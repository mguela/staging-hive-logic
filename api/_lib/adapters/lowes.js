// api/_lib/adapters/lowes.js
//
// Vendor Adapter #2 -- Lowe's. Implements the same vendor-neutral adapter
// interface as homedepot.js (search / getProduct / getAvailability /
// getAccountPricing / getRateBudget / normalize) per the Material Catalog
// PRD S8.1. api/track1.js's materials_* resources only ever call these six
// functions through the adapters/index.js registry -- nothing outside this
// file is allowed to know Lowe's (or Unwrangle's) native field names.
//
// DATA SOURCES (updated 2026-07-21 after the deep-dive research pass):
//
//   1. UNWRANGLE (live path, scrape-bridge) -- data.unwrangle.com's
//      lowes_search / lowes_detail engines. Paid, structured-JSON,
//      scraping-based third-party service -- the exact same taxonomy as the
//      Home Depot adapter's SerpApi bridge. Gated on UNWRANGLE_API_KEY.
//      Rows are tagged source:'lowes:unwrangle' so they're visibly
//      distinguishable from any future licensed/partner source.
//
//   2. LOWE'S OFFICIAL API PORTAL (future upgrade path) --
//      portal.apim.lowes.com (Azure API Management, self-serve signup
//      confirmed 2026-07-21; API/product list is only visible after
//      login, so the request/response shapes below remain UNVERIFIED
//      placeholders). Gated on LOWES_API_KEY. Takes priority over
//      Unwrangle when both keys exist. Rows tagged source:'lowes:api'.
//      NOTE: the earlier apis-b2b-stage.lowes.com "Vendor Gateway" lead
//      was a dead end -- that's Lowe's supplier-side system, not a
//      developer API.
//
// Honesty-gating discipline (same as every adapter): with neither key
// present, every function returns an honest "not connected" result --
// this file NEVER fabricates product data. First real call against either
// source will surface field-name mismatches; fix normalize() and the
// request builders against the real response, do not guess further.

const UNWRANGLE_BASE = 'https://data.unwrangle.com/api/getter/';
const DEFAULT_BASE_URL = 'https://apis.lowes.com'; // official-API placeholder -- confirm real base URL from portal.apim.lowes.com after signup.

// Bug fix (2026-08-07, "Lowe's scraper down account-wide"): neither fetch()
// call below had a timeout, so a slow/failing Unwrangle scrape hung for a
// full minute-plus (confirmed live) before finally surfacing Unwrangle's own
// error -- every caller (materials_search, the Command Center, etc.) just
// looked frozen that whole time. This doesn't fix Unwrangle/Lowe's being
// down (that's external), it just fails fast with an honest message instead
// of hanging.
const FETCH_TIMEOUT_MS = 20000;
async function fetchWithTimeout(url, opts, label) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`${label} timed out after ${FETCH_TIMEOUT_MS / 1000}s -- it may be down or slow right now, try again shortly.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function lowesConnected() {
  return Boolean(process.env.LOWES_API_KEY || process.env.UNWRANGLE_API_KEY);
}

function activeSource() {
  if (process.env.LOWES_API_KEY) return 'api';
  if (process.env.UNWRANGLE_API_KEY) return 'unwrangle';
  return null;
}

function notConnectedResult() {
  return {
    connected: false,
    error: "Lowe's is not connected yet -- no UNWRANGLE_API_KEY (or LOWES_API_KEY) configured. Fastest path: sign up at unwrangle.com and paste UNWRANGLE_API_KEY into Vercel env vars. Long-term path: create an account at portal.apim.lowes.com and configure LOWES_API_KEY.",
    results: [],
  };
}

// ---------------------------------------------------------------------------
// Unwrangle request helper (lowes_search / lowes_detail engines).
// Docs: docs.unwrangle.com/lowes-product-search-api /
//       docs.unwrangle.com/lowes-product-data-api
// Auth is api_key as a query param. Standard plan: 10 credits per
// successful detail request (search cost per docs/dashboard).
// Optional locality: LOWES_STORE_NO / LOWES_ZIP / LOWES_ZIP_STATE env vars
// (Unwrangle's own defaults are an Alaska store -- set these for real CT
// availability/pricing).
// ---------------------------------------------------------------------------
async function unwrangleGet(params) {
  const url = new URL(UNWRANGLE_BASE);
  url.searchParams.set('api_key', process.env.UNWRANGLE_API_KEY);
  const locality = {
    store_no: process.env.LOWES_STORE_NO,
    zipcode: process.env.LOWES_ZIP,
    zip_state: process.env.LOWES_ZIP_STATE,
  };
  // Bug fix (2026-07-23): {...locality, ...params} let an explicitly-
  // undefined key in `params` (e.g. store_no when opts.storeId wasn't
  // passed -- the common case for a plain keyword search) silently clobber
  // the real LOWES_STORE_NO/LOWES_ZIP/LOWES_ZIP_STATE env-var defaults with
  // `undefined`, because object spread copies a key even when its value is
  // undefined. Every search was falling back to Unwrangle's own default
  // locality (their docs cite an Alaska store) instead of Chris's
  // configured CT-area store regardless of env vars -- confirmed live:
  // materials_search?vendor=lowes was failing with "No product data found
  // in the response" for ordinary queries (drywall, 2x4, etc.). Filtering
  // undefined/null/empty keys out of `params` first means an unset
  // opts.storeId no longer overrides the locality default; an explicitly-
  // passed one still does.
  const cleanParams = Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
  );
  for (const [k, v] of Object.entries({ ...locality, ...cleanParams })) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const r = await fetchWithTimeout(url.toString(), {}, "Unwrangle's Lowe's search");
  const json = await r.json().catch(() => null);
  if (!r.ok || json?.success === false) {
    throw new Error(`Unwrangle error: ${json?.error || json?.message || r.statusText}`);
  }
  return json;
}

// ---------------------------------------------------------------------------
// Official Lowe's API request helper -- UNVERIFIED placeholder shape, kept
// as the upgrade path. Endpoint paths/params must be corrected against the
// real portal.apim.lowes.com docs once an account + subscription exist.
// Azure APIM convention is a subscription-key header, so both header styles
// are sent; delete whichever the real docs reject.
// ---------------------------------------------------------------------------
function baseUrl() {
  return process.env.LOWES_API_BASE_URL || DEFAULT_BASE_URL;
}

async function lowesApiGet(path, params = {}) {
  const url = new URL(path, baseUrl());
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const r = await fetchWithTimeout(url.toString(), {
    headers: {
      Authorization: `Bearer ${process.env.LOWES_API_KEY}`,
      'Ocp-Apim-Subscription-Key': process.env.LOWES_API_KEY,
      Accept: 'application/json',
    },
  }, "Lowe's official API");
  const json = await r.json().catch(() => null);
  if (!r.ok) {
    throw new Error(`Lowe's API error: ${json?.error || json?.message || r.statusText}`);
  }
  return json;
}

