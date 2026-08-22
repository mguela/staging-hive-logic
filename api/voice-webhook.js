// api/voice-webhook.js - Vercel serverless function
// Twilio-facing webhooks for HiveLogic Phone. Every route here is called
// BY Twilio (never by the HiveLogic frontend) and is protected by Twilio
// request-signature verification instead of a user session -- that's the
// correct boundary for this surface, matching how api/authnet-webhook.js
// verifies the payment provider's signature instead of a HiveLogic login.
//
// Call-control model: ordinary calls stay on a direct <Dial> for the best
// audio quality and only escalate into a named Twilio Conference
// (`call-{voice_calls.id}`) on-demand, if Hold or Transfer is actually
// invoked -- see reina/voip-quality-fix-2026-07-24.md. Every <Dial><Client>
// leg below also carries a CallId <Parameter> so the browser on the other
// end can populate its own state.activeCallId, which Hold/Transfer need.
//
// Architecture rule this file follows: a broken integration (client
// lookup, AI summary) must NEVER stop an ordinary call from being
// answered. Every non-essential lookup is wrapped so it degrades to
// "no match" instead of failing the webhook.
//
// Usage (register these exact URLs in the Twilio Console once a number
// exists -- see the Settings > Numbers admin panel for the full list):
//   Main number Voice webhook:        POST /api/voice-webhook?resource=inbound
//   Main number Status Callback:      POST /api/voice-webhook?resource=status
//   TwiML App Voice Request URL:      POST /api/voice-webhook?resource=outbound

import { supabaseRequest } from './_lib/jobber.js';
import {
  TwiML, xmlResponse, verifyTwilioSignature, updateLiveCall,
  normalizeToE164, escapeXml, twilioRequest,
  intelligenceConfigured, createCallTranscript, getTranscriptStatus, fetchTranscriptText,
} from './_lib/voice.js';
import Anthropic from '@anthropic-ai/sdk';
import { getVoiceSettings, runCallIntelligence } from './_lib/call-intelligence.js';
import { companyBusinessHours } from './_lib/company-hours.js';

const anthropicVoice = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function verify(req) {
  // Twilio signs the exact URL it called, including query string, plus
  // the POST body params. req.body here is already the parsed
  // application/x-www-form-urlencoded object (Vercel parses it for us).
  const url = `${baseUrl(req)}${req.url}`;
  const signature = req.headers['x-twilio-signature'];
  return verifyTwilioSignature(url, req.body || {}, signature);
}

