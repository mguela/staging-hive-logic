// The "New lead?" button on a ringing call, pressed for real.
//
// The phone popup is its own IIFE; index.html is a dozen other script blocks.
// A function declared in one is invisible to the other unless it is explicitly
// put on window, and when that export is missing NOTHING appears -- the button
// is simply absent, which is the failure mode nobody reports. This test asks
// the page itself rather than reading the source.
//
// The Twilio Device is stubbed: the SDK needs a live token and a real carrier
// leg, and neither belongs in a test. What is real here is everything from the
// `incoming` event onward, which is the part that was built.

import test, { before, after } from 'node:test';
import assert from 'node:assert';
import { startServer } from './serve.mjs';
import { findPlaywright, findChromium, unavailableReason, SUPABASE_STUB } from './driver.mjs';

const reason = unavailableReason();
const OPTS = reason ? { skip: reason } : {};
const pw = reason ? null : findPlaywright();
const chromiumPath = reason ? null : findChromium();

let server; let page; let browser;
let callerRequests = [];

// One client on the number.
const ONE = {
  clientId: 'c-100', name: 'Lori Kendall', firstName: 'Lori', lastName: 'Kendall',
  companyName: null, email: 'lori@example.com', phone: '+19145550111',
  address: '14 Maple Ave, Greenwich, CT', balance: 0, isLead: false, isArchived: false,
};
// Two clients sharing it -- 171 numbers in production look like this.
const TWO = [
  { ...ONE, clientId: 'c-201', name: 'Ana Ruiz', firstName: 'Ana', lastName: 'Ruiz', address: '2 Oak St' },
  { ...ONE, clientId: 'c-202', name: 'Bruno Ruiz', firstName: 'Bruno', lastName: 'Ruiz', address: '4 Elm Rd', balance: 1250 },
];

let callerReply = { ok: true, e164: '+19145550111', matches: [ONE], knownName: null };

