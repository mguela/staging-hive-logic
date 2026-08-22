#!/usr/bin/env node
// Generates public/hiveconnect/styles-scoped.css from public/hiveconnect/styles.css.
//
// HiveConnect is embedded into the HiveLogic host page in the light DOM -- no
// iframe, no Shadow DOM -- so its stylesheet cannot be allowed to match host
// elements. styles.css is written as if HiveConnect owned the document;
// this rewrites every selector in it to match only inside #hiveconnect-root,
// or on an element carrying .hc-embed.
//
// styles-scoped.css has carried an "AUTO-GENERATED ... by scope-css.mjs" header
// since it was introduced, but the script it names was never committed, so the
// file was hand-synced instead -- and drifted. This is that script, written
// against the transform the committed file actually demonstrates.
//
//   node scripts/scope-css.mjs           # regenerate
//   node scripts/scope-css.mjs --check   # exit 1 if the committed file is stale
//
// The rules below are derived from the committed output, not invented:
//
//   :root                  -> #hiveconnect-root, .hc-embed
//   html / body            -> #hiveconnect-root          (see BODY_ONLY_ROOT)
//   *                      -> ROOT, ROOT *
//   .thing                 -> ROOT .thing, ROOT.thing    (may BE the root)
//   button                 -> ROOT button                (cannot be the root)
//   html[data-theme=...] X -> html[data-theme=...] ROOT X (host stays outside)
//
// @keyframes bodies are left alone -- `from`, `to` and percentage stops are not
// selectors. @media bodies are scoped normally.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = ':is(#hiveconnect-root, .hc-embed)';
const HEADER = `/* AUTO-GENERATED from styles.css by scope-css.mjs — do not hand-edit.
   Scoped so HiveConnect's styles apply ONLY inside #hiveconnect-root or on
   .hc-embed-tagged elements. Regenerate after any styles.css change. */
`;

// `html, body { height: 100% }` and friends must scope to #hiveconnect-root and
// NOT to .hc-embed. .hc-embed is also stamped onto small body-appended overlays
// -- toasts, dropdown menus, modals, incoming-call cards (hiveconnect-mount.js's
// HC_BODY_ROOTS) -- and root-level height/overflow rules force-stretched those
// to fill the whole viewport. This exception is the fix for that incident, and
// styles.css carries a comment at the rule warning about it.
const BODY_ONLY_ROOT = new Set(['html', 'body']);

// A selector whose leftmost compound could match the root element itself needs
// a second, non-descendant form: .hc-embed IS the element in the overlay case.
// A type selector cannot be the root, so it gets the descendant form only.
function canBeRootItself(selector) {
  // A pseudo-ELEMENT is not a compound the root could match -- `ROOT::-webkit-
  // scrollbar` styles the root's own scrollbar, which is not what
  // `::-webkit-scrollbar` inside the app means. The committed output agrees:
  // it emits the descendant form only.
  if (selector.startsWith('::')) return false;
  return /^[.#\[:]/.test(selector);
}

// Rules living under `html[data-theme="dark"]` (or any html-level prefix) must
// keep that prefix OUTSIDE the scope: the theme attribute is on the host's
// documentElement, which is by definition not inside #hiveconnect-root.
const HTML_PREFIX = /^(html(?:\[[^\]]*\])*)\s*/;

function scopeOne(selector) {
  const trimmed = selector.trim();
  if (!trimmed) return [];
  if (trimmed === ':root') return ['#hiveconnect-root', '.hc-embed'];
  if (BODY_ONLY_ROOT.has(trimmed)) return ['#hiveconnect-root'];
  if (trimmed === '*') return [ROOT, `${ROOT} *`];

  const html = HTML_PREFIX.exec(trimmed);
  if (html) {
    const prefix = html[1];
    const rest = trimmed.slice(html[0].length).trim();
    if (!rest || BODY_ONLY_ROOT.has(rest)) {
      return [`${prefix} #hiveconnect-root`, `${prefix} .hc-embed`];
    }
    const forms = [`${prefix} ${ROOT} ${rest}`];
    if (canBeRootItself(rest)) forms.push(`${prefix} ${ROOT}${rest}`);
    return forms;
  }

  const forms = [`${ROOT} ${trimmed}`];
  if (canBeRootItself(trimmed)) forms.push(`${ROOT}${trimmed}`);
  return forms;
}

