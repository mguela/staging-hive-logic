// api/ops-events.js - Vercel serverless function
//
// The operational event feed. Chris, 2026-08-22: "AI should never let you miss
// an opportunity for efficiency and also follow ups."
//
//   GET  ?resource=sweep    run every detector, record what is newly true    (cron)
//   GET  ?resource=feed     the open feed, newest first                      (staff)
//   GET  ?resource=health   when each detector last ran and what it found    (staff)
//   POST ?resource=act      record that somebody chose a follow-up           (staff)
//   POST ?resource=mute     silence a kind, optionally scoped                (staff)
//   POST ?resource=flag     set or clear a client flag ("no work", VIP, ...) (staff)
//
// WHERE THE THINKING LIVES. All of it is in api/_lib/ops-detectors.js, which is
// pure. This file reads rows, hands them over, and writes back what came out.
// That split is what makes "a job finished four days ago and was never invoiced"
// testable without a job, an invoice, or four days.
//
// THE SWEEP IS IDEMPOTENT. Detectors re-find the same true facts every run. An
// event whose dedupe_key already exists has its last_seen_at bumped and nothing
// else -- so "still true after three days" is answerable and the reader is not
// told twice. An open event whose fact has stopped being true is closed as
// 'resolved' rather than left to rot, because a feed full of things that already
// got handled is a feed nobody reads.
//
// NOTHING HERE SENDS ANYTHING. `act` records the decision and returns what the
// caller should do next. Anything customer-facing still goes through the
// automations outbox behind its master switch.
import { supabaseRequest } from './_lib/jobber.js';
import { requireUser } from './_lib/auth.js';
import { requireApiAuth } from './_lib/guard.js';
import { runAll, isMuted, shouldInterrupt } from './_lib/ops-detectors.js';

const DAY = 24 * 3600 * 1000;

// How far back the sweep looks. Wide enough to catch a job that finished last
// week and was never billed; narrow enough that the read stays cheap.
const LOOKBACK_MS = 45 * DAY;
const LOOKAHEAD_MS = 10 * DAY;

