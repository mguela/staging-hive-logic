// api/_lib/connection-states.js
// Shared Universal Connections state machine -- same 10-state vocabulary
// and transition rules the Phase 15 flow established in api/marketing.js
// for marketing_platform_connections. Extracted to its own module (that
// file has no exports for it) so ad_platform_connections enforces the
// exact same legal-transition rules without silently drifting from them.
// If the two ever need to diverge, do it deliberately and update both.

const CONNECTION_STATES = [
  'not_connected', 'setup_incomplete', 'reporting_verified', 'draft_validated',
  'launch_enabled', 'needs_attention', 'needs_reauth', 'policy_blocked',
  'billing_blocked', 'external_approval_pending',
];

const ISSUE_STATES = new Set(['needs_attention', 'needs_reauth', 'policy_blocked', 'billing_blocked', 'external_approval_pending']);

const RECOVERY_TARGETS = new Set(['setup_incomplete', 'not_connected']);

const CONNECTION_STATE_TRANSITIONS = {
  not_connected: new Set(['setup_incomplete']),
  setup_incomplete: new Set(['reporting_verified', 'not_connected', 'needs_reauth', 'policy_blocked', 'billing_blocked', 'external_approval_pending']),
  reporting_verified: new Set(['draft_validated', 'not_connected', 'needs_attention', 'needs_reauth', 'policy_blocked', 'billing_blocked']),
  draft_validated: new Set(['launch_enabled', 'not_connected', 'needs_attention', 'needs_reauth', 'policy_blocked', 'billing_blocked']),
  launch_enabled: new Set(['not_connected', 'needs_attention', 'needs_reauth', 'policy_blocked', 'billing_blocked']),
  needs_attention: new Set(RECOVERY_TARGETS),
  needs_reauth: new Set(RECOVERY_TARGETS),
  policy_blocked: new Set(RECOVERY_TARGETS),
  billing_blocked: new Set(RECOVERY_TARGETS),
  external_approval_pending: new Set(RECOVERY_TARGETS),
};

function isValidConnectionTransition(fromState, toState) {
  const allowed = CONNECTION_STATE_TRANSITIONS[fromState];
  return !!allowed && allowed.has(toState);
}

export {
  CONNECTION_STATES,
  ISSUE_STATES,
  RECOVERY_TARGETS,
  CONNECTION_STATE_TRANSITIONS,
  isValidConnectionTransition,
};
