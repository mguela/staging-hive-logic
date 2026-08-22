import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = path.join(__dirname, '..', 'api', 'track1.js');
const source = fs.readFileSync(SRC_PATH, 'utf-8');

function extractBlock(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1) throw new Error('marker not found: ' + marker);
  const braceStart = src.indexOf('{', start);
  let depth = 1;
  let i = braceStart + 1;
  while (depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(start, i);
}

const GATE_MARKER = "if (resource !== 'check_new_leads') {";
const gateSrc = extractBlock(source, GATE_MARKER);

test('reina_todo_set has no handler-level exemption from the Track 1 auth gate', () => {
  assert.ok(source.includes(GATE_MARKER),
    'the Dev To-Do writer must use the same user-or-cron auth gate as other mutable resources');
});

async function runGate({ resource, method, gateOk }) {
  const calls = [];
  const res = {
    _status: 200,
    status(code) { this._status = code; return this; },
    json(body) { calls.push({ status: this._status, body }); return this; },
  };
  const req = { method };
  const requireApiAuth = async () => (gateOk ? { ok: true } : { ok: false });
  const wrapper = `(async function(resource, req, requireApiAuth, res) {
${gateSrc}
  return 'passed';
})`;
  const fn = vm.runInNewContext(wrapper, { Promise, console });
  const result = await fn(resource, req, requireApiAuth, res);
  return { result, calls };
}

test('reina_todo_set POST with no auth is rejected', async () => {
  const { result, calls } = await runGate({ resource: 'reina_todo_set', method: 'POST', gateOk: false });
  assert.notStrictEqual(result, 'passed');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].status, 401);
});

test('reina_todo_set GET with no auth remains gated', async () => {
  const { result, calls } = await runGate({ resource: 'reina_todo_set', method: 'GET', gateOk: false });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].status, 401);
  assert.notStrictEqual(result, 'passed');
});

test('reina_todo_get (a different resource) with no auth: still gated -- the exemption never widens beyond reina_todo_set', async () => {
  const { result, calls } = await runGate({ resource: 'reina_todo_get', method: 'POST', gateOk: false });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].status, 401);
});

test('check_new_leads (the original cron exemption) is unaffected by this change', async () => {
  const { result } = await runGate({ resource: 'check_new_leads', method: 'GET', gateOk: false });
  assert.strictEqual(result, 'passed');
});

test('any other resource still requires a valid session -- a real gate failure still 401s', async () => {
  const { result, calls } = await runGate({ resource: 'cash', method: 'GET', gateOk: false });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].status, 401);
  assert.notStrictEqual(result, 'passed');
});

test('any other resource with a valid session still passes (existing behavior preserved)', async () => {
  const { result, calls } = await runGate({ resource: 'cash', method: 'GET', gateOk: true });
  assert.strictEqual(result, 'passed');
  assert.strictEqual(calls.length, 0);
});
