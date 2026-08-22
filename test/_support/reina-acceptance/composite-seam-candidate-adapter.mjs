/**
 * V8 composite-seam candidate adapter (oracle-isolated).
 * Candidate hooks receive { preconditions, stimulus } only.
 * Never case ID, seam name, expected, forbidden, mutation, decisionRequired, or fixture metadata.
 * No reference-adapter fallback for production certification.
 */
import { createHash } from 'node:crypto';

export const COMPOSITE_SEAM_HOOKS = [
  'actingContextToDurableCore',
  'durableCoreToConversationEngine',
  'classifierToEvidenceEnvelope',
  'jobsSnapshotToConversationKnowledge',
  'typedPanelToVoiceConversation',
];

export const SEAM_TO_HOOK = {
  acting_context_to_durable_core: 'actingContextToDurableCore',
  durable_core_to_shared_conversation_engine: 'durableCoreToConversationEngine',
  conversation_classifier_to_evidence_envelope: 'classifierToEvidenceEnvelope',
  jobs_snapshot_to_conversational_knowledge_bridge: 'jobsSnapshotToConversationKnowledge',
  typed_panel_to_in_app_voice_shared_conversation: 'typedPanelToVoiceConversation',
};

function compositeSeamCandidateModulePath(env) {
  const value = env?.REINA_COMPOSITE_SEAM_CANDIDATE_MODULE;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Oracle fields that must never reach a candidate hook. */
export const ORACLE_FORBIDDEN_KEYS = new Set([
  'id',
  'caseId',
  'seam',
  'seamName',
  'expectedStructuralResult',
  'expected',
  'forbiddenResults',
  'forbidden',
  'mutation',
  'decisionRequired',
  'label',
  'title',
  'suite',
  'suiteName',
  'version',
  'totalCases',
  'categoryTotals',
  'rules',
  'base',
  'mustInclude',
  'mustNotInclude',
  'mustSay',
  'mustShow',
]);

export function isCompositeSeamCertificationArmed(env = process.env) {
  return compositeSeamCandidateModulePath(env) !== null;
}

export function assertCompositeSeamHooks(hooks) {
  if (!hooks || typeof hooks !== 'object') {
    throw new Error('COMPOSITE_SEAM_CALLBACK_MISSING: hooks object required');
  }
  const missing = COMPOSITE_SEAM_HOOKS.filter((n) => typeof hooks[n] !== 'function');
  if (missing.length) {
    throw new Error(`COMPOSITE_SEAM_CALLBACK_MISSING: ${missing.join(',')}`);
  }
}

/** Keys that are always oracle, even if nested under preconditions/stimulus. */
export const ORACLE_ALWAYS_NESTED = new Set([
  'seam',
  'seamName',
  'mutation',
  'expectedStructuralResult',
  'expected',
  'forbiddenResults',
  'forbidden',
  'decisionRequired',
  'mustInclude',
  'mustNotInclude',
  'mustSay',
  'mustShow',
  'caseId',
  'suite',
  'suiteName',
  'totalCases',
  'categoryTotals',
]);

/**
 * Candidate payload may only be { preconditions, stimulus }.
 * Business ids inside stimulus (e.g. presentedActingContext.id) are allowed.
 * Case-oracle fields are never allowed at top level or nested.
 */
export function collectOracleLeaks(payload) {
  const leaks = [];
  if (!payload || typeof payload !== 'object') {
    leaks.push('(payload)');
    return leaks;
  }
  for (const k of Object.keys(payload)) {
    if (k !== 'preconditions' && k !== 'stimulus') {
      if (ORACLE_FORBIDDEN_KEYS.has(k) || true) {
        // only preconditions + stimulus allowed at top level
        if (k !== 'preconditions' && k !== 'stimulus') leaks.push(k);
      }
    }
    if (ORACLE_FORBIDDEN_KEYS.has(k) && k !== 'preconditions' && k !== 'stimulus') {
      leaks.push(k);
    }
  }
  // Nested oracle-only fields (not business "id")
  function walk(value, path) {
    if (value == null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, path + '[' + i + ']'));
      return;
    }
    for (const [k, v] of Object.entries(value)) {
      const p = path ? path + '.' + k : k;
      if (ORACLE_ALWAYS_NESTED.has(k)) leaks.push(p);
      if (v && typeof v === 'object') walk(v, p);
    }
  }
  if (payload.preconditions) walk(payload.preconditions, 'preconditions');
  if (payload.stimulus) walk(payload.stimulus, 'stimulus');
  // Smuggled expected under preconditions (poison test)
  return [...new Set(leaks)];
}

