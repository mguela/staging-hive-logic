# Security operations runbook

Last reviewed: 2026-08-17. This file contains procedures and secret names
only. Never add a real credential, token prefix, key length, or recovery value.

## Immediate credential rotations

Two values have appeared in repository history and must be considered
compromised even though the current tree is redacted:

1. Rotate TEST_WORKFLOW_SECRET in every Vercel environment that has it.
2. Rotate both LiveKit credentials used by HiveConnect video. Store the
   replacements in HiveConnect Supabase Vault as
   hiveconnect_livekit_api_key and hiveconnect_livekit_api_secret, then
   review and apply sql/hiveconnect/20260817_livekit_secret_vault.sql.

Removing a value from the current checkout does not remove it from Git history,
old deployments, logs, forks, or local clones. Do not reuse either old value.
A history rewrite is a separate, destructive owner decision and is not a
substitute for rotation.

## TOKEN_ENC_KEY backup and rotation

api/_lib/secrets.js reads enc:v1 and enc:v2 AES-256-GCM envelopes. Version 2
adds a non-secret key fingerprint. It reads the active key from TOKEN_ENC_KEY
and, during a rotation only, earlier keys from comma-separated
TOKEN_ENC_KEY_PREVIOUS. Production secret writes fail closed when the active
key is absent or invalid.

Envelope rollout is expand/contract because preview and production currently
share integration-token rows:

1. Deploy the dual reader with TOKEN_ENC_WRITE_VERSION unset or `v1`, keeping
   the existing TOKEN_ENC_KEY unchanged. Reads accept v1/v2; every write stays
   v1, so the prior production deployment and rollback candidate remain safe.
2. Exercise token reads and refreshes, then confirm every active and approved
   rollback deployment contains the dual reader.
3. Set TOKEN_ENC_WRITE_VERSION=`v2` and deploy again. Only this explicit flag
   activates v2 writes.
4. Inventory envelopes and retain at least one known-good dual-reader rollback.

Never enable v2 writes from a shared preview before step 2. Do not combine the
envelope-version cutover with a key rotation.

Backup policy:

- Generate 32 random bytes and encode them as base64. Never derive the key from
  a password.
- Keep the active value in the Vercel encrypted environment store and one
  independent, owner-controlled recovery vault/password manager. Database
  backups are not key backups.
- Store only the non-secret envelope key id in an operations ticket. Never put
  the key in Git, SQL, chat, email, screenshots, or status documents.
- Test recovery against a non-production ciphertext before relying on a backup.

Key-rotation sequence (only after the dual-reader rollout is complete):

1. Confirm the existing key is recoverable from the independent backup.
2. Generate and back up the new key.
3. Keep TOKEN_ENC_WRITE_VERSION=`v2`. Deploy with the new value in
   TOKEN_ENC_KEY and the old value in
   TOKEN_ENC_KEY_PREVIOUS.
4. Exercise Jobber, QBO, Gusto, TikTok, Microsoft mail, and IMAP/app-password
   credential reads. A normal OAuth refresh rewrites rotating tokens with the
   new key. Re-save static mailbox credentials explicitly.
5. Inventory stored envelopes. Keep the previous key until no required row has
   an old enc:v1 envelope or the old enc:v2 key id.
6. Remove TOKEN_ENC_KEY_PREVIOUS, deploy, and repeat the read/refresh checks.

If the active key is lost, restore it before reconnecting or refreshing an
integration. Replacing it blindly makes existing ciphertext unrecoverable.

## Supabase password protection

Leaked-password protection was enabled and security-advisor verified on
2026-08-17 for HiveLogic, HiveConnect, and HiveDoc. Supabase Auth now rejects
known leaked passwords on its checked password lifecycle.

HiveConnect's legacy redeem_invite, admin_create_user, and
admin_reset_password database functions write password hashes directly to
auth.users and therefore bypass that lifecycle. Their removal uses a
zero-downtime expand/contract rollout:

1. Apply `sql/hiveconnect/20260818_auth_password_lifecycle.sql`. It adds only
   service-role helpers and deliberately preserves the three legacy RPCs so
   the current application and rollback deployment continue to work.
2. Deploy the matching bridge/client. Confirm the standalone HiveConnect page
   fetches the versioned `app.js?v=20260818-auth` asset, then smoke invite
   redemption, admin account creation, and admin password reset through the
   bridge. Record that immutable deployment as the new rollback floor.
