// test/hivedoc-files-contract.test.mjs
//
// api/_lib/hivedoc-files.js is the one way into HiveDoc's `docs` bucket, shared
// by api/invites.js (onboarding licences) and api/subportal.js (sub compliance
// docs and invoices). Its primitives sit directly on two attack surfaces:
// values that reach us from a browser go into a storage PATH, and bytes that
// reach us from a browser get a CONTENT TYPE that a signed URL will later serve
// back. So they get their own tests rather than only being exercised through
// the two callers.
//
// Run: node --test test/hivedoc-files-contract.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOCS_BUCKET, MAX_UPLOAD_BYTES, isAllowedUploadType, extensionFor, safeSegment, decodeDataUrl,
} from '../api/_lib/hivedoc-files.js';

const dataUrl = (type, body) => 'data:' + type + ';base64,' + Buffer.from(body).toString('base64');

test('the bucket is the one that exists', () => {
  // Six buckets exist on production, verified 2026-08-22. This module must
  // never be the place a seventh name gets invented.
  assert.equal(DOCS_BUCKET, 'docs');
});

// ---------- path segments ----------

test('a segment cannot contain a separator', () => {
  for (const evil of ['../../media/x', 'a/b', 'a\\b', 'a%2Fb']) {
    const out = safeSegment(evil);
    assert.doesNotMatch(out, /[/\\]/, evil);
    assert.doesNotMatch(out, /%2f/i, evil);
  }
});

test('no `..` survives anywhere in a segment', () => {
  for (const evil of ['..', '...', '../x', 'a..b', 'x..']) {
    assert.doesNotMatch(safeSegment(evil), /\.\./, evil);
  }
});

test('a segment that sanitises to nothing falls back rather than collapsing the path', () => {
  // '' would produce `subs/documents/sub-1//1234.pdf` -- a double slash, which
  // is a different object than intended and may not be addressable at all.
  assert.equal(safeSegment('..'), 'file');
  assert.equal(safeSegment(''), 'file');
  assert.equal(safeSegment(null), 'file');
  assert.equal(safeSegment(undefined, 'invoice'), 'invoice');
});

test('ordinary names come through recognisable', () => {
  assert.equal(safeSegment('IMG_4821.HEIC'), 'IMG_4821.HEIC');
  assert.equal(safeSegment('w9'), 'w9');
  assert.equal(safeSegment('Certificate of Insurance'), 'Certificate_of_Insurance');
});

test('a segment is bounded', () => {
  assert.ok(safeSegment('a'.repeat(500)).length <= 80);
});

// ---------- content types ----------

test('only documents and photos are accepted', () => {
  for (const ok of ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic']) {
    assert.ok(isAllowedUploadType(ok), ok);
  }
});

test('anything that executes when opened is refused', () => {
  // These would be served from a signed URL on the storage origin.
  for (const bad of ['text/html', 'image/svg+xml', 'application/javascript', 'text/xml', '', null]) {
    assert.equal(isAllowedUploadType(bad), false, String(bad));
  }
});

test('the allowlist is not case- or whitespace-sensitive', () => {
  assert.ok(isAllowedUploadType(' Application/PDF '));
});

test('every accepted type has a real extension', () => {
  for (const ok of ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif']) {
    assert.notEqual(extensionFor(ok), 'bin', ok + ' should map to something openable');
  }
  assert.equal(extensionFor('application/x-nonsense'), 'bin');
});

// ---------- decoding ----------

test('a well-formed data URL decodes to its bytes', () => {
  const { contentType, buffer } = decodeDataUrl(dataUrl('application/pdf', '%PDF-1.4'));
  assert.equal(contentType, 'application/pdf');
  assert.equal(buffer.toString(), '%PDF-1.4');
});

test('a base64 payload wrapped across lines still decodes', () => {
  // Phone cameras and some HTTP clients wrap long base64 at a fixed column, so
  // the newlines arrive inside the payload. Node's Buffer ignores them, which
  // means this works today by inheritance rather than by decision -- and a
  // future hand-rolled decoder would break licence and COI uploads from exactly
  // the devices the field uses, with no test to say so.
  const { contentType, buffer } = decodeDataUrl('data:image/jpeg;base64,SGVsbG8g\nV29ybGQ=');
  assert.equal(contentType, 'image/jpeg');
  assert.equal(buffer.toString('utf8'), 'Hello World');
});

test('a disallowed type is refused at decode, before anything is uploaded', () => {
  assert.throws(() => decodeDataUrl(dataUrl('text/html', '<script>')), /not accepted/i);
});

test('an oversized file is refused at decode', () => {
  const big = dataUrl('application/pdf', Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x41));
  assert.throws(() => decodeDataUrl(big), /too large/i);
});

test('an empty file is refused', () => {
  assert.throws(() => decodeDataUrl('data:application/pdf;base64,'), /Expected a base64 data URL/);
});

test('a non-data-URL is refused', () => {
  for (const bad of ['https://evil.test/x.pdf', 'not a url', '', null, undefined]) {
    assert.throws(() => decodeDataUrl(bad), /Expected a base64 data URL/, String(bad));
  }
});

test('decode errors are safe to show whoever uploaded', () => {
  // These messages reach a subcontractor, who is outside the company. The
  // original bug was handing that person a raw Supabase error.
  for (const bad of [dataUrl('text/html', 'x'), 'nonsense', dataUrl('application/pdf', Buffer.alloc(MAX_UPLOAD_BYTES + 1))]) {
    try { decodeDataUrl(bad); assert.fail('should have thrown'); }
    catch (e) {
      assert.doesNotMatch(e.message, /bucket|supabase|docs\/|service|key/i, e.message);
    }
  }
});
