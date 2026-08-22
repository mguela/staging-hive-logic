# Session status log (read this first, add to it last)

## 2026-08-16 -- Claude -- GPS health check follows the FleetSharp-only decision
- Branch `claude/gps-health-check-fleetsharp`. Narrow follow-on to the
  FleetSharp-only GPS change already on main (see the "Monitoring ALIVE" entry).
- That change moved the health-SIGNALS probe to `fleetsharp_updated_at`, but the
  `Vehicle GPS freshness` check in `api/health-cron.js` was left pointed at
  Jobber. It still computed `newestJobber` and would have emailed
  "Jobber's own GPS feed is dead -- single point of failure" EVERY DAY, forever,
  about a feed the codebase deliberately no longer reads. Alert fatigue is the
  failure mode that makes the whole health report worthless, so this is not
  cosmetic.
- Rewritten to watch FleetSharp only, and only what is actionable:
  * `fail` FLEET DARK when nothing is placeable within 2h -- with one source
    there is no second feed to mask an outage, so this is the only thing between
    a dead FleetSharp push and a map that silently freezes;
  * `warn` NAMING any tracker silent over 24h, which is a device/subscription
    fault someone can chase, unlike a whole-feed alarm;
  * 24h deliberately, not 12: a parked truck reports on movement, so a shorter
    threshold would fire every single morning.
  Jobber is not read and not mentioned.
