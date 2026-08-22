// api/_lib/monitor.js
// Security-critical primitives for the HiveLogic Monitor stack, factored out
// of api/track1.js so they can be unit-tested in isolation (see
// test/monitor-security.test.mjs). Nothing here trusts client-declared types
// or client-supplied randomness.
import crypto from 'crypto';
import { supabaseRequest } from './jobber.js';

// Retention window for monitor captures (see sql/052_monitor_retention.sql).
export const MONITOR_RETENTION_DAYS = Number(process.env.MONITOR_RETENTION_DAYS) || 90;

// Screenshots are ~1080p JPEGs; 6MB is a generous per-image ceiling that still
// rejects anything trying to use the upload endpoint as bulk storage.
export const MAX_SCREENSHOT_BYTES = 6 * 1024 * 1024;

// SHA-256 hex hash of the agent bearer token. Both enrollment (store) and auth
// (lookup) run the presented token through this, so the plaintext token never
// touches the database. Matches the hashing style in _lib/agents/security.js.
export function hashAgentToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Long-lived agent bearer token: 256 bits of CSPRNG entropy, hex-encoded.
export function generateAgentToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Short-lived pairing code: 6 decimal digits from a CSPRNG (crypto.randomInt),
// zero-padded so the full 000000-999999 range (incl. leading zeros) is used.
// Never Math.random()/timestamps -- those are predictable and would let an
// attacker guess a pending code within its window.
export function generatePairingCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// Magic-byte sniff. Returns the real image mime from the first bytes, or null
// if the buffer is not a PNG or JPEG -- regardless of what content-type the
// client claimed.
export function sniffImageMime(buf) {
  if (!buf || buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return 'image/png';
  return null;
}

// Validate a client-uploaded screenshot body. Decodes base64, enforces the max
// size, and requires the DECODED CONTENTS to actually be PNG or JPEG. Returns
// { ok, status, error } on rejection or { ok:true, buffer, contentType, ext }.
export function validateScreenshotBase64(imageBase64) {
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return { ok: false, status: 400, error: 'imageBase64 is required.' };
  }
  let buf;
  try {
    buf = Buffer.from(imageBase64, 'base64');
  } catch (e) {
    return { ok: false, status: 400, error: 'imageBase64 is not valid base64.' };
  }
  if (!buf || buf.length === 0) {
    return { ok: false, status: 400, error: 'imageBase64 decoded to an empty body.' };
  }
  if (buf.length > MAX_SCREENSHOT_BYTES) {
    return { ok: false, status: 413, error: 'Screenshot too large (max 6MB).' };
  }
  const mime = sniffImageMime(buf);
  if (!mime) {
    return { ok: false, status: 400, error: 'Uploaded body is not a valid PNG or JPEG image.' };
  }
  return { ok: true, buffer: buf, contentType: mime, ext: mime === 'image/png' ? 'png' : 'jpg' };
}

// Authenticate a monitor agent from its Bearer token by HASH lookup. Returns
// the active agent row or null. `request` is injectable for tests; it defaults
// to supabaseRequest (which uses global fetch under the hood).
export async function requireMonitorAgent(req, request = supabaseRequest) {
  const authHeader = (req.headers && (req.headers['authorization'] || req.headers['Authorization'])) || '';
  const token = String(authHeader).replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const tokenHash = hashAgentToken(token);
  const agentRes = await request(
    `monitor_agents?agent_token_hash=eq.${encodeURIComponent(tokenHash)}&status=eq.active&limit=1`
  );
  if (!agentRes || !agentRes.ok) return null;
  const rows = await agentRes.json();
  return (rows && rows[0]) || null;
}

// Delete monitor Storage blobs + DB rows older than the retention window.
// Screenshots are handled here (blob-then-row) because Postgres cannot reach
// Storage; activity samples / pair attempts are pruned too. Injectable
// dependencies keep it unit-testable. Returns counts.
export async function pruneMonitorData({
  retentionDays = MONITOR_RETENTION_DAYS,
  request = supabaseRequest,
  storageDelete = defaultStorageDelete,
  now = new Date(),
} = {}) {
  const cutoff = new Date(now.getTime() - Math.max(retentionDays, 1) * 24 * 60 * 60 * 1000).toISOString();
  const result = { cutoff, screenshotsDeleted: 0, activitySamplesDeleted: 0, pairAttemptsDeleted: 0, sessionsDeleted: 0, storageErrors: 0 };

  // Screenshots: fetch old rows, delete each blob, then delete rows.
  const shotRes = await request(`monitor_screenshots?captured_at=lt.${encodeURIComponent(cutoff)}&select=id,storage_path&limit=1000`);
  const shots = shotRes && shotRes.ok ? await shotRes.json() : [];
  for (const s of shots || []) {
    try {
      if (s.storage_path) await storageDelete(s.storage_path);
    } catch (e) {
      result.storageErrors += 1;
      continue; // leave the row so a later run retries the blob delete
    }
    await request(`monitor_screenshots?id=eq.${s.id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    result.screenshotsDeleted += 1;
  }

  // Activity samples.
  const actRes = await request(`monitor_activity_samples?sampled_at=lt.${encodeURIComponent(cutoff)}`, {
    method: 'DELETE', headers: { Prefer: 'return=representation', 'Range-Unit': 'items' },
  });
  const actRows = actRes && actRes.ok ? await actRes.json() : [];
  result.activitySamplesDeleted = Array.isArray(actRows) ? actRows.length : 0;

  // Pairing attempt logs.
  const paRes = await request(`monitor_pair_attempts?attempted_at=lt.${encodeURIComponent(cutoff)}`, {
    method: 'DELETE', headers: { Prefer: 'return=representation', 'Range-Unit': 'items' },
  });
  const paRows = paRes && paRes.ok ? await paRes.json() : [];
  result.pairAttemptsDeleted = Array.isArray(paRows) ? paRows.length : 0;

  // Ended sessions older than the window (their screenshots/samples are gone by now).
  const sessRes = await request(`monitor_sessions?ended_at=lt.${encodeURIComponent(cutoff)}&ended_at=not.is.null`, {
    method: 'DELETE', headers: { Prefer: 'return=representation', 'Range-Unit': 'items' },
  });
  const sessRows = sessRes && sessRes.ok ? await sessRes.json() : [];
  result.sessionsDeleted = Array.isArray(sessRows) ? sessRows.length : 0;

  return result;
}

async function defaultStorageDelete(storagePath) {
  const res = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/monitor-screenshots/${storagePath}`, {
    method: 'DELETE',
    headers: { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`storage delete failed (${res.status})`);
  }
  return true;
}
