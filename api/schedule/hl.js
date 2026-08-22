// api/schedule/hl.js
// HiveLogic-NATIVE scheduling write path. Owner decision (2026-08-14): new
// appointments, clock in/out, and crew changes live in HiveLogic ONLY — this
// endpoint NEVER writes to Jobber (Jobber stays a read-only mirror). Additive
// tables: hl_appointments, hl_clock, hl_crew_overrides (migration hl_native_scheduling).
//
// GET  ?start=YYYY-MM-DD&end=YYYY-MM-DD  → { appointments, clock, overrides }
// POST { action, ... }                   → mutate one of the three tables
import { supabaseRequest } from '../_lib/jobber.js';
import { genToken, hashToken } from '../_lib/portal-auth.js';
import { moveInvalidatesReminders, staleReminderQuery, queuedForAppointmentQuery } from '../_lib/reminder-resync.js';
import { clockCrewIn, clockCrewOut } from '../_lib/crew-clock.js';
import { jobRef } from '../_lib/project-numbers.js';

const WRITE_ROLES = ['owner', 'partner', 'office_manager', 'systems_pm', 'dispatch', 'project_manager'];

async function getRequester(req) {
  const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!userRes.ok) return null;
  const user = await userRes.json();
  if (!user || !user.id) return null;
  const profRes = await supabaseRequest(`profiles?id=eq.${user.id}&select=id,email,full_name,role`);
  const prof = (profRes.ok ? await profRes.json() : [])[0] || { id: user.id, email: user.email, role: null };
  let permissionRoles = [];
  let jobberId = null;
  // permission roles via users→employee_roles. jobberId also identifies the caller
  // AS a crew member, which is what self-unchain authorizes against.
  try {
    if (prof.email) {
      const ur = await supabaseRequest(`users?email=eq.${encodeURIComponent(prof.email)}&select=jobber_id&limit=1`);
      jobberId = (ur.ok ? await ur.json() : [])[0]?.jobber_id || null;
      if (jobberId) {
        const rr = await supabaseRequest(`employee_roles?jobber_id=eq.${encodeURIComponent(jobberId)}&select=permission_roles,permission_role`);
        const row = (rr.ok ? await rr.json() : [])[0];
        permissionRoles = (row && row.permission_roles) || (row && row.permission_role ? [row.permission_role] : []);
      }
    }
  } catch (e) {}
  return { ...prof, permissionRoles, jobberId };
}
function canWrite(r) {
  if (!r) return false;
  if (r.role === 'admin' || r.role === 'superadmin') return true;
  return (r.permissionRoles || []).some((x) => WRITE_ROLES.indexOf(x) !== -1);
}
// A crew member acting on their OWN chain (peel themselves off a job) doesn't
// need dispatch rights — but they can only ever act on themselves.
function isSelf(r, jid) {
  return !!(r && r.jobberId && jid && String(r.jobberId) === String(jid));
}

async function sb(path, method, body) {
  const opts = { method: method || 'GET' };
  if (body) opts.body = JSON.stringify(body);
  if (method && method !== 'GET') opts.headers = { Prefer: 'return=representation' };
  const r = await supabaseRequest(path, opts);
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) {}
  return { ok: r.ok, status: r.status, json };
}

