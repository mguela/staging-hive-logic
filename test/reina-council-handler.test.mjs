import assert from 'node:assert/strict';
import test from 'node:test';

import { createCouncilHandler } from '../api/reina-council.js';

const env = {
  REINA_COUNCIL_ENABLED: 'true',
  OPENAI_API_KEY: 'test', REINA_COUNCIL_OPENAI_MODEL: 'test',
  ANTHROPIC_API_KEY: 'test', REINA_COUNCIL_ANTHROPIC_MODEL: 'test',
  XAI_API_KEY: 'test', REINA_COUNCIL_XAI_MODEL: 'test',
  REINA_COUNCIL_OPENAI_INPUT_CENTS_PER_MILLION: '1', REINA_COUNCIL_OPENAI_OUTPUT_CENTS_PER_MILLION: '1',
  REINA_COUNCIL_ANTHROPIC_INPUT_CENTS_PER_MILLION: '1', REINA_COUNCIL_ANTHROPIC_OUTPUT_CENTS_PER_MILLION: '1',
  REINA_COUNCIL_XAI_INPUT_CENTS_PER_MILLION: '1', REINA_COUNCIL_XAI_OUTPUT_CENTS_PER_MILLION: '1',
};

const evidence = [{
  sourceId: 'brief', label: 'Brief',
  content: 'Run the repository test suite before release.',
}];

const providerMessage = JSON.stringify({
  summary: 'Run tests.',
  claims: [{
    topic: 'tests', stance: 'support', statement: 'Run the repository tests.',
    citations: [{ sourceId: 'brief', locator: 'sentence 1', excerpt: 'Run the repository test suite before release.' }],
  }],
  risks: [], questions: [],
});

function providers() {
  return Object.fromEntries(['claude', 'chatgpt', 'grok'].map((name) => [name, {
    estimateMaxCostCents: () => 1,
    generate: async () => ({ text: providerMessage, usage: { inputTokens: 10, outputTokens: 10, costCents: 0.5 } }),
  }]));
}

