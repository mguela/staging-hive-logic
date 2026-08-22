// server/bookkeeping/src/qbo-write-client.js
//
// The live QuickBooks Online WRITE pathway -- ported verbatim from the
// reference's src/qbo-client.js (it's already generic/pure, no reference-
// specific paths to adapt). This is deliberately separate from
// api/qbo/index.js, this app's existing READ-only QBO integration (cash,
// AR/AP, P&L) that Reina's chat already uses -- that module has no write
// capability and this one adds none to it; they are two independent
// integrations against the same QuickBooks company.
//
// Off by default, same as the reference: createQboWriteClient() only
// becomes usable when the caller passes enabled:true AND a real url --
// api/bookkeeping/controls/qbo-sync.js is the one and only caller, and it
// only sets enabled:true when process.env.HIVELOGIC_QBO_WRITE_ENABLED is
// literally the string "true". Nothing in this file reads an environment
// variable itself -- it takes its configuration as plain arguments, so it
// stays trivially testable and can never accidentally activate itself.
//
// Every write is idempotent: qboRequestId() derives a stable, deterministic
// id from the caller's own idempotencyKey (never a fresh random value), sent
// both as a query param and a header, so retrying the exact same outbox item
// (server/bookkeeping/src/controls.js's retryQboSync()) can never create a
// second QuickBooks record for one HiveLogic entity.

import { createHash } from 'node:crypto';

export function qboRequestId(idempotencyKey) {
  return createHash('sha256').update(String(idempotencyKey)).digest('hex').slice(0, 32);
}

function parseResult(body) {
  const qboId = body?.qboId || body?.Id || body?.Purchase?.Id || body?.purchase?.Id || body?.Bill?.Id || body?.bill?.Id || body?.result?.Id;
  return qboId ? String(qboId) : null;
}

export function createQboWriteClient({ enabled = false, url = '', token = '', timeoutMs = 20_000, fetchImpl = fetch } = {}) {
  return {
    enabled: enabled && Boolean(url),
    async send(item) {
      if (!this.enabled) return { ok: false, retryable: false, skipped: true, error: 'QBO writes are disabled.' };
      const requestId = qboRequestId(item.idempotencyKey);
      const target = new URL(url);
      target.searchParams.set('requestid', requestId);
      try {
        const response = await fetchImpl(target, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            'x-idempotency-key': item.idempotencyKey,
            'x-qbo-request-id': requestId,
            ...(token ? { authorization: `Bearer ${token}` } : {})
          },
          body: JSON.stringify({ companyId: item.companyId, entityType: item.entityType, entityId: item.entityId, operation: item.operation, idempotencyKey: item.idempotencyKey, requestId, payload: item.payload }),
          signal: AbortSignal.timeout(timeoutMs)
        });
        let body = {};
        try { body = await response.json(); } catch { body = {}; }
        if (!response.ok) {
          return {
            ok: false,
            retryable: response.status === 408 || response.status === 409 || response.status === 425 || response.status === 429 || response.status >= 500,
            error: body.error || body.Fault?.Error?.[0]?.Message || `QBO write endpoint returned ${response.status}.`,
            status: response.status,
            requestId
          };
        }
        const qboId = parseResult(body);
        if (!qboId) return { ok: false, retryable: false, error: 'QBO write response did not include the created record ID.', requestId };
        return { ok: true, qboId, requestId, response: body };
      } catch (error) {
        return { ok: false, retryable: true, error: error.name === 'TimeoutError' ? 'QBO write timed out.' : error.message, requestId };
      }
    }
  };
}
