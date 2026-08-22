// test/oauth-state.test.mjs
// Item 5 (2026-08-01): proves OAuth state is cryptographically random,
// single-use, short-lived, and validated at the callback — closing the CSRF /
// authorization-code-injection hole (Jobber used a static state; Jobber & QBO
// callbacks validated nothing). Fully in-memory; no network, no DB, no secret.
//   node --test test/oauth-state.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  genOAuthState, hashState,
  issueOAuthState, consumeOAuthState, claimOAuthStateOnce,
  escapeHtml, escapeJsonForScript,
} from '../api/_lib/oauth-state.js';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'svc';

// In-memory oauth_states table honoring the unique(provider,state_hash) index.
function memStore() {
  const rows = [];
  let idc = 1;
  const supabaseRequest = async (path, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const table = path.split('?')[0];
    if (table !== 'oauth_states') throw new Error('unexpected path ' + path);
    if (method === 'POST') {
      const body = JSON.parse(opts.body);
      if (rows.some((r) => r.provider === body.provider && r.state_hash === body.state_hash)) {
        return { ok: false, status: 409, text: async () => 'conflict', json: async () => ({}) };
      }
      const row = { id: idc++, used_at: null, ...body };
      rows.push(row);
      return { ok: true, status: 201, text: async () => JSON.stringify([row]), json: async () => [row] };
    }
    if (method === 'GET') {
      const q = new URLSearchParams(path.split('?')[1] || '');
      let out = rows.slice();
      for (const [k, v] of q) {
        if (k === 'select') continue;
        const m = /^eq\.(.*)$/.exec(v);
        if (!m) continue;
        const val = decodeURIComponent(m[1]);
        out = out.filter((r) => String(r[k]) === val);
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(out), json: async () => out };
    }
    if (method === 'PATCH') {
      const id = Number((/[?&]id=eq\.(\d+)/.exec(path) || [])[1]);
      const requireUnused = path.includes('used_at=is.null');
      const body = JSON.parse(opts.body);
      const row = rows.find((r) => r.id === id && (!requireUnused || r.used_at === null));
      if (!row) return { ok: true, status: 200, text: async () => '[]', json: async () => [] };
      Object.assign(row, body);
      return { ok: true, status: 200, text: async () => JSON.stringify([row]), json: async () => [row] };
    }
    throw new Error('unexpected method ' + method);
  };
  return { supabaseRequest, rows };
}

test('genOAuthState is high-entropy hex and unique per call', () => {
  const a = genOAuthState(), b = genOAuthState();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

test('issue stores the HASH (never the raw state) and returns the raw', async () => {
  const store = memStore();
  const raw = await issueOAuthState({ provider: 'jobber', userId: 'user-1', deps: store });
  assert.match(raw, /^[0-9a-f]{64}$/);
  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0].state_hash, hashState(raw));
  assert.notEqual(store.rows[0].state_hash, raw);
  assert.equal(store.rows[0].user_id, 'user-1');
});

test('consume: a valid state succeeds exactly once, then is reused-rejected', async () => {
  const store = memStore();
  const raw = await issueOAuthState({ provider: 'jobber', userId: 'user-1', deps: store });
  const first = await consumeOAuthState({ provider: 'jobber', state: raw, deps: store });
  assert.equal(first.ok, true);
  assert.equal(first.userId, 'user-1');
  const second = await consumeOAuthState({ provider: 'jobber', state: raw, deps: store });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'reused');
});

test('consume rejects missing, unknown, and expired state', async () => {
  const store = memStore();
  assert.deepEqual(await consumeOAuthState({ provider: 'jobber', state: '', deps: store }), { ok: false, reason: 'missing' });
  assert.equal((await consumeOAuthState({ provider: 'jobber', state: 'never-issued', deps: store })).reason, 'unknown');
  // expired: issue with a negative ttl
  const raw = await issueOAuthState({ provider: 'qbo', ttlMs: -1000, deps: store });
  assert.equal((await consumeOAuthState({ provider: 'qbo', state: raw, deps: store })).reason, 'expired');
});

test('consume is provider-scoped: a jobber state cannot be spent as a qbo state', async () => {
  const store = memStore();
  const raw = await issueOAuthState({ provider: 'jobber', deps: store });
  assert.equal((await consumeOAuthState({ provider: 'qbo', state: raw, deps: store })).ok, false);
});

test('claimOAuthStateOnce: first claim wins, duplicate is reused-rejected', async () => {
  const store = memStore();
  const h = hashState('some-msmail-state');
  assert.equal((await claimOAuthStateOnce({ provider: 'msmail', stateHash: h, deps: store })).ok, true);
  const dup = await claimOAuthStateOnce({ provider: 'msmail', stateHash: h, deps: store });
  assert.equal(dup.ok, false);
  assert.equal(dup.reason, 'reused');
});

test('claimOAuthStateOnce fails OPEN on a store exception (never severs mail)', async () => {
  const deps = { supabaseRequest: async () => { throw new Error('db down'); } };
  const r = await claimOAuthStateOnce({ provider: 'msmail', stateHash: 'x', deps });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'store-exception-open');
});

test('escapeHtml neutralizes an HTML-injection payload in a callback page', () => {
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
});

test('escapeJsonForScript prevents breaking out of a <script> block', () => {
  const out = escapeJsonForScript({ username: '</script><script>alert(1)</script>' });
  assert.ok(!out.includes('</script>'), 'no literal </script> can appear');
  assert.ok(out.includes('\\u003c'), '< is unicode-escaped');
});

// ---- handler-level: jobber callback rejects a bad state before doing anything
test('jobber callback: a code with NO state is rejected (no token exchange)', async () => {
  const original = global.fetch;
  let tokenExchangeCalled = false;
  global.fetch = async (url) => {
    if (String(url).includes('getjobber.com')) tokenExchangeCalled = true;
    throw new Error('should not reach any upstream');
  };
  try {
    const { default: handler } = await import('../api/jobber/callback.js');
    let redirectedTo = null;
    const res = { redirect: (u) => { redirectedTo = u; }, status: () => ({ send: () => {} }) };
    await handler({ query: { code: 'abc' /* no state */ } }, res);
    assert.match(redirectedTo || '', /jobber_error=invalid_state_missing/);
    assert.equal(tokenExchangeCalled, false, 'must not exchange the code without a valid state');
  } finally {
    global.fetch = original;
  }
});
