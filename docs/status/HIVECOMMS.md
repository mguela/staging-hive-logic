# HiveComms / HiveConnect status

**Evidence date:** 2026-08-17
**Owner:** No HiveComms owner is recorded in the repository.

## Repository state

- `api/hiveconnect-bridge.js` verifies the HiveLogic bearer identity, maps or
  provisions the matching HiveConnect account, and ignores caller-supplied
  identity fields. Disabled users, duplicate emails, and failed session mints
  fail closed.
- HiveConnect Tasks are a real backend surface. The Command Center bridge can
  list and complete tasks, with completion history attributed to the verified
  caller. The session log records an end-to-end preview completion on
  2026-08-16; this pass did not repeat that external write.
- The mounted HiveConnect UI and right-rail shortcuts have teardown coverage so
  their correction interval/observer does not survive after the mount stops.
- Mail code supports real mailbox connectors, but connector code is not proof
  that an account is linked.
- Account creation, invite redemption, and admin password reset now route
  through the authenticated server bridge and GoTrue's checked password-update
  path. A stable, database-retained Auth UUID makes an acknowledged-lost create
  recoverable. The standalone app cache key was bumped with this change.
- The additive lifecycle migration is live as
  `20260818002333 hiveconnect_auth_password_lifecycle_expand`. Its four helpers
  are service-role-only; the three legacy direct password writers remain until
  the matching production build is deployed and smoke-tested.

## Verification and open gaps

- The bridge suite passed all 11 mocked identity/provisioning scenarios; the
  HiveConnect tab/mount suite passed all 11 routing/teardown scenarios.
- The password-lifecycle suite passed all 11 normal, rejection, transport-
  ambiguity, authorization, ACL, and expand/contract scenarios. Leaked-password
  protection is enabled and advisor-verified for the HiveConnect project.
- Production was rechecked read-only on 2026-08-17: HiveConnect had zero
  `hc_ms_tokens` mailbox connections, 57 channels, 2,151 messages (latest at
  `2026-08-17T15:30Z`), and one task (latest update
  `2026-08-16T22:44Z`). The message/task counts prove current backend activity;
  the zero-token result means Microsoft mailbox features must still be labelled
  not connected.
- No live chat, mail, video, or telephony action was performed. Those checks
  require the external HiveConnect project and user/account credentials.
- Replacement LiveKit credentials exist only in named HiveConnect Vault
  entries. The self-hosted video server has not been switched because no
  DigitalOcean session/token or accepted SSH key is available; the old pair
  remains active and the Vault token-function migration remains unapplied.
- The lifecycle cleanup migration remains intentionally unapplied until the
  exact new production app is healthy. Admin-created/reset temporary passwords
  are random and no-store, but moving to SMTP invite/recovery emails is still a
  product decision because it changes the owner workflow.

**Current label:** Auth bridge, task contracts, and the lifecycle expand phase
are implemented and verified; lifecycle contract cleanup awaits the matching
deployment. Live chat/task data exists, mailbox features are not connected,
and video/telephony remain externally unverified.
