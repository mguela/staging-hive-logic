import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { encryptSecret, decryptSecret, isEncrypted } from '../api/_lib/secrets.js';

const originalEnv = {
  key: process.env.TOKEN_ENC_KEY,
  previous: process.env.TOKEN_ENC_KEY_PREVIOUS,
  writeVersion: process.env.TOKEN_ENC_WRITE_VERSION,
  node: process.env.NODE_ENV,
  vercel: process.env.VERCEL_ENV,
};

function restoreEnv() {
  if (originalEnv.key === undefined) delete process.env.TOKEN_ENC_KEY;
  else process.env.TOKEN_ENC_KEY = originalEnv.key;
  if (originalEnv.previous === undefined) delete process.env.TOKEN_ENC_KEY_PREVIOUS;
  else process.env.TOKEN_ENC_KEY_PREVIOUS = originalEnv.previous;
  if (originalEnv.writeVersion === undefined) delete process.env.TOKEN_ENC_WRITE_VERSION;
  else process.env.TOKEN_ENC_WRITE_VERSION = originalEnv.writeVersion;
  if (originalEnv.node === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalEnv.node;
  if (originalEnv.vercel === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = originalEnv.vercel;
}

test.afterEach(restoreEnv);

function legacyV1(plain, base64Key) {
  const key = Buffer.from(base64Key, 'base64');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['enc:v1', iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

// Mirrors the reader in the currently deployed production revision. This is
// intentionally kept in the test so the compatibility release proves its
// default writes remain usable by the rollback candidate, not merely by the
// new dual reader.
function deployedV1Reader(envelope, base64Key) {
  assert.match(envelope, /^enc:v1:/);
  const [ivB64, tagB64, ciphertextB64] = envelope.slice('enc:v1:'.length).split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(base64Key, 'base64'), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

test('reader-first rollout keeps new writes on enc:v1 by default', () => {
  const key = crypto.randomBytes(32).toString('base64');
  process.env.TOKEN_ENC_KEY = key;
  delete process.env.TOKEN_ENC_KEY_PREVIOUS;
  delete process.env.TOKEN_ENC_WRITE_VERSION;
  const encrypted = encryptSecret('refresh-token-value');
  assert.match(encrypted, /^enc:v1:/);
  assert.equal(isEncrypted(encrypted), true);
  assert.equal(decryptSecret(encrypted), 'refresh-token-value');
  assert.equal(deployedV1Reader(encrypted, key), 'refresh-token-value');
});

test('v2 writes require an explicit post-reader cutover flag', () => {
  process.env.TOKEN_ENC_KEY = crypto.randomBytes(32).toString('base64');
  process.env.TOKEN_ENC_WRITE_VERSION = 'v2';
  const encrypted = encryptSecret('refresh-token-value');
  assert.match(encrypted, /^enc:v2:[0-9a-f]{16}:/);
  assert.equal(decryptSecret(encrypted), 'refresh-token-value');
});

test('only an authenticated envelope is treated as already encrypted', () => {
  process.env.TOKEN_ENC_KEY = crypto.randomBytes(32).toString('base64');
  delete process.env.TOKEN_ENC_KEY_PREVIOUS;

  const envelope = encryptSecret('already-protected');
  assert.equal(encryptSecret(envelope), envelope, 'valid ciphertext remains idempotent');

  for (const raw of ['enc:v1:valid-raw-password', 'enc:v2:not:a:real:envelope']) {
    const encrypted = encryptSecret(raw);
    assert.notEqual(encrypted, raw, 'an envelope-looking raw credential must not bypass encryption');
    assert.match(encrypted, /^enc:v1:/);
    assert.equal(decryptSecret(encrypted), raw);
  }
});

test('rotation reads an old v2 envelope through TOKEN_ENC_KEY_PREVIOUS and writes with the new key id', () => {
  const oldKey = crypto.randomBytes(32).toString('base64');
  const newKey = crypto.randomBytes(32).toString('base64');
  process.env.TOKEN_ENC_WRITE_VERSION = 'v2';
  process.env.TOKEN_ENC_KEY = oldKey;
  const oldEnvelope = encryptSecret('old-row');
  const oldId = oldEnvelope.split(':')[2];

  process.env.TOKEN_ENC_KEY = newKey;
  process.env.TOKEN_ENC_KEY_PREVIOUS = oldKey;
  assert.equal(decryptSecret(oldEnvelope), 'old-row');
  const newEnvelope = encryptSecret('new-row');
  assert.notEqual(newEnvelope.split(':')[2], oldId);
  assert.equal(decryptSecret(newEnvelope), 'new-row');

  const rewrapped = encryptSecret(oldEnvelope);
  assert.notEqual(rewrapped, oldEnvelope, 'a previous-key v2 envelope must migrate to the active key');
  assert.notEqual(rewrapped.split(':')[2], oldId);
  assert.equal(decryptSecret(rewrapped), 'old-row');
});

test('legacy enc:v1 rows can be opened by a previous rotation key', () => {
  const oldKey = crypto.randomBytes(32).toString('base64');
  const newKey = crypto.randomBytes(32).toString('base64');
  const oldEnvelope = legacyV1('legacy-row', oldKey);
  process.env.TOKEN_ENC_KEY = newKey;
  process.env.TOKEN_ENC_KEY_PREVIOUS = oldKey;
  assert.equal(isEncrypted(oldEnvelope), true);
  assert.equal(decryptSecret(oldEnvelope), 'legacy-row');
});

test('an unknown v2 key id fails clearly instead of returning ciphertext', () => {
  process.env.TOKEN_ENC_KEY = crypto.randomBytes(32).toString('base64');
  process.env.TOKEN_ENC_WRITE_VERSION = 'v2';
  const envelope = encryptSecret('must-not-leak');
  process.env.TOKEN_ENC_KEY = crypto.randomBytes(32).toString('base64');
  assert.throws(() => decryptSecret(envelope), /No configured TOKEN_ENC_KEY matches encrypted key id/);
  assert.throws(() => encryptSecret(envelope), /No configured TOKEN_ENC_KEY matches encrypted key id/);
});

test('a previous-key v1 envelope is rewrapped with the active key', () => {
  const oldKey = crypto.randomBytes(32).toString('base64');
  const newKey = crypto.randomBytes(32).toString('base64');
  const oldEnvelope = legacyV1('legacy-rotation-row', oldKey);
  process.env.TOKEN_ENC_KEY = newKey;
  process.env.TOKEN_ENC_KEY_PREVIOUS = oldKey;
  const rewrapped = encryptSecret(oldEnvelope);
  assert.notEqual(rewrapped, oldEnvelope);
  assert.equal(deployedV1Reader(rewrapped, newKey), 'legacy-rotation-row');
});

test('reader-first mode rewrites an incoming v2 envelope back to v1', () => {
  process.env.TOKEN_ENC_KEY = crypto.randomBytes(32).toString('base64');
  process.env.TOKEN_ENC_WRITE_VERSION = 'v2';
  const v2 = encryptSecret('shared-row');
  delete process.env.TOKEN_ENC_WRITE_VERSION;
  const compatible = encryptSecret(v2);
  assert.match(compatible, /^enc:v1:/);
  assert.equal(decryptSecret(compatible), 'shared-row');
});

test('an invalid write-version flag fails instead of guessing a format', () => {
  process.env.TOKEN_ENC_KEY = crypto.randomBytes(32).toString('base64');
  process.env.TOKEN_ENC_WRITE_VERSION = 'v3';
  assert.throws(() => encryptSecret('do-not-guess'), /must be v1 or v2/);
});

test('production secret writes fail closed when TOKEN_ENC_KEY is missing', () => {
  delete process.env.TOKEN_ENC_KEY;
  delete process.env.TOKEN_ENC_KEY_PREVIOUS;
  process.env.VERCEL_ENV = 'production';
  assert.throws(() => encryptSecret('never-store-this-plaintext'), /TOKEN_ENC_KEY is required/);
});

test('preview secret writes also fail closed when TOKEN_ENC_KEY is missing', () => {
  delete process.env.TOKEN_ENC_KEY;
  delete process.env.TOKEN_ENC_KEY_PREVIOUS;
  process.env.VERCEL_ENV = 'preview';
  assert.throws(() => encryptSecret('never-store-this-plaintext'), /TOKEN_ENC_KEY is required/);
});

test('local development retains no-key passthrough for non-production fixtures', () => {
  delete process.env.TOKEN_ENC_KEY;
  delete process.env.TOKEN_ENC_KEY_PREVIOUS;
  process.env.NODE_ENV = 'test';
  delete process.env.VERCEL_ENV;
  assert.equal(encryptSecret('local-fixture'), 'local-fixture');
});
