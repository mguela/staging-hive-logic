// test/client-phone-edit.test.mjs
// jomell, 2026-08-25, looking at jovie folloso's real client card: "in
// clients (clients tab) where its almost getting data everytime like their
// name and number, for example jovie. his number is not present anywhere
// add this and it should reflect to all clients and future clients."
//
// openRealClient() (the real, Jobber-synced client card) never rendered a
// Phone row at all -- a DIFFERENT card (the appointment sheet) already
// showed "No phone on file" correctly, this one just omitted the field
// entirely. There was also no way to edit an existing client's phone
// anywhere: the only client-mutation path (handleCreateClient) only ever
// creates a brand-new HiveLogic client.
//
// The fix writes ONLY clients.phone, never phone_e164 -- api/jobber/
// sync.js's mapClient() does a full-row upsert on jobber_id every hour and
// always includes phone_e164 (even as null), so writing there directly
// would get silently wiped on the next sync for any real Jobber client.
// `phone` is never in that payload, and api/clients.js already reads it as
// the fallback (phone: c.phone_e164 || c.phone || null), so it is the
// column HiveLogic can actually own.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');
const TRACK1 = fs.readFileSync(path.join(__dirname, '..', 'api', 'track1.js'), 'utf-8');

function extractFunction(src, decl) {
  const start = src.indexOf(decl);
  if (start === -1) throw new Error('not found: ' + decl);
  let depth = 1, i = start + decl.length;
  while (depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(start, i);
}

// ---- frontend ---------------------------------------------------------

test('the real client card renders a Phone row', () => {
  const fn = extractFunction(HTML, 'function openRealClient(id){');
  assert.match(fn, /<span>Phone<\/span>/);
  assert.match(fn, /c\.phone\?hlEsc\(c\.phone\)/);
  assert.match(fn, /No phone on file/, 'must say so honestly when there is none, like the appointment card already does');
});

test('the Phone row has a real Edit control, wired to the new modal', () => {
  const fn = extractFunction(HTML, 'function openRealClient(id){');
  assert.match(fn, /onclick="efOpenEditClientPhoneModal\(/);
  assert.match(fn, /efOpenEditClientPhoneModal\([\s\S]{0,30}hlEsc\(c\.id\)/);
});

test('a Call action appears once a phone number exists', () => {
  const fn = extractFunction(HTML, 'function openRealClient(id){');
  assert.match(fn, /if\(c\.phone\)acts\+='<button class="gbtn" onclick="window\.location\.href=\\'tel:/);
});

test('editing the phone does not use a native browser prompt', () => {
  const fn = extractFunction(HTML, 'function efOpenEditClientPhoneModal(id){');
  assert.doesNotMatch(fn, /window\.prompt|window\.confirm/);
  assert.match(fn, /hlModal\(/);
});

test('saving posts to update_client_contact with the client id and the typed number', () => {
  const fn = extractFunction(HTML, 'function efOpenEditClientPhoneModal(id){');
  assert.match(fn, /hlApiPost\('update_client_contact',\{id:id,phone:phone\}\)/);
});

test('a successful save updates the in-memory client and re-renders the card live', () => {
  const fn = extractFunction(HTML, 'function efOpenEditClientPhoneModal(id){');
  assert.match(fn, /c\.phone\s*=\s*phone\|\|null/);
  assert.match(fn, /openRealClient\(id\)/);
});

test('a failed save shows the real error, not a silent no-op', () => {
  const fn = extractFunction(HTML, 'function efOpenEditClientPhoneModal(id){');
  assert.match(fn, /if\(!d\|\|!d\.ok\)/);
  assert.match(fn, /err\.style\.display='block'/);
});

// ---- backend ------------------------------------------------------------

test('the resource dispatch routes update_client_contact to the real handler', () => {
  assert.match(TRACK1, /resource === 'update_client_contact'/);
  assert.match(TRACK1, /handleUpdateClientContact\(req, res\)/);
});

test('the handler requires a signed-in HiveLogic user', () => {
  const fn = extractFunction(TRACK1, 'async function handleUpdateClientContact(req, res) {');
  assert.match(fn, /getRequestingProfile\(req\)/);
  assert.match(fn, /Not signed in/);
});

test('the handler requires a client id', () => {
  const fn = extractFunction(TRACK1, 'async function handleUpdateClientContact(req, res) {');
  assert.match(fn, /if \(!id\) return res\.status\(400\)/);
});

test('the handler writes ONLY clients.phone, never phone_e164', () => {
  // The whole point: phone_e164 is in the Jobber sync's upsert payload
  // (mapClient(), always sent even as null) -- writing it here would be
  // silently overwritten on the very next hourly sync for a real client.
  const fn = extractFunction(TRACK1, 'async function handleUpdateClientContact(req, res) {');
  assert.match(fn, /body: JSON\.stringify\(\{ phone: phoneRaw \|\| null \}\)/);
  assert.doesNotMatch(fn, /phone_e164/, 'must never touch the Jobber-owned column');
});

test('the handler PATCHes the existing row by jobber_id, rather than inserting a new one', () => {
  const fn = extractFunction(TRACK1, 'async function handleUpdateClientContact(req, res) {');
  assert.match(fn, /method: 'PATCH'/);
  assert.match(fn, /clients\?jobber_id=eq\.\$\{encodeURIComponent\(id\)\}/);
});

test('a client id that matches nothing is reported as not found, not a silent success', () => {
  const fn = extractFunction(TRACK1, 'async function handleUpdateClientContact(req, res) {');
  assert.match(fn, /if \(!rows\.length\) return res\.status\(404\)/);
});

test('the route stays POST-only', () => {
  const fn = extractFunction(TRACK1, 'async function handleUpdateClientContact(req, res) {');
  assert.match(fn, /if \(req\.method !== 'POST'\) return res\.status\(405\)/);
});
