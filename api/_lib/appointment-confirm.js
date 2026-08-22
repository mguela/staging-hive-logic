// api/_lib/appointment-confirm.js
// The decision logic behind the customer-facing confirm/decline link.
//
// This is the only appointment path a person with no account can reach, so the
// rules are deliberately narrow and all of them live here, dependency-injected,
// so every refusal is testable without a database.
//
// TOKEN MODEL (same discipline as the sub portal, api/_lib/portal-auth.js):
// the raw token exists only in the emailed link. The database stores its
// SHA-256 hash, and lookup is by hash of whatever the visitor presents. A
// dumped hl_appointments table therefore cannot be used to confirm or decline
// anybody's appointment.
//
// WHAT THE LINK CAN DO is the other half of the safety story. It sets one
// column to one of two values. It cannot move an appointment, change its time,
// see other appointments, or read anything about the customer beyond the visit
// the token already refers to -- so the worst case for a leaked link is that
// someone marks one visit confirmed or declined, which the office sees on the
// board and can undo.

import { hashToken } from './portal-auth.js';

export const CONFIRM_STATES = ['unconfirmed', 'confirmed', 'declined'];

/** A token that could not possibly be one of ours -- rejected before any lookup. */
export function isWellFormedToken(raw) {
  return typeof raw === 'string' && /^[a-f0-9]{64}$/.test(raw);
}

/**
 * Why this token cannot act on this appointment, or null when it may.
 *
 * Deliberately returns the SAME message for "no such token" and "expired": a
 * public endpoint that distinguishes them lets an attacker confirm which tokens
 * ever existed.
 */
export function refuseReason(appt, now) {
  const GENERIC = 'That link is no longer valid. Please contact the office and we will send a new one.';
  if (!appt) return GENERIC;
  if (appt.canceled === true) return 'That appointment has been cancelled. Please contact the office if this is unexpected.';
  // A missing expiry is treated as invalid, not as "never expires". Both
  // columns are always written together, so the only way to reach this is a
  // half-written row -- and the safe reading of a half-written row is that its
  // link does not work, never that it works forever.
  if (!appt.confirm_expires_at) return GENERIC;
  if (new Date(appt.confirm_expires_at).getTime() < now) return GENERIC;
  return null;
}

/**
 * Apply a decision. Returns the patch to write, or null when nothing should
 * change.
 *
 * Idempotent on purpose: mail clients prefetch links, people double-click, and
 * a customer may click "confirm" twice. Re-confirming an already-confirmed
 * appointment is a no-op that still reports success, rather than an error the
 * customer cannot act on.
 *
 * CHANGING one's mind IS allowed -- confirmed -> declined -- because a customer
 * who confirmed on Monday and cannot make it on Tuesday has no other route, and
 * the office would far rather know.
 */
export function decisionPatch(appt, decision, now) {
  if (decision !== 'confirmed' && decision !== 'declined') return null;
  if (appt.confirm_state === decision) return null;
  return {
    confirm_state: decision,
    confirmed_at: new Date(now).toISOString(),
  };
}

/**
 * Resolve a presented token to its appointment.
 * The caller supplies `loadByHash` so this stays offline-testable.
 */
export async function resolveToken(rawToken, { loadByHash }) {
  if (!isWellFormedToken(rawToken)) return null;
  return (await loadByHash(hashToken(rawToken))) || null;
}
