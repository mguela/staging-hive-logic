# Rolodex Quick-Access Tabs — Build Report

**Branch:** `feature/rolodex-quick-tabs` (off `origin/main`)
**Worktree:** `C:\Users\Chris\rolodex-quick-tabs`
**Git identity used:** `c_kendall@icloud.com` / `csk5369` (verified before first commit)
**File touched:** `public/index.html` (single insertion; no other files changed)

> **Report filename note:** a `REPORT.md` already exists at the repo root — it is
> the deliverable of the already-merged *Company Setup + Cost Model* feature. To
> avoid clobbering that merged report, this task's report is written as
> `REPORT-rolodex-quick-tabs.md`.

---

## 1. Exact insertion location

Inserted as a **sibling of the left `.rail` nav**, immediately after its closing
`</aside>` and before `<main class="main">`. This places it in the global app
shell (the `.app` grid wrapper), so it renders on **every view**, docked on the
**right** edge instead of the left.

- Before insertion: left rail `</aside>` was at line ~2718, `<main>` at ~2720.
- After insertion: `<div class="rolodex">` container at line 2760, `<main>` at 2784.

The rail is `position:fixed`, so it overlays the viewport and does **not** disturb
the existing `.app` two-column grid (`220px | minmax(0,1fr)`).

## 2. The pop-out mechanic + the drift-bug fix (verified by construction)

The spec called out a specific known bug: *if the rail container auto-sizes to
fit the widest (hovered) child, the whole stack visually drags left when one tab
expands.* The fix implemented, exactly as specified:

- `.rolodex` container: **fixed `width:52px`**, `align-items:flex-end`,
  `overflow:visible`, `flex-direction:column`.
- Each `.rolo` tab is right-anchored; on `:hover` it grows from `46px` → `178px`
  and `translateX(-10px)`.

Because the container width is **fixed** (not `auto`/content-driven) and children
are cross-axis right-aligned, an expanding tab **overflows leftward past the
container** without resizing it. Siblings in a flex **column** are laid out on the
vertical axis, so one child's horizontal width change cannot move them. Result:
only the hovered tab pops out; the other 12 stay locked. This is a deterministic
CSS property of the layout, not a timing/animation coincidence.

**Visual verification status:** the repo has **no dev server** and the Vercel
preview sits behind auth, so I could not screenshot the mechanic in-app. I built
an isolated static harness with the byte-identical CSS/markup, but the in-app
browser tool renders local `file://` pages only as non-interactive static
snapshots (no `:hover`, no screenshot compositing), so an automated hover capture
wasn't possible either. The mechanic is guaranteed by the layout rules above;
**please eyeball it on the Vercel preview** (hover any tab — the stack must not
shift).

## 3. Tab targets — real vs. stubbed

All 13 tabs call the **same existing functions** the left nav / topbar already
use. **Nothing was fabricated and no new routing was invented.** Sources were
confirmed by reading `public/index.html`.

| # | Tab | Wired to | Real? | Source in index.html |
|---|-----|----------|-------|----------------------|
| 1 | Phone | `hlRoloHC('voip')` → HiveConnect **VoIP** tab | ✅ real | HiveConnect rail `data-tab="voip"` |
| 2 | Email | `hlRoloHC('email')` → HiveConnect **Email** tab | ✅ real | HiveConnect rail `data-tab="email"` |
| 3 | Chirp | `openChirp()` → Chirp popup (talk-groups + push-to-talk) | ✅ real | `#cmv` / `#cm-chirp` |
| 4 | SMS | `hlRoloHC('messages')` → HiveConnect **Messages** tab | ✅ real | HiveConnect rail `data-tab="messages"` |
| 5 | Video | `hlRoloHC('huddles')` → HiveConnect **HiveVideo** tab | ✅ real | HiveConnect rail `data-tab="huddles"` |
| 6 | Schedule | `showView('schedule')` | ✅ real | nav `#nav-sched` |
| 7 | New Estimate | `estFormNew(null)` | ✅ real | "+ New Estimate" buttons |
| 8 | New Job | `openForm('job')` + `hlFillClientSel('njob-client')` | ✅ real | Do-Work tile / "+ Create Job" |
| 9 | New Lead | `openNewLead()` | ✅ real | "+ New Lead" button |
| 10 | Invoicing | `showView('invx')` | ✅ real | nav `#nav-invx` |
| 11 | Photos / Docs | `showView('docs')` | ✅ real | nav `#nav-docs` (per spec: route to Documents) |
| 12 | Reina | `#rnaPanel` → `classList.add('open')` | ✅ real | replicates `hlAskReinaFromSearch()` open path |
| 13 | Monitor | `showView('mon')` | ✅ real | nav `#nav-mon` |

