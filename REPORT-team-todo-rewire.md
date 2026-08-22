# Team To-Do — operational rewire (v2, supersedes v1)

**Branch:** `claude/team-todo-rewire-v2-fmxmco` (cut from `origin/main` @ `ced23ed`)
**Git identity:** `c_kendall@icloud.com` / `csk5369`
**Files changed:** `api/hiveconnect-bridge.js`, `api/track1.js`, `public/index.html`,
`test/team-todo-bridge-tasks.test.mjs` (new), `test/team-todo-detections.test.mjs` (new),
`test/team-todo-frontend.test.mjs` (new), `test/command-center-session-race.test.mjs`,
`test/command-center-layout.test.mjs`, and this file
**Merge policy honoured:** nothing merged to `main`; PR opened as a draft for Chris.
**Production SQL:** none written, none needed — confirmed against both live databases (below).

---

## Status, stated plainly

**Every path in this change has now run against live data, including the write.**
Chris exercised the card on the preview deployment on 2026-08-16: it rendered
(screenshots in the PR thread), and the completion round trip was verified in
HiveConnect's own database — see *Verified live: the completion round trip*
below. Two things remain unclicked (`＋ TASK` routing and the Dev To-Do view;
both render, neither was followed to its destination), and this session still
cannot reach `*.vercel.app` itself — the egress proxy refuses the CONNECT tunnel
with a 403 — so every visual claim here is Chris's screenshots read back, while
every database claim is a query this session ran directly.

## Verified live: the completion round trip

Chris ticked the checkbox on the preview at **2026-08-16 22:44:10 UTC**. Queried
straight out of the HiveConnect project afterwards:

| Field | Value |
|---|---|
| `tasks.status` | `completed` |
| `tasks.completion_date` | `2026-08-16 22:44:10.339+00` |
| `tasks.updated_at` | `2026-08-16 22:44:10.339+00` |
| `task_status_history` | one new row, `not_started` → `completed` |
| `changed_by` | `7564a957-575c-4da2-8e9a-3eb2899aa111` — **Chris's own HiveConnect profile**, not a service identity |
| `note` | `Completed from HiveLogic Command Center` |

The browser console agreed from the other side: `complete-response 200 {"ok":true,
… "historyWritten":true}`, then `complete-ok`, then a reload returning
`tasks_list-response 200 {"tasks":[]}` — the task left the active list. Both
writes landed, in the same shape `public/hiveconnect/tasks.js updateTaskStatus()`
produces. This was the one untested path in the change; it is no longer untested.

### Correction (2026-08-16): a diagnostic error of mine, recorded because it cost time

An earlier tick of the same checkbox appeared to do nothing, and while chasing it
this session repeatedly reported that **"the request never reached the server,"**
citing an absence of `/rest/v1/tasks` entries in HiveConnect's edge logs. That
conclusion was wrong. **The log windows queried ran roughly two hours behind
actual time** — the detections payload in the browser console read
`asOf: 2026-08-16T22:44Z` while every log query ended at 20:45 or 21:00 UTC. An
empty stretch of the wrong time range was reported as an absence of traffic. That
sent Chris through an unnecessary hard-reload and a session check that came back
`SESSION: true`, i.e. fine all along.

The real cause of that first non-working tick is **still unknown** and is not
being invented after the fact. The plausible candidates were a stale hour-old tab
and a cross-tab `sb.auth.getSession()` lock; neither was proven. What is certain
is that the run above is clean end to end, and that the silent-failure fix
(commit `c34538c`) is what made it observable at all — the console lines that
settled this (`complete-start`, `complete-response 200`, `complete-ok`) did not
exist before it.

### Correction (2026-08-16, after the preview screenshot)

An earlier revision of this report stated that the vendor-payments row **would**
render "Financial feed offline" for as long as the QBO 401 blackout lasted.
**That is wrong, and the preview disproved it:** the row rendered real
QuickBooks data — **$390,126 across 102 bills, 1 past due window** (screenshot
in the PR). The `integrations` row for `qbo` was refreshed at 17:51 UTC that day
with a token valid for the following hour, so this read path is working. The
401 blackout does not affect `bills_due_range`, or no longer affects it. The
honest-degradation path is still implemented and still tested against a mocked
401 — it simply is not the state production is in. Nothing in the code changed
as a result of this correction; only this report was wrong.

