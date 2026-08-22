// api/chat.js - Vercel serverless function
// Reina's real chat engine, ported from the reina-ai local prototype so
// production runs the SAME Claude-powered brain -- but wired to REAL
// Jobber-synced data (Supabase clients/jobs/invoices) instead of the
// prototype's local fake data.js collections.
// Read-only: this can only ever read records, never create or change anything.
import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { supabaseRequest } from './_lib/jobber.js';
import { getSnapshotData } from './snapshot.js';
import { getClientsData } from './clients.js';
import { getJobsListData } from './jobs.js';
import { getInvoicesData } from './invoices.js';
import { getFinancials as qboGetFinancials } from './qbo/index.js';
import { getTrackResourceData } from './track1.js';

// No import.meta/__dirname here -- this project's package.json has no "type":
// "module", so Vercel loads this file as CommonJS, where `import.meta` is a
// hard SyntaxError (not just unavailable). process.cwd() is the function's
// task root (confirmed via Vercel's own runtime logs: /var/task), which is
// exactly where the repo's api/ folder lives once deployed.
const MODEL = process.env.REINA_MODEL || 'claude-sonnet-4-5';
const MAX_TOOL_ROUNDS = 6;

// ---------- Brain: same master prompt + playbooks as reina-ai, plus an honest
// note about what's actually synced in THIS deployment (Law 1: no invented data). ----------
let SYSTEM_PROMPT;
function getSystemPrompt() {
  if (SYSTEM_PROMPT) return SYSTEM_PROMPT;
  const dir = path.join(process.cwd(), 'api', '_lib', 'brain');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort();
  const parts = files.map(f =>
    `<document name="${f}">\n${fs.readFileSync(path.join(dir, f), 'utf8')}\n</document>`
  );
  const master = parts.shift();
  const masterText = master.replace(/^<document[^>]*>\n/, '').replace(/\n<\/document>$/, '');
  SYSTEM_PROMPT = masterText +
    '\n\n# YOUR KNOWLEDGE BASE — playbooks and business facts\n\n' + parts.join('\n\n') +
    '\n\n# DATA REALITY IN THIS DEPLOYMENT\n' +
    'You are running against REAL synced Jobber data via Supabase — Clients, Jobs, Invoices, Quotes, ' +
    'Requests, Visits, Expenses, and Timesheets are all real and current, and all queryable via get_business_data. ' +
    'Vendors are not queryable via this tool. Leads exist in HiveLogic (clients flagged is_lead, plus a ' +
    'lead_pipeline table) but are not queryable via this tool either — say plainly they are not available here yet ' +
    '— never invent numbers or records for either. QuickBooks Online IS connected (as of 2026-07-16) — use get_financials ' +
    'for real cash, AR/AP, and P&L data, and always cite QuickBooks as the source. There is also no job-health scoring model for ' +
    'real Jobber jobs yet (no owner/budget/materials fields exist in this schema) — never invent a health score.';
  return SYSTEM_PROMPT;
}

// ---------- Tools ----------
const TOOLS = [
  {
    name: 'get_weather',
    description:
      '7-day weather forecast for a location (live, via Open-Meteo). Use for scheduling/dispatch questions involving outdoor work.',
    input_schema: {
      type: 'object',
      properties: { location: { type: 'string', description: 'City/town + state, or zip code, e.g. "Trenton, NJ" or "08618"' } },
      required: ['location']
    }
  },
  {
    name: 'get_datetime',
    description: 'Current date and time in the business timezone (America/New_York). Use before anything time-sensitive.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_business_data',
    description:
      "REAL live data synced from Jobber via Supabase. clients, jobs, invoices, quotes, requests, visits, expenses, " +
      "timesheets, and users are ALL real, current, synced records -- not stubs. Leads and vendors are NOT queryable " +
      "via this tool yet -- say so honestly if asked, never invent them. " +
      "action='snapshot' → company-wide counts + AR outstanding, computed across every real record (START HERE for overview questions). " +
      "action='list' with collection=clients|jobs|invoices|quotes|requests|visits|expenses|timesheets|users → up to `limit` " +
      "real records (default 25, max 200), optionally filtered client-side with filterField/filterValue (e.g. filterField='status' filterValue='draft', " +
      "or filterField='name' filterValue='desalva' to find a client by partial name). filterValue is a case- and whitespace-insensitive SUBSTRING match, " +
      "not an exact match -- you do not need the exact casing, spacing, or full spelling of a name. " +
      "action='get' with collection + id (the Jobber record id) → a single real record. " +
      "This tool is READ ONLY.",
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['snapshot', 'list', 'get'], description: 'What to fetch. Default snapshot.' },
        collection: { type: 'string', enum: ['clients', 'jobs', 'invoices', 'quotes', 'requests', 'visits', 'expenses', 'timesheets', 'users'], description: 'Required for list/get.' },
        id: { type: 'string', description: 'Jobber record id. Required for get.' },
        limit: { type: 'number', description: 'Max records for list. Default 25, max 200.' },
        filterField: { type: 'string', description: 'Optional field to filter list by, e.g. status.' },
        filterValue: { type: 'string', description: 'Optional value to filter list by.' }
      }
    }
  },
  {
    name: 'get_financials',
    description:
      "REAL live read from QuickBooks Online (connected 2026-07-16) — cash, AR/AP, and P&L. Read-only, " +
      "same connection Chris approved directly. Always cite QuickBooks as the source when answering from this. " +
      "kind='summary' (default) → cash in bank, true cash estimate, AR/AP totals, YTD P&L — START HERE for " +
      "'how are we doing financially' type questions. kind='profit_and_loss'|'balance_sheet'|'ar_aging'|" +
      "'ap_aging'|'open_invoices'|'open_bills'|'accounts' → that specific report.",
    input_schema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['summary', 'profit_and_loss', 'balance_sheet', 'ar_aging', 'ap_aging', 'open_invoices', 'open_bills', 'accounts'],
          description: 'Which QuickBooks report to pull. Default summary.'
        }
      }
    }
  }
];

