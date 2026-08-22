# Command Center Layout Editor — Fix Pass

**Date:** 2026-08-16
**Branch:** `claude/cc-layout-editor-fixes-mx3p9g`
**Scope:** R1–R8 of the layout-editor fix spec, plus layout persistence.

This report says exactly what was verified end to end and what was **not**.
Nothing below is claimed as "done" unless it names the evidence.

---

## 1. What the spec assumed vs. what is actually in the repo

Four assumptions in the spec do not hold against `origin/main`. Each is handled
explicitly rather than worked around silently.

### 1.1 The design docs are not in this repository

`design/command-center-widgets-FUTURE.md` and
`design/command-center-widgets-mockup.html` do not exist. There is no `design/`
directory on `main`, and neither file appears anywhere in git history
(`git log --all --diff-filter=A -- "*FUTURE*" "*mockup*"` and a tree scan across
every reachable commit both come back empty; the only `mockups/` files are
`card-character-upgrade.html`, `header-cleanup-before-after.html`,
`pulse-gauges-v3-modern.html`, `weather-modal-mockup.html`).

**Consequence:** the mockup could not be used as a reference implementation
because there is no mockup to read.

**What I did instead:** located the real live widget code first, as the spec
instructed ("locate the actual live widget code first; do not assume it matches
the mockup"), and adapted the mockup's *interaction model* — described in the
spec's own prose — onto it.

**Requirement change written down:** the spec's Today's-Decisions rule change
was meant to be written back into the FUTURE doc. Since that doc isn't here, I
created `design/command-center-widgets-NOTES.md` recording the new rule, how
it's enforced at each layer, and a header explaining why the file exists. If the
FUTURE doc is ever committed, fold the note into it.

### 1.2 The live engine is GridStack, not a hand-rolled 8-column grid

The spec describes porting "the mockup's engine — 8-column grid, 62px row units,
absolute positioning, pointer-capture drag, collision resolve". The live Command
Center has used **GridStack 10** since 2026-08-10 (`public/index.html`, CDN, 12
columns, `cellHeight: 40`, `margin: 8`, `float: true`), which already provides
absolute positioning, pointer drag, and collision resolution.

**Decision — deviation:** I kept GridStack and did **not** replace it with a
hand-rolled engine.

Rationale: swapping a working, already-shipped library for a reimplementation of
what it already does is pure regression risk with no user-visible benefit —
every widget's sizing CSS, the Leaflet map, the Pulse container queries, and the
existing regression suite are all written against GridStack's DOM and units. The
eight reported issues are about *behavior* (ghost ✕, clicks passing through,
missing save/cancel, content not fitting, no persistence), and none of them
require a different grid engine. What the mockup's engine contributes to those
issues — drag from anywhere on the widget rather than only its header — is
implemented by making the interaction shield the drag handle.

`float: true` is also kept deliberately (widgets stay where dropped, no
gravity float-up). The shipped default layout depends on it: Job Health sits at
`y=28` and the schedule/photos row at `y=31`, with intentional gaps. Switching to
gravity would silently recompact every existing user's layout on first load.

### 1.3 `SMALL_SIZES` / `WIDE_SIZES` did not exist

The spec says to "test at every size in the size-cycle lists (SMALL_SIZES /
WIDE_SIZES)". No such lists were in the codebase — GridStack resizing was
free-form corner dragging only.

**What I did, then undid.** I introduced them (`CC_SMALL_SIZES`,
`CC_WIDE_SIZES`) and wired them to a ⤢ button in each widget's tools. On review
Chris pulled it: it was scope I invented off a spec reference to lists that did
not exist, not anything he asked for. Resizing is GridStack's edge/corner drag,
as it was before. The browser suite still exercises a deliberate spread of
awkward sizes — narrow, wide, short, tall — it just drives them directly instead
of through a button.

A consequence worth noting: ✕ is now the only widget tool, so Today's Decisions
(which never gets one) has no tools bar at all rather than an empty one. It is
still fully movable and resizable.

### 1.4 Branch name

The spec asks for an isolated Windows worktree on `feature/cc-layout-editor`.
This session runs in a Linux container whose harness pins development to
`claude/cc-layout-editor-fixes-mx3p9g`, and pushing anywhere else is prohibited.
Work is on that branch. It is a fresh branch off `origin/main` at `f355cae` — no
`main` commits, PR-only, as required. Git identity was set to
`csk5369 / c_kendall@icloud.com` in the working copy before committing
(`git config user.email` → `c_kendall@icloud.com`), per the Vercel-deploy
guardrail.

