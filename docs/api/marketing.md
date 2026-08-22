# Marketing, Social & Ads APIs

This is HiveLogic's marketing surface: the Marketing Operating System (MOS) in
`api/marketing.js` (opportunity detection, campaign creation/sending, the
Marketing Command Center, budgets, owner-submitted ideas, and lifecycle
auto-send playbooks), organic social post scheduling in `api/social-posts.js`,
TikTok's Content Posting OAuth flow (`api/tiktok/connect.js` /
`api/tiktok/callback.js`), the public unsubscribe link
(`api/marketing-unsubscribe.js`), and paid ad platform integration for Meta,
Google Ads, and TikTok Ads in `api/ads.js`. All data is real: every handler
reads from Jobber-synced tables (jobs, clients, quotes) or HiveLogic's own
marketing tables, and every AI-drafted field (ad copy, captions, review
replies) is grounded only in facts fetched for that specific request — never a
fabricated number, name, or outcome.

## api/marketing.js — Marketing Operating System (MOS)

Every operation below is reached as `GET`/`POST`/`PATCH /api/marketing?resource=<name>`.
Unless noted otherwise, **Auth** is: `Authorization: Bearer <Supabase access
token>`, verified by a local `requireUser(req)` that calls Supabase's own
`/auth/v1/user` endpoint — return 401 `{ "ok": false, "error": "Not
authenticated. Sign in and try again." }` if missing/invalid. Nine resources
(`process_scheduled_sends`, `process_review_request_autosend`, and the seven
`process_*_autosend` lifecycle resources) are Vercel Cron entry points and
bypass `requireUser` entirely via a `CRON_SECRET` bearer-token check
(`Authorization: Bearer $CRON_SECRET`) — see their own section below.

### Review Requests & Review Queue

#### `GET /api/marketing?resource=review_queue`
**Auth:** Bearer Supabase token via `requireUser`.
**Purpose:** Lists completed jobs that still need a review ask sent (client has an email on file, no `review_requests` row marks it sent/dismissed).

**Request body / query params:** none.

**Response:**
```json
{
  "ok": true,
  "source": "HiveLogic (jobs + clients, real completed-job data)",
  "totalCompletedJobs": 0,
  "withEmail": 0,
  "alreadyActioned": 0,
  "returned": 0,
  "windowDays": 60,
  "withinWindowCount": 0,
  "pending": [{ "jobId": "...", "clientId": "...", "clientName": "...", "clientEmail": "...", "jobTitle": "...", "jobNumber": "...", "total": 0, "completedAt": "...", "ageDays": 0 }]
}
```
Notes: `pending` is capped at 300 rows. No sentiment/rating filter exists anywhere — every completed job with a client email gets the same treatment, by design.

#### `POST /api/marketing?resource=review_requests`
**Auth:** Bearer Supabase token.
**Purpose:** Records that the owner sent or dismissed a review ask for one job, so it drops out of the queue.

**Request body / query params:**
- `jobId` (string, required)
- `status` (string, required) — `"sent"` or `"dismissed"`
- `clientId` (string, optional)
- `dismissedReason` (string, optional) — only used when `status` is `"dismissed"`

**Response:**
```json
{ "ok": true, "jobId": "...", "status": "sent" }
```
Notes: upserts on `job_id` (unique). If the `review_requests` table isn't migrated yet, returns 200 with `ok:false` and an explanatory error instead of a 500.

#### `POST /api/marketing?resource=review_requests_bulk`
**Auth:** Bearer Supabase token.
**Purpose:** Bulk-dismisses the entire review-ask backlog older than N days in one call ("clear the backlog").

**Request body / query params:**
- `olderThanDays` (number, required, must be positive)

**Response:**
```json
{ "ok": true, "dismissedCount": 0 }
```

#### `GET /api/marketing?resource=review_requests_candidates`
**Auth:** Bearer Supabase token.
**Purpose:** Returns the real, named list of review-ask candidates (not just a count) so a campaign can be built with a real audience.

**Request body / query params:**
- `limit` (number, optional, query string; capped at 500)

**Response:**
```json
{ "ok": true, "candidates": [{ "clientId": "...", "jobId": "...", "jobTitle": "...", "completedAt": "...", "clientName": "...", "email": "..." }], "totalEligible": 0, "cap": 500, "hasMore": false }
```

### Opportunity Engine

#### `GET /api/marketing?resource=opportunities`
**Auth:** Bearer Supabase token.
**Purpose:** Runs all seven real opportunity computations (unsold estimates, neighborhood expansion, review requests, reactivate past customers, referral opportunities, seasonal promotion, missed lead sources) and returns them as cards.

**Request body / query params:** none.

**Response:**
```json
{ "ok": true, "source": "HiveLogic (real Jobber-synced + HiveLogic tables, no fabricated figures)", "opportunities": [{ "key": "unsold_estimates", "label": "Unsold Estimates", "count": 0, "estRevenue": 0, "real": true, "actionable": true, "description": "...", "actionLabel": "Create Campaign" }] }
```
Notes: `neighborhood_expansion` is always `actionable: false` for email (it's geographic areas, not existing-customer contacts) — see `OPPORTUNITY_ELIGIBILITY` and `checkCampaignEligibility()`, which is the single source of truth the campaign-create endpoint also enforces so the UI and the write path can never drift apart. `missed_lead_sources` is permanently non-actionable (`actionableReason` explains there's no connector for it).

#### `GET /api/marketing?resource=brief`
**Auth:** Bearer Supabase token.
**Purpose:** Picks the single highest-`estRevenue` real opportunity (from unsold estimates, reactivate customers, neighborhood expansion) as one headline recommendation.

**Response:**
```json
{ "ok": true, "brief": { "headline": "Recover Unsold Estimates", "description": "...", "estRevenue": 0, "opportunityKey": "unsold_estimates" } }
```
or, if nothing stands out: `{ "ok": true, "brief": null, "message": "No real opportunity currently stands out -- nothing urgent to recommend right now." }`.

#### `GET /api/marketing?resource=insights`
**Auth:** Bearer Supabase token.
**Purpose:** Surfaces only what's honestly computable today (sent-review-request count, seasonal trend reused from the opportunity engine) as short insight cards.

**Response:**
```json
{ "ok": true, "insights": [{ "icon": "star", "insight": "...", "why": "...", "action": "..." }] }
```

#### `GET /api/marketing?resource=opportunity_candidates`
**Auth:** Bearer Supabase token.
**Purpose:** Generic dispatcher returning the real recipient candidates behind one opportunity key.

**Request body / query params:**
- `key` (string, required, query) — one of `review_requests`, `unsold_estimates`, `reactivate_customers`, `seasonal_promotion`, `referral_opportunities`
- `limit` (number, optional, query; capped at 500)

**Response:**
```json
{ "ok": true, "key": "unsold_estimates", "candidates": [...], "totalEligible": 0, "cap": 500, "hasMore": false, "coverageNote": null }
```

### Marketing Health, Config & Test Send

#### `GET /api/marketing?resource=marketing_health`
**Auth:** Bearer Supabase token.
**Purpose:** A 0–100 health score built only from real, measurable sub-metrics (content freshness from `media.captured_at`, average lead-response time from `lead_pipeline`); unmeasurable sub-metrics (brand consistency, review rating, campaign performance) are explicitly flagged rather than scored as 0.

**Response:**
```json
{ "ok": true, "score": null, "scoreLabel": "...", "coverage": { "measured": 0, "total": 5 }, "metrics": [{ "key": "content_freshness", "label": "Content freshness", "real": false, "value": "..." }], "weighting": "...", "measurementPeriod": "...", "missingDataBehavior": "..." }
```

