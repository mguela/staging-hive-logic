// api/_lib/adapters/ferguson.js
//
// Vendor Adapter #3 -- Ferguson. Structurally different from Home Depot and
// Lowe's: Ferguson has no live search/product-detail HTTP endpoint to poll.
// Ferguson's approved-partner integration is PunchOut (cXML) -- the buyer is
// redirected into a hosted Ferguson shopping session (their catalog, their
// account pricing, their inventory), shops there, and Ferguson posts a
// PunchOutOrderMessage (cart) back to us when they're done. That means
// search/getProduct/getAvailability CANNOT be implemented as live REST calls
// the way homedepot.js/lowes.js are -- they only ever have data once a
// PunchOut session has actually returned a cart. This file still implements
// the full six-function interface (PRD S8.1) so the adapters/index.js
// registry and api/track1.js never need vendor-specific branching beyond
// connectorType -- but search/getProduct/getAvailability here return honest
// "not applicable via this connector" responses, not stubs pretending to be
// live lookups.
//
// DATA SOURCE: developer.ferguson.com, approved-partner review process (not
// self-serve) -- source confidence 5/5 per the 2026-07-19 vendor deep dive,
// PENDING Chris's application actually being approved. Whether GH Group
// already has a Ferguson trade account to attach the PunchOut session to is
// an open question per the build scope S5 -- not resolved here.
//
// NOT YET LIVE. As of this writing there is no FERGUSON_PUNCHOUT_URL /
// FERGUSON_PUNCHOUT_SHARED_SECRET configured. The cXML field names below are
// a best-effort placeholder based on the public cXML PunchOut 1.2 spec
// shape -- NOT verified against a real Ferguson session, because this
// adapter has never actually opened one. connected() gates every function
// so this NEVER fabricates product/cart data. Once Chris has PunchOut
// credentials, getPunchOutSessionUrl()'s request body and
// receiveCartReturn()'s parsing are the two things to verify against a real
// session first -- fix normalize() against that real cart, not before.

export function fergusonConnected() {
  return Boolean(process.env.FERGUSON_PUNCHOUT_URL && process.env.FERGUSON_PUNCHOUT_SHARED_SECRET);
}

function notConnectedResult() {
  return {
    connected: false,
    error: 'Ferguson is not connected yet -- no PunchOut setup configured. Apply at developer.ferguson.com, then paste FERGUSON_PUNCHOUT_URL and FERGUSON_PUNCHOUT_SHARED_SECRET into Vercel env vars to go live.',
    results: [],
  };
}

// No live search endpoint exists for this connector type -- PunchOut has no
// server-side product search. The Vendor Catalog UI should render a "Shop
// via Ferguson" launch button for this vendor instead of an inline search
// box (see getPunchOutSessionUrl below), per the build scope S2, rather than
// calling this function expecting real results. Kept in the interface so
// the registry/router don't need vendor-specific branching beyond
// connectorType.
export async function search(query, mode = 'keyword', opts = {}) {
  if (!fergusonConnected()) return notConnectedResult();
  return {
    connected: true,
    applicable: false,
    reason: 'Ferguson has no live search API -- PunchOut has no server-side search. Use getPunchOutSessionUrl() to open a hosted Ferguson session instead.',
    results: [],
  };
}

// Only ever has real data once a PunchOut cart has been returned (see
// receiveCartReturn). There is nothing to poll -- this is not a lookup
// that can be made live the way homedepot.js/lowes.js's getProduct is.
export async function getProduct(vendorSku, opts = {}) {
  if (!fergusonConnected()) return notConnectedResult();
  return {
    connected: true,
    applicable: false,
    reason: 'Ferguson product detail is only available from a returned PunchOut cart line, not a live lookup. Call receiveCartReturn() with the posted cXML PunchOutOrderMessage to get real offers.',
  };
}

export async function getAvailability(vendorSku, storeId) {
  if (!fergusonConnected()) return notConnectedResult();
  return {
    connected: true,
    applicable: false,
    reason: 'Ferguson availability is only known from a returned PunchOut cart line, same limitation as getProduct.',
  };
}

// Native to PunchOut -- Ferguson's hosted session always shows the buyer's
// negotiated account pricing directly (that's the point of PunchOut), so
// this never needs a separate account-id-keyed request the way lowes.js
// does. It's only real once a cart line for that vendor_sku has actually
// come back, though -- same limitation as getProduct.
export async function getAccountPricing(vendorSku, accountId) {
  if (!fergusonConnected()) return { connected: false, available: false, reason: notConnectedResult().error };
  return {
    connected: true,
    available: false,
    reason: 'Ferguson account pricing comes back natively on the PunchOut cart line -- not available until a session for this SKU has been shopped and returned.',
  };
}

