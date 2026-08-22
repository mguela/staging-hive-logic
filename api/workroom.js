import { requireUser } from './_lib/agents/security.js';
import { evaluateTaskCompletion } from './_lib/completion-gate.js';
import { supabaseRequest } from './_lib/jobber.js';

const AGENTS = new Set(['codex', 'chatgpt', 'claude', 'claude_code', 'grok', 'reina']);
const LANES = new Set(['green', 'yellow', 'red']);
const TIERS = new Set(['economy', 'standard', 'expert']);
const STATUSES = new Set(['queued', 'claimed', 'working', 'review', 'blocked', 'done', 'cancelled']);
const EVENTS = new Set(['created', 'claimed', 'started', 'evidence', 'review_requested', 'reviewed', 'response', 'gate_passed', 'gate_failed', 'blocked', 'completed', 'cost_escalated']);
const EVIDENCE = new Set(['test', 'crawler', 'preview', 'diff', 'review', 'deployment', 'cost']);
const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const integer = (value, fallback = 0) => Number.isInteger(Number(value)) ? Number(value) : fallback;
const reply = (res, status, payload) => res.status(status).json(payload);
async function db(path, options) {
  const response = await supabaseRequest(path, options);
  if (!response.ok) throw new Error(`Database request failed (${response.status})`);
  if (response.status === 204) return [];
  return response.json();
}

function bridgeAllowed(req) {
  return req.method === 'POST' && Boolean(process.env.HIVELOGIC_WORKROOM_AGENT_SECRET) && req.headers['x-hivelogic-workroom-secret'] === process.env.HIVELOGIC_WORKROOM_AGENT_SECRET && Boolean(process.env.HIVELOGIC_WORKROOM_OWNER_ID);
}
async function owner(req, bridge) {
  if (bridge) return process.env.HIVELOGIC_WORKROOM_OWNER_ID;
  const auth = await requireUser(req);
  return auth ? auth.id : null;
}
async function findTask(ownerId, taskId) {
  const rows = await db(`workroom_tasks?select=*&owner_id=eq.${encodeURIComponent(ownerId)}&id=eq.${encodeURIComponent(taskId)}&limit=1`);
  return rows?.[0] || null;
}
async function taskPacket(ownerId, taskId) {
  const task = await findTask(ownerId, taskId);
  if (!task) return null;
  const [events, evidence] = await Promise.all([
    db(`workroom_events?select=*&task_id=eq.${encodeURIComponent(taskId)}&order=created_at.asc`),
    db(`workroom_evidence?select=*&task_id=eq.${encodeURIComponent(taskId)}&order=evidence_sequence.asc`)
  ]);
  return { task, events: events || [], evidence: evidence || [] };
}

