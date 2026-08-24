// The website enquiry form's intake endpoint.
//
// Chris, 2026-08-23: "build the web lead intake"
//
// Until this, nothing captured a lead from the website. No endpoint, no form,
// no table, no webhook -- the 'Website' and 'Google' options in "How did they
// find us?" were hand-picked afterwards by whoever retyped the enquiry.
//
// This and /api/schedule/confirm are the only two surfaces in the app that
// anyone on the internet can reach without an account, so most of what is
// asserted here is what the endpoint CANNOT be made to do.
//
// Run with: node --experimental-test-module-mocks --test test/web-lead-intake.test.mjs

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUARD = fs.readFileSync(path.join(__dirname, '..', 'api', '_lib', 'guard.js'), 'utf-8');
const FORM = fs.readFileSync(path.join(__dirname, '..', 'public', 'web-lead-form.html'), 'utf-8');

// Everything the handler wrote, and everything it asked for.
let writes = [];
let reads = [];
let clientMatch = [];      // rows returned for a clients?...select=jobber_id lookup
let rateLimitOk = true;
let failTable = null;      // a table whose insert should fail

mock.module('../api/_lib/jobber.js', {
  namedExports: {
    supabaseRequest: async (p, opts) => {
      const path_ = String(p);
      const method = (opts && opts.method) || 'GET';
      if (method === 'GET') {
        reads.push(path_);
        if (path_.startsWith('clients?')) return { ok: true, json: async () => clientMatch };
        return { ok: true, json: async () => [] };
      }
      writes.push({ path: path_, body: JSON.parse((opts && opts.body) || '{}') });
      if (failTable && path_.startsWith(failTable)) {
        return { ok: false, text: async () => 'boom', json: async () => ({}) };
      }
      if (path_.startsWith('clients')) {
        return { ok: true, json: async () => [{ jobber_id: JSON.parse(opts.body).jobber_id }] };
      }
      return { ok: true, json: async () => [{ id: 'lead-1' }] };
    },
    jobberGraphQL: async () => ({}),
  },
});

mock.module('../api/_lib/portal-auth.js', {
  namedExports: {
    checkRateLimit: async () => ({ allowed: rateLimitOk, reason: rateLimitOk ? undefined : 'store-error' }),
    hashToken: (s) => s,
    genToken: () => 'x',
    deliverLoginLink: async () => ({ delivered: false }),
  },
});

const mod = await import('../api/web-lead.js');

function res() {
  return {
    statusCode: null, body: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    end() { this.ended = true; return this; },
  };
}

async function post(body, extra = {}) {
  writes = []; reads = [];
  const r = res();
  await mod.default({
    method: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.9', ...(extra.headers || {}) },
    body,
    query: {},
  }, r);
  return r;
}

const GOOD = { name: 'Dana Fielder', phone: '(914) 555-0111', email: 'dana@example.com',
               address: '14 Maple Ave, Greenwich CT', need: 'Back door will not latch' };

const leadWrite = () => writes.find((w) => w.path.startsWith('lead_pipeline'));
const clientWrite = () => writes.find((w) => w.path.startsWith('clients'));

// ---- it is on the public allowlist, deliberately and with reasons ----------

test('the route is allowlisted past the session guard', () => {
  // Without this every submission 401s at the edge before reaching the handler.
  assert.match(GUARD, /'\/api\/web-lead',/);
});

test('the allowlist entry says why it is safe', () => {
  // Every other entry in that list carries its justification. An undocumented
  // public route is one nobody can audit later.
  const i = GUARD.indexOf("'/api/web-lead',");
  const entry = GUARD.slice(i, i + 900);
  assert.match(entry, /WRITE-ONLY/);
  assert.match(entry, /enumerate/);
  assert.match(entry, /rate limited/i);
});

// ---- what it accepts -------------------------------------------------------

