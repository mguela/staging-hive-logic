import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Command Center layout editor fix pass (2026-08-16, Chris's 8 reported issues).
//
// Structural + behavioral coverage for R1-R8. These tests read the REAL engine
// and run it in a VM sandbox with a stubbed GridStack and DOM. No mock copy of
// the page, no duplicated implementation.
//
// The engine used to live inline in public/index.html, and this file used to
// find it by slicing between two comment anchors. Since 2026-08-17 it is
// public/app-command-center.js and the whole file IS the engine, so it is read
// whole -- no anchors to drift, and no risk of an anchor silently matching the
// wrong occurrence. See docs/COMMAND-CENTER-EXTRACTION-SCOPE.md.
//
// index.html is still read as `source`, because a few things this file checks
// deliberately did NOT move: the widget markup, and the saved-layouts list UI
// (hlCCLRow) which lives with the rest of the Settings screen.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = path.join(__dirname, '..', 'public', 'index.html');
const ENGINE_PATH = path.join(__dirname, '..', 'public', 'app-command-center.js');
const source = fs.readFileSync(SRC_PATH, 'utf-8');
const ENGINE = fs.readFileSync(ENGINE_PATH, 'utf-8');

test('the page loads the engine module, and no longer carries it inline', () => {
  // The move is only safe while the page actually pulls the file in. A stray
  // revert of the tag would leave every test below passing against a module
  // the browser never loads.
  assert.match(source, /<script src="\/app-command-center\.js"><\/script>/,
    'index.html must load the extracted engine');
  assert.ok(!source.includes('window.hlInitCcGrid = function'),
    'the engine must not also still be inline -- that would run it twice');
  assert.match(ENGINE, /window\.hlInitCcGrid = function/, 'the module must be the engine');
});

// ---- R5: live mode is fully locked ------------------------------------------

test('R5: the ghost remove button is gone -- no widget renders edit-tool markup at page load', () => {
  assert.ok(
    !/<span class="hl-cc-close"/.test(source),
    'the always-rendered .hl-cc-close ✕ must not come back -- edit tools are mounted only while editing',
  );
  // Matched at start-of-line so the fix's own comment, which quotes the old
  // rule to explain the bug, doesn't count as the rule coming back.
  assert.ok(
    !/\n\s*#cc-main-gridstack \.grid-stack-item:hover \.hl-cc-close\{opacity:1\}/.test(source),
    'the unscoped hover rule that lit up the ✕ during normal use is the reported bug and must not return',
  );
  // Nothing in the shipped markup carries the edit affordances.
  assert.ok(!/class="w-tools"/.test(source), '.w-tools must be created in JS, never rendered into the page');
  assert.ok(!/class="w-shield"/.test(source), '.w-shield must be created in JS, never rendered into the page');
});

test('R5: belt-and-braces CSS hides any edit chrome that somehow survives an exit from edit mode', () => {
  assert.match(
    source,
    /#snapshot:not\(\.cc-editing\) \.w-shield,#snapshot:not\(\.cc-editing\) \.w-tools\{display:none !important\}/,
  );
});

test('R5: the grid boots locked (staticGrid) and only hlCcSetEditMode unlocks it', () => {
  assert.match(ENGINE, /staticGrid: true \}, el\);/, 'GridStack must be initialised static');
  // Enter/exit are separate setStatic calls now, because entering has to mount
  // the drag shield in between (see the ordering comment in the engine).
  assert.match(ENGINE, /hlCcMountEditChrome\(\);\s*\n\s*try \{ grid\.setStatic\(false\); \}/,
    'the shield must be mounted BEFORE drag is unlocked, or GridStack never sees it as a handle');
  assert.match(ENGINE, /try \{ grid\.setStatic\(true\); \}\s*catch \(e\) \{\}\s*\n\s*hlCcUnmountEditChrome\(\);/);
});

// ---- R2: interaction shield --------------------------------------------------

