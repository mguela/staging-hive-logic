import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Normalized line endings: the 'legacyExactQuery' slice below looks for
// 'requestedJobNumber\n', which on a Windows checkout (core.autocrlf gives this
// file CRLF) never matched -- indexOf returned -1, the slice came back empty,
// and its doesNotMatch assertion passed against nothing at all. It was green
// and testing air. In CI, where the checkout is LF, it did real work; that gap
// is exactly what makes this kind of failure invisible.
const source = (await readFile(new URL('../api/track1.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

test('bridge is read-only, timing-safe, and uses a dedicated secret', () => {
  assert.match(source, /resource === 'reina_lab_read' && req\.method === 'GET'/);
  assert.match(source, /process\.env\.REINA_LAB_READ_TOKEN/);
  assert.match(source, /crypto\.timingSafeEqual/);
  assert.match(source, /Cache-Control', 'no-store'/);
  assert.doesNotMatch(source, /REINA_LAB_READ_TOKEN.*CRON_SECRET/);
  assert.match(source, /process\.env\.REINA_LAB_FULL_READ_ENABLED !== 'true'/);
});

test('a configured Lab token does not silently expand the existing narrow connector', () => {
  const section = source.slice(source.indexOf('async function handleReinaLabRead'), source.indexOf('// ---------- Live tech-header status'));
  const gate = section.indexOf("process.env.REINA_LAB_FULL_READ_ENABLED !== 'true'");
  const broad = section.indexOf("mode: 'full_business_read'");
  assert.ok(gate >= 0 && broad > gate);
  const fallbackEnd = section.indexOf('\n  const text =', gate);
  assert.ok(fallbackEnd > gate && fallbackEnd < broad);
  const fallback = section.slice(gate, fallbackEnd);
  assert.match(fallback, /jobs\?select=job_number,title,job_status,start_at,end_at,jobber_updated_at/);
  assert.doesNotMatch(fallback, /clients\?select=|invoices\?select=|expenses\?select=/);
});

test('bridge projection contains real fleet, jobs, and broad read-only business areas', () => {
  // Vehicle position comes from FleetSharp only as of 2026-08-16 (Chris:
  // "Remove Jobber GPS from this equation all together"). Jobber's feed on
  // this account has been frozen since 2026-07-28, so selecting its columns
  // fed Reina three-week-old positions that looked current. This used to pin
  // the literal Jobber select; it now pins the shared column constant and,
  // more usefully, that the stale source is NOT selected.
  assert.match(source, /vehicles\?select=name,\$\{VEHICLE_GPS_COLUMNS\}&order=name\.asc/);
  assert.doesNotMatch(source, /vehicles\?select=name,status,speed,latitude,longitude,gps_updated_at/);
  assert.match(source, /jobs_enriched\?select=job_number,title,job_status,job_type,total/);
  const section = source.slice(source.indexOf('async function handleReinaLabRead'), source.indexOf('// ---------- Live tech-header status'));
  for (const required of ['clients?', 'invoices?', 'quotes?', 'job_workflow?', 'visits?', 'lead_pipeline?', 'requests?', 'expenses?', 'vendors?', 'subscriptions?', 'subcontractors?', 'purchase_orders?', 'estimates?', 'sync_log?']) {
    assert.match(section, new RegExp(required.replace('?', '\\?')));
  }
  for (const area of ['executive', 'clients', 'jobs', 'schedule', 'receivables', 'estimates', 'sales', 'expenses', 'vendors', 'subscriptions', 'subcontractors', 'purchasing', 'fleet', 'today_decisions', 'sync_health']) {
    assert.match(section, new RegExp(`['"]${area}['"]`));
  }
  assert.match(section, /mode:\s*'full_business_read'/);
  assert.match(section, /readOnly:\s*true/);
});

test('bridge supports an exact read-only job-number lookup outside the recent snapshot', () => {
  const section = source.slice(source.indexOf('async function handleReinaLabRead'), source.indexOf('// ---------- Live tech-header status'));
  assert.match(section, /req\.query && req\.query\.job_number/);
  assert.match(section, /\^\[a-z0-9-\]\{2,40\}\$/i);
  assert.match(section, /job_number=eq\.\$\{encodeURIComponent\(requestedJobNumber\)\}/);
  assert.match(section, /limit=2/);
  assert.match(section, /\? \{ available: true, jobNumber: requestedJobNumber, record:/);
  assert.match(section, /jobLookup,/);
  const legacyExactQuery = section.slice(section.indexOf('requestedJobNumber\n'), section.indexOf('(async () => {', section.indexOf('requestedJobNumber\n')));
  assert.doesNotMatch(legacyExactQuery, /job_number=ilike|or=\(/i);
});

test('bridge supports targeted client, invoice, estimate, job, and vehicle lookups outside recent snapshots', () => {
  const section = source.slice(source.indexOf('async function handleReinaLabRead'), source.indexOf('// ---------- Live tech-header status'));
  assert.match(section, /lookup_kind/);
  assert.match(section, /lookup_term/);
  for (const kind of ['client', 'invoice', 'estimate', 'job', 'vehicle']) assert.match(section, new RegExp(`requestedLookupKind === '${kind}'`));
  assert.match(section, /clients\?select=jobber_id,name,company_name/);
  assert.match(section, /invoices\?select=jobber_id,client_id,invoice_number/);
  assert.match(section, /quotes\?select=jobber_id,quote_number/);
  assert.match(section, /jobs_enriched\?select=job_number,title/);
  assert.match(section, /'dump truck': '2014 RAM 5500'/);
  assert.match(section, /client_locations\?select=jobber_id,street,city,lat,lng/);
  assert.match(section, /locationLabel = text\(client\?\.name \|\| client\?\.company_name/);
  assert.match(section, /locationLabel = 'the shop'/);
  assert.match(section, /matched_client_address/);
  assert.doesNotMatch(section, /locationLabel, address, locationSource,\s*latitude|locationLabel, address, locationSource,\s*longitude/);
  assert.match(section, /exactLookup: exactLookupResult/);
});

test('client projection supports global search without exposing contact details', () => {
  const section = source.slice(source.indexOf('async function handleReinaLabRead'), source.indexOf('// ---------- Live tech-header status'));
  assert.match(section, /clients\?select=jobber_id,name,company_name,is_lead,is_archived,jobber_created_at,jobber_updated_at/);
  assert.match(section, /clientRef/);
  assert.doesNotMatch(section, /clients\?select=[^'\n]*(?:email|phone|street)/i);
});

test('broad bridge still excludes credentials, private contact data beyond the approved vehicle place label, banking, payroll, and write operations', () => {
  const section = source.slice(source.indexOf('async function handleReinaLabRead'), source.indexOf('// ---------- Live tech-header status'));
  for (const forbidden of ['email', 'phone', 'postal_code', 'country', 'license_plate', 'vin', 'tax_id', 'routing_number', 'account_number', 'access_token', 'refresh_token']) {
    assert.doesNotMatch(section, new RegExp(`\\b${forbidden}\\b`, 'i'));
  }
  assert.doesNotMatch(section, /select=\*/i);
  assert.doesNotMatch(section, /method:\s*['"](?:PATCH|PUT|DELETE)['"]/i);
  const postCalls = section.match(/method:\s*['"]POST['"]/gi) || [];
  assert.equal(postCalls.length, 1, 'only the read-only executive aggregate RPC may use POST');
  assert.match(section, /supabaseRequest\('rpc\/snapshot_aggregates',\s*\{\s*method:\s*'POST'/);
  assert.match(section, /excluded:\s*\[[^\]]*'credentials'[^\]]*'bank accounts'[^\]]*'payroll'[^\]]*'write operations'/s);
});

// Mail is the one source that carries a person's address, and it is handled the
// way vehicle GPS is: the raw value is fetched inside this function and only a
// reduced label leaves it. A domain distinguishes a supplier from a customer;
// the address itself is contact data and never reaches a model prompt.
test('triaged mail reaches Reina as a summary, never as an inbox', () => {
  const section = source.slice(source.indexOf('async function handleReinaLabRead'), source.indexOf('// ---------- Live tech-header status'));
  assert.match(section, /reina_mail_triage\?select=subject,from_name,from_address,received_at/);
  assert.match(section, /fromDomain: text\(String\(row\.from_address \|\| ''\)\.split\('@'\)\[1\]/,
    'the sender is reduced to a domain inside the bridge');
  assert.doesNotMatch(section, /fromAddress:/, 'the address itself never leaves this function');
  assert.doesNotMatch(section, /reina_mail_triage\?select=[^'\n]*\bbody\b/i,
    'message bodies are a different decision than triage summaries');
  assert.match(section, /'mail'/, 'and the access statement names it');
});

test('bridge reuses the exact cached Command Center Daily Brief for Today\'s Decisions', () => {
  const section = source.slice(source.indexOf('async function handleReinaLabRead'), source.indexOf('// ---------- Live tech-header status'));
  assert.match(section, /handleFiDailyBrief\(capture\)/);
  assert.match(section, /todayDecisions/);
  for (const field of ['headline', 'asOf', 'type', 'text', 'source', 'confidence']) {
    assert.match(section, new RegExp(`\\b${field}\\b`));
  }
  assert.doesNotMatch(section, /decision\.view/);
  assert.doesNotMatch(section, /decision\.(?:approve|reject|execute|send)|(?:approve|reject|execute|send)Decision\s*:/i);
});

// ---- what is actually owed ---------------------------------------------------
// Chris: "why doesn't reina have access to client accounts and totals due,
// invoices, estimates etc".
//
// She had the access. The queries behind it were the problem, and both failed
// in the same silent way -- returning nothing, or returning the wrong nothing,
// rather than erroring:
//
//   Receivables filtered on `balance > 0`. Jobber's sync has never written
//   that column: all 2,852 invoices carry balance = NULL. So the filter matched
//   zero rows and Reina, asked who owed money, said nobody -- while 27 invoices
//   sat past due and about $232k was outstanding.
//
//   Estimates were ordered by last-updated across the whole table, where 730
//   archived and 666 converted quotes bury the ten still awaiting an answer.
//   She could see estimates and could not have told you which were open.

test('unpaid invoices are selected by status, not by a column nobody fills in', () => {
  const section = source.slice(source.indexOf('async function handleReinaLabRead'), source.indexOf('// ---------- Live tech-header status'));
  assert.doesNotMatch(section, /invoices\?select=[^'`\n]*balance=gt\.0/,
    'a filter on an unwritten column answers "none" instead of failing');
  assert.match(section, /invoice_status=in\.\(\$\{RECEIVABLE_STATUSES\.join\(','\)\}\)/);
  for (const status of ['past_due', 'awaiting_payment', 'bad_debt', 'draft']) {
    assert.match(section, new RegExp(`'${status}'`), `${status} is money not yet collected`);
  }
});

test('an amount owed says whether it is exact or derived, using the shared sum', () => {
  // Jobber's own balance when there is one; otherwise total minus payments,
  // deposit and discount, clamped at zero -- the same arithmetic the invoices
  // screen and the client portal use. Reina quoting a different number than
  // the screen shows would be worse than her not knowing, and the first
  // version of this file did exactly that: it forgot the discount and the
  // clamp. One helper owns the sum now.
  const section = source.slice(source.indexOf('async function handleReinaLabRead'), source.indexOf('// ---------- Live tech-header status'));
  assert.match(section, /const owed = invoiceAmountDue\(row\);/);
  assert.match(section, /amountDue: owed\.amountDue/);
  assert.match(section, /amountDueIsExact: owed\.isExact/);
  assert.match(section, /invoices\?select=[^'`\n]*\bdiscount\b/,
    'the discount must be read, or the shared sum cannot subtract it');
  assert.doesNotMatch(section, /Math\.round\(\(total - \(number\(row\.payments\)/,
    'no hand-written copy of the sum');
});

test('an unpaid invoice carries the name of whoever owes it', () => {
  // "Who owes me money" is a question about people. An invoice number with no
  // name attached does not answer it.
  const section = source.slice(source.indexOf('async function handleReinaLabRead'), source.indexOf('// ---------- Live tech-header status'));
  assert.match(section, /clientName: text\(names\.get\(String\(row\.client_id\)\), 160\)/);
  assert.match(section, /clients\?select=jobber_id,name,company_name&jobber_id=in\./);
});

test('open estimates are read on their own so archived ones cannot bury them', () => {
  const section = source.slice(source.indexOf('async function handleReinaLabRead'), source.indexOf('// ---------- Live tech-header status'));
  assert.match(section, /quote_status=in\.\(\$\{OPEN_QUOTE_STATUSES\.join\(','\)\}\)/);
  assert.match(section, /quote_status=not\.in\.\(\$\{OPEN_QUOTE_STATUSES\.join\(','\)\}\)/);
  assert.match(section, /records: \[\.\.\.open, \.\.\.recent\]/, 'the live ones come first');
  assert.match(section, /openCount: open\.length/, 'and how many are live is stated, not inferred');
});

// ---- the rest of the business ------------------------------------------------
// Reina, reading the right Thursday calendar: "Technician assignments aren't
// included, so I can't confirm coverage for every technician." The column was
// there and synced -- visits.assigned_users, which the dispatch board has used
// all along -- and the projection simply never selected it. That turned out to
// be the shape of the whole gap: the rows existed and nothing asked for them.

test('a scheduled visit says who is on it', () => {
  const section = source.slice(source.indexOf('async function handleReinaLabRead'), source.indexOf('// ---------- Live tech-header status'));
  assert.match(section, /visits\?select=[^'`\n]*\bassigned_users\b/);
  assert.match(section, /assignedTo: assignedNames\(row\.assigned_users\)/);
  assert.match(section, /const assignedNames = \(value\) =>/);
  assert.doesNotMatch(section, /assignedTo:[^\n]*entry\.id/,
    'a Jobber user id is an identifier for systems, not an answer to "who is on this job"');
});

test('the areas with real rows in them are all reachable', () => {
  const section = source.slice(source.indexOf('async function handleReinaLabRead'), source.indexOf('// ---------- Live tech-header status'));
  for (const [area, table] of [
    ['people', 'employee_roles'],
    ['timeclock', 'workforce_time_sessions'],
    ['timesheets', 'time_sheet_entries'],
    ['activity', 'timeline_events'],
    ['photos', 'media'],
    ['costing', 'cost_lines'],
    ['calls', 'voice_calls'],
  ]) {
    assert.match(section, new RegExp(`when\\('${area}'`), `${area} is wired into the read`);
    assert.match(section, new RegExp(`${table}\\?select=`), `${area} reads ${table}`);
  }
});

test('the new areas keep the same exclusions as the old ones', () => {
  const section = source.slice(source.indexOf('async function handleReinaLabRead'), source.indexOf('// ---------- Live tech-header status'));
  // media rows carry gps_lat/gps_lng. Where a photo was taken is a coordinate,
  // and coordinates never leave this function -- the same rule the vehicle
  // read follows.
  assert.doesNotMatch(section, /media\?select=[^'`\n]*gps_/i);
  // voice_calls carries from_number/to_number and a full transcript. What a
  // call was about is a business fact; who called and what was said word for
  // word is not this bridge's to hand over.
  assert.doesNotMatch(section, /voice_calls\?select=[^'`\n]*(from_number|to_number)/i);
  assert.doesNotMatch(section, /voice_calls\?select=[^'`\n]*\btranscript\b/i);
  assert.match(section, /voice_calls\?select=[^'`\n]*ai_summary/i);
});

// ---- coverage must not cost a turn -------------------------------------------
// Reading every area on every turn is exactly what pushed the composer past
// its budget and made her answer "unavailable" to everything. Twenty-three
// areas cannot each be a query on a question about one of them.

test('only the areas a question is about are read', () => {
  const section = source.slice(source.indexOf('async function handleReinaLabRead'), source.indexOf('// ---------- Live tech-header status'));
  assert.match(section, /const wants = \(name\) => requestedAreas\.length === 0 \|\| requestedAreas\.includes\(name\)/);
  assert.match(section, /const when = \(name, read\) => wants\(name\) \? read\(\) : Promise\.resolve\(skipped\)/);
  assert.match(section, /reason: 'Not read for this turn\. Ask about it directly\.'/,
    'an area that was skipped says so rather than looking empty');
});

test('a caller that names no areas still gets everything, as it always did', () => {
  const section = source.slice(source.indexOf('async function handleReinaLabRead'), source.indexOf('// ---------- Live tech-header status'));
  assert.match(section, /requestedAreas\.length === 0 \|\|/,
    'no areas parameter means all of them, so existing callers are untouched');
  assert.match(section, /areasReadThisTurn: requestedAreas\.length \? requestedAreas : 'all'/,
    'and the answer states which it was');
});

// ---- one job, in depth -------------------------------------------------------
// "was the material ordered for this job" -> "that job's material status isn't
// available here". True, and useless. Every area the bridge reads is a
// business-wide list one row deep per job; there was no way to go DOWN into a
// single job. Job 2985 has a visit, nine timeline entries and nine photos
// attached to it, and none of them could be reached.

test('a question about one job reads what is attached to that job', () => {
  const dossier = source.slice(source.indexOf('const readJobDossier'), source.indexOf('const exactLookup'));
  assert.match(dossier, /const readJobDossier = async \(job, jobNumber\) =>/);
  for (const [table, key] of [
    ['visits', 'job_id'], ['timeline_events', 'job_id'], ['media', 'job_id'],
    ['invoices', 'job_id'], ['expenses', 'job_id'], ['change_orders', 'job_id'],
    ['job_line_items', 'job_ref'], ['job_workflow', 'job_ref'], ['time_sheet_entries', 'job_id'],
  ]) {
    assert.ok(dossier.includes(`${table}?select=`), `${table} is read for the job in focus`);
    assert.ok(dossier.includes(`${key}=eq.${'${id}'}`), `${table} is filtered to that one job`);
  }
});

test('a dossier says in words that an empty section means nothing was recorded', () => {
  // In JSON "no records" and "not read" look identical and mean opposite
  // things. One is a fact about the business; the other is a gap in the read.
  const section = source.slice(source.indexOf('async function handleReinaLabRead'), source.indexOf('// ---------- Live tech-header status'));
  assert.match(section, /means nothing has been recorded against this job, not that it was not read/i);
});

test('a job number that is not unique buys no dossier at all', () => {
  const section = source.slice(source.indexOf('async function handleReinaLabRead'), source.indexOf('// ---------- Live tech-header status'));
  assert.match(section, /if \(!Array\.isArray\(rows\) \|\| rows\.length !== 1\) return null;/,
    'answering "this job" from an ambiguous match would be worse than not answering');
  assert.match(section, /if \(!job \|\| \(!job\.jobberId && !job\.uuidId\)\) return null;/);
});

test('the dossier carries who was on each visit, and no coordinates', () => {
  const section = source.slice(source.indexOf('const readJobDossier'), source.indexOf('const exactLookup'));
  assert.match(section, /assignedTo: assignedNames\(row\.assigned_users\)/);
  assert.doesNotMatch(section, /gps_/i, 'photo coordinates stay out of the dossier too');
  assert.match(section, /invoiceAmountDue\(row\)/, 'money uses the one shared sum');
});

// ---- "when we have a check for materials, will she know to check?" ---------
//
// There IS a check for materials, and it is not one thing. Job Setup has a
// five-gate, twelve-item checklist; the Materials gate is driven by the
// materials status staff set on the job, and the gate is named "Materials &
// POs" because a purchase order is the other half of the same answer.
//
// Two ways that could have gone wrong quietly:
//
// job_workflow stores ONLY the boxes somebody has touched. An untouched box
// is absent, so a job where nobody has confirmed anything and a job with no
// checklist at all look identical -- and "materials are not on site" and
// "nobody has said either way" are different answers to give a foreman.
//
// purchase_orders keys on job_id (a Jobber id) and ALSO carries job_uuid, the
// row's own key. The table is empty today, so a wrong guess between the two
// would cost nothing until the first PO is raised, and then it would report
// "no purchase orders on this job" forever without erroring once.

test('the full setup checklist is offered, ticked or not', () => {
  const section = source.slice(source.indexOf('const READINESS_GATES'), source.indexOf('const readJobDossier'));
  for (const item of [
    'Start date confirmed with client', 'Access and parking arranged',
    'Deposit invoice sent', 'Payment received and cleared', 'Materials on site',
    'Permits filed and approved', 'Plans and specs in job folder', 'COI current',
    'Lead and helpers chained', 'Sub commitments confirmed',
  ]) {
    assert.ok(section.includes(item), `${item} is one of the twelve and is named`);
  }
  assert.match(section, /done: !!\(entry && entry\.done === true\)/,
    'an item nobody has touched reads as not done, not as missing');
  assert.match(section, /materialsOnSite: !!\(workflowRow && workflowRow\.materials_status === 'on_site'\)/,
    'the materials box is computed the way the setup screen computes it');
  assert.match(section, /depositPaid: !!\(workflowRow && workflowRow\.deposit_paid_at\)/);
});

test('who ticked a box is a person, not their address', () => {
  const section = source.slice(source.indexOf('const READINESS_GATES'), source.indexOf('const readJobDossier'));
  assert.match(section, /checkedBy: by \? by\.split\('@'\)\[0\] : null/,
    'readiness_items stores sign-in addresses and this bridge does not hand out addresses');
});

test('purchase orders for a job are asked for under both of its identities', () => {
  const dossier = source.slice(source.indexOf('const readJobDossier'), source.indexOf('const exactLookup'));
  assert.ok(dossier.includes('purchase_orders?select='), 'the Materials gate is "Materials & POs"');
  assert.match(dossier, /readPurchaseOrders\('job_id', job\.jobberId\)/);
  assert.match(dossier, /readPurchaseOrders\('job_uuid', job\.uuidId\)/);
  assert.match(dossier, /purchaseOrders: mergePurchaseOrders\(posByJobberId, posByUuid\)/);
});

test('a job carrying only one identity still gets a straight answer', () => {
  const dossier = source.slice(source.indexOf('const readJobDossier'), source.indexOf('const exactLookup'));
  // The absent identity is not a failed read -- it is an identity nothing
  // could be filed under, so there is genuinely nothing to report.
  assert.match(dossier, /const NO_IDENTITY = \{ available: true, records: \[\] \}/);
  assert.match(dossier, /if \(a\.available !== true && b\.available !== true\)/,
    'both sources failing is unavailable; one failing is not "no purchase orders"');
  assert.match(dossier, /if \(seen\.has\(key\)\) continue;/,
    'a PO filed under both ids is one purchase order');
});

test('the dossier says what an unticked checklist item means', () => {
  const section = source.slice(source.indexOf('async function handleReinaLabRead'), source.indexOf('// ---------- Live tech-header status'));
  assert.match(section, /setupChecklist is the Job Setup checklist in full/);
  assert.match(section, /done:false means it has not been confirmed/);
});
