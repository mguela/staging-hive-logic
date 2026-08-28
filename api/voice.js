// api/voice.js - Vercel serverless function
// HiveLogic Phone -- the authenticated, member-facing API. Everything
// Twilio calls directly lives in api/voice-webhook.js instead; this file
// is only ever called by public/app-phone.js from inside a logged-in
// HiveLogic session.
//
// Auth: every request must carry `Authorization: Bearer <supabase access
// token>`, verified here against Supabase's own /auth/v1/user endpoint --
// a real check, not just "the app shell required login" (see the known,
// documented gap on api/marketing.js's review_requests endpoint; voice
// call control is more sensitive -- it can place calls and mint identity
// tokens -- so it gets the stronger check).
//
// GET  /api/voice?resource=status                 -> { configured, mainNumber, extensionCount }
// GET  /api/voice?resource=extensions              -> list
// POST /api/voice?resource=extensions              -> upsert (admin)
// GET  /api/voice?resource=numbers                 -> list
// POST /api/voice?resource=numbers                 -> register a number bought/ported in the Twilio console (admin)
// GET  /api/voice?resource=schedules | greetings | blocklist  -> list
// POST /api/voice?resource=schedules | greetings | blocklist  -> upsert/add (admin)
// POST /api/voice?resource=blocklist_remove        -> { id }
// POST /api/voice?resource=contact_create          -> { e164, name } (label an unknown number)
// POST /api/voice?resource=contact_link            -> { e164, jobberClientId } (link a number to an existing Jobber client)
// POST /api/voice?resource=sms                     -> { to, body } (send a one-off SMS via Twilio)
// GET  /api/voice?resource=sms_threads              -> one row per real conversation, newest first
// GET  /api/voice?resource=sms_thread&number=...    -> the full message history with one number
// GET  /api/voice?resource=caller&e164=...        -> { matches[], knownName } (who is calling)
// GET  /api/voice?resource=calls                   -> call log, paginated
// GET  /api/voice?resource=voicemails               -> voicemail list (own extension by default)
// POST /api/voice?resource=voicemail_read           -> { id, read }
// POST /api/voice?resource=token                    -> { identity } -> { token }  (Twilio Voice SDK access token)
// POST /api/voice?resource=hold                      -> { callId, hold: true|false }
// POST /api/voice?resource=transfer                   -> { callId, toExtensionNumber? , toNumber? }
// --- Phase 1: Call Queues ---
// GET   /api/voice?resource=queues                    -> list queues + members
// POST  /api/voice?resource=queues                    -> create/update a queue (+ members[]) (admin)
// PATCH /api/voice?resource=queues                     -> partial update, e.g. active toggle (admin)
// GET   /api/voice?resource=queue_status               -> live { waiting, longestWaitSeconds, agentsAvailable } per queue
// GET   /api/voice?resource=agent_status               -> every extension's presence
// POST  /api/voice?resource=agent_status               -> { status, statusNote? } set own (admin may set others via extensionId)
// POST  /api/voice?resource=queue_answer               -> { queueId? } ring me + bridge to the next waiting caller
// GET   /api/voice?resource=callbacks                  -> overflow callback requests (optional ?status=)
// POST  /api/voice?resource=callback_update            -> { id, status?|claim? } claim/complete/dismiss

import { supabaseRequest } from './_lib/jobber.js';
import { isVoiceConfigured, mintVoiceAccessToken, twilioRequest, normalizeToE164, updateLiveCall, findActiveChildCallSid, queueFriendlyName, twilioQueueStatus, createCall } from './_lib/voice.js';
import { getVoiceSettings, runCallIntelligence } from './_lib/call-intelligence.js';

async function requireUser(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  try {
    const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) return null;
    return res.json(); // { id, email, ... }
  } catch {
    return null;
  }
}

