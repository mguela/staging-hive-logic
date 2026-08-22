import test from 'node:test';
import assert from 'node:assert/strict';

import { requireUser } from '../api/_lib/auth.js';

import {
  ACTING_CONTEXT_REASON,
  ADMIN_PILOT_CAPABILITIES,
  resolveActingContext,
} from '../api/_lib/reina/acting-context.js';
import {
  AUTHORIZATION_POLICY_VERSION,
  AUTHORIZATION_REASON,
  REINA_OPERATION,
  decideAuthorization,
  isAuthorizedDecisionFor,
} from '../api/_lib/reina/authorization.js';

const enabledEnv = {
  REINA_ACTING_CONTEXT_ENABLED: 'true',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_KEY: 'test-service-key',
};

function request() { return { headers: { authorization: 'Bearer test' } }; }
function auth(user = { id: 'user-1' }) { return async () => user; }
function profileFetch(rows, ok = true) {
  return async () => ({ ok, json: async () => rows });
}

async function adminContext(options = {}) {
  const result = await resolveActingContext(options.req || request(), {
    env: options.env || enabledEnv,
    requireUserImpl: options.requireUserImpl || auth(),
    fetchImpl: options.fetchImpl || profileFetch([{ id: 'user-1', role: 'admin' }]),
  });
  assert.equal(result.ok, true);
  return result.context;
}

test('feature is disabled unless the flag is exactly true', async () => {
  for (const value of [undefined, '', 'TRUE', '1', 'false']) {
    const result = await resolveActingContext(request(), {
      env: { ...enabledEnv, REINA_ACTING_CONTEXT_ENABLED: value },
      requireUserImpl: () => { throw new Error('must not authenticate while disabled'); },
    });
    assert.deepEqual(result, { ok: false, context: null, reason: ACTING_CONTEXT_REASON.disabled });
  }
});

test('authentication and exact profile resolution fail closed', async () => {
  const cases = [
    { user: null, rows: [], reason: ACTING_CONTEXT_REASON.unauthenticated },
    { user: { id: 'user-1' }, rows: [], reason: ACTING_CONTEXT_REASON.profileUnavailable },
    { user: { id: 'user-1' }, rows: [{ id: 'user-1' }, { id: 'user-1' }], reason: ACTING_CONTEXT_REASON.profileAmbiguous },
    { user: { id: 'user-1' }, rows: [{ id: 'other', role: 'admin' }], reason: ACTING_CONTEXT_REASON.profileMismatch },
  ];
  for (const item of cases) {
    const result = await resolveActingContext(request(), {
      env: enabledEnv,
      requireUserImpl: auth(item.user),
      fetchImpl: profileFetch(item.rows),
    });
    assert.equal(result.ok, false);
    assert.equal(result.context, null);
    assert.equal(result.reason, item.reason);
  }
});

test('authentication and profile dependency errors deny instead of escaping', async () => {
  const authFailure = await resolveActingContext(request(), {
    env: enabledEnv,
    requireUserImpl: async () => { throw new Error('auth unavailable'); },
  });
  assert.equal(authFailure.reason, ACTING_CONTEXT_REASON.authenticationUnavailable);
  assert.equal(authFailure.context, null);

  const profileFailure = await resolveActingContext(request(), {
    env: enabledEnv,
    requireUserImpl: auth(),
    fetchImpl: async () => { throw new Error('profile unavailable'); },
  });
  assert.equal(profileFailure.reason, ACTING_CONTEXT_REASON.profileUnavailable);
  assert.equal(profileFailure.context, null);
});

