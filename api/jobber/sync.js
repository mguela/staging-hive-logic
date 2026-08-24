// api/jobber/sync.js - Vercel serverless function
// Pulls clients, jobs, and invoices from Jobber and upserts them into
// Supabase. Runs automatically on Vercel Cron (see vercel.json) so no one
// has to trigger it by hand. Each entity type is synced independently via
// ?resource=clients|jobs|invoices so a single run always finishes well
// inside the function time limit; calling with no resource param syncs
// all three in one request (handy for a manual/on-demand full sync).
// Pagination stops itself a safety margin before Vercel's time limit
// (TIME_BUDGET_MS) instead of at a fixed record count, so growing data
// volume is never silently truncated. The pagination cursor for each
// resource is persisted in sync_cursors so a run that runs out of time
// resumes on the next run instead of re-fetching the same first page of
// records forever - it logs status "partial" in sync_log while resuming,
// and "success" once a full pass reaches the end (which also resets the
// cursor so the next run starts a fresh pass and picks up updates).
// Jobber charges query-cost points per field-per-record (see jobberGraphQL
// in _lib/jobber.js for the automatic throttle retry/backoff).
//
// 2026-07-24: clients now also sync `phones` -> clients.phone_e164
// (sql/023_voice_phone_system.sql), added for HiveLogic Phone's caller
// recognition (a call/text from a known client shows their name and
// open job instead of just a raw number). This is the fix for the
// long-standing "client phone numbers aren't synced from Jobber, only
// email" gap flagged in reina/mos-phase1-horseshit-diagnosis-2026-07-23.md
// and api/fieldops.js's own honesty notes. Live-verified 2026-08-07 (a
// "0 of 8,662 clients have a phone" ticket turned out to be stale): raw
// Jobber phones data confirmed correct shape via a live sync_log capture,
// and clients.phone_e164 is populated for 7,419 of 8,676 clients in
// production -- the ~1,257 without one are clients Jobber itself has no
// phone on file for, not a sync gap.
import { jobberGraphQL, supabaseRequest } from '../_lib/jobber.js';
import { normalizeToE164 } from '../_lib/voice.js';
import { checkCronSecret } from '../_lib/guard.js';
import { dedupeRowsByConflictKey } from '../_lib/sync-dedupe.js';

const PAGE_SIZE = 25;
// Fields a query may ask for and survive without. Only these justify falling
// back to a simpler query shape; anything else is a real failure.
const OPTIONAL_FIELDS = ['balance'];
const PAGE_DELAY_MS = 400; // small gap between pages so cost points can restore
const TIME_BUDGET_MS = 260000; // stop paginating ~40s before the 300s function limit

function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
}

const CLIENTS_QUERY = `
  query Clients($cursor: String) {
      clients(first: ${PAGE_SIZE}, after: $cursor) {
            nodes {
                    id
                            firstName
                                    lastName
                                            companyName
                                                    name
                                                            isCompany
                                                                    isLead
                                                                            isArchived
                                                                                    balance
                                                                                            defaultEmails
                                                                                                    phones { number primary description }
                                                                                                            jobberWebUri
                                                                                                                    createdAt
                                                                                                                            updatedAt
                                                                                                                                  }
                                                                                                                                        pageInfo { hasNextPage endCursor }
                                                                                                                                            }
                                                                                                                                              }
                                                                                                                                              `;

const JOBS_QUERY = `
  query Jobs($cursor: String) {
      jobs(first: ${PAGE_SIZE}, after: $cursor) {
            nodes {
                    id
                            client { id }
                                    jobNumber
                                            title
                                                    jobStatus
                                                            jobType
                                                                    total
                                                                            startAt
                                                                                    endAt
                                                                                            completedAt
                                                                                                    jobberWebUri
                                                                                                            createdAt
                                                                                                                    updatedAt
                                                                                                                          }
                                                                                                                                pageInfo { hasNextPage endCursor }
                                                                                                                                    }
                                                                                                                                      }
                                                                                                                                      `;

