# Branch & multi-chat coordination protocol

Written 2026-07-19 after a real incident: a feature branch went stale
because another concurrent chat's merge work wasn't visible, an automated
commit used a placeholder git identity that Vercel silently refused to
deploy, and one push accidentally landed on the wrong branch because a
tool defaulted to "current branch" on a shared, moved-underneath-us
checkout. None of this was malicious — it's just what happens when
multiple AI sessions share one working directory with no shared state.
This doc exists so it doesn't happen again.

**Updated 2026-07-21:** this repo is now worked on by two people (Chris
and Jovie), each usually running their own Claude session, sometimes from
two different computers. Section "Multiple humans, multiple machines"
below covers that case specifically — read it in addition to the original
rules if you're a session working on behalf of either of them.

## The core problem

Every AI chat (Claude, Codex/ChatGPT-based tools, anything else) that
works on this repo does so through a working directory on someone's
machine — historically always `C:\Users\Chris\Desktop\hivelogic-live`, now
potentially a second clone on Jovie's machine too. No chat can see what
another chat (or another person) is doing in real time. If two sessions
are active at once, one can switch the checked-out branch, advance it, or
push over work the other assumed was still there — silently.

## Rules

1. **Check state before touching git, every time.** Run the equivalent of
   `git status` / `git log -3` before assuming which branch is checked
   out or what its HEAD is. Never assume the branch you left checked out
   last session (or five minutes ago) is still checked out — another chat
   may have changed it.

2. **Do your actual git work in an isolated worktree, not the shared
   checkout.** `git worktree add <temp-dir> <branch>` gives you a private
   copy to commit/merge in without disturbing whatever the shared
   checkout is doing. Remove it when done (`git worktree remove
   <temp-dir>`). This is now the default way to do any commit/merge in
   this repo. (This applies within one machine — see the new section
   below for the separate-machines case.)

3. **One branch, one active chat, at a time.** If you're about to start
   substantial work, that should be a fresh branch cut from the latest
   `origin/main` (or an explicit ask about which existing branch to
   continue). Don't assume a branch nobody's touched in a while is safe to
   build on top of without first merging latest `main` into it — check how
   far behind it is.

4. **`main` is the only source of truth for "what's actually live."**
   Feature branches should get merged back into `main` and cleaned up
   promptly once done — the longer one sits open, the more it drifts from
   `main`, and the more likely a preview looks "wrong" simply because it's
   stale, not because anything is broken.

5. **Always commit with the real, GitHub-linked git identity of whoever
   is actually doing the work.** For Chris:
   ```
   email: c_kendall@icloud.com
   name:  csk5369
   ```
   For Jovie, use **his own** GitHub-linked name/email once he's set up as
   a collaborator — never reuse Chris's identity for Jovie's commits, and
   never invent a placeholder (e.g. a `name@hivelogic.local`-style
   address) for any commit that will be pushed. A placeholder works fine
   locally and pushes without error, but **Vercel's deployment protection
   silently blocks builds whose commit author isn't a verified account on
   the connected GitHub repo** — the site just keeps serving the last good
   deploy with no visible error, which looks exactly like a stale/wrong-
   version bug and wastes real debugging time (this is what caused the
   2026-07-19 incident). If a tool/environment has no git identity
   configured, set it explicitly per-command with `-c user.email=... -c
   user.name=...` using the correct person's identity — don't invent one.

6. **Never force-push, and never push to `main` without confidence the
   change is small, additive, and non-conflicting** (like this doc). For
   anything touching application code, work on a branch and let Chris (or
   an explicit go-ahead) decide when it merges to `main`.

7. **If something looks wrong on a deployed preview** (stale content,
   missing feature, broken section), don't guess — check, in this order:
   (a) is the branch actually up to date with `main`? (b) is the specific
   Vercel deployment for that branch's latest commit actually `Ready`, or
   is it `Blocked`/`Error`/`Building`? Vercel's own deployment page shows
   this plainly and is the fastest way to rule out "it just didn't
   deploy" before assuming a code bug.

## Multiple humans, multiple machines (added 2026-07-21)

