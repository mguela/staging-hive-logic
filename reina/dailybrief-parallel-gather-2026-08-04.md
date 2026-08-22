# Daily Brief ("Today's Decisions") — parallel gather (2026-08-04)

Branch: `feature/dailybrief-parallel-gather` (off `origin/main` @ `22b61f4`)

## Symptom

"Today's Decisions" (the Reina Daily Brief card, `resource=dailybrief`) took
nearly a minute to load. The card fetches `dailybrief` + `crew_schedule` in
parallel on the frontend, so its wall-clock is dominated by whichever is
slower — and `dailybrief` was the slow one.

## Root cause

`handleFiDailyBrief` in `api/track1.js` gathered **six independent data sets
sequentially** — each `try { await … }` block finished before the next began:

1. QuickBooks (accounts + bills-due + P&L; cold ≈ 10–15s)
2. Jobber completed-not-invoiced + past-due (3 Supabase full-table scans)
3. Stalled jobs (2 Supabase scans)
4. Today's visits (1 scan)
5. Open quotes (1 scan)
6. Weather

So the cache-miss brief cost the **sum** of all six. The finished payload is
cached for 10 minutes (`FI_BRIEF_TTL_MS`), so this was paid by the first viewer
of each 10-minute cycle (and on serverless cold starts).

None of the six blocks reads another block's result — they only get combined at
the `decisions` / `headline` assembly, and each writes its own outer-scoped
variables plus a **distinct** `notConnected.<key>`.

## Fix

Wrapped each of the six blocks in an `async` IIFE and launched them together in
one `await Promise.all([...])`. Every block keeps its own `try/catch` verbatim,
so a single source failing still degrades to its `notConnected` note without
taking the others down. Wall-clock on a cache miss drops from the **sum** of all
six to roughly the **slowest single block** (the QuickBooks reports) — a ~3–4×
improvement. The emitted payload is byte-for-byte the same shape; only timing
changed.

Behaviour explicitly preserved:
- 10-minute cache read/write path untouched (still short-circuits on a hit).
- QuickBooks sub-calls were already `Promise.all`'d internally — unchanged.
- Per-source failure isolation unchanged (distinct `notConnected` keys).

## Tests — `test/reina-dailybrief-parallel.test.mjs` (real invocation, vm)

Extracts the real, unmodified `handleFiDailyBrief` source and runs it against
controllable I/O stubs (no mocked results):

- **Concurrency proof** — gates every first-touch I/O call; asserts all six
  blocks are in-flight before any resolves (sequential code would have started
  only the first block).
- Payload shape preserved (`ok`, `decisions[]`, all source keys).
- One block failing degrades to its `notConnected` note; the other five still
  return their data.
- A warm cache still short-circuits before any block starts.
- Regression guard that the concurrent-gather shape is present in real source.

### Results

- `npm test` — **1221 passed, 0 failed, 2 skipped** (1223 total).
- `npm run test:smoke` — 19 passed, 2 failed; both failures run anonymously
  against deployed production (`/api/chat` wrong-method → 401; `sync-extended`
  counts), pre-existing and unrelated to this change.

## Not done (available follow-ups)

- **Stale-while-revalidate**: serve the stale cache instantly and recompute in
  the background so no viewer ever waits even on a cold cache. Bigger cache-path
  change; deferred pending Chris's call.
- **Cache warming cron**: recompute before the 10-minute TTL lapses.

## Files

- `api/track1.js` — `handleFiDailyBrief` blocks parallelized (behaviour-preserving).
- `test/reina-dailybrief-parallel.test.mjs` — new.

Branch pushed. **Not** merged to `main` — Chris's call.
