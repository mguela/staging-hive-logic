// api/fieldops.js — Vercel serverless function
//
// FIELD APP OPS — ONE consolidated route (?action=), same discipline as
// api/subportal.js / api/clientportal.js. Frontend: public/field/ (tech) and
// public/track/ (client-facing travel tracking page).
//
// Spec dictated by Chris 2026-07-21:
//   - Tech opens app -> clock-in gate (frontend), fine-print bypass.
//   - Day quick view + all jobs (action=day, enriched with the client's
//     geocoded address from client_locations so the app can navigate).
//   - "Start Travel" on a job -> creates a travel session with an
//     approximate ETA from the tech's live GPS to the job (haversine
//     distance / average driving speed + buffer — computed, never
//     invented, always labeled approximate), returns native-maps
//     directions URLs and a prefilled SMS body with the tracking link.
//   - Client tracking link (action=travel_view, public via capability
//     token) shows a COARSE truck position — coords are rounded to 2
//     decimals (~a half-mile) before leaving the server, per spec: "a very
//     broad location". Exact positions never reach the client page.
//
// HONESTY NOTES (Law #1):
//   - No SMS provider is wired in this codebase, so nothing is auto-sent:
//     travel_start returns the message text + link and the FIELD APP opens
//     the tech's own texting app prefilled. The tech hits send. Client
//     phone numbers are not synced from Jobber yet (clients sync pulls
//     defaultEmails only), so the tech picks the recipient.
//   - ETA is straight-line distance x 1.3 road factor / 28 mph + 4 min
//     buffer. That's an estimate and is labeled "approx" everywhere.

import { supabaseRequest } from './_lib/jobber.js';
import { summarizeBillable, billingWarnings, hlClockToEntries, nativeClockWarnings } from './_lib/tm-billable.js';
import { buildInvoiceOutboxRow } from './_lib/tm-invoice-message.js';
import crypto from 'crypto';
import { authnetConfigured, getHostedPaymentPageToken } from './_lib/authnet.js';
import { crewClockResult, crewForVisit, electLead, jobberIdForEmail, prepareCrewClockIn } from './_lib/crew-clock.js';

const FIELD_DISPATCH_ROLES = new Set(['admin', 'superadmin', 'owner', 'dispatch', 'office_manager']);

async function authorizedVisitContext(staff, visitRef, { wholeTeam = false } = {}) {
  const myJid = await jobberIdForEmail(staff.email);
  if (!myJid) {
    const error = new Error('Your HiveLogic profile is not mapped to a Jobber crew identity.');
    error.status = 403;
    throw error;
  }
  const visit = await crewForVisit(visitRef);
  const isDispatch = FIELD_DISPATCH_ROLES.has(String(staff.role || '').toLowerCase());
  const isAssigned = visit.jids.some((jid) => String(jid) === String(myJid));
  if (!isAssigned && !isDispatch) {
    const error = new Error('You are not assigned to this visit.');
    error.status = 403;
    throw error;
  }
  if (wholeTeam && !isDispatch) {
    const elected = await electLead(visit.jids, visit.leadJid);
    const soloLead = visit.jids.length === 1 && isAssigned;
    if (!soloLead && String(elected || '') !== String(myJid)) {
      const error = new Error('Only the elected crew lead or dispatch can clock the whole team.');
      error.status = 403;
      throw error;
    }
  }
  return { ...visit, myJid, isDispatch };
}

function visitLookupStatus(error) {
  if (error?.status) return error.status;
  if (error?.code === 'VISIT_NOT_FOUND') return 404;
  return 502;
}

function genToken(bytes = 20) {
  return crypto.randomBytes(bytes).toString('hex');
}

async function sb(path, options) {
  const res = await supabaseRequest(path, options);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase error on ${path}: ${res.status} ${body}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${req.headers.host}`;
}

// Short-lived signed URL for a private 'media' bucket object -- same
// pattern public/index.html already uses client-side via
// sb.storage.from('media').createSignedUrl(path, 3600), reimplemented here
// server-side (service key) since this file talks to Supabase over raw
// fetch, not the supabase-js SDK.
async function signMediaUrl(storagePath, expiresIn = 3600) {
  const res = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/sign/media/${storagePath}`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn }),
  });
  if (!res.ok) return null;
  const j = await res.json().catch(() => null);
  if (!j || !j.signedURL) return null;
  return `${process.env.SUPABASE_URL}/storage/v1${j.signedURL}`;
}

// Same staff-auth pattern as api/track1.js getRequestingProfile —
// duplicated on purpose, no cross-file dependency.
async function getStaffProfile(req) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!userRes.ok) return null;
  const user = await userRes.json();
  if (!user || !user.id) return null;
  const profRes = await supabaseRequest(`profiles?id=eq.${user.id}&select=id,email,full_name,role`);
  if (!profRes.ok) return { id: user.id, email: user.email, full_name: null, role: null };
  const rows = await profRes.json();
  return (rows && rows[0]) || { id: user.id, email: user.email, full_name: null, role: null };
}

// ---------------------------------------------------------------------------
// geo helpers
// ---------------------------------------------------------------------------
function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8; // earth radius, miles
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Approximate drive ETA: straight-line x 1.3 road-winding factor, 28 mph
// average local speed, +4 min get-going buffer. An estimate, labeled as one.
function etaMinutes(distMiles) {
  const driveMiles = distMiles * 1.3;
  return Math.max(5, Math.round((driveMiles / 28) * 60 + 4));
}

// Client-facing coordinates are always coarsened to 2 decimal places
// (~0.4-0.7 mi) — "very broad location" per spec.
function coarse(n) {
  return n === null || n === undefined ? null : Math.round(Number(n) * 100) / 100;
}

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

function todayRangeET() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const offsetMs = now - et;
  const startET = new Date(et.getFullYear(), et.getMonth(), et.getDate(), 0, 0, 0);
  const endET = new Date(et.getFullYear(), et.getMonth(), et.getDate(), 23, 59, 59);
  return {
    startISO: new Date(startET.getTime() + offsetMs).toISOString(),
    endISO: new Date(endET.getTime() + offsetMs).toISOString(),
  };
}


