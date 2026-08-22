# Morning Handoff — HiveConnect ↔ HiveLogic Merge

Everything that could be done without you is done and tested. Full detail is in
`hiveconnect-merge-progress.md`; this file is just the runbook.

**Deliverables, sent to chat overnight and NOT written into your real `hivelogic-live`
folder** (see progress log for why — short version: your `.bat` scripts push whatever's
checked out straight to production, so this was kept out of your working tree until you've
deliberately branched):

- `overnight-build.zip` — the 9 new/changed files, ready to drop in
- `full-diff.patch` / `patches/0001...0005*.patch` — the same changes as patches
- `feature-embed-hiveconnect.bundle` — a git bundle with the full local commit history

## Step-by-step

**1. Create the branch, apply the work**
```
cd path\to\hivelogic-live
git checkout -b feature/embed-hiveconnect
```
Then either unzip `overnight-build.zip` over the repo (it only contains the 9 changed
files, nothing else) — or, if you want the actual commit history instead of one big diff:
```
git fetch <path-to-bundle> feature/embed-hiveconnect:feature/embed-hiveconnect
```
Review with `git diff` / `git status` before committing anything.

**2. Approve GitHub device-flow auth**
Say the word and this session (or your next one) will start it — you'll get a link + code,
approve in your browser, ~30 seconds.

**3. Push the branch**
```
git add -A
git commit -m "Embed HiveConnect as a native module (Option C auth bridge)"
git push -u origin feature/embed-hiveconnect
```
Confirm your current Vercel plan first if you're not sure — see the function-count risk
note in the progress log (16 API routes after this push; you hit a 12-function limit once
before).

**4. Enter the real secret directly into Vercel**
Project settings → Environment Variables (preview scope only, not production yet):
- `HIVECONNECT_SUPABASE_URL`
- `HIVECONNECT_SUPABASE_SERVICE_KEY`

Never paste these into chat — enter them straight into Vercel's dashboard.

Also run the new migration manually, same as 002–008:
Supabase dashboard → SQL Editor → paste `sql/009_hiveconnect_bridge_mapping.sql` → Run.

**5. Run staging validation, then give final go-live approval**
Once Vercel builds the preview: run through spec §7's test checklist and the 9 scenarios
in §11 against the real preview URL (the mocked versions already pass locally — this is
the real-credentials pass). Come back with results and I'll show before/after screenshots
next to the baseline. Nothing touches production until you approve that in chat.

---
Two things worth 30 seconds of thought before step 3, both explained in the progress log:
the Vercel function-count risk, and the assumption that HiveConnect's own Microsoft Graph
integration is meant to replace HiveLogic's stub Email tab (not compete with it).
