import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BOARDROOM_COMPLETION_STANDARD,
  PARTICIPANTS,
  PARTICIPANT_ROLES,
  consensusReport,
  normalizeAttachments,
  parseCouncilMessage,
  parseProviderJson,
  runCouncil,
  scenarioBaseline,
  validateExecutionRequest,
} from '../api/_lib/reina/council-core.js';

const evidence = [{
  sourceId: 'brief',
  label: 'Owner decision brief',
  content: 'Run the repository test suite before a release. The repository is the approved source of truth.',
}];

function message({ stance = 'support', topic = 'release_test', statement = 'Run the approved repository test suite.' } = {}) {
  return JSON.stringify({
    summary: statement,
    claims: [{
      topic,
      stance,
      statement,
      citations: [{ sourceId: 'brief', locator: 'sentence 1', excerpt: 'Run the repository test suite before a release.' }],
    }],
    risks: ['A test failure must block release.'],
    questions: [],
  });
}

function providers({ onGenerate = null } = {}) {
  return Object.fromEntries(PARTICIPANTS.map((participant) => [participant, {
    estimateMaxCostCents: () => 2,
    generate: async (input) => {
      onGenerate?.(participant, input);
      return { text: message(), usage: { inputTokens: 30, outputTokens: 100, costCents: 1.25 } };
    },
  }]));
}

test('proposal parser removes citations that are not verbatim supplied evidence', () => {
  const result = parseCouncilMessage(JSON.parse(message()).claims ? JSON.parse(message()) : null, 'claude', 0, new Map(evidence.map((item) => [item.sourceId, item])));
  assert.ok(result);
  const forged = JSON.parse(message());
  forged.claims[0].citations[0].excerpt = 'A fabricated source excerpt.';
  const sanitized = parseCouncilMessage(forged, 'claude', 0, new Map(evidence.map((item) => [item.sourceId, item])));
  assert.ok(sanitized);
  assert.deepEqual(sanitized.claims[0].citations, []);
});

test('provider parser accepts ordinary multiline JSON and a fenced JSON response', () => {
  const sourceMap = new Map(evidence.map((item) => [item.sourceId, item]));
  const raw = JSON.parse(message());
  raw.summary = 'First line.\nSecond line.';
  assert.ok(parseProviderJson(JSON.stringify(raw), 'claude', 0, sourceMap));
  assert.ok(parseProviderJson(`\`\`\`json\n${JSON.stringify(raw)}\n\`\`\``, 'grok', 0, sourceMap));
});

test('provider parser safely bounds verbose structured output instead of discarding the director', () => {
  const sourceMap = new Map(evidence.map((item) => [item.sourceId, item]));
  const raw = JSON.parse(message());
  raw.summary = 'S'.repeat(2_000);
  raw.claims[0].topic = 'T'.repeat(200);
  raw.claims[0].statement = 'A'.repeat(1_500);
  raw.claims[0].citations = Array.from({ length: 10 }, () => ({ sourceId: 'brief', locator: 'sentence 1', excerpt: 'Run the repository test suite before a release.' }));
  raw.questions = Array.from({ length: 67 }, (_, index) => index === 6 ? 'Q'.repeat(680) : `Question ${index + 1}?`);
  const parsed = parseProviderJson(JSON.stringify(raw), 'chatgpt', 0, sourceMap);
  assert.ok(parsed);
  assert.equal(parsed.summary.length, 1_600);
  assert.equal(parsed.claims[0].topic.length, 160);
  assert.equal(parsed.claims[0].statement.length, 1_200);
  assert.equal(parsed.claims[0].citations.length, 6);
  assert.equal(parsed.questions.length, 12);
  assert.equal(parsed.questions[6].length, 500);
});

