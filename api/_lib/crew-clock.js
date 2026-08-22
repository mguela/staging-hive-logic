// api/_lib/crew-clock.js
// Crew chaining + group clock, shared by the dispatch board (api/schedule/hl.js)
// and the field app (api/fieldops.js).
//
// Owner decision (2026-08-17): hl_clock is the per-person record of WHO was on
// the clock. It is the payroll answer, and a group clock-in writes one row per
// crew member — never one row with a "whole team" flag on it, which is what the
// field app used to do and why a lead's tap produced a single record instead of
// N. job_time_entries keeps its separate job: per-job activity kind (travel /
// supplies / onsite / lunch / break) and the T&M billing meter that reads it.
import { supabaseRequest } from './jobber.js';
import { VEHICLE_GPS_COLUMNS, vehicleGps } from './vehicle-gps.js';

export const NEAR_LEAD_METERS = 500;   // ~0.3mi, the arrival radius track1 already uses

async function sb(path, method, body) {
  const opts = { method: method || 'GET' };
  if (body) opts.body = JSON.stringify(body);
  if (method && method !== 'GET') opts.headers = { Prefer: 'return=representation' };
  const r = await supabaseRequest(path, opts);
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) {}
  return { ok: r.ok, status: r.status, json };
}
const arr = (r) => (Array.isArray(r.json) ? r.json : []);
const inList = (a) => a.map((e) => '"' + encodeURIComponent(String(e)) + '"').join(',');

export function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// The crew actually on a Jobber visit right now: whoever Jobber assigned, with
// HiveLogic's chain/unchain overrides applied on top.
export async function crewForVisit(visitJid) {
  const out = { jids: [], leadJid: null, jobId: null, clientId: null };
  if (!visitJid) return out;
  const [vr, or_] = await Promise.all([
    sb(`visits?jobber_id=eq.${encodeURIComponent(visitJid)}&select=assigned_users,job_id,client_id&limit=1`),
    sb(`hl_crew_overrides?visit_jid=eq.${encodeURIComponent(visitJid)}&select=*`),
  ]);
  if (!vr.ok || !or_.ok) {
    const error = new Error('Crew assignment data is temporarily unavailable.');
    error.code = 'CREW_LOOKUP_FAILED';
    throw error;
  }
  const v = arr(vr)[0];
  if (!v) {
    const error = new Error('Visit not found.');
    error.code = 'VISIT_NOT_FOUND';
    throw error;
  }
  let assigned = [];
  try { assigned = typeof v?.assigned_users === 'string' ? JSON.parse(v.assigned_users) : (v?.assigned_users || []); } catch (e) { assigned = []; }
  let jids = assigned.map((p) => p && p.id).filter(Boolean).map(String);
  const ov = arr(or_)[0];
  if (ov) {
    (ov.remove_jids || []).forEach((j) => { jids = jids.filter((x) => x !== String(j)); });
    (ov.add_jids || []).forEach((j) => { if (jids.indexOf(String(j)) === -1) jids.push(String(j)); });
    out.leadJid = ov.lead_jid || null;
  }
  out.jids = jids;
  out.jobId = v.job_id || null;
  out.clientId = v.client_id || null;
  return out;
}

// Who leads this job? Dispatch's per-job election wins; otherwise the person-level
// is_lead flag set in user setup. Two flagged leads on one job is a real case and
// dispatch has to break the tie — we return null rather than pick for them.
export async function electLead(jids, explicitLead) {
  if (explicitLead && jids.some((j) => String(j) === String(explicitLead))) return String(explicitLead);
  if (!jids.length) return null;
  try {
    const r = await sb(`employee_roles?jobber_id=in.(${inList(jids)})&is_lead=is.true&select=jobber_id`);
    const leads = arr(r);
    if (leads.length === 1) return String(leads[0].jobber_id);
  } catch (e) {}
  return null;
}

