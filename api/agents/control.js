import { supabaseRequest } from '../_lib/jobber.js';
import { TENANT_ID, requireStaff, sendAuthError, taskScopeHash, validateTask, audit } from '../_lib/agents/security.js';

async function patchAgent(id, patch) {
  return supabaseRequest(`automation_agents?id=eq.${encodeURIComponent(id)}&tenant_id=eq.${TENANT_ID}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
}

export async function recordTaskDecision({ request = supabaseRequest, task, approved, staffId, reason = null }) {
  const approvalRes = await request('automation_task_approvals', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify([{
      tenant_id: TENANT_ID,
      task_id: task.id,
      scope_hash: task.scope_hash,
      decision: approved ? 'approved' : 'rejected',
      decided_by: staffId,
      reason,
    }]),
  });
  if (!approvalRes.ok) {
    return { ok: false, error: 'Approval decision was not saved; task remains blocked.' };
  }
  const taskPatchRes = await request(
    `automation_tasks?id=eq.${task.id}&tenant_id=eq.${TENANT_ID}&status=eq.pending_approval`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        status: approved ? 'queued' : 'blocked',
        approved_at: approved ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      }),
    }
  );
  const changedRows = taskPatchRes.ok ? await taskPatchRes.json() : [];
  if (!taskPatchRes.ok || !changedRows[0]) {
    return { ok: false, error: 'Decision was recorded, but task state did not change; task remains blocked.' };
  }
  return { ok: true };
}

export default async function handler(req, res) {
  const staff = await requireStaff(req);
  if (!staff || staff.forbidden) return sendAuthError(res, staff);

  if (req.method === 'GET') {
    const agentsRes = await supabaseRequest(`automation_agents?tenant_id=eq.${TENANT_ID}&select=*&order=created_at.desc`);
    const tasksRes = await supabaseRequest(`automation_tasks?tenant_id=eq.${TENANT_ID}&select=*&order=created_at.desc&limit=100`);
    if (!agentsRes.ok || !tasksRes.ok) return res.status(500).json({ ok: false, error: 'Could not load devices.' });
    return res.status(200).json({ ok: true, agents: await agentsRes.json(), tasks: await tasksRes.json() });
  }

  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  const body = req.body || {};
  const action = String(body.action || '');

  if (action === 'create_task') {
    const checked = validateTask(body.taskType, body.payload);
    if (!checked.ok) return res.status(400).json({ ok: false, error: checked.error });
    const agentId = String(body.agentId || '');
    const agentRes = await supabaseRequest(`automation_agents?id=eq.${encodeURIComponent(agentId)}&tenant_id=eq.${TENANT_ID}&revoked_at=is.null&select=id,status&limit=1`);
    const agents = agentRes.ok ? await agentRes.json() : [];
    if (!agents[0]) return res.status(404).json({ ok: false, error: 'Device not found.' });
    if (['paused','emergency_stopped','revoked'].includes(agents[0].status)) return res.status(409).json({ ok: false, error: 'Device is not accepting tasks.' });
    const scopeHash = taskScopeHash({ agentId, taskType: body.taskType, payload: checked.payload });
    const status = checked.approvalRequired ? 'pending_approval' : 'queued';
    const inserted = await supabaseRequest('automation_tasks', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify([{ tenant_id: TENANT_ID, agent_id: agentId, task_type: body.taskType, payload: checked.payload, scope_hash: scopeHash, risk_tier: checked.riskTier, status, created_by: staff.id }]),
    });
    const rows = inserted.ok ? await inserted.json() : [];
    if (!rows[0]) return res.status(500).json({ ok: false, error: 'Could not create task.' });
    await audit({ agentId, taskId: rows[0].id, eventType: 'task.created', data: { taskType: body.taskType, status } });
    return res.status(201).json({ ok: true, task: rows[0] });
  }

  if (action === 'approve_task' || action === 'reject_task') {
    const taskId = String(body.taskId || '');
    const taskRes = await supabaseRequest(`automation_tasks?id=eq.${encodeURIComponent(taskId)}&tenant_id=eq.${TENANT_ID}&status=eq.pending_approval&select=*&limit=1`);
    const tasks = taskRes.ok ? await taskRes.json() : [];
    if (!tasks[0]) return res.status(409).json({ ok: false, error: 'Task is not awaiting approval.' });
    const approved = action === 'approve_task';
    const decision = await recordTaskDecision({
      task: tasks[0],
      approved,
      staffId: staff.id,
      reason: body.reason || null,
    });
    if (!decision.ok) return res.status(500).json(decision);
    await audit({ agentId: tasks[0].agent_id, taskId, eventType: approved ? 'task.approved' : 'task.rejected' });
    return res.status(200).json({ ok: true });
  }

  if (['pause','resume','emergency_stop','revoke'].includes(action)) {
    const agentId = String(body.agentId || '');
    const now = new Date().toISOString();
    const patches = {
      pause: { status: 'paused', paused_at: now },
      resume: { status: 'offline', paused_at: null, emergency_stopped_at: null },
      emergency_stop: { status: 'emergency_stopped', emergency_stopped_at: now },
      revoke: { status: 'revoked', revoked_at: now },
    };
    const changed = await patchAgent(agentId, patches[action]);
    if (!changed.ok) return res.status(500).json({ ok: false, error: 'Could not update device.' });
    if (action === 'emergency_stop') {
      await supabaseRequest(`automation_tasks?agent_id=eq.${agentId}&status=in.(queued,claimed,running)`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'cancel_requested', updated_at: now }),
      });
    }
    if (action === 'revoke') {
      await supabaseRequest(`automation_agent_credentials?agent_id=eq.${agentId}&revoked_at=is.null`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ revoked_at: now }),
      });
    }
    await audit({ agentId, eventType: `agent.${action}`, message: body.reason || null });
    return res.status(200).json({ ok: true });
  }

  if (action === 'rotate_credential') {
    return res.status(409).json({
      ok: false,
      error: 'Credential rotation is disabled until the installed-agent rotation handshake is implemented.',
    });
  }

  if (action === 'cancel_task') {
    const taskId = String(body.taskId || '');
    await supabaseRequest(`automation_tasks?id=eq.${taskId}&tenant_id=eq.${TENANT_ID}&status=in.(queued,claimed,running)`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'cancel_requested', updated_at: new Date().toISOString() }),
    });
    await audit({ taskId, eventType: 'task.cancel_requested' });
    return res.status(200).json({ ok: true });
  }
  return res.status(400).json({ ok: false, error: 'Unsupported action.' });
}
