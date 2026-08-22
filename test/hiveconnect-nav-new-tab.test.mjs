// test/hiveconnect-nav-new-tab.test.mjs
// The sidebar HiveConnect tab used to swap the current view in place
// (openHiveConnect() -> showView('hiveconnect')). It now opens in a separate
// browser tab instead, landing on the real #/hiveconnect route -- hlCheckRoute
// already calls openHiveConnect() itself for that hash, so the new tab boots
// the same SPA and mounts HiveConnect on its own, no separate page needed.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');

function extractFunction(src, declSnippet) {
  const declStart = src.indexOf(declSnippet);
  assert.ok(declStart > -1, `${declSnippet} must exist`);
  const braceStart = src.indexOf('{', src.indexOf(')', declStart));
  let depth = 1;
  let i = braceStart + 1;
  while (depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(declStart, i);
}

test('the sidebar HiveConnect nav item opens a new tab, not the in-place view', () => {
  assert.match(source, /id="nav-hiveconnect" onclick="openHiveConnectNewTab\(\)"/);
});

test('openHiveConnectNewTab opens the real #/hiveconnect route in a new tab', () => {
  const FN = extractFunction(source, 'function openHiveConnectNewTab(){');
  const calls = [];
  const ctx = vm.createContext({
    window: {},
    location: { origin: 'https://hivelogic-live.vercel.app' },
  });
  ctx.window.open = (...args) => calls.push(args);
  vm.runInContext(`${FN} openHiveConnectNewTab();`, ctx);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['https://hivelogic-live.vercel.app/#/hiveconnect', '_blank']);
});

test('openHiveConnect itself is untouched -- the new tab still mounts HiveConnect the normal way', () => {
  // hlCheckRoute() calls openHiveConnect() (not openHiveConnectNewTab()) when a
  // fresh load lands on #/hiveconnect -- confirmed by the routing table already
  // covered in showview-hash-sync.test.mjs. This just pins that the function
  // the new tab depends on for its own boot hasn't been altered by this change.
  const FN = extractFunction(source, 'function openHiveConnect(){');
  assert.match(FN, /showView\('hiveconnect'\)/);
  assert.match(FN, /__mountHiveConnect/);
});
