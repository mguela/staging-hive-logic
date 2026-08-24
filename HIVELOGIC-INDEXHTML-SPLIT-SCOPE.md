# index.html split — scope (v2, corrected)

Goal Chris stated: **bulletproof and lightning fast.**

**v2 supersedes the first draft of this doc.** Measuring it (see
`HIVELOGIC-PERF-BASELINE.md`) invalidated three claims in v1. Corrections are
called out in §2 rather than quietly edited, because the v1 plan was approved
and partly acted on.

Status: baseline measured, `defer` fix shipped in this PR. Everything below
Track A is **scoped only, not built.**

---

## 1. What index.html actually contains

Measured at `origin/main` (`778b2ccd`) and against prod.

| Thing | Measured |
|---|---|
| `public/index.html` | 26,240 lines / 2,117,656 bytes (prod: 2,346,236) |
| — **embedded iframe documents** (14 mockups, 8 built, 1 dead — see §4a) | **9,649 lines / 758,836 bytes — 32%** |
| — real application document | 1,587,400 bytes — 68% |
| Inline `<script>` blocks | 137 |
| Inline `<style>` blocks | 38 |
| Top-level `function` declarations | 756 |
| View containers (`id="view-*"`) | 46 |
| Embedded iframe documents (`data-hl63`) | **23** (+1 already extracted: `csx`) |
| Tests that read index.html as source text | 38 of 191 files |
| Bundler / build step | none — plain static files |

## 2. Corrections to v1

**v1 claim: "Leaflet is loaded twice — `index.html:2343` and `:11212`."**
Wrong. Line 11212 is not a script tag in the document at all. It is *inside*
the `data-hl63` attribute of `<iframe id="if-ldx">` — a complete HTML document
stored as an escaped attribute string. It never executes unless that iframe is
populated. There is exactly **one** real Leaflet tag. Nothing to dedupe. Had
this "fix" been applied blind, it would have broken the Leads mockup view.

**v1 claim: "defer the 19 local `<script src>` tags — 1 hr, unblocks first paint."**
Overstated. 16 of the 19 sit at line 12111 or later, at the end of the body,
where the document is already parsed — deferring them is ~a no-op. Of the
remaining three, `reina-global-search.js` **must not** be deferred
(`index.html:17064` consumes it at parse time; deferring silently breaks global
search). The real win was two `<head>` libraries, which is what shipped.

**v1 claim: extraction waves sized by view — "tox ~1,529 lines, vcx ~607, …"**
Those line counts were measuring the **embedded iframe payloads**, not extractable
view logic. The wave ordering in v1 was therefore sizing the wrong thing. These
are not a JS-module problem; they are a static-HTML problem with a much easier
fix (§4). Calling them all "mockups" was also wrong — 8 of the 23 are built
against live, implemented endpoints. See §4a.

**What v1 got right:** the duplicate-globals finding, the 38-test coupling cost,
the "splitting alone does not make it faster" framing, and measure-first.

## 3. Two tracks, still

- **Track A — Fast:** get bytes off the parse path. Mostly *not* a JS split.
- **Track B — Bulletproof:** kill the global-collision bug class. *Is* a JS split.

Track A is now known to matter mainly on **cold** loads — warm load event is
432 ms, which is fine. See baseline §3.

## 4. Track A — the real speed work, in payoff order

| # | Change | Effort | Win |
|---|---|---|---|
| A1 | ~~Remove duplicate Leaflet~~ | — | **Void — does not exist.** See §2. |
| A2 | `defer` Leaflet + GridStack in `<head>` | done | 228 KB off the cold critical path |
| **A3** | **Move the 23 embedded iframe documents into real `.html` files, the way `csx` already is** | **3–4 days** | **758 KB (32%) off every load, warm and cold** |
| A4 | Self-host the 4 CDN libs | half day | removes 2 third-party DNS+TLS handshakes and a supply-chain dependency on cdnjs/jsdelivr |
| A5 | Load Leaflet/GridStack/pdf.js on demand rather than on every page | 1 day | ~230 KB off loads that never open a map or the Command Center grid |

**A3 is the single biggest item in this document.** But "mockups" was the wrong
label for the whole set — see §4a. Only 14 of the 23 are mockups. The mechanism
already exists in this codebase and is running in prod (§4b), so this is
repetition of a proven change, not new architecture.

Risks specific to A3:
- The payloads are HTML-escaped (`&quot;`) inside the attribute; they must be
  unescaped exactly once on extraction. Verify each extracted file parses.
- `index.html:24724` themes these frames on their `load` event
  (`iframe[id^="if-"]`). The already-extracted `csx` shows the pattern works,
  but re-check per frame.
- The 14 true mockups are **design specs Chris wants built** (memory:
  `mockups-are-design-specs`). Extract verbatim. Do not tidy or delete.

### 4a. What the 23 embedded documents actually are

Classified by evidence, not by assumption: self-declared status banners in the
markup, `fetch()` targets in each payload, and whether those endpoints exist in
`api/`. **Every endpoint listed below was verified present** in `api/track1.js`,
`api/takeoffs.js`, or `api/qbo/`.

**BUILT — 8 views, 337.7 KB.** Real endpoints, all implemented server-side:

