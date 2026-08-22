// api/reina/mail-triage.js
//
// Reina inbox triage -- read the caller's unread mail, label each message by
// what it wants from him, and remember every correction.
//
// Chris, 2026-08-17: "what about Reina reading my emails and determining what's
// needing a response and what needs scheduling and what needs action, flagging
// junk and learning to get better at managing my inbox each day?"
//
// THIS ROUTE MOVES NO MAIL. It reads, it labels, it records what a human chose.
// Reading a mailbox is reversible; archiving the wrong message is not, so the
// one-tap actions (draft a reply, push to Team To-Do, put it on the calendar,
// archive the junk) are a separate, deliberate step -- never something a
// confidence score decides on its own.
//
// Actions:
//   POST ?action=list     -> triage the caller's unread inbox; returns the list
//   POST ?action=correct  -> {messageId, label} record a re-label + learn from it
//
// ON-DEMAND BY DESIGN. Chris chose "only when I look" over a schedule: no cron,
// no unattended spend, nothing running while he sleeps. Every classification on
// this path is one he asked for by opening the page.
//
// COST. Three things keep this from being "one model call per email forever":
//   1. A verdict is written once per message and never re-derived.
//   2. A standing correction answers before the model, so a sender he has
//      already judged never costs a call again.
//   3. What is left goes to the model in batches sharing one system prompt.
// The practical result is that the second look at a day's mail is nearly free,
// and a steady inbox converges toward costing almost nothing.

import { supabaseRequest as defaultSupabaseRequest } from '../_lib/jobber.js';
import { requireApiAuth } from '../_lib/guard.js';
import { encryptSecret, decryptSecret } from '../_lib/secrets.js';
import { mailboxAccessToken } from '../_lib/ms-mailbox-tokens.js';
import { htmlToText } from './_m365-pull.js';
import {
  classifyMailBatch, chunkForTriage, matchTriageRule, ruleFromCorrection,
  isMailTriageLabel, sortTriageRows, MAIL_TRIAGE_EXAMPLE_LIMIT, mailTriageModel,
  briefMessage, unsubscribeFromHeaders, safeUnsubscribeUrl,
} from '../_lib/mail-triage.js';

// WHAT COUNTS AS "NEEDS TRIAGING" (Chris, 2026-08-17: "why not have it read
// all of today's emails even if they're shown read").
//
// The first version read unread mail only, which was a lazy proxy: he reads
// mail on his phone all day, so "read" marks what his EYES have been over, not
// what he has DEALT WITH. A client question he glanced at in a truck at 8am is
// exactly the thing this page exists to catch, and it was being skipped.
//
// So the rule is two clauses, either of which qualifies a message:
//   * it arrived TODAY -- read or not. Today is the day being managed.
//   * it is still UNREAD within the lookback -- yesterday's unhandled mail
//     does not stop mattering at midnight.
// Older mail he has already read is neither: that is archaeology.
export const MAIL_TRIAGE_LOOKBACK_DAYS = 30;
export const MAIL_TRIAGE_MAX_MESSAGES = 100;
export const MAIL_TRIAGE_BUSINESS_TZ = 'America/New_York';

// Midnight today in the business's own timezone, as an instant. Derived by
// subtracting the seconds already elapsed in the local day, which is exact
// without needing to reason about UTC offsets or DST.
export function startOfBusinessDayMs(nowMs, timeZone = MAIL_TRIAGE_BUSINESS_TZ) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(nowMs));
  const get = (t) => Number((parts.find((p) => p.type === t) || {}).value || 0);
  const elapsed = (get('hour') % 24) * 3600 + get('minute') * 60 + get('second');
  return nowMs - elapsed * 1000;
}

function jsonError(res, code, error, extra = {}) {
  return res.status(code).json({ ok: false, error, ...extra });
}

// ---- Graph ------------------------------------------------------------------

async function mailboxRowsFor(ownerId, deps) {
  const r = await deps.supabaseRequest(
    `hc_ms_tokens?owner_id=eq.${encodeURIComponent(ownerId)}` +
    '&select=home_account_id,username,name,access_token,refresh_token,expires_at&order=updated_at.desc'
  );
  if (!r.ok) throw new Error((await r.text()).slice(0, 160));
  return (await r.json()) || [];
}

// Where this mailbox's last scan got to. Derived from the verdicts already
// stored rather than from a "last run" column, which means it is self-healing:
// if a scan half-finished, or a write failed, the watermark simply has not
// moved and the next scan picks those messages up again. A column would have
// recorded "scanned" for mail that never actually got a verdict.
export function scanWatermarkMs(storedRows, homeAccountId) {
  let newest = 0;
  for (const r of storedRows || []) {
    if (homeAccountId && r.home_account_id && r.home_account_id !== homeAccountId) continue;
    const t = Date.parse(r.received_at || '');
    if (!isNaN(t) && t > newest) newest = t;
  }
  return newest;
}

// The window this scan should cover for one mailbox.
//
// Chris, 2026-08-17: "every email that hasn't been read and scanned by reina...
// let's say I don't check in with reina for 3 days, she'll go back and check
// all from the last read email."
//
// So the window starts at whichever is EARLIER: the start of today, or where
// the last scan got to. Check in daily and it is today's mail; disappear for
// three days and it reaches back across all three. An hour of overlap covers
// mail that lands out of order, and the lookback is a hard floor so a mailbox
// scanned for the first time does not try to swallow its entire history.
export function scanWindowStartMs(nowMs, watermarkMs, lookbackDays = MAIL_TRIAGE_LOOKBACK_DAYS) {
  const floor = nowMs - lookbackDays * 86400000;
  const today = startOfBusinessDayMs(nowMs);
  const fromWatermark = watermarkMs ? watermarkMs - 3600000 : today;
  return Math.max(floor, Math.min(today, fromWatermark));
}

// Inbox mail from ONE mailbox inside the scan window, newest first.
//
// READ MAIL COUNTS. The first version asked Graph for unread only, which was a
// lazy proxy: Chris reads mail on his phone all day, so "read" marks what his
// eyes have passed over, not what he has dealt with. A client question glanced
// at in a truck at 8am is exactly what this page exists to catch.
//
// `internetMessageId` is what we key on -- it survives the message being filed,
// which is what lets a verdict be written once and stay attached.
async function recentFrom(row, ownerId, sinceISO, deps) {
  const minted = await mailboxAccessToken(row, {
    encryptSecret, decryptSecret,
    patchTokens: (patch) => deps.supabaseRequest(
      `hc_ms_tokens?owner_id=eq.${encodeURIComponent(ownerId)}&home_account_id=eq.${encodeURIComponent(row.home_account_id)}`,
      { method: 'PATCH', body: JSON.stringify(patch) }
    ),
  });
  // ONE property in $filter, and $orderby on that same property. Graph rejects
  // a filter on one property ordered by another ("the restriction or sort order
  // is too complex") -- which is exactly what `isRead eq false and
  // receivedDateTime ge X` + `$orderby=receivedDateTime` did, and why the first
  // live run returned nothing at all.
  let url = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages' +
    '?$top=50' +
    `&$filter=receivedDateTime ge ${encodeURIComponent(sinceISO)}` +
    '&$orderby=receivedDateTime desc' +
    '&$select=id,internetMessageId,subject,from,receivedDateTime,bodyPreview,webLink,isRead';

  // A three-day catch-up is more than one page. Follow nextLink until the cap,
  // so "I didn't check in all week" does not silently become "the newest 50".
  const out = [];
  let pages = 0;
  while (url && out.length < MAIL_TRIAGE_MAX_MESSAGES && pages < 10) {
    const gRes = await deps.fetchImpl(url, { headers: { Authorization: 'Bearer ' + minted.accessToken } });
    const data = await gRes.json().catch(() => ({}));
    if (!gRes.ok) throw new Error((data.error && data.error.message) || `inbox read failed (${gRes.status})`);
    for (const m of data.value || []) {
      out.push({
        messageId: m.internetMessageId || m.id,
        graphId: m.id,
        homeAccountId: row.home_account_id,
        subject: m.subject || '',
        fromAddress: (m.from && m.from.emailAddress && m.from.emailAddress.address) || '',
        fromName: (m.from && m.from.emailAddress && m.from.emailAddress.name) || '',
        receivedAt: m.receivedDateTime || null,
        preview: m.bodyPreview || '',
        webLink: m.webLink || null,
        isRead: m.isRead === true,
      });
    }
    url = data['@odata.nextLink'] || null;
    pages++;
  }
  return { messages: out.slice(0, MAIL_TRIAGE_MAX_MESSAGES), truncated: !!url };
}

