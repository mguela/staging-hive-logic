// public/hiveconnect/tasks.js
// Extracted from app.js -- HiveConnect Tasks V1 native task system.
// Pure move, zero logic changes (Phase 1 modularization, refactor/extract-hiveconnect-tasks-module).
// Loaded via <script src="tasks.js"> before app.js in index.html; all functions/state below
// remain global (no module system in this codebase yet), so existing call sites in app.js
// (msgEl -> openTaskQuickCreateFromSource, setNavTab -> openTasksTabNative) are unaffected.

const TASK_PRIORITY_LABEL = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };

let tasksData = [];
let tasksNativeView = 'mine'; // mine | team | unassigned | waiting | blocked | completed
let pendingTaskSource = null; // staged source-link fields for the next task created

function taskOwnerLabel(t) {
  if (t.owner_type === 'employee') { const p = t.owner_profile_id && profiles.get(t.owner_profile_id); return p ? (p.display_name || p.username) : 'Unknown'; }
  if (t.owner_type === 'team') { const c = t.owner_channel_id && channels.get(t.owner_channel_id); return c ? '#' + (c.name || 'team') : 'Team'; }
  const c = t.owner_contact_id && contactsData.find(x => x.id === t.owner_contact_id);
  return c ? c.name : ({ vendor: 'Vendor', sub: 'Sub', client: 'Client' }[t.owner_type] || 'Unassigned');
}
function taskOwnerAvatar(t) {
  if (t.owner_type === 'employee') { const p = t.owner_profile_id && profiles.get(t.owner_profile_id); return avatarEl(p, 'avatar'); }
  if (t.owner_type === 'team') { const c = t.owner_channel_id && channels.get(t.owner_channel_id); return avatarEl({ display_name: c ? c.name : 'Team' }, 'avatar'); }
  const c = t.owner_contact_id && contactsData.find(x => x.id === t.owner_contact_id);
  return avatarEl({ display_name: c ? c.name : '?' }, 'avatar');
}

async function loadTasksNative() {
  const list = $('tsk-list'); if (list) list.innerHTML = '<div class="ev-loading">Loading…</div>';
  try {
    const { data, error } = await sb.from('tasks').select('*').order('deliverable_date', { ascending: true, nullsFirst: false }).order('created_at', { ascending: false });
    if (error) throw error;
    tasksData = data || [];
  } catch (e) { tasksData = []; if (list) list.innerHTML = '<div class="ev-loading">Couldn\'t load tasks — ' + esc(e.message || '') + '</div>'; return; }
  renderTasksSidebar();
  renderTasksList();
}

function taskCounts() {
  const active = tasksData.filter(t => t.status !== 'completed' && t.status !== 'cancelled');
  return {
    mine: active.filter(t => t.owner_type === 'employee' && t.owner_profile_id === (me && me.id)).length,
    team: active.filter(t => !(t.owner_type === 'employee' && t.owner_profile_id === (me && me.id))).length,
    unassigned: tasksData.filter(t => t.status === 'unassigned' || t.status === 'draft').length,
    waiting: tasksData.filter(t => t.status === 'waiting').length,
    blocked: tasksData.filter(t => t.status === 'blocked').length,
    completed: tasksData.filter(t => t.status === 'completed').length,
  };
}

function renderTasksSidebar() {
  const el = $('panel-tasks'); if (!el) return;
  el.innerHTML = '';
  const add = document.createElement('button'); add.className = 'new-channel-cta'; add.id = 'tsk-add-cta';
  add.innerHTML = '<span>＋</span> New task'; add.onclick = () => openTaskDetail(null);
  el.appendChild(add);
  const counts = taskCounts();
  const views = [
    ['mine', '🙋 My Tasks', counts.mine],
    ['team', '👥 Team Tasks', counts.team],
    ['unassigned', '❔ Unassigned', counts.unassigned],
    ['waiting', '⏳ Waiting', counts.waiting],
    ['blocked', '🚧 Blocked', counts.blocked],
    ['completed', '✅ Completed', counts.completed],
  ];
  const nav = document.createElement('div'); nav.className = 'tsk-nav';
  views.forEach(([key, label, count]) => {
    const b = document.createElement('button'); b.className = 'tsk-nav-item' + (tasksNativeView === key ? ' active' : '');
    b.innerHTML = '<span class="tsk-nav-lbl">' + label + '</span>' + (count ? '<span class="tsk-nav-count">' + count + '</span>' : '');
    b.onclick = () => { tasksNativeView = key; renderTasksSidebar(); renderTasksList(); };
    nav.appendChild(b);
  });
  el.appendChild(nav);
}

