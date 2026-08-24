// api/health-cron.js — Daily HiveLogic health check (Chris 2026-07-28).
//
// Runs once a day via Vercel Cron (see vercel.json). Checks that the app's
// data + integrations + API functions are alive and that the key money numbers
// reconcile, then emails a report to Allan/Chris/Jovie AND posts it to Chirp.
//
// Reuses existing, already-configured infrastructure — no new accounts:
//   - Supabase service key (SUPABASE_SERVICE_KEY) for direct DB truth.
//   - Resend via ./_lib/email.js sendEmail() (from mail.ghgrp.net).
//   - Reina bot via ./hiveconnect-bridge.js postBotMessage() for Chirp.
//   - CRON_SECRET auth, same pattern as api/track1.js check_new_leads.
//
// Safety / honesty:
//   - Never throws the whole run; every check is independently try/caught.
//   - If email or Chirp isn't configured in this deployment, it skips that
//     channel and reports which channels actually fired (no silent failure).
//   - ?dryrun=1 builds and RETURNS the report without sending anything —
//     used to verify the checks before letting it email real people.
//   - Manual test: GET /api/health-cron?key=<CRON_SECRET>&dryrun=1

import { sendEmail, isEmailConfigured } from './_lib/email.js';
import { postBotMessage } from './hiveconnect-bridge.js';

const RECIPIENTS = ['Allan@ghgrp.net', 'chris@ghgrp.net', 'Jovie@ghgrp.net'];
import { checkCronSecret } from './_lib/guard.js';

import { selfOrigin, selfFetchInit } from './_lib/self-origin.js';
import { allSignals, evaluateSignals, summarize, postgrestLookup } from './_lib/health-signals.js';
import { PAGE_BUILD } from './_lib/page-build.js';
import { EXPECTED_AGENT_VERSION } from './_lib/agent-version.js';
import { findingsFromHealthChecks, observeFindings } from './_lib/status-hub.js';

// Resolved per call rather than pinned at import: on a preview deployment this
// must probe THAT deployment, not production. Production resolves to the same
// stable origin this constant used to hold. See api/_lib/self-origin.js.

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

