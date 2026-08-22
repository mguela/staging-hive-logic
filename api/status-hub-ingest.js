// Failure-only machine intake for the Dev To-Do exception queue.  This route
// intentionally cannot write successes or activity events.
import crypto from 'node:crypto';
import { observeFindings } from './_lib/status-hub.js';

function sameSecret(candidate, expected) {
  if (!candidate || !expected) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return {};
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const expected = process.env.STATUS_HUB_INGEST_SECRET;
  const bearer = String(req.headers && req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!expected) return res.status(503).json({ ok: false, error: 'Status intake is not configured.' });
  if (!sameSecret(bearer, expected)) return res.status(401).json({ ok: false, error: 'Unauthorized.' });
  const input = body(req);
  const source = String(input.source || '');
  const fingerprint = String(input.fingerprint || '');
  const title = String(input.title || '').trim().slice(0, 280);
  const detail = String(input.detail || '').trim().slice(0, 2000);
  if (source !== 'github_ci' || !/^[a-zA-Z0-9._:-]{8,180}$/.test(fingerprint) || title.length < 4) {
    return res.status(400).json({ ok: false, error: 'Invalid failure finding.' });
  }
  try {
    const [finding] = await observeFindings([{
      source, fingerprint, title, detail: detail || 'A production branch check failed.',
      severity: ['critical', 'high', 'medium', 'low'].includes(input.severity) ? input.severity : 'high',
      evidence: { kind: 'ci_failure', workflow: String(input.workflow || '').slice(0, 160), run_id: String(input.run_id || '').slice(0, 80) },
    }]);
    return res.status(200).json({ ok: true, finding });
  } catch (error) {
    return res.status(502).json({ ok: false, error: String(error.message || error).slice(0, 300) });
  }
}
