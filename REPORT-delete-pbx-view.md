# Delete the Price Book (`pbx`) Mockup View — 2026-08-17

**Branch:** `feature/delete-pbx-view` (off `origin/main` @ `d1d6aeb`)
**Git identity:** `csk5369` / `c_kendall@icloud.com`
**Files changed:** `public/index.html`, `api/_lib/page-build.js` (build-marker restamp), this file
**Merge policy:** nothing merged to `main`; PR opened for review.

Follow-up to [#352](https://github.com/csk5369/hivelogic-live/pull/352), which deleted
`fax`, `rwx`, `ccv2`, `cmx` and `dbx` and deliberately left `pbx` in place pending a
build/delete decision. Chris made the call: delete.

## What was removed

`pbx` was already an orphan — no sidebar nav entry (`nav-pbx` did not exist). Removed:

- the `view-pbx` container and its frozen `if-pbx` `data-hl63` iframe (410 lines)
- the `'pbx'` entry in `showView`'s per-view display-toggle array
- `"pbx": "money"` in the `HLGRP` sidebar-group map
- `'pbx'` in the `HL_ROUTE_VIEWS` deep-link allowlist (39 → 38 entries)

`public/index.html`: **2,049,515 → 2,025,036 bytes = 24,479 saved** (LF-normalized, so it
is comparable to the figure in #352). 422 lines removed. `<div id="view-*">` containers:
41 → 40.

## The one thing to look at: the Estimate Builder still needs a price book

`pbx` is **not** like the five views in #352. There is live functionality named after it.

The Estimate Builder has a working **"Browse Price Book"** control — the 💰 Pricing
accordion row calls `pbLookup()`, which searches a `PRICEBOOK` array of 6 service rows.
Those 6 rows were originally hand-transcribed from the `view-pbx` mockup (added at
Chris's 2026-07-21 request so the lookup could live inside the builder rather than
requiring a separate page).

**Deleting the view does not break it.** `PRICEBOOK` is a self-contained literal array
in the Estimate Builder's own script — it never read from `if-pbx` or `view-pbx` at
runtime. The only links between the two were **two comments**. Verified end-to-end in the
browser after deletion: `pbLookup()` runs, and searching "electrical" still returns both
matching rows with correct pricing:

```
Basic electrical outlet installation (per outlet)
Base $28 + labor $95 = $175 price, 48% margin

Electrical panel upgrade (200A→300A) (per panel)
Base $450 + labor $1200 = $2100 price, 56% margin
```

Both comments were updated rather than left pointing at a page that no longer exists.
The old one said the rows were "transcribed verbatim from that page" and that "if Price
Book becomes real/editable later, this array should be replaced with a live fetch from
that same source" — advice that is now impossible to follow. The replacement records the
provenance, notes the source view was deleted on 2026-08-17, and states that this array
is now the only copy and should be replaced by a real editable price book when one is
built. The 6 rows themselves are **unchanged**.

Standing item for Chris, not a defect in this PR: the Estimate Builder's price book is
still 6 hard-coded example rows, not a real, editable, database-backed price list.
Deleting the mockup view does not change that either way — it just removes the dead
second copy of the same static table.

## Residual `pbx` matches: one, in a comment, on purpose

A word-boundary grep for `pbx` across `public/`, `api/`, `test/`, `scripts/`, `sql/` and
`supabase/` returns exactly one hit — inside the new provenance comment, which names
`view-pbx` so anyone doing git archaeology on those 6 rows can find where they came
from. There are no code references left. There were no references outside `index.html`
to begin with.

## `pbkx` is untouched

`pbkx` (Bookkeeping) is a different, live view whose id contains `pbx`-adjacent letters.
It was explicitly checked and is fully intact: 7 occurrences before and after, and in
the browser its view container, nav entry, `HL_ROUTE_VIEWS` entry and `HLGRP` mapping
(`"pbkx": "money"`) all still resolve.

## Verified

**Tests**
- `npm test` — **2184 pass, 0 fail**, 2 skipped (2186 total).
- `npm run test:smoke` — **21 pass, 0 fail**.

**Browser (local static serve of `public/` on :8142)**
- No `ReferenceError`, `TypeError`, "is not defined" or "Cannot read" in the console.
  Only `/api/*` 404s and "not signed in", expected on a static serve.
- `view-pbx`, `nav-pbx`, `if-pbx` — **all resolve to null**.
- `HL_ROUTE_VIEWS.includes('pbx')` → `false`; `'pbx' in HLGRP` → `false`.
- `pbLookup` still a function; `PRICEBOOK` still 6 rows with the first row byte-identical;
  full lookup exercised end-to-end (above).
- Routed through 10 live views — `cc`, `estimates`, `jobs`, `invx`, `clients`,
  `financial`, `pbkx`, `reports`, `co`, `docs`: none threw, all rendered `display:block`,
  all rewrote the hash correctly.
- The Money sidebar group is unchanged and still has all 8 entries (`pbx` was never in
  it): `financial`, `invx`, `pbkx`, `co`, `expx`, `pnlx`, `fix`, `vcx`.
- Only orphaned route id remaining is `ttx`, which is pre-existing and by design — it
  renders through `#workforce` rather than a `view-ttx` container.

**Build marker** — `test/page-build-marker.test.mjs` required the usual restamp;
ran `node scripts/stamp-page-build.mjs`, which updated `api/_lib/page-build.js`.

## Not verified

- **Vercel preview URL.** Deployment Protection SSO 302s every preview request, so
  browser checks were run against a local static serve of the same `public/` instead.
  Signed-in behavior on real production data is unverified — the click-through was
  signed-out.
- No screenshot (the Browser pane was not compositing frames); verification is DOM- and
  console-level.
