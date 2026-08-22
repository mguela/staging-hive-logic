import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeTask } from '../src/runner.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('cancellation terminates the npm process tree, including descendants', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows process-tree behavior is tested on Windows only.');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-agent-runner-'));
  const marker = path.join(root, 'child-survived.txt');
  try {
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      private: true,
      scripts: { test: 'node parent.cjs' },
    }));
    fs.writeFileSync(path.join(root, 'parent.cjs'), [
      "const { spawn } = require('node:child_process');",
      "spawn(process.execPath, ['child.cjs'], { stdio: 'ignore' });",
      'setTimeout(() => {}, 10000);',
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'child.cjs'), [
      "const fs = require('node:fs');",
      `setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, 'survived'), 1500);`,
      'setTimeout(() => {}, 10000);',
    ].join('\n'));
    const controller = new AbortController();
    const running = executeTask({
      task_type: 'repository_test',
      payload: { path: root },
    }, controller.signal);
    await wait(400);
    controller.abort();
    const result = await running;
    assert.equal(result.ok, false);
    await wait(1800);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
