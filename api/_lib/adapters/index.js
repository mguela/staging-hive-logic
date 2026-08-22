// api/_lib/adapters/index.js
// Vendor adapter registry. Every vendor plugs in here under its vendor_key
// -- api/track1.js's materials_* resources only ever go through this
// registry, never import a specific vendor adapter directly. Adding a new
// vendor (F.W. Webb, a local feed importer, etc. -- see the 2026-07-19
// vendor deep dive for the real rollout order) means adding one entry here
// and one new file under adapters/; it should never require touching
// track1.js's routing logic or the products/vendor_offers schema.
//
// connectorType documents which of the 4 connector types (PRD S8.2) each
// adapter implements -- 'api' adapters (homedepot, lowes) implement the
// full search/getProduct/getAvailability contract live; 'punchout'
// (ferguson) and 'feed' (ringsend) adapters have a narrower real shape
// (search/getProduct/getAvailability are only ever real once a session/
// import has actually produced data -- see each file's header) even though
// they expose the same six-function interface so the router never needs
// vendor-specific branching beyond connectorType. This registry is where
// that distinction is surfaced to callers via listAdapters().
//
// connected() naming convention: each adapter module exports its own
// `<vendorKey>Connected()` (homedepotConnected, lowesConnected,
// fergusonConnected, ringsendConnected) rather than a shared `connected`
// name, so listAdapters() below looks it up by vendorKey.

import * as homedepot from './homedepot.js';
import * as lowes from './lowes.js';
import * as ferguson from './ferguson.js';
import * as ringsend from './ringsend.js';

export const ADAPTERS = {
  homedepot: { module: homedepot, connectorType: 'api', label: 'Home Depot' },
  lowes: { module: lowes, connectorType: 'api', label: "Lowe's" },                    // pending Chris's partner-API application -- see lowes.js header
  ferguson: { module: ferguson, connectorType: 'punchout', label: 'Ferguson' },        // pending Chris's PunchOut approval -- see ferguson.js header
  ringsend: { module: ringsend, connectorType: 'feed', label: "Ring's End" },          // pending outreach + a migration for the import table -- see ringsend.js header
  // fwwebb: { module: fwwebb, connectorType: 'punchout', label: 'F.W. Webb' },     -- Phase 5, pending PunchOut specs
  // sherwinwilliams: { ... connectorType: 'punchout' },                           -- Phase 5
  // interstate: { ... connectorType: 'feed' },                                    -- Phase 1.5, pending pilot outreach
  // tileamerica: { ... connectorType: 'feed' },                                   -- Phase 1.5
  // torrco: { ... connectorType: 'feed' },                                        -- Phase 1.5
};

export function getAdapter(vendorKey) {
  const entry = ADAPTERS[vendorKey];
  if (!entry) return null;
  return entry;
}

export function listAdapters() {
  return Object.entries(ADAPTERS).map(([key, { connectorType, label, module }]) => {
    const connectedFn = module[`${key}Connected`] || module.connected;
    return {
      vendorKey: key,
      connectorType,
      label,
      connected: typeof connectedFn === 'function' ? connectedFn() : null,
    };
  });
}
