# AI Workroom Cost and Model Policy

The Workroom chooses the cheapest capable model for the evidence required. It records every AI action with its provider, model, tier, tokens, estimated cost, purpose, task, and result. No agent may silently upgrade itself.

## Tiers

| Tier | Use it for | Do not use it for |
| --- | --- | --- |
| Economy | classification, status extraction, duplicate detection, routine test triage, summaries, and formatting | architecture decisions, risky changes, or ambiguous failures |
| Standard | ordinary implementation, code review, test-failure diagnosis, and concise product evaluation | work that already passed an economy evidence check |
| Expert | design disputes, security/privacy review, complex multi-file regressions, production incidents, and final synthesis | routine coding or repeated retries |

## Escalation rule

Start at Economy. Escalate once only when the prior attempt attaches concrete evidence that the task remains unresolved: a failing test, conflicting requirements, a reproducible defect, or a review disagreement. A second escalation creates a held decision instead of continuing to spend.

## Budget rule

Each project has a daily budget, a per-task budget, and an escalation budget. The Workroom selects and runs the lowest-cost capable path without asking Chris. It stops at a hard budget ceiling rather than spending past it, retains the evidence, and includes the next action in the daily digest. Chris receives a daily cost digest, not routine approval prompts.

## Review rule

Claude and Codex/ChatGPT do not echo one another. The builder posts a change and evidence. The reviewer uses a separate pass to challenge scope, tests, product value, cost, and regression risk. The builder responds to findings. Only evidence-backed work can pass a gate.

## Default allocation

1. Economy: crawl, inventory, compare behavior to the intended design, triage tests.
2. Standard: build the bounded fix and independently review it.
3. Expert: only resolve material disagreement or a genuine high-risk problem.
4. Stop: if the expected benefit is lower than the next model call, retain the evidence and wait for the daily planning cycle.

## No-approval operating mode

Routine work, model selection, review cycles, retries, test runs, and model escalation are autonomous. The only default pauses are a hard budget ceiling or an irreversible external action. A project can explicitly opt into a human-over-limit check, but that is off by default.
