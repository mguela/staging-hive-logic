// api/subportal.js — Vercel serverless function
//
// SUBCONTRACTOR PORTAL — ONE consolidated route (mirrors the api/track1.js
// and api/hiveconnect-bridge.js pattern already used in this repo to stay
// under Vercel's per-plan function-count limit — see fix-function-limit.bat
// and claude/sub-portal-spec.md P0 #4). Every sub-portal endpoint is an
// ?action= on this single file. Frontend: public/subportal/.
//
// Spec: claude/sub-portal-spec.md (dictated by Chris 2026-07-21, audited
// and approved same day — every P0/P1 item referenced below by number is
// from that audit).
//
// AUTH MODEL (two separate token types, on purpose — spec P0 #5):
//   - sub_auth_links: single-use, short-lived magic-link tokens. Redeeming
//     one mints a sub_sessions token and is then dead.
//   - sub_sessions: long-lived device session token. This is what keeps a
//     sub signed in without ever having a password. Revocable per-row.
//     Every session-scoped action below requires
//     `Authorization: Bearer <sub_sessions.token>` and is scoped
//     server-side to that row's sub_id — never trusted from the client
//     body (spec P0 #3).
//
// NOT YET WIRED (disclosed honestly, not faked — Law #1, never bluff):
//   - SMS/email dispatch: no Twilio/SendGrid/RingCentral connection exists
//     in this codebase yet (confirmed: api/_lib/brain/00-master-prompt.md
//     says Jobber/HCP/etc are "not yet connected"). login_link and invite
//     both return the link directly in the API response so staff can send
//     it manually today; wiring an actual send is a follow-up, not a Phase
//     1 blocker.
//   - Invoice OCR (spec P1 #6): no OCR provider connected. invoice_submit
//     accepts a sub-entered amount or leaves it null with
//     amount_source:'pending_ocr' rather than inventing a number.
//   - Payment tokenization (spec P0 #2): sub_banking never accepts
//     anything that isn't already masked — see REAUTH + validation below.
//     No live provider (QBO Bill Pay / Melio / Stripe) is wired yet; that's
//     a Phase 2 decision (see spec open questions).

import { supabaseRequest } from './_lib/jobber.js';
import { genToken, hashToken, checkRateLimit, deliverLoginLink } from './_lib/portal-auth.js';
import { hasAllowedRole } from './_lib/permission-roles.js';
import { listPortalFiles, subJobIds } from './_lib/hivedoc-portal-files.js';

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function numOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (Array.isArray(fwd) ? fwd[0] : fwd || '').split(',')[0].trim() || null;
}

// Append-only audit trail (spec P0 #3) — every sub-initiated action gets a
// row here. Best-effort: a logging failure never blocks the real action.
async function auditLog(subId, actor, action, entity = {}, detail = null, req = null) {
  try {
    await supabaseRequest('sub_audit_log', {
      method: 'POST',
      body: JSON.stringify({
        sub_id: subId || null,
        actor,
        action,
        entity_type: entity.type || null,
        entity_id: entity.id || null,
        detail: detail || null,
        ip: req ? clientIp(req) : null,
      }),
    });
  } catch (e) {
    console.error('sub_audit_log write failed (non-fatal):', e.message);
  }
}

function baseUrl(req) {
  if (process.env.SUBPORTAL_BASE_URL) return process.env.SUBPORTAL_BASE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${req.headers.host}`;
}

// ---------------------------------------------------------------------------
// staff auth — mirrors api/track1.js's getRequestingProfile() exactly.
// Duplicated on purpose rather than imported, so this file never depends on
// (or risks destabilizing) track1.js's internals.
// ---------------------------------------------------------------------------
async function getStaffProfile(req) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!userRes.ok) return null;
  const user = await userRes.json();
  if (!user || !user.id) return null;
  const profRes = await supabaseRequest(`profiles?id=eq.${user.id}&select=id,email,full_name,role`);
  if (!profRes.ok) return { id: user.id, email: user.email, full_name: null, role: null };
  const rows = await profRes.json();
  return (rows && rows[0]) || { id: user.id, email: user.email, full_name: null, role: null };
}

// Role gate, Phase 2 (2026-08-06): Sub Portal staff management was open to
// any signed-in employee -- the main app's own nav only ever shows this
// section (Vendors & Subs) to project_manager/accounting (+ owner/partner/
// office_manager/systems_pm, who see everything), so this closes the API to
// match. Unlike the financial-resource gate in track1.js, there was no
// existing server-side policy to mirror here -- this list is a new call,
// not a pre-decided one; flag to Chris if a different role should be added.
// 2026-08-10: Stage 2 permission redesign -- old owner/partner/office_manager/
// systems_pm (all identical "full access" roles) collapsed into "owner",
// accounting renamed to office_ar. See sql/066_permission_roles_v2.sql.
const SUB_PORTAL_STAFF_ROLES = ['owner', 'project_manager', 'office_ar'];
async function isAuthorizedSubPortalStaff(staff) {
  return hasAllowedRole(staff, SUB_PORTAL_STAFF_ROLES);
}

// ---------------------------------------------------------------------------
// sub session auth — the long-lived device-session half of the auth model.
// ---------------------------------------------------------------------------
async function getSubSession(req) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  // Sessions are stored hashed (2026-08-01): hash the presented bearer and
  // look up the row by its hash. The raw token never touches the database.
  const rows = await sb(`sub_sessions?token=eq.${encodeURIComponent(hashToken(token))}&revoked_at=is.null&select=*`);
  if (!rows || !rows.length) return null;
  const session = rows[0];
  // touch last_seen_at, best-effort
  supabaseRequest(`sub_sessions?id=eq.${session.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ last_seen_at: new Date().toISOString() }),
  }).catch(() => {});
  const subRows = await sb(`subs?id=eq.${session.sub_id}&select=*`);
  if (!subRows || !subRows.length) return null;
  return { session, sub: subRows[0] };
}

