// public/hiveconnect/voip-panel.js
// HiveConnect's "VoIP" tab -- premium dispatcher dashboard: Dialer, Call
// history, Voicemail, Directory, and Settings (Extensions / Numbers /
// Greetings / Blocklist). The popup (public/app-phone-popup.js, top-bar
// phone icon) stays the quick-access surface for placing/answering calls
// from anywhere on the site; this tab is the deeper, everything-in-one-
// place view for history, directory, and admin work.
//
// Visual language matches the rest of HiveLogic (Daily Brief / Command
// Center): edge-to-edge canvas, large shadowed cards, strong hierarchy.
// UI-only pass -- no backend or call-routing changes. Cards that need a
// backend feature that does not exist yet (queues, call park, live agent
// presence) show an honestly-styled empty state instead of invented
// numbers -- see reina/voip-dispatch-center-redesign-2026-07-25.md.
//
// Both this tab and the popup share ONE Twilio Device. Calls started from
// this tab route through window.hlPhone (exposed by app-phone-popup.js),
// not a second softphone -- Twilio Voice SDK only supports one healthy
// registration per identity per browser tab. The live call itself always
// plays out in the popup, so it survives navigating away from this tab.
//
// Loaded via <script src="voip-panel.js"> before app.js. All functions
// here are global on purpose (no module system in this codebase yet).

let voipData = { calls: [], voicemails: [], status: null, extensions: [], numbers: [] };
let voipCenterTab = 'dial'; // dial | directory | history | voicemail
let voipCallTimerInterval = null;

// Shared color/shadow tokens for the new premium card look. Green stays
// the primary accent (matches the rest of HiveConnect); blue is reserved
// for the voicemail stat only, per the locked mockup.
const VOIP_UI = {
  green: '#1B7A50', greenBg: '#e6f2ec', greenBorder: '#bfe3d1',
  red: '#c65b4e', redBg: '#faeeec', redBorder: '#f0cec7',
  amber: '#b8791f', amberBg: '#fdf3e2', amberBorder: '#f2ddac',
  blue: '#3b6fd6', blueBg: '#eaf0fd', blueBorder: '#c9d9f7',
  gold: '#c9862e', goldDark: '#a86e22',
  gray: '#8b92a8', grayBg: '#f0f1f6', grayBorder: '#dadde8',
  ink: '#161e2e', sub: '#5d657b', line: '#e3e5ec',
  cardShadow: '0 14px 32px rgba(22,30,46,.09),0 4px 12px rgba(22,30,46,.06)',
  cardRadius: '16px',
};
// Expose on window so sibling scripts (voip-callflow.js) never hard-fail if
// they run before this const is in scope (load-order / stale-cache mismatch).
try { window.VOIP_UI = VOIP_UI; } catch (e) {}

function voipEscapeHtml(v) { return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function voipFmtDuration(sec) { if (!sec && sec !== 0) return '&mdash;'; const m = Math.floor(sec / 60), s = sec % 60; return `${m}:${String(s).padStart(2, '0')}`; }
function voipFmtWhen(iso) { if (!iso) return '&mdash;'; const d = new Date(iso); return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
function voipFmtTime(iso) { if (!iso) return '&mdash;'; const d = new Date(iso); return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }
function voipNotify(msg) { (window.hlToast || alert)(msg); }
function voipSoon() { voipNotify('Coming soon.'); }

async function voipApi(path, method, body) {
  const headers = {};
  const token = typeof hlTokenSync === 'function' ? hlTokenSync() : null;
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body) headers['Content-Type'] = 'application/json';
  try {
    const res = await fetch(`/api/voice${path}`, { method: method || 'GET', headers, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  } catch (e) {
    return { ok: false, data: { error: String(e && e.message || e) } };
  }
}

// Every "call this number" action in this tab goes through the popup's
// single Twilio Device -- see the file header for why.
function voipDial(to) {
  if (!to) return;
  if (window.hlPhone && window.hlPhone.dial) window.hlPhone.dial(to);
  else if (window.hlPhonePopupToggle) window.hlPhonePopupToggle();
}

function voipOpenPopup() {
  if (window.hlPhone && window.hlPhone.open) window.hlPhone.open();
  else if (window.hlPhonePopupToggle) window.hlPhonePopupToggle();
}

function voipRenderNotConfigured(root, missing) {
  root.innerHTML = `
    <div style="max-width:440px;margin:80px auto;text-align:center">
      <div style="font-size:30px;margin-bottom:8px">&#128222;</div>
      <h3 style="margin:0 0 6px">HiveLogic Phone isn't connected yet</h3>
      <p style="color:#8892a6;font-size:13px;line-height:1.6">Real code, just waiting on a Twilio account. See the top-bar phone icon for setup status, or ask an admin.</p>
      ${missing && missing.length ? `<div style="text-align:left;background:#f5f6fa;border-radius:8px;padding:10px 12px;margin-top:10px;font-size:11.5px;font-family:ui-monospace,monospace;display:inline-block">Missing: ${missing.map(voipEscapeHtml).join(', ')}</div>` : ''}
    </div>`;
}
// ---------------------------------------------------------------------
// Header stat cards -- 4 large cards with a real (or honestly-labeled)
// figure, an icon, and a tiny sparkline. Calls/voicemail sparklines are
// computed client-side from the already-fetched calls/voicemails lists
// (bucketed by recency) -- real derived data, not invented trend lines.
// ---------------------------------------------------------------------
function voipSparklinePath(values, w, h) {
  if (!values.length) return '';
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = Math.max(max - min, 1);
  const stepX = values.length > 1 ? w / (values.length - 1) : 0;
  return values.map((v, i) => {
    const x = (i * stepX).toFixed(1);
    const y = (h - ((v - min) / range) * h).toFixed(1);
    return (i === 0 ? 'M' : 'L') + x + ',' + y;
  }).join(' ');
}
function voipSparklineSvg(values, color) {
  const w = 64, h = 26;
  const path = voipSparklinePath(values, w, h);
  if (!path) return '';
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" style="display:block"><path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
function voipBucketByRecency(items, dateField, buckets) {
  if (!items.length) return new Array(buckets).fill(0);
  const times = items.map(it => new Date(it[dateField]).getTime()).filter(t => !isNaN(t));
  if (!times.length) return new Array(buckets).fill(0);
  const max = Math.max(...times), min = Math.min(...times);
  const span = Math.max(max - min, 1);
  const counts = new Array(buckets).fill(0);
  times.forEach(t => {
    let idx = Math.floor(((t - min) / span) * buckets);
    if (idx >= buckets) idx = buckets - 1;
    if (idx < 0) idx = 0;
    counts[idx]++;
  });
  return counts;
}

function voipStatCard(opts) {
  const spark = opts.sparkline ? `<div style="margin-left:auto">${voipSparklineSvg(opts.sparkline, opts.sparkColor || VOIP_UI.green)}</div>` : '';
  return `<div style="flex:1;min-width:200px;background:#fff;border:1px solid ${VOIP_UI.line};border-radius:${VOIP_UI.cardRadius};padding:13px 18px;box-shadow:${VOIP_UI.cardShadow};display:flex;align-items:center;gap:12px">
    <div style="flex:1">
      <div style="font-size:21px;font-weight:800;color:${opts.dim ? VOIP_UI.gray : VOIP_UI.ink};line-height:1">${opts.value}</div>
      <div style="font-size:10.5px;color:${VOIP_UI.gray};font-weight:800;letter-spacing:.06em;text-transform:uppercase;margin-top:5px">${opts.label}</div>
      ${opts.sub ? `<div style="font-size:10.5px;color:${VOIP_UI.amber};font-weight:700;margin-top:4px">${opts.sub}</div>` : ''}
    </div>
    ${spark}
  </div>`;
}

function voipRenderStats(status, calls, voicemails) {
  const unread = voicemails.filter(v => !v.read).length;
  const callVolume = voipBucketByRecency(calls, 'started_at', 7);
  const vmVolume = voipBucketByRecency(voicemails, 'created_at', 7);
  const extFlat = new Array(7).fill(status && status.extensionCount || 0);
  return `
    <div style="display:flex;gap:12px;margin-bottom:14px;flex-wrap:wrap">
      ${voipStatCard({ value: calls.length, label: 'Recent calls', sparkline: callVolume, sparkColor: VOIP_UI.green })}
      ${voipStatCard({ value: '&mdash;', label: 'Calls in queue', sub: 'Not tracked yet', dim: true, sparkline: new Array(7).fill(0), sparkColor: VOIP_UI.grayBorder })}
      ${voipStatCard({ value: unread, label: 'Unread voicemail', sparkline: vmVolume, sparkColor: VOIP_UI.blue })}
      ${voipStatCard({ value: status && status.extensionCount || 0, label: 'Extensions active', sparkline: extFlat, sparkColor: VOIP_UI.green })}
    </div>`;
}
// ---------------------------------------------------------------------
// Call history -- Time / Direction / From-To / Duration / Agent / Outcome.
// Outcome pill is derived from the real voice_calls.status column (see
// sql/023_voice_phone_system.sql) -- completed/missed/failed/voicemail
// map to real states; anything still in-flight (ringing/answered/held/
// transferring/parked/conferenced) reads as "In progress".
// ---------------------------------------------------------------------
function voipOutcomePill(status) {
  let color = VOIP_UI.gray, bg = VOIP_UI.grayBg, label = 'In progress';
  if (status === 'completed') { color = VOIP_UI.green; bg = VOIP_UI.greenBg; label = 'Completed'; }
  else if (status === 'missed' || status === 'no-answer') { color = VOIP_UI.red; bg = VOIP_UI.redBg; label = 'Missed'; }
  else if (status === 'failed') { color = VOIP_UI.red; bg = VOIP_UI.redBg; label = 'Failed'; }
  else if (status === 'busy') { color = VOIP_UI.red; bg = VOIP_UI.redBg; label = 'Busy'; }
  else if (status === 'canceled') { color = VOIP_UI.gray; bg = VOIP_UI.grayBg; label = 'Canceled'; }
  else if (status === 'voicemail') { color = VOIP_UI.amber; bg = VOIP_UI.amberBg; label = 'Voicemail'; }
  else if (status === 'unknown') { color = VOIP_UI.gray; bg = VOIP_UI.grayBg; label = 'Unknown'; }
  return `<span style="display:inline-block;font-size:10.5px;font-weight:800;color:${color};background:${bg};padding:4px 10px;border-radius:99px">${label}</span>`;
}
function voipDirectionIcon(direction) {
  const out = direction !== 'inbound';
  const color = out ? VOIP_UI.green : VOIP_UI.blue;
  const arrow = out ? '&#8599;' : '&#8601;';
  return `<span style="color:${color};font-weight:800">${arrow} ${out ? 'Out' : 'In'}</span>`;
}

function voipRenderCallsTable(calls, opts) {
  opts = opts || {};
  voipInitRowMenu();
  voipInitCallIntel();
  if (!calls.length) return `<div style="color:${VOIP_UI.gray};font-size:13px;padding:20px 0;text-align:center">No calls logged yet.</div>`;
  const th = (label) => `<th style="padding:10px 14px;font-size:10px;color:${VOIP_UI.gray};font-weight:800;letter-spacing:.06em;text-transform:uppercase;text-align:left;position:sticky;top:0;background:${VOIP_UI.grayBg};z-index:1">${label}</th>`;
  return `
    <table style="width:100%;border-collapse:collapse;font-size:12.5px">
      <thead><tr style="background:${VOIP_UI.grayBg}">${th('Time')}${th('Direction')}${th('From / To')}${th('Duration')}${th('Agent')}${th('Outcome')}${th('Actions')}</tr></thead>
      <tbody>${calls.map(c => {
        const number = c.direction === 'inbound' ? c.from_number : c.to_number;
        const primary = c.clientName || number;
        const secondary = c.clientName ? number : null;
        return `<tr class="voip-call-row" data-to="${voipEscapeHtml(number)}" style="border-top:1px solid ${VOIP_UI.line};cursor:pointer">
          <td style="padding:11px 14px;color:${VOIP_UI.sub};white-space:nowrap">${voipFmtTime(c.started_at)}</td>
          <td style="padding:11px 14px;white-space:nowrap">${voipDirectionIcon(c.direction)}</td>
          <td style="padding:11px 14px"><div style="font-weight:700;color:${VOIP_UI.ink}">${voipEscapeHtml(primary)}</div>${secondary ? `<div style="font-size:11px;color:${VOIP_UI.gray}">${voipEscapeHtml(secondary)}</div>` : ''}</td>
          <td style="padding:11px 14px;color:${VOIP_UI.sub};white-space:nowrap">${voipFmtDuration(c.duration_seconds)}</td>
          <td style="padding:11px 14px;color:${VOIP_UI.sub};white-space:nowrap">${voipEscapeHtml((c.extensionLabel || '').split(' — ')[1] || '&mdash;')}</td>
          <td style="padding:11px 14px;white-space:nowrap">${voipOutcomePill(c.status)}</td>
          <td style="padding:11px 14px;white-space:nowrap;text-align:right">${(c.ai_summary || c.recording_url) ? ('<button class="voip-ci-btn" data-callid="' + voipEscapeHtml(c.id) + '" title="Call intelligence" style="border:none;background:' + VOIP_UI.greenBg + ';color:' + VOIP_UI.green + ';font-weight:900;font-size:12px;padding:4px 9px;border-radius:99px;cursor:pointer;line-height:1;margin-right:4px">&#10024;</button>') : ''}${c.clientName ? '' : ('<button class="voip-row-kebab" data-number="' + voipEscapeHtml(number) + '" title="More options" style="border:none;background:' + VOIP_UI.grayBg + ';color:' + VOIP_UI.gray + ';font-weight:900;font-size:13px;padding:4px 9px;border-radius:99px;cursor:pointer;line-height:1">&#8942;</button>')}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
}

// ---------------------------------------------------------------------
// Phase 4: Call Intelligence panel -- the ✨ button on a call row expands an
// inline detail row with recording playback, the AI summary + key points,
// and draft actions (Approve/Dismiss). Approve on a follow-up callback claims
// it + dials back (fully end-to-end); change-order/task drafts are shown as
// "suggested" until their engines are wired (next increment).
// ---------------------------------------------------------------------
let voipCallIntelInited = false;
function voipInitCallIntel() {
  if (voipCallIntelInited) return;
  voipCallIntelInited = true;
  document.addEventListener('click', function (e) {
    const btn = e.target.closest('.voip-ci-btn');
    if (!btn) return;
    e.stopPropagation();
    voipToggleCallIntel(btn);
  });
}
function voipCallById(id) { return ((voipData && voipData.calls) || []).find(c => c.id === id) || null; }

function voipToggleCallIntel(btn) {
  const tr = btn.closest('tr');
  if (!tr) return;
  const next = tr.nextElementSibling;
  if (next && next.classList && next.classList.contains('voip-ci-detail')) { next.remove(); return; }
  const call = voipCallById(btn.dataset.callid);
  if (!call) return;
  const detail = document.createElement('tr');
  detail.className = 'voip-ci-detail';
  detail.innerHTML = `<td colspan="7" style="padding:0 14px 14px;background:${VOIP_UI.grayBg}">${voipCallIntelPanel(call)}</td>`;
  tr.parentNode.insertBefore(detail, tr.nextSibling);
  detail.querySelectorAll('.voip-ci-approve').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    await voipApi('?resource=callback_update', 'POST', { id: b.dataset.id, claim: true });
    if (b.dataset.num) voipDial(b.dataset.num);
    voipNotify('Follow-up approved — added to your callbacks.');
    b.textContent = 'Approved';
  }));
  detail.querySelectorAll('.voip-ci-dismiss').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    await voipApi('?resource=callback_update', 'POST', { id: b.dataset.id, status: 'dismissed' });
    const wrap = b.closest('.voip-ci-draft'); if (wrap) wrap.style.opacity = '.5';
    b.textContent = 'Dismissed';
  }));
}

