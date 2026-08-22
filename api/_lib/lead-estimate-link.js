// api/_lib/lead-estimate-link.js — keeping a lead and its estimate in step.
//
// The lead board tracks 'estimate_booked' and 'estimate_sent' stages, and
// people already use them (20 of 58 live leads sit in estimate_booked). What
// was missing was any connection to a real estimate: the card was moved by
// hand, and an estimate had no idea which lead produced it.
//
// This is the last unlinked hop in the chain. With it a project is traceable
// end to end: lead → E-10001 → J-10001 → CO-10001-1 → INV-10001-1.
//
// Two deliberate choices about stages:
//
//   - Creating the estimate links it but does NOT move the card. The estimate
//     starts as a draft, and the send that follows can fail; a lead that
//     claimed "sent" because a draft existed would be lying.
//   - Sending it advances the lead to 'estimate_sent', and only ever forwards.
//     Someone who has already marked a lead 'won' should not see it dragged
//     backwards by a resend.

import { supabaseRequest as defaultSb } from './jobber.js';

// Board order. Anything at or past 'estimate_sent' is left alone when an
// estimate is sent — see advanceLeadOnSend.
const STAGE_ORDER = ['new', 'contacted', 'estimate_booked', 'estimate_sent', 'won', 'lost'];

export function stageIsBefore(current, target) {
  const a = STAGE_ORDER.indexOf(String(current || ''));
  const b = STAGE_ORDER.indexOf(String(target || ''));
  if (a === -1 || b === -1) return false;
  return a < b;
}

// Points the lead at the estimate. Never touches the stage.
//
// Returns { linked: true } on success. A failure here must NOT sink the
// estimate: the estimate is the real record and already exists by this point,
// so a broken link is a reporting gap, not lost work. It is reported rather
// than thrown, so the caller can say so honestly.
export async function linkLeadToEstimate(leadId, estimateId, deps = {}) {
  const sb = deps.supabaseRequest || defaultSb;
  if (!leadId || !estimateId) return { linked: false, reason: 'nothing to link' };

  const res = await sb(`lead_pipeline?id=eq.${encodeURIComponent(leadId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ estimate_id: String(estimateId), updated_at: new Date().toISOString() }),
  });
  if (!res.ok) return { linked: false, reason: (await res.text()).slice(0, 160) };
  const rows = await res.json();
  if (!rows.length) return { linked: false, reason: 'that lead no longer exists' };
  return { linked: true, lead: rows[0] };
}

// Moves the lead to 'estimate_sent' when its estimate is sent — forwards only.
export async function advanceLeadOnSend(leadId, deps = {}) {
  const sb = deps.supabaseRequest || defaultSb;
  if (!leadId) return { advanced: false, reason: 'no lead' };

  const cur = await sb(`lead_pipeline?id=eq.${encodeURIComponent(leadId)}&select=id,stage&limit=1`);
  if (!cur.ok) return { advanced: false, reason: 'could not read the lead' };
  const lead = (await cur.json())[0];
  if (!lead) return { advanced: false, reason: 'that lead no longer exists' };

  if (!stageIsBefore(lead.stage, 'estimate_sent')) {
    return { advanced: false, reason: `already at ${lead.stage}`, stage: lead.stage };
  }

  const res = await sb(`lead_pipeline?id=eq.${encodeURIComponent(leadId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ stage: 'estimate_sent', last_contacted_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
  });
  if (!res.ok) return { advanced: false, reason: (await res.text()).slice(0, 160) };
  return { advanced: true, stage: 'estimate_sent' };
}
