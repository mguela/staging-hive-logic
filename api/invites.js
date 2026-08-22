// api/invites.js — Vercel serverless function (Company Setup + Cost Model V1).
//
// Minimum-viable employee invites (Slice 6).
//   POST ?resource=create   — an authenticated office user mints an invite.
//                             Emails the redeem link via the existing Resend
//                             integration (_lib/email.js). Returns NOTHING
//                             sensitive: no raw token, no hash.
//   GET  ?resource=redeem&token=RAW
//                           — validates the token, marks it consumed (one-time),
//                             opens an onboarding_sessions row (actor_type=
//                             'employee'). Token-authenticated, so it needs no
//                             Supabase session.
//
// SECURITY:
//   * Token = 32 random bytes from node:crypto (CSPRNG), base64url. Only its
//     SHA-256 hash is stored (invites.token_hash). The raw token appears ONLY
//     in the emailed link and is NEVER logged or returned (except behind the
//     off-by-default INVITES_RETURN_LINK escape hatch, for Chris to test when
//     email delivery is disabled — see REPORT.md).
//   * 7-day expiry. Single use (consumed_at). Rate-limited per IP + per email.
//   * /api/invites is on the guard's public allowlist; create() self-gates with
//     requireApiAuth, redeem() is authenticated by the token itself — the same
//     pattern api/qbo and api/mail use.

import crypto from 'node:crypto';
import { supabaseRequest } from './_lib/jobber.js';
import { requireApiAuth } from './_lib/guard.js';
import { companyForUser } from './_lib/tenant.js';
import { sendEmail, isEmailConfigured } from './_lib/email.js';
import { twilioRequest, isVoiceConfigured } from './_lib/voice.js';
import { provisionEmployee } from './_lib/gusto-provision.js';

const LICENSE_BUCKET = 'onboarding-licenses';
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const CODE_TTL_MS = 10 * 60 * 1000;

const EXPIRY_DAYS = 7;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Best-effort in-memory IP limiter (per warm instance). The durable limit is
// the per-email DB check below; this just blunts a burst against one instance.
const RATE = new Map(); // ip -> [timestamps]
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 5;

function clientIp(req) {
  const xf = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.headers['x-real-ip'] || 'unknown';
}
function rateLimited(ip) {
  const now = Date.now();
  const hits = (RATE.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  RATE.set(ip, hits);
  return hits.length > RATE_MAX;
}

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

// Company name for user-facing copy (invite email, SMS), by id. Best-effort:
// falls back to a generic label so a missing row never breaks the flow.
async function companyName(companyId) {
  try {
    const r = await supabaseRequest(`companies?id=eq.${encodeURIComponent(companyId)}&select=name&limit=1`);
    if (r.ok) { const row = (await r.json())[0]; if (row && row.name) return row.name; }
  } catch { /* fall through */ }
  return 'your company';
}

function baseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

async function create(req, res) {
  const auth = await requireApiAuth(req);
  if (!auth.ok) return res.status(401).json({ ok: false, error: 'Not signed in.' });

  const ip = clientIp(req);
  if (rateLimited(ip)) return res.status(429).json({ ok: false, error: 'Too many requests. Try again shortly.' });

  const body = req.body || {};
  const email = String(body.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ ok: false, error: 'A valid email is required.' });
  const actor_type = ['employee', 'subcontractor'].includes(body.actor_type) ? body.actor_type : 'employee';

  // The invite belongs to the inviting admin's company (resolved from their
  // membership) — this is what stamps the tenant onto the invite, so the hire
  // who later redeems it lands in the right company.
  const resolved = await companyForUser(auth.user);
  if (!resolved) return res.status(404).json({ ok: false, error: 'No company for this account.' });
  const companyId = resolved.company.id;
  const coName = resolved.company.name || 'your company';

  // Durable rate limit: cap outstanding (unconsumed, unexpired) invites per email.
  const nowIso = new Date().toISOString();
  const outstanding = await supabaseRequest(
    `invites?company_id=eq.${companyId}&email=eq.${encodeURIComponent(email)}&consumed_at=is.null&expires_at=gt.${nowIso}&select=id`,
  );
  if (outstanding.ok) {
    const rows = await outstanding.json();
    if (rows.length >= 3) return res.status(429).json({ ok: false, error: 'This email already has pending invites.' });
  }

  const rawToken = crypto.randomBytes(32).toString('base64url'); // >= 32 bytes CSPRNG
  const token_hash = sha256(rawToken);
  const expires_at = new Date(Date.now() + EXPIRY_DAYS * 86400 * 1000).toISOString();

  const ins = await supabaseRequest('invites', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{
      company_id: companyId, token_hash, actor_type, email,
      phone: body.phone || null, role: body.role || null,
      // Provisioning data the admin sets at invite time (pay type is admin's
      // choice) — carried through to Gusto when onboarding completes.
      payload: {
        ...(body.payload || {}),
        first_name: body.first_name || null, last_name: body.last_name || null,
        pay_type: body.pay_type === 'salary' ? 'salary' : 'hourly',
        rate: body.rate != null ? body.rate : null,
        title: body.title || null,
        is_field: body.is_field !== false,
      },
      expires_at, created_by: auth.user ? auth.user.id : null,
    }]),
  });
  if (!ins.ok) throw new Error('invite insert failed: ' + (await ins.text()));
  const invite = (await ins.json())[0];

  const link = `${baseUrl(req)}/field/onboard.html?token=${encodeURIComponent(rawToken)}`;

  // Email the link (never log it). Delivery is off unless RESEND_API_KEY +
  // MARKETING_EMAIL_SEND_ENABLED are set — sendEmail reports honestly.
  let email_sent = false, email_error = null;
  if (isEmailConfigured()) {
    const sent = await sendEmail({
      to: email,
      subject: `Your ${coName} onboarding link`,
      html: `<p>You've been invited to join ${coName} on HiveLogic.</p>
             <p><a href="${link}">Tap here to get started</a>. This link expires in ${EXPIRY_DAYS} days.</p>`,
      text: `You've been invited to join ${coName} on HiveLogic. Open ${link} — expires in ${EXPIRY_DAYS} days.`,
    });
    email_sent = sent.ok;
    if (!sent.ok) email_error = sent.error;
  } else {
    email_error = 'Email is not configured for this deployment (RESEND_API_KEY unset).';
  }

  const out = { ok: true, invite_id: invite.id, email, expires_at, email_sent };
  if (email_error) out.email_note = email_error;
  // Return the onboarding link to the authenticated admin who created the invite
  // — they need it to hand to the hire (email delivery is optional/off by
  // default). The raw token is never logged; this response is the only place it
  // surfaces, to the authorized creator.
  out.redeem_link = link;
  return res.status(200).json(out);
}

