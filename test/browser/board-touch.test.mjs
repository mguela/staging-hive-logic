// Touch gestures on the schedule board map, in a real browser.
//
// app.js calls touchZoomRotate.enable(), touchPitch.enable() and
// dragRotate.enable(), and for weeks that was the whole basis for believing
// pinch/rotate/tilt worked on a phone. It is not evidence: those calls succeed
// whether or not the handlers ever bind, the try/catch around them swallows
// anything that goes wrong, and none of it runs at all if the map is built
// non-interactive. So this drives actual TouchEvents at the real canvas and
// reads the camera afterwards.
//
// Two things make a touch test easy to fake and worthless, both guarded here:
//   1. Dispatching touches at a page Chromium does not consider touch-capable.
//      MapLibre checks for touch support, so the gesture silently does nothing
//      and "the camera did not move" looks like a finding rather than a setup
//      bug. The context is created with hasTouch.
//   2. Asserting a change without first proving the camera CAN change. Every
//      case below records the camera before and after and requires movement in
//      the right direction, not merely inequality.

import test, { before, after } from 'node:test';
import assert from 'node:assert';
import { startServer } from './serve.mjs';
import { findPlaywright, unavailableReason, openBoard, showView } from './driver.mjs';

const reason = unavailableReason();
if (reason && process.env.HL_UI_TESTS_REQUIRED === '1') {
  throw new Error(
    `HL_UI_TESTS_REQUIRED=1 but the browser tests cannot run: ${reason}. `
    + 'Refusing to report a pass for tests that did not execute.');
}
const skip = reason || false;
const chromium = skip ? null : findPlaywright().chromium;

let server, browser, page;

before(async () => {
  if (skip) return;
  server = await startServer();
  ({ browser, page } = await openBoard(chromium, server.url, { touch: true, width: 900, height: 800 }));
  // The board builds TWO maps: a non-interactive backdrop behind the calendar
  // lanes, and the real one on the Map view. The backdrop has every handler
  // disabled ON PURPOSE, so gesturing at it proves nothing -- an earlier draft
  // of this file did exactly that and read the resulting stillness as a bug.
  // Switch to the Map view and take the interactive instance.
  await showView(page, 'map');
  await page.waitForFunction(
    () => (window.__maps || []).some((m) => m.dragPan && m.dragPan.isEnabled() && m.loaded()),
    null, { timeout: 25000 });
  await page.evaluate(() => {
    window.__touchMap = window.__maps.find((m) => m.dragPan && m.dragPan.isEnabled());
  });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

/** The map's canvas box, in page coordinates. */
async function canvasBox() {
  return page.evaluate(() => {
    const c = window.__touchMap.getCanvas();
    const b = c.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height };
  });
}

async function camera() {
  return page.evaluate(() => {
    const m = window.__touchMap;
    return { zoom: m.getZoom(), bearing: m.getBearing(), pitch: m.getPitch() };
  });
}

/**
 * Dispatch a real multi-touch sequence at the canvas. `frames` is a list of
 * [[x,y],[x,y]] positions; each becomes a touchmove, with a touchstart before
 * and a touchend after. MapLibre needs several moves to clear its gesture
 * thresholds, so a single jump does nothing.
 */
async function touchDrag(frames) {
  await page.evaluate((pts) => {
    const canvas = window.__touchMap.getCanvas();
    const mk = (id, x, y) => new Touch({ identifier: id, target: canvas, clientX: x, clientY: y });
    const fire = (type, coords) => {
      const touches = coords.map((c, i) => mk(i, c[0], c[1]));
      canvas.dispatchEvent(new TouchEvent(type, {
        touches, targetTouches: touches, changedTouches: touches,
        bubbles: true, cancelable: true, view: window,
      }));
    };
    fire('touchstart', pts[0]);
    for (let i = 1; i < pts.length; i++) fire('touchmove', pts[i]);
    fire('touchend', []);
  }, frames);
  // let MapLibre settle its camera
  await page.waitForTimeout(400);
}

/** Interpolate a two-finger gesture from a start pair to an end pair. */
function frames(from, to, steps = 12) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    out.push([0, 1].map((f) => [
      from[f][0] + (to[f][0] - from[f][0]) * t,
      from[f][1] + (to[f][1] - from[f][1]) * t,
    ]));
  }
  return out;
}

