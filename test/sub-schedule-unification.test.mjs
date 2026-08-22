// One entry, two doors.
//
// A sub used to have a schedule in the portal (sub_schedule_items) and a
// separate existence on the dispatch board, with nothing tying them together --
// the schedule plan's third hard truth. These assert the seam is closed, and
// closed safely.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../api/subportal.js', import.meta.url), 'utf8');
const mig = fs.readFileSync(
  new URL('../supabase/migrations/20260818040000_hl_appointment_sub_link.sql', import.meta.url), 'utf8');

function block(name) {
  const i = src.indexOf(`action === '${name}'`);
  assert.ok(i > 0, `${name} handler must exist`);
  return src.slice(i, i + 2600);
}

test('the portal schedule reads native appointments too', () => {
  const b = block('schedule');
  assert.match(b, /hl_appointments\?sub_id=eq\./);
  assert.match(b, /sub_schedule_items\?sub_id=eq\./, 'the existing source is still read, not replaced');
});

test('a sub only ever sees their own appointments', () => {
  const b = block('schedule');
  assert.match(b, /hl_appointments\?sub_id=eq\.\$\{sub\.id\}/);
  assert.match(b, /canceled=eq\.false/, 'a cancelled visit is not on anyone schedule');
});

test('the portal is not handed columns it has no business with', () => {
  // An explicit select, not select=*: the appointment row carries crew ids and
  // internal linkage that a subcontractor has no reason to receive.
  const b = block('schedule');
  assert.match(b, /select=id,title,client,start_at,end_at,confirm_state,job_no,details/);
  assert.equal(/hl_appointments[^\n]*select=\*/.test(b), false);
});

test('appointment states map onto the vocabulary the portal already speaks', () => {
  const b = block('schedule');
  assert.match(b, /confirmed'.*approved/s);
  assert.match(b, /declined'.*change_requested/s);
});

test('each item says which source it came from', () => {
  // The respond path needs to know which table to write; a list that hides this
  // forces the client to guess.
  const b = block('schedule');
  assert.match(b, /source: 'appointment'/);
  assert.match(b, /source: 'sub_schedule_item'/);
});

test('responding to an appointment writes the same column the customer link does', () => {
  const b = block('schedule_respond');
  assert.match(b, /confirm_state/);
  assert.match(b, /hl_appointments\?id=eq\.\$\{id\}&sub_id=eq\.\$\{sub\.id\}/,
    'scoped by sub_id as well as id, so a sub cannot answer for work that is not theirs');
});

test('the legacy respond path still works', () => {
  const b = block('schedule_respond');
  assert.match(b, /sub_schedule_items\?id=eq\.\$\{id\}&sub_id=eq\.\$\{sub\.id\}/);
});

test('the migration is additive and does not retire the old table yet', () => {
  assert.match(mig, /add column if not exists sub_id/);
  assert.equal(/drop table/i.test(mig), false);
  assert.equal(/delete from/i.test(mig), false);
  assert.match(mig, /NOT dropped here/);
});