test('a real enquiry creates a client and a lead', async () => {
  clientMatch = [];
  const r = await post(GOOD);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);

  const c = clientWrite();
  assert.ok(c, 'a client row');
  assert.equal(c.body.name, 'Dana Fielder');
  assert.equal(c.body.first_name, 'Dana');
  assert.equal(c.body.last_name, 'Fielder');
  // This is what makes the existing check_new_leads cron text Chris within 15
  // minutes. Without it a website lead lands silently and nobody looks.
  assert.equal(c.body.is_lead, true);

  const l = leadWrite();
  assert.ok(l, 'a lead row');
  assert.equal(l.body.stage, 'new');
  assert.equal(l.body.lead_source, 'Website');
  assert.equal(l.body.need, 'Back door will not latch');
  assert.equal(l.body.title, 'Back door will not latch', 'what they wrote is the headline too');
  assert.equal(l.body.service_address, '14 Maple Ave, Greenwich CT');
});

// ---- nothing a stranger types becomes an identity -------------------------
//
// The first draft of this endpoint attached a submission to an existing client
// whenever the typed email or phone matched one. A security review found that
// three separate parts of HiveLogic treat a clients row as PROOF of who
// somebody is, and a web form proves nothing:
//
//   clients.phone_e164      -> who is calling (the screen pop, and the voice
//                              webhook's own caller attribution)
//   clients.email           -> who gets a Client Portal sign-in link
//   lead_pipeline.client_id -> whose record a piece of work belongs to
//
// These are the tests for that boundary. They are the most important ones in
// this file.

test('a submission never attaches itself to an existing client', async () => {
  // Anyone who knows a customer's email could otherwise file a lead ON that
  // customer's record carrying their own callback number, and the office would
  // ring a stranger believing it was a ten-year client. Nothing here is
  // verified, so nothing here gets to choose whose record it lands on.
  clientMatch = [{ jobber_id: 'existing-42', name: 'Barrie Levitt' }];
  const r = await post({ ...GOOD, email: 'barrie.levitt@example.com' });
  assert.equal(r.statusCode, 200);
  const c = clientWrite();
  assert.ok(c, 'it makes its own row');
  assert.notEqual(c.body.jobber_id, 'existing-42');
  assert.equal(leadWrite().body.client_id, c.body.jobber_id, 'and the lead hangs off that one');
});

test('the created client carries a name and no way to be identified by', async () => {
  // clients.phone_e164 is the caller-ID index and clients.email is what portal
  // sign-in resolves against. A stranger writing either means naming yourself
  // "Con Edison" against a number you chose and having the screen pop confirm
  // it, or shadowing a real customer at sign-in.
  clientMatch = [];
  await post(GOOD);
  const c = clientWrite().body;
  assert.equal(c.name, 'Dana Fielder');
  assert.equal(c.phone_e164, undefined, 'no caller-ID claim');
  assert.equal(c.email, undefined, 'no sign-in claim');
});

test('the contact details still reach the office, on the lead', async () => {
  // Removing them from the client record must not mean losing them -- the
  // office has to be able to answer the person.
  clientMatch = [];
  await post(GOOD);
  const l = leadWrite().body;
  assert.equal(l.phone, '+19145550111');
  assert.match(l.notes, /Email: dana@example\.com/);
  assert.match(l.notes, /have not been verified/, 'and it says what they are worth');
});

test('a likely match is offered to staff as a note, never acted on', async () => {
  // The signal is genuinely useful. The authority is what the attacker wanted.
  clientMatch = [{ jobber_id: 'existing-42', name: 'Barrie Levitt' }];
  await post(GOOD);
  const l = leadWrite().body;
  assert.match(l.notes, /matches an existing client/);
  assert.match(l.notes, /before merging/);
  assert.notEqual(l.client_id, 'existing-42', 'a note, not a link');
});

test('phone is checked before email for the hint', async () => {
  clientMatch = [{ jobber_id: 'c1', name: 'Someone' }];
  await post(GOOD);
  assert.match(reads[0], /phone_e164=eq/);
});

test('an enquiry with no message still becomes a usable card', async () => {
  clientMatch = [];
  await post({ name: 'Sam Reed', phone: '9145550122' });
  assert.match(leadWrite().body.title, /Website enquiry from Sam Reed/,
    'a blank headline is a card nobody can tell apart in the pipeline');
});