async function sbJson(path) {
  const res = await supabaseRequest(path);
  if (!res.ok) throw new Error(`${path.split('?')[0]}: ${await res.text()}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// the sweep
// ---------------------------------------------------------------------------

// Only the clients actually referenced by this sweep, fetched by id in chunks.
//
// The first production run read `clients` with a flat limit of 5000 and
// production holds 8,656 active ones, so a third were never loaded -- 57 of the
// 117 events came out saying "A client" while carrying the client_id all along.
// Raising the cap would only move the cliff; the sweep never needs more than the
// few hundred clients its own rows point at.
async function loadClientsFor(ids) {
  const wanted = [...new Set((ids || []).filter(Boolean))];
  if (!wanted.length) return [];
  const out = [];
  for (let i = 0; i < wanted.length; i += 150) {
    const chunk = wanted.slice(i, i + 150).map(encodeURIComponent).join(",");
    const rows = await sbJson(
      `clients?select=jobber_id,name,first_name,last_name,company_name,balance&jobber_id=in.(${chunk})`
    ).catch(() => []);
    out.push(...rows);
  }
  return out;
}

async function loadSweepData(now) {
  const fromISO = new Date(now - LOOKBACK_MS).toISOString();
  const toISO = new Date(now + LOOKAHEAD_MS).toISOString();

  const [visits, invoices, , quotes, presence, flags] = await Promise.all([
    sbJson('visits?select=jobber_id,title,start_at,end_at,completed_at,is_all_day,client_id,job_id,assigned_users,visit_status,jobber_web_uri'
      + `&or=(and(start_at.gte.${fromISO},start_at.lte.${toISO}),and(completed_at.gte.${fromISO},completed_at.lte.${toISO}))`
      + '&limit=4000'),
    sbJson(`invoices?select=jobber_id,client_id,invoice_number,invoice_status,total,balance,due_date,job_id,jobber_created_at,jobber_web_uri&jobber_created_at=gte.${fromISO}&limit=4000`),
    Promise.resolve([]), // clients are fetched below, by id -- see loadClientsFor()
    sbJson(`quotes?select=jobber_id,quote_number,quote_status,total,client_id,client_name,jobber_updated_at,jobber_web_uri&jobber_updated_at=gte.${fromISO}&limit=2000`),
    sbJson(`fleet_job_presence?select=*&arrived_at=gte.${new Date(now - 1 * DAY).toISOString()}&limit=500`).catch(() => []),
    sbJson('client_flags?select=client_id,flag,reason&cleared_at=is.null&limit=2000').catch(() => []),
  ]);

  // Everything that will need a name on it: visits, invoices and quotes all
  // carry a client_id, and every detector renders one.
  const clientRows = await loadClientsFor([
    ...(visits || []).map((v) => v.client_id),
    ...(invoices || []).map((i) => i.client_id),
    ...(quotes || []).map((q) => q.client_id),
    ...(presence || []).map((p) => p.client_id),
  ]);

  // An invoice that exists at all means the job was billed; used by
  // finishedNotInvoiced. Kept as the raw list so the detector owns the rule.
  //
  // Photo counts are read per finished job rather than over all 40,939 media
  // rows -- the sweep should not pull 18GB worth of metadata to answer "does
  // this job have any photos".
  const finishedJobIds = [...new Set((visits || []).filter((v) => v.completed_at && v.job_id).map((v) => v.job_id))].slice(0, 400);
  const mediaCountByJob = {};
  for (let i = 0; i < finishedJobIds.length; i += 100) {
    const chunk = finishedJobIds.slice(i, i + 100).map(encodeURIComponent).join(',');
    const rows = await sbJson(`media?select=job_id&job_id=in.(${chunk})&limit=5000`).catch(() => []);
    for (const r of rows) mediaCountByJob[r.job_id] = (mediaCountByJob[r.job_id] || 0) + 1;
  }

  // "Does this client have anything on the calendar" for approvedNotScheduled.
  const visitsByClient = {};
  for (const v of visits || []) {
    if (!v.completed_at && v.client_id) visitsByClient[v.client_id] = (visitsByClient[v.client_id] || 0) + 1;
  }

  return { now, visits, invoices, clients: clientRows, quotes, presence, flags, mediaCountByJob, visitsByClient };
}

async function handleSweep(req, res) {
  const now = Date.now();
  const started = now;
  const data = await loadSweepData(now);
  const mutes = await sbJson('ops_event_mutes?select=*&limit=1000').catch(() => []);

  const results = runAll(data);
  const summary = [];
  let created = 0, bumped = 0, muted = 0;

  // Everything the sweep believes is currently true, so anything open and
  // absent can be closed out below.
  const liveKeys = new Set();

  for (const r of results) {
    let madeHere = 0, mutedHere = 0;
    for (const event of r.events) {
      if (isMuted(event, mutes)) { mutedHere++; muted++; continue; }
      liveKeys.add(event.dedupe_key);

      // The unique index on dedupe_key is what makes this safe to run every
      // hour: a repeat insert is ignored rather than becoming a second copy.
      const ins = await supabaseRequest('ops_events', {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
        body: JSON.stringify({
          dedupe_key: event.dedupe_key, kind: event.kind, domain: event.domain,
          severity: event.severity, title: event.title, detail: event.detail,
          client_id: event.client_id, client_name: event.client_name,
          job_id: event.job_id, job_title: event.job_title, visit_id: event.visit_id,
          vehicle_name: event.vehicle_name, entity_url: event.entity_url,
          actions: event.actions, facts: event.facts,
        }),
      });
      const rows = ins.ok ? await ins.json().catch(() => []) : [];
      if (rows && rows.length) { created++; madeHere++; }
      else {
        // Already known. Bump last_seen_at so "this has been true for three
        // days" stays answerable without a second table.
        //
        // The PRESENTATION is refreshed alongside it, not just the timestamp. A
        // detector whose wording or lookup improves should heal the events it
        // already raised -- otherwise a fix only ever reaches events created
        // after it ships, and the ones already sitting in the feed stay wrong
        // forever, because dedupe means they are never re-inserted. The first
        // production sweep raised 57 events reading "A client" for exactly this
        // reason. Status, who acted, and created_at are deliberately untouched.
        bumped++;
        supabaseRequest(`ops_events?dedupe_key=eq.${encodeURIComponent(event.dedupe_key)}&status=eq.open`, {
          method: 'PATCH',
          body: JSON.stringify({
            last_seen_at: new Date(now).toISOString(),
            title: event.title,
            detail: event.detail,
            client_name: event.client_name,
            job_title: event.job_title,
            severity: event.severity,
            actions: event.actions,
            facts: event.facts,
          }),
        }).catch(() => {});
      }
    }

    summary.push({ detector: r.detector, found: r.events.length, created: madeHere, muted: mutedHere, error: r.error });
    supabaseRequest('ops_detector_runs', {
      method: 'POST',
      body: JSON.stringify({
        detector: r.detector, found: r.events.length, created: madeHere,
        duration_ms: Date.now() - started, error: r.error,
      }),
    }).catch(() => {});
  }

  // Close what stopped being true. An invoice got raised, a crew closed out,
  // somebody assigned the visit -- the reason to look is gone, so the row goes
  // with it. A feed full of already-handled things is a feed nobody reads.
  //
  // Scoped to the kinds this sweep actually ran, so a detector that errored
  // does not silently resolve everything it would have found.
  const ranKinds = [...new Set(results.filter((r) => !r.error).flatMap((r) => r.events.map((e) => e.kind)))];
  let resolved = 0;
  if (ranKinds.length) {
    const open = await sbJson(`ops_events?select=id,dedupe_key,kind&status=eq.open&kind=in.(${ranKinds.map((k) => `"${k}"`).join(',')})&limit=2000`).catch(() => []);
    const stale = open.filter((o) => !liveKeys.has(o.dedupe_key));
    for (const s of stale) {
      const upd = await supabaseRequest(`ops_events?id=eq.${s.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'resolved', resolved_at: new Date(now).toISOString() }),
      });
      if (upd.ok) resolved++;
    }
  }

  return res.status(200).json({
    ok: true, resource: 'sweep', created, bumped, muted, resolved,
    durationMs: Date.now() - started, detectors: summary,
  });
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