// ---- storage ----------------------------------------------------------------

async function storedVerdicts(ownerId, deps) {
  const r = await deps.supabaseRequest(
    `reina_mail_triage?owner_id=eq.${encodeURIComponent(ownerId)}&select=*&order=received_at.desc&limit=500`
  );
  if (!r.ok) throw new Error((await r.text()).slice(0, 160));
  return (await r.json()) || [];
}

async function standingRules(ownerId, deps) {
  const r = await deps.supabaseRequest(
    `reina_mail_triage_rules?owner_id=eq.${encodeURIComponent(ownerId)}&select=*&limit=500`
  );
  if (!r.ok) return [];   // rules are an optimization; losing them costs money, not correctness
  return (await r.json()) || [];
}

async function recentCorrections(ownerId, deps) {
  const r = await deps.supabaseRequest(
    `reina_mail_triage?owner_id=eq.${encodeURIComponent(ownerId)}&corrected_at=not.is.null` +
    `&select=subject,from_address,label,corrected_label&order=corrected_at.desc&limit=${MAIL_TRIAGE_EXAMPLE_LIMIT}`
  );
  if (!r.ok) return [];
  return (await r.json()) || [];
}

function verdictRow(ownerId, msg, verdict) {
  return {
    owner_id: ownerId,
    message_id: msg.messageId,
    graph_id: msg.graphId,
    home_account_id: msg.homeAccountId,
    subject: (msg.subject || '').slice(0, 500),
    from_address: msg.fromAddress || null,
    from_name: (msg.fromName || '').slice(0, 200) || null,
    received_at: msg.receivedAt,
    web_link: msg.webLink,
    label: verdict.label,
    confidence: null,
    reason: verdict.reason || null,
    model: verdict.model || null,
    source: verdict.source,
  };
}

// Rules first, then the model, then store. Shared by the Microsoft path (which
// fetches its own mail) and the IMAP path (where the browser hands the mail in),
// so both inboxes are judged by exactly the same standard and one cannot drift
// into being labelled more leniently than the other.
async function judgeAndStore(ownerId, messages, known, rules, deps) {
  // Anything already judged stays judged. Re-deriving a verdict would both cost
  // money and quietly overwrite a correction Chris made.
  //
  // ONE ENTRY PER MESSAGE, NOT PER COPY. Mail sent to both of Chris's Microsoft
  // addresses arrives as a copy in each mailbox, and both copies share one
  // internetMessageId -- which is the key this table is unique on. Two rows with
  // the same key in a single upsert is a hard Postgres error, not a merge:
  //
  //   21000 -- "ON CONFLICT DO UPDATE command cannot affect row a second time...
  //             Ensure that no rows proposed for insertion within the same
  //             command have duplicate constrained values"
  //
  // and it fails the WHOLE batch, not the duplicate. That is why the triage
  // table held fifty Gmail rows and not one Microsoft row: every Microsoft scan
  // paid the model, showed the labels, and threw all of them away on the write.
  // It only became visible on 2026-08-18, when the swallowed store error was
  // finally surfaced in the header. The list dedupes copies already; the write
  // has to as well.
  const seenFresh = new Set();
  const fresh = messages.filter((m) => {
    if (known.has(m.messageId) || seenFresh.has(m.messageId)) return false;
    seenFresh.add(m.messageId);
    return true;
  });

  // Standing corrections answer first -- free, instant, and impossible to
  // contradict, which is the whole point of having made the correction.
  const byRule = [];
  const forModel = [];
  for (const m of fresh) {
    const rule = matchTriageRule(m, rules);
    if (rule) byRule.push({ msg: m, verdict: { label: rule.label, reason: 'you set this for ' + rule.match_value, source: 'rule' }, rule });
    else forModel.push(m);
  }

  let modelVerdicts = [];
  let classifyError = null;
  if (forModel.length) {
    const corrections = await recentCorrections(ownerId, deps);
    const batches = chunkForTriage(forModel);
    const results = await Promise.all(batches.map((b) =>
      classifyMailBatch(b, { anthropic: deps.anthropic, corrections })
        .then((v) => ({ ok: true, verdicts: v }))
        .catch((e) => ({ ok: false, error: e }))));
    modelVerdicts = results.filter((r) => r.ok).flatMap((r) => r.verdicts);
    const failed = results.filter((r) => !r.ok);
    // A batch that failed leaves its messages unlabelled. Say so rather than
    // presenting a short list as the whole inbox.
    if (failed.length) {
      classifyError = String(failed[0].error && failed[0].error.message || 'classification failed').slice(0, 160);
    }
  }

  const byId = new Map(fresh.map((m) => [m.messageId, m]));
  const toInsert = [
    ...byRule.map((b) => verdictRow(ownerId, b.msg, b.verdict)),
    ...modelVerdicts.map((v) => verdictRow(ownerId, byId.get(v.messageId), v)).filter((r) => r.message_id),
  ];
  return { fresh, byRule, modelVerdicts, classifyError, toInsert };
}


// ---- pre-writing the replies ------------------------------------------------
//
// Chris, 2026-08-17: "the replies should be written already by reina for review".
//
// Drafting used to be on-demand: tap, wait for a model call, get a composer.
// That is a fine interaction and the wrong default -- the point of this list is
// to be readable in one pass, and "tap each one to find out what she would say"
// is not one pass.
//
// So every needs_reply message gets a draft written the FIRST time it is
// triaged, and the draft is stored. Same rule as the verdict: written once,
// never re-derived. The second look at a day's mail costs nothing, and a draft
// he has started editing is never overwritten underneath him.
//
// Bounded on purpose. Drafting is the expensive half -- one full message body
// and one model call EACH, where classification shares a prompt across 25. The
// cap keeps a 200-message catch-up from turning into 200 drafts in one request;
// the rest get written on the next look, oldest first.
export const MAIL_TRIAGE_DRAFT_LIMIT = 12;