async function myExtension(userId) {
  if (!userId) return null;
  const res = await supabaseRequest(`voice_extensions?user_id=eq.${encodeURIComponent(userId)}&select=*&limit=1`);
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

// ---------------------------------------------------------------------
// Role gate for voice-system administration: extensions, numbers,
// greetings, blocklist and schedules config changes, plus viewing
// voicemail that belongs to a different extension. Reuses the same
// employee_roles.permission_roles infrastructure as
// api/schedule/move-visit.js and api/track1.js instead of a separate
// voice-only role column, so it stays in sync with the Crew Roster
// roles already managed elsewhere. Closes the clearest, highest-risk
// half of the flagged no-RBAC gap: any logged-in staff could
// previously rewrite phone system config or listen to voicemail for
// any extension. Leaves call-log and blocklist viewing open for now --
// Dispatch Center non-admins rely on the shared call log day to day,
// and drawing that line is a policy decision, not a bug fix.
const VOICE_ADMIN_ROLES = ["owner", "partner", "office_manager", "systems_pm"];

async function isVoiceAdmin(user) {
  if (!user || !user.id) return false;
  const profRes = await supabaseRequest(`profiles?id=eq.${user.id}&select=role`);
  const profRows = profRes.ok ? await profRes.json() : [];
  if (profRows[0] && (profRows[0].role === "admin" || profRows[0].role === "superadmin")) return true;
  if (!user.email) return false;
  const userRow = await supabaseRequest(`users?email=eq.${encodeURIComponent(user.email)}&select=jobber_id&limit=1`);
  const userRows = userRow.ok ? await userRow.json() : [];
  const jobberId = userRows[0] && userRows[0].jobber_id;
  if (!jobberId) return false;
  const roleRes = await supabaseRequest(`employee_roles?jobber_id=eq.${encodeURIComponent(jobberId)}&select=permission_roles,permission_role`);
  const roleRows = roleRes.ok ? await roleRes.json() : [];
  const roleRow = roleRows[0];
  const roles = (roleRow && roleRow.permission_roles) || (roleRow && roleRow.permission_role ? [roleRow.permission_role] : []);
  return roles.some(r => VOICE_ADMIN_ROLES.includes(r));
}

function requireVoiceAdmin(fn) {
  return async (req, res, user) => {
    if (!(await isVoiceAdmin(user))) {
      return res.status(403).json({ ok: false, error: "Only a phone-system administrator can do that." });
    }
    return fn(req, res, user);
  };
}

// ---------------------------------------------------------------------
async function handleStatus(req, res) {
  const configured = isVoiceConfigured();
  const numRes = await supabaseRequest("voice_numbers?role=eq.main&active=eq.true&select=e164,friendly_name&limit=1");
  const mainNumber = numRes.ok ? (await numRes.json())[0] || null : null;
  const extRes = await supabaseRequest('voice_extensions?select=id&active=eq.true');
  const extensionCount = extRes.ok ? (await extRes.json()).length : 0;
  res.status(200).json({
    ok: true,
    configured,
    missingEnv: configured ? [] : ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_API_KEY_SID', 'TWILIO_API_KEY_SECRET', 'TWILIO_TWIML_APP_SID'].filter(k => !process.env[k]),
    mainNumber,
    extensionCount,
    // Lets Settings > Greetings honestly disclose whether phone-based
    // greeting recording (dial 00) is set up yet -- see handleGreetingPinPrompt
    // in api/voice-webhook.js.
    greetingPinConfigured: Boolean(process.env.VOICE_GREETING_PIN),
  });
}

async function handleExtensionsGet(req, res) {
  const r = await supabaseRequest('voice_extensions?select=*&order=extension_number.asc');
  res.status(200).json({ ok: true, extensions: r.ok ? await r.json() : [] });
}

async function handleExtensionsPost(req, res, user) {
  const b = req.body || {};
  if (!b.extension_number || !b.display_name) return res.status(400).json({ ok: false, error: 'extension_number and display_name are required' });
  const row = {
    extension_number: String(b.extension_number),
    display_name: b.display_name,
    user_id: b.user_id || null,
    forwarding_number: b.forwarding_number ? normalizeToE164(b.forwarding_number) : null,
    call_waiting_enabled: b.call_waiting_enabled !== false,
    voicemail_pin: b.voicemail_pin ? String(b.voicemail_pin).replace(/[^0-9]/g, '') || null : null,
    is_operator: Boolean(b.is_operator),
    voicemail_greeting_text: b.voicemail_greeting_text || null,
    active: b.active !== false,
    updated_at: new Date().toISOString(),
  };
  if (b.id) {
    await supabaseRequest(`voice_extensions?id=eq.${b.id}`, { method: 'PATCH', body: JSON.stringify(row) });
    return res.status(200).json({ ok: true, id: b.id });
  }
  const ins = await supabaseRequest('voice_extensions', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
  if (!ins.ok) return res.status(400).json({ ok: false, error: await ins.text() });
  const created = (await ins.json())[0];
  res.status(200).json({ ok: true, id: created.id });
}

async function handleNumbersGet(req, res) {
  const r = await supabaseRequest('voice_numbers?select=*&order=role.asc');
  res.status(200).json({ ok: true, numbers: r.ok ? await r.json() : [] });
}

async function handleNumbersPost(req, res) {
  const b = req.body || {};
  const e164 = normalizeToE164(b.e164);
  if (!e164) return res.status(400).json({ ok: false, error: 'A valid phone number is required' });
  const row = {
    e164,
    friendly_name: b.friendly_name || null,
    provider_sid: b.provider_sid || null,
    role: b.role || 'main',
    assigned_extension_id: b.assigned_extension_id || null,
  };
  const ins = await supabaseRequest('voice_numbers?on_conflict=e164', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(row) });
  if (!ins.ok) return res.status(400).json({ ok: false, error: await ins.text() });
  res.status(200).json({ ok: true });
}

function crudFactory(table, requiredFields) {
  return {
    async get(req, res) {
      const r = await supabaseRequest(`${table}?select=*&order=created_at.desc`);
      res.status(200).json({ ok: true, items: r.ok ? await r.json() : [] });
    },
    async post(req, res) {
      const b = req.body || {};
      for (const f of requiredFields) if (!b[f]) return res.status(400).json({ ok: false, error: `${f} is required` });
      const { id, ...rest } = b;
      if (id) {
        await supabaseRequest(`${table}?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(rest) });
        return res.status(200).json({ ok: true, id });
      }
      const ins = await supabaseRequest(table, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(rest) });
      if (!ins.ok) return res.status(400).json({ ok: false, error: await ins.text() });
      res.status(200).json({ ok: true, id: (await ins.json())[0].id });
    },
  };
}

const schedulesCrud = crudFactory('voice_schedules', ['name']);
const greetingsCrud = crudFactory('voice_greetings', ['name', 'kind']);

const GREETING_KINDS = ['main_open', 'main_closed', 'voicemail', 'hold'];

// Dedicated upsert-by-kind, replacing the generic crudFactory POST for
// greetings -- the generic one does a blind INSERT whenever the client
// omits an id (which the Settings form always does), so repeated saves
// for the same kind used to silently accumulate duplicate rows (the
// table's greetingFor() lookup only ever reads one, so which row 'won'
// was undefined). on_conflict=kind + merge-duplicates + the
// voice_greetings_kind_key unique constraint fix that. merge-duplicates
// only touches columns present in the body, so saving tts_text does not
// clobber a previously-saved audio_url and vice versa -- see
// handleGreetingUpload below for the other side of that.
async function handleGreetingsPost(req, res) {
  const b = req.body || {};
  const kind = b.kind;
  if (!GREETING_KINDS.includes(kind)) return res.status(400).json({ ok: false, error: 'A valid kind is required' });
  const row = { kind, name: b.name || `custom-${kind}` };
  if (b.tts_text !== undefined) row.tts_text = b.tts_text || null;
  if (b.audio_url !== undefined) row.audio_url = b.audio_url || null;
  // 'Clear recording' in the Settings UI reverts to text without having
  // to resend tts_text.
  if (b.clear_audio) row.audio_url = null;
  const ins = await supabaseRequest('voice_greetings?on_conflict=kind', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(row) });
  if (!ins.ok) return res.status(400).json({ ok: false, error: await ins.text() });
  res.status(200).json({ ok: true });
}

// Browser upload/mic-recording path for greeting audio -- base64-decodes
// the clip, uploads it to the public voice-greetings Supabase Storage
// bucket (same direct-upload pattern as api/fieldops.js), then upserts
// the resulting public URL onto the greeting row by kind.
async function handleGreetingUpload(req, res) {
  const b = req.body || {};
  const kind = b.kind;
  if (!GREETING_KINDS.includes(kind)) return res.status(400).json({ ok: false, error: 'A valid kind is required' });
  if (!b.audioBase64) return res.status(400).json({ ok: false, error: 'audioBase64 is required' });
  const contentType = b.contentType || 'audio/webm';
  const ext = contentType.includes('mpeg') || contentType.includes('mp3') ? 'mp3' : contentType.includes('wav') ? 'wav' : 'webm';
  const objectPath = `${kind}-${Date.now()}.${ext}`;
  const upload = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/voice-greetings/${objectPath}`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': contentType,
      'x-upsert': 'true',
    },
    body: Buffer.from(b.audioBase64, 'base64'),
  });
  if (!upload.ok) return res.status(400).json({ ok: false, error: await upload.text() });
  const audioUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/voice-greetings/${objectPath}`;
  const ins = await supabaseRequest('voice_greetings?on_conflict=kind', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ kind, name: `uploaded-${kind}`, audio_url: audioUrl }),
  });
  if (!ins.ok) return res.status(400).json({ ok: false, error: await ins.text() });
  res.status(200).json({ ok: true, audioUrl });
}

async function handleBlocklistGet(req, res) {
  const r = await supabaseRequest('voice_blocked_numbers?select=*&order=created_at.desc');
  res.status(200).json({ ok: true, items: r.ok ? await r.json() : [] });
}
async function handleBlocklistPost(req, res) {
  const b = req.body || {};
  const e164 = normalizeToE164(b.e164);
  if (!e164) return res.status(400).json({ ok: false, error: 'A valid phone number is required' });
  const ins = await supabaseRequest('voice_blocked_numbers?on_conflict=e164', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ e164, reason: b.reason || null }) });
  if (!ins.ok) return res.status(400).json({ ok: false, error: await ins.text() });
  res.status(200).json({ ok: true });
}
async function handleBlocklistRemove(req, res) {
  const b = req.body || {};
  if (!b.id) return res.status(400).json({ ok: false, error: 'id is required' });
  await supabaseRequest(`voice_blocked_numbers?id=eq.${b.id}`, { method: 'DELETE' });
  res.status(200).json({ ok: true });
}

function clientDisplayName(c) {
  return c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company_name || null;
}

// voice_known_numbers lets the phone popup label a number that has no
// matching clients.phone_e164 -- either with a plain name (Create Contact)
// or by linking it to an existing Jobber client (Add to Existing Contact),
// e.g. a customer calling from a personal cell that is not the number on
// file. handleCallsGet resolves against this table live; nothing gets
// backfilled onto voice_calls rows.
async function handleContactCreate(req, res) {
  const b = req.body || {};
  const e164 = normalizeToE164(b.e164);
  const name = (b.name || '').trim();
  if (!e164) return res.status(400).json({ ok: false, error: 'A valid phone number is required' });
  if (!name) return res.status(400).json({ ok: false, error: 'A contact name is required' });
  const ins = await supabaseRequest('voice_known_numbers?on_conflict=e164', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ e164, display_name: name, jobber_client_id: null }) });
  if (!ins.ok) return res.status(400).json({ ok: false, error: await ins.text() });
  res.status(200).json({ ok: true });
}

async function handleContactLink(req, res) {
  const b = req.body || {};
  const e164 = normalizeToE164(b.e164);
  const jobberClientId = b.jobberClientId ? String(b.jobberClientId) : null;
  if (!e164) return res.status(400).json({ ok: false, error: 'A valid phone number is required' });
  if (!jobberClientId) return res.status(400).json({ ok: false, error: 'jobberClientId is required' });
  const ins = await supabaseRequest('voice_known_numbers?on_conflict=e164', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ e164, display_name: null, jobber_client_id: jobberClientId }) });
  if (!ins.ok) return res.status(400).json({ ok: false, error: await ins.text() });
  res.status(200).json({ ok: true });
}

// Outbound-only quick-send from the call log's "Msg" button. No inbound
// SMS handling yet -- that needs its own Twilio webhook resource and is a
// separate piece of work; this just gets a message out via Twilio's REST
// API and logs it to voice_messages.
async function handleSms(req, res) {
  const b = req.body || {};
  const to = normalizeToE164(b.to);
  const text = (b.body || '').trim();
  if (!to) return res.status(400).json({ ok: false, error: 'A valid phone number is required' });
  if (!text) return res.status(400).json({ ok: false, error: 'Message text is required' });
  const numRes = await supabaseRequest('voice_numbers?role=eq.main&active=eq.true&select=e164&limit=1');
  const mainNumber = numRes.ok ? (await numRes.json())[0] : null;
  if (!mainNumber) return res.status(409).json({ ok: false, error: 'No active HiveLogic Phone number is configured yet.' });
  const send = await twilioRequest('Messages.json', { method: 'POST', body: new URLSearchParams({ From: mainNumber.e164, To: to, Body: text }) });
  const payload = await send.json().catch(() => ({}));
  if (!send.ok) return res.status(400).json({ ok: false, error: payload.message || 'Twilio could not send the message.' });
  await supabaseRequest('voice_messages', { method: 'POST', body: JSON.stringify({ direction: 'outbound', from_number: mainNumber.e164, to_number: to, body: text, provider_sid: payload.sid || null, status: payload.status || 'queued' }) }).catch(() => {});
  res.status(200).json({ ok: true, sid: payload.sid || null });
}

// Same two-step resolution handleCallsGet uses for a call's number, applied
// to a set of SMS counterpart numbers at once: clients.phone_e164 first,
// then voice_known_numbers (what "Create Contact" / "Add to Existing
// Contact" write) for whatever is left. Kept a duplicate of that logic
// rather than sharing it -- handleCallsGet's version is folded into a
// single already-fetched call list and reworking it into something both
// call sites can share is more churn than the two ever agreeing to change.
async function resolveNamesForNumbers(numbers) {
  const map = new Map();
  if (!numbers.length) return map;
  const inList = numbers.map(n => encodeURIComponent(`"${n}"`)).join(',');
  const [byPhone, byKnown] = await Promise.all([
    supabaseRequest(`clients?phone_e164=in.(${inList})&select=jobber_id,name,first_name,last_name,company_name,phone_e164`).then(x => x.ok ? x.json() : []),
    supabaseRequest(`voice_known_numbers?e164=in.(${inList})&select=e164,display_name,jobber_client_id`).then(x => x.ok ? x.json() : []),
  ]);
  for (const c of byPhone) map.set(c.phone_e164, { clientId: c.jobber_id, name: clientDisplayName(c) });
  const linkedIds = [...new Set(byKnown.map(k => k.jobber_client_id).filter(Boolean))];
  const linkedClients = linkedIds.length
    ? await supabaseRequest(`clients?jobber_id=in.(${linkedIds.join(',')})&select=jobber_id,name,first_name,last_name,company_name`).then(x => x.ok ? x.json() : [])
    : [];
  const linkedById = new Map(linkedClients.map(c => [c.jobber_id, c]));
  for (const k of byKnown) {
    if (map.has(k.e164)) continue;
    const linked = k.jobber_client_id && linkedById.has(k.jobber_client_id) ? linkedById.get(k.jobber_client_id) : null;
    map.set(k.e164, { clientId: k.jobber_client_id || null, name: linked ? clientDisplayName(linked) : k.display_name });
  }
  return map;
}

// One row per real conversation -- every voice_messages row grouped by the
// human on the other end (from_number on an inbound row, to_number on an
// outbound one), newest activity first. `needsReply` is computed, not
// stored: it is simply "the most recent message in this thread came from
// the client", which is the honest definition and never goes stale the way
// a separate flag would if a reply were ever sent through another path.
async function handleSmsThreadsGet(req, res) {
  const limit = Math.min(Number(req.query.limit) || 500, 1000);
  const r = await supabaseRequest(`voice_messages?select=direction,from_number,to_number,body,status,created_at&order=created_at.desc&limit=${limit}`);
  const rows = r.ok ? await r.json() : [];

  const byNumber = new Map();
  for (const m of rows) {
    const number = m.direction === 'inbound' ? m.from_number : m.to_number;
    if (!number) continue;
    if (!byNumber.has(number)) byNumber.set(number, []);
    byNumber.get(number).push(m);
  }

  const numbers = [...byNumber.keys()];
  const names = await resolveNamesForNumbers(numbers);

  const threads = numbers.map((number) => {
    const messages = byNumber.get(number); // already newest-first
    const last = messages[0];
    const identity = names.get(number) || null;
    return {
      number,
      clientId: identity ? identity.clientId : null,
      clientName: identity ? identity.name : null,
      lastMessage: { body: last.body, direction: last.direction, createdAt: last.created_at, status: last.status },
      messageCount: messages.length,
      needsReply: last.direction === 'inbound',
    };
  });

  threads.sort((a, b) => new Date(b.lastMessage.createdAt).getTime() - new Date(a.lastMessage.createdAt).getTime());
  res.status(200).json({ ok: true, threads });
}

// The full history with one number, oldest first (a thread reads top to
// bottom like a conversation). `origin: 'reina_approved'` on a row means it
// went out through the Reina draft-then-approve flow (api/reina-action.js);
// null means an ordinary send.
async function handleSmsThreadGet(req, res) {
  const number = normalizeToE164(req.query.number || '');
  if (!number) return res.status(400).json({ ok: false, error: 'A phone number is required.' });
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  const r = await supabaseRequest(
    `voice_messages?or=(from_number.eq.${encodeURIComponent(number)},to_number.eq.${encodeURIComponent(number)})` +
    `&select=id,direction,from_number,to_number,body,status,origin,created_at&order=created_at.asc&limit=${limit}`
  );
  const messages = r.ok ? await r.json() : [];
  const names = await resolveNamesForNumbers([number]);
  const identity = names.get(number) || null;
  res.status(200).json({
    ok: true,
    number,
    clientId: identity ? identity.clientId : null,
    clientName: identity ? identity.name : null,
    messages,
  });
}

// ---- who is calling -------------------------------------------------------
//
// Chris, 2026-08-23: "Call > existing client phone # > question should be at
// the inception of the call > 'New Lead?' > clicking yes should open a
// prefilled New Lead Form by the recognized phone number and pulled existing
// client's info."
//
// The phone popup asks this the moment a call starts RINGING, so the caller's
// name is on screen while it rings rather than after somebody types it in --
// and so "New lead?" can open the form already filled from the client's own
// record.
//
// Resolution order is the same one handleCallsGet uses, deliberately: the
// label on the ringing card and the label in the call log must never
// disagree about who a number belongs to.
//   1. clients.phone_e164   -- 7,434 of 8,690 clients have one
//   2. voice_known_numbers  -- what Create Contact / Add to Existing Contact write
//
// It returns EVERY match, not the first. 171 numbers in production belong to
// more than one client (up to four) -- a shared house line, a landlord, a
// property manager who books for several addresses. Silently picking one
// attaches the lead to the wrong person, and nothing downstream would ever
// reveal that a choice had been made.
async function handleCallerGet(req, res) {
  const e164 = normalizeToE164(req.query.e164 || '');
  if (!e164) return res.status(400).json({ ok: false, error: 'A phone number is required.' });

  const enc = encodeURIComponent(e164);
  const SELECT = 'jobber_id,name,first_name,last_name,company_name,email,phone,phone_e164,balance,is_lead,is_archived';

  // Archived clients are included on purpose. Someone calling back years later
  // is still the same person, and hiding the match would send the office off
  // to create a duplicate.
  const [byPhoneRes, knownRes] = await Promise.all([
    supabaseRequest(`clients?phone_e164=eq.${enc}&select=${SELECT}&limit=25`).then(r => r.ok ? r.json() : []).catch(() => []),
    supabaseRequest(`voice_known_numbers?e164=eq.${enc}&select=e164,display_name,jobber_client_id&limit=5`).then(r => r.ok ? r.json() : []).catch(() => []),
  ]);

  let rows = byPhoneRes;
  const known = knownRes[0] || null;

  // A number linked by hand ("Add to Existing Contact") counts as a match even
  // when it is not the number on the client's record -- that is the entire
  // reason someone linked it. A customer ringing from a personal cell is the
  // case this exists for.
  const knownClientId = known && known.jobber_client_id ? String(known.jobber_client_id) : null;
  if (knownClientId && !rows.some(c => String(c.jobber_id) === knownClientId)) {
    const extra = await supabaseRequest(
      `clients?jobber_id=eq.${encodeURIComponent(knownClientId)}&select=${SELECT}&limit=1`
    ).then(r => r.ok ? r.json() : []).catch(() => []);
    rows = rows.concat(extra);
  }

  // The service address, so the form does not ask for something HiveLogic
  // already knows. Non-fatal: a match with no address still beats no match.
  const addressById = new Map();
  if (rows.length) {
    try {
      const ids = rows.map(c => encodeURIComponent(`"${c.jobber_id}"`)).join(',');
      const lr = await supabaseRequest(`client_locations?jobber_id=in.(${ids})&select=jobber_id,street,city,province`);
      if (lr.ok) {
        for (const l of await lr.json()) {
          const line = [l.street, l.city, l.province].filter(Boolean).join(', ');
          if (l.jobber_id && line && !addressById.has(l.jobber_id)) addressById.set(l.jobber_id, line);
        }
      }
    } catch { /* an address is a convenience here, never the answer */ }
  }

  const matches = rows.map(c => ({
    clientId: c.jobber_id,
    name: c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company_name || 'Unnamed client',
    firstName: c.first_name || null,
    lastName: c.last_name || null,
    companyName: c.company_name || null,
    email: c.email || null,
    phone: c.phone_e164 || c.phone || null,
    address: addressById.get(c.jobber_id) || null,
    balance: c.balance != null ? Number(c.balance) : null,
    isLead: !!c.is_lead,
    isArchived: !!c.is_archived,
  }));

  res.status(200).json({
    ok: true,
    e164,
    matches,
    // A hand-typed label for a number nobody has linked to a client. Worth
    // showing on the ringing card even though it cannot prefill a client.
    knownName: known && !knownClientId ? (known.display_name || null) : null,
  });
}

async function handleDirectoryGet(req, res) {
  const q = (req.query.q || '').trim();
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const PAGE_SIZE = 250;
  const extRes = await supabaseRequest('voice_extensions?active=eq.true&select=id,extension_number,display_name&order=extension_number.asc');
  const extensions = extRes.ok ? await extRes.json() : [];
  let clients = [];
  let clientsHasMore = false;
  let clientsTotal = null;
  if (q.length >= 2) {
    const like = encodeURIComponent(`*${q}*`);
    const cRes = await supabaseRequest(`clients?phone_e164=not.is.null&or=(name.ilike.${like},company_name.ilike.${like},first_name.ilike.${like},last_name.ilike.${like})&select=jobber_id,name,first_name,last_name,company_name,phone_e164&limit=50`);
    clients = cRes.ok ? await cRes.json() : [];
  } else {
    // No search typed yet -- show a browsable, paginated default list
    // (most recently active clients first). Fixed-size pages (+ Load
    // More on the client) keep each request small so the directory
    // stays fast as the client roster grows -- see
    // reina/voip-sidebar-collapse-and-directory-fix-2026-07-25.md.
    const cRes = await supabaseRequest(`clients?phone_e164=not.is.null&is_archived=eq.false&select=jobber_id,name,first_name,last_name,company_name,phone_e164&order=jobber_updated_at.desc&limit=${PAGE_SIZE}&offset=${offset}`, { headers: { Prefer: 'count=exact' } });
    clients = cRes.ok ? await cRes.json() : [];
    clientsHasMore = clients.length === PAGE_SIZE;
    const range = cRes.headers.get('content-range');
    if (range && range.includes('/')) {
      const totalStr = range.split('/')[1];
      clientsTotal = totalStr === '*' ? null : Number(totalStr);
    }
  }
  res.status(200).json({
    ok: true,
    extensions: extensions.map(e => ({ id: e.id, extensionNumber: e.extension_number, name: e.display_name })),
    clients: clients.map(c => ({ id: c.jobber_id, name: c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company_name, phone: c.phone_e164 })),
    clientsHasMore,
    clientsTotal,
    clientsNextOffset: offset + clients.length,
  });
}

async function handleCallsGet(req, res) {
  const limit = Math.min(Number(req.query.limit) || 100, 300);
  const r = await supabaseRequest(`voice_calls?select=*&order=started_at.desc&limit=${limit}`);
  const calls = r.ok ? await r.json() : [];
  // Denormalize display names client-side-friendly without N+1 calls:
  // one extra query each for the small set of extension/client ids present.
  const extIds = [...new Set(calls.map(c => c.extension_id).filter(Boolean))];
  const clientIds = [...new Set(calls.map(c => c.client_id).filter(Boolean))];
  const [extRows, clientRows] = await Promise.all([
    extIds.length ? supabaseRequest(`voice_extensions?id=in.(${extIds.join(',')})&select=id,display_name,extension_number`).then(x => x.ok ? x.json() : []) : [],
    clientIds.length ? supabaseRequest(`clients?jobber_id=in.(${clientIds.join(',')})&select=jobber_id,name,first_name,last_name,company_name`).then(x => x.ok ? x.json() : []) : [],
  ]);
  const extById = new Map(extRows.map(e => [e.id, e]));
  const clientById = new Map(clientRows.map(c => [c.jobber_id, c]));
  let enriched = calls.map(c => ({
    ...c,
    extensionLabel: c.extension_id && extById.has(c.extension_id) ? `${extById.get(c.extension_id).extension_number} — ${extById.get(c.extension_id).display_name}` : null,
    clientName: c.client_id && clientById.has(c.client_id) ? clientDisplayName(clientById.get(c.client_id)) : null,
  }));

  // Calls that could not be named from client_id (unknown at call time) get
  // one more shot: a live lookup against clients.phone_e164 and, failing
  // that, voice_known_numbers -- the table the phone popup's "Create
  // Contact" / "Add to Existing Contact" actions write to. This lets those
  // actions retroactively label past calls without backfilling voice_calls.
  const unresolvedNumbers = [...new Set(
    enriched.filter(c => !c.clientName).map(c => (c.direction === 'inbound' ? c.from_number : c.to_number)).filter(Boolean)
  )];
  if (unresolvedNumbers.length) {
    const inList = unresolvedNumbers.map(n => encodeURIComponent(`"${n}"`)).join(',');
    const [byPhone, byKnown] = await Promise.all([
      supabaseRequest(`clients?phone_e164=in.(${inList})&select=jobber_id,name,first_name,last_name,company_name,phone_e164`).then(x => x.ok ? x.json() : []),
      supabaseRequest(`voice_known_numbers?e164=in.(${inList})&select=e164,display_name,jobber_client_id`).then(x => x.ok ? x.json() : []),
    ]);
    const phoneMap = new Map(byPhone.map(c => [c.phone_e164, clientDisplayName(c)]));
    const linkedIds = [...new Set(byKnown.map(k => k.jobber_client_id).filter(Boolean))];
    const linkedClients = linkedIds.length
      ? await supabaseRequest(`clients?jobber_id=in.(${linkedIds.join(',')})&select=jobber_id,name,first_name,last_name,company_name`).then(x => x.ok ? x.json() : [])
      : [];
    const linkedById = new Map(linkedClients.map(c => [c.jobber_id, c]));
    const knownMap = new Map(byKnown.map(k => [k.e164, k.jobber_client_id && linkedById.has(k.jobber_client_id) ? clientDisplayName(linkedById.get(k.jobber_client_id)) : k.display_name]));
    enriched = enriched.map(c => {
      if (c.clientName) return c;
      const number = c.direction === 'inbound' ? c.from_number : c.to_number;
      const name = phoneMap.get(number) || knownMap.get(number) || null;
      return name ? { ...c, clientName: name } : c;
    });
  }

  res.status(200).json({ ok: true, calls: enriched });
}

async function handleVoicemailsGet(req, res, user) {
  const mine = await myExtension(user.id);
  if (req.query.all === "1" && !(await isVoiceAdmin(user))) {
    return res.status(403).json({ ok: false, error: "Only a phone-system administrator can view voicemail for other extensions." });
  }
  const scope = req.query.all === "1" ? "" : (mine ? `&extension_id=eq.${mine.id}` : "&extension_id=is.null");
  const r = await supabaseRequest(`voice_voicemails?select=*&deleted_at=is.null${scope}&order=created_at.desc&limit=200`);
  res.status(200).json({ ok: true, voicemails: r.ok ? await r.json() : [] });
}

// Soft-delete a voicemail (sets deleted_at). Same ownership gate as
// voicemail_read: your own voicemail, or admin. Reversible -- the row and
// its recording are retained, just hidden from the inbox.
async function handleVoicemailDelete(req, res, user) {
  const b = req.body || {};
  if (!b.id) return res.status(400).json({ ok: false, error: "id is required" });
  if (!(await isVoiceAdmin(user))) {
    const mine = await myExtension(user.id);
    const vmRes = await supabaseRequest(`voice_voicemails?id=eq.${b.id}&select=extension_id&limit=1`);
    const vm = vmRes.ok ? (await vmRes.json())[0] : null;
    if (!vm || !mine || vm.extension_id !== mine.id) {
      return res.status(403).json({ ok: false, error: "You can only delete your own voicemail." });
    }
  }
  const upd = await supabaseRequest(`voice_voicemails?id=eq.${b.id}`, { method: "PATCH", body: JSON.stringify({ deleted_at: new Date().toISOString() }) });
  if (!upd.ok) return res.status(400).json({ ok: false, error: await upd.text() });
  res.status(200).json({ ok: true });
}

async function handleVoicemailRead(req, res, user) {
  const b = req.body || {};
  if (!b.id) return res.status(400).json({ ok: false, error: "id is required" });
  if (!(await isVoiceAdmin(user))) {
    const mine = await myExtension(user.id);
    const vmRes = await supabaseRequest(`voice_voicemails?id=eq.${b.id}&select=extension_id&limit=1`);
    const vmRows = vmRes.ok ? await vmRes.json() : [];
    const vm = vmRows[0];
    if (!vm || !mine || vm.extension_id !== mine.id) {
      return res.status(403).json({ ok: false, error: "You can only mark your own voicemail read." });
    }
  }
  await supabaseRequest(`voice_voicemails?id=eq.${b.id}`, { method: "PATCH", body: JSON.stringify({ read: b.read !== false }) });
  res.status(200).json({ ok: true });
}

async function handleToken(req, res, user) {
  if (!isVoiceConfigured()) return res.status(409).json({ ok: false, error: 'Twilio is not connected yet. See Settings.' });
  const mine = await myExtension(user.id);
  if (!mine) return res.status(403).json({ ok: false, error: 'No phone extension is assigned to your account yet. Ask an admin to create one in Settings.' });
  const identity = `ext-${mine.id}`;
  const token = mintVoiceAccessToken(identity);
  res.status(200).json({ ok: true, token, identity, extension: mine });
}

// ---------------------------------------------------------------------
// Live call control -- Hold uses Twilio's Conference Participant "Hold"
// API (real per-leg hold, not a Dial redirect that would drop the
// other leg -- see voice-webhook.js's conference architecture note).
// Transfer (blind) dials a new leg into the same conference, then
// removes the transferring member's own leg once the new leg has
// joined. Warm transfer ("talk first") is not built yet -- see the
// architecture doc's phased roadmap.
// ---------------------------------------------------------------------
// Escalate a direct <Dial> call into a Conference on-demand -- Hold and
// Transfer both need one; plain calls stay on <Dial> for call quality
// (see reina/voip-quality-fix-2026-07-24.md). Finds the other party's
// call leg and redirects it to join the conference; the caller's own
// <Dial> then interrupts, and its action callback (handleDialAction in
// api/voice-webhook.js) brings that leg into the same conference.
async function escalateCallToConference(call, req) {
  const childSid = await findActiveChildCallSid(call.caller_call_sid);
  if (!childSid) {
    const err = new Error('The other party is not connected.');
    err.status = 409;
    throw err;
  }
  await supabaseRequest(`voice_calls?id=eq.${call.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ escalation_requested: true }),
  }).catch(() => {});
  const url = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers['x-forwarded-host'] || req.headers.host}`;
  // The customer's leg (parent on inbound calls, child on outbound calls)
  // should hear hold music while the agent's leg starts the conference.
  const wait = call.direction === 'outbound' ? '1' : '0';
  await updateLiveCall(childSid, {
    Url: `${url}/api/voice-webhook?resource=conference-join&callId=${encodeURIComponent(call.id)}&wait=${wait}`,
    Method: 'POST',
  });
}

async function handleHold(req, res, user) {
  const b = req.body || {};
  if (!b.callId) return res.status(400).json({ ok: false, error: 'callId is required' });
  const r = await supabaseRequest(`voice_calls?id=eq.${b.callId}&select=*`);
  const call = r.ok ? (await r.json())[0] : null;
  if (!call || !call.caller_call_sid) return res.status(409).json({ ok: false, error: 'Call is not connected yet.' });

  if (!call.conference_sid) {
    // Still a direct <Dial> (see reina/voip-quality-fix-2026-07-24.md) --
    // escalate into a conference so hold is possible. Un-holding a call
    // that was never escalated is a no-op: there's nothing to release.
    if (b.hold === false) return res.status(200).json({ ok: true, held: false });
    try {
      await escalateCallToConference(call, req);
    } catch (e) {
      return res.status(e.status || 400).json({ ok: false, error: e.message || String(e) });
    }
    return res.status(200).json({ ok: true, held: true, escalating: true });
  }

  const holdUrl = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers['x-forwarded-host'] || req.headers.host}/api/voice-webhook?resource=hold-music`;
  const params = { Hold: b.hold !== false ? 'true' : 'false' };
  if (b.hold !== false) params.HoldUrl = holdUrl;
  const upd = await twilioRequest(`Conferences/${encodeURIComponent(call.conference_sid)}/Participants/${encodeURIComponent(call.caller_call_sid)}.json`, {
    method: 'POST',
    body: new URLSearchParams(params),
  });
  if (!upd.ok) return res.status(400).json({ ok: false, error: await upd.text() });
  res.status(200).json({ ok: true, held: b.hold !== false });
}