| view | KB | endpoints | notes |
|---|---|---|---|
| `tox` HiveGrid | 114.2 | `/api/takeoffs` ×3, `/api/track1?resource=quotes` | largest single document in the file |
| `prx` Presentations | 45.9 | `/api/track1?resource=quotes` | reads real quotes |
| `vcx` Vendor Catalog | 41.5 | 9 endpoints (materials search/cart/nickname, jobs, quotes) | most wired of the set |
| `jsx` Job Setup & Readiness | 37.1 | 5 (job_readiness_*, job_workflow_*, jobs) | 6 helper fns in the outer doc |
| `fix` Financial Intelligence | 32.3 | 4 (cash, leaks, overhead, forecast) | |
| `pnlx` Profit & Loss (Live) | 23.9 | `/api/qbo` financials ×2 | real QuickBooks |
| `tmx` T&M & Service Work | 22.5 | tm_live, tm_rate_types_list | **self-declares "Partial prototype"** |
| `ldx` Live Dispatch | 20.3 | maplocations, crew_schedule, dispatch_alerts | 10 helper fns in the outer doc |

**MOCKUP — 14 views, 337.9 KB.** Each carries its own banner reading *"this is a
design mockup, not a working feature"*, and none contains a single `/api/` call:

`repx` Reports & Intelligence (42.0) · `pbkx` Payment Breakdowns (31.2) ·
`dbx` Modular Dashboards (29.5) · `ivx` Inventory & Truck Stock (28.6) ·
`cmx` Comms Hub (27.0) · `pcx` Client Portal (25.5) · `cpx` Capacity Planning (23.0) ·
`pex` Employee Portal (22.6) · `pbx` Price Book (22.2) · `rwx` Remote Work (19.5) ·
`fax` Field App Mobile (19.3) · `ptx` PTO Tracking (18.9) ·
`mbx` Memberships (14.6) · `ccv2` Command Center V2 (14.0)

**DEAD WEIGHT — 1 view, 22.1 KB.** `psx` Sub Portal. The view itself is live —
`index.html:23770` loads it from `/subportal-admin/`, a real page that exists —
but its embedded `data-hl63` payload is **never read**. It can simply be deleted.

### 4b. The extraction pattern already exists and ships in prod

`public/views/` already holds 13 extracted HTML files, and `csx` already loads
this exact way (`index.html:23755`):

```js
if (v === 'csx') {
  fetch('/views/csx.html')
    .then(r => { if (!r.ok) throw new Error('csx.html HTTP ' + r.status); return r.text(); })
    .then(html => { f.srcdoc = html; f.dataset.loaded = '1'; })
    .catch(e => console.error('[csx view] failed to load views/csx.html', e));
}
```

Every other view still runs the old branch on the same line:
`f.srcdoc = f.getAttribute('data-hl63')`.

So A3 is not new architecture — it is applying the `csx` change 22 more times.
`csx.html` is 44.9 KB, already out of index.html, already working in prod. That
is the proof this works, and it is the template to copy.

Two consequences worth noting:
- Payloads are injected **lazily on view open**, not at page load, so they cost
  parse time and bytes but no runtime today.
- Ordering: do `psx` first (pure deletion), then the 14 mockups (no API
  coupling, lowest risk), then the 8 built views (real endpoints, needs a
  functional check per view).

## 5. Track B — the JS split, for correctness not speed

Seven names are declared 2–4× at top level and silently overwrite each other on
`window`: `showDetail` ×4, `hlToast` ×4, `hideDetail` ×4, `esc` ×3,
`toggleForm` ×2, `money` ×2, `hlEsc` ×2. Which one you get depends on parse
order, and parse order changes whenever anyone reorders a script block. **This
is the clearest "not bulletproof" defect in the file.**

The pattern to follow already exists and is running in prod — eleven view
modules are extracted as plain `<script src>` (`app-bookkeeping.js` 985 lines,
`app-marketing.js` 1,639, `app-books-home.js` 729, and eight more). No bundler,
no framework, same convention.

The seam is `showView(v)` at `index.html:17304` — one router function, already
carrying `if (v==='x' && typeof fn==='function') fn()` hooks that a lazy loader
can replace one view at a time.

Suggested order, now that the mockups are correctly excluded:
1. **One real view end to end**, to prove the loader and the test updates. Pick a
   view with genuine JS behind it, not a mockup.
2. **Extract the 7 colliding globals** into a single `app-shared.js` with one
   real implementation of each. This is the actual bulletproof deliverable and
   does not depend on step 1.
3. Remaining views, ~3 per PR.

`schedule` is excluded from all waves — it is under active rebuild
(`HIVELOGIC-SCHEDULE-MASTER-PLAN.md`, crew-row live integration). Splitting a
moving target guarantees conflicts.

## 6. Risks

| Risk | Reality | Mitigation |
|---|---|---|
| **38 test files read index.html as source** | Moving code out breaks them — the largest single cost line, bigger than the extraction | Each wave updates the tests for the views it moves; budget test time ≈ extraction time |
| **CRLF** | index.html is CRLF; `sed -i` silently rewrote the whole file to LF during this very PR and had to be converted back | Verify byte delta and `file` output after every edit, before committing |
| **Build marker** | Every index.html edit needs `scripts/stamp-page-build.mjs`, and `test/page-build-marker.test.mjs` fails CI if you forget | Add to each PR checklist |
| **View id collisions** | `ivx` is both the Inventory view and the live Invoices code prefix (memory: `view-id-collisions`) | Never extract by grepping a bare view id; match the container element |
| **More files, no bundler** | Only pays off if the extra files are genuinely *not* fetched on load | A3 and A5 are the lazy part; without them a split is neutral-to-negative |
| **Parallel sessions** | Two sessions have collided on the same files before (memory: `duplicate-work-collisions`) | Checked: no open PR currently touches index.html |

## 7. Recommended next step

**Do A3.** It is 32% of the page, it helps every load rather than only cold ones,
it needs no router changes, no bundler, and no test rewrites — the mockups have
no JS coupling into the main document. It is the best ratio of win to risk in
this document by a wide margin.

Track B is worth doing for the collision bugs, but on the evidence it is a
correctness project, not a speed one, and can proceed a wave at a time between
features rather than as a dedicated push.
