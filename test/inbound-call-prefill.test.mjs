// Chris, 2026-08-23: "Call > existing client phone # > question should be at
// the inception of the call > 'New Lead?' > clicking yes should open a
// prefilled New Lead Form by the recognized phone number and pulled existing
// client's info."
//
// Everything needed for this already existed and none of it was connected.
//
//   - Twilio delivers the caller's number to the browser today:
//     app-phone-popup.js reads call.parameters.From on the `incoming` event.
//     It rendered that raw number as the ring label and stopped there.
//   - The server already resolves caller -> client (voice-webhook.js
//     lookupClientAndJob) and writes client_id onto the voice_calls row, but
//     only the CALL LOG ever read it back -- never the ringing browser.
//   - clients.phone_e164 is populated for 7,434 of 8,690 clients, and 13 of
//     the 14 real inbound calls in production resolved to a client.
//
// So the office watched a bare +1 number ring, answered it, and retyped a name
// and address HiveLogic already had.
//
// What was there instead was a MOCKUP: a hardcoded "Sarah Jones · (914)
// 555-0123 · lifetime $86K" screen-pop whose Accept button typed a fictional
// client into the real New Lead form. Pressing Save after it would have
// written an invented lead into the real pipeline.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf-8');
const POPUP = fs.readFileSync(path.join(root, 'public', 'app-phone-popup.js'), 'utf-8');
const VOICE = fs.readFileSync(path.join(root, 'api', 'voice.js'), 'utf-8');

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

// ---- the fake one is gone ---------------------------------------------------

test('the hardcoded Sarah Jones screen-pop no longer exists', () => {
  // It typed a fictional client into the real New Lead form -- name, email,
  // address, and the claim "Existing client matched by caller ID". Save from
  // there and an invented lead lands in the real pipeline.
  assert.ok(!HTML.includes('function acceptCall'), 'the fake accept handler is gone');
  assert.ok(!HTML.includes('function simCall'), 'and the demo trigger that was its only caller');
  assert.ok(!HTML.includes('id="icv"'), 'and the pop itself');
  assert.ok(!HTML.includes('Demo: incoming call'), 'and the button');
  assert.ok(!HTML.includes('Existing client matched by caller ID'), 'and its invented match claim');
});

test('nothing writes a fabricated client into the real New Lead form', () => {
  // The point of removing the pop, stated as the rule rather than as one name:
  // the only things that may fill nl-first/nl-last/nl-email are the client
  // picker, a saved draft, and the caller lookup -- all of which read a real
  // record. A literal name or email next to those fields is a mockup.
  //
  // (Sarah Jones survives elsewhere in the file -- the HiveLine email and
  // voicemail lists are a separate mockup panel that writes nothing. This
  // checks the lead form specifically.)
  const writers = [...HTML.matchAll(/getElementById\('nl-(?:first|last|email|addr)'\)\.value\s*=\s*([^;]+);/g)]
    .map((m) => m[1].trim());
  assert.ok(writers.length > 0, 'expected to find the writers');
  for (const w of writers) {
    assert.ok(!/^'[^']*[A-Za-z]{3}/.test(w),
      'a hardcoded value is being typed into the lead form: ' + w);
  }
});