// Field names below match Jobber's actual InvoiceAmounts type (confirmed via
// a live schema error) - note depositAmount/discountAmount/paymentsTotal,
// not deposit/discount/payments as the field descriptions might suggest.
// `balance` is Jobber's own figure for what is still owed. It was never
// asked for, so invoices.balance was NULL on all 2,852 rows, and anything
// filtering on it -- Reina's receivables read did -- matched nothing and
// reported that nobody owed anything. The field is requested now.
//
// A field this sync guesses wrong would break the ENTIRE invoice sync with
// a validation error, which is a far worse outcome than the gap it fixes.
// So the query is built from a list of amount selections, and a validation
// error naming a field drops to the next one: the shape that has worked all
// along. Losing balance again is survivable; losing invoices is not.
const invoicesQuery = (amountFields) => `
  query Invoices($cursor: String) {
      invoices(first: ${PAGE_SIZE}, after: $cursor) {
            nodes {
                    id
                            client { id }
                                    invoiceNumber
                                            jobs(first: 3) { nodes { id } }
                                            invoiceStatus
                                                    subject
                                                            amounts { ${amountFields} }
                                                                    dueDate
                                                                            issuedDate
                                                                                    jobberWebUri
                                                                                            createdAt
                                                                                                    updatedAt
                                                                                                          }
                                                                                                                pageInfo { hasNextPage endCursor }
                                                                                                                    }
                                                                                                                      }
                                                                                                                      `;

const INVOICE_AMOUNTS_WITH_BALANCE = 'total subtotal depositAmount discountAmount paymentsTotal balance';
const INVOICE_AMOUNTS_WITHOUT_BALANCE = 'total subtotal depositAmount discountAmount paymentsTotal';
const INVOICES_QUERIES = [
  invoicesQuery(INVOICE_AMOUNTS_WITH_BALANCE),
  invoicesQuery(INVOICE_AMOUNTS_WITHOUT_BALANCE),
];


async function getStoredCursor(resource) {
        const res = await supabaseRequest(`sync_cursors?resource=eq.${resource}&select=cursor`);
        if (!res.ok) return null;
        const rows = await res.json();
        return rows.length ? rows[0].cursor : null;
}

async function saveCursor(resource, cursor) {
        await supabaseRequest('sync_cursors?on_conflict=resource', {
                  method: 'POST',
                  headers: { Prefer: 'resolution=merge-duplicates' },
                  body: JSON.stringify({ resource, cursor, updated_at: new Date().toISOString() }),
        });
}

// A GraphQL validation error naming a field we asked for -- as opposed to a
// throttle, a network failure, or an auth problem -- means this schema does
// not have that field. Narrow on purpose: it must both name the field AND
// look like validation, so a transient failure never silently downgrades the
// query and quietly stops collecting a column.
export function isUnknownFieldError(error, field) {
        const message = String((error && error.message) || '');
        if (!field || !message.includes(field)) return false;
        return /doesn't exist on type|does not exist on type|Cannot query field|undefinedField|GRAPHQL_VALIDATION_FAILED|validation/i.test(message);
}

async function fetchAllPages(queries, key, deadline, startCursor) {
        const candidates = Array.isArray(queries) ? queries : [queries];
        const all = [];
        let cursor = startCursor || null;
        let truncated = false;
        let queryIndex = 0;
        let degraded = null;
        while (true) {
                  if (Date.now() >= deadline) {
                              truncated = true;
                              break;
                  }
                  let data;
                  try {
                              data = await jobberGraphQL(candidates[queryIndex], { cursor });
                  } catch (error) {
                              // Only before the first record, and only for a field this
                              // query actually asked for. Half a pass in one shape and half
                              // in another would produce rows that disagree about what they
                              // contain.
                              const nextIndex = queryIndex + 1;
                              if (all.length === 0 && nextIndex < candidates.length
                                && OPTIONAL_FIELDS.some((field) => isUnknownFieldError(error, field))) {
                                          degraded = { droppedAfter: queryIndex, reason: String(error.message || '').slice(0, 300) };
                                          queryIndex = nextIndex;
                                          continue;
                              }
                              throw error;
                  }
                  const connection = data[key];
                  all.push(...connection.nodes);
                  if (!connection.pageInfo.hasNextPage) {
                              cursor = null;
                              break;
                  }
                  cursor = connection.pageInfo.endCursor;
                  await sleep(PAGE_DELAY_MS);
        }
        return { records: all, truncated, lastCursor: cursor, degraded };
}