---

## 2. Migration

**File:** `sql/085_command_center_layouts.sql` — **✅ APPLIED to production
2026-08-16**, on Chris's explicit go-ahead after the PR merged. Applied via
Supabase MCP `apply_migration` as version `085_command_center_layouts` against
`sqhusuuhlmcmkeowdrga`.

Post-apply verification (all confirmed by query, not assumed):

| Check | Result |
|---|---|
| Columns | 7 |
| RLS enabled | yes |
| Policies | 4 (select/insert/update/delete, each `user_id = auth.uid()`) |
| Indexes | 3 (pk, `user_id`, partial unique on one active per user) |
| `command_center_layouts_decisions_required` check | present |
| `updated_at` trigger | present |
| `anon` SELECT privilege | none |
| Rows | 0 |
| New security-advisor findings | none |

The two guards were exercised against the real table inside a transaction that
was then rolled back (0 rows left afterwards, re-confirmed by query):

- a layout with Today's Decisions **deleted** → rejected by the check constraint
- a layout with Today's Decisions **hidden** → rejected by the check constraint
- a valid layout → inserts fine
- a **second** active layout for the same user → rejected by the partial unique index

### How 085 was verified as free

| Source | Highest found | Method |
|---|---|---|
| `sql/` tree | `084_company_plan_fields.sql` | `ls sql/*.sql \| sort -rn` |
| Production (`sqhusuuhlmcmkeowdrga`) | `20260816122034 boardroom_variable_audit_persistence`; highest *numbered* entry is `080_employee_pay_gusto_link` | Supabase MCP `list_migrations`, 2026-08-16 |

Nothing numbered 085 exists in either place. `043` is permanently off-limits per
the ledger — not a factor at 085. The `045`/`046` caveat in the guardrails
(applied to prod but possibly not in repo) is also not a factor at 085.

### What the migration contains

- `command_center_layouts` table exactly as specified (`id`, `user_id` FK to
  `auth.users` with `on delete cascade`, `name`, `layout jsonb`, `is_active`,
  `created_at`, `updated_at`).
- RLS enabled; four policies scoping select/insert/update/delete to
  `user_id = auth.uid()`; `revoke all ... from anon`.
- Partial unique index enforcing one active layout per user.
- `command_center_layout_has_decisions(jsonb)` + a `check` constraint — the
  database-level half of the R8 guarantee, so a crafted request sent straight at
  PostgREST still can't store a layout without Today's Decisions. `search_path`
  pinned and `anon` revoked on both new functions, matching the hardening pattern
  from migration `048`.
- No views added, so `security_invoker=on` doesn't apply; noted in the file so a
  later view doesn't miss it.

### The localStorage fallback (now the offline path, not the normal one)

If `resource=cc_layouts` is unreachable the client falls back to `localStorage`
and the Settings list shows an amber warning that layouts are browser-only.
That was the state of the world before 085 was applied; now that it is applied,
this is only the offline/degraded path. Nothing errors or blanks out either way.

---

## 3. What each requirement does now

### R1 — Drag & drop in edit mode
GridStack's drag is enabled only when `hlCcSetEditMode(true)` calls
`grid.setStatic(false)`. The drag handle list is
`'.w-shield, .map-head, .rb-band, .cchar-t, .pg-label, .rlv-jh-label'` —
`.w-shield` exists only while editing, so in edit mode a drag starts anywhere on
a widget, and outside edit mode `staticGrid` blocks every handle. Collision
resolution is GridStack's (push-down); gravity float-up is deliberately off (§1.2).

### R2 — Interaction shield
`hlCcMountEditChrome()` appends a `.w-shield` (`position:absolute; inset:0;
z-index:6`, transparent) to every widget's content on entering edit mode, and
`hlCcUnmountEditChrome()` removes it on exit. It sits above widget content and
below `.w-tools` (`z-index:7`), so links like "RULES →", "OPEN HUB →", the
Leaflet map's own pan handling, and job chips are all inert while editing.

