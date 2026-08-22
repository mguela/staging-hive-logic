// api/_lib/call-intelligence.js
// Phase 4 -- AI Call Intelligence pipeline, shared by api/voice-webhook.js
// (the transcript-ready webhook) and api/voice.js (admin reprocess), so the
// summarize-and-draft logic lives in exactly one place. NOT Twilio-specific
// (that stays in _lib/voice.js) -- this is transcript-in, summary+drafts-out.
//
// Hard rule from the task: draft actions are NEVER auto-executed. This
// creates DRAFT records only (a voice_callbacks row for follow-ups, plus
// suggested change-order/task actions recorded for review) and stores their
// refs on voice_calls.ai_summary.draft_actions[] for the UI to approve or
// dismiss.

import { supabaseRequest } from './jobber.js';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

export async function getVoiceSettings() {
  const fallback = { record_calls: false, recording_channels: 'dual', ai_call_summaries: false, recording_consent_message: null };
  try {
    const res = await supabaseRequest('voice_settings?singleton=eq.true&select=*&limit=1');
    if (!res.ok) return fallback;
    const rows = await res.json();
    return rows[0] || fallback;
  } catch { return fallback; }
}

async function logCallEvent(callId, eventType, payload = {}) {
  if (!callId) return;
  await supabaseRequest('voice_call_events', {
    method: 'POST',
    body: JSON.stringify({ call_id: callId, event_type: eventType, payload }),
  }).catch(() => {});
}

// Run the Claude pass on a call's transcript, write the structured summary to
// voice_calls.ai_summary, and create draft actions. Returns the ai_summary
// object (or null if it couldn't run). Safe to call repeatedly (reprocess).
export async function runCallIntelligence(call) {
  if (!call || !call.id || !call.transcript) return null;
  const settings = await getVoiceSettings();
  if (!settings.ai_call_summaries) { await logCallEvent(call.id, 'call_ai_skipped', { reason: 'ai_call_summaries off' }); return null; }
  if (!anthropic) { await logCallEvent(call.id, 'call_ai_skipped', { reason: 'no ANTHROPIC_API_KEY' }); return null; }

  const prompt = `You are analyzing a transcript of a phone call for a home-services company. Return ONLY a JSON object with these keys:
- summary: 2-3 sentence summary a busy dispatcher can skim
- intent: one short phrase for why they called
- sentiment: "positive" | "neutral" | "negative"
- commitments: array of { who, what, due } for promises made on the call (empty array if none)
- price_scope: array of short strings for any price or scope-of-work mentions (empty if none)
- follow_up_needed: boolean
- follow_up_reason: one short phrase, or null

Transcript:
${call.transcript}`;

  let raw = '';
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 700,
      messages: [{ role: 'user', content: prompt }],
    });
    raw = (msg.content && msg.content[0] && msg.content[0].text) || '';
  } catch (e) {
    await logCallEvent(call.id, 'call_ai_failed', { error: String((e && e.message) || e) });
    return null;
  }

  let data = null;
  try { data = JSON.parse(raw); }
  catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) { try { data = JSON.parse(m[0]); } catch { /* fall through */ } }
  }
  if (!data) { await logCallEvent(call.id, 'call_ai_unparsed', {}); data = { summary: raw.slice(0, 500) }; }

  const draftActions = [];

  // Draft: follow-up callback -- fully approvable end-to-end (it lands in the
  // queue Callbacks card; claim -> dial back). Only one per call.
  if (data.follow_up_needed) {
    const excerpt = String(call.transcript || '').slice(0, 240);
    const fromNumber = call.direction === 'inbound' ? call.from_number : call.to_number;
    const ins = await supabaseRequest('voice_callbacks', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        call_id: call.id,
        from_number: fromNumber || 'unknown',
        reason: data.follow_up_reason || data.intent || 'Follow-up from call',
        transcript: excerpt,
        transcript_status: 'ready',
        ai_summary: { summary: data.summary, intent: data.intent, follow_up_reason: data.follow_up_reason },
        status: 'unassigned',
        source: 'ai_call_intelligence',
      }),
    }).catch(() => null);
    const created = ins && ins.ok ? (await ins.json())[0] : null;
    draftActions.push({ type: 'callback', ref_table: 'voice_callbacks', ref_id: created ? created.id : null, status: 'draft', excerpt });
  }

  // Suggested drafts whose target engines (change orders, HiveConnect tasks)
  // are the next increment -- recorded for review, not yet created.
  if (Array.isArray(data.price_scope) && data.price_scope.length) {
    draftActions.push({ type: 'change_order', status: 'suggested', excerpt: data.price_scope.join('; ').slice(0, 240) });
  }
  if (Array.isArray(data.commitments) && data.commitments.length) {
    draftActions.push({ type: 'task', status: 'suggested', excerpt: data.commitments.map(c => `${(c && c.who) || 'someone'}: ${(c && c.what) || ''}`).join('; ').slice(0, 240) });
  }

  const aiSummary = { ...data, draft_actions: draftActions, generated_at: new Date().toISOString() };
  await supabaseRequest(`voice_calls?id=eq.${call.id}`, { method: 'PATCH', body: JSON.stringify({ ai_summary: aiSummary }) }).catch(() => {});
  await logCallEvent(call.id, 'call_ai_summarized', { followUp: !!data.follow_up_needed, drafts: draftActions.length });
  return aiSummary;
}
