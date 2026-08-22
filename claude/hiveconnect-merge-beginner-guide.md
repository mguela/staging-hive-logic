# HiveConnect Merge — Complete Step-by-Step Guide (No Experience Needed)

This walks through finishing the merge from where last night's work left off. Every step
explains what you're doing and why, not just what to type. Work through it in order —
don't skip ahead.

**Before you start**, find this exact file:

```
Desktop\hivelogic-live\claude\overnight-build-2026-07-19\overnight-build.zip
```

If it's not there, it's also attached in the chat where I first sent it — download it from
there instead. Either copy is the same file.

---

## Step 1 — Open a terminal in the right folder

A "terminal" (also called Command Prompt or PowerShell on Windows) is just a text-based
way to type commands to your computer instead of clicking icons. Everything below happens
inside one.

1. Open the `hivelogic-live` folder on your Desktop in File Explorer.
2. Click into the address bar at the top of the File Explorer window (where it shows the
   folder path), type `cmd`, and press Enter. A black terminal window opens, already
   pointed at that folder — you'll know it's right if the prompt shows `hivelogic-live`
   in the path.

Every command in the rest of this guide gets typed into that same window, one at a time,
pressing Enter after each.

---

## Step 2 — Create a "branch" and load in the finished work

A **branch** is a safe side-copy of your project. Think of it like a duplicate document
you can edit freely without touching the original — nothing on the branch affects your
live site until you deliberately merge it back. This is why last night's work is safe:
it's all sitting ready to go onto a branch, not mixed into your real, live code yet.

Type this and press Enter:
```
git checkout -b feature/embed-hiveconnect
```
You should see a message like `Switched to a new branch 'feature/embed-hiveconnect'`.
That's it working correctly.

Now bring in the finished files:
1. Find `overnight-build.zip` (from last night).
2. Right-click it → **Extract All...** → extract it somewhere temporary, like your
   Desktop.
3. You'll get a folder called `overnight-build` containing a few files and folders
   (`public`, `api`, `sql`, `test`). Open it in one File Explorer window, and your
   `hivelogic-live` folder in another.
4. Copy everything **inside** `overnight-build` and paste it **inside** `hivelogic-live`,
   letting it merge into the existing folders (Windows will ask "replace these files?" —
   say yes, that's expected, it's replacing `public/index.html` with the updated version
   and adding the new files alongside it).

Go back to your terminal and type:
```
git status
```
This shows you every file that changed. You should see `public/index.html` listed as
modified, and several new files like `public/hiveconnect-mount.js`,
`public/hiveconnect/`, `api/hiveconnect-bridge.js`, `sql/009_hiveconnect_bridge_mapping.sql`,
and `test/hiveconnect-bridge.test.mjs`. If that matches, you're in good shape — this is
your chance to look things over before anything is saved permanently.

---

## Step 3 — Let me connect to GitHub (one-time, takes 30 seconds)

Your code needs to go up to GitHub (a website that stores and backs up code) before
Vercel (the service that actually runs your website) can build a preview of it. To do
that, I need to sign in to GitHub through something called "device-flow authentication" —
it's the same style of login as signing into a smart TV app: I'll get a short code, you
type it into a page on GitHub, and you approve it.

Just tell me "start the GitHub login" and I'll give you a link and a code. You'll:
1. Click the link (opens in your browser).
2. Type in the code I give you.
3. Click **Continue**, then **Authorize**.

That's the entire step. Once approved, I can push code on your behalf for the rest of
this session.

---

## Step 4 — Save your changes and send them to GitHub

Back in your terminal, type these two commands, one at a time:

```
git add -A
```
This tells git "include every changed and new file in what I'm about to save." Nothing
happens visibly — that's normal.

```
git commit -m "Embed HiveConnect as a native module (Option C auth bridge)"
```
This actually saves a snapshot of all those changes, with a short note describing what
they are. You'll see a summary listing the files.

Then:
```
git push -u origin feature/embed-hiveconnect
```
This uploads your branch to GitHub. If Step 3 was completed, this should just work and
show some progress output ending in something like `* [new branch] feature/embed-hiveconnect -> feature/embed-hiveconnect`.

