// The Schedule board's job sheet: the Client card.
//
// It used to be filled by synthClient(), which built a phone number from
// "(203) 555-" plus a hash of the client's name, an email of
// theirname@example.com, and a street address drawn from a list of seven by the
// same hash. That was fine when the board was a synthetic lab and false once it
// ran on real Jobber data -- a dispatcher was being shown a number to call that
// belongs to nobody. These tests run the board's real card builder and hold it
// to two rules: show what is on file, and say plainly when nothing is.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_PATH = path.join(__dirname, '..', 'public', 'schedule-board', 'app.js');
const DATA_PATH = path.join(__dirname, '..', 'public', 'schedule-board', 'data.js');
const source = fs.readFileSync(APP_PATH, 'utf-8');
const dataSource = fs.readFileSync(DATA_PATH, 'utf-8');

function extractFunction(src, decl) {
  const start = src.indexOf(decl);
  if (start === -1) throw new Error('function not found: ' + decl);
  let depth = 1, i = start + decl.length;
  while (depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(start, i);
}

const MAP_ESC_SRC = (source.match(/^\s*const mapEsc=.*$/m) || [])[0];
const FN_SRC = [
  MAP_ESC_SRC,
  extractFunction(source, 'function clientOf(v){'),
  extractFunction(source, 'function phoneLabel(raw){'),
  extractFunction(source, 'function clientCardHTML(v){'),
].join('\n');

function card(visit) {
  const ctx = { String, Object, Array, Math, JSON, console };
  vm.createContext(ctx);
  vm.runInContext(FN_SRC, ctx);
  ctx.__v = visit;
  vm.runInContext('__out = clientCardHTML(__v)', ctx);
  return ctx.__out;
}

const VISIT = {
  client: 'Mrs Vance', city: 'Greenwich', lat: 41.03, lng: -73.62,
  clientPhone: '+12035550134', clientEmail: 'vance@example.com',
  clientAddr: '12 Orchard St, Greenwich, CT 06830',
};

// ---------- the bug ----------

test('nothing on the card is invented', () => {
  // The old card, for a client with nothing on file, printed a phone, an email
  // and a street address anyway. The rule now is that a blank stays blank.
  const out = card({ client: 'Mr Poole', city: '', lat: null, lng: null });
  assert.doesNotMatch(out, /\(203\) 555-/, 'no hashed phone number');
  assert.doesNotMatch(out, /@example\.com/, 'no invented email');
  assert.doesNotMatch(out, /Orchard St|Maple Ave|Bedford Rd|Shore Dr|Round Hill Rd|Lake Ave|Cherry Ln/, 'no invented street');
  assert.match(out, /No phone on file/);
  assert.match(out, /No email on file/);
  assert.match(out, /No address on file/);
});

test('synthClient is gone from the board entirely', () => {
  assert.doesNotMatch(source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), /synthClient/,
    'the generator itself, and every call to it, must be gone');
});

// ---------- what it shows when the data is there ----------

test('the real phone, email and address are shown', () => {
  const out = card(VISIT);
  assert.match(out, /Mrs Vance/);
  assert.match(out, /\(203\) 555-0134/);
  assert.match(out, /vance@example\.com/);
  assert.match(out, /12 Orchard St, Greenwich, CT 06830/);
});

test('the phone dials and the email opens a draft', () => {
  const out = card(VISIT);
  assert.match(out, /href="tel:\+12035550134"/, 'tel: keeps the dialable form, not the pretty one');
  assert.match(out, /href="mailto:vance@example\.com"/);
});

test('an e164 number is shown the way a person reads one', () => {
  const ctx = { String, Object, Array, Math, JSON, console };
  vm.createContext(ctx);
  vm.runInContext(FN_SRC, ctx);
  const label = (raw) => { ctx.__r = raw; vm.runInContext('__o = phoneLabel(__r)', ctx); return ctx.__o; };
  assert.equal(label('+12035550134'), '(203) 555-0134');
  assert.equal(label('2035550134'), '(203) 555-0134');
  assert.equal(label('203-555-0134'), '(203) 555-0134');
});

