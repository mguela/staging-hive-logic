// api/bookkeeping/ledger/approve.js — approves a pending journal entry.
// Separation of duties is enforced inside approveEntry() itself: the
// creator can never approve their own entry.

let _load_ledger_cache;
async function _load_ledger() {
  if (!_load_ledger_cache) _load_ledger_cache = await import('../../../server/bookkeeping/src/ledger.js');
  return _load_ledger_cache;
}
import { updateSystem } from './_store.js';
import { getTrustedActor } from './_actor.js';
import { guardBookkeepingRequest } from '../_security.js';

export default async function handler(req, res) {
  if (!guardBookkeepingRequest(req, res)) return;

  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false }); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Only POST is supported.' }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  try {
    const { approveEntry } = await _load_ledger();
        const input = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (!input.entryId) { res.status(400).json({ ok: false, error: 'entryId is required.' }); return; }

    let approved = null;
    await updateSystem(actor.companyId, system => {
      approved = approveEntry(system.ledger, actor.companyId, input.entryId, { id: actor.id, role: actor.role });
      return system;
    });
    res.status(200).json({ ok: true, entry: approved });
  } catch (error) {
    res.status(422).json({ ok: false, error: error.message || 'Could not approve this journal entry.' });
  }
}