function voipDraftActionRow(d) {
  const label = d.type === 'callback' ? 'Follow-up callback' : (d.type === 'change_order' ? 'Possible change order' : (d.type === 'task' ? 'Review task' : String(d.type || 'Action')));
  const approvable = d.type === 'callback' && d.ref_id;
  const buttons = approvable
    ? `<button class="voip-ci-approve" data-id="${voipEscapeHtml(d.ref_id)}" style="border:none;background:${VOIP_UI.green};color:#fff;font-weight:800;font-size:10.5px;padding:5px 12px;border-radius:8px;cursor:pointer;margin-right:6px">Approve</button><button class="voip-ci-dismiss" data-id="${voipEscapeHtml(d.ref_id)}" style="border:1px solid ${VOIP_UI.line};background:#fff;color:${VOIP_UI.sub};font-weight:800;font-size:10.5px;padding:5px 12px;border-radius:8px;cursor:pointer">Dismiss</button>`
    : `<span style="font-size:10px;color:${VOIP_UI.gray};font-weight:700;white-space:nowrap">Suggested — review</span>`;
  return `<div class="voip-ci-draft" style="display:flex;align-items:center;gap:10px;background:#fff;border:1px solid ${VOIP_UI.line};border-radius:8px;padding:8px 10px;margin-top:6px">
    <div style="flex:1;min-width:0"><div style="font-size:11.5px;font-weight:800;color:${VOIP_UI.ink}">${voipEscapeHtml(label)}</div><div style="font-size:10.5px;color:${VOIP_UI.gray};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${voipEscapeHtml(d.excerpt || '')}</div></div>
    <div style="flex-shrink:0">${buttons}</div>
  </div>`;
}

function voipCallIntelPanel(call) {
  const rec = call.recording_url ? `<audio controls preload="none" data-rec-kind="call" data-rec-id="${voipEscapeHtml(call.id)}" style="width:100%;height:34px;margin-bottom:10px"></audio>` : '';
  const s = call.ai_summary;
  if (!s || typeof s !== 'object') {
    const note = call.transcript_status === 'pending'
      ? 'Recording captured. AI summary will appear once a transcript source is connected.'
      : (call.recording_url ? 'Recording captured. No AI summary yet.' : 'No recording or summary for this call.');
    return `<div style="padding:12px 0">${rec}<div style="font-size:12px;color:${VOIP_UI.gray}">${note}</div></div>`;
  }
  const chips = [];
  if (s.intent) chips.push(['Intent', s.intent]);
  if (s.sentiment) chips.push(['Sentiment', s.sentiment]);
  if (s.follow_up_needed) chips.push(['Follow-up', 'Needed']);
  const chipHtml = chips.map(([k, v]) => `<span style="font-size:10.5px;font-weight:700;color:${VOIP_UI.sub};background:#fff;border:1px solid ${VOIP_UI.line};border-radius:99px;padding:3px 9px;margin-right:6px;display:inline-block;margin-bottom:4px">${voipEscapeHtml(k)}: ${voipEscapeHtml(v)}</span>`).join('');
  const commitments = Array.isArray(s.commitments) && s.commitments.length
    ? `<div style="margin-top:8px"><b style="font-size:11px;color:${VOIP_UI.ink}">Commitments</b><ul style="margin:4px 0 0;padding-left:18px;font-size:11.5px;color:${VOIP_UI.sub}">${s.commitments.map(c => `<li>${voipEscapeHtml(((c && c.who) || '') + ' — ' + ((c && c.what) || '') + ((c && c.due) ? (' (by ' + c.due + ')') : ''))}</li>`).join('')}</ul></div>` : '';
  const drafts = Array.isArray(s.draft_actions) && s.draft_actions.length
    ? `<div style="margin-top:10px"><b style="font-size:11px;color:${VOIP_UI.ink}">Draft actions</b>${s.draft_actions.map(voipDraftActionRow).join('')}</div>` : '';
  return `<div style="padding:12px 0">
    ${rec}
    <div style="font-size:13px;color:${VOIP_UI.ink};line-height:1.55;margin-bottom:8px">&#10024; ${voipEscapeHtml(s.summary || '')}</div>
    <div>${chipHtml}</div>
    ${commitments}
    ${drafts}
  </div>`;
}

let voipRowMenuInited = false;
function voipInitRowMenu() {
  if (voipRowMenuInited) return;
  voipRowMenuInited = true;
  const menu = document.createElement('div');
  menu.id = 'voip-rowmenu';
  menu.style.cssText = 'display:none;position:fixed;background:#fff;border:1px solid ' + VOIP_UI.grayBorder + ';border-radius:10px;box-shadow:0 10px 28px rgba(20,25,40,.22);z-index:10000;overflow:hidden;min-width:190px;font-size:12px;font-family:inherit';
  document.body.appendChild(menu);
  menu.addEventListener('click', function (e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    voipHideRowMenu();
    voipRunRowMenuAction(btn.dataset.action, btn.dataset.number);
  });
  document.addEventListener('click', function (e) {
    const kebab = e.target.closest('.voip-row-kebab');
    if (kebab) { voipShowRowMenu(kebab, kebab.dataset.number); return; }
    if (menu.style.display === 'none') return;
    if (menu.contains(e.target)) return;
    voipHideRowMenu();
  });
}

function voipHideRowMenu() {
  const m = document.getElementById('voip-rowmenu');
  if (m) m.style.display = 'none';
}

function voipShowRowMenu(anchorBtn, number) {
  const m = document.getElementById('voip-rowmenu');
  if (!m || !number) return;
  const items = [
    ['create_contact', 'Create Contact'],
    ['add_to_contact', 'Add to Existing Contact'],
    ['block_number', 'Block Number'],
  ];
  m.innerHTML = items.map(function (pair) {
    return '<button data-action="' + pair[0] + '" data-number="' + voipEscapeHtml(number) + '" style="display:block;width:100%;text-align:left;padding:9px 12px;border:none;background:none;font-family:inherit;font-size:12px;font-weight:600;color:' + VOIP_UI.ink + ';cursor:pointer">' + pair[1] + '</button>';
  }).join('<div style="height:1px;background:' + VOIP_UI.line + '"></div>');
  const rect = anchorBtn.getBoundingClientRect();
  m.style.display = 'block';
  m.style.top = Math.min(window.innerHeight - 140, rect.bottom + 4) + 'px';
  m.style.left = Math.max(4, Math.min(window.innerWidth - 194, rect.right - 180)) + 'px';
}

async function voipRunRowMenuAction(action, number) {
  if (!number) return;
  if (action === 'create_contact') {
    const name = window.prompt('Contact name for ' + number + ':');
    if (!name || !name.trim()) return;
    const r = await voipApi('?resource=contact_create', 'POST', { e164: number, name: name.trim() });
    if (!r.ok) return voipNotify((r.data && r.data.error) || 'Could not save contact.');
    voipNotify('Contact saved.');
    voipRenderCenterTab();
  } else if (action === 'block_number') {
    if (!window.confirm('Block ' + number + '? They will no longer be able to reach you.')) return;
    const r = await voipApi('?resource=blocklist', 'POST', { e164: number, reason: 'Blocked from call log' });
    if (!r.ok) return voipNotify((r.data && r.data.error) || 'Could not block number.');
    voipNotify('Number blocked.');
  } else if (action === 'add_to_contact') {
    voipOpenContactLinker(number);
  }
}

let voipLinkerSearchTimer = null;
function voipOpenContactLinker(number) {
  voipCloseContactLinker();
  const overlay = document.createElement('div');
  overlay.id = 'voip-linker-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(22,30,46,.4);z-index:10001;display:flex;align-items:center;justify-content:center';
  overlay.innerHTML = '<div style="background:#fff;border-radius:14px;padding:20px;width:360px;max-width:90vw;box-shadow:' + VOIP_UI.cardShadow + '">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">'
    + '<div style="font-size:13px;font-weight:800;color:' + VOIP_UI.ink + '">Link ' + voipEscapeHtml(number) + ' to a contact</div>'
    + '<button id="voip-linker-close" style="border:none;background:none;color:' + VOIP_UI.gray + ';font-size:16px;font-weight:800;cursor:pointer;padding:0">&times;</button>'
    + '</div>'
    + '<input id="voip-linker-search" type="text" placeholder="Search contacts by name..." style="width:100%;box-sizing:border-box;font-size:12.5px;padding:9px 10px;border:1px solid ' + VOIP_UI.grayBorder + ';border-radius:8px;margin-bottom:10px;font-family:inherit;background:' + VOIP_UI.grayBg + ';color:' + VOIP_UI.ink + '" />'
    + '<div id="voip-linker-results" style="font-size:12px;color:' + VOIP_UI.gray + ';padding:6px 0;max-height:260px;overflow-y:auto">Type at least 2 characters to search.</div>'
    + '</div>';
  document.body.appendChild(overlay);
  overlay.addEventListener('click', function (e) { if (e.target === overlay) voipCloseContactLinker(); });
  document.getElementById('voip-linker-close').addEventListener('click', voipCloseContactLinker);
  const input = document.getElementById('voip-linker-search');
  input.focus();
  input.addEventListener('input', function () {
    clearTimeout(voipLinkerSearchTimer);
    const q = input.value.trim();
    voipLinkerSearchTimer = setTimeout(function () { voipRunLinkerSearch(number, q); }, 300);
  });
}

function voipCloseContactLinker() {
  const el = document.getElementById('voip-linker-overlay');
  if (el) el.remove();
}