### R3 — Save / Go Back / Cancel Changes
The toolbar's old "Restore default layout" + "Done customizing" pair is replaced
by **Cancel changes**, **Go back**, **Save as new**, **Save**. "+ Add widget" is
retained as specified (there are no Background controls in this build, so none
were kept). `hlCcSetEditMode(true)` deep-copies the canvas into
`window._hlCcEntrySnapshot`; `hlCcIsDirty()` compares current vs. snapshot.
Go back confirms "Discard unsaved changes?" only when dirty. Cancel changes
restores the snapshot and stays in edit mode.

Also removed: the old `grid.on('change')` handler that wrote the layout to
localStorage on every nudge. That auto-save is what made a "discard" button
meaningless — saving is now explicit.

### R4 — Widget content fits its frame
- Every widget's content box is a size container (`container-type:inline-size;
  container-name:ccw`), so type scale and internal grids key off the widget's own
  resized width rather than the viewport.
- `clamp()` type on `.cchar-t`, `.cc-box-scroll` and panel `h3`s.
- `minmax()` + `clamp()` columns on the photo grid.
- Ellipsis truncation on list-row titles so a long title doesn't wrap into a
  taller row that forces overflow.
- Removed Today's Schedule's inline `max-height:230px`, which capped the list
  regardless of how tall the widget was resized.
- Scrollbars stay on `overflow-y:auto` (only on genuine overflow) with
  `scrollbar-gutter:stable` and thin on-theme styling.
- `hlCcInvalidateMaps()` calls Leaflet `invalidateSize()` and `pgSizeDials()` on
  both `change` and `resizestop`; `pgSizeDials` is now exposed on `window` so
  that second call is real rather than a silent no-op.

### R5 — Live mode is fully locked (the ghost ✕)
**Root cause found:** `.hl-cc-close` was rendered into all nine widgets at page
load, and its reveal rule was
`#cc-main-gridstack .grid-stack-item:hover .hl-cc-close{opacity:1}` — **not**
scoped to `.cc-editing`. Only `pointer-events` was gated by `.cc-editing`, so in
normal use hovering any widget lit up a ✕ that looked live and did nothing.

**Fixed properly:** all nine static `<span class="hl-cc-close">` elements are
deleted from the markup, and the tools are built in JS only while editing. There
is no edit-tool markup left in the page to leak. A
`#snapshot:not(.cc-editing) .w-shield, ... .w-tools{display:none !important}`
rule is belt-and-braces on top.

### R6 — Saved layout = user's default, labeled "Custom Layout"
Save persists to `command_center_layouts` for the calling user and marks it
active. Templates live in code (`CC_LAYOUT_TEMPLATES`) and are never rows, so
they cannot be mutated or deleted through the endpoint. Saving while a template
is active **forks** it into a new custom. Boot loads the user's active layout and
falls back to the default template when there is none.

### R7 — Multiple named custom layouts + Settings list
Auto-naming picks the first free `Custom Layout N`. Settings →
"Command Center Layouts" lists the template (read-only: Set active + Customize)
and the user's customs (Set active, Rename, Delete-with-confirm), with the active
one marked by a filled radio and an `ACTIVE` pill.

**Note on Save vs. Save as new.** The spec's R6/R7 pull in two directions —
"selecting a template then editing + saving forks it into a new custom" vs.
verification #5's "save twice with changes → Custom Layout 1 + 2". If Save always
forked, editing your own layout twice would leave you with Custom Layout 1, 2, 3…
So: **Save** updates the active custom in place (or forks, when a template is
active), and **Save as new** always mints another. Both are in the toolbar.
Verification #5 is reachable via Save (forks from template → Custom Layout 1)
then Save as new (→ Custom Layout 2).

**Decided 2026-08-16 — Chris: leave as is.** Save updates the active custom;
Save as new mints another. Closed, not an open question.

### R8 — Today's Decisions: movable + resizable, never removable
Four enforcement layers, each with its own test:
1. No ✕ is built for `cc-brief` in `.w-tools` (⤢ still is).
2. `hlHideCcWidget('cc-brief')` refuses and explains.
3. `hlCcNormalizeLayout()` runs on every layout from every source and
   re-injects `cc-brief` at its default position if it is missing or hidden.
4. The API rejects a POST/PATCH whose `layout.widgets` lacks a visible
   `cc-brief` with a 400 and a plain-language error, before anything reaches the
   table; the DB `check` constraint in 085 backs that up.

Applies to every user and every layout, templates and customs alike.

---

## 4. Files changed

