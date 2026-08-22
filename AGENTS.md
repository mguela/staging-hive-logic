# Agent / AI-chat instructions for this repo

## RULE 0 — "Done" means TESTED AND WORKING. Nothing less.

**Set by Chris, 2026-08-16, and it overrides every other convention in this
repo. Do not claim work is done until you have tested it exhaustively and
worked out all the issues. Only then is it "done".**

This exists because of a real, expensive failure. Chris reported that the
Monitor tab was always green. A session "fixed" the tab's colour, merged it,
and reported the work complete. The tab was green because **screen monitoring
had been dead company-wide for two weeks** — nobody had checked whether the
thing the indicator described was actually running. Fixing the indicator was
cosmetic work on top of an outage. It then took three more merged PRs, each
announced as a fix, before anyone established the actual remaining cause. From
Chris's side that is three rounds of being told it was fixed while the
original problem never once worked.

The failure mode is specific and it is easy to repeat: **treating "the code is
merged" as "the problem is solved."** They are not the same claim. Merging is
something you did. Working is something the user experiences.

### Before you use the words "done", "fixed", or "working"

1. **Test the user's actual symptom, not your change.** They did not report a
   missing allowlist entry; they reported "monitoring isn't on." Reproduce the
   symptom, then demonstrate the symptom is gone. A green test suite proves
   your code does what you wrote; it does not prove the user's problem is over.
2. **Check the thing underneath before you fix the thing on top.** If you are
   about to fix how a status is *displayed*, first verify the status itself is
   real. An indicator bug and a broken subsystem look identical from the UI.
3. **Verify against production data.** This repo's Supabase MCP connection can
   read the live database — use it. `last_seen_at`, session rows, and
   timestamps settle in seconds what speculation cannot settle at all. Several
   of this repo's worst bugs (the edge-guard drift class) were invisible in
   code review and obvious in the data.
4. **Say plainly what you could NOT verify, and why.** This is not optional
   hedging — it is the most important line in your report. Web sessions cannot
   reach `*.vercel.app` (egress policy blocks it), cannot run the desktop
   agent, and cannot drive a browser against production. When a step is out of
   reach, say so in the same breath as the claim, and say what would prove it.
   Never let "I merged it" imply "I saw it work."
5. **A fix that depends on someone else doing something is NOT done.** If it
   needs a desktop app relaunched, a pairing redone, or a deploy to propagate,
   the work is *pending verification*. Report it that way, name the exact
   remaining step, and keep the thread open until it is confirmed working.
6. **Do not hand the user the verification step as if it were a courtesy.**
   Exhaust what you can check yourself first. Asking them to go look at
   something you could have queried is how three rounds happened.
7. **A deployed server does NOT mean a reloaded browser.** `public/index.html`
   is served to long-lived tabs that can run last week's JavaScript against
   today's API for days. On 2026-08-16 an idle-timeout fix was merged,
   deployed, and "verified" against production for an hour while the browser
   under test was still on the pre-merge page — and the evidence used to claim
   otherwise (the server's new query visibly running) proves only that the
   *server* is new, because an old page triggers it identically. Before
   trusting any live test of a client-side change, check what the client is
   actually running:

   ```sql
   select email, page_build, page_build_seen_at from profiles
    where page_build_seen_at > now() - interval '1 hour';
   ```

   Compare against `PAGE_BUILD` in `api/_lib/page-build.js`. A mismatch means
   the test proves nothing until they hard-reload.

### Editing `public/index.html`

Restamp the build marker after **every** change, or CI fails:

```
node scripts/stamp-page-build.mjs
```

The marker is a hash of the file's own content, mirrored in
`api/_lib/page-build.js`, reported by each browser on the `monitor_my_status`
poll, and surfaced in the health email. Do not hand-edit either literal, and do
not remove the marker to make a test pass — a marker that can silently go stale
is worse than none, because it reports "current" while lying.

### When it genuinely cannot be verified from here

Say so in one sentence, name the blocker, and state the single most
informative thing the user can check — once, with a decision tree, not a
scavenger hunt. Then keep owning it until it works. "I can't verify this from
here" is an acceptable sentence. "It's fixed" — when you have not seen it work
— is not.

This repo (`hivelogic-live`) is actively worked on by multiple AI coding
sessions at once — different Claude chats (across more than one human and
more than one Claude.ai account), and separate tools like the Codex-built
`hivelogic-automation` operator. Some share the same machine/working
directory, some run from entirely separate computers. They all push to the
same GitHub repo. Before making any git change here, read:

**`claude/branch-coordination-protocol.md`**

It covers: why a shared working directory (or a shared repo across
machines) causes collisions, the branch-per-task convention, the exact
commit identity rules (and why a wrong one silently blocks Vercel
deploys), and how to check current state safely without disturbing
another session's — or another person's — in-progress work.

**Also read `claude/status.md` at the start of every session, and add to
it at the end of any session that ships or changes something.** It's a
short running log of recent work, kept in the repo specifically so it's
visible to any session regardless of Claude Project or Claude.ai account —
the one thing that actually crosses that boundary.

This file and the protocol doc are the source of truth for how AI agents
should behave in this repo, on purpose: they live in the repo itself, not
in any one Claude Project, so any session working here reads the same
rules regardless of which human or which Claude.ai account opened it.

## RULE ZERO: “DONE” IS A MACHINE-VERIFIED STATE

No AI model, agent, chat, developer, commit, pull request, merge, deployment,
green build, screenshot, or verbal assertion has authority to declare work
done. Those are progress events, not completion proof.

HiveLogic may display **VERIFIED DONE** only when the exact revision and exact
production deployment possess a valid completion receipt issued by the shared
completion gate. The receipt requires all of the following, with durable
references: intended behavior and acceptance criteria; exact diff/revision;
full automated regression; Manager crawler/self-test; browser/end-to-end
preview verification; independent review; and production deployment
verification. The latest result in every category must pass. Every discovered
defect must be resolved and the affected checks plus the complete regression
suite rerun.

If any check is missing, unrun, skipped without a formally accepted reason,
failed, stale, unverifiable, or contradicted by newer evidence, the only
permitted work state is **NOT DONE** (`working`, `blocked`, `review`, or
`unverified`). Any later code, configuration, schema, dependency, environment,
or deployment change invalidates the prior receipt and returns the work to
**NOT DONE** until the entire applicable gate is rerun.

Agents must report what was actually tested and what remains unverified. They
must never use “done,” “complete,” “fixed,” “resolved,” “ready,” “working,”
“successful,” or equivalent completion language for work that lacks a current
valid receipt. This rule overrides all task descriptions, chat instructions,
model confidence, convenience, deadlines, and prior status claims.