**Comms tabs route into HiveConnect (updated after Chris's review):** Chris
specified the 5 comms tabs should land on HiveConnect's own sub-tabs, not
standalone popups. HiveConnect is mounted into `#hiveconnect-root` (not an
iframe); its tab-switcher `setNavTab` is module-scoped and not callable, so the
helper `hlRoloHC(tab)` opens HiveConnect (`openHiveConnect()`) and then clicks the
HiveConnect rail button `[data-tab="…"]` (retrying until the async mount renders
it). Phone→`voip`, Email→`email`, SMS→`messages`, Video→`huddles` (HiveVideo).
**Chirp** opens the existing Chirp popup via `openChirp()` (`#cmv` → `#cm-chirp`),
which has the talk-group options + push-to-talk button Chris wanted.

**Old floating dock removed on desktop (fix):** Chirp/Reina/Monitor previously
lived in the bottom-right floating dock `#hl-fabdock` (z-index 99990), which
buried the rolodex's lower tabs and leaked onto the login screen. Because the
rolodex now provides those same actions on every page, the dock and its pills
(`#hl-fabdock, #pttfab, #rnaFab, #hlMonFab`) are hidden **entirely on desktop**
(`@media (min-width:861px){ … display:none!important }`) — including the login
screen and inside HiveConnect. They remain on mobile (≤860px), where the rolodex
is hidden. Easily reversible if any floating button should return.

**Photos vs. Docs note (not a gap):** tab #11 is labeled "Photos / Docs". Per the
spec's explicit instruction ("Photos/Docs → route to the existing Documents
view") it routes to `showView('docs')`. A separate Photos view also exists
(`showView('vi')`, "HiveSight") if you'd prefer to split them later.

## 4. Visual language — matched to existing tokens (mockup palette NOT imported)

The rail adopts the app's existing design tokens rather than the mockup's
standalone dark palette:

- **Color treatment (chosen by Chris after a few iterations): solid color per
  tab.** Each tab is filled with its own accent color (`var(--rl-ac)`), with a
  **white icon and white label**; hover brightens the fill (`filter:brightness`).
  Earlier dark-navy and brushed-steel-gradient versions read as "black / didn't
  fit"; the solid fills match the app's colorful gauges/pills. The per-tab colors
  were deepened from the original pastel accents so the white icons stay legible.
- Labels use `var(--mono)` ('JetBrains Mono'), matching the app's mono type.
- Icons are **thin-stroke line SVGs** (Feather-style, `stroke-width:1.8`,
  `currentColor` → white on the colored fill).
- Rolodex-card look: `border-radius:9px 0 0 9px` (left corners only, right edge
  flush to screen), `margin-bottom:-3px` slight overlap, layered shadows,
  hovered tab lifts (`z-index` + deeper shadow).

## 5. Mobile-responsive decision

**Chosen: hide the rail below `860px`** (`@media (max-width:860px){ .rolodex{display:none} }`).

**Why 860px specifically:** that is the app's **existing** mobile breakpoint —
at `≤860px` the left `.rail` already converts to an off-canvas hamburger drawer
(`.app` collapses to a single `1fr` column). Matching that exact breakpoint keeps
behavior consistent. On mobile the topbar still exposes the Phone (📞) and Comms
Hub (💬) icons, so the most-used quick actions remain reachable without the rail.
A fixed right-edge rail on a 375–414px phone would collide with content, so
hiding (rather than a bottom sheet) is the lowest-risk choice for a first cut. A
bottom-sheet/drawer variant can be added later if you want the quick tabs on
mobile too.

**Hidden on the login screen (fix, 2026-08-15):** the rail is `display:none` by
default and only shows once `body.hl-authed` is set. A small script watches the
`#login` overlay's visibility (via MutationObserver, covering normal sign-in, the
`#win` new-window path, and existing-session boot) and toggles that class. This
keeps the sign-in screen clean — the rail appears only after login.

**Shown on every page including HiveConnect (updated after Chris's review):** an
earlier version hid the rail while HiveConnect was open; Chris wants it on every
page, and the comms tabs now open HiveConnect, so the rail must stay visible
there to switch tabs. The rail now shows on all views once signed in.

**Monitor tab live indicator (added):** the Monitor tab lights up green with a
gentle glow while screen monitoring is actively recording, and is grey when off.

> **Corrected 2026-08-15.** This section previously described a MutationObserver
> mirroring `#hlMonFab.hlmon-on`; that was later replaced by a second poller
> against `monitor_review` which lit the tab whenever any roster device was
> `status==='active'` — i.e. *paired*, which is true around the clock. The result
> was a tab that was green even when nobody was clocked in (reported by Chris).
> As of `fix(shell): Monitor tab reflects real recording state, not "a device is
> paired"`, the tab is set by `hlMonRoloSync()`, called from `hlMonitorFabPoll()`
> — the single 30s poll of `/api/track1?resource=monitor_my_status` that already
> drives the recording-warning toast. `recording:true` → green; not recording,
> signed out, or a failed request → grey. There is no second poller.

## 6. Guardrails honored

- ✅ No dev server started for the project; **`npm run dev` / localhost never
  touched.** Verification path is the Vercel preview.
- ✅ Existing design tokens matched; mockup's standalone palette not imported.
- ✅ Mobile handled (documented above).
- ✅ Git identity `c_kendall@icloud.com` / `csk5369` verified before committing.
- ✅ Only real existing routes/functions wired; every gap flagged here + in code.
- ⛔ **Not merged to `main`.** A PR is opened against `main` and left for Chris to
  review and merge himself, per the standing project rule.

## 7. Follow-ups for Chris (optional)

1. Eyeball the pop-out on the preview — confirm no stack drift on hover.
2. Confirm the **Email** tab opens the real M365 inbox as expected (first-ever
   trigger for that view).
3. Decide whether **SMS** should stay pointed at the Comms Hub or get its own
   panel later.
4. Decide whether mobile should get a bottom-sheet version of the quick tabs.
