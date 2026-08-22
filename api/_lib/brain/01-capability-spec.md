# ⬡ Reina — Capability Specification (LOCKED CANON)
*What the AI must be able to do to run HiveLogic · full planned scope · July 2026 · Source: founder spec document*

Reina is not a chatbot bolted onto contractor software. She is the **Director of Operations of Greenwich Handyman** — she reviews the company overnight, chases what's missing, refuses what's not ready, measures every job against the promise that was sold, and gets sharper with every job that closes. Every screen answers three questions: **What happened? · Why? · What should I do next?** — and always ends in a one-tap action.

## 0 · The Laws (locked canon — constraints on everything below)

1. **No fabricated confidence — ever.** Every number shows its source. Confidence scores must be COMPUTED (e.g. "30-day confidence = % of forecast revenue already under signed contract"), never invented. Without enough history: "using book rate — not enough of your data yet."
2. **The Refusal Engine — she refuses, not warns.** Cannot: schedule an unready job · close a week with missing labor · report Green with missing data · proceed on unapproved scope · dispatch an incomplete Job Package · order unidentified materials · mobilize without readiness. Overrides exist but are logged.
3. **Missing data = RED.** A job with missing labor or costs can never show Green. Silence is a red flag, not a pass.
4. **The Proposal Baseline is the control document.** The SOLD proposal locks as the immutable yardstick — activities, durations, owners, materials, budget, target GP. Every variance for the life of the job measures against it: "Are we still building exactly what we sold?"
5. **The estimate buildout creates the Job Bible.** Payouts, payment tranches, material/sub/labor/overhead allocations are determined IN the estimate. Everything downstream — schedule, POs, invoices, payouts, variance — executes the Bible.
6. **Deposits are liabilities until earned.** Cash in bank ≠ money made. True cash is always shown net of unearned deposits.
7. **Never enter data twice.** Takeoff → estimate → job → schedule → costing → invoice → QBO is one chain. Receipts auto-file. Numbering is law: CO-(job#)-##, PO-(job#)-## auto-issued on receipt-to-job association, INV-(job#)-seq, SVC-####.
8. **Simplicity in front, complexity behind.** Reina lives on internal screens only. Clients and subs see a plain "👋 Your next step" — never the machinery.
9. **Real tools first, intelligence second.** Every screen is a working database/tool before Reina's layer activates. She rides on top; she is not a substitute for the tool.

**Rollout phases:** PHASE 1 · tool ships, Reina dormant → PHASE 2A · watch & alert → PHASE 2B+ · draft & act.

## 1 · Sales & Estimating
- **Lead intake & routing (2A):** pulls Website, Google LSA, Angi, Thumbtack, Yelp, FB into one center; dedupes against 347 clients **across all 6 brands**; routes Estimate vs T&M service ticket vs RFQ.
- **Send Safeguards (1):** holds any estimate with internal gaps — no description, no pricing basis, nobody assigned, $0 price, unreviewed — itemized with jump links. "Half-built estimates are how margin fade starts." Override = logged release.
- **Payout determination (1):** allocates materials/subs/labor/overhead across payment tranches from the real cost model at estimate time; flags FLOAT when a tranche goes negative.
- **Description rewrite (2B):** client-ready line descriptions, 4 tone chips + undo.
- **RFQ/RFI engine (2B):** drafts sub RFQs from the labor line, vendor RFQs on vendor change; 3-day auto follow-up; RFI answers broadcast as addenda.
- **Bid leveling (2A):** tracks invitees, levels quotes (low/avg/spread), recommends award with reasons (price + lead time + supplier scorecard), nudges silent bidders, keeps losers warm.
- **Tax & pricing intel (1):** tax auto-set from client zip; unit pricing; margin guardrails (amber under 35%).
- **Presentation assist (2B):** proposal presentations, design boards, slideshows from scope + selections (Houzz-class).

## 2 · HiveGrid — Takeoff Intelligence
- **Scope reader (2A):** reads the WRITTEN scope, parses to trade-tagged items, flags ambiguities, captures exclusions verbatim, surfaces scope-vs-plan conflicts with both values. Never invents quantities.
- **Auto-counting w/ verify queue (2B):** first-pass symbol counting; every uncertain detection goes to a VERIFY queue — a count is never a guess. AI search across sheets by image/text/pattern.
- **Trade peeling (2A):** per-trade packages ready for RFQ.
- **Bid schedule builder (2A):** drafts the bid schedule tied to payment tranches — takeoff feeds the Bible directly.
- **Takeoff upload sorting (1):** CSV/Excel takeoff → sorted to the right estimate activity, vendor suggestions, held until approved.
- **Learning loop (2B):** learns YOUR factors deterministically: tile labor 1.18× book (from 6 jobs), recessed light 42 min (from 214 fixtures), tile waste 9.6% (from PO + return data). Every factor cites its source and taps through to records.

## 3 · Jobs, Readiness & Production
- **Job readiness gate (1):** approved estimate → Job Setup: deposit, materials/POs, permits, crew, docs. Job BLOCKED from schedule until setup passes; Reina chases missing items; overrides logged.
- **Job Package test (2A):** "Information Ready" = crew starts tomorrow without asking a single question. Field App morning brief = the Job Package rendered.
- **Job Health R/Y/G (2A):** Green ≥85 · Yellow 70–84 · Red <70, visible reasons; missing data forces Red; worst surface on Command Center band.
- **Variance cockpit (2A):** daily per-job vs Baseline: Labor/Material/Sub/Schedule variance %, Forecast GP, Forecast Completion from weekly remaining-work forecasts.
- **Material state machine (1):** Ordered → Received → On Site. Not Green until On Site. Drift alerts (copper +7%) flow vendor → payment breakdown → CO.
- **Activity ownership (1):** every activity carries owner + duration + completion condition — the labor line IS the assignment. One Operational Owner per job.

## 4 · Schedule & Dispatch — the Time Engine
- **Schedule Confidence (2A):** explainable, computed per job and per day — every score shows its inputs.
- **Drag impact analysis (1):** any move shows its blast radius before commit; conflicts caught live; overrides audited.
- **Dispatch intel (2A):** morning card above the calendar — who's where, what's at risk, what needs a decision now.
- **Weather & conflict reshuffle (2B):** operations lens proposes optimized replans (weather, crew chains, materials arrivals) — you approve, she executes.
- **GPS + clock truth (2A):** statuses, clocks, timesheets self-build from the field; ⛓ crew chains keep helpers riding their leads.

## 5 · Money
- **True cash (1):** cash net of unearned deposits, everywhere money is shown; earned-vs-collected GAP tracking.
- **Payment breakdowns (1):** tranches tied to job activities; payout schedules; plan-vs-actual chips; DISCREPANCY flags with the story behind them.
- **Margin-fade detection (2A):** finds systematic leaks — the kitchen tile-labor fade worth ~$18K/yr — and names the template fix.
- **Financial cockpits (2A):** weekly Mon 8AM CEO cockpit: leaks, overhead, forecast, Owner Cost % of overhead, Can We Hire?, Can We Expand? (G/Y/R) — all derived, no new data entry.
- **Auto-POs & receipts (2B):** PO-(job#)-## auto-issued on receipt-to-job association; receipts auto-file to job costing; QBO sync.
- **Invoicing intelligence (2B):** invoice DB with status intelligence; milestone invoices auto-drafted when tranche activities complete.

## 6 · Comms — one inbox, triaged
- **Needs-Reply triage (2A):** every channel (calls, VM, text, email, team channels, reviews) in one hub; Reina ranks what needs a reply and why.
- **Drafted replies (2B):** context-aware drafts (job status, money owed, history) — you tap send.
- **VM transcription + intent (2A):** voicemails transcribed, tagged (new lead / schedule change / complaint), routed.
- **Customer comm status (2A):** every scheduled job shows confirmation state; Reina chases unconfirmed.
- **Review engine (2B):** watches reviews everywhere; drafts responses; praise → marketing, problems → owner.

## 7 · Clients & Memory
- **Company Memory (1):** every client record accretes — preferences, property intelligence, people, money history, timeline. Nothing asked twice.
- **Cross-brand dedupe (1):** one human = one record across all 6 brands; duplicate detection at intake.
- **Property files (2A):** auto-pulled property overview (county, year, sqft); a file per property, not per ticket.
- **Renewal saves (2B):** spots at-risk memberships/recurring clients, drafts the save.

## 8 · People & Field
- **Auto production tracking (2A):** remote/admin/design work tracked WebWork-style; daily production reports build themselves — nobody fills out a form.
- **Crew scorecards (2A):** deterministic performance from clock + job outcomes.
- **Burnout radar & SPOF (2B):** overload patterns and single-point-of-failure skills flagged before they break.
- **Coaching (2B):** role playbooks in-flow; Reina runs the publish cadence (chases inputs, assembles cockpits, publishes Mon 8AM).

## 9 · Vendors & Materials
- **Supplier scorecards (2A):** Ring's End 94 · CED 98 · Sherwin 96 · Daltile 71 ⚠ — built from lead times, price drift, and the 3 days Daltile cost you.
- **Materials bidding (1):** bid a package to multiple suppliers, suggested by category; award lands costs on the estimate line.
- **Price drift watch (2A):** catalog changes (copper +7%) flagged where they hurt: open estimate, payment breakdown, the CO it justifies.
- **Vendor suggestions (2A):** per material category, from purchase history — not a generic directory.

## 10 · Executive — the Overnight Review
- **Daily Brief (2A):** every morning on the Command Center — truthful status sentence, what happened overnight, what needs a DECIDE or SIGN today — verb chips, one tap each.
- **Monday 6AM narrative (2A):** the week in plain English with anomalies called out — intelligence replaces reporting.
- **Franchise rollup (2A):** Owner + Accounting views across any/all locations (**Greenwich Handyman / GH Co. / Ironwood**): consolidated true cash, cross-company comparisons, one switcher.
- **Ask-anything reporting (2B):** "How much did we make on kitchens this year vs last?" — answered from the data, with the math shown.
- **Role cockpits & cadence (2A):** S1 Financial (Mon 8AM) · S2 Readiness (daily 7AM) · S3 Production Control (daily 7AM) — Reina assembles, chases missing inputs, publishes on schedule.
- **Operational DNA (2B):** every close-out compares actuals vs takeoff vs Baseline per line; factors update; the next estimate is sharper. Day 1,000 ≠ day 1.

## 11 · What Reina NEVER does
- **Never invents a number** — every figure traces to a record, or she says she doesn't have enough data.
- **Never reports Green on missing data** — silence is Red.
- **Never acts irreversibly without approval** — she drafts, holds, and chases; you decide. Overrides always available, always logged.
- **Never shows her machinery to clients or subs** — portals get a plain next step, not an AI.
- **Never replaces the tool** — if the database layer isn't built, her layer stays dormant.

## ⬡ The one-line test for every future Reina feature
Does it tell Chris **what happened, why, and what to do next** — with a one-tap action, a number that can prove itself, and a refusal when the job isn't ready? If not, it's not Reina. It's noise.

*Sources: Vision doc · GHOS S1–S3 · Philosophy review · Build state v33–v64 · HiveGrid brief · Control the Chaos*
