// test/team-todo-detections.test.mjs
// Team To-Do rewire (2026-08-16) -- Source B: auto-detected OPERATIONAL work.
//
// Three detections, all read-only, all computed and stored nowhere:
//   emails awaiting reply  -- unread inbox mail older than 4 BUSINESS hours
//   estimates to finalize  -- Jobber-mirrored quotes still in draft
//   vendor payments due    -- QuickBooks bills past due or due within 7 days
//
// The rule these tests exist to hold: when a source is unavailable the row is
// still rendered, muted, carrying the real reason. Never hidden, never stale
// numbers presented as fresh, never a fabricated one. The QBO read path is in
// a known 401 blackout as of this date, so the 401 case is a first-class test,
// not an edge case.
//
// Also covers the separation rule (every detection is category:'execution', so
// nothing that belongs to Today's Decisions can leak in) and the admin gate on
// the reina_todo read that now backs the Dev To-Do view.
//
// Run with: node --experimental-test-module-mocks --test test/team-todo-detections.test.mjs

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.CRON_SECRET = 'test-cron-secret';

// ---- module mocks -----------------------------------------------------------
let qboResult = { bills: [], total_balance: 0 };
let qboCalls = [];
mock.module('../api/qbo/index.js', {
  namedExports: {
    getFinancials: async (kind, opts) => { qboCalls.push({ kind, opts }); return typeof qboResult === 'function' ? qboResult(kind, opts) : qboResult; },
    getFinancialsDurable: async () => ({ data: {}, cachedAt: null, stale: false, refresh: null }),
    qboConnected: async () => true,
  },
});

let quotesRows = [];
let quotesOk = true;
let reinaTodoRow = { id: 'current', sections: [{ title: 'Engineering', items: [] }], generated_at: '2026-08-16T10:00:00Z' };
let profileRole = 'admin';
let permissionRoles = [];

// The caller's OWN connected mailboxes (hc_ms_tokens), which is what the email
// detection reads as of 2026-08-17. It used to read `integrations` key =
// 'microsoft' -- a shared org mailbox nobody ever connected -- and therefore
// always answered "Microsoft 365 is not connected" while everyone's mail was
// connected the whole time.
const FRESH = '2099-01-01T00:00:00Z';
const SPENT = '2020-01-01T00:00:00Z';
let msMailboxRows = [];
let msMailboxesOk = true;
let msTokenPatches = [];
let msMailboxReads = [];
let triageRows = [];   // reina_mail_triage: Reina's own reading of the mail

mock.module('../api/_lib/secrets.js', {
  namedExports: { encryptSecret: (v) => v, decryptSecret: (v) => v },
});

mock.module('../api/_lib/jobber.js', {
  namedExports: {
    supabaseRequest: async (path, opts = {}) => {
      const p = String(path);
      const res = (data, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => data, text: async () => JSON.stringify(data) });
      if (p.startsWith('quotes')) return quotesOk ? res(quotesRows) : res({ message: 'quotes table unreachable' }, false);
      if (p.startsWith('profiles')) return res([{ id: 'user-1', email: 'chris@ghgrp.net', role: profileRole }]);
      if (p.startsWith('users')) return res([{ jobber_id: 'jobber-1' }]);
      if (p.startsWith('employee_roles')) return res([{ permission_roles: permissionRoles }]);
      if (p.startsWith('hc_ms_tokens')) {
        if ((opts.method || 'GET').toUpperCase() === 'PATCH') {
          msTokenPatches.push({ path: p, patch: JSON.parse(opts.body) });
          return res([]);
        }
        msMailboxReads.push(p);
        return msMailboxesOk ? res(msMailboxRows) : res({ message: 'hc_ms_tokens unreachable' }, false);
      }
      if (p.startsWith('reina_mail_triage')) return res(triageRows);
      if (p.startsWith('integrations')) return res([]);
      if (p.startsWith('reina_todo')) return res([reinaTodoRow]);
      return res([]);
    },
    jobberGraphQL: async () => ({}),
  },
});

const track1 = await import('../api/track1.js');

