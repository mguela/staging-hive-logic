// api/_lib/guard.js
// THE global server-side auth choke point for /api/* (2026-08-01, Item 3).
//
// The problem this closes: most company-data endpoints (track1's financial
// resources handleFiCash/handleFiLeaks/handleFiOverhead, bookkeeping
// reference-data, import-companycam, etc.) shipped with NO server-side auth —
// they relied on the frontend not linking to them. Anyone who knew the URL
// could read financials, customers, jobs, schedules, and more.
//
// The fix is one guard, enforced in `middleware.js` (Vercel Edge Middleware,
// matcher '/api/:path*') so EVERY /api request is checked before it reaches a
// handler — not a per-endpoint patch. This module holds the guard's decision
// logic as pure, injectable functions so the security rules can be unit
// tested exhaustively without a network or the edge runtime.
//
// A request is allowed when ANY of these hold:
//   1. Its path is on the PUBLIC allowlist — genuinely public routes, or
//      machine endpoints that authenticate by their OWN mechanism (OAuth
//      callbacks, signed webhooks, the client/sub portals' session tokens,
//      the monitor agents' bearer tokens). Those mechanisms are hardened by
//      their own stabilization items (1, 4, 5, 6, 9); this guard stays out of
//      their way rather than double-gating them with a Supabase session.
//   2. It carries a valid Supabase user session (a real signed-in employee;
//      every employee is an admin this phase, so authenticated == authorized).
//   3. It targets a known Vercel Cron path AND carries the valid CRON_SECRET
//      bearer that Vercel attaches to cron invocations. This lets the same
//      endpoint (e.g. track1?resource=check_new_leads) serve both signed-in
//      users and the scheduler without opening it to the public.
//   4. It targets one specific, narrowly-scoped public RESOURCE+METHOD pair
//      that carries no company data (see PUBLIC_RESOURCE_PATHS below) - e.g.
//      the Reina hourly status push, which writes only an internal
//      engineering to-do list (no financials/customers/PII) and is read back
//      by the Command Center's own authenticated session anyway.
//
// Everything else is denied with 401.

