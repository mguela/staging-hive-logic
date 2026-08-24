import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (rel) => readFile(new URL(rel, import.meta.url), 'utf8');

const APP = '../public/schedule-board/app.js';
const CLIENTS = '../api/clients.js';
const TRACK1 = '../api/track1.js';
const HL = '../api/schedule/hl.js';
const MIGRATION = '../supabase/migrations/20260822152914_hl_appointments_client_ref.sql';

// ---------------------------------------------------------------------------
// The bug that started this: the job picker never had an Authorization header.
// ---------------------------------------------------------------------------

test('the job picker sends a real auth token, not an undefined helper', async () => {
  const app = await read(APP);

  // The regression: window.hlAuthHeaders was CALLED here and defined nowhere,
  // so /api/jobs got no Authorization header, answered 401, and the picker
  // rendered that 401 body as "No jobs found".
  assert.match(app, /function hlHeaders\(\)\s*\{[\s\S]*?window\.HL_BOARD_TOKEN/u,
    'hlHeaders must read the board token that hlPost already writes with');
  assert.match(app, /window\.hlAuthHeaders = hlHeaders/u,
    'the old call-site name must resolve to a real function');
  assert.match(app, /fetch\('\/api\/jobs\?limit=2000',\{headers:hlHeaders\(\)\}\)/u,
    'the jobs fetch must carry the auth header');
});

test('a failed jobs load never masquerades as an empty one', async () => {
  const app = await read(APP);
  // A non-2xx must throw into the catch rather than being parsed as data --
  // r.json() succeeds on a 401 body, which is exactly how the original bug
  // stayed invisible.
  assert.match(app, /if\(!r\.ok\) throw new Error\('HTTP '\+r\.status\)/u);
  assert.match(app, /Could not load jobs/u, 'a failure must say it failed');
  // And the two kinds of empty are told apart.
  assert.match(app, /This client has no jobs yet/u);
  assert.match(app, /No jobs found/u);
});

// ---------------------------------------------------------------------------
// Client picker
// ---------------------------------------------------------------------------

test('clients are searched on the server, never listed in full', async () => {
  const clients = await read(CLIENTS);
  assert.match(clients, /getClientsData\(\{ limit, offset, order, search \} = \{\}\)/u);
  assert.match(clients, /name\.ilike\.|company_name\.ilike\.|email\.ilike\./u,
    'search must match name, company and email');

  const app = await read(APP);
  assert.match(app, /\/api\/clients\?search='\+encodeURIComponent\(term\)/u,
    'the board must send the term to the server, not filter 8,600 rows itself');
  assert.match(app, /term\.length<2/u, 'a one-character search is not a search');
});

test('a client search cannot break out of the filter it sits in', async () => {
  const clients = await read(CLIENTS);
  // PostgREST's or=(...) is comma/paren delimited, so those characters are
  // stripped before the term is interpolated. * is the ilike wildcard.
  assert.match(clients, /replace\(\/\[,\(\)\\\*\]\/g, ' '\)/u);
  assert.match(clients, /encodeURIComponent\(pat\)/u);
});

test('archived clients are excluded in a way that survives a NULL', async () => {
  const clients = await read(CLIENTS);
  // not.eq.true would silently drop rows where is_archived IS NULL.
  assert.match(clients, /is_archived=not\.is\.true/u);
  assert.doesNotMatch(clients, /is_archived=not\.eq\.true/u);
});

test('the client list returns a phone, because the board shows one', async () => {
  const clients = await read(CLIENTS);
  assert.match(clients, /phone: c\.phone_e164 \|\| c\.phone \|\| null/u);
});

test('out-of-order search answers cannot overwrite a newer one', async () => {
  const app = await read(APP);
  assert.match(app, /if\(!cur \|\| cur\.value\.trim\(\)!==mine\) return/u,
    'a slow earlier request must not repaint results for a term already replaced');
  assert.match(app, /setTimeout\(\(\)=>\{[\s\S]*?\},220\)/u, 'the search must be debounced');
});

// ---------------------------------------------------------------------------
// New client
// ---------------------------------------------------------------------------

test('a new client can be given a phone, and it is normalised', async () => {
  const track1 = await read(TRACK1);
  assert.match(track1, /const phoneRaw = String\(b\.phone \|\| ''\)\.trim\(\)/u);
  assert.match(track1, /digits\.length === 10 \? \('\+1' \+ digits\)/u,
    'a 10-digit US number becomes +1XXXXXXXXXX, matching what the sync writes');
  assert.match(track1, /phone_e164: e164/u);
});

test('a failed address does not cost you the client', async () => {
  const track1 = await read(TRACK1);
  // The client insert is what matters; the location is a second, separate row.
  assert.match(track1, /let locationSaved = false/u);
  assert.match(track1, /catch \(e\) \{ locationSaved = false; \}/u,
    'an address failure must be caught, not thrown');
  assert.match(track1, /locationSaved/u);
});

test('a new client with no name at all is refused', async () => {
  const track1 = await read(TRACK1);
  assert.match(track1, /if \(!first && !last && !company\) return res\.status\(400\)/u);
});

// ---------------------------------------------------------------------------
// The link between an appointment and a client
// ---------------------------------------------------------------------------

test('client_ref is validated against the clients table, not trusted', async () => {
  const hl = await read(HL);
  assert.match(hl, /if \(a\.client_ref\) \{[\s\S]*?clients\?jobber_id=eq\./u);
  assert.match(hl, /That client no longer exists\./u,
    'a bad id must be a clear error, not a dangling reference');
  assert.match(hl, /client_ref: clientRef/u);
});

test('the display name survives even when the client record changes', async () => {
  const hl = await read(HL);
  // `client` (the label) is still written alongside client_ref. A card that
  // silently changes what it says is worse than a stale name.
  assert.match(hl, /client: a\.client \|\| null,\s*\n\s*client_ref: clientRef/u);

  const migration = await read(MIGRATION);
  assert.match(migration, /The display name stays in `client`/u);
});

test('the client_ref migration is additive and idempotent', async () => {
  const migration = await read(MIGRATION);
  assert.match(migration, /add column if not exists client_ref text/u);
  assert.match(migration, /create index if not exists hl_appointments_client_ref_idx/u);
  // No top-level DML, so scripts/check-migration-replay-safety.mjs passes it.
  assert.doesNotMatch(migration, /^\s*(insert|update|delete)\s/imu);
  assert.doesNotMatch(migration, /references public\.clients/iu,
    'a hard FK would fail an appointment whose client has not synced yet');
});

// ---------------------------------------------------------------------------
// The form itself
// ---------------------------------------------------------------------------

test('the form asks in the dispatcher\'s order', async () => {
  const app = await read(APP);
  const order = ['Type of visit', 'Client', 'Job', 'When', 'Who', 'Division / trade', 'Notes & details'];
  let at = app.indexOf('window.openCreate=');
  assert.ok(at > 0, 'openCreate must exist');
  for (const label of order) {
    const next = app.indexOf(label, at);
    assert.ok(next > at, `"${label}" must come after the step before it`);
    at = next;
  }
});

test('job and division are asked once, not twice', async () => {
  const app = await read(APP);
  // They are their own numbered steps now, so the per-kind extras must not
  // render a second copy of either.
  assert.match(app, /spec\.extra\.filter\(\(f\)=>f\.id!=='jobref'&&f\.id!=='div'\)/u);
});

test('picking a job fills in what the job record already knows', async () => {
  const app = await read(APP);
  assert.match(app, /window\._cJobGeo=\{ lat:j\.gpsLat\|\|null, lng:j\.gpsLng\|\|null, city:j\.city\|\|null \}/u,
    'coordinates come from the job, which the form used to send as null');
  assert.match(app, /if\(dv && j\.divisionCode/u, 'division comes from the job');
});

test('the crew sets the division only until a job overrides it', async () => {
  const app = await read(APP);
  assert.match(app, /if\(jobSel && jobSel\.value\) return;\s*\/\/ the job already decided/u);
});

test('the confirm note tells the truth about whether anything sends', async () => {
  const app = await read(APP);
  // The old copy promised sends unconditionally, which was false with the
  // master switch off -- and it is off.
  assert.match(app, /const live=!!\(window\.HL_MSG&&window\.HL_MSG\.enabled\)/u);
  assert.match(app, /Messaging is OFF/u);
  assert.match(app, /Nothing is sent to the client until you turn messaging on/u);
});

test('the client name is what gets saved when one is picked', async () => {
  const app = await read(APP);
  assert.match(app, /const client=\(chosen&&chosen\.name\)\|\|typed\|\|\('New '\+KINDS\[kind\]\.l\)/u,
    'a picked client wins over the free-text title');
  assert.match(app, /client_ref:\(chosen&&chosen\.id\)\|\|null/u);
});

test('what is known about the client rides along to the field', async () => {
  const app = await read(APP);
  assert.match(app, /if\(chosen\.phone\) details\.phone=chosen\.phone/u);
  assert.match(app, /if\(chosen\.address\) details\.address=chosen\.address/u);
});
