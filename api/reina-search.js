import { requireUser } from './_lib/auth.js';
import { supabaseRequest } from './_lib/jobber.js';

const MAX_QUERY_LENGTH = 120;
const MAX_RESULTS = 20;
const SEARCH_LIMIT = 5;

function searchEnabled(env) {
  if (!env || env.REINA_GLOBAL_SEARCH_ENABLED !== 'true') return false;
  if (env.NODE_ENV === 'test') return true;
  if (env.VERCEL_ENV === 'preview') return true;
  return env.VERCEL_ENV === 'production'
    && env.REINA_GLOBAL_SEARCH_PRODUCTION_ENABLED === 'true';
}

const SEARCH_SOURCES = Object.freeze([
  {
    kind: 'CLIENT',
    table: 'clients',
    select: 'jobber_id,name,company_name,is_lead,is_archived,jobber_updated_at',
    fields: ['name', 'company_name'],
    map: (row) => ({
      kind: 'CLIENT',
      id: String(row.jobber_id),
      title: row.name || row.company_name || 'Unnamed client',
      subtitle: row.is_archived ? 'Archived client' : (row.is_lead ? 'Lead' : 'Client'),
      status: row.is_archived ? 'archived' : (row.is_lead ? 'lead' : 'active'),
      updatedAt: row.jobber_updated_at || null,
      navigation: { view: 'clients', recordType: 'client', recordId: String(row.jobber_id) },
    }),
  },
  {
    kind: 'JOB',
    table: 'jobs_enriched',
    select: 'jobber_id,job_number,title,job_status,client_name,loc_city,loc_province,jobber_updated_at',
    fields: ['job_number', 'title', 'client_name'],
    map: (row) => ({
      kind: 'JOB',
      id: String(row.jobber_id),
      title: `${row.job_number ? `#${row.job_number} · ` : ''}${row.title || 'Untitled job'}`,
      subtitle: [row.client_name, row.loc_city, row.loc_province].filter(Boolean).join(' · '),
      status: row.job_status || null,
      updatedAt: row.jobber_updated_at || null,
      navigation: { view: 'jobs', recordType: 'job', recordId: String(row.jobber_id) },
    }),
  },
  {
    kind: 'ESTIMATE',
    table: 'quotes',
    select: 'jobber_id,quote_number,title,quote_status,client_name,total,jobber_updated_at',
    fields: ['quote_number', 'title', 'client_name'],
    map: (row) => ({
      kind: 'ESTIMATE',
      id: String(row.jobber_id),
      title: `${row.quote_number ? `#${row.quote_number} · ` : ''}${row.title || 'Untitled estimate'}`,
      subtitle: row.client_name || 'Estimate',
      status: row.quote_status || null,
      amount: finiteMoney(row.total),
      updatedAt: row.jobber_updated_at || null,
      navigation: { view: 'estimates', recordType: 'estimate', recordId: String(row.jobber_id) },
    }),
  },
  {
    kind: 'INVOICE',
    table: 'invoices',
    select: 'jobber_id,invoice_number,subject,invoice_status,total,balance,due_date,job_id,jobber_updated_at',
    fields: ['invoice_number', 'subject'],
    map: (row) => ({
      kind: 'INVOICE',
      id: String(row.jobber_id),
      title: `${row.invoice_number ? `#${row.invoice_number} · ` : ''}${row.subject || 'Invoice'}`,
      subtitle: row.due_date ? `Due ${row.due_date}` : 'Invoice',
      status: row.invoice_status || null,
      amount: finiteMoney(row.balance ?? row.total),
      updatedAt: row.jobber_updated_at || null,
      navigation: { view: 'invx', recordType: 'invoice', recordId: String(row.jobber_id) },
    }),
  },
  {
    kind: 'REQUEST',
    table: 'requests',
    select: 'jobber_id,title,request_status,client_id,jobber_created_at,jobber_updated_at',
    fields: ['title'],
    map: (row) => ({
      kind: 'REQUEST',
      id: String(row.jobber_id),
      title: row.title || 'Untitled request',
      subtitle: 'Client request',
      status: row.request_status || null,
      updatedAt: row.jobber_updated_at || row.jobber_created_at || null,
      navigation: { view: 'rqx', recordType: 'request', recordId: String(row.jobber_id) },
    }),
  },
]);