#### `GET /api/marketing?resource=config`
**Auth:** Bearer Supabase token.
**Purpose:** Small config surface for the frontend — the real Google review link plus email-send gate states.

**Response:**
```json
{ "ok": true, "reviewLink": null, "emailConfigured": false, "emailSendEnabled": false }
```

#### `POST /api/marketing?resource=test_send`
**Auth:** Bearer Supabase token.
**Purpose:** Sends one real test email through the exact same Resend path a campaign send uses, without touching any campaign/recipient rows.

**Request body / query params:**
- `subject` (string, required)
- `body` (string, required)
- `to` (string, optional) — defaults to, and by default is *required* to equal, the signed-in user's own email
- `confirmOtherAddress` (boolean, optional) — must be `true` to send to any address other than the caller's own
- `campaignId` (string, optional) — if given, logs a `test_sent` campaign-activity event

**Response:**
```json
{ "ok": true, "id": "..." }
```
Notes: gated behind `isEmailConfigured()` (RESEND_API_KEY set) and `isEmailSendEnabled()` (MARKETING_EMAIL_SEND_ENABLED=true) — both return 409 with an explanatory error if unmet.

### Launch Channels

#### `GET /api/marketing?resource=channels`
**Auth:** Bearer Supabase token.
**Purpose:** Real connection status for every marketing channel (email plus everything in `marketing_platform_connections`), replacing a hardcoded array.

**Response:**
```json
{ "ok": true, "channels": [{ "key": "email", "label": "Email", "state": "not_connected", "connected": false, "note": "..." }, { "key": "google_ads", "label": "Google Ads", "state": "not_connected", "connected": false, "accountName": null, "accountId": null, "note": "Not connected." }] }
```

### Campaigns (CRUD, Send & Lifecycle Management)

#### `GET /api/marketing?resource=campaigns`
**Auth:** Bearer Supabase token.
**Purpose:** Lists all campaigns with computed recipient/sent/response/booked stats.

**Response:**
```json
{ "ok": true, "campaigns": [{ "id": "...", "name": "...", "type": "estimate_recovery", "channel": "email", "status": "draft", "createdAt": "...", "updatedAt": "...", "createdBy": "...", "updatedBy": "...", "scheduledAt": null, "notes": null, "subject": null, "body": null, "recipientCount": 0, "sent": 0, "responseRate": null, "booked": 0, "bookedValue": 0 }] }
```

#### `POST /api/marketing?resource=campaigns`
**Auth:** Bearer Supabase token.
**Purpose:** Creates a new draft campaign with a real recipient list, or reuses/tops-up an existing draft of the same type.

**Request body / query params:**
- `name` (string, required)
- `type` (string, required) — one of `estimate_recovery`, `review_request`, `reactivation`, `referral`, `seasonal`, `custom` (plus 6 Phase-14 lifecycle types that 400 until their migration is applied: `post_job_thank_you`, `service_anniversary`, `new_lead_followup`, `dormant_reactivation`, `newsletter`, `maintenance_reminders`)
- `channel` (string, optional) — `email`|`sms`|`mail`, defaults to `email`
- `recipients` (array, optional) — `{ clientId, targetRecordId?, targetRecordType? }[]`, capped at 500
- `targetFilter` (object, optional) — `{ opportunityKey?, ... }`, checked against `OPPORTUNITY_ELIGIBILITY`
- `notes`, `subject`, `body` (strings, optional)

**Response:**
```json
{ "ok": true, "campaign": { "id": "...", "name": "...", "type": "...", "status": "draft" }, "recipientCount": 0 }
```
or, if reused: adds `"reused": true`. Returns 400 with `blocked: true` and `requiredIntegration` if `checkCampaignEligibility` rejects the audience/channel (e.g. `neighborhood_expansion` + email, or zero recipients). Best-effort creates a `marketing_approvals` row (`approvable_type: "CAMPAIGN_SPEND"`) for the "Ready for You" queue.

#### `PATCH /api/marketing?resource=campaign_recipient`
**Auth:** Bearer Supabase token.
**Purpose:** Marks one recipient's sent/outcome status manually (for channels without an automated send, e.g. mail).

**Request body / query params:**
- `recipientId` (string, required)
- `sent` (boolean, optional)
- `outcome` (string, optional) — `no_response`|`responded`|`booked`
- `outcomeValue` (number, optional)

**Response:**
```json
{ "ok": true, "recipient": { "id": "...", "outcome": "booked" } }
```

#### `POST /api/marketing?resource=campaign_send`
**Auth:** Bearer Supabase token.
**Purpose:** The real email send: sends personalized copy to every unsent recipient via Resend, with unsubscribe/suppression/consent checks and an atomic status claim to prevent double-sends.

**Request body / query params:**
- `campaignId` (string, required)
- `subject` (string, required)
- `body` (string, required) — supports merge fields `{{clientName}}`, `{{jobTitle}}`, `{{quoteTitle}}`, `{{quoteTotal}}`

**Response:**
```json
{ "ok": true, "attempted": 0, "sent": 0, "failed": 0, "skippedNoEmail": 0, "skippedSuppressed": 0 }
```
Notes: 409 if the campaign isn't `email` channel or is already `sent`/`sending`. Every send carries a real `List-Unsubscribe` header and an HMAC-signed unsubscribe link (see `api/marketing-unsubscribe.js` below) — recipients in `marketing_suppressions` or with revoked `marketing_consent_ledger` status are skipped, never emailed. A `review_request` send mirrors sent rows into the legacy `review_requests` table. Reverts campaign status to `draft` (retryable) if literally nothing sent.

#### `POST /api/marketing?resource=campaign_delete`
**Auth:** Bearer Supabase token.
**Purpose:** Deletes a draft campaign that has never sent to a real recipient.

**Request body / query params:**
- `campaignId` (string, required)
- `confirm` (boolean, required) — must be `true`

**Response:**
```json
{ "ok": true, "deleted": true, "campaignId": "..." }
```
Notes: 409 if any recipient already has `sent_at` set, or status is `active`/`sending` — a campaign that ever sent can only be archived via status change elsewhere, never deleted, so reporting can't disappear.

#### `POST /api/marketing?resource=campaign_update`
**Auth:** Bearer Supabase token.
**Purpose:** Edits a draft campaign's name/notes/subject/body, or sets/clears its scheduled send time.

**Request body / query params:**
- `campaignId` (string, required)
- `name`, `notes`, `subject`, `body` (strings, optional)
- `scheduledAt` (string ISO date or `null`, optional) — must be a future date if set

**Response:**
```json
{ "ok": true, "campaign": { "id": "...", "name": "...", "scheduled_at": null } }
```
Notes: 409 if campaign status isn't `draft`.

