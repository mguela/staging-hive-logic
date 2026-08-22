# HiveConnect ↔ HiveLogic Merge — Binding Spec

Status: **DRAFT — authored 2026-07-19 from Chris's kickoff message.** Not independently
verified against a prior design doc (none existed on disk). Treat as binding once Chris
confirms it reflects intent; flag anything that looks wrong rather than assuming it's correct.

## §1 Objective
Merge the completed HiveConnect app into HiveLogic as a native module — a transplant of
real HiveConnect code, not a rebuild, redesign, or simplification of either app.

## §2 Sources & Verification
| Source | Role | Verification required |
|---|---|---|
| `HiveMerge/hiveconnect-repo.tar[.tar]` | Only approved HiveConnect source | git HEAD must equal `374219b` |
| `HiveMerge/hivelogic-v64-backup-2026-07-19.html` | Reference backup of HiveLogic | — |
| `hivelogic-live.vercel.app` | Live source of truth for HiveLogic | Must match backup's SHA `d00ba33fee51e1772817f17d499f6f269a8d6124`; report any mismatch instead of proceeding |

Filename discrepancy (archive appears as `hiveconnect-repo.tar` in Explorer, actual name on
disk is `hiveconnect-repo.tar.tar`) is logged as a Phase 1 verification item, not assumed
resolved.

## §3 Authorized Scope — the 10 items HiveLogic changes
1. Remove the "Comms" sidebar entry.
2. Remove the "Email" sidebar entry.
3. Add one "HiveConnect" sidebar entry in that same position.
4. Mount HiveConnect as an isolated, CSS-scoped module inside HiveLogic (namespaced styles — no bleed either direction).
5. Add a hash-route mount point (e.g. `#/hiveconnect`) as HiveConnect's entry point inside HiveLogic.
6. Add legacy redirects: old Comms route → new HiveConnect hash route; old Email route → new HiveConnect hash route.
7. Retarget the Command Center "Open Hub" action to launch the embedded HiveConnect (the card itself — position, size, label, styling — is unchanged).
8. Implement the auth bridge connecting HiveLogic's session to HiveConnect (mechanism chosen from §5 — not decided yet).
9. Minimum-necessary wiring to the existing Microsoft 365/Graph email integration so no user has to reconnect email — no changes to Graph/email internals themselves.
10. Deploy items 1–9 to a **preview URL only**, on branch `feature/embed-hiveconnect` — production untouched, standalone HiveConnect deployment stays live.

Nothing outside this list is in scope. No item here authorizes redesigning, rebuilding, or
"improving" either app's existing functionality.