async function voipRunLinkerSearch(e164, q) {
  const results = document.getElementById('voip-linker-results');
  if (!results) return;
  if (q.length < 2) { results.innerHTML = 'Type at least 2 characters to search.'; return; }
  results.innerHTML = 'Searching&hellip;';
  const r = await voipApi('?resource=directory&q=' + encodeURIComponent(q));
  if (!r.ok) { results.innerHTML = 'Search failed.'; return; }
  const matches = (r.data && r.data.clients) || [];
  if (!matches.length) { results.innerHTML = 'No matching contacts.'; return; }
  results.innerHTML = matches.slice(0, 8).map(function (c) {
    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid ' + VOIP_UI.line + '">'
      + '<div><div style="font-weight:700;font-size:12px;color:' + VOIP_UI.ink + '">' + voipEscapeHtml(c.name || 'Unnamed') + '</div><div style="font-size:10.5px;color:' + VOIP_UI.gray + '">' + voipEscapeHtml(c.phone || '') + '</div></div>'
      + '<button class="voip-linker-pick" data-id="' + voipEscapeHtml(c.id || '') + '" data-name="' + voipEscapeHtml(c.name || '') + '" style="border:none;background:' + VOIP_UI.greenBg + ';color:' + VOIP_UI.green + ';font-weight:800;font-size:10px;padding:4px 9px;border-radius:99px;cursor:pointer">Link</button>'
      + '</div>';
  }).join('');
  results.querySelectorAll('.voip-linker-pick').forEach(function (b) {
    b.addEventListener('click', function () { voipConfirmLink(e164, b.dataset.id, b.dataset.name); });
  });
}

async function voipConfirmLink(e164, jobberClientId, name) {
  if (!jobberClientId) return;
  if (!window.confirm('Link ' + e164 + ' to ' + name + '?')) return;
  const r = await voipApi('?resource=contact_link', 'POST', { e164: e164, jobberClientId: jobberClientId });
  if (!r.ok) return voipNotify((r.data && r.data.error) || 'Could not link contact.');
  voipNotify('Linked to ' + name + '.');
  voipCloseContactLinker();
  voipRenderCenterTab();
}

// ---------------------------------------------------------------------
// Voicemail -- one premium card per message. AI summary/transcript are
// real columns (voice_calls.ai_summary/transcript) surfaced when present;
// otherwise honest "transcribing" / nothing-shown states.
// ---------------------------------------------------------------------
function voipRenderVoicemailList(voicemails) {
  if (!voicemails.length) return `<div style="color:${VOIP_UI.gray};font-size:13px;padding:20px 0;text-align:center">No voicemails.</div>`;
  return voicemails.map(v => `
    <div style="background:#fff;border:1px solid ${VOIP_UI.line};border-radius:14px;padding:16px 18px;margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div style="display:flex;align-items:center;gap:8px">
          ${v.read ? '' : `<span style="width:8px;height:8px;border-radius:50%;background:${VOIP_UI.red};display:inline-block"></span>`}
          <span style="font-size:14px;font-weight:800;color:${VOIP_UI.ink}">${voipEscapeHtml(v.from_number)}</span>
        </div>
        <span style="color:${VOIP_UI.gray};font-weight:600;font-size:11px">${voipFmtWhen(v.created_at)} &middot; ${voipFmtDuration(v.duration_seconds)}</span>
      </div>
      ${v.recording_url ? `<audio controls preload="none" data-rec-kind="vm" data-rec-id="${voipEscapeHtml(v.id)}" style="width:100%;margin-top:10px;height:32px"></audio>` : ''}
      ${v.ai_summary ? `<div style="margin-top:8px;font-size:12px;color:${VOIP_UI.sub};background:${VOIP_UI.grayBg};border-radius:8px;padding:8px 10px"><b style="color:${VOIP_UI.ink}">AI summary:</b> ${voipEscapeHtml(v.ai_summary)}</div>` : ''}
      ${v.transcript ? `<details style="margin-top:8px"><summary style="font-size:11.5px;cursor:pointer;color:${VOIP_UI.gray};font-weight:700">Transcript</summary><div style="font-size:12px;margin-top:4px;color:${VOIP_UI.sub}">${voipEscapeHtml(v.transcript)}</div></details>` : v.transcript_status === 'pending' ? `<div style="font-size:10.5px;color:${VOIP_UI.amber};margin-top:8px;font-weight:700">Transcribing&hellip;</div>` : ''}
      <div style="display:flex;gap:18px;margin-top:12px">
        <button class="voip-vm-toggle" data-id="${v.id}" data-read="${v.read ? '0' : '1'}" style="border:none;background:none;color:${VOIP_UI.sub};cursor:pointer;font-weight:700;font-size:11.5px;padding:0">${v.read ? 'Mark unread' : 'Mark read'}</button>
        <button class="voip-vm-callback" data-to="${voipEscapeHtml(v.from_number)}" style="border:none;background:none;color:${VOIP_UI.green};cursor:pointer;font-weight:800;font-size:11.5px;padding:0">&#128222; Call back</button>
        <button class="voip-vm-delete" data-id="${v.id}" style="border:none;background:none;color:${VOIP_UI.red};cursor:pointer;font-weight:700;font-size:11.5px;padding:0;margin-left:auto">&#128465; Delete</button>
      </div>
    </div>`).join('');
}

