import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_OUTPUT = 64 * 1024;
const TIMEOUT_MS = 10 * 60 * 1000;

function findNpmCli() {
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    process.env.APPDATA
      ? path.join(process.env.APPDATA, 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : null,
  ].filter(Boolean);
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) throw new Error('The npm CLI script could not be found beside the installed Node.js runtime.');
  return found;
}

function run(executable, args, cwd, signal) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: 'true', NO_COLOR: '1' },
    });
    let output = '';
    const append = chunk => { output = (output + chunk.toString()).slice(-MAX_OUTPUT); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    let terminated = false;
    const terminateTree = () => {
      if (terminated || child.exitCode !== null) return;
      terminated = true;
      if (process.platform === 'win32' && child.pid) {
        spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } else {
        child.kill('SIGTERM');
      }
    };
    const abort = () => terminateTree();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(terminateTree, TIMEOUT_MS);
    child.on('error', error => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve({ ok: false, code: null, output, error: error.message });
    });
    child.on('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve({ ok: code === 0, code, output });
    });
  });
}

export async function executeTask(task, signal) {
  const cwd = task.payload.path;
  if (task.task_type === 'repository_status') {
    return run('git.exe', ['status', '--short', '--branch'], cwd, signal);
  }
  if (task.task_type === 'repository_test') {
    return run(process.execPath, [findNpmCli(), 'test'], cwd, signal);
  }
  return { ok: false, blocked: true, output: 'This typed task is reserved but is not enabled in the first agent release.' };
}
