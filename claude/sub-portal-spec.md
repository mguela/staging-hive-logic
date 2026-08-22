# Subcontractor Portal — Build Spec (2026-07-21)

**Source:** Chris, dictated in chat 2026-07-21. This is the authoritative feature
list for the Sub Portal module. Grounded in the HiveLogic source-of-truth docs:

- `api/_lib/brain/00-master-prompt.md` Law 8: "Simplicity in front, complexity
  behind. Clients and subs get a plain 'Your next step' — never your machinery."
- Law 2 (Refusal Engine): expired/missing COI or license = job BLOCKED from
  schedule. Law 10: Reina drafts and chases; Chris approves.
- Blueprint Domain 1 (RFQ/RFI, bid leveling) and Domain 9 (supplier scorecards,
  materials bidding).

## THE DESIGN LAW (Chris, verbatim intent)

> THE PROCESS HAS TO BE SIMPLE ENOUGH THAT AN 8 YEAR OLD CAN DO IT.

Practical meaning, enforced on every screen:
- Magic-link auth. No passwords, ever.
- One primary action per screen: a big "Your next step" card.
- Photo-first: every upload (invoice, COI, W-9, license) can be done by taking
  a phone photo. Drag/drop and file-pick also work, but camera is the default.
- Mobile-first. Subs live in their trucks, not at desks.
- Plain words. "Send us your price" not "Submit RFQ response."

## Feature list (Chris's spec, organized)

### Sign-up / onboarding
1. Sub receives an invite to the portal (email/SMS with magic link).
2. Fills ONE form: contact info, AP info, whether they accept credit-card
   payment, licensing info, insurance info.
3. Uploads docs (COI, W-9, license) — drop, scan, or phone photo.
4. Adds banking info for ACH payments.

### Working
5. Receives RFQs through the portal; submits bids in the portal.
6. Submits RFIs through the portal.
7. Views their schedule (their scope only); requests modifications; approves
   schedule requests sent to them.

### Money
8. Checks account balance and payment schedule.
9. Submits invoices by dropping, scanning, or photographing them.

### Automated chasing (no human effort)
10. Automated reminders: bids due, invoices due, upcoming schedule,
    unapproved schedule sitting idle, and doc/license/insurance expiring
    ("upload the current one" with a one-tap camera link).

## Build phases

| Phase | Ships | Notes |
|---|---|---|
| 1. Foundation | subs table, invite + magic-link auth, onboarding form, doc upload w/ expiry dates | Unblocks everything else |
| 2. Money | invoice submission (photo-first), balance + payment schedule view | Reads from QBO/job data where connected; honest "not connected" otherwise |
| 3. Work | RFQ send/respond, RFI create/answer, schedule view + change requests | Bid data feeds future bid-leveling |
| 4. Chasing | reminder engine (cron) for all notification types | Drafts go through approval where they're outbound comms |

## Data model sketch (Supabase, follows existing sql/ migration conventions)

- `subs` — id, company_name, contact_name, phone, email, accepts_cc boolean,
  ap_contact/ap_email, status (invited/active/suspended), created_at
- `sub_auth_links` — id, sub_id, token (single-use), expires_at, used_at
- `sub_documents` — id, sub_id, doc_type (coi/w9/license/other), file_url,
  expires_at, uploaded_at, status (current/expiring/expired)
- `sub_banking` — id, sub_id, ach details (ENCRYPTED at rest — never in
  plaintext, never in logs; consider tokenizing via payment provider instead
  of storing raw account numbers at all)
- `sub_rfqs` — id, sub_id, job_ref, scope, docs, due_date, status
  (sent/viewed/bid_submitted/declined/expired), bid_amount, bid_notes,
  bid_submitted_at
- `sub_rfis` — id, sub_id, job_ref, question, answer, status, timestamps
- `sub_schedule_items` — id, sub_id, job_ref, start/end, scope,
  status (proposed/approved_by_sub/change_requested), change_note
- `sub_invoices` — id, sub_id, job_ref, file_url, amount (parsed or entered),
  status (submitted/approved/scheduled/paid), payment_due
- `sub_notifications` — id, sub_id, type, payload, send_after, sent_at

## Security notes (non-negotiable)

- Sub-facing routes are token-scoped: a sub can only ever see their own rows.
- Banking/ACH data: encrypted at rest, ideally never stored raw (use a
  payments provider token). Never returned to the frontend after entry
  (masked: ****1234). Never logged.
- Doc files in a private storage bucket; signed URLs only.
- Magic-link tokens: single-use, short expiry, revocable.

## Notification delivery — HiveConnect + "Chirp" (added by Chris mid-session)