#### `POST /api/marketing?resource=campaign_duplicate`
**Auth:** Bearer Supabase token.
**Purpose:** Duplicates any campaign as a brand-new draft with zero recipients (never copies the audience, so a stale audience can't silently ship).

**Request body / query params:**
- `campaignId` (string, required)

**Response:**
```json
{ "ok": true, "campaign": { "id": "...", "name": "... (copy)", "status": "draft" }, "recipientCount": 0, "note": "Duplicated as a new draft with zero recipients -- select a real audience for it before sending." }
```

#### `GET /api/marketing?resource=campaign_activity`
**Auth:** Bearer Supabase token.
**Purpose:** Real per-campaign audit trail (created/edited/sent/duplicated/etc.) from `campaign_activity_log`.

**Request body / query params:**
- `campaignId` (string, required, query)

**Response:**
```json
{ "ok": true, "campaignId": "...", "events": [{ "event": "created", "actor": "...", "detail": {}, "created_at": "..." }] }
```

#### `GET /api/marketing?resource=campaign_drafts`
**Auth:** Bearer Supabase token.
**Purpose:** Lists persisted Content Studio caption drafts (`marketing_campaign_drafts`).

**Response:**
```json
{ "ok": true, "drafts": [{ "id": "...", "jobId": "...", "division": "HVAC", "draftText": "...", "usedRealAnalysis": false, "photoCount": 0, "status": "...", "promotedCampaignId": null, "createdAt": "..." }] }
```

#### `GET /api/marketing?resource=process_scheduled_sends` (cron)
**Auth:** No user session — Vercel Cron only. Bypasses `requireUser` when `Authorization: Bearer <CRON_SECRET>` matches `process.env.CRON_SECRET`; if the header doesn't match, falls through to the normal `requireUser` gate (401 for anyone else).
**Purpose:** Runs every 15 minutes (`vercel.json`); finds draft campaigns whose `scheduled_at` has passed and sends each through the exact same `handleCampaignSendPost` code path an interactive click uses (same claim, suppression/consent checks, activity log).

**Response:**
```json
{ "ok": true, "processed": 0, "results": [{ "campaignId": "...", "ok": true, "result": { "ok": true, "sent": 0 } }] }
```

### AI-Assisted Campaign Copy (Ask Reina)

#### `POST /api/marketing?resource=campaign_ask_reina`
**Auth:** Bearer Supabase token.
**Purpose:** Answers a free-form owner question about one draft campaign, using only that campaign's real stats and one real sample recipient's real facts.

**Request body / query params:**
- `campaignId` (string, required)
- `question` (string, required, max 500 chars)

**Response:**
```json
{ "ok": true, "answer": "...", "usedRealSample": false }
```
Notes: 409 if `ANTHROPIC_API_KEY` is unset. Uses `claude-sonnet-4-5` (or `CLASSIFIER_MODEL`) via the `@anthropic-ai/sdk` client.

#### `POST /api/marketing?resource=campaign_regenerate_copy`
**Auth:** Bearer Supabase token.
**Purpose:** Regenerates AI subject/body copy for a draft campaign, grounded in one real sample recipient's facts.

**Request body / query params:**
- `campaignId` (string, required)

**Response:**
```json
{ "ok": true, "subject": "...", "body": "...", "usedRealSample": false }
```
Notes: 409 if campaign isn't `draft` or `ANTHROPIC_API_KEY` is unset; 502 if the model's JSON can't be parsed.

### Reina Change-Request Approvals

#### `GET /api/marketing?resource=reina_change_requests`
**Auth:** Bearer Supabase token.
**Purpose:** Lists pending `marketing_approvals` rows of type `reina_change_request` (read-only recommendations Reina wrote elsewhere) for owner review.

**Response:**
```json
{ "ok": true, "source": "marketing_approvals (reina_change_request, pending)", "returned": 0, "pending": [{ "id": "...", "jobId": "...", "title": "...", "rationale": "...", "amountCents": null, "needsEstimatorPricing": true, "confidence": null, "risks": [], "scopeDelta": null, "gaps": [], "citedExcerpt": null, "requestSource": null, "isTest": false, "target": null, "createdAt": "..." }] }
```

#### `POST /api/marketing?resource=reina_change_request_decide`
**Auth:** Bearer Supabase token.
**Purpose:** Approves or rejects one Reina change-request recommendation. On approval, emails the real client (reusing the same Resend path as `campaign_send`) — it never creates a Jobber change order or a HiveLogic Change Order (both investigated and deliberately not implemented, since neither has a verified write path or a real cost figure to use).

**Request body / query params:**
- `id` (string, required)
- `decision` (string, required) — `"approved"` or `"rejected"`
- `reason` (string, optional, max 1000 chars)

**Response:**
```json
{ "ok": true, "decision": "approved", "approval": { "id": "...", "status": "approved", "decided_by": "...", "decided_at": "..." }, "notification": { "status": "sent", "to": "..." }, "changeOrder": { "status": "not_available", "reason": "..." } }
```

#### `POST /api/marketing?resource=approval_reject`
**Auth:** Bearer Supabase token.
**Purpose:** Rejects any pending `marketing_approvals` row (any `approvable_type`, including `CAMPAIGN_SPEND`) — never deletes the underlying campaign.

**Request body / query params:**
- `approvalId` (string, required)
- `reason` (string, optional, max 2000 chars)

**Response:**
```json
{ "ok": true, "rejected": true, "approvalId": "..." }
```

### Content Studio

#### `GET /api/marketing?resource=content_jobs`
**Auth:** Bearer Supabase token.
**Purpose:** Real, photo-backed job list (most recent CompanyCam media activity) for picking a job to draft social copy about.

**Request body / query params:**
- `limit` (number, optional, query; default 12, max 30)
- `scanLimit` (number, optional, query; default 20000, max 50000)

**Response:**
```json
{ "ok": true, "source": "HiveLogic Marketing", "jobs": [{ "jobId": "...", "jobNumber": "...", "jobTitle": "...", "division": "HVAC", "clientName": "...", "mediaCount": 0, "lastActivityAt": "...", "photos": [{ "id": "...", "storagePath": "...", "capturedAt": "..." }], "hasRealAnalysis": false, "analysisNotes": [] }] }
```

#### `POST /api/marketing?resource=draft_post`
**Auth:** Bearer Supabase token.
**Purpose:** AI-drafts a short social caption for one completed job, grounded only in real CompanyCam photo-analysis facts (never fabricated materials/prices/details); best-effort persisted to `marketing_campaign_drafts`.

**Request body / query params:**
- `jobId` (string, required)

**Response:**
```json
{ "ok": true, "source": "HiveLogic Marketing", "draft": "...", "draftId": null, "usedRealAnalysis": false, "division": "HVAC", "jobNumber": "..." }
```
Notes: 409 if `ANTHROPIC_API_KEY` is unset. `draftId` stays `null` (not an error) if the drafts table isn't migrated yet — the caption is still returned.

### Review Replies

#### `GET /api/marketing?resource=review_replies`
**Auth:** Bearer Supabase token.
**Purpose:** Lists AI-drafted replies to real, owner-pasted customer reviews.

**Request body / query params:**
- `clientId` (string, optional, query)

**Response:**
```json
{ "ok": true, "replies": [{ "id": "...", "clientId": null, "reviewRequestId": null, "platform": "google_business_profile", "externalReviewId": null, "reviewerName": null, "rating": null, "reviewText": "...", "draftReplyText": "...", "finalReplyText": null, "sensitivityFlag": false, "status": "...", "createdAt": "..." }] }
```

#### `POST /api/marketing?resource=review_replies`
**Auth:** Bearer Supabase token.
**Purpose:** Drafts an AI reply to a real, unmodified customer review the owner pastes in (no GBP connector exists, so review text is manual input, not fetched live). Never rewrites the review itself.

**Request body / query params:**
- `platform` (string, required) — `google_business_profile`|`other`
- `reviewText` (string, required)
- `rating` (integer 1–5, optional)
- `clientId`, `reviewRequestId`, `externalReviewId`, `reviewerName` (strings, optional)

**Response:**
```json
{ "ok": true, "reviewReply": { "id": null, "draftReplyText": "...", "sensitivityFlag": false, "status": "draft" } }
```
Notes: `sensitivityFlag` is `true` for a rating ≤2, an unrated review, or text containing sensitive keywords (refund/scam/lawsuit/etc.) — flags for owner review before posting anywhere.

### Website Change Drafts

#### `GET /api/marketing?resource=website_changes`
**Auth:** Bearer Supabase token.
**Purpose:** Lists drafted website content changes.

**Response:**
```json
{ "ok": true, "changes": [{ "id": "...", "provider": "wordpress", "changeType": "landing_page", "pagePath": null, "title": "...", "contentSnapshot": {}, "status": "draft", "createdBy": "reina", "createdAt": "..." }] }
```

#### `POST /api/marketing?resource=website_changes`
**Auth:** Bearer Supabase token.
**Purpose:** AI-drafts website copy (headline/body/cta) for one division, grounded only in real completed-job counts/values for that division — never invents pricing, warranties, or certifications. No CMS publish path exists; this only ever creates a `draft` row.

**Request body / query params:**
- `provider` (string, optional) — `wordpress`|`webflow`|`wix`|`other`, defaults `other`
- `changeType` (string, required) — one of `landing_page`, `promotion`, `service_page`, `portfolio_page`, `video_embed`, `cta`, `form`, `local_content`, `technical_seo`, `general`
- `division` (string, required) — e.g. `HVAC`, `Electric`, `Plumbing`, `Design|Build`, `Outdoor Spaces`
- `pagePath` (string, optional)

**Response:**
```json
{ "ok": true, "websiteChange": { "id": null, "provider": "other", "changeType": "landing_page", "title": "...", "contentSnapshot": { "headline": "...", "body": "...", "cta": "...", "division": "HVAC", "realFactsUsed": {} }, "status": "draft" } }
```

### Marketing Command Center

#### `GET /api/marketing?resource=command_center`
**Auth:** Bearer Supabase token.
**Purpose:** Single aggregate payload for the Command Center dashboard — connections, "Ready for You" approval queue, the Plan tab's channel/forecast data, the schedule feed, and budget/pacing.

**Response:**
```json
{ "ok": true, "connections": { "total": 0, "connected": 0, "items": [] }, "readyForYou": { "items": [], "sentLast7Days": 0 }, "plan": { "budgetCents": 250000, "channels": [], "forecast": {} }, "schedule": { "windowStart": "...", "windowEnd": "...", "events": [], "notYetTracked": [] }, "budget": { "monthlyCents": 250000, "min": 250000, "max": 1500000, "channels": [], "allocatedCents": 0 } }
```

#### `POST /api/marketing?resource=command_center_budget`
**Auth:** Bearer Supabase token.
**Purpose:** Sets the total monthly marketing budget (clamped $2,500–$15,000).

**Request body / query params:**
- `monthlyDollars` (number, required)

**Response:**
```json
{ "ok": true, "budget": { "monthlyCents": 250000, "min": 250000, "max": 1500000 }, "plan": {} }
```

#### `POST /api/marketing?resource=command_center_budget_channels`
**Auth:** Bearer Supabase token.
**Purpose:** Alias that dispatches to the same handler as `setup_budget` below (per-channel split) — no second write path.

**Request body / query params:** same as `setup_budget`.
**Response:** same shape as `setup_budget`.

#### `GET /api/marketing?resource=command_center_assumptions`
**Auth:** Bearer Supabase token.
**Purpose:** Returns the owner's planning assumptions (gross margin, qualified-lead rate, close rate, etc.) plus a large `reference` block of real facts (avg job value, historical jobs/month, per-division job facts, seasonal distribution, unsold estimates, past customers, existing leads, prior-campaign attribution, CompanyCam availability, service territory, channel availability) and a deterministic, rule-based `rationale` list explaining what to do given those facts.

**Response:**
```json
{ "ok": true, "assumptions": { "grossMarginPct": null, "qualifiedLeadRatePer100": null, "closeRatePct": null, "maxNewJobsPerMonth": null, "riskPosture": "balanced", "avgJobValueCents": null, "updatedAt": null, "updatedBy": null }, "reference": { "realAvgJobValueCents": null, "realHistoricalJobsPerMonth": null, "...": "..." }, "rationale": [{ "key": "no_channel_ready", "priority": "blocker", "text": "..." }] }
```

#### `POST /api/marketing?resource=command_center_assumptions`
**Auth:** Bearer Supabase token.
**Purpose:** Saves the owner's planning assumptions and returns the recomputed plan.

**Request body / query params:**
- `grossMarginPct`, `closeRatePct` (number 0–100 or null, optional)
- `qualifiedLeadRatePer100` (number ≥0 or null, optional)
- `maxNewJobsPerMonth` (integer ≥0 or null, optional)
- `avgJobValueDollars` (number ≥0 or null, optional)
- `riskPosture` (string, optional) — `conservative`|`balanced`|`aggressive`

**Response:**
```json
{ "ok": true, "plan": { "budgetCents": 250000, "channels": [], "forecast": {} } }
```

#### `GET /api/marketing?resource=command_center_budget_pacing`
**Auth:** Bearer Supabase token.
**Purpose:** Real spend-vs-cap pacing for the month, reusing the exact `getBudgetCap`/`monthSpendCents` functions `api/ads.js`'s budget approval path already relies on.

**Response:**
```json
{ "ok": true, "configured": true, "capCents": 0, "spentCents": 0, "projectedCents": 0, "pctUsed": null, "daysElapsed": 1, "daysInMonth": 30, "autonomyLevel": "...", "overPace": false }
```
or `{ "ok": true, "configured": false }` if no `ad_budget_caps` row exists.

#### `GET /api/marketing?resource=command_center_channel_performance`
**Auth:** Bearer Supabase token.
**Purpose:** Real lead counts by `lead_pipeline.lead_source`, with cost-per-lead computed only for the sources with an unambiguous match to a tracked paid channel (google → google_ads, facebook → meta_ads).

**Response:**
```json
{ "ok": true, "configured": true, "rows": [{ "source": "google", "leads": 0, "channelKey": "google_ads", "spendCents": 0, "costPerLeadCents": null }], "totalLeads": 0 }
```

#### `GET /api/marketing?resource=command_center_goal`
**Auth:** Bearer Supabase token.
**Purpose:** Real quarterly revenue goal plus real quarter-to-date progress (sum of `jobs.total` for jobs completed this calendar quarter).

**Response:**
```json
{ "ok": true, "goalCents": null, "progressCents": 0, "pct": null, "quarterStart": "...", "quarterEnd": "..." }
```

#### `POST /api/marketing?resource=command_center_goal`
**Auth:** Bearer Supabase token.
**Purpose:** Sets (or clears) the quarterly revenue goal.

**Request body / query params:**
- `goalDollars` (number ≥0, or null/empty to clear, optional)

**Response:**
```json
{ "ok": true, "goalCents": null }
```

### Marketing Setup (Budgets & Accounts)

#### `GET /api/marketing?resource=setup`
**Auth:** Bearer Supabase token.
**Purpose:** Returns the total budget + per-channel split, and every account/connection record (with secrets redacted).

**Response:**
```json
{ "ok": true, "budget": { "monthlyCents": 250000, "min": 250000, "max": 1500000, "channels": [], "allocatedCents": 0 }, "accounts": [{ "key": "email", "label": "Email (Resend)", "state": "not_connected", "connected": false, "accountName": null, "accountId": null, "loginAccountId": null, "note": "...", "lastVerifiedAt": null, "fields": {}, "savedSecretFields": [] }] }
```

#### `POST /api/marketing?resource=setup_budget`
**Auth:** Bearer Supabase token.
**Purpose:** Sets the total monthly budget and an optional per-channel split (email, SMS, Google Ads, Meta, GBP, website/SEO, direct mail, other) plus pacing controls (min viable spend, daily max, testing allowance, paused, approval threshold). Rejects if channel budgets exceed the total.

**Request body / query params:**
- `monthlyDollars` (number, required)
- `channels` (object, optional) — per key, either a plain dollar number or `{ monthlyDollars, minViableSpendDollars?, dailyMaxDollars?, testingAllowanceDollars?, paused?, approvalThresholdDollars? }`

**Response:**
```json
{ "ok": true, "budget": { "monthlyCents": 250000, "channels": [{ "key": "email", "label": "Email", "monthlyCents": 0, "minViableSpendCents": null, "dailyMaxCents": null, "testingAllowanceCents": 0, "paused": false, "approvalThresholdCents": null }] } }
```

#### `GET /api/marketing?resource=setup_budget_recommendation`
**Auth:** Bearer Supabase token.
**Purpose:** Recommends a budget split using real 90-day (configurable) `ad_spend_ledger` spend + `lead_pipeline` leads for Google Ads/Meta cost-per-lead — never fabricates a preference for channels with no real data (falls back to even split or current proportions).

**Request body / query params:**
- `lookbackDays` (number, optional, query; 7–365, default 90)
- `monthlyDollars` (number, optional, query)

**Response:**
```json
{ "ok": true, "lookbackDays": 90, "totalCents": 250000, "basis": "real_cost_per_lead", "summary": "...", "trackableChannelKeys": ["google_ads", "meta_ads"], "channels": [{ "key": "google_ads", "label": "Google Ads", "currentMonthlyCents": 0, "recommendedMonthlyCents": 0, "hasRealData": false, "spendCents": null, "leads": null, "costPerLeadCents": null, "rationale": "..." }], "unassignedPlatformSpendCents": {}, "notes": [] }
```

#### `POST /api/marketing?resource=setup_account`
**Auth:** Bearer Supabase token.
**Purpose:** Saves display metadata (name/ID/notes) for one platform account. Never sets connection `state` — state only changes through the real connect/verify flow.

**Request body / query params:**
- `channel` (string, required) — one of `email` or any `CHANNEL_LABELS` key
- `accountName`, `accountId`, `loginAccountId`, `note` (strings, optional)

**Response:**
```json
{ "ok": true, "accounts": [] }
```

#### `GET /api/marketing?resource=connector_catalog`
**Auth:** Bearer Supabase token.
**Purpose:** Lists every connector's field schema (OAuth vs. API-key vs. manual, required fields) with prefilled non-secret values and which secrets are already saved (never their real values).

**Response:**
```json
{ "ok": true, "catalog": [{ "key": "website_cms", "label": "Website / CMS", "authMethod": "api_key", "fields": [{ "name": "apiKey", "label": "API key", "type": "text", "required": true, "secret": true }], "state": "not_connected", "alreadyActive": false, "savedValues": {}, "savedSecretFields": [] }], "available": [] }
```

#### `POST /api/marketing?resource=setup_account_fields`
**Auth:** Bearer Supabase token.
**Purpose:** Saves a connector's dynamic field values (e.g. Website/CMS API key). A blank secret field keeps its previously saved value instead of forcing a retype.

**Request body / query params:**
- `platform` (string, required)
- `fields` (object, required) — per the platform's `CONNECTOR_FIELD_SCHEMAS`

**Response:**
```json
{ "ok": true, "platform": "website_cms", "state": "setup_incomplete", "fields": { "cmsPlatform": "WordPress", "siteUrl": "..." }, "accounts": [] }
```
Notes: never echoes a secret-typed field's real value back.

#### `POST /api/marketing?resource=connection_transition`
**Auth:** Bearer Supabase token.
**Purpose:** Moves one platform's connection through the Universal Connections state machine (`not_connected → setup_incomplete → reporting_verified → draft_validated → launch_enabled`, or into an issue state).

**Request body / query params:**
- `platform` (string, required)
- `toState` (string, required) — one of `CONNECTION_STATES`
- `note` (string, optional, max 500 chars)

**Response:**
```json
{ "ok": true, "platform": "google_ads", "fromState": "not_connected", "toState": "setup_incomplete", "accounts": [] }
```
Notes: 409 if the transition skips a required step (enforced by `isValidConnectionTransition`).

### Owner Ideas → Campaign

#### `GET /api/marketing?resource=ideas`
**Auth:** Bearer Supabase token.
**Purpose:** Lists owner-submitted marketing ideas with real attachment counts.

**Response:**
```json
{ "ok": true, "ideas": [{ "id": "...", "submittedBy": "...", "inputMode": "text", "rawText": "...", "jobId": null, "clientId": null, "status": "submitted", "brief": null, "gapFlags": null, "campaignId": null, "errorReason": null, "processedAt": null, "createdAt": "...", "updatedAt": "...", "attachmentCount": 0 }] }
```

#### `POST /api/marketing?resource=ideas`
**Auth:** Bearer Supabase token.
**Purpose:** Submits a new idea (text, or a placeholder for voice/photo/video/document that gets its real content via a follow-up `idea_attachments` upload).

**Request body / query params:**
- `inputMode` (string, optional) — `text`|`voice_note`|`photo`|`video`|`document`, defaults `text`
- `rawText` (string, required if `inputMode` is `text`; optional caption otherwise)
- `jobId`, `clientId` (strings, optional)

**Response:**
```json
{ "ok": true, "idea": { "id": "...", "submittedBy": "...", "inputMode": "text", "rawText": "...", "status": "submitted" } }
```

#### `GET /api/marketing?resource=idea_attachments`
**Auth:** Bearer Supabase token.
**Purpose:** Lists real files attached to one idea.

**Request body / query params:**
- `ideaId` (string, required, query)

**Response:**
```json
{ "ok": true, "attachments": [{ "id": "...", "attachmentType": "photo", "storagePath": "...", "mimeType": "...", "sizeBytes": 0, "durationMs": null, "transcript": null, "uploadedBy": "...", "createdAt": "..." }] }
```

#### `POST /api/marketing?resource=idea_attachments`
**Auth:** Bearer Supabase token.
**Purpose:** Uploads a real file (as a base64 data URL) to the private `marketing-attachments` Supabase Storage bucket and records it against an idea.

**Request body / query params:**
- `ideaId` (string, required)
- `attachmentType` (string, required) — `photo`|`video`|`audio`|`document`
- `fileDataUrl` (string, required) — `data:<mime>;base64,<...>`
- `fileName` (string, optional)
- `durationMs` (number, optional)

**Response:**
```json
{ "ok": true, "attachment": { "id": "...", "attachmentType": "photo", "storagePath": "marketing-attachments/owner-idea/...", "mimeType": "...", "sizeBytes": 0, "durationMs": null, "createdAt": "..." } }
```
Notes: `transcript` and `mediaId` are deliberately always null — no transcription pipeline or media-reuse picker exists yet.

#### `POST /api/marketing?resource=ideas_process`
**Auth:** Bearer Supabase token.
**Purpose:** AI-generates a campaign brief for one idea — a summary, recommended channels (filtered to only those that are actually `launch_enabled`/ready today), and honest gap flags for anything the idea didn't specify.

**Request body / query params:**
- `ideaId` (string, required)

**Response:**
```json
{ "ok": true, "idea": { "id": "...", "status": "brief_ready", "brief": { "summary": "...", "recommendedChannels": [{ "channel": "Email", "why": "..." }] }, "gapFlags": ["..."], "errorReason": null, "processedAt": "..." } }
```
Notes: 409 if `ANTHROPIC_API_KEY` unset; status becomes `needs_input` if zero channels survive the real-readiness filter.

#### `POST /api/marketing?resource=idea_create_campaign`
**Auth:** Bearer Supabase token.
**Purpose:** Turns a `brief_ready` idea into a real draft campaign — only for Email/Text Messages (the only channels with an automated send path today).

**Request body / query params:**
- `ideaId` (string, required)
- `channel` (string, optional) — must match one of the idea's automatable recommended channel labels

**Response:**
```json
{ "ok": true, "campaignId": "...", "campaign": {}, "channel": "Email" }
```
Notes: 409 if the idea already has a campaign, isn't `brief_ready`, or has no automatable channel.

### Lifecycle Playbooks & Auto-Send

#### `GET /api/marketing?resource=lifecycle_candidates`
**Auth:** Bearer Supabase token.
**Purpose:** Read-only: returns real, consent/suppression-gated candidates for one of 7 lifecycle playbooks. Never creates or sends anything.

**Request body / query params:**
- `playbook` (string, required, query) — one of `post_job_thank_you`, `service_anniversary`, `dormant_reactivation`, `maintenance_reminders`, `new_lead_followup`, `newsletter`, `referral`

**Response:**
```json
{ "ok": true, "playbook": "post_job_thank_you", "candidates": [{ "jobId": "...", "clientId": "...", "clientName": "...", "jobTitle": "...", "completedAt": "..." }], "windowDays": 14, "totalCompletedJobsInWindow": 0, "skippedNoClient": 0, "skippedAlreadyContacted": 0, "skippedSuppressedOrRevoked": 0, "skippedNoEmail": 0 }
```
Notes: windows/eligibility differ per playbook (e.g. `post_job_thank_you` = 14 days after completion; `service_anniversary` = 350–380 days; `dormant_reactivation` = 24–60 months since a client's last job; `maintenance_reminders` = annual 330–395 day window keyed to maintenance-keyword job titles; `new_lead_followup` = `lead_pipeline` stage `new` older than 24h; `newsletter` = all active clients not contacted in 25 days; `referral` = 14–120 days after completion). Six of the seven playbooks' campaign `type` values are not yet in the `campaigns.type` CHECK constraint (migrations written, not applied) — only `referral` can be sent today.

#### `GET /api/marketing?resource=process_review_request_autosend` (cron)
**Auth:** `CRON_SECRET` bearer bypass (falls through to `requireUser` otherwise).
**Purpose:** Turns real, aged review-ask candidates into a sent campaign automatically. No-op unless `REVIEW_REQUEST_AUTOSEND_DAYS` and `GOOGLE_REVIEW_LINK` are both set.

**Response:** same shape as `campaign_send`'s response, or `{ "ok": true, "sent": 0, "message": "..." }` if not configured / nothing eligible.

#### `GET /api/marketing?resource=process_post_job_thank_you_autosend` / `process_service_anniversary_autosend` / `process_dormant_reactivation_autosend` / `process_maintenance_reminders_autosend` / `process_new_lead_followup_autosend` / `process_newsletter_autosend` / `process_referral_autosend` (crons)
**Auth:** `CRON_SECRET` bearer bypass.
**Purpose:** Each turns its matching `lifecycle_candidates` playbook into a real, sent campaign, gated behind its own `LIFECYCLE_AUTOSEND_<PLAYBOOK>` env var (must be `1`/`true`); `dormant_reactivation` additionally requires the `dormant_client_reengage` Company Setup automation toggle to be on. Reuses the exact `handleCampaignsPost`/`handleCampaignSendPost` pipeline, so suppression/consent/activity-log behavior is identical to a manual send.

**Response:** `{ "ok": true, "sent": 0, "message": "<ENV_VAR> is not set -- ... auto-send is off." }` when disabled, else the real `campaign_send` result shape.

### Attribution & Schedule

#### `GET /api/marketing?resource=attribution`
**Auth:** Bearer Supabase token.
**Purpose:** Real first-touch, last-touch, and assisted-conversion attribution computed live from `campaigns`/`campaign_recipients`/`jobs` — a job's "touch" is a real campaign send on/before its completion date. Spend/impressions/clicks/CPL are explicitly reported as not-yet-measurable (no ad platform connected for this view).

**Response:**
```json
{ "ok": true, "source": "HiveLogic (real campaigns + campaign_recipients + jobs, first-touch attribution model)", "campaigns": [{ "campaignId": "...", "name": "...", "type": "...", "channel": "...", "recipientsSent": 0, "respondedCount": 0, "bookedCount": 0, "firstTouchJobCount": 0, "firstTouchRevenueCents": 0 }], "totalAttributedJobs": 0, "totalUnattributedJobs": 0, "totalAttributedRevenueCents": 0, "totalAllRevenueCents": 0, "attributionCoveragePct": null, "notYetMeasurable": ["spend", "impressions", "video_views", "clicks", "calls", "forms", "cost_per_qualified_lead", "cost_per_estimate", "cost_per_sold_job"], "notYetMeasurableReason": "...", "lastTouch": { "campaigns": [], "totalAttributedJobs": 0 }, "assisted": { "campaigns": [], "totalMultiTouchJobs": 0, "totalAssistedConversions": 0 } }
```

#### `POST /api/marketing?resource=attribution_snapshot`
**Auth:** Bearer Supabase token.
**Purpose:** Appends a point-in-time snapshot of lead/revenue attribution into `marketing_lead_attributions`/`marketing_revenue_attributions` (schema-only tables today, nothing else writes to them). Explicit, repeatable, append-only — never overwrites.

**Response:**
```json
{ "ok": true, "capturedAt": "...", "leadAttributionRowsInserted": 0, "revenueAttributionRowsInserted": 0, "notSynced": [], "note": null }
```

#### `GET /api/marketing?resource=schedule`
**Auth:** Bearer Supabase token.
**Purpose:** Rolling window of real scheduled campaign sends (from `campaigns.scheduled_at`) for the Calendar tab.

**Request body / query params:**
- `days` (number, optional, query; 1–180, default 90)
- `pastDays` (number, optional, query; 0–90, default 7)

**Response:**
```json
{ "ok": true, "windowStart": "...", "windowEnd": "...", "events": [{ "id": "...", "kind": "campaign_send", "campaignId": "...", "name": "...", "type": "...", "channel": "...", "status": "...", "scheduledAt": "..." }], "notYetTracked": ["organic_posts", "videos", "website_promotions", "landing_page_launches", "review_campaigns", "content_production_deadlines", "promo_expirations"] }
```

---

## api/marketing-unsubscribe.js — Public Unsubscribe Link

### `GET /api/marketing-unsubscribe?c=<clientId>&ch=<channel>&s=<signature>`
**Auth:** **None.** This endpoint has no login of any kind — it is reached by clicking the unsubscribe link embedded in every marketing email, and the recipient is not a HiveLogic user. Confirmed: the only protection is the link's own HMAC-SHA256 signature (`signUnsubscribe(clientId, channel)`, keyed by `MARKETING_UNSUBSCRIBE_SECRET` or falling back to `SUPABASE_SERVICE_KEY`), checked with `crypto.timingSafeEqual`. This is intentional — it's the "public unsubscribe-link pattern," not an oversight.
**Purpose:** Verifies the signed link and records a `marketing_suppressions` row so the recipient never gets another marketing email/SMS on that channel; returns an HTML confirmation page (not JSON).

**Request body / query params:**
- `c` (string, required, query) — client ID
- `ch` (string, required, query) — channel (e.g. `email`)
- `s` (string, required, query) — HMAC signature

**Response:** `text/html` page, not JSON — status 200 "You have been unsubscribed" on success, 400 "Invalid link" if params are missing or the signature doesn't verify, 500 "Something went wrong" on a real write failure, 405 for any non-GET method.

Notes: This endpoint can only ever *write a suppression record* — it never sends email/SMS itself (the file's own header calls this out as "the opposite of a send path"). Every real send path in `api/marketing.js` (`campaign_send`, all lifecycle auto-sends) checks `marketing_suppressions` before sending, so a suppression recorded here is honored everywhere.

---

## api/social-posts.js — Organic Social Posting

Reached as `GET`/`POST /api/social-posts?resource=<name>`. A separate subsystem
from `api/ads.js` — this posts real, unpaid content to a Facebook Page,
Instagram, or TikTok profile, with no budget/targeting/"campaign" concept.
Mirrors the `ad_campaigns` draft → review → [schedule] → publish state
machine against the new `social_posts` table (`sql/059`) instead.

**Auth (all except the cron):** Bearer Supabase token via `requireUser()`
(`api/_lib/require-user.js`) — 401 `{ "ok": false, "error": "Not authenticated. Sign in and try again." }` if missing.

#### `GET /api/social-posts?resource=social_posts[&platform=][&status=]`
**Purpose:** Lists real `social_posts` rows, optionally filtered by platform or status.

**Request body / query params:**
- `platform` (string, optional, query)
- `status` (string, optional, query)

**Response:**
```json
{ "ok": true, "posts": [] }
```

#### `POST /api/social-posts?resource=social_post_draft`
**Purpose:** Creates a draft social post for one surface.

**Request body / query params:**
- `surface` (string, required) — `facebook_page`|`instagram`|`tiktok_video`
- `postType` (string, required) — must be in that surface's allowed set: Facebook Page = `text`|`link`; Instagram = `image`|`video`; TikTok = `video` (Instagram/TikTok have no text-only post type)
- `text` (string, optional, ≤5000 chars) — required for `text`/`link` posts
- `linkUrl`, `mediaUrl`, `mediaType` (strings, optional) — `mediaUrl` required for `image`/`video` posts (no asset-upload pipeline exists, so a missing `mediaUrl` is refused with 400 rather than faked)

**Response:**
```json
{ "ok": true, "post": { "tenant_id": "ghgrp", "platform": "meta", "surface": "facebook_page", "post_type": "text", "content": {}, "status": "draft", "created_by": "reina" } }
```

#### `POST /api/social-posts?resource=social_post_review`
**Purpose:** Approves or rejects a draft. Approving re-checks content completeness, then moves the post straight to `scheduled` in one click — Reina auto-picks the next sensible send slot per surface (spread across preferred America/New_York hours, ≥90 min lead, ≥3h gap from same-surface posts) unless a future `scheduledFor` is passed explicitly.

**Request body / query params:**
- `postId` (string, required)
- `decision` (string, required) — `approve`|`reject`
- `reason` (string, optional, ≤2000 chars) — used on reject
- `scheduledFor` (string ISO date, optional) — future date overrides Reina's auto-pick on approve

**Response:**
```json
{ "ok": true, "postId": "...", "status": "scheduled", "scheduledFor": "...", "autoScheduled": true }
```
or on reject: `{ "ok": true, "postId": "...", "status": "rejected" }`.

#### `POST /api/social-posts?resource=social_post_schedule`
**Purpose:** Moves an approved (or already-scheduled) post to a specific future timestamp — overrides or reschedules Reina's auto-pick.

**Request body / query params:**
- `postId` (string, required)
- `scheduledFor` (string ISO date, required, must be in the future)

**Response:**
```json
{ "ok": true, "postId": "...", "status": "scheduled", "scheduledFor": "..." }
```

#### `POST /api/social-posts?resource=social_post_publish`
**Purpose:** The real platform action — publishes a `pending_review` or due `scheduled` post right now. Facebook Page/Instagram go through the Meta Graph API; TikTok goes through TikTok's Content Posting API. Requires that surface's connection to be `launch_enabled`.

**Request body / query params:**
- `postId` (string, required)

**Response:**
```json
{ "ok": true, "postId": "...", "status": "posted", "publishResult": { "externalPostId": "..." } }
```
Notes: 409 if the connection isn't ready (`connectionNotReady`); 502 with a `classified` connection-issue state on a real platform failure, which is also recorded onto `ad_platform_connections`. Facebook Page/Instagram reuse the same `ad_platform_connections` row (`platform='meta'`) the ads system uses; TikTok organic posting uses its own separate `platform='tiktok_content'` row (different OAuth app/scopes from TikTok Ads).

#### `GET /api/social-posts?resource=process_scheduled_posts` (cron)
**Auth:** `CRON_SECRET` bearer bypass (`Authorization: Bearer <CRON_SECRET>`); falls through to the normal `requireUser` gate otherwise.
**Purpose:** Runs every 15 minutes (`vercel.json`); publishes every `scheduled` post whose `scheduled_for` has passed, best-effort (one failure never blocks the rest).

**Response:**
```json
{ "ok": true, "processed": 0, "succeeded": 0, "failed": 0, "results": [{ "postId": "...", "ok": true, "externalPostId": "..." }] }
```

---

## api/tiktok/connect.js and api/tiktok/callback.js — TikTok Content Posting OAuth

This is TikTok's **Content Posting API** (organic posting) OAuth flow —
explicitly a separate app/credentials/scopes from any TikTok **Ads Marketing
API** connection (`platform='tiktok'` in `ad_platform_connections`, used by
`api/ads.js`). This pair only ever grants permission to *post organic video
content and read basic profile info* — never ad account access, ad spend, or
ad reporting.

### `GET /api/tiktok/connect`
**Auth:** `requireApiAuth(req)` (`api/_lib/guard.js`) — must be a signed-in employee; returns 401 JSON if not (same rule as every other `connect.js` in this repo, e.g. `api/jobber/connect.js`).
**Purpose:** Starts the TikTok Content Posting OAuth flow by building TikTok's `/v2/auth/authorize/` URL with a single-use, user-bound CSRF state token.

**Request body / query params:** none. Dual response mode based on `Accept` header.

**Response:**
- If `Accept: application/json`: `{ "ok": true, "url": "https://www.tiktok.com/v2/auth/authorize/?..." }` (lets an authenticated `fetch` caller navigate the top window itself, since it can't follow a cross-origin 302).
- Otherwise: HTTP 302 redirect to that same URL.
- 500 `<h2>TIKTOK_CLIENT_KEY is not set for this deployment.</h2>` if the env var is missing.

Notes: requested scope is `user.info.basic,video.publish,video.upload` — confirms this grants posting + basic profile read only, nothing ad-related. State is issued via `issueOAuthState({ provider: 'tiktok_content', userId })`.

### `GET /api/tiktok/callback`
**Auth:** None — this is TikTok's own OAuth redirect target, not something a user navigates to directly. Protected instead by `consumeOAuthState({ provider: 'tiktok_content', state })`, which single-use-validates the CSRF state token issued by `connect.js` (invalid/reused state redirects to `/?tiktok_error=invalid_state_<reason>` rather than proceeding).
**Purpose:** Exchanges TikTok's one-time authorization `code` for a real access + refresh token, persists both (encrypted) via `saveTikTokTokens()`, and upserts the `ad_platform_connections` row for `platform='tiktok_content'` straight to `state: 'launch_enabled'` — no manual token-copying step for Chris.

**Request body / query params (all query string, from TikTok's redirect):**
- `code` (string, required unless `error` is present)
- `state` (string, required) — CSRF token from `connect.js`
- `error` (string, optional) — if present, redirects to `/?tiktok_error=<error>` immediately

**Response:** Not JSON.
- Success: HTTP 200 HTML page "TikTok connected ✓" (`Content-Type: text/html`, `Cache-Control: no-store`), noting the access token auto-refreshes every 24h.
- Failure: HTTP redirects to `/?tiktok_error=token_exchange_failed`, `/?tiktok_error=token_storage_failed:%20<message>`, or `/?tiktok_error=unexpected`.
- Missing code with no error: HTTP 400 plain text `"Missing authorization code from TikTok."`.

Notes: token exchange POSTs to `https://open.tiktokapis.com/v2/oauth/token/` with `client_key`/`client_secret`/`code`/`grant_type=authorization_code`/`redirect_uri` (`TIKTOK_CONTENT_REDIRECT_URI` env, defaulting to `https://hivelogic-live.vercel.app/api/tiktok/callback`). The upsert writes `scopes` (parsed from the token response's `scope` field), never a hardcoded guess.

---

## api/ads.js — Paid Ads Platform Integration (Meta, Google Ads, TikTok Ads)

Reached as `GET`/`POST /api/ads?resource=<name>`. This is the **paid** ads
system — distinct from the organic `api/social-posts.js` above. Confirmed:
**yes, this calls real ad platform APIs.** Meta goes through the Graph API,
Google Ads through the Google Ads REST API, and TikTok through TikTok's Ads
API — all three (`meta`, `google_ads`, `tiktok`) are in `LIVE_PLATFORMS` with
real launch/pause/spend-sync adapters wired up (`api/_lib/ad-platform-*.js`),
though the file's own header notes none of the three launch codepaths have
ever been exercised against a real ad account yet. TikTok Ads launch
additionally refuses honestly (no fabricated creative) when there's no real
uploaded media asset ID, since this build has no asset-upload pipeline.

**Auth (all resources):** Bearer Supabase token via `requireUser()`
(`api/_lib/require-user.js`) — 401 if missing/invalid.

#### `GET /api/ads?resource=ad_connections`
**Purpose:** Current connection state of all 3 ad platforms (`not_connected` if no row exists yet).

**Response:**
```json
{ "ok": true, "connections": [{ "platform": "meta", "label": "Meta (Facebook + Instagram)", "state": "not_connected", "businessAccountId": null, "adAccountId": null, "lastVerifiedAt": null, "lastError": null, "isIssue": false }] }
```

#### `POST /api/ads?resource=ad_connection_transition`
**Purpose:** Moves one ad platform's connection through the same connect → verify-reporting → verify-draft → enable-launch state machine `api/marketing.js` uses for marketing channels.

**Request body / query params:**
- `platform` (string, required) — `meta`|`google_ads`|`tiktok`
- `toState` (string, required) — one of `CONNECTION_STATES`
- `note` (string, optional, max 500 chars)
- `envVarName` (string, optional) — defaults to `AD_<PLATFORM>_CONNECTION`

**Response:**
```json
{ "ok": true, "platform": "meta", "fromState": "not_connected", "toState": "setup_incomplete", "connections": [] }
```
Notes: 409 if the transition isn't legal for the current state.

#### `GET /api/ads?resource=ad_campaigns[&platform=][&status=]`
**Purpose:** Lists real `ad_campaigns` rows, optionally filtered.

**Response:**
```json
{ "ok": true, "campaigns": [] }
```

#### `POST /api/ads?resource=ad_campaign_draft`
**Purpose:** Creates a draft ad campaign. If `adCopy` is omitted, ad copy is AI-generated, grounded only in real division job facts + real service-territory facts (`api/_lib/ad-copy-grounding.js`) — never fabricated.

**Request body / query params:**
- `platform` (string, required) — `meta`|`google_ads`|`tiktok`
- `objective` (string, required) — `lead_gen`|`traffic`|`awareness`|`conversions`
- `division` (string, required) — must be in `KNOWN_DIVISIONS`
- `dailyBudgetCents` (number, required, ≥0)
- `adCopy` (object, optional) — `{ headline, primaryText, description, cta }` (all strings, all required together if provided)

**Response:**
```json
{ "ok": true, "campaign": { "tenant_id": "ghgrp", "platform": "meta", "objective": "lead_gen", "name": "...", "status": "draft", "daily_budget_cents": 0, "targeting_summary": { "division": "...", "divisionFacts": {}, "territoryFacts": {} }, "ad_copy": {}, "created_by": "reina" } }
```
Notes: 409 if `ANTHROPIC_API_KEY` is unset and no manual `adCopy` was given.

#### `POST /api/ads?resource=ad_campaign_review`
**Purpose:** Approves (moves `draft` → `pending_review`, only after a real budget-headroom check via `api/_lib/ad-budget-governor.js` passes) or rejects a draft campaign. Neither touches a real platform.

**Request body / query params:**
- `campaignId` (string, required)
- `decision` (string, required) — `approve`|`reject`
- `reason` (string, optional, ≤2000 chars) — used on reject

**Response:**
```json
{ "ok": true, "campaignId": "...", "status": "pending_review", "budgetCheck": { "allowed": true } }
```
or on reject: `{ "ok": true, "campaignId": "...", "status": "rejected" }`.

#### `POST /api/ads?resource=ad_campaign_launch`
**Purpose:** The first real platform action — launches an approved (`pending_review`) campaign for real on Meta, Google Ads, or TikTok Ads. Requires the connection to be `launch_enabled`, real credentials present, and re-checks budget headroom.

**Request body / query params:**
- `campaignId` (string, required)
- `linkUrl` (string, optional) — defaults to `https://ghgrp.net`

**Response:**
```json
{ "ok": true, "campaignId": "...", "status": "active", "launchResult": { "externalCampaignId": "..." } }
```
Notes: 502 with a `classified` connection-issue state (`needs_reauth`/`policy_blocked`/`billing_blocked`/`needs_attention`) on a real launch failure, which is also recorded onto `ad_platform_connections`, leaving the campaign in `pending_review` for retry.

#### `POST /api/ads?resource=ad_campaign_pause`
**Purpose:** Pauses a real, currently `active` campaign on its platform. Only an active campaign with a real `external_campaign_id` can be paused.

**Request body / query params:**
- `campaignId` (string, required)
- `reason` (string, optional, ≤2000 chars) — echoed back, not persisted (no pause-reason column exists on `ad_campaigns`)

**Response:**
```json
{ "ok": true, "campaignId": "...", "status": "paused", "reason": null }
```

#### `POST /api/ads?resource=ad_spend_sync`
**Purpose:** Pulls that day's real reported spend for a launched campaign from the platform's own reporting endpoint and upserts it into `ad_spend_ledger` (the same table the budget governor sums against the cap). Never estimates a number.

**Request body / query params:**
- `campaignId` (string, required)
- `date` (string `YYYY-MM-DD`, optional) — defaults to today UTC

**Response:**
```json
{ "ok": true, "campaignId": "...", "date": "...", "spendCents": 0, "ledgerRow": {} }
```

Notes on credential shapes (relevant to why launch/pause/spend-sync behave
differently per platform): Meta's single access token lives directly in the
named env var (`ad_account_id`/`page_id` columns supply the rest). Google
Ads' `env_var_name` must point to a JSON blob
`{"developerToken","clientId","clientSecret","refreshToken"}` — four secrets,
not one token — with `ad_account_id` as the Google Ads Customer ID and
`business_account_id` as the optional MCC ID. TikTok Ads' credential shape
matches Meta's (single token + `ad_account_id` reused as the Advertiser ID),
with `page_id` reused as the real TikTok Identity ID required for ad-creative
attribution.
