import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const [shell, view, client, styles] = await Promise.all([
  readFile('public/index.html', 'utf8'),
  readFile('public/views/reina-council.html', 'utf8'),
  readFile('public/app-reina-council.js', 'utf8'),
  readFile('public/reina-council.css', 'utf8'),
]);

test('Council is a routed Manager view in the existing application shell', () => {
  assert.match(shell, /id="nav-council" onclick="showView\('council'\)"/);
  assert.match(shell, />The Boardroom<\/div>/);
  assert.match(shell, /id="view-council"/);
  assert.match(shell, /"council": "manager"/);
  assert.match(shell, /HL_ROUTE_VIEWS = \[[^\]]*'council'/);
  assert.match(shell, /hlInitReinaCouncil/);
  assert.match(shell, /src="\/app-reina-council\.js"/);
  assert.match(shell, /href="\/reina-council\.css"/);
  assert.match(shell, /Send to Boardroom/);
  assert.match(shell, /hlSendBriefToBoardroom/);
  assert.match(shell, /window\.__hlPendingBoardroomDraft = payload/);
  assert.doesNotMatch(shell, /id="nav-workroom"|id="view-workroom"|src="app-ai-workroom\.js"/);
  assert.match(shell, /if\(code==='workroom'\)\{ code='council'; h='#\/council'; \}/);
  assert.match(shell, /history\.replaceState\(\{\s*hlView:code,\s*hlDepth:depth\s*\},\s*'',\s*h\)/);
});

