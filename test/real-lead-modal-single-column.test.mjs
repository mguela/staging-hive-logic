// test/real-lead-modal-single-column.test.mjs
// jomell, 2026-08-24: opened the Real Lead card for "jovie folloso" and every
// field was squeezed into a narrow strip on the left, with a large blank gap
// beside it -- confirmed by rebuilding the exact modal in a standalone
// harness (screenshot matched the report pixel-for-pixel).
//
// Root cause: #rlv-lead-modal reuses .nl/.nl-body/.fwrap from the New Lead
// modal, whose .fwrap is a two-column grid (`1fr 340px`) for a main column
// plus a 340px sidebar. The Real Lead modal only ever renders ONE .sec into
// .fwrap -- it has no sidebar content -- but CSS Grid still reserves the
// second column's width even with nothing placed in it, so the one real
// column got squeezed into whatever space was left over.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');

test('#rlv-lead-modal has its own single-column override for .fwrap', () => {
  assert.match(source, /#rlv-lead-modal\s+\.fwrap\s*\{\s*grid-template-columns\s*:\s*1fr\s*\}/,
    'without this, .fwrap\'s shared two-column grid (1fr 340px) reserves an empty 340px column here');
});

test('the override is not accidentally scoped to the shared New Lead modal too', () => {
  // A selector of just `.fwrap{grid-template-columns:1fr}` (no #rlv-lead-modal
  // prefix) would also collapse the New Lead modal's intentional two-column
  // layout at every width, not just this one modal.
  const genericOverride = /(?<!#rlv-lead-modal\s)\.fwrap\s*\{\s*grid-template-columns\s*:\s*1fr\s*\}(?!\s*\})/g;
  const matches = source.match(genericOverride) || [];
  // The existing @media(max-width:900px) rule legitimately collapses .fwrap
  // to one column on narrow screens for BOTH modals -- that one is expected
  // and is inside a media query, not a bare top-level rule. Only flag a bare,
  // unscoped, non-media override, since that would defeat the New Lead
  // modal's sidebar at desktop widths too.
  const bareTopLevel = matches.filter((m) => {
    const idx = source.indexOf(m);
    const before = source.slice(Math.max(0, idx - 60), idx);
    return !/@media[^{]*\{[^}]*$/.test(before);
  });
  assert.equal(bareTopLevel.length, 0,
    'a bare (non-media, non-scoped) .fwrap single-column override would break the New Lead modal\'s two-column layout');
});

test('#rlv-lead-modal still only renders one .sec (confirms it genuinely has no sidebar content)', () => {
  const start = source.indexOf('id="rlv-lead-modal"');
  assert.ok(start > -1, '#rlv-lead-modal must exist');
  const end = source.indexOf('id="ldv"', start); // next modal down in the file
  const modalHtml = source.slice(start, end > -1 ? end : start + 4000);
  const secCount = (modalHtml.match(/class="sec"/g) || []).length;
  assert.equal(secCount, 1,
    'this test\'s premise (single-column by design) only holds if the modal truly has one .sec -- if a second one was added, the real fix is proper two-column content, not this override');
});
