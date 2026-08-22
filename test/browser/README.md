# Browser tests for the schedule board

```bash
npm run test:ui
```

Runs headless Chromium against the **real** `public/` tree with stubbed APIs.
No network, no deployed preview, no human looking at a screen.

## Why this exists

Every bug in here was reported by Chris after being told it was fixed. They all
share a shape: they are questions about **geometry after layout** — does this
element overlap that one, does the page grow a second scrollbar, is the map
where it should be. Unit tests cannot answer any of them, because nothing has
been laid out. Reading the code cannot answer them either; I tried, and was
wrong repeatedly.

| Test | The report it came from |
|---|---|
| controls clear a panel opened by click | *"the over lap is a problem"* → *"not fixed"* |
| closing the panel returns the width | same bug, the other direction |
| page never scrolls, board does | *"resize to fit in the current view… getting rid of the 1 slide bar"* |
| headers stay put while rows scroll | *"I dont think it should move the bars at the top"* |
| backdrop visible through the lanes | *"the map is very faint and barely visible"* |
| map centred on the shop | *"the shop address is not the center of the map"* |
| pins are the period's jobs, in frame | *"active jobs dont show"* |

## Two rules these tests enforce on themselves

**1. A measurement that cannot fail proves nothing.** The overlap bug was
reported fixed while fully present, because the probe measured a control
cluster that had no size yet. `assertConclusive()` now refuses such a result
and reports `vacuous` instead of "clear". Same for the scroll test: it asserts
the board *can* scroll before asserting what stays put, since a board too short
to scroll would pass silently.

**2. Reach the state the way a user does.** The overlap lived only in
*panel-opened-by-click* — which skips `render()`, and therefore skips the
re-measure. A harness that loaded with the panel already open never saw it. The
test explicitly closes the panel, forces a render, asserts it is closed, and
only then clicks.

## The harness is mutation-checked

Re-introducing each original bug fails exactly the test that covers it, and no
others:

| Bug put back | Result |
|---|---|
| drop the panel re-measure + `ResizeObserver` | tests 1, 2 fail |
| layer opacity `.38`, lane scrim `62%` | test 5 fails |
| centroid camera, non-symmetric fit | test 6 fails |

If you add a test here, do this to it before trusting it.

## Layout

- `fixtures.mjs` — roster, visits, vehicles. Each awkward row (long roster, crew
  with no vehicle, stale fix, one bad geocode) is there because a bug hid behind
  its absence.
- `serve.mjs` — serves `public/` and stubs `/api/*`. Port 0, so runs never
  collide.
- `driver.mjs` — finds Chromium, seals the network, exposes each MapLibre map on
  `window.__maps` so tests read the real camera rather than inferring it.
- `board-ui.test.mjs` — the tests.

## In CI

The `board-ui` job in `.github/workflows/hardened-completion-gate.yml` runs this
on every PR, alongside the unit gate. It installs Chromium (cached, keyed on the
`playwright-core` version) and sets `HL_UI_TESTS_REQUIRED=1`.

That variable turns "no browser, skip" into a **hard failure**. Skipping is the
right behaviour on a laptop without a browser; in CI it would mean a green run
that executed nothing — the same vacuous pass this suite exists to prevent, just
one level up. Verified both ways by forcing `findChromium()` to return null:
strict mode fails naming the reason, lenient mode skips naming the reason.

## Requirements

`playwright-core` and `maplibre-gl` are devDependencies. Chromium is found via
`CHROMIUM_PATH`, `PLAYWRIGHT_BROWSERS_PATH`, `/opt/pw-browsers`, the Playwright
cache, or a system install. If either is missing the tests **skip with the
reason** rather than failing or, worse, passing.

External hosts are intercepted rather than allowed: map tiles are served as a
generated stand-in, everything else is aborted. This is not only for
hermeticity — in a sandbox that blocks egress, a request **hangs** instead of
failing, which stalls MapLibre's `load` event and yields a map with no pins and
no fit. A test measuring that would report a confident wrong answer.
