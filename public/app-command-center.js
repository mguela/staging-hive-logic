// Command Center layout engine.
//
// Extracted from public/index.html on 2026-08-17, unchanged. It lived inline
// since 2026-08-10; see docs/COMMAND-CENTER-EXTRACTION-SCOPE.md for why it
// moved and what was deliberately left behind (the widget markup stays in the
// page -- there is no templating layer, so moving it would buy a load-order
// dependency and a flash of empty grid for nothing).
//
// Loaded via <script src="/app-command-center.js"> at exactly the position the
// inline block occupied, with no defer/async, so execution order is unchanged.
// Every entry point stays on `window` under its existing name -- index.html
// still carries inline onclick="hlCcSaveLayout()" handlers and showView() still
// calls window.hlInitCcGrid, and none of that was touched.
//
// Boot is self-scheduling and idempotent (see the last two lines): GridStack
// needs the container to have real dimensions, so init is deferred and safe to
// call repeatedly.

// 2026-08-10: customizable Command Center (see the grid-stack markup around #cc-main-
// gridstack for context). GridStack needs the container to have real dimensions, so
// this only actually runs once the Command Center view is visible -- called from
// showView() and once on initial load. Idempotent: safe to call repeatedly.
//
// 2026-08-16, Chris's layout-editor fix pass. What changed and why:
//   * Live mode is genuinely locked. The remove ✕ and the drag shield are now
//     MOUNTED INTO THE DOM ONLY WHILE EDITING -- previously the ✕ was rendered
//     into every widget on page load and merely hidden with opacity, and its
//     hover rule was not scoped to .cc-editing, so a ghost ✕ appeared on hover
//     during normal use.
//   * A transparent .w-shield covers each widget's content while editing, so a
//     drag can start anywhere on the widget and no click inside it reaches a
//     link/button underneath (no more accidentally navigating out of edit mode).
//   * Save / Go Back / Cancel Changes replace the old "Done customizing" +
//     "Restore default layout" pair, working off a deep-copied entry snapshot.
//   * Layouts persist PER USER (api/track1.js resource=cc_layouts, backed by
//     sql/085_command_center_layouts.sql) instead of per browser. Templates are
//     read-only code constants; a save always produces a `custom`. localStorage
//     stays as the offline cache and as the fallback while 085 is unapplied.
//   * Today's Decisions (cc-brief) can be moved and resized like anything else
//     but can never be removed -- no ✕ is rendered for it, hlHideCcWidget
//     refuses it, a layout that lost it gets it back at its default position on
//     load, and the API rejects a save without it.
var CC_WIDGET_LABELS = {
  'cc-map': 'Service Area Map',
  'cc-pulse': 'Pulse — Money & Watching',
  'cc-brief': "Today's Decisions (Reina's Brief)",
  'cc-watching': 'Watching',
  'cc-todo': 'Team To-Do',
  'cc-notif': 'Notifications',
  'cc-jobhealth': 'Job Health',
  'cc-schedule': "Today's Schedule",
  'cc-photos': 'Recent Job Photos',
};
// R8: Today's Decisions is movable + resizable, but never removable, for every
// user and every layout (templates and customs alike).
var CC_REQUIRED_WIDGET = 'cc-brief';
var CC_LS = { layout: 'hl-cc-layout', hidden: 'hl-cc-hidden-widgets', edit: 'hl-cc-edit-mode', customs: 'hl-cc-custom-layouts', active: 'hl-cc-active-layout' };
// The one built-in template. Its geometry is not hardcoded twice -- it is read
// off the gs-x/gs-y/gs-w/gs-h baked into the HTML at init (hlInitCcGrid), which
// stays the single source of truth for "default". More role templates (Dispatch,
// Accounting, ...) belong here as further constants once Chris specifies which
// widgets each role should start with; inventing them here would be guessing.
var CC_TEMPLATE_DEFAULT_ID = 'tpl-owner';
// Role baselines. Which widgets a role STARTS with is derived from what that
// role can actually reach -- the permission tables in hlApplyRolePermissions
// (ALLOWED_GROUPS / ALLOWED_STANDALONE, sql/066_permission_roles_v2.sql) and the
// server-side financial gate in api/track1.js (FINANCIAL_ALLOWED_ROLES =
// owner, office_ar). They are not a taste exercise:
//
//   * Pulse reads cash, QuickBooks P&L and vendor bills. Only owner and
//     office_ar are allowed those, so putting Pulse in a field or dispatch
//     baseline would hand them a panel with four of six tiles reading
//     "unavailable". It appears only in the two baselines whose roles can see it.
//   * Every role has nav-cc, so every role gets a baseline -- nobody lands on
//     an empty Command Center.
//   * Today's Decisions is in all of them, because it cannot be removed anyway.
//
// Anything not listed for a template is hidden in it, and the user can add it
// back from "+ Add widget" -- these are starting points, not restrictions.
var CC_LAYOUT_TEMPLATES = [
  { id: 'tpl-owner', name: 'Owner — everything', template: true, widgets: [
    { id: 'cc-map', x: 0, y: 0, w: 4, h: 13 },
    { id: 'cc-pulse', x: 0, y: 13, w: 4, h: 10 },
    { id: 'cc-brief', x: 4, y: 0, w: 5, h: 22 },
    { id: 'cc-watching', x: 9, y: 0, w: 3, h: 8 },
    { id: 'cc-todo', x: 9, y: 8, w: 3, h: 7 },
    { id: 'cc-notif', x: 9, y: 15, w: 3, h: 7 },
    { id: 'cc-jobhealth', x: 0, y: 23, w: 12, h: 3 },
    { id: 'cc-schedule', x: 0, y: 26, w: 6, h: 8 },
    { id: 'cc-photos', x: 6, y: 26, w: 6, h: 8 },
  ] },
  // office_ar is the only non-owner role with the money + insights groups, so
  // it is the only other baseline that leads with Pulse.
  { id: 'tpl-office', name: 'Office & AR — money first', template: true, widgets: [
    { id: 'cc-pulse', x: 0, y: 0, w: 6, h: 10 },
    { id: 'cc-brief', x: 6, y: 0, w: 6, h: 17 },
    { id: 'cc-watching', x: 0, y: 10, w: 6, h: 7 },
    { id: 'cc-notif', x: 0, y: 17, w: 6, h: 7 },
    { id: 'cc-todo', x: 6, y: 17, w: 6, h: 7 },
    { id: 'cc-jobhealth', x: 0, y: 24, w: 12, h: 3 },
  ] },
  // dispatch / admin_remote / project_manager / purchasing: jobs and crm, no
  // money. Map and schedule lead; Pulse is left out because they cannot read it.
  { id: 'tpl-dispatch', name: 'Dispatch & scheduling', template: true, widgets: [
    { id: 'cc-map', x: 0, y: 0, w: 6, h: 13 },
    { id: 'cc-brief', x: 6, y: 0, w: 6, h: 13 },
    { id: 'cc-schedule', x: 0, y: 13, w: 6, h: 9 },
    { id: 'cc-watching', x: 6, y: 13, w: 3, h: 9 },
    { id: 'cc-notif', x: 9, y: 13, w: 3, h: 9 },
    { id: 'cc-jobhealth', x: 0, y: 22, w: 12, h: 3 },
  ] },
  // field_lead / field_tech (and the no-role-assigned fallback): crm + portal
  // only. What is on today, where it is, and what came back from site.
  { id: 'tpl-field', name: 'Field — today and where', template: true, widgets: [
    { id: 'cc-brief', x: 0, y: 0, w: 6, h: 12 },
    { id: 'cc-schedule', x: 6, y: 0, w: 6, h: 12 },
    { id: 'cc-map', x: 0, y: 12, w: 6, h: 10 },
    { id: 'cc-photos', x: 6, y: 12, w: 6, h: 10 },
    { id: 'cc-notif', x: 0, y: 22, w: 12, h: 6 },
  ] },
  { id: 'tpl-sales', name: 'Sales — pipeline', template: true, widgets: [
    { id: 'cc-brief', x: 0, y: 0, w: 6, h: 14 },
    { id: 'cc-watching', x: 6, y: 0, w: 6, h: 7 },
    { id: 'cc-notif', x: 6, y: 7, w: 6, h: 7 },
    { id: 'cc-schedule', x: 0, y: 14, w: 6, h: 8 },
    { id: 'cc-todo', x: 6, y: 14, w: 6, h: 8 },
  ] },
];
// Role -> baseline. Keys are the permission roles from
// sql/066_permission_roles_v2.sql; owner/admin/superadmin come in as an account
// tier rather than a role and are handled in hlCcTemplateForRole.
var CC_ROLE_TEMPLATE = {
  owner: 'tpl-owner',
  office_ar: 'tpl-office',
  dispatch: 'tpl-dispatch',
  admin_remote: 'tpl-dispatch',
  project_manager: 'tpl-dispatch',
  purchasing: 'tpl-dispatch',
  field_lead: 'tpl-field',
  field_tech: 'tpl-field',
  sales: 'tpl-sales',
};
// The baseline for whoever is signed in. Mirrors hlApplyRolePermissions: the
// account tier (profiles.role) wins, then the first mapped business role, and
// no role at all falls through to the most restricted baseline -- fail closed,
// the same direction that function chose.
window.hlCcTemplateForRole = function () {
  var tier = window.HL_ACCESS_LEVEL;
  if (tier === 'superadmin' || tier === 'admin') return 'tpl-owner';
  var roles = window.HL_PERMISSION_ROLES || [];
  for (var i = 0; i < roles.length; i++) {
    if (CC_ROLE_TEMPLATE[roles[i]]) return CC_ROLE_TEMPLATE[roles[i]];
  }
  return roles.length ? 'tpl-field' : 'tpl-field';
};