async function redeem(req, res) {
  const raw = (req.query && req.query.token) || (req.body && req.body.token) || '';
  if (!raw) return res.status(400).json({ ok: false, error: 'token is required.' });

  const ip = clientIp(req);
  if (rateLimited(ip)) return res.status(429).json({ ok: false, error: 'Too many requests. Try again shortly.' });

  const token_hash = sha256(String(raw));
  const nowIso = new Date().toISOString();
  const look = await supabaseRequest(
    `invites?token_hash=eq.${token_hash}&limit=1`,
  );
  if (!look.ok) throw new Error('invite lookup failed: ' + (await look.text()));
  const invite = (await look.json())[0];
  // Uniform "invalid" for not-found / expired / already-consumed — don't leak which.
  if (!invite || invite.consumed_at || new Date(invite.expires_at) <= new Date(nowIso)) {
    return res.status(400).json({ ok: false, error: 'This invite link is invalid or has expired.' });
  }

  // One-time: mark consumed (guard against a race by filtering consumed_at is null).
  const consume = await supabaseRequest(
    `invites?id=eq.${invite.id}&consumed_at=is.null`,
    { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ consumed_at: nowIso }) },
  );
  if (!consume.ok) throw new Error('invite consume failed: ' + (await consume.text()));
  const consumed = await consume.json();
  if (!consumed.length) return res.status(400).json({ ok: false, error: 'This invite link is invalid or has expired.' });

  // Open an employee onboarding session.
  const sess = await supabaseRequest('onboarding_sessions', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{
      company_id: invite.company_id, actor_type: invite.actor_type || 'employee',
      current_step: 'welcome', status: 'in_progress', started_at: nowIso, confidence_score: 0,
    }]),
  });
  if (!sess.ok) throw new Error('session create failed: ' + (await sess.text()));
  const session = (await sess.json())[0];

  // Stash the invite's provisioning data on the session so finish() can push
  // the hire to Gusto without re-reading the (now consumed) invite.
  await supabaseRequest('onboarding_steps?on_conflict=session_id,step_key', {
    method: 'POST',
    headers: { Prefer: 'return=minimal,resolution=merge-duplicates' },
    body: JSON.stringify([{
      company_id: invite.company_id, session_id: session.id, step_key: 'invite', status: 'complete',
      payload: { email: invite.email, role: invite.role || null, ...(invite.payload || {}) },
    }]),
  }).catch(() => {});

  return res.status(200).json({
    ok: true, redeemed: true, session_id: session.id,
    email: invite.email, role: invite.role || null, actor_type: invite.actor_type || 'employee',
  });
}

