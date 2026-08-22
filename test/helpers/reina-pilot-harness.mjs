// The harness for the Reina popup host: a text-only DOM, the real client,
// login-brief, typed-panel and intent-router modules, and a stand-in voice host
// that records what it was asked to do.
//
// It lives here rather than inside one test file because
// test/reina-voice-contract.test.mjs must set globalThis.SpeechRecognition
// BEFORE the host module is evaluated -- the host captures the recogniser once
// at load, on purpose, so page code cannot swap it afterwards. A file that
// imports this helper dynamically gets to install its fake first.
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';

import HostModule from '../../public/reina-pilot-host.js';
import PilotClient from '../../public/reina-pilot-client.js';
import LoginBrief from '../../public/reina-login-brief-controller.js';
import TypedPanel from '../../public/reina-typed-panel-controller.js';
import UiIntentRouter from '../../public/reina-ui-intent-router.js';
import { createReinaInAppVoiceHost } from '../../public/reina-inapp-voice-host.js';
import { createCanonicalVoiceTransport } from '../../public/reina-canonical-voice-transport.js';

export const { createReinaPilotHost, installReinaPilotPage, resolveElements, createNativeRecognitionFactory, NATIVE_VOICE_MESSAGES, FIXED_ERRORS, VOICE_RATES } = HostModule;
export { HostModule, PilotClient, LoginBrief, TypedPanel, UiIntentRouter, createReinaInAppVoiceHost, createCanonicalVoiceTransport };
export const SESSION = `rp.${'a'.repeat(64)}`;
export const HASH = 'b'.repeat(64);
export const AS_OF = '2026-08-03T14:00:00Z';
export const REVIEW_EXPIRES = new Date(Date.now() + 5 * 60 * 1000).toISOString();

export function reviewFields(sessionId = SESSION, suffix = '1') {
  const padded = String(suffix).padStart(32, '0');
  const intentId = `rui.${padded}`;
  const turnId = `bootstrap.${padded}`;
  return {
    review: { intentId, available: true, expiresAt: REVIEW_EXPIRES },
    uiIntent: {
      version: 'reina.ui-intent.v1', executed: false, requiresConfirmation: true,
      conversationId: sessionId, turnId, intentId, expiresAt: REVIEW_EXPIRES,
      kind: 'navigate', destination: 'standup', parameters: {},
    },
  };
}

export class Classes {
  constructor() { this.values = new Set(); }
  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
  contains(value) { return this.values.has(value); }
}