function hlCcNum(v, dflt) { var n = Number(v); return Number.isFinite(n) ? n : dflt; }
function hlCcClone(o) { try { return JSON.parse(JSON.stringify(o)); } catch (e) { return null; } }
function hlCcGridEl() { return document.getElementById('cc-main-gridstack'); }
function hlCcNode(gsId) { var el = hlCcGridEl(); return el ? el.querySelector('[gs-id="' + gsId + '"]') : null; }

// ---- layout shape -----------------------------------------------------------
// { widgets: [{id,x,y,w,h,hidden}], background: null, brand_image: null }
function hlCcReadLayout(el) {
  return [].slice.call(el.querySelectorAll('.grid-stack-item')).map(function (n) {
    return { id: n.getAttribute('gs-id'), x: +n.getAttribute('gs-x'), y: +n.getAttribute('gs-y'), w: +n.getAttribute('gs-w'), h: +n.getAttribute('gs-h'), hidden: n.style.display === 'none' };
  });
}
// The live canvas as a layout object. Reads GridStack's own model for the nodes
// it still owns, and the DOM for the ones that were removed (hidden).
window.hlCcCurrentLayout = function () {
  var el = hlCcGridEl(), grid = window._hlCcGrid;
  if (!el) return { widgets: [], background: null, brand_image: null };
  var live = {};
  if (grid) {
    try {
      grid.save(false).forEach(function (n) { if (n && n.id) live[n.id] = n; });
    } catch (e) {}
  }
  var widgets = [].slice.call(el.querySelectorAll('.grid-stack-item')).map(function (n) {
    var id = n.getAttribute('gs-id');
    var hidden = n.style.display === 'none';
    var src = (!hidden && live[id]) ? live[id] : n;
    var get = function (k, attr) { return (src === n) ? +n.getAttribute(attr) : hlCcNum(src[k], 0); };
    return { id: id, x: get('x', 'gs-x'), y: get('y', 'gs-y'), w: get('w', 'gs-w'), h: get('h', 'gs-h'), hidden: hidden };
  });
  return { widgets: widgets, background: (window._hlCcBackground || null), brand_image: (window._hlCcBrandImage || null) };
};
// R8 + forward-compatibility guard. Runs on EVERY load, whatever the source
// (server row, localStorage, a template, a hand-edited payload):
//   * unknown widget ids are dropped;
//   * a widget the saved layout predates falls back to its hardcoded default;
//   * Today's Decisions is re-injected at its default position if it is missing
//     or was marked hidden -- it cannot be removed from any layout.
window.hlCcNormalizeLayout = function (layout) {
  var defaults = (window._hlCcDefaultLayout && window._hlCcDefaultLayout.widgets) || [];
  var byDefault = {};
  defaults.forEach(function (d) { byDefault[d.id] = d; });
  var src = (layout && Array.isArray(layout.widgets)) ? layout.widgets : (Array.isArray(layout) ? layout : []);
  var out = [], seen = {};
  src.forEach(function (w) {
    if (!w || !CC_WIDGET_LABELS[w.id] || seen[w.id]) return;
    seen[w.id] = true;
    var d = byDefault[w.id] || {};
    out.push({
      id: w.id,
      x: Math.max(0, hlCcNum(w.x, hlCcNum(d.x, 0))),
      y: Math.max(0, hlCcNum(w.y, hlCcNum(d.y, 0))),
      w: Math.max(1, hlCcNum(w.w, hlCcNum(d.w, 3))),
      h: Math.max(1, hlCcNum(w.h, hlCcNum(d.h, 4))),
      hidden: w.hidden === true,
    });
  });
  defaults.forEach(function (d) {
    if (seen[d.id]) return;
    seen[d.id] = true;
    out.push({ id: d.id, x: d.x, y: d.y, w: d.w, h: d.h, hidden: false });
  });
  var dec = null;
  out.forEach(function (w) { if (w.id === CC_REQUIRED_WIDGET) dec = w; });
  var decDefault = byDefault[CC_REQUIRED_WIDGET];
  if (!dec && decDefault) {
    out.push({ id: CC_REQUIRED_WIDGET, x: decDefault.x, y: decDefault.y, w: decDefault.w, h: decDefault.h, hidden: false });
  } else if (dec && dec.hidden) {
    // Someone removed it anyway (stale save, tampered DOM, crafted payload).
    // Put it back where the default layout puts it rather than at whatever
    // position it happened to be hidden from.
    dec.hidden = false;
    if (decDefault) { dec.x = decDefault.x; dec.y = decDefault.y; dec.w = decDefault.w; dec.h = decDefault.h; }
  }
  var base = (layout && typeof layout === 'object' && !Array.isArray(layout)) ? layout : {};
  return { widgets: out, background: base.background || null, brand_image: base.brand_image || null };
};
function hlCcRectsOverlap(a, b) {
  return a.x < (b.x + b.w) && b.x < (a.x + a.w) && a.y < (b.y + b.h) && b.y < (a.y + a.h);
}
function hlCcLayoutHasCollision(items) {
  var visible = items.filter(function (n) { return !n.hidden && [n.x, n.y, n.w, n.h].every(function (v) { return Number.isFinite(v); }); });
  for (var i = 0; i < visible.length; i++) {
    for (var j = i + 1; j < visible.length; j++) {
      if (hlCcRectsOverlap(visible[i], visible[j])) return true;
    }
  }
  return false;
}
function hlCcInvalidateMaps() {
  // Leaflet measures its container once; after a resize it renders grey tiles
  // and mis-placed markers until told to re-measure. Same fix pattern already
  // used elsewhere in this file for the display:none -> block transition.
  if (window._ccLeafletMap) setTimeout(function () { try { window._ccLeafletMap.invalidateSize(); } catch (e) {} }, 60);
  // The Pulse dials have no in-flow content, so their pixel size is computed in
  // JS (pgSizeDials, driven by a ResizeObserver) -- nudge it for the case where
  // a widget was hidden/shown rather than resized.
  if (typeof window.pgSizeDials === 'function') setTimeout(function () { try { window.pgSizeDials(); } catch (e) {} }, 80);
}
// Apply a layout object to the live canvas.
window.hlCcApplyLayout = function (layout) {
  var grid = window._hlCcGrid, el = hlCcGridEl();
  if (!grid || !el) return;
  var norm = window.hlCcNormalizeLayout(layout);
  var byId = {};
  norm.widgets.forEach(function (w) { byId[w.id] = w; });
  Object.keys(CC_WIDGET_LABELS).forEach(function (id) {
    var node = hlCcNode(id);
    if (!node) return;
    var want = byId[id];
    var hide = !want || want.hidden === true;
    var isOff = node.style.display === 'none';
    if (hide && !isOff) { try { grid.removeWidget(node, false); } catch (e) {} node.style.display = 'none'; }
    else if (!hide && isOff) { node.style.display = ''; try { grid.addWidget(node); } catch (e) {} }
  });
  var visible = norm.widgets.filter(function (w) { return !w.hidden; })
    .map(function (w) { return { id: w.id, x: w.x, y: w.y, w: w.w, h: w.h }; });
  try { grid.load(visible, false); } catch (e) {}
  window._hlCcBackground = norm.background || null;
  window._hlCcBrandImage = norm.brand_image || null;
  hlCcInvalidateMaps();
  if (document.getElementById('snapshot') && document.getElementById('snapshot').classList.contains('cc-editing')) hlCcMountEditChrome();
};

