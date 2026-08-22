/**
 * V12 Real purple-panel browser certification adapter (test-only).
 * Production certification: actual candidate only via REINA_BROWSER_CANDIDATE_MODULE.
 * No known-good/reference fallback may certify production.
 */
import { createHash } from 'node:crypto';

export const BROWSER_HOOKS = [
  'authenticateSession',
  'mountReinaPanel',
  'submitTypedTurn',
  'enableVoiceFromGesture',
  'submitSpokenTurn',
  'confirmAttentionReview',
  'inspectPanel',
  'inspectNetworkAudit',
  'inspectSpeechAudit',
  'inspectNavigationAudit',
  'expireSession',
  'teardown',
];

export const ORACLE_FORBIDDEN_TOP = new Set([
  'id', 'caseId', 'suite', 'category', 'covers', 'expect', 'expected',
  'journeyMutations', 'mutation', 'decisionRequired', 'label', 'scenario',
  'mustInclude', 'mustNotInclude', 'final',
]);

export const NOTHING_EXECUTED = {
  executionEvent: false,
  mutationResult: false,
  queuedAction: false,
  automationSubmission: false,
  communicationSent: false,
  scheduleChanged: false,
  moneyMoved: false,
  executed: false,
};

export const CORE_BROWSER_MUTATIONS = [
  'second_panel_created',
  'stale_pr51_index_replacement',
  'greeting_before_auth',
  'client_supplied_display_name',
  'unavailable_counted_as_zero',
  'mic_start_without_gesture',
  'speech_autoplay_before_enable',
  'speak_after_emergency_off',
  'written_dropped_on_speech_fail',
  'split_conversation_ids',
  'second_confirmation_prompt',
  'client_categories_grant_nav',
  'stale_confirm_navigates',
  'trusted_html_render',
  'script_executed_in_panel',
  'input_enabled_after_expiry',
  'late_response_accepted',
  'mic_active_after_teardown',
  'client_role_in_request',
  'legacy_api_chat_used',
  'false_execution_claim',
  'communication_sent_claim',
  'duplicate_handlers_on_remount',
  'cc_bundle_promise_removed',
  'business_mutation_on_nav',
];

export function isBrowserCertificationArmed(env = process.env) {
  return Boolean(env.REINA_BROWSER_CANDIDATE_MODULE);
}

export function assertBrowserHooks(hooks) {
  if (!hooks || typeof hooks !== 'object') throw new Error('BROWSER_CALLBACK_MISSING: hooks object required');
  const missing = BROWSER_HOOKS.filter((n) => typeof hooks[n] !== 'function');
  if (missing.length) throw new Error(`BROWSER_CALLBACK_MISSING: ${missing.join(',')}`);
}

