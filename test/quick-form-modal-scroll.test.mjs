// test/quick-form-modal-scroll.test.mjs
// jomell, 2026-08-25: "in the leads tab, when i click on someone, and click
// 'start the job' the new job window would popup but it seems like its cut
// off and we cant access it by scrolling."
//
// The New Job form (.fm#fm-job) is long enough on its own -- client, title,
// division, value, notes, schedule choice, billing, line items -- that on a
// normal-height screen it runs past the bottom of the viewport. .fm had no
// max-height and no scrolling, so the Create Job button (and everything
// below whatever fit) was simply unreachable. Same popup shell is reused for
// New Lead/Estimate/Client/Invoice/Payment, so this fixes all of them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function rule(selector) {
  const start = html.indexOf(selector);
  assert.ok(start > -1, `${selector} must exist`);
  const open = html.indexOf('{', start);
  const close = html.indexOf('}', open);
  return html.slice(open + 1, close);
}

test('the quick-form popup caps its height and scrolls internally instead of running off-screen', () => {
  const fm = rule('.fm{');
  assert.match(fm, /max-height:calc\(100vh - 130px\)/,
    'without a height cap, a long form (New Job) runs past the bottom of the viewport with no way to reach it');
  assert.match(fm, /flex-direction:column/,
    'must be a flex column so the header/footer can stay put while the body scrolls');
});

test('the popup body scrolls while the header and footer stay fixed in place', () => {
  const body = rule('.fm-body{');
  assert.match(body, /overflow-y:auto/, 'the body -- not the whole popup -- must be what scrolls');
  assert.match(body, /flex:1/, 'must fill the space between the fixed header and footer');

  const head = rule('.fm-head{');
  assert.match(head, /flex-shrink:0/, 'the header (with the close button) must never be scrolled out of view');

  const foot = rule('.fm-foot{');
  assert.match(foot, /flex-shrink:0/, 'the footer (with Create/Save) must never be scrolled out of view');
});