function money(n) { return '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }); }

async function sbGet(pathAndQuery, { count = false } = {}) {
  const headers = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
  if (count) { headers.Prefer = 'count=exact'; headers.Range = '0-24'; }
  const res = await fetch(`${SB_URL}/rest/v1/${pathAndQuery}`, { headers });
  const rows = await res.json().catch(() => []);
  let total = Array.isArray(rows) ? rows.length : null;
  if (count) { const cr = res.headers.get('content-range'); if (cr && cr.includes('/')) total = parseInt(cr.split('/')[1], 10); }
  return { ok: res.ok, status: res.status, rows: Array.isArray(rows) ? rows : [], total };
}

// A check returns { name, status: 'ok'|'warn'|'fail', detail }
async function safe(name, fn) {
  try { const r = await fn(); return Object.assign({ name }, r); }
  catch (e) { return { name, status: 'fail', detail: 'check errored: ' + (e.message || String(e)).slice(0, 120) }; }
}

export async function runChecks() {
  const checks = [];

  // --- Database reachable ---
  checks.push(await safe('Database (Supabase)', async () => {
    if (!SB_URL || !SB_KEY) return { status: 'fail', detail: 'SUPABASE_URL / SERVICE_KEY not set in this deployment' };
    const r = await sbGet('jobs?select=jobber_id&limit=1');
    return r.ok ? { status: 'ok', detail: 'reachable' } : { status: 'fail', detail: 'HTTP ' + r.status };
  }));

  // --- Jobber sync freshness (core integration) ---
  // Uses jobs.synced_at = when OUR daily sync last wrote the row (NOT
  // jobber_updated_at, which reflects business activity in Jobber and would
  // false-alarm on a quiet day). Daily cadence: >36h warn, >48h fail.
  checks.push(await safe('Jobber sync freshness', async () => {
    const r = await sbGet('jobs?select=synced_at&order=synced_at.desc&limit=1');
    if (!r.ok || !r.rows.length || !r.rows[0].synced_at) return { status: 'warn', detail: 'could not read last sync time' };
    const latest = new Date(r.rows[0].synced_at);
    const hrs = (Date.now() - latest.getTime()) / 3600000;
    if (hrs > 48) return { status: 'fail', detail: `STALE — Jobber sync last ran ${Math.round(hrs)}h ago; daily sync appears to have stopped` };
    if (hrs > 36) return { status: 'warn', detail: `${Math.round(hrs)}h since last Jobber sync (expected daily)` };
    return { status: 'ok', detail: `fresh — synced ${Math.round(hrs)}h ago` };
  }));

  // --- Vehicle GPS freshness (2026-08-15, rewritten 2026-08-16) ---
  // Originally this alarmed on Jobber's own GPS feed being dead, on the theory
  // that losing it left FleetSharp as a single point of failure. Chris pushed
  // back and he was right: Jobber's Vehicle.liveState is a passthrough of
  // whatever telematics is wired into Jobber -- very likely the same FleetSharp
  // hardware -- so it was never an independent source. If a truck's tracker
  // dies, both go dark together. GPS is now deliberately FleetSharp-only and
  // the Jobber columns are no longer read for position at all, so warning about
  // them daily would be nagging about something nobody intends to fix. That is
  // the alert fatigue that makes a health report worthless.
  //
  // What IS actionable, and all this now checks:
  //   1. Can we place the fleet at all? With one source there is no second feed
  //      to mask an outage, so this is the only thing between a dead FleetSharp
  //      push and a map that silently freezes.
  //   2. Has an individual tracker gone dark? A named truck is chaseable in a
  //      way a whole-feed alarm is not.
  checks.push(await safe('Vehicle GPS freshness', async () => {
    const r = await sbGet('vehicles?select=name,fleetsharp_updated_at');
    if (!r.ok) return { status: 'warn', detail: 'could not read vehicles' };
    const rows = r.rows || [];
    if (!rows.length) return { status: 'warn', detail: 'no vehicles in the fleet table' };

    const PLACEABLE_H = 2;    // a parked truck reports on movement, so this is generous
    const DEVICE_DEAD_H = 24; // longer than any overnight gap: silence this long is a fault
    const now = Date.now();
    const ageH = (t) => (t ? (now - new Date(t).getTime()) / 3600000 : Infinity);

    const fleet = rows.map((v) => ({ name: v.name || 'unnamed', ageH: ageH(v.fleetsharp_updated_at) }));
    const placeable = fleet.filter((v) => v.ageH < PLACEABLE_H);
    const dead = fleet.filter((v) => v.ageH >= DEVICE_DEAD_H);
    const describe = (v) => `${v.name} (${v.ageH === Infinity ? 'never' : Math.round(v.ageH / 24) + 'd'})`;

    if (!placeable.length) {
      const newest = Math.min(...fleet.map((v) => v.ageH));
      return { status: 'fail',
        detail: `FLEET DARK — no vehicle has a FleetSharp position under ${PLACEABLE_H}h old`
          + (Number.isFinite(newest) ? ` (newest ${Math.round(newest)}h)` : ' (no vehicle has ever reported)') };
    }
    if (dead.length) {
      return { status: 'warn',
        detail: `${placeable.length}/${fleet.length} vehicles placed within ${PLACEABLE_H}h, but `
          + `${dead.length} tracker(s) silent over ${DEVICE_DEAD_H}h: ${dead.map(describe).join(', ')}` };
    }
    return { status: 'ok', detail: `${placeable.length}/${fleet.length} vehicles placed within ${PLACEABLE_H}h on FleetSharp` };
  }));

  // --- Core record counts ---
  checks.push(await safe('Clients', async () => {
    const r = await sbGet('clients?select=jobber_id', { count: true });
    return r.total > 0 ? { status: 'ok', detail: `${r.total} clients` } : { status: 'warn', detail: 'zero clients returned' };
  }));
  checks.push(await safe('Jobs', async () => {
    const r = await sbGet('jobs?select=jobber_id', { count: true });
    return r.total > 0 ? { status: 'ok', detail: `${r.total} jobs` } : { status: 'warn', detail: 'zero jobs returned' };
  }));

  // --- MONEY RECONCILIATION (the "$1.5M vs $74K" clarity) ---
  let pastDueSum = 0, pastDueCt = 0, openSum = 0, openCt = 0;
  checks.push(await safe('Accounts receivable', async () => {
    const pd = await sbGet('invoices?select=total,payments&invoice_status=eq.past_due', { count: true });
    pastDueCt = pd.total || pd.rows.length;
    pastDueSum = pd.rows.reduce((s, i) => s + (Number(i.total) - Number(i.payments || 0)), 0);
    const op = await sbGet('invoices?select=total,payments&invoice_status=neq.paid', { count: true });
    openCt = op.total || op.rows.length;
    openSum = op.rows.reduce((s, i) => s + (Number(i.total) - Number(i.payments || 0)), 0);
    // Not a failure — this is the daily truth statement so the two dashboard
    // numbers can be reconciled at a glance.
    return { status: 'ok', detail: `past-due ${money(pastDueSum)} (${pastDueCt}) · all-open ${money(openSum)} (${openCt})` };
  }));

  // --- Pipeline ---
  checks.push(await safe('Open quote pipeline', async () => {
    const q = await sbGet('quotes?select=total&quote_status=eq.awaiting_response', { count: true });
    const sum = q.rows.reduce((s, x) => s + Number(x.total || 0), 0);
    return { status: 'ok', detail: `${money(sum)} across ${q.total || q.rows.length} quote(s) awaiting reply` };
  }));

  // --- Today's schedule ---
  checks.push(await safe("Today's visits", async () => {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    const r = await sbGet(`visits?select=jobber_id&start_at=gte.${start.toISOString()}&start_at=lt.${end.toISOString()}`, { count: true });
    return { status: 'ok', detail: `${r.total || 0} visit(s) on the board` };
  }));

  // --- Silent-failure detection across everything that should be running ---
  // The checks above are a hand-written list: each exists because a person
  // thought of it. That is exactly why screen monitoring could die
  // company-wide for two weeks without this report noticing. The block below
  // is DERIVED -- every cron in vercel.json plus the registered live signals
  // -- so coverage cannot fall behind the app again. See
  // api/_lib/health-signals.js.
  //
  // Only genuine alarms get their own row; everything else is rolled into one
  // coverage line. A report that lists 30 healthy things every morning stops
  // being read, and an unread report is the same as no report.
  try {
    const results = await evaluateSignals({ signals: allSignals(), lookup: postgrestLookup(sbGet) });
    const s = summarize(results);
    for (const alarm of s.alarms) {
      checks.push({
        name: `Not running: ${alarm.label || alarm.key}`,
        status: 'fail',
        detail: alarm.detail,
      });
    }
    checks.push({
      name: 'Signal coverage',
      status: s.healthy ? 'ok' : 'warn',
      detail: `${s.total} watched · ${s.ok} current · ${s.stale} stale · ${s.never} never ran · ${s.uncovered} uncovered · ${s.offByDesign} off by design · ${s.unverifiable} with no evidence source`,
    });
  } catch (e) {
    // A broken checker must be loud. Silently checking nothing is the failure
    // mode this whole module exists to end.
    checks.push({ name: 'Signal coverage', status: 'fail', detail: 'the silent-failure checker itself failed: ' + (e && e.message ? e.message : e) });
  }

  // --- Agents that can never authenticate ---------------------------------
  // Belt-and-braces for the 2026-08 monitoring outage. A monitor_agents row
  // that is status='active' with agent_token_hash NULL can never match
  // requireMonitorAgent's lookup, so that agent is permanently dead -- and it
  // fails exactly like a wrong token: a 401, no log line, a tray reading
  // "Heartbeat error". Chris's agent sat like that for two weeks.
  //
  // A CHECK constraint now makes the state impossible
  // (20260816145500_monitor_agents_active_requires_token_hash.sql), so this
  // should always read zero. It stays because a constraint only protects a
  // database that HAS it -- a restored snapshot, a branch database, or a
  // future environment provisioned from an older baseline would not, and this
  // is the difference between finding out in a morning email and finding out
  // in two weeks.
  checks.push(await safe('Monitor agents able to authenticate', async () => {
    const r = await sbGet('monitor_agents?status=eq.active&agent_token_hash=is.null&select=id,device_name', { count: true });
    if (!r.ok) return { status: 'warn', detail: 'could not check agent credentials' };
    const broken = r.total || 0;
    if (broken === 0) return { status: 'ok', detail: 'every active agent has a usable credential' };
    return {
      status: 'fail',
      detail: `${broken} active agent(s) have no token hash and can NEVER authenticate -- they will look like a wrong token and fail silently. Re-pair them, or backfill as in migration 20260816143000.`,
    };
  }));

  // --- Browsers running code we already replaced ---------------------------
  // A tab can run last week's JavaScript against today's API for days. On
  // 2026-08-16 that made an hour of production testing worthless: an
  // idle-timeout fix was merged, deployed and "verified" while the browser
  // under test was still on the pre-merge page. The server was visibly new,
  // which says nothing about the tab.
  //
  // Only counts people seen in the last hour -- a stale build last reported
  // days ago is a closed tab, not someone working against old code now. NULL
  // (never reported) is not counted as stale: that is a client older than the
  // mechanism, and calling it stale would be a claim we cannot back up.
  // --- Desktop agents on the current build ---------------------------------
  // The agent updates on its own schedule from a hand-made release, so the
  // server can be enforcing a rule whose warning dialog has not reached anyone
  // yet -- exactly what happened with the 2026-08-17 consent change. Only
  // counts agents that have checked in recently; a stale version last seen in
  // July is a machine nobody is using, not an update that failed.
  checks.push(await safe('Monitor agents on the current build', async () => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const r = await sbGet(`monitor_agents?status=eq.active&last_seen_at=gte.${since}&select=device_name,agent_version`);
    if (!r.ok) return { status: 'warn', detail: 'could not check which agent build machines are running' };
    const rows = r.rows || [];
    if (!rows.length) return { status: 'warn', detail: 'no active agent has checked in for 24h -- nobody is being monitored' };
    const describe = (a) => `${a.device_name || 'unnamed'} (${a.agent_version || 'not reported'})`;
    const stale = rows.filter((a) => a.agent_version && a.agent_version !== EXPECTED_AGENT_VERSION);
    const unknown = rows.filter((a) => !a.agent_version);
    if (!stale.length && !unknown.length) {
      return { status: 'ok', detail: `${rows.length} agent(s) checked in, all on ${EXPECTED_AGENT_VERSION}` };
    }
    const parts = [];
    if (stale.length) parts.push(`${stale.length} on an older build: ${stale.map(describe).join(', ')}`);
    // Named as unknown, not folded in with stale -- an agent that predates
    // version reporting could be on anything, and guessing is the habit this
    // is meant to break.
    if (unknown.length) parts.push(`${unknown.length} not reporting a version at all (predates 1.2.4): ${unknown.map(describe).join(', ')}`);
    return {
      status: 'warn',
      detail: `${rows.length} agent(s) checked in; ${parts.join('; ')}. They will not have recent agent-side changes -- publish a release, or check the auto-updater on those machines.`,
    };
  }));

  checks.push(await safe('Browsers on the current build', async () => {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const r = await sbGet(`profiles?page_build_seen_at=gte.${since}&page_build=not.is.null&select=email,page_build`);
    if (!r.ok) return { status: 'warn', detail: 'could not check which build clients are running' };
    const rows = r.rows || [];
    if (!rows.length) return { status: 'warn', detail: 'no client reported its build in the last hour -- nobody signed in, or the reporting itself is broken' };
    const stale = rows.filter((p) => p.page_build !== PAGE_BUILD);
    if (!stale.length) return { status: 'ok', detail: `${rows.length} client(s) active in the last hour, all on ${PAGE_BUILD}` };
    const who = stale.map((p) => `${p.email || 'unknown'} (${p.page_build})`).join(', ');
    return {
      status: 'warn',
      detail: `${stale.length} of ${rows.length} active client(s) are running an older build than ${PAGE_BUILD}: ${who}. They will not have recent fixes, and testing against them proves nothing. A reload fixes it.`,
    };
  }));

  // --- API function liveness (a 5xx/timeout = broken function; 401 = alive) ---
  const endpoints = ['/api/track1?resource=dailybrief', '/api/jobs?status=active', '/api/qbo?resource=financials', '/api/fieldops?action=day'];
  for (const ep of endpoints) {
    checks.push(await safe('API ' + ep.split('?')[0].replace('/api/', ''), async () => {
      const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 12000);
      try {
        const res = await fetch(selfOrigin() + ep, selfFetchInit({ signal: ctrl.signal }));
        clearTimeout(to);
        if (res.status >= 500) return { status: 'fail', detail: `HTTP ${res.status} — function is erroring` };
        return { status: 'ok', detail: `responding (HTTP ${res.status})` };
      } catch (e) { clearTimeout(to); return { status: 'fail', detail: 'no response / timeout' }; }
    }));
  }

  return checks;
}

