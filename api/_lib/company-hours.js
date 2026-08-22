// api/_lib/company-hours.js
//
// Makes Company Setup's business hours mean something.
//
// The voice webhook decides whether a caller reaches the open-hours or the
// after-hours greeting from a `voice_schedules` row. That table has never had a
// row in production, and isOpenNow() treats "no schedule" as always-open — so
// after-hours routing has simply never fired. Company Setup now owns business
// hours (sql/086 company_settings, section 'hours'), and this adapter feeds them
// to the webhook so setting your hours on that page actually changes what a
// 9 PM caller hears.
//
// Precedence is deliberate: an explicit voice_schedules row still wins, because
// a phone system's own schedule is more specific than the company default. This
// only fills the gap where there is no row at all.
//
// Fails open in every direction. If the settings table is missing (sql/086 not
// applied), if no company resolves, or if the row is malformed, this returns
// null and the caller keeps its previous always-open behavior. Nobody gets sent
// to voicemail because a lookup failed.

import { supabaseRequest as defaultSb } from './jobber.js';
import { resolveCompany as defaultResolve } from './tenant.js';

// isOpenNow() keys windows by a 3-letter lowercase day; company_settings keys
// days 0 (Sunday) … 6 (Saturday).
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Convert a company_settings `hours` value into the voice_schedules
 * `business_hours` shape: { mon: [['07:30','17:00']], … }.
 *
 * A closed day becomes an empty array — which isOpenNow() reads as closed,
 * NOT as "unconfigured". Returns null when nothing usable is present, so the
 * caller can fall back rather than accidentally closing the line all week.
 */
export function hoursToVoiceWindows(hours) {
  if (!hours || typeof hours !== 'object') return null;
  const days = hours.days;
  if (!days || typeof days !== 'object') return null;

  const out = {};
  let usable = 0;

  for (let i = 0; i < 7; i += 1) {
    const d = days[i] || days[String(i)] || null;
    if (!d || typeof d !== 'object') { out[DAY_KEYS[i]] = []; continue; }
    if (d.closed) { out[DAY_KEYS[i]] = []; usable += 1; continue; }
    const open = String(d.open || '');
    const close = String(d.close || '');
    // A malformed or inverted window is treated as closed rather than trusted —
    // but it does not count as "usable", so a wholly broken row falls back.
    if (!HHMM.test(open) || !HHMM.test(close) || close <= open) { out[DAY_KEYS[i]] = []; continue; }
    out[DAY_KEYS[i]] = [[open, close]];
    usable += 1;
  }

  return usable > 0 ? out : null;
}

/**
 * The company's business hours as a voice_schedules-shaped object, or null.
 * Returns { business_hours, timezone, _source: 'company_settings' }.
 *
 * deps is injectable so this is unit-testable without network.
 */
export async function companyBusinessHours(deps = {}) {
  const sb = deps.supabaseRequest || defaultSb;
  const resolve = deps.resolveCompany || defaultResolve;

  try {
    // No user in a Twilio webhook — resolveCompany's sole-company fallback is
    // the intended path here, and it self-disables once a second company exists.
    const tenant = await resolve(null, deps);
    if (!tenant || !tenant.company_id) return null;

    const r = await sb(
      `company_settings?company_id=eq.${encodeURIComponent(tenant.company_id)}` +
      '&section=eq.hours&select=value&limit=1',
    );
    if (!r.ok) return null; // includes "table does not exist" pre-migration
    const rows = await r.json();
    const value = rows && rows[0] ? rows[0].value : null;

    const business_hours = hoursToVoiceWindows(value);
    if (!business_hours) return null;

    // Timezone comes from the company profile (sql/081); isOpenNow() defaults
    // to America/New_York when it is absent.
    let timezone = null;
    try {
      const cr = await sb(`companies?id=eq.${encodeURIComponent(tenant.company_id)}&select=timezone&limit=1`);
      if (cr.ok) {
        const crows = await cr.json();
        timezone = (crows && crows[0] && crows[0].timezone) || null;
      }
    } catch { /* timezone is optional — isOpenNow has its own default */ }

    return { business_hours, timezone, _source: 'company_settings' };
  } catch {
    return null;
  }
}