test('no dead references to the removed pop are left behind', () => {
  assert.ok(!HTML.includes("getElementById('icv')"));
  assert.ok(!/\.icv\{/.test(HTML), 'its CSS went with it');
});

// ---- the endpoint -----------------------------------------------------------

test('there is a caller lookup the browser can call', () => {
  assert.match(VOICE, /caller: handleCallerGet,/);
  assert.match(VOICE, /async function handleCallerGet\(req, res\) \{/);
});

test('the lookup is behind the same session check as the rest of voice', () => {
  // It returns a client's name, email, address and balance from a phone
  // number. Unauthenticated that is a lookup service for the whole client book.
  const i = VOICE.indexOf('const GET_HANDLERS');
  const gate = VOICE.slice(VOICE.indexOf('export default async function handler'));
  assert.match(gate, /if \(req\.method === 'GET' && resource === 'status'\) return handleStatus/);
  assert.match(gate, /const user = await requireUser\(req\);/);
  // status is the only public GET; caller must not have been added beside it.
  assert.ok(!/resource === 'caller'/.test(gate), 'caller is not exempted from the session check');
  assert.ok(i > -1);
});

test('it normalizes the number instead of trusting the caller-ID string', () => {
  const fn = extractFunction(VOICE, 'async function handleCallerGet(req, res) {');
  assert.match(fn, /normalizeToE164\(req\.query\.e164/);
  assert.match(fn, /A phone number is required/);
});

test('it resolves in the same order as the call log', () => {
  // If the ring card and the call log disagree about who a number belongs to,
  // one of them is lying and there is no way to tell which.
  const fn = extractFunction(VOICE, 'async function handleCallerGet(req, res) {');
  assert.match(fn, /clients\?phone_e164=eq\./);
  assert.match(fn, /voice_known_numbers\?e164=eq\./);
});

test('a hand-linked number counts as a match', () => {
  // "Add to Existing Contact" exists precisely for a customer ringing from a
  // number that is not the one on their record. Ignoring it here would make
  // that feature look broken.
  const fn = extractFunction(VOICE, 'async function handleCallerGet(req, res) {');
  assert.match(fn, /knownClientId/);
  assert.match(fn, /rows\.some\(c => String\(c\.jobber_id\) === knownClientId\)/);
});

test('it returns every match, not the first', () => {
  // 171 numbers in production belong to more than one client, up to four.
  const fn = extractFunction(VOICE, 'async function handleCallerGet(req, res) {');
  assert.match(fn, /matches/);
  assert.ok(!/phone_e164=eq\.\$\{enc\}&select=\$\{SELECT\}&limit=1\b/.test(fn),
    'a limit of 1 would silently pick one of several people');
  assert.match(fn, /limit=25/);
});

test('a missing address never costs us the match', () => {
  const fn = extractFunction(VOICE, 'async function handleCallerGet(req, res) {');
  const addr = fn.slice(fn.indexOf('const addressById'));
  assert.match(addr, /catch/, 'the address lookup is wrapped');
});

// ---- the popup --------------------------------------------------------------

test('the lookup fires when the call arrives, not when it is answered', () => {
  // "at the inception of the call". Looking it up on answer would put the name
  // on screen after the decision it exists to inform.
  const i = POPUP.indexOf("state.device.on('incoming'");
  const j = POPUP.indexOf('state.ringingCall = call;', i);
  const head = POPUP.slice(i, j);
  assert.match(head, /lookupCaller\(/);
  assert.ok(head.indexOf('lookupCaller(') < head.indexOf('state.waitingCall = call'),
    'it runs before any of the ring/waiting branching');
});

test('an extension-to-extension call is not asked about', () => {
  // Those arrive as `client:ext-4`. There is no customer behind one.
  const fn = extractFunction(POPUP, 'function lookupCaller(rawFrom) {');
  assert.match(fn, /\^\\\+\?\\d/, 'it checks the From looks like a phone number');
  assert.match(fn, /resetCaller\(\); return;/);
});

test('a failed lookup says so rather than showing "not a client"', () => {
  // Those are different facts. "We could not check" sends you to ask; "not on
  // file" sends you to create a duplicate.
  const fn = extractFunction(POPUP, 'function lookupCaller(rawFrom) {');
  assert.match(fn, /status: 'failed'/);
  const strip = extractFunction(POPUP, 'function callerStripHtml() {');
  assert.match(strip, /Could not check who this is/);
  assert.match(strip, /Not a client we have on file/);
  assert.ok(strip.indexOf('Could not check') !== strip.indexOf('Not a client'));
});

test('a late answer cannot label the wrong call', () => {
  // A second call can start ringing while the first lookup is in flight.
  const fn = extractFunction(POPUP, 'function lookupCaller(rawFrom) {');
  assert.match(fn, /state\.caller\.e164 !== from\) return;/);
  assert.strictEqual((fn.match(/state\.caller\.e164 !== from\) return;/g) || []).length, 2,
    'both the success and the failure path must check');
});

test('the raw number stays visible under the resolved name', () => {
  // The name is a lookup. Lookups are wrong sometimes, and the number is the
  // fact.
  const i = HTML.length; // markup is in the popup, not index.html
  assert.ok(i > 0);
  const fn = extractFunction(POPUP, 'function renderRinging() {');
  assert.match(fn, /callerLabel\(state\.ringingCallLabel/);
  assert.match(fn, /escapeHtml\(state\.caller\.e164\)/);
});

test('the caller is cleared when the line goes free', () => {
  // Otherwise the next call inherits the last one's identity, and the office
  // starts a lead for the wrong person.
  assert.ok(POPUP.includes('function resetCaller()'));
  const disconnect = POPUP.slice(POPUP.indexOf("call.on('disconnect'"), POPUP.indexOf("call.on('cancel'"));
  assert.match(disconnect, /resetCaller\(\)/);
  const decline = extractFunction(POPUP, 'function declineRinging() {');
  assert.match(decline, /resetCaller\(\)/);
});

test('the button is hidden where it cannot work', () => {
  // The popup loads on pages that do not contain the New Lead form.
  const fn = extractFunction(POPUP, 'function newLeadButtonHtml(label) {');
  assert.match(fn, /typeof window\.hlNewLeadFromCall !== 'function'\) return ''/);
});

// ---- the prefill ------------------------------------------------------------

test('the entry point is exported, or the button never appears', () => {
  // app-phone-popup.js is its own IIFE and cannot see anything declared in
  // index.html. This trap has shipped four broken features already.
  assert.match(HTML, /window\.hlNewLeadFromCall = hlNewLeadFromCall;/);
});

test('the phone is filled in whether or not a client matched', () => {
  const fn = extractFunction(HTML, 'function hlNewLeadFromCall(payload) {');
  assert.match(fn, /nl-phone/);
  assert.ok(fn.indexOf("getElementById('nl-phone')") < fn.indexOf('matches.length === 1'),
    'the number is set before any branch on whether we know them');
});

test('the number is shown the way a person reads it back', () => {
  const fn = extractFunction(HTML, 'function hlPrettyPhone(raw) {');
  assert.match(fn, /d\.length === 11 && d\.charAt\(0\) === '1'/);
  assert.match(fn, /\(' \+ d\.slice\(0, 3\)/);
});

test('one match fills the form from the client\'s own record', () => {
  const fn = extractFunction(HTML, 'function hlApplyCallerMatch(m) {');
  for (const id of ['nl-clientid', 'nl-first', 'nl-last', 'nl-email', 'nl-addr']) {
    assert.ok(fn.includes(id), id + ' should be filled from the match');
  }
  // Linked, so the lead attaches to the existing client instead of making a
  // second copy of them.
  assert.match(fn, /getElementById\('nl-clientid'\)\.value = m\.clientId/);
});

test('an address already typed is never overwritten', () => {
  const fn = extractFunction(HTML, 'function hlApplyCallerMatch(m) {');
  assert.match(fn, /!addrEl\.value\.trim\(\)/);
});

test('money owed and an archived record are surfaced, not buried', () => {
  // Both are things to know before the conversation gets going.
  const fn = extractFunction(HTML, 'function hlApplyCallerMatch(m) {');
  assert.match(fn, /m\.isArchived/);
  assert.match(fn, /m\.balance > 0/);
  assert.match(fn, /owed/);
});

test('several clients on one number means asking, never guessing', () => {
  const fn = extractFunction(HTML, 'function hlNewLeadFromCall(payload) {');
  assert.match(fn, /matches\.length > 1/);
  assert.match(fn, /hlAskWhichCaller\(matches\)/);
  const ask = extractFunction(HTML, 'function hlAskWhichCaller(matches) {');
  assert.match(ask, /nlAskSheet/);
  // A number on file does not prove the person holding it is on file.
  assert.match(ask, /None of these/);
});

test('the prefill does not make the form look like unsaved work', () => {
  // A form that asks to be saved the instant it opens trains him to dismiss
  // the question that exists to protect his typing.
  const fn = extractFunction(HTML, 'function hlFormWatchLead() {');
  assert.match(fn, /hlFormWatch\('nlv'\)/);
  for (const decl of ['function hlApplyCallerMatch(m) {', 'function hlNewLeadFromCall(payload) {']) {
    assert.match(extractFunction(HTML, decl), /hlFormWatchLead\(\)/, decl + ' must re-photograph the form');
  }
});

test('"how did they find us" is left alone', () => {
  // A phone call is how they reached us, not how they found us. Filling that
  // box from the fact of a call turns every referral in the report into a
  // phone call.
  const fn = extractFunction(HTML, 'function hlNewLeadFromCall(payload) {');
  assert.ok(!fn.includes("getElementById('nl-source')"));
});

// ---- two bugs this shipped on top of ---------------------------------------

test('opening a new lead no longer shows a destination as already picked', () => {
  // The destinations became buttons in #567, but nlResetForm still re-added the
  // selected border to the first one every time the form opened -- so it read
  // as a choice already made, on a form whose whole point is that pressing one
  // IS the choice.
  const fn = extractFunction(HTML, 'function nlResetForm() {');
  assert.match(fn, /#nl-nextsteps \.step-o'\)\.forEach\(function \(x\) \{ x\.classList\.remove\('sel'\); \}\)/);
  assert.ok(!/step-o'\)\.forEach\(function \(x, i\)/.test(fn), 'no index-based re-selection');
});

test('approximate cost does not survive into the next lead', () => {
  // It was missing from the reset list, so a number typed for one lead sat in
  // the box on the next one and would save as that lead's value.
  const fn = extractFunction(HTML, 'function nlResetForm() {');
  assert.match(fn, /'nl-need', 'nl-approx'\]/);
});

test('the form stops claiming phone is not synced, because it is', () => {
  // clients.phone_e164 is filled for 7,434 of 8,690, and /api/clients has been
  // returning it as `phone` all along. The note told the user to ask the client
  // for something HiveLogic already had, for six clients in seven -- the same
  // mistake the address half of this note used to make.
  assert.ok(!HTML.includes('Phone isn&#8217;t part of the Jobber sync'));
  assert.ok(!HTML.includes('phone isn&#8217;t part of the Jobber sync'));
  const pick = extractFunction(HTML, 'function nlClientPick(id) {');
  assert.match(pick, /if \(phoneEl && !phoneEl\.value\.trim\(\) && c\.phone\) phoneEl\.value = hlPrettyPhone\(c\.phone\)/);
  const note = extractFunction(HTML, 'function nlPhoneNote(c) {');
  assert.match(note, /No phone on their record/);
  assert.match(note, /Phone filled in from their record/);
});
