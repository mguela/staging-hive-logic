import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  haversineMeters,
  nearestJobWithin,
  presenceConfidence,
  detectPresence,
} from '../api/_lib/fleet/geo.js';

// A job site and a far-away point, near Greenwich CT.
const A = { jobUuid: 'job-A', lat: 41.0300, lng: -73.6300 };
const B = { jobUuid: 'job-B', lat: 41.0310, lng: -73.6300 }; // ~111 m north of A
const FAR = { lat: 41.2000, lng: -73.4000 };                 // many km away

const min = (n) => n * 60000;
let clock = 0;
const at = (lat, lng) => ({ t: (clock += min(5)), lat, lng }); // 5-min spaced samples

test('haversineMeters: ~111 km per degree of latitude', () => {
  const d = haversineMeters(41.0, -73.6, 42.0, -73.6);
  assert.ok(Math.abs(d - 111195) < 500, `got ${d}`);
});

test('haversineMeters: zero distance for identical points', () => {
  assert.equal(haversineMeters(41.03, -73.63, 41.03, -73.63), 0);
});

test('nearestJobWithin: picks the closer of two in-range jobs', () => {
  const pos = { t: 0, lat: 41.0307, lng: -73.6300 }; // closer to B than A
  assert.equal(nearestJobWithin(pos, [A, B], 150).jobUuid, 'job-B');
});

test('nearestJobWithin: null when nothing is inside the radius', () => {
  const pos = { t: 0, lat: FAR.lat, lng: FAR.lng };
  assert.equal(nearestJobWithin(pos, [A, B], 150), null);
});

test('nearestJobWithin: respects a job time window', () => {
  const windowed = { ...A, windowStart: 1000, windowEnd: 2000 };
  assert.equal(nearestJobWithin({ t: 1500, lat: A.lat, lng: A.lng }, [windowed], 150).jobUuid, 'job-A');
  assert.equal(nearestJobWithin({ t: 5000, lat: A.lat, lng: A.lng }, [windowed], 150), null); // after window
});

test('detectPresence: arrive and stay -> one interval spanning the visit', () => {
  clock = 0;
  const positions = [at(A.lat, A.lng), at(A.lat, A.lng), at(A.lat, A.lng), at(A.lat, A.lng)];
  const out = detectPresence(positions, [A, B]);
  assert.equal(out.length, 1);
  assert.equal(out[0].jobUuid, 'job-A');
  assert.equal(out[0].samples, 4);
  assert.equal(out[0].arrivedAt, positions[0].t);
  assert.equal(out[0].departedAt, positions[3].t);
  assert.equal(out[0].dwellMs, min(15));
});

test('detectPresence: a single drive-by is recorded but low confidence', () => {
  clock = 0;
  const positions = [at(FAR.lat, FAR.lng), at(A.lat, A.lng), at(FAR.lat, FAR.lng)];
  const out = detectPresence(positions, [A]);
  assert.equal(out.length, 1);
  assert.equal(out[0].samples, 1);
  assert.ok(out[0].confidence <= 40, `confidence ${out[0].confidence}`);
});

test('detectPresence: leave and return to same job -> two intervals', () => {
  clock = 0;
  const positions = [
    at(A.lat, A.lng), at(A.lat, A.lng),
    at(FAR.lat, FAR.lng),
    at(A.lat, A.lng), at(A.lat, A.lng),
  ];
  const out = detectPresence(positions, [A]);
  assert.equal(out.length, 2);
  assert.equal(out[0].samples, 2);
  assert.equal(out[1].samples, 2);
});

test('detectPresence: no jobs in range -> no intervals', () => {
  clock = 0;
  const positions = [at(FAR.lat, FAR.lng), at(FAR.lat, FAR.lng)];
  assert.deepEqual(detectPresence(positions, [A, B]), []);
});

test('detectPresence: switching jobs closes one interval and opens the next', () => {
  clock = 0;
  const positions = [at(A.lat, A.lng), at(A.lat, A.lng), at(B.lat, B.lng)];
  const out = detectPresence(positions, [A, B]);
  assert.equal(out.length, 2);
  assert.equal(out[0].jobUuid, 'job-A');
  assert.equal(out[1].jobUuid, 'job-B');
});

test('presenceConfidence: rises with samples and dwell, capped at 100', () => {
  assert.ok(presenceConfidence(1, 0) < presenceConfidence(3, 0));
  assert.ok(presenceConfidence(3, 0) < presenceConfidence(3, min(30)));
  assert.equal(presenceConfidence(10, min(120)), 100);
});