test('a one-word name does not lose the name', async () => {
  clientMatch = [];
  await post({ name: 'Cher', email: 'cher@example.com' });
  assert.equal(clientWrite().body.first_name, 'Cher');
  assert.equal(clientWrite().body.last_name, null);
  assert.equal(clientWrite().body.name, 'Cher');
});

// ---- what it refuses -------------------------------------------------------

test('no name, or no way to reply, is refused', async () => {
  for (const bad of [
    {},
    { name: 'Dana' },                                  // no phone, no email
    { phone: '9145550111' },                           // no name
    { name: '   ', email: 'a@b.co' },                  // whitespace is not a name
    { name: 'Dana', email: 'not-an-email' },           // and that is not reachable
  ]) {
    const r = await post(bad);
    assert.equal(r.statusCode, 400, JSON.stringify(bad) + ' should be refused');
    assert.equal(writes.length, 0, 'nothing written');
  }
});

test('a phone number nobody could ring is not a way to reply', async () => {
  // normalizeToE164 is a formatter, not a validator: it returns '+' for "+"
  // and '+1' for "1", both truthy. Trusting that let an enquiry through with
  // no reachable contact at all -- a lead the office can only stare at.
  for (const junk of ['+', '++', '1', '555', '(', '   ']) {
    const r = await post({ name: 'Dana Fielder', phone: junk });
    assert.equal(r.statusCode, 400, JSON.stringify(junk) + ' is not a phone number');
    assert.equal(writes.length, 0);
  }
});

test('a real number, however it is typed, is accepted', async () => {
  clientMatch = [];
  for (const good of ['9145550111', '(914) 555-0111', '914.555.0111', '+1 914 555 0111', '1-914-555-0111']) {
    const r = await post({ name: 'Dana Fielder', phone: good });
    assert.equal(r.statusCode, 200, good + ' should be accepted');
    assert.equal(leadWrite().body.phone, '+19145550111', good + ' should normalize onto the lead');
  }
});

test('an email alone is still enough, with no phone at all', async () => {
  clientMatch = [];
  const r = await post({ name: 'Dana Fielder', email: 'dana@example.com' });
  assert.equal(r.statusCode, 200);
  assert.equal(leadWrite().body.phone, null);
  assert.match(leadWrite().body.notes, /Email: dana@example\.com/);
});

test('GET does nothing', async () => {
  // Link scanners and prefetchers hit URLs. A GET that created a lead would
  // mean every crawler files one.
  const r = res();
  await mod.default({ method: 'GET', headers: {}, query: {}, body: {} }, r);
  assert.equal(r.statusCode, 405);
  assert.equal(r.headers.allow, 'POST, OPTIONS');
});

test('a filled honeypot is accepted and written nowhere', async () => {
  // Telling a bot it was caught only teaches it to stop filling that field.
  const r = await post({ ...GOOD, company_website: 'http://spam.example' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true, 'indistinguishable from a real submission');
  assert.equal(writes.length, 0, 'and nothing reached the database');
});

test('the honeypot is checked before anything else', async () => {
  // Before validation and before the rate limiter, so a bot flood costs one
  // string comparison rather than a round trip each.
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'web-lead.js'), 'utf-8');
  const i = src.indexOf('company_website');
  assert.ok(i > -1);
  assert.ok(i < src.indexOf('checkRateLimit('), 'honeypot before the limiter');
  assert.ok(i < src.indexOf('normalizeToE164(phoneRaw)'), 'and before the parsing');
});

// ---- abuse -----------------------------------------------------------------

test('a throttled connection is refused, and nothing is written', async () => {
  rateLimitOk = false;
  const r = await post(GOOD);
  rateLimitOk = true;
  assert.equal(r.statusCode, 429);
  assert.equal(writes.length, 0);
});

test('the limiter is consulted before any write', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'web-lead.js'), 'utf-8');
  assert.ok(src.indexOf('checkRateLimit(') < src.indexOf("supabaseRequest('clients'"),
    'throttling after the insert throttles nothing');
});

