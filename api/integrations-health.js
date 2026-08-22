import { requireApiAuth } from './_lib/guard.js';
import { supabaseRequest } from './_lib/jobber.js';
import { buildIntegrationHealth } from './_lib/integration-health.js';

export async function handleIntegrationHealth(req, res, dependencies = {}) {
  const requireAuth = dependencies.requireAuth || requireApiAuth;
  const readSupabase = dependencies.supabase || supabaseRequest;
  const env = dependencies.env || process.env;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  const auth = await requireAuth(req);
  if (!auth.ok || !auth.user) {
    return res.status(401).json({ ok: false, error: 'Sign in to view integration health.' });
  }

  try {
    // Deliberately excludes access_token and refresh_token. This endpoint is
    // an inventory/health surface, never a secret-reading surface.
    const response = await readSupabase(
      'integrations?select=key,expires_at,updated_at,realm_id,environment&order=key.asc'
    );
    if (!response.ok) {
      return res.status(502).json({ ok: false, error: 'Could not read integration metadata.' });
    }
    const rows = await response.json();
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(buildIntegrationHealth({ rows, env }));
  } catch {
    return res.status(502).json({ ok: false, error: 'Could not read integration metadata.' });
  }
}

export default function handler(req, res) {
  return handleIntegrationHealth(req, res);
}
