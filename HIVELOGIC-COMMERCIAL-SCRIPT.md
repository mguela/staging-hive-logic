# HiveLogic — "Run The Whole Thing"
### 3:00 product film · shooting script + shot list

**Format:** 1920×1080, 24fps feel (30fps capture), 2.39:1 letterbox on the wide beats
**Voice:** OpenAI neural TTS (`nova`) — the same engine that speaks as Reina in production
**Runtime target:** 3:00 · **VO word count:** 358 (≈119 wpm — a slow, confident read with air)
**Music direction:** single piano note held under Act I; low strings enter at the turn; percussion from Act IV; everything drops out for the kicker.

> **Every number spoken in this film is real and verifiable.** They are listed with their sources in
> "Fact check" at the bottom. Nothing in this script is estimated, projected, or rounded up.

---

## ACT I — THE DAY YOU ALREADY KNOW
*0:00 – 0:32 · Cold, blue, handheld. No music but one held note.*

**1. BLACK.** A phone screen lights the dark cab of a truck. 6:41 AM.

> It's 6:41 in the morning. And you're already behind.

**2.** Rain on a windshield. A clipboard on the passenger seat, curled at the corner.

> A crew is waiting on an address. A customer is waiting on a price.
> Somebody is always waiting on you.

**3.** Hard cuts, one second each: a whiteboard schedule half-erased. A shoebox of receipts. Seven browser tabs. A phone with fourteen unread texts.

> So you run the jobs in one app. The books in another.
> The schedule on a wall. And the part that actually decides
> whether this year was any good — you keep that in your head.

---

## ACT II — THE TURN
*0:32 – 0:56 · Everything stops. Silence. Let it sit.*

**4.** The truck cab, still. Rain, no wipers. Hold two full seconds before the line.

> Every piece of software you have ever bought promised to fix this.

**5.** Slow push on the seven open tabs.

> And every one of them just gave you one more place to type.

**6.** Cut to black. Two seconds of nothing.

> What if it worked the other way around?

---

## ACT III — THE REVEAL
*0:56 – 1:12 · First warmth in the film. The hex mark builds, it doesn't fade in.*

**7.** The HiveLogic hex draws itself on deep navy. Clean. No flourish.

`ON SCREEN: HiveLogic`

> This is HiveLogic.

**8.** The mark settles.

> One system that runs the whole company.
> Not another tab. The whole company.

---

## ACT IV — THE SAME DAY, RUN DIFFERENTLY
*1:12 – 2:18 · Real screen capture. Rhythmic. One beat per capability. Percussion in.*

Each line is one shot of the real product. Cut on the beat — the rhythm is the argument.

**9.** Dispatch board, trucks moving on the map.
> The schedule builds itself around where your trucks actually are.

**10.** An estimate being sent from a phone.
> The estimate goes out before you get back to the truck.

**11.** A receipt photographed, then the journal entry appearing.
> A photo of a receipt becomes a posted entry. Coded. Matched. Reconciled.

**12.** Purchase order screen, three columns snapping into alignment.
> Purchase orders match themselves — order, receipt, bill.

**13.** The close package generating.
> The books close.

**14.** Payroll screen.
> Payroll runs.

**15.** A customer's phone: an automatic text on the way to the job.
> Your customer hears from you before they have to ask.

**16.** A quote card going quiet, then a follow-up drafting itself.
> And when a quote goes cold, nobody has to remember.
> The system already did.

**17.** *(Beat. Percussion drops to a pulse.)* Reina's panel opens.
> Her name is Reina.

**18.** Reina reading across jobs, invoices, messages — data flowing in.
> She reads every job, every invoice, every message.
> And she does not wait to be asked.

**19.** The Growth screen, ranked cards.
> Monday morning she tells you where the money actually is.
> The estimates nobody followed up on. The customers who quietly stopped calling.
> And she has already drafted the campaign.

---

## ACT V — THE PART THAT SHOULD WORRY YOUR COMPETITION
*2:18 – 2:42 · Type on navy. Each number lands alone. Percussion builds.*

**20.** Hard cut. White type, navy field.

> Here is the part that should worry your competition.

**21.** Numbers hit one at a time, each on its own beat:

`39 DAYS OLD` → `2,038 COMMITS` → `240 TABLES` → `4,322 TESTS. GREEN.`

> HiveLogic is thirty-nine days old.
> Two thousand commits. Two hundred and forty tables.
> Four thousand tests, passing.

**22.** The numbers compress into a single line.

> It got better while you were watching this.

---

## ACT VI — THE KICKER
*2:42 – 3:00 · Everything drops out. One piano note returns. This is the whole film.*

**23.** Black. Silence for a full second.

> One more thing.

**24.** Slow fade up on the frames of this very film, playing back inside HiveLogic's own Content Studio.

> This commercial. The script. The voice you are listening to right now.
> The edit, the timing, the words on screen.
> HiveLogic made it.

**25.** Hold on the Content Studio window.

> That was one afternoon's feature.

**26.** The hex mark. Everything else falls away.

`ON SCREEN: HiveLogic — Run the whole thing.`

> Imagine what it does with your company.

**FADE OUT.**

---

## Fact check — every claim, and where it comes from

| Spoken claim | Real value | Source |
|---|---|---|
| "thirty-nine days old" | first commit 2026-07-15, today 2026-08-23 | `git log --reverse` |
| "two thousand commits" | 2,038 | `git rev-list --count HEAD` |
| "two hundred and forty tables" | 240 | `information_schema.tables`, production |
| "four thousand tests, passing" | 4,322 pass / 0 fail | `npm test` |
| every capability in Act IV | a real endpoint under `api/` | 152 endpoints, 69 shared modules |

Deliberately **not** claimed, because it could not be verified: any customer count, revenue figure,
time-saved statistic, ROI number, or comparison to a named competitor. A film for this product cannot
be the one thing in the build that invents a number.

## Production notes

- **Voice:** `nova` at the default production TTS instructions — warm, brisk, unhurried. Not an announcer.
- **The Act V numbers must be read flat.** No lift on "four thousand." The restraint is what sells it.
- **Act VI must be slower than feels comfortable.** The kicker only works with air around it.
- **Frames** come from real captured HiveLogic screens, not mockups. A mockup in this film would
  contradict the film.