// ---- harness ----------------------------------------------------------------
function res() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
function jsonRes(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}

let graphResponse = { value: [] };
let graphStatus = 200;
let graphCalls = [];
let graphTokens = [];
// Per-access-token overrides, so a two-mailbox test can make ONE of them fail.
let graphByToken = {};
let msRefreshResponse = { access_token: 'refreshed-access', refresh_token: 'rotated-refresh', expires_in: 3600 };
let msRefreshStatus = 200;
let msRefreshCalls = [];
let authUser = { id: 'user-1', email: 'chris@ghgrp.net' };

async function withMockedFetch(fn) {
  const original = global.fetch;
  graphCalls = [];
  graphTokens = [];
  msRefreshCalls = [];
  msTokenPatches = [];
  msMailboxReads = [];
  qboCalls = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return authUser ? jsonRes(authUser) : jsonRes({ error: 'bad token' }, 401);
    if (u.includes('login.microsoftonline.com')) {
      msRefreshCalls.push(String(opts.body || ''));
      return jsonRes(msRefreshResponse, msRefreshStatus);
    }
    if (u.includes('graph.microsoft.com')) {
      const token = String((opts.headers && opts.headers.Authorization) || '').replace(/^Bearer\s+/, '');
      graphCalls.push(u);
      graphTokens.push(token);
      const per = graphByToken[token];
      if (per) return jsonRes(per.body, per.status || 200);
      return jsonRes(graphResponse, graphStatus);
    }
    return jsonRes({ error: 'unexpected fetch in test: ' + u }, 500);
  };
  try { return await fn(); } finally { global.fetch = original; }
}

async function callTrack1(resource, { authHeader = 'Bearer usertoken' } = {}) {
  const req = { method: 'GET', query: { resource }, headers: { authorization: authHeader }, body: {} };
  const r = res();
  await track1.default(req, r);
  return r;
}
const rowFor = (body, key) => body.detections.find((d) => d.key === key);

function resetWorld() {
  authUser = { id: 'user-1', email: 'chris@ghgrp.net' };
  profileRole = 'admin';
  permissionRoles = ['owner'];
  quotesOk = true;
  quotesRows = [];
  qboResult = { bills: [], total_balance: 0 };
  graphResponse = { value: [] };
  graphStatus = 200;
  graphByToken = {};
  msRefreshResponse = { access_token: 'refreshed-access', refresh_token: 'rotated-refresh', expires_in: 3600 };
  msRefreshStatus = 200;
  msMailboxesOk = true;
  triageRows = [];
  msMailboxRows = [{
    home_account_id: 'oid-1.tid-1', username: 'Chris@ghgrp.net', name: 'Chris Kendall',
    access_token: 'access-1', refresh_token: 'refresh-1', expires_at: FRESH,
  }];
}

// ---- the business-hours definition -----------------------------------------
test('4 business hours back from a Tuesday 2pm is that same Tuesday 10am', () => {
  const tue2pm = Date.parse('2026-08-18T18:00:00Z'); // 14:00 America/New_York (EDT)
  const cutoff = track1.teamTodoBusinessHoursAgo(tue2pm, 4);
  assert.equal(new Date(cutoff).toISOString(), '2026-08-18T14:00:00.000Z');
});

test('4 business hours back from a Monday 9am lands on the PREVIOUS FRIDAY afternoon, not the weekend', () => {
  const mon9am = Date.parse('2026-08-17T13:00:00Z'); // Mon 09:00 EDT
  const cutoff = track1.teamTodoBusinessHoursAgo(mon9am, 4);
  const d = new Date(cutoff);
  assert.equal(d.getUTCDay(), 5, 'must land on a Friday');
  // 1h of Monday (08:00-09:00) + 3h back from Friday 17:00 = Friday 14:00 EDT = 18:00Z
  assert.equal(d.toISOString(), '2026-08-14T18:00:00.000Z');
});

