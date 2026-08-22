import { supabaseRequest } from '../_lib/jobber.js';
import { TENANT_ID, hashSecret, randomSecret, requireStaff, sendAuthError, audit } from '../_lib/agents/security.js';

export async function claimEnrollmentCode(codeRecord, request = supabaseRequest) {
  const claimRes = await request(
    `automation_enrollment_codes?id=eq.${codeRecord.id}&used_at=is.null`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ used_at: new Date().toISOString() }),
    }
  );
  const claimedCodes = claimRes.ok ? await claimRes.json() : [];
  return claimedCodes[0] || null;
}

export function isEnrollmentCodeUsable(codeRecord, now = new Date()) {
  if (!codeRecord || codeRecord.used_at || !codeRecord.expires_at) return false;
  const expiresAt = new Date(codeRecord.expires_at);
  return Number.isFinite(expiresAt.getTime()) && expiresAt > now;
}

export default async function handler(req, res) {
  if (req.method === 'POST' && req.query.action === 'create') {
    const staff = await requireStaff(req);
    if (!staff || staff.forbidden) return sendAuthError(res, staff);
    const code = randomSecret(24);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const insert = await supabaseRequest('automation_enrollment_codes', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify([{ tenant_id: TENANT_ID, code_hash: hashSecret(code), created_by: staff.id, expires_at: expiresAt }]),
    });
    if (!insert.ok) return res.status(500).json({ ok: false, error: 'Could not create enrollment code.' });
    return res.status(201).json({ ok: true, enrollmentCode: code, expiresAt });
  }

  if (req.method === 'POST' && req.query.action === 'consume') {
    const body = req.body || {};
    const code = String(body.enrollmentCode || '');
    const hostname = String(body.hostname || '').trim().slice(0, 200);
    const displayName = String(body.displayName || hostname).trim().slice(0, 200);
    if (!code || !hostname || !displayName) return res.status(400).json({ ok: false, error: 'Enrollment code, hostname, and display name are required.' });
    const codeRes = await supabaseRequest(
      `automation_enrollment_codes?code_hash=eq.${hashSecret(code)}&used_at=is.null&select=*&limit=1`
    );
    const codes = codeRes.ok ? await codeRes.json() : [];
    if (!isEnrollmentCodeUsable(codes[0])) {
      return res.status(401).json({ ok: false, error: 'Enrollment code is invalid, expired, or already used.' });
    }
    const claimedCode = await claimEnrollmentCode(codes[0]);
    if (!claimedCode) {
      return res.status(401).json({ ok: false, error: 'Enrollment code is invalid, expired, or already used.' });
    }

    const existingRes = await supabaseRequest(
      `automation_agents?tenant_id=eq.${TENANT_ID}&hostname=eq.${encodeURIComponent(hostname)}&select=id,status&limit=1`
    );
    const existing = existingRes.ok ? await existingRes.json() : [];
    if (existing[0]) {
      return res.status(409).json({
        ok: false,
        error: 'This hostname is already registered. Re-enrollment and credential sharing are not allowed.',
      });
    }
    const agentRecord = { tenant_id: TENANT_ID, hostname, display_name: displayName, platform: 'windows', agent_version: body.agentVersion || null, capabilities: body.capabilities || [], created_by: codes[0].created_by, status: 'offline', revoked_at: null, paused_at: null, emergency_stopped_at: null };
    const agentRes = await supabaseRequest('automation_agents', {
      method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify([agentRecord]),
    });
    const agents = agentRes.ok ? await agentRes.json() : [];
    if (!agents[0]) return res.status(500).json({ ok: false, error: 'Could not register device.' });
    const secret = randomSecret();
    const credentialRes = await supabaseRequest('automation_agent_credentials', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify([{ tenant_id: TENANT_ID, agent_id: agents[0].id, secret_hash: hashSecret(secret) }]),
    });
    if (!credentialRes.ok) return res.status(500).json({ ok: false, error: 'Could not issue device credential.' });
    const scopes = Array.isArray(body.approvedScopes) ? body.approvedScopes.slice(0, 50) : [];
    if (scopes.length) {
      const validPermissions = new Set(['read','test']);
      const permissionRows = scopes
        .filter(s => s && ['folder','repository'].includes(s.type) && String(s.path || '').trim())
        .map(s => ({
          tenant_id: TENANT_ID,
          agent_id: agents[0].id,
          scope_type: s.type,
          canonical_path: String(s.path).trim().slice(0, 500),
          permissions: (Array.isArray(s.permissions) ? s.permissions : []).filter(p => validPermissions.has(p)),
          approved_by: codes[0].created_by,
        }));
      if (permissionRows.length) {
        await supabaseRequest(`automation_agent_permissions?agent_id=eq.${agents[0].id}`, {
          method: 'DELETE', headers: { Prefer: 'return=minimal' },
        });
        await supabaseRequest('automation_agent_permissions', {
          method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(permissionRows),
        });
      }
    }
    await audit({ agentId: agents[0].id, eventType: 'agent.enrolled', message: 'Windows agent enrolled.' });
    return res.status(201).json({ ok: true, agent: agents[0], credential: `${agents[0].id}.${secret}` });
  }
  return res.status(405).json({ ok: false, error: 'Method not allowed.' });
}