async function handleTransfer(req, res, user) {
  const b = req.body || {};
  if (!b.callId) return res.status(400).json({ ok: false, error: 'callId is required' });
  const r = await supabaseRequest(`voice_calls?id=eq.${b.callId}&select=*`);
  const call = r.ok ? (await r.json())[0] : null;
  if (!call || !call.caller_call_sid) return res.status(409).json({ ok: false, error: 'Call is not connected yet.' });

  if (!call.conference_sid) {
    // Still a direct <Dial> -- escalate first; the frontend retries this
    // same request once the conference exists (see
    // reina/voip-quality-fix-2026-07-24.md).
    try {
      await escalateCallToConference(call, req);
    } catch (e) {
      return res.status(e.status || 400).json({ ok: false, error: e.message || String(e) });
    }
    return res.status(200).json({ ok: true, transferring: true, escalating: true });
  }

  let target = null;
  if (b.toExtensionNumber) {
    const extRes = await supabaseRequest(`voice_extensions?extension_number=eq.${encodeURIComponent(b.toExtensionNumber)}&active=eq.true&select=id&limit=1`);
    const ext = extRes.ok ? (await extRes.json())[0] : null;
    if (!ext) return res.status(404).json({ ok: false, error: 'No such extension' });
    target = `client:ext-${ext.id}`;
  } else if (b.toNumber) {
    target = normalizeToE164(b.toNumber);
  } else {
    return res.status(400).json({ ok: false, error: 'toExtensionNumber or toNumber is required' });
  }

  const url = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers['x-forwarded-host'] || req.headers.host}`;
  const confJoinUrl = `${url}/api/voice-webhook?resource=conference-join&callId=${encodeURIComponent(call.id)}`;
  const newLeg = await twilioRequest('Calls.json', {
    method: 'POST',
    body: new URLSearchParams({
      To: target,
      From: call.from_number || '',
      Url: confJoinUrl,
      Timeout: '20',
    }),
  });
  if (!newLeg.ok) return res.status(400).json({ ok: false, error: await newLeg.text() });

  // Remove the transferring member's own leg so the caller ends up
  // alone with the new target once they join (blind transfer).
  if (call.agent_call_sid) {
    await twilioRequest(`Conferences/${encodeURIComponent(call.conference_sid)}/Participants/${encodeURIComponent(call.agent_call_sid)}.json`, { method: 'DELETE' }).catch(() => {});
  }
  res.status(200).json({ ok: true, transferredTo: target });
}

// ---------------------------------------------------------------------
// Call Flow -- backs the drag-and-drop editor in VoIP Settings > Call
// Flow (public/hiveconnect/voip-callflow.js). Reading the current flow
// is allowed for any authenticated staff member (same as extensions and
// numbers below); saving a new flow is admin-only via requireVoiceAdmin,
// same gate as every other voice-system config mutation.
const CALL_FLOW_NODE_TYPES = ["call_in", "dispatch_active", "greeting_ivr", "queue", "voicemail", "hangup"];

function validateCallFlowGraph(graph) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return "The flow needs a nodes list and an edges list.";
  const ids = new Set();
  for (const n of graph.nodes) {
    if (!n.id || typeof n.id !== "string") return "Every node needs a unique id.";
    if (ids.has(n.id)) return "Duplicate node id: " + n.id;
    ids.add(n.id);
    if (!CALL_FLOW_NODE_TYPES.includes(n.type)) return "Unknown node type: " + n.type;
  }
  const callInCount = graph.nodes.filter(function (n) { return n.type === "call_in"; }).length;
  if (callInCount !== 1) return "The flow needs exactly one Call In node.";
  for (const e of graph.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) return "An edge points to a node that does not exist.";
  }
  return null;
}

async function handleCallFlowGet(req, res) {
  const r = await supabaseRequest("voice_call_flows?is_active=eq.true&select=id,name,graph,updated_at&order=updated_at.desc&limit=1");
  const rows = r.ok ? await r.json() : [];
  res.status(200).json({ ok: true, flow: rows[0] || null });
}

async function handleCallFlowPost(req, res) {
  const b = req.body || {};
  const error = validateCallFlowGraph(b.graph);
  if (error) return res.status(400).json({ ok: false, error });
  // Keep history instead of updating in place -- flip every previously
  // active row off, then insert the new one as the sole active flow.
  await supabaseRequest("voice_call_flows?is_active=eq.true", {
    method: "PATCH",
    body: JSON.stringify({ is_active: false }),
  }).catch(function () {});
  const ins = await supabaseRequest("voice_call_flows", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ name: b.name || "Main Inbound Flow", is_active: true, graph: b.graph }),
  });
  if (!ins.ok) return res.status(400).json({ ok: false, error: await ins.text() });
  const created = (await ins.json())[0];
  res.status(200).json({ ok: true, id: created.id });
}

// ---------------------------------------------------------------------
// Phase 1 -- Call Queues, Agent Status, Callbacks.
// Queues are an ordered hold line (Twilio <Enqueue>) that available
// agents pull from ("Answer Next" -> Twilio <Dial><Queue>). Live waiting
// counts are read straight from Twilio (the source of truth) via
// twilioQueueStatus, never tracked in our DB where they could drift.
// All queue/agent config mutations are admin-gated; setting your OWN
// status and answering the next caller are available to any agent.
// ---------------------------------------------------------------------
const AGENT_STATUSES = ['available', 'on_call', 'on_break', 'dnd', 'offline', 'wrapping_up'];

async function handleQueuesGet(req, res) {
  const r = await supabaseRequest('voice_queues?select=*&order=created_at.asc');
  const queues = r.ok ? await r.json() : [];
  const mRes = await supabaseRequest('voice_queue_members?select=id,queue_id,extension_id,priority');
  const members = mRes.ok ? await mRes.json() : [];
  const byQueue = new Map();
  for (const m of members) {
    if (!byQueue.has(m.queue_id)) byQueue.set(m.queue_id, []);
    byQueue.get(m.queue_id).push(m);
  }
  res.status(200).json({
    ok: true,
    queues: queues.map(q => ({ ...q, members: byQueue.get(q.id) || [] })),
  });
}

async function handleQueuesPost(req, res) {
  const b = req.body || {};
  if (!b.id && !b.name) return res.status(400).json({ ok: false, error: 'name is required' });
  const row = {};
  if (b.name !== undefined) row.name = b.name;
  if (b.ring_order !== undefined) row.ring_order = ['fifo', 'priority'].includes(b.ring_order) ? b.ring_order : 'fifo';
  if (b.timeout_seconds !== undefined) row.timeout_seconds = Math.max(5, Number(b.timeout_seconds) || 30);
  if (b.overflow_destination !== undefined) row.overflow_destination = ['extension', 'voicemail', 'callback'].includes(b.overflow_destination) ? b.overflow_destination : 'voicemail';
  if (b.overflow_extension_id !== undefined) row.overflow_extension_id = b.overflow_extension_id || null;
  if (b.hold_music_url !== undefined) row.hold_music_url = b.hold_music_url || null;
  if (b.is_default_inbound !== undefined) row.is_default_inbound = Boolean(b.is_default_inbound);
  if (b.active !== undefined) row.active = b.active !== false;
  row.updated_at = new Date().toISOString();

  // Only one queue may be the default inbound target -- clear the flag on
  // every other row first when this one claims it (the partial unique
  // index enforces it, but clearing avoids a constraint error on save).
  if (row.is_default_inbound) {
    await supabaseRequest(`voice_queues?is_default_inbound=eq.true${b.id ? `&id=neq.${b.id}` : ''}`, {
      method: 'PATCH', body: JSON.stringify({ is_default_inbound: false }),
    }).catch(() => {});
  }

  let queueId = b.id;
  if (b.id) {
    const upd = await supabaseRequest(`voice_queues?id=eq.${b.id}`, { method: 'PATCH', body: JSON.stringify(row) });
    if (!upd.ok) return res.status(400).json({ ok: false, error: await upd.text() });
  } else {
    const ins = await supabaseRequest('voice_queues', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
    if (!ins.ok) return res.status(400).json({ ok: false, error: await ins.text() });
    queueId = (await ins.json())[0].id;
  }

  // Optional full membership replace: body.members is an array of
  // { extension_id, priority } (or bare extension_id strings).
  if (Array.isArray(b.members)) {
    await supabaseRequest(`voice_queue_members?queue_id=eq.${queueId}`, { method: 'DELETE' }).catch(() => {});
    const rows = b.members
      .map(m => (typeof m === 'string' ? { extension_id: m } : m))
      .filter(m => m && m.extension_id)
      .map(m => ({ queue_id: queueId, extension_id: m.extension_id, priority: Number(m.priority) || 0 }));
    if (rows.length) {
      await supabaseRequest('voice_queue_members', { method: 'POST', body: JSON.stringify(rows) }).catch(() => {});
    }
  }
  res.status(200).json({ ok: true, id: queueId });
}

async function handleQueuesPatch(req, res) {
  // Partial update -- e.g. flip active on/off, retarget overflow -- without
  // resending the whole queue. Same admin gate as POST.
  const b = req.body || {};
  if (!b.id) return res.status(400).json({ ok: false, error: 'id is required' });
  const { id, members, ...rest } = b;
  rest.updated_at = new Date().toISOString();
  if (rest.is_default_inbound) {
    await supabaseRequest(`voice_queues?is_default_inbound=eq.true&id=neq.${id}`, { method: 'PATCH', body: JSON.stringify({ is_default_inbound: false }) }).catch(() => {});
  }
  const upd = await supabaseRequest(`voice_queues?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(rest) });
  if (!upd.ok) return res.status(400).json({ ok: false, error: await upd.text() });
  res.status(200).json({ ok: true, id });
}

