import { createHash } from 'node:crypto';
import { requireUser } from './_lib/agents/security.js';
import { supabaseRequest } from './_lib/jobber.js';
import { createCouncilHandler } from './reina-council.js';

const THREAD_FIELDS = 'id,owner_id,title,status,pinned,project_id,created_at,updated_at';
const MESSAGE_FIELDS = 'id,thread_id,author_type,author_name,body,kind,task_state,metadata,source,source_conversation_id,source_message_id,created_at';
const AGENTS = new Set(['codex', 'chatgpt', 'claude', 'claude_code', 'grok', 'reina', 'system']);
const IMPORT_AUTHORS = new Set(['user', 'codex', 'chatgpt', 'claude', 'claude_code', 'grok', 'reina', 'system']);
const KINDS = new Set(['message', 'task', 'status', 'decision', 'evidence']);
const STATES = new Set(['queued', 'claimed', 'working', 'blocked', 'done', 'cancelled']);
const SOURCES = new Set(['codex', 'chatgpt', 'claude', 'claude_code', 'grok', 'reina', 'github', 'manager_self_test']);
const TIERS = new Set(['economy', 'standard', 'expert']);
const cleanText = value => value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
const text = (value, max) => typeof value === 'string' ? cleanText(value).trim().slice(0, max) : '';
const respond = (res, status, body) => res.status(status).json(body);
const kind = value => KINDS.has(value) ? value : 'message';
const taskState = value => STATES.has(value) ? value : null;
async function db(path, options) {
  const response = await supabaseRequest(path, options);
  if (!response.ok) {
    const detail = cleanText(await response.text()).slice(0, 1000);
    throw new Error(`Database request failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }
  if (response.status === 204) return [];
  return response.json();
}

async function dbAll(path, pageSize = 1000) {
  const output = [];
  for (let offset = 0; ; offset += pageSize) {
    const separator = path.includes('?') ? '&' : '?';
    const page = await db(`${path}${separator}limit=${pageSize}&offset=${offset}`);
    output.push(...(page || []));
    if (!Array.isArray(page) || page.length < pageSize) return output;
  }
}

function importMessageId(source, conversationId, item) {
  const explicit = text(item?.externalId || item?.id, 500);
  if (explicit) return explicit;
  return createHash('sha256').update(JSON.stringify({
    source, conversationId, author: item?.author_type, authorName: item?.author_name,
    createdAt: item?.created_at || item?.createdAt || null, body: item?.body || '', kind: item?.kind || 'message',
  })).digest('hex');
}

function importedAt(item) {
  const value = item?.created_at || item?.createdAt;
  const parsed = typeof value === 'string' ? new Date(value) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
}

function historyBound(values, mode, fallback = null) {
  const timestamps = values.filter(Boolean).map(value => new Date(value).getTime()).filter(Number.isFinite);
  if (!timestamps.length) return fallback;
  return new Date(mode === 'min' ? Math.min(...timestamps) : Math.max(...timestamps)).toISOString();
}

async function findThread(ownerId, id) {
  const rows = await db(`ai_workroom_threads?select=${encodeURIComponent(THREAD_FIELDS)}&id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(ownerId)}&limit=1`);
  return rows?.[0] || null;
}
async function getPayload(ownerId, id) {
  const thread = await findThread(ownerId, id);
  if (!thread) return null;
  const messages = await dbAll(`ai_workroom_messages?select=${encodeURIComponent(MESSAGE_FIELDS)}&thread_id=eq.${encodeURIComponent(id)}&order=created_at.asc,id.asc`);
  return { thread, messages: messages || [] };
}
async function dashboard(ownerId) {
  const [threads, projects, sources] = await Promise.all([
    dbAll(`ai_workroom_threads?select=${encodeURIComponent(THREAD_FIELDS)}&owner_id=eq.${encodeURIComponent(ownerId)}&order=updated_at.desc`),
    db(`ai_workroom_projects?select=id,name,repository,created_at,updated_at&owner_id=eq.${encodeURIComponent(ownerId)}&order=updated_at.desc&limit=50`),
    db(`ai_workroom_sources?select=source,status,last_synced_at,details&owner_id=eq.${encodeURIComponent(ownerId)}&order=source.asc`)
  ]);
  return { threads: threads || [], projects: projects || [], sources: sources || [] };
}
async function costDashboard(ownerId) {
  const [policies, usage] = await Promise.all([
    db(`ai_workroom_budget_policies?select=id,name,project_id,default_model_tier,daily_limit_cents,task_limit_cents,escalation_limit_cents,require_human_over_limit,active&owner_id=eq.${encodeURIComponent(ownerId)}&active=eq.true&order=created_at.asc`),
    db(`ai_workroom_model_usage?select=actor,provider,model,model_tier,purpose,input_tokens,output_tokens,estimated_cost_cents,outcome,created_at&owner_id=eq.${encodeURIComponent(ownerId)}&order=created_at.desc&limit=250`)
  ]);
  return { policies: policies || [], usage: usage || [] };
}
async function learningDashboard(ownerId) {
  const lessons = await db(`ai_workroom_lessons?select=id,title,lesson,product_area,intended_purpose,observed_behavior,value_assessment,confidence,status,applies_to,evidence_count,created_at,updated_at&owner_id=eq.${encodeURIComponent(ownerId)}&order=updated_at.desc&limit=100`);
  return { lessons: lessons || [] };
}

function replyBody(reply) {
  const lines = [text(reply?.summary, 4000)];
  const claims = Array.isArray(reply?.claims) ? reply.claims.slice(0, 8) : [];
  if (claims.length) lines.push('', ...claims.map(item => `• ${text(item?.statement, 1200)}`).filter(line => line !== '• '));
  const risks = Array.isArray(reply?.risks) ? reply.risks.slice(0, 5).map(item => text(typeof item === 'string' ? item : item?.risk || item?.statement, 800)).filter(Boolean) : [];
  if (risks.length) lines.push('', 'Risks:', ...risks.map(item => `• ${item}`));
  const questions = Array.isArray(reply?.questions) ? reply.questions.slice(0, 5).map(item => text(typeof item === 'string' ? item : item?.question, 800)).filter(Boolean) : [];
  if (questions.length) lines.push('', 'Open questions:', ...questions.map(item => `• ${item}`));
  return lines.filter((line, index) => line || index > 0).join('\n').trim() || 'No written response was returned.';
}

function reinaBody(report) {
  const consensus = Array.isArray(report?.consensus) ? report.consensus : [];
  const conflicts = Array.isArray(report?.conflicts) ? report.conflicts : [];
  const unresolved = Array.isArray(report?.unresolved) ? report.unresolved : [];
  const lines = ['Council discussion finished. Work status: NOT DONE until the machine-enforced completion gate passes.'];
  if (consensus.length) lines.push('', 'Agreed direction:', ...consensus.slice(0, 10).map(item => `• ${text(item?.topic, 300)} — ${text(item?.stance, 80)}`));
  if (conflicts.length) lines.push('', 'Differences to resolve:', ...conflicts.slice(0, 6).map(item => `• ${text(item?.topic, 300)}`));
  if (unresolved.length) lines.push('', 'Needs evidence:', ...unresolved.slice(0, 6).map(item => `• ${text(item?.topic, 300)}`));
  return lines.join('\n');
}

async function dispatchCouncil(req, threadId, messageId, brief, conversation, ownerId, role) {
  let statusCode = 500; let payload = {};
  const capture = {
    setHeader() {},
    status(code) { statusCode = code; return this; },
    json(value) { payload = value || {}; return this; },
  };
  const transcript = (conversation || []).slice(-24).map(item => `${item.author_name || item.author_type}: ${item.body}`).join('\n\n').slice(-12000);
  const councilReq = {
    ...req,
    // Node's IncomingMessage fields are not all enumerable, so spreading req
    // does not reliably carry headers into this internal handler call.
    headers: req?.headers || {},
    method: 'POST',
    query: {},
    body: {
      action: 'start',
      idempotencyKey: `workroom:${messageId}`,
      brief,
      evidence: transcript ? [{ sourceId: `workroom-${threadId}`, label: 'Recent AI Workroom conversation', content: transcript }] : [],
        // Reasoning models need enough room to emit the complete structured
        // Council envelope. Server and daily ceilings still bound spend.
        budget: { maxRounds: 1, maxTokensPerResponse: 4_000, maxCostCents: 100 },
      },
    };
  // The outer handler already resolved who this request is acting as -- via
  // a real bearer token, or the agent/desktop bridge secret, which carries no
  // bearer token at all. Re-deriving auth from req.headers here (as before)
  // worked for a signed-in admin but always failed the bridge path (no
  // bearer token -> 401) and any signed-in non-admin/superadmin (403),
  // silently sending "AI Council could not answer" for both. Passing the
  // already-resolved identity through preserves the same admin/superadmin
  // restriction without re-deriving it from headers that don't carry it.
  // Workroom conversation remains useful when one vendor is temporarily
  // unavailable. The direct Boardroom route keeps its three-director rule.
  await createCouncilHandler({
    minimumParticipants: 1,
    requireStaff: async () => (role === 'admin' || role === 'superadmin')
      ? { id: ownerId, role }
      : { id: ownerId, role, forbidden: true },
  })(councilReq, capture);
  if (statusCode < 200 || statusCode >= 300 || !payload.ok) throw new Error(text(payload.error, 500) || 'The AI Council did not complete.');
  return payload;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const bridgeAuthorized = req.method === 'POST'
    && Boolean(process.env.HIVELOGIC_WORKROOM_AGENT_SECRET)
    && req.headers['x-hivelogic-workroom-secret'] === process.env.HIVELOGIC_WORKROOM_AGENT_SECRET
    && Boolean(process.env.HIVELOGIC_WORKROOM_OWNER_ID);
  const auth = bridgeAuthorized ? null : await requireUser(req);
  if (!bridgeAuthorized && !auth) return respond(res, 401, { error: 'Sign in to use AI Workroom' });
  const ownerId = bridgeAuthorized ? process.env.HIVELOGIC_WORKROOM_OWNER_ID : auth.id;
  try {
    if (req.method === 'GET') {
      if (req.query?.cost === '1') return respond(res, 200, await costDashboard(ownerId));
      if (req.query?.learning === '1') return respond(res, 200, await learningDashboard(ownerId));
      if (req.query?.dashboard === '1' || req.query?.threads === '1') return respond(res, 200, await dashboard(ownerId));
      const id = text(req.query?.threadId, 80);
      if (!id) return respond(res, 400, { error: 'threadId is required' });
      const payload = await getPayload(ownerId, id);
      return payload ? respond(res, 200, payload) : respond(res, 404, { error: 'Workroom conversation not found' });
    }
    if (req.method !== 'POST') return respond(res, 405, { error: 'Method not allowed' });
    const action = text(req.body?.action, 40);
    if (action === 'create_thread') {
      const title = text(req.body?.title, 140) || 'New workroom conversation';
      const projectId = text(req.body?.projectId, 80) || null;
      const rows = await db('ai_workroom_threads', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ owner_id: ownerId, title, status: 'active', project_id: projectId }) });
      return respond(res, 201, { thread: rows?.[0] });
    }
    if (action === 'create_project') {
      const name = text(req.body?.name, 120); if (!name) return respond(res, 400, { error: 'A project name is required' });
      const rows = await db('ai_workroom_projects', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ owner_id: ownerId, name, repository: text(req.body?.repository, 500) || null }) });
      return respond(res, 201, { project: rows?.[0] });
    }
    if (action === 'create_budget_policy') {
      const name = text(req.body?.name, 120);
      const daily = Number(req.body?.dailyLimitCents); const task = Number(req.body?.taskLimitCents); const escalation = Number(req.body?.escalationLimitCents);
      if (!name || !Number.isInteger(daily) || !Number.isInteger(task) || !Number.isInteger(escalation) || daily < 0 || task < 0 || escalation < 0) return respond(res, 400, { error: 'A name and non-negative whole-cent limits are required' });
      const tier = text(req.body?.defaultModelTier, 20) || 'economy';
      if (!TIERS.has(tier)) return respond(res, 400, { error: 'Unknown model tier' });
      const rows = await db('ai_workroom_budget_policies', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ owner_id: ownerId, name, project_id: text(req.body?.projectId, 80) || null, default_model_tier: tier, daily_limit_cents: daily, task_limit_cents: task, escalation_limit_cents: escalation, require_human_over_limit: req.body?.requireHumanOverLimit === true }) });
      return respond(res, 201, { policy: rows?.[0] });
    }
    if (action === 'import_history') {
      if (!bridgeAuthorized) return respond(res, 403, { error: 'Agent authentication required' });
      const source = text(req.body?.source, 30); const title = text(req.body?.title, 140); const conversationId = text(req.body?.conversationId, 500); const items = Array.isArray(req.body?.messages) ? req.body.messages.slice(0, 500) : [];
      if (!SOURCES.has(source) || !title || !conversationId || !items.length) return respond(res, 400, { error: 'Source, conversationId, title, and imported messages are required' });
      const checkpoints = await db(`ai_workroom_import_checkpoints?select=id,thread_id,imported_count,history_started_at,history_ended_at&owner_id=eq.${encodeURIComponent(ownerId)}&source=eq.${encodeURIComponent(source)}&source_conversation_id=eq.${encodeURIComponent(conversationId)}&limit=1`);
      let thread = checkpoints?.[0] ? await findThread(ownerId, checkpoints[0].thread_id) : null;
      if (!thread) {
        const created = await db('ai_workroom_threads', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ owner_id: ownerId, title, status: 'active' }) });
        thread = created?.[0];
      }
      const messages = items.map(function (item) {
        const body = text(item?.body, 8000); if (!body) return null;
        const author = text(item?.author_type, 30).toLowerCase();
        return {
          thread_id: thread.id, author_type: IMPORT_AUTHORS.has(author) ? author : 'system', author_name: text(item?.author_name, 80) || source,
          body, kind: kind(item?.kind), task_state: taskState(item?.task_state), created_at: importedAt(item), source,
          source_conversation_id: conversationId, source_message_id: importMessageId(source, conversationId, item),
          metadata: { ...(item?.metadata && typeof item.metadata === 'object' ? item.metadata : {}), source, imported: true },
        };
      }).filter(Boolean);
      const inserted = messages.length ? await db('ai_workroom_messages?on_conflict=thread_id,source,source_message_id', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' }, body: JSON.stringify(messages) }) : [];
      const now = new Date().toISOString(); const checkpoint = checkpoints?.[0] || {}; const priorCount = Number(checkpoint.imported_count) || 0;
      const importedTimes = messages.map(item => item.created_at);
      await db('ai_workroom_import_checkpoints?on_conflict=owner_id,source,source_conversation_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify({
        owner_id: ownerId, thread_id: thread.id, source, source_conversation_id: conversationId, cursor: text(req.body?.cursor, 1000) || null,
        imported_count: priorCount + inserted.length,
        history_started_at: historyBound([checkpoint.history_started_at, ...importedTimes], 'min'),
        history_ended_at: historyBound([checkpoint.history_ended_at, ...importedTimes], 'max'),
        last_synced_at: now, last_error: null, updated_at: now,
      }) });
      await db('ai_workroom_sources?on_conflict=owner_id,source', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify({ owner_id: ownerId, source, status: 'connected', last_synced_at: now, details: { imported_count: priorCount + inserted.length, last_batch_received: messages.length, last_batch_inserted: inserted.length } }) });
      return respond(res, 201, { thread, received: messages.length, imported: inserted.length, duplicate: messages.length - inserted.length, cursor: text(req.body?.cursor, 1000) || null });
    }
    if (action === 'record_lesson') {
      if (!bridgeAuthorized) return respond(res, 403, { error: 'Agent authentication required' });
      const title = text(req.body?.title, 180); const lesson = text(req.body?.lesson, 5000); const confidence = Number(req.body?.confidence);
      if (!title || !lesson || !Number.isInteger(confidence) || confidence < 0 || confidence > 100) return respond(res, 400, { error: 'A title, lesson, and confidence from 0 to 100 are required' });
      const value = text(req.body?.valueAssessment, 30) || 'unknown';
      if (!['valuable', 'needs_improvement', 'not_useful', 'unknown'].includes(value)) return respond(res, 400, { error: 'Unknown value assessment' });
      const rows = await db('ai_workroom_lessons', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ owner_id: ownerId, title, lesson, product_area: text(req.body?.productArea, 180) || null, intended_purpose: text(req.body?.intendedPurpose, 3000) || null, observed_behavior: text(req.body?.observedBehavior, 3000) || null, value_assessment: value, confidence, applies_to: text(req.body?.appliesTo, 800) || null, evidence_count: Math.max(0, Number(req.body?.evidenceCount) || 0), status: confidence >= 85 ? 'active' : 'hypothesis' }) });
      return respond(res, 201, { lesson: rows?.[0] });
    }
    const id = text(req.body?.threadId, 80);
    if (!await findThread(ownerId, id)) return respond(res, 404, { error: 'Workroom conversation not found' });
    if (action === 'record_model_usage') {
      if (!bridgeAuthorized) return respond(res, 403, { error: 'Agent authentication required' });
      const actor = text(req.body?.actor, 20); const tier = text(req.body?.modelTier, 20); const cents = Number(req.body?.estimatedCostCents);
      if (!['codex', 'chatgpt', 'claude', 'claude_code', 'system'].includes(actor) || !TIERS.has(tier) || !Number.isInteger(cents) || cents < 0) return respond(res, 400, { error: 'Valid actor, tier, and non-negative cost are required' });
      const rows = await db('ai_workroom_model_usage', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ owner_id: ownerId, thread_id: id, policy_id: text(req.body?.policyId, 80) || null, actor, provider: text(req.body?.provider, 80) || actor, model: text(req.body?.model, 120) || 'unspecified', model_tier: tier, purpose: text(req.body?.purpose, 240) || 'workroom task', input_tokens: Number.isInteger(Number(req.body?.inputTokens)) ? Math.max(0, Number(req.body.inputTokens)) : 0, output_tokens: Number.isInteger(Number(req.body?.outputTokens)) ? Math.max(0, Number(req.body.outputTokens)) : 0, estimated_cost_cents: cents, outcome: text(req.body?.outcome, 20) || null }) });
      return respond(res, 201, { usage: rows?.[0] });
    }
    if (action === 'pin_thread') {
      await db(`ai_workroom_threads?id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(ownerId)}`, { method: 'PATCH', body: JSON.stringify({ pinned: Boolean(req.body?.pinned), updated_at: new Date().toISOString() }) });
      return respond(res, 200, { ok: true });
    }
    let message;
    if (action === 'send_message') {
      const body = text(req.body?.body, 8000);
      if (!body) return respond(res, 400, { error: 'A message is required' });
      message = { thread_id: id, author_type: 'user', author_name: 'Chris', body, kind: kind(req.body?.kind) };
    } else if (action === 'agent_update') {
      if (!bridgeAuthorized) return respond(res, 403, { error: 'Agent authentication required' });
      const author = text(req.body?.author, 20).toLowerCase(); const body = text(req.body?.body, 8000);
      if (!AGENTS.has(author) || !body) return respond(res, 400, { error: 'Valid agent and message are required' });
      const names = { codex: 'Codex', chatgpt: 'ChatGPT', claude: 'Claude', claude_code: 'Claude Code', grok: 'Grok', reina: 'Reina', system: 'HiveLogic' };
      message = { thread_id: id, author_type: author, author_name: names[author], body, kind: kind(req.body?.kind), task_state: taskState(req.body?.taskState), metadata: req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {} };
    } else return respond(res, 400, { error: 'Unknown action' });
    const rows = await db('ai_workroom_messages', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(message) });
    const source = text(req.body?.source, 30);
    if (SOURCES.has(source)) await db('ai_workroom_sources?on_conflict=owner_id,source', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ owner_id: ownerId, source, status: 'connected', last_synced_at: new Date().toISOString() }) });
    await db(`ai_workroom_threads?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ updated_at: new Date().toISOString(), status: message.task_state === 'blocked' ? 'waiting' : 'active' }) });
    if (action !== 'send_message') return respond(res, 201, { message: rows?.[0] });

    const userMessage = rows?.[0];
    try {
      const conversation = (await getPayload(ownerId, id))?.messages || [userMessage];
      const council = await dispatchCouncil(req, id, userMessage.id, userMessage.body, conversation, ownerId, bridgeAuthorized ? 'admin' : auth.role);
      const names = { chatgpt: 'ChatGPT', claude: 'Claude', grok: 'Grok' };
      const agentRows = (council.replies || []).map(reply => ({
        thread_id: id, author_type: reply.participant, author_name: names[reply.participant] || reply.participant,
        body: replyBody(reply), kind: 'message', metadata: { council_run_id: council.runId, round: reply.round, usage: reply.usage || null },
      }));
      const degraded = Array.isArray(council.degradedProviders) ? council.degradedProviders : [];
      if (degraded.length) agentRows.push({
        thread_id: id, author_type: 'system', author_name: 'HiveLogic', kind: 'status',
        body: `Response completed with ${degraded.map(name => name === 'chatgpt' ? 'ChatGPT' : name[0].toUpperCase() + name.slice(1)).join(' and ')} temporarily unavailable.`,
        metadata: { council_run_id: council.runId, degraded_providers: degraded, retryable: true },
      });
      agentRows.push({
        thread_id: id, author_type: 'reina', author_name: 'Reina', body: reinaBody(council.report), kind: 'decision',
        metadata: { council_run_id: council.runId, usage: council.usage || null },
      });
      const saved = await db('ai_workroom_messages', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(agentRows) });
      console.info('ai-workroom council completed', { threadId: id, runId: council.runId, replies: saved.length, costCents: council.usage?.totalCostCents });
      return respond(res, 201, { messages: [userMessage, ...saved], council: { runId: council.runId, usage: council.usage } });
    } catch (error) {
      console.error('ai-workroom council dispatch failed', { threadId: id, error: error?.message || String(error) });
      const statusRows = await db('ai_workroom_messages', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({
        thread_id: id, author_type: 'system', author_name: 'HiveLogic', kind: 'status', task_state: 'blocked',
        body: `Your message was saved, but the AI Council could not answer: ${text(error?.message, 500) || 'unknown error'}`,
        metadata: { retryable: true },
      }) });
      return respond(res, 202, { messages: [userMessage, ...(statusRows || [])], council: { ok: false } });
    }
  } catch (error) {
    console.error('ai-workroom failed', error?.message || error);
    return respond(res, 500, { error: 'AI Workroom is unavailable. Confirm its database migration is deployed.' });
  }
}
