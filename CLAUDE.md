# HiveLogic — standing rules

Rules that govern every part of this app. They are here because breaking one
is not caught by tests: the code works, and the product is wrong.

---

## Settings follow the USER, not the device

> Chris, 2026-08-23: "as a full HiveLogic Rule, settings changed should follow
> the user not the device. for every part of Hivelogic"

A preference someone sets is a fact about **them**, not about the machine they
happened to be sitting at. Set it on the office desktop and it is set on the
laptop, on the tablet in the truck, and on a browser they have never opened
before. Signing in is what restores it.

**So a setting is stored server-side, keyed by the signed-in user.**
`localStorage` is not where a setting lives.

This is not a style preference. A per-device setting fails in a way nobody
reports, because it never looks broken — it looks like the app forgot, and the
person quietly sets it again. The evidence is the setting being changed twice.

### What this means in practice

- **Write it to the server, keyed by user id.** Read it back on load.
- **`localStorage` is a CACHE, never the record.** Painting last known state
  before the server answers is fine and good — it stops a flash of the wrong
  theme. Treating it as the answer is the bug.
- **Clearing site data must not lose a setting.** That is the test. If it does,
  the setting was on the device.
- **A second browser must show the same settings.** That is the other test.

### The narrow exceptions

Three things are genuinely about the machine, and storing them per-device is
correct:

1. **Hardware selection** — which microphone, which speaker, which camera. The
   devices differ per machine; carrying a choice across would name a device
   that is not there.
2. **Device registration** — a Web Push subscription is a capability to reach
   one browser, not a preference. Note the split this forces and respect it:
   "Desktop notifications off" is a SETTING and follows the user;
   "Forget this computer" is a DEVICE action and does not.
3. **In-flight local drafts** — unsent text still being typed, kept so a
   refresh does not eat it. The moment it is saved it belongs to the user.

If a thing is not one of those three, it follows the user.

### Where it goes

`profiles` is the per-user table. `company_settings`, `voice_settings` and
`workforce_settings` are company-scoped and are NOT the home for a personal
preference — putting one there sets it for everybody.

`reina_notify_rules` is the pattern to copy for anything Reina-shaped: keyed
by `owner_id`, one row per rule, readable and reversible by the person who set
it.

---

## Keep answers to Chris short

> Chris, 2026-08-23: "I can't read these giant long explanations. you need to
> make it a rule to eplaned in the shortest format possible, tell me exactly
> what I need to do and keep it simple."

He reads these on a phone, between jobs. A four-paragraph root-cause writeup
buries the one line that tells him what to do next.

- **Lead with the action.** One line.
- Then the state: done / not done / waiting on him.
- Stop. Detail only when he asks. "Why" is a follow-up question, not a preamble.
- No recap of what was already said. No summary of the summary.
- Never report "not merged" or "not deployed" without saying what to do next.

The long version belongs in the commit message and the PR body. That is what
they are for, and he reads them only when he wants to.

Good:
  Reload the page, then click Sales > Leads.
  Merged and live.

A long answer is not more thorough, it is less usable. If he cannot find the
instruction in it, it did not tell him anything.