async function handleQueueStatusGet(req, res) {
  const only = req.query.queueId;
  const scope = only ? `&id=eq.${only}` : '&active=eq.true';
  const r = await supabaseRequest(`voice_queues?select=id,name,timeout_seconds${scope}&order=created_at.asc`);
  const queues = r.ok ? await r.json() : [];
  if (!queues.length) return res.status(200).json({ ok: true, queues: [] });

  const [memRes, statusRes] = await Promise.all([
    supabaseRequest('voice_queue_members?select=queue_id,extension_id'),
    supabaseRequest(`voice_agent_status?status=eq.available&select=extension_id`),
  ]);
  const members = memRes.ok ? await memRes.json() : [];
  const availableExt = new Set((statusRes.ok ? await statusRes.json() : []).map(s => s.extension_id));
  const membersByQueue = new Map();
  for (const m of members) {
    if (!membersByQueue.has(m.queue_id)) membersByQueue.set(m.queue_id, []);
    membersByQueue.get(m.queue_id).push(m.extension_id);
  }

  const configured = isVoiceConfigured();
  const out = [];
  for (const q of queues) {
    const live = configured ? await twilioQueueStatus(queueFriendlyName(q.id)) : { size: 0, longestWaitSeconds: 0, averageWaitSeconds: 0 };
    const qMembers = membersByQueue.get(q.id) || [];
    out.push({
      id: q.id,
      name: q.name,
      timeoutSeconds: q.timeout_seconds,
      waiting: live.size,
      longestWaitSeconds: live.longestWaitSeconds,
      averageWaitSeconds: live.averageWaitSeconds,
      agentsAvailable: qMembers.filter(id => availableExt.has(id)).length,
      agentsTotal: qMembers.length,
    });
  }
  res.status(200).json({ ok: true, configured, queues: out });
}

