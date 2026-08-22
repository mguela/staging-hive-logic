import crypto from 'node:crypto';
import { supabaseRequest } from '../jobber.js';

export const TENANT_ID = process.env.HIVELOGIC_TENANT_ID || 'ghgrp';
export const TASK_TYPES = Object.freeze({
  repository_status: { riskTier: 'read_only', approvalRequired: false },
  repository_test: { riskTier: 'read_only', approvalRequired: true },
});

export function randomSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function taskScopeHash({ agentId, taskType, payload }) {
  return hashSecret(canonicalJson({ agentId, taskType, payload }));
}

export function validateTask(taskType, payload) {
  const schema = TASK_TYPES[taskType];
  if (!schema) return { ok: false, error: 'Unsupported task type.' };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'Task payload must be an object.' };
  }
  const path = String(payload.path || '').trim();
  if (!path || path.length > 500) return { ok: false, error: 'An approved path is required.' };
  if (payload.command || payload.shell || payload.script) {
    return { ok: false, error: 'Arbitrary commands, shells, and scripts are not supported.' };
  }
  return { ok: true, ...schema, payload: { ...payload, path } };
}

export async function requireUser(req) {
  const raw = req.headers.authorization || req.headers.Authorization || '';
  const token = raw.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!userRes.ok) return null;
  const user = await userRes.json();
  const profRes = await supabaseRequest(`profiles?id=eq.${encodeURIComponent(user.id)}&select=id,email,full_name,role&limit=1`);
  const rows = profRes.ok ? await profRes.json() : [];
  return rows[0] || { id: user.id, email: user.email, role: null };
}

export async function requireStaff(req, allowedRoles = ['admin', 'superadmin']) {
  const profile = await requireUser(req);
  if (!profile) return null;
  if (!allowedRoles.includes(profile.role)) return { ...profile, forbidden: true };
  return profile;
}

export async function requireAgent(req) {
  const raw = req.headers.authorization || req.headers.Authorization || '';
  const token = raw.replace(/^Agent\s+/i, '').trim();
  const split = token.indexOf('.');
  if (split < 1) return null;
  const agentId = token.slice(0, split);
  const secretHash = hashSecret(token.slice(split + 1));
  const credRes = await supabaseRequest(
    `automation_agent_credentials?agent_id=eq.${encodeURIComponent(agentId)}&secret_hash=eq.${secretHash}&revoked_at=is.null&select=id,agent_id,expires_at&limit=1`
  );
  const creds = credRes.ok ? await credRes.json() : [];
  const credential = creds[0];
  if (!credential || (credential.expires_at && new Date(credential.expires_at) <= new Date())) return null;
  const agentRes = await supabaseRequest(
    `automation_agents?id=eq.${encodeURIComponent(agentId)}&tenant_id=eq.${encodeURIComponent(TENANT_ID)}&revoked_at=is.null&select=*&limit=1`
  );
  const agents = agentRes.ok ? await agentRes.json() : [];
  if (!agents[0]) return null;
  await supabaseRequest(`automation_agent_credentials?id=eq.${credential.id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ last_used_at: new Date().toISOString() }),
  });
  return agents[0];
}

export async function audit({ agentId = null, taskId = null, eventType, level = 'info', message = null, data = {} }) {
  await supabaseRequest('automation_task_events', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify([{ tenant_id: TENANT_ID, agent_id: agentId, task_id: taskId, event_type: eventType, level, message, data }]),
  });
}

export function sendAuthError(res, actor) {
  if (!actor) return res.status(401).json({ ok: false, error: 'Authentication required.' });
  return res.status(403).json({ ok: false, error: 'Owner/admin permission required.' });
}
