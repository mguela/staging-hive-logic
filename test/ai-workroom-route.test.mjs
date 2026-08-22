import assert from 'node:assert/strict';
import fs from 'node:fs';
const index = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
assert.doesNotMatch(index, /id="nav-workroom"|id="view-workroom"|src="app-ai-workroom\.js"/);
assert.doesNotMatch(index, /HL_ROUTE_VIEWS[^;]*'workroom'/);
assert.match(index, /if\(code==='workroom'\)\{ code='council'; h='#\/council'; \}/);
assert.match(index, /history\.replaceState\(\{\s*hlView:code,\s*hlDepth:depth\s*\},\s*'',\s*h\)/);
assert.match(index, /id="nav-council" onclick="showView\('council'\)"/);
console.log('Retired AI Workroom routes safely into The Boardroom');
