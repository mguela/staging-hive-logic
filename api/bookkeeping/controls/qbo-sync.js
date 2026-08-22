// api/bookkeeping/controls/qbo-sync.js
//
// The one and only place in this whole app that can write to real
// QuickBooks. POST { outboxId } -- begins (or resumes/retries) the named
// controls.js QBO-outbox item, calls the real write client
// (server/bookkeeping/src/qbo-write-client.js), and records the result,
// exactly mirroring the reference's own begin -> send -> finish sequence
// (its drainQboOutbox(), which this app has no automation.js/scheduler to
// run automatically -- so here it is always a deliberate, one-item,
// human-triggered action instead of a background sweep. That is a stricter
// safety posture than the reference's, not a gap: nothing can ever sync to
// QuickBooks in this app without an explicit click from a bookkeeper or
// controller AND HIVELOGIC_QBO_WRITE_ENABLED=true already set for the whole
// deployment).
//
// Standing rule: this route is a no-op (200, enabled:false, nothing
// touched) unless HIVELOGIC_QBO_WRITE_ENABLED is literally "true". Flipping
// that switch is Chris's decision alone, on top of BOOKKEEPING_ENABLED and
// the actor's own bookkeeper/controller role check below.

import { getSystem, updateSystem } from '../ledger/_store.js';
import { getTrustedActor } from '../ledger/_actor.js';
import { guardBookkeepingRequest } from '../_security.js';

let _load_controls_cache;
async function _load_controls() {
  if (!_load_controls_cache) _load_controls_cache = await import('../../../server/bookkeeping/src/controls.js');
  return _load_controls_cache;
}
let _load_qbo_client_cache;
async function _load_qbo_client() {
  if (!_load_qbo_client_cache) _load_qbo_client_cache = await import('../../../server/bookkeeping/src/qbo-write-client.js');
  return _load_qbo_client_cache;
}

export default async function handler(req, res) {
  if (!guardBookkeepingRequest(req, res)) return;

  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false }); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Only POST is supported.' }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }
  if (!['bookkeeper', 'controller'].includes(actor.role)) { res.status(403).json({ ok: false, error: 'Only a bookkeeper or controller can trigger a QuickBooks sync.' }); return; }

  const qboWriteEnabled = process.env.HIVELOGIC_QBO_WRITE_ENABLED === 'true';
  if (!qboWriteEnabled) {
    res.status(200).json({ ok: true, enabled: true, qboWriteEnabled: false, synced: false, note: 'Live QuickBooks writes are turned off for this deployment (HIVELOGIC_QBO_WRITE_ENABLED is not "true"). The item stays queued -- nothing was sent to QuickBooks.' });
    return;
  }

  try {
    const input = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (!input.outboxId) { res.status(400).json({ ok: false, error: 'outboxId is required.' }); return; }

    const { createQboWriteClient } = await _load_qbo_client();
    const qboClient = createQboWriteClient({
      enabled: true,
      url: process.env.HIVELOGIC_QBO_WRITE_URL || '',
      token: process.env.HIVELOGIC_QBO_WRITE_TOKEN || ''
    });
    if (!qboClient.enabled) { res.status(409).json({ ok: false, error: 'HIVELOGIC_QBO_WRITE_ENABLED is true, but HIVELOGIC_QBO_WRITE_URL is not configured for this deployment.' }); return; }

    const { beginQboSync, retryQboSync, recoverInterruptedQboSync, finishQboSync } = await _load_controls();
    const ledgerActor = { id: actor.id, role: actor.role };

    const before = await getSystem(actor.companyId);
    const existing = (before.controls?.qboOutbox || []).find(item => item.id === input.outboxId);
    if (!existing) { res.status(404).json({ ok: false, error: 'QBO outbox item not found.' }); return; }
    if (existing.status === 'complete') { res.status(200).json({ ok: true, enabled: true, qboWriteEnabled: true, synced: true, outbox: existing, note: 'This item already synced previously; nothing was sent again.' }); return; }
    if (existing.status === 'blocked') { res.status(409).json({ ok: false, error: 'This item is blocked from a non-retryable QuickBooks failure and needs manual review before it can be retried.' }); return; }

    let started = null;
    await updateSystem(actor.companyId, system => {
      const item = system.controls.qboOutbox.find(entry => entry.id === input.outboxId);
      if (item.status === 'in_flight') recoverInterruptedQboSync(system.controls, input.outboxId, ledgerActor);
      const current = system.controls.qboOutbox.find(entry => entry.id === input.outboxId);
      started = current.status === 'retry' ? retryQboSync(system.controls, input.outboxId, ledgerActor) : beginQboSync(system.controls, input.outboxId, ledgerActor);
      return system;
    });

    const result = await qboClient.send(started);

    let finished = null;
    await updateSystem(actor.companyId, system => {
      finished = finishQboSync(system.controls, input.outboxId, result, ledgerActor);
      return system;
    });

    res.status(200).json({ ok: true, enabled: true, qboWriteEnabled: true, synced: finished.status === 'complete', outbox: finished, qboResult: result });
  } catch (error) {
    res.status(422).json({ ok: false, error: error.message || 'Could not sync this item to QuickBooks.' });
  }
}
