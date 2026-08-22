// test/inventory.test.mjs
// Real Inventory & Truck Stock (2026-08-12), replacing a fully-mock page
// that fabricated a $38,420 stock value and an AI banner claiming to have
// already drafted a real purchase order overnight. Phase 1 is deliberately
// manual: a real stock-item catalog, a real per-location on-hand ledger
// (warehouse or a real vehicle/truck), logged adjustments, and a plain
// threshold-based low-stock flag -- no automatic decrement (no
// "materials used on a job" concept exists anywhere in this schema to hook
// into) and no AI-drafted reorder.
// Fully mocked -- no network, no DB, no real secret.
// Run with: node --experimental-test-module-mocks --test test/inventory.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.CRON_SECRET = 'test-cron-secret';

function res() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

let scenario = {};

function jsonRes(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}

async function withMockedFetch(fn) {
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return jsonRes({ id: 'user-1', email: scenario.email || 'chris@ghgrp.net' });
    if (u.includes('/rest/v1/profiles')) return jsonRes([{ id: 'user-1', email: scenario.email || 'chris@ghgrp.net', role: scenario.profileRole || null }]);

    if (u.includes('/rest/v1/stock_items') && opts && opts.method === 'POST') {
      const row = Object.assign({ id: 'item-new', created_at: '2026-08-12T00:00:00Z' }, JSON.parse(opts.body)[0]);
      scenario.insertedItem = row;
      return jsonRes([row]);
    }
    if (u.includes('/rest/v1/stock_items') && u.includes('id=in.(')) return jsonRes(scenario.itemsForNames || []);
    if (u.includes('/rest/v1/stock_items')) return jsonRes(scenario.itemRows || []);

    if (u.includes('/rest/v1/stock_on_hand') && opts && opts.method === 'POST') {
      scenario.upsertedOnHand = JSON.parse(opts.body)[0];
      return jsonRes([scenario.upsertedOnHand]);
    }
    if (u.includes('/rest/v1/stock_on_hand') && u.includes('stock_item_id=eq.')) return jsonRes(scenario.currentOnHandRows || []);
    if (u.includes('/rest/v1/stock_on_hand')) return jsonRes(scenario.onHandRows || []);

    if (u.includes('/rest/v1/vehicles') && u.includes('jobber_id=eq.')) return jsonRes(scenario.truckExists === false ? [] : [{ jobber_id: scenario.lookupVehicleId || 'V1' }]);
    if (u.includes('/rest/v1/vehicles')) return jsonRes(scenario.vehicleRows || []);

    if (u.includes('/rest/v1/users') && u.includes('assigned_vehicle_id')) return jsonRes(scenario.assignedUsers || []);

    if (u.includes('/rest/v1/stock_adjustments') && opts && opts.method === 'POST') {
      scenario.insertedAdjustment = JSON.parse(opts.body)[0];
      return jsonRes([scenario.insertedAdjustment]);
    }
    if (u.includes('/rest/v1/stock_adjustments')) return jsonRes(scenario.adjustmentRows || []);

    if (u.includes('/rest/v1/purchase_orders')) return jsonRes(scenario.poRows || []);

    return jsonRes({ error: 'not relevant to this test' });
  };
  try {
    return await fn();
  } finally {
    global.fetch = original;
  }
}

const trackMod = await import('../api/track1.js');

async function callTrack1(resource, { method = 'GET', body, query = {}, authHeader = 'Bearer usertoken' } = {}) {
  const req = { method, query: Object.assign({ resource }, query), headers: { authorization: authHeader }, body };
  const r = res();
  await trackMod.default(req, r);
  return r;
}

// ---------------------------------------------------- auth gate (shared across all inventory_* resources)

test('inventory_stock: an anonymous request 401s', async () => {
  const r = await withMockedFetch(() => callTrack1('inventory_stock', { authHeader: '' }));
  assert.equal(r.statusCode, 401);
});

test('inventory_stock: a non-admin is rejected 403', async () => {
  scenario = { email: 'field@ghgrp.net', profileRole: 'crew' };
  const r = await withMockedFetch(() => callTrack1('inventory_stock'));
  assert.equal(r.statusCode, 403);
});

// ---------------------------------------------------- inventory_items

test('inventory_items GET: returns the real stock item catalog', async () => {
  scenario = { email: 'chris@ghgrp.net', profileRole: 'admin', itemRows: [{ id: 'i1', name: 'Romex 12-2', sku: 'RX-122', category: 'Electrical', unit_of_measure: 'roll', reorder_threshold: 5 }] };
  const r = await withMockedFetch(() => callTrack1('inventory_items'));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.items.length, 1);
  assert.equal(r.body.items[0].name, 'Romex 12-2');
});