test('mail that arrived overnight is not yet "4 business hours old" when the office opens', () => {
  const mon815 = Date.parse('2026-08-17T12:15:00Z');        // Mon 08:15 EDT, office just opened
  const cutoff = track1.teamTodoBusinessHoursAgo(mon815, 4);
  const overnight = Date.parse('2026-08-17T04:00:00Z');      // Mon 00:00 EDT, nobody was working
  const fridayAfternoon = Date.parse('2026-08-14T17:00:00Z'); // Fri 13:00 EDT, a real working hour
  assert.ok(overnight > cutoff, 'overnight mail must NOT be counted as awaiting a reply at 08:15');
  assert.ok(fridayAfternoon <= cutoff, 'mail sitting since Friday lunchtime IS awaiting a reply');
});

// ---- auth -------------------------------------------------------------------
test('team_todo_detections with no session is 401', async () => {
  resetWorld();
  authUser = null;
  const r = await withMockedFetch(() => callTrack1('team_todo_detections', { authHeader: '' }));
  assert.equal(r.statusCode, 401);
  assert.equal(r.body.ok, false);
});

// ---- every detection renders ------------------------------------------------
test('all three detections render, each tagged category:execution (never an approval item)', async () => {
  resetWorld();
  quotesRows = [{ jobber_id: 'q1', total: 4200 }, { jobber_id: 'q2', total: 1800 }];
  qboResult = { bills: [{ num: '1', vendor: 'Ferguson', balance: 900, due: '2026-01-01' }], total_balance: 900 };
  graphResponse = { value: [{ id: 'm1', receivedDateTime: '2020-01-01T10:00:00Z' }] };
  const r = await withMockedFetch(() => callTrack1('team_todo_detections'));
  assert.equal(r.statusCode, 200);
  const keys = r.body.detections.map((d) => d.key).sort();
  assert.deepEqual(keys, ['emails_awaiting_reply', 'estimates_to_finalize', 'vendor_payments_due']);
  r.body.detections.forEach((d) => assert.equal(d.category, 'execution', `${d.key} must be execution-flavored -- approval items belong to Today's Decisions`));
  r.body.detections.forEach((d) => assert.ok(d.view, `${d.key} must deep-link somewhere`));
});

test('estimates to finalize counts DRAFT quotes and sums their value', async () => {
  resetWorld();
  quotesRows = [{ jobber_id: 'q1', total: 4200 }, { jobber_id: 'q2', total: 1800.5 }];
  const r = await withMockedFetch(() => callTrack1('team_todo_detections'));
  const row = rowFor(r.body, 'estimates_to_finalize');
  assert.equal(row.state, 'ok');
  assert.equal(row.count, 2);
  assert.equal(row.amount, 6000.5);
  assert.equal(row.view, 'estimates');
});

test('estimates detection degrades honestly when the quotes read fails -- muted row, real reason, no number', async () => {
  resetWorld();
  quotesOk = false;
  const r = await withMockedFetch(() => callTrack1('team_todo_detections'));
  const row = rowFor(r.body, 'estimates_to_finalize');
  assert.equal(row.state, 'unavailable');
  assert.equal(row.count, null, 'an unavailable source must never carry a count');
  assert.match(row.reason, /Estimates feed offline/);
});

test('vendor payments: past-due and due-within-7-days bills are counted and totalled', async () => {
  resetWorld();
  const today = new Date().toISOString().slice(0, 10);
  qboResult = {
    bills: [
      { num: '1', vendor: 'Ferguson', balance: 1200, due: '2026-01-05' },  // long past due
      { num: '2', vendor: 'SiteOne', balance: 800, due: '2099-01-01' },     // inside the window per the query
    ],
    total_balance: 2000,
  };
  const r = await withMockedFetch(() => callTrack1('team_todo_detections'));
  const row = rowFor(r.body, 'vendor_payments_due');
  assert.equal(row.state, 'ok');
  assert.equal(row.count, 2);
  assert.equal(row.amount, 2000);
  assert.equal(row.pastDueCount, 1, 'bills dated before today are past due');
  assert.equal(row.view, 'financial');
  assert.ok(today, 'today resolved');
  const call = qboCalls.find((c) => c.kind === 'bills_due_range');
  assert.ok(call, 'the real QBO bills resource must be the source');
  assert.ok(call.opts.end_date > call.opts.start_date);
});

