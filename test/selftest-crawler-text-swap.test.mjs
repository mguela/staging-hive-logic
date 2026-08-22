import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Found 2026-08-22, investigating vcx's "Search" reading NO_OUTCOME: clicking
// Search with an empty query box swaps the results panel's ONE child <div>
// for a different <div> with different wording ("Type a material above and
// hit Search..." -> "Type a material to search.") -- a real, deliberate
// message the app shows on purpose (live-confirmed against production via
// the Claude Browser tools). That's exactly one childList mutation record:
// docFp (element COUNT) is unchanged -- one div swapped for one div -- and
// muts=1 sits nowhere near the existing muts>3 threshold (which exists
// specifically so a busy live-updating view doesn't false-positive on an
// inert click; raising it was already tried and rejected elsewhere in this
// file). textAmongMutations() compares the removed vs. added nodes' own
// text, not a page-wide snapshot, so it isn't exposed to an unrelated
// background ticker drifting between two time-separated reads the way a
// page-wide text fingerprint would be.
const src = readFileSync(new URL('../public/tools/selftest.js', import.meta.url), 'utf8');

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start > -1, `${signature} must exist`);
  let depth = 0, i = source.indexOf('{', start);
  do {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  } while (depth > 0 && i < source.length);
  assert.equal(depth, 0, 'braces must balance');
  return source.slice(start, i);
}

const textAmongMutationsSrc = extractFunction(src, 'function textAmongMutations(mutRecords)');
function runTextAmongMutations(mutRecords) {
  const ctx = vm.createContext({ result: undefined });
  ctx.__records = mutRecords;
  vm.runInContext(`${textAmongMutationsSrc}\nresult = textAmongMutations(__records);`, ctx);
  return ctx.result;
}
function fakeNode(text) { return { textContent: text }; }
function fakeChildListRecord(removedTexts, addedTexts) {
  return { type: 'childList', removedNodes: removedTexts.map(fakeNode), addedNodes: addedTexts.map(fakeNode) };
}

test('a childList mutation that swaps one message for a differently-worded one is detected', () => {
  const records = [fakeChildListRecord(['Type a material above and hit Search…'], ['Type a material to search.'])];
  assert.equal(runTextAmongMutations(records), true);
});

test('a childList mutation that re-renders identical text is not mistaken for a real change', () => {
  const records = [fakeChildListRecord(['Loading…'], ['Loading…'])];
  assert.equal(runTextAmongMutations(records), false);
});

test('an attributes-type mutation is ignored -- this signal only looks at childList records', () => {
  const records = [{ type: 'attributes', attributeName: 'class' }];
  assert.equal(runTextAmongMutations(records), false);
});

test('no mutation records at all is not a change', () => {
  assert.equal(runTextAmongMutations([]), false);
});

test('multiple removed/added nodes are joined before comparing, not compared node-by-node', () => {
  // A real re-render can replace N nodes with a different N nodes; only the
  // combined text matters, not a 1:1 positional match.
  const records = [fakeChildListRecord(['A', 'B'], ['A', 'B', 'C'])];
  assert.equal(runTextAmongMutations(records), true);
  const same = [fakeChildListRecord(['A', 'B'], ['AB'])];
  assert.equal(runTextAmongMutations(same), false);
});

test('textAmongMutations is wired into the moved computation', () => {
  assert.match(src, /textSwapped = textAmongMutations\(mutRecords\)/);
  const movedLine = src.slice(src.indexOf('var moved ='), src.indexOf('\n', src.indexOf('var moved =')));
  assert.match(movedLine, /\|\| textSwapped/);
  // Additive only -- every pre-existing signal must still be present.
  for (const signal of ['aFp !== bFp', 'aAct !== bAct', 'muts > 3', 'opened', 'toastChanged', 'styled', 'switched', 'reordered']) {
    assert.ok(movedLine.includes(signal), `expected the pre-existing "${signal}" signal to still be part of the moved check`);
  }
});