test('authentication and profile fetches receive the server deadline signal and reject wrapped credentials', async () => {
  const controller = new AbortController();
  const seenSignals = [];
  const user = await requireUser(request(), {
    env: enabledEnv,
    signal: controller.signal,
    fetchImpl: async (_url, init) => {
      seenSignals.push(init.signal);
      return { ok: true, json: async () => ({ id: 'user-1' }) };
    },
  });
  assert.equal(user.id, 'user-1');

  const resolved = await resolveActingContext(request(), {
    env: enabledEnv,
    signal: controller.signal,
    requireUserImpl: async (_req, options) => {
      seenSignals.push(options.signal);
      return { id: 'user-1' };
    },
    fetchImpl: async (_url, init) => {
      seenSignals.push(init.signal);
      return { ok: true, json: async () => [{ id: 'user-1', role: 'admin' }] };
    },
  });
  assert.equal(resolved.ok, true);
  assert.deepEqual(seenSignals, [controller.signal, controller.signal, controller.signal]);

  let calls = 0;
  const wrapped = await requireUser({
    headers: { authorization: new String('Bearer wrapped') },
  }, {
    env: enabledEnv,
    fetchImpl: async () => { calls += 1; return { ok: true, json: async () => ({ id: 'user-1' }) }; },
  });
  assert.equal(wrapped, null);
  assert.equal(calls, 0);
});

test('inactive authenticated principals and non-admin profiles are denied', async () => {
  for (const user of [
    { id: 'user-1', deleted_at: '2030-01-01T00:00:00.000Z' },
    { id: 'user-1', banned_until: '2999-01-01T00:00:00.000Z' },
  ]) {
    const result = await resolveActingContext(request(), {
      env: enabledEnv,
      requireUserImpl: auth(user),
      fetchImpl: () => { throw new Error('must not load a profile for an inactive principal'); },
    });
    assert.equal(result.reason, ACTING_CONTEXT_REASON.principalInactive);
    assert.equal(result.context, null);
  }

  const nonAdmin = await resolveActingContext(request(), {
    env: enabledEnv,
    requireUserImpl: auth(),
    fetchImpl: profileFetch([{ id: 'user-1', role: 'crew' }]),
  });
  assert.equal(nonAdmin.reason, ACTING_CONTEXT_REASON.roleDenied);
  assert.equal(nonAdmin.context, null);
});

test('one server-authenticated admin profile resolves without a nonexistent active column', async () => {
  let requestedUrl = '';
  const result = await resolveActingContext({
    ...request(),
    body: {
      principalId: 'attacker',
      role: 'admin',
      companyId: 'attacker-company',
      capabilities: ['*', 'reina:tool:execute'],
    },
  }, {
    env: enabledEnv,
    requireUserImpl: auth(),
    fetchImpl: async (url) => {
      requestedUrl = url;
      return { ok: true, json: async () => [{ id: 'user-1', role: 'admin' }] };
    },
  });
  assert.equal(result.ok, true);
  assert.match(requestedUrl, /select=id,role&limit=2$/);
  assert.doesNotMatch(requestedUrl, /active/);
  assert.equal(result.context.principalId, 'user-1');
  assert.equal(result.context.role, 'admin');
  assert.equal(result.context.companyId, null);
  assert.deepEqual(result.context.capabilities, ADMIN_PILOT_CAPABILITIES);
});

test('admin context is finite, immutable, and has no invented company authority', async () => {
  const context = await adminContext();
  assert.deepEqual(context.capabilities, [
    'reina:pilot:access',
    'reina:conversation:read',
    'reina:conversation:create',
    'reina:conversation:append',
  ]);
  assert.equal(context.capabilities, ADMIN_PILOT_CAPABILITIES);
  assert.equal(context.companyId, null);
  assert.equal(context.companyAuthorityVerified, false);
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.capabilities), true);
});