test('Business Time Machine accepts bounded assumptions and compiles the latest director median', () => {
  const sourceMap = new Map(evidence.map((item) => [item.sourceId, item]));
  const withScenario = (participant, round, revenue, confidence = 'board_estimate') => {
    const raw = JSON.parse(message());
    raw.scenario = { monthlyRevenueChange: revenue, monthlyCostChange: 2000, oneTimeInvestment: 10000, rampMonths: 3, confidence, assumptions: ['Demand remains steady.'] };
    return parseCouncilMessage(raw, participant, round, sourceMap);
  };
  const messages = [
    withScenario('claude', 0, 9000),
    withScenario('chatgpt', 0, 12000),
    withScenario('grok', 0, 15000),
    withScenario('claude', 1, 11000, 'company_data'),
  ];
  const baseline = scenarioBaseline(messages);
  assert.equal(baseline.monthlyRevenueChange, 12000);
  assert.equal(baseline.directorsContributing, 3);
  assert.equal(baseline.assumptions.length, 1);
  const malformed = JSON.parse(message());
  malformed.scenario = { monthlyRevenueChange: 1, monthlyCostChange: 1, oneTimeInvestment: -1, rampMonths: 1, confidence: 'certain', assumptions: [] };
  assert.equal(parseCouncilMessage(malformed, 'claude', 0, sourceMap).scenario, null);
});