function voipRenderVoicemailPanel(body) {
  body.innerHTML = voipRenderVoicemailList(voipData.voicemails);
  body.querySelectorAll('.voip-vm-toggle').forEach(b => b.addEventListener('click', async () => {
    await voipApi('?resource=voicemail_read', 'POST', { id: b.dataset.id, read: b.dataset.read === '1' });
    const vmRes = await voipApi('?resource=voicemails&all=1');
    voipData.voicemails = vmRes.ok ? vmRes.data.voicemails : [];
    voipRenderVoicemailPanel(body);
  }));
  body.querySelectorAll('.voip-vm-callback').forEach(b => b.addEventListener('click', () => voipDial(b.dataset.to)));
  body.querySelectorAll('.voip-vm-delete').forEach(b => b.addEventListener('click', async () => {
    if (!window.confirm('Delete this voicemail? It will be removed from your inbox.')) return;
    const r = await voipApi('?resource=voicemail_delete', 'POST', { id: b.dataset.id });
    if (!r.ok) { voipNotify((r.data && r.data.error) || 'Could not delete voicemail.'); return; }
    const vmRes = await voipApi('?resource=voicemails&all=1');
    voipData.voicemails = vmRes.ok ? vmRes.data.voicemails : [];
    voipRenderVoicemailPanel(body);
  }));
}
// ---------------------------------------------------------------------
// Left column: Active Call / Coming Soon (Queue Overview + Call Park
// merged into one compact card -- two near-identical placeholder cards
// was clutter). Active Call reads window.hlPhone.getActiveCall() -- real
// state from the popup's single Twilio Device. The 5 near-duplicate
// hold/mute/transfer/keypad/more buttons were collapsed into a single
// "Call controls" button that opens the popup (the only place those
// controls actually live); End Call stays real via hangup(). Queue
// Overview and Call Park have no backend yet -- honest, well-designed
// empty state, not fake data.
// ---------------------------------------------------------------------
function voipInitials(label) {
  const parts = String(label || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}
function voipCardShell(title, badge, innerHtml) {
  return `<section style="background:#fff;border:1px solid ${VOIP_UI.line};border-radius:${VOIP_UI.cardRadius};padding:15px;box-shadow:${VOIP_UI.cardShadow}">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <h4 style="margin:0;font-size:11.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:${VOIP_UI.ink}">${title}</h4>
      ${badge || ''}
    </div>
    ${innerHtml}
  </section>`;
}
function voipEmptyState(icon, text) {
  return `<div style="text-align:center;padding:15px 6px;color:${VOIP_UI.gray}">
    <div style="font-size:20px;margin-bottom:6px;opacity:.7">${icon}</div>
    <div style="font-size:12px;line-height:1.6">${text}</div>
  </div>`;
}

function voipRenderActiveCallCard(container) {
  clearInterval(voipCallTimerInterval);
  const info = (window.hlPhone && window.hlPhone.getActiveCall) ? window.hlPhone.getActiveCall() : { onCall: false };
  if (!info.onCall) {
    container.innerHTML = voipCardShell('Active Call', '', voipEmptyState('&#128222;', 'No active call. Incoming and outgoing calls will appear here.'));
    return;
  }
  const badge = `<span style="display:flex;align-items:center;gap:5px;font-family:ui-monospace,monospace;font-size:12px;color:${VOIP_UI.sub}"><span style="width:6px;height:6px;border-radius:50%;background:${VOIP_UI.green}"></span><span id="voip-active-timer"></span></span>`;
  const inner = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
      <div style="width:44px;height:44px;border-radius:50%;background:${VOIP_UI.green};color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:15px;flex-shrink:0">${voipInitials(info.label)}</div>
      <div style="min-width:0">
        <div style="font-size:15px;font-weight:800;color:${VOIP_UI.ink};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${voipEscapeHtml(info.label || 'On a call')}</div>
        <div style="font-size:11px;color:${VOIP_UI.gray}">Live call</div>
      </div>
    </div>
    <button id="voip-act-controls" style="width:100%;padding:9px 0;border-radius:10px;border:1px solid ${VOIP_UI.line};background:#fbfbfd;color:${VOIP_UI.sub};font-weight:800;font-size:11.5px;cursor:pointer;margin-bottom:10px">Hold &middot; Mute &middot; Transfer &middot; Keypad</button>
    <button id="voip-active-endcall" style="width:100%;padding:12px 0;border-radius:10px;border:none;background:${VOIP_UI.red};color:#fff;font-weight:800;font-size:13px;cursor:pointer">&#128222; End Call</button>`;
  container.innerHTML = voipCardShell('Active Call', badge, inner);
  { const b = document.getElementById('voip-act-controls'); if (b) b.addEventListener('click', voipOpenPopup); }
  const endBtn = document.getElementById('voip-active-endcall');
  if (endBtn) endBtn.addEventListener('click', () => { if (window.hlPhone && window.hlPhone.hangup) window.hlPhone.hangup(); });
  const timerEl = document.getElementById('voip-active-timer');
  if (timerEl && info.startedAt) {
    const tick = () => { timerEl.textContent = voipFmtDuration(Math.floor((Date.now() - info.startedAt) / 1000)).replace('&mdash;', '0:00'); };
    tick();
    voipCallTimerInterval = setInterval(tick, 1000);
  }
}

// Phase 1: live Queue Overview -- per-queue waiting count, longest-wait
// timer, agents available, and an [Answer Next] button that rings the
// requesting agent and bridges them to the front caller. Call Park (Phase
// 2) keeps an honest coming-soon line below until it ships.
function voipFmtWait(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
function voipRenderQueueOverviewCard(container) {
  const queues = (voipData && voipData.queues) || [];
  let inner;
  if (!queues.length) {
    inner = voipEmptyState('&#9737;', 'No active queues. Add one in Settings to route the main line to a hold line.');
  } else {
    inner = queues.map(q => {
      const waiting = q.waiting || 0;
      const overLong = q.longestWaitSeconds >= (q.timeoutSeconds || 30);
      const waitColor = overLong ? VOIP_UI.red : (waiting > 0 ? VOIP_UI.amber : VOIP_UI.gray);
      return `<div style="padding:10px 0;border-bottom:1px solid ${VOIP_UI.line}">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div style="font-size:12.5px;font-weight:800;color:${VOIP_UI.ink};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${voipEscapeHtml(q.name)}</div>
          <span style="font-size:10px;font-weight:800;color:${q.agentsAvailable > 0 ? VOIP_UI.green : VOIP_UI.gray}">${q.agentsAvailable}/${q.agentsTotal} agents</span>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:9px">
          <div style="flex:1;text-align:center;background:${VOIP_UI.grayBg};border-radius:9px;padding:7px 0">
            <div style="font-size:19px;font-weight:900;color:${waiting > 0 ? VOIP_UI.ink : VOIP_UI.gray};line-height:1">${waiting}</div>
            <div style="font-size:9px;font-weight:800;color:${VOIP_UI.gray};letter-spacing:.05em;text-transform:uppercase;margin-top:3px">Waiting</div>
          </div>
          <div style="flex:1;text-align:center;background:${VOIP_UI.grayBg};border-radius:9px;padding:7px 0">
            <div style="font-size:19px;font-weight:900;color:${waitColor};line-height:1;font-family:ui-monospace,monospace">${waiting > 0 ? voipFmtWait(q.longestWaitSeconds) : '&mdash;'}</div>
            <div style="font-size:9px;font-weight:800;color:${VOIP_UI.gray};letter-spacing:.05em;text-transform:uppercase;margin-top:3px">Longest</div>
          </div>
        </div>
        <button class="voip-answer-next" data-queue="${voipEscapeHtml(q.id)}" ${waiting > 0 ? '' : 'disabled'} style="width:100%;padding:9px 0;border-radius:9px;border:none;background:${waiting > 0 ? VOIP_UI.green : VOIP_UI.grayBorder};color:#fff;font-weight:800;font-size:12px;cursor:${waiting > 0 ? 'pointer' : 'not-allowed'}">&#9993; Answer Next</button>
      </div>`;
    }).join('');
    inner += `<div style="display:flex;align-items:center;gap:8px;padding:9px 0 2px;color:${VOIP_UI.gray}">
      <span style="font-size:13px;opacity:.7">&#128273;</span>
      <div style="font-size:10px;line-height:1.4">Call Park arrives in the next phase &mdash; parked calls will show here.</div>
    </div>`;
  }
  const configured = voipData && voipData.queues && voipData.status && voipData.status.configured;
  const badge = configured ? `<span style="width:7px;height:7px;border-radius:50%;background:${VOIP_UI.green};display:inline-block" title="Live"></span>` : '';
  container.innerHTML = voipCardShell('Queue Overview', badge, inner);
  container.querySelectorAll('.voip-answer-next').forEach(b => b.addEventListener('click', () => voipAnswerNext(b.dataset.queue, b)));
}

async function voipAnswerNext(queueId, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Ringing you…'; }
  const res = await voipApi('?resource=queue_answer', 'POST', { queueId });
  if (res.ok) {
    voipNotify('Ringing your phone now — answer to connect to the next caller.');
    voipOpenPopup();
  } else {
    voipNotify(res.data && res.data.error ? res.data.error : 'Could not answer the next caller.');
    if (btn) { btn.disabled = false; btn.innerHTML = '&#9993; Answer Next'; }
  }
}

// ---------------------------------------------------------------------
// Agent status toggle (toolbar). Sets the signed-in agent's own presence;
// the change drives the "agents available" counts across the queue cards.
// The dropdown offers the agent-settable states (on_call/wrapping_up are
// driven by call state, not chosen here).
// ---------------------------------------------------------------------
const VOIP_SETTABLE_STATUSES = ['available', 'on_break', 'dnd', 'offline'];

function voipSyncMyAgentStatus() {
  const btn = document.getElementById('voip-agent-status-btn');
  const wrap = document.getElementById('voip-agent-status-wrap');
  if (!btn || !wrap) return;
  const hasExt = voipData && voipData.myExtensionId;
  if (!hasExt) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  const status = (voipData && voipData.myStatus) || 'offline';
  const meta = VOIP_AGENT_STATUS_META[status] || VOIP_AGENT_STATUS_META.offline;
  const dot = document.getElementById('voip-agent-status-dot');
  const text = document.getElementById('voip-agent-status-text');
  if (dot) dot.style.background = meta.dot;
  if (text) text.textContent = meta.label;
}

function voipToggleAgentStatusMenu(forceClose) {
  const menu = document.getElementById('voip-agent-status-menu');
  if (!menu) return;
  if (forceClose || menu.style.display !== 'none') { menu.style.display = 'none'; return; }
  const current = (voipData && voipData.myStatus) || 'offline';
  menu.innerHTML = VOIP_SETTABLE_STATUSES.map(s => {
    const meta = VOIP_AGENT_STATUS_META[s];
    const active = s === current;
    return `<button class="voip-status-opt" data-status="${s}" style="width:100%;display:flex;align-items:center;gap:9px;text-align:left;padding:8px 10px;border:none;border-radius:8px;background:${active ? VOIP_UI.grayBg : 'none'};cursor:pointer;font-family:inherit">
      <span style="width:9px;height:9px;border-radius:50%;background:${meta.dot};flex-shrink:0"></span>
      <span style="flex:1;font-size:12.5px;font-weight:${active ? 800 : 600};color:${VOIP_UI.ink}">${meta.label}</span>
      ${active ? `<span style="color:${VOIP_UI.green};font-weight:900">&#10003;</span>` : ''}
    </button>`;
  }).join('');
  menu.style.display = 'block';
  menu.querySelectorAll('.voip-status-opt').forEach(b => b.addEventListener('click', () => voipSetMyStatus(b.dataset.status)));
}

async function voipSetMyStatus(status) {
  voipToggleAgentStatusMenu(true);
  const res = await voipApi('?resource=agent_status', 'POST', { status });
  if (!res.ok) { voipNotify(res.data && res.data.error ? res.data.error : 'Could not update status.'); return; }
  if (voipData) {
    voipData.myStatus = status;
    if (voipData.myExtensionId && Array.isArray(voipData.agents)) {
      const rec = voipData.agents.find(a => a.extensionId === voipData.myExtensionId);
      if (rec) rec.status = status; else voipData.agents.push({ extensionId: voipData.myExtensionId, status });
    }
  }
  voipSyncMyAgentStatus();
  const agentsBox = document.getElementById('voip-box-agents');
  if (agentsBox) voipRenderAgentsCard(agentsBox, voipData.extensions);
}

// Wire the toolbar status button once (buttons live in static index.html).
{
  const btn = document.getElementById('voip-agent-status-btn');
  if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); voipToggleAgentStatusMenu(); });
  document.addEventListener('click', (e) => {
    const wrap = document.getElementById('voip-agent-status-wrap');
    if (wrap && !wrap.contains(e.target)) voipToggleAgentStatusMenu(true);
  });
}

// ---------------------------------------------------------------------
// Live updates for the queue / callbacks / agents cards. A short poll
// keeps counts fresh reliably; a Supabase Realtime subscription (best-
// effort -- the poll is the fallback) refreshes instantly on any change
// to voice_calls / voice_agent_status / voice_callbacks.
// ---------------------------------------------------------------------
async function voipRefreshQueueCards() {
  const box = document.getElementById('voip-box-comingsoon');
  if (!box || !document.body.contains(box)) { voipStopLiveUpdates(); return; }
  const [qRes, agRes, cbRes] = await Promise.all([
    voipApi('?resource=queue_status'), voipApi('?resource=agent_status'), voipApi('?resource=callbacks&status=unassigned'),
  ]);
  if (qRes.ok) voipData.queues = qRes.data.queues;
  if (agRes.ok) { voipData.agents = agRes.data.agents; voipData.myExtensionId = agRes.data.mineExtensionId; voipData.myStatus = agRes.data.mineStatus; }
  if (cbRes.ok) voipData.callbacks = cbRes.data.callbacks;
  const qBox = document.getElementById('voip-box-comingsoon');
  const cbBox = document.getElementById('voip-box-callqueues');
  const agBox = document.getElementById('voip-box-agents');
  if (qBox) voipRenderQueueOverviewCard(qBox);
  if (cbBox) voipRenderCallbacksCard(cbBox);
  if (agBox) voipRenderAgentsCard(agBox, voipData.extensions);
  voipSyncMyAgentStatus();
}

function voipStopLiveUpdates() {
  if (window.__voipQueuePoll) { clearInterval(window.__voipQueuePoll); window.__voipQueuePoll = null; }
  if (window.__voipRealtimeChannel) {
    try { (typeof sb !== 'undefined' && sb ? sb : window.__voipSb).removeChannel(window.__voipRealtimeChannel); } catch (e) {}
    window.__voipRealtimeChannel = null;
  }
}

function voipStartLiveUpdates() {
  voipStopLiveUpdates();
  // Poll every 10s (queue counts, longest-wait timer, presence).
  window.__voipQueuePoll = setInterval(voipRefreshQueueCards, 10000);
  // Realtime: refresh immediately on any relevant change. Best-effort --
  // if the client or publication isn't available, the poll still covers it.
  try {
    const client = (typeof sb !== 'undefined' && sb) ? sb : (window.supabase && window.HIVE_CONFIG ? (window.__voipSb || (window.__voipSb = window.supabase.createClient(window.HIVE_CONFIG.url, window.HIVE_CONFIG.anonKey))) : null);
    if (client && client.channel) {
      let debounce = null;
      const ping = () => { clearTimeout(debounce); debounce = setTimeout(voipRefreshQueueCards, 400); };
      const ch = client.channel('voip-live-' + Date.now())
        .on('postgres_changes', { event: '*', schema: 'public', table: 'voice_calls' }, ping)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'voice_agent_status' }, ping)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'voice_callbacks' }, ping)
        .subscribe();
      window.__voipRealtimeChannel = ch;
    }
  } catch (e) { /* poll-only is fine */ }
}

// ---------------------------------------------------------------------
// Right column: Call Queues / Available Agents / Quick Shortcuts. Call
// Queues has no backend concept yet, so it lists the real registered
// phone numbers (Settings > Numbers) instead -- real rows, honestly
// labeled "not tracked" for the wait-time column the mockup shows.
// Available Agents shows real extensions; a green "On call" dot only
// appears when a real in-progress call (from the calls list already
// fetched) is matched to that extension -- everything else is neutral,
// not a fabricated "Available".
// ---------------------------------------------------------------------
// Phase 1: Callbacks -- callers who overflowed a queue and left a call-back
// request. AI structures name/number/reason from the transcript; an agent
// claims one ([Call back]) or clears it ([Dismiss]).
function voipCallbackName(cb) {
  if (cb.caller_name) return cb.caller_name;
  if (cb.ai_summary && cb.ai_summary.caller_name) return cb.ai_summary.caller_name;
  return cb.from_number || 'Unknown caller';
}
function voipCallbackNumber(cb) {
  return (cb.ai_summary && cb.ai_summary.callback_number) || cb.from_number || null;
}
function voipCallbackBlurb(cb) {
  if (cb.reason) return cb.reason;
  if (cb.ai_summary && cb.ai_summary.summary) return cb.ai_summary.summary;
  if (cb.transcript) return cb.transcript.slice(0, 90);
  if (cb.transcript_status === 'pending') return 'Transcribing…';
  return 'Call-back requested';
}
function voipRenderCallbacksCard(container) {
  const callbacks = (voipData && voipData.callbacks) || [];
  if (!callbacks.length) {
    container.innerHTML = voipCardShell('Callbacks', '', voipEmptyState('&#9742;', 'No pending callbacks. Overflowed callers who ask for a call back land here.'));
    return;
  }
  const rows = callbacks.map(cb => {
    const num = voipCallbackNumber(cb);
    return `<div style="padding:9px 0;border-bottom:1px solid ${VOIP_UI.line}">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
        <span style="width:8px;height:8px;border-radius:50%;background:${VOIP_UI.amber};flex-shrink:0"></span>
        <div style="flex:1;min-width:0;font-size:12.5px;font-weight:800;color:${VOIP_UI.ink};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${voipEscapeHtml(voipCallbackName(cb))}</div>
        <span style="font-size:9.5px;color:${VOIP_UI.gray};font-weight:700">${voipEscapeHtml(voipFmtWhen(cb.created_at))}</span>
      </div>
      <div style="font-size:10.5px;color:${VOIP_UI.sub};line-height:1.5;margin:0 0 7px 16px">${voipEscapeHtml(voipCallbackBlurb(cb))}</div>
      <div style="display:flex;gap:6px;margin-left:16px">
        <button class="voip-cb-call" data-num="${voipEscapeHtml(num || '')}" data-id="${voipEscapeHtml(cb.id)}" ${num ? '' : 'disabled'} style="flex:1;padding:6px 0;border-radius:8px;border:none;background:${num ? VOIP_UI.green : VOIP_UI.grayBorder};color:#fff;font-weight:800;font-size:11px;cursor:${num ? 'pointer' : 'not-allowed'}">&#9993; Call back</button>
        <button class="voip-cb-dismiss" data-id="${voipEscapeHtml(cb.id)}" style="padding:6px 12px;border-radius:8px;border:1px solid ${VOIP_UI.line};background:#fff;color:${VOIP_UI.sub};font-weight:800;font-size:11px;cursor:pointer">Dismiss</button>
      </div>
    </div>`;
  }).join('');
  const badge = `<span style="font-size:10.5px;color:${VOIP_UI.amber};font-weight:800">${callbacks.length} waiting</span>`;
  container.innerHTML = voipCardShell('Callbacks', badge, rows);
  container.querySelectorAll('.voip-cb-call').forEach(b => b.addEventListener('click', async () => {
    await voipApi('?resource=callback_update', 'POST', { id: b.dataset.id, claim: true });
    if (b.dataset.num) voipDial(b.dataset.num);
    voipRefreshQueueCards();
  }));
  container.querySelectorAll('.voip-cb-dismiss').forEach(b => b.addEventListener('click', async () => {
    await voipApi('?resource=callback_update', 'POST', { id: b.dataset.id, status: 'dismissed' });
    voipRefreshQueueCards();
  }));
}

function voipExtensionIsBusy(extensionId) {
  const liveStatuses = ['ringing', 'answered', 'held', 'transferring', 'conferenced'];
  return voipData.calls.some(c => c.extension_id === extensionId && liveStatuses.includes(c.status) && !c.ended_at);
}

// Presence metadata for each agent status. 'on_call' is inferred from a
// live call even if the agent hasn't set it, so the dot is always honest.
const VOIP_AGENT_STATUS_META = {
  available: { label: 'Available', color: '#1B7A50', dot: '#1B7A50' },
  on_call: { label: 'On call', color: '#b8791f', dot: '#b8791f' },
  wrapping_up: { label: 'Wrapping up', color: '#3b6fd6', dot: '#3b6fd6' },
  on_break: { label: 'On break', color: '#8b92a8', dot: '#c9862e' },
  dnd: { label: 'Do not disturb', color: '#c65b4e', dot: '#c65b4e' },
  offline: { label: 'Offline', color: '#8b92a8', dot: '#dadde8' },
};
function voipAgentStatusFor(extensionId) {
  const rec = ((voipData && voipData.agents) || []).find(a => a.extensionId === extensionId);
  return rec ? rec.status : 'offline';
}
function voipRenderAgentsCard(container, extensions) {
  if (!extensions.length) {
    container.innerHTML = voipCardShell('Available Agents', '', voipEmptyState('&#128101;', 'No extensions set up yet.'));
    return;
  }
  const effStatus = (e) => voipExtensionIsBusy(e.id) ? 'on_call' : voipAgentStatusFor(e.id);
  const availCount = extensions.filter(e => effStatus(e) === 'available').length;
  const badge = `<span style="font-size:10.5px;color:${VOIP_UI.green};font-weight:800">${availCount} available</span>`;
  const rows = extensions.map(e => {
    const meta = VOIP_AGENT_STATUS_META[effStatus(e)] || VOIP_AGENT_STATUS_META.offline;
    return `<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid ${VOIP_UI.line}">
      <div style="width:32px;height:32px;border-radius:50%;background:${VOIP_UI.grayBg};color:${VOIP_UI.sub};display:flex;align-items:center;justify-content:center;font-weight:800;font-size:11px;flex-shrink:0;position:relative">${voipInitials(e.name)}<span style="position:absolute;bottom:-1px;right:-1px;width:9px;height:9px;border-radius:50%;background:${meta.dot};border:2px solid #fff"></span></div>
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;font-weight:700;color:${VOIP_UI.ink};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${voipEscapeHtml(e.name)}</div>
        <div style="font-size:10.5px;color:${VOIP_UI.gray}">ext. ${voipEscapeHtml(e.extensionNumber)}</div>
      </div>
      <span style="font-size:9.5px;font-weight:800;color:${meta.color};white-space:nowrap">${meta.label}</span>
      <button class="voip-agent-call" data-to="${voipEscapeHtml(e.extensionNumber)}" style="border:none;background:${VOIP_UI.greenBg};color:${VOIP_UI.green};width:26px;height:26px;border-radius:50%;cursor:pointer;flex-shrink:0">&#128222;</button>
    </div>`;
  }).join('');
  container.innerHTML = voipCardShell('Available Agents', badge, rows);
  container.querySelectorAll('.voip-agent-call').forEach(b => b.addEventListener('click', () => voipDial(b.dataset.to)));
}
// ---------------------------------------------------------------------
// Quick Shortcuts -- was a 2x2 icon grid + 2 rows, 5 of the 6 buttons
// were dead "Coming soon" stubs (Intercom/Broadcast/Call Flip/DND/
// Recording). Trimmed to the one real action (Voicemail -> jumps to the
// tab) plus a static disclosure line for what is planned but not built --
// clickable dead ends read as broken, a plain sentence does not.
// ---------------------------------------------------------------------
function voipOpenSettings() {
  const root = document.getElementById('voip-list');
  if (!root) return;
  root.innerHTML = `<div style="color:${VOIP_UI.gray};font-size:13px;padding:20px 0">Loading&hellip;</div>`;
  voipRenderSettings(root);
}

function voipRenderQuickShortcutsCard(container) {
  const inner = `
    <button id="voip-shortcut-voicemail" style="width:100%;display:flex;align-items:center;gap:10px;text-align:left;padding:9px 4px;border:none;border-bottom:1px solid ${VOIP_UI.line};background:none;cursor:pointer;margin-bottom:8px">
      <span style="font-size:16px">&#128233;</span>
      <span style="flex:1">
        <div style="font-size:12px;font-weight:800;color:${VOIP_UI.ink}">Voicemail</div>
        <div style="font-size:10px;color:${VOIP_UI.gray}">Open tab</div>
      </span>
    </button>
    <div style="font-size:10.5px;color:${VOIP_UI.gray};line-height:1.6">Intercom, Broadcast, Call Flip, DND Mode, and Call Recording are planned &mdash; not built yet.</div>`;
  container.innerHTML = voipCardShell('Quick Shortcuts', '', inner);
  const vmBtn = document.getElementById('voip-shortcut-voicemail');
  if (vmBtn) vmBtn.addEventListener('click', () => { voipCenterTab = 'voicemail'; voipRenderCenterTab(); });
}

// ---------------------------------------------------------------------
// Dialer -- large number field, large keypad, and a big green Call
// button. The old 4-button quick-action row (Voicemail/Record/Add
// Caller/Transfer) was removed -- Voicemail duplicated the tab right
// above it, and Record/Add Caller were dead "Coming soon" stubs. Places
// calls through the shared popup Device (see voipDial above) so the
// live call surface is always the popup.
// ---------------------------------------------------------------------
const VOIP_KEYS = [['1',''],['2','ABC'],['3','DEF'],['4','GHI'],['5','JKL'],['6','MNO'],['7','PQRS'],['8','TUV'],['9','WXYZ'],['*',''],['0',''],['#','']];

function voipDialerHtml() {
  return `
    <div style="max-width:360px;margin:0 auto;position:relative">
      <div style="position:relative;margin-bottom:18px">
        <input id="voip-dial-input" type="text" autocomplete="off" placeholder="Enter number or extension" style="width:100%;box-sizing:border-box;font-size:15px;padding:14px 40px 14px 16px;border:1px solid ${VOIP_UI.grayBorder};border-radius:12px;font-family:ui-monospace,monospace;background:${VOIP_UI.grayBg};color:${VOIP_UI.ink}" />
        <button id="voip-dial-clear" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);border:none;background:${VOIP_UI.grayBg};color:${VOIP_UI.gray};width:22px;height:22px;border-radius:50%;cursor:pointer;font-size:11px">&#10005;</button>
        <div id="voip-dial-suggest" style="position:absolute;left:calc(100% + 10px);right:auto;top:0;width:290px;background:#fff;border:1px solid ${VOIP_UI.line};border-radius:10px;box-shadow:${VOIP_UI.cardShadow};z-index:5;display:none;text-align:left;max-height:200px;overflow:auto"></div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:18px">
        ${VOIP_KEYS.map(([k, letters]) => `<button class="voip-key" data-key="${k}" style="padding:16px 0;border:1px solid ${VOIP_UI.line};border-radius:12px;background:#fbfbfd;cursor:pointer">
          <div style="font-size:19px;font-weight:800;color:${VOIP_UI.ink}">${k}</div>
          ${letters ? `<div style="font-size:8.5px;color:${VOIP_UI.gray};font-weight:700;letter-spacing:.08em;margin-top:2px">${letters}</div>` : ''}
        </button>`).join('')}
      </div>
      <button id="voip-call-btn" style="width:100%;padding:15px 0;border-radius:12px;background:${VOIP_UI.green};color:#fff;border:none;font-weight:800;font-size:14px;cursor:pointer;margin-bottom:14px">&#128222; Call</button>
      <div style="margin-top:12px;font-size:11px;color:${VOIP_UI.gray};line-height:1.5;text-align:center">Calls place through the phone popup (top bar) &mdash; the live call stays with you as you navigate around HiveLogic.</div>
    </div>`;
}

function wireVoipDialer(root, extensions) {
  const input = document.getElementById('voip-dial-input');
  const suggest = document.getElementById('voip-dial-suggest');
  root.querySelectorAll('.voip-key').forEach(b => b.addEventListener('click', () => { input.value += b.dataset.key; input.dispatchEvent(new Event('input')); input.focus(); }));
  document.getElementById('voip-call-btn').addEventListener('click', () => { voipDial(input.value.trim()); hideSuggest(); });
  const clearBtn = document.getElementById('voip-dial-clear');
  if (clearBtn) clearBtn.addEventListener('click', () => { input.value = ''; input.focus(); hideSuggest(); });
  function hideSuggest() { suggest.style.display = 'none'; suggest.innerHTML = ''; }
  function renderSuggest(items) {
    if (!items.length) { hideSuggest(); return; }
    suggest.innerHTML = items.map(it => `<div class="voip-suggest-row" data-to="${voipEscapeHtml(it.to)}" style="padding:10px 14px;font-size:12.5px;cursor:pointer;border-bottom:1px solid ${VOIP_UI.line};display:flex;justify-content:space-between"><span>${voipEscapeHtml(it.name)}</span><span style="color:${VOIP_UI.gray}">${voipEscapeHtml(it.to)}</span></div>`).join('');
    suggest.style.display = 'block';
    suggest.querySelectorAll('.voip-suggest-row').forEach(el => el.addEventListener('click', () => {
      input.value = el.dataset.to;
      hideSuggest();
      input.focus();
    }));
  }
  let searchTimer = null;
  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearTimeout(searchTimer);
    if (!q) { hideSuggest(); return; }
    searchTimer = setTimeout(async () => {
      const r = await voipApi(`?resource=directory&q=${encodeURIComponent(q)}`);
      if (!r.ok) return hideSuggest();
      const items = [
        ...r.data.extensions.map(e => ({ name: e.name, to: e.extensionNumber })),
        ...r.data.clients.map(c => ({ name: c.name, to: c.phone })),
      ].slice(0, 8);
      renderSuggest(items);
    }, 200);
  });
  document.addEventListener('click', (e) => {
    if (suggest && !suggest.contains(e.target) && e.target !== input) hideSuggest();
  });
}
// ---------------------------------------------------------------------
// Directory tab -- team + client search, click to call.
// ---------------------------------------------------------------------
function voipRenderDirectoryTab(container) {
  container.innerHTML = `
    <input id="voip-dir-search" placeholder="Search team or clients&hellip;" style="width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid ${VOIP_UI.grayBorder};border-radius:10px;margin-bottom:14px;font-size:13px;background:${VOIP_UI.grayBg};color:${VOIP_UI.ink}" />
    <div id="voip-dir-list"></div>`;
  const list = document.getElementById('voip-dir-list');
  const rowStyle = `display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border:1px solid ${VOIP_UI.line};cursor:pointer;background:#fff;border-radius:10px;margin-bottom:8px;font-size:12.5px`;
  let loadedClients = [];
  let nextOffset = 0;
  let hasMore = false;
  let total = null;
  let currentQuery = '';
  let lastExtensions = [];
  function rowHtml(c) { return `<div class="voip-dir-row" data-to="${voipEscapeHtml(c.phone)}" style="${rowStyle}"><span style="font-weight:700;color:${VOIP_UI.ink}">${voipEscapeHtml(c.name)}</span><span style="color:${VOIP_UI.gray}">${voipEscapeHtml(c.phone)}</span></div>`; }
  function render() {
    const extensions = lastExtensions;
    const moreBtn = (!currentQuery && hasMore) ? `<button id="voip-dir-more" style="width:100%;margin-top:8px;padding:10px;border:1px dashed ${VOIP_UI.line};border-radius:10px;background:none;color:${VOIP_UI.gray};font-weight:700;font-size:11.5px;cursor:pointer">Load more${total ? ` (${loadedClients.length} of ${total})` : ''}</button>` : '';
    list.innerHTML = `
      <div style="font-size:10.5px;font-weight:800;color:${VOIP_UI.gray};letter-spacing:.06em;text-transform:uppercase;margin:6px 0 8px">Team</div>
      ${extensions.map(e => `<div class="voip-dir-row" data-to="${voipEscapeHtml(e.extensionNumber)}" style="${rowStyle}"><span style="font-weight:700;color:${VOIP_UI.ink}">${voipEscapeHtml(e.name)}</span><span style="color:${VOIP_UI.gray}">ext. ${voipEscapeHtml(e.extensionNumber)}</span></div>`).join('') || `<div style="color:${VOIP_UI.gray};font-size:12.5px">No extensions set up yet.</div>`}
      ${loadedClients.length ? `<div style="font-size:10.5px;font-weight:800;color:${VOIP_UI.gray};letter-spacing:.06em;text-transform:uppercase;margin:16px 0 8px">Clients${total ? ` (${loadedClients.length} of ${total})` : ''}</div>${loadedClients.map(rowHtml).join('')}` : ''}
      ${!extensions.length && !loadedClients.length && currentQuery ? `<div style="color:${VOIP_UI.gray};font-size:12.5px">No matches.</div>` : ''}
      ${moreBtn}`;
    list.querySelectorAll('.voip-dir-row').forEach(el => el.addEventListener('click', () => voipDial(el.dataset.to)));
    const mb = document.getElementById('voip-dir-more');
    if (mb) mb.addEventListener('click', loadMore);
  }
  async function load(q) {
    currentQuery = q;
    loadedClients = [];
    nextOffset = 0;
    hasMore = false;
    total = null;
    const r = await voipApi(`?resource=directory${q ? '&q=' + encodeURIComponent(q) : ''}`);
    if (!r.ok) { list.innerHTML = `<div style="color:${VOIP_UI.gray};font-size:13px">Could not load directory.</div>`; return; }
    const { extensions, clients, clientsHasMore, clientsTotal, clientsNextOffset } = r.data;
    lastExtensions = extensions;
    loadedClients = clients;
    hasMore = !!clientsHasMore;
    total = clientsTotal;
    nextOffset = clientsNextOffset != null ? clientsNextOffset : clients.length;
    render();
  }
  async function loadMore() {
    const r = await voipApi(`?resource=directory&offset=${nextOffset}`);
    if (!r.ok) return;
    const { clients, clientsHasMore, clientsTotal, clientsNextOffset } = r.data;
    loadedClients = loadedClients.concat(clients);
    hasMore = !!clientsHasMore;
    total = clientsTotal;
    nextOffset = clientsNextOffset != null ? clientsNextOffset : nextOffset + clients.length;
    render();
  }
  const input = document.getElementById('voip-dir-search');
  if (input) input.addEventListener('input', (e) => load(e.target.value.trim()));
  load('');
}

// ---------------------------------------------------------------------
// Center column tabs: Dial Pad / Directory / Call History / Voicemail.
// ---------------------------------------------------------------------
function voipCenterTabBarHtml() {
  const tabs = [['dial', 'Dial Pad'], ['directory', 'Directory'], ['history', 'Call History'], ['voicemail', 'Voicemail']];
  return `<div style="display:flex;gap:4px;border-bottom:1px solid ${VOIP_UI.line};margin-bottom:20px;flex-wrap:wrap">
    ${tabs.map(([k, label]) => `<button class="voip-ctab" data-t="${k}" style="padding:12px 16px;border:none;background:none;font-family:inherit;font-weight:800;font-size:12.5px;cursor:pointer;border-bottom:3px solid ${voipCenterTab === k ? VOIP_UI.green : 'transparent'};color:${voipCenterTab === k ? VOIP_UI.green : VOIP_UI.gray}">${label}</button>`).join('')}
  </div>`;
}

async function voipRenderCenterTab() {
  const body = document.getElementById('voip-center-body');
  const tabbar = document.getElementById('voip-center-tabbar');
  if (!body || !tabbar) return;
  tabbar.innerHTML = voipCenterTabBarHtml();
  tabbar.querySelectorAll('.voip-ctab').forEach(b => b.addEventListener('click', () => { voipCenterTab = b.dataset.t; voipRenderCenterTab(); }));
  if (voipCenterTab === 'dial') {
    body.innerHTML = voipDialerHtml() + `
      <div style="margin-top:28px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <h4 style="margin:0;font-size:11.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:${VOIP_UI.ink}">Recent Calls</h4>
          <button id="voip-view-all-calls" style="border:none;background:none;color:${VOIP_UI.green};font-weight:800;font-size:11.5px;cursor:pointer">View All &rarr;</button>
        </div>
        ${voipRenderCallsTable(voipData.calls.slice(0, 5))}
      </div>`;
    wireVoipDialer(body, voipData.extensions);
    body.querySelectorAll('.voip-call-row').forEach(el => el.addEventListener('click', (e) => { if (e.target.closest('button')) return; voipDial(el.dataset.to); }));
    const viewAll = document.getElementById('voip-view-all-calls');
    if (viewAll) viewAll.addEventListener('click', () => { voipCenterTab = 'history'; voipRenderCenterTab(); });
  } else if (voipCenterTab === 'directory') {
    voipRenderDirectoryTab(body);
  } else if (voipCenterTab === 'history') {
    body.innerHTML = `<div style="color:${VOIP_UI.gray};font-size:13px;padding:16px 0">Loading&hellip;</div>`;
    const histRes = await voipApi('?resource=calls&limit=300');
    const histCalls = histRes.ok ? histRes.data.calls : voipData.calls;
    body.innerHTML = `<div style="max-height:calc(100vh - 340px);min-height:320px;overflow-y:auto">${voipRenderCallsTable(histCalls)}</div>`;
    body.querySelectorAll('.voip-call-row').forEach(el => el.addEventListener('click', (e) => { if (e.target.closest('button')) return; voipDial(el.dataset.to); }));
  } else if (voipCenterTab === 'voicemail') {
    voipRenderVoicemailPanel(body);
  }
}
// ---------------------------------------------------------------------
// Greeting recorder modal -- start/stop, preview, redo, then Save hands
// the blob to whichever caller opened it (mic-record button in Settings).
// Chris asked for this after the inline record/stop link was hard to use
// with no way to hear a take before it uploaded.
// ---------------------------------------------------------------------
function voipCloseGreetRecorderModal() {
  const el = document.getElementById('voip-greet-modal-backdrop');
  if (!el) return;
  if (el._voipStream) el._voipStream.getTracks().forEach(t => t.stop());
  if (el._voipTimer) clearInterval(el._voipTimer);
  el.remove();
}

// Twilio Play only supports MP3/WAV. Browser MediaRecorder always
// records webm/opus, which Twilio cannot decode -- this is what caused
// inbound callers to hear static instead of the greeting (2026-07-25).
// Decode whatever the browser gave us via Web Audio and re-encode as
// plain 16-bit PCM WAV, which Twilio always plays cleanly. Runs client
// side, no server dependency, used for both the record modal and the
// plain file picker.
async function voipBlobToWav(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const AudioCtxCls = window.AudioContext || window.webkitAudioContext;
  const audioCtx = new AudioCtxCls();
  let audioBuffer;
  try {
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  } finally {
    audioCtx.close();
  }
  const length = audioBuffer.length;
  const sampleRate = audioBuffer.sampleRate;
  let samples;
  if (audioBuffer.numberOfChannels > 1) {
    const ch0 = audioBuffer.getChannelData(0);
    const ch1 = audioBuffer.getChannelData(1);
    samples = new Float32Array(length);
    for (let i = 0; i < length; i++) samples[i] = (ch0[i] + ch1[i]) / 2;
  } else {
    samples = audioBuffer.getChannelData(0);
  }
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  function writeStr(offset, str) { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); }
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

function voipOpenGreetRecorderModal(kind, kindLabel, onSave) {
  voipCloseGreetRecorderModal();
  const wrap = document.createElement('div');
  wrap.id = 'voip-greet-modal-backdrop';
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(15,20,30,.55);z-index:9998;display:flex;align-items:center;justify-content:center';
  wrap.innerHTML = `
    <div style="background:#fff;border-radius:16px;padding:24px;width:340px;max-width:92vw;box-shadow:0 20px 60px rgba(0,0,0,.35)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px">
        <h3 style="margin:0;font-size:15px;color:${VOIP_UI.ink}">Record greeting</h3>
        <button id="voip-greet-modal-close" style="border:none;background:none;font-size:20px;cursor:pointer;color:${VOIP_UI.gray};line-height:1;padding:4px">&times;</button>
      </div>
      <div style="font-size:12px;color:${VOIP_UI.gray};margin-bottom:20px">${voipEscapeHtml(kindLabel)}</div>
      <div style="display:flex;flex-direction:column;align-items:center;gap:14px">
        <button id="voip-greet-modal-record" style="width:76px;height:76px;border-radius:50%;border:none;background:${VOIP_UI.red};color:#fff;font-size:24px;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 18px rgba(198,91,78,.35)">&#9679;</button>
        <div id="voip-greet-modal-status" style="font-size:13px;font-weight:700;color:${VOIP_UI.ink}">Tap to record</div>
        <div id="voip-greet-modal-timer" style="font-size:22px;font-weight:800;color:${VOIP_UI.ink};font-family:ui-monospace,monospace;display:none">0:00</div>
        <audio id="voip-greet-modal-preview" controls style="width:100%;display:none"></audio>
        <div id="voip-greet-modal-actions" style="display:none;gap:10px;width:100%">
          <button id="voip-greet-modal-redo" style="flex:1;padding:9px;border:1px solid ${VOIP_UI.line};background:#fff;color:${VOIP_UI.sub};border-radius:8px;font-weight:700;font-size:12.5px;cursor:pointer">Redo</button>
          <button id="voip-greet-modal-save" style="flex:1;padding:9px;border:none;background:${VOIP_UI.green};color:#fff;border-radius:8px;font-weight:700;font-size:12.5px;cursor:pointer">Save greeting</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  const recordBtn = wrap.querySelector('#voip-greet-modal-record');
  const statusEl = wrap.querySelector('#voip-greet-modal-status');
  const timerEl = wrap.querySelector('#voip-greet-modal-timer');
  const previewEl = wrap.querySelector('#voip-greet-modal-preview');
  const actionsEl = wrap.querySelector('#voip-greet-modal-actions');
  const redoBtn = wrap.querySelector('#voip-greet-modal-redo');
  const saveBtn = wrap.querySelector('#voip-greet-modal-save');
  const closeBtn = wrap.querySelector('#voip-greet-modal-close');

  let recorder = null, chunks = [], blob = null, seconds = 0;
  const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  function toIdle() {
    if (previewEl.src) URL.revokeObjectURL(previewEl.src);
    blob = null; chunks = []; seconds = 0;
    recordBtn.style.display = 'flex';
    recordBtn.innerHTML = '&#9679;';
    recordBtn.style.background = VOIP_UI.red;
    statusEl.textContent = 'Tap to record';
    timerEl.style.display = 'none';
    timerEl.textContent = '0:00';
    previewEl.style.display = 'none';
    previewEl.removeAttribute('src');
    actionsEl.style.display = 'none';
  }

  async function startRecording() {
    if (!navigator.mediaDevices || !window.MediaRecorder) { voipNotify('This browser cannot record audio.'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      wrap._voipStream = stream;
      chunks = [];
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      recorder.onstop = () => {
        blob = new Blob(chunks, { type: 'audio/webm' });
        previewEl.src = URL.createObjectURL(blob);
        previewEl.style.display = 'block';
        actionsEl.style.display = 'flex';
        recordBtn.style.display = 'none';
        statusEl.textContent = 'Preview your recording';
        timerEl.style.display = 'none';
        clearInterval(wrap._voipTimer);
        stream.getTracks().forEach(t => t.stop());
      };
      recorder.start();
      seconds = 0;
      timerEl.style.display = 'block';
      timerEl.textContent = fmt(0);
      wrap._voipTimer = setInterval(() => {
        seconds++;
        timerEl.textContent = fmt(seconds);
        if (seconds >= 120) stopRecording();
      }, 1000);
      recordBtn.innerHTML = '&#9632;';
      recordBtn.style.background = VOIP_UI.ink;
      statusEl.textContent = 'Recording... tap to stop';
    } catch (e) {
      voipNotify('Could not access the microphone: ' + (e && e.message || e));
    }
  }

  function stopRecording() {
    if (recorder && recorder.state === 'recording') recorder.stop();
  }

  recordBtn.addEventListener('click', () => {
    if (recorder && recorder.state === 'recording') stopRecording();
    else startRecording();
  });
  redoBtn.addEventListener('click', () => toIdle());
  saveBtn.addEventListener('click', async () => {
    if (!blob) return;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    await onSave(blob);
    voipCloseGreetRecorderModal();
  });
  closeBtn.addEventListener('click', () => voipCloseGreetRecorderModal());
  wrap.addEventListener('click', (e) => { if (e.target === wrap) voipCloseGreetRecorderModal(); });

  toIdle();
}

// ---------------------------------------------------------------------
// Settings -- Extensions / Numbers / Greetings / Blocklist admin. Opened
// from the gear icon in the toolbar (or "Manage Numbers"), replacing the
// dashboard until "Back" is clicked. Same /api/voice resources the
// Phase-1 UI used; carried over as-is, just visually unchanged from the
// prior pass since it is not part of the locked dashboard mockup.
// ---------------------------------------------------------------------
async function voipRenderSettings(body, editingExtId) {
  body.innerHTML = `<div style="color:${VOIP_UI.gray};font-size:13px;padding:16px 0">Loading&hellip;</div>`;
  const [extR, numR, greetR, blockR, setR] = await Promise.all([
    voipApi('?resource=extensions'), voipApi('?resource=numbers'), voipApi('?resource=greetings'), voipApi('?resource=blocklist'), voipApi('?resource=voice_settings'),
  ]);
  const extensions = extR.ok ? extR.data.extensions : [];
  const numbers = numR.ok ? numR.data.numbers : [];
  const greetings = greetR.ok ? greetR.data.items : [];
  const blocklist = blockR.ok ? blockR.data.items : [];
  const vset = (setR.ok && setR.data.settings) ? setR.data.settings : { record_calls: false, ai_call_summaries: false };
  const GREETING_KINDS = [
    { value: 'main_open', label: 'Main (open)' },
    { value: 'main_closed', label: 'Main (closed)' },
    { value: 'voicemail', label: 'Voicemail' },
    { value: 'hold', label: 'Hold' },
  ];
  const greetingByKind = {};
  greetings.forEach(g => { greetingByKind[g.kind] = g; });
  const voicePinConfigured = Boolean(voipData.status && voipData.status.greetingPinConfigured);

  body.innerHTML = `
    <button id="voip-settings-back" style="display:inline-flex;align-items:center;gap:7px;border:1px solid ${VOIP_UI.line};background:#fff;color:${VOIP_UI.ink};font-weight:700;font-size:12.5px;cursor:pointer;padding:9px 16px;border-radius:10px;margin-bottom:16px;box-shadow:${VOIP_UI.cardShadow}"><span style="font-size:14px;color:${VOIP_UI.green}">&#8592;</span> Back to dashboard</button>
    <div style="display:grid;gap:16px;max-width:640px">
      <section style="background:#fff;border:1px solid ${VOIP_UI.line};border-radius:12px;padding:16px">
        <h4 style="margin:0 0 10px;font-size:13px">Call Flow</h4>
        <div style="font-size:12.5px;color:${VOIP_UI.sub};margin-bottom:10px;line-height:1.5">Drag-and-drop editor for how inbound calls are routed. Changes go live immediately.</div>
        <button class="voip-callflow-open-btn" style="padding:9px 14px;border-radius:9px;border:1px solid ${VOIP_UI.greenBorder};background:${VOIP_UI.greenBg};color:${VOIP_UI.green};font-weight:600;font-size:13px;cursor:pointer">Open Call Flow Editor</button>
      </section>
      <section style="background:#fff;border:1px solid ${VOIP_UI.line};border-radius:12px;padding:16px">
        <h4 style="margin:0 0 4px;font-size:13px">Call Recording &amp; AI</h4>
        <div style="font-size:11.5px;color:${VOIP_UI.sub};margin-bottom:12px;line-height:1.5">Callers are already told calls may be recorded. Recordings play back in Call History.</div>
        <label style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid ${VOIP_UI.line};cursor:pointer">
          <span><span style="font-size:12.5px;font-weight:700;color:${VOIP_UI.ink}">Record calls</span><br><span style="font-size:11px;color:${VOIP_UI.gray}">Dual-channel recording on every connected call.</span></span>
          <input type="checkbox" id="voip-set-record" ${vset.record_calls ? 'checked' : ''} style="width:18px;height:18px;flex-shrink:0;cursor:pointer;accent-color:${VOIP_UI.green}" />
        </label>
        <label style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;cursor:pointer">
          <span><span style="font-size:12.5px;font-weight:700;color:${VOIP_UI.ink}">AI call summaries</span><br><span style="font-size:11px;color:${VOIP_UI.gray}">Summarize transcripts &amp; draft follow-ups (needs a transcript source).</span></span>
          <input type="checkbox" id="voip-set-aisum" ${vset.ai_call_summaries ? 'checked' : ''} style="width:18px;height:18px;flex-shrink:0;cursor:pointer;accent-color:${VOIP_UI.green}" />
        </label>
        <div id="voip-set-status" style="font-size:11px;color:${VOIP_UI.green};font-weight:700;margin-top:8px;min-height:14px"></div>
      </section>
            <section style="background:#fff;border:1px solid ${VOIP_UI.line};border-radius:12px;padding:16px">
        <h4 style="margin:0 0 10px;font-size:13px">Extensions</h4>
        ${extensions.map(e => (e.id === editingExtId ? `
          <form id="voip-edit-ext-form" style="background:${VOIP_UI.grayBg};border-radius:8px;padding:10px;margin-bottom:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <input type="hidden" name="id" value="${e.id}" />
            <input name="extension_number" value="${voipEscapeHtml(e.extension_number)}" placeholder="Ext #" style="width:70px;padding:8px;border:1px solid #e3e5ec;border-radius:6px" required />
            <input name="display_name" value="${voipEscapeHtml(e.display_name)}" placeholder="Name" style="flex:1;min-width:120px;padding:8px;border:1px solid #e3e5ec;border-radius:6px" required />
            <label style="font-size:11.5px;display:flex;align-items:center;gap:4px;color:#484f64"><input type="checkbox" name="is_operator" ${e.is_operator ? 'checked' : ''} /> Operator (0)</label>
            <input name="forwarding_number" value="${voipEscapeHtml(e.forwarding_number || '')}" placeholder="Forward calls to (optional)" style="width:150px;padding:8px;border:1px solid #e3e5ec;border-radius:6px" />
            <label style="font-size:11.5px;display:flex;align-items:center;gap:4px;color:#484f64"><input type="checkbox" name="call_waiting_enabled" ${e.call_waiting_enabled !== false ? 'checked' : ''} /> Call waiting</label>
            <input name="voicemail_pin" value="${voipEscapeHtml(e.voicemail_pin || '')}" placeholder="Voicemail PIN (optional)" style="width:110px;padding:8px;border:1px solid #e3e5ec;border-radius:6px" />
            <button type="submit" style="padding:8px 14px;background:${VOIP_UI.green};color:#fff;border:none;border-radius:6px;font-weight:700;cursor:pointer;font-size:12px">Save</button>
            <button type="button" class="voip-edit-ext-cancel" style="padding:8px 14px;background:#fff;border:1px solid ${VOIP_UI.grayBorder};border-radius:6px;font-weight:700;cursor:pointer;font-size:12px">Cancel</button>
            <div style="width:100%;font-size:11px;color:${VOIP_UI.sub}">Forwarding, call waiting, and the voicemail PIN are live. Forwarding rings your cell alongside your desk line, call waiting shows an Answer/Decline banner, and the PIN unlocks phone-based voicemail check-in by pressing 98 from the main greeting.</div>
          </form>
        ` : `
          <div style="display:flex;gap:10px;align-items:center;padding:7px 0;border-bottom:1px solid #f0f1f5;font-size:12.5px">
            <b>${voipEscapeHtml(e.extension_number)}</b><span>${voipEscapeHtml(e.display_name)}</span>${e.is_operator ? `<span style="font-size:9.5px;background:#f0f1f6;padding:2px 6px;border-radius:99px;color:#8892a6">OPERATOR</span>` : ''}${e.forwarding_number ? `<span style="font-size:9.5px;color:${VOIP_UI.sub}">&rarr; ${voipEscapeHtml(e.forwarding_number)}</span>` : ''}
            <button class="voip-edit-ext-btn" data-id="${e.id}" style="margin-left:auto;border:none;background:none;color:${VOIP_UI.blue};cursor:pointer;font-weight:700;font-size:11.5px">Edit</button>
          </div>
        `)).join('') || `<div style="color:#8892a6;font-size:12.5px">None yet.</div>`}
        <form id="voip-new-ext" style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;align-items:center">
          <input name="extension_number" placeholder="Ext #" style="width:70px;padding:8px;border:1px solid #e3e5ec;border-radius:6px" required />
          <input name="display_name" placeholder="Name" style="flex:1;min-width:120px;padding:8px;border:1px solid #e3e5ec;border-radius:6px" required />
          <label style="font-size:11.5px;display:flex;align-items:center;gap:4px;color:#484f64"><input type="checkbox" name="is_operator" /> Operator (0)</label>
          <input name="forwarding_number" placeholder="Forward calls to (optional)" style="width:150px;padding:8px;border:1px solid #e3e5ec;border-radius:6px" />
          <label style="font-size:11.5px;display:flex;align-items:center;gap:4px;color:#484f64"><input type="checkbox" name="call_waiting_enabled" checked /> Call waiting</label>
          <input name="voicemail_pin" placeholder="Voicemail PIN (optional)" style="width:110px;padding:8px;border:1px solid #e3e5ec;border-radius:6px" />
          <button type="submit" style="padding:8px 14px;background:#1B7A50;color:#fff;border:none;border-radius:6px;font-weight:700;cursor:pointer;font-size:12px">Add</button>
        </form>
      </section>

      <section style="background:#fff;border:1px solid ${VOIP_UI.line};border-radius:12px;padding:16px">
        <h4 style="margin:0 0 6px;font-size:13px">Numbers</h4>
        <p style="font-size:11.5px;color:#8892a6;margin:0 0 10px">Buy or port a number in the Twilio console first, then register it here.</p>
        ${numbers.map(n => `<div style="padding:6px 0;font-size:12.5px">${voipEscapeHtml(n.e164)} &mdash; <span style="color:#8892a6">${voipEscapeHtml(n.role)}</span></div>`).join('') || `<div style="color:#8892a6;font-size:12.5px">None registered yet.</div>`}
        <form id="voip-new-num" style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
          <input name="e164" placeholder="+1..." style="width:130px;padding:8px;border:1px solid #e3e5ec;border-radius:6px" required />
          <input name="friendly_name" placeholder="Label" style="flex:1;min-width:100px;padding:8px;border:1px solid #e3e5ec;border-radius:6px" />
          <select name="role" style="padding:8px;border:1px solid #e3e5ec;border-radius:6px"><option value="main">Main</option><option value="direct">Direct</option><option value="toll_free">Toll-free</option></select>
          <button type="submit" style="padding:8px 14px;background:#1B7A50;color:#fff;border:none;border-radius:6px;font-weight:700;cursor:pointer;font-size:12px">Add</button>
        </form>
      </section>

      <section style="background:#fff;border:1px solid ${VOIP_UI.line};border-radius:12px;padding:16px">
        <h4 style="margin:0 0 4px;font-size:13px">Greetings</h4>
        <p style="font-size:11.5px;color:#8892a6;margin:0 0 10px">A recorded or uploaded clip always plays instead of the typed text, if one is saved for that greeting.</p>
        ${GREETING_KINDS.map(k => { const g = greetingByKind[k.value]; const hasAudio = g && g.audio_url; return `
          <div style="padding:10px 0;border-bottom:1px solid #f0f1f5">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
              <b style="font-size:12.5px">${k.label}</b>
              ${hasAudio ? `<span style="font-size:9.5px;background:${VOIP_UI.greenBg};color:${VOIP_UI.green};padding:2px 7px;border-radius:99px;font-weight:700">RECORDED</span>` : `<span style="font-size:9.5px;background:${VOIP_UI.grayBg};color:${VOIP_UI.gray};padding:2px 7px;border-radius:99px;font-weight:700">TEXT-TO-SPEECH</span>`}
            </div>
            ${hasAudio ? `<audio controls src="${voipEscapeHtml(g.audio_url)}" style="width:100%;margin-top:6px;height:32px"></audio><button class="voip-greet-clear" data-kind="${k.value}" style="border:none;background:none;color:${VOIP_UI.red};cursor:pointer;font-weight:700;font-size:11px;padding:6px 0 0">Clear recording (revert to text)</button>` : `<div style="font-size:12px;color:#484f64;margin-top:4px">${voipEscapeHtml((g && g.tts_text) || '(using default built-in greeting)')}</div>`}
            <div style="display:flex;gap:8px;margin-top:9px">
              <button class="voip-greet-record-btn" data-kind="${k.value}" data-label="${voipEscapeHtml(k.label)}" style="display:inline-flex;align-items:center;gap:6px;border:1px solid ${VOIP_UI.greenBorder};background:${VOIP_UI.greenBg};color:${VOIP_UI.green};cursor:pointer;font-weight:700;font-size:11.5px;padding:6px 12px;border-radius:8px"><span style="font-size:13px">&#127908;</span> Record</button>
              <label style="display:inline-flex;align-items:center;gap:6px;border:1px solid ${VOIP_UI.line};background:#fbfbfd;color:${VOIP_UI.sub};cursor:pointer;font-weight:700;font-size:11.5px;padding:6px 12px;border-radius:8px"><span style="font-size:13px">&#128193;</span> Upload<input type="file" accept="audio/*" class="voip-greet-file" data-kind="${k.value}" style="display:none" /></label>
            </div>
          </div>`; }).join('')}
        <form id="voip-new-greet" style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
          <select name="kind" style="padding:8px;border:1px solid #e3e5ec;border-radius:6px">${GREETING_KINDS.map(k => `<option value="${k.value}">${k.label}</option>`).join('')}</select>
          <input name="tts_text" placeholder="What should we say?" style="flex:1;min-width:160px;padding:8px;border:1px solid #e3e5ec;border-radius:6px" required />
          <input type="hidden" name="name" value="custom" />
          <button type="submit" style="padding:8px 14px;background:#1B7A50;color:#fff;border:none;border-radius:6px;font-weight:700;cursor:pointer;font-size:12px">Save text</button>
        </form>
        <div id="voip-greet-record-status" style="font-size:11px;color:${VOIP_UI.amber};margin-top:8px"></div>
        <div style="font-size:11px;color:#8892a6;margin-top:10px;line-height:1.6">Or record from any phone: call the main number, press <b>00</b>, enter the recording PIN, then pick a greeting slot to record and confirm.${voicePinConfigured ? '' : ` <span style="color:${VOIP_UI.amber}">Not set up yet -- ask an admin to set VOICE_GREETING_PIN.</span>`}</div>
      </section>

      <section style="background:#fff;border:1px solid ${VOIP_UI.line};border-radius:12px;padding:16px">
        <h4 style="margin:0 0 10px;font-size:13px">Blocked numbers</h4>
        ${blocklist.map(b => `<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:12.5px"><span>${voipEscapeHtml(b.e164)}${b.reason ? ' &mdash; ' + voipEscapeHtml(b.reason) : ''}</span><button data-id="${b.id}" class="voip-unblock" style="border:none;background:none;color:#c65b4e;cursor:pointer;font-weight:700;font-size:11.5px">Remove</button></div>`).join('') || `<div style="color:#8892a6;font-size:12.5px">Nothing blocked.</div>`}
        <form id="voip-new-block" style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
          <input name="e164" placeholder="+1..." style="width:130px;padding:8px;border:1px solid #e3e5ec;border-radius:6px" required />
          <input name="reason" placeholder="Reason (optional)" style="flex:1;min-width:100px;padding:8px;border:1px solid #e3e5ec;border-radius:6px" />
          <button type="submit" style="padding:8px 14px;background:#c65b4e;color:#fff;border:none;border-radius:6px;font-weight:700;cursor:pointer;font-size:12px">Block</button>
        </form>
      </section>
    </div>`;

  function formToObject(form) {
    const fd = new FormData(form);
    const obj = {};
    fd.forEach((v, k) => { obj[k] = v; });
    obj.is_operator = form.elements.is_operator ? form.elements.is_operator.checked : undefined;
    obj.call_waiting_enabled = form.elements.call_waiting_enabled ? form.elements.call_waiting_enabled.checked : undefined;
    return obj;
  }
  const wire = (id, resource) => {
    const form = document.getElementById(id);
    if (!form) return;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = await voipApi(`?resource=${resource}`, 'POST', formToObject(form));
      if (!r.ok) return voipNotify(r.data.error || 'Save failed.');
      voipRenderSettings(body);
    });
  };
  wire('voip-new-ext', 'extensions');
  wire('voip-edit-ext-form', 'extensions');
  body.querySelectorAll('.voip-edit-ext-btn').forEach(function (btn) { btn.addEventListener('click', function () { voipRenderSettings(body, btn.dataset.id); }); });
  var extCancelBtn = body.querySelector('.voip-edit-ext-cancel');
  if (extCancelBtn) extCancelBtn.addEventListener('click', function () { voipRenderSettings(body); });
  wire('voip-new-num', 'numbers');
  wire('voip-new-greet', 'greetings');
  wire('voip-new-block', 'blocklist');

  // Greetings: mic recording + file upload both end up here -- base64 the
  // clip and POST it to greeting_upload, which stores it in Supabase
  // Storage and upserts the public URL onto the greeting row by kind.
  async function uploadGreetingAudio(kind, blob, contentType) {
    const statusEl = document.getElementById('voip-greet-record-status');
    // Twilio Play only supports MP3/WAV -- normalize every upload (mic
    // recording or file picker) to WAV before it reaches Twilio. See
    // voipBlobToWav above for why this is required.
    let uploadBlob = blob;
    let uploadType = contentType;
    if (statusEl) statusEl.textContent = 'Converting...';
    try {
      uploadBlob = await voipBlobToWav(blob);
      uploadType = 'audio/wav';
    } catch (e) {
      console.error('Greeting audio WAV conversion failed, uploading original file:', e);
    }
    if (statusEl) statusEl.textContent = 'Uploading...';
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = reject;
      reader.readAsDataURL(uploadBlob);
    });
    const r = await voipApi('?resource=greeting_upload', 'POST', { kind, audioBase64: base64, contentType: uploadType });
    if (statusEl) statusEl.textContent = '';
    if (!r.ok) return voipNotify(r.data.error || 'Upload failed.');
    voipRenderSettings(body);
  }

  body.querySelectorAll('.voip-greet-file').forEach(input => input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (!file) return;
    uploadGreetingAudio(input.dataset.kind, file, file.type || 'audio/mpeg');
  }));

  body.querySelectorAll('.voip-greet-clear').forEach(btn => btn.addEventListener('click', async () => {
    const r = await voipApi('?resource=greetings', 'POST', { kind: btn.dataset.kind, name: 'custom', clear_audio: true });
    if (!r.ok) return voipNotify(r.data.error || 'Could not clear recording.');
    voipRenderSettings(body);
  }));

  body.querySelectorAll('.voip-greet-record-btn').forEach(btn => btn.addEventListener('click', () => {
    voipOpenGreetRecorderModal(btn.dataset.kind, btn.dataset.label, (blob) => uploadGreetingAudio(btn.dataset.kind, blob, 'audio/webm'));
  }));
  body.querySelectorAll('.voip-unblock').forEach(b => b.addEventListener('click', async () => {
    await voipApi('?resource=blocklist_remove', 'POST', { id: b.dataset.id });
    voipRenderSettings(body);
  }));
  body.querySelectorAll('.voip-callflow-open-btn').forEach(function (btn) { btn.addEventListener('click', function () { voipOpenCallFlowModal(); }); });
  const saveSetting = async (field, value) => {
    const st = document.getElementById('voip-set-status');
    if (st) { st.style.color = VOIP_UI.gray; st.textContent = 'Saving…'; }
    const r = await voipApi('?resource=voice_settings', 'POST', { [field]: value });
    if (st) {
      if (r.ok) { st.style.color = VOIP_UI.green; st.textContent = 'Saved.'; setTimeout(() => { if (st) st.textContent = ''; }, 1800); }
      else { st.style.color = VOIP_UI.red; st.textContent = (r.data && r.data.error) || 'Could not save.'; }
    }
  };
  const recEl = document.getElementById('voip-set-record');
  if (recEl) recEl.addEventListener('change', () => saveSetting('record_calls', recEl.checked));
  const aiEl = document.getElementById('voip-set-aisum');
  if (aiEl) aiEl.addEventListener('change', () => saveSetting('ai_call_summaries', aiEl.checked));
  const back = document.getElementById('voip-settings-back');
  if (back) back.addEventListener('click', () => { openVoipTab(); });
}
function voipUpdateSystemStatus(status) {
  const el = document.getElementById('voip-system-status');
  if (!el) return;
  const dot = el.querySelector('.voip-status-dot');
  const label = el.querySelector('.voip-status-label');
  if (!dot || !label) return;
  if (!status) { dot.style.background = VOIP_UI.gray; label.textContent = 'Checking...'; label.style.color = VOIP_UI.ink; return; }
  const ok = !!status.configured;
  dot.style.background = ok ? VOIP_UI.green : VOIP_UI.red;
  label.style.color = VOIP_UI.ink;
  label.textContent = ok ? 'All Systems Go' : 'Not Connected';
}

// ---------------------------------------------------------------------
// Dispatcher dashboard shell: 4 stat cards, then a 3-column layout --
// Active Call / Queue Overview / Call Park on the left; Dial Pad /
// Directory / Call History / Voicemail tabs in the center; Call Queues /
// Available Agents / Quick Shortcuts on the right -- plus a status dock
// at the bottom. Settings lives behind the gear icon in the toolbar.
// ---------------------------------------------------------------------
async function openVoipTab() {
  const root = document.getElementById('voip-list');
  if (!root) return;
  // Keep Recent Calls fresh while the tab is open (call rows are written at
  // dial time, so a 20s poll catches your own just-placed calls).
  if (window.__voipCallsPoll) clearInterval(window.__voipCallsPoll);
  window.__voipCallsPoll = setInterval(voipRefreshCalls, 20000);
  root.innerHTML = `<div style="color:${VOIP_UI.gray};font-size:13px;padding:20px 0">Loading&hellip;</div>`;

  const statusRes = await voipApi('?resource=status');
  const status = statusRes.ok ? statusRes.data : null;
  voipUpdateSystemStatus(status);
  if (!status || !status.configured) {
    voipRenderNotConfigured(root, status ? status.missingEnv : []);
    return;
  }

  const [callsRes, vmRes, dirRes, numRes, qRes, agRes, cbRes] = await Promise.all([
    voipApi('?resource=calls&limit=50'), voipApi('?resource=voicemails&all=1'), voipApi('?resource=directory'), voipApi('?resource=numbers'),
    voipApi('?resource=queue_status'), voipApi('?resource=agent_status'), voipApi('?resource=callbacks&status=unassigned'),
  ]);
  voipData = {
    calls: callsRes.ok ? callsRes.data.calls : [],
    voicemails: vmRes.ok ? vmRes.data.voicemails : [],
    status,
    extensions: dirRes.ok ? dirRes.data.extensions : [],
    numbers: numRes.ok ? numRes.data.numbers : [],
    queues: qRes.ok ? qRes.data.queues : [],
    agents: agRes.ok ? agRes.data.agents : [],
    callbacks: cbRes.ok ? cbRes.data.callbacks : [],
    myExtensionId: agRes.ok ? agRes.data.mineExtensionId : null,
    myStatus: agRes.ok ? agRes.data.mineStatus : null,
  };
  voipSyncMyAgentStatus();

  root.innerHTML = `
    ${voipRenderStats(status, voipData.calls, voipData.voicemails)}
    <div style="display:grid;grid-template-columns:272px minmax(300px,1fr) 264px;gap:14px;align-items:start">
      <div style="min-width:0;display:flex;flex-direction:column;gap:12px">
        <div id="voip-box-active"></div>
        <div id="voip-box-comingsoon"></div>
      </div>
      <div style="min-width:0;background:#fff;border:1px solid ${VOIP_UI.line};border-radius:${VOIP_UI.cardRadius};padding:18px;box-shadow:${VOIP_UI.cardShadow}">
        <div id="voip-center-tabbar"></div>
        <div id="voip-center-body"></div>
      </div>
      <div style="min-width:0;display:flex;flex-direction:column;gap:12px">
        <div id="voip-box-callqueues"></div>
        <div id="voip-box-agents"></div>
        <div id="voip-box-shortcuts"></div>
      </div>
    </div>`;

  voipRenderActiveCallCard(document.getElementById('voip-box-active'));
  voipRenderQueueOverviewCard(document.getElementById('voip-box-comingsoon'));
  voipRenderCallbacksCard(document.getElementById('voip-box-callqueues'));
  voipRenderAgentsCard(document.getElementById('voip-box-agents'), voipData.extensions);
  voipRenderQuickShortcutsCard(document.getElementById('voip-box-shortcuts'));
  voipRenderCenterTab();
  voipStartLiveUpdates();
}

{ const b = document.getElementById('voip-refresh'); if (b) b.addEventListener('click', openVoipTab); }
{ const b = document.getElementById('voip-settings-btn'); if (b) b.addEventListener('click', voipOpenSettings); }

async function voipRefreshCalls() {
  const body = document.getElementById('voip-center-body');
  if (!body || !document.body.contains(body)) { clearInterval(window.__voipCallsPoll); window.__voipCallsPoll = null; return; }
  if (voipCenterTab !== 'dial' && voipCenterTab !== 'history') return;
  let res; try { res = await voipApi('?resource=calls&limit=50'); } catch (e) { return; }
  if (!res || !res.ok || !res.data) return;
  const fresh = res.data.calls || [];
  const key = (list) => list.slice(0, 8).map(c => (c.id || c.provider_call_sid || c.started_at) + ":" + (c.status || "") + ":" + (c.duration_seconds || "")).join("|");
  const changed = key(fresh) !== key((voipData && voipData.calls) || []);
  if (voipData) voipData.calls = fresh;
  if (!changed) return;
  const inp = document.getElementById('voip-dial-input');
  if (inp && document.activeElement === inp) return; // never stomp mid-typing; next poll gets it
  const saved = inp ? inp.value : null;
  voipRenderCenterTab();
  if (saved) {
    const inp2 = document.getElementById('voip-dial-input');
    if (inp2) inp2.value = saved;
  }
}

// ---- authenticated recording playback (no Twilio login popups) ----
async function voipRecToken() {
  try { if (typeof hlTokenSync === 'function') { const t = hlTokenSync(); if (t) return t; } } catch (e) {}
  try {
    const c = window.sb || window.hcSb;
    if (c && c.auth) { const s = await c.auth.getSession(); const t2 = s && s.data && s.data.session && s.data.session.access_token; if (t2) return t2; }
  } catch (e) {}
  return null;
}
async function voipLoadRecordingInto(a) {
  if (a.dataset.recLoading) return; a.dataset.recLoading = '1';
  try {
    const tok = await voipRecToken();
    const r = await fetch('/api/voice?resource=recording_audio&kind=' + encodeURIComponent(a.dataset.recKind) + '&id=' + encodeURIComponent(a.dataset.recId), { headers: tok ? { Authorization: 'Bearer ' + tok } : {} });
    if (!r.ok) throw new Error('fetch ' + r.status);
    const blob = await r.blob();
    a.src = URL.createObjectURL(blob);
    a.dataset.recLoaded = '1';
    a.play().catch(function () {});
  } catch (err) {
    a.dataset.recLoading = '';
    try { voipNotify('Could not load the recording. Try again.'); } catch (e) {}
  }
}
if (!window.__voipRecWired) {
  window.__voipRecWired = true;
  document.addEventListener('play', function (e) {
    const a = e.target;
    if (!a || a.tagName !== 'AUDIO' || !a.dataset || !a.dataset.recId || a.dataset.recLoaded) return;
    a.pause();
    voipLoadRecordingInto(a);
  }, true);
}
