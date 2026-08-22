// test/company-hours-consumer.test.mjs
// Slice 4 — proving Company Setup's business hours are not an island.
//
// The voice webhook decides open-hours vs after-hours greeting from
// isOpenNow(activeSchedule()). voice_schedules has never had a row in
// production, so that has always returned "open". These tests pin the adapter
// that now feeds it from company_settings, and above all pin the FAIL-OPEN
// behaviour: no configuration, a missing table, or a malformed row must never
// silently close the phone line.
// Run: node --experimental-test-module-mocks --test test/company-hours-consumer.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

const { hoursToVoiceWindows, companyBusinessHours } = await import('../api/_lib/company-hours.js');

const WEEKDAY = { open: '07:30', close: '17:00', closed: false };
const CLOSED = { open: null, close: null, closed: true };
const FULL_WEEK = {
  days: { 0: CLOSED, 1: WEEKDAY, 2: WEEKDAY, 3: WEEKDAY, 4: WEEKDAY, 5: WEEKDAY, 6: CLOSED },
};

// ---------------------------------------------------------------------------
// hoursToVoiceWindows — shape conversion
// ---------------------------------------------------------------------------
test('converts a normal week into voice_schedules windows', () => {
  const w = hoursToVoiceWindows(FULL_WEEK);
  assert.deepEqual(w.mon, [['07:30', '17:00']]);
  assert.deepEqual(w.fri, [['07:30', '17:00']]);
  assert.deepEqual(w.sun, [], 'a closed day is an empty window list');
  assert.deepEqual(w.sat, []);
  assert.deepEqual(Object.keys(w).sort(), ['fri', 'mon', 'sat', 'sun', 'thu', 'tue', 'wed']);
});

test('accepts string-keyed days (JSON round-trips object keys as strings)', () => {
  const w = hoursToVoiceWindows({ days: { '1': WEEKDAY } });
  assert.deepEqual(w.mon, [['07:30', '17:00']]);
});

test('returns null for nothing usable, so the caller falls back to always-open', () => {
  assert.equal(hoursToVoiceWindows(null), null);
  assert.equal(hoursToVoiceWindows({}), null);
  assert.equal(hoursToVoiceWindows({ days: {} }), null);
  assert.equal(hoursToVoiceWindows({ days: { 1: { open: 'garbage', close: 'junk' } } }), null,
    'an entirely malformed week must fall back, not close the line');
});

test('a single malformed day is treated as closed but does not sink the week', () => {
  const w = hoursToVoiceWindows({ days: { 1: WEEKDAY, 2: { open: '25:99', close: '17:00' } } });
  assert.deepEqual(w.mon, [['07:30', '17:00']]);
  assert.deepEqual(w.tue, []);
});

test('an inverted window (close before open) is treated as closed', () => {
  const w = hoursToVoiceWindows({ days: { 1: WEEKDAY, 3: { open: '17:00', close: '07:30', closed: false } } });
  assert.deepEqual(w.wed, []);
  assert.deepEqual(w.mon, [['07:30', '17:00']]);
});

test('an all-closed week is honoured — that is a real answer, not a fallback', () => {
  const w = hoursToVoiceWindows({ days: { 0: CLOSED, 1: CLOSED, 2: CLOSED, 3: CLOSED, 4: CLOSED, 5: CLOSED, 6: CLOSED } });
  assert.notEqual(w, null, 'deliberately closing every day must not be mistaken for "unconfigured"');
  assert.deepEqual(w.mon, []);
});

// ---------------------------------------------------------------------------
// companyBusinessHours — the DB read, fully injected
// ---------------------------------------------------------------------------
function deps({ tenant = { company_id: 'gh-1', role: 'service' }, settingsRes, companyRes } = {}) {
  const calls = [];
  return {
    calls,
    resolveCompany: async () => tenant,
    supabaseRequest: async (path) => {
      calls.push(path);
      if (path.startsWith('company_settings')) {
        return settingsRes || { ok: true, json: async () => [{ value: FULL_WEEK }] };
      }
      if (path.startsWith('companies')) {
        return companyRes || { ok: true, json: async () => [{ timezone: 'America/New_York' }] };
      }
      return { ok: false, json: async () => ({}), text: async () => 'unhandled' };
    },
  };
}

test('reads the hours section and returns a voice-shaped schedule', async () => {
  const d = deps();
  const s = await companyBusinessHours(d);
  assert.equal(s._source, 'company_settings');
  assert.equal(s.timezone, 'America/New_York');
  assert.deepEqual(s.business_hours.mon, [['07:30', '17:00']]);
  assert.ok(d.calls.some((p) => p.includes('section=eq.hours')), 'must query only the hours section');
  assert.ok(d.calls.some((p) => p.includes('company_id=eq.gh-1')), 'must scope to the resolved company');
});

test('returns null when sql/086 is not applied yet (table missing)', async () => {
  const s = await companyBusinessHours(deps({
    settingsRes: { ok: false, status: 404, json: async () => ({ code: 'PGRST205' }), text: async () => 'PGRST205' },
  }));
  assert.equal(s, null, 'pre-migration must fail open, not close the phone line');
});

test('returns null when no hours row has been saved', async () => {
  const s = await companyBusinessHours(deps({ settingsRes: { ok: true, json: async () => [] } }));
  assert.equal(s, null);
});

test('returns null when no company resolves', async () => {
  const s = await companyBusinessHours(deps({ tenant: null }));
  assert.equal(s, null);
});

test('a thrown error fails open rather than propagating into the webhook', async () => {
  const s = await companyBusinessHours({
    resolveCompany: async () => { throw new Error('boom'); },
    supabaseRequest: async () => { throw new Error('boom'); },
  });
  assert.equal(s, null);
});

test('a failing timezone lookup still yields usable hours', async () => {
  const s = await companyBusinessHours(deps({ companyRes: { ok: false, json: async () => ({}) } }));
  assert.notEqual(s, null);
  assert.equal(s.timezone, null, 'isOpenNow falls back to America/New_York on its own');
  assert.deepEqual(s.business_hours.mon, [['07:30', '17:00']]);
});

// ---------------------------------------------------------------------------
// end-to-end shape: what companyBusinessHours returns must satisfy isOpenNow's
// contract, or the wiring is decorative.
// ---------------------------------------------------------------------------
test('the returned object matches what isOpenNow() reads', async () => {
  const s = await companyBusinessHours(deps());
  // Mirror of isOpenNow() in api/voice-webhook.js.
  const isOpenNow = (schedule, at) => {
    if (!schedule || !schedule.business_hours) return true;
    const day = at.toLocaleDateString('en-US', { weekday: 'short', timeZone: schedule.timezone || 'America/New_York' }).toLowerCase().slice(0, 3);
    const windows = schedule.business_hours[day];
    if (!windows || !windows.length) return false;
    const hhmm = at.toLocaleTimeString('en-US', { hour12: false, timeZone: schedule.timezone || 'America/New_York' }).slice(0, 5);
    return windows.some(([start, end]) => hhmm >= start && hhmm <= end);
  };

  // Monday 2026-08-17, 10:00 and 21:00 America/New_York (14:00 / 01:00+1 UTC).
  assert.equal(isOpenNow(s, new Date('2026-08-17T14:00:00Z')), true, 'Monday 10:00 must be open');
  assert.equal(isOpenNow(s, new Date('2026-08-18T01:00:00Z')), false, 'Monday 21:00 must be after-hours');
  // Sunday 2026-08-16, 12:00 ET.
  assert.equal(isOpenNow(s, new Date('2026-08-16T16:00:00Z')), false, 'Sunday must be closed');
});
