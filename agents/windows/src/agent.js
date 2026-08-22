import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { authorizeTask } from './policy.js';
import { executeTask } from './runner.js';

const stateDir = process.env.HIVELOGIC_AGENT_STATE_DIR || path.join(process.env.ProgramData || os.homedir(), 'HiveLogic', 'Agent');
const config = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8'));
const credential = execFileSync('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', path.join(import.meta.dirname, '..', 'scripts', 'unprotect-credential.ps1'),
  '-Path', path.join(stateDir, 'credential.dpapi'),
], { encoding: 'utf8', windowsHide: true }).trim();
const agentId = credential.slice(0, credential.indexOf('.'));
const base = String(config.controlPlaneUrl).replace(/\/$/, '');
let stopped = false;
let activeController = null;

function redact(value) {
  return String(value || '')
    .replace(credential, '[DEVICE_CREDENTIAL]')
    .replace(/(token|secret|password|authorization)\s*[:=]\s*\S+/gi, '$1=[REDACTED]');
}

async function call(action, method = 'GET', body) {
  const response = await fetch(`${base}/api/agents/device?action=${encodeURIComponent(action)}`, {
    method,
    headers: { Authorization: `Agent ${credential}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 401) {
    stopped = true;
    throw new Error('Device credential was revoked.');
  }
  if (!response.ok) throw new Error(`Control plane returned ${response.status}.`);
  return response.json();
}

async function event(taskId, eventName, fields = {}) {
  return call('event', 'POST', { taskId, event: eventName, ...fields });
}

async function cycle() {
  const heartbeat = await call('heartbeat', 'POST', {
    agentVersion: '0.1.0',
    hostname: os.hostname(),
    capabilities: ['repository_status', 'repository_test'],
  });
  if (heartbeat.emergencyStop && activeController) activeController.abort();
  if (heartbeat.paused || heartbeat.emergencyStop) return;

  const polled = await call('poll');
  const task = polled.task;
  if (!task) return;
  const decision = authorizeTask(config, task, agentId);
  if (!decision.ok) {
    await event(task.id, 'blocked', { summary: decision.reason });
    return;
  }
  activeController = new AbortController();
  await event(task.id, 'started');
  const checkpoint = setInterval(async () => {
    try {
      const state = await call('heartbeat', 'POST', {
        agentVersion: '0.1.0',
        currentTaskId: task.id,
        capabilities: ['repository_status', 'repository_test'],
      });
      if (state.emergencyStop || state.cancelRequested) activeController?.abort();
    } catch (error) {
      process.stderr.write(`${redact(error.message)}\n`);
    }
  }, 3000);
  const result = await executeTask(task, activeController.signal);
  clearInterval(checkpoint);
  const wasCancelled = activeController.signal.aborted;
  activeController = null;
  const summary = redact(result.output || result.error || '').slice(-1000);
  await event(task.id, wasCancelled ? 'cancelled' : result.blocked ? 'blocked' : result.ok ? 'succeeded' : 'failed', { summary });
}

async function main() {
  while (!stopped) {
    try { await cycle(); } catch (error) { process.stderr.write(`${redact(error.message)}\n`); }
    await new Promise(resolve => setTimeout(resolve, Math.max(2000, Number(config.pollIntervalMs) || 5000)));
  }
}

process.on('SIGTERM', () => { stopped = true; if (activeController) activeController.abort(); });
process.on('SIGINT', () => { stopped = true; if (activeController) activeController.abort(); });
main();