// --- Public allowlist ------------------------------------------------------
// Exact paths or path prefixes that are exempt from the Supabase-session
// requirement. Keep this list tight and documented — each entry says why it's
// safe and what actually authenticates it.
export const PUBLIC_API_PREFIXES = [
  '/api/health',              // health + health-test liveness checks (no data)
  '/api/health-test',
  '/api/jobber/callback',     // Jobber OAuth redirect target (Jobber calls it)
  '/api/jobber/webhook',      // Jobber webhook + drain (machine; own handling)
  '/api/qbo',                 // Intuit OAuth callback + connect; data resources
                              //   self-gate with requireUser inside qbo/index.js
  '/api/gusto',               // Gusto OAuth start + callback + status probe
                              //   (status returns only booleans). Same pattern
                              //   as /api/qbo; payroll data pulls run server-side
                              //   in gusto-payroll-sync.js, never via this route.
  '/api/msmail',              // Microsoft OAuth connect/callback (Item 5)
  '/api/mail',                // IMAP/SMTP mailboxes — self-gates with its own
                              //   dual-realm requireUser on every data action
                              //   (health exposes no data), same as /api/msmail.
                              //   Needs the exemption because the edge guard only
                              //   verifies MAIN-project sessions, but HiveConnect
                              //   callers carry a HiveConnect-project JWT.
  '/api/invites',             // Employee invites — redeem?token= is authenticated
                              //   by the one-time CSPRNG token itself (no Supabase
                              //   session yet for a new hire); create self-gates
                              //   with requireApiAuth inside the handler. Same
                              //   self-gating pattern as /api/qbo and /api/mail.
  '/api/schedule/confirm',    // Customer appointment confirm/decline link. Same
                              //   pattern as /api/invites above: authenticated by
                              //   the 256-bit CSPRNG token in the emailed link,
                              //   which is stored only as a SHA-256 hash. The
                              //   recipient is a customer with no HiveLogic
                              //   account, so no session can exist. The token
                              //   authorises two values in ONE column of ONE
                              //   appointment -- it cannot move, cancel, read or
                              //   list anything -- and the handler pins itself to
                              //   GET/POST with fail-closed rate limiting.
  '/api/bookkeeping/estimates/respond', // Client Approve/Reject link, emailed
                              //   by estimates/send.js. Exact same pattern as
                              //   /api/schedule/confirm above (respond.js's
                              //   own header comment says so explicitly): a
                              //   256-bit CSPRNG token, hashed at rest,
                              //   single-use, rate-limited per token AND IP,
                              //   authorizing exactly one estimate's
                              //   approve/reject -- nothing else is readable
                              //   or writable through it. The recipient is a
                              //   customer with no HiveLogic account, so no
                              //   session can ever exist. Found live,
                              //   2026-08-27: this route was built to mirror
                              //   /api/schedule/confirm but never actually
                              //   added here, so the edge gate 401'd every
                              //   real client who clicked a real emailed
                              //   link -- unreachable since it shipped
                              //   because nobody had a working Resend key to
                              //   click a real one until now.
  '/api/authnet-webhook',     // Authorize.Net webhook — signature-authenticated (Item 4)
  '/api/resend-webhook',      // Resend webhook — signature-authenticated (Item 6)
  '/api/voice-webhook',       // Twilio voice webhook — provider-authenticated
  '/api/voice',               // Twilio voice entrypoint — provider-authenticated
  '/api/clientportal',        // Client Portal — own client-session tokens (Item 1)
  '/api/subportal',           // Sub Portal — own sub-session tokens (Item 1)
  '/api/agents/',             // Automation agents (control/device/enrollment) —
                              //   own bearer tokens (Item 9). NOTE: this is NOT
                              //   the HiveLogic Monitor desktop agent, despite
                              //   what this comment said until 2026-08-16. That
                              //   one posts to /api/track1?resource=monitor_*
                              //   and is allowlisted in PUBLIC_RESOURCE_PATHS
                              //   below; the wording here is what made it look
                              //   covered for two weeks while it was 401'ing.
  '/api/ai-workroom',         // Desktop history/agent bridge. The handler
                              //   independently requires either a valid signed-in
                              //   user or HIVELOGIC_WORKROOM_AGENT_SECRET plus a
                              //   configured owner; this exemption only lets that
                              //   dedicated machine credential reach its check.
  '/api/web-lead',            // Website enquiry form. Public by necessity, same
                              //   as /api/schedule/confirm above: the person
                              //   filling it in has no HiveLogic account and
                              //   never will, so no session can exist. It is
                              //   WRITE-ONLY and creates exactly one lead --
                              //   it cannot read, list, or update anything,
                              //   and its response is byte-identical whether or
                              //   not the submitter matched an existing client,
                              //   so it cannot be used to enumerate customers.
                              //   Pinned to POST, honeypot-screened, every
                              //   field length-capped, and rate limited per IP
                              //   failing CLOSED on the same limiter as the
                              //   portal recovery endpoints.
  '/api/marketing-unsubscribe', // public one-click unsubscribe link
  '/api/test-workflow',       // CI runner — own runner secret (Item 2)
  '/api/status-hub-ingest',   // failure-only CI/reporting intake — its handler
                              //   requires STATUS_HUB_INGEST_SECRET and has no
                              //   read surface.
  '/api/status-hub-log-drain', // Vercel/Supabase log drain intake — its handler
                              //   requires STATUS_HUB_LOG_DRAIN_SECRET and has
                              //   no read surface, same shape as the CI intake
                              //   above.
];

