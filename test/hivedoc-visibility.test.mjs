import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIENCES, normalizeViewer, canSee, filterVisible, redactForAudience,
  normalizeDocumentRow, normalizeMediaRow,
} from '../api/_lib/hivedoc-search.js';

// Who is allowed to see a file. Before 2026-08-21 neither document system had
// the internal / client-visible / subcontractor-visible model the brief
// described -- only `sensitive`, a staff-side admin-only flag that answers a
// different question. Both axes exist now and both are enforced in one place.
//
// Every test here is written from the leak direction: the failure that matters
// is a file reaching somebody who should not have it, so the assertions are
// mostly about what is NOT returned.

const doc = (over = {}) => normalizeDocumentRow({
  id: 'd1', filename: 'permit.pdf', storage_path: 'x/permit.pdf', doc_type: 'permit',
  client_id: 'C1', client_name: 'John Smith', job_id: 'JOB1', job_title: 'Bathroom Remodel',
  uploaded_at: '2026-07-14T09:00:00Z', ...over,
});

const photo = (over = {}) => normalizeMediaRow({
  id: 'm1', job_id: 'JOB1', storage_path: 'JOB1/companycam-1.jpg',
  captured_at: '2026-07-20T12:00:00Z', ...over,
}, { JOB1: { client_id: 'C1', client_name: 'John Smith', job_title: 'Bathroom Remodel' } });

const staff = (role) => ({ audience: 'staff', role });
const client = (clientId) => ({ audience: 'client', clientId });
const sub = (...jobIds) => ({ audience: 'subcontractor', jobIds });

// ---------- the viewer ----------

test('an unrecognised audience sees nothing, rather than defaulting to staff', () => {
  // The failure mode that matters: a typo or a missing field must close the
  // door, not open it.
  assert.equal(canSee(doc(), { audience: 'admin' }), false);
  assert.equal(canSee(doc(), {}), false);
  assert.equal(canSee(doc(), null), false);
  assert.equal(normalizeViewer({ audience: 'nonsense' }).audience, null);
});

test('the three audiences are the only ones there are', () => {
  assert.deepEqual(AUDIENCES, ['staff', 'client', 'subcontractor']);
});

// ---------- staff ----------

test('staff see ordinary files, including photos', () => {
  assert.ok(canSee(doc(), staff('crew')));
  assert.ok(canSee(photo(), staff('crew')));
});

test('crew cannot open a sensitive document; admins can', () => {
  const payroll = doc({ doc_type: 'payroll', sensitive: true });
  assert.equal(canSee(payroll, staff('crew')), false);
  assert.ok(canSee(payroll, staff('admin')));
  assert.ok(canSee(payroll, staff('superadmin')));
});

test('a staff member whose role could not be read is treated as least privileged', () => {
  // resolveStaffViewer() passes role: null when the profile lookup fails. A
  // failed lookup must not widen what somebody can see.
  assert.equal(canSee(doc({ sensitive: true }), staff(null)), false);
  assert.ok(canSee(doc(), staff(null)), 'but ordinary files are still visible');
});

// ---------- clients ----------

test('a client sees nothing by default -- sharing has to be deliberate', () => {
  assert.equal(canSee(doc(), client('C1')), false, 'internal is the default and it holds');
});

test('a client sees a file shared with them, on their own record', () => {
  assert.ok(canSee(doc({ client_visible: true }), client('C1')));
});

test('a client CANNOT see another client\'s shared file', () => {
  // Without the id match, one portal would show every client-visible file in
  // the business. This is the single most damaging bug this model can have.
  assert.equal(canSee(doc({ client_visible: true }), client('C2')), false);
});

test('a client with no id resolves to nobody, not to everybody', () => {
  assert.equal(canSee(doc({ client_visible: true }), client(null)), false);
  assert.equal(canSee(doc({ client_visible: true, client_id: null }), client('C1')), false);
});

test('a sensitive document never leaves the company, even if flagged client-visible', () => {
  // Two flags disagreeing is a mistake somebody made; it resolves closed.
  assert.equal(canSee(doc({ sensitive: true, client_visible: true }), client('C1')), false);
});

test('a sub-visible file is not thereby client-visible', () => {
  assert.equal(canSee(doc({ sub_visible: true }), client('C1')), false);
});

// ---------- subcontractors ----------

test('a sub sees a shared file on a job they are assigned to, and no other job', () => {
  const shared = doc({ sub_visible: true });
  assert.ok(canSee(shared, sub('JOB1')));
  assert.equal(canSee(shared, sub('JOB2')), false, 'a sub on a different job sees nothing');
  assert.equal(canSee(shared, sub()), false, 'a sub with no assignments sees nothing');
});

test('a client-visible file is not thereby visible to subs', () => {
  // The case a single ordered visibility level would get wrong: a client
  // contract must never reach a subcontractor.
  assert.equal(canSee(doc({ client_visible: true }), sub('JOB1')), false);
});

test('a file can be visible to both audiences at once', () => {
  const both = doc({ client_visible: true, sub_visible: true });
  assert.ok(canSee(both, client('C1')));
  assert.ok(canSee(both, sub('JOB1')));
});

// ---------- photos ----------

test('photos are internal always, whatever flags are set on them', () => {
  // media rows are projected with client_visible/sub_visible hard-false, and
  // canSee refuses non-document rows outside the company regardless. Belt and
  // braces on purpose: photo sharing has its own mechanism, and a second path
  // would mean two places to check before answering "can they see this".
  assert.equal(canSee(photo(), client('C1')), false);
  assert.equal(canSee(photo(), sub('JOB1')), false);
  assert.equal(photo().client_visible, false);
  assert.equal(photo().sub_visible, false);

  const tampered = { ...photo(), client_visible: true, sub_visible: true };
  assert.equal(canSee(tampered, client('C1')), false, 'even a row that claims otherwise');
  assert.equal(canSee(tampered, sub('JOB1')), false);
});

// ---------- filtering a result set ----------

test('filtering a mixed result set leaves each audience only what it may see', () => {
  const rows = [
    doc({ id: 'internal' }),
    doc({ id: 'shared-client', client_visible: true }),
    doc({ id: 'shared-sub', sub_visible: true }),
    doc({ id: 'payroll', sensitive: true }),
    photo({ id: 'pic' }),
  ];
  const ids = (viewer) => filterVisible(rows, viewer).map((r) => r.id).sort();

  assert.deepEqual(ids(staff('admin')), ['internal', 'payroll', 'pic', 'shared-client', 'shared-sub']);
  assert.deepEqual(ids(staff('crew')), ['internal', 'pic', 'shared-client', 'shared-sub'], 'crew lose only the payroll doc');
  assert.deepEqual(ids(client('C1')), ['shared-client']);
  assert.deepEqual(ids(sub('JOB1')), ['shared-sub']);
  assert.deepEqual(ids({ audience: 'bogus' }), []);
});

// ---------- redaction ----------

test('an outside audience is not told how the file is stored or who else can see it', () => {
  const out = redactForAudience(doc({ client_visible: true }), client('C1'));
  for (const leaky of ['storage_bucket', 'storage_path', 'sensitive', 'client_visible', 'sub_visible', 'source_system']) {
    assert.ok(!(leaky in out), `${leaky} must not be sent outside the company`);
  }
  assert.ok(out.title && out.category && out.open_url, 'but the useful fields survive');
});

test('staff keep the full row -- redaction is for outsiders', () => {
  const row = doc();
  assert.deepEqual(redactForAudience(row, staff('admin')), row);
});
