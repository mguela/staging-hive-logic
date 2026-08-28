/* api/_lib/reina/action-approvals.js
 *
 * The server side of "Reina asked, a person said yes".
 *
 * Every function here is a thin, honest wrapper over one SQL function. The
 * rules -- once only, owner only, before expiry, never without an approval --
 * are enforced in the database, not here, because this file is not the only
 * thing that could ever call that database and a rule that lives in one caller
 * is not a rule. See supabase/migrations/20260823230000_reina_action_approvals.sql
 * and test/sql/reina-action-approvals.sh.
 *
 * What this file DOES own: refusing to build a proposal that is malformed, and
 * computing the digest of what is actually about to happen.
 */
import { createHash, randomBytes } from 'node:crypto';

const RPC_TIMEOUT_MS = 8_000;
// A yes has to be recent. Long enough to read a draft properly, short enough
// that an approval left open in a tab is not still spendable after lunch.
export const APPROVAL_TTL_MS = 5 * 60 * 1000;

export const ACTION_KINDS = Object.freeze({
  SEND_EMAIL: 'send_email',
  SEND_SMS: 'send_sms',
});

// Which actions a person must personally approve. Chris named the categories:
// financial, schedule, comms, and anything otherwise sensitive. The default for
// an unrecognised action is NOT 'routine' -- see requiresApproval below.
export const SENSITIVITY = Object.freeze({
  [ACTION_KINDS.SEND_EMAIL]: 'comms',
  [ACTION_KINDS.SEND_SMS]: 'comms',
});

const APPROVED_SENSITIVITIES = Object.freeze(['comms', 'schedule', 'financial']);

// An action nobody has classified is treated as sensitive. Getting this
// backwards -- defaulting to 'routine' -- would mean that the way to make a new
// action skip the approval popup is to forget to classify it.
export function requiresApproval(actionKind) {
  const sensitivity = Object.prototype.hasOwnProperty.call(SENSITIVITY, actionKind)
    ? SENSITIVITY[actionKind]
    : 'financial';
  return APPROVED_SENSITIVITIES.includes(sensitivity);
}

export function sensitivityOf(actionKind) {
  return Object.prototype.hasOwnProperty.call(SENSITIVITY, actionKind)
    ? SENSITIVITY[actionKind]
    : 'financial';
}

export function newApprovalId() {
  return `rap.${randomBytes(16).toString('hex')}`;
}

// The digest covers exactly what will be executed, in a fixed order, with the
// lengths included so that no two different drafts can share a digest by moving
// a delimiter around. It is recorded at approval time and is the answer to
// "what actually went out", which the proposal alone cannot answer once the
// draft has been edited.
export function payloadDigest(actionKind, payload) {
  const parts = [actionKind];
  if (actionKind === ACTION_KINDS.SEND_EMAIL) {
    parts.push(
      (payload.to || []).join(','),
      (payload.cc || []).join(','),
      (payload.bcc || []).join(','),
      payload.subject || '',
      payload.body || '',
      payload.from || '',
    );
  } else if (actionKind === ACTION_KINDS.SEND_SMS) {
    parts.push(payload.to || '', payload.body || '');
  } else {
    parts.push(JSON.stringify(payload));
  }
  const canonical = parts.map((part) => `${part.length}:${part}`).join('|');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>".]+\.[^\s@,;<>"]{2,}$/u;

export function normalizeRecipients(value, limit = 25) {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return null;
    const address = entry.trim().toLowerCase();
    if (!address) continue;
    if (!EMAIL_RE.test(address) || address.length > 254) return null;
    if (seen.has(address)) continue;
    seen.add(address);
    out.push(address);
    if (out.length > limit) return null;
  }
  return out;
}

// Bounds exist so that a malformed or hostile draft cannot become an enormous
// send. They are not formatting preferences.
export const EMAIL_LIMITS = Object.freeze({
  subject: 300,
  body: 20_000,
  recipients: 25,
});

export function normalizeEmailPayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const to = normalizeRecipients(raw.to, EMAIL_LIMITS.recipients);
  const cc = normalizeRecipients(raw.cc === undefined ? [] : raw.cc, EMAIL_LIMITS.recipients);
  const bcc = normalizeRecipients(raw.bcc === undefined ? [] : raw.bcc, EMAIL_LIMITS.recipients);
  if (!to || !cc || !bcc || to.length === 0) return null;
  const subject = typeof raw.subject === 'string' ? raw.subject.trim() : '';
  const body = typeof raw.body === 'string' ? raw.body : '';
  if (!subject || subject.length > EMAIL_LIMITS.subject) return null;
  if (!body.trim() || body.length > EMAIL_LIMITS.body) return null;
  // A subject or body carrying control characters is not something a person
  // typed, and header-injection lives in exactly that gap.
  if (/[\r\n]/u.test(subject) || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(subject + body)) return null;
  const from = typeof raw.from === 'string' ? raw.from.trim().toLowerCase() : '';
  if (from && !EMAIL_RE.test(from)) return null;
  return Object.freeze({ to, cc, bcc, subject, body, from });
}

