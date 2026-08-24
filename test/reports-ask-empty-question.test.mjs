import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Dev To-Do / self-test reported "Ask" as NO_OUTCOME in reports. Live-
// confirmed via the Claude Browser tools: clicking "Ask" with an empty
// question field changes absolutely nothing -- the answer panel's text is
// byte-identical before and after. `if (!question) return;` was a silent
// early return with zero feedback, the same shape of bug already fixed for
// docs' New Folder/Rename/Copy.
const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('reportsAsk no longer silently no-ops on an empty question', () => {
  const start = page.indexOf('window.reportsAsk = async function()');
  assert.ok(start > -1, 'sanity: reportsAsk still exists');
  const body = page.slice(start, page.indexOf('\n  };', start));
  assert.doesNotMatch(body, /if \(!question\) return;/,
    'a bare early return gives the user zero feedback that anything went wrong');
  assert.match(body, /if \(!question\) \{ out\.className = 'trust'; out\.textContent = 'Type a question first\.'; return; \}/);
});