test('Council composer is one question with an optional file drop and hidden advanced controls', () => {
  for (const id of ['rc-brief', 'rc-drop', 'rc-files', 'rc-attachments', 'rc-rounds', 'rc-tokens', 'rc-cost', 'rc-agent', 'rc-task', 'rc-path']) {
    assert.match(view, new RegExp('id="' + id + '"'));
  }
  assert.match(view, /class="rc-send" id="rc-start" type="submit"[^>]*><span>Send<\/span>/);
  for (const id of ['rc-user-message', 'rc-thinking', 'rc-board-response']) assert.match(view, new RegExp('id="' + id + '"'));
  for (const id of ['rc-time-machine', 'rc-tm-launch', 'rc-tm-panel', 'rc-tm-revenue', 'rc-tm-cost', 'rc-tm-investment', 'rc-tm-ramp', 'rc-tm-futures', 'rc-tm-plan']) assert.match(view, new RegExp('id="' + id + '"'));
  for (const id of ['rc-handoff', 'rc-handoff-label', 'rc-handoff-clear']) assert.match(view, new RegExp('id="' + id + '"'));
  assert.match(view, /<h1 id="rc-title">The Boardroom<\/h1>/);
  for (const id of ['rc-history-title', 'rc-history', 'rc-history-count', 'rc-history-prev', 'rc-history-next', 'rc-history-refresh']) assert.match(view, new RegExp('id="' + id + '"'));
  assert.match(view, /Boardroom conversations/);
  assert.match(view, /Every discussion, provider exchange, cost record, and final Reina recommendation is saved here/);
  for (const id of ['rc-new-conversation', 'rc-show-recent', 'rc-show-pinned', 'rc-project-filter', 'rc-add-project', 'rc-open-settings']) assert.match(view, new RegExp('id="' + id + '"'));
  assert.match(view, /id="rc-rounds"[^>]*min="2"[^>]*value="2"/);
  assert.match(view, /Reina's final recommendation/);
  assert.match(view, /REINA, CHAIRPERSON/);
  assert.doesNotMatch(view, /Ask the Council/);
  assert.match(view, /id="rc-tokens"[^>]*value="700"/);
  assert.match(view, /id="rc-cost"[^>]*value="10"/);
  assert.match(view, /Maximum provider budget/);
  assert.match(view, /\$0\.10 ceiling, actual cost may be lower/);
  assert.match(view, /up to 30 files/);
  assert.match(view, /Drop job photos, plans, PDFs, or files anywhere in this box/);
  assert.match(view, /<details class="rc-advanced">/);
  assert.match(view, /id="rc-definition-of-done"/);
  assert.match(view, /HiveLogic Definition of Done/);
  assert.match(view, /exhaustively tested for its scope and risk/);
  assert.match(view, /merge, deployment, green build, or AI statement is not proof of completion/);
  assert.doesNotMatch(view, /rc-source-id|Every Council claim|Add source/);
  assert.doesNotMatch(view, /id="rc-(?:command|shell|script|args)"/i);
  assert.match(view, /repository_status/);
  assert.match(view, /repository_test/);
  assert.match(styles, /#view-council/);
  assert.match(styles, /\.rc-send\{position:absolute;right:14px;bottom:14px/);
  assert.match(styles, /\.rc-time-machine/);
  assert.match(styles, /\.rc-tm-futures\{display:grid;grid-template-columns:repeat\(3/);
  assert.match(view, /<strong>G<\/strong>[\s\S]*<b>Grok<\/b>[\s\S]*<strong>O<\/strong>[\s\S]*<b>ChatGPT<\/b>[\s\S]*<strong>D<\/strong>[\s\S]*<b>Claude<\/b>/);
});

test('client performs start, aggregate read, and explicit human approval only through the Council API', () => {
  assert.match(client, /action: 'start'/);
  assert.match(client, /window\.hlOpenBoardroomDraft/);
  assert.match(client, /evidence: draftEvidence\.map/);
  assert.match(client, /applyBoardroomDraft\(pendingBoardroomDraft \|\| window\.__hlPendingBoardroomDraft\)/);
  assert.match(styles, /\.rc-handoff/);
  assert.match(client, /attachments: attachments\.map/);
  assert.match(client, /addFiles\(event\.dataTransfer\.files\)/);
  assert.match(client, /MAX_ATTACHMENTS = 30/);
  assert.match(client, /rc-proposal-section/);
  assert.match(client, /Company intelligence/);
  assert.match(client, /Risks and open questions/);
  assert.match(client, /function concise\(values, limit, maxLength\)/);
  assert.match(client, /\['Executive recommendation',[\s\S]*?, 3, 360\)/);
  assert.doesNotMatch(client, /\['Growth opportunity'/);
  assert.match(client, /function showPending\(brief\)/);
  assert.match(client, /\/api\/reina-council\?history=1&limit=/);
  assert.match(client, /function slideHistory\(direction\)/);
  assert.match(client, /loadHistory\(false\)/);
  assert.match(client, /var visibleRows = historyRows\.slice\(\)/);
  assert.match(client, /if \(replace\) historyRows = \[\]/);
  assert.match(client, /historyRows = visibleRows;[\s\S]*renderHistory\(historyRows\)/);
  assert.match(client, /await loadHistory\(true\)/);
  assert.match(client, /host\.scrollBy\(/);
  assert.match(client, /data-run-id/);
  assert.match(client, /loadRun\(button\.getAttribute\('data-run-id'\)\)/);
  assert.match(client, /if \(run\.brief\) byId\('rc-user-message'\)\.textContent = run\.brief/);
  assert.match(styles, /\.rc-history-item/);
  assert.match(styles, /scroll-snap-type:x mandatory/);
  assert.match(styles, /overflow-x:auto/);
  assert.match(client, /byId\('rc-brief'\)\.value = ''/);
  assert.match(styles, /@keyframes rcPulse/);
  assert.match(client, /idempotencyKey/);
  assert.match(client, /\?runId=/);
  assert.match(client, /action: 'approve_execution'/);
  assert.match(client, /rc-approval-check/);
  assert.match(client, /window\.confirm\(/);
  assert.match(client, /No shell command can be supplied/);
  assert.match(client, /money\(usage\.totalCostCents\)/);
  assert.match(client, /renderAnswer\(run\.report, run\.messages\)/);
  assert.match(client, /report\.completionStandard/);
  assert.match(client, /report\.completionGate/);
  assert.match(client, /Authoritative work status/);
  assert.match(client, /Boardroom discussion finished &middot; Work/);
  assert.match(client, /Until the required test evidence is recorded and every discovered defect is resolved, this recommendation is unverified/);
  assert.match(client, /function tmProjection\(input, config, months\)/);
  assert.match(client, /function tmPayback\(input, config\)/);
  assert.match(client, /loadTimeMachine\(run\)/);
  assert.match(view, /Nothing is executed/);
  assert.match(client, /nothing has been executed/i);
  assert.match(client, /buildTimeMachinePlan/);
  assert.match(client, /limits\.maxTokensPerResponse/);
  assert.match(client, /input\.max = String\(ceiling\)/);
  assert.match(client, /Math\.max\(2, Number\(byId\('rc-rounds'\)\.value\)\)/);
  assert.match(client, /\/api\/reina-council\?workspace=1/);
  assert.match(client, /action: 'create_project'/);
  assert.match(client, /action: 'update_run_metadata'/);
  assert.match(client, /data-pin-run/);
  assert.match(styles, /body\.hl-dark #view-council/);
  assert.match(styles, /\.rc-definition-of-done/);
  assert.match(styles, /body\.hl-dark \.rc-definition-of-done/);
});

// jomell tested a real run and "Reina is meeting with the directors..."
// stayed on screen alongside the finished recommendation below it.
// Live-confirmed: renderRun() correctly sets rc-thinking.hidden = true (the
// HTML `hidden` attribute IS present), but .rc-thinking{display:flex} is an
// AUTHOR rule, and an author rule always wins over the browser's own default
// `[hidden]{display:none}` UA rule regardless of the hidden attribute or
// selector specificity -- so the banner rendered as a visible flex box the
// entire time despite `hidden` being true. getComputedStyle on the real
// element in production showed display:"flex" with hidden=true, confirming
// this exact mechanism.
test('the "meeting with the directors" banner actually disappears when hidden -- an explicit [hidden] override beats the unconditional display:flex', () => {
  assert.match(styles, /\.rc-thinking\{display:flex[^}]*\}/, 'the base rule must still exist, unchanged');
  assert.match(styles, /\.rc-thinking\[hidden\]\{display:none\}/, 'a same-or-higher-specificity rule must restore the browser default for the hidden state');
});

test('all dynamic Council and model text is escaped before HTML rendering', () => {
  assert.match(client, /function esc\(value\)/);
  assert.match(client, /esc\(message\.summary\)/);
  assert.match(client, /esc\(claim\.statement\)/);
  assert.match(client, /esc\(JSON\.stringify\(event\.detail/);
  assert.match(client, /esc\(lines\.join\(' '\)\)/, 'the stale-debate-position hint must escape provider names before insertAdjacentHTML');
});

test('a debate round that carried forward a stale provider position is surfaced, not silently accepted as a full response', () => {
  assert.match(client, /result\.staleDebatePositions/, 'the independent round is always fresh after the whole-round retry, but a later debate round can still silently carry a stale position forward -- the UI must surface it');
  assert.match(client, /rc-stale-hint/);
  // Must run after loadRun(), same as the existing project-request hint --
  // loadRun() -> renderRun() overwrites rc-run-meta's innerHTML.
  assert.match(client, /await loadRun\(result\.runId\);[\s\S]*rc-stale-hint/);
  assert.match(styles, /\.rc-stale-hint\{/);
  assert.match(styles, /body\.hl-dark \.rc-stale-hint\{/, 'the stale-debate hint needs a dark-mode variant, matching every other Council hint');
});

// ---- Duplicate final-recommendation bullets (2026-08-20) -----------------
// jomell tested a real crisis run and "Company intelligence" / "Financial
// impact" showed the exact same two sentences, verbatim. Live-confirmed
// against the actual run (18d4fa3b-a73d-405a-ad6d-762a2ce9e131): ChatGPT's
// round-1 claim topic "cash crisis severity" matches Company intelligence's
// regex (has "cash") AND Financial impact's (also has "cash") -- matching()
// had no notion of "already shown elsewhere", so the identical statement
// rendered in both sections. All 3 directors (chatgpt/claude/grok) had in
// fact debated across 2 real rounds -- the bug was purely in how the client
// buckets their claims into display sections, not the debate itself.
test('claim-section labels are built via claimSection(), not a bare array literal, so dedup can apply', () => {
  assert.match(client, /var usedStatements = \{\};/);
  assert.match(client, /function claimSection\(label, pattern, limit, maxLength, extra\)/);
  assert.match(client, /claimSection\('Executive recommendation', \/executive\|recommendation\|decision\/i, 3, 360, summaries\)/);
  assert.match(client, /claimSection\('Company intelligence', \/company signal\|intelligence\|trend\|pattern\|data\|growth\|market\|opportunity\|customer\|competitive\|revenue\|cash\|capacity\|performance\/i, 3, 300\)/);
  assert.match(client, /claimSection\('Financial impact', \/financial\|price\|cost\|budget\|cash\|margin\|profit\|return\|roi\|allowance\/i, 2, 300\)/);
});

test('claimSection excludes statements a higher-priority section already claimed, and marks its own picks used for later ones', () => {
  const start = client.indexOf('var usedStatements = {};');
  const end = client.indexOf('var sections = [');
  const snippet = client.slice(start, end);
  assert.ok(start > -1 && end > start, 'expected the section-building block to exist between these two markers');

  const ctx = vm.createContext({
    matching: (pattern) => ctx.__allClaims.filter((c) => pattern.test(c.topic)).map((c) => c.statement),
    concise: (values, limit) => [...new Set(values)].filter(Boolean).slice(0, limit),
    summaries: [],
    risks: [],
    questions: [],
    result: undefined,
  });
  // Mirrors the real bug exactly: one claim's topic matches both a
  // "company"-flavored and a "financial"-flavored pattern (both contain
  // "cash"), plus a second claim that ONLY the later section can see.
  ctx.__allClaims = [
    { topic: 'cash crisis severity', statement: 'STATEMENT_BOTH_MATCH' },
    { topic: 'margin erosion', statement: 'STATEMENT_FINANCIAL_ONLY' },
  ];
  vm.runInContext(
    `${snippet}\nresult = [` +
      `claimSection('Company intelligence', /cash|revenue/i, 3, 300),` +
      `claimSection('Financial impact', /cash|financial|margin/i, 3, 300)` +
    `];`,
    ctx
  );
  const [companyIntel, financialImpact] = ctx.result;
  assert.deepEqual(companyIntel[1], ['STATEMENT_BOTH_MATCH'], 'the first section to match a claim keeps it');
  assert.deepEqual(financialImpact[1], ['STATEMENT_FINANCIAL_ONLY'], 'the second section must not repeat what the first already showed, but still gets its own unique match');
});

test('a claim matching only one section still renders there once (no regression for the common, non-overlapping case)', () => {
  const start = client.indexOf('var usedStatements = {};');
  const end = client.indexOf('var sections = [');
  const snippet = client.slice(start, end);
  const ctx = vm.createContext({
    matching: (pattern) => ctx.__allClaims.filter((c) => pattern.test(c.topic)).map((c) => c.statement),
    concise: (values, limit) => [...new Set(values)].filter(Boolean).slice(0, limit),
    summaries: [], risks: [], questions: [],
    result: undefined,
  });
  ctx.__allClaims = [{ topic: '90-day rollout plan', statement: 'STATEMENT_ACTION_ONLY' }];
  vm.runInContext(
    `${snippet}\nresult = [claimSection('Next actions', /30|60|90/i, 3, 300)];`,
    ctx
  );
  assert.deepEqual(ctx.result[0][1], ['STATEMENT_ACTION_ONLY']);
});