const TABLE_BY_COLLECTION = {
  clients: 'clients', jobs: 'jobs', invoices: 'invoices',
  quotes: 'quotes', requests: 'requests', visits: 'visits', expenses: 'expenses',
  timesheets: 'time_sheet_entries', users: 'users'
};
// Collections whose 'list' action is served by api/track1.js's RESOURCE_CONFIG
// (real Jobber-synced tables that already have a working read/shape path
// there) rather than a dedicated clients.js/jobs.js/invoices.js-style file.
const TRACK1_LIST_COLLECTIONS = new Set(['quotes', 'requests', 'visits', 'expenses', 'timesheets', 'users']);

// get_business_data's 'snapshot'/'list' actions and get_financials used to
// self-fetch this deployment's own /api/snapshot, /api/{collection}, and
// /api/qbo routes over HTTPS -- meaning every tool call cold-started a
// SECOND serverless function even though it's the exact same deployment.
// These now call the same underlying logic in-process (each api/*.js route
// file exports its core function alongside its HTTP handler), which removes
// that extra network hop entirely. The 25-default/200-max cap for 'list' is
// preserved here exactly as it was in the old fetchList() helper -- the
// route files themselves cap at 10,000 for their normal HTTP callers (the
// frontend), so this clamp has to stay in chat.js to keep get_business_data's
// documented "max 200" behavior unchanged for Reina.
const LIST_LIMIT_DEFAULT = 25;
const LIST_LIMIT_MAX = 200;

async function getRecord(collection, id) {
  const table = TABLE_BY_COLLECTION[collection];
  const r = await supabaseRequest(`${table}?select=*&jobber_id=eq.${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(await r.text());
  const rows = await r.json();
  return rows[0] || null;
}

export async function runBusinessData(input) {
  const action = input.action || 'snapshot';
  if (action === 'snapshot') return await getSnapshotData();
  if (action === 'list') {
    if (!input.collection) return { error: 'collection required for list' };
    const cappedLimit = Math.min(Number(input.limit) || LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX);
    let rows;
    if (input.collection === 'clients') rows = (await getClientsData({ limit: cappedLimit })).clients;
    else if (input.collection === 'jobs') rows = (await getJobsListData({ limit: cappedLimit })).jobs;
    else if (input.collection === 'invoices') rows = (await getInvoicesData({ limit: cappedLimit })).invoices;
    else if (TRACK1_LIST_COLLECTIONS.has(input.collection)) {
      const result = await getTrackResourceData(input.collection, { limit: cappedLimit });
      if (result.error) return { error: result.error };
      rows = result.records;
    }
    else return { error: `Unknown collection: ${input.collection}` };
    // Case-insensitive SUBSTRING match, not exact equality (round 2 fix,
    // 2026-08-15, jomell/Chris: "what is the profit margin on AnnaMaria
    // Desalva job?" hit the tool-round limit -- root cause: exact-equality
    // matching means any filterValue that doesn't character-for-character
    // match the stored name (different spacing/casing than a real client
    // like "Anna Maria DeSalva") returns zero rows every time, so Claude
    // burned its whole tool-round budget retrying name-guess variations
    // instead of ever finding the record). A name lookup is exactly the
    // kind of query this tool needs to tolerate loosely.
    if (input.filterField) {
      // Whitespace-stripped as well as case-insensitive: a real client name
      // like "Anna Maria DeSalva" should still match a query typed as
      // "AnnaMaria Desalva" or "annamariadesalva" -- name spacing is exactly
      // the kind of detail a person asking a question won't get exactly right.
      const normalize = s => String(s).toLowerCase().replace(/\s+/g, '');
      const needle = normalize(input.filterValue);
      rows = rows.filter(r => normalize(r[input.filterField]).includes(needle));
    }
    return { collection: input.collection, records: rows };
  }
  if (action === 'get') {
    if (!input.collection || !input.id) return { error: 'collection and id required for get' };
    const rec = await getRecord(input.collection, input.id);
    return rec || { error: `${input.collection} ${input.id} not found` };
  }
  return { error: `Unknown action: ${action}` };
}

async function getWeather(location) {
  const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;
  const geoRes = await fetch(geoUrl);
  if (!geoRes.ok) throw new Error(`the geocoding service returned HTTP ${geoRes.status}.`);
  const geo = await geoRes.json();
  if (!geo.results || !geo.results.length) return { error: `Could not find location "${location}". Try "Town, ST" or a zip code.` };
  const { latitude, longitude, name, admin1 } = geo.results[0];
  const fcUrl =
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=America%2FNew_York&forecast_days=7`;
  const fcRes = await fetch(fcUrl);
  if (!fcRes.ok) throw new Error(`the forecast service returned HTTP ${fcRes.status}.`);
  const fc = await fcRes.json();
  const d = fc.daily;
  const days = d.time.map((date, i) => ({
    date,
    high_f: d.temperature_2m_max[i],
    low_f: d.temperature_2m_min[i],
    precip_prob_pct: d.precipitation_probability_max[i],
    precip_total_in: d.precipitation_sum[i],
    wind_max_mph: d.wind_speed_10m_max[i]
  }));
  return { location: `${name}, ${admin1 || ''}`.trim(), source: 'Open-Meteo live forecast', days };
}

function getDatetime() {
  return {
    now: new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'full', timeStyle: 'short' }),
    timezone: 'America/New_York'
  };
}

