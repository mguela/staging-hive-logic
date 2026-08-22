// api/_lib/adapters/ringsend.js
//
// Vendor Adapter #4 -- Ring's End. Structurally different again from
// Home Depot/Lowe's (live REST) and Ferguson (PunchOut session): Ring's End
// has no public API and no confirmed integration path yet (build scope S5
// open question) -- per the 2026-07-19 vendor deep dive this needs a direct
// ask (account rep or branch manager) for a full active-product export, GH
// Group's account price list, a branch inventory file, and whatever format
// they're willing to provide (CSV/Excel/API/PunchOut). Until that exists,
// this adapter has nothing to call -- there is no vendor endpoint AND no
// imported data yet.
//
// DATA SOURCE: a scheduled feed import (frequency TBD once Ring's End
// agrees to one), landing in a Supabase table -- NOT a live HTTP call at
// query time. search/getProduct/getAvailability below read already-imported
// rows via supabaseRequest (the same Supabase REST helper jobber.js and
// track1.js already use), never Ring's End directly.
//
// That table does NOT exist yet in this schema as of this writing -- this
// repo's sql/ directory only has 002 through 009 (extended_resources,
// locations, qbo_integration, workforce_status, visual_intel,
// entity_links_expand, hiveconnect_bridge_mapping); there is no material-
// catalog/vendor_offers/feed-import migration yet, despite the build scope
// referencing one. That migration needs to land before RINGSEND_FEED_TABLE
// can point at anything real. Flagging honestly rather than assuming it
// exists -- do not treat this comment as resolved until you've confirmed
// the migration is actually in sql/.
//
// NOT YET LIVE. connected() gates every function so this NEVER fabricates
// product data -- same discipline as homedepot.js/lowes.js/ferguson.js.

import { supabaseRequest } from '../jobber.js';

export function ringsendConnected() {
  return Boolean(process.env.RINGSEND_FEED_TABLE);
}

function notConnectedResult() {
  return {
    connected: false,
    error: "Ring's End is not connected yet -- no feed agreement/import exists. Once Chris has an export format from Ring's End and a migration creates the import table, set RINGSEND_FEED_TABLE in Vercel env vars to go live.",
    results: [],
  };
}

function feedTable() {
  return process.env.RINGSEND_FEED_TABLE;
}

// mode in {keyword, sku, upc, model_number, category, barcode} per PRD S3.1.
// Filters against whatever columns the eventual import table has --
// column names below are a placeholder guess matching the standard
// vendor_offers shape this file normalizes into, since Ring's End's real
// export column names aren't known yet. Verify/adjust once a real feed has
// actually landed.
export async function search(query, mode = 'keyword', opts = {}) {
  if (!ringsendConnected()) return notConnectedResult();
  const columnByMode = {
    keyword: 'title',
    sku: 'vendor_sku',
    upc: 'upc',
    model_number: 'manufacturer_model_number',
    category: 'category',
    barcode: 'upc',
  };
  const column = columnByMode[mode] || 'title';
  const filter = mode === 'keyword'
    ? `${column}=ilike.*${encodeURIComponent(query)}*`
    : `${column}=eq.${encodeURIComponent(query)}`;
  const r = await supabaseRequest(`${feedTable()}?${filter}&limit=50`);
  if (!r.ok) throw new Error(`Ring's End feed table query failed: ${await r.text()}`);
  const raw = await r.json();
  return {
    connected: true,
    searchMode: mode,
    query,
    results: raw.map(normalize),
  };
}

export async function getProduct(vendorSku) {
  if (!ringsendConnected()) return notConnectedResult();
  const r = await supabaseRequest(`${feedTable()}?vendor_sku=eq.${encodeURIComponent(vendorSku)}&limit=1`);
  if (!r.ok) throw new Error(`Ring's End feed table query failed: ${await r.text()}`);
  const rows = await r.json();
  if (!rows.length) return { connected: true, found: false };
  return { connected: true, found: true, offer: normalize(rows[0]) };
}

// Only as fresh as the last feed run -- there is no live inventory check
// unless Ring's End agrees to one (build scope S2 table). Reads the same
// imported row rather than making a second call.
export async function getAvailability(vendorSku, storeId) {
  if (!ringsendConnected()) return notConnectedResult();
  const detail = await getProduct(vendorSku);
  if (!detail.found) return { connected: true, found: false };
  return {
    connected: true,
    storeAvailability: detail.offer.store_availability,
    deliveryAvailability: detail.offer.delivery_availability,
    asOf: 'last feed import -- not live',
  };
}

// Whatever GH Group's account pricing shows up in the feed, if Ring's End
// agrees to include it at all -- same imported row, no separate call.
export async function getAccountPricing(vendorSku, accountId) {
  if (!ringsendConnected()) return { connected: false, available: false, reason: notConnectedResult().error };
  const detail = await getProduct(vendorSku);
  if (!detail.found || detail.offer.account_price == null) {
    return { connected: true, available: false, reason: "No account pricing present in the last Ring's End feed import for this SKU." };
  }
  return { connected: true, available: true, price: detail.offer.account_price };
}

// Governed by the feed's schedule (e.g. weekly), not a polling limit --
// same discipline as the other adapters: report limitKnown:false rather
// than inventing a ceiling.
export function getRateBudget() {
  return { connected: ringsendConnected(), limitKnown: false, note: "Feed-based connector -- governed by the import schedule, not a request rate limit. Check when the last scheduled import ran, not a rate ceiling." };
}

// Maps an imported feed row to the standard vendor_offers field set
// (PRD S2.1). This is the ONLY function in the codebase allowed to know
// Ring's End's feed column names -- placeholder column names until a real
// feed exists; adjust here only once one lands.
export function normalize(raw) {
  return {
    vendor_key: 'ringsend',
    vendor_sku: raw.vendor_sku || raw.sku || null,
    store_sku: raw.store_sku || null,
    vendor_title: raw.title || raw.description || '',
    manufacturer_model_number: raw.manufacturer_model_number || raw.model_number || null,
    brand: raw.brand || null,
    package_qty: raw.package_qty || null,
    unit_price: numOrNull(raw.unit_price ?? raw.price),
    bulk_price_tiers: raw.bulk_price_tiers || null,
    account_price: numOrNull(raw.account_price ?? raw.contract_price),
    store_availability: raw.store_availability || null,
    delivery_availability: raw.delivery_availability || null,
    lead_time_days: raw.lead_time_days ?? null,
    product_url: raw.product_url || null,
    image_url: raw.image_url || null,
    currency: raw.currency || 'USD',
    source: 'ringsend:feed',
    raw_specifications: raw.specifications || raw.specs || null,
    upc: raw.upc || null,
  };
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
