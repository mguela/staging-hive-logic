# Delete Dead Mockup Views — 2026-08-17

**Branch:** `feature/delete-dead-mockup-views` (off `origin/main` @ `0593ce3`)
**Git identity:** `csk5369` / `c_kendall@icloud.com`
**Files changed:** `public/index.html`, `api/_lib/page-build.js` (build-marker restamp), this file
**Merge policy honoured:** nothing merged to `main`; PR opened for Chris to review and squash-merge.

Permanently deleted 5 of the 6 requested dead views from `public/index.html`. The 6th
(`phx`) was already gone before this branch started. Nothing was hidden; nothing else
was touched.

> Written as `REPORT-delete-dead-mockup-views.md` rather than `REPORT.md`, because
> `REPORT.md` already holds the Schedule Tab Repairs report and the repo convention is
> `REPORT-<topic>.md` (see `REPORT-cc-layout-editor.md`, `REPORT-rolodex-quick-tabs.md`,
> `REPORT-team-todo-rewire.md`).

## Result

| id | Label | Status |
|---|---|---|
| `fax` | Field App | **Deleted** — nav, view container, route entry, HLGRP entry |
| `phx` | V63 Review | **Already deleted** — no work needed (see below) |
| `rwx` | Remote & Production | **Deleted** — nav, view container, route entry, HLGRP entry |
| `ccv2` | (orphan, no nav) | **Deleted** — view container, route entry |
| `cmx` | Comms Hub (orphan) | **Deleted** — view container, floating 💬 icon button. One reference intentionally kept (see below) |
| `dbx` | (orphan, no nav) | **Deleted** — view container, route entry, HLGRP entry, plus its only consumer `ccRole()` |

Byte delta on `public/index.html`: **2,201,161 → 2,049,515 = 151,646 bytes saved (−6.9%)**.
Line delta: 1,489 lines removed from `index.html`.

`<div id="view-*">` containers: 46 → 41. Sidebar `nav-*` entries: 49 → 47.

## Surprises

### 1. `phx` was already deleted — nothing to do
`phx` ("V63 Review" / "Philosophy Review") does not exist anywhere in `origin/main`.
It was removed in commit `0e7a096` ("Remove the internal 'V63 Review' / 'Philosophy
Review' (phx) dev artifact"). The only `phx` hits in the repo are `phx_close` /
`phx_error` / `phx_join` strings inside the bundled Supabase realtime client
(`public/vi-app/assets/index-*.js`) — Phoenix channel protocol constants, unrelated.
No change made.

### 2. `dbx` was referenced by `ccRole()` — dead code, removed with it
`index.html` had `var src=document.getElementById('if-dbx').getAttribute('data-hl63');`
inside `function ccRole(r, el)` — a Command Center "role preview" that rendered the dbx
mockup into a `#ccrolewrap` iframe.

Verified dead before removing:
- `ccRole` had **zero callers** anywhere in the repo.
- Its anchor element `#ccroles` **does not exist** in the document (zero `id="ccroles"`
  occurrences), so `bar.querySelectorAll(...)` would have thrown on the first call.
- The adjacent in-file comment (dated 2026-08-16) says the HLLAYOUTS design mock that
  drove this preview "is gone (replaced by the real layout store)" and "The real layout
  is now applied by `hlCcApplyLayout` instead."

`ccRole` existed solely to render `if-dbx`, so it was deleted with it. Leaving it would
have left a dangling `getElementById('if-dbx')` that returns `null`.

**Left in place (out of scope, does not reference any of the 6 ids):** one line further
down, `try{ var fp=document.querySelector('#ccroles .rp'); ... }catch(e){}`. It is part
of the same abandoned role-preview mock and is already a silent no-op inside its
`try/catch`. Flagging rather than removing.

### 3. `'#cmx'` intentionally kept in `LEGACY_HASHES` — it is live behavior
`index.html` still contains:

```js
var LEGACY_HASHES = ['#cmx','#mail','#/comms','#/email'];
```

This is the HiveConnect legacy-hash shim, which the task explicitly excludes from
changes. It is **not** a dangling reference to the deleted view — it maps old `#cmx`
bookmarks onto HiveConnect. Verified live in the browser: setting `location.hash =
'#cmx'` still rewrites to `#/hiveconnect` and shows the HiveConnect view.

This is the only remaining occurrence of any of the 6 ids in the codebase.

### 4. Build marker required a restamp
`test/page-build-marker.test.mjs` failed after the edit (by design — it hashes
`index.html` plus its assets). Ran `node scripts/stamp-page-build.mjs`, which updated
`api/_lib/page-build.js`. That is the second file in this diff.

## Verified

**Residual-reference audit** — word-boundary grep for all 6 ids across `public/`,
`api/`, `test/`, `scripts/`: **zero** matches except the intentional `'#cmx'`
legacy-hash entry above. No references existed outside `index.html` to begin with.

**Tests**
- `npm test` — **2151 passed, 0 failed, 2 skipped** (2153 total).
- `npm run test:smoke` — **21 passed, 0 failed**.

**Browser (local static serve of `public/` on :8141)**
- Cold load: **no `ReferenceError`, no `TypeError`, no "is not defined", no "Cannot
  read"**. The only console errors are `HTTP 404` on `/api/*` and "not signed in",
  expected because a static file server has no API.
- `getElementById` for all `view-*`, `nav-*`, `if-*` variants of the 6 ids: **all null**.
- `#hlcomms` (the 💬 Comms Hub icon button): **gone**; neighbouring top-bar icons
  (⧉, 🌙, 🔔, 📞, ⚙, ?, avatar) all still render.
- `HL_ROUTE_VIEWS` (39 entries) and `HLGRP`: **zero** dead ids remain.
- Routed through 12 live views — `cc`, `schedule`, `jobs`, `invx`, `clients`, `pcx`,
  `pex`, `ptx`, `docs`, `reports`, `financial`, `ttx`: **none threw**, each container
  became `display:block`, and each rewrote the hash correctly (`#/jobs`, `#/clients`, …).
  No blank screens.
- Deep link `#/cc` on a cold load: works.
- Sidebar groups that lost an entry still expand with the correct remaining children:
  `grp-people` → `[ptx, ttx, agents, team]` (rwx gone), `grp-portal` → `[pcx, psx, pex]`
  (fax gone). `grp-money` and `grp-insights` unchanged.
- `showView`, `hlGrp`, `openHiveConnect` all still defined; `window.ccRole` now
  `undefined`, as intended.

## Not verified

- **Vercel preview URL.** Vercel Deployment Protection SSO 302s every preview request,
  including `/api/health`, so preview-URL verification is not possible from this
  environment. Browser verification above was done against a local static serve of the
  same `public/` directory instead. Signed-in behavior on real production data is
  therefore unverified — the click-through was done in the signed-out state.
- A screenshot could not be captured (the Browser pane was not compositing frames);
  verification is DOM- and console-level rather than visual.

## Untouched, as instructed

`pbx` (Price Book, orphaned but pending a build/delete decision), all other mockup views
(`co`, `repx`, `ivx`, `mbx`, `ptx`, `pcx`, `psx`, `pex`, `cpx`, `pbkx`, `csx`), every
live/partially-live view, and the `hiveconnect` legacy-hash shim.

One pre-existing `HLGRP` orphan is unrelated to this change and was left alone:
`"marketing": "sales"` has no `view-marketing` or `nav-marketing` element. It predates
this branch.
