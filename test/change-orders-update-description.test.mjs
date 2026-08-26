// test/change-orders-update-description.test.mjs
// jomell, 2026-08-26: "the invoices and job order should have a title or
// label rather than just the number... their names should be edittable."
// For change orders the label is `description` (server/bookkeeping/src/
// change-orders.js already treats it as the human-readable name, per the
// existing Change Orders tab's coCard()). This exercises the new
// updateChangeOrderDescription state-machine function directly (no I/O),
// and the API route that wraps it with the durable store's
// compare-and-swap update -- same split as every other lifecycle action in
// this file (send/reject/record-payment).

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import { updateChangeOrderDescription } from '../server/bookkeeping/src/change-orders.js';

const actor = { id: 'actor-1', companyId: 'greenwich-handyman', role: 'controller' };

function baseCo(overrides = {}) {
  return {
    id: 'co-1',
    companyId: 'greenwich-handyman',
    coNumber: 'CO-HL-JOB-10008-01',
    jobId: 'J-10008',
    kind: 'estimate',
    description: 'Add recessed lighting in hallway',
    lifecycleStatus: 'draft',
    lines: [],
    history: [],
    ...overrides,
  };
}

// ---- pure engine function ---------------------------------------------

test('a draft change order\'s description can be edited', () => {
  const next = updateChangeOrderDescription(baseCo(), actor, { description: 'Add recessed lighting in hallway and pantry' });
  assert.equal(next.description, 'Add recessed lighting in hallway and pantry');
});

test('a sent (awaiting client approval) change order can still have its description fixed', () => {
  const next = updateChangeOrderDescription(baseCo({ lifecycleStatus: 'sent' }), actor, { description: 'Corrected description' });
  assert.equal(next.description, 'Corrected description');
});

test('an approved change order refuses the edit -- it describes what was actually approved', () => {
  assert.throws(
    () => updateChangeOrderDescription(baseCo({ lifecycleStatus: 'approved' }), actor, { description: 'Rewritten after the fact' }),
    /Cannot edit the description of a change order in status "approved"/,
  );
});

test('a paid, converted, rejected, or cancelled change order also refuses the edit', () => {
  for (const lifecycleStatus of ['paid', 'converted', 'rejected', 'cancelled']) {
    assert.throws(() => updateChangeOrderDescription(baseCo({ lifecycleStatus }), actor, { description: 'x' }));
  }
});

test('a blank description is rejected -- the same requirement as at creation', () => {
  assert.throws(
    () => updateChangeOrderDescription(baseCo(), actor, { description: '   ' }),
    /A description of the additional work is required/,
  );
});

test('an unauthenticated actor is refused', () => {
  assert.throws(() => updateChangeOrderDescription(baseCo(), null, { description: 'x' }));
});

test('the edit is recorded in history so a change is traceable', () => {
  const next = updateChangeOrderDescription(baseCo(), actor, { description: 'New wording' });
  const entry = next.history.find((h) => h.type === 'description_edited');
  assert.ok(entry, 'expected a description_edited history entry');
  assert.equal(entry.detail.from, 'Add recessed lighting in hallway');
  assert.equal(entry.detail.to, 'New wording');
  assert.equal(entry.actorId, actor.id);
});

test('saving the exact same description is a no-op -- no spurious history entry', () => {
  const co = baseCo();
  const next = updateChangeOrderDescription(co, actor, { description: co.description });
  assert.equal(next.history.length, 0);
});

// ---- API route: api/bookkeeping/change-orders/update-description.js ----

process.env.BOOKKEEPING_ENABLED = 'true';

mock.module('../api/bookkeeping/purchase-orders/_actor.js', {
  namedExports: {
    getTrustedActor: async () => actor,
  },
});

let storedCo = baseCo();
mock.module('../api/bookkeeping/change-orders/_store.js', {
  namedExports: {
    getChangeOrder: async () => storedCo,
    updateChangeOrder: async (companyId, id, mutate) => {
      storedCo = mutate(storedCo);
      return storedCo;
    },
  },
});

const { default: handler } = await import('../api/bookkeeping/change-orders/update-description.js');

function res() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

test('the route saves a new description and returns the updated change order', async () => {
  storedCo = baseCo();
  const r = res();
  await handler({ method: 'POST', body: { id: 'co-1', description: 'Add recessed lighting in hallway, pantry, and mudroom' } }, r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.changeOrder.description, 'Add recessed lighting in hallway, pantry, and mudroom');
});

test('the route refuses a change order that has already moved past draft/sent', async () => {
  storedCo = baseCo({ lifecycleStatus: 'paid' });
  const r = res();
  await handler({ method: 'POST', body: { id: 'co-1', description: 'try to rewrite it' } }, r);
  assert.equal(r.statusCode, 422);
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /Cannot edit the description/);
});

test('the route requires a change order id', async () => {
  const r = res();
  await handler({ method: 'POST', body: { description: 'no id given' } }, r);
  assert.equal(r.statusCode, 422);
  assert.equal(r.body.ok, false);
});

test('a non-POST request is rejected', async () => {
  const r = res();
  await handler({ method: 'GET', body: {} }, r);
  assert.equal(r.statusCode, 405);
});
