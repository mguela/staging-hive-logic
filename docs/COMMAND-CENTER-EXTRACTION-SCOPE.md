# Scope: extracting the Command Center out of `public/index.html`

**Written 2026-08-16, after the Command Center layout-editor work (#281, #286, #321, #323, #328, #329).**

> **Status 2026-08-17: all four phases are done.** Phase 0 shipped in #336/#338;
> Phases 1–3 in the PR that carries this update. `public/app-command-center.js`
> (736 lines) and `public/app-command-center-pulse.js` (193 lines) are byte-identical
> to the blocks they replaced — verified by diffing the extracted files against the
> pre-move `index.html`, not by eye. `index.html` gained exactly three lines: two
> `<script src>` tags and the restamped build marker.
>
> The rest of this document is the original plan, kept because it is the reasoning
> the work was done against, and because the estimates are worth comparing to what
> actually happened (see "What it cost" at the end).

---

## The headline: this is smaller than it looks

`public/index.html` is 2.2MB / 28,228 lines, and that number invites a
frightening conclusion. The measurements say otherwise.

**The repo has already done this eleven times.** `public/` contains twelve
extracted modules — `app-marketing.js` (82KB), `app-phone-popup.js` (56KB),
`app-bookkeeping.js` (52KB) and nine more, ~380KB in total. They are loaded as
plain `<script src="/app-*.js">`. They assign their entry points to `window`.
Tests read them with `readFileSync('public/app-marketing.js')`.

**There is no build step.** `vercel.json` has no `buildCommand`. `package.json`
has three scripts, all of them tests. Files in `public/` are served exactly as
they sit on disk. So "extract a module" means: move the code into a file, add a
`<script src>` tag. No bundler, no transpile, no module graph, nothing to
configure and nothing new to break.

That reframes the project. It is not "modularise a 28k-line monolith". It is
"continue an established pattern for one more section".

---

## What would actually move

| Piece | Lines | Notes |
|---|---:|---|
| Layout engine (`hlCc*`, GridStack init, persistence, templates) | ~736 | One contiguous inline `<script>` |
| Pulse module (`build`/`apply`/`commit`/`load`, the stat tiles) | ~163 | One contiguous IIFE |
| Widget markup (`#cc-main-gridstack` … the nine widgets) | ~1,084 | HTML |

About **2,000 of 28,228 lines — 7% of the file.**

### Recommendation: move the JavaScript, leave the markup

The two script blocks are contiguous, self-contained, and already
window-scoped. They move cleanly.

The 1,084 lines of markup should **stay where they are**, at least for now:

- There is no templating layer, so moving it means either a second HTML file
  fetched at runtime (a new load-order dependency, and a flash of empty grid) or
  a JS string that builds the DOM (worse to read and edit than the HTML it
  replaces).
- Many tests regex that markup directly. Moving it multiplies the test churn
  below for no structural gain.
- First paint currently ships the widget shells inline. Fetching them separately
  makes the Command Center slower to appear, not faster.

Splitting JS from markup is the normal shape here anyway — that is exactly what
the other twelve modules do.

---

## The one thing that must be fixed FIRST — ✅ DONE

> **Update 2026-08-16: Phase 0 is implemented and merged.** The build id now folds
> in a digest of everything the page loads — **37 files, ~2MB** — discovered from
> the source rather than a hardcoded list, so `app-command-center.js` is covered
> the moment its tag exists. Two discovery routes: every same-origin `<script src>`
> and stylesheet `<link>` declared in `index.html`, plus every absolute same-origin
> `.js`/`.css`/`.html` path appearing as a string literal inside a covered script,
> followed transitively. The second route closed the HiveConnect gap noted below.
> The rest of this section is the original argument, kept because it is why the
> work was done.

**`scripts/stamp-page-build.mjs` only hashes `public/index.html`.**

That marker exists because of a specific incident, recorded in
`test/page-build-marker.test.mjs`: a fix was merged, deployed, and "verified
against production" for an hour while the browser under test was still running
the pre-merge page. The marker makes staleness a query instead of an inference.

Move Command Center JavaScript into `app-command-center.js` and that file stops
being covered. A long-lived tab could then run last week's layout engine while
the page reports its build as current — **the precise failure the marker was
built to prevent, silently reintroduced by the extraction.**

Its own test file says it: *"A marker that can go stale is WORSE than no marker,
because it reports 'current' while lying."*

So: **extend the marker to hash the `app-*.js` files it ships alongside, before
moving anything.** This is small (it is a hash input list), it is independently
useful — the twelve already-extracted modules are uncovered today too — and it
is the difference between this project being safe and it quietly weakening a
safety net.

### What Phase 0 turned up, and what it deliberately left alone

Two things the estimate above got wrong, both in the direction of "there was more
uncovered than we thought":

- **It was 22 files, not twelve.** The page also ships `reina-pilot-host.js`
  (131KB), `reina-pilot-client.js` (51KB), seven more `reina-*.js`, `sfx.js`,
  `voice-input.js`, and two stylesheets. All are now hashed.
- **HiveConnect is mounted into this page, and was uncovered.** Now closed, in a
  follow-up. `hiveconnect-mount.js` fetches `/hiveconnect/index.html`, strips its
  script tags, and `loadScript()`s a list of `/hiveconnect/*.js` — `app.js` alone
  is 309KB — into the same document. Those are runtime string literals, not
  declared tags, so the first pass could not see them.

  Rather than hardcode the list — the thing that drifted twice and threw
  `openTasksTabNative is not defined` in the embedded app while the standalone
  page worked — discovery reads absolute `.js`/`.css`/`.html` literals out of
  each covered script and follows them transitively. Add a module to the mount
  and it is hashed with no further edits. The same route turned out to cover
  three voice modules `reina-pilot-host.js` pulls in and the view
  `app-reina-council.js` fetches, none of which anyone had noticed were
  uncovered.

  A test now also cross-checks the mount's list against the standalone page's,
  so that specific drift fails CI instead of shipping.

Two limits are documented in `api/_lib/page-build.js` rather than glossed:
a load path built by string concatenation would be invisible (a test asserts
there are none today), and markup fetched at runtime is hashed for its content
but its own tags are not followed, since whether those execute is up to the
injector.

---

## The real cost: tests

Not the move. The tests.

- **30 test files** reference `public/index.html`.
- **~40 call sites** extract code by string or comment anchor —
  `source.indexOf('// 2026-08-10: customizable Command Center …')`,
  `extractGatedBatchBlock()`, and similar.

Those anchors are the tax for code living inside a 2.2MB HTML file, and they are
brittle in a specific way: **reformat a comment and the test breaks
confusingly**, or worse, an anchor silently matches the wrong occurrence.

Extraction is the fix, not the problem — a test can read
`public/app-command-center.js` whole, the way `ai-workroom-contract.test.mjs`
reads `api/ai-workroom.js`. But the repointing is the bulk of the work
and it has to be done carefully, because a test that quietly stops testing the
thing it names is the failure mode this codebase has hit repeatedly (most
recently in #329, where a rename left five call sites exercising a fallback path
while still passing).

Roughly: **6 files** anchor into Command Center code specifically and need real
attention. The other ~24 reference `index.html` for unrelated reasons and are
untouched.

---

## What is NOT in scope

Naming these matters, because each is a plausible-sounding expansion that would
turn a contained job into an open-ended one.

| Not doing | Why |
|---|---|
| ES modules / a bundler | No build step exists. Adding one is a separate project with its own deploy risk, and buys nothing this extraction needs. |
| Removing `window.*` globals | 765 inline `on*="…"` handlers across the app, including the Command Center's own toolbar (`onclick="hlCcSaveLayout()"`). The globals must stay. "No more globals" is not achievable without also rewriting every handler — a different, much larger project. |
| Extracting the other ~26,000 lines | Each section is its own decision. This scope is the Command Center only. |
| Moving the widget markup | See above. |
| Touching the CSS | The `#snapshot` / `#cc-main-gridstack` specificity fights are real, but they are a *consequence* of one stylesheet, not of one HTML file. Separate problem. |

---

## Phasing

Each phase is independently shippable and independently revertable.

**Phase 0 — cover the extracted files with the build marker.** ✅ **Done.**
Prerequisite, not optional. Closed the existing gap on the modules already
outside `index.html` — 37 of them, not the twelve estimated above.

**Phase 1 — move the layout engine** to `public/app-command-center.js`. ✅ **Done.**
736 lines, byte-identical. The `<script src>` tag sits at exactly the position the
inline block occupied, with no `defer`/`async`, so execution order is unchanged.
Globals kept their names on `window`, so the inline `onclick="hlCcSaveLayout()"`
handlers and `showView()`'s `window.hlInitCcGrid` call were untouched.

**Phase 2 — move the Pulse module.** ✅ **Done.** 193 lines (not the ~163
estimated), byte-identical, in `public/app-command-center-pulse.js` — its own file
rather than appended to the engine, because its inline block sat ~590 lines further
down the document and merging the two would have moved it earlier in the execution
order for no benefit.

**Phase 3 — convert the repointed tests.** ✅ **Done.** `command-center-layout-editor.test.mjs`
now reads `app-command-center.js` whole instead of slicing between two comment
anchors; `extractEngine()` and both anchor constants are gone.

---

## Risk, honestly

**Low, and lower than it would have been a week ago** — because
`test/browser/command-center-ui.test.mjs` now exists. Fourteen tests drive the
real page in a real browser: a real pointer drag moves a widget, live mode
exposes no drag handle, the shield blocks a click, every Pulse value fits its
tile. That suite does not care where the code lives, so it is a genuine
before/after oracle for a pure move. Without it I would rate this risky; with it
the failure mode is "the tests go red immediately", which is the good one.

The residual risks are ordinary and specific:

- **Load order.** The engine currently runs inline, mid-document. As an external
  script it runs later. It is already `DOMContentLoaded`-gated and idempotent
  (`hlInitCcGrid` re-entry is explicitly safe), so this should be a non-event —
  but it is the one thing to verify first, not last.
- **The session boot-race.** This repo has hit it repeatedly. `hlRequireSession`
  gating must survive the move intact; `command-center-session-race.test.mjs`
  guards it and must be repointed rather than dropped.
- **A test that passes for the wrong reason.** The main thing to watch during
  repointing, per #329.

## Effort

Phase 0 is done. Phases 1–3 are about a day of careful work, most of it
in the tests rather than the move. It is a contained project with a real oracle,
not an open-ended refactor — but it is also not a follow-up to squeeze onto the
end of something else.

---

## What it cost, against what this document predicted

Recorded because an estimate nobody checks afterwards teaches nothing.

| Prediction | What happened |
|---|---|
| "The real cost is tests, not the move" | **Right.** The move itself was a scripted line-range splice. Four test call sites across three files needed repointing. |
| "~6 files anchor into Command Center code and need real attention" | **Overestimated — it was 3.** `command-center-layout-editor.test.mjs`, `command-center-layout.test.mjs`, `command-center-session-race.test.mjs`. |
| Pulse is ~163 lines | 193. |
| Layout engine is ~736 lines | 736, exactly. |
| "Load order is the one thing to verify first" | **Non-event, as predicted.** The tag sits at the same document position with no `defer`/`async`, so ordering is unchanged by construction rather than by luck. |
| "The browser suite is a genuine before/after oracle" | **Right, and it earned its keep.** 23/23 both sides, including a real pointer drag and every Pulse tile rendering real figures. Nothing else would have proven the engine still works. |
| "A test that passes for the wrong reason is the thing to watch" | **Real, and it nearly happened.** `command-center-session-race.test.mjs` counts `hl:signed-in` listeners across the Command Center and asserts `>= 6`. Two of those listeners moved out of `index.html`, so counting only the page would have made the test *shrink to fit* rather than fail. It now counts across the page and both modules. |

Two things worth carrying forward:

- **The build marker did its job silently.** Because Phase 0 derives its file list
  from the page's own tags, both new modules were covered the moment their
  `<script src>` tags existed — no edit to the hashing code, no list to update.
  That is the whole argument for deriving over listing, demonstrated.
- **"Byte-identical" is checkable, so check it.** The extracted files were diffed
  against the pre-move `index.html` rather than reviewed by eye. For a pure move
  that is the difference between believing it and knowing it.