// Queue confirmation + reminders for a client-facing appointment. Rows sit in
// hl_outbox as 'queued' (a live preview of what WOULD send). Nothing is sent here —
// a separate processor only sends when hl_message_settings.enabled is true.
async function queueMessages(appt, opts) {
  const remindersOnly = !!(opts && opts.remindersOnly);
  try {
    if (!appt || !appt.id || !appt.start_at) return;
    const CLIENT_FACING = ['field', 'service', 'sitevisit', 'lead'];
    if (CLIENT_FACING.indexOf(appt.kind) === -1) return;
    const sres = await sb('hl_message_settings?id=eq.true&select=*');
    const s = (Array.isArray(sres.json) ? sres.json : [])[0] || {};
    const reminders = Array.isArray(s.reminders) ? s.reminders : [];
    const on = (id) => reminders.some((r) => r.id === id && r.on !== false);
    const contact = (appt.details && (appt.details.contact || appt.details.email || appt.details.phone)) || null;

    // Mint the confirm link's token here, at queue time, because this is the
    // one moment we hold the raw value: it goes into the email body and its
    // SHA-256 hash goes into the row. The raw token is never stored, so a
    // leaked hl_appointments dump cannot be used to answer for a customer.
    // Expiry is the appointment's own end time -- a link that outlives the
    // visit it refers to has no legitimate use.
    let confirmUrl = null;
    if (s.confirm_on_create !== false && !remindersOnly) {
      const rawToken = genToken(32);
      const base = process.env.MARKETING_PUBLIC_BASE_URL || 'https://hivelogic-live.vercel.app';
      confirmUrl = `${base}/api/schedule/confirm?token=${rawToken}`;
      const stamped = await sb(`hl_appointments?id=eq.${encodeURIComponent(appt.id)}`, 'PATCH', {
        confirm_token_hash: hashToken(rawToken),
        confirm_expires_at: appt.end_at || appt.start_at,
      });
      // If the row could not be stamped the link would resolve to nothing, so
      // send no link at all rather than one that lands on "not valid".
      if (!stamped.ok) confirmUrl = null;
    }
    const start = new Date(appt.start_at);
    const label = appt.title || appt.client || 'your appointment';
    const whenStr = start.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const rows = [];
    const now = Date.now();
    const push = (step, when, subject, body) => { if (when.getTime() > now - 60000) rows.push({ appointment_id: appt.id, step, channel: 'email', recipient_name: appt.client || null, recipient_contact: contact, subject, body, scheduled_for: when.toISOString(), status: 'queued' }); };
    if (s.confirm_on_create !== false && !remindersOnly) {
      const cta = confirmUrl ? `

Confirm or reschedule: ${confirmUrl}` : '';
      push('confirm', new Date(), `Please confirm: ${label}`,
        `Hi ${appt.client || ''} — please confirm your appointment on ${whenStr}.${cta}

${s.cancellation_policy || ''}`.trim());
    }
    if (on('d3')) push('d3', new Date(start.getTime() - 3 * 864e5), `Reminder: ${label} in 3 days`, `A reminder that your appointment is on ${whenStr}.`);
    if (on('d1')) push('d1', new Date(start.getTime() - 1 * 864e5), `Reminder: ${label} tomorrow`, `See you tomorrow — your appointment is ${whenStr}.`);
    if (on('d0')) { const dz = new Date(start); dz.setHours(7, 0, 0, 0); push('d0', dz, `Today: ${label}`, `Your appointment is today, ${whenStr}.`); }
    if (on('h1')) push('h1', new Date(start.getTime() - 36e5), `Soon: ${label} in 1 hour`, `Your appointment is in about an hour — ${whenStr}.`);
    if (rows.length) await sb('hl_outbox', 'POST', rows);
  } catch (e) { /* queueing must never fail the create */ }
}


// Reminders are queued once, at create, against the time the appointment had
// THEN. Moving it changed start_at and left them untouched, so a visit pushed
// from Tuesday to Friday still mailed "your appointment is tomorrow" on Monday
// night, naming the old slot. This resyncs them.
//
// Deliberately narrow: it drops only QUEUED REMINDER rows. A 'confirm' row is
// left alone even when still queued, because re-queueing it would re-mint the
// token (see queueMessages) and kill the link already sitting in the customer's
// inbox. Anything already sent is history and is never rewritten.
async function resyncReminders(appt) {
  try {
    if (!appt || !appt.id) return;
    await sb(staleReminderQuery(appt.id), 'DELETE');
    await queueMessages(appt, { remindersOnly: true });
  } catch (e) { /* a resync failure must never fail the move itself */ }
}

// Cancelling kills anything still queued for that appointment. The processor
// also refuses cancelled appointments at send time, so this is the second of
// two independent guards rather than the only one -- a queued row that somehow
// survives here still cannot reach a customer.
async function cancelQueuedMessages(id) {
  try {
    await sb(queuedForAppointmentQuery(id), 'PATCH', {
      status: 'skipped', error: 'appointment cancelled',
    });
  } catch (e) { /* never fail the cancel */ }
}

