// api/team.js — Vercel serverless function.
// Team management: edit and archive a hire. Auth-gated by the edge middleware
// (not on the public allowlist) + requireApiAuth here. Pay changes push through
// to the hire's linked Gusto compensation; archiving is non-destructive (sets
// an end date) and flags — never performs — a Gusto termination.

import { supabaseRequest } from './_lib/jobber.js';
import { requireApiAuth } from './_lib/guard.js';
import { updateGustoCompensation } from './_lib/gusto-provision.js';
import { gustoConnected } from './gusto/index.js';

const EDITABLE = ['display_name', 'pay_type', 'pay_class', 'base_rate', 'is_field', 'title'];

function pick(obj, fields) {
  const out = {};
  for (const f of fields) if (obj && obj[f] !== undefined) out[f] = obj[f];
  return out;
}

async function getHire(id) {
  const r = await supabaseRequest(`employee_pay?id=eq.${id}&limit=1`);
  if (!r.ok) throw new Error('hire read failed: ' + (await r.text()));
  return (await r.json())[0] || null;
}

export default async function handler(req, res) {
  const auth = await requireApiAuth(req);
  if (!auth.ok) return res.status(401).json({ ok: false, error: 'Not signed in.' });

  const resource = (req.query && req.query.resource) || '';
  const method = (req.method || 'GET').toUpperCase();
  const body = req.body || {};

  try {
    // ---- edit a hire (and push a pay change to Gusto) --------------------
    if (resource === 'hire_update' && (method === 'POST' || method === 'PATCH')) {
      const id = body.id;
      if (!id) return res.status(400).json({ ok: false, error: 'id is required.' });
      const before = await getHire(id);
      if (!before) return res.status(404).json({ ok: false, error: 'Hire not found.' });

      const patch = pick(body, EDITABLE);
      if (patch.pay_type && !['hourly', 'salary'].includes(patch.pay_type)) return res.status(400).json({ ok: false, error: 'pay_type must be hourly or salary.' });
      if (patch.pay_class && !['w2', '1099', 'owner'].includes(patch.pay_class)) return res.status(400).json({ ok: false, error: 'pay_class must be w2, 1099, or owner.' });
      if (patch.base_rate != null) patch.base_rate = Number(patch.base_rate) || 0;

      const upd = await supabaseRequest(`employee_pay?id=eq.${id}`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch),
      });
      if (!upd.ok) throw new Error('hire update failed: ' + (await upd.text()));
      const item = (await upd.json())[0];

      // Push a pay change to Gusto when the hire is linked and a rate/type moved.
      let gusto_push = null;
      const payChanged = (patch.pay_type && patch.pay_type !== before.pay_type)
        || (patch.base_rate != null && Number(patch.base_rate) !== Number(before.base_rate));
      if (payChanged && before.gusto_job_uuid && body.push_gusto !== false) {
        try {
          if (await gustoConnected()) {
            gusto_push = await updateGustoCompensation({
              gusto_job_uuid: before.gusto_job_uuid,
              pay_type: patch.pay_type || before.pay_type,
              rate: patch.base_rate != null ? patch.base_rate : before.base_rate,
            });
          } else {
            gusto_push = { ok: false, error: 'Gusto not connected — HiveLogic updated, Gusto not.' };
          }
        } catch (e) { gusto_push = { ok: false, error: e.message }; }
      }
      return res.status(200).json({ ok: true, item, gusto_push });
    }

    // ---- archive a hire (non-destructive; flag Gusto termination) --------
    if (resource === 'hire_archive' && method === 'POST') {
      const id = body.id;
      if (!id) return res.status(400).json({ ok: false, error: 'id is required.' });
      const before = await getHire(id);
      if (!before) return res.status(404).json({ ok: false, error: 'Hire not found.' });

      const today = new Date().toISOString().slice(0, 10);
      const upd = await supabaseRequest(`employee_pay?id=eq.${id}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ effective_to: today }),
      });
      if (!upd.ok) throw new Error('hire archive failed: ' + (await upd.text()));

      return res.status(200).json({
        ok: true, archived: true,
        gusto_termination_needed: Boolean(before.gusto_employee_uuid),
        gusto_employee_uuid: before.gusto_employee_uuid || null,
        note: before.gusto_employee_uuid
          ? 'Archived in HiveLogic. Terminate them in Gusto to stop payroll — this never auto-terminates.'
          : 'Archived in HiveLogic. No linked Gusto employee.',
      });
    }

    return res.status(404).json({ ok: false, error: `Unknown resource/method: ${resource} ${method}` });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