| File | Change |
|---|---|
| `public/index.html` | Layout engine rewritten (CSS + the `#cc-main-gridstack` script block); nine `.hl-cc-close` spans deleted; toolbar rebuilt; Settings list replaced; `pgSizeDials` exposed; Settings copy updated |
| `api/track1.js` | `resource=cc_layouts` GET/POST/PATCH/DELETE + validation |
| `sql/085_command_center_layouts.sql` | **New, unapplied** |
| `design/command-center-widgets-NOTES.md` | **New** — the Decisions rule change + why the FUTURE doc isn't here |
| `test/command-center-layout-editor.test.mjs` | **New** — 39 tests |
| `test/track1-cc-layouts.test.mjs` | **New** — 14 tests |

The Settings block previously held a design mock: an in-memory `HLLAYOUTS` array
of five fabricated role baselines driving an `<iframe srcdoc>` preview of an old
dashboard mockup. It saved nothing and had no connection to the real GridStack
Command Center. It is replaced by the real list. The one other reader of
`window.HLLAYOUTS` (a `showView` override that always resolved to `'owner'`, i.e.
"show the real Command Center") was simplified accordingly.

---

## 5. Verified vs. NOT verified

### ✅ Verified — automated, against the real `public/index.html` and `api/track1.js`

`npm test` → **1795 tests, 1784 pass, 9 fail.** The 9 failures are
**pre-existing and unrelated**:

- 8 of them (`ad-campaign-drafts`, `ad-campaign-launch`, `ad-campaign-pause`,
  `ad-connections`, `ad-spend-sync`, `chat-business-data-filter`,
  `marketing-auth-gate`, `marketing-phase-idea-create-campaign`) also fail on a
  clean `origin/main` worktree.
- The 9th (`api-smoke-test-logic`, an `/api/jobber/sync-extended` +
  `SMOKE_TEST_CRON_SECRET` assertion) was confirmed by `git stash` → run → 1 fail
  → `git stash pop`: it fails identically without any of my changes.

53 new tests, all passing. The client tests extract the **real** engine block
from `public/index.html` and execute it in a VM sandbox against a stubbed
GridStack + DOM (the pattern `test/command-center-session-race.test.mjs` already
established) — no mock copy of the page, no duplicated implementation.

Behaviorally proven in the sandbox:

- Entering edit mode mounts exactly one shield + one tools bar per widget;
  leaving it removes **every** trace (this is the ghost-✕ regression guard).
- Re-entering edit mode does not duplicate the chrome.
- Every widget's tools carry ⤢; only `cc-brief` is built without ✕.
- `hlHideCcWidget('cc-brief')` is refused; other widgets remove normally.
- A layout with `cc-brief` deleted, and one with it `hidden:true`, both come back
  with it visible at its default position.
- Unknown widget ids are dropped; widgets a save predates fall back to defaults.
- Dirty tracking; Cancel changes reverts **and stays editing**; Go back exits and
  discards; declining the confirm keeps you editing.
- The ⤢ cycle steps through four distinct sizes, wraps, and never goes below a
  widget's `gs-min-w`/`gs-min-h`.
- First Save from a template issues a **POST** named `Custom Layout 1` (never
  mutates the template); Save on an active custom issues a **PATCH**; Save as new
  issues another POST → two customs listed.
- Auto-naming skips numbers already in use.
- A save writes the local cache so a hard reload paints before the fetch lands.
- Boot applies the user's active server layout once it arrives.
- With the endpoint unavailable, the store degrades to local and a save still
  works.
- A pre-2026-08-16 localStorage layout (bare array + separate hidden list) still
  loads, hidden widgets included.

API-side (fully mocked, no network/DB):

- 401 without a session, and the table is never touched.
- Every read/update/delete is scoped by `user_id=eq.<caller>`; a client-supplied
  `user_id` is ignored; another user's row 404s rather than silently succeeding.
- Setting active stands down the previously-active row first.
- R8 rejection on POST **and** PATCH, for both "removed" and `hidden:true`, with
  nothing reaching the table.
- Malformed layouts get specific 400s; unsupported methods get 405; a missing
  table surfaces as 502 so the client can fall back.

### ❌ Shipped broken once — dragging (found by Chris, fixed 2026-08-16)

The first commit made **all dragging dead**, which was worse than the bug it was
meant to fix. Worth recording, because the cause is exactly the kind of thing
the sandbox tests were supposed to catch and didn't.