// --- Cron allowlist --------------------------------------------------------
// Paths Vercel Cron invokes (see vercel.json "crons"). These are exempt from
// the user-session requirement ONLY when they carry the valid CRON_SECRET.
// Some are whole paths (the endpoint exists only for machine/sync use); some
// are a specific ?resource= on an otherwise user-facing endpoint, so we pin
// the exact resource — the endpoint's OTHER resources still require a user.
const CRON_WHOLE_PATHS = [
  '/api/jobber/sync',
  '/api/jobber/sync-extended',
  '/api/import-companycam',
  '/api/health-cron',
  '/api/reina/scan-change-requests', // Reina auto-scan (off by default; not yet scheduled)
  // Read exemption (2026-08-15): api/snapshot.js was given handler-side
  // CRON_SECRET acceptance so unattended read-only checks (the daily AR /
  // Business Pulse pulls) would stop 401'ing -- but the middleware half was
  // never added, so those requests died HERE, at the edge, before the handler
  // could honour the secret they were already carrying. Verified against
  // production: GET /api/snapshot WITH a bearer still returns the middleware's
  // "Authentication required.", never the handler's "Not signed in.".
  // Same shape as the 2026-08-05 track1 leaks/watching_margin_fade fix below.
  // Safe: snapshot is a read-only aggregate route with no write path, and
  // api/snapshot.js still self-gates (checkCronSecret, else requireUser), so a
  // caller without the secret is refused by the handler even during the
  // cron-grace-no-secret window. It stays OFF the public allowlist.
  '/api/snapshot',
  // Fleet Slice 3 (2026-08-16): records live truck GPS (from public.vehicles,
  // FleetSharp/Jobber) into the Fleet history tables every few minutes.
  // Cron-only machine endpoint; self-gates with requireApiAuth AND FLEET_ENABLED,
  // reads the mirror + writes only fleet_* tables (never public.vehicles).
  // Allowlisted here in the SAME change that schedules it in vercel.json.
  '/api/fleet/record-positions',
  // Reina desktop notifications (2026-08-19): the unattended half of mail
  // triage. Reads the owner's Microsoft mailboxes with the tokens already in
  // hc_ms_tokens, judges what is new, and pushes what is worth interrupting
  // him for -- the thing that could not exist while every read started from
  // his browser. Cron-only machine endpoint: self-gates with requireApiAuth,
  // writes only reina_* tables, and moves no mail. Allowlisted here in the
  // SAME change that schedules it in vercel.json.
  '/api/reina/mail-sweep',
  // Fleet Slice 6 (2026-08-16): matches recorded truck positions to scheduled
  // job sites, writing fleet_job_presence intervals (evidence only, no alerts).
  // Cron-only; self-gates with requireApiAuth AND FLEET_ENABLED; reads
  // fleet_positions + jobs_enriched, writes only fleet_job_presence.
  // Allowlisted in the SAME change that schedules it in vercel.json.
  '/api/fleet/detect-presence',
  // Ops event sweep (2026-08-22): runs the detectors behind the operational
  // feed -- finished-but-uninvoiced jobs, crews over their window, work booked
  // for a client flagged "no work". Cron-only machine route: self-gates with
  // requireApiAuth, reads visits/invoices/clients/quotes and writes only ops_*
  // tables. It sends nothing. Allowlisted in the SAME change that schedules it.
  '/api/ops-events',
];
// Entries may pin `method`; when omitted the entry matches any method (the
// pre-2026-08-15 behaviour, kept so the already-live entries below are not
// re-scoped by this change). New read-only entries pin GET so an allowlisted
// read resource can never be used as a door to a write on the same endpoint.
const CRON_RESOURCE_PATHS = [
  { path: '/api/marketing', resource: 'process_scheduled_sends' },
  { path: '/api/track1', resource: 'check_new_leads' },
  // Read exemption (2026-08-05): daily AR/job-costing health checks carry the
  // valid CRON_SECRET but were still 401'ing here -- this allowlist is keyed
  // on path+resource, checked BEFORE the secret itself, so check_new_leads
  // being present didn't cover these. Both are read-only financial GETs, same
  // trust level as check_new_leads.
  { path: '/api/track1', resource: 'leaks' },
  { path: '/api/track1', resource: 'watching_margin_fade' },

  // Read exemption (2026-08-15): the rest of track1's financial read surface.
  // The 2026-08-05 fix above added only the two resources whose scheduled
  // check was failing loudly at the time; the unattended Business Pulse /
  // Engineering Audit runs read the others too and have 401'd at this edge
  // ever since the guard shipped on 2026-08-01 -- the "financial data
  // blackout". api/snapshot.js + api/qbo/index.js were fixed earlier today
  // (d6c3b61); this is the third and last leg of that same half-shipped fix.
  //
  // Not a guess at what the schedulers want: this is exactly track1's OWN
  // FINANCIAL_RESOURCES list (api/track1.js, the role gate) plus dailybrief.
  // That role gate already reads `!(gate && gate.via === 'cron')` -- it was
  // written to let a cron caller through these very resources, which could
  // never happen because this edge allowlist rejected them two layers earlier.
  // dailybrief is the Command Center's Business Pulse tile source and is
  // deliberately outside that role gate (visible to every role).
  //
  // Safe: all five handlers take `res` only -- they are handed no req, so they
  // cannot read a body, a method or a query and have no write path at all.
  // GET-pinned anyway, and track1's own requireApiAuth still runs behind this.
  { path: '/api/track1', resource: 'dailybrief', method: 'GET' },
  { path: '/api/track1', resource: 'cash', method: 'GET' },
  { path: '/api/track1', resource: 'overhead', method: 'GET' },
  { path: '/api/track1', resource: 'forecast', method: 'GET' },
  { path: '/api/track1', resource: 'jobs_margin_list', method: 'GET' },

  // Drift repair (2026-08-15): scheduled in vercel.json since it was added,
  // but never allowlisted here, so every 08:00 run has died at the edge.
  // Internal data-retention prune (monitor screenshots/sessions past
  // MONITOR_RETENTION_DAYS) -- no company data out, nothing customer-facing,
  // and handleMonitorPrune re-checks CRON_SECRET itself, so it stays
  // fail-closed twice over.
  { path: '/api/track1', resource: 'monitor_prune' },

  // Browser-gone sweep (2026-08-16): closes clock-ins whose browser went away
  // and never came back, backdated to the moment it went. Cron-only and
  // GET-pinned; handleWorkforceSweepGone re-checks CRON_SECRET itself
  // (timing-safe), so it stays fail-closed twice over. Allowlisted here in the
  // same commit that schedules it -- the drift documented all over this file
  // is what happens when those two steps get separated.
  { path: '/api/track1', resource: 'workforce_sweep_gone', method: 'GET' },

  // Drift repair, remaining scheduled routes (2026-08-15). These nine are the
  // rest of the vercel.json/guard drift: 8 marketing lifecycle auto-sends and
  // the social publisher. All have been scheduled but 401'ing at this edge
  // since the day they shipped -- they have never run, not once.
  //
  // Held back in the first pass of this fix, then cleared to land after
  // confirming each is independently switched off BEHIND this guard, so
  // reaching the handler is not the same as sending:
  //
  //   * The 7 lifecycle auto-sends all run through runLifecycleAutosend
  //     (api/marketing.js), which returns {sent: 0} unless that playbook's
  //     own env var is set to 1/true. None are set.
  //   * process_review_request_autosend needs BOTH
  //     REVIEW_REQUEST_AUTOSEND_DAYS (a positive number) and
  //     GOOGLE_REVIEW_LINK; without either it returns {sent: 0}.
  //   * process_scheduled_posts publishes only posts already past their
  //     scheduled_for, and each publish requires that surface's connection to
  //     be launch_enabled. Verified read-only against production on
  //     2026-08-15: ad_platform_connections and social_posts are both EMPTY,
  //     so there is nothing to publish and no connection to publish with.
  //
  // So this restores the plumbing and nothing more. Turning any of them on
  // remains a separate, deliberate act: set that playbook's env var, or
  // connect a social surface. GET-pinned -- Vercel Cron issues GET, and these
  // must never be reachable as a write door.
  // Weekly growth scan. Reads real jobs/quotes/customers/ad spend and writes
  // growth_suggestions rows plus, at most, DRAFT ad campaigns. It cannot
  // launch an ad, send an email, or publish a post -- see the refusal list in
  // the header of api/growth.js -- and GROWTH_AUTOPILOT_ENABLED=false reduces
  // it to suggestions only. GET-pinned like every other cron entry here.
  { path: '/api/growth', resource: 'growth_scan', method: 'GET' },
  { path: '/api/social-posts', resource: 'process_scheduled_posts', method: 'GET' },
  { path: '/api/marketing', resource: 'process_review_request_autosend', method: 'GET' },
  { path: '/api/marketing', resource: 'process_post_job_thank_you_autosend', method: 'GET' },
  { path: '/api/marketing', resource: 'process_service_anniversary_autosend', method: 'GET' },
  { path: '/api/marketing', resource: 'process_dormant_reactivation_autosend', method: 'GET' },
  { path: '/api/marketing', resource: 'process_maintenance_reminders_autosend', method: 'GET' },
  { path: '/api/marketing', resource: 'process_new_lead_followup_autosend', method: 'GET' },
  { path: '/api/marketing', resource: 'process_newsletter_autosend', method: 'GET' },
  { path: '/api/marketing', resource: 'process_referral_autosend', method: 'GET' },

  // Company Setup automation runners (sql/087). Both gates live inside the
  // handler; this entry only lets the cron past the edge with its secret.
  // Missing entries here are what stranded 10 crons before -- the drift test in
  // test/cron-allowlist-drift.test.mjs fails CI if vercel.json and this list
  // ever disagree again.
  { path: '/api/automations', resource: 'missed_call_textback', method: 'GET' },
  { path: '/api/automations', resource: 'invoice_overdue_nudge', method: 'GET' },

  // Client-messaging outbox processor. Allowlisted in the SAME change that
  // schedules it in vercel.json -- see the drift note above. Sending is gated
  // three times over inside the handler (master switch, env var, channel), so
  // this entry only lets the cron past the edge with its secret.
  { path: '/api/schedule/outbox', resource: 'process', method: 'GET' },
];

