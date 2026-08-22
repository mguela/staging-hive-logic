// test/monitor-agent-credential-guard.test.mjs
//
// The guard for the failure that cost two weeks.
//
// A monitor_agents row could be status='active' with agent_token_hash NULL.
// requireMonitorAgent() looks agents up by that hash alone, so such a row can
// never match -- the agent is permanently unauthenticatable. The part that
// made it expensive is that it fails EXACTLY like a wrong token: a 401, no log
// line, a tray reading "Heartbeat error". Chris's agent was in that state from
// 2026-08-01 to 2026-08-16, sending a correct token every 60 seconds, while
// three separate auth gates were opened in front of it. None could have helped.
//
// The row got there because token hashing shipped without migrating the rows
// that already existed. Two layers now stop a repeat:
//
//   1. a CHECK constraint makes the state impossible to write -- the
//      half-shipped migration would have failed loudly instead of silently
//      disabling an agent;
//   2. a health-cron check reports any such row anyway, because a constraint
//      only protects a database that has it (restored snapshots, branch
//      databases, environments built from an older baseline).
//
// Applied and verified against production on 2026-08-16: both a null-hash
// update and a plaintext-token update were rejected by the constraint.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const MIGRATION = 'supabase/migrations/20260816145500_monitor_agents_active_requires_token_hash.sql';
const BACKFILL = 'supabase/migrations/20260816143000_monitor_agents_backfill_token_hash.sql';

test('the backfill migration that ended the outage is recorded in the repo', () => {
  assert.ok(fs.existsSync(BACKFILL), 'the production backfill must be committed, not left as an undocumented hand-edit');
  const sql = fs.readFileSync(BACKFILL, 'utf8');
  assert.match(sql, /update public\.monitor_agents/);
  assert.match(sql, /agent_token_hash = encode\(digest\(agent_token, 'sha256'\), 'hex'\)/);
  assert.match(sql, /agent_token = null/, 'the plaintext copy must be dropped, which was the point of hashing');
  assert.match(sql, /where agent_token is not null\s*\n\s*and agent_token_hash is null/,
    'it must only touch rows in the broken state, so re-running is a no-op');
});

test('an active agent is required to be authenticatable', () => {
  assert.ok(fs.existsSync(MIGRATION), 'the guard migration must exist');
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  assert.match(sql, /add constraint monitor_agents_active_requires_token_hash/);
  assert.match(sql, /status <> 'active'/, 'scoped to active rows');
  assert.match(sql, /agent_token_hash is not null/, 'an active agent must have a usable credential');
});

test('the same constraint also forbids a plaintext token on an active agent', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  assert.match(sql, /agent_token is null/,
    'handleMonitorPair already nulls it; this stops a regression putting credentials back in the clear');
});

test('pending and revoked agents are deliberately exempt', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  // A pending agent is mid-enrollment and legitimately has neither value --
  // production has two such rows (Jovie, Robert). Constraining them would have
  // made this migration unappliable, and revoked rows are history that must
  // stay readable as written.
  assert.match(sql, /status <> 'active'/);
  assert.match(sql, /[Pp]ending/, 'the reasoning for the exemption must be written down');
});

test('health-cron reports any agent that cannot authenticate, as a failure', () => {
  const src = fs.readFileSync('api/health-cron.js', 'utf8');
  assert.match(src, /monitor_agents\?status=eq\.active&agent_token_hash=is\.null/,
    'the check must look for exactly the unauthenticatable state');
  assert.match(src, /status: 'fail'/, 'a dead agent is a failure, not a warning');
  assert.match(src, /can NEVER authenticate/, 'and it must say plainly what is wrong');
  // It must not be silent when it cannot answer -- the whole theme here.
  assert.match(src, /could not check agent credentials/);
});

test('the check tells whoever reads the email what to actually do', () => {
  const src = fs.readFileSync('api/health-cron.js', 'utf8');
  assert.match(src, /Re-pair them, or backfill as in migration 20260816143000/,
    'an alarm without a remedy just becomes noise');
});