test('past due reaches back 90 days, not a year -- and the row names its own window', async () => {
  resetWorld();
  qboResult = { bills: [{ num: '1', vendor: 'Ferguson', balance: 1200, due: '2026-08-01' }], total_balance: 1200 };
  const r = await withMockedFetch(() => callTrack1('team_todo_detections'));
  const row = rowFor(r.body, 'vendor_payments_due');
  assert.equal(row.pastDueLookbackDays, 90);
  assert.match(row.detail, /past due \(last 90 days\)/,
    'a count whose scope is invisible invites "why is that number so big?" -- 102 past-due bills over a year is what prompted this bound');

  const call = qboCalls.find((c) => c.kind === 'bills_due_range');
  const days = Math.round((Date.parse(new Date().toISOString().slice(0, 10)) - Date.parse(call.opts.start_date)) / 86400000);
  assert.ok(days >= 89 && days <= 91, `bills_due_range must start ~90 days back, got ${days}`);
});

test('vendor payments during the QBO 401 blackout renders "Financial feed offline" with the real status -- no fake data', async () => {
  resetWorld();
  qboResult = { error: 'QuickBooks read failed: unauthorized', qboStatus: 401, qboRaw: 'AuthenticationFailed' };
  const r = await withMockedFetch(() => callTrack1('team_todo_detections'));
  const row = rowFor(r.body, 'vendor_payments_due');
  assert.equal(row.state, 'unavailable');
  assert.equal(row.label, 'Financial feed offline');
  assert.match(row.reason, /401/, 'the real QuickBooks status must reach the user');
  assert.equal(row.count, null);
  assert.equal(row.amount, null);
});

test('vendor payments is not readable by a role without financial access, and no QBO call is made for them', async () => {
  resetWorld();
  profileRole = null;
  permissionRoles = ['field_tech'];
  qboResult = { bills: [{ num: '1', balance: 500, due: '2026-01-01' }] };
  const r = await withMockedFetch(() => callTrack1('team_todo_detections'));
  const row = rowFor(r.body, 'vendor_payments_due');
  assert.equal(row.state, 'unavailable');
  assert.match(row.reason, /does not have access to financial data/);
  assert.equal(qboCalls.length, 0, 'a role without financial access must not trigger a financial read at all');
});

test('emails awaiting reply counts only unread mail older than the business-hours cutoff', async () => {
  resetWorld();
  graphResponse = { value: [
    { id: 'old', receivedDateTime: '2020-01-01T10:00:00Z' },
    { id: 'older', receivedDateTime: '2019-01-01T10:00:00Z' },
    { id: 'just-now', receivedDateTime: new Date().toISOString() },
  ] };
  const r = await withMockedFetch(() => callTrack1('team_todo_detections'));
  const row = rowFor(r.body, 'emails_awaiting_reply');
  assert.equal(row.state, 'ok');
  assert.equal(row.count, 2, 'mail that just landed is not awaiting a reply yet');
  assert.ok(graphCalls[0].includes('isRead eq false'), 'only unread mail is considered');
  assert.ok(graphCalls[0].includes('mailFolders/inbox'), 'the existing inbox read path is reused');
  assert.equal(row.view, 'hiveconnect_email');
});

test('emails detection degrades honestly when Graph fails (mocked 401)', async () => {
  resetWorld();
  graphStatus = 401;
  graphResponse = { error: { message: 'Access token has expired' } };
  const r = await withMockedFetch(() => callTrack1('team_todo_detections'));
  const row = rowFor(r.body, 'emails_awaiting_reply');
  assert.equal(row.state, 'unavailable');
  assert.match(row.reason, /Email feed offline/);
  assert.equal(row.count, null);
});

test('emails detection degrades honestly when no mailbox is connected', async () => {
  resetWorld();
  msMailboxRows = [];
  const r = await withMockedFetch(() => callTrack1('team_todo_detections'));
  const row = rowFor(r.body, 'emails_awaiting_reply');
  assert.equal(row.state, 'unavailable');
  assert.match(row.reason, /No mailbox connected/);
  assert.equal(graphCalls.length, 0, 'no mailbox means nothing to ask Graph about');
});