// --- Field-onboarding helpers (token-independent; scoped to a live session) --
// A new hire has already consumed their one-time token during redeem(); from
// then on they carry only session_id. These verify the session is real and
// still in progress before doing anything. MVP tradeoff (see REPORT.md): this
// is session-id-scoped, not fully authenticated.
async function requireLiveSession(sessionId) {
  if (!sessionId) return null;
  const r = await supabaseRequest(`onboarding_sessions?id=eq.${sessionId}&status=eq.in_progress&limit=1`);
  if (!r.ok) return null;
  return (await r.json())[0] || null;
}

async function upsertStep(session, step_key, payload, status = 'pending') {
  const row = { company_id: session.company_id, session_id: session.id, step_key, status, payload };
  const up = await supabaseRequest('onboarding_steps?on_conflict=session_id,step_key', {
    method: 'POST',
    headers: { Prefer: 'return=representation,resolution=merge-duplicates' },
    body: JSON.stringify([row]),
  });
  if (!up.ok) throw new Error('step upsert failed: ' + (await up.text()));
  return (await up.json())[0];
}
async function readStep(sessionId, step_key) {
  const r = await supabaseRequest(`onboarding_steps?session_id=eq.${sessionId}&step_key=eq.${step_key}&limit=1`);
  return r.ok ? (await r.json())[0] || null : null;
}

async function sendCode(req, res) {
  const ip = clientIp(req);
  if (rateLimited(ip)) return res.status(429).json({ ok: false, error: 'Too many requests.' });
  const body = req.body || {};
  const session = await requireLiveSession(body.session_id);
  if (!session) return res.status(404).json({ ok: false, error: 'Onboarding session not found.' });
  const phone = String(body.phone || '').trim();
  if (!/^\+?[0-9][0-9\-\s().]{6,}$/.test(phone)) return res.status(400).json({ ok: false, error: 'A valid phone number is required.' });

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await upsertStep(session, 'phone', { phone, code_hash: sha256(code), expires: Date.now() + CODE_TTL_MS, verified: false }, 'pending');

  let sent = false, note = null;
  if (isVoiceConfigured()) {
    try {
      const numRes = await supabaseRequest('voice_numbers?role=eq.main&active=eq.true&select=e164&limit=1');
      const main = numRes.ok ? (await numRes.json())[0] : null;
      if (main) {
        const coName = await companyName(session.company_id);
        await twilioRequest('Messages.json', { method: 'POST', body: new URLSearchParams({ From: main.e164, To: phone, Body: `Your ${coName} verification code is ${code}` }) });
        sent = true;
      } else note = 'No active main phone number configured.';
    } catch (e) { note = 'SMS send failed: ' + (e.message || 'unknown'); }
  } else {
    note = 'Twilio is not configured for this deployment.';
  }
  return res.status(200).json({ ok: true, sent, note }); // never returns the code
}

async function verifyCode(req, res) {
  const body = req.body || {};
  const session = await requireLiveSession(body.session_id);
  if (!session) return res.status(404).json({ ok: false, error: 'Onboarding session not found.' });
  const step = await readStep(session.id, 'phone');
  const p = step && step.payload;
  if (!p || !p.code_hash) return res.status(400).json({ ok: false, error: 'Request a code first.' });
  if (Date.now() > Number(p.expires || 0)) return res.status(400).json({ ok: false, error: 'Code expired. Request a new one.' });
  if (sha256(String(body.code || '')) !== p.code_hash) return res.status(400).json({ ok: false, error: 'Incorrect code.' });
  await upsertStep(session, 'phone', { ...p, verified: true }, 'complete');
  return res.status(200).json({ ok: true, verified: true });
}

async function uploadLicense(req, res) {
  const body = req.body || {};
  const session = await requireLiveSession(body.session_id);
  if (!session) return res.status(404).json({ ok: false, error: 'Onboarding session not found.' });
  const dataB64 = String(body.dataBase64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!dataB64) return res.status(400).json({ ok: false, error: 'A license photo is required.' });
  const buf = Buffer.from(dataB64, 'base64');
  if (buf.length === 0 || buf.length > MAX_UPLOAD_BYTES) return res.status(400).json({ ok: false, error: 'Photo must be 1 byte–5 MB.' });
  const contentType = /^image\/(png|jpe?g|webp|heic)$/i.test(body.contentType || '') ? body.contentType : 'image/jpeg';
  const safeName = String(body.filename || 'license.jpg').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  const objectPath = `${session.id}/${Date.now()}_${safeName}`;

  // Upload to a PRIVATE Supabase Storage bucket via the storage REST API with
  // the service-role key. V1: NO OCR — the photo is stored and the step is
  // flagged for office review; the office types the fields for now.
  let stored = false, note = null;
  try {
    const up = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/${LICENSE_BUCKET}/${objectPath}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        apikey: process.env.SUPABASE_SERVICE_KEY,
        'Content-Type': contentType,
        'x-upsert': 'true',
      },
      body: buf,
    });
    if (up.ok) stored = true;
    else note = `Storage upload failed (${up.status}). The private bucket "${LICENSE_BUCKET}" may need to be created.`;
  } catch (e) { note = 'Storage upload error: ' + (e.message || 'unknown'); }

  await upsertStep(session, 'license', { stored, path: stored ? objectPath : null, flagged_for_review: true, note }, stored ? 'complete' : 'pending');
  return res.status(stored ? 200 : 502).json({ ok: stored, stored, flagged_for_review: true, note });
}