test('R2: the shield is a transparent full-bleed overlay above widget content and below the tools', () => {
  assert.match(source, /\.w-shield\{position:absolute;inset:0;z-index:6;background:transparent/);
  assert.match(source, /\.w-tools\{position:absolute;top:6px;right:14px;z-index:7/);
});

test('R2: a drag can start from the shield -- it is first in the GridStack handle list', () => {
  assert.match(ENGINE, /handle: '\.w-shield, \.map-head, \.rb-band, \.cchar-t, \.pg-label, \.rlv-jh-label'/);
});

// ---- R8 (markup half): Today's Decisions is never removable ------------------

test("R8: Today's Decisions is the one widget that never gets a ✕", () => {
  assert.match(ENGINE, /var CC_REQUIRED_WIDGET = 'cc-brief';/);
  assert.match(
    ENGINE,
    /if \(gsId !== CC_REQUIRED_WIDGET && !content\.querySelector\('\.w-tools'\)\) \{[\s\S]*?remove\.className = 'w-remove'/,
    'the tools bar must be built only for widgets other than cc-brief',
  );
});

// ---- R3: Save / Go Back / Cancel Changes ------------------------------------

test('R3: the edit toolbar offers Save, Go back and Cancel changes -- not the old Done/Restore pair', () => {
  assert.match(source, /id="cc-save-btn" onclick="hlCcSaveLayout\(\)"/);
  assert.match(source, /id="cc-go-back-btn" onclick="hlCcGoBack\(\)"/);
  assert.match(source, /id="cc-cancel-changes-btn" onclick="hlCcCancelChanges\(\)"/);
  assert.ok(!/hlRestoreCcDefault/.test(source), 'the old "Restore default layout" button is replaced');
  // As above: the replacement is checked in button form, so the comment that
  // explains what these buttons replaced doesn't trip it.
  assert.ok(
    !/<button[^>]*onclick="hlCcSetEditMode\(false\)"[^>]*>[^<]*Done customizing/.test(source),
    'the old "Done customizing" button is replaced',
  );
  // "+ Add widget" is explicitly retained.
  assert.match(source, /id="cc-add-widget-btn" onclick="hlToggleCcAddMenu\(\)"/);
});

test('R3: Go back confirms before discarding, Cancel changes does not exit edit mode', () => {
  assert.match(ENGINE, /window\.hlCcGoBack = function \(\) \{\s*if \(window\.hlCcIsDirty\(\) && !window\.confirm\('Discard unsaved changes\?'\)\) return;/);
  const cancel = ENGINE.slice(ENGINE.indexOf('window.hlCcCancelChanges = function'), ENGINE.indexOf('window.hlCcGoBack = function'));
  assert.ok(!/hlCcSetEditMode/.test(cancel), 'Cancel changes must stay in edit mode');
  assert.match(cancel, /hlCcApplyLayout\(hlCcClone\(window\._hlCcEntrySnapshot\)\)/);
});

test('R3: positions are no longer auto-saved on every nudge -- that is what made Go back meaningless', () => {
  assert.ok(
    !/grid\.on\('change', function\(\)\{\s*try \{ localStorage\.setItem\('hl-cc-layout'/.test(source),
    'the old save-on-change hook must not return',
  );
  assert.match(ENGINE, /grid\.on\('change', function \(\) \{ hlCcInvalidateMaps\(\); \}\)/);
});

// ---- R4: content fits its frame ---------------------------------------------

test('R4: each widget is its own size container so content reflows off the WIDGET, not the viewport', () => {
  assert.match(
    source,
    /#cc-main-gridstack \.grid-stack-item > \.grid-stack-item-content\{container-type:inline-size;container-name:ccw\}/,
  );
  assert.match(source, /#cc-main-gridstack \.cchar-t\{font-size:clamp\(8\.5px,2\.4cqw,11px\)\}/);
  assert.match(source, /#cc-main-gridstack \.cc-box-scroll\{font-size:clamp\(9\.5px,2\.9cqw,12\.5px\)\}/);
  assert.match(source, /#cc-main-gridstack #recentPhotosGrid\{grid-template-columns:repeat\(auto-fill,minmax\(clamp\(64px,22cqw,120px\),1fr\)\)\}/);
});

test("R4: Today's Schedule is no longer capped at its inline max-height:230px when the widget is resized taller", () => {
  assert.match(source, /#cc-main-gridstack \.sched-scroll\{max-height:none !important\}/);
});

test('R4: scrollbars stay on auto (only on real overflow) and get a stable gutter + thin on-theme styling', () => {
  assert.match(source, /#cc-main-gridstack \.cc-box-scroll\{scrollbar-gutter:stable;scrollbar-width:thin/);
  assert.ok(
    !/#cc-main-gridstack[^\n]*\.cc-box-scroll\{[^}]*overflow-y:scroll/.test(source),
    'never force a permanent scrollbar',
  );
});

test('R4: charts and maps re-measure after a resize (the Leaflet invalidateSize pattern)', () => {
  assert.match(ENGINE, /function hlCcInvalidateMaps\(\) \{[\s\S]*?window\._ccLeafletMap\.invalidateSize\(\)/);
  assert.match(ENGINE, /window\.pgSizeDials\(\)/, 'the Pulse dials are JS-sized and must be nudged too');
  assert.match(ENGINE, /grid\.on\('resizestop', function \(\) \{ hlCcInvalidateMaps\(\); \}\)/);
});

// ---- Boot-race discipline ----------------------------------------------------

test('the layout fetch never fires before the session is restored, and re-runs on hl:signed-in', () => {
  assert.match(ENGINE, /if \(typeof window\.hlRequireSession === 'function'\) window\.hlRequireSession\(run, run\);/);
  assert.match(ENGINE, /window\.addEventListener\('hl:signed-in', function \(\) \{ if \(window\._hlCcGrid\) hlCcBootLoadLayouts\(\); \}\)/);
});

// ---- Sandbox: run the real engine against a stub GridStack + DOM -------------

const WIDGET_IDS = ['cc-map', 'cc-pulse', 'cc-brief', 'cc-watching', 'cc-todo', 'cc-notif', 'cc-jobhealth', 'cc-schedule', 'cc-photos'];
const DEFAULTS = {
  'cc-map': [0, 0, 4, 13], 'cc-pulse': [0, 13, 4, 15], 'cc-brief': [4, 0, 5, 22],
  'cc-watching': [9, 0, 3, 8], 'cc-todo': [9, 8, 3, 8], 'cc-notif': [9, 16, 3, 8],
  'cc-jobhealth': [0, 28, 12, 3], 'cc-schedule': [0, 31, 6, 8], 'cc-photos': [6, 31, 6, 10],
};

function makeEl(tag) {
  const el = {
    tagName: tag, className: '', style: {}, attrs: {}, children: [], parent: null,
    innerHTML: '', textContent: '', title: '', type: '',
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    appendChild(c) { c.parent = this; this.children.push(c); return c; },
    addEventListener() {},
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((n) => n !== this); this.parent = null; },
    get classList() {
      const self = this;
      return {
        contains: (c) => self.className.split(' ').includes(c),
        add: (c) => { if (!self.className.split(' ').includes(c)) self.className = (self.className + ' ' + c).trim(); },
        remove: (c) => { self.className = self.className.split(' ').filter((x) => x !== c).join(' '); },
        toggle: (c, on) => { if (on) self.classList.add(c); else self.classList.remove(c); },
      };
    },
    descendants() { return this.children.flatMap((c) => [c, ...c.descendants()]); },
    matches(sel) {
      // Only the selector forms the engine actually uses.
      if (sel === '.grid-stack-item') return this.className.split(' ').includes('grid-stack-item');
      if (sel === '.grid-stack-item-content') return this.className.split(' ').includes('grid-stack-item-content');
      if (sel === '.w-shield') return this.className.split(' ').includes('w-shield');
      if (sel === '.w-tools') return this.className.split(' ').includes('w-tools');
      if (sel === '.w-shield, .w-tools') return this.matches('.w-shield') || this.matches('.w-tools');
      if (sel === GS_HANDLE) return GS_HANDLE.split(',').some((s) => this.className.split(' ').includes(s.trim().slice(1)));
      const m = /^\[gs-id="(.+)"\]$/.exec(sel);
      if (m) return this.getAttribute('gs-id') === m[1];
      return false;
    },
    querySelectorAll(sel) { return this.descendants().filter((n) => n.matches(sel)); },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
  };
  return el;
}

// Build a stand-in for the #cc-main-gridstack subtree with the same gs-* values
// as the real markup, so hlCcReadLayout() captures the same default template.
function buildGrid() {
  const grid = makeEl('div');
  grid.attrs.id = 'cc-main-gridstack';
  grid._offsetWidth = 1200;
  Object.defineProperty(grid, 'offsetWidth', { get() { return grid._offsetWidth; } });
  WIDGET_IDS.forEach((id) => {
    const item = makeEl('div');
    item.className = 'grid-stack-item';
    const [x, y, w, h] = DEFAULTS[id];
    item.setAttribute('gs-id', id);
    item.setAttribute('gs-x', x); item.setAttribute('gs-y', y);
    item.setAttribute('gs-w', w); item.setAttribute('gs-h', h);
    item.setAttribute('gs-min-w', 2); item.setAttribute('gs-min-h', 2);
    const content = makeEl('div');
    content.className = 'grid-stack-item-content';
    // Every real widget has one of the header strips in GridStack's handle list
    // (.cchar-t / .map-head / .rb-band / ...). The fixture needs one too: with
    // no handle match at all, GridStack falls back to `dragEls = [el]` (the
    // whole item becomes draggable), which would hide the very bug these tests
    // exist to catch.
    const header = makeEl('div');
    header.className = 'cchar-t';
    content.appendChild(header);
    item.appendChild(content);
    grid.appendChild(item);
  });
  return grid;
}

// Minimal GridStack stand-in: enough of load/save/update/addWidget/removeWidget
// to exercise the engine's own logic. It writes positions back to the gs-*
// attributes exactly as the real library does.
//
// It also models ONE behaviour of the real library faithfully, because getting
// it wrong is what broke dragging on the first cut of this fix: GridStack
// resolves its drag handles exactly once, in the DDDraggable constructor --
//
//     this.dragEls = Array.from(el.querySelectorAll(option.handle))
//     ...
//     if (this.dragEls.length === 0) { this.dragEls = [el]; }
//                            (gridstack 10.3.1, dist/dd-draggable.js:25-30)
//
// -- and that constructor runs inside setStatic(false) / addWidget(). Anything
// matching the handle selector that appears AFTER that call never gets a
// mousedown listener. Since .w-shield covers the header strips, a shield
// mounted late doesn't just fail to drag, it swallows the mousedowns the
// headers would have handled, and nothing on the page drags at all.
//
// So: this stub snapshots dragEls at enable time, exactly like the real thing,
// and dragHandlesFor() reports what a real pointer would actually be able to
// grab.
const GS_HANDLE = '.w-shield, .map-head, .rb-band, .cchar-t, .pg-label, .rlv-jh-label';
function makeGridStack(gridEl) {
  const removed = new Set();
  const dragEls = new Map(); // gs-id -> elements that carry a mousedown listener
  const resolveDragEls = (item) => {
    const found = item.querySelectorAll(GS_HANDLE);
    dragEls.set(item.getAttribute('gs-id'), found.length ? found : [item]);
  };
  const api = {
    _static: true,
    // What a real pointer could start a drag from on this widget, right now.
    dragHandlesFor(gsId) { return this._static ? [] : (dragEls.get(gsId) || []); },
    setStatic(v) {
      this._static = v;
      dragEls.clear();
      if (!v) gridEl.querySelectorAll('.grid-stack-item').forEach(resolveDragEls);
    },
    on() {},
    save() {
      return gridEl.querySelectorAll('.grid-stack-item')
        .filter((n) => !removed.has(n.getAttribute('gs-id')) && n.style.display !== 'none')
        .map((n) => ({ id: n.getAttribute('gs-id'), x: +n.getAttribute('gs-x'), y: +n.getAttribute('gs-y'), w: +n.getAttribute('gs-w'), h: +n.getAttribute('gs-h') }));
    },
    load(items) {
      items.forEach((it) => {
        const n = gridEl.querySelector(`[gs-id="${it.id}"]`);
        if (!n) return;
        removed.delete(it.id);
        n.setAttribute('gs-x', it.x); n.setAttribute('gs-y', it.y);
        n.setAttribute('gs-w', it.w); n.setAttribute('gs-h', it.h);
      });
    },
    update(node, opts) {
      if (opts.w !== undefined) node.setAttribute('gs-w', opts.w);
      if (opts.h !== undefined) node.setAttribute('gs-h', opts.h);
    },
    addWidget(node) {
      removed.delete(node.getAttribute('gs-id'));
      if (!this._static) resolveDragEls(node); // addWidget re-creates this node's DD
    },
    removeWidget(node) { removed.add(node.getAttribute('gs-id')); },
  };
  return api;
}

function bootEngine({ storedLayouts = [], apiWorks = true } = {}) {
  const gridEl = buildGrid();
  const snapshot = makeEl('div');
  snapshot.attrs.id = 'snapshot';
  const byId = { 'cc-main-gridstack': gridEl, snapshot };
  const store = {};
  const listeners = {};
  const sandbox = {
    console: { warn() {}, log() {} },
    JSON, Number, Math, Object, Array, String, Boolean, Promise, Error, Date,
    setTimeout: () => 0,
    document: {
      readyState: 'complete',
      getElementById: (id) => byId[id] || null,
      addEventListener() {},
      createElement: (t) => makeEl(t),
    },
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    fetch: () => (apiWorks
      ? Promise.resolve({ json: () => Promise.resolve({ ok: true, layouts: storedLayouts }) })
      : Promise.reject(new Error('offline'))),
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = (ev, fn) => { listeners[ev] = fn; };
  sandbox.window.confirm = () => true;
  sandbox.GridStack = { init: (opts, el) => makeGridStack(el) };
  vm.createContext(sandbox);
  vm.runInContext(ENGINE, sandbox, { filename: SRC_PATH });
  sandbox.hlInitCcGrid();
  return { sandbox, gridEl, snapshot, store, listeners };
}

/** Resize a widget the way GridStack's own edge drag does. */
function resize(sandbox, gsId, w, h) {
  const node = sandbox.document.getElementById('cc-main-gridstack').querySelector(`[gs-id="${gsId}"]`);
  sandbox._hlCcGrid.update(node, { w, h });
}

function layoutMap(sandbox) {
  const out = {};
  sandbox.hlCcCurrentLayout().widgets.forEach((w) => { out[w.id] = w; });
  return out;
}

test('sandbox sanity: the engine boots, captures the HTML defaults as the template, and starts locked', () => {
  const { sandbox } = bootEngine();
  assert.equal(sandbox._hlCcGrid._static, true, 'live mode must be locked');
  const tpl = sandbox.hlCcTemplateLayout('tpl-owner');
  assert.equal(tpl.widgets.length, WIDGET_IDS.length);
  const brief = tpl.widgets.find((w) => w.id === 'cc-brief');
  assert.deepEqual([brief.x, brief.y, brief.w, brief.h], DEFAULTS['cc-brief']);
});

// ---- R2/R5 behavior ----------------------------------------------------------

test('R5: entering edit mode mounts the shield + tools; leaving it removes every trace from the DOM', () => {
  const { sandbox, gridEl, snapshot } = bootEngine();
  assert.equal(gridEl.querySelectorAll('.w-shield').length, 0, 'live mode starts with no shields');
  assert.equal(gridEl.querySelectorAll('.w-tools').length, 0, 'live mode starts with no tools');

  sandbox.hlCcSetEditMode(true);
  assert.ok(snapshot.classList.contains('cc-editing'));
  assert.equal(sandbox._hlCcGrid._static, false, 'edit mode unlocks the grid');
  assert.equal(gridEl.querySelectorAll('.w-shield').length, WIDGET_IDS.length, 'every widget gets a shield (R2)');
  // Every widget except Today's Decisions, which has nothing to put in one.
  assert.equal(gridEl.querySelectorAll('.w-tools').length, WIDGET_IDS.length - 1);

  sandbox.hlCcSetEditMode(false);
  assert.ok(!snapshot.classList.contains('cc-editing'));
  assert.equal(sandbox._hlCcGrid._static, true, 'live mode re-locks the grid');
  assert.equal(gridEl.querySelectorAll('.w-shield').length, 0, 'no shield may survive into live mode');
  assert.equal(gridEl.querySelectorAll('.w-tools').length, 0, 'no ✕ / ⤢ may survive into live mode -- this is the reported ghost-✕ bug');
});

test('R1/R2: the shield is an actual drag handle -- edit chrome is mounted BEFORE drag is enabled', () => {
  // The regression this pins: GridStack snapshots its drag handles once, inside
  // setStatic(false). Mounting the shield after that call left it with no
  // mousedown listener -- and since the shield covers the header strips, it
  // swallowed their mousedowns too, so NOTHING on the page dragged. Chris hit
  // this on the first cut. See the ordering comment in hlCcSetEditMode.
  const { sandbox, gridEl } = bootEngine();
  sandbox.hlCcSetEditMode(true);
  WIDGET_IDS.forEach((id) => {
    const handles = sandbox._hlCcGrid.dragHandlesFor(id);
    const item = gridEl.querySelector(`[gs-id="${id}"]`);
    const shield = item.querySelector('.w-shield');
    assert.ok(shield, `${id} must have a shield`);
    assert.ok(
      handles.includes(shield),
      `${id}: the shield must be one of GridStack's resolved drag handles -- if it is not, it covers the header and kills dragging entirely`,
    );
  });
});

test('R1: live mode exposes no drag handles at all', () => {
  const { sandbox } = bootEngine();
  WIDGET_IDS.forEach((id) => {
    assert.deepEqual(sandbox._hlCcGrid.dragHandlesFor(id), [], `${id} must not be draggable outside edit mode`);
  });
  sandbox.hlCcSetEditMode(true);
  sandbox.hlCcSetEditMode(false);
  WIDGET_IDS.forEach((id) => {
    assert.deepEqual(sandbox._hlCcGrid.dragHandlesFor(id), [], `${id} must not be draggable after leaving edit mode`);
  });
});

test('R1: a widget added back mid-edit comes back draggable', () => {
  const { sandbox, gridEl } = bootEngine();
  sandbox.hlCcSetEditMode(true);
  sandbox.hlHideCcWidget('cc-photos');
  sandbox.hlShowCcWidget('cc-photos');
  const item = gridEl.querySelector('[gs-id="cc-photos"]');
  assert.ok(
    sandbox._hlCcGrid.dragHandlesFor('cc-photos').includes(item.querySelector('.w-shield')),
    're-adding a widget must not leave it undraggable (addWidget re-resolves its handles)',
  );
});

test('R5: edit chrome cannot be mounted while not editing', () => {
  const { sandbox, gridEl } = bootEngine();
  sandbox.hlCcApplyLayout(sandbox.hlCcTemplateLayout('tpl-owner'));
  sandbox.hlShowCcWidget('cc-photos');
  assert.equal(gridEl.querySelectorAll('.w-shield').length, 0, 'no path may mount a shield outside edit mode');
  assert.equal(gridEl.querySelectorAll('.w-tools').length, 0);
});

test('R5: mounting edit chrome twice does not duplicate it', () => {
  const { sandbox, gridEl } = bootEngine();
  sandbox.hlCcSetEditMode(true);
  sandbox.hlCcSetEditMode(true);
  assert.equal(gridEl.querySelectorAll('.w-shield').length, WIDGET_IDS.length);
  assert.equal(gridEl.querySelectorAll('.w-tools').length, WIDGET_IDS.length - 1);
});

test("R8: only Today's Decisions is built without a remove button", () => {
  const { sandbox, gridEl } = bootEngine();
  sandbox.hlCcSetEditMode(true);
  gridEl.querySelectorAll('.grid-stack-item').forEach((item) => {
    const id = item.getAttribute('gs-id');
    const bar = item.querySelector('.w-tools');
    const remove = bar ? bar.children.find((b) => b.className === 'w-remove') : null;
    if (id === 'cc-brief') {
      assert.equal(remove || null, null, "Today's Decisions must never render a remove button");
      // ✕ is the only tool now, so it gets no tools bar at all rather than an
      // empty one. Resizing is GridStack's edge drag, for it and everything else.
      assert.equal(bar, null, "Today's Decisions needs no tools bar");
    } else {
      assert.ok(remove, `${id} must offer remove`);
    }
  });
});

// ---- R8: the guards ----------------------------------------------------------

test('R8: hlHideCcWidget refuses to remove Today\'s Decisions, but removes anything else', () => {
  const { sandbox } = bootEngine();
  sandbox.hlCcSetEditMode(true);
  sandbox.hlHideCcWidget('cc-brief');
  assert.equal(layoutMap(sandbox)['cc-brief'].hidden, false, 'cc-brief must survive a direct remove call');
  sandbox.hlHideCcWidget('cc-photos');
  assert.equal(layoutMap(sandbox)['cc-photos'].hidden, true, 'other widgets remove normally');
});

test('R8: a layout that lost Today\'s Decisions gets it re-injected at its default position', () => {
  const { sandbox } = bootEngine();
  const tampered = { widgets: sandbox.hlCcTemplateLayout('tpl-owner').widgets.filter((w) => w.id !== 'cc-brief') };
  const fixed = sandbox.hlCcNormalizeLayout(tampered);
  const brief = fixed.widgets.find((w) => w.id === 'cc-brief');
  assert.ok(brief, 'a layout missing cc-brief must have it put back');
  assert.equal(brief.hidden, false);
  assert.deepEqual([brief.x, brief.y, brief.w, brief.h], DEFAULTS['cc-brief']);
});

test('R8: a layout that marked Today\'s Decisions hidden is un-hidden and reset to its default position', () => {
  const { sandbox } = bootEngine();
  const widgets = sandbox.hlCcTemplateLayout('tpl-owner').widgets.map((w) => (
    w.id === 'cc-brief' ? { ...w, hidden: true, x: 11, y: 99, w: 1, h: 1 } : w
  ));
  const fixed = sandbox.hlCcNormalizeLayout({ widgets });
  const brief = fixed.widgets.find((w) => w.id === 'cc-brief');
  assert.equal(brief.hidden, false);
  assert.deepEqual([brief.x, brief.y, brief.w, brief.h], DEFAULTS['cc-brief']);
});

test('R8: applying a tampered layout still leaves Today\'s Decisions on the canvas', () => {
  const { sandbox } = bootEngine();
  sandbox.hlCcApplyLayout({ widgets: [{ id: 'cc-map', x: 0, y: 0, w: 4, h: 6 }] });
  assert.equal(layoutMap(sandbox)['cc-brief'].hidden, false);
});

test('normalize drops unknown widget ids and back-fills widgets a saved layout predates', () => {
  const { sandbox } = bootEngine();
  const fixed = sandbox.hlCcNormalizeLayout({
    widgets: [
      { id: 'cc-map', x: 1, y: 2, w: 3, h: 4 },
      { id: 'cc-brief', x: 0, y: 0, w: 5, h: 5 },
      { id: 'cc-not-a-real-widget', x: 0, y: 0, w: 2, h: 2 },
    ],
  });
  const ids = fixed.widgets.map((w) => w.id);
  assert.ok(!ids.includes('cc-not-a-real-widget'), 'unknown ids are dropped');
  assert.equal(new Set(ids).size, WIDGET_IDS.length, 'every known widget ends up in the layout exactly once');
  const photos = fixed.widgets.find((w) => w.id === 'cc-photos');
  assert.deepEqual([photos.x, photos.y, photos.w, photos.h], DEFAULTS['cc-photos'], 'a widget the save predates falls back to its default');
});

// ---- R3 behavior -------------------------------------------------------------

test('R3: entering edit mode deep-copies the canvas, and the dirty flag tracks divergence from it', () => {
  const { sandbox } = bootEngine();
  sandbox.hlCcSetEditMode(true);
  assert.equal(sandbox.hlCcIsDirty(), false, 'nothing changed yet');
  resize(sandbox, 'cc-photos', 8, 12);
  assert.equal(sandbox.hlCcIsDirty(), true, 'a resize makes the canvas dirty');
});

test('R3: Cancel changes reverts to the entry snapshot AND stays in edit mode', () => {
  const { sandbox, snapshot, gridEl } = bootEngine();
  sandbox.hlCcSetEditMode(true);
  const before = JSON.stringify(sandbox.hlCcCurrentLayout());
  resize(sandbox, 'cc-photos', 8, 12);
  sandbox.hlHideCcWidget('cc-notif');
  assert.notEqual(JSON.stringify(sandbox.hlCcCurrentLayout()), before);

  sandbox.hlCcCancelChanges();
  assert.equal(JSON.stringify(sandbox.hlCcCurrentLayout()), before, 'canvas is back to the entry snapshot');
  assert.ok(snapshot.classList.contains('cc-editing'), 'Cancel changes must NOT leave edit mode');
  assert.equal(gridEl.querySelectorAll('.w-shield').length, WIDGET_IDS.length, 'the shield survives a cancel');
});

test('R3: Go back exits edit mode, discards unsaved changes and restores the last-saved layout', () => {
  const { sandbox, snapshot, gridEl } = bootEngine();
  sandbox.hlCcSetEditMode(true);
  const before = JSON.stringify(sandbox.hlCcCurrentLayout());
  resize(sandbox, 'cc-map', 6, 9);
  sandbox.hlCcGoBack();
  assert.ok(!snapshot.classList.contains('cc-editing'), 'Go back leaves edit mode');
  assert.equal(JSON.stringify(sandbox.hlCcCurrentLayout()), before, 'unsaved changes are discarded');
  assert.equal(gridEl.querySelectorAll('.w-tools').length, 0);
});

test('R3: Go back with unsaved changes asks first, and a "no" keeps you editing', () => {
  const { sandbox, snapshot } = bootEngine();
  sandbox.hlCcSetEditMode(true);
  resize(sandbox, 'cc-map', 6, 9);
  let asked = 0;
  sandbox.window.confirm = () => { asked++; return false; };
  sandbox.hlCcGoBack();
  assert.equal(asked, 1, 'a dirty canvas must prompt "Discard unsaved changes?"');
  assert.ok(snapshot.classList.contains('cc-editing'), 'declining the prompt keeps you in edit mode');
});

// ---- R6/R7: persistence ------------------------------------------------------

test('R6/R7: the first Save forks the active template into "Custom Layout 1" and makes it active', async () => {
  const { sandbox } = bootEngine();
  const posted = [];
  sandbox.fetch = (url, opts) => {
    posted.push({ url, opts });
    const body = JSON.parse(opts.body);
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, layout: { id: 'row-1', name: body.name, layout: body.layout, is_active: true } }) });
  };
  sandbox._hlCcStore.remote = true;
  sandbox.hlCcSetEditMode(true);
  resize(sandbox, 'cc-map', 6, 9);
  await sandbox.hlCcSaveLayout();

  assert.equal(posted.length, 1);
  assert.equal(posted[0].opts.method, 'POST', 'saving from a template must CREATE a custom, never mutate the template');
  assert.match(posted[0].url, /resource=cc_layouts/);
  assert.equal(JSON.parse(posted[0].opts.body).name, 'Custom Layout 1');
  assert.equal(sandbox._hlCcStore.activeId, 'row-1');
  assert.equal(sandbox._hlCcStore.customs.length, 1);
});

test('R7: auto-naming skips numbers already in use', () => {
  const { sandbox } = bootEngine();
  sandbox._hlCcStore.customs = [
    { id: 'a', name: 'Custom Layout 1', layout: {}, is_active: false },
    { id: 'b', name: 'Custom Layout 3', layout: {}, is_active: false },
    { id: 'c', name: 'Site walk view', layout: {}, is_active: false },
  ];
  sandbox._hlCcStore.remote = true;
  let name = null;
  sandbox.fetch = (url, opts) => {
    name = JSON.parse(opts.body).name;
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, layout: { id: 'row-2', name, layout: {}, is_active: true } }) });
  };
  return sandbox.hlCcSaveLayoutAsNew().then(() => {
    assert.equal(name, 'Custom Layout 2', 'the first free "Custom Layout N" is used');
  });
});

test('R6: Save on an already-active custom updates it in place; Save as new mints another', async () => {
  const { sandbox } = bootEngine();
  sandbox._hlCcStore.remote = true;
  sandbox._hlCcStore.customs = [{ id: 'row-1', name: 'Custom Layout 1', layout: { widgets: [] }, is_active: true }];
  sandbox._hlCcStore.activeId = 'row-1';
  const calls = [];
  sandbox.fetch = (url, opts) => {
    calls.push(opts.method);
    const body = JSON.parse(opts.body);
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, layout: { id: body.id || 'row-2', name: body.name || 'Custom Layout 1', layout: body.layout || {}, is_active: true } }) });
  };
  sandbox.hlCcSetEditMode(true);
  await sandbox.hlCcSaveLayout();
  assert.deepEqual(calls, ['PATCH'], 'saving your own layout updates it rather than piling up copies');

  sandbox.hlCcSetEditMode(true);
  await sandbox.hlCcSaveLayoutAsNew();
  assert.deepEqual(calls, ['PATCH', 'POST']);
  assert.equal(sandbox._hlCcStore.customs.length, 2, 'Settings now lists Custom Layout 1 + 2');
});

test('R6: a save exits edit mode and leaves the canvas clean', async () => {
  const { sandbox, snapshot } = bootEngine();
  sandbox._hlCcStore.remote = true;
  sandbox.fetch = (url, opts) => Promise.resolve({
    json: () => Promise.resolve({ ok: true, layout: { id: 'row-1', name: JSON.parse(opts.body).name, layout: JSON.parse(opts.body).layout, is_active: true } }),
  });
  sandbox.hlCcSetEditMode(true);
  resize(sandbox, 'cc-map', 6, 9);
  await sandbox.hlCcSaveLayout();
  assert.ok(!snapshot.classList.contains('cc-editing'), 'Save exits edit mode');
});

test('R6: a saved layout is cached locally so a hard reload paints it before the fetch lands', async () => {
  const { sandbox, store } = bootEngine();
  sandbox._hlCcStore.remote = true;
  sandbox.fetch = (url, opts) => Promise.resolve({
    json: () => Promise.resolve({ ok: true, layout: { id: 'row-1', name: 'Custom Layout 1', layout: JSON.parse(opts.body).layout, is_active: true } }),
  });
  sandbox.hlCcSetEditMode(true);
  resize(sandbox, 'cc-photos', 8, 12);
  const expected = JSON.stringify(sandbox.hlCcCurrentLayout().widgets.find((w) => w.id === 'cc-photos'));
  await sandbox.hlCcSaveLayout();
  const cached = JSON.parse(store['hl-cc-layout']);
  assert.equal(JSON.stringify(cached.widgets.find((w) => w.id === 'cc-photos')), expected);
  assert.equal(JSON.parse(store['hl-cc-active-layout']), 'row-1');
});

test('R6: boot restores the cached layout, then the user\'s active server layout when it arrives', async () => {
  const serverLayout = { widgets: [{ id: 'cc-map', x: 8, y: 4, w: 4, h: 6 }, { id: 'cc-brief', x: 0, y: 0, w: 6, h: 10 }] };
  const { sandbox } = bootEngine({ storedLayouts: [{ id: 'row-9', name: 'Custom Layout 1', layout: serverLayout, is_active: true }] });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const map = layoutMap(sandbox);
  assert.deepEqual([map['cc-map'].x, map['cc-map'].y, map['cc-map'].w, map['cc-map'].h], [8, 4, 4, 6]);
  assert.equal(sandbox._hlCcStore.activeId, 'row-9');
});

test('the endpoint being unavailable (085 not applied yet) degrades to local storage, it does not break the page', async () => {
  const { sandbox } = bootEngine({ apiWorks: false });
  const store = await sandbox.hlCcLoadLayouts();
  assert.equal(store.remote, false);
  assert.equal(store.loaded, true);
  assert.equal(store.customs.length, 0);
  // ...and a save still works, locally.
  sandbox.hlCcSetEditMode(true);
  const row = await sandbox.hlCcPersistNew('Custom Layout 1', sandbox.hlCcCurrentLayout());
  assert.equal(row.name, 'Custom Layout 1');
  assert.equal(sandbox._hlCcStore.customs.length, 1);
});

test('a pre-2026-08-16 localStorage layout (bare array + separate hidden list) still loads', () => {
  const gridEl = buildGrid();
  const { sandbox } = bootEngine();
  // Seed the legacy keys, then re-run the cached-layout path.
  // Parked where the hidden cc-photos frees space -- a legacy position that
  // OVERLAPPED another widget would (rightly) trip the collision self-heal and
  // reset to default, which is a different code path than the one under test.
  sandbox.localStorage.setItem('hl-cc-layout', JSON.stringify([{ id: 'cc-map', x: 6, y: 31, w: 5, h: 9 }]));
  sandbox.localStorage.setItem('hl-cc-hidden-widgets', JSON.stringify(['cc-photos']));
  const el = sandbox.document.getElementById('cc-main-gridstack');
  el._hlGsInited = false;
  sandbox.hlInitCcGrid();
  const map = layoutMap(sandbox);
  assert.deepEqual([map['cc-map'].x, map['cc-map'].y, map['cc-map'].w, map['cc-map'].h], [6, 31, 5, 9], 'the legacy position survives');
  assert.equal(map['cc-photos'].hidden, true, 'the legacy hidden list survives');
  assert.equal(map['cc-brief'].hidden, false, "and Today's Decisions is still there");
  assert.ok(gridEl);
});

// ---- Role baselines ----------------------------------------------------------
// Which widgets a role starts with is DERIVED from what that role can reach —
// the permission tables in hlApplyRolePermissions and the server-side financial
// gate (api/track1.js FINANCIAL_ALLOWED_ROLES = owner, office_ar). These pin
// that derivation so a template can't quietly drift away from the permissions
// it was built from.

const FINANCIAL_ROLES = ['owner', 'office_ar'];
// Today's Decisions: present and visible in every baseline, since it cannot be
// removed from a layout anyway.
const REQUIRED_WIDGET = 'cc-brief';

test('the template id these tests use is a real template, not the unknown-id fallback', () => {
  // hlCcTemplateLayout falls back to the HTML defaults for an id it does not
  // know. That is right for a user whose active template was renamed away, and
  // wrong for a test: renaming tpl-default to tpl-owner left five call sites
  // here asking for a dead id, still passing, and quietly exercising the
  // fallback instead of the Owner baseline they named.
  const { sandbox } = bootEngine();
  const ids = sandbox.CC_LAYOUT_TEMPLATES.map((t) => t.id);
  assert.ok(ids.includes('tpl-owner'), `the id these tests reset with must be a real template; have ${ids}`);
  assert.equal(sandbox.CC_TEMPLATE_DEFAULT_ID, 'tpl-owner');
  // And it must resolve to the template's OWN geometry, not the HTML fallback.
  const tpl = sandbox.CC_LAYOUT_TEMPLATES.find((t) => t.id === 'tpl-owner');
  const resolved = sandbox.hlCcTemplateLayout('tpl-owner');
  tpl.widgets.forEach((w) => {
    const got = resolved.widgets.find((r) => r.id === w.id);
    assert.deepEqual({ x: got.x, y: got.y, w: got.w, h: got.h }, { x: w.x, y: w.y, w: w.w, h: w.h },
      `${w.id} did not resolve to the template's own geometry`);
  });
});

test('every role baseline is a usable layout: no overlaps, inside 12 columns, Decisions present', () => {
  const { sandbox } = bootEngine();
  const templates = sandbox.CC_LAYOUT_TEMPLATES;
  assert.ok(templates.length >= 2, 'there must be more than one baseline, or this proves nothing');
  for (const t of templates) {
    const layout = sandbox.hlCcTemplateLayout(t.id);
    const visible = layout.widgets.filter((w) => !w.hidden);
    assert.ok(visible.length >= 3, `${t.id}: only ${visible.length} widgets — too thin to be a baseline`);
    const hits = [];
    for (let i = 0; i < visible.length; i++) {
      for (let j = i + 1; j < visible.length; j++) {
        const a = visible[i]; const b = visible[j];
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) hits.push(`${a.id}/${b.id}`);
      }
    }
    assert.deepEqual(hits, [], `${t.id}: widgets overlap`);
    visible.forEach((w) => {
      assert.ok(w.x >= 0 && w.x + w.w <= 12, `${t.id}: ${w.id} runs outside the 12-column grid`);
      assert.ok(w.w > 0 && w.h > 0, `${t.id}: ${w.id} has no size`);
    });
    const brief = layout.widgets.find((w) => w.id === REQUIRED_WIDGET);
    assert.ok(brief && !brief.hidden, `${t.id}: Today's Decisions must be visible — it cannot be removed anyway`);
    // Unlisted widgets are hidden, not dropped, so "+ Add widget" can offer them.
    assert.equal(layout.widgets.length, WIDGET_IDS.length, `${t.id}: every widget must be present (hidden or not)`);
  }
});

test('Pulse appears only in baselines whose roles can actually read financial data', () => {
  const { sandbox } = bootEngine();
  const roleFor = {};
  Object.entries(sandbox.CC_ROLE_TEMPLATE).forEach(([role, tpl]) => {
    (roleFor[tpl] = roleFor[tpl] || []).push(role);
  });
  for (const t of sandbox.CC_LAYOUT_TEMPLATES) {
    const pulse = sandbox.hlCcTemplateLayout(t.id).widgets.find((w) => w.id === 'cc-pulse');
    if (pulse && !pulse.hidden) {
      const roles = roleFor[t.id] || [];
      assert.ok(roles.length > 0, `${t.id}: shows Pulse but no role maps to it`);
      roles.forEach((r) => assert.ok(
        FINANCIAL_ROLES.includes(r),
        `${t.id} shows Pulse but maps role "${r}", which the server's financial gate refuses — that role would get a panel of "unavailable" tiles`,
      ));
    }
  }
  // Non-vacuous: at least one baseline does show Pulse.
  const withPulse = sandbox.CC_LAYOUT_TEMPLATES.filter((t) =>
    sandbox.hlCcTemplateLayout(t.id).widgets.some((w) => w.id === 'cc-pulse' && !w.hidden));
  assert.ok(withPulse.length > 0, 'no baseline shows Pulse at all — this check proves nothing');
});

test('every permission role maps to a baseline that exists', () => {
  const { sandbox } = bootEngine();
  const ids = new Set(sandbox.CC_LAYOUT_TEMPLATES.map((t) => t.id));
  // The nine roles from sql/066_permission_roles_v2.sql, as used by
  // hlApplyRolePermissions' ALLOWED_GROUPS / ALLOWED_STANDALONE.
  for (const role of ['owner', 'office_ar', 'dispatch', 'admin_remote', 'project_manager',
    'purchasing', 'field_lead', 'field_tech', 'sales']) {
    const tpl = sandbox.CC_ROLE_TEMPLATE[role];
    assert.ok(tpl, `role "${role}" has no baseline`);
    assert.ok(ids.has(tpl), `role "${role}" maps to "${tpl}", which is not a template`);
  }
});

test('the baseline picker mirrors hlApplyRolePermissions: account tier wins, no role fails closed', () => {
  const { sandbox } = bootEngine();
  const pick = (tier, roles) => {
    sandbox.HL_ACCESS_LEVEL = tier;
    sandbox.HL_PERMISSION_ROLES = roles;
    return sandbox.hlCcTemplateForRole();
  };
  assert.equal(pick('superadmin', []), 'tpl-owner', 'superadmin bypasses roles, as it does everywhere else');
  assert.equal(pick('admin', ['field_tech']), 'tpl-owner', 'the account tier outranks the business role');
  assert.equal(pick(null, ['field_tech']), 'tpl-field');
  assert.equal(pick(null, ['office_ar']), 'tpl-office');
  assert.equal(pick(null, ['sales']), 'tpl-sales');
  assert.equal(pick(null, ['dispatch']), 'tpl-dispatch');
  // Fail closed, the same direction hlApplyRolePermissions chose for the
  // no-role case: the most restricted baseline, never the owner's.
  assert.equal(pick(null, []), 'tpl-field', 'someone with no role must not land on the owner baseline');
  assert.equal(pick(null, ['not_a_real_role']), 'tpl-field');
});

// ---- Settings list (R7) ------------------------------------------------------

test('R7: Settings renders templates as read-only and customs with Set active / Rename / Delete', () => {
  const start = source.indexOf('function hlCCLRow(id, name, isTemplate, isActive)');
  assert.ok(start !== -1, 'the Settings layout list must exist');
  const block = source.slice(start, source.indexOf('window.hlCCLDelete = hlCCLDelete;'));
  assert.match(block, /if \(isTemplate\) \{[\s\S]*?hlCcEnterCustomize\(\)/, 'templates offer Customize, never Delete');
  assert.ok(!/isTemplate[\s\S]{0,200}hlCCLDelete/.test(block.slice(block.indexOf('if (isTemplate)'), block.indexOf('} else {'))), 'templates must not be deletable');
  assert.match(block, /hlCCLRename\('/);
  assert.match(block, /hlCCLDelete\('/);
  assert.match(block, /hlCCLSetActive\('/);
  assert.match(block, /ACTIVE/, 'the active layout is indicated visually');
});

test('R7: the fabricated HLLAYOUTS design mock is gone', () => {
  assert.ok(!/var HLLAYOUTS=\[/.test(source), 'the five in-memory fake role baselines must not come back');
  assert.ok(!/window\.HLLAYOUTS/.test(source));
});
