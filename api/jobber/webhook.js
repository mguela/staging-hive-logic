// api/jobber/webhook.js - Vercel serverless function
// Near-real-time Jobber sync via webhooks (2026-07-31).
//
// Jobber pushes an event the moment a client/job/invoice changes. Jobber
// requires a response within 1 second and delivers at-least-once (dupes
// possible), so this endpoint does the minimum synchronously: verify the
// HMAC signature, insert the raw event into webhook_events, ACK 200.
// A once-a-minute cron (vercel.json: /api/jobber/webhook?drain=1) then
// fetches each changed record from Jobber's GraphQL API by id and upserts
// it into Supabase using the same row shapes as api/jobber/sync.js. The
// hourly full sync.js pass remains as the reconciliation backstop.
//
// Registration (one-time, manual): Jobber Developer Center -> the HiveLogic
// app -> Webhooks -> URL https://hivelogic-live.vercel.app/api/jobber/webhook
// with topics CLIENT_CREATE/UPDATE/DESTROY, JOB_CREATE/UPDATE/DESTROY,
// INVOICE_CREATE/UPDATE/DESTROY. Signature: base64 HMAC-SHA256 of the raw
// request body keyed with JOBBER_CLIENT_SECRET (same env var the OAuth
// token refresh already uses), header X-Jobber-Hmac-SHA256, compared with
// timingSafeEqual.
//
// The row-mapping functions below intentionally mirror api/jobber/sync.js
// (mapClient/mapJob/mapInvoice). If a field is added there, add it here too.
// TODO(cleanup): hoist the shared maps into api/_lib/jobber-maps.js once the
// in-flight marketing-suite branches (which also touch sync.js) are merged,
// so this duplication can't drift.

import crypto from 'crypto';
import { jobberGraphQL, supabaseRequest } from '../_lib/jobber.js';
import { normalizeToE164 } from '../_lib/voice.js';
import { checkCronSecret } from '../_lib/guard.js';

// Raw body needed: the HMAC is computed over the exact bytes Jobber sent.
export const config = { api: { bodyParser: false } };

const DRAIN_BATCH = 40; // events per drain run; 1-min cadence keeps backlog tiny
const DRAIN_TIME_BUDGET_MS = 45000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifySignature(rawBody, headerValue) {
  const secret = process.env.JOBBER_CLIENT_SECRET;
  if (!secret || !headerValue) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(headerValue));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- single-record fetch + row mapping (mirrors sync.js) ----------

const CLIENT_QUERY = `
  query Client($id: EncodedId!) {
    client(id: $id) {
      id firstName lastName companyName name isCompany isLead isArchived
      balance defaultEmails phones { number primary description }
      jobberWebUri createdAt updatedAt
    }
  }
`;

const JOB_QUERY = `
  query Job($id: EncodedId!) {
    job(id: $id) {
      id client { id } jobNumber title jobStatus jobType total
      startAt endAt completedAt jobberWebUri createdAt updatedAt
    }
  }
`;

const INVOICE_QUERY = `
  query Invoice($id: EncodedId!) {
    invoice(id: $id) {
      id client { id } jobs(first: 3) { nodes { id } } invoiceNumber invoiceStatus subject
      amounts { total subtotal depositAmount discountAmount paymentsTotal }
      dueDate issuedDate jobberWebUri createdAt updatedAt
    }
  }
`;

function pickPrimaryPhone(phones) {
  if (!Array.isArray(phones) || !phones.length) return null;
  const primary = phones.find((p) => p.primary) || phones[0];
  return primary && primary.number ? normalizeToE164(primary.number) : null;
}

function mapClient(c) {
  return {
    jobber_id: c.id,
    first_name: c.firstName,
    last_name: c.lastName,
    company_name: c.companyName,
    name: c.name,
    is_company: c.isCompany,
    is_lead: c.isLead,
    is_archived: c.isArchived,
    balance: c.balance,
    email: (c.defaultEmails && c.defaultEmails[0]) || null,
    phone_e164: pickPrimaryPhone(c.phones),
    jobber_web_uri: c.jobberWebUri,
    jobber_created_at: c.createdAt,
    jobber_updated_at: c.updatedAt,
    synced_at: new Date().toISOString(),
  };
}