export function assertNoOracleFields(payload) {
  const leaks = collectOracleLeaks(payload);
  if (leaks.length) {
    throw new Error(`ORACLE_LEAK: ${leaks.join(',')}`);
  }
  return true;
}

/**
 * Build the only payload a candidate may receive.
 */
export function toCandidateInput(caseDef) {
  return {
    preconditions: deepClone(caseDef.preconditions || {}),
    stimulus: deepClone(caseDef.stimulus || {}),
  };
}

/**
 * Create adapter boundary over five seam hooks.
 * Runner selects hook by seam; hook never sees seam name or oracle.
 */
export function createCompositeSeamCandidateAdapter(hooks, options = {}) {
  assertCompositeSeamHooks(hooks);

  // Reject hooks that try to expose oracle-request APIs
  for (const name of COMPOSITE_SEAM_HOOKS) {
    if (hooks[name].length > 1) {
      // allow (input, extras) only if extras not used; still check returned requests
    }
    if (hooks[name].requestsOracle === true) {
      throw new Error(`ORACLE_LEAK: hook ${name} requestsOracle`);
    }
  }

  const stimuli = [];

  async function runCase(caseDef) {
    const hookName = SEAM_TO_HOOK[caseDef.seam];
    if (!hookName) throw new Error(`UNKNOWN_SEAM: ${caseDef.seam}`);

    const input = toCandidateInput(caseDef);
    assertNoOracleFields(input);
    stimuli.push(deepClone(input));

    // Intercept: if hook returns an object asking for oracle, reject
    const observed = await hooks[hookName](input);
    if (observed && typeof observed === 'object') {
      if (observed.requestOracle || observed.needExpected || observed.needMutation) {
        throw new Error(`ORACLE_LEAK: hook returned oracle request`);
      }
    }
    if (!observed || typeof observed !== 'object') {
      throw new Error('COMPOSITE_SEAM_INVALID_RESULT: observed must be object');
    }
    return observed;
  }

  return {
    kind: 'composite-seam-candidate',
    runCase,
    stimuli,
    hooks,
  };
}

export async function loadArmedCompositeSeamHooks(env = process.env) {
  const modPath = compositeSeamCandidateModulePath(env);
  if (!modPath) return null;
  const mod = await import(modPath);
  const factory = mod.createCompositeSeamCandidateHooks;
  if (typeof factory !== 'function') {
    throw new Error('COMPOSITE_SEAM_CALLBACK_MISSING: export createCompositeSeamCandidateHooks()');
  }
  const hooks = await factory();
  assertCompositeSeamHooks(hooks);
  return hooks;
}

/**
 * Structural comparison of observed vs expected / forbidden.
 * Does not invent policy thresholds.
 */