// --- Narrow public-resource allowlist ---------------------------------------
// Unlike PUBLIC_API_PREFIXES (a whole path), these are ONE specific
// ?resource= value on an otherwise user-gated endpoint, restricted to ONE
// HTTP method. Keep this list as narrow as PUBLIC_API_PREFIXES - path +
// resource + method, never a whole endpoint.
//
// SECURITY (2026-08-18): reina_todo_set is deliberately NOT listed here.
// The former anonymous writer let any caller overwrite the admin Dev To-Do
// snapshot and allowed a stale third-party hourly task to erase verified
// remediation status. Writes now require a signed-in user or CRON_SECRET in
// the normal Track 1 gate; viewing remains separately admin-only.
const PUBLIC_RESOURCE_PATHS = [
  // Reina Lab read bridge. Middleware lets only this exact resource reach
  // track1; the handler then requires its own dedicated timing-safe bearer.
  { path: '/api/track1', resource: 'reina_lab_read', method: 'GET' },
  // FleetSharp Push API webhook (2026-08-11): FleetSharp POSTs live GPS here
  // as the vehicle GPS fix (Jobber's own upstream FleetSharp connection had
  // failed, leaving Vehicle.liveState.currentPosition days stale). This is a
  // real external vendor pushing on ITS OWN schedule, so it can't carry a
  // Supabase session or CRON_SECRET -- same pattern as reina_lab_read: let it
  // through here, then the handler requires its own dedicated
  // FLEETSHARP_PUSH_SECRET bearer (checkBearerSecret in this file).
  { path: '/api/jobber/sync-extended', resource: 'fleetsharp_push', method: 'POST' },

  // HiveLogic Monitor desktop agent (2026-08-16). THE BUG: this guard's public
  // allowlist carries '/api/agents/' with the comment "Monitor agents -- own
  // bearer tokens (Item 9)", but that prefix is the *automation* agent surface
  // (api/agents/control.js, device.js, enrollment.js). The screen-monitoring
  // desktop agent does not live there -- it calls four ?resource= values on
  // /api/track1 (hivelogic-monitor-agent/src/main.js). None were allowlisted,
  // so every one of its requests has been 401'd at the edge since this guard
  // shipped on 2026-08-01, and screen monitoring has been dead company-wide
  // ever since. Confirmed against production on 2026-08-16: Chris's agent's
  // last_seen_at is 2026-08-02, his last monitor_sessions row is 2026-08-01,
  // and he was clocked in with monitoring_enabled = true the whole time. Same
  // half-shipped-guard class as the snapshot / financial-read / monitor_prune
  // repairs above.
  //
  // The agent cannot carry a Supabase session (it is a desktop app, not a
  // browser, and it holds no user JWT) or the CRON_SECRET, so it belongs here
  // rather than in the cron list -- same shape as reina_lab_read and
  // fleetsharp_push: the middleware lets exactly these resources reach track1,
  // and the handler then demands the agent's own credential.
  //
  // Safe, and each is independently gated BEHIND this guard:
  //   * heartbeat / consent / screenshot_upload all call getRequestingAgent()
  //     -> requireMonitorAgent() (api/_lib/monitor.js), which SHA-hashes the
  //     presented bearer and requires a matching status='active' agent row.
  //     No token, revoked token, or wrong token = 401 from the handler.
  //   * pair is the enrollment exchange itself, so by definition it has no
  //     token yet -- same situation as /api/invites redeem?token=, already on
  //     the allowlist above. It is hardened on its own terms: a 6-digit code
  //     that expires in 15 minutes, at most 5 wrong guesses per code before
  //     the row is burned, and a flat 15-attempts-per-IP-per-10-minutes cap.
  // All four are POST-pinned -- the agent only ever POSTs -- so none of these
  // can be used as a GET door onto track1's read surface.
  // Browser-close clock-out beacon (2026-08-16). SEVENTH instance of the
  // half-shipped-guard class, and the same shape as the Monitor agent above:
  // navigator.sendBeacon is the only API browsers guarantee will finish
  // sending as a page goes away, and it CANNOT set an Authorization header.
  // The frontend therefore puts the Supabase token in the request body, and
  // getRequestingProfile() has a documented fallback that reads it from there
  // -- but middleware.js only ever looks at the header, so every one of these
  // has 401'd at the edge since this guard shipped on 2026-08-01.
  //
  // Proof from production, not inference: close_reason 'browser_closed' stops
  // dead at 2026-08-01 16:34, while 'idle_timeout' -- the SAME endpoint,
  // reached by an ordinary authenticated fetch that does carry a header --
  // still fires today. Same endpoint, two callers, only the header-less one
  // died, and it died on the day this file shipped.
  //
  // Safe: the handler still calls getRequestingProfile(), which verifies the
  // token against Supabase's own /auth/v1/user before touching anything. A
  // caller with no token, or someone else's expired one, is refused there. It
  // can only ever act on the session belonging to the token presented, and its
  // only power is to mark or close that person's own clock-in.
  { path: '/api/track1', resource: 'workforce_auto_clockout', method: 'POST' },

  { path: '/api/track1', resource: 'monitor_pair', method: 'POST' },
  { path: '/api/track1', resource: 'monitor_heartbeat', method: 'POST' },
  { path: '/api/track1', resource: 'monitor_consent', method: 'POST' },
  { path: '/api/track1', resource: 'monitor_screenshot_upload', method: 'POST' },
  // Phase 5 (2026-08-25): the desktop agent GETs the app whitelist with its
  // own bearer token to classify locally -- GET only. Writing a rule is an
  // admin action and stays gated normally (a real Supabase session already
  // clears this gate on its own; see handleMonitorAppRules for the
  // requester.role check that still applies inside the handler either way).
  { path: '/api/track1', resource: 'monitor_app_rules', method: 'GET' },

  // Customer card payment link (2026-08-19). EIGHTH instance of the
  // half-shipped-guard class catalogued above, and the only one that costs
  // money while it is broken.
  //
  // A tech raises a T&M invoice, the customer gets a /pay/?t=<token> link, and
  // that page's only call is GET /api/fieldops?action=tm_pay_init&t=... The
  // customer has no HiveLogic account, so no session can exist -- and
  // '/api/fieldops' is deliberately NOT on the prefix allowlist (there is a
  // test asserting exactly that, and rightly: the path's other actions read
  // visits, crews and billing). So every payment link 401s at the edge and the
  // page tells the customer "This payment link is no longer active."
  //
  // Verified with the decision function itself, not by inference:
  //   decideAccess({ pathname: '/api/fieldops',
  //                  searchParams: 'action=tm_pay_init&t=...',
  //                  hasValidUser: false, method: 'GET' })
  //     -> { allow: false, status: 401, reason: 'no-auth' }
  //
  // Safe, and the same capability-URL pattern as /api/schedule/confirm above:
  // authenticated by a 160-bit CSPRNG token (crypto.randomBytes(20)) that is
  // the only way to name the invoice. Pinned to this ONE action and to GET, so
  // it opens no other part of fieldops. The handler returns just the amount,
  // the cash-discount price and the job title for that single invoice, plus an
  // Authorize.Net hosted-form token -- no crew, no schedule, no client list.
  //
  // Residual risk worth recording: unlike /api/schedule/confirm, which stores
  // only a SHA-256 hash of its token, tm_invoices.pay_token is stored in
  // plaintext, so a database leak would expose live payment links. Hashing it
  // would invalidate every link already in a customer's text messages, so that
  // is a separate, migration-shaped decision -- not a reason to leave the
  // feature dead.
  { path: '/api/fieldops', param: 'action', resource: 'tm_pay_init', method: 'GET' },
];