function mapJob(j) {
  return {
    jobber_id: j.id,
    client_id: j.client ? j.client.id : null,
    job_number: j.jobNumber,
    title: j.title,
    job_status: j.jobStatus,
    job_type: j.jobType,
    total: j.total,
    start_at: j.startAt,
    end_at: j.endAt,
    completed_at: j.completedAt,
    jobber_web_uri: j.jobberWebUri,
    jobber_created_at: j.createdAt,
    jobber_updated_at: j.updatedAt,
    synced_at: new Date().toISOString(),
  };
}

function mapInvoice(i) {
  const amounts = i.amounts || {};
  return {
    jobber_id: i.id,
    client_id: i.client ? i.client.id : null,
    job_id: (i.jobs && i.jobs.nodes && i.jobs.nodes.length) ? i.jobs.nodes[0].id : null,
    invoice_number: i.invoiceNumber,
    invoice_status: i.invoiceStatus,
    subject: i.subject,
    total: amounts.total,
    subtotal: amounts.subtotal,
    deposit: amounts.depositAmount,
    discount: amounts.discountAmount,
    payments: amounts.paymentsTotal,
    due_date: i.dueDate,
    issued_date: i.issuedDate,
    jobber_web_uri: i.jobberWebUri,
    jobber_created_at: i.createdAt,
    jobber_updated_at: i.updatedAt,
    synced_at: new Date().toISOString(),
  };
}

// topic prefix -> how to fetch and store that entity
const ENTITIES = {
  CLIENT: { query: CLIENT_QUERY, key: 'client', table: 'clients', map: mapClient },
  JOB: { query: JOB_QUERY, key: 'job', table: 'jobs', map: mapJob },
  INVOICE: { query: INVOICE_QUERY, key: 'invoice', table: 'invoices', map: mapInvoice },
};

