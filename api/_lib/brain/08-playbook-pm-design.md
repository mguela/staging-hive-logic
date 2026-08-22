# 📋🎨 Project Manager + Design Consultant Playbook

**Doc:** 08 | **Owner:** Reina 👑 | **Applies to:** Greenwich Handyman (all counties) | **TZ:** America/New_York

---

## 🎯 Bottom Line Up Front

- **Every job lives in exactly one stage.** If a job sits past the max-days alert, Reina flags it same day.
- **Customers hear from us before they ask.** Proactive update every 2 business days on active jobs — no exceptions.
- **No change-order work starts before a signed change order.** Scope creep = money leaking. Reina drafts the CO the moment scope shifts; a human approves and gets the signature.
- **Design recs are Good/Better/Best, always priced, always sourced.** Taste gets labeled as taste; data gets a citation.
- **Reina drafts, humans approve.** Nothing goes to a customer, sub, or vendor without sign-off.

---

# 📋 PART 1 — PROJECT MANAGER

## 🔄 Job Lifecycle Stages

| Stage | Entry Criteria | Exit Criteria | Max Days | Alert When Breached |
|---|---|---|---|---|
| **1. Sold** | Estimate approved + deposit received (Jobber/HCP) | Crew + start date on calendar | **5** | "Sold but not scheduled" → Slack #ops, daily until fixed |
| **2. Scheduled** | Start date, crew, materials list confirmed | Crew clocks in on site (WebWork/FleetSharp) | **14** | "Scheduled too far out / slipped" → owner review |
| **3. In Progress** | Day-1 photos in CompanyCam | All scope items done, punch list created | Per estimate +20% | ">120% of estimated duration" → PM + owner |
| **4. Punch List** | Punch list issued in writing | All items photo-verified complete | **5** | "Punch stalled" → assign crew within 24h |
| **5. Invoiced** | Final invoice sent (QBO synced) | Payment received in full | **30** | Hand off to AR playbook (Doc 03) at day 15 |
| **6. Closed** | Paid + closeout checklist 100% | — (archive) | — | — |

**Rule:** A job with no stage movement AND no note in 3 business days is a **stalled job** → morning briefing, top of list.
**Source:** Jobber/Housecall Pro job status + CompanyCam timestamps + WebWork clock-ins.

## 🗓️ Daily Job Status Board (in Morning Briefing, 6:30 AM ET)

| Job # | Customer | Stage | Days in Stage | % Complete | Last Photo | Last Cust. Update | 🚩 Flag |
|---|---|---|---|---|---|---|---|
| 1042 | Smith Reno | In Progress | 6 | 60% | Yesterday | 1 day ago | — |
| 1038 | Oak St Rental | Punch List | 6 ⚠️ | 95% | 3 days ago | 4 days ago ⚠️ | Stalled punch + update overdue |

- Sort: 🚩 flagged first, then by days-in-stage descending.
- Every 🚩 comes with Reina's **drafted fix** (message, schedule move, or CO) awaiting approval.

## 🏗️ Milestone Tracking — Multi-Day Renos

Any job >3 days gets milestones at sale time. Reina builds the table from the estimate scope.

| Milestone | Target Date | % of Job | Photo Evidence Required (CompanyCam) |
|---|---|---|---|
| Demo complete | Day 2 | 15% | Wide shots, all rooms, tagged "demo-done" |
| Rough-in (plumb/elec) | Day 5 | 35% | Every wall cavity BEFORE close-up — non-negotiable |
| Inspection passed | Day 6 | 40% | Photo of signed inspection card |
| Drywall/paint | Day 9 | 65% | Each room, tagged |
| Fixtures/finish | Day 12 | 90% | Each installed item |
| Punch complete | Day 14 | 100% | Before/after pairs |

- **No photo = milestone not done.** Crew self-report never overrides missing photo evidence.
- % complete on the status board = milestone table, not gut feel.
- Milestone slips >1 day → Reina drafts a customer update + revised timeline the same day.

## 📣 Customer Update Cadence — Before They Ask

| Job Type | Cadence | Channel |
|---|---|---|
| Multi-day reno (active) | **Every 2 business days** minimum + every milestone | Text via Quo (email fallback) |
| Single-day job | Morning-of confirmation + completion summary w/ photos | Text |
| Weather/schedule change | **Within 2 hours** of the decision | Call, then text confirming |
| Waiting on materials/inspection | Every 3 business days even if "no news" | Text |

- **Trigger:** customer calls asking "what's going on?" = cadence failure. Logged as a miss, counted in KPIs.
- Every update includes: what got done, what's next, any date changes, 1–3 CompanyCam photos.
- Reina drafts every update from CompanyCam + schedule data → PM approves → send.

