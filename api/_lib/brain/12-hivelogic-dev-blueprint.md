# 🏗️ HiveLogic Dev Blueprint — Building Reina Into the Product

**Doc:** 12 | **Audience:** Zenkoders (dev shop) + Chris | **Status:** Architecture brief for scoping/quoting | **Date:** 2026-07

---

## 🎯 Bottom Line Up Front

- **One AI brain ("Reina"), 11 role modules, multi-tenant.** Greenwich Handyman is tenant #1; every line of code must be reusable for the next home-services company that signs up.
- **The product is not a chatbot.** It's an operations layer: Reina reads live business data, drafts actions, and **every outbound action waits in a human Approval Inbox.** That approval queue IS the product's core trust feature.
- **Answers carry confidence % + source citations, rendered in the UI.** Never-bluff is a spec, not a vibe.
- **MVP = 4 screens on 4 integrations:** Morning Briefing, Approval Inbox, Schedule Board w/ weather, Ask Reina — on QBO + Jobber/HCP + weather + Quo/RingCentral.

---

## 🧠 Vision Recap

| Element | Spec |
|---|---|
| Brain | One agent core ("Reina") — commanding, decisive persona; zero fluff |
| Role modules | 11 playbooks (Docs 00–11): Ops Director, CPA/Controller, Dispatcher, Weatherman, HR, Design, Estimator, PM, Purchasing, Sales, Marketing — same brain, different playbook + tools per module |
| Tenancy | Multi-tenant SaaS. Tenant #1: Greenwich Handyman (plumbing, reno, property mgmt; multi-county; TZ America/New_York) |
| Knowledge base | Project docs 00–11 seed each tenant's KB; tenant customizes thresholds/templates |
| Non-negotiables | Never bluff (confidence % + source), act-with-approval, cite every answer, protect the money, weather is a first-class scheduling input |

## 🏛️ Recommended Architecture

| Layer | Recommendation | Notes for Zenkoders |
|---|---|---|
| **LLM agent core** | Claude API via **Claude Agent SDK** | Agent loop, tool-calling, sub-agents per role module out of the box. Don't build an agent framework from scratch. |
| **Orchestration** | Job/queue service (e.g., BullMQ/Temporal) + cron scheduler | Runs: 6:30 AM briefing, hourly weather checks, sync polls, KPI rollups. Every Reina run = a traceable job. |
| **Per-tenant knowledge base** | Postgres + pgvector (or managed vector DB) per tenant namespace | Seeded with docs 00–11 + tenant SOPs, price lists, past-job history. RAG for "Ask Reina." |
| **Tool/connector layer** | One internal connector interface; each SaaS integration is a plugin behind it | Normalize to internal entities (below). Poll + webhooks where available. Secrets in a vault, per tenant. |
| **Approval queue** ⭐ | First-class service + UI: every outbound action (text, email, PO, invoice, schedule change) is a **Draft → Pending → Approved/Rejected → Executed** record | This is the act-with-approval rule as a feature. Per-action-type auto-approve thresholds later (e.g., "auto-send updates <$0 impact"), OFF by default. |
| **Audit log** | Append-only log: every Reina answer, draft, approval, execution, and the data snapshot it used | Needed for trust, debugging, and disputes ("why did Reina say that?"). |
| **App/UI** | Web app (responsive) + push notifications | Owner lives on his phone. Mobile-first Approval Inbox. |

## 🔌 Integration Priority

