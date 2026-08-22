// api/_lib/status-hub.js -- normalized, traceable application findings.
// Every automated source uses this same server-side store; clients never write
// the tables directly.
import crypto from 'node:crypto';
import { supabaseRequest } from './jobber.js';

const SELFTEST_PROBLEMS = new Set(['THREW', 'FAILED_FETCH', 'FAKE_SUCCESS', 'NO_OUTCOME', 'UNREADABLE_ACTIVE', 'SLOW_BLOCKING']);
const SEVERITY = {
  THREW: 'high', FAILED_FETCH: 'high', FAKE_SUCCESS: 'high',
  SLOW_BLOCKING: 'medium', UNREADABLE_ACTIVE: 'medium', NO_OUTCOME: 'low',
};
const MANUAL_SOURCES = new Set(['manual_blocker', 'mock_ui', 'owner_decision', 'external_blocker']);
// Enough to show before/after or two angles of the same screen without
// turning a finding into a photo dump.
const MAX_ATTACHMENTS_PER_FINDING = 4;
// A health warning is not automatically a developer issue.  Keep this queue
// focused on failures and blockers that can stop the product from working.
const BLOCKER_WARNING = /^(API\b|Database\b|Signal coverage\b|Not running:|Monitor agents\b|Browsers on the current build\b)/i;

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex').slice(0, 40); }
function text(value, max = 2000) { return String(value || '').trim().slice(0, max); }
function dueDate(value) {
  const date = text(value, 10);
  if (!date) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new Error('Invalid blocker due date.');
  }
  return date;
}