async function handleFeed(req, res) {
  const q = req.query || {};
  const limit = Math.min(Number.parseInt(q.limit, 10) || 50, 200);
  const params = ['select=*', `limit=${limit}`, 'order=severity.asc,created_at.desc'];
  params.push(`status=eq.${['open', 'acted', 'dismissed', 'resolved'].includes(q.status) ? q.status : 'open'}`);
  if (q.domain) params.push(`domain=eq.${encodeURIComponent(q.domain)}`);
  if (q.severity) params.push(`severity=eq.${encodeURIComponent(q.severity)}`);
  if (q.client_id) params.push(`client_id=eq.${encodeURIComponent(q.client_id)}`);

  const events = await sbJson(`ops_events?${params.join('&')}`);
  const hourLocal = Number.isFinite(Number(q.hour)) ? Number(q.hour) : null;

  return res.status(200).json({
    ok: true, resource: 'feed',
    // Split rather than one list: the caller should not have to re-derive which
    // of these were worth stopping for.
    interrupts: events.filter((e) => shouldInterrupt(e, { hourLocal })),
    digest: events.filter((e) => !shouldInterrupt(e, { hourLocal })),
    total: events.length,
  });
}

// A detector that silently stops producing looks exactly like one with nothing
// to report. This is how you tell them apart.
async function handleHealth(req, res) {
  const rows = await sbJson('ops_detector_runs?select=detector,ran_at,found,created,error&order=ran_at.desc&limit=300');
  const latest = {};
  for (const r of rows) if (!latest[r.detector]) latest[r.detector] = r;
  return res.status(200).json({ ok: true, resource: 'health', detectors: Object.values(latest) });
}

// ---------------------------------------------------------------------------
// acting
// ---------------------------------------------------------------------------

// Records the decision and hands back where to go. It deliberately does NOT
// create the invoice or send the chirp itself: those live in their own
// endpoints with their own rules, and an action router that quietly performs
// them would be a second place where money moves.
const ACTION_ROUTES = {
  create_invoice: (e) => ({ go: 'invoices', jobId: e.job_id }),
  send_invoice: (e) => ({ go: 'invoices', clientId: e.client_id }),
  open_job: (e) => ({ go: 'job', jobId: e.job_id }),
  open_client: (e) => ({ go: 'client', clientId: e.client_id }),
  schedule_work: (e) => ({ go: 'schedule', clientId: e.client_id }),
  assign_crew: (e) => ({ go: 'schedule', visitId: e.visit_id }),
  reschedule: (e) => ({ go: 'schedule', visitId: e.visit_id }),
  cancel_visit: (e) => ({ go: 'schedule', visitId: e.visit_id }),
  mark_complete: (e) => ({ go: 'job', jobId: e.job_id }),
  chirp_lead: (e) => ({ go: 'chirp', jobId: e.job_id }),
  collect_first: (e) => ({ go: 'client', clientId: e.client_id }),
  clear_flag: (e) => ({ go: 'client', clientId: e.client_id }),
  dismiss: () => ({ go: null }),
  snooze_7d: () => ({ go: null }),
};