async function runTool(name, input) {
  try {
    if (name === 'get_weather') return await getWeather(input.location);
    if (name === 'get_datetime') return getDatetime();
    if (name === 'get_business_data') return await runBusinessData(input);
    if (name === 'get_financials') return await qboGetFinancials(input.kind || 'summary');
    return { error: `Unknown tool: ${name}` };
  } catch (e) {
    return { error: `Tool ${name} failed: ${e.message}` };
  }
}

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

function buildParams(convo) {
  return {
    model: MODEL,
    max_tokens: 1600, // Reina answers tight; smaller ceiling = snappier
    system: [{ type: 'text', text: getSystemPrompt(), cache_control: { type: 'ephemeral' } }],
    tools: TOOLS,
    messages: convo
  };
}

import { verifyRequestUser } from './_lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  if (!anthropic) return res.status(409).json({ ok: false, error: 'ANTHROPIC_API_KEY is not set for this deployment.' });
  // 2026-08-15: this used to be `requireUser(req)` and a flat 401 "Not signed
  // in." for every failure -- including the case where the DEPLOYMENT has no
  // Supabase credentials to verify anyone with. That is what "Reina chat
  // doesn't authenticate on Vercel preview deployments" looked like from the
  // outside: a correctly signed-in user, told they were signed out, on a
  // deployment that simply could not check. Report the deployment's own
  // problem as the deployment's problem -- same spirit as the
  // ANTHROPIC_API_KEY 409 directly above -- and keep a plain 401 for a caller
  // who really is signed out. Still fail-closed either way: no request gets
  // through unverified.
  const _auth = await verifyRequestUser(req);
  if (!_auth.ok) {
    if (_auth.reason === 'auth-unconfigured') {
      return res.status(503).json({
        ok: false,
        code: 'auth_unconfigured',
        error: 'This deployment cannot verify sign-ins: no Supabase URL/key is set for it. If this is a Vercel preview deployment, add SUPABASE_URL and SUPABASE_ANON_KEY to the Preview environment.',
      });
    }
    if (_auth.reason === 'verify-failed') {
      return res.status(503).json({
        ok: false,
        code: 'auth_verify_failed',
        error: 'Could not reach Supabase to verify your sign-in. This is not a sign-in problem — try again in a moment.',
      });
    }
    return res.status(401).json({ ok: false, code: 'not_signed_in', error: 'Not signed in.' });
  }
  const _authedUser = _auth.user;
  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ ok: false, error: 'messages array required' });
    }
    let convo = [...messages];
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const resp = await anthropic.messages.create(buildParams(convo));
      if (resp.stop_reason === 'tool_use') {
        // Run every tool Claude asked for in this round CONCURRENTLY instead
        // of one at a time -- e.g. a "morning brief" question asks for
        // weather + business data + financials in the same turn, and those
        // are independent calls with no reason to wait on each other.
        // runTool() always catches its own errors and returns {error: ...}
        // rather than throwing, so Promise.all here can't reject and leave
        // a tool_use block without a matching tool_result.
        const toolBlocks = resp.content.filter(block => block.type === 'tool_use');
        const results = await Promise.all(toolBlocks.map(block => runTool(block.name, block.input)));
        const toolResults = toolBlocks.map((block, i) => ({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(results[i])
        }));
        convo.push({ role: 'assistant', content: resp.content });
        convo.push({ role: 'user', content: toolResults });
        continue;
      }
      const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      return res.status(200).json({ ok: true, reply: text, model: resp.model });
    }
    return res.status(200).json({ ok: true, reply: "⚠️ I hit my tool-use limit on this one. Ask me again more specifically." });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}