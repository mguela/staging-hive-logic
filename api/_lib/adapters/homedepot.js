// api/_lib/adapters/homedepot.js
//
// Vendor Adapter #1 -- Home Depot. Implements the vendor-neutral adapter
// interface from reina/material-catalog-procurement-prd-2026-07-19.md S8.1:
// search / getProduct / getAvailability / getAccountPricing / getRateBudget
// / normalize. NOTHING outside this file is allowed to know Home Depot's
// (or SerpApi's) native field names -- api/track1.js only ever calls these
// six functions and only ever sees the normalized vendor_offers shape back.
//
// DATA SOURCE (PRD S9 -- disclosed, not a default engineering shortcut):
// Home Depot has no self-serve public product-search API (their
// "Pro Integrations" program is a B2B quoting/ordering sales channel, not a
// developer API -- confirmed by fetching homedepot.com/c/pro-integrations
// 2026-07-19, no docs, "contact Customer Service Center"). This adapter
// defaults to SerpApi's Home Depot Search + Product APIs
// (serpapi.com/home-depot-product, engine=home_depot /
// engine=home_depot_product) -- a paid, structured-JSON, scraping-based
// third-party service. That makes it a SCRAPE-BRIDGE, not a licensed feed,
// per the PRD's own taxonomy. Every row this adapter writes is tagged
// source:'homedepot:serpapi' so it's visibly distinguishable in
// vendor_offers.source from any future licensed-feed or Partner API source.
//
// SERPAPI_KEY IS configured in Vercel (confirmed 2026-08-11 -- added
// 2026-07-20 per the dashboard, this comment just never got updated). The
// request/response shapes below were originally a good-faith mapping from
// SerpApi's published documentation, not verified against a real response;
// whether they're still unverified or have since been exercised against a
// real search is not something this comment can promise -- if you hit a
// field-name mismatch, fix normalize() against the real response, same
// iterate-on-first-real-error workflow already used for Jobber's GraphQL
// fields. connected() below still gates every function on the key actually
// being present, so a future missing/revoked key NEVER fabricates product
// data -- it returns an honest "not connected" result instead, the same
// discipline api/track1.js already uses for QuickBooks (qboConnected()) and
// the "not synced yet" RESOURCE_CONFIG pattern.

const SERPAPI_BASE = 'https://serpapi.com/search.json';

export function homedepotConnected() {
  return Boolean(process.env.SERPAPI_KEY);
}

function notConnectedResult() {
  return {
    connected: false,
    error: 'Home Depot is not connected yet -- no SERPAPI_KEY configured. Add one at serpapi.com and paste it into Vercel env vars to go live.',
    results: [],
  };
}

async function serpApiGet(params) {
  const url = new URL(SERPAPI_BASE);
  url.searchParams.set('api_key', process.env.SERPAPI_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const r = await fetch(url.toString());
  const json = await r.json();
  if (!r.ok || json.error) {
    throw new Error(`SerpApi error: ${json.error || r.statusText}`);
  }
  return json;
}

// mode in {keyword, sku, upc, model_number, category, barcode} per PRD S3.1.
// SerpApi's home_depot engine's primary discovery param is `q` (free text) --
// there is no confirmed separate param per identifier type in their public
// docs as of this writing, so every mode is passed through `q` for now. This
// is a known simplification: barcode/UPC/model-number searches will work as
// well as Home Depot's own search page resolves that text to a product,
// which is usually good for exact SKUs/UPCs/model numbers but not
// guaranteed. Flagging honestly rather than claiming exact-match behavior
// this hasn't been verified to have.
export async function search(query, mode = 'keyword', opts = {}) {
  if (!homedepotConnected()) return notConnectedResult();
  const json = await serpApiGet({
    engine: 'home_depot',
    q: query,
    store_id: opts.storeId,
    delivery_zip: opts.zip,
  });
  const raw = json.products || json.product_results || [];
  return {
    connected: true,
    searchMode: mode,
    query,
    results: raw.map(normalize),
  };
}

export async function getProduct(vendorSku, opts = {}) {
  if (!homedepotConnected()) return notConnectedResult();
  const json = await serpApiGet({
    engine: 'home_depot_product',
    product_id: vendorSku,
    store_id: opts.storeId,
    delivery_zip: opts.zip,
  });
  const raw = json.product_results || json.product || null;
  if (!raw) return { connected: true, found: false };
  return { connected: true, found: true, offer: normalize(raw) };
}

export async function getAvailability(vendorSku, storeId) {
  if (!homedepotConnected()) return notConnectedResult();
  const detail = await getProduct(vendorSku, { storeId });
  if (!detail.found) return { connected: true, found: false };
  return {
    connected: true,
    storeAvailability: detail.offer.store_availability,
    deliveryAvailability: detail.offer.delivery_availability,
  };
}

// Home Depot Pro account/contract pricing. SerpApi has no documented
// account-pricing passthrough (it scrapes the public site, not a logged-in
// Pro account) -- this always returns unavailable until Chris has a real Pro
// account integration path. Kept as a named function so the interface
// contract (PRD S8.1) stays uniform across adapters even when a given
// vendor can't fill it yet.
export async function getAccountPricing() {
  return { connected: homedepotConnected(), available: false, reason: 'Home Depot Pro account pricing is not available through the current data source (SerpApi scrapes public listings only).' };
}

// SerpApi bills by monthly search credits, not a classic rate-limit header.
// Without a live account there's no real number to report -- return null
// rather than inventing a ceiling; the S6.3 background-refresh scheduler
// should treat a null rate budget as "throttle conservatively, check
// SerpApi's dashboard" until a real account exists.
export function getRateBudget() {
  return { connected: homedepotConnected(), limitKnown: false, note: 'SerpApi bills by monthly credit allotment -- check the SerpApi account dashboard for actual remaining credits.' };
}

// Maps SerpApi's raw home_depot / home_depot_product result shape to the
// standard vendor_offers field set (PRD S2.1). This is the ONLY function in
// the codebase allowed to know SerpApi/Home Depot's native field names.
// Field names below are SerpApi's documented shape as of 2026-07 -- verify
// against the first real response and adjust here only.
export function normalize(raw) {
  return {
    vendor_key: 'homedepot',
    vendor_sku: raw.product_id || raw.item_id || null,
    store_sku: raw.store_sku || null,
    vendor_title: raw.title || '',
    manufacturer_model_number: raw.model_number || raw.model || null,
    brand: raw.brand || null,
    package_qty: raw.pack_quantity || null,
    unit_price: numOrNull(raw.price ?? raw?.pricing?.price),
    bulk_price_tiers: raw.bulk_pricing || null,
    account_price: null, // never available via SerpApi -- see getAccountPricing
    store_availability: raw.store_availability || raw.fulfillment?.store || null,
    delivery_availability: raw.delivery_availability || raw.fulfillment?.delivery || null,
    lead_time_days: raw.lead_time_days ?? null,
    product_url: raw.link || raw.product_link || null,
    image_url: (Array.isArray(raw.thumbnails) && Array.isArray(raw.thumbnails[0]) ? raw.thumbnails[0][0] : null) || raw.thumbnail || raw.images?.[0] || null,
    currency: 'USD',
    source: 'homedepot:serpapi',
    // Passed through untouched for the S3.5 AI naming pass and for
    // spec_attributes on the Product Master -- never used as the
    // standard_name directly.
    raw_specifications: raw.specifications || raw.specs || null,
    upc: raw.upc || null,
  };
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