test('a number that is not a plain NANP one is left exactly as stored', () => {
  // Reformatting an international or extension-carrying number into a
  // 10-digit shape would produce something the dialler cannot reach.
  const ctx = { String, Object, Array, Math, JSON, console };
  vm.createContext(ctx);
  vm.runInContext(FN_SRC, ctx);
  const label = (raw) => { ctx.__r = raw; vm.runInContext('__o = phoneLabel(__r)', ctx); return ctx.__o; };
  assert.equal(label('+44 20 7946 0958'), '+44 20 7946 0958');
  assert.equal(label('203-555-0134 x22'), '203-555-0134 x22');
  assert.equal(label(''), '');
});

// ---------- partial data ----------

test('a client with a phone but no email says so for the email only', () => {
  const out = card({ ...VISIT, clientEmail: null });
  assert.match(out, /\(203\) 555-0134/);
  assert.match(out, /No email on file/);
  assert.doesNotMatch(out, /No phone on file/);
});

test('a city with no street is shown as a city, and admits it is not an address', () => {
  const out = card({ ...VISIT, clientAddr: null });
  assert.match(out, /Greenwich/);
  assert.match(out, /no street address on file/);
});

test('the Look around button appears only where there are coordinates', () => {
  assert.match(card(VISIT), /Look around/);
  assert.doesNotMatch(card({ ...VISIT, lat: null, lng: null }), /Look around/);
});

test('Look around is labelled with the real address, falling back to client and town', () => {
  assert.match(card(VISIT), /openLookAround\(41\.03,-73\.62,'12 Orchard St, Greenwich, CT 06830'\)/);
  assert.match(card({ ...VISIT, clientAddr: null }), /openLookAround\(41\.03,-73\.62,'Mrs Vance, Greenwich'\)/);
});

// ---------- escaping ----------

test("a client's name and details are escaped into the card", () => {
  const out = card({
    ...VISIT,
    client: 'Bob & Sons <script>alert(1)</script>',
    clientEmail: 'a"b@example.com',
    clientAddr: "12 O'Hara St",
  });
  assert.doesNotMatch(out, /<script>/, 'a name cannot open a tag');
  assert.match(out, /Bob &amp; Sons/);
  assert.match(out, /a&quot;b@example\.com/);
  assert.match(out, /O&#39;Hara/);
});

test("a quote in an address cannot break out of the Look around handler", () => {
  const out = card({ ...VISIT, clientAddr: "12 O'Hara St" });
  const handler = (out.match(/onclick="openLookAround\(([^"]*)\)"/) || [])[1];
  assert.ok(handler, 'the button is still built');
  assert.doesNotMatch(handler, /'.*'.*'/, 'no stray quote inside the inline handler');
});

// ---------- the wiring that feeds it ----------

test('the board carries contact details onto every visit row', () => {
  assert.match(dataSource, /clientPhone: v\.clientPhone \|\| null/);
  assert.match(dataSource, /clientEmail: v\.clientEmail \|\| null/);
  assert.match(dataSource, /clientAddr: v\.clientAddress \|\| null/);
});

test("a chained crew member's row shows the same client as the lead's", () => {
  // The secondary rows are the same visit; opening one must not show a blank
  // client card just because it was built from a different branch.
  const chained = dataSource.slice(dataSource.indexOf("_chained'"));
  assert.match(chained.slice(0, 900), /\}, contact\)\)/, 'the chained row is built with the same contact');
});

test('a native appointment uses its own details, then the client it was booked for', () => {
  assert.match(dataSource, /clientPhone: det\.phone \|\| known\.clientPhone \|\| null/);
  assert.match(dataSource, /clientEmail: det\.email \|\| known\.clientEmail \|\| null/);
  assert.match(dataSource, /clientAddr: det\.address \|\| det\.addr \|\| known\.clientAddr \|\| null/);
});

test('the map pin shows the real street address too', () => {
  const pin = extractFunction(source, 'function jobPinHTML(v){');
  assert.match(pin, /v\.clientAddr\|\|v\.city/, 'street where known, town otherwise');
});