All sub-facing messaging ties back to **HiveConnect** (the comms/phones layer):
reminders, bid-due notices, schedule notifications, doc-expiry chasing all go
out through HiveConnect's messaging to the sub's phone. Subs additionally get
the option to **download the app and opt into the "Chirp" feature** — the
push/messaging channel for these notifications. Portal invite + reminders must
therefore not build a separate notification stack: they enqueue through
HiveConnect. (Dependency note: the HiveConnect embed/merge is a separate
in-flight effort — see claude/hiveconnect-*.md. Phase 4 chasing should target
whatever HiveConnect surface is live when it ships; SMS/email fallback for subs
who don't opt into Chirp.)

## v2 revisions (Chris, 2026-07-21 — after reviewing mockup v1)

Answered: comms are BOTH — "all comms get pushed to text and emails as
available" (Chirp/app push is the opt-in third channel on top).

Information architecture (locked):
- Visual style: match the HiveLogic app — dark theme, tokens from
  public/index.html :root (canvas #0e1320, card #171f30, line #26304a,
  ink #c9d3e4, steel-blue accent #8fa9c4/#9db8d4), layered card shadows
  (0 10px 30px rgba(22,30,46,.35); deep 0 24px 70px .45).
- Home screen main square = **Notifications** (that exact title) — one feed
  aggregating everything actionable from all areas (bids due, schedule OKs,
  doc expiry, payments), each row with a one-tap action button.
- Bottom tabs: **Home · Jobs · Schedule · Money · Account** (5).
- **Jobs tab** (new): the sub's job list with status, plus RFQ (send your
  price) and RFI (ask a question) living under the job they belong to.
- **Messaging available from every tab** — floating 💬 button on all screens
  opens the message thread (rides on HiveConnect).
- Schedule page titled just "**Schedule**": every actionable event listed,
  each with a "Request a change" button; needs-OK items get an approve
  button; **"Add my schedule to my phone's calendar"** — subs get a request
  to add their schedule to their native calendar (calendar invite/ICS sync).
- Money page titled just "**Money**" (not "Your money").
- Money: **invoice follow-up** — list of previously sent invoices with
  payment status (submitted/scheduled/paid), and a "Follow up" button on
  anything without a payment date.
- **Account tab** (new): user profile + account settings — contact info,
  paperwork (docs + expiry, camera-first upload), ACH banking (masked) +
  CC acceptance, notification preferences (text/email/Chirp toggles),
  calendar sync toggle.

Mockup v2 reflecting all of this: claude/sub-portal-mockup.html.

## Audit outcomes — APPROVED by Chris 2026-07-21 ("love all these ideas")

These are now official requirements, folded into the phases below.

### P0 — hard requirements before/with Phase 1 code

1. **Progressive onboarding.** Magic link → confirm name & phone → the sub is
   IN. W-9/COI/banking are chased afterwards through the Notifications feed,
   one item at a time. Never a long form on day one. Onboarding is the
   hardest 8-year-old test in the product — design it first, not last.
2. **No raw ACH storage.** Bank details tokenized via a payment provider
   (evaluate QBO Bill Pay / Melio / Stripe during Phase 2 scoping). The
   portal stores only a masked reference (••••4821). NACHA compliance comes
   from the provider, not from us.
3. **Server-side sub scoping + audit log.** Every query filtered by the
   sub_id derived from the token — never trusted from the client. Editing
   banking requires a fresh magic link (re-auth). Every sub action (bid
   submitted, schedule approved, doc uploaded) is audit-logged for disputes.
4. **One consolidated API function.** All sub-portal endpoints live in a
   single `api/subportal.js` with a resource= dispatcher, mirroring
   track1.js — this repo hit Vercel's function-count limit before. Never one
   file per route.
5. **Session reality.** Magic links open in email webviews and get lost:
   long-lived device sessions once opened; "text me a new link" is the ONLY
   recovery path. No passwords exist anywhere, including failure cases.

### P1 — build into Phase 1–2 while cheap

6. **Invoice OCR + one-tap confirm.** Photo → OCR → "We read $3,650 — right?"
   Wrong → sub types it. Structured AP data captured invisibly.
7. **Offline-tolerant uploads.** Queue locally, auto-retry; show "✓ Sent"
   only on real success. Job sites have bad signal.
8. **Spanish from day one.** ES/EN toggle; all UI strings externalized now
   (~40 strings) instead of retrofitted later.
9. **Calendar = subscription, not invites.** Per-sub webcal URL so
   reschedules auto-update their native calendar; one-off ICS fallback.
10. **Designed empty states.** New sub, no jobs: "You're all set — we'll
    ping you when something needs you." Never a blank screen.
11. **"Follow up" creates a task on Chris's side** (approval inbox item),
    never a direct auto-email from sub to Chris.

### P2 — later, high value

12. Lien-waiver flow tied to payment release (sign → payment releases).
13. Structured bid fields (qty/unit price, optional) → feeds bid leveling.
14. Multi-user per sub company (owner + office manager, same company).
15. Sub scorecards auto-fed from portal behavior (response time, on-time %,
    quote speed) → Domain 9 vision.

### North-star principle (from the audit)

The portal's moat is that every sub action lands as STRUCTURED DATA (bids,
confirmations, docs, invoices) instead of texts and voicemails. Every feature
must capture structure without the sub ever feeling it.

## Open questions for Chris (none block Phase 1)

- Payment provider choice for ACH tokenization (QBO Bill Pay / Melio /
  Stripe) — decision needed by Phase 2, not Phase 1.
- Which sub gets the pilot invite? (Suggest: one friendly sub, e.g. Pickwick.)