---

## What changed

### Separation rule, enforced in code
- Today's Decisions = approval / yes-no. Team To-Do = execution.
- Every Source B detection is tagged `category: 'execution'` server-side, and
  the card's `teamTodoDedupe()` **drops anything that isn't**. Exact
  entity-level de-dupe (`entityType` + `entityId`) runs first and is wired up,
  but today's `resource=dailybrief` payload exposes no entity ids, so in v1 it
  is the category rule that does the work — exactly the fallback the task
  specified. `window.HL_TODAY_DECISIONS` is now published by the Decisions
  widget so the match can tighten later without re-plumbing.
- Reina no longer pushes anything into Team To-Do. The card does not read
  `reina_todo` at all.

### Source A — HiveConnect Tasks (no new table)
`api/hiveconnect-bridge.js` gained two session-authenticated POST actions on
the existing consolidated route (no new Vercel function):

| Action | Does |
|---|---|
| `?action=tasks_list` | Reads `tasks` from the HiveConnect project (service key, server-side only) where `status not in (completed, cancelled, draft)`, resolving owner display names across all three owner shapes (profile / channel / contact). Returns title, owner label + initials, due date, priority, tag. |
| `?action=task_complete` | Patches `status='completed'` + `completion_date` + `updated_at`, then appends a `task_status_history` row with `from_status`, `to_status`, and `changed_by` = the caller's own HiveConnect profile id from `hiveconnect_account_map`. |

The write is a byte-for-byte match of what `public/hiveconnect/tasks.js`
`updateTaskStatus()` does, so a completion from the Command Center is
indistinguishable from one made inside HiveConnect. That is the **only** write
this feature makes: no create, no reopen, no delete, and nothing that touches
Jobber (a test asserts the whole task section of the bridge contains exactly
one PATCH and one POST).

### Source B — computed detections (`/api/track1?resource=team_todo_detections`)
Read-only, stored nowhere, each row carrying an icon, a count/amount and a deep
link:

| Row | Source | Deep link |
|---|---|---|
| Emails awaiting reply | Microsoft Graph inbox, unread and older than **4 business hours** (Mon–Fri 08:00–17:00 America/New_York, walked backwards over nights and weekends) | HiveConnect email tab |
| Estimates to finalize | Jobber-mirrored `quotes` where `quote_status = 'draft'` — read-only, never written back to Jobber | Estimates tab |
| Vendor payments due | QuickBooks `bills_due_range`, balance > 0, due within 7 days or past due within the last 90 days | Financial tab |

Honest degradation is the load-bearing behaviour: a dead source renders a
**muted row carrying the real reason** — never hidden, never a stale number
shown as fresh, never a fabricated one. A QBO 401 specifically renders
`Financial feed offline — Vendor payments unavailable (QuickBooks returned
401).` That path is implemented and tested against a mocked 401, but it is
**not** the state production was in when this shipped — the row returned real
data on the preview (see the correction above). The 401 itself was not touched,
per the task.

Role behaviour is inherited from policy that already exists rather than
invented: the mailbox row is admin-only (matching `resource=notifications`),
and the vendor-payments row is owner/office_ar/admin only (matching
`FINANCIAL_RESOURCES`). A role without access sees an honest unavailable row,
and no financial or mailbox read is issued for them at all.

### Frontend (Command Center card)
- Two sections: **Tasks** (checkboxes, write back to HiveConnect) and **Needs
  attention** (tappable rows).
- **＋ TASK** routes to HiveConnect's own Tasks tab and lands in its
  quick-create input (`hlRoloHC('tasks')` → `#tsk-new-title`). No form rebuilt
  on the HiveLogic side.
