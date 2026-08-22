// server/bookkeeping/src/bank-statement-import.js
//
// Parses a bank/card statement CSV export into the plain transaction array
// importBankFeed() (./banking.js) expects: { accountId, postedDate
// 'YYYY-MM-DD', amount (signed), description, externalId?, checkNumber?,
// authorizedDate? }. accountId is not present in a bank's own CSV export
// (the account is implied by which statement the user picked to upload), so
// the caller (api/bookkeeping/ledger/bank-import.js) attaches the real
// accountId the user selected after this returns.
//
// This is new code, not a port -- there is no equivalent parser anywhere in
// the approved reference (hivelogic-expense-control) or in this app before
// this commit. Scoped deliberately to CSV only: every bank and card issuer
// offers a CSV export, so this covers every real institution without
// attempting OFX/QFX/QBO's more complex SGML-like formats, which are
// explicitly NOT supported yet -- flagged as a known gap, not silently
// half-implemented.
//
// Deliberately tolerant of one bad row rather than an all-or-nothing parse:
// a single malformed date or an unparceable amount produces a warning and
// skips that row, so one damaged line in a 200-row statement doesn't block
// importing the other 199. Every warning is returned, never swallowed.

function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') { current += '"'; i += 1; } else { inQuotes = false; }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map(cell => cell.trim());
}

function normalizeHeader(cell) {
  return String(cell || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const HEADER_ALIASES = {
  date: ['date', 'postdate', 'posteddate', 'transactiondate', 'trandate', 'postingdate'],
  description: ['description', 'desc', 'memo', 'payee', 'name', 'transactiondescription'],
  amount: ['amount', 'amt', 'transactionamount'],
  debit: ['debit', 'withdrawal', 'withdrawals', 'paymentamount', 'debitamount'],
  credit: ['credit', 'deposit', 'deposits', 'creditamount'],
  checkNumber: ['checknumber', 'checkno', 'check', 'checknum', 'checknumber'],
  externalId: ['id', 'transactionid', 'referencenumber', 'reference', 'refnum', 'referenceid'],
  authorizedDate: ['authorizeddate', 'authdate', 'effectivedate']
};

function findColumn(headerCells, field) {
  const aliases = HEADER_ALIASES[field];
  for (let i = 0; i < headerCells.length; i += 1) {
    if (aliases.includes(headerCells[i])) return i;
  }
  return -1;
}

const MONEY_CLEAN = /[$,\s]/g;

function parseMoney(raw) {
  if (raw == null || raw === '') return null;
  let text = String(raw).replace(MONEY_CLEAN, '');
  let negative = false;
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1); }
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

function parseDate(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const slash = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (slash) {
    const month = slash[1].padStart(2, '0');
    const day = slash[2].padStart(2, '0');
    return `${slash[3]}-${month}-${day}`;
  }
  const iso = text.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  return null;
}

export function parseBankStatementCsv(csvText) {
  const rawLines = String(csvText || '').split(/\r\n|\r|\n/);
  const lines = rawLines.filter(line => line.trim().length > 0);
  if (!lines.length) throw new Error('That file is empty.');

  const header = splitCsvLine(lines[0]).map(normalizeHeader);
  const columns = {
    date: findColumn(header, 'date'),
    description: findColumn(header, 'description'),
    amount: findColumn(header, 'amount'),
    debit: findColumn(header, 'debit'),
    credit: findColumn(header, 'credit'),
    checkNumber: findColumn(header, 'checkNumber'),
    externalId: findColumn(header, 'externalId'),
    authorizedDate: findColumn(header, 'authorizedDate')
  };

  if (columns.date === -1) {
    throw new Error(`Could not find a date column. Recognized headers: ${HEADER_ALIASES.date.join(', ')}. Found columns: ${header.join(', ') || '(none)'}.`);
  }
  if (columns.amount === -1 && (columns.debit === -1 || columns.credit === -1)) {
    throw new Error(`Could not find an amount column (either a single "Amount" column, or both "Debit" and "Credit" columns). Found columns: ${header.join(', ') || '(none)'}.`);
  }

  const transactions = [];
  const warnings = [];

  for (let rowIndex = 1; rowIndex < lines.length; rowIndex += 1) {
    const cells = splitCsvLine(lines[rowIndex]);
    const rowNumber = rowIndex + 1; // 1-based, matching what a spreadsheet shows
    if (cells.every(cell => !cell)) continue;

    const postedDate = parseDate(cells[columns.date]);
    if (!postedDate) { warnings.push(`Row ${rowNumber}: could not parse a date from "${cells[columns.date] ?? ''}" -- row skipped.`); continue; }

    let amount = null;
    if (columns.amount !== -1) {
      amount = parseMoney(cells[columns.amount]);
    } else {
      const debit = parseMoney(cells[columns.debit]);
      const credit = parseMoney(cells[columns.credit]);
      if (credit) amount = Math.abs(credit);
      else if (debit) amount = -Math.abs(debit);
    }
    if (amount == null || amount === 0) { warnings.push(`Row ${rowNumber}: could not parse a non-zero amount -- row skipped.`); continue; }

    transactions.push({
      postedDate,
      amount,
      description: columns.description !== -1 ? (cells[columns.description] || '') : '',
      checkNumber: columns.checkNumber !== -1 ? (cells[columns.checkNumber] || null) : null,
      externalId: columns.externalId !== -1 ? (cells[columns.externalId] || null) : null,
      authorizedDate: columns.authorizedDate !== -1 ? (parseDate(cells[columns.authorizedDate]) || null) : null
    });
  }

  return { transactions, warnings };
}