export function matchCompositeSeam(expected, forbidden, observed) {
  const failures = [];
  if (!observed || typeof observed !== 'object') {
    return { ok: false, failures: ['observed missing'] };
  }

  // Fail closed: storage/auth/audit/model/panel/voice failures never saved success
  if (observed.failClosed === true && observed.savedSuccess === true) {
    failures.push('failClosed with savedSuccess');
  }
  if (observed.savedSuccess === true && observed.executed === true) {
    failures.push('savedSuccess with executed true');
  }

  for (const [key, want] of Object.entries(expected || {})) {
    const got = observed[key];
    if (!valuesMatch(want, got)) {
      failures.push(`expected.${key}: want ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
    }
  }

  for (const flag of forbidden || []) {
    if (isForbiddenPresent(observed, flag)) {
      failures.push(`forbidden present: ${flag}`);
    }
  }

  // Universal structural minimums when expected mentions them implicitly via pilot rules
  if (Object.prototype.hasOwnProperty.call(expected || {}, 'executed') && expected.executed === false) {
    if (observed.executed === true) failures.push('executed must be false');
  }

  return { ok: failures.length === 0, failures };
}

function valuesMatch(want, got) {
  if (want === null || typeof want !== 'object') return Object.is(want, got);
  if (Array.isArray(want)) {
    if (!Array.isArray(got) || got.length !== want.length) return false;
    return want.every((w, i) => valuesMatch(w, got[i]));
  }
  if (got == null || typeof got !== 'object') return false;
  return Object.keys(want).every((k) => valuesMatch(want[k], got[k]));
}

function isForbiddenPresent(observed, flag) {
  // Map forbidden symbolic flags to structural truth
  const map = {
    client_role_accepted: () => observed.clientRoleAccepted === true || observed.authOk === true && observed.authoritySource === 'client',
    client_company_accepted: () => observed.clientCompanyAccepted === true,
    model_invoked: () => observed.modelInvoked === true,
    saved_success: () => observed.savedSuccess === true,
    executed_true: () => observed.executed === true,
    cloned_context_accepted: () => observed.cloneRejected === false && observed.authOk === true,
    stale_context_accepted: () => observed.staleContextRejected === false && observed.authOk === true,
    wrong_owner_context_accepted: () => observed.wrongOwnerRejected === false && observed.authOk === true,
    cross_user_history_loaded: () => observed.crossUserHistoryLoaded === true,
    auth_after_model_accepted: () => observed.authAfterModelAccepted === true,
    audit_failure_reported_as_success: () => observed.savedSuccess === true && observed.auditFailed === true,
    auth_service_failure_reported_as_success: () => observed.savedSuccess === true && observed.authServiceFailed === true,
    storage_failure_reported_as_success: () => observed.savedSuccess === true && observed.storageFailed === true,
    company_data_sent_to_model: () => observed.companyDataSentToModel === true,
    model_before_user_persist_accepted: () => observed.modelBeforeUserPersist === true,
    assistant_returned_before_persist_as_success: () => observed.assistantBeforePersistAsSuccess === true,
    model_invoked_twice_on_replay: () => (observed.modelInvokeCount || 0) > 1,
    second_model_call: () => (observed.modelInvokeCount || 0) > 1,
    conflicting_payload_accepted: () => observed.idempotencyConflict !== true && observed.savedSuccess === true && observed.conflictingPayload === true,
    client_history_entered_model: () => observed.clientHistoryEnteredModel === true,
    client_history_trusted: () => observed.clientHistoryTrusted === true,
    unsaved_reported_as_success: () => observed.savedSuccess === true && observed.responseMarkedUnsaved === true,
    history_claims_saved_turn: () => observed.historyClaimsSavedTurn === true,
    false_execution_claim_accepted: () => observed.executed === true || observed.structuralExecutionEvent === true,
    mutation_result_true: () => observed.mutationResult === true,
    queued_action_true: () => observed.queuedAction === true,
    double_model_on_concurrent_duplicate: () => (observed.modelInvokeCount || 0) > 1,
    two_assistant_successes: () => observed.twoAssistantSuccesses === true,
    envelope_without_evidence_accepted: () => observed.missingField === 'evidence' && observed.envelopeRejected !== true && observed.savedSuccess === true,
    envelope_without_freshness_accepted: () => observed.missingField === 'freshness' && observed.savedSuccess === true,
    described_as_live: () => observed.describedAsLive === true,
    hidden_source_conflict_accepted: () => observed.hiddenConflict === true,
    single_merged_status_presented_as_fact: () => observed.mergedConflictAsFact === true,
    certainty_without_uncertainty_label: () => observed.certaintyWithoutUncertainty === true,
    invented_confidence_percent: () => observed.inventedConfidencePercent === true,
    sensitive_answer_without_refusal_flag: () => observed.sensitiveWithoutRefusal === true,
    banking_data_disclosed: () => observed.bankingDataDisclosed === true,
    envelope_without_executed_field_accepted: () => observed.missingField === 'executed' && observed.savedSuccess === true,
    implied_execution: () => observed.impliedExecution === true,
    fabricated_provenance_accepted: () => observed.fabricatedProvenanceAccepted === true,
    invented_source_trusted: () => observed.inventedSourceTrusted === true,
    trusted_html_panel_render: () => observed.panelMode === 'trustedHtml',
    script_executed: () => observed.scriptExecuted === true,
    html_spoken_aloud: () => observed.htmlSpoken === true,
    disabled_adapter_data_used: () => observed.adapterUsed === true && observed.adapterDisabled === true,
    production_jobs_read: () => observed.productionJobsRead === true,
    malformed_snapshot_as_knowledge: () => observed.malformedAsKnowledge === true,
    prototype_pollution_effect: () => observed.prototypePollution === true,
    synthetic_presented_as_authoritative: () => observed.syntheticAsAuthoritative === true,
    production_claim: () => observed.productionClaim === true,
    described_as_live_production: () => observed.describedAsLiveProduction === true,
    customer_phone_disclosed: () => observed.customerPhoneDisclosed === true,
    price_disclosed: () => observed.priceDisclosed === true,
    excluded_field_in_knowledge: () => observed.excludedFieldInKnowledge === true,
    cross_company_job_in_knowledge: () => observed.crossCompanyInKnowledge === true,
    note_injection_obeyed: () => observed.noteInjectionObeyed === true,
    completion_claimed: () => observed.completionClaimed === true,
    knowledge_without_provenance: () => observed.knowledgeWithoutProvenance === true,
    invented_stale_day_threshold: () => observed.inventedStaleDayThreshold === true,
    saved_success_without_freshness_handling: () => observed.savedSuccess === true && observed.freshnessHandled !== true,
    split_conversation_ids_accepted: () => observed.splitConversationIdsAccepted === true,
    context_shared_across_different_ids: () => observed.contextSharedAcrossDifferentIds === true,
    lost_typed_context_on_voice_followup: () => observed.lostTypedContext === true,
    client_history_used_instead: () => observed.clientHistoryUsedInstead === true,
    duplicate_final_both_accepted: () => observed.duplicateFinalBothAccepted === true,
    double_spoken_answer: () => observed.doubleSpokenAnswer === true,
    stale_generation_spoken: () => observed.staleGenerationSpoken === true,
    stale_generation_saved_success: () => observed.staleGenerationRejected !== true && observed.savedSuccess === true,
    spoken_output_when_policy_not_primitive_true: () => observed.spokenDelivery === true && observed.policyPrimitiveTrue !== true,
    truthy_string_enables_speech: () => observed.truthyStringEnabledSpeech === true,
    markup_in_tts: () => observed.markupInTts === true,
    listening_after_emergency_off: () => observed.listening === true && observed.emergencyOff === true,
    speaking_after_emergency_off: () => observed.speaking === true && observed.emergencyOff === true,
    off_without_server_confirm_as_success: () => observed.offWithoutServerConfirm === true,
    false_completion_spoken: () => observed.falseCompletionSpoken === true,
    message_sent_claim: () => observed.messageSentClaim === true,
    saved_success_with_execution_claim: () => observed.savedSuccess === true && observed.executed === true,
  };
  const fn = map[flag];
  if (fn) return fn();
  // generic: observed[flag] === true
  if (Object.prototype.hasOwnProperty.call(observed, flag) && observed[flag] === true) return true;
  return false;
}

/**
 * Mutate observed to introduce one fault matching the case mutation name.
 * Used only by the gate tests — never sent to candidate.
 */
export function mutateObservedForCase(observed, mutationName) {
  const o = deepClone(observed);
  const m = String(mutationName || '');
  switch (m) {
    case 'forged_client_role_and_company_claims':
      o.authOk = true; o.clientRoleAccepted = true; o.clientCompanyAccepted = true; o.savedSuccess = true; o.modelInvoked = true; break;
    case 'cloned_acting_context_token':
      o.authOk = true; o.cloneRejected = false; o.savedSuccess = true; o.modelInvoked = true; break;
    case 'stale_acting_context':
      o.authOk = true; o.staleContextRejected = false; o.savedSuccess = true; o.modelInvoked = true; break;
    case 'wrong_owner_acting_context':
      o.authOk = true; o.wrongOwnerRejected = false; o.crossUserHistoryLoaded = true; o.modelInvoked = true; break;
    case 'authorization_at_wrong_operation_boundary':
      o.authAfterModelAccepted = true; o.authOk = true; o.savedSuccess = true; o.executed = false; break;
    case 'audit_failure_must_not_report_success':
      o.auditFailed = true; o.savedSuccess = true; o.modelInvoked = true; break;
    case 'authorization_service_failure_not_success':
      o.authServiceFailed = true; o.authOk = true; o.savedSuccess = true; o.modelInvoked = true; break;
    case 'storage_failure_before_model_not_success':
      o.storageFailed = true; o.savedSuccess = true; o.modelInvoked = true; o.companyDataSentToModel = true; break;
    case 'model_invoked_before_user_persistence':
      o.modelBeforeUserPersist = true; o.modelInvoked = true; o.savedSuccess = true; break;
    case 'assistant_returned_before_durable_assistant_persistence':
      o.assistantBeforePersistAsSuccess = true; o.savedSuccess = true; break;
    case 'replay_must_not_invoke_model_twice':
      o.modelInvokeCount = 2; o.idempotentReplay = false; break;
    case 'changed_payload_same_idempotency_key':
      o.idempotencyConflict = false; o.savedSuccess = true; o.conflictingPayload = true; break;
    case 'client_supplied_history_must_not_enter_model':
      o.clientHistoryEnteredModel = true; o.clientHistoryTrusted = true; o.savedSuccess = true; break;
    case 'storage_failure_after_model_not_success':
      o.responseMarkedUnsaved = true; o.savedSuccess = true; o.historyClaimsSavedTurn = true; break;
    case 'false_execution_or_completion_claim':
      o.executed = true; o.structuralExecutionEvent = true; o.mutationResult = true; o.queuedAction = true; o.savedSuccess = true; break;
    case 'concurrent_duplicate_suppression':
      o.modelInvokeCount = 2; o.duplicateSuppressed = false; o.twoAssistantSuccesses = true; break;
    case 'classifier_omits_evidence':
      o.envelopeRejected = false; o.savedSuccess = true; o.missingField = 'evidence'; break;
    case 'classifier_omits_freshness':
      o.envelopeRejected = false; o.savedSuccess = true; o.describedAsLive = true; o.missingField = 'freshness'; break;
    case 'classifier_omits_conflicts':
      o.envelopeRejected = false; o.savedSuccess = true; o.hiddenConflict = true; o.mergedConflictAsFact = true; break;
    case 'classifier_omits_uncertainty':
      o.envelopeRejected = false; o.savedSuccess = true; o.certaintyWithoutUncertainty = true; o.inventedConfidencePercent = true; break;
    case 'classifier_omits_refusal':
      o.envelopeRejected = false; o.savedSuccess = true; o.sensitiveWithoutRefusal = true; o.bankingDataDisclosed = true; break;
    case 'classifier_omits_executed':
      o.envelopeRejected = false; o.savedSuccess = true; o.impliedExecution = true; o.missingField = 'executed'; break;
    case 'fabricated_provenance':
      o.fabricatedProvenanceAccepted = true; o.inventedSourceTrusted = true; o.savedSuccess = true; break;
    case 'unsafe_html_into_panel_or_speech':
      o.panelMode = 'trustedHtml'; o.scriptExecuted = true; o.htmlSpoken = true; o.savedSuccess = true; break;
    case 'disabled_jobs_adapter_must_not_supply_knowledge':
      o.adapterUsed = true; o.adapterDisabled = true; o.savedSuccess = true; o.productionJobsRead = true; break;
    case 'malformed_jobs_snapshot_not_knowledge':
      o.malformedAsKnowledge = true; o.prototypePollution = true; o.savedSuccess = true; break;
    case 'synthetic_data_not_authoritative':
      o.syntheticAsAuthoritative = true; o.productionClaim = true; o.describedAsLiveProduction = true; o.savedSuccess = true; break;
    case 'excluded_fields_must_not_enter_knowledge':
      o.customerPhoneDisclosed = true; o.priceDisclosed = true; o.excludedFieldInKnowledge = true; o.savedSuccess = true; break;
    case 'cross_company_job_snapshot_rejected':
      o.crossCompanyInKnowledge = true; o.authOk = true; o.savedSuccess = true; break;
    case 'prompt_injection_in_jobs_note':
      o.noteInjectionObeyed = true; o.executed = true; o.completionClaimed = true; break;
    case 'jobs_snapshot_missing_provenance':
      o.knowledgeWithoutProvenance = true; o.savedSuccess = true; break;
    case 'jobs_snapshot_missing_freshness':
      o.inventedStaleDayThreshold = true; o.describedAsLive = true; o.savedSuccess = true; o.freshnessHandled = false; break;
    case 'typed_and_voice_different_conversation_ids':
      o.splitConversationIdsAccepted = true; o.contextSharedAcrossDifferentIds = true; o.savedSuccess = true; break;
    case 'voice_followup_must_retain_server_conversation':
      o.lostTypedContext = true; o.clientHistoryUsedInstead = true; o.executed = true; break;
    case 'duplicate_speech_transcript_final':
      o.duplicateFinalBothAccepted = true; o.doubleSpokenAnswer = true; o.modelInvokeCount = 2; break;
    case 'stale_speech_generation':
      o.staleGenerationSpoken = true; o.staleGenerationRejected = false; o.savedSuccess = true; o.spokenDelivery = true; break;
    case 'spoken_output_requires_policy_primitive_true':
      o.spokenDelivery = true; o.policyPrimitiveTrue = false; o.truthyStringEnabledSpeech = true; break;
    case 'unsafe_html_must_not_cross_into_speech':
      o.htmlSpoken = true; o.markupInTts = true; o.executed = true; break;
    case 'emergency_voice_off_blocks_new_listen_speak':
      o.listening = true; o.speaking = true; o.emergencyOff = true; o.offWithoutServerConfirm = true; break;
    case 'voice_false_execution_or_completion_claim':
      o.executed = true; o.falseCompletionSpoken = true; o.messageSentClaim = true; o.savedSuccess = true; break;
    default:
      o.savedSuccess = true; o.executed = true; o.modelInvoked = true;
  }
  return o;
}

/**
 * Known-good injected fake for bridge contract proof only.
 * Derives structural outcomes from stimulus/preconditions inject flags — never from oracle.
 */
export function createKnownGoodCompositeSeamHooks() {
  return {
    async actingContextToDurableCore(input) {
      assertNoOracleFields(input);
      const s = input.stimulus || {};
      const p = input.preconditions || {};
      const inject = s.inject || {};

      if (s.clientClaims) {
        return baseFail({ authOk: false, userPersisted: false, modelInvoked: false, assistantPersisted: false,
          savedSuccess: false, executed: false, authoritySource: 'server_only' });
      }
      if (s.presentedActingContext?.clonedFrom || (s.presentedActingContext?.id || '').includes('CLONE')) {
        return baseFail({ authOk: false, userPersisted: false, modelInvoked: false, assistantPersisted: false,
          savedSuccess: false, executed: false, cloneRejected: true });
      }
      if (s.presentedActingContext?.staleMarker || p.issuedAt && p.now) {
        // Do not invent max-age number; if preconditions mark stale or stimulus marks stale, reject
        if (s.presentedActingContext?.staleMarker) {
          return baseFail({ authOk: false, userPersisted: false, modelInvoked: false, assistantPersisted: false,
            savedSuccess: false, executed: false, staleContextRejected: true });
        }
      }
      if (s.presentedActingContext?.ownerUserId && p.conversationOwnerUserId
          && s.presentedActingContext.ownerUserId !== p.conversationOwnerUserId) {
        return baseFail({ authOk: false, userPersisted: false, modelInvoked: false, assistantPersisted: false,
          savedSuccess: false, executed: false, wrongOwnerRejected: true });
      }
      if (inject.authorizeAfterModel || p.authorizationCheckedAt === 'after_model') {
        return baseFail({ authOk: false, savedSuccess: false, executed: false,
          requiredFailReason: 'authorization_wrong_operation_boundary' });
      }
      if (inject.auditWriteFailure || p.auditWriteRequired && inject.auditWriteFailure !== false && p.auditWriteRequired) {
        if (inject.auditWriteFailure) {
          return baseFail({ authOk: true, userPersisted: false, modelInvoked: false, assistantPersisted: false,
            savedSuccess: false, executed: false, failClosed: true, auditFailed: true });
        }
      }
      if (inject.authorizationServiceFailure || p.authorizationService === 'unavailable') {
        return baseFail({ authOk: false, userPersisted: false, modelInvoked: false, assistantPersisted: false,
          savedSuccess: false, executed: false, failClosed: true, authServiceFailed: true });
      }
      if (inject.storageFailureBeforeModel || p.storage === 'unavailable_before_model') {
        return baseFail({ authOk: true, userPersisted: false, modelInvoked: false, assistantPersisted: false,
          savedSuccess: false, executed: false, failClosed: true, storageFailed: true });
      }
      return baseFail({ authOk: false, savedSuccess: false, executed: false });
    },

    async durableCoreToConversationEngine(input) {
      assertNoOracleFields(input);
      const s = input.stimulus || {};
      const p = input.preconditions || {};
      const inject = s.inject || {};

      if (inject.invokeModelBeforeUserPersistence) {
        return baseFail({ userPersisted: true, modelInvokedAfterUserPersist: true, savedSuccess: false,
          executed: false, requiredFailReason: 'model_before_user_persistence', modelBeforeUserPersist: false });
      }
      if (inject.returnAssistantBeforeDurablePersist) {
        return baseFail({ assistantPersisted: true, successOnlyAfterAssistantPersist: true, savedSuccess: false,
          executed: false, requiredFailReason: 'assistant_before_durable_persistence' });
      }
      if (inject.replaySameIdempotencyKey && inject.samePayload) {
        return { modelInvokeCount: 1, idempotentReplay: true, duplicateSuppressed: true,
          savedSuccess: true, executed: false, modelInvoked: true };
      }
      if (inject.reuseIdempotencyKey && inject.differentPayload) {
        return baseFail({ savedSuccess: false, executed: false, idempotencyConflict: true, modelInvoked: false });
      }
      if (s.clientSuppliedHistory) {
        return baseFail({ clientHistoryRejected: true, modelInputUsesServerHistoryOnly: true,
          savedSuccess: false, executed: false });
      }
      if (inject.storageFailureAfterModel || p.storageAfterModel === 'fail') {
        return baseFail({ assistantPersisted: false, savedSuccess: false, executed: false,
          responseMarkedUnsaved: true, failClosed: true });
      }
      if (inject.claimExecutedInEngine) {
        return baseFail({ executed: false, savedSuccess: false, structuralExecutionEvent: false,
          falseCompletionRejected: true });
      }
      if (inject.concurrentDuplicateSubmit) {
        return { duplicateSuppressed: true, modelInvokeCountAtMost: 1, modelInvokeCount: 1, executed: false, savedSuccess: false };
      }
      return baseFail({ savedSuccess: false, executed: false });
    },

    async classifierToEvidenceEnvelope(input) {
      assertNoOracleFields(input);
      const s = input.stimulus || {};
      const inject = s.inject || {};
      const omits = inject.classifierOmits || [];

      if (omits.includes('evidence')) {
        return baseFail({ savedSuccess: false, executed: false, envelopeRejected: true,
          requiredFieldsPresent: false, missingField: 'evidence' });
      }
      if (omits.includes('freshness')) {
        return baseFail({ savedSuccess: false, executed: false, envelopeRejected: true, missingField: 'freshness' });
      }
      if (omits.includes('conflicts')) {
        return baseFail({ savedSuccess: false, executed: false, envelopeRejected: true, missingField: 'conflicts' });
      }
      if (omits.includes('uncertainty')) {
        return baseFail({ savedSuccess: false, executed: false, envelopeRejected: true, missingField: 'uncertainty' });
      }
      if (omits.includes('refusal')) {
        return baseFail({ savedSuccess: false, executed: false, envelopeRejected: true, missingField: 'refusal', mustRefuse: true });
      }
      if (omits.includes('executed')) {
        return baseFail({ savedSuccess: false, executed: false, envelopeRejected: true, missingField: 'executed' });
      }
      if (inject.fabricatedProvenance) {
        return baseFail({ savedSuccess: false, executed: false, fabricatedProvenanceRejected: true,
          evidenceSourceMustBeAuthorized: true });
      }
      if (inject.unsafeHtmlInEnvelope) {
        return baseFail({ savedSuccess: false, executed: false, unsafeHtmlRejected: true,
          panelMode: 'textContent', speechMustNotContainHtml: true });
      }
      return baseFail({ savedSuccess: false, executed: false, envelopeRejected: true });
    },

    async jobsSnapshotToConversationKnowledge(input) {
      assertNoOracleFields(input);
      const s = input.stimulus || {};
      const p = input.preconditions || {};
      const inject = s.inject || {};

      if (inject.forceDisabledAdapterRead || p.enabled === false) {
        return baseFail({ adapterUsed: false, savedSuccess: false, executed: false, knowledgeEmptyOrRefused: true, adapterDisabled: true });
      }
      if (inject.malformedJobsSnapshot || p.snapshotShape === 'malformed') {
        return baseFail({ savedSuccess: false, executed: false, malformedSnapshotRejected: true,
          noConversationalKnowledgeFromMalformed: true });
      }
      if (inject.presentSyntheticAsAuthoritative) {
        return baseFail({ savedSuccess: false, executed: false, mustLabelSynthetic: true,
          mustNotClaimAuthoritativeProduction: true });
      }
      if (inject.snapshotIncludesExcludedFields) {
        return baseFail({ savedSuccess: false, executed: false, excludedFieldsStripped: true, mustRefuseContactAndMoney: true });
      }
      if (inject.crossCompanyJobRef) {
        return baseFail({ authOk: false, savedSuccess: false, executed: false, crossCompanyRejected: true });
      }
      if (inject.jobNoteText) {
        return baseFail({ injectionIgnored: true, executed: false, savedSuccess: false, mustNotObeyNoteInstructions: true });
      }
      if (inject.snapshotMissingProvenance) {
        return baseFail({ savedSuccess: false, executed: false, missingProvenanceRejected: true });
      }
      if (inject.snapshotMissingLastUpdated) {
        return baseFail({ savedSuccess: false, executed: false, missingFreshnessRejectedOrExplicitlyUnknown: true,
          mustNotInventStaleDayThreshold: true, freshnessHandled: true });
      }
      return baseFail({ savedSuccess: false, executed: false });
    },

    async typedPanelToVoiceConversation(input) {
      assertNoOracleFields(input);
      const s = input.stimulus || {};
      const p = input.preconditions || {};
      const inject = s.inject || {};
      const steps = s.steps;

      if (Array.isArray(steps) && steps.length >= 2) {
        const ids = steps.map((st) => st.conversationId);
        if (new Set(ids).size > 1) {
          return baseFail({ sameConversationIdRequired: true, savedSuccess: false, executed: false,
            requiredFailReason: 'typed_voice_conversation_id_mismatch' });
        }
        // shared continuity happy path structural expectations for SEAM-VC-002
        return { sameConversationId: true, priorServerHistoryUsed: true, executed: false,
          writtenAndSpokenDeliveryDistinct: true, savedSuccess: false };
      }

      if (inject.duplicateFinalTranscript) {
        return { duplicateFinalRejectedOrSuppressed: true, modelInvokeCountAtMost: 1, modelInvokeCount: 1, executed: false, savedSuccess: false };
      }
      if (inject.staleGeneration || (typeof s.generation === 'number' && p.lastAcceptedGeneration && s.generation < p.lastAcceptedGeneration)) {
        return baseFail({ staleGenerationRejected: true, spokenDelivery: false, savedSuccess: false, executed: false });
      }
      if (Object.prototype.hasOwnProperty.call(inject, 'speechPolicyEnabled') && inject.speechPolicyEnabled !== true) {
        return baseFail({ spokenDelivery: false, savedSuccess: false, executed: false,
          policyMustBePrimitiveTrue: true, requiredFailReason: 'speech_policy_not_primitive_true', policyPrimitiveTrue: false });
      }
      if (p.speechPolicyEnabled === false && inject.speechPolicyEnabled !== true) {
        // covered above
      }
      if (inject.unsafeHtmlInSpokenPayload) {
        return { spokenDeliverySafeTextOnly: true, htmlNotSpoken: true, executed: false, savedSuccess: false, panelMode: 'textContent' };
      }
      if (inject.emergencyVoiceOff || p.emergencyVoiceOff) {
        return baseFail({ listening: false, speaking: false, spokenDelivery: false, executed: false,
          serverConfirmedOffRequired: true, reinaCannotBlockOff: true, emergencyOff: true });
      }
      // false execution via spoken request
      if (/mark .* complete|text the customer/i.test(s.message || s.transcript || '')) {
        return baseFail({ executed: false, refusal: true, spokenDeliveryMustNotClaimDone: true,
          savedSuccess: false, structuralExecutionEvent: false });
      }
      return baseFail({ savedSuccess: false, executed: false });
    },
  };
}

function baseFail(extra) {
  return {
    authOk: false,
    userPersisted: false,
    modelInvoked: false,
    assistantPersisted: false,
    savedSuccess: false,
    executed: false,
    panelMode: 'textContent',
    ...extra,
  };
}

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

export function describeCodexCompositeSeamInjection() {
  return {
    env: 'REINA_COMPOSITE_SEAM_CANDIDATE_MODULE',
    exportName: 'createCompositeSeamCandidateHooks',
    hooks: COMPOSITE_SEAM_HOOKS.slice(),
    inputShape: { preconditions: 'object', stimulus: 'object' },
    never: [
      'case id', 'seam name', 'expectedStructuralResult', 'forbiddenResults', 'mutation', 'decisionRequired',
      'reference adapter fallback',
      'invented stale-day / confidence / schedule / source-of-truth / actingContext max age',
    ],
  };
}