**One thing to check first:** you hit a limit before where Vercel only allowed 12
"functions" (small backend programs) on your plan, and you had to consolidate some. This
merge adds one more function, bringing your total to 16. Before you push, take 30 seconds
to check your Vercel plan (Vercel dashboard → your account/plan settings) — if you're
still capped at 12, let me know and I'll fold the new function into an existing file
instead of adding a new one.

---

## Step 5 — Add the real secret password to Vercel

The auth bridge needs a special admin password (called a "service-role key" or "secret")
to talk to HiveConnect's login system on your behalf. This is sensitive — like a master
key — so it should never be typed into a chat message, ever, to me or anyone. It goes
directly into Vercel's settings, where only your project can read it.

1. Go to `vercel.com` and sign in.
2. Open the **hivelogic-live** project.
3. Click **Settings** → **Environment Variables**.
4. Add two new variables (click "Add New" for each):
   - Name: `HIVECONNECT_SUPABASE_URL` — Value: HiveConnect's Supabase project URL (find
     this in your Supabase dashboard, under the HiveConnect project → Settings → API →
     "Project URL").
   - Name: `HIVECONNECT_SUPABASE_SERVICE_KEY` — Value: the "service_role" key from that
     same Supabase API settings page (NOT the "anon" key — the service_role one, further
     down the page, usually behind a "reveal" click since it's sensitive).
5. Set both to apply to **Preview** environments (not Production yet — we're not going
   live until you approve that separately).
6. Click **Save**.

---

## Step 6 — Set up the new database table

The auth bridge needs one new small table to remember which HiveLogic user matches which
HiveConnect account. You add it the same way you've added every other database change in
this project (SQL migrations 002 through 008 were done this exact way):

1. Open the file `sql/009_hiveconnect_bridge_mapping.sql` in Notepad (right-click → Open
   with → Notepad).
2. Select all the text (Ctrl+A) and copy it (Ctrl+C).
3. Go to your Supabase dashboard → the **HiveLogic** project (not HiveConnect — this
   table lives on HiveLogic's side) → **SQL Editor** → **New query**.
4. Paste the text in and click **Run**.
5. You should see a success message, no red error text.

---

## Step 7 — Let Vercel build the preview, then test it

Once your branch is pushed (Step 4), Vercel automatically builds a "preview" version of
your site — a separate, private URL that behaves exactly like production but isn't
public and doesn't affect your real site.

1. Go to `vercel.com/chris-projects-bc5d8fbb/hivelogic-live/deployments`.
2. Find the newest deployment — it'll be tagged with your branch name,
   `feature/embed-hiveconnect`. Wait until it says **Ready** (not "Building" or "Error") —
   usually 30-60 seconds.
3. Click it to open the preview URL.

Now click around and check:
- The sidebar shows one **HiveConnect** entry where Comms and Email used to be.
- Clicking it opens HiveConnect right there, with no second login screen.
- The Command Center's "Comms" card still opens HiveConnect too.
- Nothing else on the page looks different from before.
- Try refreshing the page while HiveConnect is open — it should still be signed in, not
  ask you to log in again.

If anything looks wrong, or you see an error message where HiveConnect should be, take a
screenshot and send it my way — don't try to fix code yourself, just flag it.

---

## Step 8 — Give the final go-ahead

Once you've clicked around the preview and it looks right, tell me. I'll walk through the
full test checklist with you side-by-side with the "before" screenshots from Phase 1, and
only after that's all confirmed good do we talk about actually replacing your live site —
which never happens without you explicitly saying so in this chat.

---

### Quick reference — everything you'll type, in order
```
git checkout -b feature/embed-hiveconnect
(copy the unzipped files into the folder here)
git status
(tell me to start GitHub login, approve it in your browser)
git add -A
git commit -m "Embed HiveConnect as a native module (Option C auth bridge)"
git push -u origin feature/embed-hiveconnect
(add the two secrets in Vercel's website)
(paste sql/009_hiveconnect_bridge_mapping.sql into Supabase's website)
(wait for the Vercel preview, click around and test it)
(tell me how it went)
```
