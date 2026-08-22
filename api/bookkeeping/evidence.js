// api/bookkeeping/evidence.js
// The evidence vault: stores the original receipt/bill file a user attaches
// in Expense Entry, and serves it back for the thumbnail + full-screen
// viewer. public/app-bookkeeping.js has called POST /api/bookkeeping/evidence
// since it was written, but no route existed here until this commit --
// every upload silently 404'd, so no expense could ever be attached or
// submitted (saveExpense() refuses to save without an evidenceId). This
// closes that real, verified gap.
//
// GET without an id (added for the Books Home evidence vault list) returns
// metadata only -- id/filename/mimeType/sizeBytes/createdAt for every
// document this company has, newest first. GET with an id keeps its
// original behavior: serves that one document's raw bytes for the
// thumbnail/viewer. Two different response shapes on purpose -- the vault
// list should never have to download every receipt's full file body just to
// render a list.
//
// Storage: ./_evidence_store.js, the same dual-backend (memory default /
// durable Supabase opt-in) pattern every other bookkeeping store in this app
// already uses.

import { getTrustedActor } from './purchase-orders/_actor.js';
import { insertEvidence, getEvidence, listEvidence, storeBackend } from './_evidence_store.js';
import { guardBookkeepingRequest } from './_security.js';

export default async function handler(req, res) {
  if (!guardBookkeepingRequest(req, res)) return;

  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request.' }); return; }

  if (req.method === 'GET') {
    try {
      const { id } = req.query || {};
      if (!id) {
        const documents = await listEvidence(actor.companyId);
        res.status(200).json({ ok: true, documents, storeBackend: storeBackend() });
        return;
      }
      const doc = await getEvidence(actor.companyId, id);
      if (!doc) { res.status(404).json({ ok: false, error: 'That document was not found.' }); return; }
      const buffer = Buffer.from(doc.dataBase64, 'base64');
      res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${String(doc.filename || 'receipt').replace(/"/g, '')}"`);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.status(200).send(buffer);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || 'Could not read this evidence document.' });
    }
    return;
  }

  if (req.method === 'POST') {
    try {
      const input = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const doc = await insertEvidence({
        companyId: actor.companyId,
        filename: input.filename,
        mimeType: input.mimeType,
        dataBase64: input.dataBase64,
        createdBy: actor.id
      });
      res.status(200).json({
        ok: true,
        evidence: { id: doc.id, filename: doc.filename, mimeType: doc.mimeType, sizeBytes: doc.sizeBytes, sha256: doc.sha256 },
        storeBackend: storeBackend()
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message || 'Could not save this file.' });
    }
    return;
  }

  res.status(405).json({ ok: false, error: 'Only GET and POST are supported for this route.' });
}
