import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Dev To-Do / self-test reported "Create" as NO_OUTCOME in docs. Live-
// confirmed via the Claude Browser tools: clicking "Create" on the New
// Folder modal with the name field left empty does ABSOLUTELY nothing --
// no error, no toast, the modal just sits there. `if(!name) return;` was a
// silent early return with zero user feedback. Rename and Copy share the
// exact same input-modal pattern and had the identical bug -- fixed all
// three the same way, matching the existing chirpToast('⚠ ...') pattern
// already used one line below for the real Supabase-error case in each.
const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('New Folder, Rename, and Copy no longer silently no-op on an empty name', () => {
  assert.doesNotMatch(page, /var name = document\.getElementById\('hldoc-input-name'\)\.value\.trim\(\);\s*\n\s*if\(!name\) return;/,
    'a bare `if(!name) return;` gives the user zero feedback that anything went wrong');
});

test('all three now show the same "Enter a folder name" toast on an empty name', () => {
  const count = (page.match(/if\(!name\)\{ chirpToast\('⚠ Enter a folder name\.'\); return; \}/g) || []).length;
  assert.equal(count, 3, 'expected New Folder, Rename, and Copy to all get the fix');
});

test('the fix sits inside each function\'s own modal confirm callback, not somewhere unrelated', () => {
  for (const [fn, marker] of [
    ['hlDocNewFolder', "insert({ name: name, parent_id: parentId"],
    ['hlDocRename', "update({ name: name }).eq('id', id)"],
    ['hlDocCopy', 'await hlDocCopyRecursive(src, null, name)'],
  ]) {
    const start = page.indexOf(`function ${fn}(`);
    assert.ok(start > -1, `sanity: ${fn} still exists`);
    const body = page.slice(start, page.indexOf(marker, start) + marker.length);
    assert.match(body, /if\(!name\)\{ chirpToast\('⚠ Enter a folder name\.'\); return; \}/,
      `${fn} must validate the name before proceeding`);
  }
});