test('it fails closed, using the shared limiter rather than its own', async () => {
  // checkRateLimit returns allowed:false when the store is missing or erroring.
  // A private counter here would have to re-learn that, and would get it wrong.
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'web-lead.js'), 'utf-8');
  assert.match(src, /import \{ checkRateLimit \} from '\.\/_lib\/portal-auth\.js'/);
  assert.match(src, /if \(!rl\.allowed\)/);
});

test('the caller cannot invent a lead source', async () => {
  // lead_source feeds the marketing report. Free text from the public means
  // anyone can conjure a channel and skew where the money looks like it comes
  // from.
  clientMatch = [];
  await post({ ...GOOD, source: 'Definitely Our Best Channel' });
  assert.equal(leadWrite().body.lead_source, 'Website');

  await post({ ...GOOD, source: 'Google' });
  assert.equal(leadWrite().body.lead_source, 'Google', 'a real one is kept');
});

test('every field is length-capped before it reaches the database', async () => {
  clientMatch = [];
  await post({
    name: 'A'.repeat(500),
    email: 'b'.repeat(400) + '@example.com',
    phone: '9'.repeat(200),
    address: 'C'.repeat(900),
    need: 'D'.repeat(9000),
  });
  const c = clientWrite(), l = leadWrite();
  assert.equal(c.body.name.length, 120);
  assert.ok((l.body.need || '').length <= 4000);
  assert.ok((l.body.service_address || '').length <= 300);
});

test('the response cannot be used to enumerate customers', async () => {
  // The whole point. If "we know that email" reads differently from "we do
  // not", anyone can walk a list of addresses and learn the client book.
  clientMatch = [{ jobber_id: 'existing-42' }];
  const known = await post(GOOD);
  clientMatch = [];
  const unknown = await post(GOOD);
  assert.equal(known.statusCode, unknown.statusCode);
  assert.deepEqual(known.body, unknown.body);
});

test('a database error does not leak table or column names', async () => {
  clientMatch = [];
  failTable = 'clients';
  const r = await post(GOOD);
  failTable = null;
  assert.equal(r.statusCode, 500);
  assert.ok(!/clients|lead_pipeline|insert|supabase/i.test(JSON.stringify(r.body)),
    'the error text names internals and this endpoint answers to anyone: ' + JSON.stringify(r.body));
  assert.match(r.body.error, /call us/, 'and it tells them what to do instead');
});

// ---- CORS ------------------------------------------------------------------

test('CORS is closed unless the origin is named', async () => {
  delete process.env.WEB_LEAD_ALLOWED_ORIGINS;
  const r = await post(GOOD, { headers: { origin: 'https://anything.example' } });
  assert.equal(r.headers['access-control-allow-origin'], undefined,
    'unset means same-origin only -- the safe default, not the convenient one');
});

test('a named origin is allowed, and only that exact origin', async () => {
  process.env.WEB_LEAD_ALLOWED_ORIGINS = 'https://ghgrp.net,https://www.ghgrp.net';
  const good = await post(GOOD, { headers: { origin: 'https://www.ghgrp.net' } });
  assert.equal(good.headers['access-control-allow-origin'], 'https://www.ghgrp.net');
  assert.equal(good.headers.vary, 'Origin');

  // A prefix or substring check here is how "ghgrp.net" comes to also mean
  // "ghgrp.net.evil.com".
  for (const bad of ['https://ghgrp.net.evil.com', 'https://evil.com/https://ghgrp.net', 'http://ghgrp.net']) {
    const r = await post(GOOD, { headers: { origin: bad } });
    assert.equal(r.headers['access-control-allow-origin'], undefined, bad + ' must not be allowed');
  }
  delete process.env.WEB_LEAD_ALLOWED_ORIGINS;
});

