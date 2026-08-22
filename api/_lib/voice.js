// api/_lib/voice.js
// Shared helpers for HiveLogic Phone. Everything Twilio-specific lives in
// this one file on purpose -- the rest of the app (api/voice.js,
// api/voice-webhook.js, public/app-phone.js) talks to functions like
// placeCallToken(), buildTwiML(), verifyProviderSignature() rather than
// to Twilio directly, so swapping carriers later means rewriting this
// file, not the whole feature. See reina/voip-system-architecture-2026-07-24.md
// (Build Reina project) for the ADR that decided this boundary.
//
// No twilio npm package -- matches this repo's existing pattern (jobber.js,
// marketing.js) of talking to third-party APIs with raw fetch instead of
// adding SDK dependencies. Twilio's REST API and TwiML are both plain
// HTTP/XML, so this needs nothing beyond fetch + node:crypto.

import crypto from 'node:crypto';

const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';
const TWILIO_INTELLIGENCE_BASE = 'https://intelligence.twilio.com/v2';

export function isVoiceConfigured() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_API_KEY_SID &&
    process.env.TWILIO_API_KEY_SECRET &&
    process.env.TWILIO_TWIML_APP_SID
  );
}

// ---------------------------------------------------------------------
// Twilio REST (used for: minting call-control updates like hold/transfer,
// and -- later -- number search/purchase). Basic Auth with Account SID /
// Auth Token, exactly as Twilio's REST API expects.
// ---------------------------------------------------------------------
export async function twilioRequest(path, options = {}) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error('Twilio not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN missing)');
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const res = await fetch(`${TWILIO_API_BASE}/Accounts/${sid}/${path}`, {
    ...options,
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...options.headers,
    },
  });
  return res;
}

// Update an in-progress call (used for hold/resume/redirect/transfer):
// POST /Calls/{CallSid}.json with a new Url (TwiML) or Twiml body, or
// Status=completed to end it. See Twilio's "Modify Live Calls" docs.
export async function updateLiveCall(callSid, params) {
  const res = await twilioRequest(`Calls/${encodeURIComponent(callSid)}.json`, {
    method: 'POST',
    body: new URLSearchParams(params),
  });
  if (!res.ok) throw new Error(`Twilio call update failed: ${await res.text()}`);
  return res.json();
}

// Find the currently-active call leg that Twilio spawned as a child of a
// <Dial> verb (used to escalate a direct two-party call into a
// conference on-demand, when Hold or Transfer is actually invoked --
// see reina/voip-quality-fix-2026-07-24.md). Returns null if none found
// (e.g. the other party already hung up).
export async function findActiveChildCallSid(parentCallSid) {
  if (!parentCallSid) return null;
  const res = await twilioRequest(`Calls.json?ParentCallSid=${encodeURIComponent(parentCallSid)}&Status=in-progress&PageSize=1`);
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const call = data && data.calls && data.calls[0];
  return call ? call.sid : null;
}

// ---------------------------------------------------------------------
// Signature verification for inbound webhooks -- Twilio's algorithm:
// HMAC-SHA1 of (full request URL + sorted POST param key/value pairs
// concatenated), base64-encoded, compared to X-Twilio-Signature.
// https://www.twilio.com/docs/usage/webhooks/webhooks-security
// ---------------------------------------------------------------------
export function verifyTwilioSignature(url, params, signatureHeader) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return false;
  if (!signatureHeader) return false;
  let data = url;
  const keys = Object.keys(params || {}).sort();
  for (const key of keys) {
    data += key + params[key];
  }
  const expected = crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false; // length mismatch etc. -- treat as not verified, never throw
  }
}

