// api/_lib/native-job.js — creating a job that HiveLogic owns.
//
// Two callers need this and must agree exactly: the New Job form
// (track1 create_job) and converting an approved estimate
// (bookkeeping/estimates/convert). Before this existed only the first one
// created jobs, and it did so with three defects that this module fixes:
//
//   1. No project number at all — the job was unidentifiable to anyone who
//      doesn't read database ids.
//   2. The client was stored only as a text reference, never as the internal
//      link (jobs.client_uuid) that the rest of the app joins on, so a native
//      job was invisible to anything that walks the client relationship.
//   3. The division was appended to the job's TITLE as text —
//      "Kitchen remodel [GH Design|Build]" — so it could never be grouped,
//      filtered or costed by division.
//
// Jobs synced from Jobber are untouched by any of this: they keep Jobber's own
// numbering in job_number and have project_seq null.

import { supabaseRequest as defaultSb } from './jobber.js';
import { allocateProjectSequence, jobRef } from './project-numbers.js';

// Divisions arrive from the UI as display names ("GH Electric") but are stored
// as org_units codes ("GH-EL"), because a name is something Chris may reword
// and a code is not. Accepts either, so a caller that already holds a code
// doesn't have to round-trip through the name.
//
// Returns null for "no division given", and throws only when a division WAS
// given and isn't recognised — silently dropping it would leave the job
// looking company-wide, which is worse than a clear error.
export async function resolveDivisionCode(nameOrCode, deps = {}) {
  const sb = deps.supabaseRequest || defaultSb;
  const raw = String(nameOrCode || '').trim();
  if (!raw) return null;

  const res = await sb('org_units?unit_type=eq.division&select=code,name');
  if (!res.ok) throw new Error(`Could not read the division list: ${(await res.text()).slice(0, 160)}`);
  const units = await res.json();

  const wanted = raw.toLowerCase();
  const hit = units.find(u => String(u.code || '').toLowerCase() === wanted)
    || units.find(u => String(u.name || '').toLowerCase() === wanted);
  if (hit) return hit.code;

  const known = units.map(u => u.name).filter(Boolean).join(', ');
  throw new Error(`"${raw}" is not one of this company's divisions (${known}).`);
}

// jobs.client_uuid carries a real foreign key to clients.uuid_id; client_id is
// only the Jobber-side text reference. Setting the text one alone is what made
// native jobs disconnected from their client.
export async function resolveClientUuid(clientId, deps = {}) {
  const sb = deps.supabaseRequest || defaultSb;
  const id = String(clientId || '').trim();
  if (!id) return null;
  const res = await sb(`clients?jobber_id=eq.${encodeURIComponent(id)}&select=uuid_id&limit=1`);
  if (!res.ok) return null; // a missing client shouldn't sink the job; it stays linkable by text
  const rows = await res.json();
  return (rows && rows[0] && rows[0].uuid_id) || null;
}

export async function resolveCompanyUuid(companyId, deps = {}) {
  const sb = deps.supabaseRequest || defaultSb;
  const slug = String(companyId || '').trim();
  if (!slug) throw new Error('A job needs a company.');
  const res = await sb(`companies?slug=eq.${encodeURIComponent(slug)}&select=id&limit=1`);
  if (!res.ok) throw new Error(`Could not resolve the job company: ${(await res.text()).slice(0, 160)}`);
  const rows = await res.json();
  if (!rows?.[0]?.id) throw new Error(`Company "${slug}" does not exist.`);
  return rows[0].id;
}

// Creates the job row and returns it along with its project reference.
//
// companyId here is the company SLUG ('greenwich-handyman'), matching how
// est_counters / co_counters / po_counters are scoped — all four counters key
// the same way so they behave identically. The jobs row's own company_id
// column is a uuid and keeps its database default; changing how that is
// resolved is a tenancy concern well outside this change.
export async function createNativeJob(input, deps = {}) {
  const sb = deps.supabaseRequest || defaultSb;
  const {
    companyId,
    title,
    clientId = null,
    total = null,
    division = null,
    sourceEstimateId = null,
    jobStatus = 'active',
    projectSeq = null, // supplied when the project already has a number (estimate -> job)
    companyUuid = null,
  } = input || {};

  const cleanTitle = String(title || '').trim();
  if (!cleanTitle) throw new Error('A job needs a title.');
  if (!companyId) throw new Error('A job needs a company.');

  const divisionCode = await resolveDivisionCode(division, deps);
  const clientUuid = await resolveClientUuid(clientId, deps);
  const resolvedCompanyUuid = companyUuid || await resolveCompanyUuid(companyId, deps);

  // An estimate converting into a job reuses the number it was raised under —
  // that shared sequence is the entire point of E-10001 becoming J-10001.
  const seq = projectSeq || await allocateProjectSequence(companyId, deps);

  const row = {
    jobber_id: 'HL-JOB-' + seq,
    company_id: resolvedCompanyUuid,
    project_seq: seq,
    title: cleanTitle,
    job_status: jobStatus,
    client_id: clientId || null,
    client_uuid: clientUuid,
    division_code: divisionCode,
    source_estimate_id: sourceEstimateId,
    total: (isFinite(Number(total)) && Number(total) > 0) ? Number(total) : null,
    jobber_updated_at: new Date().toISOString(),
  };

  const res = await sb('jobs', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });

  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    // uq_jobs_project_seq is what stops one estimate becoming two jobs. Say so
    // in words rather than surfacing a Postgres constraint name to a user.
    if (/uq_jobs_project_seq|duplicate key/i.test(text)) {
      const err = new Error(`Job ${jobRef(seq)} already exists.`);
      err.code = 'PROJECT_NUMBER_TAKEN';
      err.projectSeq = seq;
      throw err;
    }
    throw new Error(`Could not create the job: ${text}`);
  }

  const created = (await res.json())[0];
  return { job: created, projectSeq: seq, jobRef: jobRef(seq) };
}