test('preflight is answered without doing anything', async () => {
  process.env.WEB_LEAD_ALLOWED_ORIGINS = 'https://ghgrp.net';
  writes = [];
  const r = res();
  await mod.default({ method: 'OPTIONS', headers: { origin: 'https://ghgrp.net' }, query: {}, body: {} }, r);
  assert.equal(r.statusCode, 204);
  assert.equal(writes.length, 0);
  delete process.env.WEB_LEAD_ALLOWED_ORIGINS;
});

// ---- the form --------------------------------------------------------------

test('the form carries the honeypot the server checks for', () => {
  // If these two names ever drift apart the trap silently stops working, and
  // nothing looks wrong.
  assert.match(FORM, /name="company_website"/);
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'web-lead.js'), 'utf-8');
  assert.match(src, /b\.company_website/);
});

test('the honeypot is hidden more than one way', () => {
  // A careless bot checks display:none and fills everything else.
  const i = FORM.indexOf('.hp {');
  const rule = FORM.slice(i, FORM.indexOf('}', i));
  assert.match(rule, /position: absolute/);
  assert.match(rule, /opacity: 0/);
  assert.match(rule, /width: 1px/);
});

test('the honeypot is not offered to a person by keyboard or screen reader', () => {
  // The input itself, not the comment at the top of the file that explains it.
  const i = FORM.indexOf('name="company_website"');
  assert.ok(i > -1);
  const around = FORM.slice(i - 400, i + 200);
  assert.match(around, /aria-hidden="true"/, 'the wrapper is hidden from assistive tech');
  assert.match(around, /tabindex="-1"/, 'and it cannot be tabbed into');
});

test('a failed send keeps what the person typed', () => {
  // Wiping the form because the network hiccuped is how an enquiry is lost
  // twice -- once by us and once by them.
  const i = FORM.indexOf("btn.disabled = false;");
  assert.ok(i > -1);
  assert.ok(!/form\.reset\(\)/.test(FORM), 'nothing resets the form on failure');
});

test('the form asks for the same minimum the server enforces', () => {
  assert.match(FORM, /!body\.name\.trim\(\) \|\| \(!body\.phone\.trim\(\) && !body\.email\.trim\(\)\)/);
});

// ---- what a stranger's text can do once it is inside ----------------------

test('a lead name cannot smuggle a link into the owner alert SMS', async () => {
  // check_new_leads texts Chris FROM HIS OWN COMPANY NUMBER. Since this
  // endpoint exists, a lead name can be typed by a stranger -- so
  // "HiveLogic alert: re-auth at <domain>" would arrive looking like a system
  // message from a trusted sender. There is no rendering context to escape
  // into here, only a person deciding whether to tap, so links are removed
  // rather than encoded.
  const TRACK1 = fs.readFileSync(path.join(__dirname, '..', 'api', 'track1.js'), 'utf-8');
  const fn = TRACK1.slice(TRACK1.indexOf('function smsSafeLeadTitle('),
                          TRACK1.indexOf('async function handleCheckNewLeadsGet'));
  assert.ok(fn.includes('smsSafeLeadTitle'), 'the sanitiser exists');

  // Run the real thing rather than asserting on its source.
  const smsSafeLeadTitle = new Function('return ' + fn.slice(fn.indexOf('function smsSafeLeadTitle')))();
  // The first version of this blocklisted 13 TLDs. Every one of these got
  // through it, and the test suite passed because it only tried the 13.
  // The rule is an allowlist now, so there is no list to fall behind.
  for (const attack of [
    'HiveLogic alert: re-auth at hivelogic-id.co/r',
    'go to https://evil.example/x now',
    'www.evil.com',
    'GH Group: re-auth bit.ly/gh-id',   // .ly
    'hivelogic-id.ai/r',                // .ai
    'gh-portal.ru/login',               // .ru
    'hl.click/x', 'g.page/x', 'short.gg/a', 'evil.tv/x',
    '192.0.2.10/x',                     // a bare IP is tappable too
    'hxxp://evil.example',              // the obfuscation people still tap
    'www.evil.anything',
  ]) {
    assert.match(smsSafeLeadTitle(attack), /\[link removed\]/, attack + ' must not survive');
  }

  // A callback number is the other half of a voice-phishing attempt, and the
  // sender being the company's own number is what sells it.
  assert.match(smsSafeLeadTitle('Invoice hold - call 914-555-0142 now'), /\[number removed\]/);
  assert.match(smsSafeLeadTitle('call +1 914 555 0142'), /\[number removed\]/);

  // A quote in the name closed the framing and let the text read as our own
  // prose. Nothing may re-open it.
  assert.ok(!smsSafeLeadTitle('Acct alert" verify at bit.ly/x "').includes('"'));

  // A lookalike dot (U+2024) renders like a domain but must not stay tappable.
  assert.ok(!/\./.test(smsSafeLeadTitle('evil\u2024com')));
  // A real lead name survives intact -- a sanitiser that mangles ordinary
  // enquiries gets switched off.
  // A sanitiser that mangles ordinary enquiries gets switched off, so this
  // half matters as much as the blocking half.
  for (const real of [
    'Kitchen remodel — cabinets',
    'Back door will not latch',
    "O'Brien - 14 Maple Ave",
    'Deck rebuild 16x20',
    'Repaint (whole house)',
    'Bath & powder room',
    'José Núñez',
  ]) {
    assert.equal(smsSafeLeadTitle(real), real, real + ' is a real lead name and must survive intact');
  }
  // Newlines cannot fake a second message, and length is bounded.
  assert.ok(!/\n/.test(smsSafeLeadTitle('a\nb')));
  assert.ok(smsSafeLeadTitle('A'.repeat(400)).length <= 61);
  assert.equal(smsSafeLeadTitle(''), 'New lead');
});