async function prewriteReplies(ownerId, rows, mailboxes, deps) {
  const needing = rows
    .filter((r) => (r.corrected_label || r.label) === 'needs_reply')
    .filter((r) => !r.draft_text && !r.draft_error)
    // An IMAP mailbox cannot be opened from the server, so its body never
    // arrives here. Those keep the on-tap path, where the browser couriers it.
    .filter((r) => r.graph_id && r.home_account_id && !String(r.home_account_id).startsWith('imap:'))
    .slice(0, MAIL_TRIAGE_DRAFT_LIMIT);
  if (!needing.length) return [];

  const written = await Promise.all(needing.map(async (row) => {
    try {
      const box = mailboxes.find((m) => m.home_account_id === row.home_account_id);
      if (!box) throw new Error('mailbox no longer connected');
      const minted = await mailboxAccessToken(box, {
        encryptSecret, decryptSecret,
        patchTokens: (patch) => deps.supabaseRequest(
          `hc_ms_tokens?owner_id=eq.${encodeURIComponent(ownerId)}&home_account_id=eq.${encodeURIComponent(box.home_account_id)}`,
          { method: 'PATCH', body: JSON.stringify(patch) }
        ),
      });
      const gRes = await deps.fetchImpl(
        `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(row.graph_id)}?$select=body,bodyPreview`,
        { headers: { Authorization: 'Bearer ' + minted.accessToken } }
      );
      const msg = await gRes.json().catch(() => ({}));
      if (!gRes.ok) throw new Error((msg.error && msg.error.message) || 'the mailbox would not return that message');
      const d = await draftFrom(row, htmlToText((msg.body && msg.body.content) || msg.bodyPreview || ''), deps);
      return { row, draft_text: d.draft, draft_error: null };
    } catch (e) {
      // A message with no draft must say WHY, rather than looking like one
      // Reina simply had nothing to say about.
      return { row, draft_text: null, draft_error: String(e.message || e).slice(0, 200) };
    }
  }));

  const now = new Date().toISOString();
  await Promise.all(written.map((w) => deps.supabaseRequest(
    `reina_mail_triage?owner_id=eq.${encodeURIComponent(ownerId)}&message_id=eq.${encodeURIComponent(w.row.message_id)}`,
    { method: 'PATCH', body: JSON.stringify({ draft_text: w.draft_text, draft_error: w.draft_error, draft_at: now }) }
  ).catch(() => null)));

  for (const w of written) {
    w.row.draft_text = w.draft_text;
    w.row.draft_error = w.draft_error;
    w.row.draft_at = now;
  }
  return written;
}

// ---- classify (the IMAP path) -----------------------------------------------
//
// Chris, 2026-08-17: "now do the gmail inbox."
//
// greenwichhandyman@gmail.com is not a Microsoft mailbox. It is Gmail over
// IMAP, its credentials live in HiveConnect's project under a DIFFERENT account
// id, and it is reachable only through /api/mail's IMAP adapter. Rather than
// teach this route to speak IMAP across a project boundary -- a second mail
// client, a second credential path, a second thing to break -- the browser
// hands the envelopes in. It is already authenticated to /api/mail for exactly
// this mailbox; that is how the mail app reads it today.
//
// WHAT THAT MEANS FOR TRUST: these envelopes are client-supplied. They are
// stored under the caller's own owner_id and shown only back to them, so the
// worst a forged one does is put a wrong row on that person's own list. It is
// not a path to anyone else's data, and it never writes to a mailbox. Fields
// are length-capped and the batch is bounded regardless.
//
// WHAT IT COSTS IN QUALITY, said plainly: the IMAP adapter's envelope list
// carries no body preview, so Gmail messages are judged on sender and subject
// alone. That is a weaker read than the Microsoft mailboxes get, and the row
// says so rather than letting the two look equally considered.
export const MAIL_TRIAGE_CLASSIFY_MAX = 100;

function sanitizeIncoming(m, account) {
  const messageId = String(m.messageId || '').slice(0, 500);
  if (!messageId) return null;
  const s = (v, n) => (v == null ? null : String(v).slice(0, n));
  return {
    messageId,
    graphId: s(m.graphId, 500),
    // The 'imap:' prefix is how every later step knows this row is not a Graph
    // mailbox -- same convention hc_mailbox_links already uses for these.
    homeAccountId: 'imap:' + String(account || '').toLowerCase().slice(0, 200),
    subject: s(m.subject, 500) || '',
    fromAddress: s(m.fromAddress, 320) || '',
    fromName: s(m.fromName, 200) || '',
    receivedAt: s(m.receivedAt, 40),
    preview: s(m.preview, 500) || '',
    webLink: null,
    isRead: m.isRead === true,
  };
}

async function handleClassify(ownerId, body, deps) {
  const account = String(body.account || '').trim().toLowerCase();
  if (!account) { const e = new Error('account is required'); e.status = 400; throw e; }
  const incoming = Array.isArray(body.messages) ? body.messages : null;
  if (!incoming) { const e = new Error('messages must be an array'); e.status = 400; throw e; }
  if (incoming.length > MAIL_TRIAGE_CLASSIFY_MAX) {
    const e = new Error(`at most ${MAIL_TRIAGE_CLASSIFY_MAX} messages at a time`); e.status = 400; throw e;
  }

  const messages = incoming.map((m) => sanitizeIncoming(m, account)).filter(Boolean);
  const [stored, rules] = await Promise.all([storedVerdicts(ownerId, deps), standingRules(ownerId, deps)]);
  const known = new Map(stored.map((r) => [r.message_id, r]));

  const { byRule, modelVerdicts, fresh, classifyError, toInsert } =
    await judgeAndStore(ownerId, messages, known, rules, deps);

  let storeError = null;
  if (toInsert.length) {
    const ins = await deps.supabaseRequest('reina_mail_triage?on_conflict=owner_id,message_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(toInsert),
    });
    if (ins.ok) {
      const saved = await ins.json().catch(() => []);
      for (const row of saved || []) known.set(row.message_id, row);
    } else {
      for (const row of toInsert) known.set(row.message_id, row);
      storeError = `${toInsert.length} verdict${toInsert.length === 1 ? '' : 's'} — ` +
        (await ins.text().catch(() => '')).slice(0, 120);
    }
  }
  if (byRule.length) await bumpRuleHits(byRule.map((b) => b.rule), deps);

  const live = messages.map((m) => {
    const row = known.get(m.messageId);
    return row ? { ...row, is_read: m.isRead === true } : null;
  }).filter(Boolean);


  return {
    ok: true,
    rows: sortTriageRows(live),
    classified: modelVerdicts.length,
    byRule: byRule.length,
    unlabelled: fresh.length - byRule.length - modelVerdicts.length,
    classifyError,
    storeError,
  };
}

// ---- list -------------------------------------------------------------------

// Exported for the unattended sweep (api/reina/mail-sweep.js). It is the same
// pull-and-judge the app does on login, and it needs no session: the mailbox
// tokens live in hc_ms_tokens, not in the caller's browser.
export async function scanMailboxes(ownerId, deps) { return handleList(ownerId, deps); }

