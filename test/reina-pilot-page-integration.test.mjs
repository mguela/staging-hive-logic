import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const INDEX_URL = new URL('../public/index.html', import.meta.url);

test('current-main purple panel mounts the strict pilot host with no legacy chat fallback', () => {
  const index = readFileSync(INDEX_URL, 'utf8');
  const start = index.indexOf('<button id="rnaFab"');
  const end = index.indexOf('end Reina layer', start);
  assert.ok(start >= 0 && end > start, 'the existing purple Reina shell must remain present');
  const block = index.slice(start, end);

  for (const id of ['rnaFab', 'rnaPanel', 'rnaMode', 'rnaVoice', 'rnaVoiceLabel', 'rnaVoiceHint',
    'rnaStage', 'rnaHistory', 'rnaSettings', 'rnaMin', 'rnaX', 'rnaFeed', 'rnaIn', 'rnaSend']) {
    assert.match(block, new RegExp(`id="${id}"`, 'u'));
  }
  assert.equal((index.match(/id="rnaVoice"/gu) || []).length, 1,
    'Voice has one control inside the Reina popup and no duplicate beside global Settings');
  const topbarEnd = index.indexOf('</header>');
  assert.doesNotMatch(index.slice(0, topbarEnd > 0 ? topbarEnd : start), /id="rnaVoice"/u);
  assert.match(index, /\.rnaM\.q\{background:#e9e9eb/, 'Reina messages use the familiar left-side neutral bubble');
  assert.match(index, /\.rnaM\.u\{background:#0a84ff/, 'user messages use the familiar right-side blue bubble');
  assert.match(index, /#rnaIn\{flex:1;border:1px solid #d1d1d6;border-radius:19px/, 'composer uses a rounded familiar-message input');
  assert.match(index, /#rnaPanel\{[^}]*width:min\(430px,[^}]*height:min\(620px/, 'the popup uses Reina Lab desktop geometry');
  assert.match(index, /aria-label="Move Reina popup"/u);
  assert.match(index, /data-rna-resize="nw"/u);
  // One voice control, holding the walkie-talkie model of the Chirp button.
  // It replaced three: a Voice On/Off toggle labelled with a state instead of
  // an action, a "Stop talking" button that stopped REINA rather than the
  // speaker, and a separate Listening chip repeating what the toggle should
  // already have shown.
  assert.match(index, /id="rnaVoiceLabel">HOLD<\/span>/u,
    'a big round button you hold, the way the Chirp one already works');
  assert.match(index, /id="rnaVoiceHint">Hold to talk · release to send<\/div>/u,
    'with the instruction spelled out under it');
  assert.match(index, /class="rnaStage" id="rnaStage"/u, 'on its own stage, not lost in the header');
  const stageAt = index.indexOf('id="rnaStage"');
  const composerAt = index.indexOf('id="rnaBar"');
  assert.ok(stageAt > 0 && composerAt > stageAt,
    'and directly above the composer, where a thumb already is');
  assert.match(index, /id="rnaVoice"[^>]*title="Hold to talk, release to send"/u);
  assert.doesNotMatch(index, /id="rnaStopTalking"/u, 'the ambiguous stop button is gone');
  assert.doesNotMatch(index, /id="rnaVoiceToggle"/u, 'and so is the state-labelled toggle');
  assert.doesNotMatch(index, /id="rnaListening"/u, 'and the duplicate chip with it');
  assert.match(index, /id="rnaSettings"[^>]*aria-label="Voice settings"/u,
    'the icon buttons still name themselves for screen readers');
  assert.match(index, /id="rnaHistory"[^>]*aria-label="Conversation history"/u);
  assert.match(index, /@media\(max-width:760px\)\{#rnaPanel\{left:0!important;top:0!important/u);
  assert.match(index, /\.rnaM:empty\{display:none\}/, 'empty voice and interim placeholders do not render as bubbles');
  const scripts = [
    '/reina-login-brief-controller.js',
    '/reina-pilot-client.js',
    '/reina-typed-panel-controller.js',
    '/reina-pilot-host.js',
  ];
  let previous = -1;
  for (const script of scripts) {
    const position = block.indexOf(script);
    assert.ok(position > previous, `${script} must load in dependency order`);
    previous = position;
  }
  assert.match(block, /Object\.getOwnPropertyDescriptor\(window,'ReinaPilotHost'\)/u);
  assert.match(block, /Object\.getOwnPropertyDescriptor\(host,'installReinaPilotPage'\)/u);
  assert.match(block, /const HL_REINA_PILOT_INSTALLER_V1=/u);
  assert.match(block, /install\(\{documentRef:document,authClient:authClient\}\)/u);
  assert.doesNotMatch(block, /authClient:window\.sb/u);
  assert.match(index, /HL_REINA_PILOT_INSTALLER_V1\(sb\)/u);
  assert.match(block, /id="rnaIn"[^>]*data-hl-voice-input="off"[^>]*disabled/u);
  assert.match(block, /id="rnaSend"[^>]*disabled/u);
  assert.match(block, /id="rnaFab"[^>]*style="display:none"/u);

  for (const forbidden of [
    '/api/chat', '/api/health', 'messages:hist', 'marked.parse',
    'demoReply', 'reviewed the company overnight', '3 things need you',
  ]) assert.equal(block.includes(forbidden), false, `legacy Reina path remains: ${forbidden}`);
});

test('page installs with the exact newly created Supabase client, not a mutable window.sb lookup', () => {
  const index = readFileSync(INDEX_URL, 'utf8');
  const hostScript = index.indexOf('<script src="/reina-pilot-host.js"></script>');
  const scriptOpen = index.indexOf('<script>', hostScript);
  const scriptClose = index.indexOf('</script>', scriptOpen);
  assert.ok(hostScript >= 0 && scriptOpen > hostScript && scriptClose > scriptOpen);
  const captureSource = index.slice(scriptOpen + '<script>'.length, scriptClose);
  const clientStart = index.indexOf('var HL_SUPABASE_URL');
  const installCall = "try { if (typeof HL_REINA_PILOT_INSTALLER_V1 === 'function') HL_REINA_PILOT_INSTALLER_V1(sb); } catch(e) {}";
  const clientEnd = index.indexOf(installCall, clientStart);
  assert.ok(clientStart >= 0 && clientEnd > clientStart);
  const clientSource = index.slice(clientStart, clientEnd + installCall.length);

  let trustedCalls = 0;
  const genuine = Object.freeze({ marker: 'genuine-auth-client' });
  const forgedBefore = Object.freeze({ marker: 'forged-before-create' });
  const forgedAfter = Object.freeze({ marker: 'forged-after-install' });
  let installedAuth = null;
  const context = {
    document: Object.freeze({ marker: 'document' }),
    ReinaPilotHost: {
      installReinaPilotPage(options) {
        trustedCalls += 1;
        installedAuth = options.authClient;
        return { installed: true };
      },
    },
    supabase: {
      createClient() { return genuine; },
    },
  };
  context.window = context;
  vm.runInNewContext(captureSource, context);
  context.sb = forgedBefore;
  vm.runInNewContext(clientSource, context);
  context.sb = forgedAfter;

  assert.equal(trustedCalls, 1);
  assert.equal(installedAuth, genuine);
});

test('actual page fetch wrapper never shares authenticated or no-store Reina bootstrap reads', async () => {
  const index = readFileSync(INDEX_URL, 'utf8');
  const marker = index.indexOf('HL_FETCH_DEDUPE_V1');
  const scriptOpen = index.lastIndexOf('<script>', marker);
  const scriptClose = index.indexOf('</script>', marker);
  assert.ok(marker >= 0 && scriptOpen >= 0 && scriptClose > marker);
  const source = index.slice(scriptOpen + '<script>'.length, scriptClose);
  const calls = [];
  const windowRef = {
    fetch: async (_url, init) => {
      const owner = init.headers.Authorization;
      calls.push(owner);
      return {
        ok: true,
        owner,
        clone() { return { ok: true, owner, clone: this.clone }; },
      };
    },
  };
  vm.runInNewContext(source, { window: windowRef, Map, Date, Promise });

  const first = await windowRef.fetch('/api/reina-pilot', {
    method: 'GET', headers: { Authorization: 'Bearer principal-a' },
  });
  const second = await windowRef.fetch('/api/reina-pilot', {
    method: 'GET', headers: { Authorization: 'Bearer principal-b' },
  });
  const third = await windowRef.fetch('/api/reina-pilot', {
    method: 'GET', cache: 'no-store', headers: {},
  });
  const fourth = await windowRef.fetch('/api/reina-pilot', {
    method: 'GET', cache: 'no-store', headers: {},
  });

  assert.deepEqual(calls, ['Bearer principal-a', 'Bearer principal-b', undefined, undefined]);
  assert.equal(first.owner, 'Bearer principal-a');
  assert.equal(second.owner, 'Bearer principal-b');
  assert.notEqual(first.owner, second.owner);
  assert.equal(third.ok, true);
  assert.equal(fourth.ok, true);
});

function pageFetchWrapperSources(index) {
  const dedupeMarker = index.indexOf('HL_FETCH_DEDUPE_V1');
  const dedupeOpen = index.lastIndexOf('<script>', dedupeMarker);
  const dedupeClose = index.indexOf('</script>', dedupeMarker);
  const authStart = index.indexOf('function hlTokenSync()');
  const authEnd = index.indexOf('\n})();', authStart);
  assert.ok(dedupeMarker >= 0 && dedupeOpen >= 0 && dedupeClose > dedupeMarker);
  assert.ok(authStart >= 0 && authEnd > authStart);
  return {
    dedupe: index.slice(dedupeOpen + '<script>'.length, dedupeClose),
    auth: index.slice(authStart, authEnd + '\n})();'.length),
  };
}

test('combined page wrappers pin explicit Bearer requests and never heal a caller-owned 401', async () => {
  const sources = pageFetchWrapperSources(readFileSync(INDEX_URL, 'utf8'));
  let nativeCalls = 0;
  let forgedCalls = 0;
  let waitCalls = 0;
  let refreshCalls = 0;
  const seenAuthorization = [];
  const windowRef = {
    location: { origin: 'https://app.example.test' },
    fetch: async (_url, init) => {
      nativeCalls += 1;
      seenAuthorization.push(init.headers.Authorization);
      return { ok: nativeCalls === 1, status: nativeCalls === 1 ? 200 : 401, marker: nativeCalls === 1 ? 'native-200' : 'native-401' };
    },
    sb: { auth: { refreshSession: async () => { refreshCalls += 1; } } },
  };
  const localStorage = { getItem: () => null };
  const context = {
    window: windowRef,
    sb: windowRef.sb,
    localStorage,
    performance: { now: () => 1 },
    setInterval() { waitCalls += 1; throw new Error('explicit auth must not wait'); },
    clearInterval() {},
    Map,
    Date,
    Promise,
    Object,
    Array,
    String,
  };
  vm.runInNewContext(sources.dedupe, context);
  vm.runInNewContext(sources.auth, context);
  const captured = windowRef.fetch;
  windowRef.fetch = async () => { forgedCalls += 1; return { ok: true, status: 200, marker: 'forged' }; };

  const first = await captured('/api/reina-pilot', {
    method: 'GET', cache: 'no-store', headers: { Authorization: 'Bearer principal-a' },
  });
  const second = await captured('/api/reina-pilot', {
    method: 'GET', cache: 'no-store', headers: { Authorization: 'Bearer principal-a' },
  });

  assert.equal(first.marker, 'native-200');
  assert.equal(second.marker, 'native-401');
  assert.equal(nativeCalls, 2);
  assert.equal(forgedCalls, 0);
  assert.equal(waitCalls, 0);
  assert.equal(refreshCalls, 0);
  assert.deepEqual(seenAuthorization, ['Bearer principal-a', 'Bearer principal-a']);
});

test('token boot-wait retries through the captured local wrapper, never a replaced global fetch', async () => {
  const sources = pageFetchWrapperSources(readFileSync(INDEX_URL, 'utf8'));
  let token = null;
  let nativeCalls = 0;
  let forgedCalls = 0;
  let waitCalls = 0;
  let nativeAuthorization = null;
  const authKey = 'sb-sqhusuuhlmcmkeowdrga-auth-token';
  const localStorage = {
    [authKey]: true,
    getItem(key) { return key === authKey && token ? JSON.stringify({ access_token: token }) : null; },
  };
  const windowRef = {
    location: { origin: 'https://app.example.test' },
    fetch: async (_url, init) => {
      nativeCalls += 1;
      nativeAuthorization = init.headers.Authorization;
      return { ok: true, status: 200, marker: 'native' };
    },
    sb: { auth: { refreshSession: async () => ({}) } },
  };
  const context = {
    window: windowRef,
    sb: windowRef.sb,
    localStorage,
    performance: { now: () => 1 },
    setInterval(callback) { waitCalls += 1; token = 'restored-token'; callback(); return 1; },
    clearInterval() {},
    Map,
    Date,
    Promise,
    Object,
    Array,
    String,
  };
  vm.runInNewContext(sources.dedupe, context);
  vm.runInNewContext(sources.auth, context);
  const captured = windowRef.fetch;
  windowRef.fetch = async () => { forgedCalls += 1; return { ok: true, status: 200, marker: 'forged' }; };

  const result = await captured('/api/reina-pilot', { method: 'GET', cache: 'no-store', headers: {} });
  assert.equal(result.marker, 'native');
  assert.equal(waitCalls, 1);
  assert.equal(nativeCalls, 1);
  assert.equal(forgedCalls, 0);
  assert.equal(nativeAuthorization, 'Bearer restored-token');
});

test('signed-out application API reads fail locally and never wake the server', async () => {
  const sources = pageFetchWrapperSources(readFileSync(INDEX_URL, 'utf8'));
  const nativeUrls = [];
  const windowRef = {
    location: { origin: 'https://app.example.test' },
    fetch: async (url) => {
      nativeUrls.push(url);
      return { ok: true, status: 200, marker: 'native', clone() { return this; } };
    },
    sb: { auth: { refreshSession: async () => ({}) } },
  };
  const context = {
    window: windowRef,
    sb: windowRef.sb,
    localStorage: { getItem: () => null },
    performance: { now: () => 9000 },
    setInterval() { throw new Error('a settled signed-out page must not wait or poll'); },
    clearInterval() {},
    Map,
    Date,
    Promise,
    Object,
    Array,
    String,
    JSON,
  };
  vm.runInNewContext(sources.dedupe, context);
  vm.runInNewContext(sources.auth, context);

  const apiResult = await windowRef.fetch('/api/jobs?limit=1000');
  assert.equal(apiResult.status, 401);
  assert.deepEqual(nativeUrls, [], 'unsigned /api calls must not reach the network');

  const viewResult = await windowRef.fetch('/views/docs.html');
  assert.equal(viewResult.marker, 'native');
  assert.deepEqual(nativeUrls, ['/views/docs.html'], 'non-API assets still load normally');
});

test('login, silent restoration, and sign-out leave panel visibility to the authenticated host', () => {
  const index = readFileSync(INDEX_URL, 'utf8');
  assert.equal(index.includes('Good morning, Chris'), false);
  assert.match(index, /<b id="cc-greet-name">Hello<\/b>/u);
  assert.match(index, /g\.textContent = first \? 'Hello, ' \+ first : 'Hello';/u);
  assert.match(index, /if\(window\.hlReinaPilotStop\) window\.hlReinaPilotStop\(\);/u);

  const login = index.slice(index.indexOf('async function lgSubmit'), index.indexOf('function hlNewWin'));
  const silent = index.slice(index.indexOf('async function hlTrySilentLogin'), index.indexOf('// ---------- Folder state'));
  assert.doesNotMatch(login, /rnaFab[^\n]*(?:display|style)/u);
  assert.doesNotMatch(silent, /rnaFab[^\n]*(?:display|style)/u);
});