export function findingsFromSelftest(results) {
  if (!Array.isArray(results)) return [];
  const seen = new Set();
  return results.flatMap((result) => {
    if (!result || !SELFTEST_PROBLEMS.has(result.verdict)) return [];
    const view = text(result.view || 'unknown', 80);
    const label = text(result.label || 'Unnamed control', 280);
    const verdict = text(result.verdict, 40);
    const key = `${verdict}|${view}|${label}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      source: 'selftest',
      fingerprint: sha(key),
      title: `${verdict.replace(/_/g, ' ')} — ${label}`,
      detail: text(result.note || `Crawler finding in ${view}.`),
      severity: SEVERITY[verdict] || 'medium',
      evidence: { verdict, view, label, kind: text(result.kind, 80), depth: Number.isFinite(result.depth) ? result.depth : null },
    }];
  });
}

export function findingsFromHealthChecks(checks) {
  if (!Array.isArray(checks)) return [];
  return checks.flatMap((check) => {
    if (!check || !['warn', 'fail'].includes(check.status)) return [];
    const name = text(check.name || 'Unnamed health check', 280);
    if (check.status === 'warn' && !BLOCKER_WARNING.test(name)) return [];
    return [{
      source: 'daily_health',
      fingerprint: sha(name),
      title: `Health check ${check.status === 'fail' ? 'failed' : 'warning'} — ${name}`,
      detail: text(check.detail || 'No detail reported.'),
      severity: check.status === 'fail' ? 'high' : 'medium',
      evidence: { health_status: check.status, check: name },
    }];
  });
}

// Human-reported blockers are deliberately normalized through the same
// finding store as automated failures.  A stable source/title fingerprint
// refreshes the same unresolved issue instead of creating a noisy activity
// stream every time someone reports it.
export async function createManualFinding(input, actorId) {
  const source = text(input && input.source, 80);
  const title = text(input && input.title, 280);
  const detail = text(input && input.detail, 2000);
  const severity = text(input && input.severity, 20).toLowerCase() || 'medium';
  const assignedTo = text(input && input.assigned_to, 160) || null;
  const due = dueDate(input && input.due_date);
  if (!MANUAL_SOURCES.has(source)) throw new Error('Invalid blocker type.');
  if (title.length < 4) throw new Error('A short blocker summary is required.');
  if (!['critical', 'high', 'medium', 'low'].includes(severity)) throw new Error('Invalid blocker severity.');
  const result = await observeFinding({
    source,
    fingerprint: sha(`${source}|${title.toLowerCase()}`),
    title,
    detail: detail || 'Reported without additional detail.',
    severity,
    evidence: { reported_by: actorId || null, kind: 'manual_blocker' },
    assigned_to: assignedTo,
    due_date: due,
  });
  return result;
}

async function observeFinding(finding) {
  const query = `app_status_findings?source=eq.${encodeURIComponent(finding.source)}&fingerprint=eq.${encodeURIComponent(finding.fingerprint)}&select=id,status&limit=1`;
  const priorRes = await supabaseRequest(query);
  if (!priorRes.ok) throw new Error(`Could not look up status finding: ${await priorRes.text()}`);
  const prior = (await priorRes.json())[0];
  const now = new Date().toISOString();
  if (prior) {
    // A finding a human marked "resolved" that the same source observes again
    // is, by definition, not actually fixed -- reopen it instead of silently
    // refreshing evidence under a closed status where nobody will see it.
    // "ignored" is a standing decision (e.g. a known mock screen), not a claim
    // the underlying problem is gone, so recurrence there is left alone.
    const reopening = prior.status === 'resolved';
    const patch = { title: finding.title, detail: finding.detail || null, severity: finding.severity, evidence: finding.evidence, last_seen_at: now, updated_at: now };
    if (reopening) Object.assign(patch, { status: 'open', resolved_at: null, resolved_by: null, status_note: `Recurred -- seen again by ${finding.source} after being marked resolved.` });
    const patchRes = await supabaseRequest(`app_status_findings?id=eq.${encodeURIComponent(prior.id)}`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    });
    if (!patchRes.ok) throw new Error(`Could not refresh status finding: ${await patchRes.text()}`);
    const updated = (await patchRes.json())[0];
    if (reopening) {
      await supabaseRequest('app_status_events', { method: 'POST', body: JSON.stringify({ finding_id: prior.id, event_type: 'status_changed', detail: `open: recurred via ${finding.source} after being marked resolved.` }) });
    }
    return { finding: updated, created: false };
  }
  const createRes = await supabaseRequest('app_status_findings', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ ...finding, first_seen_at: now, last_seen_at: now, updated_at: now }),
  });
  if (!createRes.ok) throw new Error(`Could not create status finding: ${await createRes.text()}`);
  const created = (await createRes.json())[0];
  await supabaseRequest('app_status_events', { method: 'POST', body: JSON.stringify({ finding_id: created.id, event_type: 'observed', detail: `Observed by ${finding.source}.` }) });
  return { finding: created, created: true };
}

export async function observeFindings(findings) {
  return Promise.all((findings || []).map(async (finding) => (await observeFinding(finding)).finding));
}

export async function listFindings() {
  const r = await supabaseRequest('app_status_findings?select=*&order=last_seen_at.desc&limit=200');
  if (!r.ok) throw new Error(`Could not load status findings: ${await r.text()}`);
  return withResolverNames(await r.json());
}

// One batched query for every finding on the page, like withResolverNames --
// not one round trip per row.
export async function listFindingAttachments(findingIds) {
  const ids = [...new Set((findingIds || []).filter(Boolean))];
  if (!ids.length) return [];
  const list = ids.map((id) => `"${encodeURIComponent(id)}"`).join(',');
  const r = await supabaseRequest(`app_status_finding_attachments?finding_id=in.(${list})&select=id,finding_id,storage_path,content_type,created_at&order=created_at.asc`);
  if (!r.ok) throw new Error(`Could not load attachments: ${await r.text()}`);
  return r.json();
}

// Stores the (already magic-byte-validated, see validateScreenshotBase64) image
// bytes in the devtodo-attachments bucket and records the pointer row. Caps at
// MAX_ATTACHMENTS_PER_FINDING so the report-a-blocker form can't be turned into
// bulk file storage.
export async function addFindingAttachment(findingId, shot, actorId) {
  const findingRes = await supabaseRequest(`app_status_findings?id=eq.${encodeURIComponent(findingId)}&select=id&limit=1`);
  if (!findingRes.ok) throw new Error(`Could not look up finding: ${await findingRes.text()}`);
  if (!(await findingRes.json())[0]) throw new Error('Finding not found.');

  const countRes = await supabaseRequest(`app_status_finding_attachments?finding_id=eq.${encodeURIComponent(findingId)}&select=id`);
  if (!countRes.ok) throw new Error(`Could not check existing attachments: ${await countRes.text()}`);
  if ((await countRes.json()).length >= MAX_ATTACHMENTS_PER_FINDING) {
    throw new Error(`Too many attachments already (max ${MAX_ATTACHMENTS_PER_FINDING}).`);
  }

  const objPath = `${findingId}/${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${shot.ext}`;
  const upRes = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/devtodo-attachments/${objPath}`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': shot.contentType,
    },
    body: shot.buffer,
  });
  if (!upRes.ok) throw new Error(`Could not store the attachment: ${await upRes.text()}`);

  const insRes = await supabaseRequest('app_status_finding_attachments', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ finding_id: findingId, storage_path: objPath, content_type: shot.contentType, created_by: actorId || null }),
  });
  if (!insRes.ok) throw new Error(`Attachment stored but could not record it: ${await insRes.text()}`);
  return (await insRes.json())[0];
}

