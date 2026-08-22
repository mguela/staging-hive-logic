import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SRC_PATH = 'public/index.html';
const raw = fs.readFileSync(SRC_PATH, 'utf8');

function extractFunction(source, declSnippet) {
  const idx = source.indexOf(declSnippet);
  assert.ok(idx !== -1, `expected to find "${declSnippet}"`);
  const lineStart = source.lastIndexOf('\n', idx) + 1;
  const braceStart = idx + declSnippet.length - 1;
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(lineStart, i + 1);
  }
  throw new Error(`unterminated function ${declSnippet}`);
}

function extractArrayLine(source, declSnippet) {
  const idx = source.indexOf(declSnippet);
  assert.ok(idx !== -1, `expected to find "${declSnippet}"`);
  return source.slice(idx, source.indexOf('\n', idx));
}

const routeSrc = extractArrayLine(raw, 'var HL_ROUTE_VIEWS =');
const commitSrc = extractFunction(raw, 'function hlCommitRoute(v){');
const showViewSrc = extractFunction(raw, 'function showView(v){');
const checkRouteSrc = extractFunction(raw, 'function hlCheckRoute(event){');
const blockSrc = [routeSrc, commitSrc, showViewSrc, checkRouteSrc].join('\n\n');

function makeElement() {
  const classes = new Set();
  return {
    style: {},
    classList: {
      toggle(name, force) { if (force === undefined ? !classes.has(name) : force) classes.add(name); else classes.delete(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
  };
}

function makeSandbox(initialHash = '') {
  const elements = new Map();
  const document = {
    hidden: false,
    title: '',
    body: { classList: makeElement().classList },
    getElementById(id) { if (!elements.has(id)) elements.set(id, makeElement()); return elements.get(id); },
  };
  const location = { hash: initialHash };
  const entries = [{ url: initialHash, state: null }];
  let cursor = 0;
  const calls = { replace: [], push: [], back: 0 };
  let sandbox;
  const history = {
    get state() { return entries[cursor].state; },
    replaceState(state, _title, url) { calls.replace.push(url); entries[cursor] = { state, url }; location.hash = url; },
    pushState(state, _title, url) { calls.push.push(url); entries.splice(cursor + 1); entries.push({ state, url }); cursor++; location.hash = url; },
    back() { if (cursor > 0) { cursor--; calls.back++; location.hash = entries[cursor].url; sandbox.hlCheckRoute({ type: 'popstate' }); } },
  };
  const window = { scrollTo() {}, addEventListener() {} };
  sandbox = { document, location, history, window, console, setTimeout, Number };
  vm.createContext(sandbox);
  vm.runInContext(blockSrc, sandbox, { filename: SRC_PATH });
  window.showView = sandbox.showView;
  sandbox.openHiveConnect = () => sandbox.showView('hiveconnect');
  sandbox.openMarketingCC = () => sandbox.showView('marketing_cc');
  return { sandbox, document, location, history, entries, calls };
}

test('showView has one canonical declaration and delegates URL writes to hlCommitRoute', () => {
  assert.equal((raw.match(/function showView\s*\(/g) || []).length, 1);
  assert.match(showViewSrc, /hlCommitRoute\(v\)/);
  assert.doesNotMatch(raw, /if\(h && h!==['"]#['"]\) history\.replaceState/,
    'page boot must not erase a valid deep-link hash');
});

test('first app route replaces the load entry; subsequent view clicks push history entries', () => {
  const { sandbox, location, calls } = makeSandbox();
  sandbox.showView('leads');
  sandbox.showView('clients');
  assert.equal(location.hash, '#/clients');
  assert.deepEqual(calls.replace, ['#/leads']);
  assert.deepEqual(calls.push, ['#/clients']);
});

test('reselecting the current view does not create a duplicate history entry', () => {
  const { sandbox, calls } = makeSandbox();
  sandbox.showView('clients');
  sandbox.showView('clients');
  assert.deepEqual(calls.push, []);
  assert.deepEqual(calls.replace, ['#/clients']);
});

test('a hard-refresh deep link is preserved and renders the requested view', () => {
  const { sandbox, document, location, calls } = makeSandbox('#/docs');
  assert.equal(sandbox.hlCheckRoute(), true);
  assert.equal(location.hash, '#/docs');
  assert.equal(document.getElementById('view-docs').style.display, 'block');
  assert.deepEqual(calls.push, []);
});

test('native Back replays the previous view without pushing a replacement entry', () => {
  const { sandbox, document, location, history, calls } = makeSandbox();
  sandbox.showView('leads');
  sandbox.showView('clients');
  history.back();
  assert.equal(location.hash, '#/leads');
  assert.equal(document.getElementById('view-leads').style.display, 'block');
  assert.equal(document.getElementById('view-clients').style.display, 'none');
  assert.deepEqual(calls.push, ['#/clients']);
  assert.equal(calls.back, 1);
});

test('HiveConnect and embedded Marketing are canonical routes too', () => {
  const { sandbox, calls } = makeSandbox();
  sandbox.showView('hiveconnect');
  sandbox.showView('marketing_cc');
  assert.deepEqual(calls.replace, ['#/hiveconnect']);
  assert.deepEqual(calls.push, ['#/marketing_cc']);
});

test('manual canonical hash changes replay through one router without pushing or corrupting depth', () => {
  const { sandbox, document, history, calls } = makeSandbox();
  sandbox.showView('leads');
  // A real address-bar hash edit creates a browser entry whose state is null.
  history.pushState(null, '', '#/hiveconnect');
  calls.push.length = 0;
  assert.equal(sandbox.hlCheckRoute({ type: 'hashchange' }), true);
  assert.equal(document.getElementById('view-hiveconnect').style.display, 'block');
  assert.deepEqual(calls.push, []);
  assert.equal(sandbox.window.__hlRouteDepth, 1);
});

test('legacy comms hashes normalize to the canonical HiveConnect route', () => {
  const { sandbox, document, location, calls } = makeSandbox('#mail');
  assert.equal(sandbox.hlCheckRoute(), true);
  assert.equal(location.hash, '#/hiveconnect');
  assert.equal(document.getElementById('view-hiveconnect').style.display, 'block');
  assert.deepEqual(calls.replace, ['#/hiveconnect']);
});

test('only the canonical router owns hashchange events', () => {
  assert.equal((raw.match(/addEventListener\('hashchange'/g) || []).length, 1);
  assert.match(raw, /addEventListener\('hashchange', hlCheckRoute\)/);
});