test('authorization accepts only server-resolved contexts and freezes every decision', async () => {
  const context = await adminContext();
  const invalidContexts = [
    null,
    { ...context },
    Object.freeze({ ...context }),
    JSON.parse(JSON.stringify(context)),
    structuredClone(context),
    Object.freeze({
      principalId: 'user-1',
      role: 'admin',
      companyId: null,
      companyAuthorityVerified: false,
      capabilities: ADMIN_PILOT_CAPABILITIES,
      source: 'server_verified_auth_and_profile',
    }),
  ];

  for (const invalidContext of invalidContexts) {
    const decision = decideAuthorization(invalidContext, REINA_OPERATION.PILOT_ACCESS);
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, AUTHORIZATION_REASON.invalidContext);
    assert.equal(decision.operation, null);
    assert.equal(Object.isFrozen(decision), true);
  }
});

test('operation identifiers are primitive, exact, and finite', async () => {
  const context = await adminContext();
  const forgedSafeEnvelope = {
    operation: REINA_OPERATION.CONVERSATION_APPEND,
    capability: 'reina:conversation:append',
    readOnly: true,
    companyScoped: false,
    consequential: false,
    tool: false,
  };

  let accessorReads = 0;
  const accessorEnvelope = {};
  Object.defineProperty(accessorEnvelope, 'operation', {
    enumerable: true,
    get() {
      accessorReads += 1;
      return REINA_OPERATION.CONVERSATION_APPEND;
    },
  });
  const throwingProxy = new Proxy({}, {
    get() { throw new Error('must not inspect caller objects'); },
    ownKeys() { throw new Error('must not inspect caller objects'); },
  });

  for (const malformed of [
    null,
    undefined,
    '',
    ' ',
    ` ${REINA_OPERATION.PILOT_ACCESS}`,
    `${REINA_OPERATION.PILOT_ACCESS} `,
    'REINA.PILOT.ACCESS',
    'reina:pilot:access',
    'a'.repeat(101),
    new String(REINA_OPERATION.PILOT_ACCESS),
    forgedSafeEnvelope,
    { ...forgedSafeEnvelope, companyScoped: true },
    { ...forgedSafeEnvelope, consequential: true },
    { ...forgedSafeEnvelope, tool: true },
    { operationId: REINA_OPERATION.CONVERSATION_APPEND, readOnly: true },
    accessorEnvelope,
    throwingProxy,
    [],
    Symbol('reina.pilot.access'),
    1,
  ]) {
    const decision = decideAuthorization(context, malformed);
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, AUTHORIZATION_REASON.malformedRequest);
    assert.equal(Object.isFrozen(decision), true);
  }
  assert.equal(accessorReads, 0, 'caller object accessors are never evaluated');

  for (const unknown of [
    'reina.tool.execute',
    'reina.business.pay',
    'reina.automation.task',
    'reina.company.read',
    'reina.conversation.delete',
  ]) {
    const decision = decideAuthorization(context, unknown);
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, AUTHORIZATION_REASON.unknownOperation);
    assert.equal(decision.operation, unknown);
    assert.equal(decision.toolExecutionAllowed, false);
    assert.equal(decision.businessActionAllowed, false);
    assert.equal(decision.automationTaskAllowed, false);
    assert.equal(Object.isFrozen(decision), true);
  }
});

test('finite server policies bind each known operation to an explicit capability', async () => {
  const context = await adminContext();
  const cases = [
    [REINA_OPERATION.PILOT_ACCESS, 'reina:pilot:access', 'pilot_runtime', 'access'],
    [REINA_OPERATION.CONVERSATION_CREATE, 'reina:conversation:create', 'app_internal_conversation', 'create'],
    [REINA_OPERATION.CONVERSATION_READ, 'reina:conversation:read', 'app_internal_conversation', 'read'],
    [REINA_OPERATION.CONVERSATION_APPEND, 'reina:conversation:append', 'app_internal_conversation', 'append'],
  ];

  for (const [operation, capability, resource, effect] of cases) {
    const decision = decideAuthorization(context, operation);
    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, AUTHORIZATION_REASON.allowed);
    assert.equal(decision.operation, operation);
    assert.equal(decision.capability, capability);
    assert.equal(context.capabilities.includes(capability), true);
    assert.equal(decision.policyVersion, AUTHORIZATION_POLICY_VERSION);
    assert.equal(decision.resource, resource);
    assert.equal(decision.effect, effect);
    assert.equal(decision.ownerScope, 'principal');
    assert.equal(decision.ownerPrincipalId, 'user-1');
    assert.equal(decision.companyId, null);
    assert.equal(decision.companyAuthorityUsed, false);
    assert.equal(decision.toolExecutionAllowed, false);
    assert.equal(decision.businessActionAllowed, false);
    assert.equal(decision.automationTaskAllowed, false);
    assert.equal(Object.hasOwn(decision, 'readOnly'), false);
    assert.equal(Object.hasOwn(decision, 'authorizedToolNames'), false);
    assert.equal(Object.isFrozen(decision), true);
    assert.equal(isAuthorizedDecisionFor(decision, context, operation), true);
  }
});