async function handleList(ownerId, deps) {
  const mailboxes = await mailboxRowsFor(ownerId, deps);
  if (!mailboxes.length) {
    return { ok: true, rows: [], mailboxesRead: 0, mailboxesTotal: 0, classified: 0,
      note: 'No mailbox connected — connect one in HiveConnect Email.' };
  }

  // The stored verdicts are read FIRST, because they are what says where the
  // last scan got to -- per mailbox, so one mailbox falling behind does not drag
  // the other back over ground it has already covered.
  const [stored, rules] = await Promise.all([storedVerdicts(ownerId, deps), standingRules(ownerId, deps)]);
  const nowMs = Date.now();

  const pulled = await Promise.all(mailboxes.map((m) => {
    const sinceMs = scanWindowStartMs(nowMs, scanWatermarkMs(stored, m.home_account_id));
    return recentFrom(m, ownerId, new Date(sinceMs).toISOString(), deps)
      .then((v) => ({ ok: true, messages: v.messages, truncated: v.truncated, sinceMs }))
      .catch((e) => ({ ok: false, error: e }));
  }));

  const good = pulled.filter((p) => p.ok);
  if (!good.length) {
    const first = pulled.find((p) => p.error);
    const reauth = pulled.every((p) => p.error && p.error.reauth);
    const err = new Error(reauth
      ? 'Mailbox needs reconnecting — open HiveConnect Email.'
      : String((first && first.error && first.error.message) || 'inbox read failed').slice(0, 160));
    err.status = 502;
    throw err;
  }

  const messages = good.flatMap((p) => p.messages);
  const known = new Map(stored.map((r) => [r.message_id, r]));

  const judged = await judgeAndStore(ownerId, messages, known, rules, deps);
  const { byRule, modelVerdicts, fresh, classifyError } = judged;
  const toInsert = judged.toInsert;

  let storeError = null;
  if (toInsert.length) {
    const ins = await deps.supabaseRequest('reina_mail_triage?on_conflict=owner_id,message_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(toInsert),
    });
    if (ins.ok) {
      const saved = await ins.json().catch(() => []);
      for (const row of saved || []) known.set(row.message_id, row);
    } else {
      // The labels are still usable this request even if the write failed --
      // they just cost again next time. Better than showing nothing.
      //
      // BUT SAY SO. This branch used to swallow the failure completely, so a
      // mailbox whose verdicts never reached the database looked exactly like
      // one that was saving fine: same list, same labels, and every correction
      // made against those rows silently landing on nothing.
      for (const row of toInsert) known.set(row.message_id, row);
      storeError = `${toInsert.length} verdict${toInsert.length === 1 ? '' : 's'} — ` +
        (await ins.text().catch(() => '')).slice(0, 120);
    }
  }
  if (byRule.length) await bumpRuleHits(byRule.map((b) => b.rule), deps);

  // The list is what this scan covered. `isRead` comes from the mailbox live
  // rather than from the stored row, because it changes after the verdict was
  // written -- a message read on a phone at lunchtime is still the same message
  // needing the same reply, and the row should say so without pretending the
  // stored copy knew.
  // DEDUPE ACROSS MAILBOXES. Mail sent to both of Chris's addresses lands as a
  // separate copy in each mailbox, but it is ONE message with one
  // internetMessageId -- so the verdict is stored once and, without this, the
  // same row was rendered twice. Seen live 2026-08-17: AnnaMaria's "Re: Service
  // Report" appeared as two identical lines.
  //
  // It counts as read only when he has read it EVERYWHERE, since an unread copy
  // sitting in the other mailbox is still unread mail.
  const seen = new Map();
  for (const m of messages) {
    const row = known.get(m.messageId);
    if (!row) continue;
    const prior = seen.get(m.messageId);
    if (prior) prior.is_read = prior.is_read && m.isRead === true;
    else seen.set(m.messageId, { ...row, is_read: m.isRead === true });
  }
  const live = [...seen.values()];

  // The replies are written HERE, not on tap, so the list is readable in one
  // pass. Failures are recorded on the row rather than thrown -- a missing
  // draft must not cost him the whole triage.
  const drafted = await prewriteReplies(ownerId, live, mailboxes, deps).catch(() => []);

  return {
    ok: true,
    rows: sortTriageRows(live),
    mailboxesRead: good.length,
    mailboxesTotal: mailboxes.length,
    classified: modelVerdicts.length,
    byRule: byRule.length,
    drafted: drafted.filter((d) => d.draft_text).length,
    draftsFailed: drafted.filter((d) => d.draft_error).length,
    unlabelled: fresh.length - byRule.length - modelVerdicts.length,
    // How far back this scan actually reached, so a three-day catch-up is
    // visible as one rather than looking like an unusually busy day.
    scannedSince: new Date(Math.min(...good.map((p) => p.sinceMs))).toISOString(),
    truncated: good.some((p) => p.truncated),
    classifyError,
    storeError,
  };
}

async function bumpRuleHits(rules, deps) {
  await Promise.all(rules.map((r) => deps.supabaseRequest(
    `reina_mail_triage_rules?id=eq.${encodeURIComponent(r.id)}`,
    { method: 'PATCH', body: JSON.stringify({ hits: (Number(r.hits) || 0) + 1, updated_at: new Date().toISOString() }) }
  ).catch(() => null)));
}

// ---- correct ----------------------------------------------------------------

// WRITE FIRST. (Chris, 2026-08-18: "none of the dropdown choices worked when I
// tried to select them either." The database agreed: fifty triaged messages and
// not one stored correction, while `act` -- which goes straight to its PATCH --
// had recorded his one tap of the handled button.)
//
// This used to SELECT the row before updating it, purely so the sender was in
// hand for the standing rule. That made a read the correction could not survive,
// for a value the update itself hands back for free via return=representation.
// So the update goes first and the rule is derived from what it returns: the
// correction lands even if the rule cannot be worked out, which is the right way
// round -- the rule is an optimization, the correction is the thing he asked for.
//
// Every failure below names its own step. One shared wording meant
// three different things across this file and told nobody which one had happened.
async function handleCorrect(ownerId, body, deps) {
  const messageId = String(body.messageId || '');
  const label = String(body.label || '');
  if (!messageId) { const e = new Error('messageId is required'); e.status = 400; throw e; }
  if (!isMailTriageLabel(label)) { const e = new Error('unknown label'); e.status = 400; throw e; }

  const patch = await deps.supabaseRequest(
    `reina_mail_triage?owner_id=eq.${encodeURIComponent(ownerId)}&message_id=eq.${encodeURIComponent(messageId)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ corrected_label: label, corrected_at: new Date().toISOString() }),
    }
  );
  if (!patch.ok) {
    const e = new Error('saving the correction failed — ' + (await patch.text().catch(() => '')).slice(0, 120));
    e.status = 502; throw e;
  }
  const row = ((await patch.json().catch(() => [])) || [])[0];
  if (!row) { const e = new Error('no triage row for that message'); e.status = 404; throw e; }

  // The correction becomes a standing rule for that sender, which is what makes
  // the same mistake impossible to repeat.
  let ruleSaved = false;
  const rule = ruleFromCorrection(ownerId, row, label);
  if (rule) {
    const up = await deps.supabaseRequest('reina_mail_triage_rules?on_conflict=owner_id,match_kind,match_value', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify([rule]),
    });
    ruleSaved = up.ok;
  }

  return { ok: true, messageId, label, ruleSaved, learnedFrom: rule ? rule.match_value : null };
}

// ---- act --------------------------------------------------------------------
// Record that a message has been dealt with, so it drops off the triage list
// AND out of the Team To-Do count. This route records; it does not perform.
// The actual doing (opening a reply, opening the calendar, archiving) happens
// in the mail app with the mail app's own controls, which is what keeps "Reina
// suggested it" and "a human did it" from blurring together.
export const MAIL_TRIAGE_ACTIONS = ['replied', 'scheduled', 'tasked', 'archived', 'dismissed'];

async function handleAct(ownerId, body, deps) {
  const messageId = String(body.messageId || '');
  const action = String(body.action || '');
  if (!messageId) { const e = new Error('messageId is required'); e.status = 400; throw e; }
  if (MAIL_TRIAGE_ACTIONS.indexOf(action) === -1) { const e = new Error('unknown action'); e.status = 400; throw e; }

  const r = await deps.supabaseRequest(
    `reina_mail_triage?owner_id=eq.${encodeURIComponent(ownerId)}&message_id=eq.${encodeURIComponent(messageId)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ acted_action: action, acted_at: new Date().toISOString() }),
    }
  );
  if (!r.ok) { const e = new Error('could not record that'); e.status = 502; throw e; }
  const rows = await r.json().catch(() => []);
  if (!rows || !rows.length) { const e = new Error('no triage row for that message'); e.status = 404; throw e; }
  return { ok: true, messageId, action };
}