before(async () => {
  if (reason) return;
  server = await startServer();
  browser = await pw.chromium.launch({ executablePath: chromiumPath, args: ['--no-sandbox', '--disable-gpu'] });
  page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  await page.route((u) => u.hostname !== '127.0.0.1' && u.protocol.startsWith('http'), (r) => r.abort());
  await page.route((u) => u.hostname.includes('jsdelivr.net') && u.pathname.includes('supabase'),
    (r) => r.fulfill({ body: SUPABASE_STUB, contentType: 'application/javascript' }));

  await page.route('**/api/voice**', async (route) => {
    const url = new URL(route.request().url());
    const resource = url.searchParams.get('resource');
    if (resource === 'caller') {
      callerRequests.push(url.searchParams.get('e164'));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(callerReply) });
    }
    if (resource === 'status') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, configured: true }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.route('**/api/track1**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, rows: [], clients: [] }) }));

  await page.goto(`${server.url}/index.html#win`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction('typeof window.hlNewLeadFromCall === "function"', null, { timeout: 30000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const strip = () => [...document.body.children].forEach((el) => {
      if (el.id === 'nlv' || el.id === 'nl-ask-back' || el.id === 'hlphonepop') return;
      const st = getComputedStyle(el);
      if (st.position === 'fixed' && Number(st.zIndex) >= 10000 && st.display !== 'none') el.remove();
    });
    new MutationObserver(strip).observe(document.body, { childList: true });
    strip();
  });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

// NOTE ON COVERAGE: what is exercised below is the prefill -- window.hlNewLeadFromCall
// and everything it touches. The popup's own ring rendering (lookupCaller,
// callerStripHtml, the "New lead?" button) cannot be driven from here:
// app-phone-popup.js is an IIFE that exposes none of its internals, and
// reaching them would need a live Twilio Device. Those are pinned by
// test/inbound-call-prefill.test.mjs at the source level instead, and the one
// thing that binds the two halves together -- the window export the popup
// checks for before it renders the button at all -- is asserted first here,
// against the real page.

test('the entry point the popup looks for is actually on window', OPTS, async () => {
  // Without this the "New lead?" button never renders at all -- newLeadButtonHtml
  // checks for it by name and returns an empty string.
  const t = await page.evaluate(() => typeof window.hlNewLeadFromCall);
  assert.strictEqual(t, 'function');
});

test('a known caller prefills the form from their own record', OPTS, async () => {
  callerReply = { ok: true, e164: '+19145550111', matches: [ONE], knownName: null };
  await page.evaluate((m) => {
    window.hlNewLeadFromCall({ phone: '+19145550111', matches: [m], knownName: null });
  }, ONE);
  await page.waitForTimeout(400);

  const form = await page.evaluate(() => ({
    open: document.getElementById('nlv').classList.contains('open'),
    first: document.getElementById('nl-first').value,
    last: document.getElementById('nl-last').value,
    email: document.getElementById('nl-email').value,
    addr: document.getElementById('nl-addr').value,
    clientId: document.getElementById('nl-clientid').value,
    phone: document.getElementById('nl-phone').value,
    matchShown: getComputedStyle(document.getElementById('nl-match')).display !== 'none',
    matchTxt: document.getElementById('nl-match-txt').textContent,
  }));
  assert.ok(form.open, 'the form should be open');
  assert.strictEqual(form.first, 'Lori');
  assert.strictEqual(form.last, 'Kendall');
  assert.strictEqual(form.email, 'lori@example.com');
  assert.strictEqual(form.addr, '14 Maple Ave, Greenwich, CT');
  assert.strictEqual(form.clientId, 'c-100', 'linked, so the lead is not a second copy of her');
  // Read back the way a person says it, not as +1914...
  assert.strictEqual(form.phone, '(914) 555-0111');
  assert.ok(form.matchShown);
  assert.match(form.matchTxt, /Matched by caller ID to Lori Kendall/);
});

test('an unknown caller still gets the number, and asks for a name', OPTS, async () => {
  await page.evaluate(() => {
    window.hlNewLeadFromCall({ phone: '+12035559999', matches: [], knownName: null });
  });
  await page.waitForTimeout(400);
  const form = await page.evaluate(() => ({
    phone: document.getElementById('nl-phone').value,
    first: document.getElementById('nl-first').value,
    clientId: document.getElementById('nl-clientid').value,
    focused: document.activeElement && document.activeElement.id,
    matchShown: getComputedStyle(document.getElementById('nl-match')).display !== 'none',
  }));
  assert.strictEqual(form.phone, '(203) 555-9999');
  assert.strictEqual(form.first, '', 'nothing invented');
  assert.strictEqual(form.clientId, '', 'not linked to anyone');
  assert.strictEqual(form.focused, 'nl-first', 'the cursor is where the missing fact goes');
  assert.ok(!form.matchShown, 'and no "matched" chip claiming otherwise');
});

test('the previous caller does not bleed into the next lead', OPTS, async () => {
  // Lori was linked a moment ago. Opening a lead for an unknown number must
  // not leave her client id attached to it.
  const clientId = await page.evaluate(() => document.getElementById('nl-clientid').value);
  assert.strictEqual(clientId, '');
});

test('two clients on one number means being asked, not guessed at', OPTS, async () => {
  await page.evaluate((ms) => {
    window.hlNewLeadFromCall({ phone: '+19145550111', matches: ms, knownName: null });
  }, TWO);
  await page.waitForTimeout(400);

  const sheet = await page.evaluate(() => {
    const b = document.getElementById('nl-ask-back');
    if (!b) return null;
    return {
      title: b.textContent.slice(0, 60),
      options: [...document.getElementById('nl-ask-who').options].map((o) => o.text),
    };
  });
  assert.ok(sheet, 'it must ask');
  assert.match(sheet.title, /2 clients share this number/);
  assert.ok(sheet.options.some((o) => o.includes('Ana Ruiz')));
  assert.ok(sheet.options.some((o) => o.includes('Bruno Ruiz')));
  // A number being on file does not prove the person holding it is on file.
  assert.ok(sheet.options.some((o) => /None of these/.test(o)));

  // Nothing may be attached until the question is answered.
  const before = await page.evaluate(() => document.getElementById('nl-clientid').value);
  assert.strictEqual(before, '', 'no client attached while the question is still open');

  await page.selectOption('#nl-ask-who', { label: TWO[1].name + ' — 4 Elm Rd' });
  await page.click('#nl-ask-back button[data-act="ok"]');
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({
    clientId: document.getElementById('nl-clientid').value,
    first: document.getElementById('nl-first').value,
    txt: document.getElementById('nl-match-txt').textContent,
  }));
  assert.strictEqual(after.clientId, 'c-202', 'the one actually chosen');
  assert.strictEqual(after.first, 'Bruno');
  assert.match(after.txt, /1,250 owed/, 'and what he owes is on screen before the call gets going');
});

test('"None of these" leaves the form blank rather than picking anyway', OPTS, async () => {
  await page.evaluate((ms) => {
    document.getElementById('nlv').classList.remove('open');
    window.hlNewLeadFromCall({ phone: '+19145550111', matches: ms, knownName: null });
  }, TWO);
  await page.waitForTimeout(400);
  await page.selectOption('#nl-ask-who', 'none');
  await page.click('#nl-ask-back button[data-act="ok"]');
  await page.waitForTimeout(300);
  const form = await page.evaluate(() => ({
    clientId: document.getElementById('nl-clientid').value,
    first: document.getElementById('nl-first').value,
    phone: document.getElementById('nl-phone').value,
  }));
  assert.strictEqual(form.clientId, '');
  assert.strictEqual(form.first, '');
  assert.strictEqual(form.phone, '(914) 555-0111', 'the number is still worth having');
});

test('the prefilled form does not immediately claim to be unsaved work', OPTS, async () => {
  // hlFormIsDirty compares against the photo taken by hlFormWatch. If the
  // prefill happens after the photo, the form is "dirty" the moment it opens
  // and closing it nags -- which teaches him to dismiss the nag that exists to
  // protect real typing.
  await page.evaluate((m) => {
    document.getElementById('nlv').classList.remove('open');
    window.hlNewLeadFromCall({ phone: '+19145550111', matches: [m], knownName: null });
  }, ONE);
  await page.waitForTimeout(500);
  const dirty = await page.evaluate(() => (typeof window.hlFormIsDirty === 'function' ? window.hlFormIsDirty('nlv') : null));
  assert.strictEqual(dirty, false, 'a form that was only prefilled is not unsaved work');
});

test('typing after the prefill IS unsaved work', OPTS, async () => {
  // The other half. If the snapshot swallowed everything, the guard is off.
  await page.evaluate(() => { document.getElementById('nl-need').value = 'Back door will not latch'; });
  const dirty = await page.evaluate(() => window.hlFormIsDirty('nlv'));
  assert.strictEqual(dirty, true);
});

test('opening a fresh lead shows no destination as already chosen', OPTS, async () => {
  // Regression on #567: nlResetForm re-added the selected border to the first
  // tile every time the form opened. The unit test could not see it, because
  // it checked the markup and this happens at runtime.
  await page.evaluate(() => { document.getElementById('nlv').classList.remove('open'); openNewLead(); });
  await page.waitForTimeout(300);
  const sel = await page.evaluate(() => document.querySelectorAll('#nl-nextsteps .step-o.sel').length);
  assert.strictEqual(sel, 0);
});

test('approximate cost does not carry into the next lead', OPTS, async () => {
  await page.evaluate(() => { document.getElementById('nl-approx').value = '850'; });
  await page.evaluate(() => { document.getElementById('nlv').classList.remove('open'); openNewLead(); });
  await page.waitForTimeout(300);
  const v = await page.evaluate(() => document.getElementById('nl-approx').value);
  assert.strictEqual(v, '', 'a number nobody typed for this lead is worse than an empty box');
});