test('the alert quotes the name so it reads as somebody else\'s words', async () => {
  const TRACK1 = fs.readFileSync(path.join(__dirname, '..', 'api', 'track1.js'), 'utf-8');
  assert.match(TRACK1, /'New lead opportunity: "' \+ smsSafeLeadTitle\(cand\.title\) \+ '"/);
});

// ---- a name is not inert ---------------------------------------------------

test('a submitted name cannot carry markup', async () => {
  // The fix for the identity findings kept `name` as the one attacker-chosen
  // field on the clients row, on the premise that a bare name is harmless.
  // It is not: clients.name reaches chirpToast, which writes innerHTML.
  // Stripped at the door as well as escaped at the sink -- one unescaped sink
  // anywhere in a 30,000-line page is an admin session token.
  clientMatch = [];
  await post({ ...GOOD, name: '<img src=x onerror=alert(1)>Dana', need: '<script>x</script>leak' });
  assert.ok(!/[<>]/.test(clientWrite().body.name), 'no angle brackets in the stored name');
  assert.ok(!/[<>]/.test(leadWrite().body.need), 'nor in what they wrote');
  assert.ok(!/[<>]/.test(leadWrite().body.title));
});

test('the lead board escapes a name before putting it in a toast', async () => {
  // chirpToast writes innerHTML. Dragging a website lead to Contacted is the
  // ordinary next action on one, and it used to run whatever was in the name.
  const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');
  assert.match(HTML, /chirpToast\('✓ ' \+ hlEsc\(lead\.name\)/);
});

test('the merge hint does not name the client it matched', async () => {
  // Printing it confirms a name the submitter may only have guessed, and turns
  // a prompt to check into a prompt to merge -- which is what attaching
  // automatically would have done.
  clientMatch = [{ jobber_id: 'existing-42', name: 'Barrie Levitt' }];
  await post(GOOD);
  const notes = leadWrite().body.notes;
  assert.match(notes, /matches an existing client/);
  assert.ok(!notes.includes('Barrie Levitt'), 'the name stays out of it');
  assert.match(notes, /before merging/);
});

test('a phone that failed the check still reaches the office', async () => {
  // It is not good enough to count as "a way to reply", but it is still a clue
  // for whoever picks the lead up, and dropping it silently helps nobody.
  clientMatch = [];
  await post({ name: 'Dana Fielder', email: 'dana@example.com', phone: '555-0142' });
  assert.equal(leadWrite().body.phone, '555-0142');
});