test('conversation persistence authority is internal, operation-bound, and never tool or business authority', async () => {
  const context = await adminContext();
  const appendDecision = decideAuthorization(context, REINA_OPERATION.CONVERSATION_APPEND);
  assert.equal(appendDecision.resource, 'app_internal_conversation');
  assert.equal(appendDecision.effect, 'append');
  assert.equal(appendDecision.companyId, null);
  assert.equal(appendDecision.companyAuthorityUsed, false);
  assert.equal(appendDecision.toolExecutionAllowed, false);
  assert.equal(appendDecision.businessActionAllowed, false);
  assert.equal(appendDecision.automationTaskAllowed, false);

  for (const otherOperation of [
    REINA_OPERATION.PILOT_ACCESS,
    REINA_OPERATION.CONVERSATION_CREATE,
    REINA_OPERATION.CONVERSATION_READ,
    'reina.tool.execute',
    'reina.business.pay',
    'reina.automation.task',
  ]) {
    assert.equal(isAuthorizedDecisionFor(appendDecision, context, otherOperation), false);
  }

  const otherContext = await adminContext({
    requireUserImpl: auth({ id: 'user-2' }),
    fetchImpl: profileFetch([{ id: 'user-2', role: 'admin' }]),
  });
  assert.equal(isAuthorizedDecisionFor(appendDecision, otherContext, REINA_OPERATION.CONVERSATION_APPEND), false);
  assert.equal(isAuthorizedDecisionFor({ ...appendDecision }, context, REINA_OPERATION.CONVERSATION_APPEND), false);
  assert.equal(isAuthorizedDecisionFor(Object.freeze({ ...appendDecision }), context, REINA_OPERATION.CONVERSATION_APPEND), false);
  assert.equal(isAuthorizedDecisionFor(JSON.parse(JSON.stringify(appendDecision)), context, REINA_OPERATION.CONVERSATION_APPEND), false);
  assert.equal(isAuthorizedDecisionFor(structuredClone(appendDecision), context, REINA_OPERATION.CONVERSATION_APPEND), false);
});

test('company scope remains unavailable and forged safe labels cannot change policy', async () => {
  const context = await adminContext();
  assert.equal(context.companyId, null);
  assert.equal(context.companyAuthorityVerified, false);

  for (const forged of [
    { operation: REINA_OPERATION.CONVERSATION_READ, companyScoped: false },
    { operation: REINA_OPERATION.CONVERSATION_READ, companyScoped: true },
    { operation: REINA_OPERATION.CONVERSATION_READ, companyId: 'invented-company' },
    { operation: 'reina.company.read', readOnly: true, consequential: false, tool: false },
  ]) {
    const decision = decideAuthorization(context, forged);
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, AUTHORIZATION_REASON.malformedRequest);
  }

  const companyOperation = decideAuthorization(context, 'reina.company.read');
  assert.equal(companyOperation.allowed, false);
  assert.equal(companyOperation.reason, AUTHORIZATION_REASON.unknownOperation);
  assert.equal(companyOperation.companyAuthorityUsed, false);
});
