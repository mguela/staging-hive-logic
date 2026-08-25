// test/estimate-client-response-ui.test.mjs
// jomell, 2026-08-25: "when clicking 'send to client'... i should receive
// an email... that email should contain details and there should be a
// button or lets say links either saying 'approve' or 'reject'."
//
// Backend half (send.js emailing the client, respond.js consuming the
// token) is covered by test/estimate-send-client-email.test.mjs and
// test/estimate-respond-link.test.mjs. This covers the three frontend
// changes: the row carries the client's response, the Send toast reports
// whether the email actually went out, and the summary modal surfaces an
// approval that never touches lifecycleStatus and would otherwise be
// invisible to staff.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');

function extractFunction(src, decl) {
  const start = src.indexOf(decl);
  assert.ok(start > -1, `${decl} must exist`);
  let depth = 0, i = src.indexOf('{', start);
  do {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  } while (depth > 0 && i < src.length);
  assert.equal(depth, 0, 'braces must balance');
  return src.slice(start, i);
}

function estimatesRowClickHandler() {
  const anchor = source.indexOf('window._hlEstEdit=isLocalRow');
  assert.ok(anchor > -1, 'the local/real branch on _hlEstEdit must exist');
  const start = source.lastIndexOf("document.addEventListener('click',function(e){", anchor);
  return source.slice(start, source.indexOf('},true);', anchor) + 10);
}

test('nativeEstimateToRow carries the client\'s emailed response through to the list', () => {
  const fn = extractFunction(source, 'function nativeEstimateToRow(e){');
  assert.match(fn, /clientApprovedAt\s*:\s*e\.clientApprovedAt\s*\|\|\s*null/);
});

test('the Send toast reports whether the client email actually went out', () => {
  const fn = estimatesRowClickHandler();
  const sendStart = fn.indexOf('window._hlEstSend=function');
  assert.ok(sendStart > -1);
  const sendFn = fn.slice(sendStart, fn.indexOf('};', sendStart) + 2);
  assert.match(sendFn, /d\.clientEmailSent/);
  assert.match(sendFn, /d\.clientEmailAddress/);
  assert.match(sendFn, /d\.clientEmailError/,
    'a failed client email must not be silently swallowed -- staff needs to know to follow up another way');
});

test('a client approval that never touched lifecycleStatus still shows up in the summary modal', () => {
  const fn = estimatesRowClickHandler();
  assert.match(fn, /var clientApprovedBanner\s*=\s*\(nativeRow&&nativeRow\.clientApprovedAt\)/,
    'without this banner, an emailed approval (which deliberately does not change lifecycleStatus) would be invisible to staff');
  assert.match(fn, /Client approved via email/);
});
