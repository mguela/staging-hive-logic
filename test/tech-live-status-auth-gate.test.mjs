import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const start = html.indexOf('function loadTechLiveStatus(){');
const end = html.indexOf('\nif(!window.__techLiveStatusTimer)', start);

assert.ok(start >= 0 && end > start, 'loadTechLiveStatus must remain extractable');
const source = html.slice(start, end);

function harness({ session } = {}) {
  const calls = { fetch: [], errors: [], gate: 0, render: 0 };
  const window = {
    __HL_CUR_VIEW: 'schedule',
    hlRequireSession(onSession, onMissing) {
      calls.gate += 1;
      return Promise.resolve(session ? onSession(session) : onMissing());
    },
  };
  const context = {
    window,
    fetch(url, options) {
      calls.fetch.push({ url, options });
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, techs: [] }) });
    },
    console: { error(...args) { calls.errors.push(args); } },
    ALLCOLS: () => [],
    renderCal() { calls.render += 1; },
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nwindow.loadTechLiveStatus = loadTechLiveStatus;`, context);
  return { calls, window };
}

test('tech live status quietly skips signed-out boot before making a request', async () => {
  const { calls, window } = harness();

  await window.loadTechLiveStatus();

  assert.equal(calls.gate, 1, 'the shared session gate must decide whether the request may run');
  assert.deepEqual(calls.fetch, [], 'signed-out boot must not request protected live status');
  assert.deepEqual(calls.errors, [], 'an expected missing session is not a console error');
  assert.equal(calls.render, 0);
});

test('tech live status still fetches once with the restored bearer session', async () => {
  const { calls, window } = harness({ session: { access_token: 'restored-token' } });

  await window.loadTechLiveStatus();

  assert.equal(calls.gate, 1);
  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.fetch[0].url, '/api/track1?resource=tech_live_status');
  assert.equal(calls.fetch[0].options.headers.Authorization, 'Bearer restored-token');
  assert.deepEqual(calls.errors, []);
  assert.equal(calls.render, 1);
});