export function buildReport(checks) {
  const fails = checks.filter(c => c.status === 'fail');
  const warns = checks.filter(c => c.status === 'warn');
  const overall = fails.length ? 'FAIL' : (warns.length ? 'WARN' : 'OK');
  const icon = fails.length ? '❌' : (warns.length ? '⚠️' : '✅');
  const date = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' });
  const headline = fails.length ? `${fails.length} issue(s) need attention`
    : (warns.length ? `${warns.length} thing(s) worth a look` : 'All systems healthy');
  const subject = `[HiveLogic Health] ${icon} ${headline} — ${date}`;

  const line = c => `${c.status === 'ok' ? '✅' : c.status === 'warn' ? '⚠️' : '❌'} ${c.name}: ${c.detail}`;
  const text = [
    `HiveLogic daily health check — ${date} (America/New_York)`,
    `Overall: ${icon} ${overall}`,
    '',
    ...checks.map(line),
    '',
    'This runs automatically every morning after the Jobber sync. Reply to Reina in HiveLogic if anything looks off.',
  ].join('\n');

  const rowHtml = c => `<tr><td style="padding:6px 10px;font-size:16px">${c.status === 'ok' ? '✅' : c.status === 'warn' ? '⚠️' : '❌'}</td><td style="padding:6px 10px;font-weight:600">${c.name}</td><td style="padding:6px 10px;color:#444">${c.detail}</td></tr>`;
  const html = `<div style="font-family:system-ui,Segoe UI,sans-serif;max-width:640px">
    <h2 style="margin:0 0 4px">${icon} HiveLogic Health — ${overall}</h2>
    <div style="color:#666;margin-bottom:14px">${date} · America/New_York</div>
    <table style="border-collapse:collapse;width:100%;border:1px solid #eee">${checks.map(rowHtml).join('')}</table>
    <p style="color:#888;font-size:12px;margin-top:14px">Runs automatically every morning after the Jobber sync. Reply to Reina in HiveLogic if anything looks off.</p>
  </div>`;

  const chirp = `${icon} **Daily Health Check — ${overall}**\n${headline}.\n\n` + checks.map(line).join('\n');
  return { overall, subject, text, html, chirp };
}

