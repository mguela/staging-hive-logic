import assert from 'node:assert/strict';

import { PARTICIPANTS, runCouncil } from '../api/_lib/reina/council-core.js';
import { configuredCouncilProviders, createCouncilProviders } from '../api/_lib/reina/council-providers.js';

const expected = [...PARTICIPANTS];
assert.deepEqual([...configuredCouncilProviders(process.env)].sort(), [...expected].sort(), 'All three Boardroom providers must be configured.');

const result = await runCouncil({
  brief: 'Choose the single best way for HiveLogic to consolidate AI collaboration into The Boardroom. Compare reliability, owner effort, and operating cost. Challenge the other directors, then converge on one practical recommendation.',
  evidence: [],
  attachments: [],
  budget: {
    maxRounds: 2,
    maxTokensPerResponse: 4_000,
    maxCostCents: 500,
  },
  budgetCeiling: {
    maxRounds: 2,
    maxTokensPerResponse: 4_000,
    maxCostCents: 500,
  },
  providers: createCouncilProviders({ env: process.env }),
});

assert.equal(result.ok, true, result.error || 'Boardroom run failed.');
assert.equal(result.state, 'completed');
assert.equal(result.messages.length, 6, 'Expected three independent answers and three cross-review answers.');
for (const round of [0, 1]) {
  assert.deepEqual(result.messages.filter((message) => message.round === round).map((message) => message.participant).sort(), [...expected].sort());
}
assert.ok(result.audit.some((event) => event.type === 'moderator.independent_round_completed'));
assert.ok(result.audit.some((event) => event.type === 'moderator.debate_round_completed' && event.data.round === 1));
assert.ok(result.audit.some((event) => event.type === 'moderator.consensus_computed'));
assert.ok(result.report.consensus.length + result.report.conflicts.length + result.report.unresolved.length > 0, 'Reina must have a consolidated decision record.');

console.log(JSON.stringify({
  ok: true,
  participants: expected,
  rounds: 2,
  messages: result.messages.length,
  consensusTopics: result.report.consensus.length,
  conflicts: result.report.conflicts.length,
  unresolved: result.report.unresolved.length,
  totalCostCents: result.usage.totalCostCents,
  finalSummaries: Object.fromEntries(result.messages.filter((message) => message.round === 1).map((message) => [message.participant, message.summary])),
}, null, 2));