// ---------------------------------------------------------------------
// TwiML builder -- deliberately a tiny hand-rolled XML builder, not a
// dependency. Every function returns a well-formed <Response> document.
// ---------------------------------------------------------------------
export function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export class TwiML {
  constructor() { this.body = ''; }
  say(text, opts = {}) {
    const voice = opts.voice || 'Polly.Joanna';
    this.body += `<Say voice="${escapeXml(voice)}">${escapeXml(text)}</Say>`;
    return this;
  }
  play(url) { this.body += `<Play>${escapeXml(url)}</Play>`; return this; }
  pause(seconds = 1) { this.body += `<Pause length="${Number(seconds) || 1}"/>`; return this; }
  redirect(url) { this.body += `<Redirect method="POST">${escapeXml(url)}</Redirect>`; return this; }
  hangup() { this.body += '<Hangup/>'; return this; }
  reject() { this.body += '<Reject/>'; return this; }
  // Gather digits (dial-by-extension / keypad menu). `action` is where
  // Twilio POSTs the collected Digits.
  gather({ action, numDigits = null, timeout = 6, finishOnKey = '#', say = null, playUrl = null }) {
    let inner = playUrl ? `<Play>${escapeXml(playUrl)}</Play>` : (say ? `<Say voice="Polly.Joanna">${escapeXml(say)}</Say>` : '');
    const nd = numDigits ? ` numDigits="${numDigits}"` : '';
    this.body += `<Gather input="dtmf" action="${escapeXml(action)}" method="POST" timeout="${timeout}" finishOnKey="${escapeXml(finishOnKey)}"${nd}>${inner}</Gather>`;
    return this;
  }
  // Dial to a client (browser softphone identity) or a plain PSTN number.
  dial({ toClientIdentity = null, toNumber = null, callerId = null, timeout = 20, action = null, record = 'do-not-record' }) {
    const attrs = [
      callerId ? `callerId="${escapeXml(callerId)}"` : '',
      `timeout="${timeout}"`,
      action ? `action="${escapeXml(action)}" method="POST"` : '',
      `record="${escapeXml(record)}"`,
    ].filter(Boolean).join(' ');
    const target = toClientIdentity
      ? `<Client>${escapeXml(toClientIdentity)}</Client>`
      : `<Number>${escapeXml(toNumber)}</Number>`;
    this.body += `<Dial ${attrs}>${target}</Dial>`;
    return this;
  }
  // Queues (Phase 1). <Enqueue> parks the caller in a named Twilio Queue
  // (auto-created on first use); waitUrl serves looping hold music and the
  // timeout->overflow check; action fires when the caller leaves the queue
  // (dequeued/bridged, <Leave>, or hangup) with a QueueResult param.
  enqueue(queueName, { waitUrl = null, action = null } = {}) {
    const attrs = [
      waitUrl ? `waitUrl="${escapeXml(waitUrl)}" waitUrlMethod="POST"` : '',
      action ? `action="${escapeXml(action)}" method="POST"` : '',
    ].filter(Boolean).join(' ');
    this.body += `<Enqueue ${attrs}>${escapeXml(queueName)}</Enqueue>`;
    return this;
  }
  // <Leave> dequeues the current caller from its queue; control then
  // passes to the <Enqueue>'s action URL with QueueResult=leave. Used by
  // the wait loop to fire overflow once timeout_seconds is exceeded.
  leave() { this.body += '<Leave/>'; return this; }
  // <Dial><Queue> is how an available agent pulls the next (front) caller
  // out of a queue and bridges to them ("Dequeue"). Referenced by the
  // same friendly name used in enqueue().
  dialQueue(queueName, { timeout = 30, action = null, callerId = null } = {}) {
    const dialAttrs = [
      callerId ? `callerId="${escapeXml(callerId)}"` : '',
      `timeout="${timeout}"`,
      action ? `action="${escapeXml(action)}" method="POST"` : '',
    ].filter(Boolean).join(' ');
    this.body += `<Dial ${dialAttrs}><Queue>${escapeXml(queueName)}</Queue></Dial>`;
    return this;
  }
  record({ action, maxLength = 120, transcribe = false, transcribeCallback = null, playBeep = true }) {
    const attrs = [
      `action="${escapeXml(action)}"`,
      'method="POST"',
      `maxLength="${maxLength}"`,
      `playBeep="${playBeep ? 'true' : 'false'}"`,
      transcribe ? 'transcribe="true"' : '',
      transcribe && transcribeCallback ? `transcribeCallback="${escapeXml(transcribeCallback)}"` : '',
    ].filter(Boolean).join(' ');
    this.body += `<Record ${attrs}/>`;
    return this;
  }
  toXml() { return `<?xml version="1.0" encoding="UTF-8"?><Response>${this.body}</Response>`; }
}