// ---- the source itself (fixed 2026-08-17) -----------------------------------
// Chris: "fix the emails awaiting reply source". The row read `integrations`
// key='microsoft' -- a single shared org mailbox behind resource=mailconnect
// that was never connected -- so it permanently answered "Microsoft 365 is not
// connected" while three real mailboxes sat in hc_ms_tokens refreshing fine.
// These tests pin the row to the store HiveConnect Email actually uses, so the
// two can never disagree about whether you have mail connected.

test('the email row reads the CALLER\'S OWN mailboxes, never the shared org row', async () => {
  resetWorld();
  graphResponse = { value: [{ id: 'm1', receivedDateTime: '2020-01-01T10:00:00Z' }] };
  const r = await withMockedFetch(() => callTrack1('team_todo_detections'));
  assert.equal(rowFor(r.body, 'emails_awaiting_reply').state, 'ok');
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../api/track1.js', import.meta.url), 'utf-8'));
  const detection = src.slice(src.indexOf('async function ttDetectEmailsAwaitingReply'), src.indexOf('// 2. Estimates to finalize'));
  assert.ok(!/getValidMicrosoftAccessToken/.test(detection),
    'the shared-org-mailbox token path is the bug; this row must not use it');
  assert.ok(/hc_ms_tokens/.test(src.slice(src.indexOf('async function ttMailboxesForOwner'))),
    'mailboxes come from hc_ms_tokens, the same table /api/msmail writes');
});

test('the mailbox read is scoped to the signed-in user, not the whole table', async () => {
  resetWorld();
  await withMockedFetch(() => callTrack1('team_todo_detections'));
  const read = msMailboxReads[0];
  assert.ok(read, 'a mailbox read must happen');
  assert.ok(read.includes('owner_id=eq.user-1'),
    `the mailbox read must be filtered to the caller -- everyone's mailboxes live in this one table: ${read}`);
});

test('unread counts from two connected mailboxes are added up, and the row says so', async () => {
  resetWorld();
  msMailboxRows = [
    { home_account_id: 'a', username: 'Chris@ghgrp.net', access_token: 'access-a', refresh_token: 'r-a', expires_at: FRESH },
    { home_account_id: 'b', username: 'Chris@greenwichhandyman.net', access_token: 'access-b', refresh_token: 'r-b', expires_at: FRESH },
  ];
  graphByToken = {
    'access-a': { body: { value: [{ id: '1', receivedDateTime: '2020-01-01T10:00:00Z' }] } },
    'access-b': { body: { value: [
      { id: '2', receivedDateTime: '2020-01-01T10:00:00Z' },
      { id: '3', receivedDateTime: '2020-01-02T10:00:00Z' },
    ] } },
  };
  const r = await withMockedFetch(() => callTrack1('team_todo_detections'));
  const row = rowFor(r.body, 'emails_awaiting_reply');
  assert.equal(row.state, 'ok');
  assert.equal(row.count, 3, 'both mailboxes count toward "awaiting reply"');
  assert.equal(row.mailboxesRead, 2);
  assert.match(row.detail, /across 2 mailboxes/);
  assert.deepEqual(graphTokens.sort(), ['access-a', 'access-b'], 'each mailbox is read with its own token');
});

test('one dead mailbox does not hide the other -- the count is shown WITH its shortfall', async () => {
  resetWorld();
  msMailboxRows = [
    { home_account_id: 'a', username: 'a@ghgrp.net', access_token: 'access-a', refresh_token: 'r-a', expires_at: FRESH },
    { home_account_id: 'b', username: 'b@ghgrp.net', access_token: 'access-b', refresh_token: 'r-b', expires_at: FRESH },
  ];
  graphByToken = {
    'access-a': { body: { value: [{ id: '1', receivedDateTime: '2020-01-01T10:00:00Z' }] } },
    'access-b': { status: 500, body: { error: { message: 'mailbox unavailable' } } },
  };
  const r = await withMockedFetch(() => callTrack1('team_todo_detections'));
  const row = rowFor(r.body, 'emails_awaiting_reply');
  assert.equal(row.state, 'ok');
  assert.equal(row.count, 1);
  assert.equal(row.mailboxesRead, 1);
  assert.equal(row.mailboxesTotal, 2);
  assert.match(row.detail, /1 of 2 mailboxes read/,
    'a partial count must say it is partial -- a number whose scope is invisible reads as complete');
});