// PunchOut is session-based, not a polling API -- there is no rate limit to
// report. Returning limitKnown:false, not a fabricated ceiling, so the
// S6.3 background-refresh scheduler never polls this connector type.
export function getRateBudget() {
  return { connected: fergusonConnected(), limitKnown: false, note: 'PunchOut is a session-based connector, not polled -- no rate budget applies. Do not schedule background refreshes for this vendor_key.' };
}

// Builds the PunchOutSetupRequest cXML and returns the hosted session URL to
// redirect the buyer into (the "Shop via Ferguson" button per the build
// scope S2). NOT one of the PRD S8.1 six -- an addition specific to the
// punchout connector type, same as the build scope calls out ("small
// frontend branch on connector_type, not a new architecture"). Placeholder
// request shape -- verify against Ferguson's real PunchOut setup spec once
// credentials exist.
export async function getPunchOutSessionUrl(opts = {}) {
  if (!fergusonConnected()) return notConnectedResult();
  const cxml = buildPunchOutSetupRequestCxml(opts);
  const r = await fetch(process.env.FERGUSON_PUNCHOUT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: cxml,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Ferguson PunchOut setup failed: ${text}`);
  const match = text.match(/<URL>([^<]+)<\/URL>/i);
  if (!match) throw new Error('Ferguson PunchOut setup response had no <URL> -- verify the cXML response shape against a real session.');
  return { connected: true, sessionUrl: match[1] };
}

function buildPunchOutSetupRequestCxml({ buyerCookie, returnUrl } = {}) {
  // Placeholder cXML PunchOutSetupRequest per the public 1.2 spec shape --
  // credential domain / shared-secret handshake not verified against
  // Ferguson's real onboarding docs yet.
  const cookie = buyerCookie || `hivelogic-${Math.random().toString(36).slice(2)}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<cXML>
  <Header>
    <From><Credential domain="DUNS"><Identity>${process.env.FERGUSON_BUYER_DUNS || ''}</Identity></Credential></From>
    <To><Credential domain="DUNS"><Identity>${process.env.FERGUSON_SUPPLIER_DUNS || ''}</Identity></Credential></To>
    <Sender>
      <Credential domain="hivelogic"><Identity>hivelogic-live</Identity><SharedSecret>${process.env.FERGUSON_PUNCHOUT_SHARED_SECRET}</SharedSecret></Credential>
    </Sender>
  </Header>
  <Request>
    <PunchOutSetupRequest operation="create">
      <BuyerCookie>${cookie}</BuyerCookie>
      <BrowserFormPost><URL>${returnUrl || ''}</URL></BrowserFormPost>
    </PunchOutSetupRequest>
  </Request>
</cXML>`;
}

// Parses a posted PunchOutOrderMessage (Ferguson's cart return) into
// normalized vendor_offers rows. This is the real entry point for
// getProduct/getAvailability/getAccountPricing data for this vendor --
// call it from whatever route handles Ferguson's BrowserFormPost callback.
// Regex-based cXML parsing is a placeholder -- swap for a real XML parser
// once a real cart payload exists to test against.
export function receiveCartReturn(cxmlOrderMessage) {
  const items = [...cxmlOrderMessage.matchAll(/<ItemIn[^>]*quantity="([^"]*)"[^>]*>([\s\S]*?)<\/ItemIn>/g)];
  return items.map(([, quantity, body]) => normalize(parseItemInBody(body, quantity)));
}

function parseItemInBody(body, quantity) {
  const field = (tag) => body.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i'))?.[1] || null;
  return {
    supplierPartId: field('SupplierPartID'),
    description: field('Description'),
    manufacturerPartId: field('ManufacturerPartID'),
    manufacturerName: field('ManufacturerName'),
    unitPrice: field('UnitPrice'),
    currency: body.match(/currency="([^"]+)"/i)?.[1] || 'USD',
    classification: field('Classification'),
    quantity,
  };
}

// Maps a parsed PunchOut cart line to the standard vendor_offers field set
// (PRD S2.1). This is the ONLY function in the codebase allowed to know
// Ferguson's cXML field names. Field names above are a best-effort mapping
// of the public cXML PunchOut spec -- verify against Ferguson's real cart
// return on first live session.
export function normalize(raw) {
  return {
    vendor_key: 'ferguson',
    vendor_sku: raw.supplierPartId || null,
    store_sku: null,
    vendor_title: raw.description || '',
    manufacturer_model_number: raw.manufacturerPartId || null,
    brand: raw.manufacturerName || null,
    package_qty: raw.quantity ? Number(raw.quantity) : null,
    unit_price: numOrNull(raw.unitPrice),
    bulk_price_tiers: null,
    account_price: numOrNull(raw.unitPrice), // PunchOut pricing IS the buyer's account price natively
    store_availability: null,
    delivery_availability: null,
    lead_time_days: null,
    product_url: null,
    image_url: null,
    currency: raw.currency || 'USD',
    source: 'ferguson:punchout',
    raw_specifications: raw.classification || null,
    upc: null,
  };
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