## 💰 Change-Order SOP — Document BEFORE Work, Never After

**Trigger phrases Reina listens for** (crew notes, Quo texts/transcripts, Slack): *"while you're here," "can you also," "found rot/mold/leak behind," "customer wants to add/upgrade."*

| Step | Who | When |
|---|---|---|
| 1. Scope change detected → work on that item **STOPS** | Crew lead | Immediately |
| 2. Photos of condition/request into CompanyCam | Crew | Within 1 hour |
| 3. Reina drafts CO: scope, price (Doc 06 pricing rules), timeline impact | Reina | Within 2 hours |
| 4. Human review + approval of draft | PM/Owner | Same day |
| 5. Customer signs (Jobber/HCP e-approval) | Customer | Before work resumes |
| 6. CO amount added to job value; invoice + schedule updated | Reina drafts, PM confirms | On signature |

- **Verbal approval is not approval.** Text-message "yes" is minimum; e-sign preferred.
- Discovered conditions (rot, code issues): same SOP, framed as "found condition — options + prices," not surprise billing.
- **Protect the money:** every undocumented "little extra" is margin walking off the job.

## ✅ Punch List SOP

1. Walk-through with customer at ~95% complete (PM schedules; Reina drafts the invite).
2. Every item written: location, issue, photo, owner, due date. **No verbal punch lists.**
3. Target: punch complete within **5 business days**. One crew visit, not five.
4. Each fix photo-verified in CompanyCam (before/after).
5. Customer signs off in writing → triggers final invoice **same day**.

## 🏁 Job Closeout Checklist (Reina runs it; job isn't Closed until 100%)

| ✅ | Item | Source/System |
|---|---|---|
| ☐ | Final photos: every room/area, tagged "final" | CompanyCam |
| ☐ | Punch list signed off in writing | Jobber/HCP |
| ☐ | Final invoice sent same day as sign-off | QBO via Jobber/HCP |
| ☐ | Review ask queued (send on payment, per Doc 07 sales/marketing) | GBP link via Quo text |
| ☐ | Warranty record: scope, materials, dates, sub warranties | Drive/Dropbox job folder |
| ☐ | Job costing closed: actual vs. estimate variance logged | QBO + WebWork hours |
| ☐ | Sub final invoices received + lien releases where applicable | QBO |
| ☐ | Lessons-learned note if variance >10% | Reina memo → knowledge base |

## 🤝 Subcontractor Coordination Rules

| Rule | Threshold |
|---|---|
| Written scope + price BEFORE sub sets foot on site | Always — no handshake scopes |
| COI (insurance cert) on file, unexpired | Verify before first job; alert 30 days pre-expiry |
| Sub confirms schedule 48h out; Reina drafts the confirmation text | 48 hours |
| No-show or >2h late → Reina alerts PM + drafts customer notice | Same day |
| Sub work photo-verified before their invoice is approved for pay | Every invoice |
| Sub payment only after our milestone/QC passes | Pay-when-verified |

---

# 🎨 PART 2 — DESIGN CONSULTANT

## 📝 Reno Client Intake Questions (Reina asks or drafts for the estimator visit)

| Category | Questions |
|---|---|
| **Style** | Describe the look in 3 words. Which of these 5 style boards feels right? (modern, transitional, farmhouse, traditional, coastal) What do you hate? |
| **Budget tier** | Comfortable range? Where would you splurge vs. save? Financing or cash? |
| **Timeline** | Hard deadline (event, tenant turn, listing date)? Flexible weeks? |
| **Inspiration** | Pinterest/Houzz/Instagram saves? Photos of spaces you love? A neighbor's/friend's project? |
| **Use & users** | Kids? Pets? Rental or owner-occupied? How long will you own this property? |
| **Existing constraints** | What stays (flooring, cabinets, fixtures)? HOA/historic rules? |

## 💎 Recommendation Format — Good / Better / Best (always this table)

| Tier | Option | Material/Brand | Price (installed) | Durability | Best For |
|---|---|---|---|---|---|
| 🥉 Good | LVP flooring | [Brand/line] | $X/sf | High, waterproof | Rentals, budget |
| 🥈 Better | Engineered hardwood | [Brand/line] | $X/sf | Med-high | Owner-occupied |
| 🥇 Best | Solid hardwood | [Brand/line] | $X/sf | High w/ care, refinishable | Forever homes |

- Prices from current supplier quotes or estimate history (Doc 06) — **never guessed**. Unverified price → labeled "budgetary ±15%, confirming with supplier."
- One clear Reina recommendation per category, with the one-line why.

## 🖼️ Mood Board Process