test('independent proposal calls cannot receive another model response', async () => {
  const received = [];
  const result = await runCouncil({
    brief: 'Decide whether to run the approved test task.', evidence,
    budget: { maxRounds: 1, maxTokensPerResponse: 200, maxCostCents: 10 },
    budgetCeiling: { maxRounds: 3, maxTokensPerResponse: 500, maxCostCents: 50 },
    providers: providers({ onGenerate: (participant, input) => received.push({ participant, prompt: input.prompt }) }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.messages.length, 3);
  assert.equal(received.length, 3);
  for (const call of received) {
    assert.ok(call.prompt.includes(PARTICIPANT_ROLES[call.participant]));
    assert.equal(call.prompt.includes('Council messages:'), false);
    for (const other of PARTICIPANTS.filter((name) => name !== call.participant)) assert.equal(call.prompt.includes(`"participant":"${other}"`), false);
  }
});

test('a conversational council can complete with one healthy independent provider', async () => {
  const resilient = providers();
  resilient.claude.generate = async () => { throw new Error('provider unavailable'); };
  resilient.chatgpt.generate = async () => { throw new Error('provider unavailable'); };
  const result = await runCouncil({
    brief: 'Confirm the conversational council remains available.', evidence,
    budget: { maxRounds: 1, maxTokensPerResponse: 200, maxCostCents: 20 },
    budgetCeiling: { maxRounds: 3, maxTokensPerResponse: 500, maxCostCents: 50 },
    providers: resilient,
    minimumParticipants: 1,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.messages.map((item) => item.participant), ['grok']);
  const completed = result.audit.find((item) => item.type === 'moderator.independent_round_completed');
  assert.equal(completed.data.degraded, true);
  assert.deepEqual(completed.data.unavailable, ['claude', 'chatgpt']);
});

test('one invalid structured provider response is repaired once and fully costed', async () => {
  const repairing = providers();
  let grokCalls = 0;
  repairing.grok.generate = async (input) => {
    grokCalls += 1;
    return {
      text: grokCalls === 1 ? '{"not":"a council message"}' : message(),
      usage: { inputTokens: 30, outputTokens: 100, costCents: 1.25 },
    };
  };
  const result = await runCouncil({
    brief: 'Decide whether to run the approved test task.', evidence,
    budget: { maxRounds: 1, maxTokensPerResponse: 200, maxCostCents: 20 },
    budgetCeiling: { maxRounds: 3, maxTokensPerResponse: 500, maxCostCents: 50 },
    providers: repairing,
  });
  assert.equal(result.ok, true);
  assert.equal(grokCalls, 2);
  assert.equal(result.usage.totalCostCents, 5);
  assert.equal(result.audit.filter((event) => event.type === 'provider.retrying').length, 1);
  assert.equal(result.audit.filter((event) => event.type === 'provider.completed').length, 3);
});

test('a provider whose repair attempt also fails still gets a whole-round retry before the round fails', async () => {
  const flaky = providers();
  let grokCalls = 0;
  flaky.grok.generate = async () => {
    grokCalls += 1;
    return {
      text: grokCalls <= 2 ? '{"not":"a council message"}' : message(),
      usage: { inputTokens: 30, outputTokens: 100, costCents: 1.25 },
    };
  };
  const result = await runCouncil({
    brief: 'Decide whether to run the approved test task.', evidence,
    budget: { maxRounds: 1, maxTokensPerResponse: 200, maxCostCents: 50 },
    budgetCeiling: { maxRounds: 3, maxTokensPerResponse: 500, maxCostCents: 50 },
    providers: flaky,
  });
  assert.equal(result.ok, true);
  // attempt 0 + repair attempt (both invalid) then a fresh whole-round retry
  // attempt that succeeds -- three calls, not just the two a single repair
  // would allow.
  assert.equal(grokCalls, 3);
  assert.equal(result.messages.length, 3);
  assert.ok(result.audit.some((event) => event.type === 'moderator.independent_round_retrying'
    && event.data.participants.includes('grok')));
});

test('a provider that fails every attempt, including the whole-round retry, still fails the independent round', async () => {
  const broken = providers();
  broken.grok.generate = async () => ({ text: '{"not":"a council message"}', usage: { inputTokens: 30, outputTokens: 100, costCents: 1.25 } });
  const result = await runCouncil({
    brief: 'Decide whether to run the approved test task.', evidence,
    budget: { maxRounds: 1, maxTokensPerResponse: 200, maxCostCents: 50 },
    budgetCeiling: { maxRounds: 3, maxTokensPerResponse: 500, maxCostCents: 50 },
    providers: broken,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Grok could not complete an independent answer/);
});

test('a malformed response is repaired only after every director receives an initial turn', async () => {
  const order = [];
  const deferred = Object.fromEntries(PARTICIPANTS.map((participant) => [participant, {
    estimateMaxCostCents: () => 2,
    generate: async () => {
      order.push(participant);
      const firstChatGptAttempt = participant === 'chatgpt'
        && order.filter((name) => name === 'chatgpt').length === 1;
      return {
        text: firstChatGptAttempt ? '{"not":"a council message"}' : message(),
        usage: { inputTokens: 10, outputTokens: 10, costCents: 0.5 },
      };
    },
  }]));
  const result = await runCouncil({
    brief: 'Decide whether to run the approved test task.', evidence,
    budget: { maxRounds: 1, maxTokensPerResponse: 200, maxCostCents: 4 },
    budgetCeiling: { maxRounds: 2, maxTokensPerResponse: 500, maxCostCents: 50 },
    providers: deferred,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(order, ['claude', 'chatgpt', 'grok', 'chatgpt']);
  assert.equal(result.audit.filter((event) => event.type === 'provider.repair_deferred').length, 1);
  assert.equal(result.audit.filter((event) => event.type === 'provider.retrying').length, 1);
  assert.equal(result.audit.some((event) => event.data.reason === 'insufficient_reserved_budget'), false);
});

test('pricing questions require a customer-ready proposal structure', async () => {
  const prompts = [];
  const result = await runCouncil({
    brief: 'What should this shower renovation cost?', evidence,
    budget: { maxRounds: 1, maxTokensPerResponse: 200, maxCostCents: 50 },
    budgetCeiling: { maxRounds: 2, maxTokensPerResponse: 500, maxCostCents: 50 },
    providers: providers({ onGenerate: (_participant, input) => prompts.push(input.prompt) }),
  });
  assert.equal(result.ok, true);
  for (const prompt of prompts) {
    assert.match(prompt, /pricing\/proposal request/);
    assert.match(prompt, /recommended price range, proposed scope, assumptions, exclusions, risks\/unknowns, and next steps/);
  }
});

test('every director is instructed to turn company evidence into strategic intelligence', async () => {
  const prompts = [];
  const result = await runCouncil({
    brief: 'Should the company hire another crew?', evidence,
    budget: { maxRounds: 1, maxTokensPerResponse: 200, maxCostCents: 50 },
    budgetCeiling: { maxRounds: 2, maxTokensPerResponse: 500, maxCostCents: 50 },
    providers: providers({ onGenerate: (_participant, input) => prompts.push(input.prompt) }),
  });
  assert.equal(result.ok, true);
  for (const prompt of prompts) {
    assert.match(prompt, /director in the HiveLogic Boardroom/);
    assert.match(prompt, /patterns, anomalies, opportunities/);
    assert.match(prompt, /30\/60\/90-day action plan/);
    assert.match(prompt, /summary under 280 characters/);
    assert.match(prompt, /exactly 2 strong claims, each statement under 300 characters/);
    assert.match(prompt, /no more than 2 risks and 2 questions/);
    assert.match(prompt, /Business Time Machine/);
    assert.match(prompt, /Use null rather than manufacturing a number/);
  }
});

test('an ordinary question needs no evidence and attachments remain read-only context', async () => {
  const attachments = [{ id: 'photo-1', name: 'dog.jpg', kind: 'image', mimeType: 'image/jpeg', dataBase64: '/9j/AA==' }];
  const plainProviders = Object.fromEntries(PARTICIPANTS.map((participant) => [participant, {
    estimateMaxCostCents: ({ attachments: received }) => received.length ? 1 : 100,
    generate: async (input) => ({
      text: JSON.stringify({ summary: 'Dogs vary in size and diet.', claims: [{ topic: 'dogs', stance: 'support', statement: 'Several ordinary factors affect the result.', citations: [] }], risks: [], questions: [] }),
      usage: { inputTokens: 10, outputTokens: 10, costCents: 0.1 },
    }),
  }]));
  const result = await runCouncil({
    brief: 'Why are dogs different sizes?', attachments,
    budget: { maxRounds: 1, maxTokensPerResponse: 200, maxCostCents: 10 },
    budgetCeiling: { maxRounds: 2, maxTokensPerResponse: 500, maxCostCents: 50 }, providers: plainProviders,
  });
  assert.equal(result.ok, true);
  assert.equal(result.messages.every((item) => item.claims[0].citations.length === 0), true);
  assert.deepEqual(result.audit[0].data.attachments, [{ id: 'photo-1', name: 'dog.jpg', kind: 'image', mimeType: 'image/jpeg' }]);
});

test('attachment validation accepts safe common files and rejects executable or oversized input', () => {
  assert.equal(normalizeAttachments([
    { id: 'notes', name: 'notes.txt', kind: 'text', mimeType: 'text/plain', content: 'hello' },
    { id: 'photo', name: 'photo.png', kind: 'image', mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' },
    { id: 'paper', name: 'paper.pdf', kind: 'pdf', mimeType: 'application/pdf', dataBase64: 'JVBERi0xLjQ=' },
  ]).length, 3);
  assert.equal(normalizeAttachments([{ id: 'bad', name: 'run.exe', kind: 'binary', mimeType: 'application/octet-stream', dataBase64: 'aGVsbG8=' }]), null);
  assert.equal(normalizeAttachments(Array.from({ length: 30 }, (_, index) => ({ id: `file-${index}`, name: `${index}.txt`, kind: 'text', mimeType: 'text/plain', content: 'a' }))).length, 30);
  assert.equal(normalizeAttachments(Array.from({ length: 31 }, (_, index) => ({ id: `too-many-${index}`, name: 'a.txt', kind: 'text', mimeType: 'text/plain', content: 'a' }))), null);
});

test('usage totals include all provider input and output tokens', async () => {
  const result = await runCouncil({
    brief: 'Decide whether to run the approved test task.', evidence,
    budget: { maxRounds: 2, maxTokensPerResponse: 200, maxCostCents: 20 },
    budgetCeiling: { maxRounds: 3, maxTokensPerResponse: 500, maxCostCents: 50 },
    providers: providers(),
  });
  assert.equal(result.usage.inputTokens, 180);
  assert.equal(result.usage.outputTokens, 600);
});

test('audit event count remains compatible with the atomic persistence invariant', async () => {
  for (const maxRounds of [1, 2, 3]) {
    const result = await runCouncil({
      brief: 'Decide whether to run the approved test task.', evidence,
      budget: { maxRounds, maxTokensPerResponse: 200, maxCostCents: 100 },
      budgetCeiling: { maxRounds: 3, maxTokensPerResponse: 500, maxCostCents: 100 },
      providers: providers(),
    });
    assert.equal(result.ok, true);
    assert.equal(result.audit.length, 3 + (8 * maxRounds));
    assert.equal(result.report.simulation.directorsContributing, 0);
  }
});

test('debate opens only after independent messages and computes consensus', async () => {
  const inputs = [];
  const attachments = [{ id: 'photo-1', name: 'site.jpg', kind: 'image', mimeType: 'image/jpeg', dataBase64: '/9j/AA==' }];
  const result = await runCouncil({
    brief: 'Decide whether to run the approved test task.', evidence, attachments,
    budget: { maxRounds: 2, maxTokensPerResponse: 200, maxCostCents: 20 },
    budgetCeiling: { maxRounds: 3, maxTokensPerResponse: 500, maxCostCents: 50 },
    providers: providers({ onGenerate: (participant, input) => inputs.push({ participant, round: input.round, prompt: input.prompt, attachments: input.attachments }) }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(inputs.map((input) => input.round).sort(), [0, 0, 0, 1, 1, 1]);
  for (const input of inputs.filter((item) => item.round === 1)) {
    for (const participant of PARTICIPANTS) assert.match(input.prompt, new RegExp(participant, 'i'), `${input.participant} must receive ${participant}'s position before the final round`);
    assert.deepEqual(input.attachments, [], 'debate must not rebill the files already analyzed independently');
    assert.equal(input.prompt.includes(evidence[0].content), false, 'debate must not repeat the full source bundle');
    assert.match(input.prompt, /Compact director positions/);
  }
  assert.equal(result.report.consensus.length, 1);
  assert.equal(result.report.conflicts.length, 0);
  assert.equal(result.report.completionStandard, BOARDROOM_COMPLETION_STANDARD);
});

test('permanent Definition of Done reaches every independent and debate prompt', async () => {
  const inputs = [];
  const result = await runCouncil({
    brief: 'Decide whether this release is done.', evidence,
    budget: { maxRounds: 2, maxTokensPerResponse: 200, maxCostCents: 20 },
    budgetCeiling: { maxRounds: 3, maxTokensPerResponse: 500, maxCostCents: 50 },
    providers: providers({ onGenerate: (participant, input) => inputs.push({ participant, ...input }) }),
  });
  assert.equal(result.ok, true);
  assert.equal(inputs.length, 6);
  for (const input of inputs) {
    assert.match(input.prompt, /PERMANENT COMPLETION RULE/);
    assert.match(input.prompt, /exhaustively tested for its scope and risk/);
    assert.match(input.prompt, /every discovered issue, error, and fault has been resolved/);
    assert.match(input.prompt, /merge, deployment, green build, or model assertion is not proof of completion/);
    assert.match(input.prompt, /unverified—never done, complete, fixed, resolved, ready, working, or successful/);
  }
  assert.equal(result.report.completionStandard.version, 'hivelogic.definition-of-done.v1');
  assert.equal(result.report.completionStandard.requirements.length, 5);
  assert.equal(result.report.completionStandard.forbiddenShortcuts.length, 2);
});

test('a Boardroom discussion is never an authoritative completion claim without a verification receipt', async () => {
  const sourceMap = new Map(evidence.map((item) => [item.sourceId, item]));
  const report = consensusReport([
    parseCouncilMessage(JSON.parse(message({ topic: 'completion' })), 'claude', 0, sourceMap),
    parseCouncilMessage(JSON.parse(message({ topic: 'completion' })), 'chatgpt', 0, sourceMap),
    parseCouncilMessage(JSON.parse(message({ topic: 'completion' })), 'grok', 0, sourceMap),
  ]);
  assert.equal(report.completionGate.status, 'unverified');
  assert.equal(report.completionGate.authoritativeLabel, 'NOT DONE');
  assert.equal(report.completionGate.receipt, null);
  assert.match(report.completionGate.reason, /discussion finished/);
});

test('a failed debate response carries forward the last verified director position', async () => {
  const resilientProviders = providers();
  resilientProviders.grok.generate = async (input) => {
    if (input.round === 1) throw Object.assign(new Error('temporary provider failure'), { code: 'timeout' });
    return { text: message({ topic: 'growth', statement: 'Grow only after the release test passes.' }), usage: { inputTokens: 30, outputTokens: 100, costCents: 1.25 } };
  };
  const result = await runCouncil({
    brief: 'Decide whether to run the approved test task.', evidence,
    budget: { maxRounds: 2, maxTokensPerResponse: 200, maxCostCents: 20 },
    budgetCeiling: { maxRounds: 3, maxTokensPerResponse: 500, maxCostCents: 50 },
    providers: resilientProviders,
  });
  assert.equal(result.ok, true);
  assert.equal(result.messages.length, 6);
  const grokMessages = result.messages.filter((item) => item.participant === 'grok');
  assert.equal(grokMessages.length, 2);
  assert.equal(grokMessages[1].round, 1);
  assert.equal(grokMessages[1].summary, grokMessages[0].summary);
  const debateAudit = result.audit.find((item) => item.type === 'moderator.debate_round_completed');
  assert.deepEqual(debateAudit.data.carriedForward, ['grok']);
  assert.equal(debateAudit.data.degraded, true);
  assert.equal(result.audit.length, 3 + (8 * result.budget.maxRounds));
});

test('a debate budget shortfall preserves all independent positions and completes', async () => {
  const expensiveDebate = Object.fromEntries(PARTICIPANTS.map((participant) => [participant, {
    estimateMaxCostCents: ({ prompt }) => prompt.includes('board discussion round') ? 100 : 2,
    generate: async () => ({ text: message(), usage: { inputTokens: 30, outputTokens: 100, costCents: 1 } }),
  }]));
  const result = await runCouncil({
    brief: 'Decide whether to run the approved test task.', evidence,
    budget: { maxRounds: 2, maxTokensPerResponse: 200, maxCostCents: 20 },
    budgetCeiling: { maxRounds: 3, maxTokensPerResponse: 500, maxCostCents: 50 },
    providers: expensiveDebate,
  });
  assert.equal(result.ok, true);
  assert.equal(result.messages.length, 6);
  assert.deepEqual(
    result.audit.find((item) => item.type === 'moderator.debate_round_completed').data.carriedForward,
    PARTICIPANTS,
  );
  assert.equal(result.audit.length, 3 + (8 * result.budget.maxRounds));
});

test('conflicting model stances are reported rather than resolved by assertion', () => {
  const map = new Map(evidence.map((item) => [item.sourceId, item]));
  const messages = [
    parseCouncilMessage(JSON.parse(message({ stance: 'support' })), 'claude', 0, map),
    parseCouncilMessage(JSON.parse(message({ stance: 'oppose' })), 'chatgpt', 0, map),
    parseCouncilMessage(JSON.parse(message({ stance: 'conditional' })), 'grok', 0, map),
  ];
  const report = consensusReport(messages);
  assert.equal(report.consensus.length, 0);
  assert.equal(report.conflicts.length, 1);
});

test('consensus requires distinct participants and uses each participant latest stance', () => {
  const map = new Map(evidence.map((item) => [item.sourceId, item]));
  const duplicate = parseCouncilMessage(JSON.parse(JSON.stringify({
    ...JSON.parse(message()),
    claims: [JSON.parse(message()).claims[0], JSON.parse(message()).claims[0]],
  })), 'claude', 0, map);
  assert.equal(consensusReport([duplicate]).consensus.length, 0);

  const messages = [
    parseCouncilMessage(JSON.parse(message({ stance: 'oppose' })), 'claude', 0, map),
    parseCouncilMessage(JSON.parse(message({ stance: 'support' })), 'chatgpt', 0, map),
    parseCouncilMessage(JSON.parse(message({ stance: 'support' })), 'claude', 1, map),
  ];
  const report = consensusReport(messages);
  assert.equal(report.consensus.length, 1);
  assert.deepEqual([...report.consensus[0].participants].sort(), ['chatgpt', 'claude']);
});

test('budget failure halts a provider result that exceeds the configured ceiling', async () => {
  const tooLarge = Object.fromEntries(PARTICIPANTS.map((participant) => [participant, {
    estimateMaxCostCents: () => 2,
    generate: async () => ({ text: message(), usage: { inputTokens: 1, outputTokens: 201, costCents: 1 } }),
  }]));
  const result = await runCouncil({
    brief: 'Decide whether to run the approved test task.', evidence,
    budget: { maxRounds: 1, maxTokensPerResponse: 200, maxCostCents: 10 },
    budgetCeiling: { maxRounds: 2, maxTokensPerResponse: 500, maxCostCents: 50 }, providers: tooLarge,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Claude and ChatGPT and Grok could not complete/);
});

test('sequential reservations admit every director when actual spend remains under the cap', async () => {
  let calls = 0;
  const costly = Object.fromEntries(PARTICIPANTS.map((participant) => [participant, {
    estimateMaxCostCents: () => 4,
    generate: async () => {
      calls += 1;
      return { text: message(), usage: { inputTokens: 1, outputTokens: 1, costCents: 1 } };
    },
  }]));
  const result = await runCouncil({
    brief: 'Decide whether to run the approved test task.', evidence,
    budget: { maxRounds: 1, maxTokensPerResponse: 200, maxCostCents: 10 },
    budgetCeiling: { maxRounds: 2, maxTokensPerResponse: 500, maxCostCents: 50 }, providers: costly,
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 3);
  assert.equal(result.usage.totalCostCents, 3);
  assert.equal(result.audit.some((event) => event.data.reason === 'insufficient_reserved_budget'), false);
  assert.equal(result.audit.find((event) => event.type === 'moderator.provider_batch_started').data.mode, 'sequential');
});

test('direct status checks explicitly forbid unrelated company strategy', async () => {
  const prompts = [];
  const result = await runCouncil({
    brief: 'Are you working?', evidence: [],
    budget: { maxRounds: 1, maxTokensPerResponse: 200, maxCostCents: 50 },
    budgetCeiling: { maxRounds: 2, maxTokensPerResponse: 500, maxCostCents: 50 },
    providers: providers({ onGenerate: (_participant, input) => prompts.push(input.prompt) }),
  });
  assert.equal(result.ok, true);
  assert.equal(prompts.length, 3);
  for (const prompt of prompts) {
    assert.match(prompt, /direct Boardroom status check/);
    assert.match(prompt, /status question directly/);
    assert.match(prompt, /Do not discuss receivables, invoices, jobs, staffing, sales, growth/);
  }
});

test('an imported-history-only answer is rejected unless it cites the imported history verbatim', () => {
  const history = [{
    sourceId: 'imported-ai-history',
    label: 'Imported Codex and Claude Code history',
    content: 'The automation bridge retry state remains unfinished and needs an end-to-end recovery test.',
  }];
  const sourceMap = new Map(history.map((item) => [item.sourceId, item]));
  const uncited = JSON.parse(message());
  uncited.claims[0].citations = [];
  assert.equal(parseCouncilMessage(uncited, 'claude', 0, sourceMap), null);
  uncited.claims[0].citations = [{
    sourceId: 'imported-ai-history',
    locator: 'history excerpt',
    excerpt: 'The automation bridge retry state remains unfinished',
  }];
  assert.ok(parseCouncilMessage(uncited, 'claude', 0, sourceMap));
});

test('imported-history citations verify against decoded message text containing escaped JSON characters', () => {
  const sourceMap = new Map([['imported-ai-history', {
    sourceId: 'imported-ai-history',
    content: JSON.stringify([{ body: 'Chris said "keep the full history".\nThen Claude confirmed the importer.' }]),
  }]]);
  const parsed = {
    summary: 'The importer requirement is recorded.',
    claims: [{
      topic: 'history', stance: 'support', statement: 'Keep the full history.',
      citations: [{ sourceId: 'imported-ai-history', locator: 'imported conversation', excerpt: 'Chris said "keep the full history".' }],
    }],
    risks: [], questions: [], scenario: null,
  };
  const result = parseCouncilMessage(parsed, 'grok', 0, sourceMap);
  assert.ok(result);
  assert.equal(result.claims[0].citations[0].excerpt, 'Chris said "keep the full history".');
});

test('history-only prompts provide every director with a guaranteed exact citation object', async () => {
  const prompts = [];
  const historyMessage = JSON.parse(message());
  historyMessage.claims[0].citations = [{
    sourceId: 'imported-ai-history', locator: 'imported conversation', excerpt: 'HiveLogic history import is required.',
  }];
  const historyProviders = Object.fromEntries(PARTICIPANTS.map((participant) => [participant, {
    estimateMaxCostCents: () => 1,
    generate: async ({ prompt }) => {
      prompts.push(prompt);
      return { text: JSON.stringify(historyMessage), usage: { inputTokens: 10, outputTokens: 10, costCents: 0.01 } };
    },
  }]));
  const result = await runCouncil({
    brief: 'Review all imported history.',
    evidence: [{ sourceId: 'imported-ai-history', label: 'Imported history', content: JSON.stringify([{ body: 'HiveLogic history import is required.' }]) }],
    budget: { maxRounds: 1, maxTokensPerResponse: 4000, maxCostCents: 10 },
    budgetCeiling: { maxRounds: 3, maxTokensPerResponse: 4000, maxCostCents: 500 },
    providers: historyProviders,
  });
  assert.equal(result.ok, true);
  assert.equal(prompts.length, 3);
  assert.ok(prompts.every((prompt) => prompt.includes('"excerpt":"HiveLogic history import is required."')));
});

test('an imported-history-only prompt forbids generic company advice and requires a history citation', async () => {
  const imported = [{
    sourceId: 'imported-ai-history',
    label: 'Imported AI history',
    content: 'The automation bridge retry state remains unfinished and needs an end-to-end recovery test.',
  }];
  const prompts = [];
  const historyMessage = JSON.parse(message());
  historyMessage.claims[0].citations = [{
    sourceId: 'imported-ai-history', locator: 'history excerpt',
    excerpt: 'The automation bridge retry state remains unfinished',
  }];
  const historyProviders = Object.fromEntries(PARTICIPANTS.map((participant) => [participant, {
    estimateMaxCostCents: () => 2,
    generate: async (input) => {
      prompts.push(input.prompt);
      return { text: JSON.stringify(historyMessage), usage: { inputTokens: 30, outputTokens: 100, costCents: 1.25 } };
    },
  }]));
  const result = await runCouncil({
    brief: 'Using only imported Codex and Claude Code history, identify unfinished work.',
    evidence: imported,
    budget: { maxRounds: 1, maxTokensPerResponse: 200, maxCostCents: 10 },
    budgetCeiling: { maxRounds: 3, maxTokensPerResponse: 500, maxCostCents: 50 },
    providers: historyProviders,
  });
  assert.equal(result.ok, true);
  assert.equal(prompts.length, 3);
  for (const prompt of prompts) {
    assert.match(prompt, /imported history is the only factual source/i);
    assert.match(prompt, /At least one claim MUST cite sourceId imported-ai-history/);
    assert.match(prompt, /Do not introduce company financial, invoicing, job, staffing, sales, or operations advice/);
    assert.doesNotMatch(prompt, /Organize claims around executive recommendation, company signals, financial impact/);
  }
});

test('directors run concurrently when the complete batch fits under the hard cost ceiling', async () => {
  let active = 0;
  let maximumActive = 0;
  const concurrent = Object.fromEntries(PARTICIPANTS.map((participant) => [participant, {
    estimateMaxCostCents: () => 1,
    generate: async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { text: message(), usage: { inputTokens: 1, outputTokens: 1, costCents: 1 } };
    },
  }]));
  const result = await runCouncil({
    brief: 'Decide whether to run the approved test task.', evidence,
    budget: { maxRounds: 1, maxTokensPerResponse: 200, maxCostCents: 10 },
    budgetCeiling: { maxRounds: 2, maxTokensPerResponse: 500, maxCostCents: 50 }, providers: concurrent,
  });
  assert.equal(result.ok, true);
  assert.equal(maximumActive, 3);
  assert.equal(result.audit.find((event) => event.type === 'moderator.provider_batch_started').data.mode, 'parallel');
  assert.equal(result.usage.totalCostCents, 3);
});

test('execution request is strictly typed and can only await human approval', async () => {
  assert.equal(validateExecutionRequest({ agentId: 'agent.1', taskType: 'repository_test', path: 'C:\\approved\\repo', shell: 'powershell' }), false);
  assert.equal(validateExecutionRequest({ agentId: 'agent.1', taskType: 'repository_test', path: 'C:\\approved\\repo' }), false);
  const agentId = '00000000-0000-4000-8000-000000000001';
  const result = await runCouncil({
    brief: 'Decide whether to run the approved test task.', evidence,
    budget: { maxRounds: 1, maxTokensPerResponse: 200, maxCostCents: 10 },
    budgetCeiling: { maxRounds: 2, maxTokensPerResponse: 500, maxCostCents: 50 }, providers: providers(),
    executionRequest: { agentId, taskType: 'repository_test', path: 'C:\\approved\\repo' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.state, 'awaiting_human_approval');
  assert.equal(result.executionRequest.taskType, 'repository_test');
  assert.equal(result.audit.some((event) => event.type === 'council.completed'), true);
});
