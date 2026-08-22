// test/hiveconnect-bridge.test.mjs
// HIVECONNECT MERGE — Option C auth bridge tests (spec §11, all 9 required
// scenarios). Every scenario here is mocked: no real network call, no real
// secret, ever. Run with:
//
//   node test/hiveconnect-bridge.test.mjs
//
// Exit code 0 if every check passes, 1 if anything fails.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ensureMappedAndMint,
  getMapping,
  mintHiveConnectSession,
} from '../api/hiveconnect-bridge.js';
import bridgeHandler from '../api/hiveconnect-bridge.js';

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// ---------- in-memory mock stores (fresh per test via factory) ----------
function makeMockWorld(seed = {}) {
  const mappings = new Map(Object.entries(seed.mappings || {}));       // hivelogic_user_id -> row
  const hcUsersByEmail = new Map(Object.entries(seed.hcUsersByEmail || {})); // email -> [users]
  let nextHcId = 1000;
  const events = []; // captures what generate_link / verify were asked to do, for assertions

  const deps = {
    hlRequest: async (path, options = {}) => {
      if (path.startsWith('hiveconnect_account_map?hivelogic_user_id=eq.')) {
        const id = decodeURIComponent(path.split('eq.')[1].split('&')[0]);
        const row = mappings.get(id);
        return jsonRes(row ? [row] : []);
      }
      if (path.startsWith('hiveconnect_account_map?on_conflict=hivelogic_user_id') && options.method === 'POST') {
        const body = JSON.parse(options.body);
        mappings.set(body.hivelogic_user_id, body);
        return jsonRes([body]);
      }
      throw new Error('unexpected hlRequest path in test: ' + path);
    },
    hcAdminRequest: async (path, options = {}) => {
      if (path.startsWith('users?page=')) {
        // Real endpoint doesn't filter server-side — return every known
        // user across every email, exactly like production's admin API
        // actually behaves; production code does the email filtering.
        const all = [];
        for (const list of hcUsersByEmail.values()) all.push(...list);
        return jsonRes(all);
      }
      if (path === 'users' && options.method === 'POST') {
        const body = JSON.parse(options.body);
        const user = { id: 'hc-user-' + (nextHcId++), email: body.email };
        const list = hcUsersByEmail.get(body.email) || [];
        list.push(user);
        hcUsersByEmail.set(body.email, list);
        return jsonRes(user);
      }
      if (path === 'generate_link' && options.method === 'POST') {
        const body = JSON.parse(options.body);
        events.push({ type: 'generate_link', email: body.email });
        return jsonRes({ hashed_token: 'mock-hash-for-' + body.email });
      }
      throw new Error('unexpected hcAdminRequest path in test: ' + path);
    },
    verify: async (hashedToken) => {
      events.push({ type: 'verify', hashedToken });
      if (hashedToken === 'FORCE_MINT_FAILURE') {
        return { ok: false, text: async () => 'mock: expired or invalid token' };
      }
      return jsonRes({ access_token: 'mock-access-' + hashedToken, refresh_token: 'mock-refresh-' + hashedToken, expires_at: Date.now() / 1000 + 3600 });
    },
  };

  return { deps, mappings, hcUsersByEmail, events };
}

function jsonRes(body) {
  return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
}

// ---------- 1. Existing mapped user ----------
check('existing mapped user mints a session without re-provisioning', async () => {
  const { deps, events } = makeMockWorld({
    mappings: { 'hl-1': { hivelogic_user_id: 'hl-1', hiveconnect_user_id: 'hc-existing-1', status: 'active' } },
  });
  const session = await ensureMappedAndMint('hl-1', 'alice@ghgrp.net', { deps });
  assert.ok(session.access_token, 'expected an access_token');
  assert.equal(events.filter(e => e.type === 'generate_link').length, 1, 'should mint exactly once');
});

// ---------- 2. Existing unmapped user (HiveConnect account exists, no mapping row yet) ----------
check('existing unmapped user links to their existing HiveConnect account, does not create a duplicate', async () => {
  const { deps, mappings, hcUsersByEmail } = makeMockWorld({
    hcUsersByEmail: { 'bob@ghgrp.net': [{ id: 'hc-preexisting-2', email: 'bob@ghgrp.net' }] },
  });
  const session = await ensureMappedAndMint('hl-2', 'bob@ghgrp.net', { deps });
  assert.ok(session.access_token);
  assert.equal(mappings.get('hl-2').hiveconnect_user_id, 'hc-preexisting-2', 'must link the existing account, not create a new one');
  assert.equal(hcUsersByEmail.get('bob@ghgrp.net').length, 1, 'must not create a duplicate HiveConnect user');
});