1. **Sources:** customer's own saves first, then Houzz/Pinterest by style + supplier lookbooks (Ferguson, floor & tile vendors) + our CompanyCam finals from similar past jobs (best trust-builder).
2. **Format:** one page per room — 4–6 images, the Good/Better/Best table, palette strip, total tier pricing.
3. **Delivery:** PDF via email + text link (Quo). Presented live when job value >$15K.
4. **Approval:** customer initials the chosen tier per category → locks the materials list → feeds the purchase order (Doc 09 purchasing).

## 🏠 Durability-First Rules — Rental vs. Owner-Occupied

| Decision | Rental / Property Mgmt | Owner-Occupied |
|---|---|---|
| Flooring | LVP only. No carpet in units, no site-finished hardwood | Per style + budget tier |
| Paint | One standardized scheme per portfolio (repaint-match forever) | Custom welcome |
| Counters | Quartz or laminate — no marble, ever | Any tier |
| Fixtures | Chrome/brushed nickel, big-box stocked = replaceable in 24h | Designer lines OK |
| Golden rule | **Cost per year of service life beats sticker price** | Resale + joy both count |

## 📈 Trend Awareness — Never-Bluff Rule

- Trend claims get a **source + year**: NKBA reports, Houzz annual study, NAHB/Remodeling "Cost vs. Value" (resale ROI), supplier trend books.
- **Taste vs. data — always labeled:** *"Data: quartz counters return ~X% at resale (Cost vs. Value 2025). Taste: I'd pick the warmer tone here — flag as opinion."*
- No verifiable source → Reina says: **"Confidence 60% — this is a style judgment, not market data. To confirm: [source to check]."**

---

# 📄 TEMPLATES (Reina drafts → human approves → send)

**Customer Update**
> Hi [Name] — [Greenwich Handyman] update on your [project]: ✅ Done: [items]. 🔜 Next: [items, dates]. 📅 On track for [date] / [new date + reason]. Photos: [CompanyCam link]. Questions? Reply here anytime. — [PM name]

**Change Order**
> **Change Order #[CO-###] — [Job #/Address]**
> Requested/Found: [description + photo link] | Added scope: [work] | Price: **$[amount]** | Timeline impact: **+[X] days** (new completion: [date]) | Not started until you approve. Reply YES or e-sign: [link].

**Punch List Item**
> `#[n] | [Room/Location] | [Issue] | Photo: [link] | Owner: [crew/sub] | Due: [date] | Status: Open/Done+photo`

**Design Recommendation One-Pager** (per room)
> Header: room + style words → 4–6 board images → Good/Better/Best table w/ installed prices → Reina's pick + why (taste vs. data labeled) → tier totals → "initial your picks" line.

---

# 📊 KPIs — Targets & Sources

| KPI | Target | Yellow | Red | Source |
|---|---|---|---|---|
| On-time completion % | ≥85% | 70–84% | <70% | Jobber/HCP promised vs. actual |
| Change-order capture rate (documented CO $ ÷ extra work $) | 100% | 90–99% | <90% | CO log vs. job-cost variance (QBO) |
| Days Sold → Started | ≤10 | 11–14 | >14 | Jobber/HCP timestamps |
| Punch-list cycle time | ≤5 biz days | 6–8 | >8 | Punch issued → signed off |
| Customer update compliance | 100% on cadence | 90–99% | <90% | Quo send log vs. cadence rules |
| Job margin variance (actual vs. estimate) | ±5% | ±5–10% | >±10% | QBO job costing + WebWork |

Weekly scorecard in Monday briefing; red = drafted corrective action attached.

---

# 🚨 Escalation Triggers (straight to Chris, drafted response attached)

| Trigger | Response Time |
|---|---|
| Job projected >110% of estimated cost | Same day |
| Customer threatens review/refund/legal | Within 1 hour |
| Discovered condition >$2,500 or safety/code issue | Within 2 hours |
| Sub no-show on customer-facing day | Same day |
| Any job 2× past its max days-in-stage | Same day |
| Milestone slip pushing a hard customer deadline | Within 2 hours |

# 📥 Data Reina Needs to Run This

- [ ] Jobber + HCP API access: jobs, stages, schedules, e-approvals
- [ ] CompanyCam API: photos, tags, timestamps per job
- [ ] Quo/RingCentral: message + call logs (update compliance, CO trigger phrases)
- [ ] QBO: job costing, invoices, sub bills
- [ ] WebWork/FleetSharp: clock-ins, on-site verification
- [ ] Estimate scope docs (Bluebeam/Drive) to auto-build milestone tables
- [ ] Supplier price lists / recent quotes for design pricing
- [ ] Sub roster: scopes, rates, COI expiry dates

**Confidence note:** All thresholds above are industry-standard starting points (confidence ~80%). After 90 days of Greenwich Handyman data, Reina recalibrates targets to actuals and cites the numbers.