// Onboarding complete -> auto-provision the hire into Gusto (once), using the
// invite's provisioning data. Session-gated (the hire has no admin session).
// Idempotent: won't re-create if already provisioned.
async function finish(req, res) {
  const body = req.body || {};
  const session = await requireLiveSession(body.session_id);
  if (!session) return res.status(404).json({ ok: false, error: 'Onboarding session not found.' });

  const inviteStep = await readStep(session.id, 'invite');
  const p = (inviteStep && inviteStep.payload) || {};

  const existing = await readStep(session.id, 'gusto');
  let provision = existing && existing.payload;
  if (!provision || !provision.gusto_employee_uuid) {
    provision = await provisionEmployee({
      display_name: [p.first_name, p.last_name].filter(Boolean).join(' ') || null,
      first_name: p.first_name, last_name: p.last_name, email: p.email,
      pay_type: p.pay_type, rate: p.rate, title: p.title, is_field: p.is_field,
    });
    await upsertStep(session, 'gusto', provision, provision.ok ? 'complete' : 'pending');

    // Record the hire in employee_pay with the durable Gusto link (once), so
    // future timesheet pushes + payroll sync map to the right person.
    if (provision.ok && provision.gusto_employee_uuid) {
      try {
        const chk = await supabaseRequest(`employee_pay?gusto_employee_uuid=eq.${provision.gusto_employee_uuid}&select=id&limit=1`);
        const exists = chk.ok ? (await chk.json()).length > 0 : false;
        if (!exists) {
          await supabaseRequest('employee_pay', {
            method: 'POST', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify([{
              company_id: session.company_id,
              display_name: [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email || 'New hire',
              pay_type: p.pay_type === 'salary' ? 'salary' : 'hourly',
              base_rate: Number(p.rate) || 0,
              is_field: p.is_field !== false,
              source: 'imported',
              gusto_employee_uuid: provision.gusto_employee_uuid,
              gusto_job_uuid: provision.gusto_job_uuid || null,
            }]),
          });
        }
      } catch { /* best effort — provisioning already succeeded */ }
    }
  }

  await supabaseRequest(`onboarding_sessions?id=eq.${session.id}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'complete', current_step: 'live', completed_at: new Date().toISOString() }),
  }).catch(() => {});

  return res.status(200).json({
    ok: true, finished: true,
    provisioned: {
      ok: Boolean(provision && provision.ok),
      gusto_employee_uuid: provision && provision.gusto_employee_uuid,
      pay_type: provision && provision.pay_type,
      error: provision && provision.error, step: provision && provision.step,
    },
  });
}

// Admin verify button: provision a test hire into Gusto directly. Auth-gated.
async function provisionTest(req, res) {
  const auth = await requireApiAuth(req);
  if (!auth.ok) return res.status(401).json({ ok: false, error: 'Not signed in.' });
  const b = req.body || {};
  const result = await provisionEmployee({
    first_name: b.first_name || 'Test', last_name: b.last_name || `Hire${String(Date.now()).slice(-5)}`,
    email: b.email || `test.hire.${Date.now()}@example.com`,
    pay_type: b.pay_type || 'hourly', rate: b.rate || '30.00', title: b.title || 'Field Technician',
  });
  return res.status(result.ok ? 200 : 502).json(result);
}

export default async function handler(req, res) {
  const resource = (req.query && req.query.resource) || '';
  const method = (req.method || 'GET').toUpperCase();
  try {
    if (resource === 'finish' && method === 'POST') return await finish(req, res);
    if (resource === 'provision_test' && method === 'POST') return await provisionTest(req, res);
    if (resource === 'create' && method === 'POST') return await create(req, res);
    if (resource === 'redeem' && (method === 'GET' || method === 'POST')) return await redeem(req, res);
    if (resource === 'send_code' && method === 'POST') return await sendCode(req, res);
    if (resource === 'verify_code' && method === 'POST') return await verifyCode(req, res);
    if (resource === 'upload_license' && method === 'POST') return await uploadLicense(req, res);
    return res.status(404).json({ ok: false, error: `Unknown resource/method: ${resource} ${method}` });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
