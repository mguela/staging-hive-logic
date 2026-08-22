// api/bookkeeping/ledger/bank-import.js — imports a bank/card statement CSV
// into the real ledger engine's bank-feed store (importBankFeed() in
// server/bookkeeping/src/banking.js -- a complete, tested function that had
// no route anywhere in this app before this commit).
//
// This is a FILE-UPLOAD import, not a live bank connection: the user
// downloads a CSV from their bank/card portal and uploads it here. Nothing
// in this route or in banking.js ever calls an external bank API -- that
// distinction matters under this project's standing rule against live
// bank-feed writes, which this route does not touch (there is no live feed
// to write to; the only "write" is importing already-downloaded statement
// data into HiveLogic's own ledger).
//
// Body: { accountId, filename, csvText }. importKey is derived here (a
// sha256 of accountId+csvText), not supplied by the client, so re-uploading
// the exact same file for the exact same account is a safe no-op
// (importBankFeed() already handles the replay case) rather than something
// the caller has to get right.

import { createHash } from 'node:crypto';
let _load_banking_cache;
async function _load_banking() {
  if (!_load_banking_cache) _load_banking_cache = await import('../../../server/bookkeeping/src/banking.js');
  return _load_banking_cache;
}
let _load_bank_csv_cache;
async function _load_bank_csv() {
  if (!_load_bank_csv_cache) _load_bank_csv_cache = await import('../../../server/bookkeeping/src/bank-statement-import.js');
  return _load_bank_csv_cache;
}
import { getSystem, updateSystem } from './_store.js';
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
    const input = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (!input.accountId) { res.status(400).json({ ok: false, error: 'accountId is required.' }); return; }
    if (!input.csvText) { res.status(400).json({ ok: false, error: 'No file content was received.' }); return; }

    const system = await getSystem(actor.companyId);
    const company = system.ledger.companies[actor.companyId];
    if (!company?.accounts?.[input.accountId]) { res.status(400).json({ ok: false, error: 'That account was not found on this company.' }); return; }

    const { parseBankStatementCsv } = await _load_bank_csv();
    let parsed;
    try {
      parsed = parseBankStatementCsv(input.csvText);
    } catch (parseError) {
      res.status(422).json({ ok: false, error: parseError.message || 'Could not parse this file.' });
      return;
    }
    if (!parsed.transactions.length) {
      res.status(422).json({ ok: false, error: 'No usable transactions were found in this file.', warnings: parsed.warnings });
      return;
    }

    const { importBankFeed } = await _load_banking();
    const importKey = createHash('sha256').update(`${actor.companyId}:${input.accountId}:${input.csvText}`).digest('hex');
    const transactions = parsed.transactions.map(transaction => ({ ...transaction, accountId: input.accountId }));

    let result = null;
    await updateSystem(actor.companyId, sys => {
      result = importBankFeed(sys.ledger, actor.companyId, transactions, importKey, { id: actor.id, role: actor.role });
      return sys;
    });

    res.status(200).json({
      ok: true,
      imported: result.imported,
      duplicates: result.duplicates,
      replay: result.replay,
      parseWarnings: parsed.warnings,
      note: result.replay
        ? 'This exact file was already imported for this account -- nothing new was added.'
        : `${result.imported} transaction(s) imported, ${result.duplicates} duplicate(s) skipped.${parsed.warnings.length ? ` ${parsed.warnings.length} row(s) could not be parsed and were skipped -- see warnings.` : ''}`
    });
  } catch (error) {
    res.status(422).json({ ok: false, error: error.message || 'Could not import this statement.' });
  }
}