async function handleAgentStatusGet(req, res, user) {
  const [extRes, stRes] = await Promise.all([
    supabaseRequest('voice_extensions?active=eq.true&select=id,extension_number,display_name,user_id&order=extension_number.asc'),
    supabaseRequest('voice_agent_status?select=extension_id,status,status_note,updated_at'),
  ]);
  const extensions = extRes.ok ? await extRes.json() : [];
  const statuses = stRes.ok ? await stRes.json() : [];
  const byExt = new Map(statuses.map(s => [s.extension_id, s]));
  const mine = extensions.find(e => e.user_id && user && e.user_id === user.id) || null;
  res.status(200).json({
    ok: true,
    mineExtensionId: mine ? mine.id : null,
    mineStatus: mine && byExt.get(mine.id) ? byExt.get(mine.id).status : (mine ? 'offline' : null),
    agents: extensions.map(e => {
      const s = byExt.get(e.id);
      return {
        extensionId: e.id,
        extensionNumber: e.extension_number,
        name: e.display_name,
        status: s ? s.status : 'offline',
        statusNote: s ? s.status_note : null,
        updatedAt: s ? s.updated_at : null,
      };
    }),
  });
}

async function handleAgentStatusPost(req, res, user) {
  const b = req.body || {};
  const status = b.status;
  if (!AGENT_STATUSES.includes(status)) return res.status(400).json({ ok: false, error: 'A valid status is required' });
  // An agent may set their OWN status; only an admin may set another
  // extension's status (e.g. force-offline). 'on_call'/'wrapping_up' are
  // normally set by call webhooks but allowed here for manual override.
  const mine = await myExtension(user.id);
  let extensionId = mine ? mine.id : null;
  if (b.extensionId && (!mine || b.extensionId !== mine.id)) {
    if (!(await isVoiceAdmin(user))) return res.status(403).json({ ok: false, error: 'You can only change your own status.' });
    extensionId = b.extensionId;
  }
  if (!extensionId) return res.status(403).json({ ok: false, error: 'No phone extension is assigned to your account yet.' });
  const row = { extension_id: extensionId, status, status_note: b.statusNote || null, updated_at: new Date().toISOString() };
  const up = await supabaseRequest('voice_agent_status?on_conflict=extension_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(row),
  });
  if (!up.ok) return res.status(400).json({ ok: false, error: await up.text() });
  res.status(200).json({ ok: true, status });
}

