// api/bookkeeping/ledger/entries.js — Vercel serverless function.
// GET: list journal entries for the authenticated actor's company.
// POST: create a journal entry (status starts 'pending_approval' -- see
// approve.js / post.js for the rest of the create -> approve -> post
// lifecycle server/bookkeeping/src/ledger.js enforces).
//
// QBO writes are never made here. This route only ever creates a LOCAL,
// unposted-until-approved journal entry in the ported general ledger.

let _load_ledger_cache;
async function _load_ledger() {
  if (!_load_ledger_cache) _load_ledger_cache = await import('../../../server/bookkeeping/src/ledger.js');
  return _load_ledger_cache;
}
import { getSystem, updateSystem } from './_store.js';
import { getTrustedActor } from './_actor.js';
import { guardBookkeepingRequest } from '../_security.js';

export default async function handler(req, res) {
  if (!guardBookkeepingRequest(req, res)) return;

  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  try {
    const { createEntry } = await _load_ledger();
        if (req.method === 'GET') {
      const system = await getSystem(actor.companyId);
      const company = system.ledger.companies[actor.companyId];
      res.status(200).json({ ok: true, entries: company?.entries || [], accounts: Object.values(company?.accounts || {}) });
      return;
    }
    if (req.method !== 'POST') { res.status(405).json({ error: 'Only GET and POST are supported.' }); return; }

    const input = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    let created = null;
    const next = await updateSystem(actor.companyId, system => {
      created = createEntry(system.ledger, { ...input, companyId: actor.companyId }, { id: actor.id, role: actor.role });
      return system;
    });
    res.status(200).json({ ok: true, entry: created, qboWritesEnabled: false, note: 'Created as pending approval. No QBO write occurred.' });
  } catch (error) {
    res.status(422).json({ ok: false, error: error.message || 'Could not process this journal entry request.' });
  }
}
