import { verifyRequestUser } from './_lib/auth.js';
import { supabaseRequest } from './_lib/jobber.js';

export const config = { api: { bodyParser: false } };

const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_CHARS = 4_000;
const ALLOWED_TYPES = new Set(['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav', 'audio/mpeg']);

function secure(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
}

function response(res, status, code, extra = {}) {
  return res.status(status).json({ ok: false, code, ...extra });
}

function contentType(req) {
  const raw = req?.headers?.['content-type'];
  if (typeof raw !== 'string' || raw.length > 128) return null;
  const type = raw.split(';', 1)[0].trim().toLowerCase();
  return ALLOWED_TYPES.has(type) ? type : null;
}

function extensionForType(type) {
  switch (type) {
    case 'audio/ogg': return 'ogg';
    case 'audio/mp4': return 'mp4';
    case 'audio/wav': return 'wav';
    case 'audio/mpeg': return 'mp3';
    case 'audio/webm':
    default: return 'webm';
  }
}

function upstreamFailureCode(status) {
  if (status === 401 || status === 403) return 'transcription_auth';
  if (status === 400) return 'transcription_bad_audio';
  if (status === 429) return 'transcription_rate_limited';
  return 'transcription_unavailable';
}

export async function readBoundedBody(req, maximum = MAX_AUDIO_BYTES) {
  if (!req || typeof req.on !== 'function' || !Number.isSafeInteger(maximum)) return null;
  const chunks = [];
  let size = 0;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    req.on('data', (chunk) => {
      if (settled || !Buffer.isBuffer(chunk)) return finish(null);
      size += chunk.length;
      if (size > maximum) return finish('too_large');
      chunks.push(chunk);
    });
    req.on('end', () => finish(settled ? null : Buffer.concat(chunks)));
    req.on('error', () => finish(null));
    req.on('aborted', () => finish(null));
  });
}

// STRIP, DO NOT DISCARD. This used to answer null -- "no speech" -- for a
// transcript that merely CONTAINED something unwanted: one stray angle bracket,
// one zero-width character, and a correctly heard sentence was thrown away
// whole and reported to the user as an unheard microphone. A transcript is
// somebody's speech, not markup: remove what must not survive and keep the
// words. Only genuinely empty (or absurdly long) output is refused, and the
// output still satisfies the client's own `sanitizeText(t) === t` contract.
//
// `reason` names WHY a refusal happened, so "the model returned nothing" stays
// distinguishable from "we deleted what it returned" without guessing.
function normalizeTranscript(value) {
  if (typeof value !== 'string') return { text: null, reason: 'not_a_string' };
  const raw = value.replace(/\r\n?/g, '\n').normalize('NFC');
  if (raw.trim().length === 0) return { text: null, reason: 'empty' };
  const stripped = raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/javascript\s*:/giu, ' ')
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, (character) => (character === '\t' || character === '\n' ? character : ''))
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  if (stripped.length === 0) return { text: null, reason: 'empty_after_sanitizing' };
  if (stripped.length > MAX_TRANSCRIPT_CHARS) return { text: null, reason: 'too_long' };
  return { text: stripped, reason: stripped === raw.trim() ? 'clean' : 'sanitized' };
}

// A refused transcript leaves a durable trace, because the two places it was
// visible are both unreachable from where it gets debugged: the Vercel function
// log needs a Vercel session, and the browser console needs the person who
// spoke to copy it out by hand. sync_log is already the repo's general-purpose
// run record and is readable over PostgREST. Shape ONLY -- how many bytes, what
// the model returned a value of, how long it was, and which refusal fired.
// Never the words: the reason code is what distinguishes the failures, so
// storing somebody's speech in a business table would buy nothing.
export async function recordRefusal(details, request = supabaseRequest) {
  try {
    await request('sync_log', {
      method: 'POST',
      body: JSON.stringify({ source: 'reina-transcribe', status: 'no_transcript', details }),
    });
  } catch {
    /* best effort: a log write must never change what the caller is told */
  }
}

function primaryModel() {
  return process.env.REINA_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe';
}

// A second opinion, not a retry. gpt-4o-mini-transcribe answers HTTP 200 with
// an empty string for audio whisper-1 will happily transcribe -- it is the
// stricter of the two about noisy or distant recordings. Seven recordings in
// one evening, peaks from 1 to 128 across four microphones, every one coming
// back empty on a 200 is exactly that signature, so an empty result is worth
// one more ask of a model that judges differently before the user is told
// nothing was heard.
function fallbackModel() {
  return process.env.REINA_TRANSCRIPTION_FALLBACK_MODEL || 'whisper-1';
}

async function askModel({ bytes, type, apiKey, fetchImpl, model }) {
  let form;
  try {
    form = new FormData();
    form.append('model', model);
    // Reina's HiveLogic voice experience is English-first. Supplying the
    // ISO-639-1 language prevents short American-English phrases from being
    // auto-detected and decoded as an unrelated language.
    form.append('language', 'en');
    form.append('response_format', 'json');
    form.append('file', new Blob([bytes], { type }), `reina-voice.${extensionForType(type)}`);
  } catch {
    return { ok: false, code: 'unavailable' };
  }
  let upstream;
  try {
    upstream = await fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form,
    });
  } catch {
    console.error('[reina-transcribe] upstream transport transcription_unavailable');
    return { ok: false, code: 'transcription_unavailable' };
  }
  if (!upstream || upstream.ok !== true) {
    const code = upstreamFailureCode(upstream?.status);
    console.error('[reina-transcribe] upstream status', Number.isSafeInteger(upstream?.status) ? upstream.status : 0, code);
    return { ok: false, code };
  }
  let payload;
  try { payload = await upstream.json(); } catch { return { ok: false, code: 'transcription_unavailable' }; }
  const normalized = normalizeTranscript(payload?.text);
  if (normalized.text) return { ok: true, transcript: normalized.text };
  return { ok: false, code: 'no_speech', rawText: payload?.text, reason: normalized.reason };
}