function taskMatchesView(t) {
  switch (tasksNativeView) {
    case 'mine': return t.owner_type === 'employee' && t.owner_profile_id === (me && me.id) && t.status !== 'completed' && t.status !== 'cancelled';
    case 'team': return !(t.owner_type === 'employee' && t.owner_profile_id === (me && me.id)) && t.status !== 'completed' && t.status !== 'cancelled';
    case 'unassigned': return t.status === 'unassigned' || t.status === 'draft';
    case 'waiting': return t.status === 'waiting';
    case 'blocked': return t.status === 'blocked';
    case 'completed': return t.status === 'completed';
    default: return true;
  }
}

function renderTasksList() {
  const list = $('tsk-list'); if (!list) return; list.innerHTML = '';
  const rows = tasksData.filter(taskMatchesView);
  if (!rows.length) { list.innerHTML = '<div class="ev-loading">Nothing here. 🎉</div>'; return; }
  rows.forEach(t => list.appendChild(taskRowEl(t)));
}

function taskRowEl(t) {
  const r = document.createElement('div'); r.className = 'tk-item' + (t.status === 'completed' ? ' done' : '');
  const cb = document.createElement('button'); cb.className = 'tk-check'; cb.innerHTML = t.status === 'completed' ? '✓' : '';
  cb.title = t.status === 'completed' ? 'Mark not complete' : 'Mark complete';
  cb.onclick = (e) => { e.stopPropagation(); toggleTaskComplete(t); };
  r.appendChild(cb);

  const av = taskOwnerAvatar(t); av.classList.add('tsk-item-av'); r.appendChild(av);

  const mid = document.createElement('div'); mid.className = 'tk-mid';
  const ti = document.createElement('div'); ti.className = 'tk-title'; ti.textContent = t.title || '(untitled)'; mid.appendChild(ti);
  const metaBits = [];
  metaBits.push('<span class="tsk-owner">' + esc(taskOwnerLabel(t)) + '</span>');
  if (t.deliverable_date) {
    const d = new Date(t.deliverable_date + 'T00:00:00');
    const overdue = d < new Date(new Date().toDateString()) && t.status !== 'completed';
    metaBits.push('<span class="tk-due' + (overdue ? ' overdue' : '') + '">📅 ' + esc(d.toLocaleDateString([], { month: 'short', day: 'numeric' })) + '</span>');
  }
  if (t.job_ref || t.client_ref) metaBits.push('<span class="tsk-tag">🏷 ' + esc(t.job_ref || t.client_ref) + '</span>');
  const meta = document.createElement('div'); meta.className = 'tsk-meta'; meta.innerHTML = metaBits.join('');
  mid.appendChild(meta);
  r.appendChild(mid);

  const badges = document.createElement('div'); badges.className = 'tsk-badges';
  const pr = document.createElement('span'); pr.className = 'tsk-priority tsk-priority-' + (t.priority || 'normal'); pr.textContent = TASK_PRIORITY_LABEL[t.priority] || 'Normal'; badges.appendChild(pr);
  if (t.status !== 'not_started' && t.status !== 'completed') { const st = document.createElement('span'); st.className = 'tsk-status tsk-status-' + t.status; st.textContent = TASK_STATUS_LABEL[t.status] || t.status; badges.appendChild(st); }
  r.appendChild(badges);

  r.onclick = () => openTaskDetail(t);
  return r;
}

async function toggleTaskComplete(t) {
  await updateTaskStatus(t, t.status === 'completed' ? 'not_started' : 'completed');
}

async function updateTaskStatus(t, newStatus, note) {
  const patch = { status: newStatus, updated_at: new Date().toISOString() };
  if (newStatus === 'completed') patch.completion_date = new Date().toISOString();
  const { error } = await sb.from('tasks').update(patch).eq('id', t.id);
  if (error) { railToast("Couldn't update — check your access."); return; }
  try { await sb.from('task_status_history').insert({ task_id: t.id, from_status: t.status, to_status: newStatus, changed_by: me.id, note: note || null }); } catch (e) {}
  await loadTasksNative();
}

