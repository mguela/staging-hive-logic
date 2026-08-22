# HiveLogic Windows Agent setup

This first release creates a secure device control plane inside HiveLogic and a separate Windows service agent. The service makes outbound HTTPS requests only. It has no inbound listener, remote shell, remote desktop, mouse, keyboard, or unrestricted file browser.

## Before deployment

1. Apply `sql/035_automation_agents.sql` to the HiveLogic Supabase project.
2. Add `HIVELOGIC_TENANT_ID=ghgrp` to Vercel (the default is already `ghgrp`).
3. Deploy the feature branch to a protected preview.
4. Sign in as an admin and open **Team → Automation Devices**.

## Enroll a Windows computer

1. In HiveLogic Devices, select **Add computer** and copy the single-use code.
2. On the computer, install Node.js 20 or newer.
3. Copy `agents/windows/config.example.json` to `config.json`.
4. Replace the example approved path and grant only the required permissions (`read` or `test`).
5. Open an elevated PowerShell window and run the checked-in installer:

   ```powershell
   .\installer\Install-HiveLogicAgent.ps1 -ConfigPath .\config.json
   ```

Enrollment stores the device credential encrypted with Windows DPAPI using machine scope. Its file ACL permits only Administrators and SYSTEM. Each computer receives a unique, independently revocable credential.

## Supported tasks

- `repository_status`: exact `git status --short --branch`
- `repository_test`: exact `npm test`

The agent launches these exact executables and argument lists without a shell. Every task is checked against the real filesystem target, the locally approved path, permission list, immutable scope hash, and recorded approval where required. Build, write, deploy, rollback, update, shell, and desktop-control task types are rejected by both the server and device.

## Safety behavior

- Paused devices do not claim tasks.
- Emergency stop requests cancellation and prevents new work.
- Revoked credentials cannot heartbeat, poll, or report results.
- Test tasks require explicit approval tied to the immutable task scope hash.
- Cancellation terminates the complete Windows process tree.
- Windows junctions and symbolic links cannot escape an approved path.
- Output is bounded and redacted before upload.
- The device independently enforces local policy even after server approval.

## Production gates still required

- Code-sign the installer/service package.
- Add signed, atomic updates with rollback.
- Add a durable local SQLite journal before enabling write/deploy handlers.
- Add server integration tests against a disposable Supabase project.
- Rotate the previously exposed GitHub credential reported in the transfer audit.
