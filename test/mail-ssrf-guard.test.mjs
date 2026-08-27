// test/mail-ssrf-guard.test.mjs
// api/mail.js's add_account lets a signed-in user point imap_host/smtp_host
// at any custom server, and this route (server-side, not the browser) opens
// a real TCP connection to it. Without a guard, that's an SSRF/port-scan
// oracle against internal infrastructure -- the differentiated error text
// (timeout vs. refused vs. protocol mismatch) tells the caller what's there.
//
// This tests the pure IP-classification logic and the literal-IP fast path
// of assertPublicHost -- fully offline, no DNS/network, matching the rest of
// this suite. The hostname-resolution branch (dns.lookup) is intentionally
// not exercised here for the same reason. Run with:
//   node --test test/mail-ssrf-guard.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isPrivateOrReservedIp, assertPublicHost } = require('../api/mail.js');

test('loopback and unspecified addresses are rejected', () => {
  for (const ip of ['127.0.0.1', '127.255.255.255', '0.0.0.0', '::1', '::']) {
    assert.equal(isPrivateOrReservedIp(ip), true, `${ip} must be treated as private`);
  }
});

test('RFC1918 private ranges are rejected', () => {
  for (const ip of ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.0.1', '192.168.255.255']) {
    assert.equal(isPrivateOrReservedIp(ip), true, `${ip} must be treated as private`);
  }
  // just outside the 172.16/12 range -- must NOT be swept in by a sloppy check
  for (const ip of ['172.15.255.255', '172.32.0.1']) {
    assert.equal(isPrivateOrReservedIp(ip), false, `${ip} is outside 172.16/12 and must be public`);
  }
});

test('link-local and cloud metadata addresses are rejected', () => {
  // 169.254.169.254 is the AWS/GCP/Azure instance-metadata endpoint -- the
  // single most valuable address an SSRF guard exists to close off.
  assert.equal(isPrivateOrReservedIp('169.254.169.254'), true);
  assert.equal(isPrivateOrReservedIp('169.254.0.1'), true);
  assert.equal(isPrivateOrReservedIp('fe80::1'), true);
});

test('IPv6 unique-local and IPv4-mapped addresses are rejected', () => {
  assert.equal(isPrivateOrReservedIp('fc00::1'), true);
  assert.equal(isPrivateOrReservedIp('fd12:3456::1'), true);
  assert.equal(isPrivateOrReservedIp('::ffff:127.0.0.1'), true, 'IPv4-mapped loopback must unwrap and reject');
  assert.equal(isPrivateOrReservedIp('::ffff:8.8.8.8'), false, 'IPv4-mapped public address must unwrap and pass');
});

test('carrier-grade NAT (100.64/10) is rejected', () => {
  assert.equal(isPrivateOrReservedIp('100.64.0.1'), true);
  assert.equal(isPrivateOrReservedIp('100.127.255.255'), true);
  assert.equal(isPrivateOrReservedIp('100.63.255.255'), false, 'just outside the range must be public');
});

test('real public mail-server IPs are not misclassified as private', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.253.62.108', '17.171.0.1']) {
    assert.equal(isPrivateOrReservedIp(ip), false, `${ip} is a real public address`);
  }
});

test('assertPublicHost rejects a literal private/loopback IP without touching the network', async () => {
  await assert.rejects(() => assertPublicHost('127.0.0.1'), /isn't reachable/i);
  await assert.rejects(() => assertPublicHost('169.254.169.254'), /isn't reachable/i);
  await assert.rejects(() => assertPublicHost('10.0.0.5'), /isn't reachable/i);
});

test('assertPublicHost rejects "localhost" by name, and an empty host', async () => {
  await assert.rejects(() => assertPublicHost('localhost'), /isn't reachable/i);
  await assert.rejects(() => assertPublicHost(''), /required/i);
  await assert.rejects(() => assertPublicHost(undefined), /required/i);
});

test('assertPublicHost accepts a literal public IP without a DNS lookup', async () => {
  // A literal IP short-circuits before dns.lookup, so this stays offline.
  await assert.doesNotReject(() => assertPublicHost('8.8.8.8'));
});