async function requireSub(req, res) {
  const ctx = await getSubSession(req);
  if (!ctx) {
    res.status(401).json({ ok: false, error: 'Not signed in. This link may have expired — request a new one.' });
    return null;
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Supabase Storage upload for docs/invoices. Accepts a data: URL (what a
// phone camera capture produces client-side) and puts it in a private
// bucket, returning the object path. Buckets are NOT created by this code —
// create `sub-documents` and `sub-invoices` (private) once in the Supabase
// dashboard before this goes live; that's a one-time manual step, same as
// every other piece of infra in this repo that isn't SQL.
// ---------------------------------------------------------------------------
// Short-lived signed URL for a private bucket object. Returns null rather than
// throwing so one unreachable file cannot take down a whole list.
async function signBucketUrl(bucket, storagePath, expiresInSeconds = 3600) {
  const r = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/sign/${bucket}/${storagePath}`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: expiresInSeconds }),
  });
  if (!r.ok) return null;
  const d = await r.json();
  return d && d.signedURL ? `${process.env.SUPABASE_URL}/storage/v1${d.signedURL}` : null;
}

async function uploadDataUrl(bucket, path, dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) throw new Error('Expected a base64 data URL (e.g. from a camera capture).');
  const [, contentType, b64] = match;
  const buf = Buffer.from(b64, 'base64');
  const res = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/${bucket}/${path}`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': contentType,
      'x-upsert': 'true',
    },
    body: buf,
  });
  if (!res.ok) throw new Error(`Storage upload failed: ${await res.text()}`);
  return `${bucket}/${path}`;
}

// A masked_account value is only ever allowed in the shape "****1234" (or
// similar), never anything that could be a real account/routing number.
// Defense-in-depth for spec P0 #2, enforced in code, not just in the schema
// comment.
function looksLikeSafeMask(v) {
  return typeof v === 'string' && /^[*•]{2,}\d{2,4}$/.test(v.trim());
}