test('an expired stored token is refreshed, and the ROTATED refresh token is written back', async () => {
  resetWorld();
  msMailboxRows = [{
    home_account_id: 'oid-1.tid-1', username: 'Chris@ghgrp.net',
    access_token: 'stale-access', refresh_token: 'refresh-1', expires_at: SPENT,
  }];
  graphByToken = { 'refreshed-access': { body: { value: [{ id: '1', receivedDateTime: '2020-01-01T10:00:00Z' }] } } };
  const r = await withMockedFetch(() => callTrack1('team_todo_detections'));
  const row = rowFor(r.body, 'emails_awaiting_reply');
  assert.equal(row.state, 'ok');
  assert.equal(row.count, 1);
  assert.equal(msRefreshCalls.length, 1, 'a spent token must be refreshed, not used');
  assert.match(msRefreshCalls[0], /refresh_token=refresh-1/, 'the stored refresh token goes to Microsoft');
  assert.equal(graphTokens[0], 'refreshed-access', 'Graph is called with the NEW token');

  // Microsoft rotates refresh tokens: the old one dies the moment the refresh
  // succeeds. Not writing the new one back breaks the mailbox on its next use
  // -- which would look like "my email disconnected itself".
  assert.equal(msTokenPatches.length, 1, 'the refreshed tokens must be persisted');
  assert.equal(msTokenPatches[0].patch.refresh_token, 'rotated-refresh');
  assert.ok(msTokenPatches[0].patch.access_token, 'the new access token is stored too');
  assert.ok(msTokenPatches[0].path.includes('home_account_id=eq.oid-1.tid-1'), 'the write targets that one mailbox');
});

test('a fresh stored token is used as-is -- no needless refresh against Microsoft', async () => {
  resetWorld();
  graphResponse = { value: [] };
  await withMockedFetch(() => callTrack1('team_todo_detections'));
  assert.equal(msRefreshCalls.length, 0, 'refreshing a valid token burns the rotation for nothing');
  assert.equal(graphTokens[0], 'access-1');
});

test('a mailbox needing re-authentication says so, instead of "feed offline"', async () => {
  resetWorld();
  msMailboxRows = [{
    home_account_id: 'a', username: 'a@ghgrp.net',
    access_token: 'stale-access', refresh_token: 'dead-refresh', expires_at: SPENT,
  }];
  msRefreshStatus = 400;
  msRefreshResponse = { error: 'invalid_grant', error_description: 'refresh token expired' };
  const r = await withMockedFetch(() => callTrack1('team_todo_detections'));
  const row = rowFor(r.body, 'emails_awaiting_reply');
  assert.equal(row.state, 'unavailable');
  assert.match(row.reason, /reconnecting/,
    '"sign in again" and "Microsoft is down" are different problems for the reader');
  assert.equal(row.count, null);
});

test('a mailbox table read failure degrades honestly rather than reporting zero', async () => {
  resetWorld();
  msMailboxesOk = false;
  const r = await withMockedFetch(() => callTrack1('team_todo_detections'));
  const row = rowFor(r.body, 'emails_awaiting_reply');
  assert.equal(row.state, 'unavailable');
  assert.match(row.reason, /Email feed offline/);
  assert.equal(row.count, null, 'a source we could not read is never "0 emails waiting"');
});

test('a non-admin now sees THEIR OWN unread count -- the old admin gate belonged to the shared mailbox', async () => {
  resetWorld();
  profileRole = null;
  permissionRoles = [];
  graphResponse = { value: [{ id: 'm1', receivedDateTime: '2020-01-01T10:00:00Z' }] };
  const r = await withMockedFetch(() => callTrack1('team_todo_detections'));
  const row = rowFor(r.body, 'emails_awaiting_reply');
  assert.equal(row.state, 'ok', 'telling someone their own inbox is admin-only was the gate misfiring');
  assert.equal(row.count, 1);
});

