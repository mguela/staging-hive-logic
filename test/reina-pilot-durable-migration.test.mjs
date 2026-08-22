import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const MIGRATION_URL = new URL(
  '../supabase/migrations/20260803083417_reina_pilot_durable_conversations.sql',
  import.meta.url,
);

test('unapplied Reina pilot migration is principal-scoped, fenced, and service-RPC-only', async () => {
  const sql = await readFile(MIGRATION_URL, 'utf8');

  for (const table of [
    'reina_pilot_conversations',
    'reina_pilot_turns',
    'reina_pilot_messages',
    'reina_pilot_review_intents',
  ]) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}\\b`, 'u'));
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, 'u'));
    assert.match(sql, new RegExp(`revoke all on public\\.${table} from public, anon, authenticated, service_role`, 'u'));
  }

  for (const rpc of [
    'load_conversation',
    'create_conversation',
    'claim_turn',
    'append_user_once',
    'load_history',
    'append_assistant_and_complete',
    'mark_turn_failed',
    'issue_review_intent',
    'consume_review_intent',
  ]) {
    assert.match(sql, new RegExp(`create or replace function public\\.reina_pilot_${rpc}\\(`, 'u'));
    assert.match(sql, new RegExp(`grant execute on function public\\.reina_pilot_${rpc}\\([\\s\\S]*?\\) to service_role;`, 'u'));
  }

  assert.match(sql, /owner_principal_id uuid not null references public\.profiles\(id\)/u);
  assert.match(sql, /primary key \(owner_principal_id, conversation_id, idempotency_key\)/u);
  assert.match(sql, /reina_pilot_one_unresolved_turn_idx[\s\S]*where state <> 'completed'/u);
  assert.match(sql, /claim_id uuid not null/u);
  assert.match(sql, /lease_expires_at timestamptz/u);
  assert.match(sql, /completion_policy_reference jsonb/u);
  assert.match(sql, /failure_policy_reference jsonb/u);
  assert.equal((sql.match(/create table if not exists public\.reina_pilot_/gu) || []).length, 4);
  assert.doesNotMatch(sql, /create policy[\s\S]*?reina_pilot_/iu);
  assert.match(sql, /create table if not exists public\.reina_pilot_review_intents[\s\S]*?intent_id text primary key/u);
  assert.match(sql, /reina_pilot_review_intents_turn_unique[\s\S]*?unique \(owner_principal_id, conversation_id, turn_id\)/u);
  assert.match(sql, /expires_at > issued_at[\s\S]*?interval '10 minutes'/u);
  assert.match(sql, /consumed_at is null or \(consumed_at >= issued_at and consumed_at < expires_at\)/u);
  assert.match(sql, /create or replace function public\.reina_pilot_issue_review_intent\([\s\S]*?clock_timestamp\(\)[\s\S]*?on conflict do nothing/u);
  assert.match(sql, /create or replace function public\.reina_pilot_consume_review_intent\([\s\S]*?for update;[\s\S]*?set consumed_at = v_now/u);
  assert.match(sql, /set consumed_at = v_now[\s\S]*?consumed_at is null[\s\S]*?expires_at > clock_timestamp\(\)[\s\S]*?clock_timestamp\(\) < p_deadline_at/u);
  for (const binding of [
    "'kind', 'reina_ui_confirmation_policy'",
    "'policyVersion', 'reina-acting-context-policy-v1'",
    "'operation', 'reina.pilot.access'",
    "'capability', 'reina:pilot:access'",
    "'resource', 'pilot_runtime'",
    "'effect', 'access'",
    "'ownerScope', 'principal'",
    "'ownerPrincipalId', p_owner_principal_id::text",
  ]) {
    assert.equal((sql.match(new RegExp(binding.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gu')) || []).length >= 2, true);
  }
  assert.match(sql, /v_intent\.owner_principal_id <> p_owner_principal_id[\s\S]*?'owner_mismatch'/u);
  assert.match(sql, /v_intent\.conversation_id <> p_conversation_id[\s\S]*?'not_found'/u);
  assert.match(sql, /v_intent\.policy_reference <> p_policy_reference[\s\S]*?'policy_mismatch'/u);
  assert.match(sql, /v_intent\.expires_at <= v_now[\s\S]*?'expired'/u);
  assert.match(sql, /v_intent\.consumed_at is not null[\s\S]*?'duplicate'/u);
  assert.match(sql, /revoke all on function public\.reina_pilot_issue_review_intent\([^;]+\) from public, anon, authenticated, service_role;/u);
  assert.match(sql, /revoke all on function public\.reina_pilot_consume_review_intent\([^;]+\) from public, anon, authenticated, service_role;/u);
  assert.match(sql, /reina_pilot_prepare_deadline[\s\S]*?set_config\('lock_timeout'/u);
  assert.doesNotMatch(sql, /set_config\('statement_timeout'/u);
  assert.equal((sql.match(/pg_try_advisory_xact_lock/gu) || []).length, 5);
  assert.doesNotMatch(sql, /perform\s+pg_advisory_xact_lock/u);
  assert.match(sql, /p_attempt_deadline_at timestamptz/u);
  assert.match(sql, /lease_expires_at = p_attempt_deadline_at/u);
  assert.match(sql, /v_claim, 'in_flight', p_attempt_deadline_at/u);
  assert.match(sql, /sum\(octet_length\(m\.content\)\)[\s\S]*?v_bytes > 1000000/u);
  assert.match(sql, /raise exception using errcode = '57014', message = 'reina_pilot_deadline'/u);
  assert.doesNotMatch(sql, /grant (?:select|insert|update|delete|all) on [^;]+ to (?:anon|authenticated)/iu);
  assert.doesNotMatch(sql, /grant execute on function [^;]+ to (?:anon|authenticated)/iu);
});
