// test/reina-voice-panel-controller.test.mjs
//
// Adversarial tests for the unwired Voice panel presenter/controller. Everything
// is driven through injected fakes -- a minimal fake DOM element (tracks
// textContent, refuses to be read via innerHTML meaningfully, and records bound
// listeners) and a fake bridge factory that captures the controller's callbacks
// so the test can replay bridge events. No real DOM, microphone, or speakers.
//
// Coverage: unsafe HTML, duplicate clicks, late callbacks, stale state updates,
// OFF races, dispose races, speech denial, missing controls, throwing render
// targets, unclear transcripts, and written-vs-spoken delivery.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoicePanelController } from '../public/reina-voice-panel-controller.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

// A tiny element that ONLY supports textContent + event listeners. It records
// every assignment so a test can prove the controller never used innerHTML.
class FakeEl {
  constructor() {
    this._textContent = '';
    this.disabled = false;
    this._listeners = {};
    this.innerHTMLWrites = 0;
  }
  get textContent() {
    return this._textContent;
  }
  set textContent(v) {
    this._textContent = String(v);
  }
  // If the controller ever tried innerHTML, this setter would count it.
  set innerHTML(_v) {
    this.innerHTMLWrites++;
  }
  get innerHTML() {
    return '';
  }
  addEventListener(type, handler) {
    (this._listeners[type] = this._listeners[type] || []).push(handler);
  }
  removeEventListener(type, handler) {
    const arr = this._listeners[type] || [];
    const i = arr.indexOf(handler);
    if (i !== -1) arr.splice(i, 1);
  }
  click() {
    (this._listeners.click || []).slice().forEach((h) => h({ type: 'click' }));
  }
  listenerCount(type) {
    return (this._listeners[type] || []).length;
  }
}

// A fake bridge that captures the controller's callbacks (so the test can fire
// bridge events) and records every control invocation.
function makeFakeBridge() {
  const calls = [];
  let cb = null;
  const bridge = {
    startListening: async () => {
      calls.push('startListening');
      return true;
    },
    stopListening: () => calls.push('stopListening'),
    interrupt: async () => {
      calls.push('interrupt');
      return true;
    },
    mute: () => calls.push('mute'),
    unmute: () => calls.push('unmute'),
    submit: async (t) => {
      calls.push('submit:' + t);
      return { accepted: true };
    },
    retry: () => calls.push('retry'),
    emergencyOff: () => calls.push('emergencyOff'),
    dispose: () => calls.push('dispose'),
  };
  const createBridge = (callbacks) => {
    cb = callbacks;
    return bridge;
  };
  return {
    createBridge,
    calls,
    fire: (name, arg) => cb && cb[name] && cb[name](arg),
    hasCb: () => !!cb,
  };
}

