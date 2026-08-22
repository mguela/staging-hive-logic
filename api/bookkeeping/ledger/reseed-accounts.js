// api/bookkeeping/ledger/reseed-accounts.js
//
// POST-only, admin-gated maintenance action: rebuilds this company's General
// Ledger chart of accounts from its real, live QuickBooks accounts (see
// ./_store.js's reseedAccountsFromQbo() for the full mechanics and the
// header comment on defaultChartOfAccounts() for why this exists at all --
// short version: the ledger was provisioned with a fixed, generic 22-account
// placeholder list that has no relationship to this company's actual QBO
// accounts, so real submitted expenses' journal entries never matched any
// account here and the Financial Reports tab never reconciled to QuickBooks.
//
// Refuses (via reseedAccountsFromQbo()'s own guard) if this company already
// has any posted or pending journal entry, so this can never be used to
// silently corrupt real ledger activity -- it is safe to expose as a plain
// admin button with no extra confirmation dialog needed.

import { reseedAccountsFromQbo } from './_store.js';
import { getTrustedActor } from './_actor.js';
import { guardBookkeepingRequest } from '../_security.js';

export default async function handler(req, res) {
  if (!guardBookkeepingRequest(req, res)) return;

  const enabled = process.env.BOOKKEEPING_ENABLED === 'true';
  if (!enabled) { res.status(200).json({ ok: true, enabled: false }); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Only POST is supported.' }); return; }

  const actor = await getTrustedActor(req);
  if (!actor) { res.status(401).json({ ok: false, error: 'No trusted server-verified identity was present on this request. Sign in and try again.' }); return; }
  if (actor.hivelogicRole !== 'admin') { res.status(403).json({ ok: false, error: 'Only an admin can rebuild the chart of accounts from QuickBooks.' }); return; }

  try {
    const result = await reseedAccountsFromQbo(actor.companyId);
    res.status(200).json({ ok: true, ...result, note: 'The General Ledger chart of accounts now matches your live QuickBooks accounts exactly. Submitted expenses will post to the General Ledger correctly going forward.' });
  } catch (error) {
    res.status(422).json({ ok: false, error: error.message || 'Could not rebuild the chart of accounts from QuickBooks.' });
  }
}