// ---- Quick create ----
function populateOwnerQuickSelect() {
  const sel = $('tsk-new-owner'); if (!sel || !me) return;
  sel.innerHTML = '';
  const meOpt = document.createElement('option'); meOpt.value = me.id; meOpt.textContent = 'Me'; sel.appendChild(meOpt);
  Array.from(profiles.values()).filter(p => p.id !== me.id).sort((a, b) => (a.display_name || '').localeCompare(b.display_name || '')).forEach(p => {
    const o = document.createElement('option'); o.value = p.id; o.textContent = p.display_name || p.username; sel.appendChild(o);
  });
  sel.value = me.id;
}

async function quickCreateTask() {
  const inp = $('tsk-new-title'); const title = (inp.value || '').trim();
  if (!title) return;
  const ownerSel = $('tsk-new-owner');
  const ownerProfileId = (ownerSel && ownerSel.value) || me.id;
  const due = $('tsk-new-due').value || null;
  const priority = $('tsk-new-priority').value || 'normal';
  const tag = ($('tsk-new-tag').value || '').trim() || null;
  const rec = { title, priority, owner_type: 'employee', owner_profile_id: ownerProfileId, created_by: me.id, deliverable_date: due, job_ref: tag, status: 'not_started' };
  const { data, error } = await sb.from('tasks').insert(rec).select().single();
  if (error) { railToast("Couldn't create task — " + ((error && error.message) || "check your access.")); return; }
  if (pendingTaskSource) { try { await sb.from('task_source_links').insert({ task_id: data.id, ...pendingTaskSource }); } catch (e) {} pendingTaskSource = null; }
  inp.value = ''; $('tsk-new-due').value = ''; $('tsk-new-tag').value = ''; $('tsk-new-priority').value = 'normal'; populateOwnerQuickSelect();
  tasksNativeView = (ownerProfileId === (me && me.id)) ? 'mine' : 'team'; railToast('Task created ✅');
  await loadTasksNative();
}

// Called from the "✅ Task" action on an email / message / channel post / thread reply.
function openTaskQuickCreateFromSource(src) {
  pendingTaskSource = {
    source_type: src.type,
    source_message_id: src.sourceMessageId || null,
    source_channel_id: src.sourceChannelId || null,
    external_ref: src.externalRef || null,
    snapshot_subject: src.subject || null,
    snapshot_sender: src.sender || null,
    snapshot_preview: src.preview || null,
  };
  setNavTab('tasks');
  setTimeout(() => {
    const inp = $('tsk-new-title'); if (inp) { inp.value = src.subject || ''; inp.focus(); inp.select(); }
    const kind = src.type === 'email' ? 'email' : src.type === 'thread_reply' ? 'thread reply' : src.type === 'channel_post' ? 'channel post' : 'message';
    railToast('Linked to this ' + kind + ' — finish the task below');
  }, 150);
}

// ---- Full "More Details" builder ----
function taskOwnerOptionsHtml(t) {
  return ['employee', 'team', 'vendor', 'sub', 'client'].map(v => '<option value="' + v + '"' + (t.owner_type === v ? ' selected' : '') + '>' + ({ employee: 'Employee', team: 'Team', vendor: 'Vendor', sub: 'Sub', client: 'Client' }[v]) + '</option>').join('');
}
function renderOwnerPicker(t) {
  const wrap = $('tsk-owner-picker-wrap'); if (!wrap) return;
  const type = $('tsk-f-owner-type').value;
  wrap.innerHTML = '';
  if (type === 'employee') {
    const sel = document.createElement('select'); sel.id = 'tsk-f-owner-profile'; sel.className = 'rec-input';
    Array.from(profiles.values()).sort((a, b) => (a.display_name || '').localeCompare(b.display_name || '')).forEach(p => { const o = document.createElement('option'); o.value = p.id; o.textContent = p.display_name || p.username; if (t.owner_profile_id === p.id) o.selected = true; sel.appendChild(o); });
    wrap.appendChild(sel);
  } else if (type === 'team') {
    const sel = document.createElement('select'); sel.id = 'tsk-f-owner-channel'; sel.className = 'rec-input';
    Array.from(channels.values()).filter(c => c.type !== 'dm').sort((a, b) => (a.name || '').localeCompare(b.name || '')).forEach(c => { const o = document.createElement('option'); o.value = c.id; o.textContent = '#' + c.name; if (t.owner_channel_id === c.id) o.selected = true; sel.appendChild(o); });
    wrap.appendChild(sel);
  } else {
    const sel = document.createElement('select'); sel.id = 'tsk-f-owner-contact'; sel.className = 'rec-input';
    const blank = document.createElement('option'); blank.value = ''; blank.textContent = '— choose a contact —'; sel.appendChild(blank);
    contactsData.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).forEach(c => { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name + (c.company ? ' · ' + c.company : ''); if (t.owner_contact_id === c.id) o.selected = true; sel.appendChild(o); });
    wrap.appendChild(sel);
  }
  const accWrap = $('tsk-acc-owner-wrap');
  if (accWrap) accWrap.classList.toggle('hidden', !(type === 'vendor' || type === 'sub'));
}
function refreshTaskConditionalFields() {
  const status = $('tsk-f-status').value;
  const wr = $('tsk-waiting-wrap'); if (wr) wr.classList.toggle('hidden', status !== 'waiting');
  const bl = $('tsk-blocked-wrap'); if (bl) bl.classList.toggle('hidden', status !== 'blocked');
}

