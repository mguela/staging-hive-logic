import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickFreshestFix,
  shouldRecord,
  movementState,
  positionHash,
} from '../api/_lib/fleet/positions.js';

test('pickFreshestFix: chooses the source with the newer timestamp', () => {
  const v = {
    latitude: 41.0, longitude: -73.6, speed: 0, status: 'OFF', gps_updated_at: '2026-08-16T10:00:00Z',
    fleetsharp_latitude: 41.1, fleetsharp_longitude: -73.7, fleetsharp_speed: 30, fleetsharp_status: 'DRIVING', fleetsharp_updated_at: '2026-08-16T12:00:00Z',
  };
  const fix = pickFreshestFix(v);
  assert.equal(fix.source, 'fleetsharp');
  assert.equal(fix.lat, 41.1);
  assert.equal(fix.status, 'DRIVING');
});

test('pickFreshestFix: falls back to jobber when it is newer', () => {
  const v = {
    latitude: 41.0, longitude: -73.6, speed: 5, status: 'IDLE', gps_updated_at: '2026-08-16T15:00:00Z',
    fleetsharp_latitude: 41.1, fleetsharp_longitude: -73.7, fleetsharp_speed: 30, fleetsharp_status: 'DRIVING', fleetsharp_updated_at: '2026-08-16T12:00:00Z',
  };
  assert.equal(pickFreshestFix(v).source, 'jobber');
});

test('pickFreshestFix: ignores a source missing coords or time', () => {
  const v = {
    latitude: null, longitude: null, speed: null, status: null, gps_updated_at: null,
    fleetsharp_latitude: 41.1, fleetsharp_longitude: -73.7, fleetsharp_speed: 0, fleetsharp_status: 'OFF', fleetsharp_updated_at: '2026-08-16T12:00:00Z',
  };
  assert.equal(pickFreshestFix(v).source, 'fleetsharp');
});

test('pickFreshestFix: returns null when no usable fix', () => {
  assert.equal(pickFreshestFix({}), null);
  assert.equal(pickFreshestFix(null), null);
  assert.equal(pickFreshestFix({ fleetsharp_latitude: 41.1, fleetsharp_longitude: -73.7, fleetsharp_updated_at: null }), null);
});

test('shouldRecord: only when strictly newer than last stored', () => {
  const fix = { deviceTime: '2026-08-16T12:00:00Z' };
  assert.equal(shouldRecord(fix, null), true);                        // nothing stored yet
  assert.equal(shouldRecord(fix, '2026-08-16T11:00:00Z'), true);      // newer
  assert.equal(shouldRecord(fix, '2026-08-16T12:00:00Z'), false);     // same -> no dup
  assert.equal(shouldRecord(fix, '2026-08-16T13:00:00Z'), false);     // older -> never roll back
  assert.equal(shouldRecord(null, null), false);
});

test('movementState: maps live statuses', () => {
  assert.equal(movementState('DRIVING', 30), 'moving');
  assert.equal(movementState('IDLE', 0), 'idle');
  assert.equal(movementState('OFF', 0), 'parked');
  assert.equal(movementState(null, 15), 'moving');
  assert.equal(movementState(null, 0), 'parked');
  assert.equal(movementState(null, null), 'unknown');
});

test('positionHash: stable and distinct', () => {
  assert.equal(positionHash('abc', '2026-08-16T12:00:00Z', 'fleetsharp'), 'mirror:fleetsharp:abc:2026-08-16T12:00:00Z');
  assert.notEqual(
    positionHash('abc', '2026-08-16T12:00:00Z', 'fleetsharp'),
    positionHash('abc', '2026-08-16T12:05:00Z', 'fleetsharp'),
  );
});