// ---------------------------------------------------------------------------
// handler
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  const action = req.query.action;

  try {
    // ---------------- STAFF ----------------
    if (action === 'invite') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const staff = await getStaffProfile(req);
      if (!staff) return res.status(401).json({ ok: false, error: 'Staff sign-in required to invite a sub.' });
      if (!(await isAuthorizedSubPortalStaff(staff))) return res.status(403).json({ ok: false, error: 'Your role does not have access to Sub Portal management. Ask an owner, office manager, project manager, or accounting.' });

      const body = req.body || {};
      const bodySubcontractorId = body.subcontractor_id ? String(body.subcontractor_id) : '';

      // Resolve the ONE directory entity (subcontractors) this portal account
      // belongs to. subcontractors is the single source of truth for company
      // identity (name/contact/phone/email) -- subs is the portal-account
      // extension of it, not a second identity (2026-08 fix, sql/062: subs
      // used to duplicate these fields with zero link back to the directory).
      let subcontractor;
      if (bodySubcontractorId) {
        const rows = await sb(`subcontractors?id=eq.${encodeURIComponent(bodySubcontractorId)}&select=*`);
        subcontractor = rows && rows[0];
        if (!subcontractor) return res.status(400).json({ ok: false, error: 'subcontractor_id does not match a directory entry.' });
      } else {
        const { company_name, contact_name, phone, email } = body;
        if (!company_name) return res.status(400).json({ ok: false, error: 'company_name is required.' });
        const existingDirectory = email
          ? await sb(`subcontractors?email=eq.${encodeURIComponent(email)}&select=*`)
          : [];
        if (existingDirectory && existingDirectory.length) {
          subcontractor = existingDirectory[0];
        } else {
          const createdDirectory = await sb('subcontractors', {
            method: 'POST',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify({
              name: company_name, contact_name: contact_name || null, phone: phone || null, email: email || null,
              status: 'active', created_by: staff.email || staff.id, updated_by: staff.email || staff.id,
            }),
          });
          subcontractor = createdDirectory[0];
        }
      }

      let sub;
      const existing = subcontractor.email
        ? await sb(`subs?email=eq.${encodeURIComponent(subcontractor.email)}&select=*`)
        : [];
      if (existing && existing.length) {
        sub = existing[0];
        if (!sub.subcontractor_id) {
          const linked = await sb(`subs?id=eq.${sub.id}`, {
            method: 'PATCH',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify({ subcontractor_id: subcontractor.id }),
          });
          sub = linked[0];
        }
      } else {
        const created = await sb('subs', {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({
            company_name: subcontractor.name, contact_name: subcontractor.contact_name || null,
            phone: subcontractor.phone || null, email: subcontractor.email || null,
            status: 'invited', subcontractor_id: subcontractor.id,
          }),
        });
        sub = created[0];
      }

      const token = genToken(24);
      await supabaseRequest('sub_auth_links', {
        method: 'POST',
        body: JSON.stringify({
          sub_id: sub.id,
          token: hashToken(token), // store the hash; raw token lives only in the URL/email
          purpose: 'invite',
          expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
        }),
      });

      const inviteUrl = `${baseUrl(req)}/subportal/?token=${token}`;
      // Deliver the link out-of-band to the sub's on-file email when we can.
      const delivery = await deliverLoginLink({ email: sub.email, url: inviteUrl, brandName: 'GH Group', purpose: 'portal invite', deps: { supabaseRequest } });
      await auditLog(sub.id, 'staff', 'invite_created', { type: 'sub', id: sub.id }, { by: staff.id, delivered: delivery.delivered }, req);

      return res.status(200).json({
        ok: true,
        sub,
        // inviteUrl is returned only to authenticated staff (never a public
        // response) so an admin can still hand-deliver it when email delivery
        // isn't configured. It is NOT returned on the public login_link path.
        inviteUrl,
        delivered: delivery.delivered,
        note: delivery.delivered
          ? 'Invite link emailed to the sub.'
          : 'Email delivery is not configured — copy this link to the sub yourself for now.',
      });
    }

    // ================================================================
    // STAFF ADMIN SURFACE — HiveLogic-side of the sub portal.
    // Every action below is gated by getStaffProfile(req), same as
    // 'invite' above. These let staff manage subs, RFQs/bids, RFIs,
    // schedule proposals, invoice review, and messaging without ever
    // touching a sub_sessions token — this is the missing "HiveLogic
    // side" Chris asked for on 2026-07-22.
    // ================================================================

    if (action === 'subs_list') {
      if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET required' });
      const staff = await getStaffProfile(req);
      if (!staff) return res.status(401).json({ ok: false, error: 'Staff sign-in required.' });
      if (!(await isAuthorizedSubPortalStaff(staff))) return res.status(403).json({ ok: false, error: 'Your role does not have access to Sub Portal management. Ask an owner, office manager, project manager, or accounting.' });

      const { status, q } = req.query;
      let qs = 'order=company_name.asc&select=*';
      if (status) qs += `&status=eq.${encodeURIComponent(status)}`;
      if (q) qs += `&company_name=ilike.*${encodeURIComponent(q)}*`;
      const [subs, openRfqRows, expiringDocRows] = await Promise.all([
        sb(`subs?${qs}`),
        sb(`sub_rfqs?status=in.(sent,viewed)&select=sub_id`),
        sb(`sub_documents?status=neq.current&select=sub_id`),
      ]);
      const rfqCounts = {};
      for (const r of openRfqRows) rfqCounts[r.sub_id] = (rfqCounts[r.sub_id] || 0) + 1;
      const docCounts = {};
      for (const d of expiringDocRows) docCounts[d.sub_id] = (docCounts[d.sub_id] || 0) + 1;
      const enriched = subs.map((s) => ({ ...s, openRfqs: rfqCounts[s.id] || 0, docsExpiring: docCounts[s.id] || 0 }));
      return res.status(200).json({ ok: true, subs: enriched });
    }

    if (action === 'sub_detail') {
      if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET required' });
      const staff = await getStaffProfile(req);
      if (!staff) return res.status(401).json({ ok: false, error: 'Staff sign-in required.' });
      if (!(await isAuthorizedSubPortalStaff(staff))) return res.status(403).json({ ok: false, error: 'Your role does not have access to Sub Portal management. Ask an owner, office manager, project manager, or accounting.' });

      const { sub_id } = req.query;
      if (!sub_id) return res.status(400).json({ ok: false, error: 'sub_id is required' });
      const subRows = await sb(`subs?id=eq.${sub_id}&select=*`);
      if (!subRows || !subRows.length) return res.status(404).json({ ok: false, error: 'Sub not found.' });

      const [documents, banking, rfqs, rfis, schedule, invoices, messages, auditRows] = await Promise.all([
        sb(`sub_documents?sub_id=eq.${sub_id}&order=uploaded_at.desc&select=*`),
        sb(`sub_banking?sub_id=eq.${sub_id}&select=*`),
        sb(`sub_rfqs?sub_id=eq.${sub_id}&order=created_at.desc&select=*`),
        sb(`sub_rfis?sub_id=eq.${sub_id}&order=created_at.desc&select=*`),
        sb(`sub_schedule_items?sub_id=eq.${sub_id}&order=start_at.asc&select=*`),
        sb(`sub_invoices?sub_id=eq.${sub_id}&order=submitted_at.desc&select=*`),
        sb(`sub_messages?sub_id=eq.${sub_id}&order=created_at.asc&select=*`),
        sb(`sub_audit_log?sub_id=eq.${sub_id}&order=created_at.desc&limit=20&select=*`),
      ]);
      return res.status(200).json({
        ok: true,
        sub: subRows[0],
        documents,
        banking: banking[0] || null,
        rfqs,
        rfis,
        schedule,
        invoices,
        messages,
        auditLog: auditRows,
      });
    }

    if (action === 'docs_expiring') {
      if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET required' });
      const staff = await getStaffProfile(req);
      if (!staff) return res.status(401).json({ ok: false, error: 'Staff sign-in required.' });
      if (!(await isAuthorizedSubPortalStaff(staff))) return res.status(403).json({ ok: false, error: 'Your role does not have access to Sub Portal management. Ask an owner, office manager, project manager, or accounting.' });

      const [docs, subs] = await Promise.all([
        sb(`sub_documents?status=neq.current&order=expires_at.asc&select=*`),
        sb(`subs?select=id,company_name,contact_name,phone,email`),
      ]);
      const subMap = {};
      for (const s of subs) subMap[s.id] = s;
      const enriched = docs.map((d) => ({ ...d, sub: subMap[d.sub_id] || null }));
      return res.status(200).json({ ok: true, documents: enriched });
    }

    if (action === 'rfq_create') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const staff = await getStaffProfile(req);
      if (!staff) return res.status(401).json({ ok: false, error: 'Staff sign-in required.' });
      if (!(await isAuthorizedSubPortalStaff(staff))) return res.status(403).json({ ok: false, error: 'Your role does not have access to Sub Portal management. Ask an owner, office manager, project manager, or accounting.' });

      const { sub_id, job_ref, title, scope, doc_urls, due_date } = req.body || {};
      if (!sub_id || !title) return res.status(400).json({ ok: false, error: 'sub_id and title are required.' });
      const created = await sb('sub_rfqs', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          sub_id,
          job_ref: job_ref || null,
          title,
          scope: scope || null,
          doc_urls: doc_urls || null,
          due_date: due_date || null,
          status: 'sent',
        }),
      });
      const rfq = created[0];
      await supabaseRequest('sub_notifications', {
        method: 'POST',
        body: JSON.stringify({
          sub_id,
          type: 'bid_due',
          title: `New RFQ: ${title}`,
          body: due_date ? `Bid due ${due_date}.` : 'A new request for quote is waiting for you.',
          action_url: '#jobs',
          entity_type: 'sub_rfq',
          entity_id: rfq.id,
        }),
      }).catch(() => {});
      await auditLog(sub_id, 'staff', 'rfq_created', { type: 'sub_rfq', id: rfq.id }, { by: staff.id, title }, req);
      return res.status(200).json({ ok: true, rfq });
    }

    if (action === 'rfq_review') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const staff = await getStaffProfile(req);
      if (!staff) return res.status(401).json({ ok: false, error: 'Staff sign-in required.' });
      if (!(await isAuthorizedSubPortalStaff(staff))) return res.status(403).json({ ok: false, error: 'Your role does not have access to Sub Portal management. Ask an owner, office manager, project manager, or accounting.' });

      const { rfq_id, decision, note } = req.body || {};
      if (!rfq_id || !['awarded', 'declined'].includes(decision)) {
        return res.status(400).json({ ok: false, error: "rfq_id and decision ('awarded' or 'declined') are required" });
      }
      const updated = await sb(`sub_rfqs?id=eq.${rfq_id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ status: decision }),
      });
      if (!updated.length) return res.status(404).json({ ok: false, error: 'RFQ not found.' });
      const rfq = updated[0];
      await supabaseRequest('sub_notifications', {
        method: 'POST',
        body: JSON.stringify({
          sub_id: rfq.sub_id,
          type: 'rfq_decision',
          title: decision === 'awarded' ? `You got the job: ${rfq.title}` : `RFQ update: ${rfq.title}`,
          body: decision === 'awarded' ? 'Your bid was accepted — check the job for next steps.' : (note || 'This RFQ was not awarded to you this time.'),
          action_url: '#jobs',
          entity_type: 'sub_rfq',
          entity_id: rfq.id,
        }),
      }).catch(() => {});
      await auditLog(rfq.sub_id, 'staff', `rfq_${decision}`, { type: 'sub_rfq', id: rfq.id }, { by: staff.id, note: note || null }, req);
      return res.status(200).json({ ok: true, rfq });
    }

    if (action === 'rfi_answer') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const staff = await getStaffProfile(req);
      if (!staff) return res.status(401).json({ ok: false, error: 'Staff sign-in required.' });
      if (!(await isAuthorizedSubPortalStaff(staff))) return res.status(403).json({ ok: false, error: 'Your role does not have access to Sub Portal management. Ask an owner, office manager, project manager, or accounting.' });

      const { rfi_id, answer } = req.body || {};
      if (!rfi_id || !answer) return res.status(400).json({ ok: false, error: 'rfi_id and answer are required.' });
      const updated = await sb(`sub_rfis?id=eq.${rfi_id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ answer, status: 'answered', answered_at: new Date().toISOString() }),
      });
      if (!updated.length) return res.status(404).json({ ok: false, error: 'RFI not found.' });
      const rfi = updated[0];
      await supabaseRequest('sub_notifications', {
        method: 'POST',
        body: JSON.stringify({
          sub_id: rfi.sub_id,
          type: 'rfi_answered',
          title: 'Your question was answered',
          body: answer.slice(0, 140),
          action_url: '#jobs',
          entity_type: 'sub_rfi',
          entity_id: rfi.id,
        }),
      }).catch(() => {});
      await auditLog(rfi.sub_id, 'staff', 'rfi_answered', { type: 'sub_rfi', id: rfi.id }, { by: staff.id }, req);
      return res.status(200).json({ ok: true, rfi });
    }

    if (action === 'schedule_item_create') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const staff = await getStaffProfile(req);
      if (!staff) return res.status(401).json({ ok: false, error: 'Staff sign-in required.' });
      if (!(await isAuthorizedSubPortalStaff(staff))) return res.status(403).json({ ok: false, error: 'Your role does not have access to Sub Portal management. Ask an owner, office manager, project manager, or accounting.' });

      const { sub_id, job_ref, title, start_at, end_at } = req.body || {};
      if (!sub_id || !title || !start_at) return res.status(400).json({ ok: false, error: 'sub_id, title, and start_at are required.' });
      const created = await sb('sub_schedule_items', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ sub_id, job_ref: job_ref || null, title, start_at, end_at: end_at || null, status: 'proposed' }),
      });
      const item = created[0];
      await supabaseRequest('sub_notifications', {
        method: 'POST',
        body: JSON.stringify({
          sub_id,
          type: 'schedule_upcoming',
          title: `New schedule item: ${title}`,
          body: 'Please review and approve.',
          action_url: '#schedule',
          entity_type: 'sub_schedule_item',
          entity_id: item.id,
        }),
      }).catch(() => {});
      await auditLog(sub_id, 'staff', 'schedule_item_created', { type: 'sub_schedule_item', id: item.id }, { by: staff.id, title }, req);
      return res.status(200).json({ ok: true, item });
    }

    if (action === 'invoice_status_update') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const staff = await getStaffProfile(req);
      if (!staff) return res.status(401).json({ ok: false, error: 'Staff sign-in required.' });
      if (!(await isAuthorizedSubPortalStaff(staff))) return res.status(403).json({ ok: false, error: 'Your role does not have access to Sub Portal management. Ask an owner, office manager, project manager, or accounting.' });

      const { invoice_id, status, payment_due, amount } = req.body || {};
      if (!invoice_id || !['submitted', 'scheduled', 'paid'].includes(status)) {
        return res.status(400).json({ ok: false, error: "invoice_id and status ('submitted'|'scheduled'|'paid') are required" });
      }
      const patch = { status };
      if (payment_due !== undefined) patch.payment_due = payment_due || null;
      if (amount !== undefined) patch.amount = numOrNull(amount);
      if (status === 'paid') patch.paid_at = new Date().toISOString();
      const updated = await sb(`sub_invoices?id=eq.${invoice_id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(patch),
      });
      if (!updated.length) return res.status(404).json({ ok: false, error: 'Invoice not found.' });
      const invoice = updated[0];
      if (status === 'paid') {
        await supabaseRequest('sub_notifications', {
          method: 'POST',
          body: JSON.stringify({
            sub_id: invoice.sub_id,
            type: 'payment_sent',
            title: 'Payment sent',
            body: invoice.amount ? `$${invoice.amount} on its way.` : 'Your invoice has been paid.',
            action_url: '#money',
            entity_type: 'sub_invoice',
            entity_id: invoice.id,
          }),
        }).catch(() => {});
      }
      await auditLog(invoice.sub_id, 'staff', 'invoice_status_updated', { type: 'sub_invoice', id: invoice.id }, { by: staff.id, status }, req);
      return res.status(200).json({ ok: true, invoice });
    }

    if (action === 'staff_messages') {
      if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET required' });
      const staff = await getStaffProfile(req);
      if (!staff) return res.status(401).json({ ok: false, error: 'Staff sign-in required.' });
      if (!(await isAuthorizedSubPortalStaff(staff))) return res.status(403).json({ ok: false, error: 'Your role does not have access to Sub Portal management. Ask an owner, office manager, project manager, or accounting.' });

      const { sub_id } = req.query;
      if (!sub_id) return res.status(400).json({ ok: false, error: 'sub_id is required' });
      const rows = await sb(`sub_messages?sub_id=eq.${sub_id}&order=created_at.asc&select=*`);
      return res.status(200).json({ ok: true, messages: rows });
    }

    if (action === 'staff_message_send') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const staff = await getStaffProfile(req);
      if (!staff) return res.status(401).json({ ok: false, error: 'Staff sign-in required.' });
      if (!(await isAuthorizedSubPortalStaff(staff))) return res.status(403).json({ ok: false, error: 'Your role does not have access to Sub Portal management. Ask an owner, office manager, project manager, or accounting.' });

      const { sub_id, body } = req.body || {};
      if (!sub_id || !body) return res.status(400).json({ ok: false, error: 'sub_id and body are required.' });
      const created = await sb('sub_messages', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ sub_id, sender: 'staff', body }),
      });
      await auditLog(sub_id, 'staff', 'message_sent', { type: 'sub_message', id: created[0].id }, { by: staff.id }, req);
      return res.status(200).json({ ok: true, message: created[0] });
    }

    // ---------------- SUB: redeem a magic link → mint a device session ----------------
    if (action === 'redeem') {
      if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET required' });
      const { token } = req.query;
      if (!token) return res.status(400).json({ ok: false, error: 'token is required' });

      // Rate-limit REDEMPTION by IP (2026-08-02, Codex) so a leaked/guessed
      // token space can't be hammered. Fails closed if the store is unavailable.
      const rl = await checkRateLimit({ bucket: 'subportal:redeem', identifier: clientIp(req), limit: 20, windowMs: 15 * 60 * 1000, deps: { supabaseRequest } });
      if (!rl.allowed) return res.status(429).json({ ok: false, error: 'Too many requests. Please wait a few minutes and try again.' });

      // ATOMIC single-use redemption (2026-08-02): claim the link in ONE
      // conditional UPDATE guarded on `used_at IS NULL AND expires_at > now`,
      // instead of the old select-then-PATCH. Postgres serializes concurrent
      // UPDATEs on the same row, so of two racing requests exactly one sees
      // used_at still NULL and gets 1 row back; the loser re-evaluates the
      // predicate after the winner commits, matches 0 rows, and is rejected.
      // Only an affected-row count of exactly 1 may mint a session. The old
      // read-then-write left a window where two requests could both read the
      // link as unused and both mint a session from a single-use link.
      const nowIso = new Date().toISOString();
      const claimed = await sb(`sub_auth_links?token=eq.${encodeURIComponent(hashToken(token))}&used_at=is.null&expires_at=gt.${encodeURIComponent(nowIso)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ used_at: nowIso }),
      });
      if (!Array.isArray(claimed) || claimed.length !== 1) {
        return res.status(400).json({ ok: false, error: 'This link has expired or was already used. Ask your GH Group contact for a new one.' });
      }
      const link = claimed[0];

      const sessionToken = genToken(32);
      await supabaseRequest('sub_sessions', {
        method: 'POST',
        body: JSON.stringify({ sub_id: link.sub_id, token: hashToken(sessionToken), user_agent: req.headers['user-agent'] || null }),
      });

      const subRows = await sb(`subs?id=eq.${link.sub_id}&select=*`);
      const sub = subRows[0];

      await auditLog(sub.id, 'sub', 'login', { type: 'sub_auth_link', id: link.id }, { purpose: link.purpose }, req);

      return res.status(200).json({ ok: true, sessionToken, sub, reauth: link.purpose === 'reauth' });
    }

    // ---------------- SUB: "text me a new link" recovery ----------------
    // SECURITY (2026-08-01, Item 1): PUBLIC endpoint. Never returns a working
    // link/token, never reveals whether a contact is on file. A match is only
    // acted on when the link is DELIVERABLE to the on-file EMAIL — SMS is not
    // wired, so a phone-only sub is simply not deliverable, and public
    // recovery is effectively disabled for them (spec). Every path returns the
    // same generic 200, so entering someone else's phone/email reveals
    // nothing and hands back nothing.
    if (action === 'login_link') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const { phone_or_email } = req.body || {};
      const GENERIC = {
        ok: true,
        message: 'If that contact is on file, a sign-in link has been sent to the email we have for it. Check your inbox, then come back here.',
      };
      if (!phone_or_email) return res.status(400).json({ ok: false, error: 'phone_or_email is required' });

      const rl = await checkRateLimit({ bucket: 'subportal:login_link', identifier: clientIp(req), limit: 5, windowMs: 15 * 60 * 1000, deps: { supabaseRequest } });
      if (!rl.allowed) return res.status(429).json({ ok: false, error: 'Too many requests. Please wait a few minutes and try again.' });

      const v = phone_or_email.trim();
      const matches = v.includes('@')
        ? await sb(`subs?email=eq.${encodeURIComponent(v.toLowerCase())}&select=*`)
        : await sb(`subs?phone=eq.${encodeURIComponent(v)}&select=*`);
      const sub = matches && matches[0];
      if (sub) {
        const token = genToken(24);
        const link = `${baseUrl(req)}/subportal/?token=${token}`;
        const delivery = await deliverLoginLink({ email: sub.email, url: link, brandName: 'GH Group', purpose: 'sign-in', deps: { supabaseRequest } });
        if (delivery.delivered) {
          await supabaseRequest('sub_auth_links', {
            method: 'POST',
            body: JSON.stringify({ sub_id: sub.id, token: hashToken(token), purpose: 'login', expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString() }),
          });
          await auditLog(sub.id, 'sub', 'login_link_sent', { type: 'sub', id: sub.id }, null, req);
        } else {
          await auditLog(sub.id, 'sub', 'login_link_undeliverable', { type: 'sub', id: sub.id }, null, req);
        }
      }

      return res.status(200).json(GENERIC);
    }

    // ---------------- SUB: start a fresh reauth (for editing banking) ----------------
    // SECURITY (2026-08-02, Codex review of PR #43): the one-time banking
    // re-verification challenge is delivered OUT-OF-BAND to the sub's on-file
    // email. The requesting browser NEVER receives the token or URL and cannot
    // choose or replace the destination (it comes only from the server record),
    // so a STOLEN SESSION cannot reauthenticate itself — the attacker would also
    // need the real contact's inbox. The grant row is created only when delivery
    // succeeds; on missing/failed delivery we fail safe (no token, no grant
    // leaked). The response is generic and identical either way, and the raw
    // token is never returned, logged, or audited. Request is rate-limited.
    if (action === 'reauth_start') {
      const ctx = await requireSub(req, res);
      if (!ctx) return;
      const { sub } = ctx;
      const GENERIC = {
        ok: true,
        message: 'A banking re-verification link has been sent to the email on file for your account. Check your inbox to continue.',
      };

      const rl = await checkRateLimit({ bucket: 'subportal:reauth_start', identifier: `${sub.id}:${clientIp(req)}`, limit: 5, windowMs: 15 * 60 * 1000, deps: { supabaseRequest } });
      if (!rl.allowed) return res.status(429).json({ ok: false, error: 'Too many requests. Please wait a few minutes and try again.' });

      // Destination is server-derived (sub.email) — the browser cannot supply or
      // override it. Delivered via the same secure email path used for sign-in.
      const token = genToken(24);
      const url = `${baseUrl(req)}/subportal/?token=${token}`;
      const delivery = await deliverLoginLink({ email: sub.email, url, brandName: 'GH Group', purpose: 'banking re-verification', deps: { supabaseRequest } });
      if (delivery.delivered) {
        await supabaseRequest('sub_auth_links', {
          method: 'POST',
          body: JSON.stringify({ sub_id: sub.id, token: hashToken(token), purpose: 'reauth', expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() }),
        });
        await auditLog(sub.id, 'sub', 'reauth_link_sent', { type: 'sub', id: sub.id }, null, req);
      } else {
        await auditLog(sub.id, 'sub', 'reauth_link_undeliverable', { type: 'sub', id: sub.id }, null, req);
      }
      // Same generic response whether or not delivery happened; token/URL never returned.
      return res.status(200).json(GENERIC);
    }

    // ---------------- everything below requires a sub session ----------------
    const ctx = await requireSub(req, res);
    if (!ctx) return;
    const { sub } = ctx;

    if (action === 'me') {
      if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET required' });
      const [unread, docsExpiring, rfqsOpen, scheduleUnapproved] = await Promise.all([
        sb(`sub_notifications?sub_id=eq.${sub.id}&read_at=is.null&select=id`),
        sb(`sub_documents?sub_id=eq.${sub.id}&status=neq.current&select=id`),
        sb(`sub_rfqs?sub_id=eq.${sub.id}&status=in.(sent,viewed)&select=id`),
        sb(`sub_schedule_items?sub_id=eq.${sub.id}&status=eq.proposed&select=id`),
      ]);
      return res.status(200).json({
        ok: true,
        sub,
        badges: {
          notifications: unread.length,
          docsExpiring: docsExpiring.length,
          rfqsOpen: rfqsOpen.length,
          scheduleUnapproved: scheduleUnapproved.length,
        },
      });
    }

    if (action === 'profile') {
      if (req.method !== 'PATCH') return res.status(405).json({ ok: false, error: 'PATCH required' });
      const allowed = ['contact_name', 'phone', 'accepts_cc', 'ap_contact_name', 'ap_email', 'license_number', 'license_type'];
      const patch = {};
      for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];

      // Progressive onboarding (spec P0 #1): the moment name + phone exist,
      // the sub graduates from 'invited' to 'active' — everything else
      // (docs, banking) gets chased later through Notifications, never
      // blocking the front door.
      const willHaveName = 'contact_name' in patch ? patch.contact_name : sub.contact_name;
      const willHavePhone = 'phone' in patch ? patch.phone : sub.phone;
      if (sub.status === 'invited' && willHaveName && willHavePhone) {
        patch.status = 'active';
        patch.onboarded_at = new Date().toISOString();
      }

      const updated = await sb(`subs?id=eq.${sub.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(patch),
      });
      await auditLog(sub.id, 'sub', 'profile_updated', { type: 'sub', id: sub.id }, { fields: Object.keys(patch) }, req);
      return res.status(200).json({ ok: true, sub: updated[0] });
    }

    if (action === 'notif_prefs') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const allowed = ['notify_sms', 'notify_email', 'notify_chirp', 'calendar_sync_enabled'];
      const patch = {};
      for (const k of allowed) if (k in (req.body || {})) patch[k] = Boolean(req.body[k]);
      const updated = await sb(`subs?id=eq.${sub.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(patch),
      });
      return res.status(200).json({ ok: true, sub: updated[0] });
    }

    if (action === 'notifications') {
      if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET required' });
      const rows = await sb(`sub_notifications?sub_id=eq.${sub.id}&order=send_after.desc&limit=50&select=*`);
      return res.status(200).json({ ok: true, notifications: rows });
    }

    if (action === 'notifications_read') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const { id, all } = req.body || {};
      const filter = all ? `sub_id=eq.${sub.id}&read_at=is.null` : `id=eq.${id}&sub_id=eq.${sub.id}`;
      await supabaseRequest(`sub_notifications?${filter}`, {
        method: 'PATCH',
        body: JSON.stringify({ read_at: new Date().toISOString() }),
      });
      return res.status(200).json({ ok: true });
    }

    // ---------------- sub: HiveDoc files shared onto their jobs ----------------
    // Distinct from 'documents' above, which is the sub's OWN compliance
    // paperwork. These are company documents (plans, permits, scopes) that
    // somebody deliberately flagged sub_visible on a job this sub is actually
    // booked to. The job list is derived from real assignment rows, never from
    // anything the sub sends, and canSee() re-checks every row after the query.
    if (action === 'job_files') {
      if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET required' });
      const jobIds = await subJobIds(sub, sb);
      const files = await listPortalFiles({
        viewer: { audience: 'subcontractor', jobIds },
        sb,
        sign: signBucketUrl,
      });
      auditLog(sub.id, 'sub', 'job_files_viewed', { type: 'documents' }, { count: files.length }, req).catch(() => {});
      return res.status(200).json({ ok: true, files });
    }

    if (action === 'documents') {
      if (req.method === 'GET') {
        const rows = await sb(`sub_documents?sub_id=eq.${sub.id}&order=uploaded_at.desc&select=*`);
        return res.status(200).json({ ok: true, documents: rows });
      }
      if (req.method === 'POST') {
        const { doc_type, file_data_url, expires_at } = req.body || {};
        if (!doc_type || !file_data_url) return res.status(400).json({ ok: false, error: 'doc_type and file_data_url are required' });
        const path = `${sub.id}/${doc_type}-${Date.now()}`;
        const stored = await uploadDataUrl('sub-documents', path, file_data_url);
        const created = await sb('sub_documents', {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ sub_id: sub.id, doc_type, file_url: stored, expires_at: expires_at || null, status: 'current' }),
        });
        await auditLog(sub.id, 'sub', 'doc_uploaded', { type: 'sub_document', id: created[0].id }, { doc_type }, req);
        return res.status(200).json({ ok: true, document: created[0] });
      }
      return res.status(405).json({ ok: false, error: 'GET or POST required' });
    }

    if (action === 'banking') {
      if (req.method === 'GET') {
        const rows = await sb(`sub_banking?sub_id=eq.${sub.id}&select=*`);
        return res.status(200).json({ ok: true, banking: rows[0] || null });
      }
      if (req.method === 'POST') {
        // P0 #3/#5: editing banking requires a fresh reauth token, not just
        // an already-open session.
        const reauthToken = req.headers['x-reauth-token'];
        if (!reauthToken) return res.status(401).json({ ok: false, error: 'Re-verification required. Request a fresh link before changing banking info.' });

        // Codex review (PR #43): VALIDATE + NORMALIZE all banking input BEFORE
        // the reauth grant is consumed. The previous version consumed the grant
        // first and split the banking writes across two HTTP calls, so invalid
        // input could permanently burn a valid reauthorization and a failure
        // between the writes could leave partial state. Nothing below this
        // validation block mutates anything until the single transactional RPC.
        const body = req.body || {};
        const provider = typeof body.provider === 'string' && body.provider.trim() ? body.provider.trim() : null;
        const providerRef = typeof body.provider_ref === 'string' && body.provider_ref.trim() ? body.provider_ref.trim() : null;
        const maskedAccount = (body.masked_account === undefined || body.masked_account === null || body.masked_account === '')
          ? null
          : String(body.masked_account).trim();
        // Length caps mirror the database function's own validation, so an
        // over-long value fails fast here with a clear 400 (and never reaches
        // the grant). The DB re-checks these as defense in depth.
        if ((provider !== null && provider.length > 64) || (providerRef !== null && providerRef.length > 128)) {
          return res.status(400).json({ ok: false, error: 'provider/provider_ref is too long.' });
        }
        // P0 #2, enforced in code: reject anything that isn't already a masked
        // display value. This endpoint physically cannot accept a raw
        // account/routing number. Rejecting here (before the RPC) means an
        // invalid value never touches — never consumes — the reauth grant.
        if (maskedAccount !== null && (maskedAccount.length > 32 || !looksLikeSafeMask(maskedAccount))) {
          return res.status(400).json({ ok: false, error: 'Only a masked account value (e.g. ****1234) is accepted here — never a full account number.' });
        }
        const setAcceptsCc = Object.prototype.hasOwnProperty.call(body, 'accepts_cc');
        const acceptsCc = setAcceptsCc ? Boolean(body.accepts_cc) : false;

        // ONE transactional RPC does everything atomically: find the grant by
        // its HASH, verify it is unused + purpose='reauth' + within the window,
        // consume it exactly once, apply the optional accepts_cc change and the
        // sub_banking upsert — all committed together or all rolled back. A
        // concurrent second submit blocks on the grant row, then matches zero
        // rows once the first commits, so exactly one banking change lands. A
        // DB error anywhere rolls back the whole transaction, INCLUDING the
        // consume, so no grant is burned and no partial state remains.
        const result = await sb('rpc/consume_sub_reauth_and_apply_banking', {
          method: 'POST',
          body: JSON.stringify({
            p_sub_id: sub.id,
            p_token_hash: hashToken(reauthToken),
            p_provider: provider,
            p_provider_ref: providerRef,
            p_masked_account: maskedAccount,
            p_set_accepts_cc: setAcceptsCc,
            p_accepts_cc: acceptsCc,
          }),
        });

        // VALIDATE THE COMPLETE RPC RESULT (2026-08-02, Codex). Report success
        // ONLY for exactly one valid scalar object carrying ok===true, a banking
        // object with a nonempty id, banking.sub_id bound to THIS authenticated
        // sub, and stable field types. Anything else — the invalid_reauth path,
        // an empty/array/malformed body, a mismatched sub_id — fails closed with
        // NO success audit. (A thrown DB error is caught by the outer try and
        // also fails closed; the transaction rolled back, so no grant is burned.)
        const banking = result && typeof result === 'object' && !Array.isArray(result) ? result.banking : null;
        const validResult =
          result && typeof result === 'object' && !Array.isArray(result) &&
          result.ok === true &&
          banking && typeof banking === 'object' && !Array.isArray(banking) &&
          typeof banking.id === 'string' && banking.id.length > 0 &&
          banking.sub_id === sub.id &&
          typeof banking.accepts_ach === 'boolean' &&
          (banking.updated_at === null || typeof banking.updated_at === 'string');
        if (!validResult) {
          return res.status(401).json({ ok: false, error: 'That verification has expired or was already used. Request a fresh link and try again.' });
        }

        await auditLog(sub.id, 'sub', 'banking_updated', { type: 'sub_banking', id: banking.id }, null, req);
        return res.status(200).json({ ok: true, banking });
      }
      return res.status(405).json({ ok: false, error: 'GET or POST required' });
    }

    if (action === 'account') {
      if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET required' });
      const [documents, banking] = await Promise.all([
        sb(`sub_documents?sub_id=eq.${sub.id}&order=uploaded_at.desc&select=*`),
        sb(`sub_banking?sub_id=eq.${sub.id}&select=*`),
      ]);
      return res.status(200).json({ ok: true, sub, documents, banking: banking[0] || null });
    }

    if (action === 'jobs') {
      if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET required' });
      const [rfqs, schedule] = await Promise.all([
        sb(`sub_rfqs?sub_id=eq.${sub.id}&order=due_date.asc&select=*`),
        sb(`sub_schedule_items?sub_id=eq.${sub.id}&order=start_at.asc&select=*`),
      ]);
      return res.status(200).json({ ok: true, rfqs, schedule });
    }

    if (action === 'rfqs') {
      if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET required' });
      const rows = await sb(`sub_rfqs?sub_id=eq.${sub.id}&order=due_date.asc&select=*`);
      return res.status(200).json({ ok: true, rfqs: rows });
    }

    if (action === 'rfq_bid') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const { rfq_id, bid_amount, bid_notes } = req.body || {};
      if (!rfq_id || bid_amount === undefined) return res.status(400).json({ ok: false, error: 'rfq_id and bid_amount are required' });
      const updated = await sb(`sub_rfqs?id=eq.${rfq_id}&sub_id=eq.${sub.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ status: 'bid_submitted', bid_amount: numOrNull(bid_amount), bid_notes: bid_notes || null, bid_submitted_at: new Date().toISOString() }),
      });
      if (!updated.length) return res.status(404).json({ ok: false, error: 'RFQ not found for this account.' });
      await auditLog(sub.id, 'sub', 'bid_submitted', { type: 'sub_rfq', id: rfq_id }, { bid_amount: numOrNull(bid_amount) }, req);
      return res.status(200).json({ ok: true, rfq: updated[0] });
    }

    if (action === 'rfis') {
      if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET required' });
      const rows = await sb(`sub_rfis?sub_id=eq.${sub.id}&order=created_at.desc&select=*`);
      return res.status(200).json({ ok: true, rfis: rows });
    }

    if (action === 'rfi_ask') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const { job_ref, question } = req.body || {};
      if (!question) return res.status(400).json({ ok: false, error: 'question is required' });
      const created = await sb('sub_rfis', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ sub_id: sub.id, job_ref: job_ref || null, question }),
      });
      await auditLog(sub.id, 'sub', 'rfi_asked', { type: 'sub_rfi', id: created[0].id }, null, req);
      return res.status(200).json({ ok: true, rfi: created[0] });
    }

    if (action === 'schedule') {
      if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET required' });
      // Two sources, one list. A sub used to have a schedule here and a
      // separate existence on the dispatch board, with nothing tying them
      // together -- the plan's third hard truth. Native appointments assigned
      // to this sub now appear in the same list, so the portal and the board
      // are finally showing the same work.
      //
      // sub_schedule_items is still read, not replaced: retiring it before
      // parity is proven would lose whatever is already in it.
      const [rows, appts] = await Promise.all([
        sb(`sub_schedule_items?sub_id=eq.${sub.id}&order=start_at.asc&select=*`),
        sb(`hl_appointments?sub_id=eq.${sub.id}&canceled=eq.false&order=start_at.asc&select=id,title,client,start_at,end_at,confirm_state,job_no,details`),
      ]);
      const fromBoard = (appts || []).map((a) => ({
        id: a.id,
        source: 'appointment',           // tells the portal which respond path to use
        title: a.title || a.client || 'Scheduled work',
        start_at: a.start_at,
        end_at: a.end_at,
        job_no: a.job_no || null,
        // Mapped onto the vocabulary the portal already speaks, so the UI needs
        // no new states: confirmed -> approved, declined -> change_requested.
        status: a.confirm_state === 'confirmed' ? 'approved'
          : a.confirm_state === 'declined' ? 'change_requested' : 'proposed',
      }));
      const legacy = (rows || []).map((r) => Object.assign({ source: 'sub_schedule_item' }, r));
      const schedule = legacy.concat(fromBoard)
        .sort((a, b) => String(a.start_at || '').localeCompare(String(b.start_at || '')));
      return res.status(200).json({ ok: true, schedule });
    }

    if (action === 'schedule_respond') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const { id, response, note } = req.body || {};
      if (!id || !['approved', 'change_requested'].includes(response)) {
        return res.status(400).json({ ok: false, error: "id and response ('approved' or 'change_requested') are required" });
      }
      // A native appointment answers on hl_appointments.confirm_state -- the
      // same column the customer confirm link writes -- so one entry has one
      // answer no matter which door it came through. Scoped by sub_id as well
      // as id, so a sub can only ever answer for their own work.
      const isAppointment = (req.body || {}).source === 'appointment';
      const updated = isAppointment
        ? await sb(`hl_appointments?id=eq.${id}&sub_id=eq.${sub.id}`, {
            method: 'PATCH',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify({
              confirm_state: response === 'approved' ? 'confirmed' : 'declined',
              confirmed_at: new Date().toISOString(),
            }),
          })
        : await sb(`sub_schedule_items?id=eq.${id}&sub_id=eq.${sub.id}`, {
            method: 'PATCH',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify({ status: response, change_note: note || null }),
          });
      if (!updated.length) return res.status(404).json({ ok: false, error: 'Schedule item not found for this account.' });
      await auditLog(sub.id, 'sub', `schedule_${response}`, { type: 'sub_schedule_item', id }, { note: note || null }, req);
      return res.status(200).json({ ok: true, item: updated[0] });
    }

    if (action === 'calendar.ics') {
      // Read-only webcal subscription (spec P1 #9) — token passed as a
      // query param because calendar apps can't send custom headers. This
      // is a capability URL: anyone with the link can read the schedule,
      // nothing more; revoking the sub's session invalidates it.
      if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET required' });
      const rows = await sb(`sub_schedule_items?sub_id=eq.${sub.id}&order=start_at.asc&select=*`);
      const ics = buildIcs(sub, rows);
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Content-Disposition', 'inline; filename="schedule.ics"');
      return res.status(200).send(ics);
    }

    if (action === 'invoices') {
      if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET required' });
      const rows = await sb(`sub_invoices?sub_id=eq.${sub.id}&order=submitted_at.desc&select=*`);
      return res.status(200).json({ ok: true, invoices: rows });
    }

    if (action === 'invoice_submit') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const { job_ref, file_data_url, amount } = req.body || {};
      if (!file_data_url) return res.status(400).json({ ok: false, error: 'file_data_url is required' });
      const path = `${sub.id}/invoice-${Date.now()}`;
      const stored = await uploadDataUrl('sub-invoices', path, file_data_url);
      const created = await sb('sub_invoices', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          sub_id: sub.id,
          job_ref: job_ref || null,
          file_url: stored,
          amount: numOrNull(amount),
          amount_source: amount !== undefined && amount !== null && amount !== '' ? 'manual' : 'pending_ocr',
        }),
      });
      await auditLog(sub.id, 'sub', 'invoice_submitted', { type: 'sub_invoice', id: created[0].id }, { amount: numOrNull(amount) }, req);
      return res.status(200).json({ ok: true, invoice: created[0] });
    }

    if (action === 'invoice_followup') {
      // Spec P1 #11: this creates a task on the STAFF side (visible via
      // sub_audit_log today) rather than the sub directly emailing anyone.
      // A dedicated staff Approval Inbox surface for this is a follow-up,
      // not a Phase 1 blocker.
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const { invoice_id } = req.body || {};
      if (!invoice_id) return res.status(400).json({ ok: false, error: 'invoice_id is required' });
      await auditLog(sub.id, 'sub', 'invoice_followup_requested', { type: 'sub_invoice', id: invoice_id }, null, req);
      return res.status(200).json({ ok: true, note: "We've flagged this for the office to follow up." });
    }

    if (action === 'messages') {
      if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET required' });
      const rows = await sb(`sub_messages?sub_id=eq.${sub.id}&order=created_at.asc&select=*`);
      return res.status(200).json({ ok: true, messages: rows });
    }

    if (action === 'message_send') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const { body } = req.body || {};
      if (!body) return res.status(400).json({ ok: false, error: 'body is required' });
      const created = await sb('sub_messages', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ sub_id: sub.id, sender: 'sub', body }),
      });
      await auditLog(sub.id, 'sub', 'message_sent', { type: 'sub_message', id: created[0].id }, null, req);
      return res.status(200).json({ ok: true, message: created[0] });
    }

    return res.status(400).json({ ok: false, error: `Unknown action "${action}"` });
  } catch (e) {
    console.error('subportal error:', e);
    return res.status(502).json({ ok: false, error: e.message });
  }
}

function icsEscape(s) {
  return String(s || '').replace(/[\\,;]/g, (m) => `\\${m}`).replace(/\n/g, '\\n');
}
function icsDate(d) {
  return new Date(d).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}
function buildIcs(sub, items) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//HiveLogic//Sub Portal//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${icsEscape(sub.company_name)} — GH Group Schedule`];
  for (const it of items) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${it.id}@hivelogic-subportal`,
      `DTSTAMP:${icsDate(new Date())}`,
      `DTSTART:${icsDate(it.start_at)}`,
      `DTEND:${icsDate(it.end_at || it.start_at)}`,
      `SUMMARY:${icsEscape(it.title)}`,
      `STATUS:${it.status === 'approved' ? 'CONFIRMED' : 'TENTATIVE'}`,
      'END:VEVENT'
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