// ---- stored layouts ---------------------------------------------------------
// Server is the source of truth (resource=cc_layouts). localStorage mirrors it
// so a reload paints the right layout before the fetch lands, and so the whole
// feature still works if the endpoint is unreachable -- including right now,
// before sql/085_command_center_layouts.sql has been applied to production.
window._hlCcStore = { customs: [], activeId: null, remote: false, loaded: false };

function hlCcLsRead(key, dflt) { try { var v = JSON.parse(localStorage.getItem(key)); return (v === null || v === undefined) ? dflt : v; } catch (e) { return dflt; } }
function hlCcLsWrite(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }
function hlCcLsWriteRaw(key, val) { try { localStorage.setItem(key, val); } catch (e) {} }

// Pre-2026-08-16 saves lived in two separate keys: a bare GridStack array in
// hl-cc-layout plus a list of removed ids in hl-cc-hidden-widgets. Fold them
// into one layout object so an existing user's custom arrangement survives.
function hlCcLegacyLocalLayout() {
  var arr = hlCcLsRead(CC_LS.layout, null);
  var hidden = hlCcLsRead(CC_LS.hidden, []);
  if (!Array.isArray(arr) && !(Array.isArray(hidden) && hidden.length)) return null;
  var widgets = (Array.isArray(arr) ? arr : []).map(function (n) {
    return { id: n.id, x: hlCcNum(n.x, 0), y: hlCcNum(n.y, 0), w: hlCcNum(n.w, 3), h: hlCcNum(n.h, 4), hidden: false };
  }).filter(function (n) { return !!CC_WIDGET_LABELS[n.id]; });
  var seen = {};
  widgets.forEach(function (n) { seen[n.id] = n; });
  (Array.isArray(hidden) ? hidden : []).forEach(function (id) {
    if (!CC_WIDGET_LABELS[id]) return;
    if (seen[id]) seen[id].hidden = true;
    else widgets.push({ id: id, x: 0, y: 0, w: 3, h: 4, hidden: true });
  });
  return { widgets: widgets, background: null, brand_image: null };
}
function hlCcCacheActive(layout, activeId) {
  hlCcLsWrite(CC_LS.layout, layout);
  hlCcLsWriteRaw(CC_LS.active, JSON.stringify(activeId || CC_TEMPLATE_DEFAULT_ID));
}
function hlCcCachedActiveLayout() {
  var cached = hlCcLsRead(CC_LS.layout, null);
  if (cached && !Array.isArray(cached) && Array.isArray(cached.widgets)) return cached;
  return hlCcLegacyLocalLayout();
}
function hlCcNextCustomName() {
  var used = {};
  window._hlCcStore.customs.forEach(function (c) {
    var m = /^Custom Layout (\d+)$/.exec(String(c.name || '').trim());
    if (m) used[+m[1]] = true;
  });
  var n = 1;
  while (used[n]) n++;
  return 'Custom Layout ' + n;
}
window.hlCcTemplateLayout = function (templateId) {
  var tpl = null;
  CC_LAYOUT_TEMPLATES.forEach(function (t) { if (t.id === templateId) tpl = t; });
  if (!tpl) return hlCcClone(window._hlCcDefaultLayout) || { widgets: [], background: null, brand_image: null };
  // Widgets a template does not list are hidden, not dropped -- the user can add
  // any of them back, and normalize needs every id present to reason about them.
  var listed = {};
  tpl.widgets.forEach(function (w) { listed[w.id] = w; });
  var widgets = Object.keys(CC_WIDGET_LABELS).map(function (id) {
    var w = listed[id];
    if (w) return { id: id, x: w.x, y: w.y, w: w.w, h: w.h, hidden: false };
    var d = null;
    ((window._hlCcDefaultLayout && window._hlCcDefaultLayout.widgets) || []).forEach(function (n) { if (n.id === id) d = n; });
    return { id: id, x: (d ? d.x : 0), y: (d ? d.y : 0), w: (d ? d.w : 3), h: (d ? d.h : 4), hidden: true };
  });
  return { widgets: widgets, background: null, brand_image: null };
};
window.hlCcLayoutById = function (id) {
  if (!id || id === CC_TEMPLATE_DEFAULT_ID) return window.hlCcTemplateLayout(CC_TEMPLATE_DEFAULT_ID);
  var found = null;
  window._hlCcStore.customs.forEach(function (c) { if (c.id === id) found = c; });
  return found ? hlCcClone(found.layout) : window.hlCcTemplateLayout(CC_TEMPLATE_DEFAULT_ID);
};