export default async function handler(req, res) {
  const requester = await getRequester(req);
  if (!requester) return res.status(401).json({ ok: false, error: 'Not signed in' });

  // ---- GET: list native records for a date range ----
  if (req.method === 'GET') {
    const start = (req.query.start || '').slice(0, 10);
    const end = (req.query.end || '').slice(0, 10);
    const startISO = start ? start + 'T00:00:00Z' : '1970-01-01T00:00:00Z';
    const endISO = end ? end + 'T23:59:59Z' : '2999-01-01T00:00:00Z';
    const [appts, clock, ov, outbox, mset, rechain, subs] = await Promise.all([
      sb(`hl_appointments?canceled=eq.false&start_at=gte.${startISO}&start_at=lte.${endISO}&order=start_at.asc`),
      sb(`hl_clock?clock_out=is.null`),
      sb(`hl_crew_overrides?select=*`),
      sb(`hl_outbox?status=eq.queued&order=scheduled_for.asc&limit=200`),
      sb(`hl_message_settings?id=eq.true&select=*`),
      sb(`hl_rechain_requests?status=eq.open&order=created_at.desc&limit=100`),
      // Subcontractor names for the board's Subs layer. Only id+name: the board
      // needs a row label, not a vendor record.
      sb(`subs?select=id,name&order=name.asc&limit=200`),
    ]);
    // Coerce to arrays only — a PostgREST error body is a truthy object that would
    // otherwise reach the board and throw on .forEach/.map.
    const arr = (x) => (Array.isArray(x.json) ? x.json : []);
    return res.status(200).json({
      ok: true,
      appointments: arr(appts),
      clock: arr(clock),
      overrides: arr(ov),
      outbox: arr(outbox),
      messaging: arr(mset)[0] || { enabled: false },
      subs: arr(subs),
      rechainRequests: arr(rechain),
      viewerJid: requester.jobberId || null,   // lets the board show "unchain me"
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const enc = (v) => encodeURIComponent(String(v));                 // for eq. values
  const inList = (a) => a.map((e) => '"' + encodeURIComponent(String(e)) + '"').join(','); // for in.(...)
  const rows = (r) => (Array.isArray(r.json) ? r.json.length : 0);  // how many rows a write touched

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = body.action;
    const who = requester.email || requester.id;

    // Dispatch rights are required for everything EXCEPT a crew member peeling
    // themselves off a job — that one is authorized by being the person named.
    const SELF_ACTIONS = ['self_unchain'];
    if (SELF_ACTIONS.indexOf(action) === -1 && !canWrite(requester)) {
      return res.status(403).json({ ok: false, error: 'You don’t have permission to change the schedule.' });
    }
    if (action === 'create_appointment') {
      const a = body.appointment || {};
      if (!a.start_at || !a.end_at) return res.status(400).json({ ok: false, error: 'start_at and end_at are required' });

      // Scheduling a specific job (Phase 0, item 4). When job_ref is given, the
      // job record is the authority for its own number, title, client and
      // division -- a dispatcher shouldn't be retyping any of that, and a typo
      // in the job number used to be the only thing linking the two.
      // Appointments with no job (shop days, callbacks, in-person estimates)
      // are still perfectly valid and skip all of this.
      let jobLink = { job_ref: null, job_no: a.job_no || null };
      if (a.job_ref) {
        const jr = await sb(`jobs?jobber_id=eq.${enc(a.job_ref)}&select=jobber_id,project_seq,job_number,title,client_id,division_code&limit=1`);
        const job = (Array.isArray(jr.json) ? jr.json : [])[0];
        if (!job) return res.status(404).json({ ok: false, error: 'That job no longer exists.' });
        jobLink = {
          job_ref: job.jobber_id,
          // A HiveLogic job shows as J-10001; a Jobber-synced one keeps its own
          // bare number, because that is what it is called everywhere else.
          job_no: job.project_seq ? jobRef(job.project_seq) : (job.job_number != null ? String(job.job_number) : null),
        };
        if (!a.title) a.title = job.title || null;
        if (!a.division) a.division = job.division_code || null;
      }

      const row = {
        kind: a.kind || 'field', title: a.title || null, client: a.client || null,
        crew_jids: a.crew_jids || [], lead_jid: a.lead_jid || null,
        start_at: a.start_at, end_at: a.end_at, division: a.division || null,
        job_no: jobLink.job_no, job_ref: jobLink.job_ref,
        lat: a.lat ?? null, lng: a.lng ?? null,
        // Where this came from. A site visit booked off a lead keeps a link
        // back to it, so the calendar entry is traceable to the request that
        // caused it rather than floating free.
        source_lead_id: a.source_lead_id || null,
        source_estimate_id: a.source_estimate_id || null,
        details: a.details || {}, status: 'scheduled', created_by: who,
      };
      const r = await sb('hl_appointments', 'POST', row);
      if (!r.ok) return res.status(500).json({ ok: false, error: 'create failed', detail: r.json });
      const created = (Array.isArray(r.json) ? r.json : [])[0];
      await queueMessages(created);   // queues confirm + reminders (sends nothing unless messaging is enabled)
      return res.status(200).json({ ok: true, appointment: created });
    }

    if (action === 'cancel_appointment') {
      if (!body.id) return res.status(400).json({ ok: false, error: 'id required' });
      const r = await sb(`hl_appointments?id=eq.${enc(body.id)}`, 'PATCH', { canceled: true, updated_at: new Date().toISOString() });
      if (r.ok && rows(r) > 0) await cancelQueuedMessages(body.id);
      return res.status(r.ok ? 200 : 500).json({ ok: r.ok && rows(r) > 0, changed: rows(r) });
    }

    if (action === 'move_appointment') {
      if (!body.id) return res.status(400).json({ ok: false, error: 'id required' });
      const patch = { updated_at: new Date().toISOString() };
      if (body.start_at) patch.start_at = body.start_at;
      if (body.end_at) patch.end_at = body.end_at;
      if (Array.isArray(body.crew_jids)) patch.crew_jids = body.crew_jids;
      if (body.lead_jid !== undefined) patch.lead_jid = body.lead_jid;
      const r = await sb(`hl_appointments?id=eq.${enc(body.id)}`, 'PATCH', patch);
      const moved = (Array.isArray(r.json) ? r.json : [])[0];
      // Only when the TIME actually changed -- reassigning crew does not make
      // the reminders wrong, and needless requeueing churns the outbox.
      if (r.ok && moved && moveInvalidatesReminders(body)) await resyncReminders(moved);
      return res.status(r.ok ? 200 : 500).json({ ok: r.ok && rows(r) > 0, appointment: moved });
    }

    if (action === 'clock_in') {
      // body.employees = [jid...], target_kind, target_id, label, lead_jid, source
      // One tap by the lead clocks the whole chained crew in — but each person gets
      // their OWN row, because payroll pays people, not crews.
      const emps = body.employees || (body.employee_jid ? [body.employee_jid] : []);
      if (!emps.length) return res.status(400).json({ ok: false, error: 'employees required' });
      const out = await clockCrewIn({
        employees: emps, leadJid: body.lead_jid, source: body.source,
        targetKind: body.target_kind, targetId: body.target_id, label: body.label, who,
      });
      return res.status(out.ok ? 200 : 500).json(out);
    }

    if (action === 'clock_out') {
      const emps = body.employees || (body.employee_jid ? [body.employee_jid] : []);
      if (!emps.length) return res.status(400).json({ ok: false, error: 'employees required' });
      const out = await clockCrewOut(emps);
      return res.status(out.ok ? 200 : 500).json({ ok: out.ok && out.changed > 0, changed: out.changed, note: (out.ok && !out.changed) ? 'nobody was clocked in' : undefined });
    }

    if (action === 'chain' || action === 'unchain') {
      // add/remove an employee jid on a Jobber visit, stored as a HiveLogic override
      const visit = body.visit_jid; const jid = String(body.employee_jid || '');
      if (!visit || !jid) return res.status(400).json({ ok: false, error: 'visit_jid and employee_jid required' });
      const cur = await sb(`hl_crew_overrides?visit_jid=eq.${encodeURIComponent(visit)}&select=*`);
      const row = (cur.json || [])[0];
      let add = (row && row.add_jids) || [], rem = (row && row.remove_jids) || [];
      add = add.filter((x) => x !== jid); rem = rem.filter((x) => x !== jid);
      if (action === 'chain') add.push(jid); else rem.push(jid);
      const payload = { visit_jid: visit, add_jids: add, remove_jids: rem, updated_by: who, updated_at: new Date().toISOString() };
      let r;
      if (row) r = await sb(`hl_crew_overrides?visit_jid=eq.${encodeURIComponent(visit)}`, 'PATCH', payload);
      else r = await sb('hl_crew_overrides', 'POST', payload);
      return res.status(r.ok ? 200 : 500).json({ ok: r.ok, override: (r.json || [])[0] });
    }

    if (action === 'self_unchain') {
      // A tech peels THEMSELVES off one job. This never removes them from their
      // crew — it drops this job only, and files a request so dispatch can put
      // them back on it or place them somewhere else.
      const visit = body.visit_jid;
      const jid = String(body.employee_jid || requester.jobberId || '');
      if (!visit || !jid) return res.status(400).json({ ok: false, error: 'visit_jid required' });
      if (!isSelf(requester, jid) && !canWrite(requester)) {
        return res.status(403).json({ ok: false, error: 'You can only unchain yourself.' });
      }
      const cur = await sb(`hl_crew_overrides?visit_jid=eq.${encodeURIComponent(visit)}&select=*`);
      const row = (cur.json || [])[0];
      let add = (row && row.add_jids) || [], rem = (row && row.remove_jids) || [];
      add = add.filter((x) => x !== jid);
      if (rem.indexOf(jid) === -1) rem = rem.concat([jid]);
      const payload = { visit_jid: visit, add_jids: add, remove_jids: rem, updated_by: who, updated_at: new Date().toISOString() };
      const r = row
        ? await sb(`hl_crew_overrides?visit_jid=eq.${encodeURIComponent(visit)}`, 'PATCH', payload)
        : await sb('hl_crew_overrides', 'POST', payload);
      if (!r.ok) return res.status(500).json({ ok: false, error: 'unchain failed', detail: r.json });
      // close their clock on this job — they're off it
      await sb(`hl_clock?clock_out=is.null&employee_jid=eq.${enc(jid)}&target_id=eq.${enc(visit)}`, 'PATCH', { clock_out: new Date().toISOString() });
      const reqRow = {
        target_kind: 'jobber_visit', target_id: String(visit), employee_jid: jid,
        lead_jid: (row && row.lead_jid) || body.lead_jid || null,
        reason: (body.reason || '').slice(0, 500) || null, status: 'open',
      };
      const rr = await sb('hl_rechain_requests', 'POST', reqRow);
      return res.status(200).json({ ok: true, request: (Array.isArray(rr.json) ? rr.json : [])[0] || null });
    }

    if (action === 'set_visit_lead') {
      // Dispatch picks the lead for one job — used when two leads land together,
      // and when a lead goes out sick and someone else has to run the job.
      const visit = body.visit_jid;
      const jid = body.employee_jid ? String(body.employee_jid) : null;   // null = clear the election
      if (!visit) return res.status(400).json({ ok: false, error: 'visit_jid required' });
      const cur = await sb(`hl_crew_overrides?visit_jid=eq.${encodeURIComponent(visit)}&select=*`);
      const row = (cur.json || [])[0];
      const payload = { visit_jid: visit, lead_jid: jid, updated_by: who, updated_at: new Date().toISOString() };
      const r = row
        ? await sb(`hl_crew_overrides?visit_jid=eq.${encodeURIComponent(visit)}`, 'PATCH', payload)
        : await sb('hl_crew_overrides', 'POST', payload);
      return res.status(r.ok ? 200 : 500).json({ ok: r.ok, override: (Array.isArray(r.json) ? r.json : [])[0] });
    }

    if (action === 'resolve_rechain') {
      // Dispatch answers a self-unchain: 'rechain' puts them back on the job,
      // 'dismiss' just closes the request and leaves them off it.
      const id = body.id, how = body.resolution === 'rechain' ? 'rechain' : 'dismiss';
      if (!id) return res.status(400).json({ ok: false, error: 'id required' });
      const got = await sb(`hl_rechain_requests?id=eq.${enc(id)}&select=*`);
      const reqRow = (Array.isArray(got.json) ? got.json : [])[0];
      if (!reqRow) return res.status(404).json({ ok: false, error: 'Request not found' });
      if (how === 'rechain') {
        const visit = reqRow.target_id, jid = String(reqRow.employee_jid);
        const cur = await sb(`hl_crew_overrides?visit_jid=eq.${encodeURIComponent(visit)}&select=*`);
        const row = (cur.json || [])[0];
        let add = (row && row.add_jids) || [], rem = (row && row.remove_jids) || [];
        rem = rem.filter((x) => x !== jid);
        if (add.indexOf(jid) === -1) add = add.concat([jid]);
        const payload = { visit_jid: visit, add_jids: add, remove_jids: rem, updated_by: who, updated_at: new Date().toISOString() };
        if (row) await sb(`hl_crew_overrides?visit_jid=eq.${encodeURIComponent(visit)}`, 'PATCH', payload);
        else await sb('hl_crew_overrides', 'POST', payload);
      }
      const r = await sb(`hl_rechain_requests?id=eq.${enc(id)}`, 'PATCH', { status: how === 'rechain' ? 'rechained' : 'dismissed', resolved_by: who, resolved_at: new Date().toISOString() });
      return res.status(r.ok ? 200 : 500).json({ ok: r.ok && rows(r) > 0, resolution: how });
    }

    if (action === 'set_messaging') {
      const patch = { updated_by: who, updated_at: new Date().toISOString() };
      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
      if (typeof body.confirm_on_create === 'boolean') patch.confirm_on_create = body.confirm_on_create;
      if (Array.isArray(body.reminders)) patch.reminders = body.reminders;
      if (body.channels && typeof body.channels === 'object') patch.channels = body.channels;
      if (typeof body.cancellation_policy === 'string') patch.cancellation_policy = body.cancellation_policy;
      const r = await sb('hl_message_settings?id=eq.true', 'PATCH', patch);
      return res.status(r.ok ? 200 : 500).json({ ok: r.ok, settings: (Array.isArray(r.json) ? r.json : [])[0] });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action: ' + action });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}
