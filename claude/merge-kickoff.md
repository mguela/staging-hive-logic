# HiveConnect → HiveLogic Merge — Kickoff

**Role:** Locked-scope production merge. Precision over speed.
**Task:** Merge the completed HiveConnect app into HiveLogic as a native module.

## Step 0 — Context (before touching anything)
1. Read this file, then `hiveconnect-hivelogic-merge-spec.md`. The spec is a binding contract — if anything Chris says or Claude infers conflicts with it, the spec wins. If the spec is ambiguous, ask Chris.
2. Confirm back the scope: the authorized items to change in HiveLogic, and what will never be touched. **Do not start work until Chris replies exactly "go".**

## Sources
- `Desktop/HiveMerge/hiveconnect-repo.tar[.tar]` — extract, verify git HEAD = `374219b`. That commit is the approved HiveConnect. Use ONLY this source.
- `Desktop/HiveMerge/hivelogic-v64-backup-2026-07-19.html` — reference backup of HiveLogic.
- HiveLogic's live source of truth: `hivelogic-live.vercel.app` (pull fresh, confirm it matches the backup's SHA `d00ba33fee51e1772817f17d499f6f269a8d6124`; tell Chris if it doesn't).

## Hard Rules (non-negotiable)
- **Transplant, not rebuild.** Copy HiveConnect's real code. Never recreate, simplify, redesign, or "improve" anything in either app.
- **HiveLogic stays pixel-identical** except: Comms + Email sidebar entries replaced by one HiveConnect entry in the same position.
- **Do not touch** HiveVideo, Chirp, or Microsoft 365/Graph email internals — minimum wiring only. Users must not need to reconnect email.
- **No iframe, no webview, no redirect** to hiveconnect-test.vercel.app.
- **One visible login** (HiveLogic's). Auth bridge design: present options from spec §5 before implementing — the two apps use SEPARATE Supabase projects, do not assume otherwise.
- **Never work on the production branch.** Branch: `feature/embed-hiveconnect`.
- **The standalone HiveConnect deployment stays live** until Chris verifies the merge.
- **Deploy to a PREVIEW URL only.** Nothing replaces a live site without Chris's explicit approval in chat.

## Approval Gates
| Gate | Trigger | Waits for |
|---|---|---|
| G0 | Step 0 scope confirmation posted | Chris replies exactly "go" |
| G1 | End of Phase 1 (safety setup) | Chris checkpoint review |
| G2 | Auth bridge design | Chris picks an option from spec §5 |
| G3 | End of Phase 4 (preview + full test checklist) | Chris reviews before/after + checklist |
| G4 | Go-live | Chris's explicit approval in chat — nothing else triggers a production swap |

## Order of Work
1. **Safety setup (spec §6):** git init/push both sources to private GitHub (device-flow auth, Chris approves the code), record current prod deployment IDs, baseline screenshots of the HiveLogic Command Center at desktop/laptop/tablet/mobile widths.
2. **Transplant:** HiveConnect as an isolated, CSS-scoped module inside HiveLogic; sidebar swap; hash-route mount; legacy Comms/Email redirects; Command Center "Open Hub" retarget (card itself unchanged).
3. **Auth bridge** (after Chris picks from Claude's options, spec §5).
4. **Preview deploy** + run the FULL test checklist from spec §7. Show: before/after screenshots, checklist results, every HiveLogic file/section modified with a one-line reason each.
5. **Wait for go-live approval (G4).**

## Working Style
- Checkpoint at the end of each numbered phase — short summary, no walls of text. Visual: tables/screenshots over prose.
- If anything unexpected turns up (source mismatch, auth surprise, broken assumption): STOP and tell Chris rather than improvising around it.
- Log progress notes to `hiveconnect-merge-progress.md` as work happens so nothing is lost between sessions.

---
*Authored 2026-07-19 per Chris's explicit instruction to create this file fresh from the kickoff message given in chat — no prior version existed on disk.*
