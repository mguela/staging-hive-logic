// test/client-phone-edit.test.mjs
// jomell, 2026-08-25, looking at jovie folloso's real client card: a
// client's phone number should show up on their card, and be editable, the
// same way it works for every client, present or future.
//
// 2026-08-27: extended to also edit the address, for the same underlying
// reason -- there was no way to enter or fix one on an already-existing
// client at all.
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
  assert.match(fn, /onclick="efOpenEditClientContactModal\(/);
  assert.match(fn, /efOpenEditClientContactModal\([\s\S]{0,30}hlEsc\(c\.id\)/);
});

test('the Property section shows a real address when one is on file, with an Edit control', () => {
  const fn = extractFunction(HTML, 'function openRealClient(id){');
  assert.match(fn, /c\.address\s*\?/);
  assert.match(fn, /<span>Address<\/span>/);
  assert.doesNotMatch(fn, /No property intel synced into this view yet/, 'the old hardcoded placeholder must be gone now that c.address is real');
});

test('no address on file offers an Add-one control rather than a dead end', () => {
  const fn = extractFunction(HTML, 'function openRealClient(id){');
  assert.match(fn, /No address on file/);
  assert.match(fn, /Add one/);
});

test('a Call action appears once a phone number exists', () => {
  const fn = extractFunction(HTML, 'function openRealClient(id){');
  assert.match(fn, /if\(c\.phone\)acts\+='<button class="gbtn" onclick="window\.location\.href=\\'tel:/);
});

test('editing the phone does not use a native browser prompt', () => {
  const fn = extractFunction(HTML, 'function efOpenEditClientContactModal(id){');
  assert.doesNotMatch(fn, /window\.prompt|window\.confirm/);
  assert.match(fn, /hlModal\(/);
});

test('saving posts to update_client_contact with the client id, phone, and address fields', () => {
  const fn = extractFunction(HTML, 'function efOpenEditClientContactModal(id){');
  assert.match(fn, /hlApiPost\('update_client_contact',\{id:id,phone:phone,street:street,city:city,province:province,postalCode:postalCode\}\)/);
});

test('phone is always sent as typed, so an address-only edit can never null out an existing number', () => {
  const fn = extractFunction(HTML, 'function efOpenEditClientContactModal(id){');
  var phoneVarLine = fn.match(/var phone=[^\n]*/)[0];
  assert.match(phoneVarLine, /document\.getElementById\('ecp-phone'\)/, 'phone must come from its own always-rendered input, never omitted');
});

test('a successful save updates the in-memory client and re-renders the card live', () => {
  const fn = extractFunction(HTML, 'function efOpenEditClientContactModal(id){');
  assert.match(fn, /c\.phone\s*=\s*phone\|\|null/);
  assert.match(fn, /openRealClient\(id\)/);
});

test('a failed save shows the real error, not a silent no-op', () => {
  const fn = extractFunction(HTML, 'function efOpenEditClientContactModal(id){');
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

// jomell, 2026-08-27: an address typed in for an existing client had
// nowhere real to save to -- handleCreateClient only ever writes
// client_locations at brand-new-client creation time.
test('address fields are only written when a real street is given', () => {
  const fn = extractFunction(TRACK1, 'async function handleUpdateClientContact(req, res) {');
  assert.match(fn, /if \(String\(b\.street \|\| ''\)\.trim\(\)\)/);
});

test('the address upsert PATCHes an existing client_locations row rather than duplicating it', () => {
  const fn = extractFunction(TRACK1, 'async function upsertClientAddress(clientId, b) {');
  assert.match(fn, /client_locations\?jobber_id=eq\.\$\{encodeURIComponent\(clientId\)\}.*select=jobber_id/);
  assert.match(fn, /if \(rows\.length\)/);
  assert.match(fn, /method: 'PATCH'/);
});

test('the address upsert creates a new client_locations row when there was none', () => {
  const fn = extractFunction(TRACK1, "async function upsertClientAddress(clientId, b) {");
  assert.match(fn, /method: 'POST'/);
  assert.match(fn, /jobber_id: clientId/);
});

test('lat\\/lng are left for the geocoder, never guessed inline', () => {
  const fn = extractFunction(TRACK1, 'async function upsertClientAddress(clientId, b) {');
  assert.doesNotMatch(fn, /\blat\b\s*:/);
  assert.doesNotMatch(fn, /\blng\b\s*:/);
});

test('the route stays POST-only', () => {
  const fn = extractFunction(TRACK1, 'async function handleUpdateClientContact(req, res) {');
  assert.match(fn, /if \(req\.method !== 'POST'\) return res\.status\(405\)/);
});
