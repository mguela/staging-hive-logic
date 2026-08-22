# HiveLogic Phone — architecture spec (2026-07-24)

Read this before touching `api/voice.js`, `api/voice-webhook.js`,
`api/_lib/voice.js`, `public/app-phone.js`, or `sql/023_voice_phone_system.sql`.

## Product boundary — do not violate this

HiveLogic Phone is **strictly a telephone system**: numbers, extensions,
calls, voicemail, hold/transfer, call recording/transcription. It does
**not** contain chat, DMs, channels, email, or video meetings — that's
HiveConnect (`public/hiveconnect/`), a completely separate product living
in the same repo. Before adding anything here, ask: does this make
HiveLogic Phone feel more like an excellent, dependable telephone? If it
introduces messaging/collaboration clutter, it belongs in HiveConnect
instead, not here.

## Why Twilio, and why a provider-neutral file boundary

Building actual carrier infrastructure (SIP signaling, media servers,
STIR/SHAKEN registration, E911 dispatchable-location compliance, desk
phone hardware certification) from scratch is not realistic for this repo
— that is what companies like Twilio, Bandwidth, and Telnyx spend years
and hundreds of engineers building. HiveLogic Phone is built **on top of**
Twilio Programmable Voice as the carrier, with every Twilio-specific call
confined to `api/_lib/voice.js`. Nothing else in the codebase should
`fetch('https://api.twilio.com/...')` directly — go through that file so
a future carrier swap is a rewrite of one file, not a repo-wide hunt.

No `twilio` npm package — matches this repo's existing pattern (`_lib/jobber.js`)
of talking to third-party REST APIs with raw `fetch` instead of adding SDK
dependencies. Twilio's REST API, TwiML, and Access Tokens (a plain JWT)
are all doable with `fetch` + `node:crypto`.

## Why calls are bridged through a Conference, not a plain `<Dial>`

A direct `<Dial><Client>` only supports ending the call, not holding one
leg independently or blind-transferring without dropping the caller.
Every answered call instead joins a uniquely-named Twilio Conference
(`call-{voice_calls.id}`) with two legs: the caller/member who initiated,
and the extension/number being reached. This makes Twilio's real
Conference Participant API (`Hold=true/false`, remove-participant for
transfer) available — see `api/voice.js`'s `handleHold`/`handleTransfer`
and `api/voice-webhook.js`'s `handleGather`/`handleOutbound`.

## Real-time media never depends on the app backend

Per the architecture rule this repo was asked to follow: **the general
application backend must not sit in the real-time media path.** The
browser softphone (`public/app-phone.js`) talks to Twilio's Voice JS SDK
directly for actual call audio; `api/voice.js` only ever mints a short-
lived Access Token and issues call-control side-channel requests (hold,
transfer). If `api/voice.js` is down, an already-connected call keeps
working — only new call-control actions fail.

## What's built (Phase 1) vs. deliberately deferred

**Built, real, working once Twilio is connected:**
main number + extensions, dial-by-extension IVR with a traditional keypad
menu (0 for operator), business-hours-aware greetings (text-to-speech),
blocklist, voicemail with Twilio's built-in transcription + an AI
one-line summary (Claude), call logging with caller recognition against
synced `clients.phone_e164`, browser softphone (dial, receive, hold,
blind transfer, mute, keypad DTMF, end), admin Settings panel for
extensions/numbers/greetings/blocklist.

**Deliberately deferred, not started:**
- Physical desk phone provisioning (SIP/zero-touch) — needs real device
  hardware and a provisioning service; out of scope until Chris wants to
  buy phones.
- Warm transfer ("talk first") — blind transfer is real; warm transfer
  needs a second temporary conference leg the transferring member joins
  privately first. Next safe implementation step once blind transfer is
  verified live.
- Self-serve number search/purchase/porting wizard — Phase 1 is
  admin-paste (buy/port in the Twilio console, register the result in
  Settings > Numbers). The full guided 12-step porting flow from the
  product spec is real scope for a later phase.
- AI Attendant (conversational routing) — Phase 1 ships the traditional
  DTMF menu the spec requires as an always-available fallback anyway;
  the AI layer on top is a distinct, large feature (Shadow Mode, call-flow
  simulator, confidence-gated routing) for later.
- Ring groups / call queues beyond a single flat extension list, E911
  dispatchable location workflow, multi-carrier failover, CPNI/STIR-SHAKEN
  compliance tooling beyond what Twilio itself provides.

## What Chris needs to do before this goes live

1. Create a Twilio account (or share an existing one).
2. Buy or port a business number in the Twilio console.
3. Create a Twilio API Key (Account > API keys) and a TwiML App pointing
   its Voice Request URL at `https://hivelogic-live.vercel.app/api/voice-webhook?resource=outbound`.
4. Set the phone number's own Voice webhook to
   `https://hivelogic-live.vercel.app/api/voice-webhook?resource=inbound`
   and its Status Callback to `.../api/voice-webhook?resource=status`.
5. Add 5 Vercel env vars: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
   `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_TWIML_APP_SID`.
6. Run `sql/023_voice_phone_system.sql` in the Supabase SQL editor.
7. Register the number in Settings > Numbers (role=main) once logged in.
8. Create at least one extension for yourself in Settings > Extensions.

Until step 5 is done, `public/app-phone.js` shows an honest "not
connected yet" state — no fake data, no dead buttons.

## Known unverified item

`api/jobber/sync.js`'s new `phones { number primary description }` field
on `CLIENTS_QUERY` was written against Jobber's public schema docs, not
confirmed against a live GraphQL call (this session has no deployed
Jobber OAuth token to test with). Run a manual
`/api/jobber/sync?resource=clients` once deployed and check for a GraphQL
schema error the same way `INVOICES_QUERY`'s `amounts` fields were fixed
historically — if `phones` isn't the right field name, the error message
will say so directly.