export function xmlResponse(res, twiml) {
  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send(twiml.toXml());
}

// ---------------------------------------------------------------------
// Access Token for the browser/mobile softphone (Twilio Voice SDK).
// Hand-rolled JWT -- Twilio's Access Token format is a standard JWT with
// a specific `grants` claim shape, documented publicly; no SDK needed.
// ---------------------------------------------------------------------
function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function mintVoiceAccessToken(identity, { ttlSeconds = 3600 } = {}) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const apiKeySid = process.env.TWILIO_API_KEY_SID;
  const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;
  const twimlAppSid = process.env.TWILIO_TWIML_APP_SID;
  if (!accountSid || !apiKeySid || !apiKeySecret || !twimlAppSid) {
    throw new Error('Twilio Voice SDK not configured (need TWILIO_API_KEY_SID / TWILIO_API_KEY_SECRET / TWILIO_TWIML_APP_SID)');
  }
  const now = Math.floor(Date.now() / 1000);
  const header = { typ: 'JWT', alg: 'HS256', cty: 'twilio-fpa;v=1' };
  const payload = {
    jti: `${apiKeySid}-${now}`,
    iss: apiKeySid,
    sub: accountSid,
    iat: now,
    exp: now + ttlSeconds,
    grants: {
      identity,
      voice: {
        outgoing: { application_sid: twimlAppSid },
        incoming: { allow: true },
      },
    },
  };
  const encHeader = base64url(JSON.stringify(header));
  const encPayload = base64url(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', apiKeySecret).update(`${encHeader}.${encPayload}`).digest();
  return `${encHeader}.${encPayload}.${base64url(signature)}`;
}

// ---------------------------------------------------------------------
// E.164 normalization -- best-effort, US/Canada-default (matches GH Co.'s
// real service area). Never throws; returns null on unparseable input so
// callers can fall back to "no match" instead of crashing a webhook.
// ---------------------------------------------------------------------
export function normalizeToE164(raw, defaultCountryCode = '1') {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  const bare = digits.replace(/\D/g, '');
  if (bare.length === 10) return `+${defaultCountryCode}${bare}`;
  if (bare.length === 11 && bare.startsWith(defaultCountryCode)) return `+${bare}`;
  return bare ? `+${bare}` : null;
}

// ---------------------------------------------------------------------
// Queue helpers (Phase 1). The Twilio Queue is the source of truth for
// live waiting state -- we read it rather than tracking counts in our own
// DB, so the number on screen can't drift from what Twilio actually holds.
// A queue is referenced by a stable friendly name (`hlq-{queueId}`); it is
// auto-created by the first <Enqueue> under that name.
// ---------------------------------------------------------------------
export function queueFriendlyName(queueId) {
  return `hlq-${queueId}`;
}

// Live status for one queue: current size, longest wait (front member),
// average wait. Returns zeros (never throws) when Twilio isn't reachable
// or the queue hasn't been created yet (no calls have entered it).
export async function twilioQueueStatus(friendlyName) {
  const empty = { queueSid: null, size: 0, longestWaitSeconds: 0, averageWaitSeconds: 0 };
  try {
    // Twilio's Queues list does NOT support a FriendlyName filter, so page
    // through the queues and match ourselves (there are only a handful).
    let path = 'Queues.json?PageSize=100';
    let q = null;
    for (let guard = 0; guard < 10 && path && !q; guard++) {
      const qRes = await twilioRequest(path);
      if (!qRes.ok) break;
      const qData = await qRes.json().catch(() => null);
      if (!qData) break;
      q = (qData.queues || []).find(item => item.friendly_name === friendlyName) || null;
      const next = qData.next_page_uri;
      path = (!q && next) ? next.replace(`/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/`, '') : null;
    }
    if (!q) return empty;
    let longest = 0;
    try {
      // Members come back front-first (position 0 = longest waiting).
      const mRes = await twilioRequest(`Queues/${encodeURIComponent(q.sid)}/Members.json?PageSize=1`);
      if (mRes.ok) {
        const mData = await mRes.json().catch(() => null);
        const front = mData && mData.queue_members && mData.queue_members[0];
        if (front) {
          if (typeof front.wait_time === 'number') longest = front.wait_time;
          else if (front.date_enqueued) longest = Math.max(0, Math.round((Date.now() - new Date(front.date_enqueued).getTime()) / 1000));
        }
      }
    } catch { /* longest wait is best-effort */ }
    return {
      queueSid: q.sid,
      size: Number(q.current_size) || 0,
      longestWaitSeconds: longest,
      averageWaitSeconds: Number(q.average_wait_time) || 0,
    };
  } catch {
    return empty;
  }
}

