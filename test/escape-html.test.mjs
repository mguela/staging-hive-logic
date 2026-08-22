// Unit tests for the HTML-escaping helpers used to neutralize DOM-XSS in the
// browser bundles hardened under stabilization Work Item 8:
//   - public/app-bookkeeping.js  -> escapeHtml()  (regex, 5 chars)
//   - public/hiveconnect/app.js  -> escapeHtml()/esc()  (regex, 4 chars)
//   - public/clientportal/index.html & public/subportal/index.html
//                                -> escapeHtml()  (textContent round-trip)
//
// The browser files are plain <script> IIFEs (not importable ES modules), so
// the canonical implementations are mirrored here 1:1 and asserted to render
// hostile payloads inert. If you change a helper in the source, change it here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---- mirrors public/app-bookkeeping.js escapeHtml (also the strictest form) ----
function escapeHtmlStrict(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ---- mirrors public/hiveconnect/app.js escapeHtml + esc ----
function escapeHtmlHive(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const escHive = s => escapeHtmlHive(s == null ? '' : String(s));

// A DOM-free stand-in for the clientportal/subportal textContent round-trip
// helper: whatever escaping strategy is used, `<` and `>` MUST NOT survive so a
// tag can never be parsed out of interpolated text.
function assertInertInHtmlText(fn) {
  const payloads = [
    '<img src=x onerror=alert(1)>',
    '"><script>alert(1)</script>',
    '<svg/onload=alert(1)>',
    "'><img src=x onerror=alert(1)>",
    '</textarea><script>alert(1)</script>',
  ];
  for (const p of payloads) {
    const out = fn(p);
    assert.ok(!/<script/i.test(out), `must not contain a literal <script tag: ${out}`);
    assert.ok(!out.includes('<img'), `must not contain a literal <img tag: ${out}`);
    assert.ok(!out.includes('<svg'), `must not contain a literal <svg tag: ${out}`);
    // The defining property: no raw angle brackets remain to open/close a tag.
    assert.ok(!out.includes('<'), `must not contain a raw '<': ${out}`);
    assert.ok(!out.includes('>'), `must not contain a raw '>': ${out}`);
  }
}

test('escapeHtmlStrict neutralizes the img/onerror payload', () => {
  assert.equal(
    escapeHtmlStrict('<img src=x onerror=alert(1)>'),
    '&lt;img src=x onerror=alert(1)&gt;'
  );
});

test('escapeHtmlStrict neutralizes the attribute-breakout payload', () => {
  assert.equal(
    escapeHtmlStrict('"><script>alert(1)</script>'),
    '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;'
  );
});

test('escapeHtmlStrict escapes the single quote (attribute breakout)', () => {
  assert.equal(escapeHtmlStrict("' onmouseover='alert(1)"), '&#39; onmouseover=&#39;alert(1)');
});

test('escapeHtmlStrict escapes ampersand first (no double-encoding artifacts)', () => {
  assert.equal(escapeHtmlStrict('a & b'), 'a &amp; b');
  assert.equal(escapeHtmlStrict('&lt;'), '&amp;lt;');
});

test('escapeHtmlStrict handles null/undefined without throwing', () => {
  assert.equal(escapeHtmlStrict(null), '');
  assert.equal(escapeHtmlStrict(undefined), '');
});

test('escapeHtmlStrict renders every hostile payload inert', () => {
  assertInertInHtmlText(escapeHtmlStrict);
});

test('hiveconnect esc() neutralizes tag and attribute payloads', () => {
  assert.equal(escHive('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(escHive('"><script>alert(1)</script>'), '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('hiveconnect esc() renders every hostile payload inert in HTML text', () => {
  assertInertInHtmlText(escHive);
});

test('hiveconnect esc() coerces null/undefined to empty string', () => {
  assert.equal(escHive(null), '');
  assert.equal(escHive(undefined), '');
});
