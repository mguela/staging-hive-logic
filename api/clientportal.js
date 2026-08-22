// api/clientportal.js — Vercel serverless function
//
// CLIENT PORTAL — ONE consolidated route (same discipline as api/subportal.js
// and api/track1.js: every client-portal endpoint is an ?action= on this
// single file, to stay under Vercel's per-plan function-count limit).
// Frontend: public/clientportal/.
//
// KEY DIFFERENCE FROM THE SUB PORTAL: client identity is NOT a portal-owned
// table. Clients already exist as real records in the `clients` table,
// synced from Jobber by api/jobber/sync.js (cron'd, see vercel.json). This
// file never creates or edits a client — it only reads that table (by
// jobber_id, called `client_ref` everywhere below) and layers portal-native
// tables on top: auth, messaging, notifications, approvals, and payment
// requests. Jobs and invoices are read live from the same real synced
// tables the internal app uses (`jobs`, `invoices`) — never duplicated.
//
// AUTH MODEL (mirrors the Sub Portal's two-token design):
//   - client_auth_links: single-use, short-lived magic-link tokens.
//   - client_sessions: long-lived device session token, minted on redeem.
//     Every session-scoped action below requires
//     `Authorization: Bearer <client_sessions.token>` and is scoped
//     server-side to that row's client_ref — never trusted from the body.
//
// LOGIN IS EMAIL-ONLY IN PHASE 1 (disclosed honestly, not silently
// half-built): api/jobber/sync.js's CLIENTS_QUERY only pulls
// defaultEmails, not phone — so `clients.phone` doesn't exist yet to match
// against. Adding phone is a small follow-up to that sync query, not a
// blocker here.
//
// NOT YET WIRED (Law #1: disclosed, not faked):
//   - SMS/email dispatch: login_link and invite both return the link
//     directly in the API response, same as the Sub Portal, for the same
//     reason — no Twilio/SendGrid connection exists yet.
//   - Live payment processing: Chris's call — Phase 1 payments are a
//     REQUEST, not a charge. `client_payments` rows only ever move
//     requested -> sent_to_office. Whether an invoice is actually paid
//     still comes from Jobber's synced invoices.payments field, exactly as
//     it does in the internal app today. See sql/013_client_portal.sql's
//     header note.

import { supabaseRequest } from './_lib/jobber.js';
import { genToken, hashToken, checkRateLimit, deliverLoginLink } from './_lib/portal-auth.js';
import { hasAllowedRole } from './_lib/permission-roles.js';

// ---------------------------------------------------------------------------
// small helpers (same shapes as api/subportal.js, duplicated on purpose so
// this file has no runtime dependency on it)
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

async function auditLog(clientRef, actor, action, entity = {}, detail = null, req = null) {
  try {
    await supabaseRequest('client_audit_log', {
      method: 'POST',
      body: JSON.stringify({
        client_ref: clientRef || null,
        actor,
        action,
        entity_type: entity.type || null,
        entity_id: entity.id || null,
        detail: detail || null,
        ip: req ? clientIp(req) : null,
      }),
    });
  } catch (e) {
    console.error('client_audit_log write failed (non-fatal):', e.message);
  }
}