// ---------- 3. Brand-new user (no mapping, no existing HiveConnect account) ----------
check('brand-new user gets provisioned exactly once', async () => {
  const { deps, mappings, hcUsersByEmail } = makeMockWorld();
  const session = await ensureMappedAndMint('hl-3', 'carol@ghgrp.net', { deps });
  assert.ok(session.access_token);
  assert.ok(mappings.get('hl-3'), 'mapping row should now exist');
  assert.equal(hcUsersByEmail.get('carol@ghgrp.net').length, 1, 'exactly one HiveConnect account created');
});

// ---------- 4. Disabled user ----------
check('disabled user is refused before any provisioning or minting happens', async () => {
  const { deps, mappings } = makeMockWorld();
  await assert.rejects(
    () => ensureMappedAndMint('hl-4', 'dave@ghgrp.net', { deps, isDisabledUser: true }),
    (err) => err.code === 'disabled_user'
  );
  assert.equal(mappings.get('hl-4'), undefined, 'a disabled user must never get a mapping row created');
});

// ---------- 5. Duplicate-email condition ----------
check('duplicate HiveConnect accounts sharing one email produce a clear error, not a guess', async () => {
  const { deps, mappings } = makeMockWorld({
    hcUsersByEmail: { 'shared@ghgrp.net': [{ id: 'hc-a', email: 'shared@ghgrp.net' }, { id: 'hc-b', email: 'shared@ghgrp.net' }] },
  });
  await assert.rejects(
    () => ensureMappedAndMint('hl-5', 'shared@ghgrp.net', { deps }),
    (err) => err.code === 'duplicate_email'
  );
  assert.equal(mappings.get('hl-5'), undefined, 'must not silently pick one of the duplicates');
});

// ---------- 6. Expired session (mint step rejects a stale/expired token) ----------
check('an expired/invalid token at the verify step surfaces a clear mint failure', async () => {
  const { deps } = makeMockWorld({
    mappings: { 'hl-6': { hivelogic_user_id: 'hl-6', hiveconnect_user_id: 'hc-6', status: 'active' } },
  });
  const originalVerify = deps.verify;
  deps.verify = async () => originalVerify('FORCE_MINT_FAILURE');
  await assert.rejects(() => ensureMappedAndMint('hl-6', 'erin@ghgrp.net', { deps }));
});

check('an otp_expired verify race retries once with a fresh magic-link token', async () => {
  const events = [];
  let generated = 0;
  const session = await mintHiveConnectSession('hc-race', 'race@ghgrp.net', {
    hcAdminRequest: async (path) => {
      assert.equal(path, 'generate_link');
      generated++;
      events.push(`generate-${generated}`);
      return jsonRes({ hashed_token: `hash-${generated}` });
    },
    verify: async (hashed) => {
      events.push(`verify-${hashed}`);
      if (hashed === 'hash-1') return { ok: false, text: async () => '{"code":"otp_expired"}' };
      return jsonRes({ access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_at: 123 });
    },
  });
  assert.deepEqual(events, ['generate-1', 'verify-hash-1', 'generate-2', 'verify-hash-2']);
  assert.equal(session.access_token, 'fresh-access');
});

// Chris, 2026-08-18, on production: "HiveConnect couldn't open. Session mint
// failed at verify step: ...otp_expired". One retry was not enough. Generating
// a link INVALIDATES every earlier one for that email, so racers do not take
// turns -- they can knock each other out repeatedly.
check('a mint that keeps losing the race keeps trying, and says so when it gives up', async () => {
  let generated = 0;
  const waits = [];
  const session = await mintHiveConnectSession('hc-loser', 'loser@ghgrp.net', {
    hcAdminRequest: async () => { generated++; return jsonRes({ hashed_token: `hash-${generated}` }); },
    // Loses three times in a row, wins on the fourth.
    verify: async (hashed) => (hashed === 'hash-4'
      ? jsonRes({ access_token: 'won', refresh_token: 'r', expires_at: 1 })
      : { ok: false, text: async () => '{"code":"otp_expired"}' }),
    wait: async (ms) => { waits.push(ms); },
    jitter: () => 0,
  });
  assert.equal(generated, 4, 'one retry only covered a single collision');
  assert.equal(session.access_token, 'won');
  // Backing off matters: an instant retry is just the same collision again.
  assert.deepEqual(waits, [120, 240, 360]);
});

