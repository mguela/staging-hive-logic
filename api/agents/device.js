import { supabaseRequest } from '../_lib/jobber.js';
import { TENANT_ID, requireAgent, audit } from '../_lib/agents/security.js';

function cleanLog(value) {
  return String(value || '')
    .replace(/(token|secret|password|authorization)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .slice(0, 12000);
}

export default async function handler(req, res) {
  const agent = await requireAgent(req);
  if (!agent) return res.status(401).json({ ok: false, error: 'Invalid or revoked device credential.' });
  const body = req.body || {};
  const action = String(req.query.action || body.action || '');
  const now = new Date().toISOString();

  if (action === 'heartbeat' && req.method === 'POST') {
    const effectiveStatus = agent.emergency_stopped_at ? 'emergency_stopped' : agent.paused_at ? 'paused' : 'online';
    let cancelRequested = false;
    if (body.currentTaskId) {
      const taskRes = await supabaseRequest(
        `automation_tasks?id=eq.${encodeURIComponent(body.currentTaskId)}&agent_id=eq.${agent.id}&select=status&limit=1`
      );
      const tasks = taskRes.ok ? await taskRes.json() : [];
      cancelRequested = tasks[0]?.status === 'cancel_requested';
      if (tasks[0] && !cancelRequested) {
        await supabaseRequest(`automation_tasks?id=eq.${encodeURIComponent(body.currentTaskId)}&agent_id=eq.${agent.id}&status=in.(claimed,running)`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            lease_expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
            updated_at: now,
          }),
        });
      }
    }
    await supabaseRequest(`automation_agents?id=eq.${agent.id}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: effectiveStatus, last_heartbeat_at: now, agent_version: body.agentVersion || agent.agent_version, capabilities: body.capabilities || agent.capabilities, updated_at: now }),
    });
    return res.status(200).json({ ok: true, status: effectiveStatus, emergencyStop: !!agent.emergency_stopped_at, paused: !!agent.paused_at, cancelRequested });
  }

  if (action === 'poll' && req.method === 'GET') {
    if (agent.paused_at || agent.emergency_stopped_at) return res.status(200).json({ ok: true, task: null, paused: !!agent.paused_at, emergencyStop: !!agent.emergency_stopped_at });
    const taskRes = await supabaseRequest(`automation_tasks?agent_id=eq.${agent.id}&tenant_id=eq.${TENANT_ID}&status=eq.queued&select=*&order=created_at.asc&limit=1`);
    const tasks = taskRes.ok ? await taskRes.json() : [];
    if (!tasks[0]) return res.status(200).json({ ok: true, task: null });
    const task = tasks[0];
    const claimed = await supabaseRequest(`automation_tasks?id=eq.${task.id}&status=eq.queued`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ status: 'claimed', claimed_at: now, lease_expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(), updated_at: now }),
    });
    const rows = claimed.ok ? await claimed.json() : [];
    if (!rows[0]) return res.status(200).json({ ok: true, task: null });
    await audit({ agentId: agent.id, taskId: task.id, eventType: 'task.claimed' });
    return res.status(200).json({ ok: true, task: rows[0] });
  }

  if (action === 'event' && req.method === 'POST') {
    const taskId = String(body.taskId || '');
    const allowed = ['started','progress','succeeded','failed','cancelled','blocked'];
    if (!allowed.includes(body.event)) return res.status(400).json({ ok: false, error: 'Invalid event.' });
    const statusMap = { started: 'running', succeeded: 'succeeded', failed: 'failed', cancelled: 'cancelled', blocked: 'blocked' };
    const patch = { updated_at: now };
    if (statusMap[body.event]) patch.status = statusMap[body.event];
    if (body.event === 'started') patch.started_at = now;
    if (['succeeded','failed','cancelled','blocked'].includes(body.event)) patch.completed_at = now;
    if (body.summary) patch.result_summary = cleanLog(body.summary).slice(0, 1000);
    const taskRes = await supabaseRequest(`automation_tasks?id=eq.${taskId}&agent_id=eq.${agent.id}`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch),
    });
    const tasks = taskRes.ok ? await taskRes.json() : [];
    if (!tasks[0]) return res.status(404).json({ ok: false, error: 'Task not found for this device.' });
    await audit({ agentId: agent.id, taskId, eventType: `task.${body.event}`, level: body.event === 'failed' ? 'error' : 'info', message: cleanLog(body.message), data: body.data || {} });
    return res.status(200).json({ ok: true });
  }
  return res.status(405).json({ ok: false, error: 'Method not allowed.' });
}