test('one dead source never takes the others down', async () => {
  resetWorld();
  quotesOk = false;
  graphStatus = 500;
  qboResult = { bills: [{ num: '1', balance: 300, due: '2026-01-01' }], total_balance: 300 };
  const r = await withMockedFetch(() => callTrack1('team_todo_detections'));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.detections.length, 3);
  assert.equal(rowFor(r.body, 'vendor_payments_due').state, 'ok');
  assert.equal(rowFor(r.body, 'estimates_to_finalize').state, 'unavailable');
  assert.equal(rowFor(r.body, 'emails_awaiting_reply').state, 'unavailable');
});

// ---- Dev To-Do: reina_todo is now admin-only --------------------------------
test('reina_todo_get (the Dev To-Do backing read) is admin/owner-only', async () => {
  resetWorld();
  profileRole = null;
  permissionRoles = ['project_manager'];
  const r = await withMockedFetch(() => callTrack1('reina_todo_get'));
  assert.equal(r.statusCode, 403);
  assert.match(r.body.error, /admin-only/);
});

test('reina_todo_get still serves an admin -- the engineering list keeps a home', async () => {
  resetWorld();
  profileRole = 'admin';
  const r = await withMockedFetch(() => callTrack1('reina_todo_get'));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.todo.id, 'current');
});

test('reina_todo_get serves an owner by permission role too (Chris is not necessarily profiles.role=admin)', async () => {
  resetWorld();
  profileRole = null;
  permissionRoles = ['owner'];
  const r = await withMockedFetch(() => callTrack1('reina_todo_get'));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
});

// ---- Reina's picks outrank the clock ----------------------------------------
// Chris, 2026-08-17: "I want Reina to pick the priority emails and bring you a
// to-do notification to handle them." "Unread for four business hours" is a
// clock, not a judgement -- once Reina has actually read the mail, her reading
// is the better answer, and it is the one he asked to see.

test('once Reina has triaged, the row shows HER picks, not an unread clock', async () => {
  resetWorld();
  triageRows = [
    { label: 'needs_reply', corrected_label: null },
    { label: 'needs_reply', corrected_label: null },
    { label: 'needs_action', corrected_label: null },
    { label: 'needs_scheduling', corrected_label: null },
    { label: 'junk', corrected_label: null },
    { label: 'fyi', corrected_label: null },
  ];
  const r = await withMockedFetch(() => callTrack1('team_todo_detections'));
  const row = rowFor(r.body, 'emails_awaiting_reply');
  assert.equal(row.state, 'ok');
  assert.equal(row.count, 4, 'junk and fyi are by definition not priority');
  assert.equal(row.label, 'Emails Reina flagged');
  assert.match(row.detail, /2 to answer/);
  assert.match(row.detail, /1 to act on/);
  assert.match(row.detail, /1 to schedule/);
});

test("a label Chris corrected is counted as HIS, not as Reina's", async () => {
  resetWorld();
  triageRows = [
    { label: 'junk', corrected_label: 'needs_reply' },
    { label: 'needs_action', corrected_label: 'junk' },
  ];
  const r = await withMockedFetch(() => callTrack1('team_todo_detections'));
  const row = rowFor(r.body, 'emails_awaiting_reply');
  assert.equal(row.count, 1, 'one promoted to needs_reply, one demoted to junk');
  assert.equal(row.breakdown.needs_reply, 1);
});

test('with nothing triaged yet the row falls back to the clock rather than going blank', async () => {
  resetWorld();
  triageRows = [];
  graphResponse = { value: [{ id: 'm1', receivedDateTime: '2020-01-01T10:00:00Z' }] };
  const r = await withMockedFetch(() => callTrack1('team_todo_detections'));
  const row = rowFor(r.body, 'emails_awaiting_reply');
  assert.equal(row.state, 'ok');
  assert.equal(row.count, 1);
  assert.match(row.detail, /business hours/, 'the clock is the fallback, not a blank row');
});
