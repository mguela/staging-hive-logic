// Failure-only machine intake for Vercel and Supabase log drains, feeding the
// same Dev To-Do exception queue as status-hub-ingest.js (GitHub CI). Unlike
// that route -- one finding per request, already shaped by our own workflow
// -- a log drain delivers a BATCH of raw log lines on its own schedule, most
// of which are ordinary non-error traffic. This route's job is filtering that
// batch down to the runtime errors worth a Dev To-Do entry, then normalizing
// each into the same finding shape everything else in this store uses.
//
// The drain's target URL carries which provider it is (?src=vercel or
// ?src=supabase) instead of sniffing payload shape, because a shape guess
// that happens to overlap between two providers would silently misfile
// findings under the wrong source.
//
// HONEST CAVEAT for whoever configures the Supabase side: Vercel's log drain
// payload (array-of-objects or NDJSON, with a `level` field) is documented
// and this parses it directly. Supabase's log drain payload was normalized
// here from public documentation, not from a real captured delivery -- if
// Supabase's actual output doesn't match once you turn it on, findings will
// either come back empty or with a wrong title/detail, not silently corrupt
// anything else. Check a real delivery once it's live and adjust
// parseSupabaseEntries() if the field names differ.
import crypto from 'node:crypto';
import { observeFindings } from './_lib/status-hub.js';

const MAX_ENTRIES_PER_REQUEST = 200;

function sameSecret(candidate, expected) {
  if (!candidate || !expected) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function rawBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);
  return '';
}

// Vercel log drains deliver either one JSON array per request, or one JSON
// object per line (NDJSON) -- both are real, documented delivery formats an
// operator can choose between when creating the drain.
export function parseBatch(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return [parsed];
  } catch { /* fall through to NDJSON */ }
  return trimmed.split('\n').map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

// Strips the parts of a log message that change on every single occurrence
// of the SAME underlying error (request ids, uuids, raw numbers, ISO
// timestamps) so repeats fingerprint-match and refresh one Dev To-Do row
// instead of spamming a fresh one on every drain delivery.
export function normalizeMessage(value) {
  return String(value || '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b[0-9a-f]{16,64}\b/gi, '<hex>')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<timestamp>')
    // No \b at the trailing edge: a digit run followed by a unit letter
    // ("4213ms", "891ms") has no word-boundary between digit and letter (both
    // are \w), so a boundary-anchored version would leave the volatile number
    // in place and defeat the whole point of normalizing it.
    .replace(/\d+/g, '<n>')
    .trim()
    .slice(0, 300);
}

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex').slice(0, 40); }

export function parseVercelEntries(entries) {
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || entry.level !== 'error') return [];
    const location = String(entry.entrypoint || entry.path || entry.host || 'unknown').slice(0, 160);
    const message = String(entry.message || '').slice(0, 2000);
    const identity = `${location}|${normalizeMessage(message)}`;
    return [{
      source: 'vercel_runtime',
      fingerprint: sha(identity),
      title: `Vercel runtime error — ${location}`,
      detail: message || 'No message on the log entry.',
      severity: 'high',
      evidence: {
        kind: 'vercel_log_drain', deploymentId: String(entry.deploymentId || '').slice(0, 80),
        requestId: String(entry.requestId || '').slice(0, 80), statusCode: Number.isInteger(entry.statusCode) ? entry.statusCode : null,
        entrySource: String(entry.source || '').slice(0, 40), timestamp: entry.timestamp || null,
      },
    }];
  });
}

export function parseSupabaseEntries(entries) {
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const metadata = (entry.metadata && typeof entry.metadata === 'object') ? entry.metadata : {};
    const level = String(metadata.level || metadata.severity || entry.level || '').toLowerCase();
    const message = String(entry.event_message || entry.message || '').slice(0, 2000);
    const looksLikeError = level === 'error' || level === 'fatal' || /\b(error|fatal|panic)\b/i.test(message.slice(0, 200));
    if (!looksLikeError) return [];
    const component = String(metadata.component || metadata.host || entry.source || 'database').slice(0, 160);
    const identity = `${component}|${normalizeMessage(message)}`;
    return [{
      source: 'supabase_logs',
      fingerprint: sha(identity),
      title: `Supabase log error — ${component}`,
      detail: message || 'No message on the log entry.',
      severity: 'high',
      evidence: { kind: 'supabase_log_drain', component, timestamp: entry.timestamp || null },
    }];
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const expected = process.env.STATUS_HUB_LOG_DRAIN_SECRET;
  const bearer = String(req.headers && req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!expected) return res.status(503).json({ ok: false, error: 'Log drain intake is not configured.' });
  if (!sameSecret(bearer, expected)) return res.status(401).json({ ok: false, error: 'Unauthorized.' });
  const src = String(req.query && req.query.src || '');
  if (src !== 'vercel' && src !== 'supabase') return res.status(400).json({ ok: false, error: 'The drain URL must include ?src=vercel or ?src=supabase.' });
  const entries = parseBatch(rawBody(req)).slice(0, MAX_ENTRIES_PER_REQUEST);
  const candidates = src === 'vercel' ? parseVercelEntries(entries) : parseSupabaseEntries(entries);
  const deduped = [...new Map(candidates.map((finding) => [`${finding.source}|${finding.fingerprint}`, finding])).values()];
  try {
    const findings = await observeFindings(deduped);
    return res.status(200).json({ ok: true, received: entries.length, errorsFound: candidates.length, findingsObserved: findings.length });
  } catch (error) {
    return res.status(502).json({ ok: false, error: String(error.message || error).slice(0, 300) });
  }
}