## §4 Hard Rules (non-negotiable)
- Transplant, not rebuild — copy HiveConnect's real code as-is.
- HiveLogic pixel-identical except the sidebar swap in §3.
- Never touch HiveVideo, Chirp, or Microsoft 365/Graph email internals beyond the minimum wiring in §3.9.
- No iframe, no webview, no redirect to `hiveconnect-test.vercel.app`.
- One visible login only (HiveLogic's).
- Never commit to or deploy from the production branch. Work happens on `feature/embed-hiveconnect`.
- Standalone HiveConnect deployment stays live until Chris verifies the merge.
- Preview URL only — nothing replaces a live site without Chris's explicit chat approval.

## §5 Auth Bridge — Options (draft, awaiting Chris's decision — none of this is implemented)
Constraint: HiveLogic and HiveConnect use **separate Supabase projects**. Only one login
screen may ever be shown (HiveLogic's).

**Option A — Server-side session mint.** After a user authenticates against HiveLogic's
Supabase project, a HiveLogic backend endpoint uses a Supabase service-role credential on
the HiveConnect project to mint a matching HiveConnect session for the same user (matched
by verified email) and hands the token to the embedded module. No second login UI.
Trade-off: HiveLogic's backend now holds a HiveConnect service-role key — a real secret to
manage and rotate.

**Option B — Headless API wiring, no second identity.** Don't create a HiveConnect
Supabase session at all. Render HiveConnect's UI code inside HiveLogic but have it call
HiveConnect's backend APIs using a service-level credential scoped per HiveLogic
organization, with HiveLogic's own session data passed in as props/context. Avoids a second
user identity existing anywhere. Trade-off: only works if HiveConnect's API already
supports being driven this way — needs to be confirmed against the actual HiveConnect code,
not assumed.

**Option C — Just-in-time shadow account + mapping table.** On first visit, HiveLogic
auto-provisions (or links, if one already exists) a matching HiveConnect Supabase account by
email, and stores the `hivelogic_user_id ↔ hiveconnect_user_id` mapping in HiveLogic's own
database. Subsequent visits mint a session server-side (like Option A) using the stored
mapping. Trade-off: more moving parts and an extra data store, but most auditable and
easiest to unwind if the merge is ever reversed.

**SELECTED: Option C** — Chris confirmed 2026-07-19. Options A and B are retained above for
the record but are no longer active candidates.

## §9 Auth Bridge — Implementation Requirements (binding, from Chris, 2026-07-19)
- Mapping keys on **immutable user IDs**, never on email address alone.
- Account creation must be **idempotent** — must never create duplicate HiveConnect users.
- The admin/service-role secret is a **server-side environment variable only** — never in
  the browser, client bundle, repository, logs, screenshots, or error messages.
- **Minimum permissions** required for session creation + account provisioning — nothing broader.
- Log successful and failed mapping attempts **without** logging secrets, tokens, or auth data.
- On provisioning or session-mint failure: show a clear error, **preserve the user's existing
  HiveLogic session** — never fail silently, never drop the user's HiveLogic login.
- The auth bridge is **isolated** from the transplanted HiveConnect application code (separate
  module/files — not interleaved into HiveConnect's own source).
- No changes to Microsoft/Graph email, HiveVideo, or Chirp.
- Nothing outside the 10 items in §3.

## §10 Rollback Plan
Must cover, explicitly:
- The mapping table (how to drop/disable it cleanly).
- The session-mint endpoint (how to disable/remove it).
- The environment variable (how it's removed from the hosting config).
- The provisioning logic (how it's disabled without leaving orphaned HiveConnect accounts
  half-created).
- Confirmation that removing all of the above restores HiveLogic to its exact pre-merge
  state — sidebar included.

## §11 Test Scenarios (binding, from Chris, 2026-07-19)
Required before preview deploy is shown to Chris:
1. Existing mapped user
2. Existing unmapped user
3. Brand-new user
4. Disabled user
5. Duplicate-email condition
6. Expired session
7. Failed provisioning
8. Failed session minting
9. Rollback

No production deploy until: local merge, build, auth tests, integration tests, and this
checklist all pass.

## §6 Safety Setup — Phase 1 (before any code is transplanted)
1. `git init` both sources locally if not already a repo; push to **new private** GitHub
   repos via device-flow auth — Chris approves the device code in the browser.
2. Record current production deployment IDs for both HiveLogic and the standalone
   HiveConnect deployment (rollback reference point).
3. Baseline screenshots of the HiveLogic Command Center at four widths: desktop, laptop,
   tablet, mobile — captured before any change, for the before/after comparison in §7.

## §7 Test Checklist — Phase 4 (preview deploy, before requesting go-live)
- [ ] Sidebar shows exactly one "HiveConnect" entry; "Comms" and "Email" entries are gone.
- [ ] All other sidebar entries pixel-match the Phase 1 baseline.
- [ ] Hash route loads HiveConnect correctly, CSS scoped — no style bleed into HiveLogic or vice versa.
- [ ] Legacy `/comms` and `/email` URLs redirect to the new HiveConnect hash route.
- [ ] Command Center "Open Hub" launches embedded HiveConnect; the card itself is visually unchanged from baseline.
- [ ] HiveVideo smoke test — unaffected.
- [ ] Chirp smoke test — unaffected.
- [ ] Existing Microsoft 365/Graph email connections remain connected — no re-auth prompt for any test user.
- [ ] Only one login screen ever appears (HiveLogic's) — no second Supabase login surfaces anywhere in the flow.
- [ ] Auth-bridged session persists across a page refresh inside the embedded module.
- [ ] Responsive check at desktop/laptop/tablet/mobile matches Phase 1 baseline except for the sidebar swap.
- [ ] Deployment target is a preview URL — production is untouched.
- [ ] Standalone HiveConnect deployment is still live and unaffected.

## §8 Escalation
Any source mismatch, auth surprise, or broken assumption discovered at any phase stops work
immediately — reported in `hiveconnect-merge-progress.md` and in chat — rather than worked
around. See that file for current findings.