// Every clock entry for a job, from BOTH clocks.
//
// The field app writes job_time_entries. The schedule board writes hl_clock,
// keyed to an hl_appointment rather than to the job. A job scheduled and worked
// natively therefore had all of its hours in a table the invoice never read,
// and billed zero. This is the join that was missing.
//
// Used by tm_invoice_prefill AND tm_invoice_create deliberately: when the
// preview and the invoice read through different code they eventually disagree,
// and the number the customer is billed is the one nobody previewed.
export async function billableEntriesForJob(sb, jobRef) {
  const ref = encodeURIComponent(jobRef);
  const own = await sb(`job_time_entries?job_ref=eq.${ref}&select=id,kind,tech_name,started_at,ended_at&order=started_at.asc`) || [];

  // Native side is best-effort: a job with no appointments is the normal case,
  // and a failure here must not stop an invoice the field app can already bill.
  let native = [];
  try {
    const appts = await sb(`hl_appointments?job_ref=eq.${ref}&canceled=eq.false&select=id,title`) || [];
    if (appts.length) {
      const ids = appts.map((a) => `"${a.id}"`).join(',');
      const titleById = Object.fromEntries(appts.map((a) => [String(a.id), a.title || null]));
      const clock = await sb(`hl_clock?target_kind=eq.hl_appointment&target_id=in.(${ids})&select=id,employee_jid,target_id,label,clock_in,clock_out&order=clock_in.asc`) || [];
      native = hlClockToEntries(clock, { apptTitleById: titleById });
    }
  } catch (e) { /* board clock unavailable -- bill what the field app recorded */ }

  return own.concat(native).sort((a, b) => String(a.started_at || '').localeCompare(String(b.started_at || '')));
}