// E.164: a leading '+', then 1-15 digits, first digit not zero.
const E164_RE = /^\+[1-9]\d{1,14}$/u;

export const SMS_LIMITS = Object.freeze({
  body: 1600, // ~10 concatenated Twilio segments -- well past a normal reply
});

// True if `s` contains a control character other than tab/newline/carriage
// return -- checked by character code rather than a regex literal so the
// bytes this guards against never have to appear, even as an escape
// sequence, in this file's own source.
function hasControlChars(s) {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

// Unlike email, an SMS proposal's `to` is never something the model is asked
// to invent -- the route resolves it from the real thread being replied to,
// before the draft is even requested. This only validates the shape of
// whatever the caller (the route itself, or a person editing the draft)
// hands back.
export function normalizeSmsPayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const to = typeof raw.to === 'string' ? raw.to.trim() : '';
  if (!E164_RE.test(to)) return null;
  const body = typeof raw.body === 'string' ? raw.body.trim() : '';
  if (!body || body.length > SMS_LIMITS.body) return null;
  // Control characters (other than the newlines a real text message can
  // contain) are not something a person typed or a draft model should emit.
  if (hasControlChars(body)) return null;
  return Object.freeze({ to, body });
}

function endpointFrom(env) {
  const url = typeof env.SUPABASE_URL === 'string' ? env.SUPABASE_URL.trim() : '';
  const key = typeof env.SUPABASE_SERVICE_KEY === 'string' ? env.SUPABASE_SERVICE_KEY.trim() : '';
  if (!url || !key || /\s/u.test(key)) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'https:') return null;
  return { baseUrl: parsed.href.replace(/\/+$/u, ''), serviceKey: key };
}

export function createActionApprovalStore({ env = process.env, fetchImpl = fetch, now = () => Date.now() } = {}) {
  const endpoint = endpointFrom(env);

  async function rpc(name, body) {
    if (!endpoint) return { status: 'unavailable' };
    const controller = new AbortController();
    const timer = setTimeout(() => { try { controller.abort(); } catch { /* bounded */ } }, RPC_TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${endpoint.baseUrl}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: {
          apikey: endpoint.serviceKey,
          Authorization: `Bearer ${endpoint.serviceKey}`,
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
        signal: controller.signal,
        body: JSON.stringify(body),
      });
      if (!response || response.ok !== true || typeof response.text !== 'function') {
        return { status: 'unavailable' };
      }
      const text = await response.text();
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || typeof parsed.status !== 'string') {
        return { status: 'unavailable' };
      }
      return parsed;
    } catch {
      return { status: 'unavailable' };
    } finally {
      clearTimeout(timer);
    }
  }

  // The per-call deadline the SQL functions require. Short: these are single
  // indexed statements, and a slow one should fail rather than hold a lock.
  function deadline() {
    return new Date(now() + 5_000).toISOString();
  }

  return Object.freeze({
    async issue({ ownerPrincipalId, conversationId, turnId, approvalId, actionKind, proposal }) {
      return rpc('reina_action_issue_approval', {
        p_owner_principal_id: ownerPrincipalId,
        p_conversation_id: conversationId,
        p_turn_id: turnId,
        p_approval_id: approvalId,
        p_action_kind: actionKind,
        p_sensitivity: sensitivityOf(actionKind),
        p_proposal: proposal,
        p_expires_at: new Date(now() + APPROVAL_TTL_MS).toISOString(),
        p_policy_reference: { operation: `reina.action.${actionKind}` },
        p_deadline_at: deadline(),
      });
    },

    // Spending the approval and doing the thing are deliberately separate calls
    // in that order: the approval is spent FIRST, so a send that crashes
    // half-way cannot be retried into a second send.
    async consume({ ownerPrincipalId, approvalId, actionKind, payload }) {
      return rpc('reina_action_consume_approval', {
        p_owner_principal_id: ownerPrincipalId,
        p_approval_id: approvalId,
        p_executed_digest: payloadDigest(actionKind, payload),
        p_policy_reference: { operation: `reina.action.${actionKind}` },
        p_deadline_at: deadline(),
      });
    },

    async recordOutcome({ ownerPrincipalId, approvalId, outcome }) {
      return rpc('reina_action_record_outcome', {
        p_owner_principal_id: ownerPrincipalId,
        p_approval_id: approvalId,
        p_outcome: outcome,
        p_deadline_at: deadline(),
      });
    },

    async reject({ ownerPrincipalId, approvalId }) {
      return rpc('reina_action_reject_approval', {
        p_owner_principal_id: ownerPrincipalId,
        p_approval_id: approvalId,
        p_deadline_at: deadline(),
      });
    },
  });
}