| Phase | System | API | Auth | Why First/Second |
|---|---|---|---|---|
| **A** | QuickBooks Online | REST (Intuit) | OAuth 2.0, tokens expire — refresh handling required; Intuit app review | Money data: invoices, AR, job costing. "Protect the money" needs this day 1 |
| **A** | Jobber | GraphQL | OAuth 2.0, dev center approval | Jobs, schedule, customers, quotes |
| **A** | Housecall Pro | REST | API key/OAuth (plan-gated — verify Chris's plan tier) | Greenwich Handyman runs both FSMs today; normalize both into one internal Job model |
| **A** | Weather | **NWS api.weather.gov (free) + OpenWeather backup** | NWS: none; OWM: API key | Weatherman module: forecast overlay on schedule, rain/freeze/wind alerts per job site county |
| **A** | Quo + RingCentral | REST (both have MCP/API) | OAuth 2.0 | Comms: send drafted texts (post-approval), read messages/transcripts for CO trigger phrases + update compliance |
| **B** | CompanyCam | REST + webhooks | OAuth 2.0 | Photo evidence: milestones, punch, closeout |
| **B** | Gusto | REST | OAuth 2.0, partner approval | Payroll/HR module |
| **B** | WebWork, FleetSharp | REST (verify FleetSharp API availability — may need export/partner request) | API key | Time + GPS: on-site verification, labor cost actuals |
| **B** | Google Business Profile | Google API | OAuth 2.0 | Reviews: monitor + drafted replies, review-ask tracking |
| **B** | Slack/Teams, Drive/Dropbox/M365 | Native APIs | OAuth 2.0 | Internal comms + doc retrieval into KB |
| Later | Indeed/ZipRecruiter, Bluebeam | Limited/partner APIs | — | HR sourcing + plan markup; manual workflows until then |

## 🎯 Confidence Protocol — Product Spec

Every Reina answer object returned to the UI:

```json
{
  "answer": "...",
  "confidence": 0.85,
  "sources": [{"system": "qbo", "record": "Invoice #1042", "as_of": "2026-07-14T10:02:00-04:00"}],
  "caveat": "Payment sync runs hourly; confirm in QBO for real-time.",
  "confirm_by": "Pull live QBO balance"
}
```

| UI Rule | Spec |
|---|---|
| Confidence badge | ≥95% green ✅ / 70–94% yellow ⚠️ / <70% red 🚩 on every answer card |
| <70% behavior | Answer prefixed "NOT CONFIDENT —" + best answer + explicit "what would confirm this" line |
| Citations | Tappable chips → open source record (deep link into QBO/Jobber/etc.) |
| Data freshness | Every card shows "as of [timestamp]" from last sync |
| No source available | Reina must say so; UI blocks a bare unsourced claim from rendering as fact |

## 🖥️ Core Screens

| Screen | Contents |
|---|---|
| **1. Morning Briefing** (6:30 AM ET push) | Cash position, today's schedule w/ weather flags, stalled jobs, AR alerts, approvals waiting, top 3 actions |
| **2. Approval Inbox** ⭐ | Pending drafts (texts, COs, POs, invoices, schedule moves) — swipe approve/reject/edit; shows Reina's reasoning + sources |
| **3. Schedule Board w/ weather overlay** | Crews × days grid; per-county forecast strip; red-flag conflicts (rain + exterior job); drag-to-reschedule generates drafted customer notices |
| **4. Money Dashboard** | Cash, AR aging, job margin actual-vs-estimate, weekly P&L trend (QBO) |
| **5. Pipeline** | Leads → estimates → sold funnel, follow-up queue, close rates |
| **6. Ask Reina** | Chat over connected tenant data; every answer uses the confidence protocol |

## 🗄️ Data Model Sketch (internal normalized entities)

| Entity | Key Fields |
|---|---|
| **tenants** | id, name, tz, counties[], settings/thresholds JSON, kb_namespace |
| **users** | id, tenant_id, role (owner/pm/office/crew), approval_rights, notification prefs |
| **customers** | id, tenant_id, name, contacts, addresses[], type (homeowner/landlord/PM), source_refs (jobber_id, hcp_id, qbo_id) |
| **jobs** | id, tenant_id, customer_id, stage, type, site_address+county, estimate_id, scheduled dates, % complete, milestones JSON, source_refs |
| **crews** | id, tenant_id, members[], skills[], home county, capacity |
| **estimates** | id, job/customer refs, line items, cost/price/margin, status, version |
| **change_orders** | id, job_id, scope, amount, status (draft/sent/signed), signed_at |
| **transactions** | id, tenant_id, qbo_ref, type (invoice/payment/bill/expense), amount, job_id, status, due_date |
| **approvals** ⭐ | id, tenant_id, action_type, draft payload, reasoning, sources[], status, approver, timestamps |
| **messages** | id, customer_id, channel (quo/rc/email), direction, body, linked job |
| **photos** | id, job_id, companycam_ref, tags[], milestone link, taken_at |
| **weather_snapshots** | county, date, forecast JSON, alerts, fetched_at |
| **audit_log** | actor (reina/user), action, entity ref, data snapshot hash, ts (append-only) |

Sync layer maps Jobber/HCP/QBO IDs → internal IDs (`source_refs`); dedupe customers across systems is a known hard problem — budget for it.

## 🔁 Sync Strategy

| Concern | Spec |
|---|---|
| Freshness | Webhooks where offered (Jobber, CompanyCam); polling fallback every 15 min (QBO, HCP); weather hourly + on-demand |
| Direction | v1 is **read-heavy**: writes limited to approved sends (Quo texts) + approved schedule notes. Direct writes to QBO/Jobber come later, each behind the Approval Inbox |
| Conflict rule | External system of record always wins on read; Reina never silently overwrites source data |
| Failure handling | Sync failure >30 min → banner in UI ("QBO data stale since 9:14 AM") + confidence scores auto-degrade on affected answers |
| Rate limits | QBO and Jobber both throttle — connector layer needs per-tenant rate budgets + backoff from day 1 |

## 🧩 Role Modules — Runtime Design

- Each of the 11 modules = **same agent core + module-specific system prompt (its playbook doc) + scoped toolset** (e.g., Dispatcher gets schedule + weather + comms tools; Controller gets QBO read tools).
- Modules ship incrementally: v1 activates Ops Director, Dispatcher/Weatherman, Controller (read-only), and Ask Reina. Estimator, Design, HR, Purchasing, Sales, Marketing activate as their integrations and playbooks come online.
- Cross-module handoffs go through shared internal entities (a Job the PM module flags is the same Job the Controller costs), never through prompt-to-prompt copying.

## 🧪 Testing & Trust Plan (before Chris daily-drives it)

| Gate | Test |
|---|---|
| Answer accuracy | 100-question eval set built from real Greenwich Handyman data ("what's AR over 30?", "who's on Oak St Friday?") — target ≥95% correct-with-citation; any confident-but-wrong answer is a P1 bug |
| Confidence calibration | Sampled answers audited weekly: stated confidence vs. actual accuracy must track within 10 points |
| Approval safety | Automated test: no code path can execute an outbound action without an `approvals` record in status=approved. CI-enforced |
| Tenant isolation | Seed 2 fake tenants; every API endpoint fuzzed for cross-tenant leakage in CI |
| Pilot | 2 weeks: Reina drafts everything, Chris approves everything, zero auto-sends. Graduation = <5% of drafts rejected for factual errors |

## ✂️ MVP Cut Line

| ✅ Ships in v1 | ⏳ Later |
|---|---|
| Morning Briefing (push + screen) | Money Dashboard full P&L views |
| Approval Inbox (texts + schedule changes) | Approval Inbox for POs/invoices/COs |
| Schedule Board + weather overlay (NWS) | Drag-reschedule automation, route optimization |
| Ask Reina on connected data (QBO + Jobber/HCP + Quo), confidence protocol live | Voice, Slack/Teams bot surface |
| Phase A integrations, read-heavy + approved-send via Quo | Phase B integrations (CompanyCam, Gusto, WebWork, FleetSharp, GBP) |
| Single tenant (Greenwich Handyman) on multi-tenant schema | Tenant self-serve onboarding, KB editor UI, role-module marketplace |
| Audit log (basic) | Auto-approve thresholds, KPI scorecards, estimator/design modules |

**v1 definition of done:** Chris wakes to a briefing he trusts, approves the day's messages from his phone, sees weather conflicts before crews roll, and can ask Reina money/job questions with cited, confidence-scored answers.

## 🔐 Security & Multi-Tenant Isolation

| Item | Spec |
|---|---|
| Tenant isolation | Row-level security keyed on tenant_id everywhere + per-tenant KB/vector namespace + per-tenant encrypted credential vault. **No cross-tenant queries, ever** — test for it in CI |
| AuthN/Z | SSO (Google/Microsoft) + MFA for owners; RBAC: owner > office > crew (crew sees own jobs only) |
| Secrets | OAuth tokens encrypted at rest (KMS); refresh rotation; no tokens in logs |
| LLM data | Claude API commercial terms (no training on customer data); strip/limit PII in prompts where feasible; log prompts to audit store, tenant-scoped |
| Compliance posture | SOC 2 roadmap (not v1 blocker, but log/access design should not preclude it) |
| Backups | Daily encrypted, per-tenant restorable |

## ❓ Open Decisions for Chris

| Decision | Options | Reina's Lean | Confidence |
|---|---|---|---|
| Build vs. buy: integration plumbing | Custom connectors vs. unified API (Merge/Nango/Paragon) | Buy (Nango-style) for OAuth/refresh plumbing; custom for Jobber/HCP business logic | 75% — validate Jobber/HCP coverage on the platform first |
| Hosting | AWS vs. GCP vs. Azure (M365 shop) | Whatever Zenkoders ships fastest on; require managed Postgres + queue + KMS | 70% — cost-compare at scoping |
| One FSM or two? | Keep Jobber + HCP both, or consolidate | Consolidating to one FSM before v1 cuts integration scope ~30% | 85% — needs Chris's operational call |
| Weather vendor | NWS free vs. OpenWeather paid | NWS primary (free, US-official), OWM fallback | 90% |
| Budget checkpoints | — | Gate 1: clickable spec + data-model signoff. Gate 2: Phase A integrations demo on real Greenwich Handyman data. Gate 3: v1 pilot with Chris daily-driving 2 weeks | — |
| Mobile | Responsive web vs. native app v1 | Responsive web + push (PWA); native later | 80% |
| SMS compliance | A2P 10DLC registration for customer texting | Register early — carrier approval takes weeks | 95% |

## 🗺️ Suggested Delivery Phases (for Zenkoders' quote)

| Phase | Scope | Exit Demo |
|---|---|---|
| **0. Spec** (2–3 wks) | Clickable prototype of 4 v1 screens; data model + connector plan signed off; vendor API access confirmed | Chris clicks through the app on fake data |
| **1. Read spine** | Phase A connectors syncing real Greenwich Handyman data into normalized entities; audit log live | "Ask Reina" answers 20 real questions with citations |
| **2. Briefing + Inbox** | Morning Briefing generation; Approval Inbox with Quo send execution | Chris approves a real customer text from his phone |
| **3. Schedule + Weather** | Schedule Board, NWS overlay, conflict flags, drafted reschedule notices | Rain-day dry run: Reina flags conflicts + drafts notices before 6:30 AM |
| **4. Pilot + harden** | 2-week daily-drive pilot, eval gates (above), fix list | Graduation criteria met → v1 live |

## 📥 What Zenkoders Needs From Chris to Start

- [ ] Admin/API access: QBO, Jobber, HCP, Quo, RingCentral (sandbox where offered)
- [ ] Docs 00–11 (tenant knowledge base seed)
- [ ] Decision: one FSM or two (see above)
- [ ] Counties list for weather zones + crew roster
- [ ] Approval policy: who can approve what action types
- [ ] 90 days of historical jobs/invoices for testing sync + Ask Reina quality

**Confidence note:** Architecture pattern (agent core + connectors + approval queue + audit) is standard and proven — confidence 90%. Per-vendor API details (HCP plan gating, FleetSharp API access, Gusto partner approval timelines) need verification during scoping — confidence 65% on those specifics; confirm directly with each vendor's dev docs before quoting.