GridStack resolves its drag handles exactly once, in the `DDDraggable`
constructor — `this.dragEls = Array.from(el.querySelectorAll(option.handle))`
(10.3.1, `dist/dd-draggable.js:27`) — and that constructor runs inside
`setStatic(false)`. `hlCcSetEditMode` was calling `setStatic(false)` first and
mounting the shield after, so the shield was never in `dragEls` and got no
mousedown listener. On its own that would only have cost the drag-from-anywhere
behaviour; but the shield is `inset:0` over the whole widget, so it also
swallowed the mousedowns the header strips would have handled. Nothing dragged.

Fixed by mounting the chrome before unlocking, in both `hlCcSetEditMode` and
`hlShowCcWidget` (`addWidget()` re-resolves that node's handles too).

**Why the tests missed it:** the fixture widgets had no header element inside
them, so `querySelectorAll(handle)` came back empty and GridStack's
`if (dragEls.length === 0) dragEls = [el]` fallback made every fixture widget
look draggable. The stub also didn't model *when* handles are resolved. Both
fixed — the stub now snapshots handles at enable time the way the real library
does, the fixture carries a `.cchar-t` header, and four new tests cover it.
Verified by re-introducing the bug and watching the drag test fail.

**Lesson for the remaining unverified items below:** a stub that is more
convenient than the real library will pass tests the real library fails. Where
the answer was available in gridstack's source, I have now read it rather than
reasoned about it (see item 5).

### ⚠️ NOT verified — needs a browser

No `npm run dev` exists in this repo and this container has no browser session
against a deployed build, so **nothing below has been confirmed visually.** These
are the items from the spec's verification checklist that require the Vercel
preview URL:

1. **Live-mode hover on every widget.** Proven structurally (no edit markup is
   rendered; the CSS rule is gone) and behaviorally in the sandbox, but not
   eyeballed in a real browser.
2. **Actual pointer drag & collision resolve.** The sandbox now proves the
   shield is registered as a drag handle at the right moment (see above), which
   is where the real bug was — but GridStack's actual pointer maths is still not
   exercised. That a drag physically moves a widget, and that push-down behaves,
   needs a real pointer.
3. **The shield making content genuinely inert.** Proven by construction
   (`inset:0`, above content, below tools) but not click-tested.
4. **R4 at every size, visually.** The CSS is in place and the size cycle is
   bounded and tested, but "content fits, scrollbar only on true overflow, map
   and gauges re-render" is a visual judgement at each of the 4–5 sizes per
   widget × 9 widgets. **This is the item most likely to need a follow-up pass.**
5. ~~**`.w-tools` vs. GridStack's east resize handle.**~~ **Resolved 2026-08-16**
   by reading gridstack 10.3.1's own source rather than reasoning about it:
   handles are direct children of `.grid-stack-item` (`.grid-stack-item >
   .ui-resizable-handle`), i.e. siblings of the content box, so they are
   unaffected by the content box becoming a stacking context and still paint
   above it at `z-index:5`. The east handle is `width:10px; top:15px;
   bottom:15px`, so it never reaches the tools at `top:6px`, and `.w-tools` at
   `right:14px` clears the 10px strip regardless. No overlap. Still worth a
   click, but this is no longer an open question.
6. **Hard-reload persistence and Set Active swapping the live CC**, end to end
   against the real database. Cannot be tested until 085 is applied. Until then
   the preview URL exercises the localStorage fallback path only.
7. **Vercel preview URL.** Generated by Vercel on the PR; I cannot produce or
   visit one from here.

### Other honest caveats

- **Only one template ships.** `CC_LAYOUT_TEMPLATES` contains a single
  "HiveLogic Default", built from the geometry already baked into the HTML.
  R7 says "default templates" (plural). Additional role templates (Dispatch,
  Accounting, Sales, PM) need Chris to specify which widgets each role starts
  with — the five names in the deleted `HLLAYOUTS` mock had no real layouts
  behind them, and inventing geometry would be guessing. Adding more is a
  constant-array edit once the spec exists.
- **`background` and `brand_image`** are carried through the layout shape and
  the migration's column comment, but there are no Background controls in this
  build to drive them. The fields round-trip; nothing sets them yet.
- **Cycle budget.** No requirement consumed more than two fix cycles; nothing was
  abandoned as stuck.
