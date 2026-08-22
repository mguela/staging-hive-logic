import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const hcAcl = fs.readFileSync('sql/hiveconnect/20260817_function_privilege_hardening.sql', 'utf8');
const hcVault = fs.readFileSync('sql/hiveconnect/20260817_livekit_secret_vault.sql', 'utf8');
const hcGuestSource = fs.readFileSync('sql/hiveconnect/video_guest_passes_2026-07-26.sql', 'utf8');
const hdAcl = fs.readFileSync('sql/hivedoc/20260817_function_privilege_hardening.sql', 'utf8');
const msmail = fs.readFileSync('api/msmail.js', 'utf8');
const gusto = fs.readFileSync('api/gusto/index.js', 'utf8');
const deployRunbook = fs.readFileSync('DEPLOY_RUNBOOK.md', 'utf8');

const hcSecurityDefiners = [
  'admin_add_member', 'admin_archive_channel', 'admin_create_user',
  'admin_delete_channel', 'admin_remove_member', 'admin_reset_password',
  'admin_set_active', 'admin_set_category', 'admin_set_channel_type',
  'admin_set_role', 'can_access_channel', 'create_invite',
  'create_video_guest_pass', 'create_webhook', 'guest_video_token',
  'guard_profile_change', 'handle_new_message', 'handle_new_user',
  'invite_info', 'is_admin', 'is_channel_member', 'livekit_token', 'my_role',
  'redeem_invite', 'reina_read', 'require_admin', 'revoke_webhook',
  'toggle_pin', 'webhook_post',
];

test('HiveConnect hardening pins and removes inherited execution from all 29 live SECURITY DEFINER functions', () => {
  assert.equal(hcSecurityDefiners.length, 29);
  for (const name of hcSecurityDefiners) {
    assert.match(hcAcl, new RegExp('alter function public\\.' + name.replaceAll('_', '\\_') + '\\('));
    assert.match(hcAcl, new RegExp('revoke execute on function public\\.' + name.replaceAll('_', '\\_') + '\\('));
  }
  assert.match(hcAcl, /alter function public\.b64url\(bytea\) set search_path = pg_catalog;/);
  assert.match(hcAcl, /revoke execute on function public\.b64url\(bytea\) from PUBLIC, anon, authenticated, service_role;/);
});

test('only the five reviewed token-gated HiveConnect functions are granted to anon', () => {
  const grants = [...hcAcl.matchAll(/grant execute on function public\.([a-z0-9_]+)\([^;]+?\) to ([^;]+);/g)]
    .filter((match) => match[2].split(',').map((role) => role.trim()).includes('anon'))
    .map((match) => match[1])
    .sort();
  assert.deepEqual(grants, ['guest_video_token', 'invite_info', 'redeem_invite', 'reina_read', 'webhook_post']);
});

test('HiveDoc keeps RLS helpers authenticated and leaves trigger functions without client grants', () => {
  for (const name of ['can_access_folder', 'can_see_folder', 'is_admin', 'handle_new_user', 'apply_sensitive_default']) {
    assert.match(hdAcl, new RegExp('alter function public\\.' + name + '\\('));
    assert.match(hdAcl, new RegExp('revoke execute on function public\\.' + name + '\\('));
  }
  for (const name of ['can_access_folder', 'can_see_folder', 'is_admin']) {
    assert.match(hdAcl, new RegExp('grant execute on function public\\.' + name + '\\([^;]*\\) to authenticated, service_role;'));
  }
  assert.doesNotMatch(hdAcl, /grant execute on function public\.(handle_new_user|apply_sensitive_default)/);
});

test('LiveKit SQL reads named Vault secrets, contains no embedded signing assignment, and claims guest use atomically', () => {
  for (const source of [hcVault, hcGuestSource]) {
    assert.match(source, /hiveconnect_livekit_api_key/);
    assert.match(source, /hiveconnect_livekit_api_secret/);
    assert.doesNotMatch(source, /v_secret\s+text\s*:=\s*'[^']+'/i);
    assert.doesNotMatch(source, /v_key\s+text\s*:=\s*'[^']+'/i);
    assert.match(source, /update (?:public\.)?video_guest_passes as pass[\s\S]+returning pass\.\* into v_row;/i);
  }
});

test('setup/diagnostic responses do not return credential prefixes or lengths', () => {
  assert.doesNotMatch(msmail, /secretPrefix\s*:/);
  assert.doesNotMatch(msmail, /secretLen\s*:/);
  assert.doesNotMatch(gusto, /token_prefix\s*:/);
  assert.doesNotMatch(gusto, /token_len\s*:/);
});

test('deployment runbook no longer records a TEST_WORKFLOW_SECRET value', () => {
  assert.doesNotMatch(deployRunbook, /TEST_WORKFLOW_SECRET[^\n]*[0-9a-f]{40,}/i);
});
