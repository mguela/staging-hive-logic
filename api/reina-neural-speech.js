import { requireUser } from './_lib/auth.js';

const ALLOWED_VOICES = new Set(['marin', 'coral', 'nova', 'shimmer', 'sage']);
const MAX_TEXT = 6_000;

function secure(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
}

function enabled(env) {
  if (env.VERCEL_ENV === 'production') {
    return env.REINA_PILOT_ENABLED === 'true'
      && env.REINA_PILOT_PRODUCTION_ENABLED === 'true'
      && env.REINA_VOICE_NEURAL_ENABLED === 'true';
  }
  if (env.VERCEL_ENV !== 'preview' && env.NODE_ENV !== 'test') return false;
  return env.REINA_VOICE_NEURAL_ENABLED === 'true' || env.REINA_PREVIEW_ENABLED === 'true';
}

function safeBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.some((key) => key !== 'text' && key !== 'voice')) return null;
  const text = typeof value.text === 'string' ? value.text.trim() : '';
  const voice = typeof value.voice === 'string' ? value.voice : 'marin';
  if (!text || text.length > MAX_TEXT
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]|[\p{Cf}\p{Cs}]/u.test(text)
    || /<[^>]*>|javascript\s*:/iu.test(text) || !ALLOWED_VOICES.has(voice)) return null;
  return { text, voice };
}

export async function createNeuralSpeech({ text, voice, apiKey, fetchImpl = fetch }) {
  if (typeof apiKey !== 'string' || apiKey.length < 20 || typeof fetchImpl !== 'function'
    || typeof text !== 'string' || !text || text.length > MAX_TEXT || !ALLOWED_VOICES.has(voice)) {
    return { ok: false, code: 'unavailable' };
  }
  let upstream;
  const model = process.env.REINA_TTS_MODEL || 'gpt-4o-mini-tts';
  try {
    upstream = await fetchImpl('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // Use the supported model alias by default. Pinning the deprecated
        // snapshot caused otherwise-valid production speech turns to fail
        // upstream with a 503 at HiveLogic's fail-closed boundary.
        model,
        voice,
        input: text,
        instructions: 'Speak like a highly capable, warm American executive assistant. Sound present and conversational, with natural phrasing, subtle emphasis, short pauses, and contractions. Keep a confident, slightly brisk pace. Never sound robotic, theatrical, breathy, sing-song, or like an announcer.',
        response_format: 'mp3',
      }),
    });
  } catch {
    return { ok: false, code: 'neural_voice_unavailable' };
  }
  if (!upstream || upstream.ok !== true || typeof upstream.arrayBuffer !== 'function') {
    // Log only operational metadata. Never log the requested speech text,
    // authorization value, upstream body, or API key.
    console.warn('reina_neural_speech_upstream_failed', {
      status: Number.isInteger(upstream?.status) ? upstream.status : null,
      model,
    });
    return { ok: false, code: 'neural_voice_unavailable' };
  }
  let bytes;
  try { bytes = Buffer.from(await upstream.arrayBuffer()); } catch { return { ok: false, code: 'neural_voice_unavailable' }; }
  if (bytes.length < 100 || bytes.length > 12 * 1024 * 1024) return { ok: false, code: 'neural_voice_unavailable' };
  return { ok: true, bytes };
}

export default async function handler(req, res) {
  secure(res);
  if (req.method !== 'POST') return res.status(405).json({ ok: false, code: 'method_not_allowed' });
  if (!enabled(process.env)) return res.status(503).json({ ok: false, code: 'unavailable' });
  const user = await requireUser(req);
  if (!user) return res.status(401).json({ ok: false, code: 'auth_expired' });
  const body = safeBody(req.body);
  if (!body) return res.status(400).json({ ok: false, code: 'invalid_request' });
  const result = await createNeuralSpeech({ ...body, apiKey: process.env.OPENAI_API_KEY });
  if (!result.ok) return res.status(503).json({ ok: false, code: result.code });
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Length', String(result.bytes.length));
  return res.status(200).send(result.bytes);
}