// jid → { lat, lng, at } for everyone we can actually place right now.
// Vehicle GPS is the only real position signal in this system (same source and
// same caveat as track1's tech_live_status: it exists only for people with a
// truck assigned in Jobber).
export async function crewPositions(jids) {
  const out = {};
  try {
    if (!jids.length) return out;
    const ur = await sb(`users?jobber_id=in.(${inList(jids)})&assigned_vehicle_id=not.is.null&select=jobber_id,assigned_vehicle_id`);
    const users = arr(ur);
    if (!users.length) return out;
    const vr = await sb(`vehicles?jobber_id=in.(${inList(users.map((u) => u.assigned_vehicle_id))})&select=jobber_id,${VEHICLE_GPS_COLUMNS}`);
    const byVeh = {};
    arr(vr).forEach((v) => { byVeh[String(v.jobber_id)] = v; });
    users.forEach((u) => {
      const v = byVeh[String(u.assigned_vehicle_id)];
      const position = v ? vehicleGps(v) : null;
      if (!position || position.stale || position.lat == null || position.lng == null) return;
      out[String(u.jobber_id)] = {
        lat: Number(position.lat),
        lng: Number(position.lng),
        at: position.updatedAt,
      };
    });
  } catch (e) { /* proximity is advisory — it must never block a clock-in */ }
  return out;
}

// One tap, one row per person. Returns which crew members we could place away
// from the lead (flagged) and which we simply could not place at all
// (unverified). Unverified is NOT an accusation: a helper riding in the lead's
// truck has no independent signal, and we refuse to invent one.
export async function prepareCrewClockIn({ employees, leadJid, source, targetKind, targetId, label, who }) {
  const emps = (employees || []).map(String).filter(Boolean);
  if (!emps.length) return { ok: false, error: 'employees required' };
  const nowISO = new Date().toISOString();
  const lead = await electLead(emps, leadJid);
  const pos = await crewPositions(emps);
  const leadPos = lead ? pos[String(lead)] : null;

  const rows = emps.map((jid) => {
    const own = pos[jid] || null;
    let m = null, flag = false;
    if (leadPos && own && jid !== String(lead)) {
      m = Math.round(haversineM(own.lat, own.lng, leadPos.lat, leadPos.lng));
      flag = m > NEAR_LEAD_METERS;
    }
    return {
      employee_jid: jid,
      target_kind: targetKind || 'jobber_visit',
      target_id: targetId || null,
      label: label || null,
      clock_in: nowISO,
      created_by: who || null,
      source: source === 'field' ? 'field' : 'board',
      chained_to: (lead && jid !== String(lead)) ? String(lead) : null,
      lat: own ? own.lat : null,
      lng: own ? own.lng : null,
      proximity_m: m,
      proximity_flag: flag,
    };
  });

  return { ok: true, rows, lead };
}

export function crewClockResult(prepared, writtenRows) {
  const written = Array.isArray(writtenRows) ? writtenRows : [];
  return {
    ok: Boolean(prepared?.ok) && written.length === prepared.rows.length,
    clock: written,
    lead: prepared?.lead || null,
    flagged: written.filter((x) => x.proximity_flag).map((x) => x.employee_jid),
    unverified: written.filter((x) => x.proximity_m == null && x.chained_to).map((x) => x.employee_jid),
  };
}

export async function clockCrewIn(args) {
  const prepared = await prepareCrewClockIn(args);
  if (!prepared.ok) return prepared;

  // Closing prior sessions and inserting every replacement row is one database
  // transaction. If any insert fails, PostgreSQL rolls the closes back too.
  const r = await sb('rpc/hl_clock_crew_in', 'POST', { p_rows: prepared.rows });
  if (!r.ok) return { ok: false, error: 'Crew clock-in failed; nobody was changed.' };
  return crewClockResult(prepared, arr(r));
}

export async function clockCrewOut(employees) {
  const emps = (employees || []).map(String).filter(Boolean);
  if (!emps.length) return { ok: false, error: 'employees required' };
  const r = await sb(`hl_clock?clock_out=is.null&employee_jid=in.(${inList(emps)})`, 'PATCH', { clock_out: new Date().toISOString() });
  return { ok: r.ok, changed: arr(r).length };
}

// profile email → jobber user id (the crew identity everything here keys on)
export async function jobberIdForEmail(email) {
  if (!email) return null;
  const r = await sb(`users?email=eq.${encodeURIComponent(email)}&select=jobber_id&limit=1`);
  return arr(r)[0]?.jobber_id || null;
}