test('the harness is actually touch-capable, or nothing below means anything', { skip }, async () => {
  const touchy = await page.evaluate(() => ('ontouchstart' in window) || navigator.maxTouchPoints > 0);
  assert.ok(touchy, 'Chromium is not reporting touch support -- every gesture assertion would be vacuous');
  const box = await canvasBox();
  assert.ok(box.w > 100 && box.h > 100, `the map canvas has no usable size: ${JSON.stringify(box)}`);
});

// The distinction that made the first run of this file misleading.
test('the gestures are aimed at the interactive map, not the backdrop', { skip }, async () => {
  const state = await page.evaluate(() => ({
    maps: window.__maps.length,
    onTarget: {
      drag: window.__touchMap.dragPan.isEnabled(),
      zoomRotate: window.__touchMap.touchZoomRotate.isEnabled(),
      pitch: window.__touchMap.touchPitch.isEnabled(),
    },
    anyBackdrop: window.__maps.some((m) => !m.dragPan.isEnabled()),
  }));
  assert.ok(state.onTarget.drag && state.onTarget.zoomRotate && state.onTarget.pitch,
    `the chosen map has handlers off: ${JSON.stringify(state.onTarget)}`);
  assert.ok(state.anyBackdrop,
    'the non-interactive backdrop should still exist -- if it does not, this test is no longer distinguishing them');
});

test('pinching out zooms the map in', { skip }, async () => {
  const before = await camera();
  const box = await canvasBox();
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  await touchDrag(frames(
    [[cx - 30, cy], [cx + 30, cy]],
    [[cx - 160, cy], [cx + 160, cy]],
  ));
  const after = await camera();
  assert.ok(after.zoom > before.zoom + 0.2,
    `pinch-out did not zoom in: ${before.zoom.toFixed(2)} -> ${after.zoom.toFixed(2)}`);
});

test('pinching in zooms the map out', { skip }, async () => {
  const before = await camera();
  const box = await canvasBox();
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  await touchDrag(frames(
    [[cx - 160, cy], [cx + 160, cy]],
    [[cx - 30, cy], [cx + 30, cy]],
  ));
  const after = await camera();
  assert.ok(after.zoom < before.zoom - 0.2,
    `pinch-in did not zoom out: ${before.zoom.toFixed(2)} -> ${after.zoom.toFixed(2)}`);
});

test('twisting two fingers rotates the map', { skip }, async () => {
  const before = await camera();
  const box = await canvasBox();
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const r = 140;
  // Rotate the pair through 60 degrees about the canvas centre, keeping the
  // distance between them constant so this is a rotation and not a pinch.
  const pts = [];
  for (let i = 0; i <= 14; i++) {
    const a = (i / 14) * (Math.PI / 3);
    pts.push([
      [cx + r * Math.cos(a), cy + r * Math.sin(a)],
      [cx - r * Math.cos(a), cy - r * Math.sin(a)],
    ]);
  }
  await touchDrag(pts);
  const after = await camera();
  const moved = Math.abs(after.bearing - before.bearing);
  assert.ok(moved > 5,
    `two-finger twist did not rotate: bearing ${before.bearing.toFixed(1)} -> ${after.bearing.toFixed(1)}`);
});

test('dragging two fingers up tilts the map', { skip }, async () => {
  // touchPitch is a separate handler from touchZoomRotate: two fingers moving
  // together, vertically, with no change in the distance between them.
  const box = await canvasBox();
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2 + 120;
  await page.evaluate(() => window.__touchMap.setPitch(0));
  await page.waitForTimeout(200);
  const before = await camera();
  await touchDrag(frames(
    [[cx - 40, cy], [cx + 40, cy]],
    [[cx - 40, cy - 170], [cx + 40, cy - 170]],
    16,
  ));
  const after = await camera();
  assert.ok(after.pitch > before.pitch + 3,
    `two-finger drag did not tilt: pitch ${before.pitch.toFixed(1)} -> ${after.pitch.toFixed(1)}`);
});
