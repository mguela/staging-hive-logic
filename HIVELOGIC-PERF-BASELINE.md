# Performance baseline — index.html critical path

Measured 2026-08-23 against **prod** (`https://hivelogic-live.vercel.app`) and
the repo at `origin/main` (`778b2ccd`). This is the Phase 0 baseline from
`HIVELOGIC-INDEXHTML-SPLIT-SCOPE.md` — every later phase reports the same
numbers so the win is provable rather than asserted.

---

## 1. Page weight (deterministic — reproducible, not machine-dependent)

Prod `/` as served:

| Measure | Bytes |
|---|---|
| Wire transfer (brotli) | **597,269** |
| Decompressed, i.e. what the HTML parser walks | **2,346,236** |
| — of which: embedded iframe mockup documents | **758,836 (32%)** |
| — of which: real application document | 1,587,400 (68%) |

Render-blocking libraries in `<head>` (fetched fresh on a cold load):

| Library | Raw | Gzip |
|---|---|---|
| `leaflet.min.js` | 147,171 | 42,418 |
| `gridstack-all.js` | 81,406 | 22,130 |
| **Total blocking parse** | **228,577** | **64,548** |

`supabase-js@2` (212,199 raw / 54,410 gzip) also loads from CDN but sits deep in
`<body>` at line 14881, so it does not block first paint.

## 2. Real browser timings (prod, warm cache)

Two consecutive loads, Chrome in the Claude Code browser pane:

| Metric | Run 1 | Run 2 |
|---|---|---|
| TTFB | 118 ms | 28 ms |
| HTML download | 61 ms | 41 ms |
| **domInteractive** | 620 ms | **298 ms** |
| DOMContentLoaded | 693 ms | 358 ms |
| **Load event** | 695 ms | **432 ms** |
| Transfer | 584 KB | 584 KB |
| Decoded | 2,291 KB | 2,291 KB |
| Resources | 180 | 239 |

**Caveats, stated plainly:**

- Both runs were **warm-cache** (`X-Vercel-Cache: HIT`; Leaflet and GridStack
  both reported `transferSize: 0`). These are repeat-visit numbers, not
  first-visit numbers.
- No `paint` entries were recorded in either run, so FCP is **not** in this
  baseline. It should be captured on Chris's real machine.
- This browser is software-rendered with no GPU (memory: `browser-has-no-gpu`),
  so anything paint- or map-bound is not representative. The byte measurements
  in §1 and the timings above are network/CPU-bound and are trustworthy;
  rendering numbers from this environment are not.

## 3. The honest read

**The app is not slow on a repeat visit.** 432 ms to load event is fine. The
"lightning fast" work is therefore narrower than it first looked, and splits
into two distinct problems:

1. **Cold / first visit** — 228 KB of Leaflet + GridStack must download, parse,
   and execute before the HTML parser continues past `<head>`. This is what the
   `defer` change in this PR addresses.
2. **Every visit, warm or cold** — 758,836 bytes (32%) of the HTML is mockup
   documents stuffed into iframe `data-hl63` attributes. The parser walks all of
   it on every single load whether or not the user ever opens those views. This
   is the largest remaining item and is **not** addressed by this PR.

## 4. What this PR changes

`defer` on the two `<head>` libraries — `public/index.html:2471` and `:2476`.

Verified safe before changing anything:

- No parse-time use of `L` anywhere; the only `L.map(` call is inside a function.
- `hlInitCcGrid` is called only from `showView` via `setTimeout`, and is already
  guarded by `if (!el || !window.GridStack || ...) return`.
- Every other init path is `DOMContentLoaded`-gated, and deferred scripts execute
  **before** `DOMContentLoaded` — so ordering is preserved.

Expected effect: 228,577 raw / 64,548 gzip bytes off the cold-load critical path.
No expected change to warm-load numbers.

**Not changed, deliberately:** `reina-global-search.js` (line 2742) looks like an
easy defer but is not — `public/index.html:17064` runs
`var HL_GLOBAL_SEARCH = window.ReinaGlobalSearch && ...` at **parse time**.
Deferring the file makes that expression evaluate to `undefined` and global
search silently stops working, with no error. It is a 94-line file, so there was
nothing to win here anyway.

The other 16 local `<script src>` tags all sit at line 12111 or later — the end
of the body — where the document is already parsed. Deferring them is
approximately a no-op and was skipped.

## 5. Verification

- `npm test` — **4,127 tests, 4,125 pass, 0 fail, 2 skipped**, exit 0.
- `node scripts/stamp-page-build.mjs` run; build id `698c51fc…` → `874e3a5e…`.
- Diff is 3 lines in `public/index.html` (2 × `defer`, 1 × build marker) plus the
  matching marker in `api/_lib/page-build.js`. CRLF line endings preserved —
  verified byte delta is exactly +12 (`'defer '` × 2) against the pre-edit file.

## 6. Next measurement

Re-run §1 and §2 after deploy, ideally on Chris's machine with the cache
disabled, and add a cold-load column. Until a cold-load baseline exists, the
gain from this PR is calculated (228 KB off the critical path) rather than
observed — stated here as such rather than claimed as a measured speedup.