// ---- draft ------------------------------------------------------------------
// A REPLY DRAFT, never a sent message.
//
// Chris asked for "draft a reply for me to review". The distance between a
// draft and a sent email is the whole safety margin of this feature, so this
// route returns TEXT and writes nothing: no Graph draft, no mailbox write, no
// stored copy. The mail app opens its own reply composer with the text in it,
// which is the same composer he would have used anyway -- so the send button is
// the one he already knows, pressed by him, after reading it.
//
// This is the one place a full message body is read. Triage itself only ever
// sees a ~255-character preview; you cannot write a useful reply from that, and
// it happens only when he taps the button on that one message.
async function handleDraft(ownerId, body, deps) {
  const messageId = String(body.messageId || '');
  if (!messageId) { const e = new Error('messageId is required'); e.status = 400; throw e; }

  const r = await deps.supabaseRequest(
    `reina_mail_triage?owner_id=eq.${encodeURIComponent(ownerId)}&message_id=eq.${encodeURIComponent(messageId)}&select=*`
  );
  if (!r.ok) { const e = new Error('looking that message up failed'); e.status = 502; throw e; }
  const row = ((await r.json()) || [])[0];
  if (!row) { const e = new Error('no triage row for that message'); e.status = 404; throw e; }
  if (!row.graph_id || !row.home_account_id) { const e = new Error('that message is no longer reachable'); e.status = 404; throw e; }

  // An IMAP mailbox is not reachable from here -- its credentials live in the
  // other project and only /api/mail can open it -- so for those the caller
  // passes the body it already fetched. Same drafting, different courier.
  // A rewrite carries the attempt it is replacing, so "shorter" means shorter
  // than the one he is looking at.
  const rewrite = (body.instruction || body.previous)
    ? { instruction: body.instruction, previous: body.previous }
    : null;

  if (String(row.home_account_id).startsWith('imap:')) {
    const supplied = String(body.bodyText || '').slice(0, 20000);
    if (!supplied) { const e = new Error('bodyText is required for this mailbox'); e.status = 400; throw e; }
    return storeDraft(ownerId, await draftFrom(row, supplied, deps, rewrite), deps);
  }

  const mailboxes = await mailboxRowsFor(ownerId, deps);
  const box = mailboxes.find((m) => m.home_account_id === row.home_account_id);
  if (!box) { const e = new Error('that mailbox is no longer connected'); e.status = 409; throw e; }

  const minted = await mailboxAccessToken(box, {
    encryptSecret, decryptSecret,
    patchTokens: (patch) => deps.supabaseRequest(
      `hc_ms_tokens?owner_id=eq.${encodeURIComponent(ownerId)}&home_account_id=eq.${encodeURIComponent(box.home_account_id)}`,
      { method: 'PATCH', body: JSON.stringify(patch) }
    ),
  });
  const gRes = await deps.fetchImpl(
    `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(row.graph_id)}?$select=subject,from,body,bodyPreview`,
    { headers: { Authorization: 'Bearer ' + minted.accessToken } }
  );
  const msg = await gRes.json().catch(() => ({}));
  if (!gRes.ok) { const e = new Error((msg.error && msg.error.message) || 'the mailbox would not return that message'); e.status = 502; throw e; }

  return storeDraft(ownerId, await draftFrom(row, htmlToText((msg.body && msg.body.content) || msg.bodyPreview || ''), deps, rewrite), deps);
}

// A draft is written ONCE, same rule as the verdict. The Microsoft path already
// stored what it pre-wrote; this makes the on-demand path do the same, so a
// Gmail draft survives a refresh instead of being paid for again every look.
// Best-effort on purpose: he is holding the composer open waiting for this, and
// a slow storage write must not become a failed draft.
async function storeDraft(ownerId, drafted, deps) {
  await deps.supabaseRequest(
    `reina_mail_triage?owner_id=eq.${encodeURIComponent(ownerId)}&message_id=eq.${encodeURIComponent(drafted.messageId)}`,
    { method: 'PATCH', body: JSON.stringify({ draft_text: drafted.draft, draft_error: null, draft_at: new Date().toISOString() }) }
  ).catch(() => null);
  return drafted;
}

// The drafting itself, once someone has produced the message text. Shared by
// the Graph path (which fetches it) and the IMAP path (where the browser hands
// it in), so a Gmail reply is written to the same standard as any other.
async function draftFrom(row, rawBody, deps, rewrite) {
  const bodyText = htmlToText(rawBody || '').slice(0, 6000);
  if (!deps.anthropic) { const e = new Error('the drafting service is unavailable'); e.status = 503; throw e; }

  // Chris, 2026-08-18: "the suggested response needs a way to edit it or change
  // it to create a different anwser."
  //
  // A rewrite is not a fresh draft: it is THIS draft, redone the way he asked.
  // Handing the model the previous attempt is what makes "shorter" mean shorter
  // than that, and what stops the second try coming back the same as the first.
  const prior = rewrite && String(rewrite.previous || '').trim().slice(0, 4000);
  const how = rewrite && String(rewrite.instruction || '').trim().slice(0, 300);

  const resp = await deps.anthropic.messages.create({
    model: mailTriageModel(),
    max_tokens: 800,
    output_config: { effort: 'low' },
    system: [
      'You draft replies for the owner of a home-services contracting business.',
      'Write what HE would send: plain, direct, warm but not chatty. No corporate padding,',
      'no "I hope this email finds you well", no restating their whole message back at them.',
      'Short — usually two to five sentences.',
      '',
      'If the message asks something you cannot know (a price, a date, whether a part is in),',
      'leave a clearly marked blank like [CONFIRM DATE] rather than inventing an answer.',
      'A draft with an honest gap in it is useful; a draft with a made-up fact in it is a',
      'liability, because he might send it without noticing.',
      '',
      'Output the reply body only. No subject line, no greeting block, no signature.',
    ].join('\n'),
    messages: [{
      role: 'user',
      content: [
        prior ? 'Rewrite his reply to this email.' : 'Draft his reply to this email.',
        '',
        `From: ${row.from_name || ''} <${row.from_address || ''}>`,
        `Subject: ${row.subject || ''}`,
        '',
        bodyText,
        ...(prior ? ['', '--- The draft so far ---', prior] : []),
        ...(how ? ['', `--- Change it like this: ${how}`] : []),
        ...(prior && !how ? ['', '--- Write a different reply. Same facts, a different way in.'] : []),
      ].join('\n'),
    }],
  });
  const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (!text) { const e = new Error('the draft came back empty'); e.status = 502; throw e; }

  return {
    ok: true,
    messageId: row.message_id,
    graphId: row.graph_id,
    draft: text,
    // Named so the UI can say it out loud rather than letting a blank slip
    // through unnoticed into a sent email.
    hasBlanks: /\[[A-Z][A-Z \-]{2,}\]/.test(text),
  };
}