// mode in {keyword, sku, upc, model_number, category, barcode} per PRD S3.1.
// Unwrangle's lowes_search engine has one free-text `search` param -- every
// mode passes through it, same known simplification as the Home Depot
// adapter: exact identifiers work as well as Lowes.com's own search resolves
// them (usually good for item/model numbers, not guaranteed).
export async function search(query, mode = 'keyword', opts = {}) {
  const src = activeSource();
  if (!src) return notConnectedResult();

  if (src === 'unwrangle') {
    const json = await unwrangleGet({
      platform: 'lowes_search',
      search: query,
      page: opts.page,
      store_no: opts.storeId,
    });
    const raw = json.results || json.products || [];
    return { connected: true, searchMode: mode, query, results: raw.map(normalizeUnwrangle) };
  }

  // Official API path (placeholder shape -- see header note).
  const paramByMode = {
    keyword: 'q', sku: 'itemNumber', upc: 'upc',
    model_number: 'modelNumber', category: 'category', barcode: 'upc',
  };
  const json = await lowesApiGet('/products/search', {
    [paramByMode[mode] || 'q']: query,
    storeId: opts.storeId,
    zip: opts.zip,
  });
  const raw = json.products || json.items || json.results || [];
  return { connected: true, searchMode: mode, query, results: raw.map(normalize) };
}

// Unwrangle's detail engine takes a product URL, not an item number. When
// vendorSku is already a lowes.com URL (the UI passes product_url through
// for cart adds), hit the detail engine directly; otherwise fall back to an
// exact-match search on the item number -- honest found:false when the
// search can't pin the exact item.
export async function getProduct(vendorSku, opts = {}) {
  const src = activeSource();
  if (!src) return notConnectedResult();

  if (src === 'unwrangle') {
    if (/^https?:\/\//i.test(vendorSku)) {
      const json = await unwrangleGet({ platform: 'lowes_detail', url: vendorSku });
      const raw = json.detail || json.result || json.data || null;
      if (!raw || (!raw.item_number && !raw.sku_id && !raw.name)) return { connected: true, found: false };
      return { connected: true, found: true, offer: normalizeUnwrangle(raw) };
    }
    const found = await search(String(vendorSku), 'sku', opts);
    const exact = (found.results || []).find(
      (o) => o.vendor_sku === String(vendorSku) || o.store_sku === String(vendorSku)
    );
    if (!exact) return { connected: true, found: false, note: "No exact item-number match via Unwrangle search -- pass the lowes.com product URL for a direct detail lookup." };
    return { connected: true, found: true, offer: exact };
  }

  // Official API path (placeholder shape).
  const json = await lowesApiGet(`/products/${encodeURIComponent(vendorSku)}`, {
    storeId: opts.storeId,
    zip: opts.zip,
  });
  const raw = json.product || json.item || json;
  if (!raw || (!raw.itemNumber && !raw.sku && !raw.id)) return { connected: true, found: false };
  return { connected: true, found: true, offer: normalize(raw) };
}

