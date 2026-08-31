// test/no-entity-corruption.test.mjs
//
// Guards two frontend-source invariants that have each caused silent
// blank-screen incidents:
//
// 1) 2026-08-03 (round 1): a patch HTML-escaped "&" inside plain JS string
//    literals, so fetch URLs went out as "/api/qbo?...&amp;kind=..." in
//    contexts where browsers do NOT decode entities. Test 1 forbids entities
//    inside quoted /api/ URLs.
//
// 2) 2026-08-03 (round 2, the real P&L outage): HiveLogic views are whole
//    iframe documents stored HTML-escaped inside data-hl63 attributes
//    (loader: f.srcdoc = f.getAttribute('data-hl63')). Inside those
//    attributes "&amp;"/"&quot;" is CORRECT escaping — the failure mode is a
//    view script that doesn't run: a syntax error after decoding, or a bare
//    `sb.` reference with no definition (iframes don't inherit parent
//    globals; ReferenceError froze the P&L view on its loading text).
//    Tests 3-5 decode every data-hl63 attribute exactly like the browser
//    and assert its scripts parse and its supabase references resolve.
//
// Plus the recurring Windows-1252 mojibake sweep ("ΓÇ" from em-dashes
// mangled in transport).
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Root cause of the 5 Windows-only failures this file used to produce
// (2026-08-27): URL.prototype.pathname never decodes percent-escapes --
// on a checkout under a directory with a space in it (e.g. "Personal
// Projects"), it returned literally ".../Personal%20Projects/..." and
// every fs call built from ROOT then 404'd against a path that does not
// exist. fileURLToPath() is the actual, correct way to turn a file: URL
// into a filesystem path (it decodes percent-escapes AND handles the
// Windows drive-letter form), so this needs no hand-rolled regex at all.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AMP = String.fromCharCode(38);
const DQ = String.fromCharCode(34);

function frontendFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!/node_modules|\.git|dist/.test(f)) walk(f);
      } else if (/\.(html|js)$/i.test(e.name)) out.push(f);
    }
  };
  walk(path.join(ROOT, 'public'));
  return out;
}

function decodeAttr(v) {
  return v.split(AMP + 'quot;').join(DQ)
          .split(AMP + '#39;').join("'")
          .split(AMP + 'lt;').join('<')
          .split(AMP + 'gt;').join('>')
          .split(AMP + 'amp;').join(AMP);
}

// [start, end] raw-text ranges of every data-hl63 attribute VALUE in s
function hl63Ranges(s) {
  const ranges = [];
  let pos = 0;
  while (true) {
    const at = s.indexOf('data-hl63=' + DQ, pos);
    if (at < 0) break;
    const q0 = at + 'data-hl63='.length;
    const q1 = s.indexOf(DQ, q0 + 1); // raw " must never appear inside the value
    if (q1 < 0) break;
    ranges.push([q0 + 1, q1]);
    pos = q1 + 1;
  }
  return ranges;
}

function scriptsOf(doc) {
  const out = [];
  let p = 0;
  while (true) {
    const a = doc.indexOf('<script', p); if (a < 0) break;
    const te = doc.indexOf('>', a);
    const b = doc.indexOf('</' + 'script>', a); if (b < 0) break;
    out.push({ tag: doc.slice(a, te + 1), body: doc.slice(te + 1, b), at: a });
    p = b + 9;
  }
  return out;
}

test('no HTML entities inside quoted /api/ URLs in frontend source', () => {
  // A data-hl63 attribute is the one place "&amp;" IS the correct text (see
  // header comment #2): the attribute decode (pass 1) turns it into a real
  // "&" before that text ever becomes the inner document's <script> content,
  // which is exactly what decodeAttr()/hl63Ranges() below model. This check
  // is about the OTHER case -- a REAL top-level script, which gets no such
  // decode and would send the literal text "&amp;" out over the wire.
  const bad = [];
  for (const f of frontendFiles()) {
    const s = fs.readFileSync(f, 'utf8');
    const attrRanges = path.basename(f) === 'index.html' ? hl63Ranges(s) : [];
    const inAttr = (i) => attrRanges.some(r => i >= r[0] && i < r[1]);
    const re = /['"`](\/api\/[^'"`]*?&(?:amp|lt|gt|quot|#39);[^'"`]*?)['"`]/g;
    let m;
    while ((m = re.exec(s))) {
      if (inAttr(m.index)) continue;
      bad.push(path.relative(ROOT, f) + ' -> ' + m[1].slice(0, 90));
    }
  }
  assert.deepStrictEqual(bad, [],
    'HTML entities found inside JS /api/ URL strings (browsers do not decode entities in <script>; requests go out corrupted):\n' + bad.join('\n'));
});

test('every REAL top-level inline <script> in public/index.html parses as JavaScript', () => {
  const s = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const attrRanges = hl63Ranges(s);
  const inAttr = (i) => attrRanges.some(r => i >= r[0] && i < r[1]);
  const errs = [];
  for (const sc of scriptsOf(s)) {
    if (inAttr(sc.at)) continue;               // attribute content is checked decoded, below
    if (/\bsrc=/.test(sc.tag) || !sc.body.trim()) continue;
    try { new Function(sc.body); } catch (e) { errs.push('script @' + sc.at + ': ' + e.message); }
  }
  assert.deepStrictEqual(errs, [],
    'Top-level inline script block(s) with syntax errors:\n' + errs.join('\n'));
});

test('every data-hl63 view decodes to scripts that parse as JavaScript', () => {
  const s = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const errs = [];
  for (const [a, b] of hl63Ranges(s)) {
    const dec = decodeAttr(s.slice(a, b));
    for (const sc of scriptsOf(dec)) {
      if (!sc.body.trim()) continue;
      try { new Function(sc.body); } catch (e) { errs.push('view attr @' + a + ': ' + e.message); }
    }
  }
  assert.deepStrictEqual(errs, [],
    'data-hl63 view script(s) fail to parse AFTER attribute decoding (the view will die at load):\n' + errs.join('\n'));
});

test('no data-hl63 view uses bare `sb` without defining it (iframes do not inherit parent globals)', () => {
  const s = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const bad = [];
  for (const [a, b] of hl63Ranges(s)) {
    const dec = decodeAttr(s.slice(a, b));
    const usesBare = /[^.\w]sb\.(auth|from|rpc|storage)/.test(dec);
    const defines = /(var|let|const)\s+sb\s*=|window\.sb\s*=/.test(dec);
    if (usesBare && !defines) bad.push('view attr @' + a);
  }
  assert.deepStrictEqual(bad, [],
    'View(s) reference bare `sb` with no definition — inside the iframe this is a ReferenceError and the view freezes on its loading text. Add: var sb = window.parent.sb;\n' + bad.join('\n'));
});

test('no Windows-1252 mojibake sequences in frontend source', () => {
  const bad = [];
  for (const f of frontendFiles()) {
    const s = fs.readFileSync(f, 'utf8');
    let idx = -1;
    while ((idx = s.indexOf('ΓÇ', idx + 1)) >= 0) {
      bad.push(path.relative(ROOT, f) + ' @' + idx + ' ...' + s.slice(Math.max(0, idx - 30), idx + 10).replace(/\s+/g, ' '));
      if (bad.length > 20) break;
    }
  }
  assert.deepStrictEqual(bad, [],
    'Mojibake (mangled em-dash/quote sequences) found in frontend source:\n' + bad.join('\n'));
});