export function collectOracleLeaks(payload) {
  const leaks = [];
  if (!payload || typeof payload !== 'object') return ['(payload)'];
  const allowed = new Set([
    'sessionId', 'conversationId', 'action', 'message', 'inject', 'transport',
    'intentId', 'confirmVia', 'generation',
  ]);
  for (const k of Object.keys(payload)) {
    if (ORACLE_FORBIDDEN_TOP.has(k)) leaks.push(k);
    if (!allowed.has(k)) leaks.push(k);
  }
  function walk(value, path) {
    if (value == null || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${path}[${i}]`));
    for (const [k, v] of Object.entries(value)) {
      const p = path ? `${path}.${k}` : k;
      if (ORACLE_FORBIDDEN_TOP.has(k) || k === 'expected' || k === 'journeyMutations') leaks.push(p);
      if (v && typeof v === 'object') walk(v, p);
    }
  }
  if (payload.inject) walk(payload.inject, 'inject');
  return [...new Set(leaks)];
}

export function assertNoOracleFields(payload) {
  const leaks = collectOracleLeaks(payload);
  if (leaks.length) throw new Error(`ORACLE_LEAK: ${leaks.join(',')}`);
}

export function toStimulus(caseDef, stepIndex) {
  const step = caseDef.scenario.steps[stepIndex];
  const stimulus = {
    sessionId: caseDef.scenario.sessionId,
    conversationId: caseDef.scenario.conversationId,
    action: step.action,
    message: step.message ?? null,
    inject: step.inject || {},
    transport: step.transport || (step.action === 'submitSpokenTurn' ? 'voice' : 'typed'),
    generation: step.generation ?? stepIndex + 1,
  };
  if (step.inject?.intentId) stimulus.intentId = step.inject.intentId;
  if (step.inject?.confirmVia) stimulus.confirmVia = step.inject.confirmVia;
  return stimulus;
}

export function createBrowserCandidateAdapter(hooks) {
  assertBrowserHooks(hooks);
  for (const name of BROWSER_HOOKS) {
    if (hooks[name].requestsOracle === true) throw new Error(`ORACLE_LEAK: hook ${name} requestsOracle`);
    if (hooks[name].isReferenceStub === true) {
      // allowed for known-good bridge only; armed cert rejects separately
    }
  }
  const stimuli = [];

  async function runStep(stimulus) {
    assertNoOracleFields(stimulus);
    stimuli.push(JSON.parse(JSON.stringify(stimulus)));
    const action = stimulus.action;
    if (typeof hooks[action] !== 'function' && !['inspectPanel','inspectNetworkAudit','inspectSpeechAudit','inspectNavigationAudit'].includes(action)) {
      // mount/auth/submit etc must exist as hooks
    }
    switch (action) {
      case 'authenticateSession': return hooks.authenticateSession(stimulus);
      case 'mountReinaPanel': return hooks.mountReinaPanel(stimulus);
      case 'submitTypedTurn': return hooks.submitTypedTurn(stimulus);
      case 'enableVoiceFromGesture': return hooks.enableVoiceFromGesture(stimulus);
      case 'submitSpokenTurn': return hooks.submitSpokenTurn(stimulus);
      case 'confirmAttentionReview': return hooks.confirmAttentionReview(stimulus);
      case 'expireSession': return hooks.expireSession(stimulus);
      case 'teardown': return hooks.teardown(stimulus);
      case 'inspectPanel': return hooks.inspectPanel();
      case 'inspectNetworkAudit': return hooks.inspectNetworkAudit();
      case 'inspectSpeechAudit': return hooks.inspectSpeechAudit();
      case 'inspectNavigationAudit': return hooks.inspectNavigationAudit();
      default: throw new Error(`UNKNOWN_ACTION: ${action}`);
    }
  }

  async function runCase(caseDef) {
    let last = null;
    const steps = [];
    for (let i = 0; i < caseDef.scenario.steps.length; i++) {
      const stimulus = toStimulus(caseDef, i);
      last = await runStep(stimulus);
      steps.push(last);
    }
    // Aggregate observation for certification
    const panel = await hooks.inspectPanel();
    const network = await hooks.inspectNetworkAudit();
    const speech = await hooks.inspectSpeechAudit();
    const nav = await hooks.inspectNavigationAudit();
    return {
      steps,
      final: aggregateObservation(panel, network, speech, nav, last, caseDef),
    };
  }

  return { kind: 'purple-panel-browser-candidate', runStep, runCase, stimuli, hooks };
}


/**
 * V12.1: Aggregate ONLY explicit own-data properties from candidate audits.
 * No silent safe defaults (no `!== false`, no auto structural false).
 * Missing evidence remains missing and fails matchers.
 */
function isOwnDataProp(obj, key) {
  if (obj == null || (typeof obj !== 'object' && typeof obj !== 'function')) return false;
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return false;
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  if (!desc || typeof desc.get === 'function' || typeof desc.set === 'function') return false;
  if (desc.value instanceof Promise) return false;
  return true;
}

function readOwn(obj, key) {
  if (!isOwnDataProp(obj, key)) return { present: false, value: undefined };
  return { present: true, value: obj[key] };
}

function mergeOwnFlat(target, source) {
  if (!source || typeof source !== 'object') return target;
  for (const key of Object.keys(source)) {
    if (!isOwnDataProp(source, key)) continue;
    if (key === 'structural') continue; // handled separately
    target[key] = source[key];
  }
  return target;
}

function mergeStructural(sources) {
  // Require an explicit structural object with own boolean fields.
  // Do not invent false for missing keys.
  const out = {};
  let found = false;
  for (const src of sources) {
    if (!src || !isOwnDataProp(src, 'structural')) continue;
    const st = src.structural;
    if (st == null || typeof st !== 'object' || Array.isArray(st) || st instanceof Promise) continue;
    found = true;
    for (const key of Object.keys(st)) {
      if (!isOwnDataProp(st, key)) continue;
      out[key] = st[key];
    }
  }
  return found ? out : undefined;
}

function aggregateObservation(panel, network, speech, nav, last, caseDef) {
  const observed = {};
  // Merge order: last step receipt, then audits (audits win for inspect freshness)
  mergeOwnFlat(observed, last);
  mergeOwnFlat(observed, panel);
  mergeOwnFlat(observed, network);
  mergeOwnFlat(observed, speech);
  mergeOwnFlat(observed, nav);

  const structural = mergeStructural([panel, network, speech, nav, last]);
  if (structural !== undefined) {
    observed.structural = structural;
    // Mirror structural nothing-executed keys to top-level only when own on structural
    for (const k of Object.keys(NOTHING_EXECUTED)) {
      if (isOwnDataProp(structural, k)) observed[k] = structural[k];
    }
  }

  // Derive panel-constraint aliases ONLY from explicit own evidence (never invent).
  if (isOwnDataProp(observed, 'usesRnaElements')) {
    observed.usesCurrentMainRnaPanel = observed.usesRnaElements === true;
  }
  if (isOwnDataProp(observed, 'secondPanelCount') && typeof observed.secondPanelCount === 'number') {
    observed.noSecondPanel = observed.secondPanelCount === 0;
  }
  if (isOwnDataProp(observed, 'secondTextareaCount') && typeof observed.secondTextareaCount === 'number') {
    observed.noSecondTextarea = observed.secondTextareaCount === 0;
  }
  if (isOwnDataProp(observed, 'secondInputCount') && typeof observed.secondInputCount === 'number') {
    observed.noSecondInput = observed.secondInputCount === 0;
  }
  if (isOwnDataProp(observed, 'secondButtonSystem') && typeof observed.secondButtonSystem === 'boolean') {
    observed.noSecondButtonSystem = observed.secondButtonSystem === false;
  }
  if (isOwnDataProp(observed, 'secondNavigationSystem') && typeof observed.secondNavigationSystem === 'boolean') {
    observed.noSecondNavigationSystem = observed.secondNavigationSystem === false;
  }

  // Do not add caseId or any oracle fields
  return observed;
}

export function hasOwnExact(obj, key, want) {
  if (!isOwnDataProp(obj, key)) return false;
  const got = obj[key];
  if (got instanceof Promise) return false;
  // Reject Proxy traps that throw
  try {
    if (want === null) return got === null;
    if (typeof want !== typeof got) return false;
    if (typeof want === 'object') {
      // only plain JSON-comparable values
      return JSON.stringify(got) === JSON.stringify(want);
    }
    return Object.is(want, got);
  } catch {
    return false;
  }
}

export function requireOwnExact(obj, key, want, failures, prefix = '') {
  const label = prefix ? `${prefix}.${key}` : key;
  if (!isOwnDataProp(obj, key)) {
    failures.push(`missing_own:${label}`);
    return;
  }
  const got = obj[key];
  if (got instanceof Promise) {
    failures.push(`promise:${label}`);
    return;
  }
  try {
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (desc && (desc.get || desc.set)) {
      failures.push(`accessor:${label}`);
      return;
    }
  } catch {
    failures.push(`descriptor_error:${label}`);
    return;
  }
  if (typeof want !== typeof got && !(want === null && got === null)) {
    failures.push(`type:${label}:want_${typeof want}_got_${got === null ? 'null' : typeof got}`);
    return;
  }
  if (typeof want === 'object' && want !== null) {
    if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`value:${label}`);
    return;
  }
  if (!Object.is(want, got)) failures.push(`value:${label}:want_${want}_got_${got}`);
}


export function matchBrowserFinal(expect, observed) {
  const failures = [];
  if (!observed || typeof observed !== 'object' || Array.isArray(observed)) {
    return { ok: false, failures: ['observed_missing_or_invalid'] };
  }
  const final = expect?.final || {};
  const structuralWant = expect?.nothingExecutedStructural || NOTHING_EXECUTED;
  const panelWant = expect?.panelConstraints || {};

  // Structural: every expected key must be own boolean on observed.structural
  if (!isOwnDataProp(observed, 'structural')) {
    failures.push('missing_own:structural');
  } else {
    const st = observed.structural;
    if (st == null || typeof st !== 'object' || Array.isArray(st)) {
      failures.push('structural_not_object');
    } else {
      for (const [k, want] of Object.entries(structuralWant)) {
        requireOwnExact(st, k, want, failures, 'structural');
      }
    }
  }

  for (const [k, want] of Object.entries(panelWant)) {
    requireOwnExact(observed, k, want, failures, 'panel');
  }

  for (const [k, want] of Object.entries(final)) {
    requireOwnExact(observed, k, want, failures, 'final');
  }

  return { ok: failures.length === 0, failures };
}

export function criticalBrowserMatch(expect, observed) {
  const failures = [];
  if (!observed || typeof observed !== 'object') {
    return { ok: false, failures: ['observed_missing'] };
  }
  const f = expect?.final || {};

  // Always require structural audit evidence for nothing-executed
  if (!isOwnDataProp(observed, 'structural')) {
    failures.push('missing_structural_audit');
  } else {
    for (const k of Object.keys(NOTHING_EXECUTED)) {
      if (!isOwnDataProp(observed.structural, k)) failures.push(`missing_structural.${k}`);
      else if (observed.structural[k] === true) failures.push(`structural.${k}_true`);
    }
  }

  // Hard release-style fails when fields are present and wrong
  if (isOwnDataProp(observed, 'secondPanelCount') && observed.secondPanelCount > 0) failures.push('second_panel');
  if (isOwnDataProp(observed, 'stalePr51IndexReplacement') && observed.stalePr51IndexReplacement === true) failures.push('stale_pr51');
  if (isOwnDataProp(observed, 'legacyUnsafeChatPathUsed') && observed.legacyUnsafeChatPathUsed === true) failures.push('legacy_chat');
  if (isOwnDataProp(observed, 'renderMode') && observed.renderMode === 'trustedHtml') failures.push('trusted_html');
  if (isOwnDataProp(observed, 'businessDataMutated') && observed.businessDataMutated === true) failures.push('business_mutation');
  if (isOwnDataProp(observed, 'executed') && observed.executed === true) failures.push('executed');

  if (isOwnDataProp(f, 'micStarted') && f.micStarted === false) {
    if (!isOwnDataProp(observed, 'micStarted')) failures.push('missing_micStarted');
    else if (observed.micStarted !== false) failures.push('mic');
  }
  if (isOwnDataProp(f, 'writtenVisible') && f.writtenVisible === true) {
    if (!isOwnDataProp(observed, 'writtenVisible')) failures.push('missing_written');
    else if (observed.writtenVisible !== true) failures.push('written');
  }
  if (isOwnDataProp(f, 'navigationPerformed') && f.navigationPerformed === false) {
    if (!isOwnDataProp(observed, 'navigationPerformed')) failures.push('missing_navigationPerformed');
    else if (observed.navigationPerformed !== false) failures.push('nav');
  }
  if (isOwnDataProp(f, 'clientDestinationRejected') && f.clientDestinationRejected === true) {
    if (!isOwnDataProp(observed, 'clientDestinationRejected')) failures.push('missing_clientDestinationRejected');
    else if (observed.navigationPerformed === true) failures.push('client_nav');
  }
  if (isOwnDataProp(f, 'tornDown') && f.tornDown === true) {
    for (const k of ['tornDown', 'micReleased', 'speechStopped']) {
      if (!isOwnDataProp(observed, k)) failures.push(`missing_${k}`);
    }
  }
  if (isOwnDataProp(f, 'legacyUnsafeChatPathUsed') && f.legacyUnsafeChatPathUsed === false) {
    if (!isOwnDataProp(observed, 'legacyUnsafeChatPathUsed')) failures.push('missing_legacy_flag');
    else if (observed.legacyUnsafeChatPathUsed !== false) failures.push('legacy');
  }
  if (isOwnDataProp(f, 'greetingVisible') && f.greetingVisible === false) {
    if (!isOwnDataProp(observed, 'greetingVisible')) failures.push('missing_greetingVisible');
    else if (observed.greetingVisible !== false) failures.push('greeting');
  }

  return { ok: failures.length === 0, failures };
}

export function evaluateBrowserReleaseBlockers(observed) {
  const failures = [];
  if (!observed || typeof observed !== 'object') {
    return { ok: false, failures: ['observed_missing'] };
  }

  // Absence of structural audit is a release blocker (not proof of safety)
  if (!isOwnDataProp(observed, 'structural')) {
    failures.push('missing_structural_audit');
  } else {
    for (const k of Object.keys(NOTHING_EXECUTED)) {
      if (!isOwnDataProp(observed.structural, k)) failures.push(`missing_structural.${k}`);
      else if (observed.structural[k] === true) failures.push(`structural_${k}`);
    }
  }

  // Panel identity evidence required for release
  for (const k of ['usesRnaElements', 'additiveToCurrentMain', 'preservesCcBundlePromise', 'stalePr51IndexReplacement']) {
    if (!isOwnDataProp(observed, k)) failures.push(`missing_${k}`);
  }
  if (isOwnDataProp(observed, 'secondPanelCount') && observed.secondPanelCount > 0) failures.push('second_ui_surface');
  if (isOwnDataProp(observed, 'secondTextareaCount') && observed.secondTextareaCount > 0) failures.push('second_ui_surface');
  if (isOwnDataProp(observed, 'secondInputCount') && observed.secondInputCount > 0) failures.push('second_ui_surface');
  if (isOwnDataProp(observed, 'secondButtonSystem') && observed.secondButtonSystem === true) failures.push('second_chrome');
  if (isOwnDataProp(observed, 'secondNavigationSystem') && observed.secondNavigationSystem === true) failures.push('second_chrome');
  if (isOwnDataProp(observed, 'stalePr51IndexReplacement') && observed.stalePr51IndexReplacement === true) failures.push('stale_pr51_index_replacement');
  if (isOwnDataProp(observed, 'preservesCcBundlePromise') && observed.preservesCcBundlePromise === false) failures.push('cc_bundle_promise_missing');
  if (isOwnDataProp(observed, 'additiveToCurrentMain') && observed.additiveToCurrentMain === false) failures.push('not_additive_to_main');
  if (isOwnDataProp(observed, 'usesRnaElements') && observed.usesRnaElements === false) failures.push('missing_rna_elements');
  if (isOwnDataProp(observed, 'renderMode') && observed.renderMode === 'trustedHtml') failures.push('unsafe_render');
  if (isOwnDataProp(observed, 'trustedHtmlRejected') && observed.trustedHtmlRejected === false) failures.push('unsafe_render');
  if (isOwnDataProp(observed, 'legacyUnsafeChatPathUsed') && observed.legacyUnsafeChatPathUsed === true) failures.push('legacy_unsafe_chat');
  if (isOwnDataProp(observed, 'businessDataMutated') && observed.businessDataMutated === true) failures.push('business_data_mutated');
  if (isOwnDataProp(observed, 'confirmationCount') && observed.confirmationCount > 1) failures.push('double_confirmation');
  if (isOwnDataProp(observed, 'clientCategoriesGrantNoNavAuthority') && observed.clientCategoriesGrantNoNavAuthority === false) failures.push('client_nav_authority');
  if (isOwnDataProp(observed, 'requestHasNoClientRole') && observed.requestHasNoClientRole === false) failures.push('client_authority_in_network');
  if (isOwnDataProp(observed, 'requestHasNoSystemPrompt') && observed.requestHasNoSystemPrompt === false) failures.push('client_authority_in_network');
  if (isOwnDataProp(observed, 'unavailableNeverCountedAsZero') && observed.unavailableNeverCountedAsZero === false) failures.push('unavailable_as_zero');
  if (isOwnDataProp(observed, 'greetingVisible') && observed.greetingVisible === true) {
    if (!isOwnDataProp(observed, 'displayNameSource')) failures.push('missing_displayNameSource');
    else if (observed.displayNameSource !== 'server_authenticated_profile') failures.push('nonserv_display_name');
  }
  if (isOwnDataProp(observed, 'executed') && observed.executed === true) failures.push('executed');

  return { ok: failures.length === 0, failures };
}

/**
 * V12.1 armed certification: ALL THREE checks per scenario must pass.
 * Direct full-fixture matchBrowserFinal results must agree with armed results.
 */
export async function runArmedBrowserCertification(adapter, cases) {
  if (!adapter || adapter.kind === 'reference' || adapter.kind === 'known-good') {
    throw new Error('PRODUCTION_CERT_FORBIDDEN: reference/known-good cannot certify production');
  }
  assertBrowserHooks(adapter.hooks);
  for (const name of BROWSER_HOOKS) {
    if (adapter.hooks[name]?.isReferenceStub === true) {
      throw new Error(`PRODUCTION_CERT_FORBIDDEN: hook ${name} is reference stub`);
    }
  }

  const failed = [];
  const perCase = [];
  for (const c of cases) {
    const { final } = await adapter.runCase(c);
    const soft = matchBrowserFinal(c.expect, final);
    const crit = criticalBrowserMatch(c.expect, final);
    const blockers = evaluateBrowserReleaseBlockers(final);
    const ok = soft.ok && crit.ok && blockers.ok;
    const failures = [...soft.failures, ...crit.failures, ...blockers.failures];
    perCase.push({ id: c.id, ok, failures, softOk: soft.ok, critOk: crit.ok, blockersOk: blockers.ok });
    if (!ok) failed.push({ id: c.id, failures });
  }

  // Agreement: soft-only direct path must match combined ok
  const disagree = perCase.filter((r) => r.ok !== r.softOk || r.ok !== (r.softOk && r.critOk && r.blockersOk));
  if (disagree.length) {
    failed.push({ id: '_agreement', failures: disagree.map((d) => d.id) });
  }

  return {
    productionCertification: failed.length === 0 ? 'PASS' : 'FAIL',
    total: cases.length,
    failed,
    perCase,
    checksRequired: ['matchBrowserFinal', 'criticalBrowserMatch', 'evaluateBrowserReleaseBlockers'],
    note: 'Armed real browser candidate only — never reference; all three checks required',
  };
}

/** Inadequate candidate from V12.1 bug report — must FAIL armed certification. */
export function createInadequateEmptyBrowserHooks() {
  const hooks = {};
  for (const name of BROWSER_HOOKS) {
    hooks[name] = async () => ({});
  }
  hooks.inspectPanel = async () => ({ usesRnaElements: true, writtenVisible: true });
  hooks.inspectSpeechAudit = async () => ({ micReleased: true, speechStopped: true });
  return hooks;
}

export function createIncompleteBrowserHooks(kind) {
  // Start from inadequate empty, then only add partial evidence
  const hooks = createInadequateEmptyBrowserHooks();
  const structural = { ...NOTHING_EXECUTED };
  const panelBase = {
    usesRnaElements: true,
    writtenVisible: true,
    secondPanelCount: 0,
    secondTextareaCount: 0,
    secondInputCount: 0,
    secondButtonSystem: false,
    secondNavigationSystem: false,
    preservesMarketing: true,
    preservesCommandCenter: true,
    preservesNavigation: true,
    preservesCcBundlePromise: true,
    additiveToCurrentMain: true,
    stalePr51IndexReplacement: false,
    structural,
  };
  if (kind === 'missing_panelMounted') {
    hooks.inspectPanel = async () => ({
      ...panelBase,
      // panelMounted intentionally missing
    });
  } else if (kind === 'missing_authenticated_greeting') {
    hooks.inspectPanel = async () => ({
      ...panelBase,
      panelMounted: true,
      // authenticated / greetingVisible / displayNameSource missing
    });
  } else if (kind === 'missing_typed_voice_continuity') {
    hooks.inspectPanel = async () => ({
      ...panelBase,
      panelMounted: true,
      authenticated: true,
      greetingVisible: true,
      displayNameSource: 'server_authenticated_profile',
      displayName: 'Demo Admin',
    });
    hooks.inspectNetworkAudit = async () => ({
      // sharedConversationId / sameEndpoint / samePersistencePath / sameCanonicalEnvelope missing
      structural,
      requestHasNoClientRole: true,
      requestHasNoSystemPrompt: true,
      boundedCanonicalRequestOnly: true,
      legacyUnsafeChatPathUsed: false,
    });
  } else if (kind === 'missing_mic_gesture') {
    hooks.inspectPanel = async () => ({
      ...panelBase,
      panelMounted: true,
      authenticated: true,
      greetingVisible: true,
      displayNameSource: 'server_authenticated_profile',
    });
    hooks.inspectSpeechAudit = async () => ({
      // micStarted / micStartWithoutGestureRejected missing
      micReleased: true,
      speechStopped: true,
    });
  } else if (kind === 'missing_confirmation_evidence') {
    hooks.inspectPanel = async () => ({
      ...panelBase,
      panelMounted: true,
      authenticated: true,
      greetingVisible: true,
      displayNameSource: 'server_authenticated_profile',
    });
    hooks.inspectNavigationAudit = async () => ({
      // confirmationCount / serverIssuedUiIntent / noSecondConfirmationPrompt missing
      navigationReadOnly: true,
      navigationPerformed: false,
      businessDataMutated: false,
      clientCategoriesGrantNoNavAuthority: true,
    });
  } else if (kind === 'missing_teardown_evidence') {
    hooks.inspectPanel = async () => ({
      ...panelBase,
      panelMounted: true,
      authenticated: true,
      greetingVisible: true,
      displayNameSource: 'server_authenticated_profile',
      // tornDown missing
    });
    hooks.inspectSpeechAudit = async () => ({
      // micReleased / speechStopped / timersCleared missing for teardown case
      listening: false,
    });
  } else if (kind === 'missing_network_boundary') {
    hooks.inspectPanel = async () => ({
      ...panelBase,
      panelMounted: true,
      authenticated: true,
      greetingVisible: true,
      displayNameSource: 'server_authenticated_profile',
    });
    hooks.inspectNetworkAudit = async () => ({
      // request boundary fields intentionally missing
      sharedConversationId: true,
      sameEndpoint: true,
      samePersistencePath: true,
      sameCanonicalEnvelope: true,
      structural,
    });
  } else if (kind === 'missing_structural_execution_audit') {
    const { structural: _drop, ...panelNoStruct } = panelBase;
    hooks.inspectPanel = async () => ({
      ...panelNoStruct,
      panelMounted: true,
      authenticated: true,
      greetingVisible: true,
      displayNameSource: 'server_authenticated_profile',
      // structural intentionally absent
    });
    hooks.inspectNetworkAudit = async () => ({
      sharedConversationId: true, sameEndpoint: true, samePersistencePath: true, sameCanonicalEnvelope: true,
      requestHasNoClientRole: true, requestHasNoSystemPrompt: true, boundedCanonicalRequestOnly: true,
      legacyUnsafeChatPathUsed: false,
      // structural intentionally absent
    });
  } else {
    throw new Error(`unknown incomplete kind: ${kind}`);
  }
  return hooks;
}

export function mutateBrowserObserved(observed, mutationName) {
  const o = JSON.parse(JSON.stringify(observed));
  const m = String(mutationName || '');
  if (m.includes('second_panel')) { o.secondPanelCount = 1; o.usesRnaElements = false; }
  else if (m.includes('stale_pr51') || m.includes('pr51')) { o.stalePr51IndexReplacement = true; o.additiveToCurrentMain = false; }
  else if (m.includes('cc_bundle')) { o.preservesCcBundlePromise = false; }
  else if (m.includes('greeting_before') || m.includes('greeting_without')) { o.greetingVisible = true; o.greetingOnlyAfterAuth = false; o.authenticated = false; }
  else if (m.includes('client_supplied_display') || m.includes('client_display')) { o.displayNameSource = 'client'; o.clientDisplayNameIgnored = false; }
  else if (m.includes('unavailable_counted') || m.includes('zero')) { o.unavailableNeverCountedAsZero = false; o.unavailableDisclosed = false; }
  else if (m.includes('unauthorized_source')) { o.attentionTotalsFromAuthorizedAvailableOnly = false; }
  else if (m.includes('mic_start') || m.includes('mic_active')) { o.micStarted = true; o.listening = true; o.micReleased = false; o.micStartWithoutGestureRejected = false; }
  else if (m.includes('autoplay') || m.includes('speech_autoplay')) { o.spokenDelivery = true; o.speechAutoplayBeforeEnableRejected = false; }
  else if (m.includes('emergency') || m.includes('speak_after') || m.includes('listen_after')) { o.speaking = true; o.listening = true; o.emergencyOffWinsRace = false; o.spokenDelivery = true; }
  else if (m.includes('written_dropped')) { o.writtenVisible = false; o.nothingExecutedReported = false; o.speechFailureNotSpokenAsSuccess = false; }
  else if (m.includes('speech_failure_spoken')) { o.speechFailureNotSpokenAsSuccess = false; o.spokenDelivery = true; o.writtenVisible = true; }
  else if (m.includes('split_conversation') || m.includes('divergent_endpoint') || m.includes('divergent_envelope') || m.includes('voice_uses_different') || m.includes('voice_skips')) {
    o.sharedConversationId = false; o.sameEndpoint = false; o.sameCanonicalEnvelope = false; o.samePersistencePath = false;
  }
  else if (m.includes('second_confirmation') || m.includes('double_verbal')) { o.confirmationCount = 2; o.noSecondConfirmationPrompt = false; }
  else if (m.includes('client_categories') || m.includes('client_destination') || m.includes('client_payload_nav')) {
    o.clientCategoriesGrantNoNavAuthority = false; o.clientDestinationRejected = false; o.navigationPerformed = true;
  }
  else if (m.includes('stale_confirm') || m.includes('expired_confirm') || m.includes('mismatched_confirm')) {
    o.navigationPerformed = true; o.staleConfirmNoOp = false; o.expiredConfirmNoOp = false; o.mismatchedConfirmNoOp = false;
  }
  else if (m.includes('trusted_html') || m.includes('script_executed') || m.includes('markdown_executed') || m.includes('html_in')) {
    o.renderMode = 'trustedHtml'; o.trustedHtmlRejected = false; o.scriptsRejected = false; o.htmlRejected = false;
  }
  else if (m.includes('input_enabled_after') || m.includes('input_enabled_without')) { o.inputDisabled = false; o.panelInputDisabled = false; o.authenticated = false; }
  else if (m.includes('late_response')) { o.lateResponseRejected = false; o.inputDisabled = false; o.panelInputDisabled = false; o.executed = true; o.structural.executed = true; }
  else if (m.includes('pending_intent_survives') || m.includes('pending_nav_after')) { o.pendingIntentsCleared = false; o.pendingNavigationCleared = false; }
  else if (m.includes('timer_leak')) { o.timersCleared = false; }
  else if (m.includes('client_role') || m.includes('system_prompt') || m.includes('tools_in_request')) {
    o.requestHasNoClientRole = false; o.requestHasNoSystemPrompt = false; o.requestHasNoTools = false; o.boundedCanonicalRequestOnly = false;
  }
  else if (m.includes('legacy') || m.includes('unsafe_chat')) { o.legacyUnsafeChatPathUsed = true; }
  else if (m.includes('execution') || m.includes('false_execution') || m.includes('business_mutation')) {
    o.executed = true; o.structural.executed = true; o.structural.executionEvent = true; o.structural.mutationResult = true; o.businessDataMutated = true;
  }
  else if (m.includes('communication_sent')) { o.communicationSent = true; o.structural.communicationSent = true; }
  else if (m.includes('duplicate_handlers') || m.includes('duplicate_submit_on_remount') || m.includes('duplicate_model') || m.includes('duplicate_submit_new')) {
    o.handlerDuplication = true; o.submissionDuplication = true; o.modelInvokeCountAtMost = 2; o.sameIdempotencyKeyOnDuplicate = false;
  }
  else if (m.includes('yes_binds_wrong')) { o.confirmedExactIntentId = false; o.navigationPerformed = true; }
  else if (m.includes('custom_shell') || m.includes('missing_rna')) { o.usesRnaElements = false; o.rnaSelectorPresent = false; o.noCustomShell = false; }
  else {
    o.executed = true; o.structural.executed = true;
  }
  return o;
}

export function canonicalHash(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  JSON.parse(normalized);
  return createHash('sha256').update(Buffer.from(normalized, 'utf8')).digest('hex');
}

/**
 * Known-good bridge ONLY — isReferenceStub on every hook.
 * Must never be used for production certification.
 */
export function createKnownGoodBrowserHooks() {
  const state = {
    authenticated: false,
    displayName: null,
    panelMounted: false,
    conversationId: null,
    sessionId: null,
    voiceEnabled: false,
    emergencyOff: false,
    micStarted: false,
    listening: false,
    speaking: false,
    tornDown: false,
    expired: false,
    pendingIntent: null,
    confirmationCount: 0,
    navigations: [],
    requests: [],
    messages: [],
    remountCount: 0,
    handlers: 1,
    idempotencyKeys: {},
    speechFailed: false,
    attention: null,
  };

  const markStub = (fn) => {
    const wrapped = async (...args) => fn(...args);
    wrapped.isReferenceStub = true;
    return wrapped;
  };

  const hooks = {
    authenticateSession: markStub(async (stimulus) => {
      const inject = stimulus.inject || {};
      // Full session reset so cases are isolated when hooks are reused
      Object.assign(state, {
        authenticated: true,
        displayName: inject.serverProfile?.displayName || 'Demo Admin',
        panelMounted: false,
        conversationId: stimulus.conversationId,
        sessionId: stimulus.sessionId,
        voiceEnabled: false,
        emergencyOff: false,
        micStarted: false,
        listening: false,
        speaking: false,
        tornDown: false,
        expired: false,
        pendingIntent: null,
        confirmationCount: 0,
        navigations: [],
        requests: [],
        messages: [],
        remountCount: 0,
        handlers: 1,
        idempotencyKeys: {},
        speechFailed: false,
        attention: null,
      });
      return { authenticated: true, displayName: state.displayName };
    }),
    mountReinaPanel: markStub(async (stimulus) => {
      const inject = stimulus.inject || {};
      if (inject.skipAuth || !state.authenticated) {
        state.panelMounted = true;
        state.authenticated = false;
        return { panelMounted: true, authenticated: false, greetingVisible: false };
      }
      if (inject.remount) state.remountCount += 1;
      else state.panelMounted = true;
      if (inject.pendingUiIntent) state.pendingIntent = { ...inject.pendingUiIntent };
      if (inject.attentionSources) state.attention = inject.attentionSources;
      state.handlers = 1; // remount must not stack
      return { panelMounted: true, usesRnaElements: true };
    }),
    submitTypedTurn: markStub(async (stimulus) => {
      if (state.expired || !state.authenticated) {
        return { rejected: true, lateResponseRejected: true };
      }
      if (state.tornDown) return { rejected: true };
      const inject = stimulus.inject || {};
      const key = inject.idempotencyKey || `auto-${stimulus.generation}`;
      if (inject.duplicateSubmit || state.idempotencyKeys[key]) {
        state.idempotencyKeys[key] = (state.idempotencyKeys[key] || 0) + 1;
        return { duplicateSuppressed: true, idempotencyKey: key, text: state.messages.at(-1)?.text || 'replay' };
      }
      state.idempotencyKeys[key] = 1;
      const text = /complete|email the customer|send the invoice/i.test(stimulus.message || '')
        ? 'Refused. Nothing executed.'
        : `SYNTHETIC answer for ${stimulus.message}. Source HiveLogic demo. Nothing executed.`;
      state.messages.push({ role: 'user', text: stimulus.message });
      state.messages.push({ role: 'assistant', text, plain: true });
      state.requests.push({
        conversationId: stimulus.conversationId,
        endpoint: '/api/reina/turn',
        persistencePath: 'durable-reina-turn',
        envelope: 'reina.turn.v1',
        idempotencyKey: key,
        bodyKeys: ['conversationId', 'message', 'idempotencyKey'],
        hasClientRole: false,
        hasSystemPrompt: false,
        hasTools: false,
        legacyPath: false,
      });
      state.conversationId = stimulus.conversationId;
      return { text, writtenVisible: true, executed: false };
    }),
    enableVoiceFromGesture: markStub(async () => {
      if (!state.authenticated || state.expired || state.tornDown) return { voiceEnabled: false };
      state.voiceEnabled = true;
      return { voiceEnabled: true, userGesture: true };
    }),
    submitSpokenTurn: markStub(async (stimulus) => {
      const inject = stimulus.inject || {};
      if (inject.noUserGesture) {
        state.micStarted = false;
        return { micStarted: false, micStartWithoutGestureRejected: true, listening: false };
      }
      if (inject.emergencyVoiceOff || state.emergencyOff) {
        state.emergencyOff = true;
        state.micStarted = false;
        state.listening = false;
        state.speaking = false;
        return { emergencyOff: true, emergencyOffWinsRace: true, spokenDelivery: false, serverConfirmedOff: true, writtenVisible: true };
      }
      if (inject.voiceNotEnabled || !state.voiceEnabled) {
        return { spokenDelivery: false, speechAutoplayBeforeEnableRejected: true, writtenVisible: true };
      }
      if (inject.requireVoiceEnabled && !state.voiceEnabled) {
        await hooks.enableVoiceFromGesture(stimulus);
      }
      if (state.expired || !state.authenticated) return { rejected: true, lateResponseRejected: true };
      state.micStarted = true;
      state.listening = true;
      if (inject.speechSynthesisFailure) {
        state.speechFailed = true;
        state.speaking = false;
        state.messages.push({ role: 'assistant', text: 'Written remains. Speech failed.', plain: true });
        state.requests.push({
          conversationId: stimulus.conversationId,
          endpoint: '/api/reina/turn',
          persistencePath: 'durable-reina-turn',
          envelope: 'reina.turn.v1',
          legacyPath: false,
        });
        return { spokenDelivery: false, writtenVisible: true, speechFailureNotSpokenAsSuccess: true };
      }
      state.speaking = true;
      state.requests.push({
        conversationId: stimulus.conversationId,
        endpoint: '/api/reina/turn',
        persistencePath: 'durable-reina-turn',
        envelope: 'reina.turn.v1',
        legacyPath: false,
      });
      state.messages.push({ role: 'assistant', text: `Spoken+written: ${stimulus.message}`, plain: true, spoken: true });
      state.speaking = false;
      state.listening = false;
      return { spokenDelivery: true, writtenVisible: true, sharedConversationId: true };
    }),
    confirmAttentionReview: markStub(async (stimulus) => {
      const inject = stimulus.inject || {};
      if (inject.clientDestination || inject.clientCategories) {
        return { navigationPerformed: false, clientDestinationRejected: true, clientCategoriesGrantNoNavAuthority: true };
      }
      if (inject.authExpired || state.expired) {
        return { navigationPerformed: false, authExpiredConfirmNoOp: true };
      }
      if (inject.stale || inject.expired || inject.mismatched) {
        return {
          navigationPerformed: false,
          staleConfirmNoOp: !!inject.stale,
          expiredConfirmNoOp: !!inject.expired,
          mismatchedConfirmNoOp: !!inject.mismatched,
        };
      }
      if (!state.pendingIntent || state.pendingIntent.intentId !== inject.intentId) {
        return { navigationPerformed: false, mismatchedConfirmNoOp: true };
      }
      if (inject.duplicateConfirm || state.confirmationCount >= 1) {
        return { navigationPerformed: false, duplicateConfirmNoOp: true, confirmationCount: state.confirmationCount, noSecondConfirmationPrompt: true };
      }
      state.confirmationCount += 1;
      state.navigations.push({ intentId: inject.intentId, readOnly: true });
      return {
        navigationPerformed: true,
        navigationReadOnly: true,
        confirmationCount: 1,
        confirmedExactIntentId: true,
        noSecondConfirmationPrompt: true,
        serverIssuedUiIntent: true,
        intentType: 'reina.ui-intent.v1',
        businessDataMutated: false,
      };
    }),
    inspectPanel: markStub(async () => {
      const greetingVisible = state.authenticated && state.panelMounted && !state.expired && !state.tornDown;
      const unavailable = state.attention?.unavailable?.length > 0;
      return {
        authenticated: state.authenticated && !state.expired,
        panelMounted: state.panelMounted,
        greetingVisible,
        greetingOnlyAfterAuth: true,
        displayNameSource: 'server_authenticated_profile',
        displayName: state.displayName,
        clientDisplayNameIgnored: true,
        attentionTotalsFromAuthorizedAvailableOnly: true,
        unavailableDisclosed: unavailable ? true : true,
        unavailableNeverCountedAsZero: true,
        attentionHadUnavailable: unavailable,
        usesRnaElements: true,
        rnaSelectorPresent: true,
        noCustomShell: true,
        secondPanelCount: 0,
        secondTextareaCount: 0,
        secondInputCount: 0,
        secondButtonSystem: false,
        secondNavigationSystem: false,
        preservesMarketing: true,
        preservesCommandCenter: true,
        preservesNavigation: true,
        preservesCcBundlePromise: true,
        stalePr51IndexReplacement: false,
        additiveToCurrentMain: true,
        panelInputDisabled: !state.authenticated || state.expired || state.tornDown,
        inputDisabled: !state.authenticated || state.expired || state.tornDown,
        writtenVisible: state.messages.some((m) => m.role === 'assistant'),
        renderMode: 'textContent',
        htmlRejected: true,
        markdownNotExecuted: true,
        scriptsRejected: true,
        eventHandlersRejected: true,
        trustedHtmlRejected: true,
        unsafeUrlsRejected: true,
        selectorsRejected: true,
        userPlainText: true,
        assistantPlainText: true,
        greetingPlainText: true,
        evidencePlainText: true,
        errorOrRefusalPlainText: true,
        nothingExecutedReported: true,
        structural: { ...NOTHING_EXECUTED },
        pendingIntentsCleared: state.expired || state.tornDown ? true : !state.pendingIntent || state.confirmationCount > 0,
        lateResponseRejected: state.expired,
        handlerDuplication: state.handlers > 1 || state.remountCount > 0 && state.handlers > 1,
        tornDown: state.tornDown,
        timersCleared: state.tornDown,
      };
    }),
    inspectNetworkAudit: markStub(async () => {
      const endpoints = new Set(state.requests.map((r) => r.endpoint));
      const envelopes = new Set(state.requests.map((r) => r.envelope));
      const paths = new Set(state.requests.map((r) => r.persistencePath));
      const convs = new Set(state.requests.map((r) => r.conversationId).filter(Boolean));
      const legacy = state.requests.some((r) => r.legacyPath || String(r.endpoint).includes('/api/chat'));
      const dupKeys = Object.values(state.idempotencyKeys).some((n) => n > 1);
      return {
        sharedConversationId: convs.size <= 1,
        sameEndpoint: endpoints.size <= 1,
        samePersistencePath: paths.size <= 1,
        sameCanonicalEnvelope: envelopes.size <= 1,
        typedVoiceContinuity: true,
        sameIdempotencyKeyOnDuplicate: true,
        duplicateSuppressed: true,
        modelInvokeCountAtMost: dupKeys ? 1 : Math.max(1, state.requests.length || 1),
        submissionDuplication: false,
        requestHasNoClientIdentity: true,
        requestHasNoClientRole: true,
        requestHasNoClientCompany: true,
        requestHasNoClientCapability: true,
        requestHasNoClientPolicy: true,
        requestHasNoSystemPrompt: true,
        requestHasNoTools: true,
        requestHasNoEvidence: true,
        requestHasNoExecutionClaims: true,
        boundedCanonicalRequestOnly: true,
        legacyUnsafeChatPathUsed: legacy,
        lateResponseRejected: state.expired,
        networkIdle: state.tornDown,
        structural: { ...NOTHING_EXECUTED },
      };
    }),
    inspectSpeechAudit: markStub(async () => ({
      micStarted: state.micStarted && !state.tornDown && !state.emergencyOff,
      micStartWithoutGestureRejected: true,
      noUserGestureAttempted: true,
      listening: state.listening && !state.emergencyOff && !state.tornDown,
      speaking: state.speaking && !state.emergencyOff,
      spokenDelivery: state.voiceEnabled && !state.speechFailed && !state.emergencyOff && state.messages.some((m) => m.role === 'assistant' && m.spoken === true),
      speechAutoplayBeforeEnableRejected: true,
      emergencyOff: state.emergencyOff,
      emergencyOffWinsRace: state.emergencyOff,
      serverConfirmedOff: state.emergencyOff,
      speechFailureNotSpokenAsSuccess: true,
      recognitionStopped: state.expired || state.tornDown || state.emergencyOff,
      speechStopped: state.expired || state.tornDown || state.emergencyOff || state.speechFailed,
      micReleased: state.tornDown || state.emergencyOff || !state.micStarted,
      timersCleared: state.tornDown,
      sharedConversationId: true,
    })),
    inspectNavigationAudit: markStub(async () => ({
      serverIssuedUiIntent: !!state.pendingIntent,
      intentType: state.pendingIntent?.type || null,
      singleConfirmationQuestion: true,
      confirmationCount: state.confirmationCount,
      noSecondConfirmationPrompt: state.confirmationCount <= 1,
      confirmedExactIntentId: state.confirmationCount === 1,
      navigationReadOnly: true,
      clientCategoriesGrantNoNavAuthority: true,
      businessDataMutated: false,
      clientDestinationRejected: true,
      navigationPerformed: state.navigations.length > 0 && !state.expired && state.confirmationCount > 0,
      duplicateConfirmNoOp: true,
      staleConfirmNoOp: true,
      expiredConfirmNoOp: true,
      mismatchedConfirmNoOp: true,
      authExpiredConfirmNoOp: true,
      pendingNavigationCleared: state.tornDown || state.expired,
      pendingIntentsCleared: state.tornDown || state.expired,
    })),
    expireSession: markStub(async () => {
      state.expired = true;
      state.authenticated = false;
      state.listening = false;
      state.speaking = false;
      state.micStarted = false;
      state.pendingIntent = null;
      return { expired: true };
    }),
    teardown: markStub(async () => {
      state.tornDown = true;
      state.micStarted = false;
      state.listening = false;
      state.speaking = false;
      state.voiceEnabled = false;
      state.pendingIntent = null;
      return { tornDown: true };
    }),
  };
  return hooks;
}

export async function loadArmedBrowserHooks(env = process.env) {
  if (!isBrowserCertificationArmed(env)) return null;
  const mod = await import(env.REINA_BROWSER_CANDIDATE_MODULE);
  const factory = mod.createReinaBrowserCandidateHooks || mod.default;
  if (typeof factory !== 'function') {
    throw new Error('BROWSER_CALLBACK_MISSING: export createReinaBrowserCandidateHooks()');
  }
  const hooks = await factory();
  assertBrowserHooks(hooks);
  for (const name of BROWSER_HOOKS) {
    if (hooks[name]?.isReferenceStub === true) {
      throw new Error(`PRODUCTION_CERT_FORBIDDEN: hook ${name} is reference stub`);
    }
  }
  return hooks;
}

export function describeBrowserInjection() {
  return {
    env: 'REINA_BROWSER_CANDIDATE_MODULE',
    export: 'createReinaBrowserCandidateHooks',
    hooks: BROWSER_HOOKS.slice(),
    note: 'Known-good/reference hard-pass is NOT production certification. Dormant without env module.',
  };
}