function normalizePath(pathname) {
  // Treat "/api/foo" and "/api/foo/" and "/api/foo.js" alike; strip trailing slash.
  let p = String(pathname || '');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

export function isPublicApiPath(pathname) {
  const p = normalizePath(pathname);
  return PUBLIC_API_PREFIXES.some((prefix) =>
    prefix.endsWith('/') ? p.startsWith(prefix) : (p === prefix || p.startsWith(prefix + '/')),
  );
}

export function isCronPath(pathname, searchParams, method) {
  const p = normalizePath(pathname);
  if (CRON_WHOLE_PATHS.includes(p)) return true;
  const resource = searchParams && (typeof searchParams.get === 'function' ? searchParams.get('resource') : searchParams.resource);
  // Vercel Cron issues GET, so an absent method is treated as GET -- same
  // convention as isPublicResourcePath above. An entry with no `method` is
  // unpinned and matches any method.
  const m = String(method || 'GET').toUpperCase();
  return CRON_RESOURCE_PATHS.some((c) => c.path === p && c.resource === resource && (!c.method || c.method === m));
}

export function isPublicResourcePath(pathname, searchParams, method) {
  const p = normalizePath(pathname);
  const m = String(method || 'GET').toUpperCase();
  // Most endpoints name the thing being asked for in ?resource=. /api/fieldops
  // calls it ?action=, so an entry may name the parameter it is keyed on. The
  // default stays 'resource' so every existing entry is unchanged.
  const read = (key) => (searchParams
    ? (typeof searchParams.get === 'function' ? searchParams.get(key) : searchParams[key])
    : undefined);
  return PUBLIC_RESOURCE_PATHS.some((r) =>
    r.path === p && r.method === m && r.resource === read(r.param || 'resource'));
}

// --- Decision --------------------------------------------------------------
// Pure decision function. Callers supply the already-computed facts so this
// stays synchronous and trivially testable.
//   hasValidUser        - a valid Supabase session was presented
//   hasValidCronSecret  - Authorization matched CRON_SECRET (timing-safe)
//   cronSecretConfigured- whether CRON_SECRET is set in the environment
// Returns { allow: boolean, status: number, reason: string }.
export function decideAccess({ pathname, searchParams, hasValidUser, hasValidCronSecret, cronSecretConfigured, method }) {
  if (isPublicApiPath(pathname)) return { allow: true, status: 200, reason: 'public-allowlist' };
  if (isPublicResourcePath(pathname, searchParams, method)) return { allow: true, status: 200, reason: 'public-resource-allowlist' };
  if (hasValidUser) return { allow: true, status: 200, reason: 'valid-user' };
  if (isCronPath(pathname, searchParams, method)) {
    if (hasValidCronSecret) return { allow: true, status: 200, reason: 'valid-cron-secret' };
    // Rollout grace: if CRON_SECRET isn't configured yet, don't take down the
    // scheduler. Allow the *cron paths only* (never the general data surface)
    // and warn. Once CRON_SECRET is set, cron calls must carry it.
    if (!cronSecretConfigured) return { allow: true, status: 200, reason: 'cron-grace-no-secret' };
    return { allow: false, status: 401, reason: 'cron-bad-secret' };
  }
  return { allow: false, status: 401, reason: 'no-auth' };
}

// --- Verification helpers (used by middleware.js and by the named handlers) -

// Verify a Supabase session bearer against Supabase's own /auth/v1/user.
// Web-standard fetch only, so it runs in both the Edge middleware and Node
// handlers. Returns the user object or null.
export async function verifyUserBearer(authHeader, { fetchImpl } = {}) {
  const f = fetchImpl || fetch;
  const token = String(authHeader || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  if (process.env.CRON_SECRET && token === process.env.CRON_SECRET) return null;
  // Edge middleware may not receive Sensitive env vars. Read from several
  // possible names; prefer the anon key (safe/edge-exposed) for /auth/v1/user.
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const apiKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY;
  // If the edge runtime has NO usable Supabase config, do not fail the whole
  // API closed. Signal env-unavailable so the caller can defer enforcement to
  // the Node handlers (which run with full env and call requireApiAuth).
  if (!url || !apiKey) return 'ENV_UNAVAILABLE';
  try {
    const res = await f(url + '/auth/v1/user', {
      headers: { apikey: apiKey, Authorization: 'Bearer ' + token },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user && user.id ? user : null;
  } catch {
    return null;
  }
}

// Constant-time compare of the presented bearer to CRON_SECRET. Uses Web Crypto
// where node:crypto isn't available (Edge runtime). Falls back to a length-safe
// char loop only as a last resort.
export function checkCronSecret(authHeader) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const token = String(authHeader || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  return timingSafeStrEqual(token, secret);
}

// Constant-time compare of a presented bearer against an arbitrary secret
// (not necessarily CRON_SECRET) — used by narrow-purpose endpoints like the
// FleetSharp Push API webhook that need their own dedicated token instead of
// the global cron secret.
export function checkBearerSecret(headerValue, secret) {
  if (!secret) return false;
  const token = String(headerValue || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  return timingSafeStrEqual(token, secret);
}

function timingSafeStrEqual(a, b) {
  a = String(a);
  b = String(b);
  // Compare over the max length so the loop time doesn't leak which is longer;
  // still require equal length for a match.
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// One-call gate for use INSIDE a Node handler (defense in depth for the named
// high-value endpoints, and the enforcement point for anything the middleware
// matcher might miss). Accepts a valid user OR a valid cron secret. Returns
// { ok, user } — on failure the caller sends 401.
export async function requireApiAuth(req, { fetchImpl } = {}) {
  const headers = (req && req.headers) || {};
  const authHeader = headers['authorization'] || headers['Authorization'] || '';
  if (checkCronSecret(authHeader)) return { ok: true, user: null, via: 'cron' };
  const user = await verifyUserBearer(authHeader, { fetchImpl });
  if (user) return { ok: true, user, via: 'user' };
  return { ok: false, user: null, via: null };
}
