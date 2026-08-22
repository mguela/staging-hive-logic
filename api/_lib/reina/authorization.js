import {
  ADMIN_PILOT_CAPABILITIES,
  isServerResolvedActingContext,
} from './acting-context.js';

const authorizedDecisionBindings = new WeakMap();

export const AUTHORIZATION_POLICY_VERSION = 'reina-acting-context-policy-v1';

export const REINA_OPERATION = Object.freeze({
  PILOT_ACCESS: 'reina.pilot.access',
  CONVERSATION_CREATE: 'reina.conversation.create',
  CONVERSATION_READ: 'reina.conversation.read',
  CONVERSATION_APPEND: 'reina.conversation.append',
});

export const AUTHORIZATION_REASON = Object.freeze({
  invalidContext: 'INVALID_ACTING_CONTEXT',
  malformedRequest: 'MALFORMED_AUTHORIZATION_REQUEST',
  unknownOperation: 'UNKNOWN_OPERATION',
  capabilityDenied: 'CAPABILITY_NOT_GRANTED',
  allowed: 'AUTHORIZED',
});

const OPERATION_ID_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/;

function operationPolicy(operation, capability, resource, effect) {
  return Object.freeze({
    operation,
    capability,
    resource,
    effect,
    ownerScope: 'principal',
  });
}

// This private, deeply frozen registry is the only risk classifier. Callers
// supply one exact operation identifier; they cannot describe an operation as
// read-only, non-consequential, non-tool, or non-company-scoped to gain access.
// No company, tool, business-action, or Automation operation is registered.
const OPERATION_POLICIES = Object.freeze(Object.assign(Object.create(null), {
  [REINA_OPERATION.PILOT_ACCESS]: operationPolicy(
    REINA_OPERATION.PILOT_ACCESS,
    'reina:pilot:access',
    'pilot_runtime',
    'access',
  ),
  [REINA_OPERATION.CONVERSATION_CREATE]: operationPolicy(
    REINA_OPERATION.CONVERSATION_CREATE,
    'reina:conversation:create',
    'app_internal_conversation',
    'create',
  ),
  [REINA_OPERATION.CONVERSATION_READ]: operationPolicy(
    REINA_OPERATION.CONVERSATION_READ,
    'reina:conversation:read',
    'app_internal_conversation',
    'read',
  ),
  [REINA_OPERATION.CONVERSATION_APPEND]: operationPolicy(
    REINA_OPERATION.CONVERSATION_APPEND,
    'reina:conversation:append',
    'app_internal_conversation',
    'append',
  ),
}));

function validContext(context) {
  return isServerResolvedActingContext(context)
    && Object.isFrozen(context)
    && typeof context.principalId === 'string'
    && context.principalId.length > 0
    && context.role === 'admin'
    && context.companyId === null
    && context.companyAuthorityVerified === false
    && context.capabilities === ADMIN_PILOT_CAPABILITIES
    && Object.isFrozen(context.capabilities)
    && context.source === 'server_verified_auth_and_profile';
}

function validOperationIdentifier(operation) {
  return typeof operation === 'string'
    && operation.length > 0
    && operation.length <= 100
    && operation.trim() === operation
    && OPERATION_ID_PATTERN.test(operation);
}

function issueDecision({ context = null, operation = null, policy = null, allowed = false, reason }) {
  const decision = Object.freeze({
    allowed,
    reason,
    operation,
    capability: policy?.capability || null,
    policyVersion: AUTHORIZATION_POLICY_VERSION,
    resource: policy?.resource || null,
    effect: policy?.effect || null,
    ownerScope: policy?.ownerScope || null,
    ownerPrincipalId: allowed ? context.principalId : null,
    companyId: null,
    companyAuthorityUsed: false,
    toolExecutionAllowed: false,
    businessActionAllowed: false,
    automationTaskAllowed: false,
  });

  if (allowed) authorizedDecisionBindings.set(decision, { context, operation });
  return decision;
}

export function decideAuthorization(context, operation) {
  if (!validContext(context)) {
    return issueDecision({ reason: AUTHORIZATION_REASON.invalidContext });
  }
  if (!validOperationIdentifier(operation)) {
    return issueDecision({ reason: AUTHORIZATION_REASON.malformedRequest });
  }

  const policy = Object.hasOwn(OPERATION_POLICIES, operation)
    ? OPERATION_POLICIES[operation]
    : null;
  if (!policy) {
    return issueDecision({ operation, reason: AUTHORIZATION_REASON.unknownOperation });
  }
  if (!context.capabilities.includes(policy.capability)) {
    return issueDecision({ operation, policy, reason: AUTHORIZATION_REASON.capabilityDenied });
  }

  return issueDecision({
    context,
    operation,
    policy,
    allowed: true,
    reason: AUTHORIZATION_REASON.allowed,
  });
}

// An allowed decision is authority only for the exact verified context and
// exact server-selected operation that produced it. Clones, serialized audit
// snapshots, forged decisions, and decisions for another operation all fail.
export function isAuthorizedDecisionFor(decision, context, operation) {
  if (!decision || typeof decision !== 'object' || !validOperationIdentifier(operation)) return false;
  const binding = authorizedDecisionBindings.get(decision);
  if (!binding || binding.context !== context || binding.operation !== operation) return false;
  if (!validContext(context) || !Object.isFrozen(decision)) return false;

  const policy = Object.hasOwn(OPERATION_POLICIES, operation)
    ? OPERATION_POLICIES[operation]
    : null;
  return Boolean(policy
    && decision.allowed === true
    && decision.reason === AUTHORIZATION_REASON.allowed
    && decision.operation === operation
    && decision.capability === policy.capability
    && decision.policyVersion === AUTHORIZATION_POLICY_VERSION
    && decision.resource === policy.resource
    && decision.effect === policy.effect
    && decision.ownerScope === 'principal'
    && decision.ownerPrincipalId === context.principalId
    && decision.companyId === null
    && decision.companyAuthorityUsed === false
    && decision.toolExecutionAllowed === false
    && decision.businessActionAllowed === false
    && decision.automationTaskAllowed === false
    && context.capabilities.includes(policy.capability));
}