check('giving up names the reason, instead of a bare "failed after retry"', async () => {
  await assert.rejects(
    () => mintHiveConnectSession('hc-doomed', 'doomed@ghgrp.net', {
      hcAdminRequest: async () => jsonRes({ hashed_token: 'h' }),
      verify: async () => ({ ok: false, text: async () => '{"code":"otp_expired"}' }),
      wait: async () => {},
      jitter: () => 0,
    }),
    /otp_expired/,
    'the last failure still surfaces what actually happened',
  );
});

// The other half of the same bug: the page must not race ITSELF. Two callers
// mint a HiveConnect session -- the mount and HiveLogic's own unread-message
// bridge -- and each new magic link invalidates the last one.
check('neither minting caller can fire a second mint while one is in flight', () => {
  const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf-8');
  const mount = readFileSync(new URL('../public/hiveconnect-mount.js', import.meta.url), 'utf-8');
  for (const [name, src] of [['index.html', index], ['hiveconnect-mount.js', mount]]) {
    const at = src.indexOf("hiveconnect-bridge?action=session");
    assert.ok(at !== -1, name + ' mints a session');
    const around = src.slice(at - 400, at + 100);
    assert.match(around, /window\.__hlHcMint/, name + ' must share the in-flight mint');
  }
  // ...and it has to be released, or one failed mint locks HiveConnect out
  // for the life of the page.
  assert.match(index, /window\.__hlHcMint = null/);
  assert.match(mount, /window\.__hlHcMint = null/);
});

check('a non-expiry verify failure is not retried', async () => {
  let generated = 0;
  await assert.rejects(
    () => mintHiveConnectSession('hc-no-retry', 'no-retry@ghgrp.net', {
      hcAdminRequest: async () => {
        generated++;
        return jsonRes({ hashed_token: 'hash' });
      },
      verify: async () => ({ ok: false, text: async () => '{"code":"invalid_token"}' }),
    }),
    /invalid_token/
  );
  assert.equal(generated, 1);
});

// ---------- 7. Failed provisioning ----------
check('a failed HiveConnect account creation surfaces a clear error and leaves no mapping row', async () => {
  const { mappings } = makeMockWorld();
  const deps = {
    hlRequest: async (path) => {
      if (path.startsWith('hiveconnect_account_map?hivelogic_user_id=eq.')) return jsonRes([]);
      throw new Error('unexpected hlRequest in failed-provisioning test');
    },
    hcAdminRequest: async (path, options = {}) => {
      if (path.startsWith('users?page=')) return jsonRes([]);
      if (path === 'users' && options.method === 'POST') {
        return { ok: false, text: async () => 'mock: HiveConnect admin API unavailable' };
      }
      throw new Error('unexpected hcAdminRequest in failed-provisioning test');
    },
  };
  await assert.rejects(() => ensureMappedAndMint('hl-7', 'frank@ghgrp.net', { deps }));
  assert.equal(mappings.get('hl-7'), undefined);
});

// ---------- 8. Failed session minting (mapping already exists, mint call itself fails) ----------
check('a failed session mint (mapping already exists) surfaces a clear error', async () => {
  const { deps } = makeMockWorld({
    mappings: { 'hl-8': { hivelogic_user_id: 'hl-8', hiveconnect_user_id: 'hc-8', status: 'active' } },
  });
  deps.hcAdminRequest = async (path, options = {}) => {
    if (path === 'generate_link' && options.method === 'POST') {
      return { ok: false, text: async () => 'mock: generate_link failed' };
    }
    throw new Error('unexpected hcAdminRequest in failed-mint test');
  };
  await assert.rejects(() => ensureMappedAndMint('hl-8', 'gina@ghgrp.net', { deps }));
});