export default async function handler(req, res) {
  const q = req.query || {};
  const dryrun = q.dryrun === '1' || q.dryrun === 'true';

  // Item 6 (2026-08-01): cron secret is accepted ONLY via the Authorization
  // header (Vercel Cron sends it automatically), never a ?key= query param
  // (which leaks into logs/history). Timing-safe compare; fails closed when
  // CRON_SECRET is unset. Does NOT change the daily audit-email delivery.
  if (!checkCronSecret((req.headers && req.headers.authorization) || '')) {
    return res.status(401).json({ ok: false, error: 'This endpoint runs on Vercel Cron only. Provide Authorization: Bearer <CRON_SECRET>.' });
  }

  const checks = await runChecks();
  const report = buildReport(checks);
  if (dryrun) {
    return res.status(200).json({ ok: true, dryrun: true, overall: report.overall, subject: report.subject, checks, preview: report.text, statusHub: { observed: 0, dryrun: true } });
  }

  // The daily email is useful, but the status hub is the team's durable place
  // to work from. Never let a reporting-store outage hide the health result:
  // surface that failure in the response and continue the normal report path.
  let statusHub = { observed: 0, error: null };
  try { statusHub.observed = (await observeFindings(findingsFromHealthChecks(checks))).length; }
  catch (e) { statusHub.error = String(e.message || e).slice(0, 300); }

  // ---- send email to the 3 recipients ----
  const delivery = { email: [], chirp: null };
  if (isEmailConfigured()) {
    for (const to of RECIPIENTS) {
      const r = await sendEmail({ to, subject: report.subject, html: report.html, text: report.text });
      delivery.email.push({ to, ok: r.ok, error: r.error || null });
    }
  } else {
    delivery.email.push({ ok: false, error: 'RESEND_API_KEY not set — email skipped (Chirp still posted).' });
  }

  // ---- post to Chirp as Reina bot ----
  // Post to the existing "Reina's Reports" channel by its fixed id. Hardcoded
  // (with an optional env override) so the report always lands in the same
  // channel — no by-name lookup that could spin up a duplicate channel, and no
  // dependence on an env var that might be unset in a deployment.
  //
  // The override MUST be its own var. REINA_BOT_DEFAULT_CHANNEL_ID is the
  // shared Reina-bot catch-all (#admin-hub) that voicemail alerts, change-order
  // scans, and track1 also post to; it is always set in prod, so reading it
  // here made the hardcoded id below unreachable and buried every daily report
  // in #admin-hub from 2026-08-06 to 2026-08-23.
  const REINA_REPORTS_CHANNEL_ID = '35be9f8f-f83d-4ba2-9748-4ac05ce859a3'; // #Reina's Reports (hiveconnect)
  const channelId = process.env.REINA_REPORTS_CHANNEL_ID || REINA_REPORTS_CHANNEL_ID;
  try {
    if (!channelId) throw new Error('No Reina Reports channel id resolved');
    await postBotMessage(channelId, report.chirp);
    delivery.chirp = { ok: true, channelId };
  } catch (e) {
    delivery.chirp = { ok: false, error: (e.message || String(e)).slice(0, 140) };
  }

  return res.status(200).json({ ok: true, overall: report.overall, delivery, checks, statusHub });
}