// Build a mounted controller wired to fakes. Returns the controller + handles.
function makeController(o = {}) {
  const els = {
    status: new FakeEl(),
    interim: new FakeEl(),
    reply: new FakeEl(),
    confirm: new FakeEl(),
    error: new FakeEl(),
  };
  const controls = o.controls || {
    start: new FakeEl(),
    stop: new FakeEl(),
    interrupt: new FakeEl(),
    mute: new FakeEl(),
    unmute: new FakeEl(),
    off: new FakeEl(),
    reset: new FakeEl(),
    confirm: new FakeEl(),
    dismiss: new FakeEl(),
  };
  const fb = o.fakeBridge || makeFakeBridge();
  const events = [];
  const controller = createVoicePanelController({
    elements: o.render ? undefined : els,
    render: o.render,
    controls,
    createBridge: o.noBridge ? undefined : fb.createBridge,
    onControlEvent: (e) => events.push(e),
    labels: o.labels,
  });
  if (o.mount !== false) controller.mount();
  return { controller, els, controls, fb, events };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// ===========================================================================
// Dormancy + no auto-mic
// ===========================================================================

test('dormant until mounted; mount never activates the microphone', async () => {
  const fb = makeFakeBridge();
  const controller = createVoicePanelController({
    elements: { status: new FakeEl() },
    createBridge: fb.createBridge,
  });
  // Not mounted yet: no bridge constructed, controls inert.
  assert.equal(fb.hasCb(), false);
  assert.equal(controller.isMounted(), false);
  assert.equal(controller.startListening(), false); // inert before mount

  controller.mount();
  await flush();
  assert.equal(controller.isMounted(), true);
  assert.equal(fb.hasCb(), true); // bridge constructed at mount
  // Mount must NOT have started the mic.
  assert.equal(fb.calls.includes('startListening'), false);
});

test('microphone activates ONLY from an explicit start seam', async () => {
  const h = makeController();
  assert.equal(h.fb.calls.includes('startListening'), false);
  h.controller.startListening();
  await flush();
  assert.deepEqual(h.fb.calls, ['startListening']);
});

// ===========================================================================
// States
// ===========================================================================

test('honestly reflects each bridge state', async () => {
  const h = makeController();
  for (const s of ['idle', 'listening', 'thinking', 'speaking', 'error']) {
    h.fb.fire('onState', s, {});
    assert.equal(h.controller.getState(), s);
    assert.equal(h.els.status.textContent, s);
  }
});

test('unknown/malformed state falls closed to error', () => {
  const h = makeController();
  h.fb.fire('onState', 'bogus-state', {});
  assert.equal(h.controller.getState(), 'error');
});

// ===========================================================================
// Unsafe HTML / plain-text rendering
// ===========================================================================

test('unsafe HTML in a reply is rendered as plain text (never innerHTML)', () => {
  const h = makeController();
  const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  h.fb.fire('onReply', { reply: evil });
  assert.equal(h.els.reply.textContent, evil); // stored verbatim as TEXT
  assert.equal(h.els.reply.innerHTMLWrites, 0); // innerHTML never touched
});

test('unsafe HTML in interim + confirm + error also stays plain text', () => {
  const h = makeController();
  h.fb.fire('onState', 'listening', {});
  h.fb.fire('onInterim', { text: '<b>hi</b>' });
  assert.equal(h.els.interim.textContent, '<b>hi</b>');
  h.fb.fire('onNeedsConfirmation', { text: '<i>x</i>', reason: 'confirm' });
  assert.ok(h.els.confirm.textContent.includes('<i>x</i>'));
  h.fb.fire('onError', { reason: '<u>err</u>' });
  assert.equal(
    h.els.status.innerHTMLWrites + h.els.reply.innerHTMLWrites + h.els.error.innerHTMLWrites,
    0,
  );
});

// ===========================================================================
// Duplicate clicks
// ===========================================================================

test('duplicate start clicks activate the mic at most once', async () => {
  const h = makeController();
  h.controls.start.click();
  h.controls.start.click();
  h.controls.start.click();
  await flush();
  assert.equal(h.fb.calls.filter((c) => c === 'startListening').length, 1);
});

test('start is ignored while already listening/thinking/speaking', async () => {
  const h = makeController();
  h.controller.startListening();
  await flush();
  h.fb.fire('onState', 'listening', {});
  h.controls.start.click(); // should be ignored -- not idle/error
  await flush();
  assert.equal(h.fb.calls.filter((c) => c === 'startListening').length, 1);
});

test('graceful stop releases Start so a new recognition generation can begin', async () => {
  const h = makeController();
  h.controller.startListening();
  await flush();
  h.fb.fire('onState', 'listening', {});

  h.controller.stop();
  assert.equal(h.controller.getState(), 'idle');
  assert.equal(h.controls.start.disabled, false);
  assert.equal(h.fb.calls.filter((c) => c === 'stopListening').length, 1);

  assert.equal(h.controller.startListening(), true);
  await flush();
  assert.equal(h.fb.calls.filter((c) => c === 'startListening').length, 2);
});

// ===========================================================================
// Late callbacks / stale updates / dispose races
// ===========================================================================

test('late callbacks after dispose never render or fire', () => {
  const h = makeController();
  h.fb.fire('onState', 'listening', {});
  h.controller.dispose();
  const before = h.els.status.textContent;
  h.fb.fire('onState', 'thinking', {}); // late
  h.fb.fire('onReply', { reply: 'too late' }); // late
  h.fb.fire('onInterim', { text: 'too late' }); // late
  assert.equal(h.els.status.textContent, before);
  assert.equal(h.els.reply.textContent, '');
  assert.equal(h.els.interim.textContent, '');
});

test('dispose is idempotent and calls the bridge cleanup once', () => {
  const h = makeController();
  h.controller.dispose();
  h.controller.dispose();
  h.controller.dispose();
  assert.equal(h.fb.calls.filter((c) => c === 'dispose').length, 1);
  assert.equal(h.controller.isDisposed(), true);
});

test('dispose removes owned control listeners', () => {
  const h = makeController();
  assert.equal(h.controls.start.listenerCount('click'), 1);
  h.controller.dispose();
  assert.equal(h.controls.start.listenerCount('click'), 0);
  // A click after dispose does nothing.
  h.controls.start.click();
  assert.equal(h.fb.calls.includes('startListening'), false);
});

test('stale state update after a newer state is ignored once OFF/disposed', () => {
  const h = makeController();
  h.fb.fire('onState', 'listening', {});
  h.controller.emergencyOff();
  h.fb.fire('onState', 'listening', {}); // stale, arrives after OFF
  assert.equal(h.controller.getState(), 'off');
  assert.equal(h.els.status.textContent, 'off');
});

// ===========================================================================
// Emergency OFF
// ===========================================================================

test('emergency OFF: immediate OFF, disables start, suppresses late events, latches', async () => {
  const h = makeController();
  h.fb.fire('onState', 'listening', {});
  h.controller.emergencyOff();
  await flush();

  assert.equal(h.controller.getState(), 'off');
  assert.equal(h.els.status.textContent, 'off');
  assert.equal(h.controls.start.disabled, true); // new listening disabled
  assert.ok(h.fb.calls.includes('emergencyOff')); // bridge told to halt

  // Late interim/reply/speaking all suppressed.
  h.fb.fire('onInterim', { text: 'late interim' });
  h.fb.fire('onReply', { reply: 'late reply' });
  h.fb.fire('onState', 'speaking', {});
  assert.equal(h.els.interim.textContent, '');
  assert.equal(h.els.reply.textContent, '');
  assert.equal(h.controller.getState(), 'off');

  // start seam is a no-op while OFF.
  assert.equal(h.controller.startListening(), false);
  assert.equal(h.fb.calls.includes('startListening'), false);
});

test('OFF remains until explicit host-authorized reset()', () => {
  const h = makeController();
  h.controller.emergencyOff();
  assert.equal(h.controller.isOff(), true);
  // reset re-enables an honest, dormant idle -- and does NOT start the mic.
  assert.equal(h.controller.reset(), true);
  assert.equal(h.controller.isOff(), false);
  assert.equal(h.controller.getState(), 'idle');
  assert.equal(h.controls.start.disabled, false);
  assert.equal(h.fb.calls.includes('startListening'), false);
});

test('OFF race: bridge onState("off") also latches and suppresses', () => {
  const h = makeController();
  h.fb.fire('onState', 'off', { reason: 'emergency' });
  assert.equal(h.controller.isOff(), true);
  h.fb.fire('onReply', { reply: 'suppressed' });
  assert.equal(h.els.reply.textContent, '');
});

// ===========================================================================
// Written vs spoken delivery / speech denial
// ===========================================================================

test('written reply is delivered even when speech is denied (state returns to idle)', () => {
  const h = makeController();
  h.fb.fire('onState', 'thinking', {});
  h.fb.fire('onReply', { reply: 'here is your written answer' });
  // Speech denied -> bridge never enters 'speaking'; it settles back to idle.
  h.fb.fire('onState', 'idle', { spoken: false });
  assert.equal(h.els.reply.textContent, 'here is your written answer');
  assert.equal(h.controller.getState(), 'idle');
});

test('written reply stays available while muted', () => {
  const h = makeController();
  h.controller.mute();
  assert.ok(h.fb.calls.includes('mute'));
  h.fb.fire('onReply', { reply: 'muted but readable' });
  assert.equal(h.els.reply.textContent, 'muted but readable');
});

// ===========================================================================
// Unclear transcript confirmation
// ===========================================================================

test('unclear transcript is never auto-submitted; explicit confirm submits', async () => {
  const h = makeController();
  h.fb.fire('onState', 'listening', {});
  h.fb.fire('onNeedsConfirmation', { text: 'transfer the deposit', reason: 'confirm' });
  await flush();
  assert.equal(h.fb.calls.some((c) => c.startsWith('submit')), false); // NOT auto-submitted
  assert.ok(h.els.confirm.textContent.includes('transfer the deposit'));

  h.controller.confirmUnclear(); // explicit user action
  await flush();
  assert.deepEqual(
    h.fb.calls.filter((c) => c.startsWith('submit')),
    ['submit:transfer the deposit'],
  );
  assert.equal(h.els.confirm.textContent, ''); // prompt cleared
});

test('unclear (empty-final) confirmation submits nothing on confirm', async () => {
  const h = makeController();
  h.fb.fire('onState', 'listening', {});
  h.fb.fire('onNeedsConfirmation', { text: null, reason: 'unclear' });
  await flush();
  assert.equal(h.controller.confirmUnclear(), false); // nothing to submit
  await flush();
  assert.equal(h.fb.calls.some((c) => c.startsWith('submit')), false);
});

test('dismissing an unclear transcript submits nothing and clears the prompt', async () => {
  const h = makeController();
  h.fb.fire('onNeedsConfirmation', { text: 'maybe this', reason: 'confirm' });
  h.controller.dismissUnclear();
  await flush();
  assert.equal(h.fb.calls.some((c) => c.startsWith('submit')), false);
  assert.equal(h.els.confirm.textContent, '');
});

// ===========================================================================
// Missing controls / throwing render targets / fail-closed deps
// ===========================================================================

test('missing control elements: mount does not throw, seams still work', async () => {
  const h = makeController({ controls: {} }); // no control elements at all
  assert.equal(h.controller.isMounted(), true);
  h.controller.startListening(); // programmatic seam still works
  await flush();
  assert.ok(h.fb.calls.includes('startListening'));
});

test('throwing render target never breaks the controller', () => {
  const boom = () => {
    throw new Error('render boom');
  };
  const fb = makeFakeBridge();
  const controller = createVoicePanelController({
    render: { status: boom, reply: boom, interim: boom, confirm: boom, error: boom },
    createBridge: fb.createBridge,
  });
  controller.mount();
  // None of these should throw despite the render sink throwing every time.
  fb.fire('onState', 'listening', {});
  fb.fire('onReply', { reply: 'x' });
  fb.fire('onInterim', { text: 'y' });
  fb.fire('onNeedsConfirmation', { text: 'z', reason: 'confirm' });
  fb.fire('onError', { reason: 'nope' });
  assert.equal(controller.getState(), 'listening'); // state tracked despite render throw
});

test('missing bridge factory: controller mounts but control seams are inert', async () => {
  const h = makeController({ noBridge: true });
  assert.equal(h.controller.isMounted(), true);
  assert.equal(h.controller.startListening(), false);
  await flush();
  // No bridge -> nothing recorded, no throw, no unhandled rejection.
  assert.equal(h.fb.calls.length, 0);
});

test('a throwing bridge factory fails closed (controls inert, no throw)', async () => {
  const controller = createVoicePanelController({
    elements: { status: new FakeEl() },
    createBridge: () => {
      throw new Error('bridge construction failed');
    },
  });
  assert.equal(controller.mount(), true); // mount still succeeds
  assert.equal(controller.startListening(), false); // inert, fail closed
  await flush();
});

test('a rejecting async control never produces an unhandled rejection', async () => {
  const fb = makeFakeBridge();
  fb.createBridge = ((orig) => (callbacks) => {
    const b = orig(callbacks);
    b.startListening = async () => {
      throw new Error('mic rejected');
    };
    return b;
  })(fb.createBridge);
  const controller = createVoicePanelController({
    elements: { status: new FakeEl() },
    createBridge: fb.createBridge,
  });
  controller.mount();
  controller.startListening(); // rejects internally -> must be swallowed
  await flush();
  assert.equal(controller.getState(), 'idle'); // still coherent, no crash
});

// ===========================================================================
// Control invocation wiring
// ===========================================================================

test('bound controls drive the matching bridge seams', async () => {
  const h = makeController();
  h.fb.fire('onState', 'listening', {});
  h.controls.stop.click();
  h.controls.interrupt.click();
  h.controls.mute.click();
  h.controls.unmute.click();
  await flush();
  assert.ok(h.fb.calls.includes('stopListening'));
  assert.ok(h.fb.calls.includes('interrupt'));
  assert.ok(h.fb.calls.includes('mute'));
  assert.ok(h.fb.calls.includes('unmute'));
});