function response() {
  return {
    statusCode: 0, payload: null, headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

function startBody(overrides = {}) {
  return {
    action: 'start', idempotencyKey: 'request-123', brief: 'Should tests run?', evidence,
    budget: { maxRounds: 1, maxTokensPerResponse: 200, maxCostCents: 10 }, ...overrides,
  };
}

function handler(store, envOverride = env) {
  return createCouncilHandler({
    env: envOverride, requireStaff: async () => ({ id: '00000000-0000-4000-8000-000000000001' }),
    providers, store,
  });
}

test('readiness reports provider configuration and operational ceilings without secrets', async () => {
  const res = response();
  await handler({})({ method: 'GET', query: { status: '1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.ready, true);
  assert.equal(res.payload.providers.length, 3);
  assert.equal(JSON.stringify(res.payload).includes('test'), false);
  assert.equal(res.payload.limits.maxConcurrentRuns, 1);
});

test('history returns only the authenticated owner Boardroom index', async () => {
  let ownerId;
  let limit;
  let offset;
  const res = response();
  await handler({ getRecentRuns: async (owner, boundedLimit, boundedOffset) => {
    ownerId = owner;
    limit = boundedLimit;
    offset = boundedOffset;
    return [{ id: 'run-1', brief: 'Should we hire?', state: 'completed' }];
  } })({ method: 'GET', query: { history: '1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(ownerId, '00000000-0000-4000-8000-000000000001');
  assert.equal(limit, 25);
  assert.equal(offset, 0);
  assert.equal(res.payload.history[0].id, 'run-1');
  assert.equal(res.payload.hasMore, false);
  assert.equal(res.payload.nextOffset, 1);
});

test('history pagination is bounded and owner-scoped', async () => {
  let paging;
  const res = response();
  await handler({ getRecentRuns: async (_owner, limit, offset) => { paging = { limit, offset }; return Array.from({ length: limit }, (_, i) => ({ id: `run-${offset + i}` })); } })({ method: 'GET', query: { history: '1', limit: '50', offset: '75' } }, res);
  assert.deepEqual(paging, { limit: 50, offset: 75 });
  assert.equal(res.payload.hasMore, true);
  assert.equal(res.payload.nextOffset, 125);
});

test('workspace returns only this owner projects and Boardroom conversations', async () => {
  const calls = [];
  const res = response();
  await handler({
    getProjects: async (owner) => { calls.push(['projects', owner]); return [{ id: '00000000-0000-4000-8000-000000000010', name: 'HiveLogic' }]; },
    getRecentRuns: async (owner, limit, offset) => { calls.push(['runs', owner, limit, offset]); return [{ id: 'run-1', pinned: true }]; },
  })({ method: 'GET', query: { workspace: '1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.projects[0].name, 'HiveLogic');
  assert.equal(res.payload.recent[0].pinned, true);
  assert.deepEqual(calls, [
    ['projects', '00000000-0000-4000-8000-000000000001'],
    ['runs', '00000000-0000-4000-8000-000000000001', 50, 0],
  ]);
});

test('project creation and run pinning remain owner-scoped', async () => {
  const projectId = '00000000-0000-4000-8000-000000000010';
  const runId = '00000000-0000-4000-8000-000000000020';
  const calls = [];
  const store = {
    createProject: async (input) => { calls.push(['create', input]); return { id: projectId, name: input.name }; },
    getProjects: async (ownerId) => { calls.push(['projects', ownerId]); return [{ id: projectId, name: 'HiveLogic' }]; },
    updateRunMetadata: async (input) => { calls.push(['update', input]); return { id: runId, pinned: true, project_id: projectId }; },
  };
  const created = response();
  await handler(store)({ method: 'POST', body: { action: 'create_project', name: 'HiveLogic' } }, created);
  assert.equal(created.statusCode, 201);
  const updated = response();
  await handler(store)({ method: 'POST', body: { action: 'update_run_metadata', runId, pinned: true, projectId } }, updated);
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.payload.run.pinned, true);
  assert.equal(calls[0][1].ownerId, '00000000-0000-4000-8000-000000000001');
  assert.equal(calls.at(-1)[1].ownerId, '00000000-0000-4000-8000-000000000001');
});

test('start requires a bounded idempotency key before admission', async () => {
  let called = false;
  const res = response();
  await handler({ admit: async () => { called = true; } })({ method: 'POST', body: startBody({ idempotencyKey: 'bad' }) }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(called, false);
});

test('durable replay returns the existing run without calling providers again', async () => {
  let providerCalled = false;
  const council = createCouncilHandler({
    env, requireStaff: async () => ({ id: '00000000-0000-4000-8000-000000000001' }),
    providers: () => { providerCalled = true; return providers(); },
    store: {
      admit: async () => ({ status: 'replay', runId: 'run-1' }),
      getRun: async () => ({ id: 'run-1', state: 'completed', report: {}, usage: {}, execution_request: null }),
    },
  });
  const res = response();
  await council({ method: 'POST', body: startBody() }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.replayed, true);
  assert.equal(providerCalled, false);
});

test('owner concurrency and daily spend decisions reject before providers are called', async () => {
  for (const reason of ['concurrent', 'daily_cost']) {
    let providerCalled = false;
    const council = createCouncilHandler({
      env, requireStaff: async () => ({ id: '00000000-0000-4000-8000-000000000001' }),
      providers: () => { providerCalled = true; return providers(); },
      store: { admit: async () => ({ status: 'quota_exceeded', reason }) },
    });
    const res = response();
    await council({ method: 'POST', body: startBody() }, res);
    assert.equal(res.statusCode, 429);
    assert.equal(providerCalled, false);
  }
});

test('an admitted Council persists under the same admission and returns aggregate usage', async () => {
  let createInput;
  const store = {
    admit: async () => ({ status: 'admitted', admissionId: 'admission-1' }),
    releaseAdmission: async () => ({ released: true }),
    createRun: async (input) => { createInput = input; return { id: 'run-1' }; },
  };
  const res = response();
  await handler(store)({ method: 'POST', body: startBody() }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.payload.runId, 'run-1');
  assert.equal(createInput.admissionId, 'admission-1');
  assert.equal(res.payload.usage.inputTokens, 30);
  assert.equal(res.payload.usage.outputTokens, 30);
});

test('an explicit request creates one owner-scoped master project and attaches the completed run', async () => {
  const projectId = '00000000-0000-4000-8000-000000000010';
  let ensured;
  let createInput;
  const store = {
    admit: async () => ({ status: 'admitted', admissionId: 'admission-1' }),
    releaseAdmission: async () => ({ released: true }),
    getOrCreateProject: async (input) => {
      ensured = input;
      return { project: { id: projectId, name: input.name }, created: true };
    },
    getImportedHistory: async () => ({
      sources: ['chatgpt', 'claude', 'grok'].map((source) => ({ source, status: 'connected' })),
      availableSources: ['chatgpt', 'claude', 'grok'],
      messages: ['chatgpt', 'claude', 'grok'].map((source) => ({ source, body: `HiveLogic ${source} history` })),
    }),
    createRun: async (input) => { createInput = input; return { id: 'run-1', project_id: input.projectId }; },
  };
  const res = response();
  await handler(store)({ method: 'POST', body: startBody({
    brief: 'Collect all history from Grok, ChatGPT and Claude regarding HiveLogic App and make 1 master project here.',
  }) }, res);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(ensured, {
    ownerId: '00000000-0000-4000-8000-000000000001',
    name: 'HiveLogic Master Project',
  });
  assert.equal(createInput.projectId, projectId);
  assert.equal(res.payload.project.id, projectId);
  assert.equal(res.payload.projectCreated, true);
});

test('discussion-only project language never creates a project', async () => {
  let projectCalled = false;
  let createInput;
  const store = {
    admit: async () => ({ status: 'admitted', admissionId: 'admission-1' }),
    releaseAdmission: async () => ({ released: true }),
    getOrCreateProject: async () => { projectCalled = true; },
    createRun: async (input) => { createInput = input; return { id: 'run-1' }; },
  };
  const res = response();
  await handler(store)({ method: 'POST', body: startBody({ brief: 'Should the HiveLogic project use this plan?' }) }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(projectCalled, false);
  assert.equal(createInput.projectId, null);
});

test('a selected existing project always wins over natural-language project creation', async () => {
  const projectId = '00000000-0000-4000-8000-000000000010';
  let projectCalled = false;
  let createInput;
  const store = {
    getProjects: async () => [{ id: projectId, name: 'Existing' }],
    admit: async () => ({ status: 'admitted', admissionId: 'admission-1' }),
    releaseAdmission: async () => ({ released: true }),
    getOrCreateProject: async () => { projectCalled = true; },
    createRun: async (input) => { createInput = input; return { id: 'run-1' }; },
  };
  const res = response();
  await handler(store)({ method: 'POST', body: startBody({ brief: 'Make a master project here.', projectId }) }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(projectCalled, false);
  assert.equal(createInput.projectId, projectId);
});

test('Boardroom receives live company intelligence and owner-scoped decision history', async () => {
  const prompts = [];
  let createInput;
  const capturingProviders = () => Object.fromEntries(['claude', 'chatgpt', 'grok'].map((name) => [name, {
    estimateMaxCostCents: () => 1,
    generate: async (input) => { prompts.push(input.prompt); return { text: providerMessage, usage: { inputTokens: 10, outputTokens: 10, costCents: 0.5 } }; },
  }]));
  const council = createCouncilHandler({
    env, requireStaff: async () => ({ id: '00000000-0000-4000-8000-000000000001' }),
    getCompanySnapshot: async () => ({ counts: { jobs: 42 }, ar: { outstanding: 12000 } }),
    providers: capturingProviders,
    store: {
      admit: async () => ({ status: 'admitted', admissionId: 'admission-1' }),
      releaseAdmission: async () => ({ released: true }),
      getRecentRuns: async () => [{ id: 'prior-1', brief: 'Should we hire?', report: { consensus: [] }, created_at: '2026-08-01T00:00:00Z' }],
      createRun: async (input) => { createInput = input; return { id: 'run-1' }; },
    },
  });
  const res = response();
  await council({ method: 'POST', body: startBody() }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(prompts.length, 3);
  assert.match(prompts[0], /company-intelligence/);
  assert.match(prompts[0], /boardroom-history/);
  assert.equal(createInput.evidence.some((item) => item.sourceId === 'company-intelligence'), true);
  assert.equal(createInput.evidence.some((item) => item.sourceId === 'boardroom-history'), true);
  assert.ok(createInput.evidence.find((item) => item.sourceId === 'company-intelligence').content.length <= 4_000);
  assert.ok(createInput.evidence.find((item) => item.sourceId === 'boardroom-history').content.length <= 2_500);
});

test('external-history requests fail closed before provider spend when named sources were never imported', async () => {
  let released = false;
  let providerCalled = false;
  const council = createCouncilHandler({
    env, requireStaff: async () => ({ id: '00000000-0000-4000-8000-000000000001' }),
    providers: () => { providerCalled = true; return providers(); },
    store: {
      admit: async () => ({ status: 'admitted', admissionId: 'admission-1' }),
      releaseAdmission: async () => { released = true; },
      getImportedHistory: async () => ({
        sources: [{ source: 'claude', status: 'connected' }],
        messages: [{ source: 'claude', body: 'HiveLogic work', created_at: '2026-08-16T00:00:00Z' }],
      }),
    },
  });
  const res = response();
  await council({ method: 'POST', body: startBody({
    brief: 'Collect all history from Grok, ChatGPT and Claude regarding HiveLogic.',
  }) }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.code, 'HISTORY_SOURCES_NOT_IMPORTED');
  assert.deepEqual(res.payload.requestedSources, ['chatgpt', 'claude', 'grok']);
  assert.deepEqual(res.payload.missingSources, ['chatgpt', 'grok']);
  assert.equal(res.payload.error.includes('No substitute company-data answer was generated'), true);
  assert.equal(released, true);
  assert.equal(providerCalled, false);
});

test('a direct Boardroom status check cannot be hijacked by company or imported history', async () => {
  const prompts = [];
  let createInput;
  const council = createCouncilHandler({
    env, requireStaff: async () => ({ id: '00000000-0000-4000-8000-000000000001' }),
    getCompanySnapshot: async () => ({ ar: { outstanding: 134003.89 }, counts: { overdueInvoices: 35 } }),
    providers: () => Object.fromEntries(['claude', 'chatgpt', 'grok'].map((name) => [name, {
      estimateMaxCostCents: () => 1,
      generate: async (input) => { prompts.push(input.prompt); return { text: providerMessage, usage: { inputTokens: 10, outputTokens: 10, costCents: 0.5 } }; },
    }])),
    store: {
      admit: async () => ({ status: 'admitted', admissionId: 'admission-1' }),
      releaseAdmission: async () => {},
      getRecentRuns: async () => [{ id: 'prior-1', brief: 'Collect overdue invoices.' }],
      getImportedHistory: async () => ({
        sources: [{ source: 'chatgpt', status: 'connected' }],
        messages: [{ source: 'chatgpt', body: 'Prior unrelated AR recovery advice.' }],
      }),
      createRun: async (input) => { createInput = input; return { id: 'run-1' }; },
    },
  });
  const res = response();
  await council({ method: 'POST', body: startBody({ brief: 'Are you working?', evidence: [] }) }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(prompts.length, 3);
  assert.equal(createInput.evidence.length, 0);
  for (const prompt of prompts) {
    assert.match(prompt, /direct Boardroom status check/);
    assert.match(prompt, /exact question is the controlling scope/);
    assert.doesNotMatch(prompt, /134003|overdue invoices|Prior unrelated AR/);
  }
});

test('Boardroom reads desktop imports from the configured canonical history owner', async () => {
  const configuredOwner = '00000000-0000-4000-8000-000000000099';
  let historyOwner;
  const council = createCouncilHandler({
    env: { ...env, HIVELOGIC_WORKROOM_OWNER_ID: configuredOwner },
    requireStaff: async () => ({ id: '00000000-0000-4000-8000-000000000001', role: 'superadmin' }),
    providers: () => providers(),
    store: {
      admit: async () => ({ status: 'admitted', admissionId: 'admission-1' }),
      releaseAdmission: async () => {},
      getImportedHistory: async (ownerId) => {
        historyOwner = ownerId;
        return {
          sources: ['chatgpt', 'claude', 'grok'].map((source) => ({ source, status: 'connected' })),
          availableSources: ['chatgpt', 'claude', 'grok'],
          messages: ['chatgpt', 'claude', 'grok'].map((source) => ({ source, body: `HiveLogic ${source} evidence`, created_at: '2026-08-16T00:00:00Z' })),
        };
      },
      createRun: async () => ({ id: 'run-1' }),
    },
  });
  const res = response();
  await council({ method: 'POST', body: startBody({ brief: 'Review ChatGPT, Claude, and Grok history.' }) }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(historyOwner, configuredOwner);
});

test('verified imported history is supplied as Boardroom evidence when every requested source is present', async () => {
  const prompts = [];
  let createInput;
  const council = createCouncilHandler({
    env, requireStaff: async () => ({ id: '00000000-0000-4000-8000-000000000001' }),
    providers: () => Object.fromEntries(['claude', 'chatgpt', 'grok'].map((name) => [name, {
      estimateMaxCostCents: () => 1,
      generate: async (input) => { prompts.push(input.prompt); return { text: providerMessage, usage: { inputTokens: 10, outputTokens: 10, costCents: 0.5 } }; },
    }])),
    store: {
      admit: async () => ({ status: 'admitted', admissionId: 'admission-1' }),
      releaseAdmission: async () => {},
      getImportedHistory: async () => ({
        sources: ['chatgpt', 'claude', 'grok'].map((source) => ({ source, status: 'connected', last_synced_at: '2026-08-16T00:00:00Z' })),
        messages: ['chatgpt', 'claude', 'grok'].map((source) => ({ source, author_name: source, source_conversation_id: `${source}-1`, body: `Verified HiveLogic ${source} history`, created_at: '2026-08-16T00:00:00Z' })),
      }),
      createRun: async (input) => { createInput = input; return { id: 'run-1' }; },
    },
  });
  const res = response();
  await council({ method: 'POST', body: startBody({
    brief: 'Collect history from Grok, ChatGPT and Claude regarding HiveLogic.',
  }) }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(prompts.length, 3);
  assert.match(prompts[0], /imported-ai-history/);
  const imported = createInput.evidence.find((item) => item.sourceId === 'imported-ai-history');
  assert.ok(imported);
  assert.equal(createInput.evidence.some((item) => item.sourceId === 'company-intelligence'), false);
  assert.equal(createInput.evidence.some((item) => item.sourceId === 'boardroom-history'), false);
  assert.match(imported.content, /Verified HiveLogic chatgpt history/);
  assert.match(imported.content, /Verified HiveLogic claude history/);
  assert.match(imported.content, /Verified HiveLogic grok history/);
  assert.doesNotThrow(() => JSON.parse(imported.content));
});

test('history evidence stays valid JSON and represents every requested source under the size cap', async () => {
  let createInput;
  const manyCodex = Array.from({ length: 30 }, (_, index) => ({
    id: `codex-${index}`, source: 'codex', body: `HiveLogic technical evidence ${index} ${'x'.repeat(900)}`, created_at: `2026-08-16T00:${String(index).padStart(2, '0')}:00Z`,
  }));
  const council = createCouncilHandler({
    env, requireStaff: async () => ({ id: '00000000-0000-4000-8000-000000000001' }),
    providers: () => providers(),
    store: {
      admit: async () => ({ status: 'admitted', admissionId: 'admission-1' }),
      releaseAdmission: async () => {},
      getImportedHistory: async () => ({
        sources: ['codex', 'claude_code'].map((source) => ({ source, status: 'connected' })),
        availableSources: ['codex', 'claude_code'],
        messages: [...manyCodex, { id: 'claude-code-only', source: 'claude_code', body: 'HiveLogic Claude Code evidence', created_at: '2026-08-16T01:00:00Z' }],
      }),
      createRun: async (input) => { createInput = input; return { id: 'run-1' }; },
    },
  });
  const res = response();
  await council({ method: 'POST', body: startBody({ brief: 'Review Codex and Claude Code history for HiveLogic technical work.' }) }, res);
  assert.equal(res.statusCode, 201);
  const imported = createInput.evidence.find((item) => item.sourceId === 'imported-ai-history');
  const parsed = JSON.parse(imported.content);
  assert.ok(imported.content.length <= 12_000);
  assert.ok(parsed.some((item) => item.source === 'codex'));
  assert.ok(parsed.some((item) => item.source === 'claude_code'));
});

test('Claude Code history does not falsely require separate Claude Chat history', async () => {
  let providerCalled = false;
  const council = createCouncilHandler({
    env, requireStaff: async () => ({ id: '00000000-0000-4000-8000-000000000001' }),
    providers: () => {
      providerCalled = true;
      return providers();
    },
    store: {
      admit: async () => ({ status: 'admitted', admissionId: 'admission-1' }),
      releaseAdmission: async () => {},
      getImportedHistory: async () => ({
        sources: ['codex', 'claude_code'].map((source) => ({ source, status: 'connected' })),
        availableSources: ['codex', 'claude_code'],
        messages: ['codex', 'claude_code'].map((source) => ({ source, body: `HiveLogic ${source} evidence`, created_at: '2026-08-16T00:00:00Z' })),
      }),
      createRun: async () => ({ id: 'run-1' }),
    },
  });
  const res = response();
  await council({ method: 'POST', body: startBody({ brief: 'Review imported Codex and Claude Code history.' }) }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(providerCalled, true);
});

test('Claude Code history does not falsely require separate Claude Chat history', async () => {
  let providerCalled = false;
  const council = createCouncilHandler({
    env, requireStaff: async () => ({ id: '00000000-0000-4000-8000-000000000001' }),
    providers: () => {
      providerCalled = true;
      return providers();
    },
    store: {
      admit: async () => ({ status: 'admitted', admissionId: 'admission-1' }),
      releaseAdmission: async () => {},
      getImportedHistory: async () => ({
        sources: ['codex', 'claude_code'].map((source) => ({ source, status: 'connected' })),
        availableSources: ['codex', 'claude_code'],
        messages: ['codex', 'claude_code'].map((source) => ({ source, body: `HiveLogic ${source} evidence`, created_at: '2026-08-16T00:00:00Z' })),
      }),
      createRun: async () => ({ id: 'run-1' }),
    },
  });
  const res = response();
  await council({ method: 'POST', body: startBody({ brief: 'Review imported Codex and Claude Code history.' }) }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(providerCalled, true);
});

test('the request-scoped Vercel OIDC token reaches providers without entering stored input', async () => {
  let providerEnv;
  let createInput;
  const council = createCouncilHandler({
    env,
    requireStaff: async () => ({ id: '00000000-0000-4000-8000-000000000001' }),
    providers: (runtimeEnv) => { providerEnv = runtimeEnv; return providers(); },
    store: {
      admit: async () => ({ status: 'admitted', admissionId: 'admission-1' }),
      releaseAdmission: async () => ({ released: true }),
      createRun: async (input) => { createInput = input; return { id: 'run-1' }; },
    },
  });
  const res = response();
  await council({
    method: 'POST', headers: { 'x-vercel-oidc-token': ' short-lived-token\n' }, body: startBody(),
  }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(providerEnv.VERCEL_OIDC_TOKEN, 'short-lived-token');
  assert.equal(JSON.stringify(createInput).includes('short-lived-token'), false);
});

test('attachment bytes are never copied into the durable Council input record', async () => {
  let createInput;
  const store = {
    admit: async () => ({ status: 'admitted', admissionId: 'admission-1' }),
    releaseAdmission: async () => ({ released: true }),
    createRun: async (input) => { createInput = input; return { id: 'run-1' }; },
  };
  const noCitationMessage = JSON.stringify({
    summary: 'A photo was reviewed.',
    claims: [{ topic: 'photo', stance: 'support', statement: 'The attachment was considered.', citations: [] }],
    risks: [], questions: [],
  });
  const attachmentProviders = () => Object.fromEntries(['claude', 'chatgpt', 'grok'].map((name) => [name, {
    estimateMaxCostCents: () => 1,
    generate: async () => ({ text: noCitationMessage, usage: { inputTokens: 10, outputTokens: 10, costCents: 0.5 } }),
  }]));
  const council = createCouncilHandler({
    env, requireStaff: async () => ({ id: '00000000-0000-4000-8000-000000000001' }), providers: attachmentProviders, store,
  });
  const res = response();
  await council({ method: 'POST', body: startBody({ evidence: [], attachments: [{ id: 'photo', name: 'dog.jpg', kind: 'image', mimeType: 'image/jpeg', dataBase64: '/9j/AA==' }] }) }, res);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(createInput.evidence, { sources: [], attachments: [{ id: 'photo', name: 'dog.jpg', kind: 'image', mimeType: 'image/jpeg' }] });
  assert.equal(JSON.stringify(createInput).includes('/9j/AA=='), false);
});

test('an unrecognized "master project" phrasing reports ambiguous instead of silently doing nothing', async () => {
  let projectCalled = false;
  const store = {
    admit: async () => ({ status: 'admitted', admissionId: 'admission-1' }),
    releaseAdmission: async () => ({ released: true }),
    getOrCreateProject: async () => { projectCalled = true; },
    createRun: async (input) => ({ id: 'run-1', project_id: input.projectId }),
  };
  const res = response();
  await handler(store)({ method: 'POST', body: startBody({ brief: 'Add this to a master project.' }) }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(projectCalled, false, 'an ambiguous mention must not silently auto-create a project');
  assert.equal(res.payload.project, null);
  assert.equal(res.payload.projectCreated, false);
  assert.equal(res.payload.projectRequestAmbiguous, true,
    'the response must say the brief mentioned a project that was not created, not silently return as if nothing was asked');
});

test('a clear explicit project request is never also flagged ambiguous', async () => {
  const projectId = '00000000-0000-4000-8000-000000000010';
  const store = {
    admit: async () => ({ status: 'admitted', admissionId: 'admission-1' }),
    releaseAdmission: async () => ({ released: true }),
    getOrCreateProject: async (input) => ({ project: { id: projectId, name: input.name }, created: true }),
    createRun: async (input) => ({ id: 'run-1', project_id: input.projectId }),
  };
  const res = response();
  await handler(store)({ method: 'POST', body: startBody({ brief: 'I want a master project for this.' }) }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.payload.projectCreated, true);
  assert.equal(res.payload.projectRequestAmbiguous, false);
});

test('a run with no project language at all is never flagged ambiguous', async () => {
  const store = {
    admit: async () => ({ status: 'admitted', admissionId: 'admission-1' }),
    releaseAdmission: async () => ({ released: true }),
    createRun: async (input) => ({ id: 'run-1', project_id: input.projectId }),
  };
  const res = response();
  await handler(store)({ method: 'POST', body: startBody({ brief: 'Should tests run before we deploy?' }) }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.payload.projectRequestAmbiguous, false);
});

test('a debate round that carries forward a stale provider position is surfaced in the response', async () => {
  const flakyProviders = () => Object.fromEntries(['claude', 'chatgpt', 'grok'].map((name) => [name, {
    estimateMaxCostCents: () => 1,
    generate: async (input) => {
      if (name === 'grok' && input.round === 1) throw new Error('provider unavailable');
      return { text: providerMessage, usage: { inputTokens: 10, outputTokens: 10, costCents: 0.5 } };
    },
  }]));
  const store = {
    admit: async () => ({ status: 'admitted', admissionId: 'admission-1' }),
    releaseAdmission: async () => ({ released: true }),
    createRun: async (input) => ({ id: 'run-1', project_id: input.projectId }),
  };
  const council = createCouncilHandler({
    env, requireStaff: async () => ({ id: '00000000-0000-4000-8000-000000000001' }), providers: flakyProviders, store,
  });
  const res = response();
  await council({ method: 'POST', body: startBody({ budget: { maxRounds: 2, maxTokensPerResponse: 200, maxCostCents: 10 } }) }, res);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.payload.staleDebatePositions, [{ round: 1, participants: ['grok'] }],
    'the independent round is always fresh, but a later debate round can silently carry a position forward without failing -- the client must be told which round and which director');
});

test('a run where every debate round gets a fresh response from all 3 directors has no stale positions', async () => {
  const store = {
    admit: async () => ({ status: 'admitted', admissionId: 'admission-1' }),
    releaseAdmission: async () => ({ released: true }),
    createRun: async (input) => ({ id: 'run-1', project_id: input.projectId }),
  };
  const res = response();
  await handler(store)({ method: 'POST', body: startBody({ budget: { maxRounds: 2, maxTokensPerResponse: 200, maxCostCents: 10 } }) }, res);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.payload.staleDebatePositions, []);
});