export async function getAvailability(vendorSku, storeId) {
  const src = activeSource();
  if (!src) return notConnectedResult();

  if (src === 'unwrangle') {
    const detail = await getProduct(vendorSku, { storeId });
    if (!detail.found) return { connected: true, found: false };
    return {
      connected: true,
      storeAvailability: detail.offer.store_availability,
      deliveryAvailability: detail.offer.delivery_availability,
    };
  }

  // Official API path (placeholder shape).
  const json = await lowesApiGet(`/products/${encodeURIComponent(vendorSku)}/availability`, { storeId });
  return {
    connected: true,
    storeAvailability: json.storeAvailability || json.store || null,
    deliveryAvailability: json.deliveryAvailability || json.delivery || null,
  };
}

// Contract/account pricing. Unwrangle scrapes public listings -- no account
// pricing, ever (same disclosure as SerpApi/Home Depot). The official API
// path keeps the account-pricing attempt for when GH Group's Lowe's account
// tier is confirmed.
export async function getAccountPricing(vendorSku, accountId) {
  const src = activeSource();
  if (!src) return { connected: false, available: false, reason: notConnectedResult().error };
  if (src === 'unwrangle') {
    return { connected: true, available: false, reason: "Lowe's account pricing is not available through Unwrangle (public-listing scrape only). Requires the official Lowe's API path." };
  }
  if (!accountId) return { connected: true, available: false, reason: "No account_id supplied -- contract pricing requires a GH Group Lowe's account identifier." };
  try {
    const json = await lowesApiGet(`/products/${encodeURIComponent(vendorSku)}/pricing`, { accountId });
    const price = numOrNull(json.contractPrice ?? json.accountPrice ?? json.price);
    return { connected: true, available: price !== null, price };
  } catch (err) {
    return { connected: true, available: false, reason: `Lowe's account pricing lookup failed: ${err.message}` };
  }
}

export function getRateBudget() {
  const src = activeSource();
  if (src === 'unwrangle') {
    return { connected: true, limitKnown: false, note: 'Unwrangle bills by credit allotment (10 credits per successful detail request on the standard plan) -- check the unwrangle.com dashboard for remaining credits.' };
  }
  return { connected: lowesConnected(), limitKnown: false, note: "Rate limit not yet confirmed -- check portal.apim.lowes.com docs once official API access exists." };
}

// ---------------------------------------------------------------------------
// normalize() -- official-API shape (UNVERIFIED placeholder, unchanged).
// normalizeUnwrangle() -- Unwrangle's documented lowes_search/lowes_detail
// shape as of 2026-07. These are the ONLY functions in the codebase allowed
// to know native field names. Verify both against the first real response
// and adjust here only.
//
// KNOWN OPEN QUESTION (flagged, not guessed): Unwrangle's docs describe the
// detail engine's price as cents and the search engine's price as a float
// of dollars. numOrNull passes the value through untouched -- verify against
// the first real detail response and, if it really is cents, divide by 100
// HERE and nowhere else.
// ---------------------------------------------------------------------------
export function normalizeUnwrangle(raw) {
  return {
    vendor_key: 'lowes',
    vendor_sku: raw.item_number || raw.id || raw.sku_id || null,
    store_sku: raw.store_sku || null,
    vendor_title: raw.name || raw.title || '',
    manufacturer_model_number: raw.model_no || raw.model_number || null,
    brand: raw.brand || null,
    package_qty: raw.package_quantity || null,
    unit_price: numOrNull(raw.price),
    bulk_price_tiers: null,
    account_price: null, // never available via Unwrangle -- see getAccountPricing
    store_availability: raw.in_stock ?? null,
    delivery_availability: raw.shipping ?? raw.delivery ?? null,
    lead_time_days: null,
    product_url: raw.url || null,
    image_url: Array.isArray(raw.images) ? raw.images[0] : raw.image || null,
    currency: 'USD',
    source: 'lowes:unwrangle',
    // Passed through untouched for the S3.5 AI naming pass and for
    // spec_attributes on the Product Master -- never used as the
    // standard_name directly.
    raw_specifications: raw.specifications || raw.specs || null,
    upc: raw.upc || null,
  };
}

export function normalize(raw) {
  return {
    vendor_key: 'lowes',
    vendor_sku: raw.itemNumber || raw.sku || raw.id || null,
    store_sku: raw.storeSku || null,
    vendor_title: raw.title || raw.description || '',
    manufacturer_model_number: raw.modelNumber || raw.model || null,
    brand: raw.brand || raw.brandName || null,
    package_qty: raw.packageQuantity || null,
    unit_price: numOrNull(raw.price ?? raw?.pricing?.price),
    bulk_price_tiers: raw.bulkPricing || null,
    account_price: numOrNull(raw.contractPrice ?? raw.accountPrice),
    store_availability: raw.storeAvailability || raw.fulfillment?.store || null,
    delivery_availability: raw.deliveryAvailability || raw.fulfillment?.delivery || null,
    lead_time_days: raw.leadTimeDays ?? null,
    product_url: raw.productUrl || raw.link || null,
    image_url: raw.imageUrl || raw.images?.[0] || null,
    currency: 'USD',
    source: 'lowes:api',
    raw_specifications: raw.specifications || raw.specs || null,
    upc: raw.upc || null,
  };
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
