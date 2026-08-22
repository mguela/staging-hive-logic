import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { execFileSync } from 'node:child_process';

const stateDir = process.env.HIVELOGIC_AGENT_STATE_DIR || path.join(process.env.ProgramData || os.homedir(), 'HiveLogic', 'Agent');
const configPath = process.argv[2] || path.join(process.cwd(), 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const enrollmentCode = await rl.question('Paste the single-use HiveLogic enrollment code: ');
const displayName = await rl.question(`Device name [${os.hostname()}]: `);
rl.close();

const response = await fetch(`${String(config.controlPlaneUrl).replace(/\/$/, '')}/api/agents/enrollment?action=consume`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    enrollmentCode: enrollmentCode.trim(),
    hostname: os.hostname(),
    displayName: displayName.trim() || os.hostname(),
    agentVersion: '0.1.0',
    capabilities: ['repository_status', 'repository_test'],
    approvedScopes: config.approvedScopes || [],
  }),
});
const result = await response.json();
if (!response.ok || !result.ok) throw new Error(result.error || 'Enrollment failed.');
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
execFileSync('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', path.join(import.meta.dirname, '..', 'scripts', 'protect-credential.ps1'),
  '-Path', path.join(stateDir, 'credential.dpapi'),
  '-Value', result.credential,
], { windowsHide: true, stdio: 'ignore' });
process.stdout.write(`Enrolled ${result.agent.display_name}. Install the Windows service next.\n`);