Chris and Jovie both work on this codebase now, usually from separate
computers, sometimes through separate Claude.ai accounts (Chris's
personal account, Jovie's on the team account). That means there are now
two independent working directories — not just multiple chats sharing
one. This is a bigger collision risk than the single-machine case above,
because there's no shared filesystem to even `git status` against — the
only shared state is the GitHub repo itself.

- **GitHub is the single source of truth, not either person's laptop.**
  Both people need push access to the *same* repo
  (`csk5369/hivelogic-live`) as collaborators. If a session ever finds
  itself unable to see the other person's recent work, unable to push, or
  looking at a codebase that doesn't match what's described in this repo
  (own server, no `origin` remote pointed at `csk5369/hivelogic-live`,
  etc.) — stop and flag it rather than assuming the local copy is right.
  That mismatch is exactly what caused the confusion this section was
  added to prevent.
- **Pull before you start, every session, no exceptions.** Because there's
  no shared filesystem to check against, `git fetch origin && git log
  origin/main -5` (or equivalent) at the start of *every* session is the
  only way to know what the other person has already done.
- **Default to a branch + a quick check-in before merging to `main`**,
  rather than both people pushing straight to `main`. Doesn't need to be a
  formal PR review every time, but for anything beyond a tiny/obviously-
  safe fix, the other person (or Chris) should get a chance to glance at
  it before it merges — that's the checkpoint that catches divergence
  early instead of after it's already caused a stale-deploy mystery.
  Small, additive, non-conflicting changes (docs like this one, a config
  tweak) can still go straight to `main` per rule 6 above.
  - **A change is "small/additive/non-conflicting" only if it doesn't
    touch application logic or shared files another branch is also
    editing.** When in doubt, branch it — the cost of an unnecessary
    branch is low; the cost of a silent collision on `public/index.html`
    or `api/track1.js` is a debugging session.
- **Say what you're about to work on**, in whatever channel the two of
  you already use (text, Slack, etc.), especially before touching a file
  the other person might also be in — git will not stop two people from
  editing the same file at the same time, it will only tell you about it
  after the fact as a merge conflict.
- **This file and `AGENTS.md` are the shared playbook on purpose.** They
  live in the repo so any Claude session — Chris's personal account or
  Jovie's team account — reads the same rules the moment it opens this
  repo, without needing access to any particular Claude Project.

## Protected feature builds (intentional — don't "fix" this)

Chris deliberately builds some features in their own separate repo,
outside `hivelogic-live`, while they're immature — to protect the main
build from half-finished work — and merges the feature into
`hivelogic-live` once it's built out enough. HiveConnect and HiveSight
were both built this way; both are now merged (their code lives under
`public/hiveconnect/` and the HiveSight equivalent inside this repo, and
the standalone `hiveconnect-weld.vercel.app` Vercel project was deleted
2026-07-20 once the merge was confirmed backed up).

**If a session finds a feature living in its own separate repo/folder,
that is not automatically a mistake or a stray duplicate.** Before
concluding a repo is "wrong" or "disconnected":

1. Check whether that feature has already been merged into
   `hivelogic-live` (look for a matching folder under `public/`, e.g.
   `public/hivesight/`, `public/hiveconnect/`) — if so, `hivelogic-live`
   is now the current source of truth for it, and the standalone repo (if
   it still exists) is a leftover, not the live version.
2. If it hasn't been merged yet, the separate repo genuinely **is** the
   current source of truth for that feature — don't redirect work back
   into `hivelogic-live` for it.
3. Either way, **a protected build should still have its own real GitHub
   remote**, even while kept separate — a local-only folder with no
   remote at all (as `hivelogic-expense-control` was found to be,
   2026-07-21) has no backup and no way for a second person/session to
   collaborate on it, regardless of whether the isolation itself is
   intentional. Flag that gap to Chris rather than assuming it's fine
   because the isolation pattern is fine.

When in doubt about a given feature's current phase (still protected vs.
already merged), ask rather than guess — Chris tracks this deliberately
and can say definitively.

## Cross-project status (separate from git)

Chris also runs several separate Claude Projects (HiveDoc, Slack Killer /
HiveComms, HiveLogic, Build Reina, HiveGrid). A Claude session can only
see the one Project it's attached to — see `reina/master-todo-protocol.md`
in the **Build Reina** project for how cross-project status notes are
meant to get written up so they're discoverable later. That's about
*Project docs*, separate from this doc, which is about *this git repo*
specifically and applies regardless of which Project — or which Claude.ai
account — a session happens to be attached to.
