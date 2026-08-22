// HiveLogic Materials Catalog — reusable materials/expenses Reina has
// learned from past receipts (nickname, vendor, SKU, unit price, product
// image), searchable from expense entry. Talks to /api/bookkeeping/catalog.
// This is distinct from the separate Vendor Catalog / Home Depot product
// catalog elsewhere in the app -- this one is fed by receipt learning tied
// to the bookkeeping engine's catalog.js, not vendor product feeds.
//
// Rebuilt for visual parity with the approved reference's materials.js: a
// real card grid (product image or a real "no image yet" placeholder, a
// material/reusable-expense type pill, a vendor/SKU/unit-price/use meta
// grid) rather than a flat list row. vendor/imageUrl/inventoryTracked are
// real fields in this app's catalog schema (server/bookkeeping/src/catalog.js
// spreads whatever the save payload includes). As of Phase 4 increment 3,
// vendor and inventoryTracked are populated by app-bookkeeping.js's
// saveLineToCatalog() (from the expense's #bkx-vendor field and the line's
// existing "Track quantity / inventory impact" checkbox, respectively) --
// new items will carry real values. imageUrl is still never sent: this app
// has no product-photo upload UI and no Reina scan pipeline to source one
// from, so it still renders through the honest "No product image yet"
// fallback below, not a fabricated value.

(function () {
  function money(n) { return '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function escapeHtml(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }
  function normalize(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

  let catalog = [];

  async function api(path) {
    const headers = {};
    const token = typeof hlTokenSync === 'function' ? hlTokenSync() : null;
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch(`/api/bookkeeping${path}`, { headers });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  // Real "reuse this item" hand-off to Expense Entry, matching the approved
  // reference's "Use / edit" action (there a plain link to
  // /?new=1&material=<id> since that app is multi-page; this app is a
  // single-page tab layout, so the equivalent is: stash the item, switch
  // tabs via the newly-exposed hlSelectExpxTab(), and let
  // app-bookkeeping.js's init() pick the stash up and fill the line it
  // already adds on load -- see applyPendingCatalogReuse() there).
  function useItem(item) {
    window.__hlPendingCatalogReuse = item;
    if (typeof window.hlSelectExpxTab === 'function') window.hlSelectExpxTab('bookkeeping');
  }

  function render() {
    const searchEl = document.getElementById('mat-search');
    const typeEl = document.getElementById('mat-type');
    const query = normalize(searchEl ? searchEl.value : '');
    const type = typeEl ? typeEl.value : '';
    const filtered = catalog.filter(item => (!type || item.type === type) && (!query || [item.nickname, item.name, item.vendor, item.sku, ...(item.aliases || [])].some(value => normalize(value).includes(query))));

    document.getElementById('mat-stat-all').textContent = catalog.length;
    document.getElementById('mat-stat-materials').textContent = catalog.filter(item => item.type === 'material').length;
    document.getElementById('mat-stat-images').textContent = catalog.filter(item => item.imageUrl).length;

    const grid = document.getElementById('mat-grid');
    if (!catalog.length) { grid.innerHTML = '<div class="note">No catalog items yet. Items are learned from receipts as Reina approves them into the catalog.</div>'; return; }
    if (!filtered.length) { grid.innerHTML = '<div class="mat-empty">No catalog items match this search.</div>'; return; }

    grid.innerHTML = `<div class="mat-card-grid">${filtered.map(item => `
      <article class="mat-card" data-item-id="${escapeHtml(item.id)}">
        <div class="mat-image">${item.imageUrl ? `<img src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.nickname || item.name)}">` : '<span>No product image yet</span>'}</div>
        <div class="mat-card-body">
          <span class="mat-type-pill${item.type === 'expense' ? ' expense' : ''}">${item.type === 'material' ? 'Material' : 'Reusable expense'}</span>
          <h2>${escapeHtml(item.nickname || item.name)}</h2>
          <p>${item.nickname ? escapeHtml(item.name) : 'Add a nickname from expense entry for easier searching.'}</p>
          <div class="mat-meta">
            <div><small>Vendor</small><b>${escapeHtml(item.vendor || 'Not assigned')}</b></div>
            <div><small>SKU</small><b>${escapeHtml(item.sku || '—')}</b></div>
            <div><small>Unit price</small><b>${money(item.defaultUnitPrice)}</b></div>
            <div><small>Use</small><b>${item.inventoryTracked ? 'Tracked' : 'Expense'}</b></div>
          </div>
          <div class="mat-actions"><button type="button" class="secondary" data-action="use-item">Use / edit</button></div>
        </div>
      </article>
    `).join('')}</div>`;
  }

  async function refresh() {
    const { ok, data } = await api('/catalog');
    if (!ok || data.enabled === false) {
      const grid = document.getElementById('mat-grid');
      if (grid) grid.innerHTML = '<div class="note">Materials catalog is disabled or not reachable in this environment.</div>';
      return;
    }
    catalog = data.items || [];
    render();
  }

  function init() {
    if (!document.getElementById('mat-grid')) return;
    const searchEl = document.getElementById('mat-search');
    const typeEl = document.getElementById('mat-type');
    if (searchEl) searchEl.addEventListener('input', render);
    if (typeEl) typeEl.addEventListener('change', render);
    document.getElementById('mat-grid').addEventListener('click', e => {
      const button = e.target.closest('[data-action="use-item"]');
      if (!button) return;
      const item = catalog.find(entry => entry.id === button.closest('[data-item-id]')?.dataset.itemId);
      if (item) useItem(item);
    });
    refresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
  window.__materialsRefresh = refresh;
  // Exposed so the Expenses sub-nav can (re)run init once this fragment is
  // fetched into the DOM -- init() itself is idempotent-safe (no-ops unless
  // #mat-grid exists).
  window.hlInitMaterials = init;
})();
