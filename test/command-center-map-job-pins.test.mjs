import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Reported 2026-08-21, on the expanded Command Center map: hovering an active
// job pin showed nothing at all, and there was no way to get from a pin to the
// job itself.
//
// The popup was never missing -- MapLibre's Marker.setPopup() binds to a CLICK,
// so it existed and simply never opened on hover. These tests run the real
// marker builder against a stubbed MapLibre and assert on what it wires up.

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function extractFunction(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start > -1, `${signature} must exist`);
  let depth = 0, i = src.indexOf('{', start);
  do {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  } while (depth > 0 && i < src.length);
  assert.ok(depth === 0, 'braces must balance');
  return src.slice(start, i);
}

const SOURCE = [
  extractFunction(html, 'function ccAttrEsc(v){'),
  extractFunction(html, 'function ccMapMarker(gl, map, lngLat, html, popupHtml, opts){'),
].join('\n');

/** A DOM and MapLibre stub deep enough to record what got wired to what. */
function harness() {
  const listeners = [];
  const makeEl = () => {
    const el = {
      style: { cssText: '', display: '' },
      innerHTML: '',
      _on: {},
      addEventListener(type, fn) { el._on[type] = fn; listeners.push({ el, type }); },
      nodeType: 1,
      contains(node) { return node === el; },
    };
    return el;
  };
  const popups = [];
  const ctx = {
    String, Object, Math, JSON, console,
    setTimeout: (fn) => { ctx.__pendingHide = fn; return 1; },
    clearTimeout: () => { ctx.__pendingHide = null; },
    document: {
      createElement: makeEl,
      // The pointer guard lives on the document, so the stub has to record it.
      addEventListener(type, fn) { if (type === 'mousemove') ctx.__docMove = fn; },
      removeEventListener(type, fn) { if (type === 'mousemove' && ctx.__docMove === fn) ctx.__docMove = null; },
    },
    maplibregl: {
      Popup: class {
        constructor(opts) { this.opts = opts; this.added = 0; this.removed = 0; this._on = {}; popups.push(this); }
        setLngLat() { return this; }
        setHTML(h) { this.html = h; return this; }
        addTo() { this.added++; this.open = true; return this; }
        remove() { this.removed++; this.open = false; return this; }
        on(evt, fn) { this._on[evt] = fn; return this; }
        isOpen() { return !!this.open; }
        getElement() { return (this.el = this.el || makeEl()); }
      },
      Marker: class {
        constructor(o) { this.el = o.element; this.popup = null; }
        setLngLat() { return this; }
        setPopup(p) { this.popup = p; return this; }
        addTo() { return this; }
      },
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SOURCE, ctx);
  return { ctx, popups, makeEl };
}

function build({ popupHtml = '<b>Job</b>', opts } = {}) {
  const h = harness();
  h.ctx.__opts = opts;
  h.ctx.__popupHtml = popupHtml;
  const mapEl = h.makeEl();
  h.ctx.__map = { _on: {}, on(evt, fn) { this._on[evt] = fn; }, getContainer: () => mapEl };
  vm.runInContext(
    '__marker = ccMapMarker(maplibregl, __map, [1, 2], "<div></div>", __popupHtml, __opts)',
    h.ctx
  );
  return { ...h, marker: h.ctx.__marker, el: h.ctx.__marker.el, map: h.ctx.__map, mapEl };
}

/** Opens the popup by hover and returns the popup + its element, wired as MapLibre would. */
function hoverOpen(b) {
  b.el._on.mouseenter();
  const pop = b.popups[0];
  pop._on.open();                       // MapLibre fires this on addTo
  return { pop, pel: pop.getElement() };
}

// ---------- the reported bug ----------

test('a hover marker opens its popup on mouseenter -- the whole reported bug', () => {
  const b = build({ opts: { hover: true } });
  assert.ok(b.el._on.mouseenter, 'a hover listener must be wired at all');
  assert.equal(b.popups[0].added, 0, 'nothing shown before the pointer arrives');
  b.el._on.mouseenter();
  assert.equal(b.popups[0].added, 1, 'hovering shows the popup');
});

test('a hover marker does NOT use setPopup, which is what bound it to click', () => {
  // setPopup installs MapLibre's own click-to-toggle on the marker element,
  // which would fight click-to-open-the-job.
  const b = build({ opts: { hover: true } });
  assert.equal(b.marker.popup, null, 'the popup is owned outright, not bound by setPopup');
});

test('leaving the pin hides the popup, but only after a grace period', () => {
  // The grace period is what makes the grouped-pin job list reachable: without
  // it, moving the pointer off the pin and onto the popup dismisses it.
  const b = build({ opts: { hover: true } });
  b.el._on.mouseenter();
  b.el._on.mouseleave();
  assert.equal(b.popups[0].removed, 0, 'not dismissed the instant the pointer leaves');
  b.ctx.__pendingHide();
  assert.equal(b.popups[0].removed, 1, 'dismissed once the grace period elapses');
});

test('moving onto the popup itself keeps it open', () => {
  const b = build({ opts: { hover: true } });
  b.el._on.mouseenter();
  b.popups[0]._on.open();               // MapLibre fires this when it opens
  const pel = b.popups[0].getElement();
  b.el._on.mouseleave();                 // pointer leaves the pin...
  pel._on.mouseenter();                  // ...and lands on the popup
  assert.equal(b.ctx.__pendingHide, null, 'the pending dismissal was cancelled');
  assert.equal(b.popups[0].open, true);
});

// ---------- Chris, 2026-08-23: the popup would not go away ----------

test('moving the pointer off the pin and away dismisses the popup', () => {
  // The whole report: hover a job, get the details, and then be stuck with them.
  const b = build({ opts: { hover: true } });
  const { pop } = hoverOpen(b);
  b.ctx.__docMove({ target: b.mapEl });   // pointer is over bare map now
  b.ctx.__pendingHide();
  assert.equal(pop.open, false, 'the popup must be gone once the pointer moves off');
});

test('the dismissal survives a mouseleave that never fires', () => {
  // The popup container is a fresh DOM node on every open, and a node inserted
  // under a stationary cursor never gets the hover state mouseleave needs. The
  // guard has to work off the pointer itself, not off the pin's own events.
  const b = build({ opts: { hover: true } });
  const { pop } = hoverOpen(b);
  b.ctx.__docMove({ target: b.mapEl });   // no mouseleave on pin OR popup
  b.ctx.__pendingHide();
  assert.equal(pop.open, false);
});

test('a pointer moving steadily across the map still dismisses it', () => {
  // Restarting the grace countdown on every mousemove would push it out
  // forever, which is exactly how a popup ends up stranded.
  const b = build({ opts: { hover: true } });
  const { pop } = hoverOpen(b);
  const first = (b.ctx.__docMove({ target: b.mapEl }), b.ctx.__pendingHide);
  b.ctx.__docMove({ target: b.mapEl });
  assert.equal(b.ctx.__pendingHide, first, 'the countdown is not restarted while it runs');
  b.ctx.__pendingHide();
  assert.equal(pop.open, false);
});

test('the pointer sitting on the popup keeps it up', () => {
  // The grouped-pin popup carries a clickable job list; it has to be reachable.
  const b = build({ opts: { hover: true } });
  const { pop, pel } = hoverOpen(b);
  b.ctx.__docMove({ target: pel });
  assert.ok(!b.ctx.__pendingHide, 'nothing is counting down');
  assert.equal(pop.open, true);
});

test('hovering the popup does not tear it down and rebuild it', () => {
  // Re-adding an open popup destroys the node the cursor is sitting on and
  // replaces it with one that has no hover state -- the original trap.
  const b = build({ opts: { hover: true } });
  const { pop, pel } = hoverOpen(b);
  pel._on.mouseenter();
  assert.equal(pop.added, 1, 'opened once, not reopened under the cursor');
  assert.equal(pop.removed, 0);
});

test('panning the map dismisses the popup', () => {
  const b = build({ opts: { hover: true } });
  const { pop } = hoverOpen(b);
  b.map._on.movestart();
  assert.equal(pop.open, false, 'a popup pinned to a moving pin is stale on sight');
});

test('leaving the map entirely dismisses the popup', () => {
  const b = build({ opts: { hover: true } });
  const { pop } = hoverOpen(b);
  b.mapEl._on.mouseleave();
  assert.equal(pop.open, false);
});

test('once dismissed, the pointer guard is unhooked from the document', () => {
  const b = build({ opts: { hover: true } });
  hoverOpen(b);
  assert.ok(b.ctx.__docMove, 'installed while open');
  b.marker.__ccHidePopup();
  assert.equal(b.ctx.__docMove, null, 'a closed popup leaves no listener behind');
});

test('switching a pin off takes its open popup with it', () => {
  // "Tech Locations" hides the job pins; a popup left floating over the map
  // would have nothing under it.
  const html2 = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const fn = extractFunction(html2, 'function ccSetMarkersVisible(markers, on){');
  assert.match(fn, /__ccHidePopup/, 'hiding a marker must dismiss its popup');
});

test('a marker hidden by the view toggle cannot show a popup', () => {
  // "Tech Locations" hides job markers by setting display:none; a hidden pin
  // must not still respond to a pointer passing over where it used to be.
  const b = build({ opts: { hover: true } });
  b.el.style.display = 'none';
  b.el._on.mouseenter();
  assert.equal(b.popups[0].added, 0);
});

// ---------- clicking through to the job ----------

test('clicking a single-job pin calls through, and stops the map handling it too', () => {
  let called = 0, stopped = 0, prevented = 0;
  const b = build({ opts: { hover: true, onClick: () => { called++; } } });
  b.el._on.click({ stopPropagation: () => { stopped++; }, preventDefault: () => { prevented++; } });
  assert.equal(called, 1);
  assert.equal(stopped, 1, 'the map underneath must not also treat this as a map click');
  assert.equal(prevented, 1);
});

test('a marker with no onClick wires no click handler at all', () => {
  const b = build({ opts: { hover: true } });
  assert.equal(b.el._on.click, undefined, 'a grouped pin is not itself clickable');
});

test('markers without opts keep the original click-to-open-popup behaviour', () => {
  // The truck markers still work this way and were not part of this report.
  const b = build({});
  assert.ok(b.marker.popup, 'setPopup is still used when hover was not asked for');
  assert.equal(b.el._on.mouseenter, undefined);
});

// ---------- escaping ----------

test('a job id is escaped before it goes into an HTML attribute', () => {
  const h = harness();
  h.ctx.__v = 'x" onclick="alert(1)';
  vm.runInContext('__out = ccAttrEsc(__v)', h.ctx);
  assert.doesNotMatch(h.ctx.__out, /"/, 'a quote must not survive into an attribute');
  assert.match(h.ctx.__out, /&quot;/);
});

test('the attribute escaper handles quotes, which the global hlEsc at :3937 does not', () => {
  // index.html declares hlEsc three times in three <script> tags; the first
  // escapes only & < >. Which one wins is script order, and that is not
  // something an attribute's safety should depend on -- hence ccAttrEsc.
  const h = harness();
  h.ctx.__v = `& < > " '`;
  vm.runInContext('__out = ccAttrEsc(__v)', h.ctx);
  assert.equal(h.ctx.__out, '&amp; &lt; &gt; &quot; &#39;');
});

// ---------- wiring in the map loader ----------

const loader = extractFunction(html, 'function loadMapLive(){');

test('job pins are built with hover on', () => {
  assert.match(loader, /hover: true/, 'the job markers must ask for hover');
});

test('a single-job pin opens that job; a grouped pin does not guess', () => {
  assert.match(
    loader,
    /onClick: single && p0\.jobId \? function\(\)\{ ccOpenJobFromMap\(p0\.jobId\); \} : null/,
    'exactly one job means open it; more than one means no pin-level click'
  );
});

test('every job in a grouped popup is individually openable', () => {
  assert.match(loader, /data-cc-jobid="/, 'each row in the list carries its own job id');
  assert.match(loader, /Click to open/, 'and says so, rather than looking inert');
});

test('a single-job pin tells the reader the click will do something', () => {
  assert.match(loader, /Click the pin to open this job/);
});

// ---------- opening the job ----------

const opener = extractFunction(html, 'function ccOpenJobFromMap(jobId){');

test('opening a job leaves full screen first', () => {
  // The expanded map is a fixed z-9999 overlay: open the panel behind it and
  // the click looks like it did nothing.
  assert.match(opener, /mapfull/);
  assert.match(opener, /toggleMapFullscreen/);
});

test('opening a job switches to the Jobs tab and opens the real job panel', () => {
  assert.match(opener, /showView\('jobs'\)/);
  assert.match(opener, /openRealJob\(jobId\)/);
});

test('it uses the same opener the Jobs list and Production board use', () => {
  // A pin should open exactly what a row opens, not a second implementation.
  assert.match(html, /onclick="openRealJob\(/, 'the list still uses openRealJob');
  assert.match(opener, /openRealJob/);
});

test('a pin with no job id does nothing rather than opening a blank panel', () => {
  assert.match(opener, /if\(!jobId\) return;/);
});

test('ccOpenJobFromMap is exposed globally, since inline onclick runs in global scope', () => {
  // Same class of bug that broke openRealJob from the Production board cards.
  assert.match(html, /window\.ccOpenJobFromMap = ccOpenJobFromMap/);
});

// ---------- the expanded view specifically ----------

test('popups are lifted above the expanded map overlay', () => {
  // .map-card.mapfull is position:fixed z-index:9999. Without this rule the
  // popup stacks below it and a hovered pin appears to show nothing -- which is
  // exactly how the bug was reported.
  assert.match(html, /\.map-card\.mapfull \.maplibregl-popup\{z-index:10000\}/);
});