async function findCallById(callId) {
  if (!callId) return null;
  const res = await supabaseRequest(`voice_calls?id=eq.${callId}&select=*`);
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

async function findCallBySid(sid) {
  if (!sid) return null;
  const res = await supabaseRequest(`voice_calls?provider_call_sid=eq.${sid}&select=*`);
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

async function patchCall(id, fields) {
  await supabaseRequest(`voice_calls?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  });
}

async function findQueueById(queueId) {
  if (!queueId) return null;
  const res = await supabaseRequest(`voice_queues?id=eq.${encodeURIComponent(queueId)}&select=*&limit=1`);
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

// The one queue the main line routes callers into, if an admin has
// activated it (is_default_inbound). Null -> inbound behaves exactly as
// before queues existed (dial-by-extension then voicemail).
async function defaultInboundQueue() {
  try {
    const res = await supabaseRequest('voice_queues?is_default_inbound=eq.true&active=eq.true&select=*&limit=1');
    if (!res.ok) return null;
    return (await res.json())[0] || null;
  } catch { return null; }
}

async function logEvent(callId, eventType, payload = {}) {
  if (!callId) return;
  await supabaseRequest('voice_call_events', {
    method: 'POST',
    body: JSON.stringify({ call_id: callId, event_type: eventType, payload }),
  }).catch(() => {}); // audit logging must never break the call flow
}

async function lookupClientAndJob(fromE164) {
  // Best-effort caller recognition. Any failure here returns nulls --
  // never throws, never delays answering the call.
  try {
    if (!fromE164) return { clientId: null, jobId: null };
    const cRes = await supabaseRequest(`clients?phone_e164=eq.${encodeURIComponent(fromE164)}&select=jobber_id&limit=1`);
    if (!cRes.ok) return { clientId: null, jobId: null };
    const clients = await cRes.json();
    const clientId = clients[0] ? clients[0].jobber_id : null;
    if (!clientId) return { clientId: null, jobId: null };
    const jRes = await supabaseRequest(`jobs?client_id=eq.${encodeURIComponent(clientId)}&completed_at=is.null&select=jobber_id&order=jobber_updated_at.desc&limit=1`);
    const jobId = jRes.ok ? ((await jRes.json())[0] || {}).jobber_id || null : null;
    return { clientId, jobId };
  } catch {
    return { clientId: null, jobId: null };
  }
}

// An explicit voice_schedules row wins — a phone system's own schedule is more
// specific than the company default. When there is no row (the case in
// production to date, which is why after-hours routing has never fired), fall
// back to the business hours set on Company Setup. Both lookups fail open: a
// null return keeps isOpenNow()'s always-open behavior rather than sending a
// caller to voicemail because a query failed.
async function activeSchedule() {
  try {
    const res = await supabaseRequest('voice_schedules?select=*&limit=1');
    if (res.ok) {
      const rows = await res.json();
      if (rows && rows[0]) return rows[0];
    }
  } catch { /* fall through to the company default */ }
  try {
    return await companyBusinessHours();
  } catch { return null; }
}

function isOpenNow(schedule) {
  if (!schedule || !schedule.business_hours) return true; // no schedule configured -- default to "open" rather than locking callers out
  try {
    const now = new Date();
    const day = now.toLocaleDateString('en-US', { weekday: 'short', timeZone: schedule.timezone || 'America/New_York' }).toLowerCase().slice(0, 3);
    const dayKey = { mon: 'mon', tue: 'tue', wed: 'wed', thu: 'thu', fri: 'fri', sat: 'sat', sun: 'sun' }[day] || day;
    const windows = schedule.business_hours[dayKey];
    if (!windows || !windows.length) return false;
    const hhmm = now.toLocaleTimeString('en-US', { hour12: false, timeZone: schedule.timezone || 'America/New_York' }).slice(0, 5);
    return windows.some(([start, end]) => hhmm >= start && hhmm <= end);
  } catch { return true; }
}

async function greetingFor(kind) {
  try {
    const res = await supabaseRequest(`voice_greetings?kind=eq.${kind}&select=tts_text,audio_url&limit=1`);
    if (!res.ok) return null;
    const rows = await res.json();
    return rows[0] || null;
  } catch { return null; }
}

// getVoiceSettings() lives in _lib/call-intelligence.js (shared with the
// admin reprocess path) and is imported above.

// Attributes injected into a <Dial> so Twilio records the connected call and
// posts to recording-status when the file is ready. Empty string (no
// recording) when the master toggle is off. dual = separate caller/agent
// channels, which gives cleaner transcripts later.
function recordingDialAttrs(url, callId, settings) {
  if (!settings || !settings.record_calls) return '';
  const track = settings.recording_channels === 'mono' ? 'record-from-answer' : 'record-from-answer-dual';
  const cb = `${url}/api/voice-webhook?resource=recording-status&callId=${encodeURIComponent(callId || '')}`;
  return ` record="${track}" recordingStatusCallback="${escapeXml(cb)}" recordingStatusCallbackEvent="completed" recordingStatusCallbackMethod="POST"`;
}

// A saved recording/upload (audio_url) always wins over typed text for a
// given greeting kind -- see voip-panel.js Settings > Greetings.
function applyGreeting(tw, greeting, fallbackText) {
  if (greeting && greeting.audio_url) tw.play(greeting.audio_url);
  else tw.say((greeting && greeting.tts_text) || fallbackText);
}

// A forwarding number (Settings > Extensions > Edit) rings in parallel with
// the extension's own softphone leg inside the same <Dial> -- find-me,
// first to answer wins, matching ordinary call-forwarding behavior rather
// than replacing the desk extension outright.
function forwardingLeg(ext, callId) {
  if (!ext || !ext.forwarding_number) return "";
  return `<Number>${escapeXml(ext.forwarding_number)}</Number>`;
}

async function isBlocked(e164) {
  if (!e164) return false;
  try {
    const res = await supabaseRequest(`voice_blocked_numbers?e164=eq.${encodeURIComponent(e164)}&select=id&limit=1`);
    if (!res.ok) return false;
    return (await res.json()).length > 0;
  } catch { return false; }
}

// ---------------------------------------------------------------------
// resource=inbound -- a call just hit the main HiveLogic Phone number.
// ---------------------------------------------------------------------
// ---------------------------------------------------------------------
// Call Flow -- the visual, drag-and-drop inbound routing graph editable
// from VoIP Settings > Call Flow (see api/voice.js call_flow resource
// and public/hiveconnect/voip-callflow.js for the editor). Node types:
//   call_in         -- the fixed entry point, exactly one per graph.
//   dispatch_active -- rings ALL extensions currently flagged operator +
//                      active simultaneously (a ring group); first to
//                      answer wins, the rest stop ringing. "Active" today
//                      reuses the existing voice_extensions.is_operator +
//                      .active columns -- there is no separate on-duty /
//                      presence toggle yet (that is the still-paused
//                      Dispatch Center Slice 2 work in the master to-do).
//   greeting_ivr    -- exactly the original hardcoded behavior: play the
//                      open/closed greeting, gather a 4-digit extension
//                      or 0 for the operator.
//   voicemail       -- send the caller straight to voicemail.
//   hangup          -- end the call.
// If no flow has ever been saved, getActiveFlow() returns null and every
// caller falls through to the exact original hardcoded behavior further
// down -- existing installs see zero change until someone opens the
// editor and hits Save.
async function getActiveFlow() {
  try {
    const r = await supabaseRequest("voice_call_flows?is_active=eq.true&select=id,graph&order=updated_at.desc&limit=1");
    if (!r.ok) return null;
    const rows = await r.json();
    const row = rows[0];
    if (!row || !row.graph || !Array.isArray(row.graph.nodes)) return null;
    return row.graph;
  } catch {
    return null;
  }
}

function findFlowNode(graph, nodeId) {
  return (graph.nodes || []).find(function (n) { return n.id === nodeId; }) || null;
}

function nextFlowNode(graph, fromNodeId, when) {
  const edges = graph.edges || [];
  let edge = edges.find(function (e) { return e.from === fromNodeId && e.when === when; });
  if (!edge) edge = edges.find(function (e) { return e.from === fromNodeId && !e.when; });
  if (!edge) return null;
  return findFlowNode(graph, edge.to);
}

// Shared by the flow-driven greeting_ivr node AND the no-flow-configured
// fallback path in handleInbound, so both give callers the identical
// experience -- this is literally the original handleInbound body,
// factored out so it can also run mid-flow.
async function buildGreetingIvrTwiml(tw, call, url, flowNodeId) {
  const schedule = await activeSchedule();
  const open = isOpenNow(schedule);
  const greeting = await greetingFor(open ? "main_open" : "main_closed");
  const greetingFallback = open
    ? "Thanks for calling. Enter an extension now, or press 0 for the operator."
    : "Thanks for calling. We are currently closed. Enter an extension if you know it, or stay on the line to leave a message.";
  const flowParam = flowNodeId ? `&flowNode=${encodeURIComponent(flowNodeId)}` : "";
  const action = `${url}/api/voice-webhook?resource=gather&callId=${encodeURIComponent(call ? call.id : "")}&attempt=1${flowParam}`;
  if (greeting && greeting.audio_url) {
    tw.gather({ action, numDigits: 4, timeout: 6, playUrl: greeting.audio_url });
  } else {
    tw.gather({ action, numDigits: 4, timeout: 6, say: (greeting && greeting.tts_text) || greetingFallback });
  }
}

async function executeFlowNode(req, res, graph, node, call) {
  const tw = new TwiML();
  const url = baseUrl(req);
  const callId = call && call.id ? call.id : null;

  if (!node) {
    tw.redirect(`${url}/api/voice-webhook?resource=voicemail-start&callId=${encodeURIComponent(callId || "")}&reason=flow_end`);
    return xmlResponse(res, tw);
  }
  if (callId) await patchCall(callId, { flow_node_id: node.id }).catch(function () {});

  if (node.type === "dispatch_active") {
    const extRes = await supabaseRequest("voice_extensions?is_operator=eq.true&active=eq.true&select=id,forwarding_number&order=extension_number.asc");
    const extensions = extRes.ok ? await extRes.json() : [];
    if (!extensions.length) {
      const fallback = nextFlowNode(graph, node.id, "no_answer") || nextFlowNode(graph, node.id, "default");
      return executeFlowNode(req, res, graph, fallback, call);
    }
    const ringSeconds = (node.config && node.config.ringSeconds) || 20;
    const dialActionUrl = `${url}/api/voice-webhook?resource=dial-action&callId=${encodeURIComponent(callId || "")}&flowNode=${encodeURIComponent(node.id)}`;
    const clients = extensions.map(function (e) {
      return `<Client><Identity>${escapeXml(`ext-${e.id}`)}</Identity><Parameter name="CallId" value="${escapeXml(callId || "")}"/></Client>${forwardingLeg(e, callId)}`;
    }).join("");
    const recAttrs = recordingDialAttrs(url, callId, await getVoiceSettings());
    tw.body += `<Dial action="${escapeXml(dialActionUrl)}" method="POST" timeout="${ringSeconds}"${recAttrs}>${clients}</Dial>`;
    if (callId) await patchCall(callId, { status: "routing" }).catch(function () {});
    return xmlResponse(res, tw);
  }

  if (node.type === "greeting_ivr") {
    await buildGreetingIvrTwiml(tw, call, url, node.id);
    const fallback = nextFlowNode(graph, node.id, "no_input") || nextFlowNode(graph, node.id, "default");
    if (fallback) {
      tw.redirect(`${url}/api/voice-webhook?resource=flow-node&nodeId=${encodeURIComponent(fallback.id)}&callId=${encodeURIComponent(callId || "")}`);
    } else {
      tw.redirect(`${url}/api/voice-webhook?resource=voicemail-start&callId=${encodeURIComponent(callId || "")}&reason=no_input`);
    }
    return xmlResponse(res, tw);
  }

  if (node.type === "queue") {
    // Drop the caller into a call queue (Phase 1). queueId comes from the
    // node config, else the default-inbound queue. The queue's own
    // overflow_destination (callback/voicemail/extension) governs what
    // happens on timeout -- see handleQueueOverflow. Falls back to
    // voicemail if no queue is configured, so a caller never hits dead air.
    let qId = (node.config && node.config.queueId) || null;
    if (!qId) { const q = await defaultInboundQueue(); qId = q ? q.id : null; }
    if (!qId) {
      tw.redirect(`${url}/api/voice-webhook?resource=voicemail-start&callId=${encodeURIComponent(callId || "")}&reason=queue_missing`);
      return xmlResponse(res, tw);
    }
    tw.redirect(`${url}/api/voice-webhook?resource=queue-enqueue&callId=${encodeURIComponent(callId || "")}&queueId=${encodeURIComponent(qId)}`);
    return xmlResponse(res, tw);
  }

  if (node.type === "voicemail") {
    tw.redirect(`${url}/api/voice-webhook?resource=voicemail-start&callId=${encodeURIComponent(callId || "")}&reason=flow`);
    return xmlResponse(res, tw);
  }

  if (node.type === "hangup") {
    tw.hangup();
    return xmlResponse(res, tw);
  }

  tw.redirect(`${url}/api/voice-webhook?resource=voicemail-start&callId=${encodeURIComponent(callId || "")}&reason=flow_unknown_node`);
  return xmlResponse(res, tw);
}

// resource=flow-node -- mid-flow continuation target used by gather
// no-input/invalid-extension and dial-action no-answer/busy/failed
// fallbacks when the current call is running a saved flow (see
// handleGather and handleDialAction below).
async function handleFlowNode(req, res) {
  const callId = req.query.callId;
  const nodeId = req.query.nodeId;
  const call = await findCallById(callId);
  const graph = await getActiveFlow();
  const node = graph ? findFlowNode(graph, nodeId) : null;
  if (!graph || !node) {
    const tw = new TwiML();
    tw.redirect(`${baseUrl(req)}/api/voice-webhook?resource=voicemail-start&callId=${encodeURIComponent(callId || "")}&reason=flow_missing`);
    return xmlResponse(res, tw);
  }
  return executeFlowNode(req, res, graph, node, call || { id: callId });
}

async function handleInbound(req, res) {
  const p = req.body || {};
  const from = normalizeToE164(p.From);
  const to = normalizeToE164(p.To);
  const callSid = p.CallSid;

  if (await isBlocked(from)) {
    await logEvent(null, "blocked", { from });
    const tw = new TwiML();
    tw.reject();
    return xmlResponse(res, tw);
  }

  const { clientId, jobId } = await lookupClientAndJob(from);
  const insertRes = await supabaseRequest("voice_calls", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      provider_call_sid: callSid,
      direction: "inbound",
      from_number: from || p.From,
      to_number: to || p.To,
      client_id: clientId,
      job_id: jobId,
      caller_call_sid: callSid,
      status: "ringing",
    }),
  });
  const call = insertRes.ok ? (await insertRes.json())[0] : null;
  await logEvent(call && call.id, "created", { from, to, clientMatched: Boolean(clientId) });

  // Call Flow -- if an admin has saved a flow in VoIP Settings > Call
  // Flow, run it starting from the call_in node. Otherwise fall through
  // to the exact original hardcoded greeting-first behavior below.
  const graph = await getActiveFlow();
  if (graph) {
    const startNode = graph.nodes.find(function (n) { return n.type === "call_in"; }) || graph.nodes[0];
    const firstNode = nextFlowNode(graph, startNode.id, "default");
    return executeFlowNode(req, res, graph, firstNode, call);
  }

  const tw = new TwiML();
  const url = baseUrl(req);
  await buildGreetingIvrTwiml(tw, call, url, null);
  // Phase 1 queues: when an admin has activated a default-inbound queue,
  // a caller who doesn't dial an extension drops into that queue's hold
  // line (dial-by-extension above still works). With no default queue,
  // behaviour is unchanged -- straight to voicemail.
  const queue = await defaultInboundQueue();
  if (queue) {
    tw.redirect(`${url}/api/voice-webhook?resource=queue-enqueue&callId=${encodeURIComponent(call ? call.id : "")}&queueId=${encodeURIComponent(queue.id)}`);
  } else {
    tw.redirect(`${url}/api/voice-webhook?resource=voicemail-start&callId=${encodeURIComponent(call ? call.id : "")}&reason=no_input`);
  }
  xmlResponse(res, tw);
}

// ---------------------------------------------------------------------
// resource=gather -- caller entered (or did not enter) digits.
// ---------------------------------------------------------------------
async function handleGather(req, res) {
  const p = req.body || {};
  const callId = req.query.callId;
  const flowNodeId = req.query.flowNode || null;
  const attempt = Number(req.query.attempt || "1");
  const digits = (p.Digits || "").trim();
  const call = await findCallById(callId);
  const tw = new TwiML();
  const url = baseUrl(req);
  const flowParam = flowNodeId ? `&flowNode=${encodeURIComponent(flowNodeId)}` : "";

  async function fallThroughToFlowOrVoicemail(reason) {
    if (flowNodeId) {
      const graph = await getActiveFlow();
      const fallback = graph ? (nextFlowNode(graph, flowNodeId, "no_input") || nextFlowNode(graph, flowNodeId, "default")) : null;
      if (fallback) {
        tw.redirect(`${url}/api/voice-webhook?resource=flow-node&nodeId=${encodeURIComponent(fallback.id)}&callId=${encodeURIComponent(callId || "")}`);
        return;
      }
    }
    tw.redirect(`${url}/api/voice-webhook?resource=voicemail-start&callId=${encodeURIComponent(callId || "")}&reason=${reason}`);
  }

  if (!digits) {
    await fallThroughToFlowOrVoicemail("no_input");
    return xmlResponse(res, tw);
  }

  // Reserved dial code for phone-based greeting recording -- see
  // handleGreetingPinPrompt below. Checked before the operator/extension
  // lookup so it can never collide with a real extension number.
  if (digits === "00") {
    tw.redirect(`${url}/api/voice-webhook?resource=greeting-pin`);
    return xmlResponse(res, tw);
  }

  // Reserved dial code for phone-based voicemail check-in -- see
  // handleVoicemailCheckin below. Same "never collide with a real
  // extension" reasoning as 00 above.
  if (digits === "98") {
    tw.redirect(`${url}/api/voice-webhook?resource=voicemail-checkin&step=extension`);
    return xmlResponse(res, tw);
  }

  let extension = null;
  if (digits === "0") {
    const opRes = await supabaseRequest("voice_extensions?is_operator=eq.true&active=eq.true&select=*&limit=1");
    if (opRes.ok) extension = (await opRes.json())[0] || null;
  } else {
    const extRes = await supabaseRequest(`voice_extensions?extension_number=eq.${encodeURIComponent(digits)}&active=eq.true&select=*&limit=1`);
    if (extRes.ok) extension = (await extRes.json())[0] || null;
  }

  if (!extension) {
    if (attempt >= 2) {
      await fallThroughToFlowOrVoicemail("invalid_extension");
      return xmlResponse(res, tw);
    }
    const action = `${url}/api/voice-webhook?resource=gather&callId=${encodeURIComponent(callId || "")}&attempt=${attempt + 1}${flowParam}`;
    tw.gather({ action, numDigits: 4, timeout: 6, say: "Sorry, that is not a valid extension. Please try again, or press 0 for the operator." });
    await fallThroughToFlowOrVoicemail("no_input");
    return xmlResponse(res, tw);
  }

  await patchCall(callId, { extension_id: extension.id, status: "routing" });
  await logEvent(callId, "routing", { extensionNumber: extension.extension_number });

  // Direct <Dial> to the extension for the best call quality (see
  // reina/voip-quality-fix-2026-07-24.md) -- this only escalates into a
  // conference on-demand, if Hold or Transfer is actually invoked
  // (handleDialAction below, via api/voice.js escalateCallToConference).
  const dialActionUrl = `${url}/api/voice-webhook?resource=dial-action&callId=${encodeURIComponent(callId || "")}${flowParam}`;
  const recAttrs = recordingDialAttrs(url, callId, await getVoiceSettings());
  tw.body += `<Dial action="${escapeXml(dialActionUrl)}" method="POST" timeout="20"${recAttrs}><Client><Identity>${escapeXml(`ext-${extension.id}`)}</Identity><Parameter name="CallId" value="${escapeXml(callId || "")}"/></Client>${forwardingLeg(extension, callId)}</Dial>`;

  xmlResponse(res, tw);
}

// resource=conference-join -- TwiML URL for a leg escalating a direct
// <Dial> call into a conference (see reina/voip-quality-fix-2026-07-24.md).
// wait=1 means this leg should join and hear hold music until the other
// leg arrives; no wait (default) starts the conference immediately.
async function handleConferenceJoin(req, res) {
  const callId = req.query.callId;
  const wait = req.query.wait === '1';
  const tw = new TwiML();
  const confName = `call-${callId}`;
  if (wait) {
    const waitUrl = `${baseUrl(req)}/api/voice-webhook?resource=hold-music`;
    const statusCb = `${baseUrl(req)}/api/voice-webhook?resource=conference-events&callId=${encodeURIComponent(callId || '')}`;
    tw.body += `<Dial><Conference startConferenceOnEnter="false" endConferenceOnExit="true" waitUrl="${escapeXml(waitUrl)}" statusCallback="${escapeXml(statusCb)}" statusCallbackEvent="start end join leave">${escapeXml(confName)}</Conference></Dial>`;
  } else {
    tw.body += `<Dial><Conference startConferenceOnEnter="true" endConferenceOnExit="true">${escapeXml(confName)}</Conference></Dial>`;
  }
  xmlResponse(res, tw);
}

// resource=hold-music -- looping wait/hold TwiML (Phase 1: a spoken
// loop via <Say> in a <Pause> cycle -- swap for a real <Play> music URL
// once Chris has one; no dependency on external audio hosting today).
async function handleHoldMusic(req, res) {
  const tw = new TwiML();
  const greeting = await greetingFor('hold');
  applyGreeting(tw, greeting, "Please hold, we'll be right with you.");
  tw.pause(10);
  tw.redirect(`${baseUrl(req)}/api/voice-webhook?resource=hold-music`);
  xmlResponse(res, tw);
}

// resource=agent-leg-status -- the outbound call to the extension ended.
async function handleAgentLegStatus(req, res) {
  const p = req.body || {};
  const callId = req.query.callId;
  const call = await findCallById(callId);
  await logEvent(callId, 'agent_leg_status', { status: p.CallStatus });
  const badOutcome = ['no-answer', 'busy', 'failed', 'canceled'].includes(p.CallStatus);
  if (badOutcome && call && call.caller_call_sid && call.status !== 'answered') {
    const url = baseUrl(req);
    try {
      await updateLiveCall(call.caller_call_sid, {
        Url: `${url}/api/voice-webhook?resource=voicemail-start&callId=${encodeURIComponent(callId)}&reason=${p.CallStatus}`,
        Method: 'POST',
      });
    } catch (e) {
      await logEvent(callId, 'redirect_to_voicemail_failed', { error: String(e && e.message || e) });
    }
  }
  res.status(200).send('');
}

// resource=conference-events -- conference start/join/leave/end.
async function handleConferenceEvents(req, res) {
  const p = req.body || {};
  const callId = req.query.callId;
  await logEvent(callId, `conference_${p.StatusCallbackEvent}`, { conferenceSid: p.ConferenceSid, callSid: p.CallSid });
  if (p.StatusCallbackEvent === 'start') {
    await patchCall(callId, { conference_sid: p.ConferenceSid });
  }
  if (p.StatusCallbackEvent === 'join') {
    await patchCall(callId, { status: 'answered', answered_at: new Date().toISOString(), agent_call_sid: p.CallSid });
  }
  if (p.StatusCallbackEvent === 'end') {
    const call = await findCallById(callId);
    const startedAt = call ? new Date(call.started_at).getTime() : Date.now();
    await patchCall(callId, {
      status: call && call.status === 'voicemail' ? 'voicemail' : 'completed',
      ended_at: new Date().toISOString(),
      duration_seconds: Math.round((Date.now() - startedAt) / 1000),
    });
  }
  res.status(200).send('');
}

// resource=voicemail-start -- caller (or dial-no-answer redirect) needs
// to leave a message.
async function handleVoicemailStart(req, res) {
  const callId = req.query.callId;
  const reason = req.query.reason || 'unavailable';
  await logEvent(callId, 'voicemail_started', { reason });
  await patchCall(callId, { status: 'voicemail' });
  const tw = new TwiML();
  const greeting = await greetingFor('voicemail');
  applyGreeting(tw, greeting, 'Please leave a message after the tone, then hang up or press pound when finished.');
  const url = baseUrl(req);
  tw.record({
    action: `${url}/api/voice-webhook?resource=voicemail-recording&callId=${encodeURIComponent(callId || '')}`,
    maxLength: 120,
    transcribe: true,
    transcribeCallback: `${url}/api/voice-webhook?resource=transcription&callId=${encodeURIComponent(callId || '')}`,
  });
  tw.say('Sorry, we did not receive a recording. Goodbye.');
  xmlResponse(res, tw);
}

async function handleVoicemailRecording(req, res) {
  const p = req.body || {};
  const callId = req.query.callId;
  const call = await findCallById(callId);
  await supabaseRequest('voice_voicemails', {
    method: 'POST',
    body: JSON.stringify({
      call_id: callId || null,
      extension_id: call ? call.extension_id : null,
      from_number: call ? call.from_number : (p.From || 'unknown'),
      recording_sid: p.RecordingSid,
      recording_url: p.RecordingUrl,
      duration_seconds: p.RecordingDuration ? Number(p.RecordingDuration) : null,
      transcript_status: 'pending',
    }),
  }).catch(() => {});
  await logEvent(callId, 'voicemail_recorded', { recordingSid: p.RecordingSid });
  const tw = new TwiML();
  tw.say('Thank you, goodbye.');
  tw.hangup();
  xmlResponse(res, tw);
}

// ---------------------------------------------------------------------
// resource=voicemail-checkin -- dial-in voicemail retrieval. Reached by
// pressing 98 from the main greeting IVR (see handleGather's reserved
// digit codes, alongside 00 for greeting recording). Two-step PIN gate
// (extension number, then that extension's voicemail_pin -- see
// Settings > Extensions > Edit) before anything is played back, mirroring
// the existing VOICE_GREETING_PIN pattern's "do not trust the caller"
// posture. An extension with no PIN set cannot be checked this way --
// there is no default or bypass PIN.
// ---------------------------------------------------------------------
async function fetchVoicemailCheckinQueue(extensionId) {
  const r = await supabaseRequest(`voice_voicemails?extension_id=eq.${encodeURIComponent(extensionId)}&order=created_at.desc&select=id,recording_url,transcript,from_number`);
  return r.ok ? await r.json() : [];
}

async function markVoicemailCheckinRead(extensionId, idx) {
  const list = await fetchVoicemailCheckinQueue(extensionId);
  const vm = list[idx];
  if (!vm) return;
  await supabaseRequest(`voice_voicemails?id=eq.${vm.id}`, { method: "PATCH", body: JSON.stringify({ read: true }) }).catch(function () {});
}

async function deleteVoicemailCheckin(extensionId, idx) {
  const list = await fetchVoicemailCheckinQueue(extensionId);
  const vm = list[idx];
  if (!vm) return;
  await supabaseRequest(`voice_voicemails?id=eq.${vm.id}`, { method: "DELETE" }).catch(function () {});
}

async function playVoicemailCheckinQueue(req, res, extension, idx) {
  const url = baseUrl(req);
  const tw = new TwiML();
  const list = await fetchVoicemailCheckinQueue(extension.id);
  const vm = list[idx];
  if (!vm) {
    tw.say(idx === 0 ? "You have no voicemail." : "That was your last message. Goodbye.");
    tw.hangup();
    return xmlResponse(res, tw);
  }
  const action = `${url}/api/voice-webhook?resource=voicemail-checkin&step=menu&ext=${encodeURIComponent(extension.id)}&idx=${idx}`;
  tw.say(`Message ${idx + 1} of ${list.length}, from ${vm.from_number || "an unknown number"}.`);
  if (vm.recording_url) tw.play(vm.recording_url);
  else tw.say(vm.transcript || "No transcript is available for this message.");
  tw.gather({ action, numDigits: 1, timeout: 6, say: "Press 5 to replay. Press 7 to permanently delete this message. Or press any other key for the next message." });
  tw.redirect(action);
  return xmlResponse(res, tw);
}

async function handleVoicemailCheckin(req, res) {
  const p = req.body || {};
  const step = req.query.step || "extension";
  const url = baseUrl(req);
  const tw = new TwiML();

  if (step === "extension") {
    const action = `${url}/api/voice-webhook?resource=voicemail-checkin&step=pin`;
    tw.gather({ action, numDigits: 4, timeout: 8, finishOnKey: "#", say: "Enter your extension number, followed by the pound sign." });
    tw.say("No entry received. Goodbye.");
    tw.hangup();
    return xmlResponse(res, tw);
  }

  if (step === "pin") {
    const extDigits = (p.Digits || "").trim();
    const extRes = await supabaseRequest(`voice_extensions?extension_number=eq.${encodeURIComponent(extDigits)}&active=eq.true&select=*&limit=1`);
    const extension = extRes.ok ? (await extRes.json())[0] || null : null;
    if (!extension || !extension.voicemail_pin) {
      tw.say("That extension is not set up for phone voicemail check-in. Goodbye.");
      tw.hangup();
      return xmlResponse(res, tw);
    }
    const action = `${url}/api/voice-webhook?resource=voicemail-checkin&step=verify&ext=${encodeURIComponent(extension.id)}`;
    tw.gather({ action, numDigits: 6, timeout: 8, finishOnKey: "#", say: "Enter your voicemail PIN, followed by the pound sign." });
    tw.say("No entry received. Goodbye.");
    tw.hangup();
    return xmlResponse(res, tw);
  }

  if (step === "verify") {
    const extId = req.query.ext;
    const pinDigits = (p.Digits || "").trim();
    const extRes = await supabaseRequest(`voice_extensions?id=eq.${extId}&select=*&limit=1`);
    const extension = extRes.ok ? (await extRes.json())[0] || null : null;
    if (!extension || !extension.voicemail_pin || extension.voicemail_pin !== pinDigits) {
      tw.say("Incorrect PIN. Goodbye.");
      tw.hangup();
      return xmlResponse(res, tw);
    }
    return playVoicemailCheckinQueue(req, res, extension, 0);
  }

  if (step === "menu") {
    const extId = req.query.ext;
    const idx = Number(req.query.idx || "0");
    const digits = (p.Digits || "").trim();
    const extRes = await supabaseRequest(`voice_extensions?id=eq.${extId}&select=*&limit=1`);
    const extension = extRes.ok ? (await extRes.json())[0] || null : null;
    if (!extension) { tw.hangup(); return xmlResponse(res, tw); }
    if (digits === "5") return playVoicemailCheckinQueue(req, res, extension, idx);
    if (digits === "7") {
      await deleteVoicemailCheckin(extension.id, idx);
      return playVoicemailCheckinQueue(req, res, extension, idx);
    }
    await markVoicemailCheckinRead(extension.id, idx);
    return playVoicemailCheckinQueue(req, res, extension, idx + 1);
  }

  tw.hangup();
  return xmlResponse(res, tw);
}

// Shared by both voicemail alert channels (SMS and the HiveConnect bot,
// see handleTranscription below) so the two only differ in *where* the
// same text gets sent, not in how it is built.
async function buildVoicemailAlertText(callId, p) {
  const call = await findCallById(callId);
  const vmRow = await supabaseRequest(`voice_voicemails?recording_sid=eq.${encodeURIComponent(p.RecordingSid || "")}&select=ai_summary&limit=1`);
  const vmRows = vmRow.ok ? await vmRow.json() : [];
  const latestSummary = (vmRows[0] && vmRows[0].ai_summary) || null;
  const from = (call && call.from_number) || "an unknown number";
  return latestSummary
    ? `New voicemail from ${from}: ${latestSummary}`
    : `New voicemail from ${from}: ${(p.TranscriptionText || "").slice(0, 300)}`;
}

async function handleTranscription(req, res) {
  const p = req.body || {};
  const callId = req.query.callId;
  const ready = p.TranscriptionStatus === 'completed' && p.TranscriptionText;
  await supabaseRequest(`voice_voicemails?recording_sid=eq.${encodeURIComponent(p.RecordingSid || '')}`, {
    method: 'PATCH',
    body: JSON.stringify({
      transcript: p.TranscriptionText || null,
      transcript_status: ready ? 'ready' : 'failed',
    }),
  }).catch(() => {});

  if (ready && anthropicVoice) {
    try {
      const msg = await anthropicVoice.messages.create({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 200,
        messages: [{ role: 'user', content: `Summarize this voicemail transcript in 1-2 short sentences a busy dispatcher can skim. Transcript:\n\n${p.TranscriptionText}` }],
      });
      const summary = msg.content && msg.content[0] && msg.content[0].text;
      if (summary) {
        await supabaseRequest(`voice_voicemails?recording_sid=eq.${encodeURIComponent(p.RecordingSid || '')}`, {
          method: 'PATCH',
          body: JSON.stringify({ ai_summary: summary }),
        });
      }
    } catch (e) {
      await logEvent(callId, 'ai_summary_failed', { error: String(e && e.message || e) });
    }
  }

  const alertPhone = process.env.REINA_VOICEMAIL_ALERT_PHONE;
  const botSecret = process.env.REINA_BOT_SECRET;
  const botChannelId = process.env.REINA_BOT_DEFAULT_CHANNEL_ID;
  if (ready && (alertPhone || (botSecret && botChannelId))) {
    const alertText = await buildVoicemailAlertText(callId, p).catch(function () { return null; });
    if (alertText) {
      if (alertPhone) {
        try {
          const numRes = await supabaseRequest('voice_numbers?role=eq.main&active=eq.true&select=e164&limit=1');
          const mainNumber = numRes.ok ? (await numRes.json())[0] : null;
          if (mainNumber) {
            await twilioRequest('Messages.json', { method: 'POST', body: new URLSearchParams({ From: mainNumber.e164, To: alertPhone, Body: alertText }) });
          }
        } catch (e) {
          await logEvent(callId, 'voicemail_alert_sms_failed', { error: String(e && e.message || e) }).catch(function () {});
        }
      }
      if (botSecret && botChannelId) {
        try {
          await fetch(`${baseUrl(req)}/api/hiveconnect-bridge?action=bot_post`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ secret: botSecret, channelId: botChannelId, text: alertText }),
          });
        } catch (e) {
          await logEvent(callId, 'voicemail_alert_hiveconnect_failed', { error: String(e && e.message || e) }).catch(function () {});
        }
      }
    }
  }

  res.status(200).send('');
}

// resource=status -- the top-level inbound call's own lifecycle.
async function handleStatus(req, res) {
  const p = req.body || {};
  const call = await findCallBySid(p.CallSid);
  if (call) {
    const fields = { status: mapTwilioStatus(p.CallStatus) };
    if (p.CallStatus === 'completed') {
      fields.ended_at = new Date().toISOString();
      fields.duration_seconds = p.CallDuration ? Number(p.CallDuration) : call.duration_seconds;
    }
    await patchCall(call.id, fields);
    await logEvent(call.id, 'status', { callStatus: p.CallStatus });
  }
  res.status(200).send('');
}

function mapTwilioStatus(s) {
  const map = { queued: 'created', initiated: 'routing', ringing: 'ringing', 'in-progress': 'answered', completed: 'completed', busy: 'failed', failed: 'failed', 'no-answer': 'missed', canceled: 'failed' };
  return map[s] || 'created';
}

// ---------------------------------------------------------------------
// resource=outbound -- the TwiML App's Voice Request URL, called by
// Twilio the moment a member's browser softphone places a call.
// ---------------------------------------------------------------------
async function handleOutbound(req, res) {
  const p = req.body || {};
  const url = baseUrl(req);
  const rawIdentity = (p.From || '').replace(/^client:/, ''); // "ext-<uuid>"
  const extMatch = /^ext-(.+)$/.exec(rawIdentity);
  const callerExtensionId = extMatch ? extMatch[1] : null;

  const to = (p.To || '').trim();
  let targetExtension = null;
  if (/^\d{2,6}$/.test(to)) {
    const extRes = await supabaseRequest(`voice_extensions?extension_number=eq.${encodeURIComponent(to)}&active=eq.true&select=*&limit=1`);
    if (extRes.ok) targetExtension = (await extRes.json())[0] || null;
  }

  const numRes = await supabaseRequest("voice_numbers?role=eq.main&active=eq.true&select=e164&limit=1");
  const mainNumber = numRes.ok ? ((await numRes.json())[0] || {}).e164 : null;

  const toE164 = targetExtension ? null : normalizeToE164(to);
  if (!targetExtension && await isBlocked(toE164)) {
    const tw = new TwiML();
    tw.say('That number is blocked.');
    tw.hangup();
    return xmlResponse(res, tw);
  }

  const { clientId, jobId } = targetExtension ? { clientId: null, jobId: null } : await lookupClientAndJob(toE164);
  // See placeCall() in app-phone-popup.js -- the browser mints this UUID
  // before connect() so it can set state.activeCallId with no round trip.
  const clientCallId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.ClientCallId || '') ? p.ClientCallId : null;
  const insertRes = await supabaseRequest('voice_calls', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      ...(clientCallId ? { id: clientCallId } : {}),
      direction: 'outbound',
      from_number: mainNumber || 'unknown',
      to_number: targetExtension ? targetExtension.extension_number : (toE164 || to),
      extension_id: callerExtensionId,
      client_id: clientId,
      job_id: jobId,
      caller_call_sid: p.CallSid,
      status: 'routing',
    }),
  });
  const call = insertRes.ok ? (await insertRes.json())[0] : null;
  await logEvent(call && call.id, 'created', { direction: 'outbound', to });

  const tw = new TwiML();
  // Direct <Dial> for the best call quality (see
  // reina/voip-quality-fix-2026-07-24.md) -- escalates into a conference
  // on-demand only if Hold or Transfer is invoked. callerId is required:
  // this call's own From is the browser's client: identity, not a phone
  // number, and Twilio needs a real E.164 caller ID to place the
  // outbound leg to a PSTN number (otherwise it rings briefly then fails).
  const dialActionUrl = `${url}/api/voice-webhook?resource=dial-action&callId=${encodeURIComponent(call ? call.id : '')}`;
  const target = targetExtension ? `<Client><Identity>${escapeXml(`ext-${targetExtension.id}`)}</Identity><Parameter name="CallId" value="${escapeXml(call ? call.id : '')}"/></Client>${forwardingLeg(targetExtension, call ? call.id : '')}` : `<Number>${escapeXml(toE164)}</Number>`;
  const recAttrs = recordingDialAttrs(url, call ? call.id : '', await getVoiceSettings());
  tw.body += `<Dial action="${escapeXml(dialActionUrl)}" method="POST" timeout="30" callerId="${escapeXml(mainNumber || '')}"${recAttrs}>${target}</Dial>`;

  xmlResponse(res, tw);
}

// resource=dial-action -- fires when a direct <Dial> (from handleGather or
// handleOutbound) ends: answered-and-hung-up, no-answer/busy/failed, OR
// deliberately interrupted to escalate into a conference for Hold/Transfer
// (see reina/voip-quality-fix-2026-07-24.md and api/voice.js's
// escalateCallToConference). DialCallStatus/escalation_requested tell us
// which case this is.
async function handleDialAction(req, res) {
  const p = req.body || {};
  const callId = req.query.callId;
  const call = await findCallById(callId);
  await logEvent(callId, 'dial_action', { dialCallStatus: p.DialCallStatus, direction: call && call.direction });

  if (call && call.escalation_requested) {
    await patchCall(callId, { escalation_requested: false }).catch(() => {});
    // The customer's leg is whichever one is the parent on inbound calls
    // and the child on outbound calls -- give IT the hold-music/wait
    // TwiML; the agent's leg (already redirected to conference-join)
    // starts the conference. See reina/voip-quality-fix-2026-07-24.md.
    const wait = call.direction === 'inbound';
    const tw = new TwiML();
    const confName = `call-${callId}`;
    if (wait) {
      const waitUrl = `${baseUrl(req)}/api/voice-webhook?resource=hold-music`;
      const statusCb = `${baseUrl(req)}/api/voice-webhook?resource=conference-events&callId=${encodeURIComponent(callId || '')}`;
      tw.body += `<Dial><Conference startConferenceOnEnter="false" endConferenceOnExit="true" waitUrl="${escapeXml(waitUrl)}" statusCallback="${escapeXml(statusCb)}" statusCallbackEvent="start end join leave">${escapeXml(confName)}</Conference></Dial>`;
    } else {
      tw.body += `<Dial><Conference startConferenceOnEnter="true" endConferenceOnExit="true">${escapeXml(confName)}</Conference></Dial>`;
    }
    return xmlResponse(res, tw);
  }

  const tw = new TwiML();
  const badOutcome = ['no-answer', 'busy', 'failed', 'canceled'].includes(p.DialCallStatus);
  // The <Dial> action callback is where a directly-dialed call (the
  // common path -- see reina/voip-quality-fix-2026-07-24.md) actually
  // finishes. This used to only decide the TwiML response and never
  // wrote the outcome back to voice_calls, so every non-escalated call
  // stayed stuck at status='routing' forever (shown as "In progress"
  // in the dashboard no matter how long ago it ended). Persist the real
  // outcome here; the conference-events handler still owns status for
  // calls that get escalated (Hold/Transfer), and voicemail-start still
  // owns it when an inbound bad outcome redirects into voicemail.
  const dialDuration = p.DialCallDuration != null && p.DialCallDuration !== '' ? Number(p.DialCallDuration) : null;
  if (call && call.direction === 'outbound') {
    if (badOutcome) tw.say("Sorry, that call couldn't be completed.");
    tw.hangup();
    await patchCall(callId, {
      status: badOutcome ? p.DialCallStatus : 'completed',
      ended_at: new Date().toISOString(),
      duration_seconds: dialDuration,
    }).catch(() => {});
  } else if (badOutcome) {
    const flowNodeId = req.query.flowNode;
    let handledByFlow = false;
    if (flowNodeId) {
      const graph = await getActiveFlow();
      const fallback = graph ? (nextFlowNode(graph, flowNodeId, "no_answer") || nextFlowNode(graph, flowNodeId, "default")) : null;
      if (fallback) {
        tw.redirect(`${baseUrl(req)}/api/voice-webhook?resource=flow-node&nodeId=${encodeURIComponent(fallback.id)}&callId=${encodeURIComponent(callId || "")}`);
        handledByFlow = true;
      }
    }
    if (!handledByFlow) {
      tw.redirect(`${baseUrl(req)}/api/voice-webhook?resource=voicemail-start&callId=${encodeURIComponent(callId || "")}&reason=${p.DialCallStatus}`);
    }
  } else {
    tw.hangup();
    await patchCall(callId, {
      status: 'completed',
      ended_at: new Date().toISOString(),
      duration_seconds: dialDuration,
    }).catch(() => {});
  }
  xmlResponse(res, tw);
}

// ---------------------------------------------------------------------
// Phone-based greeting recording -- from the main menu, dial 00 to record
// a greeting from any phone, no computer needed. Gated by an env var
// (VOICE_GREETING_PIN) Chris sets in Vercel; if it is unset the line
// honestly announces it is not set up yet instead of silently locking
// everyone out or, worse, letting anyone in. See voip-panel.js Settings >
// Greetings for the equivalent upload/mic-record path from the browser.
// ---------------------------------------------------------------------
function greetingPin() {
  return process.env.VOICE_GREETING_PIN || null;
}

async function handleGreetingPinPrompt(req, res) {
  const tw = new TwiML();
  const pin = greetingPin();
  if (!pin) {
    tw.say('Greeting recording by phone has not been set up yet. Please use the web dashboard instead.');
    tw.hangup();
    return xmlResponse(res, tw);
  }
  const url = baseUrl(req);
  tw.gather({
    action: `${url}/api/voice-webhook?resource=greeting-pin-check`,
    finishOnKey: '#',
    timeout: 8,
    say: 'Greeting recording line. Enter your PIN, then press pound.',
  });
  tw.say('Sorry, we did not receive a PIN. Goodbye.');
  tw.hangup();
  xmlResponse(res, tw);
}

async function handleGreetingPinCheck(req, res) {
  const p = req.body || {};
  const digits = (p.Digits || '').trim();
  const tw = new TwiML();
  const pin = greetingPin();
  const url = baseUrl(req);
  if (!pin || digits !== pin) {
    tw.say('That PIN was not recognized. Goodbye.');
    tw.hangup();
    return xmlResponse(res, tw);
  }
  tw.gather({
    action: `${url}/api/voice-webhook?resource=greeting-menu`,
    numDigits: 1,
    timeout: 8,
    say: 'PIN accepted. Press 1 to record the main open greeting. Press 2 for the main closed greeting. Press 3 for the voicemail greeting. Press 4 for the hold greeting.',
  });
  tw.say('Sorry, we did not receive a selection. Goodbye.');
  tw.hangup();
  xmlResponse(res, tw);
}

const GREETING_KIND_BY_DIGIT = { '1': 'main_open', '2': 'main_closed', '3': 'voicemail', '4': 'hold' };

async function handleGreetingMenu(req, res) {
  const p = req.body || {};
  const digits = (p.Digits || '').trim();
  const kind = GREETING_KIND_BY_DIGIT[digits];
  const tw = new TwiML();
  const url = baseUrl(req);
  if (!kind) {
    tw.say('Sorry, that is not a valid option. Goodbye.');
    tw.hangup();
    return xmlResponse(res, tw);
  }
  tw.say('Record your greeting after the tone. Press pound or just hang up when finished.');
  tw.record({
    action: `${url}/api/voice-webhook?resource=greeting-record-save&kind=${encodeURIComponent(kind)}`,
    maxLength: 120,
  });
  tw.say('Sorry, we did not receive a recording. Goodbye.');
  xmlResponse(res, tw);
}

async function handleGreetingRecordSave(req, res) {
  const p = req.body || {};
  const kind = req.query.kind;
  const tw = new TwiML();
  if (!kind || !p.RecordingUrl) {
    tw.say('Sorry, something went wrong saving that recording. Goodbye.');
    tw.hangup();
    return xmlResponse(res, tw);
  }
  const audioUrl = p.RecordingUrl;
  await supabaseRequest('voice_greetings?on_conflict=kind', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ kind, name: `phone-recorded-${kind}`, audio_url: audioUrl }),
  }).catch(() => {});
  tw.say('Got it. Playing your new greeting back now.');
  tw.play(audioUrl);
  tw.say('That has been saved. Goodbye.');
  tw.hangup();
  xmlResponse(res, tw);
}

// =====================================================================
// Phase 1 -- Call Queues (Twilio <Enqueue>/<Leave>/<Dial><Queue>).
// Flow: inbound greeting -> queue-enqueue (<Enqueue>) -> queue-wait loop
// (hold music; <Leave> once timeout_seconds is exceeded) -> queue-overflow
// (the <Enqueue> action; runs overflow_destination). An available agent
// pulls the front caller with Answer Next -> queue-dequeue (<Dial><Queue>).
// =====================================================================

// resource=queue-enqueue -- put the caller into the named Twilio queue.
async function handleQueueEnqueue(req, res) {
  const callId = req.query.callId;
  const queueId = req.query.queueId;
  const url = baseUrl(req);
  const qName = `hlq-${queueId}`;
  const waitUrl = `${url}/api/voice-webhook?resource=queue-wait&callId=${encodeURIComponent(callId || '')}&queueId=${encodeURIComponent(queueId || '')}`;
  const action = `${url}/api/voice-webhook?resource=queue-overflow&callId=${encodeURIComponent(callId || '')}&queueId=${encodeURIComponent(queueId || '')}`;
  await patchCall(callId, { status: 'routing' }).catch(() => {});
  await logEvent(callId, 'queue_enqueued', { queueId });
  const tw = new TwiML();
  tw.enqueue(qName, { waitUrl, action });
  xmlResponse(res, tw);
}

// resource=queue-wait -- Twilio requests this repeatedly while the caller
// holds. QueueTime is seconds waited so far; once it exceeds the queue's
// timeout we <Leave> (which fires the <Enqueue> action -> overflow).
async function handleQueueWait(req, res) {
  const p = req.body || {};
  const queueId = req.query.queueId;
  const queueTime = Number(p.QueueTime || 0);
  const queue = await findQueueById(queueId);
  const timeout = queue ? queue.timeout_seconds : 30;
  const tw = new TwiML();
  if (queueTime >= timeout) {
    tw.say('Thank you for your patience.');
    tw.leave();
    return xmlResponse(res, tw);
  }
  if (queue && queue.hold_music_url) {
    tw.play(queue.hold_music_url);
  } else {
    const greeting = await greetingFor('hold');
    applyGreeting(tw, greeting, "Please hold, we'll be with you as soon as possible.");
  }
  tw.pause(8);
  xmlResponse(res, tw);
}

// resource=queue-overflow -- the <Enqueue> action. QueueResult tells us
// why the caller left the queue: 'bridged' (an agent answered),
// 'leave' (our timeout fired), or hangup/error/etc.
async function handleQueueOverflow(req, res) {
  const p = req.body || {};
  const callId = req.query.callId;
  const queueId = req.query.queueId;
  const result = p.QueueResult || 'leave';
  const url = baseUrl(req);
  await logEvent(callId, 'queue_overflow', { result, queueTime: p.QueueTime });
  const tw = new TwiML();

  if (result === 'bridged') {
    // Agent answered and the bridge has since ended; caller leg is done.
    tw.hangup();
    return xmlResponse(res, tw);
  }
  if (result !== 'leave') {
    // hangup / error / queue-full / redirected -- caller gone or unroutable.
    await patchCall(callId, { status: 'missed', ended_at: new Date().toISOString() }).catch(() => {});
    tw.hangup();
    return xmlResponse(res, tw);
  }

  // 'leave' = our hold timeout fired -> run the configured overflow.
  const queue = await findQueueById(queueId);
  const dest = queue ? queue.overflow_destination : 'voicemail';
  if (dest === 'callback') {
    tw.redirect(`${url}/api/voice-webhook?resource=queue-callback&callId=${encodeURIComponent(callId || '')}&queueId=${encodeURIComponent(queueId || '')}`);
  } else if (dest === 'extension' && queue && queue.overflow_extension_id) {
    tw.body += `<Dial timeout="20"><Client><Identity>${escapeXml(`ext-${queue.overflow_extension_id}`)}</Identity><Parameter name="CallId" value="${escapeXml(callId || '')}"/></Client></Dial>`;
    tw.redirect(`${url}/api/voice-webhook?resource=voicemail-start&callId=${encodeURIComponent(callId || '')}&reason=overflow_no_answer`);
  } else {
    tw.redirect(`${url}/api/voice-webhook?resource=voicemail-start&callId=${encodeURIComponent(callId || '')}&reason=queue_overflow`);
  }
  xmlResponse(res, tw);
}

// resource=queue-dequeue -- TwiML served to an agent's softphone (rung by
// api/voice.js handleQueueAnswer). <Dial><Queue> bridges them to the
// front (longest-waiting) caller. If the queue is empty the dial fails
// fast and we tell the agent.
async function handleQueueDequeue(req, res) {
  const queueId = req.query.queueId;
  const url = baseUrl(req);
  const tw = new TwiML();
  tw.dialQueue(`hlq-${queueId}`, {
    timeout: 30,
    action: `${url}/api/voice-webhook?resource=queue-dequeue-done&queueId=${encodeURIComponent(queueId || '')}`,
  });
  xmlResponse(res, tw);
}

// resource=queue-dequeue-done -- the agent's <Dial><Queue> finished.
// DialCallSid is the caller who was bridged (if any); DialCallStatus tells
// us whether a caller was actually available.
async function handleQueueDequeueDone(req, res) {
  const p = req.body || {};
  const status = p.DialCallStatus;
  const bridgedSid = p.DialCallSid;
  if (bridgedSid) {
    const call = await findCallBySid(bridgedSid);
    if (call) {
      const now = new Date().toISOString();
      await patchCall(call.id, {
        status: status === 'completed' ? 'completed' : call.status,
        answered_at: call.answered_at || now,
        ended_at: status === 'completed' ? now : call.ended_at,
      }).catch(() => {});
      await logEvent(call.id, 'queue_answered', { dialStatus: status });
    }
  }
  const tw = new TwiML();
  if (status !== 'completed' && status !== 'answered' && status !== 'in-progress') {
    tw.say('There are no callers waiting in the queue right now. Goodbye.');
  }
  tw.hangup();
  xmlResponse(res, tw);
}

// resource=queue-callback -- overflow destination 'callback': record the
// caller's name/number/reason for a call back when an agent frees up.
async function handleQueueCallback(req, res) {
  const callId = req.query.callId;
  const queueId = req.query.queueId;
  const url = baseUrl(req);
  const tw = new TwiML();
  tw.say("We're sorry to keep you waiting. Please leave your name, number, and a brief message after the tone, and the next available person will call you right back.");
  tw.record({
    action: `${url}/api/voice-webhook?resource=callback-recording&callId=${encodeURIComponent(callId || '')}&queueId=${encodeURIComponent(queueId || '')}`,
    maxLength: 120,
    transcribe: true,
    transcribeCallback: `${url}/api/voice-webhook?resource=callback-transcription&callId=${encodeURIComponent(callId || '')}&queueId=${encodeURIComponent(queueId || '')}`,
    playBeep: true,
  });
  tw.say('We did not receive a message. Goodbye.');
  tw.hangup();
  xmlResponse(res, tw);
}

// resource=callback-recording -- the <Record> action: persist the
// callback request (status 'unassigned') so the queue card can surface it.
async function handleCallbackRecording(req, res) {
  const p = req.body || {};
  const callId = req.query.callId;
  const queueId = req.query.queueId;
  const call = await findCallById(callId);
  await supabaseRequest('voice_callbacks', {
    method: 'POST',
    body: JSON.stringify({
      call_id: callId || null,
      queue_id: queueId || null,
      from_number: (call && call.from_number) || p.From || 'unknown',
      recording_sid: p.RecordingSid || null,
      recording_url: p.RecordingUrl || null,
      duration_seconds: p.RecordingDuration ? Number(p.RecordingDuration) : null,
      transcript_status: 'pending',
      status: 'unassigned',
      source: 'queue_overflow',
    }),
  }).catch(() => {});
  await patchCall(callId, { status: 'completed', ended_at: new Date().toISOString() }).catch(() => {});
  await logEvent(callId, 'callback_captured', { recordingSid: p.RecordingSid });
  const tw = new TwiML();
  tw.say('Thank you. Someone will call you back as soon as possible. Goodbye.');
  tw.hangup();
  xmlResponse(res, tw);
}

// resource=callback-transcription -- Twilio transcription callback (same
// mechanism as voicemail). Stores the transcript and asks Claude to
// structure it into { caller_name, callback_number, intent, summary }.
async function handleCallbackTranscription(req, res) {
  const p = req.body || {};
  const ready = p.TranscriptionStatus === 'completed' && p.TranscriptionText;
  await supabaseRequest(`voice_callbacks?recording_sid=eq.${encodeURIComponent(p.RecordingSid || '')}`, {
    method: 'PATCH',
    body: JSON.stringify({ transcript: p.TranscriptionText || null, transcript_status: ready ? 'ready' : 'failed' }),
  }).catch(() => {});

  if (ready && anthropicVoice) {
    try {
      const msg = await anthropicVoice.messages.create({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 400,
        messages: [{ role: 'user', content: `A caller left this callback request after waiting in a phone queue. Return ONLY a JSON object with keys: caller_name (string or null), callback_number (string or null), intent (one short phrase), summary (1-2 sentences a dispatcher can skim). Transcript:\n\n${p.TranscriptionText}` }],
      });
      const text = msg.content && msg.content[0] && msg.content[0].text;
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* model returned prose, keep raw */ }
      const patch = { ai_summary: parsed || { summary: text } };
      if (parsed && parsed.caller_name) patch.caller_name = parsed.caller_name;
      if (parsed && parsed.intent) patch.reason = parsed.intent;
      await supabaseRequest(`voice_callbacks?recording_sid=eq.${encodeURIComponent(p.RecordingSid || '')}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
    } catch (e) {
      await logEvent(req.query.callId, 'callback_ai_failed', { error: String((e && e.message) || e) });
    }
  }
  res.status(200).send('');
}

// =====================================================================
// Phase 4 -- Call Intelligence (record -> transcript -> AI summary + drafts).
// The AI pipeline itself lives in _lib/call-intelligence.js (shared with the
// admin reprocess endpoint). These two webhooks are the Twilio-facing edges.
// =====================================================================

// resource=recording-status -- Twilio posts here when a call recording is
// ready (see recordingDialAttrs). Store the recording so it's playable and
// mark the transcript pending when AI summaries are on. The transcript SOURCE
// (Twilio Voice Intelligence or an external STT) is a separate configurable
// step; once a transcript lands via resource=call-transcription (or an admin
// reprocess) the summary fires.
async function handleRecordingStatus(req, res) {
  const p = req.body || {};
  const callId = req.query.callId;
  let call = callId ? await findCallById(callId) : null;
  if (!call && p.CallSid) call = await findCallBySid(p.CallSid);
  const settings = await getVoiceSettings();
  if (call) {
    const fields = { recording_sid: p.RecordingSid || null, recording_url: p.RecordingUrl || null };
    if (settings.ai_call_summaries && call.transcript_status === 'not_captured') fields.transcript_status = 'pending';
    // Transcript source: if Voice Intelligence is configured, kick off async
    // transcription of this recording now; the intelligence-callback webhook
    // finishes the job. Best-effort -- recording is stored regardless.
    if (settings.ai_call_summaries && p.RecordingSid && intelligenceConfigured()) {
      try {
        const transcriptSid = await createCallTranscript(p.RecordingSid);
        if (transcriptSid) fields.intelligence_transcript_sid = transcriptSid;
      } catch (e) {
        await logEvent(call.id, 'intelligence_create_failed', { error: String((e && e.message) || e) });
      }
    }
    await patchCall(call.id, fields).catch(() => {});
    await logEvent(call.id, 'recording_ready', { recordingSid: p.RecordingSid, duration: p.RecordingDuration });
  }
  res.status(200).send('');
}

// resource=intelligence-callback -- Twilio Voice Intelligence Service webhook,
// fired when a transcript's processing state changes. We match the transcript
// back to its call (by the stored intelligence_transcript_sid), and once it's
// completed, pull the text and run the AI summary + draft actions.
async function handleIntelligenceCallback(req, res) {
  const p = req.body || {};
  const transcriptSid = p.transcript_sid || p.TranscriptSid || req.query.transcriptSid;
  if (!transcriptSid) return res.status(200).send('');
  const r = await supabaseRequest(`voice_calls?intelligence_transcript_sid=eq.${encodeURIComponent(transcriptSid)}&select=*&limit=1`);
  const call = r.ok ? (await r.json())[0] : null;
  if (!call) return res.status(200).send('');

  const status = await getTranscriptStatus(transcriptSid);
  if (status === 'failed') {
    await patchCall(call.id, { transcript_status: 'failed' }).catch(() => {});
    await logEvent(call.id, 'intelligence_failed', { transcriptSid });
    return res.status(200).send('');
  }
  if (status && status !== 'completed') return res.status(200).send(''); // still processing; a later event will complete it

  const text = await fetchTranscriptText(transcriptSid);
  if (!text) { await logEvent(call.id, 'intelligence_empty', { transcriptSid }); return res.status(200).send(''); }
  await patchCall(call.id, { transcript: text, transcript_status: 'ready' }).catch(() => {});
  await runCallIntelligence({ ...call, transcript: text }).catch((e) => logEvent(call.id, 'call_ai_failed', { error: String((e && e.message) || e) }));
  res.status(200).send('');
}

// resource=call-transcription -- accepts a finished transcript for a call
// from whatever STT source is wired (Twilio transcription callback fields, or
// a Voice Intelligence webhook mapped to the same shape), then runs the AI
// summary + draft actions. Body: TranscriptionText|transcript, callId (query).
async function handleCallTranscription(req, res) {
  const p = req.body || {};
  const callId = req.query.callId || p.callId;
  const text = p.TranscriptionText || p.transcript || '';
  const ok = (p.TranscriptionStatus ? p.TranscriptionStatus === 'completed' : true) && Boolean(text);
  const call = await findCallById(callId);
  if (call) {
    await patchCall(call.id, { transcript: text || null, transcript_status: ok ? 'ready' : 'failed' }).catch(() => {});
    if (ok) {
      await runCallIntelligence({ ...call, transcript: text }).catch((e) => logEvent(call.id, 'call_ai_failed', { error: String((e && e.message) || e) }));
    }
  }
  res.status(200).send('');
}

const RESOURCES = {
  inbound: handleInbound,
  gather: handleGather,
  'recording-status': handleRecordingStatus,
  'call-transcription': handleCallTranscription,
  'intelligence-callback': handleIntelligenceCallback,
  'queue-enqueue': handleQueueEnqueue,
  'queue-wait': handleQueueWait,
  'queue-overflow': handleQueueOverflow,
  'queue-dequeue': handleQueueDequeue,
  'queue-dequeue-done': handleQueueDequeueDone,
  'queue-callback': handleQueueCallback,
  'callback-recording': handleCallbackRecording,
  'callback-transcription': handleCallbackTranscription,
  'flow-node': handleFlowNode,
  'conference-join': handleConferenceJoin,
  'hold-music': handleHoldMusic,
  'agent-leg-status': handleAgentLegStatus,
  'conference-events': handleConferenceEvents,
  'voicemail-start': handleVoicemailStart,
  'voicemail-recording': handleVoicemailRecording,
  transcription: handleTranscription,
  status: handleStatus,
  outbound: handleOutbound,
  'dial-action': handleDialAction,
  'greeting-pin': handleGreetingPinPrompt,
  'greeting-pin-check': handleGreetingPinCheck,
  'greeting-menu': handleGreetingMenu,
  'greeting-record-save': handleGreetingRecordSave,
  'voicemail-checkin': handleVoicemailCheckin,
};

export default async function handler(req, res) {
  const resource = req.query.resource;
  const fn = RESOURCES[resource];
  if (!fn) return res.status(404).json({ ok: false, error: 'unknown voice-webhook resource' });

  // hold-music and queue-wait are fetched by Twilio as wait/loop URLs
  // (played on repeat while a caller holds) and carry no state mutation;
  // everything else must verify its signature.
  if (resource !== 'hold-music' && resource !== 'queue-wait' && !verify(req)) {
    console.error('voice-webhook: signature verification failed', resource);
    return res.status(403).send('Invalid signature');
  }

  try {
    await fn(req, res);
  } catch (err) {
    console.error(`voice-webhook (${resource}) failed:`, err);
    // Architecture rule: never leave the caller in dead air. On any
    // unexpected error, still return valid TwiML if we haven't
    // responded yet, rather than a raw 500 the caller's carrier can't
    // interpret.
    if (!res.headersSent) {
      const tw = new TwiML();
      tw.say('Sorry, something went wrong on our end. Please try again shortly.');
      tw.hangup();
      xmlResponse(res, tw);
    }
  }
}