// return=representation added (2026-08-07, Gate 0 follow-up) so callers can
// see the server-assigned uuid_id on each upserted row -- needed to keep
// external_refs (sql/049's Gate 1 identity mapping) populated for every
// NEW client/job/invoice this sync creates, not just the ones that existed
// when 049's one-time backfill ran. Existing callers only ever used the
// row count, so this is additive; still returns that count unchanged.
async function upsert(table, rows, conflictColumn) {
        if (!rows.length) return { count: 0, rows: [] };
        const deduped = dedupeRowsByConflictKey(rows, conflictColumn);
        if (deduped.duplicatesDropped) {
                  console.warn(`Jobber sync dropped ${deduped.duplicatesDropped} duplicate ${conflictColumn} row(s) before upserting ${table}.`);
        }
        const res = await supabaseRequest(`${table}?on_conflict=${conflictColumn}`, {
                  method: 'POST',
                  headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
                  body: JSON.stringify(deduped.rows),
        });
        if (!res.ok) {
                  throw new Error(`Failed to upsert ${table}: ${await res.text()}`);
        }
        const returned = await res.json();
        return { count: deduped.rows.length, rows: returned, duplicatesDropped: deduped.duplicatesDropped };
}

// Keeps external_refs (sql/049) complete as new records sync in -- without
// this, only the rows that existed at the time of 049's one-time backfill
// ever get a mapping, and the gap grows with every new client/job/invoice
// Jobber sends over (confirmed via a Gate 0 verification pass: 29 rows
// across clients/jobs/invoices already missing their mapping before this
// fix). Same idempotent on-conflict-do-nothing shape as 049's own inserts.
const ENTITY_TYPE_BY_RESOURCE = { clients: 'client', jobs: 'job', invoices: 'invoice' };
async function syncExternalRefs(resourceName, upsertedRows) {
        const entityType = ENTITY_TYPE_BY_RESOURCE[resourceName];
        if (!entityType || !upsertedRows.length) return;
        const refs = upsertedRows
                  .filter((r) => r.jobber_id && r.uuid_id)
                  .map((r) => ({ entity_type: entityType, entity_id: r.uuid_id, system: 'jobber', external_id: r.jobber_id }));
        if (!refs.length) return;
        await supabaseRequest('external_refs?on_conflict=system,entity_type,external_id', {
                  method: 'POST',
                  headers: { Prefer: 'resolution=ignore-duplicates' },
                  body: JSON.stringify(refs),
        }).catch(() => {}); // best-effort -- a hiccup here must never fail the real sync
}

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
                  job_id: (i.jobs && i.jobs.nodes && i.jobs.nodes.length) ? i.jobs.nodes[0].id : null, // first linked job (invoices.job_id is single-valued)
                  invoice_number: i.invoiceNumber,
                  invoice_status: i.invoiceStatus,
                  subject: i.subject,
                  total: amounts.total,
                  subtotal: amounts.subtotal,
                  deposit: amounts.depositAmount,
                  discount: amounts.discountAmount,
                  payments: amounts.paymentsTotal,
                  // Jobber's own figure, or nothing. A derived number written
                  // here would be indistinguishable from an authoritative one
                  // by everything downstream, and readers rely on that
                  // distinction to say "about" instead of stating a total.
                  balance: amounts.balance == null ? null : amounts.balance,
                  due_date: i.dueDate,
                  issued_date: i.issuedDate,
                  jobber_web_uri: i.jobberWebUri,
                  jobber_created_at: i.createdAt,
                  jobber_updated_at: i.updatedAt,
                  synced_at: new Date().toISOString(),
        };
}

