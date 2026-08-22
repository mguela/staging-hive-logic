// api/_lib/secrets.js
// Application-level encryption for credentials stored in Supabase. The
// symmetric keys live only in the deployment secret store -- never in the DB.
//
// Readers accept both the legacy enc:v1 envelope and the key-addressable v2
// envelope:
//   enc:v2:<key_id>:<iv_b64>:<tag_b64>:<ciphertext_b64>
//
// ROLLOUT SAFETY: writes remain enc:v1 unless TOKEN_ENC_WRITE_VERSION=v2 is
// set explicitly. Preview and production currently share token rows, so a
// preview must never write a format that the still-live production revision
// cannot read. Ship this dual reader first; enable v2 writes only after every
// live and rollback revision can read v2. Keep the same active key throughout
// that reader-first phase.
//
// TOKEN_ENC_KEY is the active 256-bit key. TOKEN_ENC_KEY_PREVIOUS is an
// optional comma-separated list of earlier keys kept only during rotation.
// The key_id is a non-secret SHA-256 fingerprint used to select a key without
// trial-decrypting. Legacy enc:v1 values have no key id, so decryptSecret()
// tries the active key and then each previous key until one authenticates.
//
// Plaintext rows from before encryption remain readable. In production,
// however, new secret writes fail closed if the active key is absent or
// malformed; silently persisting a new plaintext OAuth token is not an
// acceptable fallback. Local/test environments retain the original no-key
// passthrough so development fixtures do not require production secrets.
import crypto from 'node:crypto';

const V1_PREFIX = 'enc:v1:';
const V2_PREFIX = 'enc:v2:';

function decodeKey(raw, envName) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const buf = /^[0-9a-fA-F]{64}$/.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64');
  if (buf.length !== 32) {
    throw new Error(`${envName} must decode to 32 bytes (got ${buf.length}). Use a base64 or hex 256-bit key.`);
  }
  return buf;
}