// ---- brief ------------------------------------------------------------------
//
// Chris, 2026-08-18: "I want a standard inbox and when you click the email on
// the list, it populates the big preview screen. in the preview it shows a
// reina summary of the email and a suggested action or response."
//
// So opening a message is the trigger, and this is what runs. It reads the WHOLE
// email once and stores everything it learned: the summary, the action, the
// label, and the reply if one is wanted.
//
// WRITTEN ONCE. The second time he opens that email this returns instantly from
// the row without a model call -- same rule as the verdicts and the drafts. A
// mailbox he keeps re-reading converges toward costing nothing.
//
// It also RE-LABELS. The batch classifier judges from a 400-character preview,
// which is where it guesses; a full read is simply better evidence. A standing
// rule still beats it, and a correction he made himself still beats everything.
async function handleBrief(ownerId, body, deps) {
  const messageId = String(body.messageId || '');
  if (!messageId) { const e = new Error('messageId is required'); e.status = 400; throw e; }

  const [existing, rules] = await Promise.all([
    deps.supabaseRequest(
      `reina_mail_triage?owner_id=eq.${encodeURIComponent(ownerId)}&message_id=eq.${encodeURIComponent(messageId)}&select=*`
    ).then((r) => (r.ok ? r.json().catch(() => []) : [])).then((rows) => (rows || [])[0] || null),
    standingRules(ownerId, deps),
  ]);

  // Already read. No model call, no wait, no charge.
  if (existing && existing.summary_text && !body.refresh) {
    return briefResponse(await backfillUnsubscribe(ownerId, existing, body, deps), { cached: true });
  }

  // The identity of the message: from the stored row when we have one, from the
  // caller when this is an email the batch scan never covered (older than the
  // window, or in a folder it does not read).
  const msg = {
    messageId,
    graphId: String(body.graphId || (existing && existing.graph_id) || ''),
    homeAccountId: String(body.homeAccountId || (existing && existing.home_account_id) || ''),
    subject: String(body.subject || (existing && existing.subject) || ''),
    fromAddress: String(body.fromAddress || (existing && existing.from_address) || ''),
    fromName: String(body.fromName || (existing && existing.from_name) || ''),
    receivedAt: body.receivedAt || (existing && existing.received_at) || null,
    webLink: body.webLink || (existing && existing.web_link) || null,
  };

  const { bodyText, headers } = await briefBodyFor(ownerId, msg, body, deps);
  const read = await briefMessage(msg, bodyText, deps);
  const unsubscribe = unsubscribeFromHeaders(headers);

  // A rule he set for this sender is a decision he already made. It outranks a
  // fresh read of one message, because he made it about ALL of this sender's mail.
  const rule = matchTriageRule(msg, rules);
  const label = rule ? rule.label : read.label;

  const now = new Date().toISOString();
  const row = {
    owner_id: ownerId,
    message_id: messageId,
    graph_id: msg.graphId || null,
    home_account_id: msg.homeAccountId || null,
    subject: (msg.subject || '').slice(0, 500),
    from_address: msg.fromAddress || null,
    from_name: (msg.fromName || '').slice(0, 200) || null,
    received_at: msg.receivedAt,
    web_link: msg.webLink,
    label,
    reason: read.action || null,
    source: rule ? 'rule' : 'model',
    model: mailTriageModel(),
    summary_text: read.summary || null,
    action_text: read.action || null,
    unsubscribe: unsubscribe || null,
    brief_at: now,
  };
  // The draft is only written when there is one -- a re-read that produces no
  // reply must not wipe a draft he has already been shown.
  if (read.draft) { row.draft_text = read.draft; row.draft_error = null; row.draft_at = now; }

  const up = await deps.supabaseRequest('reina_mail_triage?on_conflict=owner_id,message_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([row]),
  });
  // Only the columns above are sent, so a correction he made -- corrected_label,
  // corrected_at -- survives this write untouched.
  const saved = up.ok ? ((await up.json().catch(() => []))[0] || null) : null;

  // Layered onto what we already knew, not replacing it: the write only names
  // the columns above, so a correction he made is not in `row` and may not be in
  // the returned representation either. Losing it here would show him the
  // model's label on a message he has personally re-labelled.
  return briefResponse(Object.assign({}, existing || {}, row, saved || {}), {
    cached: false,
    storeError: up.ok ? null : (await up.text().catch(() => '')).slice(0, 120),
    hasBlanks: read.hasBlanks,
  });
}

/* A message briefed before unsubscribe existed has no unsubscribe data, and
   "written once" meant it never would.

   Chris, 2026-08-18: "unsubscribe didnt work". The database agreed -- of six
   Gmail messages already briefed, zero carried any: they were read the hour
   before the feature shipped, and the cached path returns them untouched
   forever. The button simply never appeared.

   So the cached path heals itself. It costs a header read, NOT a model call --
   the expensive half stays written-once. And the result is stored even when
   there is no unsubscribe link at all, so a message with nothing to find is
   asked about exactly once. */
async function backfillUnsubscribe(ownerId, row, body, deps) {
  if (row.unsubscribe) return row;                       // already looked
  if (!row.graph_id || !row.home_account_id) return row;  // nothing to look at

  let headers = null;
  if (String(row.home_account_id).startsWith('imap:')) {
    // Only the browser can open that mailbox; use what it sent, if it sent any.
    headers = Array.isArray(body.headers) && body.headers.length ? body.headers : null;
  } else {
    headers = await graphHeaders(ownerId, row, deps).catch(() => null);
  }
  if (!headers) return row;

  const unsubscribe = unsubscribeFromHeaders(headers);
  await deps.supabaseRequest(
    `reina_mail_triage?owner_id=eq.${encodeURIComponent(ownerId)}&message_id=eq.${encodeURIComponent(row.message_id)}`,
    { method: 'PATCH', body: JSON.stringify({ unsubscribe }) }
  ).catch(() => null);
  return Object.assign({}, row, { unsubscribe });
}

// Headers only -- no body, no model. The cheap half of a re-read.
async function graphHeaders(ownerId, row, deps) {
  const mailboxes = await mailboxRowsFor(ownerId, deps);
  const box = mailboxes.find((m) => m.home_account_id === row.home_account_id);
  if (!box) return null;
  const minted = await mailboxAccessToken(box, {
    encryptSecret, decryptSecret,
    patchTokens: (patch) => deps.supabaseRequest(
      `hc_ms_tokens?owner_id=eq.${encodeURIComponent(ownerId)}&home_account_id=eq.${encodeURIComponent(box.home_account_id)}`,
      { method: 'PATCH', body: JSON.stringify(patch) }
    ),
  });
  const gRes = await deps.fetchImpl(
    `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(row.graph_id)}?$select=internetMessageHeaders`,
    { headers: { Authorization: 'Bearer ' + minted.accessToken } }
  );
  if (!gRes.ok) return null;
  const got = await gRes.json().catch(() => ({}));
  return got.internetMessageHeaders || [];
}

