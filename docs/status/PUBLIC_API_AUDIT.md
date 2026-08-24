# Public API audit — every route that skips the login check

**Date:** 2026-08-23
**Scope:** the 22 path prefixes in `PUBLIC_API_PREFIXES` and the 9 entries in
`PUBLIC_RESOURCE_PATHS` (`api/_lib/guard.js`) — everything that reaches a
handler without a Supabase session.
**Method:** read each handler and each auth helper it calls. Claims in comments
were treated as claims, not evidence; every gate below was traced to its
implementation.

## Headline

**No unauthenticated access to company data was found.** Every exempted route
authenticates by its own mechanism, and each mechanism is correctly built.

Three findings, none critical, all recorded below. Two are latent rather than
live: they are inert while the right environment variables are set, and both
*are* set in production today.

---

## What protects each route

| Route | Authenticated by | Verified |
|---|---|---|
| `/api/health`, `/api/health-test` | nothing — returns no data | ✅ |
| `/api/jobber/callback`, `/api/jobber/webhook` | OAuth redirect / webhook, own handling | ✅ |
| `/api/qbo`, `/api/gusto`, `/api/msmail`, `/api/mail` | OAuth callbacks public; every data action self-gates with `requireUser` | ✅ |
| `/api/invites` | one-time CSPRNG token; `create` self-gates with `requireApiAuth` | ✅ |
| `/api/schedule/confirm` | 256-bit CSPRNG token, stored as SHA-256 hash | ✅ |
| `/api/authnet-webhook` | HMAC-SHA512 over the **raw** body, constant-time | ✅ |
| `/api/resend-webhook` | signature verification | ✅ |
| `/api/voice-webhook`, `/api/voice` | Twilio signature over URL+body, constant-time | ✅ |
| `/api/clientportal`, `/api/subportal` | portal session tokens, stored hashed | ✅ |
| `/api/agents/*` | `requireStaff` (admin/superadmin) or device token | ✅ |
| `/api/ai-workroom` | resolved identity, admin/superadmin only | ✅ |
| `/api/marketing-unsubscribe` | HMAC-SHA256 signed link, constant-time | ⚠️ see F2 |
| `/api/test-workflow` | `TEST_WORKFLOW_SECRET` | ✅ |
| `/api/status-hub-ingest`, `/api/status-hub-log-drain` | dedicated secrets, constant-time | ✅ |
| `track1?resource=reina_lab_read` | `REINA_LAB_READ_TOKEN`, constant-time | ✅ |
| `track1?resource=monitor_*` | agent bearer, SHA-256 hashed, must match an `active` row | ✅ |
| `track1?resource=workforce_auto_clockout` | Supabase token in body (`sendBeacon` cannot set headers) | ✅ |
| `fieldops?action=tm_pay_init` | 256-bit CSPRNG pay token | ⚠️ see F3 |
| `jobber/sync-extended?resource=fleetsharp_push` | FleetSharp push, own handling | ✅ |

### The cryptography is done properly

Worth stating because it is the part most often got wrong, and it is not:

- Every secret comparison uses `crypto.timingSafeEqual`, with a length guard
  first (it throws on mismatched lengths) — `guard.js`, `authnet.js`,
  `voice.js`, `track1.js`, `status-hub-*.js` alike.
- Webhook HMACs are computed over the **raw request body**, not the re-serialised
  parsed object.
- Session tokens are stored as SHA-256 hashes and looked up by hash, so the raw
  token never sits in a database column — sub portal, client portal, invites,
  schedule confirm, monitor agents.
- `requireMonitorAgent` requires the presented bearer's hash to match an agent
  row whose `status = 'active'`, so revoking an agent takes effect immediately.

### Two false alarms, verified before reporting

A keyword sweep flagged `api/authnet-webhook.js` (0 auth keywords in 259 lines)
and `api/agents/control.js` (0 in 138). Both are fine: the first calls
`verifyAuthnetSignature`, the second `requireStaff` — names the sweep did not
know. Recorded because it is the reason this audit read handlers rather than
trusting a grep.

---

## Findings

### F1 — The cron gate fails **open** when its secret is missing (latent)

`decideAccess()` in `api/_lib/guard.js`:

```
if (hasValidCronSecret) return { allow: true, ... };
if (!cronSecretConfigured) return { allow: true, reason: 'cron-grace-no-secret' };
```

If `CRON_SECRET` is ever unset, every cron path becomes callable by anyone, with
no secret at all. It is a deliberate rollout grace and is **inert today** —
`CRON_SECRET` is set in production, confirmed.

The risk is that it is silent. Deleting one environment variable opens a set of
endpoints, and nothing announces it. A fail-closed version would take the
scheduler down instead, which is loud, obvious and recoverable in a minute.

**Recommendation:** fail closed, or at minimum have the grace path also fire a
health-check alarm. This is an operational decision (a wrong call takes the
scheduler offline), so it is left to Chris rather than changed here.

### F2 — The unsubscribe signing key falls back to a literal in public source

`api/marketing-unsubscribe.js`:

```js
return process.env.MARKETING_UNSUBSCRIBE_SECRET
    || process.env.SUPABASE_SERVICE_KEY
    || 'dev-only-insecure-fallback';
```

Two problems, in order of seriousness:

1. The final fallback is a **hardcoded string in a public repository**. If both
   variables were ever absent, anyone could forge unsubscribe links.
2. The middle fallback reuses `SUPABASE_SERVICE_KEY` — the master database key —
   as an HMAC signing key. Keys should not be shared across purposes; an HMAC
   oracle is a poor thing to point at your most privileged secret.

Inert today: `MARKETING_UNSUBSCRIBE_SECRET` is set in production, confirmed. The
blast radius is also small — a forged link unsubscribes someone, it does not
read data.

**Fixed in this change:** the fallback chain is removed and the function fails
closed.

### F3 — `tm_invoices.pay_token` is stored in plaintext (known, unchanged)

Every other capability token in the system is stored as a SHA-256 hash. This one
is not, so a database leak would expose live payment links. This was already
documented as residual risk in `guard.js`, and the reason it stands is sound:
hashing it would invalidate every payment link already sitting in a customer's
text messages.

**Recommendation:** hash new tokens and accept both forms during a cutover
window. Migration-shaped, not urgent, and explicitly not done here.

---

## What this audit did NOT cover

Stated so the gaps are not mistaken for clean results:

- **Authenticated authorization.** This audit asked "can an anonymous caller get
  in", not "can a signed-in crew member reach something meant for admins". The
  role gates exist (`requireStaff`, `hasAllowedRole`, `SENSITIVE_ROLES`) but were
  not systematically traced.
- **The frontend.** No XSS, CSRF or client-side secret review.
- **Dependencies.** No supply-chain or CVE review.
- **The accounts themselves.** Supabase, Vercel, GitHub and email are outside
  the codebase and are the likeliest real-world way in — see below.

## The two things most likely to actually cause a breach

Neither is a code problem, and both outrank everything above.

1. **Account takeover.** If someone obtains the password for Supabase, Vercel,
   GitHub or the email account behind them, every control in this document is
   bypassed. Two-factor authentication on all four is the highest-value hour
   available.
2. **The service key on a developer machine.** `SUPABASE_SERVICE_KEY` sits in
   plaintext in `.env.vercelpull` on Chris's Desktop. It bypasses row level
   security entirely — every protection applied on 2026-08-23 included. A stolen
   or infected laptop is a total database compromise. Rotating it, keeping it out
   of files that live on disk, and full-disk encryption all apply.