- Empty state: `Nothing queued right now.`
- Boot deferred to `DOMContentLoaded` and wrapped in `hlRequireSession()`, plus
  a re-load on `hl:signed-in` — the known cold-login auth race.
- Periodic refresh moved off a private `setInterval` and onto the shared
  `ccRunIfStale('teamTodo', teamTodoLoad, 30000)` guard with the other widgets.
- Card id renamed `reina-todo-panel` → `team-todo-panel`; GridStack id
  (`cc-todo`), position, size and label are unchanged.

### Removed source — Reina engineering feed
- `reina_todo` table and the `reina_todo_set` hourly push are **untouched** and
  still running (verified: last write today 16:24 UTC, 8 sections).
- New admin-only **Dev To-Do** view (`showView('devtodo')`, nav item under
  Manager's) renders it read-only. `resource=reina_todo_get` is now gated
  server-side to admin / superadmin / owner, so the view fails closed even if
  someone unhides the nav item by hand.

---

## Verified live (real data, read-only queries against production)

| Check | Result |
|---|---|
| HiveConnect `tasks` exists with the columns the bridge selects | ✅ |
| Active tasks the card will show | 1: *"Allan/Hire Inhouse app developer"*, owner **Allan Amit**, due 2026-07-27 (renders overdue), priority high |
| `task_status_history` columns (`task_id, from_status, to_status, changed_by, note`) | ✅ all present — the completion write needs no schema change |
| HiveConnect `profiles.display_name/username`, `channels.name`, `contacts.name` | ✅ all present |
| HiveLogic draft quotes (the Estimates row) | **9 drafts, $180,468.68** — the row will show real, non-zero work |
| `reina_todo` still fed by the hourly push | ✅ `source='hourly-scheduled-refresh'`, `generated_at` 2026-08-16 16:24 UTC, 8 sections |
| **No schema change required anywhere** | ✅ confirmed against both projects |

### Tests
- `npm test`: **1932 pass / 7 fail**. All 7 failures are pre-existing on `main` —
  verified by stashing this branch's changes and re-running the same 7 files on
  a clean tree, where they fail identically (`ad-campaign-drafts`,
  `ad-campaign-launch`, `ad-campaign-pause`, `ad-connections`, `ad-spend-sync`,
  `chat-business-data-filter`, `marketing-auth-gate`). Nothing in this change
  touches them.
- **43 new tests**, all passing:
  - `team-todo-bridge-tasks` (11): 401 for an unauthenticated caller on both
    actions; active-only filter; owner initials; the completion round trip
    writes **both** the status patch and the history row with the caller's own
    `changed_by`; a history failure is reported rather than swallowed; unmapped
    caller, malformed id, missing task and already-completed cases; and a guard
    that the bridge has no create/reopen/delete path.
  - `team-todo-detections` (18): the business-hours definition (including the
    Monday-morning case, where the cutoff correctly walks back into Friday so
    overnight mail is not counted); 401 unauthenticated; each detection renders;
    **each degrades honestly when its source fails, including a mocked QBO 401
    and a mocked Graph 401**; role gating issues no read at all; one dead source
    never takes the others down; and the new admin gate on `reina_todo_get`.
  - `team-todo-frontend` (14): rendering rules extracted out of the shipped
    `public/index.html` and run in a vm sandbox — both sections, the empty
    state, the muted-with-real-reason unavailable row, the separation rule, XSS
    escaping of titles and ids, and that the card no longer fetches
    `reina_todo_get`.
- Two existing tests were updated to match intended new behaviour, not to make
  red go green: `command-center-session-race` (the Team To-Do assertions now
  target `teamTodoLoad` + `hlRequireSession` + `ccRunIfStale` instead of the
  removed hourly `reina_todo` interval, and a new case covers Dev To-Do), and
  `command-center-layout` (card id rename).

---

## Seen on the preview (2026-08-16, Chris's screenshot)

Read the card top to bottom, everything below rendered from live data:

| Row | Rendered |
|---|---|
| **Tasks** | *"Allan/Hire Inhouse app develop…"* · `AA` · **Jul 27 · overdue** (red) · 🏷 App Developer · high-priority dot — the single active HiveConnect task, with the overdue state correctly flagged |
| Emails awaiting reply | Muted: *"Microsoft 365 is not connected."* — **correct, and verified in the data**: HiveLogic's `integrations` has no `microsoft` row and HiveConnect's `hc_ms_tokens` has **zero** mailboxes. No mailbox is connected in either realm, so there is nothing to count. Connect one and the row starts counting; switching to the per-user `/api/msmail` path would not have helped, since that store is empty too. |
| Estimates to finalize | **9** · "still in draft" — matches the database exactly (9 drafts, $180,468.68) |
| Vendor payments due | **$390,126** · "102 past due · rest due within 7 days" — real QuickBooks data (see the correction at the top of this report) |

Also confirmed visually: the section headers, the `＋ TASK` control, the
"updated just now" stamp, and the card's own scroll frame inside the GridStack
tile — position, size and label unchanged from before the rewire.

**Resolved (Chris's call, 2026-08-16):** the first live render showed 102
past-due bills behind one number, because "past due" originally looked back a
full year. That reads as AP aging, not as a to-do, so the lookback is now
**90 days** (`TEAM_TODO_PAST_DUE_LOOKBACK_DAYS`) and the row names its own
window — "N past due (last 90 days) · rest due within 7 days". Anything older
is an accounting problem for the Financial tab, not a this-week payment run.
The dollar total moves with it, so the figure on the card will be lower than
the $390,126 in the screenshot above.

---

## NOT verified — what still has to happen

1. **`＋ TASK` routing and the Dev To-Do view are unclicked.** Both render; nobody
   has followed either through to its destination. `＋ TASK` should land in
   HiveConnect's Tasks tab with the quick-create box focused; Dev To-Do (left
   nav → Manager's) should show Reina's engineering list read-only, and should
   be invisible to non-admin accounts.
2. **The Graph inbox count is unproven end-to-end**, because no mailbox is
   connected to prove it with. The row's *unavailable* branch is proven; its
   counting branch is not.
3. **The first, non-working completion click was never root-caused** — see the
   diagnostic correction above. The path works now; why it did not that once is
   unexplained, and if it recurs the console will say so this time.
4. **This session still cannot open the preview itself** (`*.vercel.app` → 403 at
   the egress proxy), so every visual claim above is Chris's screenshot read
   back, not something this session observed directly. Database claims are this
   session's own queries.

---

## Deviations from the task, flagged

- **Email source.** The task said to reuse "the existing Microsoft Graph read
  path (HiveConnect email integration)". Two such paths exist: the per-user
  mailbox tokens behind `/api/msmail` (used by HiveConnect's own email tab) and
  the org-mailbox Graph inbox read already living inside `api/track1.js` and
  used by `resource=notifications`. This uses the **latter**, because the
  Command Center card has no way to pick which of a user's connected mailboxes
  it means, and the notifications hub already established the policy (and the
  admin gate) for exactly this "count what's in the inbox" question. Same Graph
  endpoint, same integration, one endpoint instead of two. **Update after the
  preview:** this choice turns out to be moot for now — `hc_ms_tokens` (the
  per-user store) holds zero mailboxes, so the other path would report exactly
  the same "not connected". Revisit once a mailbox is actually connected.
- **`reina_todo_get` is now role-gated.** The task asked for an admin-only Dev
  To-Do view; gating only the nav item would have been cosmetic, so the read
  itself is gated (admin / superadmin / owner-by-permission-role, so Chris is
  covered either way). The unauthenticated `reina_todo_set` push is untouched.
- **Report filename.** Written as `REPORT-team-todo-rewire.md` rather than
  overwriting the root `REPORT.md`, which still carries the Schedule Tab
  Repairs report from PR #222 — matching the existing
  `REPORT-<topic>.md` convention in this repo.
- **Isolated worktree.** This session runs in an ephemeral remote container
  with its own fresh clone of `origin/main`; Chris's
  `hivelogic-live-mainwork` checkout was never visible to it, let alone
  touched.
