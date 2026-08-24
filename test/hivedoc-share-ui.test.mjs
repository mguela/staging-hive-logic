import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { validateShare } from '../api/hivedoc.js';

// The staff-side switch for who can see a file. Until this shipped, the
// visibility flags could only be set by hand in SQL -- so the model built in
// #504/#508 protected something nobody could actually use.
//
// The server validator is imported and run directly. The UI half is extracted
// from the real page and run against a stubbed DOM, so these fail on behaviour
// rather than on wording.

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function extractFunction(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start > -1, `${signature} must exist`);
  let depth = 0, i = src.indexOf('{', start);
  do {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  } while (depth > 0 && i < src.length);
  return src.slice(start, i);
}

// ---------- the server rules ----------
//
// The database enforces two of these as CHECK constraints as well, but a
// constraint violation surfaces as an opaque 400. These exist so the person
// clicking the switch is told what is actually wrong.

const doc = (over = {}) => ({ id: 'd1', filename: 'permit.pdf', client_id: 'C1', job_id: 'JOB1', sensitive: false, ...over });
const share = (over = {}) => ({ client_visible: false, sub_visible: false, ...over });

test('sharing with a client needs a client on the file', () => {
  const msg = validateShare(doc({ client_id: null }), share({ client_visible: true }));
  assert.match(msg, /not attached to a client/i);
  assert.match(msg, /File it under a client first/i, 'and says what to do about it');
});

test('sharing with subs needs a job on the file', () => {
  const msg = validateShare(doc({ job_id: null }), share({ sub_visible: true }));
  assert.match(msg, /not attached to a job/i);
});

test('a sensitive file cannot be shared outside the company at all', () => {
  // canSee() refuses to send a sensitive document outside whatever the flags
  // say, so allowing the flag to be set would create a switch that appears on
  // and silently does nothing -- worse than one that refuses.
  assert.match(validateShare(doc({ sensitive: true }), share({ client_visible: true })), /marked sensitive/i);
  assert.match(validateShare(doc({ sensitive: true }), share({ sub_visible: true })), /marked sensitive/i);
});

test('a sensitive file can still be set back to internal', () => {
  assert.equal(validateShare(doc({ sensitive: true }), share()), null, 'turning sharing OFF is never blocked');
});

test('a valid share passes, and so does unsharing', () => {
  assert.equal(validateShare(doc(), share({ client_visible: true })), null);
  assert.equal(validateShare(doc(), share({ client_visible: true, sub_visible: true })), null);
  assert.equal(validateShare(doc(), share()), null);
});

test('a document that no longer exists is reported as missing, not as a rule failure', () => {
  assert.match(validateShare(null, share({ client_visible: true })), /no longer exists/i);
});

test('only a real boolean true turns sharing on', () => {
  // handleShare coerces with === true, so a truthy string from a hand-rolled
  // request cannot switch sharing on by accident.
  const src = readFileSync(new URL('../api/hivedoc.js', import.meta.url), 'utf8');
  assert.match(src, /client_visible: body\.client_visible === true/);
  assert.match(src, /sub_visible: body\.sub_visible === true/);
});

test('the share route is role-gated, not merely signed-in', () => {
  const src = readFileSync(new URL('../api/hivedoc.js', import.meta.url), 'utf8');
  assert.match(src, /hasAllowedRole\(profile, HIVEDOC_SHARE_ROLES\)/, 'a role check, not just requireUser');
  assert.match(src, /Could not confirm your role/, 'and an unreadable profile is refused rather than allowed');
});

test('every share change is written to the audit trail', () => {
  const src = readFileSync(new URL('../api/hivedoc.js', import.meta.url), 'utf8');
  assert.match(src, /client_audit_log/);
  assert.match(src, /document_shared/);
  assert.match(src, /document_unshared/, 'unsharing is logged too -- it is equally worth knowing about');
});

// ---------- the UI ----------

const UI = [
  extractFunction(html, 'function hlDocShareLabel(d){'),
  extractFunction(html, 'function hlDocShareChip(d){'),
].join('\n');

function run(src, extra = {}) {
  const ctx = {
    hlEsc: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    ...extra,
  };
  vm.createContext(ctx);
  vm.runInContext(UI + '\n' + src, ctx);
  return ctx.__out;
}

const label = (d) => run(`__out = hlDocShareLabel(${JSON.stringify(d)})`);
const chip = (d) => run(`__out = hlDocShareChip(${JSON.stringify(d)})`);

test('the chip states "Internal" in words rather than showing nothing', () => {
  // The point of the chip is that somebody can tell at a glance which files
  // have left the building. An absence communicates nothing.
  assert.equal(label({}).text, 'Internal');
  assert.match(chip({ id: 'd1' }), /Internal/);
});

test('the chip names exactly who can see a shared file', () => {
  assert.equal(label({ client_visible: true }).text, 'Client');
  assert.equal(label({ sub_visible: true }).text, 'Subs');
  assert.equal(label({ client_visible: true, sub_visible: true }).text, 'Client + Subs');
});

test('a shared file is visually distinct from an internal one', () => {
  const internal = label({});
  const shared = label({ client_visible: true });
  assert.notEqual(internal.tone, shared.tone, 'the two states must not look the same');
  assert.match(chip({ id: 'd1', client_visible: true }), /●/, 'a shared file carries a marker');
  assert.doesNotMatch(chip({ id: 'd1' }), /●/);
});

test('a document id is escaped into the chip rather than interpolated raw', () => {
  const out = chip({ id: 'x" onclick="alert(1)' });
  assert.doesNotMatch(out, /onclick="alert/, 'a crafted id must not become an attribute');
  assert.match(out, /&quot;/);
});

// ---------- wiring ----------

test('the row renderer actually shows the chip', () => {
  const row = extractFunction(html, 'async function hlDocRenderCurrentPage(){');
  assert.match(row, /hlDocShareChip\(d\)/, 'the chip must be rendered per row');
});

test('the chip sits outside the anchor, so clicking it does not open the file', () => {
  const row = extractFunction(html, 'async function hlDocRenderCurrentPage(){');
  const chipAt = row.indexOf('hlDocShareChip(d)');
  const closeAnchor = row.indexOf("'</a>'");
  assert.ok(closeAnchor > -1 && chipAt > closeAnchor, 'the chip must come after the link closes');
});

test('the switch is disabled, with a reason, when it could not do anything', () => {
  const open = extractFunction(html, 'function hlDocShareOpen(id){');
  assert.match(open, /Not filed under a client yet/, 'a file with no client says so');
  assert.match(open, /Not filed under a job yet/, 'a file with no job says so');
  assert.match(open, /marked sensitive/, 'and a sensitive file explains why it is locked');
  assert.match(open, /disabled/, 'rather than letting the save fail');
});

test('the UI posts to the hivedoc endpoint, not straight to Supabase', () => {
  // The rest of the Documents tab writes to Supabase from the browser. This one
  // action must not, because it is the only one that can send a file outside
  // the company and it needs the server-side role check.
  const save = extractFunction(html, 'async function hlDocShareSave(payload){');
  assert.match(save, /\/api\/hivedoc\?resource=share/);
  assert.match(save, /Authorization/, 'carrying the bearer token');
  const open = extractFunction(html, 'function hlDocShareOpen(id){');
  assert.doesNotMatch(open, /sb\.from\('documents'\)/, 'no direct table write for this action');
});

test('the click handler is delegated, so it survives a re-render', () => {
  // The list re-renders on every page change and search keystroke; per-row
  // handlers would need rebinding each time.
  assert.match(html, /closest\('\.hldoc-share-chip'\)/);
});