- I had built this as part of a wider PR (#294) that ALSO re-routed the four
  endpoints reading raw Jobber columns. Another session shipped that same fix
  first and went further on Chris's instruction ("Remove Jobber GPS from this
  equation all together") -- `vehicleGps()` is FleetSharp-only where mine kept a
  stale-flagged Jobber fallback. Theirs is better and matches what Chris asked
  for, so #294 was CLOSED rather than merged: merging it would have
  reintroduced the fallback. This branch carries only the part still missing.
- `test/vehicle-gps-freshness.test.mjs` rewritten (8) for the new intent,
  including an explicit test that Jobber being frozen produces NO warning and is
  not even mentioned. Mutation-checked: restoring the Jobber alarm fails 5 of
  the 8. Full suite 1942/0.
## 2026-08-16 -- Claude -- Team To-Do rewired to real operational work (v2)

- Branch `claude/team-todo-rewire-v2-fmxmco` off `origin/main` @ `ced23ed`. Draft PR,
  NOT merged. Full write-up: `REPORT-team-todo-rewire.md`.
- The Command Center "Team To-Do" card no longer reads `reina_todo`. It now shows
  (A) real user-created **HiveConnect tasks** and (B) computed operational detections:
  emails awaiting reply (unread >4 BUSINESS hours), estimates in draft, vendor payments
  past due / due within 7 days. Chris's rule: Decisions = approval, To-Do = execution,
  never both. Enforced by `category:'execution'` server-side + `teamTodoDedupe()` client-side.
- **No new table.** HiveConnect Tasks (project `mzyngawgpxzpsxphswmc`) already existed;
  reads/writes go through two new session-authed actions on the existing
  `api/hiveconnect-bridge.js` route (`tasks_list`, `task_complete`). The completion write
  mirrors `public/hiveconnect/tasks.js updateTaskStatus()` exactly -- status patch +
  `task_status_history` row with the caller's own `changed_by`. It is the only write.
- `reina_todo` + the hourly `reina_todo_set` push are INTACT (verified still writing:
  16:24 UTC today, 8 sections). The engineering list moved to a new admin-only
  **Dev To-Do** view; `resource=reina_todo_get` is now gated admin/superadmin/owner.
- Verified against the live databases, read-only: HiveConnect has exactly 1 active task
  (Allan Amit, due 2026-07-27, overdue) and HiveLogic has 9 draft quotes ($180,468.68),
  so both feeds have real content. Every column the new code touches already exists --
  **no schema change, no production SQL.**
- 43 new tests + 2 existing tests updated to the intended new behaviour. Suite:
  1932 pass / 7 fail, all 7 pre-existing on `main` (proven by re-running them stashed).
- Seen on the preview (Chris's screenshot, same day): the task row renders with initials,
  overdue date and priority dot; "Estimates to finalize 9"; "Vendor payments due $390,126,
  102 past due"; emails row honestly muted as "Microsoft 365 is not connected".
- **CORRECTION to an earlier claim in this entry's first revision:** vendor payments does
  NOT render "Financial feed offline" -- QBO returned real data (its `integrations` token
  refreshed 17:51 UTC, valid). The 401 blackout does not affect `bills_due_range`. The
  degradation path is still implemented and tested against a mocked 401; production is
  simply not in that state.
- Email row is correct, not broken: HiveLogic `integrations` has no `microsoft` row AND
  HiveConnect `hc_ms_tokens` has ZERO mailboxes. No mailbox is connected in either realm,
  so the per-user `/api/msmail` path would report the same thing.
- **VERIFIED on the preview 22:44:10 UTC -- the completion write works end to end.** Task
  flipped `not_started` -> `completed` with `completion_date` set, AND a `task_status_history`
  row was written with `changed_by` = Chris's own HiveConnect profile and the note
  "Completed from HiveLogic Command Center". Console agreed: `complete-response 200
  {"historyWritten":true}`, then a reload returning an empty active task list.
- A first attempt at that tick did nothing, and diagnosing it produced a WRONG claim from
  this session -- "the request never reached the server" -- based on Supabase log queries
  whose time windows ran ~2 hours behind actual time (console `asOf` said 22:44 UTC while
  queries ended at 21:00). Root cause of that first failed click is still unknown; do not
  repeat the "no traffic in the logs" conclusion without checking the window against a
  server-supplied timestamp first.
- Silent-failure fix shipped as commit `c34538c` and is what made the successful run
  observable: `teamTodoLog` (console trace + real HTTP status), `teamTodoNote` (persistent
  inline line, since `hlSay`->`chirpToast` vanishes in 2.4s and no-ops when undefined), and
  `teamTodoWithTimeout` (bounds the load and the write, so a hung `sb.auth.getSession()`
  cannot strand the checkbox disabled). Freshness stamp no longer says "updated just now"
  when both sources failed.
- Still unclicked: `+ TASK` routing and the Dev To-Do view (both render).
- "102 past due" came from a 365-day lookback; Chris's call was to narrow it. Past due now
  reaches back 90 days (`TEAM_TODO_PAST_DUE_LOOKBACK_DAYS` in api/track1.js) and the row
  names its own window -- "N past due (last 90 days) - rest due within 7 days". Older bills
  are an accounting problem for the Financial tab, not a this-week payment run; the dollar
  total drops accordingly.
## 2026-08-16 -- Claude -- Command Center greys stale truck positions
- Branch `claude/cc-map-stale-gps`. The last loose end from the GPS work: the
  schedule board already greys a stale fix and refuses to draw an untracked
  crew, but Command Center drew every vehicle at full strength regardless of
  age. `loadTechLocationsLive()` only used `updatedAt` for a "3h ago" line in
  the popup; nothing read `stale`, `ageMs` or `source`.
- With Jobber's feed frozen since 2026-07-28, that meant an 18-day-old position
  rendered identically to a live one. The sharp version: Jobber's record for the
  2025 Ram Promaster still says DRIVING at 91.73, so the map showed a truck
  doing 91 down the road, three weeks after it last reported.
- Now: past 30 minutes the marker goes grey (#b6bfcc) at .55 opacity, the popup
  reads "Last known: DRIVING - 92 mph" instead of asserting it, names the feed
  (Jobber / FleetSharp), and carries an explicit "Stale fix -- not the current
  position" line. Same 30-minute threshold as the board, asserted by a test so
  the two maps cannot drift apart.
- Undated positions and responses cached from before crew_schedule started
  sending stale/ageMs both fall back to the timestamp and count as STALE, never
  as fresh (Law 1: absence of evidence is not evidence of freshness).
- `test/command-center-vehicle-staleness.test.mjs` (7 tests) runs the real
  function against a stubbed Leaflet and inspects what was actually drawn,
  rather than matching source text. Mutation-checked: restoring the old
  always-full-strength rendering fails tests 2, 4 and 5 and nothing else.
- STILL NOT FIXED, and not fixable in code: Jobber's telematics feed. As of
  13:45 today, gps_updated_at is 18.9 days old on all 10 vehicles while our sync
  runs fine; FleetSharp is 10/10 within 2h but only 3/10 within 30 minutes on a
  Saturday afternoon. Needs reconnecting on the Jobber side, and someone should
  confirm `Vehicle.liveState` is still the field to read for this account.
## 2026-08-16 -- Claude -- nodemailer 6 -> 9 (one high-severity advisory, four total)
- Branch `claude/nodemailer-security-bump`. Found by running `npm audit
  --omit=dev` after noticing the CI log mention "1 high severity
  vulnerability" -- it was never chased.
- All four advisories were in `nodemailer@6.10.1`, which sends every piece of
  real mail this app produces:
  * GHSA-r7g4-qg5f-qqm2 -- improper TLS cert validation on OAuth2 token fetch
    (credential interception);
  * GHSA-p6gq-j5cr-w38f and GHSA-wqvq-jvpq-h66f -- `raw`/jsonTransport bypass
    `disableFileAccess`/`disableUrlAccess`, enabling arbitrary file read and
    full-response SSRF;
  * GHSA-rcmh-qjqh-p98v -- addressparser DoS via recursive calls.
  `npm audit --omit=dev` now reports **0 vulnerabilities**.
- Assessed the three majors of breaking changes against THIS codebase before
  bumping, rather than bumping and hoping:
  * v7 removed the old SES SDKs -- we use plain SMTP host/port, no SES;
  * v8 renamed error code `NoAuth` -> `ENOAUTH` -- nothing compares against it
    (`errText()` only prints `e.code`);
  * v9 enforces TLS cert validation on nodemailer's own HTTPS requests
    (attachment href/path fetches, OAuth2 token endpoints, proxy CONNECT) --
    we fetch no remote attachments, pass `accessToken` in directly rather than
    letting nodemailer fetch it, and configure no proxy. Nothing to opt out of.
  None applicable. api/mail.js is unchanged; only package.json moved.
- Exercised the real library rather than a mock (a nodemailer mock would keep
  passing after nodemailer changed, which is the failure being guarded):
  createTransport/sendMail/verify, an OAuth2 transport, and a full message
  through jsonTransport with from/to/cc/bcc/subject/html and an attachment
  that round-trips base64 back to the same bytes.
- `test/mail-nodemailer-contract.test.mjs` (5). Mutation-checked: pinning back
  to ^6 fails test 1, letting an attachment carry `path:` fails test 5.
- NOTE for whoever bumps next: attachments are deliberately built as
  {filename, content, contentType} with anything lacking `content` dropped, so
  a request body cannot smuggle `path:`/`href:`. That is what keeps the two
  file-access/SSRF advisories out of reach regardless of library version. Test
  5 pins it. Do not relax it.
- Full suite 1967/0.

## 2026-08-16 -- Claude -- Guard: an active Monitor agent must be authenticatable
- Follow-up to the outage root cause. A monitor_agents row could be
  status='active' with agent_token_hash NULL, which requireMonitorAgent can
  never match -- so the agent was permanently dead AND failed exactly like a
  wrong token (401, no log line, tray reading "Heartbeat error"). That
  indistinguishability is what cost two weeks.
- Two layers now:
  1. CHECK constraint `monitor_agents_active_requires_token_hash` -- an active
     agent must have a hash AND must not still hold a plaintext token.
     APPLIED TO PRODUCTION and verified by attempting both bad updates in a DO
     block; the constraint rejected each. The half-shipped hashing migration
     that caused this would now fail loudly at write time.
     supabase/migrations/20260816145500_monitor_agents_active_requires_token_hash.sql
  2. health-cron check "Monitor agents able to authenticate" -- reports any
     such row as a FAIL with the remedy named. Kept despite the constraint
     because a constraint only protects a database that has it: restored
     snapshots, branch databases, environments built from an older baseline.
- Scoped to status='active' on purpose. Pending rows are mid-enrollment and
  legitimately have neither value (Jovie and Robert are both pending -- they
  generated pairing codes and never completed pairing); revoked rows are
  history and must stay readable as written.
- Verification: new test/monitor-agent-credential-guard.test.mjs 6/6. Full
  npm test 1,877: 1,868 passed, 2 intended skips, 7 pre-existing
  @anthropic-ai/sdk failures. Monitoring still live throughout (last_seen
  10:52:11 local).

## 2026-08-16 -- Claude -- Monitoring ALIVE (root cause: a NULL token hash), + FleetSharp-only GPS
- MONITORING IS RUNNING for the first time since 2026-08-01. Verified on live
  data: last_seen_at moved to 10:31:11 local, a monitor session opened,
  consent allowed, activity samples recording.
- THE ROOT CAUSE was none of the three auth gates fixed earlier that day.
  Chris's agent paired 2026-07-25, when tokens were stored PLAINTEXT in
  `monitor_agents.agent_token`. The code later switched to a sha256 in
  `agent_token_hash`, but his existing row was never migrated: plaintext
  present, hash NULL. requireMonitorAgent() looks up by hash only, so a NULL
  could never match. His agent had been sending a correct token every 60s for
  two weeks and being refused, tray reading "Heartbeat error".
  Migration: supabase/migrations/20260816143000_monitor_agents_backfill_token_hash.sql
  (ALREADY APPLIED to production; verified the sha256 of the stored plaintext
  equalled the hash the live agent was presenting BEFORE writing).
- The three gate fixes (#262 edge guard, #295 track1's own requireApiAuth, #283
  the client token) were all real bugs and all genuinely blocked the agent --
  but each only moved it one layer closer to a lock that was never going to
  open. Lesson: an auth failure got diagnosed three times from the gate side
  without once checking whether the CREDENTIAL matched.
- What actually broke the deadlock was Chris's screenshot of the tray tooltip.
  "Heartbeat error" proved the app was running and being refused, which killed
  the (wrong) conclusion that it was not running at all. Before that, the same
  evidence was on screen for hours -- a 403 every ~30s on /auth/v1/user -- and
  was dismissed as background noise. It was the agent knocking.
  NOTE for future sessions: those /auth/v1/user 403s are ALSO expected noise --
  middleware.js calls verifyUserBearer on every /api request BEFORE consulting
  its allowlist, so any non-Supabase bearer produces one and the request is
  then allowed anyway. They prove nothing on their own.
- SEPARATELY, GPS is now FleetSharp-only (Chris: "Remove Jobber GPS from this
  equation all together"). Checked first: all 10 vehicles have a FleetSharp fix
  minutes old; the newest Jobber fix is 2026-07-28. Dropping Jobber costs no
  coverage. pickFreshestVehicleGps -> vehicleGps (FleetSharp only), plus a
  shared VEHICLE_GPS_COLUMNS constant, because FOUR endpoints never called the
  helper at all and selected latitude/longitude/gps_updated_at directly --
  drawing three-week-old positions on the map with no indication. The Jobber
  columns are still synced and still in the table; this only stops READING them
  for position, so it is a one-line revert if that feed ever recovers.
- The health probe moved from vehicles.gps_updated_at to fleetsharp_updated_at
  in the same change. Left pointed at the abandoned column it would alarm
  forever about a source nobody reads -- and with one GPS source there is no
  second feed to mask an outage, so that probe is now the only thing standing
  between a dead FleetSharp push and a map that silently freezes.
- Verification: fleetsharp-push 17/17 (read-side tests rewritten for the new
  contract), api-auth-guard 38/38, monitor-status-honesty 9/9. Full npm test:
  1,871 tests, 1,862 passed, 2 intended skips, 7 pre-existing
  `@anthropic-ai/sdk` failures (no node_modules in this container). One real
  regression caught and fixed on the way: reina-lab-read-bridge pinned the old
  Jobber select string.

## 2026-08-16 -- Claude -- Browser test harness for the schedule board (npm run test:ui)
- Branch `claude/board-browser-harness`. Chris: *"i need you to have the ablity
  to check and test, not rely on me."* Fair -- across the schedule-board work I
  told him a bug was fixed twice when it was not, and both times the reason was
  that I had no way to look at the rendered page.
- `npm run test:ui` drives headless Chromium against the REAL `public/` tree
  with stubbed APIs. No network, no deployed preview, no human looking at a
  screen. Eight tests, one per thing Chris actually reported: control/panel
  overlap, panel close, page-vs-board scrollbars, sticky headers, backdrop
  visibility, map centred on the shop, period pins in frame.
- These are all questions about GEOMETRY AFTER LAYOUT. Unit tests cannot answer
  them -- nothing has been laid out -- and reading the code cannot either; I
  tried, repeatedly, and was wrong.
- Two self-checks are built in, because both failure modes actually bit:
  * a measurement that CANNOT FAIL is reported `vacuous`, not "clear". The
    overlap bug was declared fixed while fully present because the probe
    measured a control cluster that had no size yet.
  * state is reached the way a USER reaches it. The overlap lived only in
    panel-opened-by-click, which skips `render()` and so skips the re-measure;
    a harness that loaded with the panel already open never saw it.
- MUTATION-CHECKED, so the suite is not decoration: putting each original bug
  back fails exactly its own test and nothing else (drop the panel re-measure
  -> tests 1-2; opacity .38 + 62% scrim -> test 5; centroid camera -> test 6).
- `playwright-core` and `maplibre-gl` are devDependencies; Chromium is found
  from the environment. Missing either SKIPS with the reason rather than
  failing or silently passing.
- NOT solved by this: reaching the deployed site. This sandbox's egress policy
  allows only github.com / api.github.com / registry.npmjs.org, so
  `hivelogic-live.vercel.app` returns 403 at the proxy. That needs the
  environment's network policy widened -- see `test/browser/README.md`.
## 2026-08-16 -- Claude -- Browser-close clock-out: grace window (NOT VERIFIED IN PRODUCTION)
- Branch `claude/clockout-grace-window`. State per Rule Zero: **unverified**.
  Code and tests are in place; the schema is NOT applied and nothing has been
  observed working in production. Do not describe this as done.
- Two bugs, one change.
  1. The browser-close auto-clockout had been DEAD since 2026-08-01 -- the
     SEVENTH instance of the guard-drift class. `navigator.sendBeacon` cannot
     set an Authorization header (the token rides in the body and
     getRequestingProfile has a documented fallback), but middleware.js reads
     only the header, so every beacon 401'd at the edge. Production proof:
     `close_reason='browser_closed'` stops dead at 2026-08-01 16:34 while
     `idle_timeout` -- same endpoint, ordinary authenticated fetch -- still
     fires today.
  2. Simply unblocking it would have been WORSE: `pagehide` fires on a refresh
     exactly as on a close, so it would have clocked people out on every
     reload. That is how Chris found it -- he hard-refreshed, stayed clocked
     in, and asked whether that was correct. It was; the reason was a bug.
- Chris chose a grace window. The beacon now MARKS `browser_gone_at`; the new
  `workforce_sweep_gone` cron (*/5) closes the session backdated to that mark,
  but only if nobody came back. `workforce_status` (polled every 60s, and hit
  on every page load) clears the mark, so a refresh cancels its own pending
  clock-out within seconds and costs nobody any time.
- TWO gates had to be opened, not one. Besides the middleware allowlist,
  track1's own `requireApiAuth` belt-and-braces check also reads only the
  header and would have re-blocked the beacon -- exactly the "silently
  re-block what the middleware just allowed" trap its own comment warns about.
  A test caught this; without it the fix would have shipped still broken.
- The health-signals checker merged earlier today REFUSED to let the new cron
  ship without an evidence entry (test failed until one was added). The
  anti-drift property worked on the very next change after it landed.
- Verification so far: `test/workforce-browser-gone-grace.test.mjs` 11/11,
  confirmed to fail 7/11 against pre-fix code. Full `npm test`: 1,778 tests,
  1,769 passed, 2 intended skips, 7 pre-existing `@anthropic-ai/sdk` failures.
- NOT DONE / next steps, in order:
  1. **Apply `supabase/migrations/20260816125500_workforce_browser_gone_at.sql`
     to production.** MIGRATIONS.md: a green Vercel deploy does NOT deploy
     schema, and the GitHub secrets for the auto-deploy workflow still do not
     exist. Until the column exists, the beacon PATCH and the sweep both fail.
  2. Confirm in production that `close_reason='browser_closed'` starts moving
     again (it has been frozen at 2026-08-01 16:34 for fifteen days) -- that is
     the observable proof this works.
  3. Confirm a hard refresh does NOT clock the user out.
- Unrelated and still open: Chris's Monitor desktop agent has still never
  reconnected (`last_seen_at` 2026-08-02). Server side is clear; the app is not
  running on his machine.

## 2026-08-16 -- Claude -- Silent-failure detection (health signals), + two outages nobody knew about
- Branch `claude/health-signals-coverage`. Built after Chris asked why the app
  can't watch itself globally, following screen monitoring dying company-wide
  for two weeks with nothing noticing.
- `api/health-cron.js` already emailed a daily report -- but it checks a
  HAND-WRITTEN list of 8 things. Every check existed because a person thought of
  it, so monitoring (which nobody listed) died invisibly. Adding a 9th check
  would fix today and leave the same hole for the 10th thing.
- New `api/_lib/health-signals.js` DERIVES coverage instead:
  * every cron in vercel.json is watched; one with no evidence rule reports
    `uncovered`, which is a FAILURE, so coverage cannot drift behind the app;
  * the staleness budget is derived from each cron expression (3 missed cycles
    + slack, floored at 20m), so there is no per-job number to get wrong;
  * LIVE (non-cron) signals are registered explicitly -- the Monitor agent is
    not a cron, so a cron-only checker would have missed the very bug it was
    built for;
  * jobs only observable when they have work (webhook drain, prunes,
    companycam) are reported `unverifiable` WITH the reason, never green
    (Law 1). Eight of them -- that count is the argument for a real run-ledger
    next;
  * the 9 deliberately-disabled marketing/social sends are `off-by-design` and
    never alarm. Alert fatigue is the failure mode that would make this
    worthless.
- Wired into health-cron: one row per genuine alarm plus a single coverage
  line, so the morning email stays readable.
- VERIFIED AGAINST LIVE PRODUCTION DATA (per Rule 0), not just unit tests. Found
  three stale signals, two of which nobody knew about:
  * `fleet/gps-freshness` -- vehicles.gps_updated_at 19 days stale. The
    schedule board map has been drawing stale truck positions.
  * `sync-extended?resource=geocode` -- client_locations.geocoded_at 15 days
    stale.
  * `monitor/agent-heartbeat` -- 14 days, the reported outage.
  Rendered the actual email through buildReport() to confirm what Chris would
  receive.
- The checker caught a bug in ITSELF on first run: cronKey() kept only
  ?resource=, collapsing `/api/jobber/webhook?drain=1` and `?cleanup=1` into one
  key so neither matched its evidence. Fixed; regression test added.
- Verification: new `test/health-signals.test.mjs` 17/17, including a replay of
  the real production timestamps and an assertion that CRON_SCHEDULES mirrors
  vercel.json exactly in both directions (drift fails the suite). Full
  `npm test`: 1,756 tests, 1,746 passed, 2 intended skips, 8 pre-existing
  `@anthropic-ai/sdk` failures (no node_modules here).
- SEPARATELY FOUND, not yet fixed: the browser-close auto-clockout has been
  dead since 2026-08-01 -- SEVENTH instance of the guard-drift class.
  `sendBeacon` cannot set an Authorization header (the token rides in the body,
  and getRequestingProfile has a documented fallback for it), but middleware.js
  only reads the header, so every beacon 401s at the edge. Proof in the data:
  `close_reason='browser_closed'` stops dead at 2026-08-01 16:34 while
  `idle_timeout` -- same endpoint, sent with a normal authenticated fetch --
  still fires today. Chris chose a GRACE WINDOW rather than immediate
  clock-out: mark "browser gone at T", clock out backdated to T only if nothing
  returns within ~5 min, so a refresh never costs anyone time. Next session:
  build that (needs a column, a sweep, and a guard allowlist entry).

## 2026-08-16 -- Claude -- Owner could not clock out: EOD exemption was browser-only
- Branch `claude/eod-clockout-blocker`, off `main`. Reported by Chris while
  checking the monitoring fix: "it asks for the EOD report, but it doesn't pop
  the report up." He was stuck clocked in.
- Cause: the Owner's End-of-Day exemption existed only in the browser
  (`hlWfIsOwner`, public/index.html). `handleWorkforceClock`'s `'out'` branch
  enforced the requirement unconditionally. So his clock-out skipped the
  client-side check -- which is the ONLY branch that navigates to the EOD form
  -- and was then refused by the server, whose error path just toasted the
  message and stopped. Unsatisfiable by design: asked for a report, never shown
  the form, never clocked out. Anyone clocking out from the top-bar widget on
  another page hit the same dead end whenever the server did the refusing.
- Fix, both halves: (1) the server now honours the same Owner exemption, keyed
  on the same identity as the client, and tags the refusal `needsEodReport`;
  (2) the navigate-to-the-form step is extracted as `hlWfGoToEodForm()` and
  called from the server-refusal path too, not just the pre-check -- it routes
  to the Time Clock page, scrolls the card in, and focuses the first field.
- Deliberately an email match, not `role`: `superadmin` also covers Jomell, who
  does submit EOD reports (see the timezone regression in
  workforce-team.test.mjs), so a role gate would have silently exempted him.
  There is a test asserting the client and server key on the same identity --
  editing one without the other is what created this bug.
- Verification: new `test/workforce-clockout-eod.test.mjs` 10/10, confirmed to
  fail 5/10 against the pre-fix code (the 5 that pass pre-fix are the
  unchanged-behaviour guards). Full `npm test`: 1,732 tests, 1,722 passed, 2
  intended skips, 8 pre-existing `@anthropic-ai/sdk` failures (no node_modules
  in this container). Edited inline script block re-parsed clean.
- Still open: Chris's Monitor agent has NOT reconnected since the guard fix
  (#262) merged -- `last_seen_at` still frozen at 2026-08-02. The edge no
  longer refuses it, so the next thing to check is whether the desktop app is
  actually running on his machine.

## 2026-08-16 -- Claude -- Screen monitoring has been dead company-wide since 2026-08-01
- Branch `claude/monitor-tab-live-status-sznm6p` (restarted off `main` after
  PR #233 merged). Found while Chris was checking the Monitor tab fix from that
  PR: the tab was correctly grey, but it was grey because monitoring genuinely
  was not running -- he was clocked in the whole time.
- Cause: `api/_lib/guard.js` (the edge auth choke point, shipped 2026-08-01)
  never allowlisted the HiveLogic Monitor desktop agent. The agent posts to
  four `?resource=` values on `/api/track1` -- `monitor_pair`,
  `monitor_heartbeat`, `monitor_consent`, `monitor_screenshot_upload`
  (`hivelogic-monitor-agent/src/main.js`) -- and authenticates with its own
  hashed bearer, so it has no Supabase session and no CRON_SECRET. Every
  request has been 401'd at the edge for two weeks.
- What made it invisible: the allowlist carries `/api/agents/` commented
  "Monitor agents -- own bearer tokens (Item 9)". That prefix is the unrelated
  *automation* agent surface (`api/agents/control|device|enrollment.js`). The
  comment has been corrected so the next reader isn't fooled the same way.
- Confirmed against production before writing the fix, not inferred: Chris's
  `monitoring_enabled` is true, his agent paired 2026-07-25, `last_seen_at`
  frozen at 2026-08-02, last `monitor_sessions` row 2026-08-01, and he had an
  active `workforce_time_sessions` row at the time he reported it. Same
  half-shipped-guard class as the snapshot / financial-read / `monitor_prune`
  repairs already documented in that file.
- Fix: the four agent resources added to `PUBLIC_RESOURCE_PATHS`, POST-pinned.
  Each stays gated behind the guard -- heartbeat/consent/upload all go through
  `requireMonitorAgent()` (hashes the bearer, requires `status='active'`), and
  `monitor_pair` is the enrollment exchange (no token yet by definition, same
  as the already-allowlisted invites redeem) hardened by a 15-minute 6-digit
  code, 5 wrong guesses per code, and 15 attempts per IP per 10 minutes. The
  browser/admin resources (`monitor_my_status`, `monitor_review`,
  `monitor_settings`, `monitor_user_toggle`, `monitor_pairing_code`) and the
  cron-only `monitor_prune` stay session/cron-gated.
- Note for next session: this restores the *server* side only. Each machine
  still needs the desktop agent actually running and paired -- Jovie's and
  Robert's agent rows have never had a `last_seen_at` at all, so they may never
  have completed pairing. Worth checking once the edge stops refusing them.
- Verification: 4 new tests in `test/api-auth-guard.test.mjs` (35/35 in that
  file), confirmed to fail against the unfixed guard. Full `npm test`: 1,722
  tests, 1,712 passed, 2 intended skips, 8 pre-existing failures -- all
  `Cannot find package '@anthropic-ai/sdk'`, this container has no
  `node_modules`.

## 2026-08-15 -- Claude -- Rolodex Monitor tab showed green while nothing was recording
- Branch `claude/monitor-tab-live-status-sznm6p`. Chris reported the Monitor tab
  in the right-edge rolodex rail was green with nobody clocked in.
- Cause: the rolodex block ran its own 45s poll against
  `track1?resource=monitor_review` and set `.mon-on` when any roster entry had
  `status==='active'`. That field means "the Monitor agent is paired", which is
  true around the clock — so the tab was effectively hardcoded green. Worth
  noting the previous fix (`c0454e9`) introduced this while trying to solve the
  opposite problem (the owner's own `recording` is always false).
- Fix: deleted that poller. The tab is now set by `hlMonRoloSync()`, called from
  `hlMonitorFabPoll()` — the single 30s `monitor_my_status` poll that already
  drives the recording-warning toast. `recording:true` → green; not recording,
  signed out, or a failed request → grey. The poll interval moved out from
  behind the `#hlMonFab` existence check (it used to `return` early on routes
  where the hidden fab is absent) and is guarded on `window.__hlMonPollTimer` so
  intervals can't stack. Toast logic and the other 12 tabs untouched.
- Note for whoever picks this up next: the tab reports **the signed-in user's
  own** recording state, which is the honest reading of "is my screen being
  recorded". It is deliberately grey for an owner who never clocks in. If Chris
  wants a company-wide "someone is being recorded" light instead, that needs a
  new endpoint — `monitor_review`'s roster status is not it.
- Verification: new `test/monitor-rolodex-tab-live-state.test.mjs` 5/5, and
  confirmed it fails 3/5 against the pre-fix file (not a tautological test).
  Full `npm test`: 1,634 tests, 1,624 passed, 2 intended skips, 8 pre-existing
  failures — all `Cannot find package '@anthropic-ai/sdk'`, since this container
  has no `node_modules`; unrelated to this change. Both edited inline `<script>`
  blocks re-parsed clean. No dev server (per guardrail); live behaviour to be
  eyeballed on the Vercel preview.

## 2026-08-08 -- Codex -- Command Center column alignment follow-up
- Branch `codex/command-center-alignment`, based on `origin/main` `9c91332`.
  The three wide-desktop primary columns now share one top and
  bottom edge: Map/Pulse remains the stable height anchor, Today's Decisions
  stretches to it, and Watching / Team To-Do / Notifications divide the same
  right-column height evenly. The two-column laptop layout also aligns its
  Map/Pulse and Today's Decisions row; tablet and phone stacking is unchanged.
- The fix changes only responsive sizing. Existing inner scroll frames remain
  the content boundary, so long feeds cannot participate in grid-row sizing or
  push the gauges down.
- Verification: Command Center layout tests 5/5; full `npm.cmd test` 1,388
  passed, 2 intended skips, 0 failed; syntax/entity and diff checks clean.
  Browser measurement at 1600px confirmed all three columns were exactly
  1,299.7px tall with identical edges, all right cards were 422.6px, and an
  80-item To-Do stayed internally scrollable. Verified 1280, 900, and 390px
  responsive layouts with no horizontal overflow.
- Release scope is limited to responsive Command Center sizing, its regression
  coverage, and this status entry; no API or production-data change is included.

## 2026-08-08 -- Codex -- Command Center fixed-shell layout repair
- Branch `codex/command-center-layout`, based on `origin/main` `31bb2bb` in an
  isolated worktree. Repaired the Command Center regression where an unbounded
  Team To-Do feed expanded the right rail, stretched the shared dashboard row,
  and pushed the Pulse gauges down.
- Dynamic Command Center panels now keep stable responsive shells and scroll
  their own content: Daily Brief, Watching, Team To-Do, Notifications, gauge
  details, Today's Schedule, Recent Job Photos, and the Job Health strip. The
  notched title chips remain outside the scroll frames. Laptop/tablet layouts
  now step through two-column and one-column arrangements without collapsing
  the six-gauge grid prematurely or creating horizontal overflow.
- Verification: new Command Center layout tests 4/4; full `npm.cmd test` 1,385
  passed, 2 intended skips, 0 failed; diff check clean. Browser stress testing
  compared 1 versus 42 To-Do items and confirmed unchanged map, Pulse gauge,
  panel, and next-row geometry while the To-Do body became internally
  scrollable. Verified at 1440, 1280, 1150, 900, 768, and 390 CSS pixels.
- Release scope is limited to the Command Center source, its regression test,
  and this status entry; no API or production-data change is included.

## 2026-08-05 -- Codex -- AI Council workspace and protected-preview completion
- Branch `codex/hivelogic-ai-council`. Added `562cdf1`, `a1d0c05`,
  `0babdf9`, and `a915de9`: a native Manager's > AI Council workspace;
  evidence, budget, transcript, Reina decision-map, audit, and explicit human
  approval UI; participant-specific evidence/risk, implementation, and
  adversarial duties; durable idempotent admission; per-owner concurrency and
  daily cost quotas; aggregate run retrieval; readiness status; and rollout/
  rollback documentation. Models remain text-only and HiveBridge still accepts
  only the existing typed read-only tasks after a separate approval.
- Verification: Council-focused suite 24/24 passing plus syntax/diff checks.
  Full `npm.cmd test` ran 1,169 tests: 1,161 passed, 2 intended skips, and the
  same 6 unrelated ad/marketing test-file failures because this isolated clone
  lacks its declared `@anthropic-ai/sdk` dependency.
- Merged current production `main` (`9ec036c`) into the isolated branch,
  resolved the additive `.env.example` and `public/index.html` conflicts, and
  reran the Council suite 24/24. Published the branch and opened draft PR #120.
  Vercel automatically built a Ready protected preview; authenticated CLI smoke
  checks confirmed the deployed Council CSS returns 200 and the Council API is
  still behind HiveLogic authentication.
- Local implementation phases 1 and 2 are complete. Activation remains safely
  blocked: the migration is unapplied; xAI is not configured; the OpenAI key is
  production-only; no Council model, pricing, limit, or feature-flag variables
  exist yet; and no authenticated Supabase browser/CLI session is available.
  Production remains disabled and no Council provider call, migration, merge,
  HiveBridge task, or production deployment was performed. The refreshed
  untracked `HiveLogic-AI-Council-Phase1-review.patch` contains the full delta.

## 2026-08-05 -- Codex -- AI Council review hardening
- Added `04b20f6` and `9831912` after an independent Grok review plus local
  verification. Consensus now counts each participant once per topic using
  its latest stance, so repeated claims/rounds cannot manufacture agreement.
  Provider calls reserve a conservative worst-case cost synchronously before
  parallel requests begin and account in integer micro-cents; blank/zero price
  configuration now fails closed.
- Replaced multi-request persistence and approval flows with two
  service-role-only Supabase RPCs in the still-unapplied Phase 1 migration.
  Complete run/message/audit creation is one transaction. Approval locks the
  run and tenant-scoped agent, writes both approval ledgers, queues the typed
  HiveBridge task, transitions the run, and writes the execution audit event
  atomically. No shell or unrestricted execution surface was added.
- Verification: focused Council suite 13/13 passing. Full `npm.cmd test` ran
  1,158 tests: 1,150 passed, 2 intended skips, and the same 6 unrelated
  ad/marketing test-file failures because this isolated clone lacks the
  declared `@anthropic-ai/sdk` dependency. Feature flag remains false; the
  migration was not applied; nothing was pushed, deployed, or executed.

## 2026-08-04 -- Codex -- HiveLogic AI Council Phase 1
- Branch: `codex/hivelogic-ai-council`, based on local clean `main`
  `c7be769`. Two commits: `fcdc8a5` (pure Council protocol + tests) and
  `4156454` (provider adapters, endpoint, persistence proposal, docs).
- Added a disabled-by-default, admin-only Council API. Claude, ChatGPT, and
  Grok make parallel independent structured proposals before any sees another
  answer; Reina's deterministic moderator validates verbatim supplied-evidence
  citations, enforces round/token/cost limits, and reports consensus/conflict.
  Providers receive text only: no tools, shell, browser, keys, or execution
  authority. All successful run/message/usage/audit data is designed for the
  new service-role-only `reina_council_*` tables.
- Execution is still human-gated: only a separate approval can queue one of
  the existing typed Windows Agent/HiveBridge tasks (`repository_status` or
  `repository_test`). No shell, script, arbitrary arguments, or model-derived
  executable payload is accepted. The migration is a proposal and was not
  applied; `REINA_COUNCIL_ENABLED` remains false by default.
- Verification: focused Council core/provider tests 8/8 passing; syntax checks
  passed for the endpoint and store. Full `npm.cmd test` ran 1,153 tests:
  1,145 passed, 2 intended skips, and 6 existing ad/marketing test-file
  failures because this isolated clone lacks the declared `@anthropic-ai/sdk`
  dependency. See `docs/REINA_AI_COUNCIL_PHASE1.md` for rollout requirements.

## 2026-08-03 -- Codex -- clean Reina RC successor
- Branch: `codex/reina-pilot-rc-successor`, created directly from verified
  authoritative main `62672137b86a95945568540ec27a06662f731380`.
- Repackaged the accepted functional tree from `772335f7444b4553a0fe15a567cbb1648dd3bedc`
  as one clean successor commit. All functional/source/test/migration files are
  byte-identical to that accepted tree; only this coordination entry is new.
  PR87 and PR88 remain preserved inside the composite RC.
- Focused RC verification: backend/context/store/route 69/69;
  client/PR87/PR88/host 175/175; actual route+panel browser candidate 3/3;
  total 247/247. Diff and scope checks passed. Broad historical suites were
  intentionally not run.
- The four-table/nine-RPC migration remains a proposal and was not applied.
  Activation remains HOLD on the existing ephemeral PostgreSQL/Supabase
  contention, deadline rollback, clock-boundary, and effective grant/RLS gate.
  Publishing this branch only as a draft PR; no merge, deployment, production
  flag change, or SQL application was performed.

## 2026-08-03 -- Codex -- Reina RC silent-revocation hardening
- Branch: `codex/reina-rc-silent-revocation`. Verified authoritative
  `origin/main` at `62672137b86a95945568540ec27a06662f731380` and the current
  source RC at `f4e3d3168b1da739cc131838af3726fc8599cb62`; rebased the RC
  delta onto that exact main before making this bounded fix. PR87 and PR88
  source/test blobs remain byte-identical to their hardened reviewed heads.
- Added authenticated, persisted, single-use review-intent issue/consume. Every
  confirmation now resolves a fresh server ActingContext before an atomic
  consume, and owner, policy, expiry, duplicate, revocation, and timeout
  failures all deny before the existing governed UI router can navigate. The
  pilot remains disabled by default, admin-only, synthetic/read-only, and
  structurally `executed:false`; no business action, Automation task, or tool
  execution was added.
- Expanded the existing unapplied migration proposal to four tables/nine RPCs
  with DB-clock expiry, row-lock/guarded-update consumption, RLS/no client
  policies, direct table revokes, and service-role-only RPC grants. The
  migration was **not applied**. Activation remains HOLD pending the existing
  ephemeral PostgreSQL/Supabase two-session contention, deadline rollback,
  clock-boundary, and effective catalog grant/RLS verification.
- Focused verification only, per task boundary: backend/context/store/route
  69/69; client/PR87/PR88/host 175/175; actual route+panel browser candidate
  3/3; total 247/247, plus syntax and diff checks. No merge, push, deployment,
  production flag change, or migration application was performed.

## 2026-08-03 -- Codex -- Reina pilot release candidate
- Branch: `codex/reina-pilot-rc-current-main`, pinned to authoritative main
  `f9c5ec3d37eaabc1babeb823e317ac2017ef0303`.
- Prepared one additive, disabled-by-default/admin-only synthetic read-only
  Reina pilot RC in the existing purple panel. Authenticated greeting,
  bounded attention summary, typed and user-gesture Voice turns share the
  same principal-scoped durable endpoint and canonical `executed:false`
  envelope. The server issues the single governed review intent; the client
  can confirm only that exact correlated intent. No business action, tools,
  Automation, web research, phone/Twilio, live mail, finance, or weather is
  enabled.
- Added a three-table/seven-RPC Supabase durability migration proposal. It was
  not applied. Activation remains blocked pending Chris's approval of the
  service-role/server-derived-owner model, recovery and retention policy, and
  an ephemeral PostgreSQL/Supabase concurrency/fencing/rollback/grant test.
- Verification: full repository suite 973 tests / 971 passed / 2 intended
  dormant skips / 0 failed; real route+panel browser candidate 3/3; focused
  backend gate 77/77. No merge, deployment, migration application, or
  production flag change was performed.

## 2026-07-31 (DB security hardening: functions + advisor) -- Chris via Cowork (this session)
- The final security follow-up (RLS/DB). Investigated the REAL state via the
  Supabase security advisor instead of blindly adding policies. Findings:
  * The ~98 "RLS enabled, no policy" tables are INFO, not a leak: RLS-on-no-
    policy DENIES all anon/authenticated access (only service_role/server can
    read). They're already locked. LEFT UNTOUCHED (adding policies = risk with
    no security gain; the app reads them server-side via service_role).
  * The real items were WARN-level: 8 SECURITY DEFINER functions executable by
    anon/authenticated via /rest/v1/rpc, and 6 functions with a mutable
    search_path.
- Applied migration security_harden_functions_2026_07_31 (via Supabase MCP
  apply_migration; Chris approved):
  * Revoked EXECUTE from PUBLIC+anon on can_access_folder(uuid),
    can_see_folder(uuid), is_admin() -- and re-granted to authenticated +
    service_role. These are used by HiveDoc's RLS policies on folders/documents/
    folder_access for the AUTHENTICATED role (verified in pg_policies), so
    logged-in access is intentionally preserved; only anonymous RPC access was
    removed.
  * Revoked EXECUTE from PUBLIC+anon+authenticated on handle_new_user() -- it's
    a trigger-only function (fires on auth.users insert as the owner), so no
    invoking role needs EXECUTE.
  * Pinned search_path='public' on apply_sensitive_default,
    bookkeeping_audit_log_immutable, allocate_co_number, allocate_estimate_number,
    allocate_po_number, apply_po_batch_update.
- VERIFIED: pg grants now show can_access_folder/can_see_folder/is_admin =
  authenticated,postgres,service_role (anon+PUBLIC gone); handle_new_user =
  postgres,service_role only; all 6 show search_path=public. Advisor re-run:
  security WARN 15 -> 4. The 4 remaining are BY DESIGN / owner-action:
  3x authenticated_security_definer_function_executable (the folder/admin
  helpers -- HiveDoc needs authenticated to call them; keep as-is) and 1x
  auth_leaked_password_protection (a Supabase Auth dashboard toggle -- handed to
  Chris to flip: Authentication -> Attack Protection -> enable leaked-password
  protection). Not code; can't set via MCP.
- Reversible: to undo, re-grant EXECUTE ... TO public/anon and reset search_path.
- This closes the security follow-up list from reina/security-followups-token-
  encryption-and-rls.md (token encryption done earlier today; RLS reframed as
  "already locked"; function hardening done here). Non-security open items
  remain (estimate template demo data; dispatch/schedule mock screens; HiveSight
  build-artifact auth debt; api-smoke-test anon probes).

## 2026-07-31 (Perf: Jobs-Needing-Attention 10-15s QBO freeze fixed) -- Chris via Cowork (this session)
- Branch: fix/qbo-attention-freeze, built in worktree .worktrees/attn-fix,
  cut from origin/main bc85c79. NOT merged to main yet -- awaiting Chris.
- ROOT CAUSE: the Command Center tile Promise.all'd watching_unscheduled
  (fast Jobber/Supabase) with watching_margin_fade, whose
  getFinancials('job_costing_summary') paginates EVERY QBO Purchase + Bill
  (SELECT *, 1000-row pages) live -- 10-15s. Its only cache was a 50s
  in-memory memo that dies with each serverless instance, so real visits
  almost always paid the full scan, and the fast Jobber count sat blocked
  behind it.
- FIX, server: new Supabase table qbo_report_cache
  (sql/042_qbo_report_cache.sql; RLS on, no policies, revoked from anon/
  authenticated -- service-role only) + getFinancialsDurable() in
  api/qbo/index.js: fresh cache (<15 min) serves instantly; stale cache is
  served FIRST and QBO is re-scanned AFTER res.json() (handler awaits the
  refresh before returning, so Vercel keeps the invocation alive -- track1
  maxDuration 120s covers it); only the very first call ever computes live.
  Refresh goes through the existing 50s in-flight memo so concurrent
  refreshes share one QBO round trip. Cache read/write failures degrade to
  today's live-compute path (deploy-safe in either order vs the migration).
  Staleness is HONEST: costDataAsOf + 'cached N min ago' in source +
  coverageNote says a background refresh is running (Law 1: no pretending
  cached numbers are live). Jobber-side data still fetched live every call.
- FIX, frontend (public/index.html loadJobsAttention): the two fetches now
  render independently -- unscheduled count paints the moment Jobber
  answers, margin fade folds in when QBO answers; if one source fails the
  other still shows, labeled ('Jobber signal unavailable' / 'QuickBooks
  margin signal unavailable' / 'checking QuickBooks...'). Removed the
  'can take up to 15s' subtext. The separate Watching margin-fade tile
  (loadWatchingLive) shares the same endpoint so it speeds up too.
- Tested (cloud harness): node --check both APIs + extracted widget JS;
  durable-cache unit tests (first-call compute+persist, fresh serve with 0
  QBO calls, stale serve <15ms + real re-scan on refresh, concurrent
  refreshes share 1 scan, cached error never served, Supabase-down falls
  through to live compute); handler test (response sent BEFORE refresh
  runs, refresh awaited before handler returns, one refresh per memoized
  result, 90%-fade math + honest age labels in body); widget tests
  (progressive render, partial-failure honesty, both-fail message, totals).
- Migration applied live to Supabase (qbo_report_cache exists in prod).
- POST-DEPLOY CHECK for Chris: open the Command Center -- Jobs Needing
  Attention should show the unscheduled count in ~1s; after the first
  cache-priming visit, the QBO margin number should join within ~1-2s
  (never a 10-15s '...' freeze). Second load should be instant.

## 2026-07-31 (Token encryption: ACTIVATED + verified) -- Chris via Cowork (this session)
- Follow-up to the token-encryption ship. Chris set TOKEN_ENC_KEY in Vercel and
  redeployed. Also shipped a fail-safe hardening first (commit ed59459,
  branch fix/secrets-failsafe): encryptSecret() now catches a getKey() error
  and stores PLAINTEXT (with a warning) instead of throwing -- so a mistyped
  key can only ever mean "not encrypted yet", never a broken Jobber/QBO refresh.
- LIVE-VERIFIED END TO END:
  * Encrypt-on-write: after the key was set, the Jobber token refreshed at
    12:45 UTC and stored ENCRYPTED (integrations.access_token + refresh_token
    both 'enc:v1:...'). Proves the key is correct and encryption-on-save works.
  * Decrypt-on-read: the 13:02 UTC clients cron ran status=success,
    clients_synced=1443 -- it read the encrypted token, decrypted it, and
    synced. Full round-trip confirmed in production; Jobber healthy.
  * Bonus: that scheduled cron authenticating + running also re-confirms the
    earlier cron-secret gate (Vercel's Bearer) works.
- QBO: still plaintext as of 13:02 (its token wasn't due to refresh yet);
  encrypts automatically on its next refresh. Microsoft 365: not connected.
- OPERATIONAL NOTE: TOKEN_ENC_KEY must remain set in Vercel forever now that
  Jobber tokens are encrypted (removing it -> decrypt throws a clear error;
  Chris was told to store a copy in a password manager). The key was generated
  this session and given to Chris only; it is NOT in the repo or memory.
- Remaining security follow-up: RLS policies on the ~98 policy-less tables
  (see reina/security-followups-token-encryption-and-rls.md). Non-security open
  items unchanged.

## 2026-07-31 (Security: encrypt integration tokens at rest) -- Chris via Cowork (this session)
- Branch: fix/encrypt-integration-tokens (commit 2458858), worktree hlv_sec1,
  pushed + fast-forwarded onto main (202e35f..2458858) with Chris's approval.
- The access/refresh tokens in the integrations table were PLAINTEXT. Added
  api/_lib/secrets.js (AES-256-GCM; key from Vercel env TOKEN_ENC_KEY only,
  never in the DB) and wired encryptSecret() on every writer + decryptSecret()
  on every reader across ALL THREE token stores found in the audit:
  Jobber (api/_lib/jobber.js getStoredTokens/saveTokens + api/jobber/callback.js),
  QuickBooks (api/qbo/index.js loadTokens/saveTokens), Microsoft 365
  (api/track1.js getStored/saveMicrosoftTokens).
- STAGED + REVERSIBLE: secrets.js is passthrough when TOKEN_ENC_KEY is unset and
  decrypt handles plaintext, so the shipped commit is a NO-OP until the key is
  set. Verified live: after deploy, both Jobber (03:45 UTC) and QBO (03:51 UTC)
  refreshed + rewrote their tokens successfully, still plaintext (at_encrypted
  =false) -- proves the wired code works in prod and broke nothing.
- STATUS: **awaiting Chris to set TOKEN_ENC_KEY in Vercel + redeploy.** Key was
  generated and given to Chris this session (NOT stored in repo/memory). Once
  set + redeployed, encryption activates on each token's next write; legacy
  plaintext rows keep working via decrypt fallback until they rotate. After that:
  verify integrations.access_token starts with 'enc:v1:' AND Jobber sync + QBO
  financials both still work. NOTE: once any token is encrypted, TOKEN_ENC_KEY
  must stay set forever (decrypt throws a clear error otherwise) -- Chris told to
  save a copy in a password manager.
- Tested: secrets.js unit (roundtrip, no-key passthrough, plaintext fallback,
  tamper detection, missing-key error, base64+hex keys); full Jobber refresh
  path end-to-end with stubs (refresh saves ciphertext, caller gets plaintext,
  read decrypts, legacy plaintext reads, no-key = true no-op); node --check all
  5 on-device; idempotent re-run.
- Remaining security follow-up (from reina/security-followups-token-encryption-
  and-rls.md): RLS policies on the ~98 policy-less tables. Non-security open
  items unchanged (estimate template demo data; dispatch/schedule mock screens;
  HiveSight build-artifact auth debt; api-smoke-test anonymous probes).

## 2026-07-31 (Security: cron + documents auth) -- Chris via Cowork (this session)
- Branch: fix/cron-and-documents-auth (commit a2636ce), worktree hlv_sec1,
  pushed + fast-forwarded onto main (5a85ff9..a2636ce) with Chris's approval.
  Live-verified: all three endpoints return 401 to anonymous callers.
- api/jobber/sync.js + api/jobber/sync-extended.js were publicly triggerable
  and hit Jobber's API (quota-abuse vector). Now gated on CRON_SECRET, the SAME
  pattern api/health-cron.js uses: accepts the Authorization: Bearer <CRON_SECRET>
  that Vercel Cron sends automatically to cron paths, OR ?key=<CRON_SECRET> for a
  manual run; 401 otherwise. CRON_SECRET confirmed set in prod (health-cron's
  identical gate is live and returns 401 without a key). The geocode branch in
  sync-extended is behind the gate too.
- api/documents.js (AI doc classifier -> Anthropic) had no auth -> anyone could
  run up an Anthropic bill. Now requires a signed-in Supabase session (shared
  requireUser). Its only caller (public/index.html) runs in the main window
  where the window.fetch auth-shim already attaches the token. 405-on-GET
  preserved.
- SAFETY NET for the gated sync: health-cron's daily "Jobber sync freshness"
  check already warns/fails + emails Chris if a sync goes stale (>36h/48h), so
  if the cron auth ever mis-fires it surfaces within a day. Revert = remove the
  6-line gate block. (Next scheduled sync window is 13:00-15:00 UTC; health-cron
  runs 15:30 UTC.)
- Tested: node --check all 3; idempotent re-run; functional gates (anon->401 with
  NO sync work / NO Anthropic call; Bearer + ?key= pass; geocode gated; 405
  preserved). Live post-deploy: sync / sync-extended / documents all 401 anon.
- Still OPEN (bigger, need Chris's go-ahead): encrypt the plaintext Jobber+QBO
  OAuth tokens in integrations (Vault installed but unused -- must update every
  reader in one shot or the healthy QBO sync breaks); add RLS policies to the
  ~98 policy-less tables (app runs on service_role today). Scoped in
  reina/security-followups-token-encryption-and-rls.md. Also still: estimate
  line-item TEMPLATE data is demo (picker is real); dispatch/schedule demo
  screens; test/api-smoke-test.js probes now-gated endpoints anonymously;
  HiveSight bundle auth is build-artifact debt.
- Coordination: another session merged fix/api-dedupe-fetch-wrapper (dedupe GET
  /api/*), "Get Desktop App" link, Command Center twitch fix. All my merges
  fast-forwarded; fetch before branching.

## 2026-07-31 (Estimate builder: client picker -> real Jobber clients) -- Chris via Cowork (this session)
- Branch: fix/estimate-real-client-picker (commit b14e490), built in worktree
  C:\Users\Chris\hlv_sec1, pushed + fast-forwarded onto main
  (7f99b58..b14e490) with Chris's approval. Live-verified.
- Follow-on to the Clients-screen work: the Estimate builder's client <select>
  in efRender() (the LIVE builder) was built from the fake CLIENTDB array, so
  every estimate -- including the REAL efRemoteCreate save (hlEstApi 'create'
  with clientId/clientName) -- was tied to a made-up client id (default 'c8').
- Fix: replaced the <select> with a type-to-search picker backed by
  REAL_CLIENTS (the live /api/clients data loadClientsLive already caches on
  boot). Picking a client calls efClientPick -> efEnsureRealClient, which
  UPSERTS a normalized entry into CLIENTDB ({n,a=company,t='',email,jobberUrl,
  _real}) so all ~15 existing CLIENTDB lookups in the estimate code resolve to
  the real client with NO edits to those sites. New efClientChange also ensures
  + gives an honest toast.
- Honest degradations (real client feed has no street/town): property shows
  company + 'See Jobber for address'; real email shown (was a fabricated
  first.last@gmail.com); sales tax defaults to Connecticut 6.35% (editable in
  totals). efRealCustInfo() renders this block only for _real clients; the
  legacy fake custinfo branch (fabricated phone/LTV/jobs) still runs for any
  non-real CLIENTDB entry. New estimates now start with NO client selected
  (was 'c8').
- Untouched on purpose: the fake CLIENTDB array itself (legacy template/new-
  client flows + openClient detail drawer still use it), and the legacy
  e2Render renderer (est-client <select>) -- not reachable from the normal
  estform flow, left as-is. Line items / deposits / totals / save / send
  unchanged.
- Tested: injected JS node --check clean; 8 unit checks (search, pick sets a
  real jobber_id + name, upsert idempotent/no-dupe, company-less -> See Jobber,
  real custinfo has company+real-email+jobber-link+CT-note, legacy client
  preserved); standalone Chromium render of the picker + pick flow, zero
  console errors; idempotent patch re-run. Live post-deploy: efEnsureRealClient
  / ef-client-results / the type-to-search input are present and the fake
  default 'c8' is gone.
- POST-DEPLOY CHECK for Chris: start a new estimate and confirm real clients
  appear in the picker as you type, and the picked client's email/company show.
- Still OPEN / flagged (unchanged): /api/jobber/sync publicly-triggerable crons;
  /api/documents ungated; plaintext OAuth tokens; RLS-without-policies;
  HiveSight bundle auth is build-artifact debt; other screens (dispatch/
  schedule demos) still carry labeled 'design reference' mock content; the
  estimate builder's e2Render legacy path + the fake CLIENTDB template data
  remain (only the live picker was wired).
- Housekeeping: worktree hlv_sec1 == main; stray claude/_incoming_*.cjs in
  hlv_claude_reina are safe to delete (canonical script committed as
  claude/_patch_estimate_real_clients.cjs).

## 2026-07-30 (Clients screen: fake list -> real Jobber data) -- Chris via Cowork (this session)
- Branch: fix/clients-screen-real-data (commit 24b5f96), built in worktree
  C:\Users\Chris\hlv_sec1, pushed + fast-forwarded onto main
  (bff23df..24b5f96) with Chris's approval. Live-verified.
- The Clients screen (view-clients in public/index.html) was a design mockup:
  fake personas (Delgado/Winslow/Brennan/Reyes/Okafor), fake stat numbers
  (347 clients / 62% repeat / $18.4K LTV / 3 at risk), and invented cards
  (Company memory / Referral engine / Reviews). Chris flagged it as fake twice.
- Rewired to REAL /api/clients data:
  * real stat tiles: total / active(not archived) / leads / owed(sum of open
    balances), computed from the live payload.
  * real searchable table of all ~8,662 clients -- search name/company/email;
    filter All/Active/Leads/Archived/Owes; sort name/balance/recently-updated;
    renders up to 400 matches with a "refine your search" notice + real counts.
  * real detail drawer (openRealClient): name, company, email, status, open
    balance, last-updated, Email + Open-in-Jobber actions. HONEST that job
    history / LTV / property notes aren't synced into THIS view yet -- links to
    Jobber for the full record (Law 1: no invented data).
  * removed the fake persona cards + the misleading '+ New client' button (it
    only unshifted a local fake row; real clients are created in Jobber).
- IMPORTANT (left intentionally): the shared fake CLIENTDB array and
  openClient() are UNTOUCHED because the ESTIMATE builder + new-client form
  still depend on them. The Clients screen now has its OWN REAL_CLIENTS +
  openRealClient(); estimates were not in scope. So the Estimate builder still
  picks clients from fake CLIENTDB -- a known remaining gap to wire to real
  /api/clients in a later pass. loadClientsLive() loads the full book once and
  caches (interval/visibility re-render only; never refetches ~8k rows).
- Verified: injected JS node --check clean; standalone Chromium render of the
  new screen (stat tiles, rows, filter, count) with ZERO console errors, plus
  a filter test (Owes money -> only balance>0 rows); idempotent patch re-run;
  live post-deploy the new "Owes money" filter is present and the fake
  "347 clients"/"Delgado" content is gone.
- POST-DEPLOY CHECK for Chris: open the Clients screen once (signed in) and
  confirm the real 8,662 load with search/filter working.
- Still OPEN / flagged (unchanged): Estimate builder still uses fake CLIENTDB
  (wire to /api/clients next); /api/jobber/sync publicly triggerable crons;
  /api/documents ungated; plaintext OAuth tokens; RLS-without-policies;
  HiveSight bundle auth is build-artifact debt (re-apply at vi-app source on
  rebuild); other screens (dispatch/schedule demos) still carry labeled
  "design reference" mock content.
- Housekeeping: worktree hlv_sec1 == main; stray claude/_incoming_*.cjs in
  hlv_claude_reina are safe to delete (canonical script committed as
  claude/_patch_clients_real.cjs).

## 2026-07-29 (P0 security round 3: HiveConnect impersonation) -- Chris via Cowork (this session)
- Branch: fix/hiveconnect-bridge-impersonation (commit 84df351), built in
  worktree C:\Users\Chris\hlv_sec1, pushed + fast-forwarded onto main
  (84c85a9..84df351) with Chris's approval. Live-verified.
- Vuln: /api/hiveconnect-bridge?action=session read the caller's identity
  (hivelogicUserId + hivelogicEmail) straight from the POST body with NO
  verification, then minted a real HiveConnect session for it. Anyone could
  POST any email and be logged into that person's HiveConnect chat (read/send
  their messages) -- full impersonation. This was the top item flagged at the
  end of round 2.
- Fix (api/hiveconnect-bridge.js handler): require the caller's verified
  Supabase session via the shared requireUser() helper (api/_lib/auth.js) ->
  401 signed-out; derive identity from the VERIFIED token (user.id/user.email)
  and IGNORE the body's id/email, so a forged body can't choose whose session
  is minted. Dropped the vestigial isDisabledUser body flag (never sent by the
  real client, no schema backs it). The browser caller
  public/hiveconnect-mount.js needs NO change -- it runs in the main index.html
  window where the round-1 window.fetch shim already attaches the signed-in
  token to same-origin /api/ calls (script tag at index.html:23447).
- Tests: 2 handler-level checks appended to test/hiveconnect-bridge.test.mjs
  (401 signed-out + zero mint; and: a forged body email is ignored, the session
  is minted for the TOKEN identity). 11/11 pass on-device (9 pre-existing
  ensureMappedAndMint tests unaffected). node --check clean. Live post-deploy:
  anonymous POST with a forged email -> HTTP 401 {"ok":false,"error":"Not signed in."}.
- POST-DEPLOY CHECK for Chris: open HiveConnect once while signed in and confirm
  chat still loads (this touches the login handshake; expected fine because the
  shim supplies the token, same mechanism HiveSight now uses).
- Still OPEN / flagged (unchanged, need Chris's scoping): /api/jobber/sync +
  sync-extended publicly triggerable crons (add a cron-secret like health-cron);
  /api/documents (AI classify, could gate to stop Anthropic-bill abuse);
  plaintext OAuth tokens in integrations (Vault unused); ~98 tables RLS-on-no-
  policy; test/api-smoke-test.js still probes gated endpoints anonymously
  (now 401s); Clients VIEW in index.html still a design mockup. HiveSight bundle
  auth fix remains build-artifact debt (must be re-applied at vi-app source on
  any rebuild).
- Housekeeping: worktree hlv_sec1 == main; stray claude/_incoming_*.cjs delivery
  copies in hlv_claude_reina are safe to delete (canonical script committed as
  claude/_patch_hiveconnect_impersonation.cjs).

## 2026-07-29 (P0 security round 2) -- Chris via Cowork (this session)
- Branch: fix/api-auth-round2-open-routes (commit 6cd4791), built in worktree
  C:\Users\Chris\hlv_sec1, pushed and fast-forwarded onto main
  (3d985f9..6cd4791) with Chris's approval. Live-verified.
- Continuation of the same-day P0 auth work. After locking /api/clients +
  /api/jobs, a full api/ route audit found 7 MORE endpoints returning real
  business data to anonymous requests (all confirmed live, signed-out):
  /api/qbo?resource=financials (full QuickBooks P&L -- cash 80,995, net income
  237,968), /api/snapshot (8,662 clients, 1.45M AR), /api/reports/summary
  (revenue MTD 392,705), /api/invoices (every invoice + balance), /api/chat
  (Reina answers using all of the above), /api/visual-intel (job media, read
  AND delete), /api/takeoffs.
- Fix: new shared helper api/_lib/auth.js (requireUser) -- single source of
  truth, same Supabase /auth/v1/user verification clients.js/jobs.js inline.
  Each handler gates -> 401 signed-out, unchanged signed-in. /api/qbo gates
  ONLY resource=financials|status; the Intuit OAuth callback (code+realmId)
  and the connect redirect stay public (Intuit calls them unauthenticated) --
  verified in the harness so the QuickBooks connection isn't broken.
- HiveSight regression fixed: public/vi-app (embedded as <iframe src="/vi-app/">)
  calls /api/jobs, /api/clients, /api/visual-intel through its bundled fetch
  helper nt() with NO auth header. Round 1 had therefore ALREADY broken its
  Jobs/Photos data -- the main app's window.fetch auth-shim lives in the parent
  window and can't reach the iframe's own fetch. Injected the same Supabase
  token (read from the shared sb-...-auth-token localStorage key) into nt()'s
  headers via claude/_patch_viapp_hivesight_auth.cjs. This fixes the round-1
  breakage AND lets visual-intel be gated. HiveSight now requires HiveLogic
  sign-in (correct for a tool showing customer photos).
  ** KNOWN DEBT: this edits the Vite BUILD ARTIFACT
  public/vi-app/assets/index-DwAcQw3z.js. HiveSight's real source (main.tsx) is
  NOT in this repo. A future HiveSight rebuild WILL overwrite this and must
  re-add the Authorization header in the app's api client (nt()). **
- Tested: node --check on all 9 changed js files (on-device); idempotent
  re-run of both patch scripts; functional harness (each route 401-out/200-in,
  qbo OAuth callback stays public, vi-app token reader in signed-in/out/nested
  shapes). Live post-deploy (cache-busted): /api/snapshot, /api/invoices,
  /api/qbo?resource=financials, /api/reports/summary, /api/visual-intel,
  /api/takeoffs all return 401 signed-out. /api/chat is POST-only (can't browser-
  probe) but gated by the same verified pattern.
- Still OPEN / flagged, NOT changed (need Chris's scoping): /api/hiveconnect-bridge
  ?action=session mints a HiveConnect session for ANY supplied email = an
  impersonation hole (left alone -- cross-product handshake, higher regression
  risk). /api/documents (AI classify, no DB read -- low risk, could gate to stop
  Anthropic-bill abuse). /api/jobber/sync + sync-extended are publicly triggerable
  crons (no data leak, but could burn API quota). Plaintext OAuth tokens + RLS-
  without-policies still open from the round-1 flags. The Clients VIEW in
  index.html is still a design mockup (fake personas) -- separate build.
- Housekeeping: worktree hlv_sec1 left in place; branch == main. Stray
  claude/_incoming_*.cjs delivery copies in hlv_claude_reina are safe to delete
  (canonical scripts committed as claude/_patch_auth_round2.cjs +
  _patch_viapp_hivesight_auth.cjs).

## 2026-07-29 (P0 security + Jobber sync) -- Chris via Cowork (this session)
- Branch: fix/p0-api-auth-jobber-refresh-lock (commit 1e07ce4), built in new
  worktree C:\Users\Chris\hlv_sec1, pushed and fast-forwarded onto main
  (083daec..1e07ce4) with Chris's explicit approval. Live-verified.
- P0-1 SECURITY: /api/clients and /api/jobs returned the full synced Jobber
  dataset (8,662 clients' names/emails/balances, 2,700+ jobs) to ANY anonymous
  request -- no session check, service-key queries. Now both handlers require
  a valid Supabase session (requireUser(), mirrored from track1.js's
  getRequestingProfile per the existing mirror-not-import convention) and
  return 401 signed-out; response shape unchanged signed-in. Frontend: one
  window.fetch shim in public/index.html (right after hlTokenSync()) auto-
  attaches the token to same-origin /api/ calls -- covers all ~12 bare call
  sites; clientportal-admin's two fetches now send its existing TOKEN.
  api/chat.js's in-process getClientsData/getJobsListData calls are un-gated
  on purpose. health-cron already treats 401 as alive. Live-verified post-
  deploy: anonymous GET on both endpoints -> 401.
- P0-2 JOBBER SYNC (dead since 07-26, second death after 07-16): root cause
  was NOT missing rotation persistence (saveTokens already stored the rotated
  refresh_token and demonstrably saved one at 07-26 10:49 UTC, 2h before
  death). Actual bug: concurrent-refresh race -- several Vercel crons fire on
  the same */15 marks (sync-extended?resource=vehicles, track1?resource=
  check_new_leads), two invocations spend the SAME single-use refresh token,
  Jobber's reuse detection revokes the grant. Fix in api/_lib/jobber.js:
  atomic refresh claim (conditional PATCH on integrations.updated_at -- one
  winner refreshes, losers poll and reuse its saved token, crashed winner
  times losers out loudly and the next run re-claims) + saveTokens now
  retries 3x so a transient Supabase error can't strand a rotated pair.
- One-time re-auth: Chris reconnected via /api/jobber/connect. Verified live:
  full sync success 22:18 UTC (841 clients / 2,731 jobs / 2,784 invoices),
  a refresh cycle at 22:41 UTC rotated AND persisted (updated_at moved,
  refresh_token changed), and a follow-up invoices sync succeeded 23:07 UTC.
- Tests: test/clients-by-ids.test.mjs updated for the auth contract + 2 new
  401 checks -- 13/13 pass on-device. node --check clean on all changed js.
  Patch scripts (idempotent, exact-anchor, CRLF-safe, verify-all-before-
  write): claude/_patch_p0_api_auth.cjs, _patch_p0_jobber_refresh_lock.cjs.
- Known follow-ups flagged, NOT done (need Chris's scoping): Jobber+QBO
  tokens are plaintext in integrations (Vault unused); ~98 tables have RLS
  on with no policies (app runs on service_role); bookkeeping/
  reference-data.js self-describes copying the old "no-auth posture" -- a
  full api/ auth audit is warranted; test/api-smoke-test.js still probes
  these endpoints anonymously (now sees 401s -- update when next touched).
  The Clients VIEW in public/index.html remains a design mockup with fake
  personas (pre-existing, labeled as such in-page) -- Chris asked about it;
  wiring it to real /api/clients data proposed as a follow-up build.
- Housekeeping: worktree hlv_sec1 left in place per hlv_* convention.
  claude/_incoming_p0_*.cjs + _incoming_status_append.cjs in the
  hlv_claude_reina worktree are stray untracked delivery copies -- safe to
  delete anytime (canonical copies are committed as claude/_patch_p0_*.cjs).

## 2026-07-29 — Chris via Codex (Windows Agent security hardening)
- Branch: `feature/windows-agent-control-20260729`; production migration and merge remain blocked pending a fresh protected-preview review and Chris's approval.
- Removed build/write/deploy/rollback/update tasks from the accepted server registry, device capabilities, runner, permissions, and UI. First release now supports only repository status and approval-gated repository tests.
- Fixed fail-closed approval persistence, atomic single-use enrollment claims, duplicate-host/device-credential rejection, realpath-based junction escape prevention, device-side immutable scope-hash/approval validation, process-tree cancellation, and lease renewal. Credential rotation is disabled until an installed-agent handshake exists.
- Added regression tests for approval failures/races, enrollment claims, scope mutation, Windows junction escapes, disabled task classes, approval presence, and descendant-process cancellation. Migration 035 now adds its circular foreign key idempotently.

## 2026-07-29 — Chris via Codex (Windows Agent control-plane foundation)
- Branch: `feature/windows-agent-control-20260729`, based on `origin/main`; not merged or deployed.
- Added the Supabase device/task/approval/event schema, authenticated enrollment and device/control APIs, admin Devices UI, and a separate outbound-only Windows service agent. Devices have unique revocable credentials, local folder/repository policy, typed tasks, approvals, pause/resume, emergency stop, cancellation, heartbeats, redacted results, and DPAPI-protected credential storage. No remote shell, remote desktop, mouse/keyboard control, or arbitrary command endpoint exists.
- First executable task handlers are deliberately limited to repository status, npm test, and npm build with exact non-shell argument lists. Write/deploy types remain blocked pending journaling/rollback and signing work. Setup and remaining production gates are in `docs/WINDOWS_AGENT_SETUP.md`.

This is a running, append-only log of what changed in this repo, written
by whichever AI session (any account, any machine) did the work. It
exists because Claude Projects don't talk to each other — a session
attached to one Project (or on a different Claude.ai account entirely,
like Jovie's Team account) has no way to see what happened elsewhere.
This file is the one thing every session CAN see, because it lives with
the code.

**Every session working in this repo should:**
1. **At the start:** read the last 5-10 entries below before doing
   anything, so you know what's already in flight.
2. **At the end of any session that shipped/changed something:** append a
   new entry using the format below. Keep it short — this is a log, not a
   report.

```
## 2026-07-24 (merge) -- Chris via Cowork (this session)
- Branch: main (merge commit 2731cf5, merged from feature/voip-popup-ui
  7673291). Chris reviewed and said "merge now" -- straightforward
  --no-ff merge, no conflicts.
- Between the push and the merge, Chris clarified the design further:
  "I think both need to be on the site. Primary use is the popup for
  quick and easy phone use, more sophisticated tab, with all features
  tied into HiveConnect and also having a small quick action button on
  the top of each page to pull up the dialer." The top-bar icon already
  satisfied the last part (global on every page). Expanded the
  HiveConnect VoIP tab to 5 sub-views -- Dialer, Call log, Voicemail
  (mark read/unread + call-back), Contacts (team + client directory,
  click-to-call), Settings (Extensions/Numbers/Greetings/Blocklist CRUD
  -- ported from the deleted Phase-1 app-phone.js, same /api/voice
  resources). Added window.hlPhone (dial/open/close/hangup/isOnCall) to
  app-phone-popup.js so the tab's Dialer/Contacts/voicemail-callback all
  route calls through the popup's SAME Twilio Device instead of
  registering a second one -- the Voice SDK only supports one healthy
  registration per identity per browser tab.
- Merge result: 6 files changed (public/app-phone-popup.js,
  public/app-phone.js deleted, public/hiveconnect/{app.js,index.html,
  voip-panel.js}, public/index.html), 689 insertions / 424 deletions.
  node --check passed on all changed .js files post-merge.
- Live now: top-bar phone icon (popup) on every page, HiveConnect "VoIP"
  tab with the full feature set. Not yet live-tested against a real
  Twilio account -- still blocked on Chris's own Console setup
  (claude/voice-phone-system-spec.md). Schedules admin (backend resource
  exists) still has no frontend in either the old or new UI -- unchanged,
  flagged gap.

## 2026-07-24 (later) -- Chris via Cowork (this session)
- Branch: feature/voip-popup-ui (pushed to origin, commit 47e7568), NOT merged
  to main yet -- same worktree, C:\Users\Chris\hlv_voip1.
- Context: continuation of the same-day VoIP build (see the entry right below
  this one). Chris asked for mockups of the phone UI ("for tomorrow!") and gave
  an explicit design pivot: popup-primary, a HiveConnect VoIP tab, and a phone
  icon in the top bar next to Notifications/Settings. First mockup draft had a
  real JS syntax bug (escaped apostrophe inside a single-quoted string crashed
  the whole <script> block, so the popup never rendered) -- Chris caught it.
  Found the exact line via Playwright + console-error capture, fixed it, and
  re-verified render (all 4 concept states, zero JS errors) BEFORE resending.
  Chris approved the concept, then said "build it."
- Reworked the UI layer only -- backend (api/voice.js, api/voice-webhook.js,
  Twilio conference call routing) is unchanged from the entry below.
- New: public/app-phone-popup.js (global popup softphone, window.
  hlPhonePopupToggle(), Dialer/Calls/Voicemail tabs, active-call view with
  real Hold/Transfer/Keypad/Mute/End via the Twilio Voice JS SDK). Deleted:
  public/app-phone.js (Phase-1 full-page tabbed UI, superseded).
- New: public/hiveconnect/voip-panel.js -- HiveConnect's VoIP tab
  (openVoipTab(), stats/call-log/voicemail list, Open dialer button). Fetches
  /api/voice using hlTokenSync() -- HiveConnect is merge-mounted into the same
  window as the main app, so that token helper is reachable even though
  HiveConnect runs its own separate Supabase project. Same pattern tasks.js
  already established (a HiveConnect tab surfacing another HiveLogic system's
  data); this one does need fetch() since the phone data lives in HiveLogic's
  own tables, not HiveConnect's.
- public/index.html: removed the Phase-1 nav-phone group/view, added the
  top-bar phone icon (#hlphoneicon / #hlphonebadge), swapped the script tag to
  app-phone-popup.js.
- public/hiveconnect/index.html + app.js: added a VoIP rail button, an empty
  panel-voip sidebar slot, a voip-view main-area view (same tc-view pattern as
  Tasks/Calendar), and wired 'voip' into setNavTab() (panel array, title map,
  view toggle, openVoipTab() call) -- same integration pattern Tasks/Calendar/
  Chirp already use.
- Verified before committing: node --check passes on both new .js files; all
  12 expected markers confirmed present via grep-style checks; old Phase-1
  markers confirmed removed; git status showed exactly the 6 expected files
  staged, nothing stray.
- Not done this session: merging to main (reverts/replaces something already
  live in main, so it's pushed for Chris to review first, not auto-merged
  like the backend build was); an actual live call test (still blocked on
  Chris's own Twilio Console setup, unchanged from the entry below).

## 2026-07-24 -- Chris via Cowork (this session)
- Branch: feature/voip-system (pushed to origin, commit 7841f45), NOT merged to
  main yet -- new worktree at C:\Users\Chris\hlv_voip1, left in place per the
  other hlv_* worktree convention.
- Context: Chris asked to build "an integrated VoIP system," then mid-session
  pasted a full detailed product spec for "HiveLogic Phone" -- a strictly
  telephone-only business VoIP system (numbers, extensions, IVR, hold/transfer,
  voicemail+transcription, AI call intelligence), explicitly separate from
  HiveConnect (which stays the chat/messaging/video product). Read that spec
  and claude/branch-coordination-protocol.md + claude/status.md first per this
  file's own instructions.
- Built Phase 1 for real, on top of Twilio Programmable Voice (no twilio npm
  dependency -- raw fetch + node:crypto, matching this repo's existing
  jobber.js pattern). Full architecture + phased roadmap + exact Twilio Console
  setup steps Chris still needs to do: claude/voice-phone-system-spec.md.
- New: sql/023_voice_phone_system.sql (extensions, numbers, schedules,
  greetings, blocklist, calls, call_events, voicemails, + clients.phone_e164),
  api/_lib/voice.js (Twilio REST/TwiML/signature/Access-Token helpers),
  api/voice-webhook.js (Twilio-facing webhooks -- conference-based call
  routing so Hold and blind Transfer are real, not simulated), api/voice.js
  (authenticated app API -- extensions/numbers/schedules/greetings/blocklist
  CRUD, call log, voicemail, softphone token minting, hold/transfer actions),
  public/app-phone.js (member UI: Dialer/Voicemail/Calls/Contacts/Settings
  tabs, Twilio Voice JS SDK softphone with real Hold/Transfer/Keypad/Mute/End).
- Also fixed a real, long-standing gap: api/jobber/sync.js now syncs client
  phone numbers (clients.phone_e164) -- previously only email synced, which
  api/marketing.js and api/fieldops.js both separately flagged as blocking
  any SMS/call automation. NOT yet live-verified against Jobber's real
  GraphQL schema (no deployed Jobber OAuth token in this session) -- see the
  spec doc's "Known unverified item" section for exactly what to check on
  the first live sync run.
- Wired into public/index.html as its own new top-level nav group ("Phone"),
  not nested under Money/Ops/CRM -- kept deliberately separate per the
  product's own "no messaging/collaboration clutter" boundary. 4 small,
  targeted edits (nav group, view container, showView's view-toggle array,
  one init hook) via a self-deleting patch script, not a full-file rewrite --
  index.html is 1.9MB and this session has no reason to risk a large diff on
  a file that size.
- Verified: `node --check` passes on all 4 new/changed .js files, vercel.json
  parses, and the 5 index.html edits are all present in the pushed commit.
  NOT verified: an actual live call, because there is no Twilio account
  connected yet -- see the spec doc's 8-step setup checklist. The UI shows an
  honest "not connected yet" state (no fake data) until Chris does that setup.
- Deliberately deferred (see spec doc for full list + reasoning): physical
  desk phone provisioning, warm ("talk first") transfer, self-serve number
  search/purchase/porting wizard (Phase 1 is admin-paste after buying/porting
  in the Twilio console), AI Attendant, ring groups/queues beyond a flat
  extension list, E911 dispatchable-location workflow, multi-carrier failover.
- Not done this session: opening a PR / merging to main (Chris hasn't said
  go-ahead), and the Twilio Console-side setup (account, number, API key,
  TwiML App, webhook URLs, env vars) -- all of that is Chris's own action,
  listed step-by-step in the spec doc.

## 2026-07-23 -- Chris via Cowork (this session)
- No commits to hivelogic-live -- this is a new, separate project, not a
  change to this repo. Logging it here per the "protected feature builds"
  section below so no one is confused finding it.
- Context: Chris asked to focus on "the production level mobile app side."
  Audited public/field/ (the Field PWA) live -- it's already a mature,
  real production app (clock gate, per-job timer w/ travel+supplies+lunch,
  live GPS ETA texts, client e-signatures, AI-read equipment photos,
  materials/office requests, end-of-job reports, T&M invoicing, Reina voice
  assistant, installable manifest + service worker). Found one live bug
  while testing: workforce_status returns a session as "active" with no
  age check -- Chris's own clock-in from 2026-07-21 was still showing
  "Clocked in" two days later on 2026-07-23, while the separate
  workforce_team endpoint correctly excluded it as not-today. Not fixed
  yet -- flagging here in case another session gets to it first.
- Chris chose to go native (App Store / Play Store) rather than keep
  hardening the PWA. Started a NEW, separate project --
  `hivelogic-field-native` -- per this doc's "protected feature builds"
  convention (immature native wrapper, kept out of the main repo). Delivered
  to Chris as a zip + written to his Desktop
  (C:\Users\Chris\Desktop\hivelogic-field-native.zip); no GitHub remote yet
  -- needs one once Chris creates an empty repo for it (flagging as an open
  gap per this doc's rule: a protected build should still have a real
  remote, not stay local-only).
- Architecture: a THIN Capacitor wrapper, not a rewrite -- capacitor.config.ts
  server.url points straight at https://hivelogic-live.vercel.app/field/, so
  every ordinary change pushed to THIS repo's main keeps shipping instantly
  to the native app too, no app-store resubmission needed for normal feature
  work. Android + iOS native projects generated, real icon/splash assets
  generated from the existing public/field/icon-512.png (not generic
  placeholders), @capacitor/push-notifications + geolocation + camera + app
  installed and synced, native permission strings added to both platforms.
- Hard constraint discovered and confirmed (not assumed): this Cowork cloud
  sandbox's network allowlist blocks dl.google.com, maven.google.com, and
  services.gradle.org -- confirmed via a direct `./gradlew` failure ("Unable
  to tunnel through proxy... 403"). No Android/iOS build can be compiled or
  tested from this environment, full stop. Real builds need to happen on a
  machine with normal internet access (Android Studio on Chris's machine
  for Android; a Mac or cloud macOS CI for iOS -- no Mac purchase required).
- Not done yet: the actual JS wiring in public/field/index.html to call the
  native push/geolocation plugins (window.Capacitor?.isNativePlatform?.()
  guarded, so it's a no-op for browser/PWA users) -- plugin deps + native
  permissions are in place but nothing calls them yet. Also: Apple
  Developer Program + Google Play Console enrollment is on Chris, not
  done by any session (needs his own accounts/payment).

## 2026-07-22 (evening, later) -- Chris via Cowork (this session)
- Branch: main (pushed to origin/main, commits 6568d75, 56078d0, 71eeede)
- Context: continuation of the T&M/client-portal/subportal audit -- Chris asked
  to live-verify the 2026-07-22 Expense/PO bookkeeping rebuild in production
  (master-todo's top HIGH item: automated tests passed but no runtime check
  had been done). Found two real, unrelated production bugs via that
  live click-through, fixed both.
- Bug 1 -- api/bookkeeping/reference-data.js 404: Expense Entry and Purchase
  Orders have called /api/bookkeeping/reference-data?resource=all since the
  rebuild, but the route was never built. Vendor/account/job fields showed
  "QBO reference data. Nothing was loaded" in production. Built the route --
  aggregates real QBO vendors + chart-of-accounts (api/qbo/index.js's
  already-live getFinancials(), same connection Financial Intelligence uses)
  and real active Jobber jobs (api/jobs.js's getJobsListData()). Also added
  the missing id field to getFinancials('accounts') so account dropdowns have
  a real id to submit, not just a label. Verified live: 1,385 real vendors,
  43 expense accounts, 20 bank accounts, 77 jobs, zero errors.
- Bug 2 -- main app login screen stuck forever despite a valid session: this
  is the actual cause of Chris's "it won't log in" report mid-session. Root
  cause confirmed via live console instrumentation, not guessed: hlRequireSession
  is declared inside the workforce/time-clock widget's own private IIFE (used
  there by workforceRefresh). hlTrySilentLogin -- the boot-time check that
  hides #login when a session already exists, added later in a separate
  script block -- calls hlRequireSession by bare name assuming it's global.
  It never was. Every single silent-login check, on every page load, threw
  "hlRequireSession is not defined", silently caught by its own try/catch,
  so the login screen never hid even with a fully valid, unexpired session --
  matches an earlier, never-finished task on this exact wiring. First attempt
  (deferring the call to DOMContentLoaded, commit 56078d0) was a real, honest
  secondary improvement, not the actual bug -- caught that it wasn't enough by
  re-testing live after that deploy, kept digging instead of declaring done.
  Real fix (commit 71eeede): window.hlRequireSession = hlRequireSession; right
  after its definition, inside the IIFE -- purely additive, doesn't change
  workforceRefresh's own behavior. Verified live end-to-end: reloaded the
  signed-in app repeatedly, lands straight on the dashboard every time now,
  no login screen.
- Open/next: api/bookkeeping/expenses.js (the actual save-on-submit endpoint
  for Expense Entry) still never persists anywhere -- validation-only,
  honestly disclosed in its own response ("Not persisted to a production
  store yet"). Same family as the already-tracked ledger/banking/close-engine
  durable-storage gap -- did not touch, out of scope for this pass, flagging
  for whenever that's prioritized.

## 2026-07-22 (evening) -- Chris via Cowork (this session)
- Branch: main (pushed to origin/main, commits 568744c, db87319)
- Context: Chris asked to see the Sub Portal. What I found: the in-app
  "Sub Portal" nav item (Portals & Field -> Sub Portal, view key psx) was
  a 100% static, zero-backend mockup -- every button just popped a "still
  in development" modal. Chris then told me about three OTHER pages that
  ARE real and live: /subportal/, /clientportal/, /clientportal-admin/ --
  I verified all three independently (didn't just take his word for it)
  and confirmed they're genuinely live, separately-deployed pages backed
  by real Supabase tables and working serverless APIs, completely
  unrelated to the fake in-app mockup. Chris's framing: "Sub portal is
  something to send to the subcontractor and live on their end. its ties
  by to HiveLogic and we need to build out the Hivelogic side of the
  portal." Asked scope -- Chris chose "everything in one pass" over
  "core loop first" or "just subs directory."
- Built the missing staff ("HiveLogic side") admin surface for the sub
  portal, mirroring the clientportal/clientportal-admin split that
  already existed:
  - api/subportal.js: 10 new staff-gated actions (subs_list, sub_detail,
    docs_expiring, rfq_create, rfq_review, rfi_answer,
    schedule_item_create, invoice_status_update, staff_messages,
    staff_message_send), all gated via the existing getStaffProfile(req)
    helper (same pattern as the pre-existing invite action). Every
    action that changes sub-visible state drops a sub_notifications row
    (so the sub sees it live on /subportal/) and a sub_audit_log entry
    (actor: staff).
  - public/subportal-admin/index.html (new): standalone staff page,
    same dark-theme tokens and Supabase-session-pickup pattern as
    clientportal-admin. Subs directory (search, status, open-RFQ /
    docs-expiring badges) -> per-sub tabs: Overview, RFQs, RFIs,
    Schedule, Invoices, Messages.
  - public/index.html: showView() now special-cases the psx view the
    same way it already special-cases csx (external live content instead
    of the baked-in data-hl63 mockup blob) -- the iframe's src is set to
    /subportal-admin/ directly. The old mockup blob is left in place but
    unreferenced; zero risk to the file's other 27 data-hl63 blobs
    (verified: blob count unchanged at 28, script-tag balance unchanged
    at 105/105).
- Caught and fixed one real bug via live testing, not just static
  checks: the invite-link success message called a full-page
  renderSubsList() right after showing the copyable invite link, which
  wiped the link (and its "copy" button) off screen before staff could
  read it -- a real problem since SMS/email auto-send still isn't wired
  up, so staff MUST copy that link manually today. Fixed by extracting
  list rendering into drawSubList() and only redrawing the list, not the
  whole page, after a successful invite.
- Verified live end-to-end on production (not simulated): invited a real
  test sub ("TEST Claude Verification Co") from the new staff page ->
  redeemed the real magic link as that sub on the real /subportal/ app
  (onboarding screen pre-filled correctly, progressive-onboarding status
  flipped invited -> active automatically) -> sent a real RFQ from staff
  -> confirmed it appeared instantly in the sub's live notification feed
  and Jobs tab -> submitted a real bid as the sub via the actual API ->
  confirmed the bid amount/notes rendered correctly on the staff RFQ
  card -> clicked Award on staff side -> confirmed status flipped to
  "awarded". All test data (sub + cascaded rows) deleted afterward via
  SQL editor; confirmed the staff subs list is clean again.
- Open/next: sidebar nav visual check (click Portals & Field -> Sub
  Portal in the logged-in app and watch it load) still pending -- the
  tab got logged out mid-session and I won't enter Chris's password
  myself. Everything else is verified through the direct /subportal-admin/
  URL and the full functional round-trip, so this is a nice-to-have, not
  a blocker. SMS/email auto-send for invites/RFQs/etc is still not wired
  (disclosed honestly in the API itself, same as before this session) --
  a Phase 2 item, not something broken by this work.

## 2026-07-22 (later still) -- Chris via Cowork (this session)
- Branch: main (pushed to origin/main, commit 62a703b)
- Context: Chris said "I think materials tab should merge with Job Readiness"
  after seeing the new Schedule Materials lens -- correctly noticed it and
  the Job Setup & Readiness page's "Materials & POs" checklist were two
  disconnected data models. Confirmed approach with Chris: extend the
  Readiness gate itself with real status+ETA (not the other way around).
- Found a real bug while auditing the target page: the Job Setup &
  Readiness page's embedded data-hl63 blob had a genuine HTML-escaping
  defect -- a backslash-escaped quote inside the embedded JS source
  (\"sub\") was never re-encoded to &quot; when the whole page got
  embedded as an HTML attribute value. The browser's attribute parser cut
  the attribute off right there and misread the remaining ~16KB as
  garbage HTML, which is why the whole page rendered as a tiny ~330x180px
  box instead of full-size. Scanned all 28 data-hl63 blobs in the app for
  the same defect -- only this one was actually broken (one other,
  if-invx, looked suspicious in an automated scan but turned out to use a
  different, fully-correct full-entity-escaping convention; false
  positive, ruled out by hand).
- Fixed: rebuilt the blob using the same &amp;/&lt;/&gt;/&quot; scheme the
  other 27 working blobs use (raw ' left alone), replaced the 3-checkbox
  "Materials & POs" gate with a real Status dropdown (not_ordered /
  ordered / on_site) + ETA date input, wired to the SAME
  resource=job_workflow_set endpoint the Schedule Materials lens already
  reads from -- so both surfaces now read/write one shared record
  instead of two. Gate passes only at on_site, matching the page's own
  stated "Material State Law" text ("It's ordered never unlocked a job
  and never will").
- Verified before shipping: script-tag balance (104/104), all 28
  data-hl63 blobs still present, file-size delta sane (+6,160 chars --
  guards against the $' duplication bug from earlier today), new
  Function() parse of the rebuilt embedded script succeeded, git diff
  showed only the intended edits. Verified live in the browser: iframe
  now renders at full size (1271x1023 via DOM inspection, not 330x180),
  did a real round-trip test on a live job (set status to ordered, then
  on_site, confirmed gate correctly stayed closed then opened, confirmed
  the write persisted server-side via job_workflow_list with the correct
  updated_by), then reset that test job back to its original
  not_ordered/no-ETA state so no real data was left altered.
- Open/next: Compliance and Company Schedule lenses still need Chris to
  define a real data source before they can go live -- unchanged from
  earlier today. Authorize.Net env vars/webhook still pending on Chris's
  side, paused by his own request.

## 2026-07-22 (later) — Chris via Cowork (this session)
- Branch: main (pushed to origin/main)
- Context: Chris asked "what's next" after pausing Authorize.Net setup;
  chose "finish Schedule's other tabs" from the remaining lens-tab backlog.
- Audited all 5 remaining fake Schedule lenses (Operations/Materials/
  Money/Compliance/Company) for a REAL backing data source before
  building anything (Law 1 -- don't fake it, and don't build a tab that
  can't be real). Findings: Money has a full real QuickBooks-backed
  engine already live elsewhere (handleFiCash/handleFiForecast, used on
  the Insights/Daily-Brief page) that was just never wired into
  Schedule. Materials has real (if sparse) data via
  job_workflow.materials_status/materials_eta. Compliance and Company
  have NO real data source anywhere in this app (vendor insurance/certs,
  permits -- the FI code itself says so explicitly:
  "No vendor-compliance data source connected yet"). Operations lens
  turned out to already be real (dispatch_alerts) per an earlier pass.
- Shipped: Money lens now calls the SAME resource=cash/resource=forecast
  endpoints as Insights -- real bank balance, real bills due (14d), real
  true-available-cash, real 8-week bill calendar with real vendor names.
  Materials lens now calls new resource=materials_overview
  (api/track1.js) -- real jobs in ordered/on-site state with real ETAs.
  Both replace 100% fabricated design-reference content ($74K payroll,
  Ferguson 78% reliability, PO-2412-01, etc.).
- Bug caught + fixed same-session: the patch script used
  `src.replace(anchor, replacementString)` -- String.replace() treats a
  literal "$'" in the replacement as a special "insert everything after
  the match" pattern, and the moneyFmt() helper's own `'$'` string
  triggered it, silently duplicating ~510KB of the file. Caught via the
  "file should not grow more than ~5KB" sanity check before committing;
  reverted with `git checkout --` and rewrote the splice using plain
  indexOf/slice instead of .replace() with a string argument.
- Open/next: Compliance and Company lenses remain honestly labeled
  design-reference -- they need Chris to define a real data source (e.g.
  a staff-maintained table like tm_rate_types) before they can be real;
  not an engineering task I can do alone. Materials lens intentionally
  omits vendor-reliability % and PO tracking (that data lives in a
  separate, not-yet-merged purchase-orders engine).

## 2026-07-22 — Chris via Cowork (this session)
- Branch: main (pushed to origin/main)
- Context: T&M step 3 — the last 2 remaining T&M items Chris asked for
  (Schedule-page T&M tab + auto-filled hours from the clock).
- Shipped: new `resource=tm_overview` endpoint in `api/track1.js`
  (real job_workflow.is_tm jobs joined to jobs + tm_invoices, computes
  totalInvoiced/totalPaid/totalPending). New 8th Schedule lens tab
  ("T&M") in `public/index.html` rendering those real totals + a
  jobs-awaiting-invoice list. Verified live: honest all-zero empty
  state (no T&M jobs exist in production yet — correct, not a bug).
- Shipped: tech's T&M invoice screen in `public/field/index.html` now
  pre-fills the hours field from real `job_time_entries` onsite clock
  segments for that tech/job (computed server-side in `api/fieldops.js`
  as `clockedHours`), still fully editable, honestly labeled either way
  (has clock data vs. none found yet).
- Open/next: T&M is now fully shipped end-to-end (intake checkbox+rate →
  invoice w/ auto-filled hours → Authorize.Net payment link → Schedule
  tab totals). Only remaining blocker is Chris adding the 3 Authorize.Net
  keys in Vercel + registering the webhook — not an engineering task.
- Also fixed same-session: `tm_pay_init` was accidentally gated behind
  staff sign-in (wrong endpoint order in `api/fieldops.js`) — moved it
  above the staff-only gate so client payment links work without login.

## 2026-07-22 — Chris via Cowork (this session)
- T&M/Service Lane, step 2 shipped: tech-generated invoice + real payment collection, per Chris ("tech generate the invoice and collect payment onsite"). Processor is United Payment Corp / Authorize.Net (Chris's choice, 2026-07-22). Checked Stripe's own Tap to Pay docs first and confirmed it needs a native iOS/Android (or React Native) app -- HiveLogic's tech-facing Field App (public/field/) is a web PWA, so Tap to Pay would have meant a much bigger native-app project. Landed instead on a payment link/QR (Authorize.Net Accept Hosted) -- works today in the existing web Field App, zero hardware, zero new app to build.
- Backend (sql/017_tm_invoices.sql): new tm_invoices table (RLS on, service-role only). status only ever becomes 'paid' via api/authnet-webhook.js after Authorize.Net's own signature-verified webhook confirms the charge and a second server-to-server lookup (getTransactionDetailsRequest) confirms it -- the client-side redirect after paying is never trusted alone.
- api/_lib/authnet.js: thin fetch()-based helper matching this repo's no-SDK convention (same style as supabaseRequest). Gated by authnetConfigured() -- returns an honest "payment processor not connected yet" instead of crashing or faking success, since AUTHNET_API_LOGIN_ID/AUTHNET_TRANSACTION_KEY/AUTHNET_SIGNATURE_KEY aren't set yet. Defaults to Authorize.Net's SANDBOX environment until Chris sets AUTHNET_ENVIRONMENT=production, so nothing can accidentally run a real charge before he's ready.
- api/fieldops.js: the tech's "day" view now merges real is_tm/tm_rate_hourly from job_workflow onto each job. New actions: tm_invoice_create (staff, computes hours x rate + materials server-side -- rate is never trusted from the client), tm_invoice_status (staff poll), tm_pay_init (public, token-gated).
- public/field/index.html: a "GENERATE T&M INVOICE" button now appears in the normal job flow, but ONLY on jobs actually flagged is_tm -- no separate T&M screen. Tech enters hours + materials, gets back a real link to text or copy to the client.
- public/pay/index.html: new public client-facing payment page (same pattern as public/track/) -- shows the real invoice total, hands off to Authorize.Net's hosted payment form.
- Caught and fixed a real bug during live verification, same session: tm_pay_init (meant to be public/client-facing, no login) had been spliced in after fieldops.js's blanket "everything below requires staff sign-in" gate, so the payment page was 401'ing for the very clients it's supposed to serve. Moved it next to the other public action (travel_view). Re-verified live afterward -- confirmed working correctly.
- Verified live end-to-end: tm_pay_init and /pay/ both handle an invalid token honestly ("This payment link is not valid"); the webhook correctly rejects an unsigned test payload with 401.
- Still needed from Chris (Vercel env vars -- never entered by me): AUTHNET_API_LOGIN_ID, AUTHNET_TRANSACTION_KEY, AUTHNET_SIGNATURE_KEY, and AUTHNET_ENVIRONMENT=production when ready. Also needs to register the webhook URL (https://hivelogic-live.vercel.app/api/authnet-webhook) for net.authorize.payment.authcapture.created in the Authorize.Net merchant portal. Until then, tm_pay_init honestly says payment isn't set up yet rather than faking anything.
- Not yet done: an hours x rate live running total display before invoice generation (currently the tech enters hours manually rather than it being pulled from the job clock automatically), and the actual T&M lens/board Chris originally asked to fold into the Schedule page tabs (separate from this intake+payment work).

## YYYY-MM-DD HH:MM — <who/session, e.g. "Chris via Cowork" or "Jovie">
- Branch: <branch name>
- Shipped: <one line per thing that actually merged/deployed>
- Open/next: <one line per thing still in progress or blocked>
```

Newest entries go at the top.

---

## 2026-07-21 (even yet later) — Chris via Cowork (this session)
- T&M/Service Lane, step 1 shipped: per Chris's direction, this is NOT a separate sidebar page. Found the app already has a real, working "New Job" form (fm-job, njobSave -- honestly labeled "Saves to HiveLogic, Jobber write-back is a later phase") -- extended that same shared intake screen instead of building a new one, exactly as Chris asked ("all jobs should start on the same screen").
- Added: a "TIME & MATERIALS JOB" checkbox on the New Job form. Checking it reveals a rate-type dropdown, populated live from a new tm_rate_types_list endpoint -- not hardcoded. Seeded with exactly ONE real row Chris gave directly in this conversation: General T&M @ $225/hr. No other service-type rates invented.
- Backend (sql/016_job_tm.sql): job_workflow gets is_tm/tm_service_type/tm_rate_hourly columns. New tm_rate_types reference table (RLS on, service-role only) is the single source of truth for the dropdown -- add rows there to add more rate types later, never hardcode in app code. handleCreateJob now looks the rate up server-side by key (never trusts a client-supplied dollar figure), and writes the T&M flag onto job_workflow right after the job itself is created.
- Verified live end-to-end: tm_rate_types_list hit directly on the deployed API returns the real $225/hr row; deployed public/index.html confirmed to contain the new checkbox/dropdown/loader markup (njob-tm-check, njobTmToggle, njobLoadTmRates).
- Deliberately NOT built yet (needs Chris's input, not guessable): (1) whether $225/hr is the only rate or more service-type rates are coming, given Chris's own phrasing implied more than one; (2) the "tech generates the invoice and collects payment onsite" flow Chris wants to replace manual Dispatch invoicing with -- this touches real money and there's no payment processor wired into this codebase yet, so nothing here should be built as UI until that's scoped for real. Also not yet built: an hours x rate live running total once clock-in/out data exists for a T&M job (straightforward once the rate table question above is settled).

## 2026-07-21 (latest) — Chris via Cowork (this session)
- Shipped: Job Setup & Readiness page. Chris confirmed the mockup's own coded gate spec (GATES array already in the page) was the real spec to build: 5 gates / 12 items -- Client confirmed, Deposit collected, Materials & POs, Permits & documents, Crew assigned.
- Backend (sql/015_job_readiness.sql): extended job_workflow with readiness_items jsonb (per-item {done, at, by}) + readiness_override_at/by/reason. Two new api/track1.js endpoints: job_readiness_set (per-checkbox toggle) and job_readiness_override (logged override, with a clear path). All verified live end-to-end (write, read, round-trip) before and after deploy.
- Frontend: queue is real (api/jobs jobs with status upcoming/unscheduled, minus ones already setup-complete in job_workflow) -- confirmed 31 real jobs currently in the queue. Real checkboxes write to job_readiness_set; "Payment received & cleared" is the one auto-derived item, read straight off the existing deposit_paid_at field instead of duplicating state. "Mark setup complete" button calls the existing job_workflow_set (setupComplete:true) -- so finishing readiness here now genuinely moves a job on the real Jobs Kanban I built earlier today.
- Fabrication removed: the old page had 4 hardcoded fake jobs, elaborate invented "Reina" commentary per job ("I called this morning: examiner reviews it TODAY" -- entirely made up), and a "Chase it" button that claimed to auto-chase by text+email with a fake 24h/48h escalation. All replaced -- open items now list honestly with no invented narrative, and the chase button says plainly there's no automated chase system connected yet.
- Not visually screenshot-tested in the logged-in app (same standing reason as Live Dispatch -- won't submit the autofilled login form). Verified instead by replicating the exact queue-filter logic against the live API from outside the app and confirming it produces the right real jobs.
- Tracker: 4 of 5 Jobs-tab pages now real (Jobs, Schedule, Live Dispatch, Job Setup & Readiness). Only T&M/Service Lane remains fully mock -- needs its own scoping conversation (does HiveLogic run T&M work today, and how) before building, same reasoning as this page had until today.

## 2026-07-21 (yet later) — Chris via Cowork (this session)
- Audited the Schedule page's 6 unaudited lens tabs (Operations/Materials/Money/Assets/Compliance/Company) for live-vs-mock, since the tracker had these flagged as unaudited after the dispatch-alerts and Live Dispatch shipments.
- Finding: Ops, Materials, Money, Compliance, and Company lenses are 100% fabricated with zero backend and, worse, NO honest disclaimer — specific fake dollar figures (payroll -$74,000, quarterly taxes -$38,000, a vendor bill -$18,400), fake dates, a fake vendor insurance countdown ("Joe The Plumber COI expires in 11 days"), and an elaborate fake "Reina reworked the week overnight" narrative with invented percentages (87% booked) were all presented with no indication they are illustrative. This is a bigger Law-1 violation than anything caught so far this session — someone skimming the app could mistake these for real numbers.
- People and Assets lenses were left alone: both already have a real, honestly-labeled section (real crew assignments from Jobber; real fleet GPS, 11/61 techs linked) sitting alongside some still-mock content — didn't want to slap a blanket "not live" label over content that IS live.
- Fix shipped (commit 63446bc): added the same "Design reference (illustrative names/values) — not yet wired to real data" disclaimer already used elsewhere in the app (leads section) to the top of all 5 fully-fake lenses, in a visible amber banner. This does not build any new backend — it is a pure honesty fix so nobody mistakes invented numbers for real ones. Building real Materials/Money/Compliance data is a much bigger lift (procurement tracking, cash-flow forecasting, insurance/license tracking) that needs its own scoping conversation with Chris, same as Job Setup & Readiness and T&M.
- Verified: git diff showed exactly 5 clean insertions in the expected spots, no other lines touched.
- Note: two more concurrent pushes landed from other sessions during this work (Field App: per-job wrap-up reports, and Field App: real sign-in screen + clock gate) — both clean fast-forwards, no conflicts, exactly the multi-human branch protocol working as intended.

## 2026-07-21 (still later) — Chris via Cowork (this session)
- Shipped: Live Dispatch page — was 100% fabricated demo (fake CSS-grid "map" with fixed pins, one hardcoded "Reina Alert" about Alex/Sunny Acres, 3 hardcoded tech rows). Replaced with:
  - Real embedded Leaflet map (id=ldx-map) plotting real job pins from resource=maplocations (points[], real geocoded Jobber addresses) plus a real HQ marker, and real tech/vehicle GPS pins from resource=crew_schedule (crews[].vehicle.lat/lng).
  - Real crew status list (id=ldx-tech-list) built from crews[].name / vehicle.status / current visit title, plus a real unassigned-visit count.
  - Real dispatch alert box (id=ldx-alert-text) reusing the resource=dispatch_alerts endpoint built earlier this session for the Schedule page — shows the top real alert + count of remaining, or an honest "nothing needs a decision" state.
  - "Customer tracking" demo block deliberately left untouched/out of scope (separate customer-facing feature, needs its own backend).
- Verified: node --check on extracted iframe JS, script tag balance (100/100), git diff --stat (119 insertions/67 deletions, single file), live API field-shape check against the 3 real endpoints before writing any parsing code (no guessed field names), and confirmed the pushed commit (2fb2a5b) is live on the Vercel deployment (fetched the deployed HTML directly, found the new markers/functions present).
- Not visually screenshot-tested inside the logged-in app this session — the HiveLogic login form had autofilled credentials waiting, and per the standing rule Claude does not submit passwords/click Sign In even when a field is pre-filled by the browser. Worth a 30-second glance from Chris on the Live Dispatch tab to confirm the map renders as expected.
- Tracker update: 3 of 5 Jobs-tab pages now have real backends (Jobs, Schedule, Live Dispatch). Job Setup & Readiness and T&M/Service Lane remain the only fully-mock pages left — both need a real conversation with Chris before building (Setup & Readiness turned out to be a multi-gate checklist system, not a simple flag; T&M needs a tickets data model from scratch).

## 2026-07-21 (even later) — Chris via Cowork (this session)
- Shipped: Schedule page's "Dispatch intelligence" card — was 100% fabricated ("Gerry frees up at 11:15" etc, zero backend). Replaced with real gap/overlap/behind-schedule/unassigned detection computed from real synced visit times (api/track1.js resource=dispatch_alerts). Verified live.
- Note: live data surfaced a "GH Technician" account tagged on many visits — producing overlap alerts that may just be a shared/placeholder Jobber user, not a real double-booked person. Flagged on the jobs-tab-tracker artifact, not fixed — needs Chris's call on how that account is actually used before tuning it out.
- Noticed in passing: another session shipped Client Portal work (aa60d6f, 968231a) between this session's commits — normal fast-forward, no conflict, exactly what the multi-human branch protocol is for.
- Open/next: Schedule page has 6 more lens tabs (Operations/Materials/Money/Assets/Compliance/Company) not yet audited for live-vs-mock. Job Setup & Readiness and T&M/Service Lane still 0% real (see jobs-tab-tracker artifact for the full picture).

## 2026-07-21 (later still) — Chris via Cowork (this session)
- Branch: feature/job-workflow-live, then main (both pushed to origin/main)
- Context: Chris asked to make the Jobs sidebar tab live, page by page.
  Ran a ground-truth audit first (persisted as the "jobs-tab-tracker"
  Cowork artifact) — of the 5 pages (Jobs, Schedule, Job Setup &
  Readiness, T&M/Service Lane, Live Dispatch), Jobs and Schedule were
  partially real, the other 3 were 100% static mockup. Started with Jobs.
- Shipped: the Jobs production board's 8 columns were fictional (Jobber
  sync has no "awaiting deposit"/"waiting on materials" concept — only 7
  unrelated statuses). Chris chose to build the real workflow rather than
  fake the columns or leave them mock. Added `job_workflow` table
  (`sql/014_job_workflow.sql` — deposit paid/amount, setup complete,
  materials status/eta, on-hold + reason, all staff-set, run live in
  Supabase already) and two endpoints in `api/track1.js`
  (`resource=job_workflow_list` / `job_workflow_set`, fetch-then-upsert so
  a repeated boolean toggle doesn't reset an already-real timestamp).
- Shipped: `api/jobs.js` now supports `?status=active` (real Jobber
  status ≠ archived) and joins a real client name onto each job
  (`fetchAllClientNames()`, same fetch-whole-table-and-join pattern as the
  existing location join) — verified live: 76 active jobs, all 76 with a
  resolved client name.
- Shipped: `public/index.html`'s Jobs board (`#jv-pipe`) is now rendered
  live — real jobs bucketed into 7 columns (Awaiting Deposit / Awaiting
  Job Setup / Waiting for Materials / Scheduled-In Progress / Requires
  Invoicing [Jobber] / On Hold / Archived [Jobber]) by a pure function of
  real Jobber status + job_workflow flags (`jwbBucket()` — no score or
  stage ever guessed, Law 1). Real HTML5 drag-and-drop between the 4
  manual columns POSTs the matching flag set to `job_workflow_set` and
  re-renders. KPI tiles (active pipeline value, active job count, awaiting
  deposit, on hold) are computed from the same real data. Removed the old
  hardcoded "WE'VE SEEN THIS" fabricated insight tile that sat right above
  it — didn't want a fake specific-dollar claim next to a newly-real board.
- Verified: both new endpoints round-tripped live (write-then-read
  confirmed, test row cleaned up after), `/api/jobs?status=active` spot
  checked live, `node --check` on the extracted JS block, a 9-case unit
  test of the bucket function, script-tag balance (98 open/98 close,
  matches pre-edit baseline), and `git diff --stat` sanity-checked before
  every commit (no surprise deletions).
- Open/next: 4 pages left on the Jobs-tab tracker — Schedule's "Dispatch
  intelligence" card (needs a reasoning backend, not just rewiring), Job
  Setup & Readiness (0% real, needs its own data model), T&M/Service Lane
  (0% real, needs a tickets model), Live Dispatch (0% real on its own
  page, but the real crew/GPS data it needs already exists via
  `resource=crew_schedule` — closest of the three to going live). The
  Jobs board's "Margin list" sub-tab and right-rail cards (Cash position,
  Capacity planning, Operational DNA, Weather, Milestones, Field
  intelligence, Financial commitments) are still static — out of scope
  for this pass, not yet touched.

## 2026-07-21 (later, incident + fix) — Chris via Cowork (this session)
- **Caught mid-session:** a device-bridge read of `public/index.html`
  returned stale/incomplete content (missing the whole Vendor Catalog
  draft-cart feature) even though the reported mtime looked fresh. An
  edit built on that stale read was written back to disk and would have
  deleted ~970 lines of real, already-shipped code if committed.
  **Caught via `git diff --stat` before any commit** — `971 deletions` on
  a card-addition-sized change was the tell. Fixed with `git checkout --
  public/index.html` (safe, nothing was committed yet), then the edit was
  redone on a freshly-verified read (byte count cross-checked against
  `device_list_dir` before trusting the content). **Lesson for any future
  session using the device bridge on this repo:** for `public/index.html`
  specifically, don't trust a staged read at face value — delete the
  local staged copy first, re-stage, and confirm the byte count matches
  `device_list_dir`'s reported size before editing or writing back. (This
  session avoided the device-bridge read of index.html entirely for the
  Jobs board rewire above — did precise anchor-based string splicing via
  `run_project_command`'s node instead, never pulling the 1.8MB file into
  context at all.)
- Shipped: in-app "Team To-Do" card on Command Center — reads a new
  `reina_todo` table via `resource=reina_todo_get`/`reina_todo_set` in
  `api/track1.js` (see `sql/011_reina_todo.sql`, now run live in
  Supabase). Built specifically so Jovie sees the same live to-do list as
  Chris regardless of Claude.ai account, since Claude Projects/artifacts
  don't cross accounts but the app itself does.
- Shipped: "Reina Master To-Do Refresh" scheduled task now runs **hourly**
  (was weekly) and, each run, POSTs the regenerated list to the app via
  `resource=reina_todo_set` in addition to its existing Google
  Doc/Cowork-artifact outputs.

## 2026-07-21 — Chris via Cowork (this session)
- Branch: main-fix (pushed to origin/main)
- Shipped: Vendor Catalog draft-cart feature (build cart before picking a
  job/estimate, checkbox-based Job/Estimate linking, `draft_cart_id`
  schema change + `materials_cart_attach` endpoint) — live, verified via
  real production round-trip test.
- Shipped: Estimate Builder Home Depot fix, Order Tracking honesty fix,
  Price Book merge (earlier same session).
- Shipped: `AGENTS.md` + `claude/branch-coordination-protocol.md` updated
  with rules for multiple humans/machines (Chris + Jovie) and a note on
  the intentional protected-feature-build pattern (HiveSight, HiveConnect,
  Docs — all confirmed merged into this repo as of today).
- Open/next: Jovie not yet added as a GitHub collaborator on
  `csk5369/hivelogic-live`. `hivelogic-expense-control` (Desktop, no git
  remote) confirmed by Chris to be early-stage discussion/mockups only,
  nothing built yet — not urgent.

## 2026-07-30 — Chris via Cowork (phone session)
- Branch: `fix/api-dedupe-fetch-wrapper` → merged to main (`5a85ff9`).
  Shipped: HL_FETCH_DEDUPE_V1 client fetch wrapper (60s GET /api/ cache,
  single-flight, write-invalidation, HL_CACHE_BUST()). Placed top of
  <head> — NOT after the Supabase tag as the task doc said; measured A/B
  showed spec placement missed most dupes (55→53) vs top placement
  (55→45, all 5 profiled dupes collapse to 1). Known leftover: HiveSight
  iframe double-fetches visual-intel mediaSummary (separate window.fetch).
- Branch: `fix/api-jobs-view-join` (this entry written there).
  Root-cause Gate 1: new `public.jobs_enriched` view
  (sql/039_jobs_enriched_view.sql, APPLIED LIVE to Supabase) joins client
  name + geocoded location onto jobs in the DB. api/jobs.js rewritten to
  query it — was ~19 PostgREST round-trips per /api/jobs call (full
  clients + client_locations table re-pagination on EVERY hit, even
  ?id=), now exactly 1. Response shapes byte-identical (name-derivation
  parity SQL-checked across all 2,740 jobs: 0 mismatches; shape locked by
  test/jobs-view-shape.test.mjs). View is security_invoker + revoked from
  anon/authenticated so it does NOT reopen the P0 anonymous-PII hole.
- Not done (flagged, needs per-consumer review): unifying the frontend's
  distinct /api/jobs URL shapes (limit=500 vs status=active&limit=1000) —
  the dedupe wrapper already collapses same-URL calls, so the win is
  small; changing shapes changes what those views see. Also untouched:
  api/track1.js server-side micro-cache, Jobs-Needing-Attention QBO stall.
- Also this session, branch `fix/api-snapshot-db-aggregates`: /api/snapshot
  reworked onto new `public.snapshot_aggregates()` SQL function
  (sql/040_snapshot_aggregates_fn.sql, APPLIED LIVE) — was ~15 paginated
  PostgREST requests downloading ~14k rows (all clients/jobs/invoices) per
  call to compute counts+AR in Node, now 1 RPC. Output cross-checked with
  independent SQL (openInvoices 43 / outstanding 323,244.12 / activeClients
  8,633 on 2026-07-30 data; jobsByStatus sums to jobs count). EXECUTE
  revoked from anon/authenticated. Shape locked by
  test/snapshot-rpc-shape.test.mjs.

## 2026-08-04 — Codex — controlled browser Voice transcription draft
- Branch: `codex/reina-controlled-transcription`.
- Replaces only the browser Chrome SpeechRecognition fallback with a user-gesture,
  short (maximum 12-second) recording sent to an authenticated transcription endpoint.
  The app does not retain audio; the transcript enters the existing canonical Voice
  turn path. Native desktop speech is unchanged.
- Requires `OPENAI_API_KEY` and `REINA_VOICE_TRANSCRIPTION_ENABLED=true` in the
  deployment environment. Neither has been set and nothing has been deployed.
- Focused Voice/transcription tests pass. The full suite retains two pre-existing,
  unrelated marketing-test failures: `assumptions-estimates` and
  `marketing-phase7-channel-recalc`.

## 2026-08-04 — Codex — browser recorder compatibility correction draft
- Branch: `codex/reina-recorder-mime`.
- The controlled Voice recorder now selects a browser-supported recording format
  (or its browser default), starts with reliable 250 ms chunks, and maps recorder
  failures honestly as unavailable instead of incorrectly blaming microphone capture.
  No Electron, permission, endpoint, or product-authority behavior changed.
- Focused transcription, host, and client suites: 83/83 passing. Full suite:
  1,238 passing, 2 skipped, with the same unrelated marketing test failures
  (`assumptions-estimates`, `marketing-phase7-channel-recalc`).

## 2026-08-04 — Codex — Voice error visibility draft
- Branch: `codex/reina-voice-error-details`.
- Replaces the generic Voice failure sentence with fixed messages for known recorder
  failures and a bounded internal failure code for unrecognized Voice failures.
  The panel remains open and typed Reina remains usable.
- Focused host and controlled-transcription tests: 42/42 passing.

## 2026-08-04 — Codex — controlled Voice error-map correction draft
- Branch: `codex/reina-controlled-error-map`.
- Preserves controlled-recorder error codes (`unavailable`, `no-microphone`,
  and `device-busy`) through the browser recognition adapter rather than
  collapsing them into the unrelated `recognition-error` fallback.
- Focused browser adapter, bridge, recorder, and host suites: 100/100 passing.
# 2026-08-04 — Codex — explicit browser microphone constraints draft

- Branch `codex/reina-recorder-constraints` changes only `public/reina-controlled-transcription.js` and its focused test.
- The live browser path now calls `getUserMedia({ audio: true })` instead of making an invalid zero-argument call; the controlled recorder still retains MIME selection and 250 ms chunks.
- Focused Voice verification: 101/101 passing; syntax and whitespace checks pass.

## 2026-08-05 — Codex — AI Council simple-question and attachment preview

- Branch: `codex/hivelogic-ai-council` (PR #120).
- Replaced the required evidence/source form with a single question box, optional
  drag-and-drop attachments, and one Ask button. Budget and HiveBridge controls
  remain available under a collapsed advanced section.
- Added read-only JPEG/PNG, PDF, and text attachment handling for Claude,
  ChatGPT, and Grok. Server validation enforces signatures, three-file and size
  ceilings; persistent audit storage keeps attachment metadata only.
- xAI PDF uploads expire after one hour and are deleted after use; its internal
  attachment search is turn-bounded and exact billed cost is read from usage.
- Focused Council verification: 28/28 passing; whitespace checks pass.
## 2026-08-05 - Codex - Reina conversation and concise Voice replies draft

- Branch: `codex/reina-conversation-voice-basics`.
- Synthetic pilot greetings such as "Hi Reina" now receive a normal, read-only
  introduction instead of an unsupported-question refusal. No live source, tool,
  business action, or data authority was enabled.
- Voice retains the complete evidence envelope in the written conversation, but
  speaks only the server-authored answer. This prevents text-to-speech from
  reciting the entire evidence, freshness, missing-information, and audit report.
- Focused composer/client suite: 49/49 passing. The full repository runner is
  blocked in this worktree by missing `@anthropic-ai/sdk` and includes two
  pre-existing Voice timing failures; neither failure is in this slice.

## 2026-08-05 - Codex - panel-scoped Hands-free Reina draft

- Branch: `codex/reina-handsfree-mode`.
- The explicit `Enable Hands-free` control is a visible consent boundary. While
  the purple Reina panel remains open, voice transcripts must begin with
  `Hey Reina`; background speech is ignored and the words after the wake phrase
  enter the existing canonical Voice turn path. Closing the panel, Stop Voice,
  or Emergency OFF ends hands-free mode.
- The change does not create a system-wide background listener, does not change
  Electron, and does not add live data or business-action authority.
- Focused host/session tests: 79/79 passing.

## 2026-08-05 - Codex - concise Reina conversation presentation draft

- Branch: `codex/reina-voice-natural-replies`.
- Voice responses now lead with the concise server-authored answer rather than
  rendering the full audit envelope as conversational prose. Typed responses
  show the same concise answer first and place evidence, freshness, missing
  information, uncertainty, and the no-action statement in a collapsed native
  `Evidence & details` disclosure.
- The synthetic attention answer is rewritten as a short operational brief;
  the underlying synthetic evidence and read-only boundary remain unchanged.
- Focused composer, client, and host suite: 88/88 passing.

## 2026-08-05 - Codex - persistent top-bar Reina Voice draft

- Branch: `codex/reina-persistent-handsfree`.
- Moves the user-controlled Reina Voice On/Off switch into the existing header beside Settings. A trusted click starts or stops hands-free listening while the HiveLogic page remains open; closing the purple panel no longer stops voice.
- The panel opens only when a wake-phrase request needs to be shown. Listening re-arms after completed playback and local no-speech or timeout conditions, but never automatically retries provider, authentication, or capture failures.
- Focused Reina pilot-host suite: 41/41 passing. Existing in-app Voice-host suite has one pre-existing stale-recognizer timing failure unrelated to these files.

## 2026-08-05 - Codex - end-of-speech Voice response draft

- Branch: `codex/reina-persistent-handsfree`, rebased on current main.
- The controlled browser recorder now detects audio activity locally and stops a recorded turn after a short silence (850 ms), rather than waiting for the long maximum duration. It also ends a silent attempt after 3.5 seconds; the existing maximum duration remains the bounded fallback when browser audio analysis is unavailable.
- Microphone constraints, recording format selection, authenticated transcription, the existing panel, and read-only policy are unchanged. Focused controlled-transcription test suite: 12/12 passing.

## 2026-08-05 - Codex - automatic sign-in Hands-free draft

- Branch: `codex/reina-persistent-handsfree`.
- After a signed-in greeting, Reina now starts hands-free listening automatically when the browser reports a previously granted microphone permission. A first-time or denied browser permission remains opt-in through the existing top-bar Reina Voice control.
- The sign-in attention summary now closes with “Let me know where you'd like to start.” Focused pilot-host suite: 43/43 passing.

## 2026-08-15 -- Claude -- Schedule tab: MapLibre map, period filter, live trucks, view-state persistence

- Branch `claude/schedule-tab-repairs-f6nbke` off `origin/main` `da37b57`. PR #222 (draft,
  NOT merged -- Chris merges). Preview:
  https://hivelogic-live-git-claude-schedu-7b9a7d-chris-projects-bc5d8fbb.vercel.app
- **The Schedule tab had no map before this.** It pointed users at Command Center. So the map
  was built new rather than repaired, which kept CC's Leaflet map out of the blast radius
  entirely -- there was no Leaflet Schedule map to swap.
- **GPS finding worth knowing:** `vehicles.gps_updated_at` (Jobber's own GPS) is STILL frozen
  at 2026-07-28 on all 10 vehicles -- 18 days stale. The fleet feed is live anyway via the
  `fleetsharp_*` columns (newest fix 1 min old at check time), and `api/track1.js:2646-2653`
  already serves whichever feed is fresher, so `resource=crew_schedule` has been live all
  along. If anyone is expecting the *Jobber* GPS link to be back: it isn't. Separate look at
  `sync-extended.js`'s vehicle sync warranted; untouched here.
- Shipped: one debounced localStorage blob (`hl_schedule_view_state`) for durable view state
  only -- `CAL.date` deliberately excluded so nobody returns to a board parked on last week;
  job pins filtered to the calendar's visible Day/Week/Month period out of the
  `schedule_range` rows already fetched (no second request); a 60s `crew_schedule` vehicle
  poll that moves markers in place and greys/labels any fix older than 30 min instead of
  showing it as current; MapLibre GL 4.7.1 with NavigationControl zoom+compass and a custom
  0-70 degree tilt slider, over a keyless OSM raster style.
- CC guardrail: its `loadMapLive()` resolves header/footer with
  `document.querySelector('.map-head')` / `('.map-foot')` -- first match in document order --
  so the Schedule card uses `.smap-head` / `.smap-foot`. A test asserts the Schedule block
  never references `_ccLeafletMap`, `_ccJobsLayer`, `_ccTechsLayer`, `_ccMapViewMode`,
  `ccBundleFetch`, or any Leaflet constructor.
- Verification: 14 new tests in `test/schedule-map-view-state.test.mjs` (functions extracted
  from the shipped index.html into a vm sandbox). Full suite 1537 pass / 8 fail, all 8
  pre-existing on `main` at `da37b57`. **The MapLibre rendering itself has NOT been visually
  verified** -- no browser in that session. REPORT.md carries the browser checklist.
- Ready to scope, not started: bringing Command Center's map to the same standard.

## 2026-08-15 -- Claude -- Schedule work REBUILT in /schedule-board/ (the visible board)

- Same branch `claude/schedule-tab-repairs-f6nbke`, PR #222 (draft, NOT merged).
- **Read this before touching the Schedule tab.** `#view-schedule`'s inline board is NOT
  what users see. `#crewboard-frame` loads `public/schedule-board/index.html` and is ON by
  default (`hl_crewboard !== '0'`), injecting
  `#view-schedule > *:not(#crewboard-frame){display:none!important}`. Anything added to the
  inline board lands in a hidden subtree. `?crewboard=0` reveals it. The first pass of this
  task was built there before that was discovered -- kept, not reverted, and live under the
  flag.
- Rebuilt all four items in `public/schedule-board/app.js`:
  durable `localStorage['hl_board_view_state']` (view/filters/role/panels/lenses/hidden/map
  period/camera; NOT `state.date`); map filtered to Day or Week with a real bug fixed --
  `mbAddJobs()` only ever ADDED markers, so the map accumulated every day you navigated
  through; real vehicle GPS replacing `truckPos()`'s interpolation-on-a-play-clock; and a
  keyless MapLibre fallback so the map always renders.
- **Correction for anyone who read the earlier entry or REPORT.md:** the board's map does NOT
  require each user to supply a Mapbox token. A shared `pk.` token is baked into
  `schedule-board/index.html:11`. The hazard is that one token failing (expiry / quota / URL
  restriction not covering a preview host) -- and `map.on('error')` used to answer that by
  removing the map and nulling the store, i.e. an empty container with no message.
- Trucks were simulated: `truckPos(id, state.mapClock)` interpolated along the day's stops.
  Now real, from `resource=crew_schedule`, 60s poll. Crews without a vehicle or a fix are
  drawn NOT AT ALL rather than parked at the shop; fixes >30 min are greyed and labelled.
- `vehicles.gps_updated_at` still frozen at 2026-07-28; `fleetsharp_*` is what's live.
- 28 tests in `test/schedule-board-map-state.test.mjs`. Full suite 1570 pass / 8 fail, all 8
  pre-existing on `main`. **Nothing visually verified** -- no browser in the session.

## 2026-08-16 -- Codex -- machine-enforced hard completion gate

- Branch `feature/hard-completion-gate` from `origin/main` `f355cae`.
- Completion is no longer an agent-authored label. Boardroom discussions now
  report `NOT DONE`; a workroom task can enter `done` only with a receipt for
  the exact source revision and production URL backed by passing diff, full
  regression, crawler, preview, independent-review, and deployment evidence.
- Postgres enforces the gate, makes receipts immutable, reopens completed work
  when evidence/specification/ownership changes, and uses a monotonic evidence
  sequence so a later failure always wins. Browser sessions are read-only on
  the ledger; only the trusted server may write evidence or completion state.
- Added a GitHub full-regression workflow for every PR and main push, plus the
  same rule in `AGENTS.md` for Codex, Claude, and other repository agents.
- Verification so far: JavaScript syntax and diff checks passed; 1,820 tests
  passed with 0 failures (2 deliberately skipped); the migration parsed on the
  linked Supabase database inside a rolled-back transaction; adversarial SQL
  proved valid certification, tamper rejection, later-evidence revocation, and
  failed recertification. The first Linux CI run exposed a pre-existing
  Windows-only CRLF assumption in a marketing regression test; that portability
  defect was corrected rather than waived. Production deployment remains `NOT DONE` until PR,
  CI, preview, migration, and live verification all pass.

## 2026-08-17 -- Codex -- security/config remediation pass

- Branch `codex/dev-todo-remediation-20260817`; no commit, push, merge, or
  deployment was performed in this security workstream.
- Confirmed the Jobber cron routes are header-secret gated and fail closed,
  and `/api/documents` requires a signed-in user before AI classification.
  Added focused auth coverage. Removed credential length/prefix disclosure
  from Microsoft Mail and Gusto diagnostics; Microsoft diagnostics now require
  an authenticated user.
- Added dual-reader AES-256-GCM token envelopes with active/previous key
  rotation support. The compatibility release keeps writes on deployed
  `enc:v1` by default and enables key-addressable `enc:v2` only through a later
  explicit flag, after every live/rollback revision can read it. Production
  secret writes fail closed without a valid `TOKEN_ENC_KEY`;
  `docs/SECURITY_OPERATIONS.md` records the expand/contract rollout, backup,
  and rotation sequence.
- Removed committed workflow/video credential values from the current tree.
  Those credentials still require external rotation because Git history and
  old deployments remain compromised. The LiveKit Vault migration is staged
  but intentionally unapplied until replacement credentials exist.
- Applied live, reversible Supabase migrations
  `hiveconnect_function_privilege_hardening_20260817` and
  `hivedoc_function_privilege_hardening_20260817`. Post-apply checks found no
  PUBLIC execute grants or search-path mismatches; HiveConnect preserves only
  five intentional anonymous token RPCs, while HiveDoc preserves only its
  three authenticated RLS helpers. Advisors now report those intentional
  application surfaces, non-relocatable `pg_net` in public, and the external
  leaked-password toggle.
- HiveSight source is not present in this repository or the accessible repo
  inventory, so its generated-artifact auth patch remains source-owner debt.
  DigitalOcean firewall changes and all three Supabase leaked-password toggles
  require owner/infra access; the repo runbook contains the exact safe steps.
- Focused security suite: 79 passed, 0 failed. The shared full suite at the
  time of the audit was 2,320 passed, 4 failed, 2 skipped; the four failures
  were in concurrently edited page routing/build-marker/Daily Brief tests, not
  security files. `git diff --check` passed.

## 2026-08-17 -- Codex -- full Dev To-Do remediation completion

- Branch `codex/dev-todo-remediation-20260817`, rebased on `origin/main`
  at `cd4b080` (including MapLibre, real Leads, Company Setup, HiveConnect
  Email triage/actions, and the schedule-board touch browser coverage).
  The remediation remains isolated from `main` and production until its release
  gate passes.
- Completed the security, data-integrity, routing, performance, truthful-UI,
  mock isolation, status-document, migration-ledger, and safe branch/worktree
  audit requested in the 2026-08-17 Dev To-Do. In particular, authenticated
  endpoints fail closed, signed-out pages make no app API requests, Command
  Center uses one view/session-gated poll lifecycle, URL history/deep links are
  canonical, AR and Documents use the corrected contracts, Documents is
  paginated and honest about page-local search, and preserved prototypes are
  hidden from ordinary production navigation and clearly labelled.
- Applied and verified live database migrations: HiveConnect and HiveDoc
  function-privilege hardening; HiveLogic
  `20260817221814_ar_balance_discount_aware.sql`,
  `20260817221820_documents_storage_rls.sql`, and forward repair
  `20260817222303_documents_storage_private_cleanup_helper.sql`. The migration
  ledgers preserve the actually applied history.
- Real Chromium cold-logged-out verification observed zero `/api/` requests;
  HiveSight stayed unloaded, Phone stayed unbooted, and hidden accounting views
  stayed unmounted. Final full regression after the rebase: **2,533 passed, 0
  failed, 2 skipped**.
  Focused final auth/routing/UI regression: **62/62 passed**. Dependency audit:
  **0 vulnerabilities**. Page build `e26179fc4108898e` is synchronized across
  the page, server check, and 39 shipped assets.
- Release preflight found preview and production share live credential rows.
  The branch therefore uses an expand/contract envelope rollout: this first
  release reads both `enc:v1` and `enc:v2` but keeps all writes on `enc:v1`,
  which the current production and rollback code can decrypt. Focused security
  coverage is 24/24, including a compatibility reader copied from the deployed
  revision. Do not set `TOKEN_ENC_WRITE_VERSION=v2` during this release or
  rotate `TOKEN_ENC_KEY` at the same time.
- Production rollout remains blocked on external security actions: rotate and
  environment-split the exposed test-workflow secret; rotate the exposed
  LiveKit signing credentials before applying the
  staged Vault migration; enable leaked-password protection on all three
  Supabase projects; apply the DigitalOcean firewall/UFW rules from a confirmed
  owner IP; reconcile real QBO/Jobber accounts; provide a canonical field-user
  mapping/test assignment; and run signed-in production Documents and field-app
  acceptance checks. No test data or external account state was fabricated.
- Branch/worktree cleanup was deliberately narrow: verified the eight old
  Phase 6 fact slices are all represented by consolidation commit `9e93230`
  already in `origin/main`, confirmed the full suite green, then removed those
  redundant refs plus three already-merged Phase 6 integration/rationale refs.
  `git worktree prune --dry-run` found no broken metadata; no active or dirty
  worktree and no remote branch was deleted.
