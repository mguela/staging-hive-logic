# Client Portal — Phase 1 spec

Companion to `sub-portal-spec.md`. Built 2026-07-21 at Chris's request
("lets build the client portal"), grounded in the existing Client Portal
mockup already embedded in the main app (`public/index.html`, view `pcx`,
under Portals & Field), not guessed from scratch.

## What's real vs. portal-native

- **Real, synced Jobber data (read-only):** `clients`, `jobs`, `invoices` —
  already populated by `api/jobber/sync.js` on a cron. This portal reads
  those tables directly by `jobber_id` (`client_ref` everywhere in this
  module); it never creates or edits a client record.
- **Portal-native (new in `sql/013_client_portal.sql`):** auth
  (`client_auth_links` / `client_sessions`), `client_messages`,
  `client_notifications`, `client_approvals` (estimate + change-order
  e-sign — not currently synced from Jobber, so staff creates these in the
  portal directly), `client_payments` (payment *requests*, not charges),
  `client_audit_log`.

## Decisions made this session

- **Login is email-only in Phase 1.** `api/jobber/sync.js`'s client query
  only pulls `defaultEmails`, not phone — so there's no phone field to
  match against yet. Adding it is a one-line follow-up to that sync query
  whenever it's wanted, not a blocker here.
- **Payments — Chris's call: Option B, mockup.** The "Pay Now" flow is
  real and working end-to-end, but it produces a *request* record
  (`client_payments`, status `requested`), not a live charge. No payment
  processor is wired in. The client sees an honest message: "sent to the
  office to follow up." Whether an invoice is actually paid still comes
  from Jobber's synced `invoices.payments` field, same as the internal app
  today. Going live with real processing is a Phase 2 decision (Jobber's
  own hosted invoice-payment link vs. a custom processor).
- **No client-editable profile.** Client identity comes from Jobber; the
  Account tab is read-only with a note to contact GH Group for changes,
  rather than building a shadow copy that could drift from Jobber.
- **Job "timeline" is computed, not invented.** Jobber's exact job-status
  enum isn't confirmed field-for-field in this codebase, so job stage
  (estimate / scheduled / in progress / completed) is derived from
  `start_at` / `completed_at` dates only — same "computed, not invented"
  rule `api/invoices.js` already uses for balance.

## Not yet wired (disclosed, not faked)

- SMS/email auto-dispatch — `login_link` and `invite` both return the
  magic link directly in the API response, same as the Sub Portal.
- Live payment processing (see above).
- A staff-facing invite UI / approval-creation UI — both exist as API
  actions (`invite`, `approval_create`) but need a staff-side form; for
  now, staff calls them with a Bearer token the same way Sub Portal invites
  work today.

## Phase 2+ (not built)

- Real payment processing (pick a path: Jobber-hosted link vs. custom).
- Two-way estimate/change-order sync with Jobber itself, if/when Jobber's
  API exposes writable estimates.
- Staff Approval Inbox surface for payment requests and rejected
  approvals (currently visible via `client_audit_log` only).
- SMS/email dispatch.