export async function transcribeAudio({ bytes, type, apiKey, fetchImpl = fetch }) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_AUDIO_BYTES
    || !ALLOWED_TYPES.has(type) || typeof apiKey !== 'string' || apiKey.length < 20
    || typeof fetchImpl !== 'function') return { ok: false, code: 'unavailable' };

  const first = primaryModel();
  let attempt = await askModel({ bytes, type, apiKey, fetchImpl, model: first });
  if (attempt.ok) return { ok: true, transcript: attempt.transcript };
  // Only an EMPTY answer earns a second opinion. An auth failure, a rate
  // limit, or a rejected file means asking again changes nothing.
  let usedModel = first;
  let secondCode = null;
  const second = fallbackModel();
  if (attempt.code === 'no_speech' && second && second !== first) {
    const retry = await askModel({ bytes, type, apiKey, fetchImpl, model: second });
    usedModel = second;
    if (retry.ok) {
      console.warn('[reina-transcribe] fallback model produced a transcript the primary did not', { primary: first, fallback: second });
      return { ok: true, transcript: retry.transcript, model: second };
    }
    secondCode = retry.code;
    if (retry.code !== 'no_speech') return { ok: false, code: retry.code };
    attempt = retry;
  }
  if (attempt.code !== 'no_speech') return { ok: false, code: attempt.code };
  const payload = { text: attempt.rawText };
  const normalized = { reason: attempt.reason };
  // WHY THIS IS RETURNED, NOT JUST LOGGED. #310 added this record so we could
  // tell "the microphone heard nothing" apart from "OpenAI answered with
  // something we refused". It lands in the Vercel function log -- which the
  // person watching a browser console during a failing call cannot see, and
  // which an agent without Vercel access cannot read either. So the same
  // bounded record goes back to the caller who produced the audio. It is that
  // caller's own speech, capped, and only ever returned to their authenticated
  // request; it says which of the two failures happened without another
  // round-trip through someone else's log viewer.
  const rawText = payload?.text;
  const diagnostic = {
    audioBytes: bytes.length,
    audioType: type,
    rawTextType: typeof rawText,
    rawTextLength: typeof rawText === 'string' ? rawText.length : null,
    rawTextSample: typeof rawText === 'string' ? rawText.slice(0, 80) : null,
    reason: normalized.reason,
  };
  console.error('[reina-transcribe] no usable transcript', {
    ...diagnostic,
    rawTextSample: typeof rawText === 'string' ? rawText.slice(0, 80) : rawText,
  });
  await recordRefusal({
    audioBytes: diagnostic.audioBytes,
    audioType: diagnostic.audioType,
    rawTextType: diagnostic.rawTextType,
    rawTextLength: diagnostic.rawTextLength,
    reason: diagnostic.reason,
    model: usedModel,
    // Both models were asked and both heard nothing. That is a far stronger
    // statement about the recording than one model's silence, and the row
    // should say which it is.
    secondOpinion: secondCode === 'no_speech' ? 'also_empty' : null,
  });
  return { ok: false, code: 'no_speech', diagnostic };
}

export default async function handler(req, res) {
  secure(res);
  if (req.method !== 'POST') return response(res, 405, 'method_not_allowed');
  if (process.env.REINA_VOICE_TRANSCRIPTION_ENABLED !== 'true') return response(res, 503, 'unavailable');
  const type = contentType(req);
  if (!type) return response(res, 415, 'unsupported_audio');
  // 2026-08-15: every auth failure used to report 'auth_expired', which reads
  // as "your session timed out" even when the real cause is that this
  // deployment has no Supabase credentials to verify anyone with. That made
  // preview deployments actively misleading to test against -- and testing
  // this endpoint on a preview URL is the documented way to tell a missing
  // OpenAI Audio scope apart from an auth problem. Keep 'auth_expired' for a
  // caller who really is signed out; name the deployment's own problem
  // separately. Fail-closed either way.
  const auth = await verifyRequestUser(req);
  if (!auth.ok) {
    if (auth.reason === 'auth-unconfigured') return response(res, 503, 'auth_unconfigured');
    if (auth.reason === 'verify-failed') return response(res, 503, 'auth_verify_failed');
    return response(res, 401, 'auth_expired');
  }
  const body = await readBoundedBody(req);
  if (body === 'too_large') return response(res, 413, 'audio_too_large');
  if (!Buffer.isBuffer(body) || body.length === 0) return response(res, 400, 'invalid_audio');
  const result = await transcribeAudio({ bytes: body, type, apiKey: process.env.OPENAI_API_KEY });
  if (!result.ok) {
    const status = result.code === 'no_speech' ? 422
      : result.code === 'transcription_auth' ? 502
        : result.code === 'transcription_bad_audio' ? 502
          : result.code === 'transcription_rate_limited' ? 503 : 503;
    return response(res, status, result.code, result.diagnostic ? { diagnostic: result.diagnostic } : {});
  }
  return res.status(200).json({ ok: true, transcript: result.transcript });
}