async function processEvent(evt) {
  const topic = String(evt.topic || '');
  const sep = topic.lastIndexOf('_');
  const entityName = sep > 0 ? topic.slice(0, sep) : topic;
  const action = sep > 0 ? topic.slice(sep + 1) : '';
  const spec = ENTITIES[entityName];
  if (!spec) return { skipped: `unhandled topic ${topic}` };

  if (action === 'DESTROY') {
    const res = await supabaseRequest(`${spec.table}?jobber_id=eq.${encodeURIComponent(evt.item_id)}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error(`Failed to delete from ${spec.table}: ${await res.text()}`);
    return { deleted: evt.item_id };
  }

  const data = await jobberGraphQL(spec.query, { id: evt.item_id });
  const record = data[spec.key];
  if (!record) {
    // Deleted (or never visible) between event and fetch - treat like DESTROY.
    await supabaseRequest(`${spec.table}?jobber_id=eq.${encodeURIComponent(evt.item_id)}`, { method: 'DELETE' }).catch(() => {});
    return { missing: evt.item_id };
  }
  const res = await supabaseRequest(`${spec.table}?on_conflict=jobber_id`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify([spec.map(record)]),
  });
  if (!res.ok) throw new Error(`Failed to upsert ${spec.table}: ${await res.text()}`);
  return { upserted: evt.item_id };
}

async function drain(res) {
  const startedAt = Date.now();
  const pendingRes = await supabaseRequest(
    `webhook_events?status=eq.pending&order=received_at.asc&limit=${DRAIN_BATCH}&select=id,topic,item_id`
  );
  if (!pendingRes.ok) {
    return res.status(500).json({ ok: false, error: `Failed to read webhook_events: ${await pendingRes.text()}` });
  }
  const events = await pendingRes.json();

  // Dedupe: at-least-once delivery + bursts of UPDATEs for the same record.
  // Only the newest fetch matters, so process each (topic-entity, item) once.
  const seen = new Set();
  const results = { processed: 0, deduped: 0, errors: 0 };
  for (const evt of events) {
    if (Date.now() - startedAt > DRAIN_TIME_BUDGET_MS) break;
    const dedupeKey = `${String(evt.topic).split('_')[0]}:${evt.item_id}`;
    try {
      if (seen.has(dedupeKey)) {
        results.deduped += 1;
      } else {
        seen.add(dedupeKey);
        await processEvent(evt);
        results.processed += 1;
        await sleep(150); // breathing room for Jobber query-cost points
      }
      await supabaseRequest(`webhook_events?id=eq.${evt.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'done', processed_at: new Date().toISOString() }),
      });
    } catch (err) {
      results.errors += 1;
      await supabaseRequest(`webhook_events?id=eq.${evt.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'error', error: String((err && err.message) || err).slice(0, 500), processed_at: new Date().toISOString() }),
      }).catch(() => {});
    }
  }
  return res.status(200).json({ ok: true, ...results, remaining_batch_full: events.length === DRAIN_BATCH });
}

// ---------- retention cleanup ----------
// webhook_events grows forever otherwise (one row per Jobber event, drained
// once a minute but never deleted). 'done' rows have already been fully
// processed by drain() above -- nothing reads them again once they're done,
// so they're safe to delete after a retention window. 'error' rows are left
// alone; those still need a human look, not a silent delete.
const CLEANUP_RETENTION_DAYS = 30;

export async function runWebhookCleanup(retentionDays) {
  const days = Number.isFinite(retentionDays) ? retentionDays : CLEANUP_RETENTION_DAYS;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const delRes = await supabaseRequest(
    `webhook_events?status=eq.done&processed_at=lt.${encodeURIComponent(cutoff)}`,
    { method: 'DELETE' }
  );
  if (!delRes.ok) {
    throw new Error(`Failed to clean up webhook_events: ${await delRes.text()}`);
  }
  return { cutoff, retention_days: days };
}

async function cleanup(res) {
  try {
    const result = await runWebhookCleanup();
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
}

export default async function handler(req, res) {
  // Mode 1: cron drain (GET, CRON_SECRET-gated like api/jobber/sync.js).
  const q = req.query || {};
  if (q.drain) {
    // Item 6 (2026-08-01): Authorization: Bearer <CRON_SECRET> only (no ?key=),
    // timing-safe, fails closed when CRON_SECRET unset. The webhook-event path
    // below is separately authenticated by Jobber's HMAC signature.
    if (!checkCronSecret((req.headers && req.headers.authorization) || '')) {
      return res.status(401).json({ ok: false, error: 'Drain runs on Vercel Cron only. Provide Authorization: Bearer <CRON_SECRET>.' });
    }
    return drain(res);
  }
  if (q.cleanup) {
    const cronSecret = process.env.CRON_SECRET;
    const authed = cronSecret && (((req.headers && req.headers.authorization) || '') === `Bearer ${cronSecret}` || q.key === cronSecret);
    if (!authed) return res.status(401).json({ ok: false, error: 'Cleanup runs on Vercel Cron only. Manual test: ?cleanup=1&key=<CRON_SECRET>' });
    return cleanup(res);
  }

  // Mode 2: incoming webhook from Jobber (POST, HMAC-gated).
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const rawBody = await readRawBody(req);
  if (!verifySignature(rawBody, req.headers['x-jobber-hmac-sha256'])) {
    return res.status(401).json({ ok: false, error: 'Invalid webhook signature' });
  }

  let evt = null;
  try {
    const parsed = JSON.parse(rawBody.toString('utf8'));
    evt = parsed && parsed.data && parsed.data.webHookEvent;
  } catch (e) {
    evt = null;
  }
  if (!evt || !evt.topic || !evt.itemId) {
    return res.status(400).json({ ok: false, error: 'Unrecognized webhook payload' });
  }

  const insert = await supabaseRequest('webhook_events', {
    method: 'POST',
    body: JSON.stringify({
      topic: evt.topic,
      item_id: evt.itemId,
      account_id: evt.accountId || null,
      occurred_at: evt.occurredAt || null,
      status: 'pending',
      received_at: new Date().toISOString(),
    }),
  });
  if (!insert.ok) {
    // 500 so Jobber retries - at-least-once + idempotent upserts make retries safe.
    return res.status(500).json({ ok: false, error: 'Failed to queue event' });
  }
  return res.status(200).json({ ok: true });
}
