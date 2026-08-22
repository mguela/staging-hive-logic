// api/bookkeeping/_security.js
//
// Shared security layer for every Accounting Control API route: response
// hardening headers (ported from the approved reference's src/security.js
// applySecurityHeaders()) plus a per-route request rate limiter (ported from
// the same file's createRateLimiter()).
//
// Scoped deliberately to api/bookkeeping/* only -- this branch's remit is
// Accounting Control parity, not a whole-HiveLogic-app security change. The
// reference's proxy-header auth scheme (authenticateRequest/requireRole/
// runtimeConfiguration) is NOT ported here: this app already has its own,
// different, real authentication (getTrustedActor(), a verified Supabase
// session token) that every bookkeeping route already uses -- porting a
// second, parallel auth scheme on top of it would be redundant and could
// only introduce a second, WEAKER path in, not strengthen anything. See the
// reina/accounting-control-parity project doc, Phase 4 increment 1, for the
// original decision to flag (not silently build) this gap, and increment 5
// for this fix.
//
// Rate limiting caveat, disclosed rather than hidden: this app runs on
// Vercel serverless functions, so this in-memory Map is per-instance, not a
// global/shared limiter across every concurrent instance the platform may
// spin up. It is a real, working, best-effort limiter -- it will catch a
// single hot instance being hammered -- but it is not a hard guarantee the
// way a shared store (e.g. Redis) would be. Documented here so nobody later
// mistakes this for a stronger guarantee than it actually provides.

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_READ = 300;
const RATE_LIMIT_WRITE = 60;
const buckets = new Map();

function clientAddress(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (forwarded) return String(Array.isArray(forwarded) ? forwarded[0] : forwarded).split(',')[0].trim();
  return String(req.socket?.remoteAddress || 'unknown');
}

// Sets the same hardening headers on every bookkeeping API response,
// regardless of outcome (success, validation error, auth failure, etc).
// `res.setHeader` before the first `res.status()/.json()` call is safe on
// Vercel's Node runtime; every existing route already calls res.status()
// AFTER this runs since it's the very first line of each handler.
export function applySecurityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'same-origin');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
  if (process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production') {
    res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
}

// Returns { ok: true } or { ok: false, retryAfter } -- never throws, so a
// caller never needs a try/catch just to check the request rate.
export function checkRateLimit(req, actorId) {
  const now = Date.now();
  const write = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
  const limit = write ? RATE_LIMIT_WRITE : RATE_LIMIT_READ;
  const key = `${actorId || clientAddress(req)}:${write ? 'write' : 'read'}`;
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  if (buckets.size > 10_000) {
    for (const [bucketKey, value] of buckets) if (value.resetAt <= now) buckets.delete(bucketKey);
  }
  if (bucket.count > limit) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }
  return { ok: true, limit, remaining: Math.max(0, limit - bucket.count) };
}

// Convenience wrapper every route calls as its first line: applies headers
// unconditionally, then checks the rate limit keyed on IP (no actor is known
// yet this early -- most routes authenticate after this call). Writes a 429
// itself and returns false if the caller should stop; returns true to
// continue normally. This mirrors the "route completes what the shared
// helper leaves off" pattern used elsewhere in this branch: routes stay thin
// wrappers, the shared logic lives in one place.
export function guardBookkeepingRequest(req, res) {
  applySecurityHeaders(res);
  const result = checkRateLimit(req, null);
  if (!result.ok) {
    res.setHeader('retry-after', String(result.retryAfter));
    res.status(429).json({ ok: false, error: 'Too many requests. Try again shortly.' });
    return false;
  }
  return true;
}

// Exposed for tests only.
export function _resetRateLimiterForTests() {
  buckets.clear();
}