function openTaskDetail(t) {
  const isNew = !t;
  t = t || { title: pendingTaskSource ? (pendingTaskSource.snapshot_subject || '') : '', description: '', status: 'not_started', priority: 'normal', owner_type: 'employee', owner_profile_id: me.id, start_date: '', deliverable_date: '', percent_complete: 0, job_ref: '', client_ref: '' };
  const old = document.getElementById('task-detail'); if (old) old.remove();
  const ov = document.createElement('div'); ov.id = 'task-detail'; ov.className = 'modal-backdrop';
  ov.innerHTML =
    '<div class="modal tsk-modal">' +
    '<button class="cc-x" id="tsk-x" title="Close">✕</button>' +
    '<h2>' + (isNew ? 'New task' : 'Task details') + '</h2>' +
    '<div class="cc-fields tsk-fields">' +
    '<div class="cc-field"><label>Title</label><input id="tsk-f-title" class="rec-input"></div>' +
    '<div class="cc-field"><label>Description</label><textarea id="tsk-f-desc" class="rec-input" rows="3"></textarea></div>' +
    '<div class="tsk-field-row">' +
    '<div class="cc-field"><label>Status</label><select id="tsk-f-status" class="rec-input">' + TASK_STATUSES.map(s => '<option value="' + s + '">' + TASK_STATUS_LABEL[s] + '</option>').join('') + '</select></div>' +
    '<div class="cc-field"><label>Priority</label><select id="tsk-f-priority" class="rec-input">' + Object.keys(TASK_PRIORITY_LABEL).map(p => '<option value="' + p + '">' + TASK_PRIORITY_LABEL[p] + '</option>').join('') + '</select></div>' +
    '</div>' +
    '<div class="tsk-field-row">' +
    '<div class="cc-field"><label>Owner type</label><select id="tsk-f-owner-type" class="rec-input">' + taskOwnerOptionsHtml(t) + '</select></div>' +
    '<div class="cc-field"><label>Owner</label><div id="tsk-owner-picker-wrap"></div></div>' +
    '</div>' +
    '<div class="cc-field tsk-acc-owner hidden" id="tsk-acc-owner-wrap"><label>Internal accountability owner</label><select id="tsk-f-acc-owner" class="rec-input"></select></div>' +
    '<div class="tsk-field-row">' +
    '<div class="cc-field"><label>Start date</label><input id="tsk-f-start" type="date" class="rec-input"></div>' +
    '<div class="cc-field"><label>Due date</label><input id="tsk-f-due" type="date" class="rec-input"></div>' +
    '</div>' +
    '<div class="cc-field"><label>% complete</label><input id="tsk-f-pct" type="number" min="0" max="100" class="rec-input"></div>' +
    '<div class="tsk-field-row">' +
    '<div class="cc-field"><label>Job tag</label><input id="tsk-f-job" class="rec-input" placeholder="Job # or name"></div>' +
    '<div class="cc-field"><label>Client tag</label><input id="tsk-f-client" class="rec-input" placeholder="Client name"></div>' +
    '</div>' +
    '<div class="cc-field hidden" id="tsk-waiting-wrap"><label>Waiting on</label><select id="tsk-f-waiting" class="rec-input"><option value="">— choose —</option>' + TASK_WAITING_REASONS.map(w => '<option value="' + w + '">' + w.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase()) + '</option>').join('') + '</select></div>' +
    '<div class="cc-field hidden" id="tsk-blocked-wrap"><label>Blocked — reason &amp; blocking party</label><input id="tsk-f-blocked-reason" class="rec-input" placeholder="Reason" style="margin-bottom:8px"><input id="tsk-f-blocked-party" class="rec-input" placeholder="Who/what is blocking this"></div>' +
    (t.id ? '<div class="cc-note" id="tsk-source-note"></div>' : '') +
    '</div>' +
    '<div class="cc-foot">' + (!isNew ? '<button class="cc-del" id="tsk-del">Delete</button>' : '') + '<button class="primary-btn" id="tsk-save">' + (isNew ? 'Create task' : 'Save') + '</button></div>' +
    '</div>';
  document.body.appendChild(ov);

  $('tsk-f-title').value = t.title || '';
  $('tsk-f-desc').value = t.description || '';
  $('tsk-f-status').value = t.status || 'not_started';
  $('tsk-f-priority').value = t.priority || 'normal';
  $('tsk-f-start').value = t.start_date || '';
  $('tsk-f-due').value = t.deliverable_date || '';
  $('tsk-f-pct').value = t.percent_complete || 0;
  $('tsk-f-job').value = t.job_ref || '';
  $('tsk-f-client').value = t.client_ref || '';
  renderOwnerPicker(t);
  { const sel = $('tsk-f-acc-owner'); if (sel) { Array.from(profiles.values()).sort((a, b) => (a.display_name || '').localeCompare(b.display_name || '')).forEach(p => { const o = document.createElement('option'); o.value = p.id; o.textContent = p.display_name || p.username; if (t.internal_accountability_owner_id === p.id) o.selected = true; sel.appendChild(o); }); } }
  if (t.waiting_reason) $('tsk-f-waiting').value = t.waiting_reason;
  if (t.blocked_reason) $('tsk-f-blocked-reason').value = t.blocked_reason;
  if (t.blocked_blocking_party) $('tsk-f-blocked-party').value = t.blocked_blocking_party;
  refreshTaskConditionalFields();
  $('tsk-f-status').addEventListener('change', refreshTaskConditionalFields);
  $('tsk-f-owner-type').addEventListener('change', () => renderOwnerPicker(t));

  if (t.id) {
    const note = $('tsk-source-note');
    if (note) {
      sb.from('task_source_links').select('*').eq('task_id', t.id).limit(1).then(({ data }) => {
        const link = data && data[0];
        if (link) note.textContent = '🔗 Linked from ' + (link.source_type === 'email' ? 'an email' : link.source_type.replace('_', ' ')) + (link.snapshot_subject ? ': "' + link.snapshot_subject + '"' : '');
        else note.remove();
      }).catch(() => note.remove());
    }
  } else if (pendingTaskSource) {
    const note = document.createElement('div'); note.className = 'cc-note'; note.textContent = '🔗 Will be linked to this ' + pendingTaskSource.source_type.replace('_', ' ') + (pendingTaskSource.snapshot_subject ? ': "' + pendingTaskSource.snapshot_subject + '"' : '');
    ov.querySelector('.tsk-fields').appendChild(note);
  }

  const close = () => ov.remove();
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  $('tsk-x').onclick = close;
  const del = $('tsk-del'); if (del) del.onclick = async () => { if (t.id && confirm('Delete this task?')) { await sb.from('tasks').delete().eq('id', t.id); await loadTasksNative(); } close(); };
  $('tsk-save').onclick = async () => {
    const title = ($('tsk-f-title').value || '').trim();
    if (!title) { $('tsk-f-title').focus(); return; }
    const ownerType = $('tsk-f-owner-type').value;
    const rec = {
      title,
      description: ($('tsk-f-desc').value || '').trim() || null,
      status: $('tsk-f-status').value,
      priority: $('tsk-f-priority').value,
      owner_type: ownerType,
      owner_profile_id: ownerType === 'employee' ? (($('tsk-f-owner-profile') && $('tsk-f-owner-profile').value) || null) : null,
      owner_channel_id: ownerType === 'team' ? (($('tsk-f-owner-channel') && $('tsk-f-owner-channel').value) || null) : null,
      owner_contact_id: (ownerType === 'vendor' || ownerType === 'sub' || ownerType === 'client') ? (($('tsk-f-owner-contact') && $('tsk-f-owner-contact').value) || null) : null,
      internal_accountability_owner_id: (ownerType === 'vendor' || ownerType === 'sub') ? (($('tsk-f-acc-owner') && $('tsk-f-acc-owner').value) || null) : null,
      start_date: $('tsk-f-start').value || null,
      deliverable_date: $('tsk-f-due').value || null,
      percent_complete: Math.max(0, Math.min(100, parseInt($('tsk-f-pct').value, 10) || 0)),
      job_ref: ($('tsk-f-job').value || '').trim() || null,
      client_ref: ($('tsk-f-client').value || '').trim() || null,
      waiting_reason: $('tsk-f-status').value === 'waiting' ? ($('tsk-f-waiting').value || null) : null,
      blocked_reason: $('tsk-f-status').value === 'blocked' ? (($('tsk-f-blocked-reason').value || '').trim() || null) : null,
      blocked_blocking_party: $('tsk-f-status').value === 'blocked' ? (($('tsk-f-blocked-party').value || '').trim() || null) : null,
      updated_at: new Date().toISOString(),
    };
    if ((ownerType === 'vendor' || ownerType === 'sub' || ownerType === 'client') && !rec.owner_contact_id) { railToast('Pick a contact for this owner.'); return; }
    if ((ownerType === 'vendor' || ownerType === 'sub') && !rec.internal_accountability_owner_id) { railToast('Vendor/sub tasks need an internal accountability owner.'); return; }
    if (rec.status === 'completed' && !t.completion_date) rec.completion_date = new Date().toISOString();
    try {
      if (isNew) {
        rec.created_by = me.id;
        const { data, error } = await sb.from('tasks').insert(rec).select().single();
        if (error) throw error;
        if (pendingTaskSource) { await sb.from('task_source_links').insert({ task_id: data.id, ...pendingTaskSource }); pendingTaskSource = null; }
      } else {
        const { error } = await sb.from('tasks').update(rec).eq('id', t.id);
        if (error) throw error;
        if (rec.status !== t.status) { try { await sb.from('task_status_history').insert({ task_id: t.id, from_status: t.status, to_status: rec.status, changed_by: me.id }); } catch (e) {} }
      }
    } catch (e) { railToast("Couldn't save — " + ((e && e.message) || "check your access.")); return; }
    tasksNativeView = (rec.status === 'completed') ? 'completed' : (rec.status === 'waiting') ? 'waiting' : (rec.status === 'blocked') ? 'blocked' : (rec.status === 'unassigned' || rec.status === 'draft') ? 'unassigned' : (rec.owner_type === 'employee' && rec.owner_profile_id === (me && me.id)) ? 'mine' : 'team';
    await loadTasksNative();
    close();
  };
}