// The Resolved tab has to say who closed each item, and `resolved_by` only
// stores the user id.  Resolve those ids to display names in one batched
// profiles lookup rather than making the browser do it per row.  Anything we
// cannot name -- closed before resolved_by shipped, deleted profile, failed
// lookup -- comes back null, and the UI renders "Unknown" for it.  It never
// guesses a name.
export async function withResolverNames(rows) {
  const findings = Array.isArray(rows) ? rows : [];
  const ids = [...new Set(findings.map((f) => f && f.resolved_by).filter(Boolean))];
  if (!ids.length) return findings.map((f) => ({ ...f, resolved_by_name: null }));
  const names = new Map();
  try {
    const list = ids.map((id) => `"${encodeURIComponent(id)}"`).join(',');
    const r = await supabaseRequest(`profiles?id=in.(${list})&select=id,full_name,email`);
    if (r.ok) {
      for (const p of await r.json()) {
        const name = text(p && p.full_name, 120) || text(p && p.email, 120);
        if (p && p.id && name) names.set(p.id, name);
      }
    }
  } catch (e) { /* naming is best-effort -- the list must still render */ }
  return findings.map((f) => ({ ...f, resolved_by_name: (f && f.resolved_by && names.get(f.resolved_by)) || null }));
}

export async function setFindingStatus(id, status, note, actorId) {
  const allowed = new Set(['open', 'in_progress', 'resolved', 'ignored']);
  if (!allowed.has(status)) throw new Error('Invalid finding status.');
  const now = new Date().toISOString();
  // Closing a finding stamps who closed it alongside when, and reopening
  // clears both -- so `resolved_by` always describes the CURRENT closure and
  // never a stale one.  `updated_by` stays the last toucher of any status.
  const closing = status === 'resolved' || status === 'ignored';
  const patch = { status, status_note: text(note, 2000) || null, updated_by: actorId || null, updated_at: now, resolved_at: closing ? now : null, resolved_by: closing ? (actorId || null) : null };
  let r = await supabaseRequest(`app_status_findings?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  // The 20260819020000 migration is applied by hand, so this code can be live
  // for a window before the column exists.  Losing the attribution is bad;
  // losing the ability to triage at all is worse -- retry once without it.
  if (!r.ok && await isMissingResolvedByColumn(r)) {
    const { resolved_by: _dropped, ...legacy } = patch;
    r = await supabaseRequest(`app_status_findings?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify(legacy),
    });
  }
  if (!r.ok) throw new Error(`Could not update finding: ${await r.text()}`);
  const row = (await r.json())[0];
  if (!row) throw new Error('Finding not found.');
  await supabaseRequest('app_status_events', { method: 'POST', body: JSON.stringify({ finding_id: row.id, event_type: 'status_changed', detail: `${status}${note ? `: ${text(note, 2000)}` : ''}`, actor_id: actorId || null }) });
  return (await withResolverNames([row]))[0];
}

// PostgREST reports an unknown column as PGRST204 / SQLSTATE 42703. Reading the
// body consumes it, which is why the caller re-issues the request rather than
// retrying this response.
async function isMissingResolvedByColumn(res) {
  if (!res || (res.status !== 400 && res.status !== 404)) return false;
  let body = '';
  try { body = await res.text(); } catch (e) { return false; }
  return /resolved_by/.test(body) && /(PGRST204|42703|does not exist|could not find)/i.test(body);
}