function baseUrl(req) {
  if (process.env.CLIENTPORTAL_BASE_URL) return process.env.CLIENTPORTAL_BASE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${req.headers.host}`;
}

// ---------------------------------------------------------------------------
// staff auth — mirrors api/track1.js's getRequestingProfile() / the Sub
// Portal's getStaffProfile() exactly. Duplicated on purpose.
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

// Role gate, Phase 2 (2026-08-06): same rationale/list as the Sub Portal's
// isAuthorizedSubPortalStaff -- no pre-existing nav-side policy to mirror
// for Client Portal management specifically, so this is a new call (not a
// pre-decided one). Flag to Chris if another role should also manage client
// invites/approvals/photo-sharing.
// 2026-08-10: Stage 2 permission redesign -- old owner/partner/office_manager/
// systems_pm (all identical "full access" roles) collapsed into "owner",
// accounting renamed to office_ar. See sql/066_permission_roles_v2.sql.
const CLIENT_PORTAL_STAFF_ROLES = ['owner', 'project_manager', 'office_ar'];
async function isAuthorizedClientPortalStaff(staff) {
  return hasAllowedRole(staff, CLIENT_PORTAL_STAFF_ROLES);
}

// ---------------------------------------------------------------------------
// client session auth. Unlike the Sub Portal, the "identity" record lives
// in the real `clients` table (owned by the Jobber sync), not a
// portal-owned one — so redeeming/resolving a session re-reads it live,
// which also means the portal always reflects the latest synced name/
// balance without any extra sync step of its own.
// ---------------------------------------------------------------------------
async function getClientByRef(clientRef) {
  const rows = await sb(`clients?jobber_id=eq.${encodeURIComponent(clientRef)}&select=*`);
  return (rows && rows[0]) || null;
}

async function getClientSession(req) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  // Sessions are stored hashed (2026-08-01): hash the presented bearer and
  // look the row up by its hash. The raw token never touches the database.
  const rows = await sb(`client_sessions?token=eq.${encodeURIComponent(hashToken(token))}&revoked_at=is.null&select=*`);
  if (!rows || !rows.length) return null;
  const session = rows[0];
  supabaseRequest(`client_sessions?id=eq.${session.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ last_seen_at: new Date().toISOString() }),
  }).catch(() => {});
  const client = await getClientByRef(session.client_ref);
  if (!client) return null;
  return { session, client, clientRef: session.client_ref };
}

async function requireClient(req, res) {
  const ctx = await getClientSession(req);
  if (!ctx) {
    res.status(401).json({ ok: false, error: 'Not signed in. This link may have expired — request a new one.' });
    return null;
  }
  return ctx;
}

function clientDisplayName(c) {
  if (!c) return null;
  return c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company_name || 'there';
}

