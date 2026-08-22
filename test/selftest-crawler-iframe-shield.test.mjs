import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Dev To-Do reported 5 NO_OUTCOME findings on Company Setup (csx) "Save"
// buttons. Investigating live turned up something bigger than a UI bug: the
// self-test crawler's network shield -- the thing that guarantees "nothing
// real is ever sent, charged, or written" -- only ever patched the OUTER
// page's window.fetch/XHR/etc. Every if-XXX embedded view (jsx, ldx, csx,
// cpx, pbx...) renders in an <iframe> with its OWN separate Window and its
// OWN native fetch, captured before the outer page's shield ever ran.
// Live-confirmed: `iframe.contentWindow.fetch === window.fetch` is false.
// That means every "Save"/"Submit" click inside an embedded view has been
// making a REAL, unstubbed write to production during every self-test run --
// the opposite of the file's core safety guarantee. It also explains the
// reported NO_OUTCOME: a real network round-trip routinely takes longer than
// the crawler's 120ms settle window, so the confirmation state lands after
// the crawler already gave up watching.
const src = readFileSync(new URL('../public/tools/selftest.js', import.meta.url), 'utf8');

test('the shield is a reusable function, not one-time top-level code tied to the outer window', () => {
  assert.match(src, /function installShield\(win, doc\)/);
  // The regression this guards: window.fetch/XMLHttpRequest.prototype.open
  // etc. must no longer be patched directly at the top level -- they must
  // only ever be assigned through `win.` inside installShield, or the outer
  // window is the only thing that ever gets protected again.
  const beforeInstallShield = src.slice(0, src.indexOf('function installShield'));
  assert.doesNotMatch(beforeInstallShield, /^\s*window\.fetch = function/m);
});

test('installShield is applied to the outer window at startup', () => {
  assert.match(src, /var restoreShield = installShield\(window, document\)/);
});

test('installShield is applied to every iframe\'s contentWindow before that view is crawled', () => {
  const crawlCurrentSrc = src.slice(src.indexOf('async function crawlCurrent'));
  assert.match(crawlCurrentSrc, /installShield\(ifr\.contentWindow, ifr\.contentDocument\)/);
  // Must happen before the element scan, not after -- a click on the first
  // element in the view must already be protected.
  const installIdx = crawlCurrentSrc.indexOf('installShield(ifr.contentWindow');
  const scanIdx = crawlCurrentSrc.indexOf('querySelectorAll');
  assert.ok(installIdx > -1 && scanIdx > -1 && installIdx < scanIdx);
});

test('installShield refuses to double-install on the same window', () => {
  assert.match(src, /if \(!win \|\| win\.__hlShielded\) return null;/);
  assert.match(src, /win\.__hlShielded = true;/);
});

test('a cross-origin iframe (fetch/XMLHttpRequest inaccessible) is skipped without throwing', () => {
  assert.match(src, /try \{ if \(!win\.fetch \|\| !win\.XMLHttpRequest\) return null; \} catch \(e\) \{ return null; \}/);
});

test('same-origin checks resolve against the TARGET window\'s origin, not the outer page\'s', () => {
  // The regression this guards: sameOrigin()/decide() used to close over the
  // outer page's `location` implicitly. An iframe's own /api/... calls are
  // same-origin to ITS OWN location, which happens to be the same origin
  // here, but the function must take origin explicitly or a future
  // differently-sourced iframe silently falls through to "blocked-external".
  assert.match(src, /function sameOrigin\(url, origin\)/);
  assert.match(src, /function decide\(url, method, origin\)/);
  assert.match(src, /var origin = win\.location\.origin;/);
});

test('all shield installations share one SHIELD.calls array, so an iframe write still counts toward the WIRED verdict', () => {
  // installShield() must reference the shared SHIELD.calls, not a
  // per-installation local array -- otherwise since(t0) (which reads
  // SHIELD.calls) never sees a write that happened inside an iframe.
  const fnSrc = src.slice(src.indexOf('function installShield'), src.indexOf('var restoreShield ='));
  assert.match(fnSrc, /SHIELD\.calls\.push/);
  assert.doesNotMatch(fnSrc, /var SHIELD = /, 'installShield must not shadow the shared SHIELD with a local one');
});

test('sendReport no longer references the old top-level REAL (regression: it moved inside installShield\'s closure)', () => {
  // The exact bug introduced and caught while making this fix: sendReport()
  // called REAL.fetch(...) to reach the real backend, but REAL used to be a
  // module-level variable and is now local to installShield(). Left
  // unfixed this throws "REAL is not defined" on every single report send.
  assert.doesNotMatch(src, /await REAL\.fetch\(/);
  assert.match(src, /await window\.fetch\('\/api\/selftest-report'/);
});

test('the stubbed Response is constructed via the target window\'s own Response constructor', () => {
  // A Response built with the OUTER window's constructor, handed back from
  // an iframe's patched fetch, would still work in most engines, but using
  // the iframe's own win.Response is the correct, realm-consistent choice
  // now that fetch is being installed per-window.
  assert.match(src, /new win\.Response\(stubBody\(\)/);
});