function keyId(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function getKeyring() {
  const active = decodeKey(process.env.TOKEN_ENC_KEY, 'TOKEN_ENC_KEY');
  const previousRaw = String(process.env.TOKEN_ENC_KEY_PREVIOUS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const previous = previousRaw.map((value, index) =>
    decodeKey(value, `TOKEN_ENC_KEY_PREVIOUS entry ${index + 1}`));

  const seen = new Set();
  const all = [active, ...previous].filter(Boolean).filter((key) => {
    const id = keyId(key);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return { active, all };
}

function deployedEncryptionRequired() {
  return process.env.VERCEL_ENV === 'production' ||
    process.env.VERCEL_ENV === 'preview' ||
    process.env.NODE_ENV === 'production';
}

function writeEnvelopeVersion() {
  const requested = String(process.env.TOKEN_ENC_WRITE_VERSION || 'v1').trim().toLowerCase();
  if (requested !== 'v1' && requested !== 'v2') {
    throw new Error('TOKEN_ENC_WRITE_VERSION must be v1 or v2. Leave it unset for the reader-first v1 rollout.');
  }
  return requested;
}

function decryptWithKey({ key, iv, tag, ciphertext }) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function canonicalBase64(value) {
  try {
    return Buffer.from(value, 'base64').toString('base64') === value;
  } catch {
    return false;
  }
}

// A raw provider credential may legitimately start with "enc:v1:" or
// "enc:v2:". Only strings with the exact envelope structure emitted here are
// treated as ciphertext for fail-closed error handling.
function hasEnvelopeShape(value) {
  if (value.startsWith(V2_PREFIX)) {
    const parts = value.slice(V2_PREFIX.length).split(':');
    return parts.length === 4 && /^[0-9a-f]{16}$/.test(parts[0]) &&
      canonicalBase64(parts[1]) && Buffer.from(parts[1], 'base64').length === 12 &&
      canonicalBase64(parts[2]) && Buffer.from(parts[2], 'base64').length === 16 &&
      canonicalBase64(parts[3]);
  }
  const parts = value.slice(V1_PREFIX.length).split(':');
  return parts.length === 3 &&
    canonicalBase64(parts[0]) && Buffer.from(parts[0], 'base64').length === 12 &&
    canonicalBase64(parts[1]) && Buffer.from(parts[1], 'base64').length === 16 &&
    canonicalBase64(parts[2]);
}

function envelopeUsesActiveKey(value, active) {
  if (value.startsWith(V2_PREFIX)) {
    return value.slice(V2_PREFIX.length).split(':', 1)[0] === keyId(active);
  }
  const [ivB64, tagB64, ciphertextB64] = value.slice(V1_PREFIX.length).split(':');
  try {
    decryptWithKey({
      key: active,
      iv: Buffer.from(ivB64, 'base64'),
      tag: Buffer.from(tagB64, 'base64'),
      ciphertext: Buffer.from(ciphertextB64, 'base64'),
    });
    return true;
  } catch {
    return false;
  }
}

export function isEncrypted(value) {
  return typeof value === 'string' && (value.startsWith(V1_PREFIX) || value.startsWith(V2_PREFIX));
}

export function encryptSecret(plain) {
  if (plain == null) return plain;

  const { active } = getKeyring();
  if (!active) {
    if (deployedEncryptionRequired()) {
      throw new Error('TOKEN_ENC_KEY is required for secret writes in deployed environments. Restore the backed-up key before retrying.');
    }
    return plain;
  }

  const writeVersion = writeEnvelopeVersion();
  let cleartext = plain;
  if (isEncrypted(plain)) {
    // Prefixes alone are not proof of encryption: mailbox passwords and OAuth
    // tokens are opaque strings and may legitimately begin with "enc:v1:" or
    // "enc:v2:". Preserve an envelope only when it authenticates with a
    // configured key; otherwise treat the entire input as raw secret text.
    const strictEnvelope = hasEnvelopeShape(plain);
    try {
      cleartext = decryptSecret(plain);
      const sameVersion = (writeVersion === 'v1' && plain.startsWith(V1_PREFIX)) ||
        (writeVersion === 'v2' && plain.startsWith(V2_PREFIX));
      if (sameVersion && envelopeUsesActiveKey(plain, active)) return plain;
    } catch (error) {
      // A real-looking envelope with a missing/wrong key must never be wrapped
      // as raw text: one decrypt would then yield only the inner ciphertext.
      if (strictEnvelope) throw error;
      // Not an authenticated envelope. Encrypt it below like any other input.
    }
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', active, iv);
  const ciphertext = Buffer.concat([cipher.update(String(cleartext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (writeVersion === 'v2') {
    return [V2_PREFIX + keyId(active), iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
  }
  return [V1_PREFIX.slice(0, -1), iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

export function decryptSecret(value) {
  if (!isEncrypted(value)) return value; // Legacy plaintext stays readable.

  const { active, all } = getKeyring();
  if (!active && all.length === 0) {
    throw new Error('TOKEN_ENC_KEY is not set but encrypted data was found. Restore TOKEN_ENC_KEY (or a rotation key in TOKEN_ENC_KEY_PREVIOUS).');
  }

  if (value.startsWith(V2_PREFIX)) {
    const parts = value.slice(V2_PREFIX.length).split(':');
    if (parts.length !== 4) throw new Error('Malformed enc:v2 secret value.');
    const [wantedId, ivB64, tagB64, ciphertextB64] = parts;
    const key = all.find((candidate) => keyId(candidate) === wantedId);
    if (!key) {
      throw new Error(`No configured TOKEN_ENC_KEY matches encrypted key id ${wantedId}. Restore that key in TOKEN_ENC_KEY_PREVIOUS.`);
    }
    try {
      return decryptWithKey({
        key,
        iv: Buffer.from(ivB64, 'base64'),
        tag: Buffer.from(tagB64, 'base64'),
        ciphertext: Buffer.from(ciphertextB64, 'base64'),
      });
    } catch {
      throw new Error('Encrypted secret authentication failed; ciphertext or key is invalid.');
    }
  }

  const parts = value.slice(V1_PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('Malformed enc:v1 secret value.');
  const [ivB64, tagB64, ciphertextB64] = parts;
  for (const key of all) {
    try {
      return decryptWithKey({
        key,
        iv: Buffer.from(ivB64, 'base64'),
        tag: Buffer.from(tagB64, 'base64'),
        ciphertext: Buffer.from(ciphertextB64, 'base64'),
      });
    } catch {
      // Legacy v1 has no key id. Try the next explicitly configured key.
    }
  }
  throw new Error('Unable to decrypt enc:v1 secret with TOKEN_ENC_KEY or TOKEN_ENC_KEY_PREVIOUS. Restore the key used for this row.');
}