async function certifyTask(ownerId, task) {
  const evidence = await db(`workroom_evidence?select=actor,evidence_type,verdict,summary,reference,created_at,evidence_sequence&owner_id=eq.${encodeURIComponent(ownerId)}&task_id=eq.${encodeURIComponent(task.id)}&order=evidence_sequence.asc`);
  return evaluateTaskCompletion({ task, evidence: evidence || [] });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const bridge = bridgeAllowed(req); const ownerId = await owner(req, bridge);
  if (!ownerId) return reply(res, 401, { error: 'Staff or agent authentication required' });
  try {
    if (req.method === 'GET') {
      const taskId = text(req.query?.taskId, 80);
      if (taskId) { const packet = await taskPacket(ownerId, taskId); return packet ? reply(res, 200, packet) : reply(res, 404, { error: 'Task not found' }); }
      const tasks = await db(`workroom_tasks?select=*&owner_id=eq.${encodeURIComponent(ownerId)}&order=priority.desc,updated_at.asc&limit=200`);
      return reply(res, 200, { tasks: tasks || [] });
    }
    if (req.method !== 'POST') return reply(res, 405, { error: 'Method not allowed' });
    const action = text(req.body?.action, 40);
    if (action === 'create_task') {
      const title = text(req.body?.title, 240); const lane = text(req.body?.lane, 20) || 'green'; const tier = text(req.body?.modelTier, 20) || 'economy';
      if (!title || !LANES.has(lane) || !TIERS.has(tier)) return reply(res, 400, { error: 'Title, lane, and model tier are required' });
      const seq = Date.now().toString().slice(-9);
      const rows = await db('workroom_tasks', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ owner_id: ownerId, task_key: `WR-${seq}`, title, specification: text(req.body?.specification, 12000), lane, priority: Math.min(100, Math.max(1, integer(req.body?.priority, 50))), assigned_agent: AGENTS.has(req.body?.assignedAgent) ? req.body.assignedAgent : null, model_tier: tier, estimated_cost_cents: Math.max(0, integer(req.body?.estimatedCostCents)), requires_review: req.body?.requiresReview !== false }) });
      const task = rows?.[0];
      await db('workroom_events', { method: 'POST', body: JSON.stringify({ owner_id: ownerId, task_id: task.id, actor: bridge ? 'system' : 'user', event_type: 'created', body: 'Task created with cost-aware model routing.' }) });
      return reply(res, 201, { task });
    }
    const taskId = text(req.body?.taskId, 80); const task = await findTask(ownerId, taskId);
    if (!task) return reply(res, 404, { error: 'Task not found' });
    if (!bridge && action !== 'update_task') return reply(res, 403, { error: 'Agent authentication required' });
    if (action === 'update_task') {
      const status = text(req.body?.status, 20); if (!STATUSES.has(status)) return reply(res, 400, { error: 'Unknown status' });
      let gate = null;
      if (status === 'done') {
        const checked = await certifyTask(ownerId, task);
        if (!checked.ok) return reply(res, 409, { error: 'Work is NOT DONE. The completion gate failed.', completionGate: checked.gate });
        gate = checked.gate;
      }
      const patch = status === 'done'
        ? { status, updated_at: new Date().toISOString(), completed_at: gate.receipt.verifiedAt, verified_at: gate.receipt.verifiedAt, verification_status: 'verified_complete', completion_fingerprint: gate.receipt.fingerprint, completion_receipt: gate.receipt }
        : { status, updated_at: new Date().toISOString(), completed_at: null, verified_at: null, verification_status: 'unverified', completion_fingerprint: null, completion_receipt: null };
      await db(`workroom_tasks?id=eq.${encodeURIComponent(taskId)}&owner_id=eq.${encodeURIComponent(ownerId)}`, { method: 'PATCH', body: JSON.stringify(patch) });
      return reply(res, 200, { ok: true, completionGate: gate });
    }
    if (action === 'add_evidence') {
      const actor = text(req.body?.actor, 20); const type = text(req.body?.evidenceType, 20); const verdict = text(req.body?.verdict, 20); const summary = text(req.body?.summary, 4000);
      if (!AGENTS.has(actor) || !EVIDENCE.has(type) || !['pass', 'fail', 'risk', 'info'].includes(verdict) || !summary) return reply(res, 400, { error: 'Valid evidence is required' });
      const rows = await db('workroom_evidence', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ owner_id: ownerId, task_id: taskId, actor, evidence_type: type, verdict, summary, reference: text(req.body?.reference, 1000) || null }) });
      await db('workroom_events', { method: 'POST', body: JSON.stringify({ owner_id: ownerId, task_id: taskId, actor, event_type: 'evidence', body: summary }) });
      return reply(res, 201, { evidence: rows?.[0] });
    }
    if (action === 'post_review') {
      const actor = text(req.body?.actor, 20); const body = text(req.body?.body, 8000); const eventType = text(req.body?.eventType, 20) || 'reviewed';
      if (!AGENTS.has(actor) || !body || !['review_requested', 'reviewed', 'response', 'gate_passed', 'gate_failed', 'blocked', 'completed', 'cost_escalated'].includes(eventType)) return reply(res, 400, { error: 'Valid review event is required' });
      let gate = null;
      if (eventType === 'completed') {
        const checked = await certifyTask(ownerId, task);
        if (!checked.ok) return reply(res, 409, { error: 'Work is NOT DONE. The completion gate failed.', completionGate: checked.gate });
        gate = checked.gate;
      }
      const rows = await db('workroom_events', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ owner_id: ownerId, task_id: taskId, actor, event_type: eventType, body, metadata: gate ? { completionReceipt: gate.receipt } : (req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {}) }) });
      const status = eventType === 'review_requested' ? 'review' : eventType === 'blocked' || eventType === 'gate_failed' ? 'blocked' : eventType === 'completed' ? 'done' : task.status;
      const patch = status === 'done'
        ? { status, updated_at: new Date().toISOString(), completed_at: gate.receipt.verifiedAt, verified_at: gate.receipt.verifiedAt, verification_status: 'verified_complete', completion_fingerprint: gate.receipt.fingerprint, completion_receipt: gate.receipt }
        : { status, updated_at: new Date().toISOString() };
      await db(`workroom_tasks?id=eq.${encodeURIComponent(taskId)}`, { method: 'PATCH', body: JSON.stringify(patch) });
      return reply(res, 201, { event: rows?.[0], status, completionGate: gate });
    }
    return reply(res, 400, { error: 'Unknown action' });
  } catch (error) {
    console.error('workroom failed', error?.message || error);
    return reply(res, 500, { error: 'Workroom task ledger is unavailable.' });
  }
}