function finiteMoney(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function setSecurityHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Robots-Tag', 'noindex');
}

function normalizedQuery(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, MAX_QUERY_LENGTH);
}

function postgrestTerm(value) {
  // PostgREST's `or` grammar treats punctuation as syntax. Keep normal names,
  // numbers, spaces, apostrophes and hyphens; discard query-language tokens.
  return value.replace(/[^\p{L}\p{N} '\-#]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

async function exactAdminProfile(userId, request) {
  let response;
  try { response = await request(`profiles?id=eq.${encodeURIComponent(userId)}&select=id,role&limit=2`); }
  catch { return false; }
  if (!response?.ok) return false;
  let rows;
  try { rows = await response.json(); } catch { return false; }
  return Array.isArray(rows) && rows.length === 1 && rows[0]?.id === userId && (rows[0]?.role === 'admin' || rows[0]?.role === 'superadmin');
}

function sourcePath(source, term) {
  const encoded = encodeURIComponent(`*${term}*`);
  const filters = source.fields.map((field) => `${field}.ilike.${encoded}`).join(',');
  return `${source.table}?select=${source.select}&or=(${filters})&order=jobber_updated_at.desc.nullslast&limit=${SEARCH_LIMIT}`;
}

export async function searchHiveLogic(query, dependencies = {}) {
  const request = dependencies.supabaseRequest || supabaseRequest;
  const term = postgrestTerm(normalizedQuery(query));
  if (term.length < 2) return { query: term, results: [], unavailable: [] };

  const settled = await Promise.allSettled(SEARCH_SOURCES.map(async (source) => {
    const response = await request(sourcePath(source, term));
    if (!response?.ok) throw new Error(`${source.kind}_UNAVAILABLE`);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error(`${source.kind}_MALFORMED`);
    return rows.map(source.map).filter((item) => item.id && item.title);
  }));

  const results = [];
  const unavailable = [];
  settled.forEach((entry, index) => {
    if (entry.status === 'fulfilled') results.push(...entry.value);
    else unavailable.push(SEARCH_SOURCES[index].kind);
  });
  if (unavailable.length === SEARCH_SOURCES.length) throw new Error('SEARCH_UNAVAILABLE');
  return { query: term, results: results.slice(0, MAX_RESULTS), unavailable };
}

export async function handleReinaSearch(req, res, dependencies = {}) {
  setSecurityHeaders(res);
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  const env = dependencies.env || process.env;
  if (!searchEnabled(env)) {
    return res.status(503).json({ ok: false, code: 'REINA_SEARCH_DISABLED', error: 'Reina search is not enabled.' });
  }

  const authenticate = dependencies.requireUser || requireUser;
  const request = dependencies.supabaseRequest || supabaseRequest;
  const user = await authenticate(req);
  if (!user?.id) return res.status(401).json({ ok: false, error: 'Authentication required.' });
  if (!(await exactAdminProfile(user.id, request))) {
    return res.status(403).json({ ok: false, error: 'Reina search is not available for this account.' });
  }

  const query = normalizedQuery(req.query?.q);
  if (query.length < 2) return res.status(200).json({ ok: true, query, results: [], unavailable: [] });

  try {
    const data = await searchHiveLogic(query, { supabaseRequest: request });
    return res.status(200).json({ ok: true, ...data });
  } catch (error) {
    const correlationId = globalThis.crypto?.randomUUID?.() || `reina-search-${Date.now()}`;
    console.error('Reina search failed', { correlationId, message: error?.message || 'unknown' });
    return res.status(503).json({ ok: false, error: 'Search is temporarily unavailable.', correlationId });
  }
}

export default function handler(req, res) {
  return handleReinaSearch(req, res);
}

export const _internals = Object.freeze({ searchEnabled });