async function handleAct(req, res, user) {
  const body = req.body || {};
  const { id, action } = body;
  if (!id || !action) return res.status(400).json({ ok: false, error: 'id and action are required' });

  const rows = await sbJson(`ops_events?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
  const event = rows && rows[0];
  if (!event) return res.status(404).json({ ok: false, error: 'That event no longer exists.' });

  // Only an action the detector actually offered. A caller naming its own
  // action would be inventing a follow-up nobody designed.
  const offered = (event.actions || []).some((a) => a.action === action);
  if (!offered) return res.status(400).json({ ok: false, error: `"${action}" is not one of the follow-ups offered on this event.` });

  const status = action === 'dismiss' ? 'dismissed' : 'acted';
  const upd = await supabaseRequest(`ops_events?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      status, acted_action: action, acted_by: user.id, acted_at: new Date().toISOString(),
    }),
  });
  if (!upd.ok) return res.status(502).json({ ok: false, error: `Could not record that: ${await upd.text()}` });

  const route = (ACTION_ROUTES[action] || (() => ({ go: null })))(event);
  return res.status(200).json({ ok: true, resource: 'act', status, next: route });
}

async function handleMute(req, res, user) {
  const b = req.body || {};
  if (!b.kind) return res.status(400).json({ ok: false, error: 'kind is required' });
  if (b.unmute) {
    const parts = [`kind=eq.${encodeURIComponent(b.kind)}`];
    parts.push(b.client_id ? `client_id=eq.${encodeURIComponent(b.client_id)}` : 'client_id=is.null');
    parts.push(b.job_id ? `job_id=eq.${encodeURIComponent(b.job_id)}` : 'job_id=is.null');
    parts.push(b.vehicle_name ? `vehicle_name=eq.${encodeURIComponent(b.vehicle_name)}` : 'vehicle_name=is.null');
    const del = await supabaseRequest(`ops_event_mutes?${parts.join('&')}`, { method: 'DELETE' });
    return res.status(del.ok ? 200 : 502).json({ ok: del.ok, resource: 'mute', unmuted: del.ok });
  }
  const ins = await supabaseRequest('ops_event_mutes', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify({
      kind: b.kind, client_id: b.client_id || null, job_id: b.job_id || null,
      vehicle_name: b.vehicle_name || null, reason: b.reason || null, muted_by: user.id,
    }),
  });
  if (!ins.ok) return res.status(502).json({ ok: false, error: await ins.text() });
  return res.status(200).json({ ok: true, resource: 'mute', muted: true });
}

// Setting or clearing "no work — prior bad experience" and its relatives.
async function handleFlag(req, res, user) {
  const b = req.body || {};
  const FLAGS = ['no_work', 'do_not_contact', 'vip', 'payment_risk'];
  if (!b.client_id || !FLAGS.includes(b.flag)) {
    return res.status(400).json({ ok: false, error: `client_id and flag (${FLAGS.join(', ')}) are required` });
  }
  if (b.clear) {
    const upd = await supabaseRequest(
      `client_flags?client_id=eq.${encodeURIComponent(b.client_id)}&flag=eq.${encodeURIComponent(b.flag)}&cleared_at=is.null`,
      { method: 'PATCH', body: JSON.stringify({ cleared_at: new Date().toISOString(), cleared_by: user.id }) }
    );
    return res.status(upd.ok ? 200 : 502).json({ ok: upd.ok, resource: 'flag', cleared: upd.ok });
  }
  const ins = await supabaseRequest('client_flags', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify({ client_id: b.client_id, flag: b.flag, reason: b.reason || null, created_by: user.id }),
  });
  if (!ins.ok) return res.status(502).json({ ok: false, error: await ins.text() });
  return res.status(200).json({ ok: true, resource: 'flag', set: true });
}

// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  const resource = req.query.resource || 'feed';
  try {
    // The sweep is a machine route: it runs unattended on a schedule and takes
    // the cron secret. Everything else needs a real signed-in person.
    if (resource === 'sweep') {
      // requireApiAuth returns {ok,user,via} and answers nothing itself -- it
      // accepts either the cron secret or a real signed-in user, so the sweep
      // can also be triggered by hand from the app.
      const auth = await requireApiAuth(req);
      if (!auth.ok) return res.status(401).json({ ok: false, error: 'The sweep needs the cron secret or a signed-in user.' });
      return await handleSweep(req, res);
    }

    const user = await requireUser(req);
    if (!user) return res.status(401).json({ ok: false, error: 'Sign in to see the ops feed.' });

    if (resource === 'feed') return await handleFeed(req, res);
    if (resource === 'health') return await handleHealth(req, res);
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
    if (resource === 'act') return await handleAct(req, res, user);
    if (resource === 'mute') return await handleMute(req, res, user);
    if (resource === 'flag') return await handleFlag(req, res, user);

    return res.status(400).json({ ok: false, error: 'resource must be one of: sweep, feed, health, act, mute, flag' });
  } catch (e) {
    return res.status(502).json({ ok: false, error: e.message });
  }
}