function briefResponse(row, extra) {
  return Object.assign({
    ok: true,
    messageId: row.message_id,
    summary: row.summary_text || null,
    action: row.action_text || row.reason || null,
    label: row.corrected_label || row.label || null,
    modelLabel: row.label || null,
    correctedLabel: row.corrected_label || null,
    draft: row.draft_text || null,
    unsubscribe: row.unsubscribe || null,
    hasBlanks: /\[[A-Z][A-Z \-]{2,}\]/.test(String(row.draft_text || '')),
    briefAt: row.brief_at || null,
  }, extra || {});
}

// The message body, from whichever mailbox it lives in.
async function briefBodyFor(ownerId, msg, body, deps) {
  // An IMAP mailbox is not reachable from here -- its credentials live in the
  // other project and only /api/mail can open it -- so the browser, which CAN
  // open it, hands the body in. Same reading either way.
  if (String(msg.homeAccountId).startsWith('imap:') || body.bodyText) {
    const supplied = htmlToText(String(body.bodyText || '')).slice(0, 40000);
    if (!supplied) { const e = new Error('bodyText is required for this mailbox'); e.status = 400; throw e; }
    // The browser is the only thing that can open an IMAP mailbox, so it sends
    // the headers along with the body it already fetched.
    return { bodyText: supplied, headers: Array.isArray(body.headers) ? body.headers : [] };
  }
  if (!msg.graphId || !msg.homeAccountId) { const e = new Error('that message is no longer reachable'); e.status = 404; throw e; }

  const mailboxes = await mailboxRowsFor(ownerId, deps);
  const box = mailboxes.find((m) => m.home_account_id === msg.homeAccountId);
  if (!box) { const e = new Error('that mailbox is no longer connected'); e.status = 409; throw e; }

  const minted = await mailboxAccessToken(box, {
    encryptSecret, decryptSecret,
    patchTokens: (patch) => deps.supabaseRequest(
      `hc_ms_tokens?owner_id=eq.${encodeURIComponent(ownerId)}&home_account_id=eq.${encodeURIComponent(box.home_account_id)}`,
      { method: 'PATCH', body: JSON.stringify(patch) }
    ),
  });
  const gRes = await deps.fetchImpl(
    `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(msg.graphId)}?$select=subject,from,body,bodyPreview,internetMessageHeaders`,
    { headers: { Authorization: 'Bearer ' + minted.accessToken } }
  );
  const got = await gRes.json().catch(() => ({}));
  if (!gRes.ok) { const e = new Error((got.error && got.error.message) || 'the mailbox would not return that message'); e.status = 502; throw e; }
  return {
    bodyText: htmlToText((got.body && got.body.content) || got.bodyPreview || ''),
    headers: got.internetMessageHeaders || [],
  };
}