async function openTasksTabNative() {
  bindTasksControls();
  populateOwnerQuickSelect();
  renderTasksSidebar();
  await loadTasksNative();
}
// The Tasks tab's three controls: Enter-to-create, Refresh, and More details.
//
// THESE USED TO BE BOUND AT THE BOTTOM OF THIS FILE, at script-evaluation time,
// and they never worked. `$` is declared in app.js -- `const $ = id => ...` --
// and app.js loads AFTER this file in both the standalone page and the embedded
// mount. Classic scripts share one global lexical scope, so reaching for `$`
// here ran before that binding existed and threw "$ is not defined" on every
// single page load. The throw aborted the remaining top-level statements, so
// ALL THREE listeners were lost: Enter in the new-task box did nothing, the
// Refresh button did nothing, and More details did nothing.
//
// It failed silently because a page error during script evaluation does not
// stop anything visible -- the tab still opened, the sidebar still rendered,
// the buttons were still there. They just did not respond. (Confirmed in
// Chromium against the real page, not reasoned about: the load throws exactly
// one pageerror, "$ is not defined".)
//
// Binding now happens when the tab is opened, which is after app.js has run by
// construction, and is guarded so repeated opens do not stack duplicates. No
// load-order assumption left to break.
let tasksControlsBound = false;
function bindTasksControls() {
  if (tasksControlsBound) return;
  const title = document.getElementById('tsk-new-title');
  const refresh = document.getElementById('tsk-refresh');
  const more = document.getElementById('tsk-more-details');
  // Bind whatever is present; if the markup is not in yet, try again next open.
  if (!title && !refresh && !more) return;
  if (title) title.addEventListener('keydown', (e) => { if (e.key === 'Enter') quickCreateTask(); });
  if (refresh) refresh.addEventListener('click', loadTasksNative);
  if (more) {
    more.addEventListener('click', () => {
      const t = (document.getElementById('tsk-new-title').value || '').trim();
      openTaskDetail(null);
      if (t) setTimeout(() => { const f = document.getElementById('tsk-f-title'); if (f) f.value = t; }, 0);
    });
  }
  tasksControlsBound = true;
}