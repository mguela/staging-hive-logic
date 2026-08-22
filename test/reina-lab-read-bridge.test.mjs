import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../api/track1.js', import.meta.url), 'utf8');

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
