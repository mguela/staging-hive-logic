# The Boardroom (Reina AI Council) — Phase 1

The Boardroom is a disabled-by-default governed workflow with a native
HiveLogic workspace under **Manager > The Boardroom**. Internally it retains the
Reina AI Council APIs and data model for compatibility. Reina is the deterministic
moderator; Claude, ChatGPT, and Grok are read-only advisors. The main screen is
one question box, an optional file/photo drop area, and an in-composer **Send**
button. The Boardroom has no shell, browser, database-write, or external action
capability. Grok's PDF adapter may use xAI's read-only attachment search, with
a fixed internal-turn limit; it is never given web, code, or function tools.

The server enriches each Boardroom request with a read-only aggregate company
snapshot and up to six owner-scoped prior Boardroom decisions. Directors are
explicitly told that prior recommendations are historical context rather than
verified outcomes. This creates bounded company intelligence without giving any
model database credentials or unrestricted record access.

## Flow

1. An authenticated HiveLogic admin asks a question and may attach up to 30
   supported photos, PDFs, or text-based files.
2. Claude, ChatGPT, and Grok receive the same question and attachments in parallel for
   round 0. They do not receive each other's output. Claude is assigned
   evidence/risk review, ChatGPT implementation planning, and Grok adversarial
   challenge; each still returns a complete independent recommendation.
3. Reina validates each JSON-only response and opens bounded debate rounds only
   after all independent proposals have completed. Ordinary knowledge and media
   claims need no artificial citation. If an API caller supplies explicit text
   evidence, a claim that cites it must use a verified verbatim excerpt.
4. Reina computes consensus, conflicts, and unresolved topics from each
   participant's latest stance. Consensus requires at least two distinct
   participants; repeated claims or debate rounds never create extra votes.
   The complete structured run and its audit events are persisted atomically
   through a service-role-only database function.
5. If an optional typed HiveBridge task was requested, the run stops at
   `awaiting_human_approval`. An admin must make a separate
   `approve_execution` request before a task can be queued.

## Execution safety

The only Phase 1 execution requests are the existing Windows Agent task types:
`repository_status` and `repository_test`. Each request is bound to an exact
agent and path, revalidated by the current Agent policy, and queued without a
shell or user-selected executable/argument list. The installed agent repeats
its own real-path, scope-hash, permission, and approval checks before it runs
the exact allowlisted command.

Approval and queueing are a single database transaction. It locks both the
pending Council run and the tenant-scoped target agent, writes the Council and
HiveBridge approval records, queues the task, transitions the run, and appends
the execution audit event together. Any failure rolls the entire transaction
back.

Attachments are treated as untrusted data, never instructions. JPEG and PNG
photos are resized and iteratively compressed in the browser so batches remain
inside the 2.5 MB request envelope. PDF and media signatures are
checked again on the server. Raw attachment content is sent only for the active
provider request; the durable Council record retains attachment metadata, not
file bytes or text. Temporary xAI PDF files receive a one-hour expiry and are
also deleted immediately after the response when possible.

The Council never converts a model message or attachment into an executable payload. Models
do not receive an agent id, path, command, script, API key, or approval token.

## Configuration and rollout

1. Review and apply `supabase/migrations/20260804210000_reina_ai_council_phase1.sql`
   using the repository migration workflow. It has not been applied by this change.
2. Configure all three API keys, one explicit model per provider, and current
   per-million-token prices in Vercel. The endpoint returns `409` if any are
   absent rather than estimating a cost.
3. Keep `REINA_COUNCIL_ENABLED=false` until a protected-preview review is
   complete. Set round/token/cost ceilings conservatively.
4. Run the Council tests and then a protected-preview admin-only exercise with
   a harmless `repository_status` task before considering `repository_test`.

## API sketch

`start` accepts `idempotencyKey`, `brief`, optional `attachments`, optional
legacy `evidence`, `budget`, and optional `executionRequest`. Attachments are
limited to 30 and 2.5 MB total: resized JPEG/PNG images, PDFs up to 1.5 MB,
and text-based files up to 500 KB. Unsupported binaries are rejected and never
executed. Legacy evidence items are `{ sourceId, label, content }`; any citation
must use a known `sourceId` and an exact `excerpt` present in its content. The optional
execution request is exactly `{ agentId, taskType, path }`.

`approve_execution` accepts only `{ action, runId, reason? }`. The endpoint
records the approver and then queues the pre-existing typed request. It never
accepts a command, shell, script, argument array, or a model-selected action.

Before any parallel provider call starts, Reina reserves a conservative
worst-case cost using the UTF-8 input size, configured per-token prices, and
the response-token ceiling. A round that cannot reserve every invocation stays
within budget by failing before the excess provider request is opened. Actual
spend is accumulated in integer micro-cents.

Before providers are called, a durable admission ledger serializes requests per
owner. The idempotency key prevents duplicate provider spend, active-run limits
prevent parallel cost bursts, and a daily reserved-cost budget rejects excess
work. Active work retains its full worst-case reservation; completed work is
atomically reconciled to measured provider spend so unused reservation does not
consume the rest of the daily allowance. Abandoned admissions expire after 15 minutes. The owner-scoped run read
returns the report, transcript, audit timeline, and approval record together.
The Boardroom workspace also exposes a private, owner-scoped recent-decision
index. Selecting an item reopens the durable question, recommendation,
transcript, cost record, and audit timeline; the index never reads another
owner's runs. The memory surface is a horizontal, keyboard-accessible carousel
with previous/next controls and a visible scrollbar. It progressively requests
bounded owner-scoped pages as the owner moves toward older decisions, so the
workspace is not limited to the first history page.

## Business Time Machine

Every completed recommendation includes a **Show Me the Future** experience.
Each director may provide four bounded scenario inputs: expected monthly
revenue change, monthly cost change, one-time investment, and months to full
operating speed. Directors must label the basis as company data, user-supplied
data, a Board estimate, or insufficient data, and must return `null` instead of
inventing a number. Reina compiles the latest director inputs using a median so
one extreme estimate cannot control the baseline.

The browser applies fixed, deterministic math to that baseline and shows
conservative, recommended, and aggressive futures at 30 days, 90 days, and one
year. Every input remains visible and editable. The forecast is explicitly
labeled directional, never as a promise or verified outcome. Selecting a
future can create a new 90-day planning brief with the scenario attached as
untrusted evidence; it performs no action. Any later HiveBridge request still
uses the existing typed, separate human-approval boundary.

Pricing, estimating, quoting, budget, and scope-of-work questions automatically
use a contractor proposal format. Each participant must separate the recommended
price range, proposed scope, assumptions, exclusions, risks/unknowns, and next
steps. The main result renders a concise decision brief with bounded sections
and item lengths; the full
model exchange remains available in the expandable audit detail.

## Delivery state

- Phase 1 — protocol, multimodal provider adapters, optional evidence validation, budgets, audit,
  human approval, and atomic HiveBridge queueing: complete locally.
- Phase 2 — native Council workspace, transcript/report rendering, participant
  duties, idempotent admission, per-owner quotas, and readiness status: complete
  locally.
- Phase 3 — protected preview: migration, provider/model/price configuration,
  and preview deployment complete; simplified question/attachment smoke test pending.
- Phase 4 — production rollout: pending explicit enablement after preview signoff,
  monitoring, and rollback verification.

See `docs/REINA_AI_COUNCIL_ROLLOUT.md` for the activation runbook. No migration,
secret, deployment, or production flag change is performed by this code change.
