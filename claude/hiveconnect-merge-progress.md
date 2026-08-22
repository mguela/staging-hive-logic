# HiveConnect ↔ HiveLogic Merge — Progress Log

## Phase 0 — Context & Verification
**Status:** In progress. No application code touched. No git push, no deploy, no merge.

**Actions completed:**
- Located sources in `Desktop/HiveMerge`: `hiveconnect-repo.tar.tar` (5,468,160 bytes) and `hivelogic-v64-backup-2026-07-19.html` (1,822,663 bytes).
- Confirmed `claude/merge-kickoff.md` and `claude/hiveconnect-hivelogic-merge-spec.md` did not exist anywhere on the connected paths (`HiveMerge`, `hivelogic-live`) — authored fresh per Chris's explicit instruction, saved to `hivelogic-live/claude/`.
- Copied the HiveConnect archive into an isolated sandbox (not the original file on Chris's disk) and extracted it read-only to verify the approved commit — this is the Step 0 verification the kickoff itself requires before any transplant work.
- Computed SHA1 of the local backup HTML file.
- Fetched `hivelogic-live.vercel.app` to compare against the backup.

**Findings:**

| Check | Expected | Actual | Result |
|---|---|---|---|
| Archive filename | `hiveconnect-repo.tar.gz` | `hiveconnect-repo.tar.tar` (plain POSIX tar, not gzipped) | ⚠️ Discrepancy — logged, not blocking |
| HiveConnect git HEAD | `374219b...` | `374219bb81a8f8100e50306e2dcc24fda785409d` | ✅ Match |
| Backup HTML SHA1 | `d00ba33fee51e1772817f17d499f6f269a8d6124` | `d00ba33fee51e1772817f17d499f6f269a8d6124` | ✅ Match |
| Live site vs. backup | Full HiveLogic app — Command Center, sidebar incl. Comms/Email, etc. | Initial `WebFetch` (no JS execution) returned only "HiveLogic Live / Backend is running." Re-checked with a real browser render (`hivelogic-live.vercel.app`, title "HiveLogic — v64", already signed in as Chris): full Command Center loads — sidebar confirmed with **Comms** and **Email** entries exactly where the spec targets them, version tag "v64" matches the backup filename. | ✅ Resolved — WebFetch tooling limitation (no JS), not a real content mismatch |

**HiveConnect standalone (`hiveconnect-test.vercel.app`) — reference check:**
Loaded for context only, not touched/modified. Sidebar: Messages, Email, Channels,
HiveVideo (top-right pill, links out), Chirp, Contacts, Tasks, Calendar, Settings, Help.
Note for later phases: HiveConnect has its own "Email" section and a "HiveVideo" reference
in its own UI — worth confirming during the transplant whether that's HiveConnect's own
Email/HiveVideo surface or a link back to HiveLogic's, so §4's "don't touch HiveVideo/Chirp
internals" rule is respected either way.

**Decisions required from Chris:**
1. Pick an auth bridge option from spec §5 (Option A / B / C) — none implemented yet.
2. Reply exactly "go" to authorize starting Phase 1.

**Files changed in either app:** none.
**Deployments:** none.
**Test results:** none yet — Phase 4 checklist not started.

**Update:** Chris selected **Option C** and replied "Go" with binding implementation
requirements (now spec §9), a rollback requirement (§10), and 9 required test scenarios
(§11). Chris then asked to go to bed and authorized overnight work strictly local-only:
no GitHub auth, no secrets, no Vercel, no push, no deploy. This log continues below.

---

## Overnight session — 2026-07-19 (local-only work, per Chris's explicit scope)

**Status:** Sidebar swap, routing, redirects, Command Center retarget, HiveConnect
transplant, and the Option C auth bridge are all **written, locally committed (in a
sandbox git repo — see "About these commits" below), and tested**. Nothing pushed to
GitHub. No secret ever touched. No Vercel access attempted. No production branch touched.
Production and the standalone HiveConnect deployment are both untouched and still live.

### About "local commits" — an honest caveat
This session has no way to run shell commands on Chris's actual Windows machine (the
device bridge here does file transfer + a few GUI/MCP tools, not a remote shell) and
GitHub auth was explicitly deferred. So the git branch and commits described below exist
in **a sandbox git repository this session built**, seeded from the working-tree files
staged from `hivelogic-live` over the device bridge — not a clone of the real repo's full
commit history (that history wasn't transferred; only the current working tree was). The
deliverables (patch files + a git bundle, see "Files delivered" below) are what carries
this work back to Chris's real checkout. **Nothing was written into Chris's real
`hivelogic-live` folder** — that was a deliberate call, explained below.

**Why the real folder wasn't touched directly:** Chris's own `.bat` scripts in that repo
(`push-tonight.bat`, `fix-function-limit.bat`) run `git add -A && git commit && git push`
against whatever is currently checked out, with no branch-name check — there's no evidence
in this repo of a feature-branch habit; everything looks like it's committed straight to
whatever `git push` sends changes to. If this session had overwritten `public/index.html`
etc. directly on disk without Chris first creating and checking out
`feature/embed-hiveconnect`, an unrelated later run of `push-tonight.bat` could have pushed
tonight's merge work straight to production without anyone reviewing it first — a direct
violation of "never work on the production branch." Keeping everything in a patch/bundle
until Chris explicitly checks out the feature branch avoids that risk entirely.

### Real source inspection (this is what the plan below is grounded in, not guesses)
- `public/index.html` (1,825,586 bytes) is HiveLogic's entire frontend — a single hand-built
  HTML file with inline `<script>`, not a framework/build-step app. Confirmed via `diff`
  against `ours.html`/`theirs.html` (pre-existing files in the repo root — look like manual
  merge-conflict-resolution backups from an earlier session, unrelated to this work; left
  untouched) that `public/index.html` has no real git conflict markers (`grep -n
  "^<<<<<<<\|^>>>>>>>"` → zero matches; the earlier `=======`-style hits were decorative
  comment banners already in the file, not conflict debris).
- Sidebar nav: `#nav-cmx` (Comms, line ~1797) and `#nav-mail` (Email, line ~1798) in the
  original file. Command Center's Comms card ("OPEN HUB →") at line ~2007. `showView(v)`
  is the whole app's client-side router — a big array of view keys toggling
  `display:none/block` — no existing hash-based routing at all (only one unrelated
  `location.hash` check for a `?win` mode).
- HiveConnect (`hiveconnect-repo.tar.tar`, HEAD `374219bb81a8...`, verified in Phase 0) is
  also a static site: `public/index.html` (45KB), `public/app.js` (259KB — the real app
  logic), `public/styles.css` (91KB), `public/config.js` (849 bytes — HiveConnect's own
  Supabase URL + anon key, safe to be public by Supabase's own design, plus a Microsoft
  Graph client ID for HiveConnect's own Email tab, `ff9bda24-d7e9-4905-a94e-f3ccc0239eb2`).
- **Resolved a real ambiguity by evidence, not assumption:** grepped all of HiveLogic's own
  `api/` code and `public/index.html` for any existing Microsoft Graph / MSAL / Outlook
  OAuth wiring — found none. HiveLogic's current "Email" feature (`<div id="mail">`) has no
  real Graph backing in this codebase. Conclusion: HiveConnect's own Graph integration
  (`config.js`'s `msGraph.clientId`) **is** "the Microsoft 365/Graph email integration" the
  hard rules protect — it isn't a second, competing system. Transplanting `config.js`
  byte-identical (done) satisfies "don't touch Graph internals, don't force a reconnect."
  Flagging this reasoning explicitly rather than quietly assuming it, so it can be checked.
- Deploy mechanics (from `push-tonight.bat` / `fix-function-limit.bat`): `git add -A && git
  commit -m "..." && git push` triggers Vercel's GitHub integration. SQL migrations are
  applied manually (Supabase dashboard → SQL Editor → paste → Run) — 002 through 008 exist
  this way; this work adds `sql/009_hiveconnect_bridge_mapping.sql` following the same
  convention (not wired into any automated runner). Vercel project identity found in
  `fix-function-limit.bat` without connecting to Vercel: org **chris-projects-bc5d8fbb**,
  project **hivelogic-live** (`vercel.com/chris-projects-bc5d8fbb/hivelogic-live/deployments`).
  No `.vercel/project.json` was present in the files staged.

### ⚠️ Real risk found, needs Chris's confirmation before push: Vercel function count
`fix-function-limit.bat`'s own commit message says they hit "Vercel's 12-function Hobby
plan limit" once already and had to consolidate 6 routes into `api/track1.js` to get back
under it. Counting current route files under `api/` (excluding `_lib/`, which Vercel
doesn't treat as routes): **15 already**, before tonight's addition. Adding
`api/hiveconnect-bridge.js` makes **16**. Either the plan has since changed (Pro, no
practical limit) or this repo is already over whatever limit currently applies — this
session cannot check the real Vercel dashboard to know which. Built the new bridge as ONE
consolidated file (mirroring the `track1.js` pattern) specifically to avoid adding more than
the one function this required. **Confirm your current Vercel plan before pushing** — if
still on a plan with a hard limit under 16, another route will need consolidating first.

### What was built (all locally committed, in the sandbox repo — see files list)
1. **Sidebar + routing + redirects + Command Center retarget** (spec §3 items 1,2,3,5,6,7)
   — `public/index.html`. Removed `nav-cmx`/`nav-mail`, added one `nav-hiveconnect` entry
   in the same spot. Retargeted the Command Center Comms card (link + all 4 rows) to
   `openHiveConnect()`; the card itself is visually unchanged. Added `openHiveConnect()`,
   a hash listener that redirects legacy `#cmx`/`#mail`/`#/comms`/`#/email` to
   `#/hiveconnect`, and one new `view-hiveconnect` container. Net change to the existing
   `showView()` function: one array entry, one toggle line.
2. **Isolated mount + bridge client** (spec §3 item 4, §9) — new file
   `public/hiveconnect-mount.js`. Mounts HiveConnect into a **Shadow DOM** (real CSS/JS
   isolation both directions, no iframe/webview — satisfies the hard rule directly, and
   is what "CSS-scoped module" resolved to technically). Calls the bridge endpoint, hands
   the session to the transplanted app, shows a clear retryable error on any failure,
   never touches HiveLogic's own session on any path.
3. **HiveConnect transplant** (hard rule: transplant, not rebuild) — new folder
   `public/hiveconnect/`. `index.html`, `styles.css`, `config.js` are **byte-identical**
   to the approved archive (diffed, confirmed identical before committing). `app.js` has
   **exactly one line changed**: the final `boot();` call now awaits priming the Supabase
   client with a bridged session first, if one was provided — documented inline, in the
   spec, and here. Everything else in that 4,580-line file is untouched.
4. **Option C auth bridge backend** (spec §5 SELECTED, §9, §10) — new file
   `api/hiveconnect-bridge.js` + new migration `sql/009_hiveconnect_bridge_mapping.sql`.
   Mapping table keyed on immutable `hivelogic_user_id` (primary key) →
   `hiveconnect_user_id` (unique) — never keyed on email alone. Idempotent: upserts on the
   immutable key; looks up an existing HiveConnect account by email before ever creating
   one; refuses (doesn't guess) on duplicate-email; refuses disabled users before any
   provisioning/minting happens; never fails silently — every failure path returns a
   structured error and never touches HiveLogic's session. Logs mapping events, strips
   secrets/tokens/passwords before logging. Consolidated into one Vercel function
   (see risk note above).
5. **Tests** — new file `test/hiveconnect-bridge.test.mjs`. All 9 required scenarios from
   spec §11, fully mocked (no real network, no real secret, ever). **Actually executed
   in this session, not just written:**

   ```
   $ node test/hiveconnect-bridge.test.mjs
     ok  - existing mapped user mints a session without re-provisioning
     ok  - existing unmapped user links to their existing HiveConnect account, does not create a duplicate
     ok  - brand-new user gets provisioned exactly once
     ok  - disabled user is refused before any provisioning or minting happens
     ok  - duplicate HiveConnect accounts sharing one email produce a clear error, not a guess
     ok  - an expired/invalid token at the verify step surfaces a clear mint failure
     ok  - a failed HiveConnect account creation surfaces a clear error and leaves no mapping row
     ok  - a failed session mint (mapping already exists) surfaces a clear error
     ok  - rollback: dropping the mapping table leaves no trace the bridge ever ran (simulated)

   9 passed, 0 failed (of 9)
   ```

   **Not run:** `test/api-smoke-test.js` (pre-existing) — it hits a real deployed URL
   (`https://hivelogic-live.vercel.app` by default), which the "no production access"
   scope for tonight excludes. Run it yourself once the preview is up.

### Build / lint / type-check
No bundler, no TypeScript, no lint config exists in this repo (confirmed: `package.json`
has no `scripts` block, no devDependencies beyond none listed, no `.eslintrc`/`tsconfig`
found in the files staged). "Build" for this project is "the files as they sit" — so
verification here was: (1) `node --check` on every new/modified `.js` file — all pass;
(2) every inline `<script>` block extracted from `public/index.html` and checked with
`node --check` — **69/91 pass, identical to the pre-edit file** (22 pre-existing failures
are HTML-entity-encoded `&amp;&amp;` inside onclick-attribute-adjacent blocks this
extraction method mis-slices — present before and after, confirmed by running the same
check against the untouched original; this work introduces zero new syntax issues); (3)
tag-balance sanity check on `<div>`/`</div>` and `<script>`/`</script>` counts, delta
matches exactly what was inserted.

### Files changed (full list)
| File | Status | What |
|---|---|---|
| `public/index.html` | modified | sidebar swap, Command Center retarget, routing/redirects, view container |
| `public/hiveconnect-mount.js` | **new** | isolated mount + bridge client glue |
| `public/hiveconnect/index.html` | **new** | transplanted, byte-identical |
| `public/hiveconnect/styles.css` | **new** | transplanted, byte-identical |
| `public/hiveconnect/config.js` | **new** | transplanted, byte-identical |
| `public/hiveconnect/app.js` | **new** | transplanted, one line changed (see above) |
| `api/hiveconnect-bridge.js` | **new** | Option C backend, one consolidated Vercel function |
| `sql/009_hiveconnect_bridge_mapping.sql` | **new** | mapping table migration (manual apply, matches existing 002-008 convention) |
| `test/hiveconnect-bridge.test.mjs` | **new** | all 9 required scenarios, mocked, passing |

### Commands run tonight (all local, in this session's sandbox — none on Chris's machine)
```
git init && git checkout -b feature/embed-hiveconnect
node test/hiveconnect-bridge.test.mjs          # 9/9 passed
node --check public/hiveconnect-mount.js       # OK
node --check public/hiveconnect/app.js         # OK
node --input-type=module --check < api/hiveconnect-bridge.js   # OK
git format-patch master..feature/embed-hiveconnect
git bundle create feature-embed-hiveconnect.bundle master feature/embed-hiveconnect
```

### Required environment variables (names only — no values exist anywhere in this session)
| Variable | Where it's used | Notes |
|---|---|---|
| `HIVECONNECT_SUPABASE_URL` | `api/hiveconnect-bridge.js` | HiveConnect's Supabase project URL |
| `HIVECONNECT_SUPABASE_SERVICE_KEY` | `api/hiveconnect-bridge.js` | **Real secret. Server-side env var only. Never seen by this session, never will be.** |
| `SUPABASE_URL` | already exists (used by `api/_lib/jobber.js`) | reused — mapping table lives in HiveLogic's own project |
| `SUPABASE_SERVICE_KEY` | already exists | reused, same as above |

### Unresolved blockers (need Chris, not further overnight work)
1. Vercel function-count risk above — confirm current plan before pushing.
2. HiveConnect's own Email tab uses its own Microsoft Graph client ID — reasoning above
   says this is intentional and fine, but it's this session's inference from the code, not
   something Chris confirmed explicitly. Worth a quick gut-check.
3. The two`.html` files (`ours.html`, `theirs.html`) sitting in the repo root look like
   leftover manual merge-conflict backups from an earlier, unrelated session — not touched,
   not part of this work, but worth cleaning up or understanding at some point.
4. Everything in the "Needs you live" list from earlier tonight still stands: GitHub
   device-flow approval, the real secret going into Vercel directly, production
   deployment IDs, final go-live approval.

---
*Log created 2026-07-19. Append future phases below this line rather than overwriting.*
