import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogImageExtension, findCatalogItem, normalizeProductImageRegion, searchCatalog, upsertCatalogItem } from '../src/catalog.js';

test('product images must match their declared safe image type', () => {
  assert.equal(catalogImageExtension('image/png', Buffer.from('89504e470d0a1a0a00000000', 'hex')), 'png');
  assert.equal(catalogImageExtension('image/jpeg', Buffer.from('ffd8ffe000104a464946', 'hex')), 'jpg');
  assert.throws(() => catalogImageExtension('image/png', Buffer.from('not an image')), /valid JPG/);
});

test('Reina product-image regions are normalized and bounded', () => {
  assert.deepEqual(normalizeProductImageRegion({ x: 33.2, y: 58.4, width: 4.5, height: 6.2, confidence: 0.91 }), { x: 0.332, y: 0.584, width: 0.045, height: 0.062, confidence: 0.91 });
  assert.deepEqual(normalizeProductImageRegion({ left: 0.33, top: 0.58, right: 0.37, bottom: 0.65, confidence: 0.94 }), { x: 0.33, y: 0.58, width: 0.04, height: 0.07, confidence: 0.94 });
  assert.deepEqual(normalizeProductImageRegion({ x: 0.97, y: 0.96, width: 0.1, height: 0.1 }), { x: 0.97, y: 0.96, width: 0.03, height: 0.04, confidence: null });
  assert.equal(normalizeProductImageRegion({ x: 0, y: 0, width: 0.9, height: 0.9 }), null);
  assert.equal(normalizeProductImageRegion(null), null);
});

test('material nicknames and SKUs are searchable', () => {
  const material = { id: 'm1', type: 'material', name: 'HINGE, TEE HD DECO 6" BLK', nickname: 'Black gate hinge', sku: '030699150311' };
  assert.equal(findCatalogItem([material], 'black gate hinge', { type: 'material' }).id, 'm1');
  assert.equal(findCatalogItem([material], '030699150311', { type: 'material' }).id, 'm1');
  assert.equal(searchCatalog([material], 'gate', { type: 'material' })[0].id, 'm1');
});

test('catalog upsert preserves identity and searchable aliases', () => {
  const created = upsertCatalogItem([], { type: 'material', name: '3/4 in. plywood', nickname: 'Cabinet plywood', sku: 'PLY-34' }, { id: 'm1', now: '2026-07-20T12:00:00.000Z' });
  const updated = upsertCatalogItem(created.items, { ...created.item, nickname: 'Shop plywood' }, { id: 'ignored', now: '2026-07-20T13:00:00.000Z' });
  assert.equal(updated.item.id, 'm1');
  assert.equal(updated.item.nickname, 'Shop plywood');
  assert.equal(findCatalogItem(updated.items, 'Cabinet plywood').id, 'm1');
});

test('catalog rejects ambiguous nicknames', () => {
  const items = [{ id: 'm1', type: 'material', name: 'Six inch tee hinge', nickname: 'Black gate hinge' }];
  assert.throws(() => upsertCatalogItem(items, { type: 'material', name: 'Different hinge', nickname: 'Black gate hinge' }, { id: 'm2' }), /already used/);
});