3. Apply `sql/hiveconnect/20260818_auth_password_lifecycle_cleanup.sql` only
   after the new deployment is healthy. It drops the three direct password
   writers. Older deployments are not valid rollback targets after this step.
4. Verify the four new helpers are executable only by service_role, the three
   legacy functions are absent, and the security advisor remains clean.

The bridge creates an Auth shell with a stable preselected UUID, then sets the
real password through GoTrue's checked Admin update path. Invite claims retain
that UUID so an acknowledged-lost create can be recovered exactly rather than
stranding an unknown account.

Reference: https://supabase.com/docs/guides/auth/password-security

## HiveConnect database hardening

The live audit found 29 SECURITY DEFINER functions inheriting broad EXECUTE
grants, plus a mutable b64url(bytea) search path. Migration
sql/hiveconnect/20260817_function_privilege_hardening.sql was applied on
2026-08-17. Its post-apply ACL audit found no PUBLIC grants, exactly five
intentional anonymous RPCs, and no role/search-path mismatches.

- Anonymous/token-gated before the password-lifecycle contract: invite_info, redeem_invite,
  guest_video_token, webhook_post, reina_read.
- Anonymous/token-gated after the contract: invite_info, guest_video_token,
  webhook_post, reina_read. The bridge replaces anonymous direct execution of
  redeem_invite.
- Signed-in application/RLS surface: the admin_* functions,
  can_access_channel, create_invite, create_video_guest_pass, create_webhook,
  is_admin, is_channel_member, livekit_token, my_role, revoke_webhook,
  toggle_pin.
- Trigger/internal only: guard_profile_change, handle_new_message,
  handle_new_user, require_admin.

Review the anonymous flows after every body change: their safety depends on
high-entropy, expiring tokens and strict row limits, not on a user session.

pg_net 0.20.4 is installed with its extension namespace recorded as public,
and this version reports extrelocatable=false. Do **not** blindly run ALTER
EXTENSION ... SET SCHEMA; it will fail. No user trigger/function dependency on
net.http_* was found in the 2026-08-17 read-only audit. During a maintenance
window, take a backup and either disable/re-enable the extension into
extensions after a dependency recheck, or ask Supabase Support to move the
non-relocatable extension. Re-run advisors afterward.

## HiveDoc database hardening

Migration sql/hivedoc/20260817_function_privilege_hardening.sql was applied
on 2026-08-17 and verified with no PUBLIC or anonymous grants.
can_access_folder, can_see_folder, and is_admin remain executable by
authenticated because live RLS policies call them. handle_new_user and
apply_sensitive_default are trigger-only and receive no client-role grant.

## HiveConnect Droplet firewall

No DigitalOcean credentials or infrastructure-as-code are present in this
repository, so firewall changes require the owner/infra account. Before
changing rules, record the Droplet id, attached services, current listening
ports (ss -lntup), and Chris's *current* public IP.

Create and attach a DigitalOcean Cloud Firewall with default-deny inbound:

- SSH/TCP 22 from Chris's current /32 only. Never commit the address.
- HTTPS/TCP 443 from the public internet.
- HTTP/TCP 80 only if the deployed redirect or certificate flow needs it.
- Add media/TURN/application ports only after matching them to a confirmed
  listening service and its vendor documentation; do not open a guessed range.

Start with required outbound DNS, HTTPS, package-update, mail, and application
dependencies inventoried from the host. If outbound allowlisting is not yet
complete, keep outbound open temporarily and schedule a measured restriction;
an untested egress deny can take production offline.

Also enforce host-level UFW rules that agree with the Cloud Firewall, SSH keys
only, password login disabled, direct root login disabled, automatic security
updates, and admin/database listeners bound to loopback or a private network.
Test a second SSH session before closing the first. DigitalOcean Cloud
Firewalls are stateful and separate from UFW:
https://docs.digitalocean.com/products/networking/firewalls/how-to/configure-rules/

## HiveSight source ownership

This repository contains only the compiled public/vi-app bundle and an
idempotent rebuild patch plus regression test. The actual HiveSight source is
not present in this repo, its history, or the accessible GitHub repository
list. The source-level auth repair is therefore blocked until that source is
recovered or intentionally adopted into a maintained repository. Do not treat
patching a generated bundle as permanent source ownership.
