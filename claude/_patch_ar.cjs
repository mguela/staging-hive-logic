// Idempotent fix for the "OWED TO YOU" AR tile (api/snapshot.js).
// Chris's call (2026-07-29): count only genuinely-open invoices as AR
// (awaiting_payment + past_due). Excludes 'paid' (the ~$1.24M phantom from
// blank synced payments), 'bad_debt' (written off), and 'draft' (not sent).
const fs = require('fs');
const P = 'api/snapshot.js';
let raw = fs.readFileSync(P, 'utf8');
const EOL = raw.indexOf('\r\n') !== -1 ? '\r\n' : '\n';

if (raw.indexOf('OPEN_AR_STATUSES') !== -1) { console.log('already_patched'); process.exit(0); }

const lines = raw.split(/\r?\n/);

// 1) Replace the 4-line open/outstanding/overdue block.
const startIdx = lines.findIndex(l => /const openInvoices = invoices\.filter/.test(l));
if (startIdx === -1) { console.log('OPEN_BLOCK_NOT_FOUND'); process.exit(1); }
// The original block is exactly 4 lines (openInvoices, outstanding, now, overdueCount).
const newBlock = [
  "  // AR = money customers actually owe you: invoices that are billed (sent)",
  "  // and unpaid. Chris's call (2026-07-29): only genuinely-open statuses count.",
  "  // Excludes 'paid' (synced payments are often blank on historical paid",
  "  // invoices, which used to phantom ~$1.24M into this tile), 'bad_debt'",
  "  // (written off, not collectable), and 'draft' (not sent to the client yet).",
  "  const OPEN_AR_STATUSES = ['awaiting_payment', 'past_due'];",
  "  const invStatus = (i) => String(i.invoice_status || '').toLowerCase().trim();",
  "  const balanceOf = (i) => (Number(i.total) || 0) - (Number(i.payments) || 0);",
  "  const openInvoices = invoices.filter(i => OPEN_AR_STATUSES.includes(invStatus(i)) && balanceOf(i) > 0.01);",
  "  const outstanding = Math.round(openInvoices.reduce((s, i) => s + balanceOf(i), 0) * 100) / 100;",
  "  const now = Date.now();",
  "  const overdueCount = openInvoices.filter(i => i.due_date && new Date(i.due_date).getTime() < now).length;",
  "",
  "  // Transparent, auditable breakdown of balances deliberately NOT counted as",
  "  // collectable AR (so the headline number can always be reconciled).",
  "  const sumBalWhere = (statuses) => {",
  "    const rows = invoices.filter(i => statuses.includes(invStatus(i)) && balanceOf(i) > 0.01);",
  "    return { count: rows.length, amount: Math.round(rows.reduce((s, i) => s + balanceOf(i), 0) * 100) / 100 };",
  "  };",
  "  const arExcluded = { draftUnsent: sumBalWhere(['draft']), writtenOffBadDebt: sumBalWhere(['bad_debt']), markedPaid: sumBalWhere(['paid']) };",
];
lines.splice(startIdx, 4, ...newBlock);

// 2) Extend the ar return object with the excluded breakdown.
const arIdx = lines.findIndex(l => /ar:\s*\{\s*openInvoices:/.test(l));
if (arIdx === -1) { console.log('AR_RETURN_NOT_FOUND'); process.exit(1); }
lines[arIdx] = lines[arIdx].replace('overdueCount }', 'overdueCount, excluded: arExcluded }');

fs.writeFileSync(P, lines.join(EOL));
console.log('patched=true');
console.log('has_open_ar=' + (lines.join('\n').indexOf('OPEN_AR_STATUSES') !== -1));
console.log('has_excluded=' + (lines.join('\n').indexOf('excluded: arExcluded') !== -1));
