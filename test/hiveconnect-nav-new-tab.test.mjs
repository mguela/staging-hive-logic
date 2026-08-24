// test/hiveconnect-nav-new-tab.test.mjs
//
// The sidebar HiveConnect tab opened a separate browser tab for a while. It is
// back to swapping the view in place, because the new tab had a cost that was
// invisible from the code: a new tab is a COLD BOOT of the whole SPA.
//
// Chris, 2026-08-23, watching a screen recording of it: "it flashes
// Hiveconnect, then immediately goes to the sign in screen and then loads
// hiveconnect". That sign-in form is HiveLogic's own, shown while
// hlTrySilentLogin() restores the session on the fresh tab. Every click
// reloaded the app and left another HiveLogic tab behind; his recording had
// eight of them open.
//
// This file kept its name so the history stays findable.

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

test('the sidebar HiveConnect nav item still routes through one entry point', () => {
  // The onclick is unchanged; what it DOES changed, so a bookmark, a keyboard
  // shortcut or a role-permission toggle that names this handler keeps working.
  assert.match(source, /id="nav-hiveconnect" onclick="openHiveConnectNewTab\(\)"/);
});

test('it opens in place and never asks the browser for a tab', () => {
  const FN = extractFunction(source, 'function openHiveConnectNewTab(){');
  const opened = [];
  let inPlace = 0;
  const ctx = vm.createContext({
    window: {},
    location: { origin: 'https://hivelogic-live.vercel.app' },
    openHiveConnect: () => { inPlace++; },
  });
  ctx.window.open = (...args) => opened.push(args);
  vm.runInContext(`${FN} openHiveConnectNewTab();`, ctx);

  assert.equal(inPlace, 1, 'the view swaps in the tab he is already in');
  assert.equal(opened.length, 0, 'a new tab is a cold boot, and a cold boot shows the login screen');
});

test('openHiveConnect itself is untouched, so #/hiveconnect still boots straight in', () => {
  // hlCheckRoute() calls openHiveConnect() (not openHiveConnectNewTab()) when a
  // fresh load lands on #/hiveconnect -- confirmed by the routing table already
  // covered in showview-hash-sync.test.mjs. A pasted or bookmarked link must
  // keep working; only the sidebar's route to it changed.
  const FN = extractFunction(source, 'function openHiveConnect(){');
  assert.match(FN, /showView\('hiveconnect'\)/);
  assert.match(FN, /__mountHiveConnect/);
});
