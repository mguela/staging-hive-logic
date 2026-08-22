// PostgreSQL rejects a single INSERT ... ON CONFLICT DO UPDATE statement when
// its payload contains the same conflict key twice (SQLSTATE 21000). Jobber
// connection pages have produced duplicate nodes in real sync runs, so every
// batch must collapse same-id rows before it reaches PostgREST.

function timestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

export function dedupeRowsByConflictKey(rows, conflictColumn, updatedAtColumn = 'jobber_updated_at') {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
  if (!conflictColumn) throw new TypeError('conflictColumn is required');

  const uniqueRows = [];
  const indexByKey = new Map();

  rows.forEach((row, inputIndex) => {
    const key = row && row[conflictColumn];
    if (key === undefined || key === null || key === '') {
      throw new Error(`Cannot upsert row ${inputIndex}: ${conflictColumn} is missing.`);
    }

    if (!indexByKey.has(key)) {
      indexByKey.set(key, uniqueRows.length);
      uniqueRows.push(row);
      return;
    }

    const existingIndex = indexByKey.get(key);
    const existing = uniqueRows[existingIndex];
    const existingUpdatedAt = timestamp(existing && existing[updatedAtColumn]);
    const candidateUpdatedAt = timestamp(row && row[updatedAtColumn]);

    // Prefer a demonstrably newer Jobber record. If the existing timestamp is
    // missing, or both timestamps are equal/missing, prefer the later
    // occurrence; never replace a dated row with an undated duplicate.
    const shouldReplace = existingUpdatedAt === null
      ? true
      : candidateUpdatedAt !== null && candidateUpdatedAt >= existingUpdatedAt;
    if (shouldReplace) {
      uniqueRows[existingIndex] = row;
    }
  });

  return {
    rows: uniqueRows,
    duplicatesDropped: rows.length - uniqueRows.length,
  };
}