// ---- draft_save -------------------------------------------------------------
//
// His edit of the draft, kept.
//
// Chris, 2026-08-18: "the suggested response needs a way to edit it". Once he
// can edit it, the version that matters is HIS, not the one Reina wrote -- and
// losing it on a folder change or a refresh would make the edit box a trap. So
// the card writes it back, and the stored draft is whatever he last left there.
async function handleDraftSave(ownerId, body, deps) {
  const messageId = String(body.messageId || '');
  if (!messageId) { const e = new Error('messageId is required'); e.status = 400; throw e; }
  // Trimmed at the ends: a box he cleared usually still holds a newline or a
  // space, and "  " must count as cleared rather than as a draft made of
  // whitespace. Internal formatting is left exactly as he typed it.
  const text = String(body.draft == null ? '' : body.draft).slice(0, 20000).trim();

  const r = await deps.supabaseRequest(
    `reina_mail_triage?owner_id=eq.${encodeURIComponent(ownerId)}&message_id=eq.${encodeURIComponent(messageId)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      // Empty means he cleared it. That is a decision, not a failure, and it
      // must not be quietly replaced by the model's version next time.
      body: JSON.stringify({ draft_text: text || null, draft_error: null, draft_at: new Date().toISOString() }),
    }
  );
  if (!r.ok) { const e = new Error('saving that draft failed'); e.status = 502; throw e; }
  const row = ((await r.json().catch(() => [])) || [])[0];
  if (!row) { const e = new Error('no triage row for that message'); e.status = 404; throw e; }
  return { ok: true, messageId, draft: row.draft_text || null };
}

// ---- reply ------------------------------------------------------------------
//
// Chris, 2026-08-18: "I also dont want it to pull you from the work at hand, it
// should pull up a seperate popup that allows you to take action quickly in the
// popup and go back to the task you were currently working on."
//
// So the popup has to be able to actually SEND. Everything up to now has stopped
// one step short of that on purpose, and the reason still holds -- the gap
// between drafted and sent is the safety margin. What makes this acceptable is
// that the text being sent is the text on his screen: the popup's draft box is
// editable, and this sends exactly what is in it, on a button that says Send.
// Nothing is ever sent from a summary he has not read.
//
// Graph's /reply threads it correctly and keeps it in the conversation, which
// is what a client sees. An IMAP mailbox is not reachable from here, so those
// are told to open the email instead rather than being silently dropped.
async function handleReply(ownerId, body, deps) {
  const messageId = String(body.messageId || '');
  const text = String(body.text || '').trim();
  if (!messageId) { const e = new Error('messageId is required'); e.status = 400; throw e; }
  if (!text) { const e = new Error('there is nothing to send'); e.status = 400; throw e; }

  const r = await deps.supabaseRequest(
    `reina_mail_triage?owner_id=eq.${encodeURIComponent(ownerId)}&message_id=eq.${encodeURIComponent(messageId)}&select=*`
  );
  if (!r.ok) { const e = new Error('looking that message up failed'); e.status = 502; throw e; }
  const row = ((await r.json().catch(() => [])) || [])[0];
  if (!row) { const e = new Error('no triage row for that message'); e.status = 404; throw e; }
  if (!row.graph_id || !row.home_account_id) { const e = new Error('that message is no longer reachable'); e.status = 404; throw e; }
  if (String(row.home_account_id).startsWith('imap:')) {
    const e = new Error('that mailbox can only be replied to from the email app — open it there');
    e.status = 409; throw e;
  }

  const mailboxes = await mailboxRowsFor(ownerId, deps);
  const box = mailboxes.find((m) => m.home_account_id === row.home_account_id);
  if (!box) { const e = new Error('that mailbox is no longer connected'); e.status = 409; throw e; }

  const minted = await mailboxAccessToken(box, {
    encryptSecret, decryptSecret,
    patchTokens: (patch) => deps.supabaseRequest(
      `hc_ms_tokens?owner_id=eq.${encodeURIComponent(ownerId)}&home_account_id=eq.${encodeURIComponent(box.home_account_id)}`,
      { method: 'PATCH', body: JSON.stringify(patch) }
    ),
  });

  const gRes = await deps.fetchImpl(
    `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(row.graph_id)}/reply`,
    {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + minted.accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment: text }),
    }
  );
  if (!gRes.ok) {
    const err = await gRes.json().catch(() => ({}));
    const e = new Error((err.error && err.error.message) || `sending failed (${gRes.status})`);
    e.status = 502; throw e;
  }

  // Sent means handled: off the popup, off the Team To-Do. Recorded AFTER the
  // send, so a failed send never leaves a message looking dealt with.
  await deps.supabaseRequest(
    `reina_mail_triage?owner_id=eq.${encodeURIComponent(ownerId)}&message_id=eq.${encodeURIComponent(messageId)}`,
    { method: 'PATCH', body: JSON.stringify({ acted_action: 'replied', acted_at: new Date().toISOString(), draft_text: text }) }
  ).catch(() => null);

  return { ok: true, messageId, sentTo: row.from_address || null };
}

// ---- pending ----------------------------------------------------------------
//
// What is still waiting on him, for the notification popup.
//
// Chris, 2026-08-18: "Comms notifications should popup on every screen in
// hivelogic ... handle any notification that comes up that might be important
// and address it quickly with reina summary and suggested way to respond."
//
// Reads only. Everything it returns was already written by the triage pass, so
// this costs a database query and nothing else -- it can be polled without
// spending a cent.
//
// Only the three labels that mean somebody is waiting. Junk and FYI never
// interrupt him: a popup that fires for a receipt is a popup he learns to
// dismiss without reading, which costs more than it saves.
export const REINA_PENDING_LABELS = ['needs_reply', 'needs_scheduling', 'needs_action'];
export const REINA_PENDING_LIMIT = 20;

async function handlePending(ownerId, deps) {
  const labels = REINA_PENDING_LABELS.map((l) => `"${l}"`).join(',');
  const r = await deps.supabaseRequest(
    `reina_mail_triage?owner_id=eq.${encodeURIComponent(ownerId)}` +
    `&acted_at=is.null` +
    `&or=(and(corrected_label.is.null,label.in.(${labels})),corrected_label.in.(${labels}))` +
    `&select=message_id,graph_id,home_account_id,subject,from_name,from_address,received_at,` +
    `label,corrected_label,summary_text,action_text,reason,draft_text,web_link,unsubscribe` +
    `&order=received_at.desc&limit=${REINA_PENDING_LIMIT}`
  );
  if (!r.ok) { const e = new Error('could not read what is waiting'); e.status = 502; throw e; }
  const rows = (await r.json().catch(() => [])) || [];

  return {
    ok: true,
    items: rows.map((row) => ({
      id: row.message_id,
      source: 'email',
      graphId: row.graph_id,
      homeAccountId: row.home_account_id,
      from: row.from_name || row.from_address || 'unknown sender',
      fromAddress: row.from_address || null,
      subject: row.subject || '(no subject)',
      receivedAt: row.received_at,
      label: row.corrected_label || row.label,
      // The summary only exists once he has opened it. Before that the one-line
      // reason from the batch pass is what there is, and saying it is thinner is
      // better than showing an empty card.
      summary: row.summary_text || null,
      action: row.action_text || row.reason || null,
      draft: row.draft_text || null,
      brief: !!row.summary_text,
      webLink: row.web_link || null,
      // Only offered as a button when the sender actually promised one-click.
      unsubscribe: row.unsubscribe || null,
    })),
  };
}

// ---- unsubscribe ------------------------------------------------------------
//
// Chris, 2026-08-18: "for spam... can you have a way to auto-unsubscribe or just
// push to junk only?"
//
// NOT AUTOMATIC, and that is the point. This runs on a button he pressed, on a
// message he was looking at. An unattended unsubscriber would be firing requests
// at strangers' servers on his behalf, and for real spam that is exactly the
// wrong move -- it confirms the address is live.
//
// The URL comes from the STORED row, never from the request body. The caller
// names a message; it does not get to name a destination. That is what keeps
// this from being a way to make our server fetch anything anyone likes.
async function handleUnsubscribe(ownerId, body, deps) {
  const messageId = String(body.messageId || '');
  if (!messageId) { const e = new Error('messageId is required'); e.status = 400; throw e; }

  const r = await deps.supabaseRequest(
    `reina_mail_triage?owner_id=eq.${encodeURIComponent(ownerId)}&message_id=eq.${encodeURIComponent(messageId)}&select=unsubscribe,from_address`
  );
  if (!r.ok) { const e = new Error('looking that message up failed'); e.status = 502; throw e; }
  const row = ((await r.json().catch(() => [])) || [])[0];
  if (!row) { const e = new Error('no triage row for that message'); e.status = 404; throw e; }

  const target = safeUnsubscribeUrl(row.unsubscribe && row.unsubscribe.oneClick);
  if (!target) {
    // Either they never promised one-click, or the link is not somewhere we are
    // willing to send a request. Junk is the answer, and saying so beats a
    // button that appears to work.
    const e = new Error('this sender does not support one-click unsubscribe — move it to Junk instead');
    e.status = 409; throw e;
  }

  // RFC 8058: the body is exactly this, and a compliant sender removes you on it.
  const res = await deps.fetchImpl(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
    redirect: 'follow',
  }).catch((err) => ({ ok: false, status: 0, statusText: String(err && err.message || err) }));

  if (!res.ok) {
    const e = new Error(`their unsubscribe endpoint said ${res.status || 'nothing'}`);
    e.status = 502; throw e;
  }
  return { ok: true, messageId, unsubscribedFrom: row.from_address || null };
}

// ---- handler ----------------------------------------------------------------

export default async function handler(req, res, injected = {}) {
  const deps = {
    supabaseRequest: injected.supabaseRequest || defaultSupabaseRequest,
    fetchImpl: injected.fetchImpl || fetch,
    anthropic: injected.anthropic,
    ...injected,
  };

  const auth = await requireApiAuth(req, { fetchImpl: deps.fetchImpl });
  // A cron has no mailbox of its own, and this route is deliberately on-demand.
  if (!auth.ok || !auth.user || !auth.user.id) return jsonError(res, 401, 'Not signed in — log into HiveLogic first.');
  const ownerId = auth.user.id;

  if (req.method !== 'POST') return jsonError(res, 405, 'POST only');
  const action = String((req.query && req.query.action) || '');
  const body = (typeof req.body === 'object' && req.body) || {};

  if (!deps.anthropic && !('anthropic' in injected) && ['list', 'draft', 'classify', 'brief'].indexOf(action) !== -1) {
    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      deps.anthropic = new Anthropic();
    } catch (e) {
      // Leave it null: rules and stored verdicts still work, and anything that
      // needed the model is reported as unlabelled rather than guessed at.
      deps.anthropic = null;
    }
  }

  try {
    if (action === 'list') return res.status(200).json(await handleList(ownerId, deps));
    if (action === 'correct') return res.status(200).json(await handleCorrect(ownerId, body, deps));
    if (action === 'classify') return res.status(200).json(await handleClassify(ownerId, body, deps));
    if (action === 'act') return res.status(200).json(await handleAct(ownerId, body, deps));
    if (action === 'draft') return res.status(200).json(await handleDraft(ownerId, body, deps));
    if (action === 'brief') return res.status(200).json(await handleBrief(ownerId, body, deps));
    if (action === 'pending') return res.status(200).json(await handlePending(ownerId, deps));
    if (action === 'reply') return res.status(200).json(await handleReply(ownerId, body, deps));
    if (action === 'draft_save') return res.status(200).json(await handleDraftSave(ownerId, body, deps));
    if (action === 'unsubscribe') return res.status(200).json(await handleUnsubscribe(ownerId, body, deps));
    return jsonError(res, 400, 'unknown action');
  } catch (e) {
    return jsonError(res, e.status || 500, String(e.message || e).slice(0, 200));
  }
}
