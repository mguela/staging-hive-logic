#!/usr/bin/env node
// scripts/check-migration-replay-safety.mjs
//
// Refuse to let .github/workflows/supabase-migrations.yml execute a migration
// against production when replaying it could destroy live data.
//
// WHY THIS EXISTS
//
// The deploy workflow applies any NEWLY ADDED migration that production's
// ledger does not already record as applied, by running:
//
//     supabase db query --linked --file <migration>
//
// That is the right behaviour for a forward-only schema change. It is the
// wrong behaviour for a migration that CAPTURES state already live -- a file
// written to record what was applied by hand, whose data statements were only
// ever meant to run once, against the OLD shape of the data.
//
// PR #198 is the worked example. `20260810220215_permission_roles_v2.sql`
// remaps an old 11-role taxonomy onto a new 9-role one with three unguarded
// UPDATEs whose CASE only knows the OLD names. Production is already on the
// new names, so a replay maps six of the nine roles to null and silently
// strips those employees' permissions. Merging that PR with the deploy secrets
// configured would have done exactly that. The only thing standing in the way
// was a paragraph in a PR description, and that PR sat unread for four days.
//
// So: a migration whose top-level statements can modify or destroy existing
// rows is refused by default. The author opts back in, per file, by stating
// why a replay is harmless.
//
// THE CONTRACT
//
//   -- hl:replay-safe: <reason>     this file may be auto-applied
//   -- hl:replay-unsafe: <reason>   never auto-apply; repair the ledger by hand
//
// A file with destructive top-level DML and no marker is refused, and the
// error says what to do about it. Failing is the safe direction: the migration
// stays unapplied and a human decides, rather than the row-shredding happening
// first and being discovered later.
//
// WHAT COUNTS AS DESTRUCTIVE
//
// Only TOP-LEVEL statements. An UPDATE inside a function body is a definition,
// not an execution -- it runs when something later calls the function, not when
// the migration is applied. Dollar-quoted bodies are therefore stripped before
// scanning, which is the difference between 23 flagged files in this repo and
// the 12 that genuinely execute DML.
//
// CREATE/ALTER/INSERT are not flagged. They add; they do not destroy. An
// INSERT that collides raises instead of overwriting, and the existing
// migrations lean on `if not exists` throughout.
//
//   node scripts/check-migration-replay-safety.mjs <file.sql> [...]
//
// Exit codes: 0 = safe to apply, 1 = refused (or bad usage).

import fs from 'node:fs';

export const SAFE_MARKER = /--\s*hl:replay-safe\s*:\s*(\S.*)$/im;
export const UNSAFE_MARKER = /--\s*hl:replay-unsafe\s*:\s*(\S.*)$/im;

// A reason has to actually say something. "ok" is not a justification, and a
// marker that can be satisfied by a single character is a marker that will be.
const MIN_REASON = 12;

/**
 * Remove everything that looks like SQL but is not executed at apply time:
 * block comments, line comments, dollar-quoted bodies (function/DO blocks),
 * and string literals (so a table named in a string cannot read as a keyword).
 */
export function stripNonExecutable(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    // $$ ... $$ and $tag$ ... $tag$ -- the body of a function or DO block
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1?\$/g, ' $BODY$ ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

const DESTRUCTIVE = [
  ['UPDATE', /(?:^|;)\s*update\s+[a-z_"]/i],
  ['DELETE', /(?:^|;)\s*delete\s+from\s+/i],
  ['TRUNCATE', /(?:^|;)\s*truncate\s+/i],
  ['DROP TABLE', /(?:^|;)\s*drop\s+table\s+/i],
  ['DROP COLUMN', /alter\s+table\s+[\s\S]{0,200}?drop\s+column\s+/i],
];

/** Which destructive statement kinds this migration executes at apply time. */
export function destructiveStatements(sql) {
  const body = stripNonExecutable(sql);
  return DESTRUCTIVE.filter(([, re]) => re.test(body)).map(([name]) => name);
}

/**
 * Decide whether one migration may be auto-applied.
 * @returns {{verdict: 'safe'|'refused', kinds: string[], reason?: string}}
 */
export function classify(sql) {
  const kinds = destructiveStatements(sql);
  const unsafe = sql.match(UNSAFE_MARKER);
  if (unsafe) {
    return { verdict: 'refused', kinds, reason: `declared hl:replay-unsafe -- ${unsafe[1].trim()}` };
  }
  if (kinds.length === 0) return { verdict: 'safe', kinds };

  const safe = sql.match(SAFE_MARKER);
  if (!safe) {
    return {
      verdict: 'refused',
      kinds,
      reason: `executes ${kinds.join(', ')} at apply time and carries no hl:replay-safe marker`,
    };
  }
  if (safe[1].trim().length < MIN_REASON) {
    return {
      verdict: 'refused',
      kinds,
      reason: `hl:replay-safe reason is too short to be a justification (${safe[1].trim().length} chars, need ${MIN_REASON})`,
    };
  }
  return { verdict: 'safe', kinds, reason: safe[1].trim() };
}

function main(files) {
  if (files.length === 0) {
    console.error('usage: check-migration-replay-safety.mjs <migration.sql> [...]');
    return 1;
  }
  let refused = 0;
  for (const file of files) {
    const sql = fs.readFileSync(file, 'utf8');
    const { verdict, kinds, reason } = classify(sql);
    if (verdict === 'safe') {
      console.log(`ok      ${file}${kinds.length ? ` (${kinds.join(', ')} -- ${reason})` : ''}`);
      continue;
    }
    refused++;
    console.error(`REFUSED ${file}: ${reason}`);
  }
  if (refused) {
    console.error(`
${refused} migration(s) refused. This is a stop, not a failure to route around.

If the objects are ALREADY LIVE (this file records work applied by hand),
do NOT make the workflow run it. Record it on the ledger instead:

    npx supabase migration repair --status applied <version>

If it is a genuine forward change whose data statements are guarded so a
second run is a no-op, say so in the file itself:

    -- hl:replay-safe: <why a replay cannot damage existing rows>

Never add the marker to silence this. The marker is a claim about the SQL,
and the SQL is what runs against real data.`);
    return 1;
  }
  return 0;
}

// Only run when invoked directly, so the test suite can import the internals.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