// Answer Next -- ring the requesting agent's softphone, then bridge them
// to the front caller of the queue via <Dial><Queue> (see the
// queue-dequeue webhook). Server-originated so the panel only needs a
// button; the agent's browser receives the call like any inbound one.
async function handleQueueAnswer(req, res, user) {
  if (!isVoiceConfigured()) return res.status(409).json({ ok: false, error: 'Twilio is not connected yet. See Settings.' });
  const b = req.body || {};
  const mine = await myExtension(user.id);
  if (!mine) return res.status(403).json({ ok: false, error: 'No phone extension is assigned to your account yet. Ask an admin to create one in Settings.' });

  // Default to the caller's queue by id, else the default-inbound queue.
  let queueId = b.queueId;
  if (!queueId) {
    const qRes = await supabaseRequest('voice_queues?is_default_inbound=eq.true&active=eq.true&select=id&limit=1');
    const q = qRes.ok ? (await qRes.json())[0] : null;
    queueId = q ? q.id : null;
  }
  if (!queueId) return res.status(404).json({ ok: false, error: 'No queue to answer.' });

  const numRes = await supabaseRequest('voice_numbers?role=eq.main&active=eq.true&select=e164&limit=1');
  const mainNumber = numRes.ok ? (await numRes.json())[0] : null;
  if (!mainNumber) return res.status(409).json({ ok: false, error: 'No main number registered yet.' });

  const url = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers['x-forwarded-host'] || req.headers.host}`;
  try {
    const call = await createCall({
      to: `client:ext-${mine.id}`,
      from: mainNumber.e164,
      url: `${url}/api/voice-webhook?resource=queue-dequeue&queueId=${encodeURIComponent(queueId)}`,
      timeout: 30,
    });
    res.status(200).json({ ok: true, callSid: call.sid, queueId });
  } catch (e) {
    res.status(400).json({ ok: false, error: String((e && e.message) || e) });
  }
}

async function handleCallbacksGet(req, res) {
  const status = req.query.status;
  const scope = status && ['unassigned', 'assigned', 'completed', 'dismissed'].includes(status) ? `&status=eq.${status}` : '';
  const r = await supabaseRequest(`voice_callbacks?select=*${scope}&order=created_at.desc&limit=200`);
  res.status(200).json({ ok: true, callbacks: r.ok ? await r.json() : [] });
}

async function handleCallbackUpdate(req, res, user) {
  const b = req.body || {};
  if (!b.id) return res.status(400).json({ ok: false, error: 'id is required' });
  const row = { updated_at: new Date().toISOString() };
  if (b.status !== undefined) {
    if (!['unassigned', 'assigned', 'completed', 'dismissed'].includes(b.status)) return res.status(400).json({ ok: false, error: 'invalid status' });
    row.status = b.status;
  }
  // Claiming a callback assigns it to the requesting agent's extension.
  if (b.claim) {
    const mine = await myExtension(user.id);
    if (!mine) return res.status(403).json({ ok: false, error: 'No phone extension is assigned to your account yet.' });
    row.assigned_extension_id = mine.id;
    row.status = 'assigned';
  }
  const upd = await supabaseRequest(`voice_callbacks?id=eq.${b.id}`, { method: 'PATCH', body: JSON.stringify(row) });
  if (!upd.ok) return res.status(400).json({ ok: false, error: await upd.text() });
  res.status(200).json({ ok: true });
}

// ---------------------------------------------------------------------
// Phase 4 -- AI Call Intelligence + recording settings. The transcribe->
// summarize->draft pipeline lives in _lib/call-intelligence.js; here we
// expose reading a call's intelligence, an admin reprocess, and the
// record_calls / ai_call_summaries toggles.
// ---------------------------------------------------------------------
async function handleCallIntelligenceGet(req, res) {
  const callId = req.query.callId;
  if (!callId) return res.status(400).json({ ok: false, error: 'callId is required' });
  const r = await supabaseRequest(`voice_calls?id=eq.${callId}&select=id,transcript,transcript_status,ai_summary,recording_url,recording_sid&limit=1`);
  const call = r.ok ? (await r.json())[0] : null;
  if (!call) return res.status(404).json({ ok: false, error: 'call not found' });
  const drafts = (call.ai_summary && call.ai_summary.draft_actions) || [];
  res.status(200).json({ ok: true, call, draftActions: drafts });
}

async function handleCallIntelligenceReprocess(req, res) {
  const b = req.body || {};
  if (!b.callId) return res.status(400).json({ ok: false, error: 'callId is required' });
  const r = await supabaseRequest(`voice_calls?id=eq.${b.callId}&select=*&limit=1`);
  const call = r.ok ? (await r.json())[0] : null;
  if (!call) return res.status(404).json({ ok: false, error: 'call not found' });
  if (!call.transcript) return res.status(409).json({ ok: false, error: 'This call has no transcript yet. Recording plus a transcript source are needed first.' });
  const summary = await runCallIntelligence(call);
  if (!summary) return res.status(409).json({ ok: false, error: 'Could not generate a summary (AI summaries off or no API key).' });
  res.status(200).json({ ok: true, aiSummary: summary });
}

async function handleVoiceSettingsGet(req, res) {
  res.status(200).json({ ok: true, settings: await getVoiceSettings() });
}

async function handleVoiceSettingsPost(req, res) {
  const b = req.body || {};
  const row = { singleton: true, updated_at: new Date().toISOString() };
  if (b.record_calls !== undefined) row.record_calls = b.record_calls !== false;
  if (b.ai_call_summaries !== undefined) row.ai_call_summaries = b.ai_call_summaries !== false;
  if (b.recording_channels !== undefined) row.recording_channels = ['dual', 'mono'].includes(b.recording_channels) ? b.recording_channels : 'dual';
  if (b.recording_consent_message !== undefined) row.recording_consent_message = b.recording_consent_message || null;
  const up = await supabaseRequest('voice_settings?on_conflict=singleton', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(row),
  });
  if (!up.ok) return res.status(400).json({ ok: false, error: await up.text() });
  res.status(200).json({ ok: true });
}

const GET_HANDLERS = {
  recording_audio: handleRecordingAudio,
  status: handleStatus,
  call_intelligence: handleCallIntelligenceGet,
  voice_settings: handleVoiceSettingsGet,
  extensions: handleExtensionsGet,
  numbers: handleNumbersGet,
  schedules: schedulesCrud.get,
  greetings: greetingsCrud.get,
  blocklist: handleBlocklistGet,
  calls: handleCallsGet,
  voicemails: handleVoicemailsGet,
  directory: handleDirectoryGet,
  caller: handleCallerGet,
  call_flow: handleCallFlowGet,
  queues: handleQueuesGet,
  queue_status: handleQueueStatusGet,
  agent_status: handleAgentStatusGet,
  callbacks: handleCallbacksGet,
  sms_threads: handleSmsThreadsGet,
  sms_thread: handleSmsThreadGet,
};

const POST_HANDLERS = {
  extensions: requireVoiceAdmin(handleExtensionsPost),
  call_flow: requireVoiceAdmin(handleCallFlowPost),
  numbers: requireVoiceAdmin(handleNumbersPost),
  schedules: requireVoiceAdmin(schedulesCrud.post),
  greetings: requireVoiceAdmin(handleGreetingsPost),
  greeting_upload: requireVoiceAdmin(handleGreetingUpload),
  blocklist: requireVoiceAdmin(handleBlocklistPost),
  blocklist_remove: requireVoiceAdmin(handleBlocklistRemove),
  contact_create: handleContactCreate,
  contact_link: handleContactLink,
  sms: handleSms,
  voicemail_read: handleVoicemailRead,
  voicemail_delete: handleVoicemailDelete,
  token: handleToken,
  hold: handleHold,
  transfer: handleTransfer,
  queues: requireVoiceAdmin(handleQueuesPost),
  agent_status: handleAgentStatusPost,
  queue_answer: handleQueueAnswer,
  callback_update: handleCallbackUpdate,
  call_intelligence_reprocess: requireVoiceAdmin(handleCallIntelligenceReprocess),
  voice_settings: requireVoiceAdmin(handleVoiceSettingsPost),
};

const PATCH_HANDLERS = {
  queues: requireVoiceAdmin(handleQueuesPatch),
};

export default async function handler(req, res) {
  const resource = req.query.resource;
  // GET status is intentionally public (unauthenticated) so the frontend
  // can show the honest "not connected yet" state before anyone logs in
  // to a phone-specific view; everything else requires a real session.
  if (req.method === 'GET' && resource === 'status') return handleStatus(req, res);

  const user = await requireUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Not authenticated' });

  const table = req.method === 'GET' ? GET_HANDLERS : (req.method === 'PATCH' ? PATCH_HANDLERS : POST_HANDLERS);
  const fn = table[resource];
  if (!fn) return res.status(404).json({ ok: false, error: 'unknown voice resource' });
  try {
    await fn(req, res, user);
  } catch (err) {
    console.error(`api/voice (${resource}) failed:`, err);
    res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
}

// ---- recording audio relay ------------------------------------------------
// <audio> tags cannot send our bearer token, and raw Twilio recording URLs
// demand Twilio basic-auth in the browser. The panel fetches THIS endpoint
// (normal Authorization header), we pull the mp3 from Twilio server-side,
// and the browser plays a local blob. Twilio credentials never leave here.
async function handleRecordingAudio(req, res) {
  const kind = req.query.kind === 'vm' ? 'vm' : 'call';
  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });
  const table = kind === 'vm' ? 'voice_voicemails' : 'voice_calls';
  const rowRes = await supabaseRequest(table + '?id=eq.' + encodeURIComponent(id) + '&select=recording_url&limit=1');
  const rows = rowRes.ok ? await rowRes.json() : [];
  const url = rows[0] && rows[0].recording_url;
  if (!url) return res.status(404).json({ ok: false, error: 'no recording for that id' });
  let u;
  try { u = new URL(url); } catch (e) { return res.status(422).json({ ok: false, error: 'bad recording url' }); }
  if (u.hostname !== 'api.twilio.com') return res.status(422).json({ ok: false, error: 'unexpected recording host' });
  const auth = Buffer.from(process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64');
  const media = /\.(mp3|wav)$/.test(u.pathname) ? url : url + '.mp3';
  const r = await fetch(media, { headers: { Authorization: 'Basic ' + auth } });
  if (!r.ok) return res.status(502).json({ ok: false, error: 'recording fetch failed (' + r.status + ')' });
  const buf = Buffer.from(await r.arrayBuffer());
  res.setHeader('Content-Type', r.headers.get('content-type') || 'audio/mpeg');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  return res.status(200).send(buf);
}