// ---------------------------------------------------------------------------
// HiveSight photo access. Photos live in the PRIVATE 'media' Storage bucket
// (sql/006_visual_intel.sql, imported from CompanyCam and captured in-app).
// The client portal never exposes the bucket directly — it only mints
// short-lived signed URLs, and ONLY for media ids that have a live
// (non-revoked) row in client_photo_shares (sql/014). No share row = the
// photo does not exist as far as the client is concerned. That's the
// pre-approval rule, enforced server-side, not just in UI.
// ---------------------------------------------------------------------------
async function signMediaUrl(storagePath, expiresInSeconds = 3600) {
  const res = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/sign/media/${storagePath}`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: expiresInSeconds }),
  });
  if (!res.ok) return null; // photo row exists but file is unreachable — skip it honestly rather than 500 the whole gallery
  const data = await res.json();
  return data && data.signedURL ? `${process.env.SUPABASE_URL}/storage/v1${data.signedURL}` : null;
}

// A simple, computed-not-invented job stage — Jobber's own job_status enum
// isn't confirmed field-for-field here, so this derives a stage from dates
// only (same "computed, not invented" rule api/invoices.js uses for
// balance), rather than guessing at Jobber's internal status strings.
function jobStage(j) {
  if (j.completed_at) return 'completed';
  if (j.start_at && new Date(j.start_at).getTime() <= Date.now()) return 'in_progress';
  if (j.start_at) return 'scheduled';
  return 'estimate';
}

// ---------------------------------------------------------------------------
// handler
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  const action = req.query.action;

  try {
    // ---------------- STAFF: invite an existing Jobber client ----------------
    if (action === 'invite') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const staff = await getStaffProfile(req);
      if (!staff) return res.status(401).json({ ok: false, error: 'Staff sign-in required to invite a client.' });
      if (!(await isAuthorizedClientPortalStaff(staff))) return res.status(403).json({ ok: false, error: 'Your role does not have access to Client Portal management. Ask an owner, office manager, project manager, or accounting.' });

      const { email } = req.body || {};
      if (!email) return res.status(400).json({ ok: false, error: 'email is required — must match the email already on the client\'s Jobber record.' });

      // ilike (no wildcards) = case-insensitive exact match -- Jobber-synced emails
      // aren't guaranteed lowercase (e.g. 'CHRIS@X.COM'), but clients naturally
      // type their own email in whatever case is comfortable, so the lookup
      // must ignore case on both sides, not just normalize the input.
      const matches = await sb(`clients?email=ilike.${encodeURIComponent(email.trim())}&select=*`);
      const client = matches && matches[0];
      if (!client) {
        return res.status(404).json({ ok: false, error: `No synced Jobber client has that email on file. Check the email matches their Jobber record exactly, or wait for the next sync.` });
      }

      const token = genToken(24);
      await supabaseRequest('client_auth_links', {
        method: 'POST',
        body: JSON.stringify({
          client_ref: client.jobber_id,
          token: hashToken(token), // store the hash; raw token lives only in the URL/email
          purpose: 'invite',
          expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
        }),
      });

      const inviteUrl = `${baseUrl(req)}/clientportal/?token=${token}`;
      // Deliver the link out-of-band to the client's on-file email when we can.
      const delivery = await deliverLoginLink({ email: client.email, url: inviteUrl, brandName: 'GH Group', purpose: 'portal invite', deps: { supabaseRequest } });
      await auditLog(client.jobber_id, 'staff', 'invite_created', { type: 'client', id: client.jobber_id }, { by: staff.id, delivered: delivery.delivered }, req);

      return res.status(200).json({
        ok: true,
        client: { jobber_id: client.jobber_id, name: clientDisplayName(client), email: client.email },
        // inviteUrl is returned only to authenticated staff (never a public
        // response) so an admin can still deliver it by hand when email
        // delivery isn't configured. It is NOT returned on the public
        // login_link recovery path below.
        inviteUrl,
        delivered: delivery.delivered,
        note: delivery.delivered
          ? 'Invite link emailed to the client.'
          : 'Email delivery is not configured — copy this link to the client yourself for now.',
      });
    }

    // ---------------- STAFF: create an estimate/change-order approval ----------------
    if (action === 'approval_create') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const staff = await getStaffProfile(req);
      if (!staff) return res.status(401).json({ ok: false, error: 'Staff sign-in required.' });
      if (!(await isAuthorizedClientPortalStaff(staff))) return res.status(403).json({ ok: false, error: 'Your role does not have access to Client Portal management. Ask an owner, office manager, project manager, or accounting.' });

      const { client_ref, job_ref, kind, number, title, description, amount, payment_terms, doc_url } = req.body || {};
      if (!client_ref || !kind || !title) return res.status(400).json({ ok: false, error: 'client_ref, kind, and title are required.' });
      if (!['estimate', 'change_order'].includes(kind)) return res.status(400).json({ ok: false, error: "kind must be 'estimate' or 'change_order'." });

      const created = await sb('client_approvals', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          client_ref, job_ref: job_ref || null, kind, number: number || null, title,
          description: description || null, amount: numOrNull(amount),
          payment_terms: payment_terms || null, doc_url: doc_url || null,
        }),
      });
      await auditLog(client_ref, 'staff', 'approval_created', { type: 'client_approval', id: created[0].id }, { kind, by: staff.id }, req);
      return res.status(200).json({ ok: true, approval: created[0] });
    }

    // ---------------- STAFF: review + approve photos for a client ----------------
    if (action === 'photos_review') {
      // Lists every HiveSight photo on a job alongside its share status, so
      // staff can see exactly what is and isn't client-visible.
      if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET required' });
      const staff = await getStaffProfile(req);
      if (!staff) return res.status(401).json({ ok: false, error: 'Staff sign-in required.' });
      if (!(await isAuthorizedClientPortalStaff(staff))) return res.status(403).json({ ok: false, error: 'Your role does not have access to Client Portal management. Ask an owner, office manager, project manager, or accounting.' });
      const { job_ref } = req.query;
      if (!job_ref) return res.status(400).json({ ok: false, error: 'job_ref is required' });

      const [mediaRows, jobRows] = await Promise.all([
        sb(`media?job_id=eq.${encodeURIComponent(job_ref)}&media_type=eq.PHOTO&order=captured_at.desc&select=id,storage_path,captured_at`),
        sb(`jobs?jobber_id=eq.${encodeURIComponent(job_ref)}&select=jobber_id,client_id,title`),
      ]);
      const job = jobRows && jobRows[0];
      if (!job) return res.status(404).json({ ok: false, error: 'Job not found.' });
      const shares = await sb(`client_photo_shares?job_ref=eq.${encodeURIComponent(job_ref)}&select=media_id,revoked_at`);
      const shareByMedia = new Map(shares.map((s) => [s.media_id, s]));

      const photos = [];
      for (const m of mediaRows) {
        const share = shareByMedia.get(m.id);
        photos.push({
          media_id: m.id,
          captured_at: m.captured_at,
          shared: Boolean(share && !share.revoked_at),
          url: await signMediaUrl(m.storage_path, 600), // 10 min — staff review only
        });
      }
      return res.status(200).json({ ok: true, job: { id: job.jobber_id, title: job.title, client_ref: job.client_id }, photos });
    }

    if (action === 'photo_share' || action === 'photo_revoke') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const staff = await getStaffProfile(req);
      if (!staff) return res.status(401).json({ ok: false, error: 'Staff sign-in required.' });
      if (!(await isAuthorizedClientPortalStaff(staff))) return res.status(403).json({ ok: false, error: 'Your role does not have access to Client Portal management. Ask an owner, office manager, project manager, or accounting.' });
      const { media_id, note } = req.body || {};
      if (!media_id) return res.status(400).json({ ok: false, error: 'media_id is required' });

      const mediaRows = await sb(`media?id=eq.${encodeURIComponent(media_id)}&select=id,job_id`);
      const media = mediaRows && mediaRows[0];
      if (!media) return res.status(404).json({ ok: false, error: 'Photo not found.' });
      const jobRows = await sb(`jobs?jobber_id=eq.${encodeURIComponent(media.job_id)}&select=jobber_id,client_id`);
      const job = jobRows && jobRows[0];
      if (!job || !job.client_id) return res.status(400).json({ ok: false, error: "This photo's job has no client attached — nothing to share it with." });

      if (action === 'photo_share') {
        const upserted = await sb('client_photo_shares?on_conflict=media_id,client_ref', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
          body: JSON.stringify({ media_id, client_ref: job.client_id, job_ref: job.jobber_id, shared_by: staff.id, note: note || null, revoked_at: null }),
        });
        // Tell the client something new is waiting — through the portal's own
        // notification feed (SMS/email dispatch still not wired, disclosed).
        await supabaseRequest('client_notifications', {
          method: 'POST',
          body: JSON.stringify({ client_ref: job.client_id, type: 'job_update', title: 'New project photos', body: 'Fresh photos from your project are ready to view.', entity_type: 'client_photo_share', entity_id: upserted[0].id }),
        }).catch(() => {});
        await auditLog(job.client_id, 'staff', 'photo_shared', { type: 'client_photo_share', id: upserted[0].id }, { media_id, by: staff.id }, req);
        return res.status(200).json({ ok: true, share: upserted[0] });
      } else {
        const updated = await sb(`client_photo_shares?media_id=eq.${encodeURIComponent(media_id)}&client_ref=eq.${encodeURIComponent(job.client_id)}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ revoked_at: new Date().toISOString() }),
        });
        await auditLog(job.client_id, 'staff', 'photo_revoked', { type: 'client_photo_share', id: updated[0] && updated[0].id }, { media_id, by: staff.id }, req);
        return res.status(200).json({ ok: true });
      }
    }

    // ---------------- CLIENT: redeem a magic link → mint a device session ----------------
    if (action === 'redeem') {
      if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET required' });
      const { token } = req.query;
      if (!token) return res.status(400).json({ ok: false, error: 'token is required' });

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
      const claimed = await sb(`client_auth_links?token=eq.${encodeURIComponent(hashToken(token))}&used_at=is.null&expires_at=gt.${encodeURIComponent(nowIso)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ used_at: nowIso }),
      });
      if (!Array.isArray(claimed) || claimed.length !== 1) {
        return res.status(400).json({ ok: false, error: 'This link has expired or was already used. Ask your GH Group contact for a new one.' });
      }
      const link = claimed[0];

      // Link is now consumed. Resolve the client record it points at. If the
      // client is gone (rare — a synced record vanished), the link stays spent
      // and the user simply requests a fresh one; we never mint without a link.
      const client = await getClientByRef(link.client_ref);
      if (!client) return res.status(404).json({ ok: false, error: 'That client record is no longer on file.' });

      const sessionToken = genToken(32);
      await supabaseRequest('client_sessions', {
        method: 'POST',
        body: JSON.stringify({ client_ref: link.client_ref, token: hashToken(sessionToken), user_agent: req.headers['user-agent'] || null }),
      });

      await auditLog(link.client_ref, 'client', 'login', { type: 'client_auth_link', id: link.id }, { purpose: link.purpose }, req);

      return res.status(200).json({ ok: true, sessionToken, client: { jobber_id: client.jobber_id, name: clientDisplayName(client), email: client.email } });
    }

    // ---------------- CLIENT: "email me a new link" recovery ----------------
    // SECURITY (2026-08-01, Item 1): this is a PUBLIC endpoint. It must never
    // return a working link/token in its response, and must never reveal
    // whether an email is on file. It looks the client up, and — only when a
    // match exists AND the link is deliverable to the on-file email — creates
    // a (hashed) magic link and emails it to that on-file address. Every path
    // returns the SAME generic 200, so an attacker entering someone else's
    // email learns nothing and receives nothing (the link, if any, goes to
    // the real owner's inbox, not the response).
    if (action === 'login_link') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const { email } = req.body || {};
      // Generic, account-independent response reused for every outcome.
      const GENERIC = {
        ok: true,
        message: 'If that email is on file, a sign-in link has been sent to it. Check your inbox, then come back here.',
      };
      if (!email) return res.status(400).json({ ok: false, error: 'email is required' });

      // Throttle by IP: caps how fast the recovery form can be used to probe
      // emails or blast sign-in messages. Fails CLOSED if the store errors
      // (returns 429), so an outage can't be used to disable the throttle.
      const rl = await checkRateLimit({ bucket: 'clientportal:login_link', identifier: clientIp(req), limit: 5, windowMs: 15 * 60 * 1000, deps: { supabaseRequest } });
      if (!rl.allowed) return res.status(429).json({ ok: false, error: 'Too many requests. Please wait a few minutes and try again.' });

      const matches = await sb(`clients?email=eq.${encodeURIComponent(email.trim().toLowerCase())}&select=*`);
      const client = matches && matches[0];
      if (client) {
        const token = genToken(24);
        const link = `${baseUrl(req)}/clientportal/?token=${token}`;
        const delivery = await deliverLoginLink({ email: client.email, url: link, brandName: 'GH Group', purpose: 'sign-in', deps: { supabaseRequest } });
        // Only persist a usable link when we could actually deliver it out of
        // band. If delivery isn't available, public recovery is effectively
        // disabled for this account (spec: "if delivery isn't ready, disable
        // public account recovery") — no link is created and none is returned.
        if (delivery.delivered) {
          await supabaseRequest('client_auth_links', {
            method: 'POST',
            body: JSON.stringify({ client_ref: client.jobber_id, token: hashToken(token), purpose: 'login', expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString() }),
          });
          await auditLog(client.jobber_id, 'client', 'login_link_sent', { type: 'client', id: client.jobber_id }, null, req);
        } else {
          await auditLog(client.jobber_id, 'client', 'login_link_undeliverable', { type: 'client', id: client.jobber_id }, null, req);
        }
      }

      // Identical response whether or not the account exists / was deliverable.
      return res.status(200).json(GENERIC);
    }

    // ---------------- everything below requires a client session ----------------
    const ctx = await requireClient(req, res);
    if (!ctx) return;
    const { client, clientRef } = ctx;

    if (action === 'me') {
      if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET required' });
      const [unread, approvalsPending] = await Promise.all([
        sb(`client_notifications?client_ref=eq.${encodeURIComponent(clientRef)}&read_at=is.null&select=id`),
        sb(`client_approvals?client_ref=eq.${encodeURIComponent(clientRef)}&status=eq.pending&select=id`),
      ]);
      return res.status(200).json({
        ok: true,
        client: { jobber_id: client.jobber_id, name: clientDisplayName(client), email: client.email, balance: client.balance },
        badges: { notifications: unread.length, approvalsPending: approvalsPending.length },
      });
    }

    if (action === 'notifications') {
      if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET required' });
      const rows = await sb(`client_notifications?client_ref=eq.${encodeURIComponent(clientRef)}&order=send_after.desc&limit=50&select=*`);
      return res.status(200).json({ ok: true, notifications: rows });
    }

    if (action === 'notifications_read') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const { id, all } = req.body || {};
      const filter = all
        ? `client_ref=eq.${encodeURIComponent(clientRef)}&read_at=is.null`
        : `id=eq.${id}&client_ref=eq.${encodeURIComponent(clientRef)}`;
      await supabaseRequest(`client_notifications?${filter}`, {
        method: 'PATCH',
        body: JSON.stringify({ read_at: new Date().toISOString() }),
      });
      return res.status(200).json({ ok: true });
    }

    if (action === 'jobs') {
      if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET required' });
      const rows = await sb(`jobs?client_id=eq.${encodeURIComponent(clientRef)}&order=jobber_updated_at.desc&select=*`);
      const jobs = rows.map((j) => ({
        id: j.jobber_id, title: j.title, jobNumber: j.job_number, total: j.total,
        startAt: j.start_at, endAt: j.end_at, completedAt: j.completed_at,
        stage: jobStage(j),
      }));
      return res.status(200).json({ ok: true, jobs });
    }

    if (action === 'job') {
      if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET required' });
      const { id } = req.query;
      if (!id) return res.status(400).json({ ok: false, error: 'id is required' });
      const rows = await sb(`jobs?jobber_id=eq.${encodeURIComponent(id)}&client_id=eq.${encodeURIComponent(clientRef)}&select=*`);
      const j = rows && rows[0];
      if (!j) return res.status(404).json({ ok: false, error: 'Job not found for this account.' });
      const [approvals, invoices] = await Promise.all([
        sb(`client_approvals?client_ref=eq.${encodeURIComponent(clientRef)}&job_ref=eq.${encodeURIComponent(id)}&order=sent_at.desc&select=*`),
        sb(`invoices?client_id=eq.${encodeURIComponent(clientRef)}&select=*`),
      ]);
      return res.status(200).json({
        ok: true,
        job: { id: j.jobber_id, title: j.title, jobNumber: j.job_number, total: j.total, startAt: j.start_at, endAt: j.end_at, completedAt: j.completed_at, stage: jobStage(j) },
        approvals,
        invoices: invoices.filter((i) => true).map(mapInvoice),
      });
    }

    if (action === 'photos') {
      // Only photos with a live share row — the approval gate. Signed URLs
      // expire in an hour; the client just reloads the tab for fresh ones.
      if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET required' });
      const shares = await sb(`client_photo_shares?client_ref=eq.${encodeURIComponent(clientRef)}&revoked_at=is.null&order=created_at.desc&limit=200&select=*`);
      if (!shares.length) return res.status(200).json({ ok: true, photos: [] });

      const mediaIds = shares.map((s) => `"${s.media_id}"`).join(',');
      const [mediaRows, jobRows] = await Promise.all([
        sb(`media?id=in.(${mediaIds})&select=id,storage_path,captured_at,job_id`),
        sb(`jobs?client_id=eq.${encodeURIComponent(clientRef)}&select=jobber_id,title,job_number`),
      ]);
      const mediaById = new Map(mediaRows.map((m) => [m.id, m]));
      const jobByRef = new Map(jobRows.map((j) => [j.jobber_id, j]));

      const photos = [];
      for (const s of shares) {
        const m = mediaById.get(s.media_id);
        if (!m) continue;
        const url = await signMediaUrl(m.storage_path, 3600);
        if (!url) continue;
        const job = jobByRef.get(s.job_ref);
        photos.push({
          id: s.media_id,
          url,
          capturedAt: m.captured_at,
          note: s.note,
          jobRef: s.job_ref,
          jobTitle: (job && (job.title || job.job_number)) || 'Your project',
        });
      }
      return res.status(200).json({ ok: true, photos });
    }

    if (action === 'approvals') {
      if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET required' });
      const rows = await sb(`client_approvals?client_ref=eq.${encodeURIComponent(clientRef)}&order=sent_at.desc&select=*`);
      return res.status(200).json({ ok: true, approvals: rows });
    }

    if (action === 'approval_sign') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const { id, signer_name, agree } = req.body || {};
      if (!id || !signer_name || !agree) return res.status(400).json({ ok: false, error: 'id, signer_name, and agree are required.' });
      const updated = await sb(`client_approvals?id=eq.${id}&client_ref=eq.${encodeURIComponent(clientRef)}&status=eq.pending`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ status: 'approved', responded_at: new Date().toISOString(), signer_name, signature_ip: clientIp(req) }),
      });
      if (!updated.length) return res.status(404).json({ ok: false, error: 'Nothing pending with that id for this account.' });
      await auditLog(clientRef, 'client', 'approval_signed', { type: 'client_approval', id }, { signer_name }, req);
      return res.status(200).json({ ok: true, approval: updated[0] });
    }

    if (action === 'approval_reject') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const { id, note } = req.body || {};
      if (!id) return res.status(400).json({ ok: false, error: 'id is required' });
      const updated = await sb(`client_approvals?id=eq.${id}&client_ref=eq.${encodeURIComponent(clientRef)}&status=eq.pending`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ status: 'rejected', responded_at: new Date().toISOString() }),
      });
      if (!updated.length) return res.status(404).json({ ok: false, error: 'Nothing pending with that id for this account.' });
      await auditLog(clientRef, 'client', 'approval_rejected', { type: 'client_approval', id }, { note: note || null }, req);
      return res.status(200).json({ ok: true, approval: updated[0] });
    }

    if (action === 'invoices') {
      if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET required' });
      const rows = await sb(`invoices?client_id=eq.${encodeURIComponent(clientRef)}&order=due_date.asc&select=*`);
      return res.status(200).json({ ok: true, invoices: rows.map(mapInvoice) });
    }

    if (action === 'payment_request') {
      // Phase 1: a REQUEST record only, no live processor — see file header
      // and sql/013_client_portal.sql. Honest response, not a fake receipt.
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const { invoice_ref, amount, method } = req.body || {};
      if (!amount) return res.status(400).json({ ok: false, error: 'amount is required' });
      const created = await sb('client_payments', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ client_ref: clientRef, invoice_ref: invoice_ref || null, amount: numOrNull(amount), method: method || null, status: 'requested' }),
      });
      await auditLog(clientRef, 'client', 'payment_requested', { type: 'client_payment', id: created[0].id }, { amount: numOrNull(amount), method: method || null }, req);
      return res.status(200).json({
        ok: true,
        payment: created[0],
        note: 'Online payment processing isn’t live yet — this request has been sent to the office, and they’ll follow up to collect payment.',
      });
    }

    if (action === 'messages') {
      if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET required' });
      const rows = await sb(`client_messages?client_ref=eq.${encodeURIComponent(clientRef)}&order=created_at.asc&select=*`);
      return res.status(200).json({ ok: true, messages: rows });
    }

    if (action === 'message_send') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const { body, job_ref } = req.body || {};
      if (!body) return res.status(400).json({ ok: false, error: 'body is required' });
      const created = await sb('client_messages', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ client_ref: clientRef, job_ref: job_ref || null, sender: 'client', body }),
      });
      await auditLog(clientRef, 'client', 'message_sent', { type: 'client_message', id: created[0].id }, null, req);
      return res.status(200).json({ ok: true, message: created[0] });
    }

    return res.status(400).json({ ok: false, error: `Unknown action "${action}"` });
  } catch (e) {
    console.error('clientportal error:', e);
    return res.status(502).json({ ok: false, error: e.message });
  }
}

// balance computed the same way api/invoices.js does it (Law 1: computed, not
// invented) — total minus payments minus deposit minus discount, never below
// zero. Found during the 8/17 Dev To-Do triage: this was total - payments
// only, which overstates what a client sees they still owe on any invoice
// with a deposit applied -- customer-facing, so this one mattered more than
// most. Fixed alongside api/invoices.js's identical gap.
export function mapInvoice(i) {
  const total = Number(i.total) || 0;
  const payments = Number(i.payments) || 0;
  const deposit = Number(i.deposit) || 0;
  const discount = Number(i.discount) || 0;
  const balance = Math.max(0, Math.round((total - payments - deposit - discount) * 100) / 100);
  return {
    id: i.jobber_id, jobNumber: i.invoice_number, status: i.invoice_status, subject: i.subject,
    total, payments, deposit, discount, balance, dueDate: i.due_date, issuedDate: i.issued_date, jobberUrl: i.jobber_web_uri,
  };
}