export class TextOnlyElement {
  constructor(tagName, id = '') {
    this.tagName = String(tagName).toUpperCase();
    this.id = id;
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this.classList = new Classes();
    this.style = { display: '' };
    this.disabled = false;
    this.type = '';
    this.value = '';
    this.onclick = null;
    this.attributes = Object.create(null);
    this.listeners = Object.create(null);
    this.innerWrites = 0;
    this.scrollTop = 0;
    this._text = '';
  }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  set innerHTML(_value) { this.innerWrites += 1; }
  get innerHTML() { return ''; }
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

export class TextOnlyDocument {
  constructor() {
    this.created = [];
    this.byId = Object.create(null);
    this.listeners = Object.create(null);
    const tags = {
      rnaFab: 'button', rnaPanel: 'div', rnaMode: 'span', rnaX: 'button',
      rnaFeed: 'div', rnaIn: 'textarea', rnaSend: 'button', rnaVoice: 'button',
      rnaVoiceLabel: 'span', rnaVoiceLive: 'span', rnaStage: 'div', rnaVoiceHint: 'div',
      rnaSettingsVoiceToggle: 'button', rnaSettings: 'button', rnaSettingsPanel: 'div',
      rnaNeuralVoice: 'select', rnaVoiceRate: 'select',
      rnaAudioInput: 'select', rnaAudioOutput: 'select', rnaRefreshAudioDevices: 'button',
      rnaAudioDeviceStatus: 'p',
      rnaHistory: 'button', rnaMin: 'button', rnaHead: 'div', standup: 'section',
    };
    for (const [id, tag] of Object.entries(tags)) this.byId[id] = new TextOnlyElement(tag, id);
    this.byId.standup.style.display = 'none';
  }
  createElement(tagName) { const node = new TextOnlyElement(tagName); this.created.push(node); return node; }
  getElementById(id) { return this.byId[id] || null; }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  removeEventListener(name, callback) {
    this.listeners[name] = (this.listeners[name] || []).filter((candidate) => candidate !== callback);
  }
  dispatch(name, event = {}) {
    for (const callback of [...(this.listeners[name] || [])]) callback(event);
  }
}

export function bootstrap(displayName = 'Chris') {
  return {
    ok: true, sessionId: SESSION, generatedAt: AS_OF,
    user: { displayName },
    attention: {
      total: 5,
      categories: [
        { key: 'jobs', label: 'Jobs', count: 5, available: true, asOf: AS_OF, evidence: ['Bounded synthetic Jobs fixture.'] },
        { key: 'mail', label: 'Important email', count: null, available: false, asOf: null, evidence: [] },
      ],
      unavailableSources: ['Important email'],
      asOf: AS_OF,
      reviewAvailable: true,
    },
    ...reviewFields(SESSION),
    executed: false,
  };
}

export function envelope(answer = 'This is a deterministic synthetic preview answer.') {
  return {
    version: PilotClient.ENVELOPE_VERSION,
    answer,
    evidence: [{
      source: 'HiveLogic Reina synthetic preview fixtures', sourceType: 'synthetic_fixture',
      dataClass: 'synthetic', synthetic: true, observedAt: AS_OF, asOf: AS_OF,
      detail: 'Fixed synthetic test record.',
    }],
    freshness: { known: true, asOf: AS_OF, note: 'Fixed synthetic snapshot.' },
    missingInformation: ['No live business source was consulted.'],
    conflictingInformation: [],
    uncertainty: ['This answer is synthetic and not authoritative.'],
    refused: false, refusalReason: null, executed: false,
    executionStatement: PilotClient.EXECUTION_STATEMENT,
  };
}

export function httpResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

export function confirmedReview(intentId) {
  return {
    ok: true, confirmed: true, intentId,
    executed: false, nothingExecuted: true,
    businessActionAllowed: false, automationTaskAllowed: false,
    toolExecutionAllowed: false,
  };
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function makeVoiceModules(state) {
  return Object.freeze({
    createControlledRecognitionFactory(options) {
      state.controlledRecognitionOptions = options;
      return function () {
        return {
          start() {}, stop() {}, abort() {},
          onstart: null, onresult: null, onerror: null, onend: null,
        };
      };
    },
    createVoiceTransport({ serverTransport }) {
      return {
        submitTurn(payload) {
          return serverTransport({
            utterance: payload.text,
            conversationId: payload.conversationId,
            turnId: payload.turnId,
            idempotencyKey: payload.idempotencyKey,
            transport: payload.source === 'voice' ? 'voice' : 'typed',
          }).then((response) => ({ reply: response.answer.text, speechSafe: response.answer.speech }));
        },
      };
    },
    createVoiceHost(options) {
      let disposed = false;
      const control = {
        starts: 0, stops: 0, interrupts: 0, offs: 0, disposes: 0,
        options,
        async final(text, eventId = `voice-${Date.now()}`) {
          const verdict = options.assessTranscript({ text, isFinal: true, eventId });
          if (!verdict || verdict.decision !== 'accept') return verdict;
          const turnId = `voice-turn-${control.starts}`;
          const acceptedText = typeof verdict.text === 'string' ? verdict.text : text;
          const response = await options.submitTurn({
            text: acceptedText, conversationId: SESSION, turnId,
            idempotencyKey: `voice:${SESSION}:${turnId}`, source: 'voice',
          });
          options.render.reply(response.reply);
          return { decision: 'accept', response };
        },
        fail(reason = 'permission_denied') {
          options.render.error('error_' + reason);
          options.onControlEvent({ type: 'error', detail: { reason } });
        },
        // What the real panel controller sends on mount() and reset(): clear
        // the error surface. It is not a failure and carries no control event.
        clear() {
          options.render.error('');
        },
      };
      state.voiceControl = control;
      return {
        mount() { options.render.controls({ canStart: true, canStop: false, off: false }); return true; },
        isVoiceAvailable() { return true; },
        startListening() { control.starts += 1; options.render.controls({ canStart: false, canStop: true, off: false }); return true; },
        stop() { control.stops += 1; },
        interrupt() { control.interrupts += 1; control.starts += 1; return true; },
        emergencyOff() { control.offs += 1; options.render.controls({ canStart: false, canStop: false, off: true }); },
        dispose() { if (!disposed) { disposed = true; control.disposes += 1; } },
      };
    },
  });
}

export function makeHarness(options = {}) {
  const documentRef = new TextOnlyDocument();
  const page = resolveElements(documentRef);
  const calls = [];
  const state = {
    displayName: options.displayName || 'Chris', postStatus: 200,
    bootstrapStatus: 200, confirmStatus: 200, tokenError: null,
    bootstrapBody: options.bootstrapBody || null,
    navigationCalls: 0,
    confirmationRequests: [],
    answer: options.answer || 'This is a deterministic synthetic preview answer.',
    bootstrapGates: Array.isArray(options.bootstrapGates) ? [...options.bootstrapGates] : [],
    postGates: Array.isArray(options.postGates) ? [...options.postGates] : [],
    confirmGates: Array.isArray(options.confirmGates) ? [...options.confirmGates] : [],
  };
  let id = 0;
  let authExpiredCount = 0;
  const createClient = ({ onAuthExpired }) => PilotClient.createReinaPilotClient({
    fetchFn: async (_url, init) => {
      // The URL matters now that the voice beacon posts through this same
      // client: "how many POSTs" no longer means "how many Reina turns".
      calls.push(Object.assign({ url: String(_url || '') }, init));
      if (String(_url || '').includes('reina-voice-diagnostic')) {
        return httpResponse(202, { ok: true });
      }
      if (init.method === 'GET') {
        const gate = state.bootstrapGates.shift();
        if (gate) await gate.promise;
        return httpResponse(state.bootstrapStatus, state.bootstrapBody || bootstrap(state.displayName));
      }
      const request = JSON.parse(init.body);
      if (request.action === 'confirm_review') {
        state.confirmationRequests.push(request);
        const confirmGate = state.confirmGates.shift();
        if (confirmGate) await confirmGate.promise;
        if (typeof options.confirmReview === 'function') {
          return options.confirmReview(request, state, init);
        }
        if (state.confirmStatus !== 200) {
          return httpResponse(state.confirmStatus, { error: 'SYNTHETIC_SECRET_SERVER_MARKER' });
        }
        return httpResponse(200, confirmedReview(request.intentId));
      }
      const postGate = state.postGates.shift();
      if (postGate) await postGate.promise;
      if (state.postStatus !== 200) return httpResponse(state.postStatus, { error: 'SYNTHETIC_SECRET_SERVER_MARKER' });
      const env = envelope(state.answer);
      return httpResponse(200, {
        ok: true, enabled: true, stored: true,
        conversationId: request.conversationId, turnId: request.turnId,
        idempotencyKey: request.idempotencyKey, replayed: false,
        executed: false, nothingExecuted: true, businessActionAllowed: false,
        automationTaskAllowed: false, toolExecutionAllowed: false,
        synthetic: true, dataAccess: 'synthetic', reviewAvailable: false,
        envelope: env, plainText: PilotClient.renderPlainText(env), navigation: null,
      });
    },
    getAccessToken: async () => {
      if (state.tokenError) throw new Error(state.tokenError);
      return 'verified-test-bearer';
    },
    hashFn: async () => HASH,
    validateBootstrap: LoginBrief.validateBootstrap,
    timeoutMs: 1000,
    onAuthExpired,
  });
  const makeHost = typeof options.createReinaPilotHost === 'function'
    ? options.createReinaPilotHost : createReinaPilotHost;
  const host = makeHost({
    documentRef, elements: page, createClient,
    createLoginBrief: LoginBrief.createLoginBrief,
    createTypedPanel: TypedPanel.createTypedPanel,
    createIntentRouter: UiIntentRouter.createUiIntentRouter,
    loadVoiceModules: options.loadVoiceModules || (() => Promise.resolve(makeVoiceModules(state))),
    showView: () => {},
    go: (destination) => {
      state.navigationCalls += 1;
      documentRef.byId.standup.style.display = destination === 'standup' ? 'block' : 'none';
    },
    newId: () => `turn-${++id}`,
    onAuthExpired: () => { authExpiredCount += 1; },
    canAutoStartVoice: options.canAutoStartVoice,
    setTimeoutFn: options.setTimeoutFn,
    clearTimeoutFn: options.clearTimeoutFn,
  });
  return { host, documentRef, page, calls, state, authExpiredCount: () => authExpiredCount };
}

export async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}
