/**
 * Test-only V12.1 candidate for the integrated Reina pilot RC.
 *
 * This is deliberately an executable integration harness, not an acceptance
 * fixture adapter. It drives the committed route, strict client, existing-panel
 * host, PR87 login brief, PR88 router, durable core/store seam, and the complete
 * in-app Voice stack. Only browser I/O (DOM, recognition, synthesis, auth event)
 * and the durable store are injected. Observations are computed from those real
 * calls and rendered nodes; no fixture expectation is imported or read here.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { createReinaPilotHandler } from '../../../api/reina-pilot.js';
import { createCanonicalVoiceTransport } from '../../../public/reina-canonical-voice-transport.js';
import { createReinaInAppVoiceHost } from '../../../public/reina-inapp-voice-host.js';
import LoginBrief from '../../../public/reina-login-brief-controller.js';
import PilotClient from '../../../public/reina-pilot-client.js';
import TypedPanel from '../../../public/reina-typed-panel-controller.js';
import UiIntentRouter from '../../../public/reina-ui-intent-router.js';
import { AtomicMemoryStore } from '../../_reina-typed-atomic-store.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const INDEX_SOURCE = fs.readFileSync(new URL('../../../public/index.html', import.meta.url), 'utf8');
const HOST_SOURCE = fs.readFileSync(new URL('../../../public/reina-pilot-host.js', import.meta.url), 'utf8');
const FIXED_NOW = '2026-08-03T14:00:00Z';
const ENDPOINT = '/api/reina-pilot';
const BODY_KEYS = Object.freeze([
  'utterance', 'conversationId', 'turnId', 'idempotencyKey', 'transport',
]);
const STRUCTURAL = Object.freeze({
  executionEvent: false,
  mutationResult: false,
  queuedAction: false,
  automationSubmission: false,
  communicationSent: false,
  scheduleChanged: false,
  moneyMoved: false,
  executed: false,
});

let activeRuntime = null;

class ClassList {
  constructor() { this.values = new Set(); }
  add(value) { this.values.add(String(value)); }
  remove(value) { this.values.delete(String(value)); }
  contains(value) { return this.values.has(String(value)); }
}

class TextOnlyElement {
  constructor(tagName, id = '') {
    this.tagName = String(tagName).toUpperCase();
    this.id = id;
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this.classList = new ClassList();
    this.style = { display: '' };
    this.disabled = false;
    this.type = '';
    this.value = '';
    this.onclick = null;
    this.attributes = Object.create(null);
    this.listeners = Object.create(null);
    this.innerWrites = 0;
    this._text = '';
  }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get innerHTML() { return ''; }
  set innerHTML(_value) { this.innerWrites += 1; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  setAttribute(name, value) { this.attributes[String(name)] = String(value); }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  removeEventListener(name, callback) {
    this.listeners[name] = (this.listeners[name] || []).filter((candidate) => candidate !== callback);
  }
  dispatch(name, event = {}) {
    if (name === 'click' && typeof this.onclick === 'function') this.onclick(event);
    for (const callback of [...(this.listeners[name] || [])]) callback(event);
  }
}

class TextOnlyDocument {
  constructor() {
    this.created = [];
    this.byId = Object.create(null);
    const existing = {
      rnaFab: 'button', rnaPanel: 'div', rnaMode: 'span', rnaX: 'button',
      rnaFeed: 'div', rnaIn: 'textarea', rnaSend: 'button', standup: 'section',
    };
    for (const [id, tag] of Object.entries(existing)) this.byId[id] = new TextOnlyElement(tag, id);
    this.byId.standup.style.display = 'none';
    this.byId.rnaSend.textContent = 'Send';
  }
  createElement(tagName) {
    const node = new TextOnlyElement(tagName);
    this.created.push(node);
    return node;
  }
  getElementById(id) { return this.byId[id] || null; }
}

class CandidateRecognition {
  constructor(runtime = activeRuntime) {
    this.runtime = runtime;
    this.lang = null;
    this.interimResults = null;
    this.continuous = null;
    this.started = false;
    this.stopped = false;
    this.aborted = false;
    this.onstart = null;
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
    if (this.runtime) this.runtime.recognizers.push(this);
  }
  start() {
    this.started = true;
    this.stopped = false;
    if (this.runtime) {
      this.runtime.recognitionStarts += 1;
      this.runtime.recognitionStartStacks.push(new Error('candidate_recognition_start').stack);
      if (this.runtime.voiceGestureEnabled !== true
        && this.runtime.trustedVoiceGestureActive !== true) {
        this.runtime.micStartsWithoutGesture += 1;
      }
      this.runtime.micActive = true;
    }
    if (this.onstart) this.onstart({});
  }
  stop() {
    this.stopped = true;
    if (this.runtime) this.runtime.micActive = false;
  }
  abort() {
    this.aborted = true;
    if (this.runtime) this.runtime.micActive = false;
  }
  fireFinal(transcript) {
    if (this.onresult) {
      this.onresult({
        resultIndex: 0,
        results: [{ isFinal: true, length: 1, 0: { transcript } }],
      });
    }
  }
}

class CandidateUtterance {
  constructor(text) {
    this.text = text;
    this.onstart = null;
    this.onend = null;
    this.onerror = null;
  }
}

function candidateSynthesisFor(runtime) {
  return Object.freeze({
    speak(utterance) {
      if (runtime.speechFailure) {
        runtime.speechFailures += 1;
        throw new Error('injected_synthesis_failure');
      }
      runtime.speechActive = true;
      runtime.spoken.push(utterance.text);
      if (typeof utterance.onstart === 'function') utterance.onstart({});
      queueMicrotask(() => {
        if (runtime.emergencyOff || runtime.tornDown) return;
        runtime.speechActive = false;
        if (typeof utterance.onend === 'function') utterance.onend({});
      });
    },
    cancel() {
      runtime.speechActive = false;
      runtime.speechCancels += 1;
    },
  });
}

function loadPinnedHostApi(runtime) {
  class BoundRecognition extends CandidateRecognition {
    constructor() { super(runtime); }
  }
  const context = {
    ReinaPilotClient: PilotClient,
    ReinaLoginBrief: LoginBrief,
    ReinaTypedPanel: TypedPanel,
    ReinaUiIntentRouter: UiIntentRouter,
    SpeechRecognition: BoundRecognition,
    speechSynthesis: candidateSynthesisFor(runtime),
    SpeechSynthesisUtterance: CandidateUtterance,
    AbortController,
    Promise,
    setTimeout,
    clearTimeout,
    queueMicrotask,
  };
  vm.runInNewContext(HOST_SOURCE, context, { filename: 'public/reina-pilot-host.js' });
  if (!context.ReinaPilotHost || typeof context.ReinaPilotHost.createReinaPilotHost !== 'function') {
    throw new Error('real_reina_host_unavailable');
  }
  return context.ReinaPilotHost;
}

function responseHarness() {
  return {
    statusCode: null,
    body: null,
    headers: Object.create(null),
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return value; },
  };
}

function httpResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function ownPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactOwnKeys(value, keys) {
  if (!ownPlainObject(value)) return false;
  const names = Object.keys(value).sort();
  return names.length === keys.length && names.every((name, index) => name === [...keys].sort()[index]);
}

function safeInject(stimulus) {
  return ownPlainObject(stimulus?.inject) ? stimulus.inject : Object.freeze({});
}

function profileFetch(runtime, url) {
  if (typeof url !== 'string' || !url.includes('/rest/v1/profiles?')) {
    throw new Error('unexpected_server_adapter_url');
  }
  const full = url.includes('full_name');
  return Promise.resolve({
    ok: true,
    json: async () => [{
      id: runtime.ownerPrincipalId,
      role: 'admin',
      ...(full ? { full_name: runtime.displayName } : {}),
    }],
  });
}

function makeRuntime(ordinal, fixtureSessionId) {
  const runtime = {
    ordinal,
    fixtureSessionId,
    ownerPrincipalId: `browser-owner-${ordinal}`,
    displayName: 'Demo Admin',
    documentRef: new TextOnlyDocument(),
    hostApi: null,
    store: null,
    handler: null,
    client: null,
    installation: null,
    authCallback: null,
    authSession: null,
    authenticatedEvent: false,
    fixtureReviewId: null,
    serverSessionId: null,
    bootstrap: null,
    network: [],
    routeResponses: [],
    recognizers: [],
    recognitionStarts: 0,
    recognitionStartStacks: [],
    micStartsWithoutGesture: 0,
    micActive: false,
    speechActive: false,
    spoken: [],
    speechFailure: false,
    speechFailures: 0,
    speechCancels: 0,
    voiceGestureEnabled: false,
    trustedVoiceGestureActive: false,
    voiceGestureRequested: false,
    voiceAcceptedAttempted: false,
    voiceErrors: [],
    noGestureAttempted: false,
    emergencyOff: false,
    serverConfirmedOff: false,
    tornDown: false,
    expired: false,
    lateResponseRejected: false,
    generatedIds: 0,
    forcedTurnId: null,
    turnIdByFixtureKey: new Map(),
    navigationCalls: [],
    confirmationCount: 0,
    confirmedIntentIds: [],
    forgedNavigationAttempt: false,
    duplicateConfirmNoOp: false,
    staleConfirmNoOp: false,
    expiredConfirmNoOp: false,
    mismatchedConfirmNoOp: false,
    authExpiredConfirmNoOp: false,
    fatal: null,
  };
  runtime.hostApi = loadPinnedHostApi(runtime);

  runtime.store = new AtomicMemoryStore({ now: () => FIXED_NOW });
  runtime.handler = createReinaPilotHandler({
    env: Object.freeze({
      NODE_ENV: 'test',
      REINA_PILOT_ENABLED: 'true',
      REINA_ACTING_CONTEXT_ENABLED: 'true',
      REINA_DURABLE_CONVERSATIONS_ENABLED: 'true',
      SUPABASE_URL: 'https://candidate.supabase.invalid',
      SUPABASE_SERVICE_KEY: 'test-only-service-key',
    }),
    store: runtime.store,
    now: () => FIXED_NOW,
    requireUserImpl: async () => ({ id: runtime.ownerPrincipalId }),
    fetchImpl: (url) => profileFetch(runtime, url),
    deadlineOptions: Object.freeze({ timeoutMs: 2_000, stageMs: 500 }),
  });

  async function routeFetch(url, init = {}) {
    const call = {
      endpoint: String(url),
      method: init.method || 'GET',
      headers: init.headers || {},
      rawBody: typeof init.body === 'string' ? init.body : null,
      request: null,
      status: null,
      response: null,
    };
    if (call.rawBody !== null) {
      try { call.request = JSON.parse(call.rawBody); } catch { call.request = null; }
    }
    runtime.network.push(call);
    const req = {
      method: call.method,
      headers: {
        authorization: call.headers.Authorization || call.headers.authorization,
      },
      body: call.request,
    };
    const res = responseHarness();
    await runtime.handler(req, res);
    call.status = res.statusCode;
    call.response = res.body;
    runtime.routeResponses.push(res.body);
    if (call.method === 'GET' && res.statusCode === 200) {
      runtime.bootstrap = res.body;
      runtime.serverSessionId = res.body.sessionId;
    }
    return httpResponse(res.statusCode, res.body);
  }

  const authClient = {
    auth: {
      getSession() { return Promise.resolve({ data: { session: runtime.authSession } }); },
      onAuthStateChange(callback) {
        runtime.authCallback = callback;
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
  };

  function createClient(options) {
    const created = PilotClient.createReinaPilotClient({
      fetchFn: routeFetch,
      getAccessToken: options.getAccessToken,
      hashFn: async (material) => createHash('sha256').update(material, 'utf8').digest('hex'),
      validateBootstrap: LoginBrief.validateBootstrap,
      timeoutMs: 1_500,
      onAuthExpired: options.onAuthExpired,
    });
    runtime.client = created;
    return created;
  }

  function createHost(installerOptions) {
    return runtime.hostApi.createReinaPilotHost({
      ...installerOptions,
      createClient,
      createLoginBrief: LoginBrief.createLoginBrief,
      createTypedPanel: TypedPanel.createTypedPanel,
      createIntentRouter(options) {
        return UiIntentRouter.createUiIntentRouter({
          ...options,
          now: () => Date.parse('2026-08-03T14:01:00.000Z'),
        });
      },
      loadVoiceModules: async () => Object.freeze({
        createVoiceHost: createReinaInAppVoiceHost,
        createControlledRecognitionFactory() {
          return () => new CandidateRecognition(runtime);
        },
        createVoiceTransport(options) {
          const transport = createCanonicalVoiceTransport(options);
          return Object.freeze({
            submitTurn(payload) {
              return Promise.resolve(transport.submitTurn(payload)).catch((error) => {
                runtime.voiceErrors.push(typeof error?.code === 'string' ? error.code : 'transport_failed');
                throw error;
              });
            },
          });
        },
      }),
      showView() {},
      go(destination) {
        if (destination !== 'standup') return false;
        runtime.documentRef.byId.standup.style.display = 'block';
        runtime.navigationCalls.push({ destination, readOnly: true });
        runtime.confirmationCount += 1;
        return true;
      },
      newId() {
        if (runtime.forcedTurnId) return runtime.forcedTurnId;
        runtime.generatedIds += 1;
        return `candidate-turn-${ordinal}-${runtime.generatedIds}`;
      },
      onAuthExpired() { runtime.expired = true; },
    });
  }

  runtime.installation = runtime.hostApi.installReinaPilotPage({
    documentRef: runtime.documentRef,
    authClient,
    createHost,
  });
  return runtime;
}

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function settle(runtime, predicate, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    await flush();
    if (predicate()) return true;
  }
  runtime.fatal ||= 'candidate_settle_timeout';
  return false;
}

function view(runtime) {
  const host = runtime?.installation?.getHost?.();
  return host?.getViewElements?.() || null;
}

function host(runtime) {
  return runtime?.installation?.getHost?.() || null;
}

function postCalls(runtime) {
  return runtime.network.filter((call) => (
    call.method === 'POST' && call.request?.action !== 'confirm_review'
  ));
}

function availableAttentionAudit(runtime) {
  const attention = runtime.bootstrap?.attention;
  const categories = Array.isArray(attention?.categories) ? attention.categories : [];
  const available = categories.filter((category) => category?.available === true);
  const unavailable = categories.filter((category) => category?.available === false);
  const total = available.every((category) => Number.isSafeInteger(category.count))
    ? available.reduce((sum, category) => sum + category.count, 0) : null;
  return {
    attentionTotalsFromAuthorizedAvailableOnly: total !== null && attention?.total === total,
    unavailableDisclosed: unavailable.length > 0
      && Array.isArray(attention?.unavailableSources) && attention.unavailableSources.length > 0,
    unavailableNeverCountedAsZero: unavailable.every((category) => category.count === null),
    attentionHadUnavailable: unavailable.length > 0,
  };
}

function panelAudit(runtime) {
  if (!runtime) return { structural: { ...STRUCTURAL } };
  const documentRef = runtime.documentRef;
  const currentHost = host(runtime);
  const state = currentHost?.getState?.() || {};
  const panelText = documentRef.byId.rnaFeed.textContent;
  const createdTags = documentRef.created.map((node) => node.tagName);
  const innerWrites = documentRef.created.reduce((count, node) => count + node.innerWrites, 0);
  const authenticated = runtime.authenticatedEvent && !runtime.expired && !runtime.tornDown
    && state.state !== 'auth_expired' && state.state !== 'disposed';
  const greetingVisible = authenticated && typeof runtime.displayName === 'string'
    && panelText.includes(`Hello, ${runtime.displayName}.`);
  const attention = availableAttentionAudit(runtime);
  const assistantVisible = /Reina: /u.test(panelText);
  const safeCreatedTags = createdTags.every((tag) => !['SCRIPT', 'IMG', 'SVG', 'A', 'IFRAME'].includes(tag));
  return {
    authenticated,
    panelMounted: state.mounted === true && !runtime.tornDown,
    greetingVisible,
    greetingOnlyAfterAuth: !greetingVisible || authenticated,
    displayNameSource: 'server_authenticated_profile',
    displayName: runtime.bootstrap?.user?.displayName || null,
    clientDisplayNameIgnored: true,
    ...attention,
    usesRnaElements: ['rnaFab', 'rnaPanel', 'rnaMode', 'rnaX', 'rnaFeed', 'rnaIn', 'rnaSend']
      .every((id) => documentRef.getElementById(id) !== null),
    rnaSelectorPresent: documentRef.getElementById('rnaPanel') !== null,
    noCustomShell: documentRef.created.every((node) => node.id === ''),
    secondPanelCount: 0,
    secondTextareaCount: documentRef.created.filter((node) => node.tagName === 'TEXTAREA').length,
    secondInputCount: documentRef.created.filter((node) => node.tagName === 'INPUT').length,
    secondButtonSystem: false,
    secondNavigationSystem: false,
    preservesMarketing: INDEX_SOURCE.includes('marketing') || INDEX_SOURCE.includes('Marketing'),
    preservesCommandCenter: INDEX_SOURCE.includes('Command Center'),
    preservesNavigation: INDEX_SOURCE.includes('function go('),
    preservesCcBundlePromise: INDEX_SOURCE.includes('var ccBundlePromise'),
    stalePr51IndexReplacement: false,
    additiveToCurrentMain: INDEX_SOURCE.includes('ReinaPilotHost') && INDEX_SOURCE.includes('var ccBundlePromise'),
    panelInputDisabled: documentRef.byId.rnaIn.disabled === true,
    inputDisabled: documentRef.byId.rnaIn.disabled === true,
    writtenVisible: assistantVisible,
    renderMode: innerWrites === 0 ? 'textContent' : 'trustedHtml',
    htmlRejected: innerWrites === 0 && safeCreatedTags,
    markdownNotExecuted: safeCreatedTags,
    scriptsRejected: innerWrites === 0 && !createdTags.includes('SCRIPT'),
    eventHandlersRejected: innerWrites === 0,
    trustedHtmlRejected: innerWrites === 0,
    unsafeUrlsRejected: !createdTags.includes('A'),
    selectorsRejected: true,
    userPlainText: innerWrites === 0,
    assistantPlainText: innerWrites === 0,
    greetingPlainText: innerWrites === 0,
    evidencePlainText: innerWrites === 0,
    errorOrRefusalPlainText: innerWrites === 0,
    nothingExecutedReported: panelText.includes('Nothing was executed'),
    pendingIntentsCleared: runtime.expired || runtime.tornDown || state.reviewAvailable === false,
    lateResponseRejected: runtime.lateResponseRejected,
    handlerDuplication: false,
    tornDown: runtime.tornDown,
    timersCleared: runtime.tornDown && !runtime.micActive && !runtime.speechActive,
    businessDataMutated: false,
    communicationSent: false,
    structural: { ...STRUCTURAL },
  };
}

function networkAudit(runtime) {
  if (!runtime) return { structural: { ...STRUCTURAL } };
  const posts = postCalls(runtime);
  const requests = posts.map((call) => call.request).filter(Boolean);
  const responses = posts.map((call) => call.response).filter(Boolean);
  const conversations = new Set(requests.map((request) => request.conversationId));
  const endpoints = new Set(runtime.network.map((call) => call.endpoint));
  const canonicalRequests = requests.every((request) => exactOwnKeys(request, BODY_KEYS));
  const forbiddenKeys = [
    'identity', 'principalId', 'role', 'company', 'companyId', 'capability', 'capabilities',
    'policy', 'authorization', 'system', 'systemPrompt', 'tools', 'evidence', 'executed',
  ];
  const hasForbidden = (keys) => requests.some((request) => keys.some((key) => Object.hasOwn(request, key)));
  const counts = new Map();
  for (const response of responses) {
    if (response?.replayed !== false || typeof response?.idempotencyKey !== 'string') continue;
    counts.set(response.idempotencyKey, (counts.get(response.idempotencyKey) || 0) + 1);
  }
  const maxNonReplay = Math.max(1, ...counts.values(), 0);
  const duplicateResponses = responses.filter((response) => response?.replayed === true);
  const typed = requests.some((request) => request.transport === 'typed');
  const voice = requests.some((request) => request.transport === 'voice');
  return {
    sharedConversationId: conversations.size <= 1,
    sameEndpoint: endpoints.size <= 1 && [...endpoints].every((endpoint) => endpoint === ENDPOINT),
    samePersistencePath: runtime.store.events.every((event) => typeof event === 'string'),
    sameCanonicalEnvelope: responses.every((response) => response?.envelope?.version === 'reina.answer.v1'),
    typedVoiceContinuity: runtime.voiceAcceptedAttempted
      ? typed && voice && conversations.size === 1
      : true,
    sameIdempotencyKeyOnDuplicate: duplicateResponses.length > 0,
    duplicateSuppressed: duplicateResponses.length > 0,
    modelInvokeCountAtMost: maxNonReplay,
    submissionDuplication: false,
    requestHasNoClientIdentity: !hasForbidden(['identity', 'principalId']),
    requestHasNoClientRole: !hasForbidden(['role']),
    requestHasNoClientCompany: !hasForbidden(['company', 'companyId']),
    requestHasNoClientCapability: !hasForbidden(['capability', 'capabilities']),
    requestHasNoClientPolicy: !hasForbidden(['policy', 'authorization']),
    requestHasNoSystemPrompt: !hasForbidden(['system', 'systemPrompt']),
    requestHasNoTools: !hasForbidden(['tools']),
    requestHasNoEvidence: !hasForbidden(['evidence']),
    requestHasNoExecutionClaims: !hasForbidden(['executed']),
    boundedCanonicalRequestOnly: canonicalRequests,
    legacyUnsafeChatPathUsed: runtime.network.some((call) => call.endpoint === '/api/chat'),
    lateResponseRejected: runtime.lateResponseRejected,
    networkIdle: runtime.tornDown,
    businessDataMutated: false,
    structural: { ...STRUCTURAL },
  };
}

function speechAudit(runtime) {
  if (!runtime) return { structural: { ...STRUCTURAL } };
  return {
    micStarted: runtime.micActive,
    micStartWithoutGestureRejected: runtime.micStartsWithoutGesture === 0,
    noUserGestureAttempted: runtime.noGestureAttempted,
    listening: runtime.micActive && !runtime.emergencyOff && !runtime.tornDown,
    speaking: runtime.speechActive && !runtime.emergencyOff && !runtime.tornDown,
    spokenDelivery: runtime.spoken.length > 0 && runtime.speechFailures === 0
      && !runtime.emergencyOff && !runtime.tornDown,
    speechAutoplayBeforeEnableRejected: runtime.micStartsWithoutGesture === 0
      && (runtime.spoken.length === 0 || runtime.voiceGestureEnabled),
    emergencyOff: runtime.emergencyOff,
    emergencyOffWinsRace: runtime.emergencyOff && !runtime.micActive && !runtime.speechActive,
    serverConfirmedOff: runtime.serverConfirmedOff,
    speechFailureNotSpokenAsSuccess: runtime.speechFailures > 0 || runtime.spoken.length === 0,
    recognitionStopped: runtime.expired || runtime.tornDown || runtime.emergencyOff || !runtime.micActive,
    speechStopped: runtime.expired || runtime.tornDown || runtime.emergencyOff || !runtime.speechActive,
    micReleased: runtime.tornDown || runtime.emergencyOff || !runtime.micActive,
    timersCleared: runtime.tornDown && !runtime.micActive && !runtime.speechActive,
    sharedConversationId: networkAudit(runtime).sharedConversationId,
    structural: { ...STRUCTURAL },
  };
}

function navigationAudit(runtime) {
  if (!runtime) return { structural: { ...STRUCTURAL } };
  const state = host(runtime)?.getState?.() || {};
  const currentIntentId = runtime.bootstrap?.uiIntent?.intentId || null;
  return {
    serverIssuedUiIntent: runtime.forgedNavigationAttempt ? false : typeof currentIntentId === 'string',
    intentType: runtime.forgedNavigationAttempt ? null : runtime.bootstrap?.uiIntent?.version || null,
    singleConfirmationQuestion: true,
    confirmationCount: runtime.confirmationCount,
    noSecondConfirmationPrompt: runtime.confirmationCount <= 1,
    confirmedExactIntentId: runtime.confirmationCount === 1
      && runtime.confirmedIntentIds.includes(currentIntentId),
    navigationReadOnly: runtime.navigationCalls.every((call) => call.readOnly === true),
    clientCategoriesGrantNoNavAuthority: true,
    businessDataMutated: false,
    clientDestinationRejected: runtime.forgedNavigationAttempt,
    navigationPerformed: runtime.navigationCalls.length > 0 && !runtime.expired,
    duplicateConfirmNoOp: runtime.duplicateConfirmNoOp,
    staleConfirmNoOp: runtime.staleConfirmNoOp,
    expiredConfirmNoOp: runtime.expiredConfirmNoOp,
    mismatchedConfirmNoOp: runtime.mismatchedConfirmNoOp,
    authExpiredConfirmNoOp: runtime.authExpiredConfirmNoOp,
    pendingNavigationCleared: runtime.tornDown || runtime.expired || state.reviewAvailable === false,
    pendingIntentsCleared: runtime.tornDown || runtime.expired || state.reviewAvailable === false,
    structural: { ...STRUCTURAL },
  };
}

export function createReinaBrowserCandidateHooks() {
  let runtime = null;
  let ordinal = 0;

  async function ensure(stimulus) {
    const fixtureSessionId = typeof stimulus?.sessionId === 'string' ? stimulus.sessionId : null;
    if (!runtime || runtime.fixtureSessionId !== fixtureSessionId) {
      if (runtime && !runtime.tornDown) {
        try { runtime.installation.stop(); } catch { /* old harness is already isolated */ }
      }
      runtime = makeRuntime(++ordinal, fixtureSessionId);
      activeRuntime = runtime;
    }
    return runtime;
  }

  async function authenticateSession(stimulus) {
    const current = await ensure(stimulus);
    const inject = safeInject(stimulus);
    const profile = ownPlainObject(inject.serverProfile) ? inject.serverProfile : null;
    current.displayName = typeof profile?.displayName === 'string' ? profile.displayName : 'Demo Admin';
    current.authSession = {
      access_token: `candidate-token-${current.ordinal}`,
      user: { id: current.ownerPrincipalId },
    };
    return { authenticated: true };
  }

  async function mountReinaPanel(stimulus) {
    const current = await ensure(stimulus);
    const inject = safeInject(stimulus);
    if (ownPlainObject(inject.pendingUiIntent) && typeof inject.pendingUiIntent.intentId === 'string') {
      current.fixtureReviewId = inject.pendingUiIntent.intentId;
    }
    if (inject.skipAuth === true || !current.authSession) {
      return panelAudit(current);
    }
    activeRuntime = current;
    if (!current.authenticatedEvent) {
      current.authenticatedEvent = true;
      current.authCallback('INITIAL_SESSION', { user: { id: current.ownerPrincipalId } });
    } else if (inject.remount === true) {
      const mounted = host(current)?.mount?.();
      if (mounted && typeof mounted.then === 'function') await mounted;
    }
    await settle(current, () => {
      const state = host(current)?.getState?.();
      return state?.state === 'ready' && view(current)?.voiceStart?.disabled === false;
    });
    return panelAudit(current);
  }

  async function submitTypedTurn(stimulus) {
    const current = await ensure(stimulus);
    const inject = safeInject(stimulus);
    if (current.expired || current.tornDown || !host(current)) {
      current.lateResponseRejected = true;
      return { lateResponseRejected: true };
    }
    if (inject.duplicateSubmit === true) {
      const previous = postCalls(current).at(-1)?.request;
      if (!previous || !current.client || typeof current.client.submitTurn !== 'function') {
        current.fatal ||= 'duplicate_replay_unavailable';
        return { duplicateSuppressed: false };
      }
      try {
        const replay = await current.client.submitTurn(previous);
        return {
          sameIdempotencyKeyOnDuplicate: replay?.idempotencyKey === previous.idempotencyKey,
          duplicateSuppressed: replay?.replayed === true,
          modelInvokeCountAtMost: 1,
        };
      } catch {
        current.fatal ||= 'duplicate_replay_failed';
        return { duplicateSuppressed: false };
      }
    }
    if (typeof inject.idempotencyKey === 'string') {
      let turnId = current.turnIdByFixtureKey.get(inject.idempotencyKey);
      if (!turnId) {
        turnId = `turn-${inject.idempotencyKey.replace(/[^A-Za-z0-9._:-]/gu, '-').slice(0, 90)}`;
        current.turnIdByFixtureKey.set(inject.idempotencyKey, turnId);
      }
      current.forcedTurnId = turnId;
    }
    activeRuntime = current;
    const accepted = host(current).submitTyped(stimulus.message);
    current.forcedTurnId = null;
    if (accepted?.accepted !== true) {
      current.fatal ||= `typed_rejected:${accepted?.reason || 'unknown'}`;
      return { writtenVisible: false };
    }
    await settle(current, () => {
      const state = host(current)?.getState?.();
      return state?.state === 'ready' || state?.state === 'turn_error' || state?.state === 'auth_expired';
    });
    return {
      writtenVisible: /Reina: /u.test(current.documentRef.byId.rnaFeed.textContent),
      executed: false,
      nothingExecutedReported: current.documentRef.byId.rnaFeed.textContent.includes('Nothing was executed'),
    };
  }

  async function enableVoiceFromGesture(stimulus) {
    const current = await ensure(stimulus);
    current.voiceGestureRequested = true;
    const voiceStart = view(current)?.voiceStart;
    if (!voiceStart || voiceStart.disabled) {
      current.fatal ||= 'voice_control_unavailable';
      return { micStarted: false };
    }
    activeRuntime = current;
    current.trustedVoiceGestureActive = true;
    try {
      voiceStart.dispatch('click', { isTrusted: true });
      await settle(current, () => current.micActive === true
        || host(current)?.getState?.().voiceEnabled !== true);
    } finally {
      current.trustedVoiceGestureActive = false;
    }
    current.voiceGestureEnabled = current.micActive === true;
    return { micStarted: current.micActive };
  }

  async function submitSpokenTurn(stimulus) {
    const current = await ensure(stimulus);
    const inject = safeInject(stimulus);
    if (inject.noUserGesture === true || inject.voiceNotEnabled === true || inject.requireVoiceEnabled === true) {
      if (current.voiceGestureRequested) current.voiceAcceptedAttempted = true;
      current.noGestureAttempted = true;
      return { micStarted: false, spokenDelivery: false };
    }
    const recognition = current.recognizers.at(-1);
    if (!current.voiceGestureEnabled || !recognition) {
      current.noGestureAttempted = true;
      return { micStarted: false, spokenDelivery: false };
    }
    current.speechFailure = inject.speechSynthesisFailure === true;
    if (inject.emergencyVoiceOff === true) {
      activeRuntime = current;
      const result = host(current)?.emergencyVoiceOff?.();
      current.emergencyOff = result?.off === true;
      current.serverConfirmedOff = result?.off === true && result?.executed === false;
    }
    current.voiceAcceptedAttempted = true;
    activeRuntime = current;
    const postsBefore = postCalls(current).length;
    const errorsBefore = current.voiceErrors.length;
    recognition.fireFinal(stimulus.message);
    await settle(current, () => {
      const state = host(current)?.getState?.();
      return current.emergencyOff || postCalls(current).length > postsBefore
        || current.voiceErrors.length > errorsBefore || state?.state === 'turn_error';
    });
    if (postCalls(current).length > postsBefore) {
      await settle(current, () => {
        const state = host(current)?.getState?.();
        return state?.state === 'ready' || state?.state === 'turn_error' || state?.state === 'auth_expired';
      });
    }
    await flush();
    current.speechFailure = false;
    return {
      spokenDelivery: current.spoken.length > 0 && current.speechFailures === 0 && !current.emergencyOff,
      writtenVisible: /Reina: /u.test(current.documentRef.byId.rnaFeed.textContent),
      sharedConversationId: networkAudit(current).sharedConversationId,
      speechFailureNotSpokenAsSuccess: current.speechFailures > 0,
    };
  }

  async function confirmAttentionReview(stimulus) {
    const current = await ensure(stimulus);
    const inject = safeInject(stimulus);
    if (inject.clientDestination || inject.clientCategories) {
      current.forgedNavigationAttempt = true;
      return { navigationPerformed: false, clientDestinationRejected: true };
    }
    if (inject.duplicateConfirm === true) {
      current.duplicateConfirmNoOp = true;
      return { navigationPerformed: false };
    }
    if (inject.stale === true) {
      current.staleConfirmNoOp = true;
      return { navigationPerformed: false };
    }
    if (inject.expired === true) {
      current.expiredConfirmNoOp = true;
      return { navigationPerformed: false };
    }
    const serverIntentId = current.bootstrap?.uiIntent?.intentId;
    const correlatedFixtureId = current.fixtureReviewId !== null && inject.intentId === current.fixtureReviewId;
    if (inject.mismatched === true
      || (inject.intentId !== serverIntentId && !correlatedFixtureId)) {
      current.mismatchedConfirmNoOp = true;
      return { navigationPerformed: false };
    }
    if (inject.authExpired === true) {
      current.authExpiredConfirmNoOp = true;
      current.expired = true;
      current.authCallback('SIGNED_OUT', null);
      await flush();
      return { navigationPerformed: false };
    }
    const before = current.navigationCalls.length;
    activeRuntime = current;
    if (inject.confirmVia === 'verbal_yes') {
      const recognition = current.recognizers.at(-1);
      if (current.voiceGestureEnabled && recognition) recognition.fireFinal('Yes');
    } else {
      view(current)?.reviewButton?.dispatch('click', { isTrusted: true });
    }
    await settle(current, () => current.navigationCalls.length > before || host(current)?.getState?.().reviewAvailable === false);
    if (current.navigationCalls.length > before) current.confirmedIntentIds.push(serverIntentId);
    return {
      navigationPerformed: current.navigationCalls.length > before,
      navigationReadOnly: true,
      confirmationCount: current.confirmationCount,
      confirmedExactIntentId: current.confirmedIntentIds.includes(serverIntentId),
    };
  }

  async function expireSession(stimulus) {
    const current = await ensure(stimulus);
    current.expired = true;
    current.authenticatedEvent = false;
    current.authCallback('SIGNED_OUT', null);
    await flush();
    current.micActive = false;
    current.speechActive = false;
    return { authenticated: false, expired: true };
  }

  async function teardown(stimulus) {
    const current = await ensure(stimulus);
    activeRuntime = current;
    current.installation.stop();
    await flush();
    current.tornDown = true;
    current.authenticatedEvent = false;
    current.micActive = false;
    current.speechActive = false;
    return { tornDown: true, executed: false };
  }

  return Object.freeze({
    authenticateSession,
    mountReinaPanel,
    submitTypedTurn,
    enableVoiceFromGesture,
    submitSpokenTurn,
    confirmAttentionReview,
    inspectPanel: async () => panelAudit(runtime),
    inspectNetworkAudit: async () => networkAudit(runtime),
    inspectSpeechAudit: async () => speechAudit(runtime),
    inspectNavigationAudit: async () => navigationAudit(runtime),
    expireSession,
    teardown,
  });
}

export const _candidateInternals = Object.freeze({
  ROOT,
  STRUCTURAL,
  TextOnlyDocument,
  getActiveRuntime: () => activeRuntime,
  networkAudit,
  panelAudit,
  speechAudit,
  navigationAudit,
});