function hlCcApi(method, body, query) {
  var h = {};
  var t = (typeof hlTokenSync === 'function') ? hlTokenSync() : null;
  if (t) h['Authorization'] = 'Bearer ' + t;
  var opts = { method: method, headers: h };
  if (body) { h['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  return fetch('/api/track1?resource=cc_layouts' + (query || ''), opts).then(function (r) { return r.json(); });
}
// Boot-race discipline (the recurring bug in this repo): never fire before the
// Supabase session has been restored, or the request 401s and the user's saved
// layout silently never loads. Same hlRequireSession + 'hl:signed-in' pattern as
// every other Command Center loader.
window.hlCcLoadLayouts = function () {
  return hlCcApi('GET').then(function (j) {
    if (!j || j.ok !== true || !Array.isArray(j.layouts)) throw new Error((j && j.error) || 'cc_layouts unavailable');
    window._hlCcStore.customs = j.layouts.map(function (r) {
      return { id: r.id, name: r.name, layout: r.layout, is_active: !!r.is_active, updated_at: r.updated_at };
    });
    var active = null;
    window._hlCcStore.customs.forEach(function (c) { if (c.is_active) active = c.id; });
    // No saved layout of their own: start them on their ROLE's baseline rather
    // than on the owner's everything-layout, which for a field tech would open
    // on a money panel they are not allowed to read.
    window._hlCcStore.activeId = active || window.hlCcTemplateForRole();
    window._hlCcStore.remote = true;
    window._hlCcStore.loaded = true;
    hlCcLsWrite(CC_LS.customs, window._hlCcStore.customs);
    return window._hlCcStore;
  }).catch(function () {
    // Offline, signed out, or resource=cc_layouts not deployed / table not yet
    // created. Keep the feature working locally rather than dead-ending.
    var local = hlCcLsRead(CC_LS.customs, []);
    window._hlCcStore.customs = Array.isArray(local) ? local : [];
    window._hlCcStore.activeId = hlCcLsRead(CC_LS.active, null) || window.hlCcTemplateForRole();
    window._hlCcStore.remote = false;
    window._hlCcStore.loaded = true;
    return window._hlCcStore;
  });
};
function hlCcLocalUpsert(row) {
  var customs = window._hlCcStore.customs.filter(function (c) { return c.id !== row.id; });
  customs.push(row);
  window._hlCcStore.customs = customs;
  hlCcLsWrite(CC_LS.customs, customs);
}
function hlCcLocalId() { return 'local-' + Date.now() + '-' + Math.floor(Math.random() * 100000); }

window.hlCcPersistNew = function (name, layout) {
  return hlCcApi('POST', { name: name, layout: layout, is_active: true }).then(function (j) {
    if (!j || j.ok !== true || !j.layout) throw new Error((j && j.error) || 'save failed');
    return j.layout;
  }).catch(function (err) {
    if (window._hlCcStore.remote) throw err; // a real server rejection (e.g. R8) must surface
    var row = { id: hlCcLocalId(), name: name, layout: layout, is_active: true };
    hlCcLocalUpsert(row);
    return row;
  }).then(function (row) {
    window._hlCcStore.customs.forEach(function (c) { c.is_active = (c.id === row.id); });
    hlCcLocalUpsert({ id: row.id, name: row.name, layout: row.layout, is_active: true });
    window._hlCcStore.activeId = row.id;
    hlCcCacheActive(row.layout, row.id);
    return row;
  });
};
window.hlCcPersistUpdate = function (id, patch) {
  var body = { id: id };
  Object.keys(patch).forEach(function (k) { body[k] = patch[k]; });
  return hlCcApi('PATCH', body).then(function (j) {
    if (!j || j.ok !== true || !j.layout) throw new Error((j && j.error) || 'update failed');
    return j.layout;
  }).catch(function (err) {
    if (window._hlCcStore.remote) throw err;
    var row = null;
    window._hlCcStore.customs.forEach(function (c) { if (c.id === id) row = c; });
    if (!row) throw err;
    Object.keys(patch).forEach(function (k) { row[k] = patch[k]; });
    return row;
  }).then(function (row) {
    if (patch.is_active === true) {
      window._hlCcStore.customs.forEach(function (c) { c.is_active = (c.id === row.id); });
      window._hlCcStore.activeId = row.id;
    }
    hlCcLocalUpsert({ id: row.id, name: row.name, layout: row.layout, is_active: !!row.is_active });
    if (window._hlCcStore.activeId === row.id) hlCcCacheActive(row.layout, row.id);
    return row;
  });
};
window.hlCcPersistDelete = function (id) {
  return hlCcApi('DELETE', null, '&id=' + encodeURIComponent(id)).then(function (j) {
    if (!j || j.ok !== true) throw new Error((j && j.error) || 'delete failed');
    return true;
  }).catch(function (err) {
    if (window._hlCcStore.remote) throw err;
    return true;
  }).then(function () {
    window._hlCcStore.customs = window._hlCcStore.customs.filter(function (c) { return c.id !== id; });
    hlCcLsWrite(CC_LS.customs, window._hlCcStore.customs);
    if (window._hlCcStore.activeId === id) {
      window._hlCcStore.activeId = CC_TEMPLATE_DEFAULT_ID;
      hlCcCacheActive(window.hlCcTemplateLayout(CC_TEMPLATE_DEFAULT_ID), CC_TEMPLATE_DEFAULT_ID);
    }
    return true;
  });
};
window.hlCcSetActive = function (id) {
  var apply = function () {
    window._hlCcStore.activeId = id;
    var layout = window.hlCcLayoutById(id);
    hlCcCacheActive(layout, id);
    window.hlCcApplyLayout(layout);
    if (typeof window.hlCCLRender === 'function') window.hlCCLRender();
  };
  if (id === CC_TEMPLATE_DEFAULT_ID) {
    // Templates are read-only presets and are not rows; "active = a template"
    // is recorded by clearing the active flag on every custom.
    var actives = window._hlCcStore.customs.filter(function (c) { return c.is_active; });
    window._hlCcStore.customs.forEach(function (c) { c.is_active = false; });
    hlCcLsWrite(CC_LS.customs, window._hlCcStore.customs);
    apply();
    return Promise.all(actives.map(function (c) {
      return window.hlCcPersistUpdate(c.id, { is_active: false }).catch(function () {});
    })).then(function () { window._hlCcStore.activeId = id; });
  }
  return window.hlCcPersistUpdate(id, { is_active: true }).then(apply);
};

// ---- add / remove widgets ---------------------------------------------------
function hlCcHiddenIds() {
  return window.hlCcCurrentLayout().widgets.filter(function (w) { return w.hidden; }).map(function (w) { return w.id; });
}
window.hlHideCcWidget = function (gsId) {
  if (gsId === CC_REQUIRED_WIDGET) {
    // R8: never removable, for anyone, in any layout. Reached only by a tampered
    // DOM or console call -- no ✕ is rendered for this widget.
    if (typeof hlSay === 'function') hlSay("Today's Decisions can be moved and resized, but it can't be removed.");
    return;
  }
  var grid = window._hlCcGrid, el = hlCcNode(gsId);
  if (!grid || !el) return;
  try { grid.removeWidget(el, false); } catch (e) {}
  el.style.display = 'none';
  hlRenderCcAddMenu();
};
window.hlShowCcWidget = function (gsId) {
  var grid = window._hlCcGrid, el = hlCcNode(gsId);
  if (!grid || !el) return;
  el.style.display = '';
  // Same ordering rule as hlCcSetEditMode: addWidget() re-creates this node's
  // drag/drop, which snapshots the handle elements as it goes -- so the shield
  // has to already be there or this widget comes back undraggable.
  hlCcMountEditChrome();
  try { grid.addWidget(el); } catch (e) {}
  hlRenderCcAddMenu();
  hlCcInvalidateMaps();
};
function hlRenderCcAddMenu() {
  var menu = document.getElementById('cc-add-menu');
  if (!menu) return;
  var hidden = hlCcHiddenIds();
  if (!hidden.length) { menu.innerHTML = '<div style="padding:8px 10px;font-size:11px;color:#5d657b;font-weight:600">All widgets are already shown.</div>'; return; }
  menu.innerHTML = hidden.map(function (gsId) {
    var label = CC_WIDGET_LABELS[gsId] || gsId;
    return '<div onclick="hlShowCcWidget(\'' + gsId + '\')" style="padding:8px 10px;font-size:12px;font-weight:700;color:#161e2e;cursor:pointer;border-radius:6px">+ ' + label + '</div>';
  }).join('');
}
window.hlToggleCcAddMenu = function () {
  var menu = document.getElementById('cc-add-menu');
  if (!menu) return;
  if (menu.style.display === 'block') { menu.style.display = 'none'; return; }
  hlRenderCcAddMenu();
  menu.style.display = 'block';
};
document.addEventListener('click', function (e) {
  var menu = document.getElementById('cc-add-menu');
  if (!menu || menu.style.display !== 'block') return;
  if (!e.target.closest('#cc-add-menu') && e.target.id !== 'cc-add-widget-btn') menu.style.display = 'none';
});

// ---- R2/R5: edit chrome, mounted only while editing -------------------------
function hlCcEditing() {
  var sn = document.getElementById('snapshot');
  return !!(sn && sn.classList.contains('cc-editing'));
}
function hlCcMountEditChrome() {
  var el = hlCcGridEl();
  // Self-guarding (R5): the shield and tools may only ever exist while editing,
  // so no caller can accidentally leak them into normal use.
  if (!el || !hlCcEditing()) return;
  [].slice.call(el.querySelectorAll('.grid-stack-item')).forEach(function (item) {
    var gsId = item.getAttribute('gs-id');
    var content = item.querySelector('.grid-stack-item-content');
    if (!content || !CC_WIDGET_LABELS[gsId]) return;
    if (!content.querySelector('.w-shield')) {
      // Transparent full-bleed overlay: it is what the pointer hits, so nothing
      // inside the widget (links, RULES →, OPEN HUB →, the Leaflet map, a job
      // chip) can be clicked or navigated to while editing, and a drag can be
      // started from anywhere on the widget rather than only its header.
      var shield = document.createElement('div');
      shield.className = 'w-shield';
      shield.setAttribute('aria-hidden', 'true');
      shield.title = 'Drag to move · drag an edge or corner to resize';
      content.appendChild(shield);
    }
    // R8: Today's Decisions is the one widget with no remove button -- and the
    // remove button is now the only tool -- so it gets no tools bar at all.
    // Resizing, for it and everything else, is GridStack's own edge/corner drag.
    if (gsId !== CC_REQUIRED_WIDGET && !content.querySelector('.w-tools')) {
      var tools = document.createElement('div');
      tools.className = 'w-tools';
      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'w-remove';
      remove.title = 'Remove this widget';
      remove.setAttribute('aria-label', 'Remove ' + (CC_WIDGET_LABELS[gsId] || gsId));
      remove.innerHTML = '&#10005;';
      remove.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
      remove.addEventListener('click', function (ev) { ev.stopPropagation(); window.hlHideCcWidget(gsId); });
      tools.appendChild(remove);
      content.appendChild(tools);
    }
  });
}
function hlCcUnmountEditChrome() {
  var el = hlCcGridEl();
  if (!el) return;
  [].slice.call(el.querySelectorAll('.w-shield, .w-tools')).forEach(function (n) { n.remove(); });
}

// ---- R3: Save / Go Back / Cancel Changes ------------------------------------
window._hlCcEntrySnapshot = null;
window.hlCcIsDirty = function () {
  if (!window._hlCcEntrySnapshot) return false;
  try { return JSON.stringify(window.hlCcCurrentLayout()) !== JSON.stringify(window._hlCcEntrySnapshot); } catch (e) { return false; }
};
function hlCcSyncToolbarName() {
  var box = document.getElementById('cc-layout-name');
  if (!box) return;
  var id = window._hlCcStore.activeId || CC_TEMPLATE_DEFAULT_ID;
  var name = 'HiveLogic Default';
  window._hlCcStore.customs.forEach(function (c) { if (c.id === id) name = c.name; });
  var isTemplate = (id === CC_TEMPLATE_DEFAULT_ID);
  box.textContent = (isTemplate ? 'Editing template: ' : 'Editing: ') + name + (isTemplate ? ' — saving forks it into your own copy' : '');
}
// Locked (staticGrid) is the safe default -- day-to-day use of the Command
// Center shouldn't risk nudging a widget out of place. Entering edit mode deep-
// copies the canvas so Cancel Changes and Go Back have something exact to
// restore; leaving it tears the edit chrome back out of the DOM.
window.hlCcSetEditMode = function (on) {
  var grid = window._hlCcGrid;
  if (!grid) return;
  var sn = document.getElementById('snapshot');
  if (sn) sn.classList.toggle('cc-editing', !!on);
  hlCcLsWriteRaw(CC_LS.edit, on ? '"1"' : '"0"');
  if (on) {
    window._hlCcEntrySnapshot = hlCcClone(window.hlCcCurrentLayout());
    // ORDER IS LORE, DON'T SWAP THESE TWO. GridStack resolves its drag handles
    // exactly once, in the DDDraggable constructor:
    //     this.dragEls = Array.from(el.querySelectorAll(option.handle))
    // (gridstack 10.3.1, dist/dd-draggable.js:27) -- and that constructor runs
    // inside setStatic(false). A .w-shield mounted AFTER that call is never in
    // dragEls, so it gets no mousedown listener; and because the shield covers
    // the header strips that do have listeners, it swallows their mousedowns
    // too. Net effect: nothing drags at all. Mount first, then unlock.
    hlCcMountEditChrome();
    try { grid.setStatic(false); } catch (e) {}
    hlCcSyncToolbarName();
  } else {
    try { grid.setStatic(true); } catch (e) {}
    hlCcUnmountEditChrome();
    window._hlCcEntrySnapshot = null;
    var menu = document.getElementById('cc-add-menu');
    if (menu) menu.style.display = 'none';
  }
};
// Cancel Changes: back to the snapshot taken when edit mode was entered, and
// STAY in edit mode.
window.hlCcCancelChanges = function () {
  if (!window._hlCcEntrySnapshot) return;
  window.hlCcApplyLayout(hlCcClone(window._hlCcEntrySnapshot));
  hlCcMountEditChrome();
  if (typeof hlSay === 'function') hlSay('↺ Changes reverted — still editing');
};
// Go Back: leave edit mode, discard anything unsaved, restore the last-saved
// layout.
window.hlCcGoBack = function () {
  if (window.hlCcIsDirty() && !window.confirm('Discard unsaved changes?')) return;
  var snapshot = hlCcClone(window._hlCcEntrySnapshot);
  window.hlCcSetEditMode(false);
  if (snapshot) window.hlCcApplyLayout(snapshot);
};
function hlCcSaveDone(row, label) {
  window._hlCcEntrySnapshot = hlCcClone(window.hlCcCurrentLayout());
  window.hlCcSetEditMode(false);
  if (typeof window.hlCCLRender === 'function') window.hlCCLRender();
  if (typeof hlSay === 'function') {
    hlSay('💾 Saved — "' + (row ? row.name : label) + '" is now your Command Center'
      + (window._hlCcStore.remote ? ', and it follows your login' : ' (saved on this browser — the layouts table isn\'t live yet)'));
  }
}
function hlCcSaveFailed(err) {
  var msg = (err && err.message) ? err.message : 'Could not save this layout.';
  if (typeof hlSay === 'function') hlSay('⚠ ' + msg);
  else window.alert(msg);
}
// Save: persist the canvas. Templates are read-only presets -- saving while a
// template is active FORKS it into a new custom rather than mutating it.
window.hlCcSaveLayout = function () {
  var layout = window.hlCcCurrentLayout();
  var activeId = window._hlCcStore.activeId || CC_TEMPLATE_DEFAULT_ID;
  var isCustom = false;
  window._hlCcStore.customs.forEach(function (c) { if (c.id === activeId) isCustom = true; });
  if (!isCustom) return window.hlCcSaveLayoutAsNew();
  return window.hlCcPersistUpdate(activeId, { layout: layout, is_active: true })
    .then(function (row) { hlCcSaveDone(row); })
    .catch(hlCcSaveFailed);
};
// Save as new: always mints another custom ("Custom Layout 1", "Custom Layout
// 2", ...) and makes it active, so a user can keep several arrangements.
window.hlCcSaveLayoutAsNew = function () {
  var layout = window.hlCcCurrentLayout();
  var name = hlCcNextCustomName();
  return window.hlCcPersistNew(name, layout)
    .then(function (row) { hlCcSaveDone(row, name); })
    .catch(hlCcSaveFailed);
};

// ---- boot -------------------------------------------------------------------
window.hlInitCcGrid = function () {
  try {
    var el = hlCcGridEl();
    if (!el || !window.GridStack || el._hlGsInited) return;
    if (el.offsetWidth === 0) return; // not visible yet -- caller will retry
    el._hlGsInited = true;
    // handle: '.w-shield' is the edit-mode drag surface (R2) and only exists
    // while editing; the header selectors after it stay so a header drag keeps
    // working. Outside edit mode staticGrid blocks all of them anyway.
    var grid = GridStack.init({ column: 12, cellHeight: 40, margin: 8, float: true,
      handle: '.w-shield, .map-head, .rb-band, .cchar-t, .pg-label, .rlv-jh-label',
      resizable: { handles: 'e,se,s,sw,w' },
      staticGrid: true }, el); // locked by default -- see hlCcSetEditMode
    window._hlCcGrid = grid;
    // Captured from the hardcoded HTML, before any saved layout is applied: this
    // is the "HiveLogic Default" template and the fallback for every widget a
    // saved layout predates.
    window._hlCcDefaultLayout = { widgets: hlCcReadLayout(el), background: null, brand_image: null };

    var cached = hlCcCachedActiveLayout();
    if (cached) window.hlCcApplyLayout(cached);
    if (hlCcLayoutHasCollision(hlCcReadLayout(el))) {
      console.warn('Command Center: saved layout collided with a widget added since it was last saved -- resetting to default.');
      window.hlCcApplyLayout(hlCcClone(window._hlCcDefaultLayout));
      hlCcCacheActive(window._hlCcDefaultLayout, CC_TEMPLATE_DEFAULT_ID);
    }
    // Positions/sizes are NOT auto-saved any more -- Save is explicit (R3), and
    // auto-saving would make Go Back/Cancel Changes meaningless. The change hook
    // is still needed so Leaflet and the Pulse dials re-measure after a resize.
    grid.on('change', function () { hlCcInvalidateMaps(); });
    grid.on('resizestop', function () { hlCcInvalidateMaps(); });

    // Re-enter customize mode if the page reloaded mid-edit. String() because
    // pre-2026-08-16 builds wrote a bare "1" (JSON.parse gives the number 1)
    // while this one writes a JSON string.
    if (String(hlCcLsRead(CC_LS.edit, '0')) === '1') window.hlCcSetEditMode(true);
    hlCcBootLoadLayouts();
  } catch (e) {}
};
// Never fire the layout fetch before Supabase has restored the session -- that
// is the repo's recurring boot-race bug (see test/command-center-session-race
// .test.mjs). Gate through hlRequireSession and re-run on 'hl:signed-in' so a
// client-side login (no page reload) still picks up the user's saved layout.
function hlCcBootLoadLayouts() {
  var run = function () {
    window.hlCcLoadLayouts().then(function (store) {
      if (typeof window.hlCCLRender === 'function') window.hlCCLRender();
      // Don't yank the canvas out from under someone mid-edit.
      var sn = document.getElementById('snapshot');
      if (sn && sn.classList.contains('cc-editing')) return;
      window.hlCcApplyLayout(window.hlCcLayoutById(store.activeId));
      hlCcCacheActive(window.hlCcLayoutById(store.activeId), store.activeId);
    });
  };
  if (typeof window.hlRequireSession === 'function') window.hlRequireSession(run, run);
  else run();
}
window.addEventListener('hl:signed-in', function () { if (window._hlCcGrid) hlCcBootLoadLayouts(); });

// Settings > Command Center > "Customize Layout" entry point (hlSettings below).
// Command Center may not be the current view (or even mounted/GridStack-inited)
// yet, so this switches to it first and waits for hlInitCcGrid to have run.
window.hlCcEnterCustomize = function () {
  var modal = document.getElementById('hlmodal'); if (modal) modal.remove();
  showView('cc');
  var tries = 0;
  (function wait() {
    if (window._hlCcGrid) { window.hlCcSetEditMode(true); return; }
    if (++tries > 40) return; // ~4s -- give up rather than loop forever
    setTimeout(wait, 100);
  })();
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(window.hlInitCcGrid, 300); });
else setTimeout(window.hlInitCcGrid, 300);
