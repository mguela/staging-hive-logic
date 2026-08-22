// Step 5: the standalone Requests & Booking tab is retired.
//
// Its inbox is column one of the Leads board now. The risk in removing a view is
// not the removal -- it is the references left behind: showView() to a view that
// no longer exists hides every container and leaves a blank screen rather than
// failing loudly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync('public/index.html', 'utf8');

test('the view, its iframe and its nav entry are gone', () => {
  assert.doesNotMatch(html, /id="view-rqx"/);
  assert.doesNotMatch(html, /id="if-rqx"/);
  assert.doesNotMatch(html, /id="nav-rqx"/);
});

test('nothing navigates to the retired view any more', () => {
  // The lead-sources strip used to link to it. A dangling showView('rqx') is a
  // blank screen, not an error.
  assert.doesNotMatch(html, /showView\('rqx'\)/);
});

test('it is deregistered from the route table and sidebar groups', () => {
  assert.doesNotMatch(html, /'rqx'\s*,/);
  assert.doesNotMatch(html, /"rqx":\s*"sales"/);
});

test('old #/rqx links land on Leads instead of nowhere', () => {
  // Shared links and bookmarks outlive the view. Same alias pattern the retired
  // #/workroom route already uses.
  // Written in the router's own style: set code and h, and let the single
  // replaceState further down write the URL.
  assert.match(html, /if\(code==='rqx'\)\{ code='leads'; h='#\/leads'; \}/);
});

test('the redirect runs before the route-table lookup', () => {
  // Rewriting the code after the HL_ROUTE_VIEWS check would never match, since
  // 'rqx' is no longer in that list.
  // Anchored on the bare name, not a signature -- hlCheckRoute gained an
  // `event` parameter when Back/Forward support landed, and pinning `()` made
  // this slice the whole file and the assertion meaningless.
  const at = html.indexOf('function hlCheckRoute(');
  assert.ok(at > -1, 'hlCheckRoute not found');
  const fn = html.slice(at, html.indexOf('window.addEventListener(\'hashchange\'', at));
  assert.ok(fn.length > 200, 'could not isolate hlCheckRoute');
  const alias = fn.indexOf("code==='rqx'");
  const lookup = fn.indexOf('HL_ROUTE_VIEWS.indexOf(code)');
  assert.ok(alias > -1 && lookup > -1, 'alias or route lookup missing from the router');
  assert.ok(alias < lookup, 'the alias must be applied before the route lookup or it is dead code');
});

test('the lead-sources strip still explains where requests go', () => {
  // The link was removed, not the sentence -- the strip exists to say that
  // sources feed the inbox, and the inbox is now on this same page.
  assert.match(html, /DEDUPED · SOURCE-TAGGED TO P&L → REQUESTS COLUMN BELOW/);
});

test('the Sales group keeps its other entries', () => {
  for (const id of ['leads', 'estimates', 'tox', 'prx']) {
    assert.match(html, new RegExp(`id="nav-${id}"`), `nav-${id} lost from the Sales group`);
  }
});

test('the Requests column that replaced it is still there', () => {
  assert.match(html, /LEAD_STAGE_ORDER = \['request', 'new'/);
  assert.match(html, /LEAD_STAGE_LABELS = \{ request: 'REQUESTS',/);
});