export default async function handler(req, res) {
  const action = req.query.action;

  try {
    // ---------------- PUBLIC: client tracking view ----------------
    if (action === 'travel_view') {
      if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET required' });
      const { t } = req.query;
      if (!t) return res.status(400).json({ ok: false, error: 'token required' });
      const rows = await sb(`travel_sessions?token=eq.${encodeURIComponent(t)}&select=*`);
      const s = rows && rows[0];
      if (!s) return res.status(404).json({ ok: false, error: 'This tracking link is no longer active.' });

      const curLat = num(s.last_lat) ?? num(s.start_lat);
      const curLng = num(s.last_lng) ?? num(s.start_lng);
      let remaining = null;
      if (s.status === 'en_route' && curLat !== null && curLng !== null) {
        remaining = etaMinutes(haversineMiles(curLat, curLng, num(s.dest_lat), num(s.dest_lng)));
      }
      const lastSeen = s.last_ping_at || s.started_at;
      return res.status(200).json({
        ok: true,
        status: s.status,
        techFirstName: (s.tech_name || 'Your tech').split(' ')[0],
        destLat: num(s.dest_lat),
        destLng: num(s.dest_lng),
        destLabel: s.dest_label || null,
        truckLat: coarse(curLat),      // COARSE on purpose — see header
        truckLng: coarse(curLng),
        etaMinutes: remaining,
        lastUpdate: lastSeen,
        staleMinutes: lastSeen ? Math.round((Date.now() - new Date(lastSeen).getTime()) / 60000) : null,
        note: 'Location and arrival time are approximate.',
      });
    }

    // ---------------- T&M: PUBLIC -- client opens the payment link ----------------
    if (action === 'tm_pay_init') {
      if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET required' });
      const { t } = req.query;
      if (!t) return res.status(400).json({ ok: false, error: 'token required' });
      const rows = await sb(`tm_invoices?pay_token=eq.${encodeURIComponent(t)}&select=*`);
      const invoice = rows && rows[0];
      if (!invoice) return res.status(404).json({ ok: false, error: 'This payment link is not valid.' });
      if (invoice.status === 'paid') {
        return res.status(200).json({ ok: true, alreadyPaid: true, invoice: { totalAmount: invoice.total_amount, jobTitle: invoice.job_title, paidAt: invoice.paid_at } });
      }
      if (!authnetConfigured()) {
        return res.status(200).json({ ok: false, error: 'Online payment is not set up yet -- please pay the tech directly or call the office.' });
      }
      const formResult = await getHostedPaymentPageToken({
        amount: invoice.total_amount,
        invoiceNumber: invoice.invoice_number,
        description: invoice.job_title || 'HiveLogic service',
        returnUrl: `${baseUrl(req)}/pay/?t=${t}&done=1`,
      });
      if (!formResult.ok) return res.status(502).json({ ok: false, error: formResult.error });
      return res.status(200).json({
        ok: true,
        formToken: formResult.formToken,
        postUrl: formResult.postUrl,
        invoice: {
          totalAmount: invoice.total_amount,
          // Cash-discount info (null on invoices created before sql/033):
          // the /pay/ page shows the cash/check/ACH price alongside the
          // posted total so both amounts are visible before payment.
          cashAmount: invoice.cash_amount != null ? invoice.cash_amount : null,
          cashDiscount: invoice.card_fee_amount != null ? invoice.card_fee_amount : null,
          jobTitle: invoice.job_title,
          clientName: invoice.client_name,
        },
      });
    }

    
    // MOVED_TM_PAY_INIT_PUBLIC: relocated here (before the staff-auth gate)
    // because this is a public, token-gated, client-facing action -- it must
    // NOT require tech sign-in. Originally spliced in after the gate by
    // mistake; caught by live verification, fixed same-session.
    // ---------------- everything below requires staff (tech) sign-in ----------------
    const staff = await getStaffProfile(req);
    if (!staff) return res.status(401).json({ ok: false, error: 'Not signed in — log into HiveLogic Field first.' });

    // ---------------- tech: today's jobs, enriched for the field ----------------
    if (action === 'day') {
      if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET required' });
      const { startISO, endISO } = todayRangeET();
      const visits = await sb(
        `visits?select=jobber_id,title,start_at,end_at,arrival_window_start,arrival_window_end,visit_status,assigned_users,client_id,job_id` +
        `&end_at=gte.${encodeURIComponent(startISO)}&start_at=lte.${encodeURIComponent(endISO)}&order=start_at.asc`
      );
      const myName = String(staff.full_name || '').trim().toLowerCase();
      const mine = visits.filter((v) => {
        let assigned = [];
        try { assigned = typeof v.assigned_users === 'string' ? JSON.parse(v.assigned_users) : (v.assigned_users || []); } catch (e) { assigned = []; }
        return myName && assigned.some((p) => String(p.name || '').trim().toLowerCase() === myName);
      });

      const clientIds = [...new Set(mine.map((v) => v.client_id).filter(Boolean))];
      let clientsById = {}, locsById = {};
      if (clientIds.length) {
        const inList = clientIds.map((id) => `"${id}"`).join(',');
        const [clients, locs] = await Promise.all([
          sb(`clients?jobber_id=in.(${inList})&select=jobber_id,name,email`),
          sb(`client_locations?jobber_id=in.(${inList})&select=jobber_id,street,city,province,lat,lng`),
        ]);
        clientsById = Object.fromEntries(clients.map((c) => [c.jobber_id, c]));
        locsById = Object.fromEntries(locs.map((l) => [l.jobber_id, l]));
      }

      const jobs = mine.map((v) => {
        const c = clientsById[v.client_id] || {};
        const loc = locsById[v.client_id] || {};
        return {
          visitRef: v.jobber_id,
          jobRef: v.job_id,
          clientRef: v.client_id,
          title: v.title,
          clientName: c.name || null,
          startAt: v.start_at,
          endAt: v.end_at,
          arrivalWindowStart: v.arrival_window_start,
          arrivalWindowEnd: v.arrival_window_end,
          status: v.visit_status || null,
          address: [loc.street, loc.city].filter(Boolean).join(', ') || null,
          lat: num(loc.lat),
          lng: num(loc.lng),
          reported: false,
        };
      });

      // T&M (Chris's ask, 2026-07-21/22): merge in the real is_tm/rate flag
      // from job_workflow so the app can show "Generate Invoice" only on
      // jobs actually flagged as T&M. Best-effort -- if job_workflow isn't
      // reachable for some reason, jobs just render without the T&M button.
      try {
        const jobRefs = [...new Set(jobs.map((j) => j.jobRef).filter(Boolean))];
        if (jobRefs.length) {
          const inList = jobRefs.map((id) => `"${id}"`).join(',');
          const wf = await sb(`job_workflow?job_ref=in.(${inList})&select=job_ref,is_tm,tm_service_type,tm_rate_hourly`);
          const wfByRef = Object.fromEntries(wf.map((w) => [w.job_ref, w]));
          jobs.forEach((j) => {
            const w = wfByRef[j.jobRef];
            j.isTm = !!(w && w.is_tm);
            j.tmServiceType = (w && w.tm_service_type) || null;
            j.tmRateHourly = (w && w.tm_rate_hourly != null) ? Number(w.tm_rate_hourly) : null;
          });
        }
      } catch (e) { /* job_workflow lookup best-effort, day still loads */ }

      // Auto-fill (never invent) hours worked so far, computed from this
      // tech's own onsite clock segments for each job -- shown as a
      // starting point on the T&M invoice screen, always still editable.
      try {
        const jobRefs2 = [...new Set(jobs.map((j) => j.jobRef).filter(Boolean))];
        if (jobRefs2.length) {
          const inList2 = jobRefs2.map((id) => `"${id}"`).join(',');
          const entries = await sb(`job_time_entries?tech_id=eq.${staff.id}&kind=eq.onsite&job_ref=in.(${inList2})&select=job_ref,started_at,ended_at`);
          const nowMs = Date.now();
          const msByRef = {};
          entries.forEach((e) => {
            if (!e.job_ref) return;
            const startMs = new Date(e.started_at).getTime();
            const endMs = e.ended_at ? new Date(e.ended_at).getTime() : nowMs;
            const dur = Math.max(0, endMs - startMs);
            msByRef[e.job_ref] = (msByRef[e.job_ref] || 0) + dur;
          });
          jobs.forEach((j) => {
            const ms = msByRef[j.jobRef];
            j.clockedHours = ms ? Math.round((ms / 3600000) * 100) / 100 : null;
          });
        }
      } catch (e) { /* job_time_entries lookup best-effort, day still loads */ }

      // Which of today's jobs already have an end-of-job report? (Gates
      // clock-out in the app.) Best-effort: if the reports table isn't
      // migrated yet, the day still loads.
      try {
        const reps = await sb(`field_job_reports?tech_id=eq.${staff.id}&created_at=gte.${encodeURIComponent(startISO)}&select=visit_ref`);
        const done = new Set(reps.map((r) => r.visit_ref).filter(Boolean));
        jobs.forEach((j) => { j.reported = done.has(j.visitRef); });
      } catch (e) { /* table not migrated yet — treat all as unreported */ }

      // Client sign-off captured on any of today's jobs (013_job_signatures.sql).
      // Best-effort, same migration caveat as above -- if the table isn't
      // there yet, jobs just render with no signature (Get Signature button
      // stays available, nothing breaks).
      try {
        const jobRefs3 = [...new Set(jobs.map((j) => j.jobRef).filter(Boolean))];
        if (jobRefs3.length) {
          const inList3 = jobRefs3.map((id) => `"${id}"`).join(',');
          const sigs = await sb(`job_signatures?job_id=in.(${inList3})&order=signed_at.desc&select=job_id,visit_id,signed_name,storage_path,signed_at`);
          const sigByVisit = {};
          const sigByJob = {};
          sigs.forEach((s) => {
            if (s.visit_id && !sigByVisit[s.visit_id]) sigByVisit[s.visit_id] = s;
            if (!sigByJob[s.job_id]) sigByJob[s.job_id] = s;
          });
          await Promise.all(jobs.map(async (j) => {
            const s = sigByVisit[j.visitRef] || sigByJob[j.jobRef];
            if (!s) return;
            const url = await signMediaUrl(s.storage_path);
            if (!url) return;
            j.signature = { signedBy: s.signed_name, signedAt: s.signed_at, url };
          }));
        }
      } catch (e) { /* table not migrated yet — sign-off button just stays available */ }

      // The tech's currently running time entry (travel / supplies / onsite /
      // lunch / break) so the app can restore the right job screen after a
      // reload. Best-effort, same migration caveat.
      let activeEntry = null;
      try {
        const act = await sb(`job_time_entries?tech_id=eq.${staff.id}&ended_at=is.null&order=started_at.desc&limit=1&select=*`);
        activeEntry = (act && act[0]) || null;
      } catch (e) { /* table not migrated yet */ }
      return res.status(200).json({
        ok: true,
        jobs,
        activeEntry,
        employeeName: staff.full_name || null,
        role: staff.role || null,
        note: myName ? null : 'Your HiveLogic profile has no full name set, so visits cannot be matched to you yet.',
      });
    }

    // ---------------- tech: start travel ----------------
    if (action === 'travel_start') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const { client_ref, job_ref, visit_ref, cur_lat, cur_lng } = req.body || {};
      if (!client_ref) return res.status(400).json({ ok: false, error: 'client_ref is required' });
      if (cur_lat === undefined || cur_lng === undefined) {
        return res.status(400).json({ ok: false, error: 'Your location is required to estimate arrival — allow location access and try again.' });
      }
      const locs = await sb(`client_locations?jobber_id=eq.${encodeURIComponent(client_ref)}&select=street,city,lat,lng`);
      const loc = locs && locs[0];
      if (!loc || loc.lat === null || loc.lng === null) {
        return res.status(400).json({ ok: false, error: "This client's address hasn't been geocoded yet, so travel tracking can't estimate a route. Navigate manually for this one." });
      }

      const dist = haversineMiles(Number(cur_lat), Number(cur_lng), Number(loc.lat), Number(loc.lng));
      const eta = etaMinutes(dist);
      const token = genToken();
      const destLabel = [loc.street, loc.city].filter(Boolean).join(', ');

      await sb('travel_sessions', {
        method: 'POST',
        body: JSON.stringify({
          tech_id: staff.id,
          tech_name: staff.full_name || staff.email,
          job_ref: job_ref || null,
          visit_ref: visit_ref || null,
          client_ref,
          token,
          dest_lat: loc.lat,
          dest_lng: loc.lng,
          dest_label: destLabel,
          start_lat: cur_lat,
          start_lng: cur_lng,
          last_lat: cur_lat,
          last_lng: cur_lng,
          eta_minutes: eta,
          distance_miles: Math.round(dist * 10) / 10,
          last_ping_at: new Date().toISOString(),
        }),
      });

      const trackUrl = `${baseUrl(req)}/track/?t=${token}`;
      const firstName = (staff.full_name || 'your technician').split(' ')[0];
      const smsBody = `Hi! It's ${firstName} from GH Group — I'm on my way to you now, about ${eta} minutes out. You can follow my progress here: ${trackUrl}`;

      // AUTO-notify (Chris spec: "no button needed"): the ETA + tracking
      // link lands in the client's portal notification feed automatically.
      // SMS still needs the tech's tap (no SMS provider wired — the app
      // auto-opens the composer instead).
      supabaseRequest('client_notifications', {
        method: 'POST',
        body: JSON.stringify({
          client_ref,
          type: 'job_update',
          title: `🛻 ${firstName} is on the way`,
          body: `About ${eta} minutes out. Tap to watch the arrival live.`,
          action_url: trackUrl,
        }),
      }).catch(() => {});

      return res.status(200).json({
        ok: true,
        token,
        trackUrl,
        etaMinutes: eta,
        distanceMiles: Math.round(dist * 10) / 10,
        destLabel,
        smsBody,
        maps: {
          google: `https://www.google.com/maps/dir/?api=1&destination=${loc.lat},${loc.lng}`,
          apple: `https://maps.apple.com/?daddr=${loc.lat},${loc.lng}&dirflg=d`,
        },
        note: 'Auto-texting is not wired yet — the app opens your texting app with this message prefilled; you hit send.',
      });
    }

    // ---------------- tech: location ping while en route ----------------
    if (action === 'travel_ping') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const { token, lat, lng } = req.body || {};
      if (!token || lat === undefined || lng === undefined) return res.status(400).json({ ok: false, error: 'token, lat, lng required' });
      const updated = await sb(`travel_sessions?token=eq.${encodeURIComponent(token)}&tech_id=eq.${staff.id}&status=eq.en_route`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ last_lat: lat, last_lng: lng, last_ping_at: new Date().toISOString() }),
      });
      if (!updated.length) return res.status(404).json({ ok: false, error: 'No active travel session.' });
      const s = updated[0];
      const remaining = etaMinutes(haversineMiles(Number(lat), Number(lng), Number(s.dest_lat), Number(s.dest_lng)));
      return res.status(200).json({ ok: true, etaMinutes: remaining });
    }

    // ---------------- tech: arrived / cancel ----------------
    if (action === 'travel_end') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const { token, outcome } = req.body || {};
      if (!token) return res.status(400).json({ ok: false, error: 'token required' });
      const status = outcome === 'canceled' ? 'canceled' : 'arrived';
      const updated = await sb(`travel_sessions?token=eq.${encodeURIComponent(token)}&tech_id=eq.${staff.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ status, arrived_at: status === 'arrived' ? new Date().toISOString() : null }),
      });
      if (!updated.length) return res.status(404).json({ ok: false, error: 'No travel session found.' });
      return res.status(200).json({ ok: true, status });
    }

    // ---------------- tech: time tracking (travel/supplies/onsite/lunch/break) ----------------
    if (action === 'time_start') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const { job_ref, visit_ref, client_ref, kind, whole_team, note } = req.body || {};
      if (!['travel', 'supplies', 'onsite', 'lunch', 'break'].includes(kind)) {
        return res.status(400).json({ ok: false, error: 'Unknown time kind.' });
      }
      if ((job_ref || client_ref || whole_team) && !visit_ref) {
        return res.status(400).json({ ok: false, error: 'A visit is required for job or whole-team time.' });
      }

      let visitContext = null;
      if (visit_ref) {
        try {
          visitContext = await authorizedVisitContext(staff, visit_ref, {
            wholeTeam: Boolean(whole_team && kind === 'onsite'),
          });
        } catch (error) {
          return res.status(visitLookupStatus(error)).json({ ok: false, error: error.message });
        }
        if (job_ref && String(job_ref) !== String(visitContext.jobId || '')) {
          return res.status(409).json({ ok: false, error: 'The job does not match this visit.' });
        }
        if (client_ref && String(client_ref) !== String(visitContext.clientId || '')) {
          return res.status(409).json({ ok: false, error: 'The client does not match this visit.' });
        }
      }
      // "WHOLE TEAM" used to be nothing but the boolean above — one row for the
      // person holding the phone, so a lead starting a 3-person job produced ONE
      // time record. Payroll pays people, so the lead's tap now also clocks each
      // chained crew member into hl_clock with their own row (owner decision,
      // 2026-08-17). job_time_entries keeps its own job: this tech's activity kind
      // and the T&M billing meter that reads it.
      let preparedCrew = null;
      if (whole_team && kind === 'onsite' && visit_ref) {
        try {
          const { jids, leadJid, myJid } = visitContext;
          if (!jids.length) {
            return res.status(409).json({ ok: false, error: 'No crew is assigned to this visit, so nobody was clocked in.' });
          }
          preparedCrew = await prepareCrewClockIn({
              employees: jids,
              leadJid: leadJid || myJid,       // the person tapping is the lead unless dispatch elected one
              source: 'field',
              targetKind: 'jobber_visit',
              targetId: visit_ref,
              label: client_ref || null,
              who: staff.email || staff.id,
          });
          if (!preparedCrew.ok) throw new Error(preparedCrew.error || 'Crew preparation failed.');
        } catch (e) {
          return res.status(502).json({ ok: false, error: 'Crew clock-in could not be prepared, so nobody was changed.' });
        }
      }

      // The tech activity and optional per-person crew rows commit together.
      // A failure cannot leave the phone user clocked in while their crew is
      // absent, or close old sessions without opening the requested new ones.
      const started = await sb('rpc/hl_field_time_start', {
        method: 'POST',
        body: JSON.stringify({
          p_entry: {
            tech_id: staff.id,
            tech_name: staff.full_name || staff.email,
            job_ref: visitContext ? visitContext.jobId : null,
            visit_ref: visit_ref || null,
            client_ref: visitContext ? visitContext.clientId : null,
            kind,
            whole_team: Boolean(whole_team),
            note: note || null,
          },
          p_crew_rows: preparedCrew ? preparedCrew.rows : [],
        }),
      });
      if (!started || !started.entry) throw new Error('Atomic field clock returned no activity row.');
      const crewClock = preparedCrew ? crewClockResult(preparedCrew, started.clock) : null;
      if (preparedCrew && !crewClock.ok) throw new Error('Atomic field clock returned an incomplete crew.');
      return res.status(200).json({ ok: true, entry: started.entry, crewClock });
    }

    if (action === 'time_stop') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      // Mirror of the whole-team start: the lead stopping the job takes the crew
      // off the clock too, each on their own hl_clock row.
      let crewJids = [];
      const stopWholeTeam = (req.body || {}).whole_team, stopVisit = (req.body || {}).visit_ref;
      if (stopWholeTeam && !stopVisit) {
        return res.status(400).json({ ok: false, error: 'A visit is required to clock out the whole team.' });
      }
      if (stopWholeTeam && stopVisit) {
        try {
          const { jids } = await authorizedVisitContext(staff, stopVisit, { wholeTeam: true });
          if (!jids.length) {
            return res.status(409).json({ ok: false, error: 'No crew is assigned to this visit, so nobody was clocked out.' });
          }
          crewJids = jids;
        } catch (e) {
          return res.status(visitLookupStatus(e)).json({ ok: false, error: e.message });
        }
      }
      const stopped = await sb('rpc/hl_field_time_stop', {
        method: 'POST',
        body: JSON.stringify({
          p_tech_id: staff.id,
          p_crew_jids: crewJids,
          p_target_id: stopWholeTeam ? stopVisit : null,
        }),
      });
      const crewClock = stopWholeTeam ? { ok: true, changed: Number(stopped?.crew_changed || 0) } : null;
      return res.status(200).json({ ok: true, closed: Number(stopped?.closed || 0), crewClock });
    }

    // ---------------- tech: requests/messages fired from the job screen ----------------
    if (action === 'request_create') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const { kind, job_ref, visit_ref, client_ref, payload } = req.body || {};
      if (!['more_time', 'materials', 'extra_work', 'office_msg', 'client_msg', 'job_status', 'note'].includes(kind)) {
        return res.status(400).json({ ok: false, error: 'Unknown request kind.' });
      }
      const created = await sb('field_requests', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          tech_id: staff.id,
          tech_name: staff.full_name || staff.email,
          job_ref: job_ref || null,
          visit_ref: visit_ref || null,
          client_ref: client_ref || null,
          kind,
          payload: payload || null,
        }),
      });
      // Client messages also land in the client's real portal thread —
      // that's actual delivery, not a pretend send (SMS still not wired).
      if (kind === 'client_msg' && client_ref && payload && payload.message) {
        supabaseRequest('client_messages', {
          method: 'POST',
          body: JSON.stringify({ client_ref, job_ref: job_ref || null, sender: 'staff', body: payload.message }),
        }).catch(() => {});
      }
      return res.status(200).json({ ok: true, request: created[0] });
    }

    // ---------------- tech: photos & notes -> HiveSight, with optional AI equipment read ----------------
    if (action === 'photo_add') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const { job_ref, data_url, note, analyze } = req.body || {};
      if (!job_ref || !data_url) return res.status(400).json({ ok: false, error: 'job_ref and data_url are required' });
      const match = /^data:([^;]+);base64,(.+)$/.exec(data_url);
      if (!match) return res.status(400).json({ ok: false, error: 'Expected a base64 data URL from the camera.' });
      const [, contentType, b64] = match;

      // straight into HiveSight: private 'media' bucket + media row keyed to
      // the job, stamped with capture time — shows up in Visual Intelligence
      const storagePath = `${job_ref}/field-${Date.now()}.jpg`;
      const up = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/media/${storagePath}`, {
        method: 'POST',
        headers: {
          apikey: process.env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
          'Content-Type': contentType,
          'x-upsert': 'true',
        },
        body: Buffer.from(b64, 'base64'),
      });
      if (!up.ok) return res.status(502).json({ ok: false, error: `Photo upload failed: ${await up.text()}` });

      const mediaRows = await sb('media', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          job_id: job_ref,
          media_type: 'PHOTO',
          storage_path: storagePath,
          mime_type: contentType,
          captured_at: new Date().toISOString(),
          uploaded_by: staff.id,
        }),
      });
      const media = mediaRows[0];

      if (note) {
        supabaseRequest('media_comments', {
          method: 'POST',
          body: JSON.stringify({ media_id: media.id, body: note, created_by: staff.id }),
        }).catch(() => {});
      }

      // Optional AI equipment read (Chris spec): real Claude vision pass —
      // manufacturer, model, serial, specs FROM THE TAG ONLY, no guessing.
      // Result is stored in media_analysis (the table built for exactly
      // this) and returned to the tech to eyeball.
      let analysis = null;
      if (analyze) {
        if (!process.env.ANTHROPIC_API_KEY) {
          analysis = { ok: false, note: 'AI reading is not configured yet (no ANTHROPIC_API_KEY on the server).' };
        } else {
          try {
            const { default: Anthropic } = await import('@anthropic-ai/sdk');
            const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
            const modelName = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
            const msg = await anthropic.messages.create({
              model: modelName,
              max_tokens: 600,
              messages: [{
                role: 'user',
                content: [
                  { type: 'image', source: { type: 'base64', media_type: contentType, data: b64 } },
                  { type: 'text', text: 'You are documenting equipment for a contractor\'s job record. Identify the equipment in this photo. If a data plate/tag/label is visible, read it EXACTLY: manufacturer, model number, serial number, and any specs (voltage, BTU, tonnage, capacity, date of manufacture). Only report what you can actually see or read — if something is not visible or not legible, say "not visible" for that field. Do not guess. Reply as short labeled lines: Equipment, Manufacturer, Model, Serial, Specs, Condition notes.' },
                ],
              }],
            });
            const text = msg.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
            await supabaseRequest('media_analysis', {
              method: 'POST',
              body: JSON.stringify({ media_id: media.id, description: text, model: modelName, analyzed_at: new Date().toISOString() }),
            }).catch(() => {});
            analysis = { ok: true, text };
          } catch (e) {
            analysis = { ok: false, note: `AI read failed: ${e.message}` };
          }
        }
      }

      return res.status(200).json({ ok: true, media, analysis });
    }

    // ---------------- tech: client sign-off on the job (013_job_signatures.sql) ----------------
    // Same upload pattern as photo_add (private 'media' bucket, service-key
    // upload), separate table (job_signatures) rather than reusing `media`
    // directly, since media.media_type is constrained to ('PHOTO','VIDEO')
    // and a signature isn't a job-site photo -- keeping it out of
    // HiveSight/Visual Intelligence's photo stream on purpose.
    if (action === 'signature_save') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const { job_ref, visit_ref, data_url, signed_name } = req.body || {};
      if (!job_ref || !data_url || !signed_name) return res.status(400).json({ ok: false, error: 'job_ref, data_url, and signed_name are required' });
      const match = /^data:([^;]+);base64,(.+)$/.exec(data_url);
      if (!match) return res.status(400).json({ ok: false, error: 'Expected a base64 PNG data URL from the signature pad.' });
      const [, contentType, b64] = match;

      const storagePath = `${job_ref}/signature-${Date.now()}.png`;
      const up = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/media/${storagePath}`, {
        method: 'POST',
        headers: {
          apikey: process.env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
          'Content-Type': contentType,
          'x-upsert': 'true',
        },
        body: Buffer.from(b64, 'base64'),
      });
      if (!up.ok) return res.status(502).json({ ok: false, error: `Signature upload failed: ${await up.text()}` });

      let signedAt = new Date().toISOString();
      try {
        const rows = await sb('job_signatures', {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({
            job_id: job_ref,
            visit_id: visit_ref || null,
            signed_name,
            storage_path: storagePath,
            signed_at: signedAt,
            captured_by: staff.id,
          }),
        });
        if (rows && rows[0]) signedAt = rows[0].signed_at;
      } catch (e) {
        return res.status(200).json({ ok: false, error: 'Signature image saved, but the job_signatures table isn\'t set up yet — ask Chris to run sql/013_job_signatures.sql in Supabase, then try again.' });
      }

      const url = await signMediaUrl(storagePath);
      return res.status(200).json({ ok: true, signature: { signedBy: signed_name, signedAt, url } });
    }

    // ---------------- tech: save (tech-confirmed) equipment info on a photo ----------------
    // The AI read pre-fills these fields; the tech can correct or fill them
    // by hand — what gets saved is what the TECH confirmed, marked as such.
    if (action === 'equipment_save') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const { media_id, equipment } = req.body || {};
      if (!media_id || !equipment || typeof equipment !== 'object') {
        return res.status(400).json({ ok: false, error: 'media_id and equipment fields are required' });
      }
      const lines = ['equipment', 'manufacturer', 'model_number', 'serial', 'specs', 'notes']
        .filter((k) => equipment[k])
        .map((k) => `${k.replace('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase())}: ${equipment[k]}`);
      if (!lines.length) return res.status(400).json({ ok: false, error: 'Fill in at least one field.' });
      const description = `EQUIPMENT RECORD (tech-confirmed)\n${lines.join('\n')}`;

      // one analysis row per media (unique index) — merge-upsert
      await sb('media_analysis?on_conflict=media_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({ media_id, description, analyzed_at: new Date().toISOString() }),
      });
      return res.status(200).json({ ok: true });
    }

    // ---------------- tech: per-job wrap-up report (replaces day-level EOD;
    // Chris 2026-07-21: "EOD report should be on the clock of each job, not
    // clock out for the day") ----------------
    if (action === 'job_report') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const { job_ref, visit_ref, client_ref, job_title, report_type, answers, notes, hours } = req.body || {};
      if (!['service', 'renovation'].includes(report_type)) {
        return res.status(400).json({ ok: false, error: "Pick the job type first — Repair/Service or Renovation." });
      }
      if (!answers || typeof answers !== 'object' || !Object.keys(answers).length) {
        return res.status(400).json({ ok: false, error: 'Answer the questions before submitting.' });
      }
      const created = await sb('field_job_reports', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          tech_id: staff.id,
          tech_name: staff.full_name || staff.email,
          job_ref: job_ref || null,
          visit_ref: visit_ref || null,
          client_ref: client_ref || null,
          job_title: job_title || null,
          report_type,
          answers,
          tasks_completed: notes || null,
          hours: num(hours),
        }),
      });
      return res.status(200).json({ ok: true, report: created[0] });
    }

    
    // ---------------- T&M: tech generates an invoice ----------------
    // What the clock says this job is worth, before anyone types a number.
    // Read-only: it raises no invoice, so the tech can look before committing.
    if (action === 'tm_invoice_prefill') {
      if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET required' });
      const staff = await getStaffProfile(req);
      if (!staff) return res.status(401).json({ ok: false, error: 'Not signed in.' });
      const jobRef = (req.query && req.query.jobRef) || '';
      if (!jobRef) return res.status(400).json({ ok: false, error: 'jobRef is required.' });
      const entries = await billableEntriesForJob(sb, jobRef);
      const summary = summarizeBillable(entries);
      return res.status(200).json({
        ok: true, ...summary,
        warnings: billingWarnings(summary).concat(nativeClockWarnings(entries)),
      });
    }

    if (action === 'tm_invoice_create') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const staff = await getStaffProfile(req);
      if (!staff) return res.status(401).json({ ok: false, error: 'Not signed in.' });
      const { jobRef, hours, materialsAmount, notes } = req.body || {};
      if (!jobRef) return res.status(400).json({ ok: false, error: 'jobRef is required.' });
      // The clock is the default source of truth. A tech may still override --
      // a customer agrees to knock half an hour off, a legitimate correction --
      // but the measured figure is recorded alongside so the invoice can always
      // be reconciled against what actually happened.
      const clockEntries = await billableEntriesForJob(sb, jobRef);
      const clock = summarizeBillable(clockEntries);
      const suppliedHours = num(hours);
      const hrs = suppliedHours > 0 ? suppliedHours : clock.hours;
      if (!(hrs > 0)) {
        return res.status(400).json({
          ok: false,
          error: clock.entryCount
            ? 'No billable time is recorded against this job yet, so there are no hours to invoice.'
            : 'Hours must be a positive number, and nothing is on either clock for this job '
              + '(the field app or the schedule board).',
          clock, warnings: billingWarnings(clock),
        });
      }
      const materials = num(materialsAmount) || 0;
      if (materials < 0) return res.status(400).json({ ok: false, error: 'Materials amount cannot be negative.' });

      const wfRows = await sb(`job_workflow?job_ref=eq.${encodeURIComponent(jobRef)}&select=is_tm,tm_rate_hourly`);
      const wf = wfRows && wfRows[0];
      if (!wf || !wf.is_tm || !(Number(wf.tm_rate_hourly) > 0)) {
        return res.status(400).json({ ok: false, error: 'This job is not flagged as T&M, or has no rate set.' });
      }
      const rate = Number(wf.tm_rate_hourly);
      const labor = Math.round(hrs * rate * 100) / 100;
      // Cash-discount pricing (Chris, 2026-07-26): rates never change — the
      // merchant-fee amount is built in automatically at the bottom, and
      // cash/check/ACH payers get it back as a discount. cash_amount is the
      // normal price (labor + materials); total_amount is the POSTED total
      // (fee included) — what's displayed and what a card payment charges.
      // Client-facing copy must say "cash discount", never "card fee" —
      // CT bans surcharges; cash discounts are legal in CT + NY (framing
      // documented in server/bookkeeping/src/card-pricing.js).
      const cardRateBps = Math.round(Number(process.env.CARD_RATE_BPS || 400));
      const cashAmount = Math.round((labor + materials) * 100) / 100;
      const cardFee = Math.round(cashAmount * cardRateBps / 10000 * 100) / 100;
      const total = Math.round((cashAmount + cardFee) * 100) / 100;

      let job = {};
      try {
        const jobRows = await sb(`jobs?jobber_id=eq.${encodeURIComponent(jobRef)}&select=title,client_id`);
        job = (jobRows && jobRows[0]) || {};
      } catch (e) { /* best-effort display info only */ }
      let clientName = null;
      if (job.client_id) {
        try {
          const cRows = await sb(`clients?jobber_id=eq.${encodeURIComponent(job.client_id)}&select=name`);
          clientName = (cRows && cRows[0] && cRows[0].name) || null;
        } catch (e) { /* best-effort */ }
      }

      const invoiceNumber = 'TM-' + Date.now().toString(36).toUpperCase();
      const payToken = genToken();
      const basePayload = {
        invoice_number: invoiceNumber,
        job_ref: jobRef,
        client_id: job.client_id || null,
        client_name: clientName,
        job_title: job.title || null,
        hours: hrs,
        rate_hourly: rate,
        labor_amount: labor,
        materials_amount: materials,
        total_amount: total,
        notes: notes || null,
        status: 'pending',
        pay_token: payToken,
        created_by: staff.id,
        created_by_name: staff.full_name || staff.email,
      };
      let created;
      let cardPricingActive = true;
      try {
        created = await sb('tm_invoices', {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ ...basePayload, card_rate_bps: cardRateBps, card_fee_amount: cardFee, cash_amount: cashAmount }),
        });
      } catch (e) {
        // sql/033_card_pricing.sql not run yet on this environment — fall
        // back HONESTLY to the pre-card-pricing invoice (normal price, no
        // fee, no discount) rather than failing the tech in the field.
        if (!/card_rate_bps|card_fee_amount|cash_amount|column/i.test(String(e.message))) throw e;
        cardPricingActive = false;
        created = await sb('tm_invoices', {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ ...basePayload, total_amount: cashAmount }),
        });
      }
      const invoice = created[0];
      const payUrl = `${baseUrl(req)}/pay/?t=${payToken}`;
      const smsBody = cardPricingActive
        ? `Hi! Here's your invoice for ${job.title || 'your service'}: $${total.toFixed(2)}. Pay securely here: ${payUrl} — or save $${cardFee.toFixed(2)} with our cash discount: $${cashAmount.toFixed(2)} by cash or check to your tech.`
        : `Hi! Here's your invoice for ${job.title || 'your service'}: $${cashAmount.toFixed(2)}. Pay securely here: ${payUrl}`;
      // Queue the invoice for delivery through the same gated, logged, retrying
      // path as every other client message, instead of relying on the tech to
      // tap send on their own phone. Best-effort by design: the invoice exists
      // and is payable whether or not this succeeds, so a queueing failure is
      // reported, never fatal. The sms: link below stays as the fallback.
      let delivery = { queued: false, reason: null };
      try {
        let clientEmail = null;
        if (invoice.client_id) {
          const cRows = await sb(`clients?jobber_id=eq.${encodeURIComponent(invoice.client_id)}&select=email`);
          clientEmail = (cRows && cRows[0] && cRows[0].email) || null;
        }
        const built = buildInvoiceOutboxRow({ invoice, payUrl, cardPricingActive, clientEmail });
        if (built.skipped) {
          delivery = { queued: false, reason: built.skipped };
        } else {
          const q = await sb('hl_outbox', { method: 'POST', body: JSON.stringify(built.row) });
          // The unique dedupe_key means a retry of the same invoice is a
          // no-op rather than a second email to the customer.
          delivery = { queued: Array.isArray(q) ? q.length > 0 : true, reason: null };
        }
      } catch (e) {
        delivery = { queued: false, reason: 'could not queue the email: ' + (e && e.message ? e.message : String(e)) };
      }

      const overridden = suppliedHours > 0 && Math.abs(suppliedHours - clock.hours) > 0.001;
      return res.status(200).json({
        ok: true,
        invoice,
        clock,
        hoursSource: overridden ? 'entered' : (suppliedHours > 0 ? 'entered-matches-clock' : 'clock'),
        delivery,
        warnings: billingWarnings(clock)
          .concat(nativeClockWarnings(clockEntries))
          .concat(
            overridden
              ? [`Invoiced ${hrs}h, the clock recorded ${clock.hours}h billable.`]
              : [],
          ),
        cardPricingActive,
        note: cardPricingActive ? undefined : 'Card pricing is not active yet — run sql/033_card_pricing.sql, then new invoices will include it.',
        payUrl,
        smsHref: 'sms:?&body=' + encodeURIComponent(smsBody),
      });
    }

    // ---------------- T&M: staff records an offline (cash-discount) payment ----------------
    // The card path is marked paid ONLY by the signature-verified Authorize.Net
    // webhook. This action is the offline sibling: the tech physically
    // received cash or a check (or the office confirmed an ACH), at the
    // discounted cash_amount. Staff-gated, records who marked it and how.
    if (action === 'tm_invoice_mark_paid_offline') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const staffOffline = await getStaffProfile(req);
      if (!staffOffline) return res.status(401).json({ ok: false, error: 'Not signed in.' });
      const { id, method } = req.body || {};
      if (!id) return res.status(400).json({ ok: false, error: 'id is required.' });
      const allowedMethods = ['cash', 'check', 'ach'];
      const payMethod = String(method || '').trim().toLowerCase();
      if (!allowedMethods.includes(payMethod)) {
        return res.status(400).json({ ok: false, error: 'method must be cash, check, or ach. Card payments are confirmed automatically by the payment processor.' });
      }
      const invRows = await sb(`tm_invoices?id=eq.${encodeURIComponent(id)}&select=*`);
      const inv = invRows && invRows[0];
      if (!inv) return res.status(404).json({ ok: false, error: 'Invoice not found.' });
      if (inv.status === 'paid') return res.status(200).json({ ok: true, alreadyPaid: true });
      const paidAmount = inv.cash_amount != null ? inv.cash_amount : inv.total_amount;
      try {
        await sb(`tm_invoices?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({
            status: 'paid',
            paid_method: payMethod,
            paid_amount: paidAmount,
            paid_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            notes: ((inv.notes || '') + `\n[offline payment] ${payMethod} for $${Number(paidAmount).toFixed(2)}, recorded by ${staffOffline.full_name || staffOffline.email}`).trim(),
          }),
        });
      } catch (e) {
        // sql/033 not run yet — record what we can without the new columns.
        if (!/paid_method|paid_amount|column/i.test(String(e.message))) throw e;
        await sb(`tm_invoices?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({
            status: 'paid',
            paid_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            notes: ((inv.notes || '') + `\n[offline payment] ${payMethod} for $${Number(paidAmount).toFixed(2)}, recorded by ${staffOffline.full_name || staffOffline.email}`).trim(),
          }),
        });
      }
      return res.status(200).json({ ok: true, paidAmount, method: payMethod });
    }

    // ---------------- T&M: staff polls invoice status ----------------
    if (action === 'tm_invoice_status') {
      if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET required' });
      const staff = await getStaffProfile(req);
      if (!staff) return res.status(401).json({ ok: false, error: 'Not signed in.' });
      const { id } = req.query;
      if (!id) return res.status(400).json({ ok: false, error: 'id is required.' });
      const rows = await sb(`tm_invoices?id=eq.${encodeURIComponent(id)}&select=id,status,total_amount,paid_at`);
      const invoice = rows && rows[0];
      if (!invoice) return res.status(404).json({ ok: false, error: 'Invoice not found.' });
      return res.status(200).json({ ok: true, invoice });
    }

return res.status(400).json({ ok: false, error: `Unknown action "${action}"` });
  } catch (e) {
    console.error('fieldops error:', e);
    return res.status(502).json({ ok: false, error: e.message });
  }
}