const RESOURCES = {
        clients: { queries: [CLIENTS_QUERY], key: 'clients', table: 'clients', map: mapClient },
        jobs: { queries: [JOBS_QUERY], key: 'jobs', table: 'jobs', map: mapJob },
        invoices: { queries: INVOICES_QUERIES, key: 'invoices', table: 'invoices', map: mapInvoice },
};

async function syncResource(name, deadline) {
        const spec = RESOURCES[name];
        const startCursor = await getStoredCursor(name);
        const { records, truncated, lastCursor, degraded } = await fetchAllPages(spec.queries, spec.key, deadline, startCursor);
        const { count, rows, duplicatesDropped = 0 } = await upsert(spec.table, records.map(spec.map), 'jobber_id');
        await syncExternalRefs(name, rows);
        await saveCursor(name, truncated ? lastCursor : null);
        // A query that had to drop a field is a fact about this data, not a
        // detail of one run: every reader downstream is now working with a
        // column that stopped being filled in. Say it where it can be seen.
        if (degraded) console.warn(`[jobber-sync] ${name}: fell back to a reduced query`, degraded);
        return { count, truncated, duplicatesDropped, degraded };
}

export default async function handler(req, res) {
  // Cron auth (2026-07-31): this endpoint hits Jobber's API and must not be
  // publicly triggerable. Vercel Cron sends the Bearer automatically; manual
  // runs use ?key=<CRON_SECRET>. Same gate as api/health-cron.js.
  // Item 6 (2026-08-01): Authorization: Bearer <CRON_SECRET> only (no ?key=),
  // timing-safe, fails closed when CRON_SECRET is unset.
  if (!checkCronSecret((req.headers && req.headers.authorization) || '')) {
    return res.status(401).json({ ok: false, error: 'This endpoint runs on Vercel Cron only. Provide Authorization: Bearer <CRON_SECRET>.' });
  }
        const startedAt = Date.now();
        const deadline = startedAt + TIME_BUDGET_MS;
        const requested = req.query && req.query.resource;
        const names = requested && RESOURCES[requested] ? [requested] : Object.keys(RESOURCES);
        const counts = { clients: 0, jobs: 0, invoices: 0 };
        const duplicatesDropped = { clients: 0, jobs: 0, invoices: 0 };
        const truncatedResources = [];

  try {
            for (const name of names) {
                        const result = await syncResource(name, deadline);
                        counts[name] = result.count;
                        duplicatesDropped[name] = result.duplicatesDropped;
                        if (result.truncated) truncatedResources.push(name);
            }

          await supabaseRequest('sync_log', {
                      method: 'POST',
                      body: JSON.stringify({
                                    status: truncatedResources.length ? 'partial' : 'success',
                                    clients_synced: counts.clients,
                                    jobs_synced: counts.jobs,
                                    invoices_synced: counts.invoices,
                                    error: truncatedResources.length
                                      ? `Ran out of time budget before finishing: ${truncatedResources.join(', ')}`
                                                    : null,
                      }),
          });

          return res.status(200).json({
                      ok: true,
                      synced: names,
                      counts,
                      duplicatesDropped,
                      truncated: truncatedResources,
                      ms: Date.now() - startedAt,
          });
  } catch (err) {
            console.error('Jobber sync failed:', err);
            await supabaseRequest('sync_log', {
                        method: 'POST',
                        body: JSON.stringify({
                                      status: 'error',
                                      clients_synced: counts.clients,
                                      jobs_synced: counts.jobs,
                                      invoices_synced: counts.invoices,
                                      error: String((err && err.message) || err),
                        }),
            }).catch(() => {});

          return res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
}