// ---------------------------------------------------------------------
// Twilio Voice Intelligence -- the transcript source for recorded calls
// (voicemail's <Record transcribe> can't transcribe a two-party call).
// A Voice Intelligence Service is created once in the Twilio console; its
// SID goes in TWILIO_INTELLIGENCE_SERVICE_SID and its webhook points at
// /api/voice-webhook?resource=intelligence-callback. Everything Twilio-
// specific stays here per the carrier-boundary rule.
// ---------------------------------------------------------------------
export function intelligenceConfigured() {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_INTELLIGENCE_SERVICE_SID);
}

async function intelligenceRequest(path, options = {}) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error('Twilio not configured');
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  return fetch(`${TWILIO_INTELLIGENCE_BASE}/${path}`, {
    ...options,
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...options.headers,
    },
  });
}

// Kick off async transcription of a completed recording. Returns the new
// Transcript SID (GT...) so the caller can store it and match the
// completion webhook back to the call. Throws on Twilio error.
export async function createCallTranscript(recordingSid) {
  const serviceSid = process.env.TWILIO_INTELLIGENCE_SERVICE_SID;
  if (!serviceSid) throw new Error('TWILIO_INTELLIGENCE_SERVICE_SID not set');
  const res = await intelligenceRequest('Transcripts', {
    method: 'POST',
    body: new URLSearchParams({
      ServiceSid: serviceSid,
      Channel: JSON.stringify({ media_properties: { source_sid: recordingSid } }),
    }),
  });
  if (!res.ok) throw new Error(`Voice Intelligence transcript create failed: ${await res.text()}`);
  const data = await res.json();
  return data.sid;
}

// Status of a transcript (queued|in-progress|completed|failed).
export async function getTranscriptStatus(transcriptSid) {
  const res = await intelligenceRequest(`Transcripts/${encodeURIComponent(transcriptSid)}`);
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data ? data.status : null;
}

// Fetch a completed transcript's sentences and join them into a readable,
// speaker-labelled transcript for the AI summary. Paginates through all
// sentences. Returns '' if none/unavailable (never throws).
export async function fetchTranscriptText(transcriptSid) {
  try {
    let url = `Transcripts/${encodeURIComponent(transcriptSid)}/Sentences?PageSize=200`;
    const lines = [];
    for (let guard = 0; guard < 20 && url; guard++) {
      const res = await intelligenceRequest(url);
      if (!res.ok) break;
      const data = await res.json().catch(() => null);
      if (!data) break;
      const sentences = data.sentences || [];
      for (const s of sentences) {
        const who = (s.media_channel === 1 || s.media_channel === '1') ? 'Agent' : 'Caller';
        const text = s.transcript || s.text || '';
        if (text) lines.push(`${who}: ${text}`);
      }
      const next = data.meta && data.meta.next_page_url;
      url = next ? next.replace(TWILIO_INTELLIGENCE_BASE + '/', '') : null;
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

// Originate a new outbound call leg (used to ring an agent's softphone so
// they can dequeue the next caller, and for intercom in Phase 3). `to` may
// be a PSTN E.164 or a `client:identity` target. Throws on Twilio error so
// the caller can surface it.
export async function createCall({ to, from, url, timeout = 30, statusCallback = null, statusCallbackEvent = null }) {
  const params = { To: to, From: from, Url: url, Method: 'POST', Timeout: String(timeout) };
  if (statusCallback) {
    params.StatusCallback = statusCallback;
    params.StatusCallbackMethod = 'POST';
    if (statusCallbackEvent) params.StatusCallbackEvent = statusCallbackEvent;
  }
  const res = await twilioRequest('Calls.json', { method: 'POST', body: new URLSearchParams(params) });
  if (!res.ok) throw new Error(`Twilio createCall failed: ${await res.text()}`);
  return res.json();
}