// Split a selector list on commas that are at nesting depth zero, so
// `:is(a, b) .c, .d` splits into two selectors and not four.
function splitSelectorList(prelude) {
  const parts = [];
  let depth = 0;
  let buffer = '';
  for (const char of prelude) {
    if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth -= 1;
    if (char === ',' && depth === 0) { parts.push(buffer); buffer = ''; continue; }
    buffer += char;
  }
  parts.push(buffer);
  return parts;
}

function scopeSelectorList(prelude) {
  const seen = new Set();
  const out = [];
  for (const part of splitSelectorList(prelude)) {
    for (const scoped of scopeOne(part)) {
      if (seen.has(scoped)) continue;
      seen.add(scoped);
      out.push(scoped);
    }
  }
  return out.join(',\n');
}

// Walks the stylesheet preserving comments and whitespace, transforming only
// the selector preludes of style rules. Deliberately not a full CSS parser: it
// tracks strings, comments and brace depth, which is all this stylesheet needs.
function transform(css) {
  let out = '';
  let i = 0;

  const readBlock = (start) => {
    // start points at '{'. Returns the index just past the matching '}'.
    let depth = 0;
    let j = start;
    while (j < css.length) {
      const char = css[j];
      if (char === '/' && css[j + 1] === '*') { j = css.indexOf('*/', j + 2) + 2 || css.length; continue; }
      if (char === '"' || char === "'") {
        const quote = char;
        j += 1;
        while (j < css.length && css[j] !== quote) { if (css[j] === '\\') j += 1; j += 1; }
      } else if (char === '{') depth += 1;
      else if (char === '}') { depth -= 1; if (depth === 0) return j + 1; }
      j += 1;
    }
    return css.length;
  };

  while (i < css.length) {
    // Comments and whitespace pass through untouched.
    if (css[i] === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      const stop = end === -1 ? css.length : end + 2;
      out += css.slice(i, stop);
      i = stop;
      continue;
    }
    if (/\s/.test(css[i])) { out += css[i]; i += 1; continue; }

    // Accumulate a prelude up to '{' (a block) or ';' (a bare at-statement).
    let j = i;
    while (j < css.length && css[j] !== '{' && css[j] !== ';') {
      if (css[j] === '/' && css[j + 1] === '*') { const e = css.indexOf('*/', j + 2); j = e === -1 ? css.length : e + 2; continue; }
      j += 1;
    }
    if (j >= css.length) { out += css.slice(i); break; }

    if (css[j] === ';') { out += css.slice(i, j + 1); i = j + 1; continue; }

    const prelude = css.slice(i, j);
    const blockEnd = readBlock(j);
    const body = css.slice(j + 1, blockEnd - 1);
    const name = prelude.trim();

    if (/^@keyframes/i.test(name) || /^@font-face/i.test(name)) {
      // Not selectors. Emit verbatim.
      out += css.slice(i, blockEnd);
    } else if (/^@/.test(name)) {
      // @media, @supports: the prelude is a condition, the body holds rules.
      out += `${prelude}{${transform(body)}}`;
    } else {
      // Preserve the source's own spacing before the brace. styles.css mixes
      // `.foo { ... }` and minified `.foo{...}`, and reformatting it would
      // churn the artifact -- and break assertions elsewhere that match the
      // compact form literally.
      const gap = /\s*$/.exec(prelude)[0];
      out += `${scopeSelectorList(prelude)}${gap}{${body}}`;
    }
    i = blockEnd;
  }
  return out;
}

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(here, '..', 'public', 'hiveconnect', 'styles.css');
const outputPath = join(here, '..', 'public', 'hiveconnect', 'styles-scoped.css');

export function generate(css) {
  return HEADER + transform(css).replace(/^\s*\n/, '');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const generated = generate(readFileSync(sourcePath, 'utf8'));
  if (process.argv.includes('--check')) {
    const committed = readFileSync(outputPath, 'utf8');
    if (committed === generated) {
      console.log('styles-scoped.css is up to date.');
      process.exit(0);
    }
    console.error('styles-scoped.css is STALE. Run: node scripts/scope-css.mjs');
    process.exit(1);
  }
  writeFileSync(outputPath, generated);
  console.log(`scoped ${sourcePath} -> ${outputPath} (${generated.length} bytes).`);
}
