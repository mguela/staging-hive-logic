// api/reina-voice-diagnostic.js
//
// WHERE A VOICE FAILURE GOES TO BE READ.
//
// Most of what breaks Reina's voice never reaches a server at all: a microphone
// that will not open, a device that disappeared out from under a stored
// deviceId, a recording that captured nothing, a transcription request that was
// rejected before it left the browser. Every one of those is visible in exactly
// one place -- the browser console of whoever was speaking -- so diagnosing it
// has meant asking that person to open DevTools and copy lines out by hand,
// once per attempt, for as many attempts as it takes.
//
// The browser now posts the SHAPE of each failure here and it lands in sync_log
// next to the server-side refusals, readable over PostgREST. That is the whole
// purpose: turn "tell me what your console says" into a query.
//
// WHAT IS ACCEPTED. Scalars only, each rebuilt field by field against a fixed
// whitelist -- never the transcript, never audio, never free text. A caller who
// sends anything else gets the unknown fields dropped, not an error, because a
// diagnostic that fails the thing it is diagnosing would be worse than useless.

import { verifyRequestUser } from './_lib/auth.js';
import { supabaseRequest } from './_lib/jobber.js';

const MAX_BODY_BYTES = 4 * 1024;
const STAGES = new Set(['recognition', 'transcription', 'turn', 'startup']);
const CODE_RE = /^[a-z0-9_-]{1,60}$/i;
const LABEL_MAX = 120;

function secure(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
}

export async function readBoundedJson(req, maximum = MAX_BODY_BYTES) {
  if (!req || typeof req.on !== 'function') return null;
  const chunks = [];
  let size = 0;
  const raw = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    req.on('data', (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buffer.length;
      if (size > maximum) return finish(null);
      chunks.push(buffer);
    });
    req.on('end', () => finish(settled ? null : Buffer.concat(chunks)));
    req.on('error', () => finish(null));
    req.on('aborted', () => finish(null));
  });
  if (!Buffer.isBuffer(raw) || raw.length === 0) return null;
  try { return JSON.parse(raw.toString('utf8')); } catch { return null; }
}

function boundedCount(value, ceiling) {
  return Number.isSafeInteger(value) && value >= 0 && value <= ceiling ? value : null;
}

// rms and crest are ratios, not counts: they carry one decimal place, and
// boundedCount rejects anything that is not a safe integer. Without this they
// were dropped twice over -- once for being absent from the whitelist, and
// again for not being whole numbers.
function boundedDecimal(value, ceiling) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > ceiling) return null;
  return Math.round(value * 10) / 10;
}

function boundedLabel(value, maximum) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '').replace(/<[^>]*>/g, '').trim();
  return text.length > 0 && text.length <= maximum ? text : null;
}

// Rebuild the record from a fixed whitelist. Anything absent stays absent, so a
// row never carries a field the browser did not actually measure.
export function boundedRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const stage = typeof value.stage === 'string' && STAGES.has(value.stage) ? value.stage : null;
  const code = typeof value.code === 'string' && CODE_RE.test(value.code) ? value.code : null;
  if (!stage || !code) return null;
  const record = { stage, code };
  const scalars = [
    ['peak', 255], ['activityThreshold', 255], ['msSinceStart', 900_000],
    ['audioBytes', 64 * 1024 * 1024], ['speechSeen', 1], ['attempt', 10_000],
    // How many 512-sample windows came back railed. Added with the clipping
    // detector and missed here, so every row it produced was written without
    // the number the detector exists to report.
    ['clippedPolls', 100_000],
  ];
  for (const [key, ceiling] of scalars) {
    const bounded = boundedCount(value[key], ceiling);
    if (bounded !== null) record[key] = bounded;
  }
  // The shape of the sound rather than its size: rms is its average level and
  // crest is peak/rms, which is what separates speech from an amplified room.
  // Same omission as clippedPolls -- measured in the browser, discarded here.
  for (const [key, ceiling] of [['rms', 255], ['crest', 1_000]]) {
    const bounded = boundedDecimal(value[key], ceiling);
    if (bounded !== null) record[key] = bounded;
  }
  for (const key of ['mimeType', 'deviceLabel', 'pageBuild', 'replyCode']) {
    const label = boundedLabel(value[key], LABEL_MAX);
    if (label !== null) record[key] = label;
  }
  return record;
}

export default async function handler(req, res, deps = {}) {
  const request = deps.supabaseRequest || supabaseRequest;
  const verify = deps.verifyRequestUser || verifyRequestUser;
  secure(res);
  if (req.method !== 'POST') return res.status(405).json({ ok: false, code: 'method_not_allowed' });
  const auth = await verify(req);
  if (!auth.ok) return res.status(401).json({ ok: false, code: 'auth_expired' });
  const record = boundedRecord(await readBoundedJson(req));
  if (!record) return res.status(400).json({ ok: false, code: 'invalid_record' });
  try {
    await request('sync_log', {
      method: 'POST',
      body: JSON.stringify({ source: 'reina-voice-client', status: record.code, details: record }),
    });
  } catch {
    // Reporting a failure must never become a second failure the caller has to
    // handle. The browser is told it landed either way; the row is best effort.
  }
  return res.status(202).json({ ok: true });
}
