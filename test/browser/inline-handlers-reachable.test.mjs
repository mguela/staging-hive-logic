// Every function a button calls must be reachable from the button.
//
// public/index.html is one enormous file with a dozen <script> blocks, and
// several are wrapped in an IIFE. A function declared inside a wrapped block is
// NOT on window -- but an inline onclick="" runs at page scope, so pressing the
// button throws "not defined". Nothing looks wrong in the code, no unit test
// touches it, and the button simply does nothing.
//
// This trap caught four separate features in one afternoon (2026-08-23):
//
//   hlResumeLeadDraft / hlDeleteLeadDraft   caught before shipping
//   rlmStartJob / rlmStartEstimate / saveRealLead
//       SHIPPED BROKEN. The lead card's Save, Start estimate and Start the job
//       all threw on press. The card looked perfectly fine.
//   rlmReferredBySearch / rlmReferredByPick the lead card's "referred by" box
//   viTab / viUpload                        the Visual Intel panel
//
// It has to be a BROWSER test. A static version was written first and reported
// 14 broken names, of which 11 were false positives: a script block can be
// partly wrapped, and no amount of regex distinguishes that reliably. A test
// that is wrong four times out of five gets ignored and then deleted. Asking
// the page itself is the only answer worth having.

import test, { before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, PUBLIC_ROOT } from './serve.mjs';
import { findPlaywright, findChromium, unavailableReason } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const reason = unavailableReason();
const OPTS = reason ? { skip: reason } : {};
const pw = reason ? null : findPlaywright();
const chromiumPath = reason ? null : findChromium();

const HTML = fs.readFileSync(path.join(PUBLIC_ROOT, 'index.html'), 'utf-8');

// Every identifier the markup calls directly from an event attribute.
function inlineHandlerNames(src) {
  const names = new Set();
  const re = /\bon(?:click|change|input|submit|focus|blur|keyup|keydown|mouseover|mouseout)="\s*([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  // onclick="if(event.target===this)..." is a statement, not a call. Keywords
  // are not handlers and would report the whole page broken.
  const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'return', 'typeof',
                            'function', 'catch', 'do', 'else', 'new', 'delete', 'void']);
  while ((m = re.exec(src))) if (!KEYWORDS.has(m[1])) names.add(m[1]);
  return [...names].sort();
}

// Some handlers are attached to window only when the thing that uses them is
// built (a modal's buttons, wired as it opens). Those are deliberate exports,
// not functions trapped in a closure, and probing at load time would report
// them broken. The source says window.NAME = somewhere; that is enough.
const LAZY = new Set([...HTML.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]));
const NAMES = inlineHandlerNames(HTML).filter((n) => !LAZY.has(n));

let server; let page; let browser;

before(async () => {
  if (reason) return;
  server = await startServer();
  browser = await pw.chromium.launch({
    executablePath: chromiumPath, args: ['--no-sandbox', '--disable-gpu'],
  });
  page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  // Seal the network: a blocked external request hangs rather than failing,
  // which would stall load and make the answers below a confident lie.
  await page.route((u) => u.hostname !== '127.0.0.1' && u.protocol.startsWith('http'), (r) => r.abort());
  await page.goto(`${server.url}/index.html`, { waitUntil: 'load', timeout: 30000 });
  // Give the deferred blocks a beat to run. Asking too early would report the
  // whole page broken.
  await page.waitForTimeout(1200);
});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

test('the page really has inline handlers to check', OPTS, () => {
  // Guards against the regex quietly matching nothing and every assertion
  // below passing on an empty list.
  assert.ok(NAMES.length > 50, 'expected plenty of inline handlers, found ' + NAMES.length);
});

test('every function called from an onclick is defined at page scope', OPTS, async () => {
  const missing = await page.evaluate(
    (names) => names.filter((n) => typeof window[n] !== 'function'), NAMES);
  assert.deepEqual(missing, [],
    'declared inside a wrapped <script> block, so pressing the button throws ' +
    '"not defined". Export them: window.NAME = NAME;  ->  ' + missing.join(', '));
});

test('the ones that shipped broken are specifically reachable', OPTS, async () => {
  // Named because they were live on production doing nothing, on a card Chris
  // uses every day. If a refactor un-exports them, this says which.
  const shipped = ['rlmStartJob', 'rlmStartEstimate', 'saveRealLead',
                   'rlmReferredBySearch', 'rlmReferredByPick', 'viTab', 'viUpload',
                   'hlResumeLeadDraft', 'hlDeleteLeadDraft'];
  const missing = await page.evaluate(
    (names) => names.filter((n) => typeof window[n] !== 'function'), shipped);
  assert.deepEqual(missing, []);
});

test('the check can actually fail', OPTS, async () => {
  // A measurement that cannot fail proves nothing. Prove the probe reports a
  // genuinely unreachable name before trusting what it says about real ones.
  const missing = await page.evaluate(
    (names) => names.filter((n) => typeof window[n] !== 'function'),
    ['saveRealLead', 'aFunctionThatDoesNotExistAnywhere']);
  assert.deepEqual(missing, ['aFunctionThatDoesNotExistAnywhere']);
});