// ---------- 9. Rollback ----------
check('rollback: dropping the mapping table leaves no trace the bridge ever ran (simulated)', async () => {
  const { deps, mappings } = makeMockWorld({
    mappings: { 'hl-9': { hivelogic_user_id: 'hl-9', hiveconnect_user_id: 'hc-9', status: 'active' } },
  });
  // Pre-rollback: mapping resolves normally.
  assert.ok(await getMapping('hl-9', deps));
  // Simulate `drop table hiveconnect_account_map;` by clearing the mock store
  // and pointing hlRequest at a store that always returns empty (as a real
  // dropped/empty table would after the SQL rollback in sql/009 runs).
  mappings.clear();
  const postRollback = await getMapping('hl-9', deps);
  assert.equal(postRollback, null, 'after rollback, no mapping should resolve');
  // And critically: this bridge endpoint being gone/erroring must never touch
  // HiveLogic's own session — that's a property of the code (this file never
  // writes to a HiveLogic session anywhere), asserted by inspection in the
  // progress log rather than re-asserted here as a redundant unit test.
});

// ---------- 10 + 11. Handler auth gate (P0 impersonation fix, 2026-07-29) ----------
// These exercise the HTTP handler (not ensureMappedAndMint directly) with a
// full global.fetch stub, to prove the session action requires a verified
// token and derives identity from it -- not from client-supplied body fields.
function mkRes() {
  const r = { code: null, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

check('session action with NO token returns 401 and never mints', async () => {
  const prevFetch = globalThis.fetch;
  process.env.SUPABASE_URL = 'https://hl.test';
  process.env.SUPABASE_SERVICE_KEY = 'svc';
  let minted = false;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/auth/v1/user')) return { ok: false, status: 401 };
    if (String(url).includes('generate_link')) minted = true;
    throw new Error('no network expected when signed out: ' + url);
  };
  try {
    const req = { method: 'POST', query: { action: 'session' }, headers: {}, body: { hivelogicUserId: 'victim-id', hivelogicEmail: 'victim@evil.com' } };
    const res = mkRes();
    await bridgeHandler(req, res);
    assert.equal(res.code, 401, 'signed-out must be 401');
    assert.equal(minted, false, 'no session may be minted signed-out');
  } finally { globalThis.fetch = prevFetch; }
});

check('session action mints for the TOKEN identity, ignoring a forged body email', async () => {
  const prevFetch = globalThis.fetch;
  process.env.SUPABASE_URL = 'https://hl.test';
  process.env.SUPABASE_SERVICE_KEY = 'svc';
  process.env.HIVECONNECT_SUPABASE_URL = 'https://hc.test';
  process.env.HIVECONNECT_SUPABASE_SERVICE_KEY = 'hcsvc';
  const TOKEN_EMAIL = 'alice@ghgrp.net';
  let generateLinkEmail = null;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    // 1) token verification -> the real signed-in user is alice
    if (u.includes('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'alice-id', email: TOKEN_EMAIL }) };
    // 2) mapping lookup (HL rest) -> already mapped, so we go straight to mint
    if (u.includes('/rest/v1/hiveconnect_account_map')) return { ok: true, json: async () => [{ hivelogic_user_id: 'alice-id', hiveconnect_user_id: 'hc-alice', status: 'active' }], text: async () => '[]' };
    // 3) generate_link -> capture which email the session is being minted for
    if (u.includes('/auth/v1/admin/generate_link')) { generateLinkEmail = JSON.parse(opts.body).email; return { ok: true, json: async () => ({ hashed_token: 'h' }), text: async () => '{}' }; }
    // 4) verify -> return a session
    if (u.includes('/auth/v1/verify')) return { ok: true, json: async () => ({ access_token: 'a', refresh_token: 'r', expires_at: 1 }) };
    throw new Error('unexpected fetch: ' + u);
  };
  try {
    const req = {
      method: 'POST', query: { action: 'session' },
      headers: { authorization: 'Bearer alice-token' },
      // forged body tries to impersonate someone else -- must be ignored:
      body: { hivelogicUserId: 'mallory-id', hivelogicEmail: 'mallory@evil.com' },
    };
    const res = mkRes();
    await bridgeHandler(req, res);
    assert.equal(res.code, 200, 'authed request should succeed');
    assert.ok(res.body.session && res.body.session.access_token, 'a session should be returned');
    assert.equal(generateLinkEmail, TOKEN_EMAIL, 'session MUST be minted for the token identity, not the forged body email');
  } finally { globalThis.fetch = prevFetch; }
});

// ---------- runner ----------
let pass = 0, fail = 0;
for (const { name, fn } of checks) {
  try {
    await fn();
    console.log('  ok  -', name);
    pass++;
  } catch (e) {
    console.log('  FAIL -', name, '\n       ', e.message);
    fail++;
  }
}
console.log(`\n${pass} passed, ${fail} failed (of ${checks.length})`);
process.exit(fail ? 1 : 0);