test('inventory_items POST: requires a name', async () => {
  scenario = { email: 'chris@ghgrp.net', profileRole: 'admin' };
  const r = await withMockedFetch(() => callTrack1('inventory_items', { method: 'POST', body: { name: '' } }));
  assert.equal(r.statusCode, 400);
});

test('inventory_items POST: rejects a negative reorder threshold', async () => {
  scenario = { email: 'chris@ghgrp.net', profileRole: 'admin' };
  const r = await withMockedFetch(() => callTrack1('inventory_items', { method: 'POST', body: { name: 'PVC pipe', reorderThreshold: -1 } }));
  assert.equal(r.statusCode, 400);
});

test('inventory_items POST: a non-admin cannot create an item', async () => {
  scenario = { email: 'field@ghgrp.net', profileRole: 'crew' };
  const r = await withMockedFetch(() => callTrack1('inventory_items', { method: 'POST', body: { name: 'PVC pipe' } }));
  assert.equal(r.statusCode, 403);
});

test('inventory_items POST: an admin can create a real item', async () => {
  scenario = { email: 'chris@ghgrp.net', profileRole: 'admin' };
  const r = await withMockedFetch(() => callTrack1('inventory_items', { method: 'POST', body: { name: 'PVC pipe 2in', sku: 'PV-210', reorderThreshold: 10 } }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.item.name, 'PVC pipe 2in');
  assert.equal(scenario.insertedItem.reorder_threshold, 10);
});

// ---------------------------------------------------- inventory_stock

test('inventory_stock GET: computes totalQuantity across warehouse+truck locations and flags low stock against the real threshold', async () => {
  scenario = {
    email: 'chris@ghgrp.net', profileRole: 'admin',
    itemRows: [
      { id: 'i1', name: 'Copper fitting 3/4"', sku: 'CF-750', category: 'Plumbing', unit_of_measure: 'ea', reorder_threshold: 20 },
      { id: 'i2', name: 'Receptacle 15A', sku: 'RO-1ST', category: 'Electrical', unit_of_measure: 'ea', reorder_threshold: 10 },
    ],
    onHandRows: [
      { stock_item_id: 'i1', location_key: 'warehouse', quantity: 14 },
      { stock_item_id: 'i1', location_key: 'truck:V1', quantity: 3 },
      { stock_item_id: 'i2', location_key: 'warehouse', quantity: 84 },
    ],
    vehicleRows: [{ jobber_id: 'V1', name: 'Truck 1', status: 'active' }],
    assignedUsers: [{ name: 'Jeff', assigned_vehicle_id: 'V1' }, { name: 'Joe', assigned_vehicle_id: 'V1' }],
  };
  const r = await withMockedFetch(() => callTrack1('inventory_stock'));
  assert.equal(r.statusCode, 200);
  const copper = r.body.items.find((i) => i.id === 'i1');
  const receptacle = r.body.items.find((i) => i.id === 'i2');
  assert.equal(copper.totalQuantity, 17);
  assert.equal(copper.lowStock, true, '17 on hand vs a threshold of 20 should be flagged low');
  assert.equal(receptacle.totalQuantity, 84);
  assert.equal(receptacle.lowStock, false);
  assert.equal(r.body.trucks.length, 1);
  assert.deepEqual(r.body.trucks[0].assignedNames.sort(), ['Jeff', 'Joe']);
  assert.equal(r.body.summary.skuCount, 2);
  assert.equal(r.body.summary.totalUnits, 101);
  assert.equal(r.body.summary.lowStockCount, 1);
});

test('inventory_stock GET: an item with no reorder threshold is never flagged low regardless of quantity', async () => {
  scenario = {
    email: 'chris@ghgrp.net', profileRole: 'admin',
    itemRows: [{ id: 'i1', name: 'Misc widget', reorder_threshold: null }],
    onHandRows: [{ stock_item_id: 'i1', location_key: 'warehouse', quantity: 0 }],
    vehicleRows: [],
    assignedUsers: [],
  };
  const r = await withMockedFetch(() => callTrack1('inventory_stock'));
  assert.equal(r.body.items[0].lowStock, false);
});

// ---------------------------------------------------- inventory_adjust

test('inventory_adjust: a non-admin cannot adjust stock', async () => {
  scenario = { email: 'field@ghgrp.net', profileRole: 'crew' };
  const r = await withMockedFetch(() => callTrack1('inventory_adjust', { method: 'POST', body: { stockItemId: 'i1', locationKey: 'warehouse', delta: 5 } }));
  assert.equal(r.statusCode, 403);
});

test('inventory_adjust: rejects a malformed locationKey', async () => {
  scenario = { email: 'chris@ghgrp.net', profileRole: 'admin' };
  const r = await withMockedFetch(() => callTrack1('inventory_adjust', { method: 'POST', body: { stockItemId: 'i1', locationKey: 'garage', delta: 5 } }));
  assert.equal(r.statusCode, 400);
});

test('inventory_adjust: rejects an adjustment against a truck that is not a real vehicle', async () => {
  scenario = { email: 'chris@ghgrp.net', profileRole: 'admin', truckExists: false };
  const r = await withMockedFetch(() => callTrack1('inventory_adjust', { method: 'POST', body: { stockItemId: 'i1', locationKey: 'truck:FAKE99', delta: 5 } }));
  assert.equal(r.statusCode, 400);
});

test('inventory_adjust: rejects an adjustment that would take quantity below zero', async () => {
  scenario = { email: 'chris@ghgrp.net', profileRole: 'admin', currentOnHandRows: [{ quantity: 3 }] };
  const r = await withMockedFetch(() => callTrack1('inventory_adjust', { method: 'POST', body: { stockItemId: 'i1', locationKey: 'warehouse', delta: -5 } }));
  assert.equal(r.statusCode, 400);
});

test('inventory_adjust: applies a positive delta on top of the current real quantity and logs it', async () => {
  scenario = { email: 'chris@ghgrp.net', profileRole: 'admin', currentOnHandRows: [{ quantity: 10 }] };
  const r = await withMockedFetch(() => callTrack1('inventory_adjust', { method: 'POST', body: { stockItemId: 'i1', locationKey: 'warehouse', delta: 4, reason: 'Recount' } }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.quantity, 14);
  assert.equal(scenario.upsertedOnHand.quantity, 14);
  assert.equal(scenario.insertedAdjustment.delta, 4);
  assert.equal(scenario.insertedAdjustment.quantity_after, 14);
  assert.equal(scenario.insertedAdjustment.reason, 'Recount');
});

test('inventory_adjust: a truck location with no prior on-hand row starts from zero', async () => {
  scenario = { email: 'chris@ghgrp.net', profileRole: 'admin', currentOnHandRows: [], lookupVehicleId: 'V1' };
  const r = await withMockedFetch(() => callTrack1('inventory_adjust', { method: 'POST', body: { stockItemId: 'i1', locationKey: 'truck:V1', delta: 6 } }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.quantity, 6);
});

// ---------------------------------------------------- inventory_adjustments (Usage History)

test('inventory_adjustments GET: resolves each logged adjustment to its real item name', async () => {
  scenario = {
    email: 'chris@ghgrp.net', profileRole: 'admin',
    adjustmentRows: [{ id: 'a1', stock_item_id: 'i1', location_key: 'warehouse', delta: -2, quantity_after: 12, reason: 'Used on job', adjusted_by_email: 'chris@ghgrp.net', adjusted_at: '2026-08-12T10:00:00Z' }],
    itemsForNames: [{ id: 'i1', name: 'Romex 12-2' }],
  };
  const r = await withMockedFetch(() => callTrack1('inventory_adjustments'));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.adjustments[0].itemName, 'Romex 12-2');
  assert.equal(r.body.adjustments[0].delta, -2);
});

// ---------------------------------------------------- inventory_purchase_orders

test('inventory_purchase_orders GET: computes a real amount from PO line items and counts drafts as awaiting approval', async () => {
  scenario = {
    email: 'chris@ghgrp.net', profileRole: 'admin',
    poRows: [
      { id: 'po1', po_number: 'PO-231-004-01', lifecycle_status: 'draft', data: { vendorName: 'Ferguson Supply', lines: [{ estimatedQty: 10, estimatedUnitPrice: 1.5 }, { estimatedQty: 2, estimatedUnitPrice: 40 }] }, created_at: '2026-08-12T09:00:00Z' },
      { id: 'po2', po_number: 'PO-231-004-02', lifecycle_status: 'ordered', data: { vendorName: 'Home Depot', lines: [] }, created_at: '2026-08-11T09:00:00Z' },
    ],
  };
  const r = await withMockedFetch(() => callTrack1('inventory_purchase_orders'));
  assert.equal(r.statusCode, 200);
  const draft = r.body.purchaseOrders.find((po) => po.poNumber === 'PO-231-004-01');
  assert.equal(draft.amount, 95);
  assert.equal(draft.vendorName, 'Ferguson Supply');
  assert.equal(r.body.awaitingApprovalCount, 1);
});
