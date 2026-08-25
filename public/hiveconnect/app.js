/* ===== HiveConnect — Phase 1 ===== */
'use strict';

const sb = window.supabase.createClient(window.HIVE_CONFIG.url, window.HIVE_CONFIG.anonKey);

/* ============ Preferences follow the user, not this browser ============
 *
 * Chris, 2026-08-23, as a standing rule (CLAUDE.md): "settings changed should
 * follow the user not the device. for every part of Hivelogic".
 *
 * HiveConnect is injected into the HiveLogic document -- no iframe -- so
 * window.hlUserSettings is right there, backed by profiles.settings and keyed
 * to the signed-in HiveLogic user. Theme set on the office desktop is now set
 * on the laptop; email templates written once are not stranded on one machine.
 *
 * localStorage stays as the CACHE, and the legacy key keeps being written, so
 * a first load before the server answers still paints what he last chose
 * rather than flashing a default at him.
 *
 * NOT here: hive_mic and hive_speaker. Which microphone is genuinely about the
 * machine -- carrying that choice across would name a device that is not
 * plugged in.
 */
function hcPref(key, legacyKey, fallback) {
  try {
    if (window.hlUserSettings) {
      const v = window.hlUserSettings.get(key, undefined);
      if (v !== undefined) return v;
    }
  } catch (e) {}
  try {
    const raw = localStorage.getItem(legacyKey);
    if (raw !== null) return raw;
  } catch (e) {}
  return fallback;
}
function hcPrefSet(key, legacyKey, value) {
  try { localStorage.setItem(legacyKey, typeof value === 'string' ? value : JSON.stringify(value)); } catch (e) {}
  try { if (window.hlUserSettings) window.hlUserSettings.set(key, value).catch(() => {}); } catch (e) {}
}
function hcPrefJson(key, legacyKey, fallback) {
  const v = hcPref(key, legacyKey, undefined);
  if (v === undefined) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (e) { return fallback; }
}



// ---------- State ----------
let me = null;                    // my profile row
window.me = null;                 // mirrored for tasks.js/voip-panel.js: those are classic
                                   // scripts written against "app.js's top-level bindings are
                                   // global" (true on the standalone HiveConnect page), but
                                   // hiveconnect-mount.js MUST load this file as a module to
                                   // avoid colliding with HiveLogic's own global `var sb` --
                                   // which, as a side effect, hides every other top-level
                                   // let/const here from those siblings too. Every `me = ...`
                                   // assignment below writes through here as well, so a bare
                                   // `me` reference in tasks.js keeps working in both contexts.
let loadEverythingStarted = false;   // guards against double-boot (bridged-session flow can call loadEverything twice concurrently, which double-subscribes realtime channels and crashes with 'cannot add postgres_changes callbacks ... after subscribe()')
let profiles = new Map();         // user_id -> profile
window.profiles = profiles;       // mirrored for the same reason as `me` (see above) -- never
                                   // reassigned wholesale below, only mutated via .set()/.delete(),
                                   // so this one early mirror stays valid for the object's whole life.
let channels = new Map();         // channel_id -> channel row
window.channels = channels;       // same as profiles -- mutated in place, never reassigned.
let memberships = new Map();      // channel_id -> membership row (mine)
let unreads = new Map();          // channel_id -> count
let notifications = [];           // my notifications (newest first)
let currentChannelId = null;
let currentThreadId = null;       // parent message id when thread panel open
let messagesCache = new Map();    // message_id -> message row (current channel + threads)
let reactionsCache = new Map();   // message_id -> [{user_id, emoji}]
let mentionSel = 0;
let onlineUsers = new Set();       // user_ids currently online (realtime presence)
let notifsEnabled = hcPref('hcNotifs', 'hive_notifs', 'on') !== 'off';

const EMOJIS = ['👍','❤️','😂','🎉','🔥','👀','✅','🙏','😅','💯','😮','😢','🚀','🐝','💪','👌','🤝','⭐','☕','🍺','😎','🤔','😴','🫡','⚡','🛠️','📸','🏠','💰','🌧️','☀️','🥶'];

// ---------- DOM ----------
const $ = id => document.getElementById(id);
// Found 2026-08-22: openTaskDetail() in tasks.js -- the same function the
// TASK_STATUSES mirror above was fixing -- goes on to call bare `$(...)`
// several lines further in, throwing "$ is not defined @tasks.js:255" in
// the mounted context once TASK_STATUSES stopped being the first thing it
// hit. Unlike `sb` (deliberately NOT mirrored -- collides with HiveLogic's
// own global `var sb`, the whole reason app.js loads as a module here) and
// `esc` (also NOT mirrored -- HiveLogic's own index.html defines its own
// top-level global `esc` for unrelated HTML-escaping; overwriting it would
// silently corrupt escaping everywhere else in the Command Center once
// HiveConnect mounts), `$` has no such collision -- confirmed no top-level
// `$` exists anywhere in HiveLogic's own index.html.
window.$ = $;
const authScreen = $('auth-screen'), app = $('app');
const messagesEl = $('messages'), composerInput = $('composer-input');
const threadPanel = $('thread-panel'), threadMessagesEl = $('thread-messages'), threadInput = $('thread-input');

// ---------- Utils ----------
function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
const esc = s => escapeHtml(s == null ? '' : String(s));
function initials(p) {
  return (p.display_name || p.username || '?').split(/\s+/).map(w => w[0]).slice(0,2).join('').toUpperCase();
}
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function fmtDay(ts) {
  const d = new Date(ts), today = new Date();
  const yest = new Date(today); yest.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}
function avatarEl(p, cls = 'avatar') {
  const d = document.createElement('div');
  d.className = cls;
  if (p && p.avatar_url) {
    d.classList.add('has-img');
    d.style.backgroundImage = `url("${p.avatar_url}")`;
    d.textContent = '';
  } else {
    d.style.background = p?.avatar_color || '#6b7180';
    d.textContent = p ? initials(p) : '?';
  }
  return d;
}

async function hiveConnectAccountAction(action, body, requireAuth = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (requireAuth) {
    const { data: { session } } = await sb.auth.getSession();
    if (!session?.access_token) throw new Error('Admin sign-in required.');
    headers.Authorization = 'Bearer ' + session.access_token;
  }
  const response = await fetch('/api/hiveconnect-bridge?action=' + encodeURIComponent(action), {
    method: 'POST',
    headers,
    body: JSON.stringify(body || {}),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    const error = new Error(result.error || 'HiveConnect could not complete that account operation.');
    error.code = result.code || 'hiveconnect_auth_error';
    throw error;
  }
  return result;
}

// Markdown-lite: code blocks, inline code, bold, italic, links, mentions
function renderContent(text) {
  const stash = [];
  let t = text;
  // fenced code blocks
  t = t.replace(/```([\s\S]*?)```/g, (_, code) => {
    stash.push(`<pre><code>${escapeHtml(code.replace(/^\n|\n$/g,''))}</code></pre>`);
    return `\x00${stash.length - 1}\x00`;
  });
  // inline code
  t = t.replace(/`([^`\n]+)`/g, (_, code) => {
    stash.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00${stash.length - 1}\x00`;
  });
  t = escapeHtml(t);
  // links [text](url)
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // bare urls
  t = t.replace(/(?<!href="|">)(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  // bold / italic
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // mentions
  const names = [...profiles.values()].map(p => escapeRegex(p.username)).sort((a,b) => b.length - a.length);
  if (names.length) {
    const re = new RegExp(`@(${names.join('|')})(?![\\w.-])`, 'gi');
    t = t.replace(re, (m, uname) => {
      const mine = me && uname.toLowerCase() === me.username.toLowerCase();
      return `<span class="mention${mine ? ' me' : ''}">${m}</span>`;
    });
  }
  // restore stashed code
  t = t.replace(/\x00(\d+)\x00/g, (_, i) => stash[+i]);
  return t;
}

// ---------- Auth ----------
$('auth-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('auth-submit'); btn.disabled = true; btn.textContent = 'Signing in…';
  const { error } = await sb.auth.signInWithPassword({
    email: $('auth-email').value.trim(),
    password: $('auth-password').value,
  });
  btn.disabled = false; btn.textContent = 'Sign in';
  if (error) { const el = $('auth-error'); el.textContent = error.message; el.classList.remove('hidden'); }
});
// sign-out now lives in the Settings menu (#sm-signout)

// ---------- Forgot password ----------
{
  const fb = $('auth-forgot');
  if (fb) fb.addEventListener('click', async () => {
    const email = ($('auth-email').value || '').trim();
    const el = $('auth-error'); el.classList.remove('hidden'); el.style.color = '';
    if (!email) { el.textContent = 'Type your email above first, then tap “Forgot password”.'; return; }
    fb.disabled = true; fb.textContent = 'Sending…';
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin });
    fb.disabled = false; fb.textContent = 'Forgot password?';
    if (error) { el.style.color = ''; el.textContent = error.message; }
    else { el.style.color = '#4c8a5f'; el.textContent = '✓ Reset link sent to ' + email + ' — check your inbox (and spam).'; }
  });
}
// When the user returns via a password-reset email, let them set a new one.
try {
  sb.auth.onAuthStateChange((event) => { if (event === 'PASSWORD_RECOVERY') promptNewPassword(); });
} catch (e) {}
function promptNewPassword() {
  if (document.getElementById('recovery-overlay')) return;
  const ov = document.createElement('div'); ov.id = 'recovery-overlay'; ov.className = 'modal-backdrop'; ov.style.zIndex = '200';
  ov.innerHTML = '<div class="modal" style="max-width:380px"><h2>Set a new password</h2>' +
    '<label class="auth-label" style="display:block;margin-bottom:5px">New password</label>' +
    '<input type="password" id="rec-pw" placeholder="At least 8 characters" class="rec-input">' +
    '<div id="rec-msg" class="auth-error hidden" style="margin-top:8px"></div>' +
    '<div style="margin-top:18px;text-align:right"><button class="primary-btn" id="rec-save">Save password</button></div></div>';
  document.body.appendChild(ov);
  const save = document.getElementById('rec-save');
  save.onclick = async () => {
    const pw = document.getElementById('rec-pw').value || ''; const msg = document.getElementById('rec-msg');
    msg.classList.remove('hidden'); msg.style.color = '';
    if (pw.length < 8) { msg.textContent = 'At least 8 characters.'; return; }
    const { error } = await sb.auth.updateUser({ password: pw });
    if (error) { msg.textContent = error.message; return; }
    msg.style.color = '#4c8a5f'; msg.textContent = 'Password updated — signing you in…';
    setTimeout(() => { ov.remove(); location.reload(); }, 1200);
  };
}

let joining = false;
async function boot() {
  // invite-link join flow — takes over the page; don't let an existing session boot the app
  const inviteToken = new URLSearchParams(location.search).get('invite');
  if (inviteToken) {
    joining = true;
    await sb.auth.signOut().catch(() => {}); // start clean so a stale session can't override
    await startJoinFlow(inviteToken);
    return;
  }

  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    // Mounted inside HiveLogic, a missing session is a hand-off still in
    // flight or one that failed -- never an invitation to log in, because
    // these are different accounts on a different project. The bridge
    // reports its own failure.
    if (!window.__hiveconnectBridging && !window.__hiveconnectBridgedSession) {
      authScreen.classList.remove('hidden');
    }
    return;
  }
  sb.realtime.setAuth(session.access_token);
  await loadEverything(session.user.id);
  authScreen.classList.add('hidden');
  app.classList.remove('hidden');
}
sb.auth.onAuthStateChange((event, session) => {
  if (joining) return; // invite-link join flow handles sign-in itself
  if (event === 'SIGNED_IN' && session && !me) {
    sb.realtime.setAuth(session.access_token);
    loadEverything(session.user.id).then(() => {
      authScreen.classList.add('hidden');
      app.classList.remove('hidden');
    });
  }
  if (event === 'TOKEN_REFRESHED' && session) sb.realtime.setAuth(session.access_token);
});

// ---------- Invite-link join flow ----------
async function startJoinFlow(token) {
  const join = $('join-screen');
  const { data: info } = await sb.rpc('invite_info', { p_token: token });
  if (!info || !info.valid) {
    join.classList.remove('hidden');
    $('join-form').classList.add('hidden');
    $('join-h1').textContent = 'Invite unavailable';
    $('join-sub').textContent = (info && info.reason) || 'This link is not valid.';
    $('join-note').textContent = 'Ask an admin for a fresh invite link.';
    return;
  }
  join.classList.remove('hidden');
  if (info.workspace) { $('join-h1').textContent = 'Join ' + info.workspace; }
  $('join-sub').textContent = "You've been invited as a " + info.role;
  if (info.email) {
    $('join-email').value = info.email;
    $('join-email').readOnly = true;
    $('join-email').style.opacity = '.7';
  }
  // auto username from name
  $('join-name').addEventListener('input', () => {
    if (!$('join-username').dataset.touched) $('join-username').value = slugUsername($('join-name').value);
  });
  $('join-username').addEventListener('input', () => { $('join-username').dataset.touched = '1'; });
  $('join-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('join-submit'); const err = $('join-error');
    err.classList.add('hidden');
    const name = $('join-name').value.trim();
    const email = ($('join-email').value || info.email || '').trim();
    const un = ($('join-username').value.trim() || slugUsername(name)).toLowerCase();
    const pw = $('join-password').value;
    if (!name) { err.textContent = 'Please enter your name.'; err.classList.remove('hidden'); return; }
    if (pw.length < 8) { err.textContent = 'Password must be at least 8 characters.'; err.classList.remove('hidden'); return; }
    btn.disabled = true; btn.textContent = 'Joining…';
    let data;
    try {
      data = await hiveConnectAccountAction('redeem_invite', {
        token,
        displayName: name,
        username: un,
        email,
        password: pw,
      }, false);
    } catch (error) {
      err.textContent = error.message;
      err.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Join →';
      return;
    }
    // log in with the password they just set
    const { error: le } = await sb.auth.signInWithPassword({ email: data.email, password: pw });
    if (le) { err.textContent = 'Account created — please sign in.'; err.classList.remove('hidden'); location.href = location.pathname; return; }
    // strip the token from the URL and enter the app
    history.replaceState({}, '', location.pathname);
    join.classList.add('hidden');
    await loadEverything((await sb.auth.getSession()).data.session.user.id);
    $('app').classList.remove('hidden');
  });
}

// ---------- Data loading ----------
async function loadEverything(myId) {
  if (loadEverythingStarted) return; // already booting/booted elsewhere (SIGNED_IN listener + boot() can race) -- re-running this double-subscribes realtime and throws
  loadEverythingStarted = true;
  const [pRes, cRes, mRes] = await Promise.all([
    sb.from('profiles').select('*'),
    sb.from('channels').select('*').order('name'),
    sb.from('channel_members').select('*').eq('user_id', myId),
  ]);
  (pRes.data || []).forEach(p => profiles.set(p.id, p));
  (cRes.data || []).forEach(c => channels.set(c.id, c));
  (mRes.data || []).forEach(m => memberships.set(m.channel_id, m));
  me = profiles.get(myId);
  window.me = me;
  if (!me) { // profile trigger raced; retry once
    const { data } = await sb.from('profiles').select('*').eq('id', myId).single();
    if (data) { profiles.set(data.id, data); me = data; window.me = me; }
  }
  if (!me) { // session invalid / profile unreadable — fall back to the login screen
    await sb.auth.signOut().catch(() => {});
    app.classList.add('hidden');
    authScreen.classList.remove('hidden');
    return;
  }

  // deactivated accounts can't use the app
  if (me && me.active === false) {
    await sb.auth.signOut();
    document.body.innerHTML = '<div style="height:100vh;display:flex;align-items:center;justify-content:center;font-family:Montserrat,sans-serif;color:#8b92a8;background:#10151f">Your account has been deactivated. Contact an admin.</div>';
    throw new Error('deactivated');
  }

  // sidebar footer
  $('me-avatar').replaceWith(Object.assign(avatarEl(me), { id: 'me-avatar' }));
  $('me-name').textContent = me.display_name;

  $('me-role').textContent = me.role || 'member';

  // show admin entry points for owner/admin
  if (me.role === 'owner' || me.role === 'admin') {
    { const _a = $('admin-btn'); if (_a) _a.classList.remove('hidden'); }
    $('sm-admin').classList.remove('hidden');
  }
  // reflect saved notification preference
  $('sm-notif-state').textContent = notifsEnabled ? 'On' : 'Off';

  await Promise.all([loadUnreads(), loadNotifications(), loadWorkspaceName()]);
  renderSidebar();
  loadContacts().then(renderSidebar);   // for Messages folder grouping by contact type
  subscribeRealtime();
  subscribePresence();
  subscribeHuddles();
  subscribeChirp();

  // Land on Messages, not whatever channel happens to sort first alphabetically
  // (previously fell back to the first non-DM channel when no #general channel
  // existed, which for admin accounts meant auto-opening "Admin Hub").
  setNavTab('messages');
}

async function loadUnreads() {
  const jobs = [...channels.values()].map(async c => {
    const since = memberships.get(c.id)?.last_read_at || '1970-01-01';
    const { count } = await sb.from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('channel_id', c.id).is('thread_parent_id', null)
      .neq('user_id', me.id).gt('created_at', since);
    unreads.set(c.id, count || 0);
  });
  await Promise.all(jobs);
}

async function loadNotifications() {
  const { data } = await sb.from('notifications')
    .select('*').order('created_at', { ascending: false }).limit(50);
  notifications = data || [];
  renderBell();
}

// ---------- Sidebar ----------
function avatarWithPresence(p) {
  const wrap = document.createElement('span'); wrap.className = 'avatar-wrap';
  wrap.appendChild(avatarEl(p, 'mini-avatar'));
  const dot = document.createElement('span');
  dot.className = 'presence-dot' + (p && onlineUsers.has(p.id) ? ' online' : '');
  wrap.appendChild(dot);
  return wrap;
}

const DIVISIONS = [
  { key: 'clients',  label: 'Client',   icon: '👥', color: '#3b82f6' },
  { key: 'vendors',  label: 'Vendor',   icon: '🚚', color: '#f59e0b' },
  { key: 'team',     label: 'Team',     icon: '🧰', color: '#10b981' },
  { key: 'channels', label: 'Channels', icon: '💬', color: '#8b5cf6' },
];
const collapsed = new Set(hcPrefJson('hcCollapsed', 'hive_collapsed', []));
function saveCollapsed() { hcPrefSet('hcCollapsed', 'hive_collapsed', [...collapsed]); }

// ---------- Channel archive (creator or owner/admin) ----------
let archivedOpen = false; // Archived section starts collapsed/hidden by default
function canArchiveChannel(c) {
  return !!(c && c.type !== 'dm' && me && (me.role === 'owner' || me.role === 'admin' || c.created_by === me.id));
}
function hcEnsureArchiveCss() {
  if (document.getElementById('hc-archive-css')) return;
  const s = document.createElement('style'); s.id = 'hc-archive-css';
  s.textContent =
    '.division .channel-list li .ch-gear{position:absolute;right:5px;top:50%;transform:translateY(-50%);border:none;background:transparent;color:#c3cbdb;font-size:15px;line-height:1;padding:0 5px;border-radius:6px;cursor:pointer;opacity:0;transition:opacity .12s,background .12s}' +
    '.division .channel-list li:hover .ch-gear{opacity:.85}' +
    '.division .channel-list li:hover .unread{display:none}' +
    '.division .channel-list li .ch-gear:hover{opacity:1;color:#fff;background:rgba(255,255,255,.16)}' +
    '.archived-division .div-badge{background:rgba(138,146,164,.18);color:#aeb6c6}' +
    '.archived-division .div-label{opacity:.85}' +
    '.hc-ch-menu{position:fixed;z-index:9600;min-width:172px;background:#fff;border:1px solid #e3e5ec;border-radius:10px;box-shadow:0 14px 40px rgba(22,30,46,.22);padding:5px}' +
    '.hc-ch-menu-item{display:block;width:100%;text-align:left;border:none;background:transparent;padding:8px 11px;font-size:13px;color:#172030;border-radius:7px;cursor:pointer;font-family:inherit}' +
    '.hc-ch-menu-item:hover{background:#f0f2f7}' +
    '.hc-arch-banner{display:flex;align-items:center;gap:10px;justify-content:space-between;margin:0 0 10px;padding:9px 13px;background:rgba(138,146,164,.12);border:1px solid rgba(138,146,164,.30);border-radius:9px;font-size:12.5px;color:#5c6578}' +
    '.hc-arch-banner b{color:#172030}' +
    '.hc-arch-banner button{border:1px solid #748a9e;background:#fff;color:#172030;font-weight:700;font-size:12px;padding:5px 12px;border-radius:8px;cursor:pointer;font-family:inherit;flex:none}' +
    '.hc-arch-banner button:hover{background:#f4f6fa}';
  document.head.appendChild(s);
}
function closeChannelMenu() { document.querySelectorAll('.hc-ch-menu').forEach(m => m.remove()); }
function openChannelMenu(anchor, c, ev) {
  hcEnsureArchiveCss();
  closeChannelMenu();
  const menu = document.createElement('div'); menu.className = 'hc-ch-menu';
  const item = document.createElement('button'); item.type = 'button'; item.className = 'hc-ch-menu-item';
  item.textContent = c.archived ? 'Unarchive channel' : 'Archive channel';
  item.onclick = (e) => { e.stopPropagation(); closeChannelMenu(); archiveChannel(c, !c.archived); };
  menu.appendChild(item);
  document.body.appendChild(menu);
  const r = (anchor && anchor.getBoundingClientRect) ? anchor.getBoundingClientRect() : null;
  let x = (ev && ev.clientX) ? ev.clientX : (r ? r.right : 40);
  let y = (ev && ev.clientY) ? ev.clientY : (r ? r.bottom : 40);
  x = Math.min(x, window.innerWidth - 190);
  y = Math.min(y + 4, window.innerHeight - 60);
  menu.style.left = Math.max(8, x) + 'px';
  menu.style.top = Math.max(8, y) + 'px';
  setTimeout(() => document.addEventListener('click', function h() { closeChannelMenu(); document.removeEventListener('click', h); }), 0);
}
async function archiveChannel(c, makeArchived) {
  if (!canArchiveChannel(c)) { alert('Only the channel creator or an admin can archive this channel.'); return; }
  if (makeArchived && !confirm('Archive #' + c.name + '?\n\nIt moves to the Archived section at the bottom of the sidebar. Messages and members are kept — you can unarchive it anytime.')) return;
  const { error } = await sb.rpc('archive_channel', { cid: c.id, is_archived: makeArchived });
  if (error) { alert(error.message || 'Could not update the channel.'); return; }
  c.archived = makeArchived;
  if (makeArchived) archivedOpen = true; // reveal the Archived section so it's clear where the channel went
  renderSidebar();
  if (currentChannelId === c.id) updateArchivedBanner();
}
function updateArchivedBanner() {
  let banner = document.getElementById('hc-arch-banner');
  const c = channels.get(currentChannelId);
  const show = !!(c && c.type !== 'dm' && c.archived);
  if (!show) { if (banner) banner.remove(); return; }
  hcEnsureArchiveCss();
  if (!banner) {
    banner = document.createElement('div'); banner.id = 'hc-arch-banner'; banner.className = 'hc-arch-banner';
    if (messagesEl && messagesEl.parentNode) messagesEl.parentNode.insertBefore(banner, messagesEl);
  }
  banner.innerHTML = '';
  const txt = document.createElement('span');
  txt.innerHTML = '<b>#' + esc(c.name) + '</b> is archived — hidden from the channel list.';
  banner.appendChild(txt);
  if (canArchiveChannel(c)) {
    const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = 'Unarchive';
    btn.onclick = () => archiveChannel(c, false);
    banner.appendChild(btn);
  }
}
function renderArchivedSection(wrap) {
  const archived = [...channels.values()].filter(c => c.type !== 'dm' && c.archived)
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  if (!archived.length) return;
  const el = document.createElement('div');
  el.className = 'division archived-division' + (archivedOpen ? '' : ' collapsed');
  el.style.setProperty('--cat', '#8a92a4');
  const head = document.createElement('button'); head.className = 'div-head archived-head';
  head.innerHTML =
    '<span class="div-badge">🗄️</span>' +
    '<span class="div-label">Archived</span>' +
    '<span class="div-count">' + archived.length + '</span>' +
    '<span class="div-chev">▾</span>';
  head.onclick = () => { archivedOpen = !archivedOpen; renderSidebar(); };
  el.appendChild(head);
  const body = document.createElement('div'); body.className = 'div-body';
  const ul = document.createElement('ul'); ul.className = 'channel-list';
  archived.forEach(c => ul.appendChild(channelRow(c)));
  body.appendChild(ul);
  el.appendChild(body);
  wrap.appendChild(el);
}

function channelRow(c) {
  const li = document.createElement('li');
  const unread = unreads.get(c.id) || 0;
  const dot = document.createElement('span'); dot.className = 'cdot';
  li.appendChild(dot);
  li.innerHTML += `<span class="hash">${c.type === 'private' ? '🔒' : '#'}</span><span class="cname"></span>`;
  li.querySelector('.cname').textContent = c.name;
  if (c.id === currentChannelId) li.classList.add('active');
  if (unread > 0) {
    li.classList.add('has-unread');
    const b = document.createElement('span'); b.className = 'unread'; b.textContent = unread; li.appendChild(b);
  }
  if (huddleParticipants(c.id).length) {
    const h = document.createElement('span'); h.className = 'huddle-badge'; h.textContent = '🎧';
    h.title = 'HiveVideo in progress'; li.appendChild(h);
  }
  if (canArchiveChannel(c)) {
    hcEnsureArchiveCss();
    const gear = document.createElement('button');
    gear.type = 'button'; gear.className = 'ch-gear';
    gear.textContent = '⋯'; gear.title = 'Channel options'; gear.setAttribute('aria-label', 'Channel options');
    gear.onclick = (e) => { e.stopPropagation(); openChannelMenu(gear, c); };
    li.appendChild(gear);
    li.oncontextmenu = (e) => { e.preventDefault(); openChannelMenu(gear, c, e); };
  }
  li.onclick = () => openChannel(c.id);
  return li;
}

function renderSidebar() {
  const wrap = $('divisions'); wrap.innerHTML = '';

  const allChans = [...channels.values()].filter(c => c.type !== 'dm' && !c.archived);
  for (const div of applyStoredOrder(DIVISIONS, d => d.key, 'hcDivOrder')) {
    const chans = allChans.filter(c => (c.category || 'channels') === div.key)
      .sort((a,b) => (a.name || '').localeCompare(b.name || ''));
    if (!chans.length) continue;
    const unreadTotal = chans.reduce((s,c) => s + (unreads.get(c.id) || 0), 0);
    const isCollapsed = collapsed.has(div.key);

    const el = document.createElement('div');
    el.className = 'division' + (isCollapsed ? ' collapsed' : '');
    el.style.setProperty('--cat', div.color);
    el.dataset.key = div.key;
    const head = document.createElement('button'); head.className = 'div-head';
    head.innerHTML =
      `<span class="fold-grip" aria-hidden="true">⠿</span>` +
      `<span class="div-bar" style="background:${div.color}"></span>` +
      `<span class="div-badge" style="background:${hexA(div.color,.16)};color:${div.color}">${div.icon}</span>` +
      `<span class="div-label">${div.label}</span>` +
      `<span class="div-count">${unreadTotal || ''}</span>` +
      `<span class="div-chev">▾</span>`;
    head.onclick = () => {
      collapsed.has(div.key) ? collapsed.delete(div.key) : collapsed.add(div.key);
      saveCollapsed(); renderSidebar();
    };
    el.appendChild(head);
    const body = document.createElement('div'); body.className = 'div-body';
    const ul = document.createElement('ul'); ul.className = 'channel-list';
    chans.forEach(c => ul.appendChild(channelRow(c)));
    body.appendChild(ul);
    el.appendChild(body);
    wrap.appendChild(el);
  }
  enableFolderDrag(wrap, '.div-head', '.division', 'key', 'hcDivOrder');
  renderArchivedSection(wrap);

  renderMessagesPanel();
  if (typeof navTab !== 'undefined' && navTab === 'huddles') renderHuddlesPanel();
}

// ---- Messages panel: DMs organized into Team / Vendor / Client / External folders ----
const MSG_ORDER = [['team', 'Team'], ['vendor', 'Vendor'], ['client', 'Client'], ['external', 'External']];
const msgOpen = { Team: true, Vendor: true, Client: true, External: true };
function dmContactType(otherId) {
  const c = contactsData.find(x => x.profile_id === otherId);
  if (c) return c.contact_type;
  const p = profiles.get(otherId);
  return (p && p.role === 'guest') ? 'external' : 'team';
}
function renderMessagesPanel() {
  const el = $('panel-messages'); if (!el) return; el.innerHTML = '';
  const nb = document.createElement('button'); nb.className = 'new-channel-cta'; nb.id = 'new-dm-btn';
  nb.innerHTML = '<span>＋</span> New message'; nb.onclick = (e) => { e.stopPropagation(); openCompose(); };
  el.appendChild(nb);
  const dms = [...channels.values()].filter(c => c.type === 'dm' && memberships.has(c.id) && dmOther(c));
  const grouped = { team: [], vendor: [], client: [], external: [] };
  dms.forEach(c => { const o = dmOther(c); const t = isGroupDM(c) ? 'team' : (o ? dmContactType(o.id) : 'team'); (grouped[t] || grouped.team).push(c); });
  // Always show all four folders (Team / Vendor / Client / External) — even when empty.
  applyStoredOrder(MSG_ORDER, x => x[0], 'hcMsgOrder').forEach(([type, label]) => {
    const list = (grouped[type] || []).sort((a, b) => (dmLastActivity(b) || '').localeCompare(dmLastActivity(a) || ''));
    const unreadTotal = list.reduce((s, c) => s + (unreads.get(c.id) || 0), 0);
    const folder = document.createElement('div'); folder.className = 'ct-folder' + (msgOpen[label] ? '' : ' collapsed'); folder.dataset.type = type; folder.dataset.folder = label;
    const head = document.createElement('button'); head.className = 'ct-head';
    const grip = document.createElement('span'); grip.className = 'fold-grip'; grip.textContent = '⠿'; grip.setAttribute('aria-hidden', 'true'); head.appendChild(grip);
    const chev = document.createElement('span'); chev.className = 'ct-chev'; chev.textContent = '▾'; head.appendChild(chev);
    const fn = document.createElement('span'); fn.className = 'ct-fname'; fn.textContent = label; head.appendChild(fn);
    const fc = document.createElement('span'); fc.className = 'ct-fcount'; fc.textContent = unreadTotal || ''; head.appendChild(fc);
    head.onclick = () => { const col = folder.classList.toggle('collapsed'); msgOpen[label] = !col; };
    folder.appendChild(head);
    const body = document.createElement('div'); body.className = 'ct-body';
    const ul = document.createElement('ul'); ul.className = 'channel-list';
    if (!list.length) { const em = document.createElement('div'); em.className = 'ct-empty'; em.textContent = 'No conversations yet'; ul.appendChild(em); }
    list.forEach(c => {
      const li = document.createElement('li');
      if (isGroupDM(c)) {
        const grp = partStrip(dmOtherProfiles(c), 2); grp.classList.add('dm-grp-av'); li.appendChild(grp);
        const nm = document.createElement('span'); nm.className = 'cname'; nm.textContent = dmGroupLabel(c); li.appendChild(nm);
      } else {
        const other = dmOther(c);
        li.appendChild(avatarWithPresence(other));
        const nm = document.createElement('span'); nm.className = 'cname'; nm.textContent = other ? other.display_name : 'DM'; li.appendChild(nm);
      }
      const unread = unreads.get(c.id) || 0;
      if (c.id === currentChannelId) li.classList.add('active');
      if (unread > 0) { li.classList.add('has-unread'); const b = document.createElement('span'); b.className = 'unread'; b.textContent = unread; li.appendChild(b); }
      const hv = document.createElement('span'); hv.className = 'dm-hv'; hv.title = 'Start HiveVideo';
      hv.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>';
      hv.onclick = async (e) => { e.stopPropagation(); if (currentChannelId !== c.id) await openChannel(c.id); joinHuddle(c.id); };
      li.appendChild(hv);
      if (huddleParticipants(c.id).length) { const h = document.createElement('span'); h.className = 'huddle-badge'; h.textContent = '🎧'; li.appendChild(h); }
      li.onclick = () => openChannel(c.id);
      ul.appendChild(li);
    });
    body.appendChild(ul); folder.appendChild(body); el.appendChild(folder);
  });
  enableFolderDrag(el, '.ct-head', '.ct-folder', 'type', 'hcMsgOrder');
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`;
}
function dmLastActivity(c) {
  // best-effort: use membership last_read or channel created; live msgs update via realtime re-render
  return (memberships.get(c.id)?.last_read_at) || c.created_at || '';
}

function dmOther(channel) {
  if (!channel.dm_key) return null;
  const ids = channel.dm_key.split(':');
  const otherId = ids.find(id => id !== me.id) || me.id;
  return profiles.get(otherId);
}

function channelLabel(c) {
  if (c.type === 'dm') { if (isGroupDM(c)) return dmGroupLabel(c); const o = dmOther(c); return o ? o.display_name : 'DM'; }
  return `${c.type === 'private' ? '🔒 ' : '#'}${c.name}`;
}

// ---------- Channel open / messages ----------
async function openChannel(channelId) {
  currentChannelId = channelId;
  closeThread();
  const c = channels.get(channelId);
  // Opening a conversation IS the current activity → make sure the rail + header reflect it
  if (navTab === 'people' || navTab === 'huddles') setNavTab(c && c.type === 'dm' ? 'messages' : 'channels');
  else updateMainHeader();
  { const g = $('channel-settings-btn'); if (g) g.classList.toggle('hidden', !(c && c.type !== 'dm' && (me.role === 'owner' || me.role === 'admin'))); }
  messagesEl.innerHTML = '<div class="notif-empty">Loading…</div>';

  // auto-join public channels (guests never auto-join — invite only)
  if (!memberships.has(channelId) && c.type === 'public' && me.role !== 'guest') {
    const { data } = await sb.from('channel_members')
      .upsert({ channel_id: channelId, user_id: me.id }, { onConflict: 'channel_id,user_id' })
      .select().single();
    if (data) memberships.set(channelId, data);
  }

  const { data: msgs } = await sb.from('messages')
    .select('*').eq('channel_id', channelId).is('thread_parent_id', null)
    .order('created_at', { ascending: true }).limit(300);

  messagesCache.clear(); reactionsCache.clear();
  (msgs || []).forEach(m => messagesCache.set(m.id, m));
  await loadReactions((msgs || []).map(m => m.id));

  renderMessages();
  markRead(channelId);
  renderSidebar();
  updateArchivedBanner();
  refreshPinCount();
  $('pinned-panel').classList.add('hidden');
  renderHuddleUI();
  composerInput.focus();
}

async function loadReactions(ids) {
  if (!ids.length) return;
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await sb.from('reactions').select('*').in('message_id', ids.slice(i, i + 100));
    (data || []).forEach(r => {
      if (!reactionsCache.has(r.message_id)) reactionsCache.set(r.message_id, []);
      reactionsCache.get(r.message_id).push(r);
    });
  }
}

async function markRead(channelId) {
  unreads.set(channelId, 0);
  const now = new Date().toISOString();
  const m = memberships.get(channelId);
  if (m) {
    m.last_read_at = now;
    await sb.from('channel_members').update({ last_read_at: now })
      .eq('channel_id', channelId).eq('user_id', me.id);
  }
}

function renderMessages() {
  messagesEl.innerHTML = '';
  const msgs = [...messagesCache.values()]
    .filter(m => m.channel_id === currentChannelId && !m.thread_parent_id)
    .sort((a,b) => a.created_at.localeCompare(b.created_at));
  let lastDay = '', lastAuthor = '', lastTs = 0;
  for (const m of msgs) {
    const day = fmtDay(m.created_at);
    if (day !== lastDay) {
      const d = document.createElement('div'); d.className = 'day-divider'; d.textContent = day;
      messagesEl.appendChild(d);
      lastDay = day; lastAuthor = '';
    }
    const grouped = m.user_id === lastAuthor && (new Date(m.created_at) - lastTs) < 5 * 60 * 1000 && !m.deleted_at;
    messagesEl.appendChild(msgEl(m, grouped, false));
    lastAuthor = m.user_id; lastTs = new Date(m.created_at).getTime();
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function msgEl(m, grouped, inThread) {
  const p = profiles.get(m.user_id);
  const div = document.createElement('div');
  div.className = 'msg' + (grouped ? ' grouped' : '');
  div.dataset.id = m.id;

  if (grouped) {
    const sp = document.createElement('div'); sp.className = 'avatar-spacer'; div.appendChild(sp);
  } else {
    div.appendChild(avatarEl(p));
  }

  const body = document.createElement('div'); body.className = 'msg-body';
  if (!grouped) {
    const head = document.createElement('div'); head.className = 'msg-head';
    head.innerHTML = `<span class="msg-author"></span>${p && p.username === 'reina' ? '<span class="bot-badge">BOT</span>' : ''}<span class="msg-time">${fmtTime(m.created_at)}</span>`;
    head.querySelector('.msg-author').textContent = p ? p.display_name : 'Unknown';
    body.appendChild(head);
  }

  // pinned flag
  if (m.pinned_at && !m.deleted_at) {
    const flag = document.createElement('div'); flag.className = 'pin-flag';
    const by = profiles.get(m.pinned_by);
    flag.textContent = '📌 Pinned' + (by ? ' by ' + by.display_name : '');
    body.appendChild(flag);
  }

  const content = document.createElement('div'); content.className = 'msg-content';
  if (m.deleted_at) {
    content.innerHTML = '<span class="deleted">This message was deleted</span>';
  } else {
    content.innerHTML = renderContent(m.content) +
      (m.edited_at ? '<span class="edited-tag">(edited)</span>' : '');
  }
  body.appendChild(content);

  // attachment
  if (m.attachment_url && !m.deleted_at) {
    if (IMG_TYPES.test(m.attachment_type || '')) {
      const a = document.createElement('a');
      a.href = m.attachment_url; a.target = '_blank'; a.rel = 'noopener';
      const img = document.createElement('img');
      img.className = 'attach-img'; img.loading = 'lazy'; img.src = m.attachment_url; img.alt = m.attachment_name || 'photo';
      a.appendChild(img);
      body.appendChild(a);
    } else {
      const chip = document.createElement('a');
      chip.className = 'file-chip'; chip.href = m.attachment_url; chip.target = '_blank'; chip.rel = 'noopener';
      chip.innerHTML = '<span class="fc-icon">📄</span><span class="fc-name"></span>';
      chip.querySelector('.fc-name').textContent = m.attachment_name || 'file';
      body.appendChild(chip);
    }
  }

  // reactions
  const rx = reactionsCache.get(m.id) || [];
  if (rx.length && !m.deleted_at) {
    const wrap = document.createElement('div'); wrap.className = 'reactions';
    const byEmoji = {};
    rx.forEach(r => { (byEmoji[r.emoji] = byEmoji[r.emoji] || []).push(r.user_id); });
    for (const [emoji, users] of Object.entries(byEmoji)) {
      const b = document.createElement('button');
      b.className = 'reaction' + (users.includes(me.id) ? ' mine' : '');
      b.innerHTML = `${esc(emoji)} <span class="count">${users.length}</span>`;
      b.title = users.map(u => profiles.get(u)?.display_name || '?').join(', ');
      b.onclick = () => toggleReaction(m.id, emoji);
      wrap.appendChild(b);
    }
    body.appendChild(wrap);
  }

  // thread link
  if (!inThread && m.reply_count > 0 && !m.deleted_at) {
    const tl = document.createElement('button'); tl.className = 'thread-link';
    tl.innerHTML = `💬 ${m.reply_count} ${m.reply_count === 1 ? 'reply' : 'replies'}`;
    tl.onclick = () => openThread(m.id);
    body.appendChild(tl);
  }

  div.appendChild(body);

  // hover tools
  if (!m.deleted_at) {
    const tools = document.createElement('div'); tools.className = 'msg-tools';
    const btn = (label, title, fn) => {
      const b = document.createElement('button'); b.textContent = label; b.title = title; b.onclick = fn;
      tools.appendChild(b);
    };
    btn('😊', 'React', e => openEmojiPicker(e, m.id));
    if (!inThread) btn('💬', 'Reply in thread', () => openThread(m.id));
    btn('📌', m.pinned_at ? 'Unpin' : 'Pin', () => togglePin(m));
    btn('✅', 'Create task from this message', () => {
      const ch = channels.get(m.channel_id);
      const isDm = ch && ch.type === 'dm';
      openTaskQuickCreateFromSource({
        type: isDm ? 'message' : (inThread ? 'thread_reply' : 'channel_post'),
        sourceMessageId: m.id, sourceChannelId: m.channel_id,
        subject: isDm ? ('DM with ' + (profiles.get(m.user_id)?.display_name || 'someone')) : ('#' + (ch ? ch.name : 'channel')),
        sender: profiles.get(m.user_id)?.display_name || profiles.get(m.user_id)?.username || '?',
        preview: (m.content || '').slice(0, 200),
      });
    });
    if (m.user_id === me.id) {
      btn('✏️', 'Edit', () => startEdit(div, m));
      btn('🗑️', 'Delete', () => deleteMessage(m));
    }
    div.appendChild(tools);
  }
  return div;
}

function rerenderMessage(id) {
  const m = messagesCache.get(id);
  if (!m) return;
  document.querySelectorAll(`.msg[data-id="${id}"]`).forEach(old => {
    const inThread = !!old.closest('.thread-messages');
    const grouped = old.classList.contains('grouped');
    old.replaceWith(msgEl(m, grouped, inThread));
  });
}

// ---------- Sending ----------
async function sendMessage(content, threadParentId = null, attachment = null) {
  if (window.hlSfx) hlSfx.play('swoosh');
  content = (content || '').trim();
  if ((!content && !attachment) || !currentChannelId) return;
  const row = {
    channel_id: currentChannelId, user_id: me.id, content,
    thread_parent_id: threadParentId,
  };
  if (attachment) {
    row.attachment_url = attachment.url;
    row.attachment_name = attachment.name;
    row.attachment_type = attachment.type;
  }
  const { error } = await sb.from('messages').insert(row);
  if (error) console.error('send failed', error);
}

// ---------- Uploads ----------
const IMG_TYPES = /^image\//;
async function uploadAndSend(file) {
  if (!file || !currentChannelId) return;
  if (file.size > 50 * 1024 * 1024) { alert('Max file size is 50 MB'); return; }
  const bar = $('upload-bar');
  bar.textContent = `Uploading ${file.name}…`;
  bar.classList.remove('hidden');
  try {
    const safe = file.name.replace(/[^\w.\-]+/g, '_').slice(-80);
    const path = `${currentChannelId}/${crypto.randomUUID()}-${safe}`;
    const { error } = await sb.storage.from('attachments').upload(path, file, { contentType: file.type || 'application/octet-stream' });
    if (error) throw error;
    const { data } = sb.storage.from('attachments').getPublicUrl(path);
    await sendMessage(composerInput.value, currentThreadId, { url: data.publicUrl, name: file.name, type: file.type || '' });
    composerInput.value = ''; autosize(composerInput);
  } catch (e) {
    alert('Upload failed: ' + (e.message || e));
  } finally {
    bar.classList.add('hidden');
  }
}
$('attach-btn').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', e => {
  const f = e.target.files[0];
  e.target.value = '';
  uploadAndSend(f);
});
// paste an image straight into the composer
document.addEventListener('paste', e => {
  if (!me) return;
  const item = [...(e.clipboardData?.items || [])].find(i => i.kind === 'file');
  if (item) { e.preventDefault(); uploadAndSend(item.getAsFile()); }
});
// drag & drop anywhere over the message area
['dragover', 'drop'].forEach(ev => messagesEl.addEventListener(ev, e => e.preventDefault()));
messagesEl.addEventListener('drop', e => {
  const f = e.dataTransfer?.files?.[0];
  if (f) uploadAndSend(f);
});

function wireComposer(textarea, sendBtn, getThreadId) {
  const doSend = () => {
    const v = textarea.value;
    if (!v.trim()) return;
    textarea.value = ''; autosize(textarea);
    sendMessage(v, getThreadId());
  };
  textarea.addEventListener('keydown', e => {
    if ($('mention-menu').classList.contains('hidden') === false && textarea === composerInput) {
      if (['ArrowDown','ArrowUp','Enter','Tab','Escape'].includes(e.key)) { handleMentionKeys(e); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  });
  textarea.addEventListener('input', () => { autosize(textarea); if (textarea === composerInput) updateMentionMenu(); });
  sendBtn.addEventListener('click', doSend);
}
function autosize(t) { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 160) + 'px'; }

wireComposer(composerInput, $('send-btn'), () => null);
wireComposer(threadInput, $('thread-send-btn'), () => currentThreadId);

// ---------- Composer emoji picker (insert into message text) ----------
const COMPOSER_EMOJIS = [
  '😀','😁','😂','🤣','😊','😇','🙂','😉','😍','😘','😜','🤪','😎','🥳','🤩','🤗','🤔','🫡','😐','😴',
  '😅','😬','🙄','😏','😮','😯','😢','😭','😤','😡','🤯','😳','🥺','😱','🤬','🤒','🤕','🤢','🥶','🥵',
  '👍','👎','👌','🤌','✌️','🤞','🤟','🤙','👏','🙌','🙏','💪','🫵','👋','🤝','✍️','👀','🧠','❤️','🧡',
  '💛','💚','💙','💜','🖤','🔥','⭐','✨','💯','✅','❌','⚠️','❓','❗','💤','💬','📌','📍','📎','🗓️',
  '💰','💵','🧾','📈','📉','🛠️','🔧','🔨','🪛','🪜','🧱','🚧','⚡','🔌','💡','🚿','🚰','🪣','🧹','🧯',
  '🏠','🏡','🏢','🏗️','🚚','🚐','🛻','📦','☕','🍕','🍺','🎉','🐝','☀️','🌧️','❄️','👷','🧰','📸','🕐'
];
function insertAtCursor(ta, text) {
  const s = ta.selectionStart ?? ta.value.length, e = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
  const pos = s + text.length;
  ta.selectionStart = ta.selectionEnd = pos;
  ta.focus(); autosize(ta);
}
function openComposerEmoji(e, textarea) {
  const picker = $('emoji-picker');
  picker.innerHTML = '';
  picker.classList.add('wide');
  COMPOSER_EMOJIS.forEach(em => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = em;
    b.onclick = (ev) => { ev.stopPropagation(); insertAtCursor(textarea, em); };
    picker.appendChild(b);
  });
  picker.classList.remove('hidden');
  const r = e.currentTarget.getBoundingClientRect();
  const w = 9 * 32 + 20;
  picker.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
  picker.style.top = Math.max(8, r.top - 250) + 'px';
  e.stopPropagation();
}
$('composer-emoji-btn').addEventListener('click', e => openComposerEmoji(e, composerInput));
$('thread-emoji-btn').addEventListener('click', e => openComposerEmoji(e, threadInput));

// ---------- Mention autocomplete ----------
function mentionQuery() {
  const pos = composerInput.selectionStart;
  const before = composerInput.value.slice(0, pos);
  const match = before.match(/(?:^|\s)@([\w.-]*)$/);
  return match ? match[1] : null;
}
function updateMentionMenu() {
  const q = mentionQuery();
  const menu = $('mention-menu');
  if (q === null) { menu.classList.add('hidden'); return; }
  const opts = [...profiles.values()]
    .filter(p => p.username.toLowerCase().startsWith(q.toLowerCase()) || p.display_name.toLowerCase().startsWith(q.toLowerCase()))
    .slice(0, 6);
  if (!opts.length) { menu.classList.add('hidden'); return; }
  mentionSel = 0;
  menu.innerHTML = '';
  opts.forEach((p, i) => {
    const d = document.createElement('div');
    d.className = 'mi' + (i === 0 ? ' sel' : '');
    d.appendChild(avatarEl(p, 'mini-avatar'));
    const nm = document.createElement('span'); nm.textContent = p.display_name; d.appendChild(nm);
    const un = document.createElement('span'); un.className = 'uname'; un.textContent = '@' + p.username; d.appendChild(un);
    d.onclick = () => insertMention(p);
    menu.appendChild(d);
  });
  menu.dataset.opts = JSON.stringify(opts.map(p => p.id));
  menu.classList.remove('hidden');
}
function handleMentionKeys(e) {
  const menu = $('mention-menu');
  const items = [...menu.querySelectorAll('.mi')];
  if (e.key === 'Escape') { menu.classList.add('hidden'); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); mentionSel = (mentionSel + 1) % items.length; }
  else if (e.key === 'ArrowUp') { e.preventDefault(); mentionSel = (mentionSel - 1 + items.length) % items.length; }
  else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    const ids = JSON.parse(menu.dataset.opts || '[]');
    const p = profiles.get(ids[mentionSel]);
    if (p) insertMention(p);
    return;
  }
  items.forEach((el, i) => el.classList.toggle('sel', i === mentionSel));
}
function insertMention(p) {
  const pos = composerInput.selectionStart;
  const before = composerInput.value.slice(0, pos).replace(/@[\w.-]*$/, '@' + p.username + ' ');
  composerInput.value = before + composerInput.value.slice(pos);
  composerInput.selectionStart = composerInput.selectionEnd = before.length;
  $('mention-menu').classList.add('hidden');
  composerInput.focus();
}

// ---------- Edit / delete ----------
function startEdit(msgDiv, m) {
  const contentEl = msgDiv.querySelector('.msg-content');
  const box = document.createElement('div'); box.className = 'edit-box';
  const ta = document.createElement('textarea'); ta.value = m.content; box.appendChild(ta);
  const actions = document.createElement('div'); actions.className = 'edit-actions';
  const save = document.createElement('button'); save.className = 'edit-save'; save.textContent = 'Save';
  const cancel = document.createElement('button'); cancel.className = 'edit-cancel'; cancel.textContent = 'Cancel';
  actions.append(save, cancel); box.appendChild(actions);
  contentEl.replaceWith(box);
  ta.focus();
  const finish = () => rerenderMessage(m.id);
  cancel.onclick = finish;
  ta.addEventListener('keydown', e => { if (e.key === 'Escape') finish(); });
  save.onclick = async () => {
    const v = ta.value.trim();
    if (v && v !== m.content) {
      await sb.from('messages').update({ content: v, edited_at: new Date().toISOString() }).eq('id', m.id);
      m.content = v; m.edited_at = new Date().toISOString();
    }
    finish();
  };
}
async function deleteMessage(m) {
  await sb.from('messages').update({ deleted_at: new Date().toISOString(), content: '' }).eq('id', m.id);
  m.deleted_at = new Date().toISOString(); m.content = '';
  rerenderMessage(m.id);
}

// ---------- Reactions ----------
async function toggleReaction(messageId, emoji) {
  const rx = reactionsCache.get(messageId) || [];
  const mine = rx.find(r => r.user_id === me.id && r.emoji === emoji);
  if (mine) {
    await sb.from('reactions').delete().eq('message_id', messageId).eq('user_id', me.id).eq('emoji', emoji);
  } else {
    await sb.from('reactions').insert({ message_id: messageId, user_id: me.id, emoji });
  }
}
function openEmojiPicker(e, messageId) {
  const picker = $('emoji-picker');
  picker.innerHTML = '';
  picker.classList.remove('wide');
  EMOJIS.forEach(em => {
    const b = document.createElement('button'); b.textContent = em;
    b.onclick = () => { picker.classList.add('hidden'); toggleReaction(messageId, em); };
    picker.appendChild(b);
  });
  picker.classList.remove('hidden');
  const r = e.target.getBoundingClientRect();
  picker.style.left = Math.min(r.left, window.innerWidth - 300) + 'px';
  picker.style.top = Math.min(r.bottom + 6, window.innerHeight - 200) + 'px';
  e.stopPropagation();
}
document.addEventListener('click', e => {
  if (!e.target.closest('#emoji-picker')) $('emoji-picker').classList.add('hidden');
  if (!e.target.closest('#notif-panel') && !e.target.closest('#bell-btn')) $('notif-panel').classList.add('hidden');
});

// ---------- Pinned messages ----------
async function togglePin(m) {
  const { data, error } = await sb.rpc('toggle_pin', { p_message: m.id });
  if (error) { alert(error.message); return; }
  m.pinned_at = data.pinned ? new Date().toISOString() : null;
  m.pinned_by = data.pinned ? me.id : null;
  rerenderMessage(m.id);
  refreshPinCount();
}
async function refreshPinCount() {
  if (!currentChannelId) return;
  const { count } = await sb.from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('channel_id', currentChannelId).not('pinned_at', 'is', null).is('deleted_at', null);
  const el = $('pin-count'), btn = $('pin-header-btn');
  el.textContent = count || 0;
  el.classList.toggle('hidden', !count);
  btn.classList.toggle('has-pins', !!count);
}
$('pin-header-btn').addEventListener('click', openPinned);
$('pinned-close').addEventListener('click', () => $('pinned-panel').classList.add('hidden'));
async function openPinned() {
  const panel = $('pinned-panel'), list = $('pinned-list');
  list.innerHTML = '<div class="notif-empty">Loading…</div>';
  panel.classList.remove('hidden');
  const { data } = await sb.from('messages')
    .select('*').eq('channel_id', currentChannelId).not('pinned_at', 'is', null).is('deleted_at', null)
    .order('pinned_at', { ascending: false });
  list.innerHTML = '';
  if (!data || !data.length) { list.innerHTML = '<div class="notif-empty">No pinned messages yet. Hover a message and hit 📌 to pin it.</div>'; return; }
  for (const m of data) {
    const p = profiles.get(m.user_id);
    const d = document.createElement('div'); d.className = 'notif-item unread';
    const txt = document.createElement('div');
    txt.innerHTML = `<b></b> · <span class="muted">${fmtTime(m.created_at)}</span><div class="search-snippet"></div>`;
    txt.querySelector('b').textContent = p ? p.display_name : '?';
    txt.querySelector('.search-snippet').textContent = (m.content || '').slice(0, 160) || '(attachment)';
    d.appendChild(txt);
    const unpin = document.createElement('button'); unpin.className = 'mini-btn'; unpin.textContent = 'Unpin';
    unpin.style.marginLeft = 'auto';
    unpin.onclick = async (ev) => { ev.stopPropagation(); await togglePin(m); openPinned(); };
    d.appendChild(unpin);
    d.onclick = () => { $('pinned-panel').classList.add('hidden'); messagesCache.has(m.id) && document.querySelector(`.msg[data-id="${m.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
    list.appendChild(d);
  }
}

// ---------- Threads ----------
async function openThread(parentId) {
  currentThreadId = parentId;
  threadPanel.classList.remove('hidden');
  threadMessagesEl.innerHTML = '<div class="notif-empty">Loading…</div>';
  const parent = messagesCache.get(parentId);
  const { data: replies } = await sb.from('messages')
    .select('*').eq('thread_parent_id', parentId).order('created_at', { ascending: true });
  (replies || []).forEach(m => messagesCache.set(m.id, m));
  await loadReactions((replies || []).map(m => m.id));
  renderThread();
  threadInput.focus();
}
function renderThread() {
  if (!currentThreadId) return;
  threadMessagesEl.innerHTML = '';
  const parent = messagesCache.get(currentThreadId);
  if (parent) threadMessagesEl.appendChild(msgEl(parent, false, true));
  const divider = document.createElement('div'); divider.className = 'day-divider';
  const replies = [...messagesCache.values()]
    .filter(m => m.thread_parent_id === currentThreadId)
    .sort((a,b) => a.created_at.localeCompare(b.created_at));
  divider.textContent = `${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`;
  threadMessagesEl.appendChild(divider);
  replies.forEach(m => threadMessagesEl.appendChild(msgEl(m, false, true)));
  threadMessagesEl.scrollTop = threadMessagesEl.scrollHeight;
}
function closeThread() { currentThreadId = null; threadPanel.classList.add('hidden'); }
$('thread-close').addEventListener('click', closeThread);

// ---------- DMs ----------
async function startDM(otherId) {
  const key = [me.id, otherId].sort().join(':');
  let dm = [...channels.values()].find(c => c.dm_key === key);
  if (!dm) {
    const { data, error } = await sb.from('channels')
      .insert({ type: 'dm', dm_key: key, created_by: me.id }).select().single();
    if (error) { // raced: fetch existing
      const { data: existing } = await sb.from('channels').select('*').eq('dm_key', key).single();
      dm = existing;
    } else {
      dm = data;
      await sb.from('channel_members').insert([
        { channel_id: dm.id, user_id: me.id },
        { channel_id: dm.id, user_id: otherId },
      ]);
    }
    if (dm) channels.set(dm.id, dm);
  }
  if (!dm) return;
  if (!memberships.has(dm.id)) {
    const { data: mem } = await sb.from('channel_members').select('*')
      .eq('channel_id', dm.id).eq('user_id', me.id).single();
    if (mem) memberships.set(dm.id, mem);
  }
  renderSidebar();
  openChannel(dm.id);
}

// ---------- Channel creation ----------
$('new-channel-btn').addEventListener('click', () => {
  $('nc-name').value = ''; $('nc-desc').value = ''; $('nc-private').checked = false;
  $('nc-error').classList.add('hidden');
  $('modal-backdrop').classList.remove('hidden');
  $('nc-name').focus();
});
$('nc-cancel').addEventListener('click', () => $('modal-backdrop').classList.add('hidden'));
$('modal-backdrop').addEventListener('click', e => { if (e.target === e.currentTarget) $('modal-backdrop').classList.add('hidden'); });
$('nc-create').addEventListener('click', async () => {
  const name = $('nc-name').value.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '');
  if (!name) return;
  // Disable + label the button so a submit gives immediate feedback instead of
  // looking dead until the modal closes a beat later.
  const btn = $('nc-create');
  if (btn.disabled) return; // guard double-submit
  const btnLabel = btn.textContent;
  btn.disabled = true; btn.style.opacity = '.6'; btn.style.cursor = 'default'; btn.textContent = 'Creating…';
  const restore = () => { btn.disabled = false; btn.style.opacity = ''; btn.style.cursor = ''; btn.textContent = btnLabel; };
  const { data, error } = await sb.from('channels').insert({
    name, description: $('nc-desc').value.trim() || null,
    type: $('nc-private').checked ? 'private' : 'public',
    category: $('nc-category').value,
    created_by: me.id,
  }).select().single();
  if (error) {
    const el = $('nc-error'); el.textContent = error.message; el.classList.remove('hidden'); restore(); return;
  }
  channels.set(data.id, data);
  const { data: mem } = await sb.from('channel_members')
    .insert({ channel_id: data.id, user_id: me.id }).select().single();
  if (mem) memberships.set(data.id, mem);
  restore();
  $('modal-backdrop').classList.add('hidden');
  renderSidebar();
  openChannel(data.id);
});

// ---------- Notifications ----------
function renderBell() {
  const unread = notifications.filter(n => !n.read).length;
  const badge = $('bell-badge');
  badge.textContent = unread;
  badge.classList.toggle('hidden', unread === 0);
}
$('bell-btn').addEventListener('click', e => {
  e.stopPropagation();
  const panel = $('notif-panel');
  if (!panel.classList.contains('hidden')) { panel.classList.add('hidden'); return; }
  renderNotifPanel();
  panel.classList.remove('hidden');
});
function renderNotifPanel() {
  const list = $('notif-list');
  list.innerHTML = '';
  if (!notifications.length) {
    list.innerHTML = '<div class="notif-empty">Nothing yet — quiet hive 🐝</div>';
    return;
  }
  for (const n of notifications.slice(0, 30)) {
    const actor = profiles.get(n.actor_id);
    const ch = channels.get(n.channel_id);
    const verb = n.kind === 'mention' ? 'mentioned you in' : n.kind === 'thread_reply' ? 'replied to your thread in' : 'sent you a message in';
    const d = document.createElement('div');
    d.className = 'notif-item' + (n.read ? '' : ' unread');
    const txt = document.createElement('div');
    txt.innerHTML = `<b></b> ${verb} <b>${ch ? esc(channelLabel(ch)) : '?'}</b> · <span class="muted">${fmtTime(n.created_at)}</span>`;
    txt.querySelector('b').textContent = actor ? actor.display_name : 'Someone';
    d.appendChild(txt);
    d.onclick = async () => {
      $('notif-panel').classList.add('hidden');
      if (!n.read) { n.read = true; renderBell(); sb.from('notifications').update({ read: true }).eq('id', n.id).then(() => {}); }
      if (n.channel_id) openChannel(n.channel_id);
    };
    list.appendChild(d);
  }
}
$('notif-clear').addEventListener('click', async () => {
  notifications.forEach(n => n.read = true);
  renderBell(); renderNotifPanel();
  await sb.from('notifications').update({ read: true }).eq('user_id', me.id).eq('read', false);
});

// ---------- Presence (online dots) ----------
function subscribePresence() {
  const ch = sb.channel('presence-online', { config: { presence: { key: me.id } } });
  ch.on('presence', { event: 'sync' }, () => {
    const state = ch.presenceState();
    onlineUsers = new Set(Object.keys(state));
    renderSidebar();
    // refresh the me-dot
    document.querySelector('.me-dot')?.classList.toggle('online', onlineUsers.has(me.id));
  }).subscribe(async status => {
    if (status === 'SUBSCRIBED') await ch.track({ online_at: new Date().toISOString() });
  });
}

/* ==================== HUDDLES (video calls) ====================
   One workspace-wide realtime presence channel tracks every huddle.
   A participant tracks { channel_id, ... }; presenceState() -> the full
   map of who is in which huddle, so every client can render live banners.
   Doc fix (2026-08-07, "Jitsi vs paid WebRTC for Huddles"): this comment
   used to say Jitsi (meet.jit.si) provides the audio/video -- stale since
   this was migrated to self-hosted LiveKit (see LIVEKIT_URL below,
   video.hiverorder.com). Jitsi isn't used anywhere in this file; the real
   open question the ticket was actually asking is self-hosted LiveKit
   (current, on Chris's own server) vs. a paid/managed option (LiveKit
   Cloud or a different vendor) -- an infra/cost decision, not a build
   choice still to be made. */
let huddleChannel = null;            // the 'huddles' realtime presence channel
let huddleState = new Map();         // channel_id -> [{user_id, display_name, avatar_url, avatar_color}]
let activeHuddle = null;             // channel_id of the huddle I'm currently in
let lkRoom = null;                   // LiveKit Room instance (self-hosted)
const LIVEKIT_URL = (window.HIVE_CONFIG && window.HIVE_CONFIG.livekitUrl) || 'wss://video.hiverorder.com';
let hudMic = true, hudCam = false, hudScreen = false;   // my local media state in the huddle
let hudConnecting = false;           // true while a LiveKit connect is in flight (guards double-join)
// ---- record / transcription / AI-notes state ----
let hudTranscript = [];              // [{name, uid, text, ts}] full session transcript
let hudSTT = null;                   // browser SpeechRecognition (my own speech)
let hudCC = false;                   // captions panel open?
let hudRec = null;                   // MediaRecorder while recording
let hudRecChunks = [];               // recorded webm chunks
let hudRecStart = 0;                 // recording start ts

function subscribeHuddles() {
  const ch = sb.channel('huddles', { config: { presence: { key: me.id } } });
  huddleChannel = ch;
  ch.on('presence', { event: 'sync' }, () => {
    const state = ch.presenceState ? ch.presenceState() : {};
    const map = new Map();
    for (const key of Object.keys(state)) {
      for (const meta of state[key]) {
        if (!meta || !meta.channel_id) continue;
        if (!map.has(meta.channel_id)) map.set(meta.channel_id, []);
        const arr = map.get(meta.channel_id);
        if (!arr.some(x => x.user_id === meta.user_id)) arr.push(meta);   // one entry per person
      }
    }
    huddleState = map;
    reconcileMyHuddlePresence(map);
    renderHuddleUI();
    renderSidebar();
    updateIncomingCalls();
  }).subscribe();
}

function huddleParticipants(cid) { return huddleState.get(cid) || []; }

/* ---- leaving a call has to actually reach the server ----
   Chris, 2026-08-23: "when i click LEAVE the popup goes away but the call is
   still active and if i hit JOIN it pulls it back up".

   Leaving was written as one unchecked push:

       try { if (huddleChannel && huddleChannel.untrack) huddleChannel.untrack(); } catch (e) {}

   which cannot fail loudly, in two separate ways:

     - untrack() is send({type:'presence'}), and that RESOLVES to 'error' or
       'timed out' when the socket is down. Nothing awaited it, so a refusal
       looked exactly like success -- the same shape of bug as fetch() resolving
       on a 4xx.
     - when the channel is not joined, channelAdapter.push() THROWS, which
       rejects the promise. A synchronous try/catch around a call nobody awaits
       never sees that rejection.

   Either way the dock hid, `activeHuddle` went null, and the server kept
   announcing him in the huddle he had just left. His own stale presence is what
   held the header at "Join (1)", and Join walked him back into it.

   The fix is to stop depending on one push landing: drop myself locally so the
   UI is right immediately, untrack with the result actually checked, and say it
   again on any later sync that still shows me in a call I'm not in. */
let untrackTries = 0;

async function clearMyHuddlePresence() {
  if (!huddleChannel || !huddleChannel.untrack) return false;
  try {
    return (await huddleChannel.untrack()) === 'ok';
  } catch (e) {
    return false;            // push() throws outright when the channel isn't joined
  }
}

// Leaving is a local fact the moment he clicks it. Don't make the UI wait for a
// round-trip that may never come back.
function dropMeFromHuddleState() {
  for (const [cid, parts] of [...huddleState]) {
    const rest = parts.filter(p => p.user_id !== me.id);
    if (rest.length) huddleState.set(cid, rest);
    else huddleState.delete(cid);
  }
}

// Only ever untracks -- never edits huddleState. A second tab where he really IS
// in the call presents under this same key, and presence is per-socket, so
// untracking here cannot take that one down; hiding it locally would.
function reconcileMyHuddlePresence(map) {
  let ghost = false;
  for (const parts of map.values()) if (parts.some(p => p.user_id === me.id)) { ghost = true; break; }
  if (!ghost || activeHuddle) { untrackTries = 0; return; }
  if (untrackTries >= 5) return;      // a server that won't let go must not spin us
  untrackTries++;
  clearMyHuddlePresence();
}

/* ---- incoming-call ring: alert people when a huddle starts in a channel they're in ---- */
let ringSeen = new Set();       // channel_ids currently showing an incoming-call card
let ringDismissed = new Set();  // channel_ids the user dismissed (until the huddle ends)
let ringCtx = null, ringTimer = null;
let ringNotifs = new Map();     // channel_id -> the desktop notification raised for it

function updateIncomingCalls() {
  for (const [cid, parts] of huddleState) {
    const others = parts.filter(p => p.user_id !== me.id);
    const c = channels.get(cid);
    if (cid === activeHuddle || !others.length || !c) { clearRing(cid); continue; }
    const eligible = c.type === 'dm' ? memberships.has(cid) : (memberships.has(cid) || c.type === 'public');
    if (!eligible || ringSeen.has(cid) || ringDismissed.has(cid)) continue;
    ringSeen.add(cid);
    if (window.hlSfx) hlSfx.startLoop('ring', 3200);
    showIncomingCall(cid, others[0], c);
  }
  for (const cid of [...ringSeen]) { if (!huddleState.has(cid) || cid === activeHuddle) clearRing(cid); }
  for (const cid of [...ringDismissed]) { if (!huddleState.has(cid)) ringDismissed.delete(cid); }
}

function ringTone() {
  try {
    ringCtx = ringCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (ringCtx.state === 'suspended') ringCtx.resume();
    const beep = () => {
      [0, 0.28].forEach((off, i) => {
        const o = ringCtx.createOscillator(), g = ringCtx.createGain();
        o.type = 'sine'; o.frequency.value = i ? 620 : 480; o.connect(g); g.connect(ringCtx.destination);
        const t = ringCtx.currentTime + off;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.22, t + 0.04);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
        o.start(t); o.stop(t + 0.24);
      });
    };
    beep(); if (!ringTimer) ringTimer = setInterval(beep, 2600);
  } catch (e) {}
}
function stopRing() { if (ringTimer) { clearInterval(ringTimer); ringTimer = null; } }

function showIncomingCall(cid, caller, c) {
  let stack = $('incoming-calls');
  if (!stack) { stack = document.createElement('div'); stack.id = 'incoming-calls'; stack.className = 'incoming-calls'; document.body.appendChild(stack); }
  if (document.getElementById('inc-' + cid)) return;
  const who = caller.display_name || 'Someone';
  const where = c.type === 'dm' ? 'is calling you' : 'is calling in #' + c.name;
  const card = document.createElement('div'); card.className = 'inc-card'; card.id = 'inc-' + cid;
  const av = avatarEl({ display_name: who, avatar_url: caller.avatar_url, avatar_color: caller.avatar_color }, 'avatar');
  av.classList.add('inc-av'); card.appendChild(av);
  const mid = document.createElement('div'); mid.className = 'inc-mid';
  const w1 = document.createElement('div'); w1.className = 'inc-who'; w1.textContent = who;
  const w2 = document.createElement('div'); w2.className = 'inc-where'; w2.textContent = '🎧 ' + where;
  mid.appendChild(w1); mid.appendChild(w2); card.appendChild(mid);
  const act = document.createElement('div'); act.className = 'inc-actions';
  const join = document.createElement('button'); join.className = 'inc-join'; join.textContent = 'Join';
  join.onclick = async () => { clearRing(cid); if (currentChannelId !== cid) await openChannel(cid); joinHuddle(cid); };
  const dis = document.createElement('button'); dis.className = 'inc-dismiss'; dis.textContent = '✕'; dis.title = 'Dismiss';
  dis.onclick = () => { ringDismissed.add(cid); clearRing(cid); };
  act.appendChild(join); act.appendChild(dis); card.appendChild(act);
  stack.appendChild(card);
  ringTone();
  ringNotify(cid, who, where);
  setTimeout(() => { if (document.getElementById('inc-' + cid)) { ringDismissed.add(cid); clearRing(cid); } }, 35000);
}

/* A call that only exists inside the tab is a call nobody answers.
 *
 * Chris, 2026-08-23: "why did it ask me the select a person to call and then
 * make me again try to invite someone once the HiveVideo window opened?"
 *
 * The ring itself was never missing -- the card, the Join button and the tone
 * have been here since the embed. What was missing is any way for it to leave
 * the page. The card is appended to document.body and the tone is WebAudio, so
 * if the person he called had HiveConnect in a background tab they saw and
 * heard nothing (an unfocused tab draws a card nobody is looking at, and
 * Chrome will not start audio in one without a prior gesture). He waited,
 * nothing happened, and the invite panel was the only way left to reach them.
 *
 * A desktop notification is what crosses that boundary. Not shown when the tab
 * is focused -- the card is right there, and a second alert for the same call
 * is noise.
 *
 * THE REMAINING LIMIT, WRITTEN DOWN SO IT IS NOT REDISCOVERED: this reaches a
 * BACKGROUND tab, not a closed one. Ringing someone who does not have
 * HiveConnect open needs a server-side Web Push, which lives in HiveLogic's
 * own project (api/reina/push.js) against a different subscription table.
 */
function ringNotify(cid, who, where) {
  try {
    if (!notifsEnabled) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (document.hasFocus()) return;
    const n = new Notification(who + ' — HiveVideo', {
      body: who + ' ' + where.replace(/^🎧\s*/, ''),
      icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><polygon points='50,5 90,27 90,73 50,95 10,73 10,27' fill='%23ffc94b'/></svg>",
      tag: 'hv-ring-' + cid,
      // A call waits for you. Unlike a message, it is worth holding the screen
      // -- and it is cleared the moment the call is answered, dismissed or
      // ends, so it cannot outlive the thing it is announcing.
      requireInteraction: true,
    });
    n.onclick = async () => {
      window.focus();
      clearRing(cid);
      if (currentChannelId !== cid) await openChannel(cid);
      joinHuddle(cid);
    };
    ringNotifs.set(cid, n);
  } catch (e) { /* a notification must never break the call itself */ }
}

function clearRing(cid) {
  if (window.hlSfx) hlSfx.stopLoop();
  ringSeen.delete(cid);
  // requireInteraction means it sits there until something closes it, and a
  // notification for a call that already ended is worse than none.
  const n = ringNotifs.get(cid);
  if (n) { try { n.close(); } catch (e) {} ringNotifs.delete(cid); }
  const card = document.getElementById('inc-' + cid);
  if (card) card.remove();
  const stack = $('incoming-calls');
  if (stack && !stack.children.length) stopRing();
}

// small stacked avatar strip
function partStrip(list, max = 4) {
  const wrap = document.createElement('div'); wrap.className = 'part-strip';
  list.slice(0, max).forEach(p => {
    const a = avatarEl({ display_name: p.display_name, username: p.display_name, avatar_url: p.avatar_url, avatar_color: p.avatar_color }, 'mini-avatar');
    wrap.appendChild(a);
  });
  if (list.length > max) {
    const more = document.createElement('span'); more.className = 'part-more'; more.textContent = `+${list.length - max}`;
    wrap.appendChild(more);
  }
  return wrap;
}

// Renders: the header button state + the in-channel "huddle active" banner
function renderHuddleUI() {
  const btn = $('huddle-btn'); if (!btn) return;
  const c = channels.get(currentChannelId);
  const isDM = c && c.type === 'dm';
  const parts = huddleParticipants(currentChannelId);
  const live = parts.length > 0;
  const iAmIn = !!activeHuddle && activeHuddle === currentChannelId;

  // header button
  const label = $('huddle-btn-label'), dot = $('huddle-btn-live');
  btn.classList.toggle('is-live', live && !iAmIn);
  btn.classList.toggle('in-call', iAmIn);
  dot.classList.toggle('hidden', !live);
  if (iAmIn) label.textContent = 'In call';
  else if (live) label.textContent = `Join (${parts.length})`;
  else label.textContent = isDM ? 'Call' : 'HiveVideo';
  btn.title = iAmIn ? 'You are in this call' : live ? 'Join the active call' : (isDM ? 'Start a call' : 'Start HiveVideo');

  // in-channel banner (only when a huddle is live here and I'm NOT already in it)
  const banner = $('huddle-banner');
  if (live && !iAmIn) {
    banner.innerHTML = '';
    const left = document.createElement('div'); left.className = 'hbn-left';
    const ic = document.createElement('span'); ic.className = 'hbn-ic'; ic.textContent = '🎧';
    left.appendChild(ic);
    left.appendChild(partStrip(parts, 5));
    const txt = document.createElement('span'); txt.className = 'hbn-txt';
    const names = parts.map(p => (p.display_name || 'Someone').split(' ')[0]);
    txt.textContent = `${names.slice(0, 2).join(', ')}${names.length > 2 ? ` +${names.length - 2}` : ''} ${parts.length === 1 ? 'is' : 'are'} in a huddle`;
    left.appendChild(txt);
    const join = document.createElement('button'); join.className = 'hbn-join'; join.textContent = 'Join';
    join.onclick = () => joinHuddle(currentChannelId);
    banner.appendChild(left); banner.appendChild(join);
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }

  // dock participant strip (if I'm in a huddle)
  if (iAmIn) {
    const parts2 = huddleParticipants(activeHuddle);
    const hp = $('hd-parts'); hp.innerHTML = '';
    // One face -- mine -- is not a participant strip, it is a stray thumbnail
    // wedged against the window controls. Show it only once it means something.
    if (parts2.length > 1) hp.appendChild(partStrip(parts2, 6));

    /* The subtitle used to be written here TOO:
         sub.textContent = n <= 1 ? 'Waiting for others…' : `${n} people`;
       which is a second author for the one line hudStatus() exists to own.
       Presence syncs several times during a call, and each one would stamp
       "Waiting for others…" over "Calling Allan…" -- reintroducing exactly the
       ambiguity ("am I calling him, or waiting for him?") this was built to
       remove. There is one writer now. */
    renderHuddleStatus();
  }
}

// ---- "Start HiveVideo" with nothing open ----
// This used to be a dead click: startHuddle() called joinHuddle(currentChannelId)
// and joinHuddle bails on `if (!cid) return`. HiveConnect lands on Messages with
// no channel selected, so that was the DEFAULT state -- the header HiveVideo
// button did nothing at all, and the Huddles CTA only flashed a small toast.
// Now, with no conversation open, every entry point asks WHERE to call.
let hvPickerQ = '';
function closeHvPicker() { const o = document.getElementById('hv-picker'); if (o) o.remove(); }
function openHvPicker() {
  closeHvPicker();
  hvPickerQ = '';
  const ov = document.createElement('div');
  ov.id = 'hv-picker'; ov.className = 'modal-backdrop';
  ov.innerHTML =
    '<div class="modal" style="width:420px;padding:22px;display:flex;flex-direction:column;max-height:72vh">' +
      '<h2>Start HiveVideo</h2>' +
      '<input id="hvp-q" type="text" placeholder="Search people and channels…" autocomplete="off">' +
      '<div id="hvp-list" style="flex:1;overflow:auto;margin-top:14px;min-height:140px"></div>' +
      '<div class="modal-actions"><button class="text-btn" id="hvp-cancel">Cancel</button></div>' +
    '</div>';
  document.body.appendChild(ov);
  ov.addEventListener('click', e => { if (e.target === ov) closeHvPicker(); });
  ov.querySelector('#hvp-cancel').onclick = closeHvPicker;
  const q = ov.querySelector('#hvp-q');
  q.oninput = () => { hvPickerQ = q.value.trim().toLowerCase(); renderHvPicker(); };
  q.onkeydown = e => {
    if (e.key === 'Escape') { closeHvPicker(); return; }
    if (e.key === 'Enter') { const first = ov.querySelector('.hvp-row'); if (first) first.click(); }
  };
  renderHvPicker();
  q.focus();
}
function renderHvPicker() {
  const list = document.getElementById('hvp-list'); if (!list) return;
  list.innerHTML = '';
  const hit = s => !hvPickerQ || (s || '').toLowerCase().includes(hvPickerQ);

  const row = (avatar, name, sub, onPick) => {
    const b = document.createElement('button');
    b.className = 'hvp-row';
    b.style.cssText = 'display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;border:none;' +
      'background:none;border-radius:9px;cursor:pointer;text-align:left;font-family:inherit';
    b.onmouseenter = () => { b.style.background = 'rgba(127,140,170,.14)'; };
    b.onmouseleave = () => { b.style.background = 'none'; };
    if (avatar) b.appendChild(avatar);
    const t = document.createElement('span');
    t.style.cssText = 'flex:1;min-width:0;font-size:12.5px;font-weight:700;color:var(--ink);' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    t.textContent = name;
    b.appendChild(t);
    if (sub) {
      const s = document.createElement('span');
      s.style.cssText = 'font-size:10.5px;font-weight:700;color:var(--mut)';
      s.textContent = sub;
      b.appendChild(s);
    }
    b.onclick = onPick;
    return b;
  };
  const head = text => {
    const h = document.createElement('div');
    h.style.cssText = 'font-family:var(--mono);font-size:9px;font-weight:800;letter-spacing:.1em;' +
      'text-transform:uppercase;color:var(--mut);margin:10px 0 4px;padding:0 10px';
    h.textContent = text;
    return h;
  };

  // People -> a DM call (creates/opens the DM, then rings the room)
  const people = [...profiles.values()]
    .filter(p => p.id !== me.id && p.username !== 'slackarchive' && p.active !== false && hit(p.display_name || p.username))
    .sort((a, b) => (a.display_name || '').localeCompare(b.display_name || ''))
    .slice(0, 8);
  if (people.length) {
    list.appendChild(head('People'));
    people.forEach(p => {
      const av = avatarEl(p);
      av.style.width = av.style.height = '26px'; av.style.fontSize = '10px'; av.style.borderRadius = '8px';
      list.appendChild(row(av, p.display_name || p.username, '', async () => {
        closeHvPicker();
        await startDM(p.id);
        if (currentChannelId) joinHuddle(currentChannelId);
      }));
    });
  }

  // Channels -> a call in that channel
  const chans = [...channels.values()]
    .filter(c => c.type !== 'dm' && !c.archived && hit(c.name))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .slice(0, 20);
  if (chans.length) {
    list.appendChild(head('Channels'));
    chans.forEach(c => {
      const n = huddleParticipants(c.id).length;
      list.appendChild(row(null, '# ' + c.name, n ? '🎧 ' + n : '', async () => {
        closeHvPicker();
        if (currentChannelId !== c.id) await openChannel(c.id);
        joinHuddle(c.id);
      }));
    });
  }

  if (!people.length && !chans.length) {
    const e = document.createElement('div');
    e.style.cssText = 'padding:24px 10px;text-align:center;font-size:12px;font-weight:600;color:var(--mut)';
    e.textContent = 'Nothing matches “' + hvPickerQ + '”';
    list.appendChild(e);
  }
}

function startHuddle() {
  if (currentChannelId) joinHuddle(currentChannelId);
  else openHvPicker();
}

async function joinHuddle(cid) {
  if (!cid) return;
  const c = channels.get(cid);
  if (activeHuddle === cid && (lkRoom || hudConnecting)) {   // already here — just resurface the window, don't re-connect
    const d = $('huddle-dock');
    d.style.left = ''; d.style.top = ''; d.style.right = ''; d.style.bottom = ''; d.style.width = ''; d.style.height = '';
    d.classList.remove('hidden', 'minimized');
    return;
  }
  if (lkRoom) { try { lkRoom.disconnect(); } catch (e) {} lkRoom = null; hudTiles.clear(); }
  activeHuddle = cid;

  // announce presence in this huddle
  if (huddleChannel && huddleChannel.track) {
    await huddleChannel.track({
      channel_id: cid,
      user_id: me.id,
      display_name: me.display_name || me.username,
      avatar_url: me.avatar_url || null,
      avatar_color: me.avatar_color || null,
      at: new Date().toISOString(),
    });
  }

  // open the dock + connect to our self-hosted LiveKit
  const dock = $('huddle-dock');
  // always reopen in the default, visible bottom-right spot (clear any prior drag/resize)
  dock.style.left = ''; dock.style.top = ''; dock.style.right = ''; dock.style.bottom = '';
  dock.style.width = ''; dock.style.height = '';
  dock.classList.remove('hidden', 'minimized', 'expanded');
  $('hd-title').textContent = c ? (c.type === 'dm' ? channelLabel(c) : '#' + c.name) : 'HiveVideo';
  $('hd-sub').textContent = 'connecting…';
  connectLiveKit(cid);
  // Calling one named person is not the same as opening an empty room. On a DM
  // the callee is implied, so the window says "Calling Allan..." and the invite
  // form stays behind the + -- putting it on screen unprompted is what made
  // this read as "you must now invite him". A channel huddle has no implied
  // callee, so there the prompt still earns its place.
  ensureHvInviteUI();
  const othersHere = huddleParticipants(cid).filter(p => p.user_id !== me.id).length;
  if (!othersHere && !hudCallTarget(cid)) openHvInvite(); else closeHvInvite();
  hudRingStart = Date.now();
  renderHuddleStatus();
  hvLogCallStart(cid);
  renderHuddleUI();
}

async function connectLiveKit(cid) {
  if (lkRoom) { try { lkRoom.disconnect(); } catch (e) {} lkRoom = null; hudTiles.clear(); }
  hudConnecting = true;
  const frame = $('hd-frame');
  frame.innerHTML = '<div id="hd-grid" class="hd-grid"></div><div id="hd-controls-bar" class="hd-controls-bar"></div><div id="hd-audio" style="display:none"></div>';
  buildHuddleControls();
  if (typeof LivekitClient === 'undefined') {
    frame.innerHTML = '<div class="hd-fallback">Video engine is loading… reload if this persists.</div>';
    hudConnecting = false;
    return;
  }
  // ask our database gatekeeper for a signed pass to this channel's room
  let token;
  try {
    const { data, error } = await sb.rpc('livekit_token', { p_channel: cid });
    if (error || !data) throw (error || new Error('no token'));
    token = data;
  } catch (e) {
    frame.innerHTML = '<div class="hd-fallback">Couldn\'t get a video pass — try again in a moment.</div>';
    hudConnecting = false;
    return;
  }
  // adaptiveStream/dynacast pause remote video when the SDK thinks a tile isn't
  // "visible" — flaky inside a small floating dock. For a small team call we just
  // want every stream to flow, always. So they're OFF.
  const room = new LivekitClient.Room({ adaptiveStream: false, dynacast: false });
  lkRoom = room;
  const RE = LivekitClient.RoomEvent;
  room
    .on(RE.TrackSubscribed, (track) => {
      // track.attach() returns a SINGLE element (not an array — that's detach()).
      // The old .forEach threw here, and because a remote audio track is subscribed
      // *during* connect for the 2nd person to join, it made room.connect() reject —
      // i.e. the receiver could never connect. This is THE receiver-fails bug.
      if (track.kind === 'audio') {
        try { const el = track.attach(); el.autoplay = true; (($('hd-audio')) || document.body).appendChild(el); applyAudioOut(el); } catch (e) {}
      }
      renderHuddleTiles();
    })
    .on(RE.TrackUnsubscribed, (track) => { track.detach().forEach(el => el.remove()); renderHuddleTiles(); })
    .on(RE.ParticipantConnected, () => {
      const wasRinging = hvRingbackOn;
      renderHuddleTiles(); stopRingClock(); renderHuddleStatus();
      if (wasRinging) { try { if (window.hlSfx) hlSfx.play('connect'); } catch (e) {} }
    })
    .on(RE.ParticipantDisconnected, () => { renderHuddleTiles(); renderHuddleStatus(); })
    .on(RE.LocalTrackPublished, renderHuddleTiles)
    .on(RE.LocalTrackUnpublished, renderHuddleTiles)
    .on(RE.TrackMuted, renderHuddleTiles)
    .on(RE.TrackUnmuted, renderHuddleTiles)
    .on(RE.ConnectionStateChanged, () => renderHuddleStatus())
    .on(RE.MediaDevicesError, (e) => hudError(deviceMsg(e, 'camera')))
    .on(RE.DataReceived, (payload) => {
      try { const d = JSON.parse(new TextDecoder().decode(payload)); if (d && d.t === 'cc' && d.text) addTranscriptLine(d.name, d.uid, d.text, true); } catch (e) {}
    })
    // Only react if THIS is still the live room. When we replace an old
    // connection (e.g. a stale one the server kicked with DUPLICATE_IDENTITY),
    // that old room's Disconnected must NOT touch the new session. And instead
    // of silently hiding the dock, show what happened + a Rejoin button.
    .on(RE.Disconnected, (reason) => { if (lkRoom === room) huddleDropped(reason, cid); });
  try {
    await room.connect(LIVEKIT_URL, token);
  } catch (e) {
    lkRoom = null; hudConnecting = false;
    try { console.warn('[huddle] connect failed:', e && (e.stack || e.message), e); } catch (_) {}
    const cidNow = cid;
    const detail = (e && (e.message || e.name)) ? String(e.message || e.name) : 'unknown error';
    frame.innerHTML = '<div class="hd-fallback">Couldn\'t connect to HiveVideo.' +
      '<div style="font-size:11px;opacity:.75;margin-top:6px;word-break:break-word">' + esc(detail) + '</div>' +
      '<button id="hd-retry" class="hd-cbtn active" style="width:auto;padding:0 16px;margin-top:12px">Try again</button></div>';
    const rt = document.getElementById('hd-retry');
    if (rt) rt.onclick = () => { activeHuddle = null; joinHuddle(cidNow); };
    return;
  }
  hudConnecting = false;
  // Force the dock visible + on-screen the moment we're live, so a stale
  // off-screen drag position or a lingering 'hidden' class can never leave the
  // user staring at an invisible/"hidden" call window.
  (function ensureDockVisible() {
    const d = $('huddle-dock'); if (!d) return;
    d.classList.remove('hidden', 'minimized');
    const r = d.getBoundingClientRect();
    const off = r.width === 0 || r.height === 0 || r.right < 40 || r.bottom < 40 ||
                r.left > window.innerWidth - 40 || r.top > window.innerHeight - 40;
    if (off) { d.style.left = ''; d.style.top = ''; d.style.right = ''; d.style.bottom = ''; d.style.width = ''; d.style.height = ''; }
  })();
  startRingClock();
  renderHuddleStatus();
  hudMic = true; hudCam = false; hudScreen = false;
  try { await room.localParticipant.setMicrophoneEnabled(true); }
  catch (e) { hudMic = false; hudError(deviceMsg(e, 'microphone')); }  // mic denied/absent → join muted (surfaced), still connected
  try { await applyMicPref(room); } catch (e) {}                       // saved mic device
  try { if (room.startAudio) await room.startAudio(); } catch (e) {}
  renderHuddleTiles(); updateHuddleControls();
  // Cowork markup layer (additive, isolated) — annotation/pointer/cursors +
  // camera background blur over the live call. Any failure here is swallowed.
  try { if (window.CoworkMarkup) window.CoworkMarkup.attach(room, { frame: $('hd-frame'), name: (me && (me.display_name || me.username)) || 'You' }); } catch (e) {}
}

/* ==================== WHAT IS THIS CALL DOING RIGHT NOW ====================
   Chris, 2026-08-23, watching himself start a call to Allan: "its unclear if
   I'm calling allan or if I needed to invite him to the call?"

   Fair question, because the window never said. The header read
   "Allan Amit / live" from the instant LiveKit connected -- `live` described MY
   socket, not the call -- and the only other thing on screen was an empty
   "Invite to this call" form, which reads as an instruction. So the one fact he
   needed, "Allan is being rung and hasn't picked up", was the one fact absent.

   Everything below derives from the room itself rather than being set once at
   connect time: remoteParticipants is who is actually here, and it is already
   re-rendered on ParticipantConnected/Disconnected. */

const HUD_RING_MS = 45000;   // how long we call someone before saying nobody picked up
let hudRingStart = 0;        // when the current outgoing call started ringing
let hudRingTimer = null;

// Who am I calling? For a DM that is a person, and naming them is the whole
// point. For a channel there is nobody specific -- it's an open room.
function hudCallTarget(cid) {
  const c = channels.get(cid || activeHuddle);
  if (!c || c.type !== 'dm' || isGroupDM(c)) return null;
  return dmOther(c) || null;
}

function hudRemoteCount() {
  return lkRoom && lkRoom.remoteParticipants ? lkRoom.remoteParticipants.size : 0;
}

// The single source of the subtitle. Returns { text, state } -- state drives the
// dot colour, so "calling" cannot look identical to "connected" the way it did.
function hudStatus() {
  if (hudConnecting) return { text: 'Connecting…', state: 'connecting' };
  if (!lkRoom) return { text: 'Not connected', state: 'off' };
  const S = LivekitClient && LivekitClient.ConnectionState;
  if (S && lkRoom.state === S.Reconnecting) return { text: 'Reconnecting…', state: 'connecting' };

  const others = hudRemoteCount();
  if (others > 0) {
    const target = hudCallTarget();
    if (others === 1) {
      const only = [...lkRoom.remoteParticipants.values()][0];
      const name = (only && only.name) || (target && target.display_name) || 'someone';
      return { text: 'In call with ' + name.split(' ')[0], state: 'live' };
    }
    return { text: (others + 1) + ' people in this call', state: 'live' };
  }

  // Alone. This is the case that used to lie.
  const target = hudCallTarget();
  const rungFor = hudRingStart ? Date.now() - hudRingStart : 0;
  if (target) {
    if (rungFor > HUD_RING_MS) return { text: 'No answer from ' + target.display_name.split(' ')[0], state: 'noanswer' };
    return { text: 'Calling ' + target.display_name.split(' ')[0] + '…', state: 'ringing' };
  }
  return { text: 'Waiting for others to join', state: 'waiting' };
}

function renderHuddleStatus() {
  const sub = $('hd-sub'); if (!sub) return;
  const { text, state } = hudStatus();
  if (sub.textContent !== text) sub.textContent = text;
  const dot = document.querySelector('.hd-live-dot');
  if (dot) dot.dataset.state = state;
  const dock = $('huddle-dock');
  if (dock) dock.dataset.callState = state;
  renderHuddleTiles();
}

/* The person being called gets a TILE, not a hero panel.

   Chris, 2026-08-24: "my video, after i turn it on is a tiny thumbnail at the
   bottom, the caller and the called should ahve the same size squares" -- and
   "the popup opens with no contorls visable, i have to enlarge it to access
   the controls".

   Both came from the same mistake. The first version gave the callee a big
   centred panel and squeezed my own camera into an 84px strip under it, which
   (a) made the two people in the call wildly different sizes and (b) ate so
   much height that the control bar was pushed out of a 328px dock entirely.

   So there is no separate stage any more. While a named person is being rung
   and has not arrived, they are simply a tile in the grid alongside mine --
   same square, same size, dimmed, captioned with what is happening. The grid
   already sizes N squares to fit, so two people ringing looks exactly like two
   people talking, and the controls keep their room. */
function hudPendingTile(grid, target, state) {
  let el = document.getElementById('hd-pending');
  if (!target) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'hd-pending'; el.className = 'hd-tile hd-pending';
    el.innerHTML = '<div class="hd-media hd-tile-av"></div><div class="hd-tile-name"></div>';
    grid.appendChild(el);
  }
  if (el.parentNode !== grid) grid.appendChild(el);
  const av = el.querySelector('.hd-media');
  if (av.dataset.for !== target.id) {
    av.innerHTML = ''; av.appendChild(avatarEl(target, 'avatar')); av.dataset.for = target.id;
  }
  el.dataset.state = state;
  const label = (state === 'noanswer' ? 'No answer — ' : 'Calling… ') + (target.display_name || 'Someone');
  const nm = el.querySelector('.hd-tile-name');
  if (nm.textContent !== label) nm.textContent = label;
}

// "Calling…" has to become "No answer" on its own, without a participant event
// to hang it off -- nobody arriving is exactly the case being reported.
function startRingClock() {
  hudRingStart = Date.now();
  clearInterval(hudRingTimer);
  // A silent outgoing call gives you nothing to tell "it's ringing" from "it's
  // broken" -- Chris, 2026-08-23: "its strange not hearing someting to indicate
  // it ringing". Only ring when there is someone specific being rung; an open
  // channel room isn't waiting on anyone in particular. Starting a call is a
  // click, so the AudioContext resumes without an autoplay fight.
  if (hudCallTarget()) startHvRingback();
  hudRingTimer = setInterval(() => {
    if (!activeHuddle) { stopRingClock(); return; }
    renderHuddleStatus();
    if (hudRemoteCount() > 0 || Date.now() - hudRingStart > HUD_RING_MS + 1000) stopRingClock();
  }, 1000);
}
function stopRingClock() { clearInterval(hudRingTimer); hudRingTimer = null; stopHvRingback(); }

/* The ringback belongs to THIS call, so it must never outlive it: it stops when
   they answer, when the call is abandoned, and when we give up. hlSfx keeps one
   loop at a time, so only stop it if we are the one still ringing -- otherwise
   leaving one call would silence an incoming ring for another. */
let hvRingbackOn = false;
function startHvRingback() {
  if (hvRingbackOn || !window.hlSfx) return;
  hvRingbackOn = true;
  try { hlSfx.startLoop('hvring', 3400); } catch (e) { hvRingbackOn = false; }
}
function stopHvRingback() {
  if (!hvRingbackOn) return;
  hvRingbackOn = false;
  try { if (window.hlSfx) hlSfx.stopLoop(); } catch (e) {}
}

/* ==================== CALL LOG ====================
   Chris, 2026-08-23: "we need a call log and AI summary and a transcription."

   The transcript and the AI summary already existed -- live captions feeding
   generateAINotes(), which posts Reina's write-up into the channel. The LOG did
   not: there was no HiveVideo table of any kind, so a call left no trace. Who
   called whom, when, how long, whether anyone picked up -- all of it lived in
   realtime presence, which is in-memory and gone the instant the socket closes.

   hv_calls fixes that, and the transcript now lands ON the call rather than
   only in a chat message, so the log row is the whole record of the call.

   Every write here is best-effort: a call must never fail to start, or refuse
   to end, because the log could not be written. */

let hvCallRowId = null;      // the hv_calls row for the call I am in
let hvCallLog = [];          // recent calls, newest first
let hvCallLogAt = 0;         // when the cache was filled

async function hvLogCallStart(cid) {
  hvCallRowId = null;
  if (!cid || !me) return;
  const mine = {
    user_id: me.id,
    display_name: me.display_name || me.username || 'Someone',
    joined_at: new Date().toISOString(),
  };
  try {
    const { data, error } = await sb.from('hv_calls')
      .insert({ channel_id: cid, started_by: me.id, participants: [mine] })
      .select('id').single();
    if (!error && data) { hvCallRowId = data.id; return; }
    // The unique partial index rejected it, which means somebody else opened
    // this call a moment ago. Join THEIR row instead of forking the log into
    // two half-calls -- that is what the index is there to force.
    const { data: open } = await sb.from('hv_calls')
      .select('id, participants').eq('channel_id', cid).is('ended_at', null)
      .order('started_at', { ascending: false }).limit(1);
    const row = open && open[0];
    if (!row) return;
    hvCallRowId = row.id;
    const parts = Array.isArray(row.participants) ? row.participants : [];
    if (!parts.some(p => p && p.user_id === me.id)) {
      await sb.from('hv_calls').update({ participants: parts.concat([mine]) }).eq('id', row.id);
    }
  } catch (e) { hvCallRowId = null; }
}

// Closing the call is the last person's job, not the starter's -- whoever
// leaves while nobody else is left stamps ended_at.
async function hvLogCallEnd(lastOut, transcript) {
  const id = hvCallRowId;
  hvCallRowId = null;
  if (!id) return;
  const patch = {};
  if (lastOut) patch.ended_at = new Date().toISOString();
  if (transcript) patch.transcript = transcript.slice(0, 100000);
  if (!Object.keys(patch).length) return;
  try { await sb.from('hv_calls').update(patch).eq('id', id); } catch (e) {}
  hvCallLogAt = 0;   // the log the panel is showing is now stale
}

function hvCallDuration(row) {
  if (!row.started_at) return '';
  const end = row.ended_at ? new Date(row.ended_at) : null;
  if (!end) return 'in progress';
  const secs = Math.max(0, Math.round((end - new Date(row.started_at)) / 1000));
  // A call nobody picked up is a real outcome and reads better as words than
  // as "0:04" -- the log should say what happened, not just how long it took.
  if (secs < 8 && (row.participants || []).length < 2) return 'no answer';
  if (secs < 60) return secs + 's';
  const m = Math.floor(secs / 60), sRem = secs % 60;
  if (m < 60) return m + 'm ' + String(sRem).padStart(2, '0') + 's';
  return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
}

function hvCallWhen(row) {
  const d = new Date(row.started_at);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return t;
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return 'Yesterday ' + t;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + t;
}

async function loadCallLog(force) {
  if (!force && hvCallLogAt && Date.now() - hvCallLogAt < 30000) return hvCallLog;
  try {
    const { data, error } = await sb.from('hv_calls')
      .select('id, channel_id, started_by, started_at, ended_at, participants, transcript, summary')
      .order('started_at', { ascending: false }).limit(40);
    if (error) throw error;
    hvCallLog = data || [];
    hvCallLogAt = Date.now();
  } catch (e) { /* keep whatever we last had rather than blanking the panel */ }
  return hvCallLog;
}

let hudTiles = new Map();   // participant.sid -> { tile, media, name, attachedSid }

// Reconciling renderer: updates tiles in place (never wipes the grid), so video
// doesn't flash and an enabled camera stays on. Only re-attaches when the video track changes.
function renderHuddleTiles() {
  const grid = $('hd-grid'); if (!grid || !lkRoom) return;
  const T = LivekitClient.Track;
  const parts = [lkRoom.localParticipant, ...lkRoom.remoteParticipants.values()];
  // Screen-share spotlight: the first active screen share becomes the stage
  // and fills the window; all other tiles shrink to a bottom thumbnail strip.
  let stageSid = null;
  for (const p of parts) {
    if (p === lkRoom.localParticipant) continue; // never spotlight my own shared screen back at me
    p.trackPublications.forEach(pub => { if (!stageSid && pub.kind === 'video' && pub.track && !pub.isMuted && pub.source === T.Source.ScreenShare) stageSid = p.sid; });
    if (stageSid) break;
  }
  grid.classList.toggle('hd-spotlight', !!stageSid);
  // The tiles are squares sized off the cell, so the CSS needs both counts --
  // knowing the columns alone cannot tell it how tall a cell is.
  // Somebody being rung occupies a square exactly like somebody who answered --
  // that is the whole point of putting them in this grid rather than above it.
  const ringState = ($('huddle-dock') || {}).dataset ? $('huddle-dock').dataset.callState : '';
  const pendingWho = (!lkRoom.remoteParticipants.size && (ringState === 'ringing' || ringState === 'noanswer'))
    ? hudCallTarget() : null;
  const count = parts.length + (pendingWho ? 1 : 0);
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  grid.style.setProperty('--cols', cols);
  grid.style.setProperty('--rows', Math.max(1, Math.ceil(count / cols)));
  const seen = new Set();
  for (const p of parts) {
    seen.add(p.sid);
    let e = hudTiles.get(p.sid);
    if (!e) {
      const tile = document.createElement('div'); tile.className = 'hd-tile';
      const media = document.createElement('div'); media.className = 'hd-media';
      const name = document.createElement('div'); name.className = 'hd-tile-name';
      tile.appendChild(media); tile.appendChild(name); grid.appendChild(tile);
      e = { tile, media, name, attachedSid: null }; hudTiles.set(p.sid, e);
    }
    const isMe = p === lkRoom.localParticipant;
    const isStage = p.sid === stageSid;
    e.tile.classList.toggle('hd-stage', isStage);
    if (isStage && grid.firstChild !== e.tile) grid.insertBefore(e.tile, grid.firstChild);
    let vpub = null;
    p.trackPublications.forEach(pub => {
      if (pub.kind === 'video' && pub.track && !pub.isMuted &&
          (pub.source === T.Source.Camera || (pub.source === T.Source.ScreenShare && !isMe))) {  // don't show me my own screen share
        if (!vpub || pub.source === T.Source.ScreenShare) vpub = pub;
      }
    });
    const wantSid = (vpub && vpub.track) ? vpub.trackSid : null;
    if (wantSid !== e.attachedSid) {   // only touch the DOM when the video actually changed
      e.media.innerHTML = '';
      if (vpub && vpub.track) {
        const v = vpub.track.attach(); v.className = 'hd-video';
        if (isMe && vpub.source === T.Source.Camera) v.style.transform = 'scaleX(-1)';
        e.media.appendChild(v);
      } else {
        const wrap = document.createElement('div'); wrap.className = 'hd-tile-av';
        const prof = profiles.get((p.identity || '').split('__')[0]) || { display_name: p.name || 'Guest' };
        wrap.appendChild(avatarEl(prof, 'avatar')); e.media.appendChild(wrap);
      }
      e.attachedSid = wantSid;
    }
    const label = (!p.isMicrophoneEnabled ? '🔇 ' : '') + (isMe ? 'You' : (p.name || 'Guest'));
    if (e.name.textContent !== label) e.name.textContent = label;
  }
  for (const [sid, e] of hudTiles) { if (!seen.has(sid)) { e.tile.remove(); hudTiles.delete(sid); } }
  hudPendingTile(grid, pendingWho, ringState);
}

function hudError(msg) {
  let el = document.getElementById('hd-err');
  if (!msg) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'hd-err'; el.className = 'hd-err'; ($('hd-frame') || document.body).appendChild(el); }
  el.textContent = msg;
  clearTimeout(hudError._t); hudError._t = setTimeout(() => { const e = document.getElementById('hd-err'); if (e) e.remove(); }, 7000);
}
function deviceMsg(e, dev) {
  if (e && e.name === 'NotReadableError') return `Your ${dev} is being used by another app or browser tab — close it and try again.`;
  if (e && (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError')) return `${dev[0].toUpperCase() + dev.slice(1)} permission is blocked — allow it in your browser's address bar.`;
  if (e && e.name === 'NotFoundError') return `No ${dev} found on this device.`;
  return `Couldn't start your ${dev}.`;
}

// Clean line-icons for the huddle controls (replaces the emoji).
const HUD_ICONS = {
  mic: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="22"/></svg>',
  micOff: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="2" x2="22" y2="22"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><path d="M15 9.34V5a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12"/><line x1="12" y1="19" x2="12" y2="22"/></svg>',
  cam: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>',
  camOff: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="2" x2="22" y2="22"/><path d="M16 16v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2"/><path d="M10 6h4a2 2 0 0 1 2 2v3l5-3v9"/></svg>',
  screen: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 15 12 9 18 15"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  cc: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="3"/><path d="M9.5 10a2.5 2.5 0 100 4M16.5 10a2.5 2.5 0 100 4"/></svg>',
  rec: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="12" cy="12" r="7"/></svg>',
  notes: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.6 3.9L17.5 8l-3 2.7.8 4.1L12 12.9 8.7 14.8l.8-4.1-3-2.7 3.9-1.1z" transform="scale(0.62) translate(3 2)"/><line x1="4" y1="20" x2="20" y2="20"/><line x1="7" y1="16.5" x2="17" y2="16.5"/></svg>',
  popout: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="14" rx="2"/><rect x="12" y="10" width="7" height="6" rx="1" fill="currentColor" stroke="none"/></svg>',
};

function buildHuddleControls() {
  const bar = $('hd-controls-bar'); if (!bar) return;
  bar.innerHTML = '';
  const group = (mainId, caretId, title, onToggle, onMenu) => {
    const g = document.createElement('div'); g.className = 'hd-ctl-group';
    const main = document.createElement('button'); main.className = 'hd-cbtn hd-ctl'; main.id = mainId; main.title = title;
    main.onclick = onToggle; g.appendChild(main);
    if (caretId) {
      const c = document.createElement('button'); c.className = 'hd-cbtn hd-caret'; c.id = caretId;
      c.title = 'Choose device'; c.innerHTML = HUD_ICONS.chevron;
      c.onclick = (e) => { e.stopPropagation(); onMenu(c); };
      g.appendChild(c);
    }
    bar.appendChild(g);
  };
  group('hd-mic', 'hd-mic-caret', 'Mute / unmute',
    async () => { if (!lkRoom) return; const t = !hudMic;
      try { await lkRoom.localParticipant.setMicrophoneEnabled(t); hudMic = t; hudError(''); }
      catch (e) { hudMic = false; hudError(deviceMsg(e, 'microphone')); }
      updateHuddleControls(); renderHuddleTiles(); },
    (anchor) => openDeviceMenu('audio', anchor));
  group('hd-cam', 'hd-cam-caret', 'Camera on / off',
    async () => { if (!lkRoom) return; const t = !hudCam;
      try { await lkRoom.localParticipant.setCameraEnabled(t); hudCam = t; hudError(''); }
      catch (e) { hudCam = false; hudError(deviceMsg(e, 'camera')); }
      updateHuddleControls(); renderHuddleTiles(); },
    (anchor) => openDeviceMenu('video', anchor));
  group('hd-screen', null, 'Share screen',
    async () => { if (!lkRoom) return; const t = !hudScreen;
      try { await lkRoom.localParticipant.setScreenShareEnabled(t); hudScreen = t; hudError(''); }
      catch (e) { hudScreen = false; }
      updateHuddleControls(); renderHuddleTiles(); });
  // divider then CC / Record / AI-notes
  const sep = document.createElement('span'); sep.className = 'hd-sep'; bar.appendChild(sep);
  const solo = (id, title, onClick) => { const g = document.createElement('div'); g.className = 'hd-ctl-group'; const b = document.createElement('button'); b.className = 'hd-cbtn hd-ctl'; b.id = id; b.title = title; b.onclick = onClick; g.appendChild(b); bar.appendChild(g); };
  solo('hd-cc-btn', 'Live captions / transcript', () => toggleCaptions());
  solo('hd-rec', 'Record the call', () => { if (hudRec) stopRecording(); else startRecording(); });
  solo('hd-notes', 'AI notes (summarize with Reina)', () => generateAINotes());
  // Pop-out: float the call + cowork tools over other apps (Chrome/Edge only).
  if ('documentPictureInPicture' in window) {
    const gp = document.createElement('div'); gp.className = 'hd-ctl-group';
    const bp = document.createElement('button'); bp.className = 'hd-cbtn hd-ctl'; bp.id = 'hd-popout'; bp.title = 'Pop out — float the call over other apps';
    bp.innerHTML = HUD_ICONS.popout;
    bp.onclick = () => togglePopout();
    gp.appendChild(bp); bar.appendChild(gp);
  }
  updateHuddleControls();
}

// ---- Pop-out: float the call + cowork tools over other apps (Document PiP) ----
let hudPipWindow = null;
function ensurePipStyles() {
  if (document.getElementById('hd-pip-css')) return;
  const st = document.createElement('style'); st.id = 'hd-pip-css';
  st.textContent = '.hd-piped{position:static!important;inset:auto!important;left:auto!important;top:auto!important;right:auto!important;bottom:auto!important;flex:1 1 auto!important;width:100%!important;height:auto!important;min-height:0!important;max-height:none!important;margin:0!important;border-radius:0!important;box-shadow:none!important;display:flex!important;flex-direction:column!important}'
    + '.hd-piped #hd-frame,.hd-piped .hd-grid{flex:1 1 auto!important;min-height:0!important;height:auto!important}'
    + '.cwm-piped{position:static!important;inset:auto!important;left:auto!important;top:auto!important;flex:0 0 auto!important;width:100%!important;max-height:none!important;margin:6px 0 0!important;border-radius:0!important}';
  document.head.appendChild(st);
}
function copyStylesToPip(pw) {
  try {
    [].forEach.call(document.styleSheets, function (ss) {
      try { var txt = [].map.call(ss.cssRules, function (r) { return r.cssText; }).join(''); var s = pw.document.createElement('style'); s.textContent = txt; pw.document.head.appendChild(s); }
      catch (e) { if (ss.href) { var l = pw.document.createElement('link'); l.rel = 'stylesheet'; l.href = ss.href; pw.document.head.appendChild(l); } }
    });
  } catch (e) {}
  try { var bs = pw.document.body.style; bs.margin = '0'; bs.background = '#0b0f16'; bs.overflow = 'hidden'; bs.display = 'flex'; bs.flexDirection = 'column'; bs.height = '100vh'; } catch (e) {}
}
async function togglePopout() {
  if (hudPipWindow) { try { hudPipWindow.close(); } catch (e) {} return; }
  const dock = $('huddle-dock'); if (!dock) return;
  ensurePipStyles();
  let pw;
  try { pw = await window.documentPictureInPicture.requestWindow({ width: 400, height: 560 }); }
  catch (e) { hudPipWindow = null; return; }
  hudPipWindow = pw;
  copyStylesToPip(pw);
  const ph = document.createComment('hd-pip'); dock.parentNode.insertBefore(ph, dock); dock.__pipPh = ph;
  dock.classList.remove('hidden', 'minimized'); dock.classList.add('hd-piped');
  pw.document.body.appendChild(dock);
  const panel = document.querySelector('.cwm-panel');
  if (panel) { dock.__pipPanel = panel; panel.classList.add('cwm-piped'); pw.document.body.appendChild(panel); }
  pw.addEventListener('pagehide', restoreFromPip, { once: true });
  updatePopoutBtn(true);
}
function restoreFromPip() {
  const dock = $('huddle-dock');
  if (dock) {
    dock.classList.remove('hd-piped');
    const ph = dock.__pipPh;
    if (ph && ph.parentNode) { ph.parentNode.insertBefore(dock, ph); ph.remove(); } else { document.body.appendChild(dock); }
    dock.__pipPh = null;
    if (dock.__pipPanel) { try { dock.__pipPanel.classList.remove('cwm-piped'); document.body.appendChild(dock.__pipPanel); } catch (e) {} dock.__pipPanel = null; }
  }
  hudPipWindow = null;
  updatePopoutBtn(false);
}
function updatePopoutBtn(on) {
  for (const id of ['hd-popout', 'hd-popout-top']) {
    const b = $(id); if (b) b.classList.toggle('on', !!on);
  }
  const t = $('hd-popout-top');
  if (t) t.title = on ? 'Put the call back in HiveLogic' : 'Open in its own window — float the call over HiveLogic and any other app';
}

function updateHuddleControls() {
  const mic = $('hd-mic'); if (mic) { mic.innerHTML = hudMic ? HUD_ICONS.mic : HUD_ICONS.micOff; if (mic.parentElement) mic.parentElement.classList.toggle('off', !hudMic); }
  const cam = $('hd-cam'); if (cam) { cam.innerHTML = hudCam ? HUD_ICONS.cam : HUD_ICONS.camOff; if (cam.parentElement) cam.parentElement.classList.toggle('off', !hudCam); }
  const scr = $('hd-screen'); if (scr) { scr.innerHTML = HUD_ICONS.screen; if (scr.parentElement) scr.parentElement.classList.toggle('active', hudScreen); }
  const cc = $('hd-cc-btn'); if (cc) { cc.innerHTML = HUD_ICONS.cc; if (cc.parentElement) cc.parentElement.classList.toggle('active', hudCC); }
  const rec = $('hd-rec'); if (rec) { rec.innerHTML = HUD_ICONS.rec; if (rec.parentElement) rec.parentElement.classList.toggle('rec', !!hudRec); rec.title = hudRec ? 'Stop recording' : 'Record the call'; }
  const nt = $('hd-notes'); if (nt) { nt.innerHTML = HUD_ICONS.notes; }
}

// ---- per-button device picker (the ▾ menu): choose mic / speaker / camera ----
let hudMenuEl = null;
function closeDeviceMenu() {
  if (hudMenuEl) { hudMenuEl.remove(); hudMenuEl = null; }
  document.removeEventListener('mousedown', hudMenuOutside, true);
}
function hudMenuOutside(e) {
  if (hudMenuEl && !hudMenuEl.contains(e.target) && !(e.target.closest && e.target.closest('.hd-caret'))) closeDeviceMenu();
}
async function openDeviceMenu(type, anchor) {
  if (hudMenuEl) { closeDeviceMenu(); return; }
  const menu = document.createElement('div'); menu.className = 'hd-devmenu'; hudMenuEl = menu;
  let devices = [];
  try { devices = await navigator.mediaDevices.enumerateDevices(); } catch (e) {}
  const sections = type === 'audio'
    ? [{ kind: 'audioinput', label: 'Microphone' }, { kind: 'audiooutput', label: 'Speaker' }]
    : [{ kind: 'videoinput', label: 'Camera' }];
  for (const sec of sections) {
    const head = document.createElement('div'); head.className = 'hd-devhead'; head.textContent = sec.label; menu.appendChild(head);
    const list = devices.filter(d => d.kind === sec.kind && d.deviceId);
    let active = null;
    try { active = lkRoom && lkRoom.getActiveDevice ? lkRoom.getActiveDevice(sec.kind) : null; } catch (e) {}
    if (!list.length) {
      const none = document.createElement('div'); none.className = 'hd-devitem hd-devnone';
      none.textContent = sec.kind === 'audioinput' ? 'No mic found — allow mic access' : 'None found';
      menu.appendChild(none);
    }
    list.forEach((d, i) => {
      const it = document.createElement('button'); it.className = 'hd-devitem';
      const isActive = active ? d.deviceId === active : (i === 0 && !active);
      it.innerHTML = '<span class="hd-devchk">' + (isActive ? HUD_ICONS.check : '') + '</span>' +
        '<span class="hd-devlbl"></span>';
      it.querySelector('.hd-devlbl').textContent = d.label || (sec.label + ' ' + (i + 1));
      it.onclick = async () => {
        try {
          if (lkRoom && lkRoom.switchActiveDevice) await lkRoom.switchActiveDevice(sec.kind, d.deviceId);
          if (sec.kind === 'audioinput' && !hudMic) { await lkRoom.localParticipant.setMicrophoneEnabled(true); hudMic = true; }
          hudError('');
        } catch (e) { hudError("Couldn't switch " + sec.label.toLowerCase()); }
        closeDeviceMenu(); updateHuddleControls(); renderHuddleTiles();
      };
      menu.appendChild(it);
    });
  }
  const dock = $('huddle-dock'); dock.appendChild(menu);
  const bar = $('hd-controls-bar');
  const dr = dock.getBoundingClientRect(), ar = anchor.getBoundingClientRect(), br = bar.getBoundingClientRect();
  menu.style.bottom = (dr.bottom - br.top + 8) + 'px';
  let left = ar.left - dr.left - 60;
  left = Math.max(8, Math.min(left, dr.width - menu.offsetWidth - 8));
  menu.style.left = left + 'px';
  setTimeout(() => document.addEventListener('mousedown', hudMenuOutside, true), 0);
}

/* ==================== LIVE TRANSCRIPTION (browser speech-to-text) ====================
   Each person's browser transcribes THEIR OWN mic and broadcasts final lines over the
   LiveKit data channel, so everyone builds the same running transcript. Free, no server. */
function sttSupported() { return !!(window.SpeechRecognition || window.webkitSpeechRecognition); }

function startSTT() {
  if (hudSTT || !sttSupported()) return;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const rec = new SR();
  rec.continuous = true; rec.interimResults = true; rec.lang = 'en-US';
  let interimEl = null;
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) {
        const text = (res[0].transcript || '').trim();
        if (text) addTranscriptLine(me.display_name || me.username, me.id, text, false);
      } else { interim += res[0].transcript; }
    }
    showInterim(interim.trim());
  };
  rec.onerror = (e) => { /* 'no-speech'/'aborted' are normal; keep going */ };
  rec.onend = () => { if (hudSTT === rec && activeHuddle) { try { rec.start(); } catch (e) {} } };
  hudSTT = rec;
  try { rec.start(); } catch (e) {}
}
function stopSTT() { const r = hudSTT; hudSTT = null; if (r) { try { r.onend = null; r.stop(); } catch (e) {} } }

function addTranscriptLine(name, uid, text, fromRemote) {
  const line = { name: name || 'Someone', uid: uid || '', text, ts: Date.now() };
  hudTranscript.push(line);
  renderTranscriptLine(line);
  if (!fromRemote && lkRoom && lkRoom.localParticipant && lkRoom.localParticipant.publishData) {
    try {
      const data = new TextEncoder().encode(JSON.stringify({ t: 'cc', name: line.name, uid: line.uid, text }));
      lkRoom.localParticipant.publishData(data, { reliable: true });
    } catch (e) {}
  }
}

/* ==================== CAPTIONS / TRANSCRIPT PANEL ==================== */
function toggleCaptions() {
  hudCC = !hudCC;
  const panel = $('hd-cc'); if (!panel) return;
  panel.classList.toggle('hidden', !hudCC);
  if (hudCC) {
    if (!sttSupported()) hudError('Live captions need Chrome or Edge.');
    else startSTT();
    // backfill any lines captured before opening
    const body = $('hd-cc-body'); if (body) { body.innerHTML = ''; hudTranscript.forEach(renderTranscriptLine); }
  }
  updateHuddleControls();
}
function renderTranscriptLine(line) {
  const body = $('hd-cc-body'); if (!body) return;
  const row = document.createElement('div'); row.className = 'cc-line';
  const who = document.createElement('span'); who.className = 'cc-who'; who.textContent = (line.name || '').split(' ')[0] + ': ';
  const txt = document.createElement('span'); txt.className = 'cc-txt'; txt.textContent = line.text;
  row.appendChild(who); row.appendChild(txt); body.appendChild(row);
  body.scrollTop = body.scrollHeight;
}
let interimTimer = null;
function showInterim(text) {
  const el = $('hd-cc-interim'); if (!el) return;
  el.textContent = text; el.classList.toggle('hidden', !text);
  clearTimeout(interimTimer); if (text) interimTimer = setTimeout(() => { el.classList.add('hidden'); }, 2500);
}

/* ==================== RECORDING (client-side composite + audio mix → webm) ==================== */
function collectAudioTracks() {
  const tracks = [];
  if (!lkRoom) return tracks;
  const grab = (p) => { p.trackPublications.forEach(pub => { if (pub.track && pub.kind === 'audio' && pub.track.mediaStreamTrack) tracks.push(pub.track.mediaStreamTrack); }); };
  grab(lkRoom.localParticipant);
  lkRoom.remoteParticipants.forEach(grab);
  return tracks;
}
async function startRecording() {
  if (hudRec || !lkRoom) return;
  let ac, dest, raf, canvas;
  try {
    ac = new (window.AudioContext || window.webkitAudioContext)();
    dest = ac.createMediaStreamDestination();
    collectAudioTracks().forEach(t => { try { ac.createMediaStreamSource(new MediaStream([t])).connect(dest); } catch (e) {} });
    canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
    const ctx = canvas.getContext('2d');
    const draw = () => {
      const vids = [...document.querySelectorAll('#hd-grid video')].filter(v => v.videoWidth);
      ctx.fillStyle = '#0b0f17'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      const n = Math.max(1, vids.length);
      const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
      const cw = canvas.width / cols, chh = canvas.height / rows;
      if (!vids.length) { ctx.fillStyle = '#5a6d8c'; ctx.font = '28px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('Audio only', canvas.width / 2, canvas.height / 2); }
      vids.forEach((v, i) => { const x = (i % cols) * cw, y = Math.floor(i / cols) * chh; try { ctx.drawImage(v, x, y, cw, chh); } catch (e) {} });
      raf = requestAnimationFrame(draw);
    };
    draw();
    const vstream = canvas.captureStream(15);
    const mixed = new MediaStream([...vstream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    let mime = 'video/webm;codecs=vp8,opus';
    if (!(window.MediaRecorder && MediaRecorder.isTypeSupported(mime))) mime = 'video/webm';
    hudRecChunks = [];
    const mr = new MediaRecorder(mixed, { mimeType: mime, videoBitsPerSecond: 1500000 });
    mr._cleanup = () => { try { cancelAnimationFrame(raf); } catch (e) {} try { ac.close(); } catch (e) {} };
    mr.ondataavailable = (e) => { if (e.data && e.data.size) hudRecChunks.push(e.data); };
    mr.onstop = () => { mr._cleanup(); finalizeRecording(); };
    hudRec = mr; hudRecStart = Date.now();
    mr.start(1000);
    hudError('Recording started.');
  } catch (e) {
    try { if (ac) ac.close(); } catch (_) {}
    hudRec = null; hudError("Couldn't start recording on this browser.");
  }
  updateHuddleControls();
}
function stopRecording() { if (hudRec && hudRec.state !== 'inactive') { try { hudRec.stop(); } catch (e) {} } }
function finalizeRecording() {
  const chunks = hudRecChunks; hudRecChunks = []; hudRec = null; updateHuddleControls();
  if (!chunks.length) { hudError('Nothing was recorded.'); return; }
  const blob = new Blob(chunks, { type: 'video/webm' });
  const c = channels.get(activeHuddle);
  const base = 'huddle-' + ((c && c.name) ? c.name : 'call') + '-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = base + '.webm';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  hudError('Recording saved to your Downloads (' + Math.round(blob.size / 1e5) / 10 + ' MB).');
}

/* ==================== AI NOTES (summarize the transcript via Reina/Claude) ==================== */
async function generateAINotes() {
  if (!hudTranscript.length) { hudError('No transcript yet — turn on CC (captions) so it can hear the call.'); return; }
  const transcript = hudTranscript.map(l => l.name + ': ' + l.text).join('\n');
  const c = channels.get(activeHuddle);
  const where = c ? (c.type === 'dm' ? 'call' : '#' + c.name) : 'huddle';
  const prompt = '@reina Please write up notes for this ' + where + ' — a short summary, key decisions, and action items (with owners if mentioned):\n\n' + transcript;
  try {
    await sb.from('messages').insert({ channel_id: activeHuddle, user_id: me.id, content: prompt.slice(0, 6000) });
    hudError('Sent the transcript to Reina — your notes will post in the channel shortly. 🐝');
  } catch (e) { hudError("Couldn't send notes to Reina."); }
}

function teardownHuddleExtras() {
  stopSTT();
  try { stopRecording(); } catch (e) {}
  hudCC = false;
  const p = $('hd-cc'); if (p) p.classList.add('hidden');
  hudTranscript = [];
}

function leaveHuddle(silent) {
  // Snapshot what the call log needs FIRST. teardownHuddleExtras() below empties
  // hudTranscript, and the LiveKit disconnect empties the room -- both a few
  // lines from here. Reading either after that point logs an empty call.
  const logTranscript = hudTranscript.length
    ? hudTranscript.map(l => l.name + ': ' + l.text).join('\n') : null;
  const logLastOut = !activeHuddle
    || huddleParticipants(activeHuddle).filter(p => p.user_id !== me.id).length === 0;

  // null lkRoom BEFORE disconnecting so the room's own Disconnected handler
  // (which checks lkRoom === room) treats this as an intentional leave and
  // does NOT pop the "call dropped — rejoin?" UI.
  try { if (hudPipWindow) { hudPipWindow.close(); } } catch (e) {}  // bring the dock back before teardown
  try { closeDeviceMenu(); } catch (e) {}
  try { teardownHuddleExtras(); } catch (e) {}
  try { if (window.CoworkMarkup) window.CoworkMarkup.detach(); } catch (e) {}
  const r = lkRoom; lkRoom = null;
  try { if (r) r.disconnect(); } catch (e) {}
  hudConnecting = false;
  hudTiles.clear();
  hudMic = true; hudCam = false; hudScreen = false;
  // Deliberately leaving must not re-ring you for this same call; the
  // suppression auto-clears when the huddle actually ends (see ringCheck).
  if (activeHuddle) { try { ringDismissed.add(activeHuddle); clearRing(activeHuddle); } catch (e) {} }
  stopRingClock(); stopHvRingback(); hudRingStart = 0;
  hvLogCallEnd(logLastOut, logTranscript);
  { const st = document.getElementById('hd-pending'); if (st) st.remove(); }
  dropMeFromHuddleState();
  activeHuddle = null;
  untrackTries = 0;
  // Checked, and retried once on the spot; reconcileMyHuddlePresence() covers
  // anything still stuck after that.
  clearMyHuddlePresence().then(ok => { if (!ok) clearMyHuddlePresence(); });
  // Found 2026-08-19 (a real call that "wouldn't end"): hudPipWindow.close()
  // above queues that window's `pagehide` -> restoreFromPip() asynchronously
  // -- it does not move the dock back into this document before this line
  // runs. $('huddle-dock') returning null here used to throw uncaught and
  // abort everything below it. Live-confirmed the LiveKit room above had
  // ALREADY disconnected cleanly by this point (its own disconnect event
  // fires fine) -- only the dock was ever left un-hidden, so the call
  // window sat stuck open even though the call itself had actually ended.
  // Guarding this (and the matching hd-frame clear below) means leaveHuddle
  // always finishes, regardless of where the dock happens to be.
  const dock = $('huddle-dock');
  if (dock) {
    dock.classList.add('hidden');
    dock.classList.remove('minimized', 'expanded', 'hd-full');
  }
  try { closeHvInvite(); } catch (e) {}
  const frame = $('hd-frame');
  if (frame) frame.innerHTML = '';
  if (!silent) renderHuddleUI();
}

// An UNEXPECTED disconnect (server kicked us, network dropped, same user joined
// from another tab). Never silently hide the dock — that reads as "the call window
// just vanished". Keep it visible, say what happened, offer a one-click rejoin.
function huddleDropped(reason, cid) {
  lkRoom = null; hudConnecting = false; hudTiles.clear();
  try { if (window.CoworkMarkup) window.CoworkMarkup.detach(); } catch (e) {}
  const R = (typeof LivekitClient !== 'undefined' && LivekitClient.DisconnectReason) || {};
  let msg = 'The call disconnected.', canRejoin = true;
  if (reason === R.DUPLICATE_IDENTITY) { msg = 'This HiveVideo call is already open in another HiveConnect tab/window. Close the extra one, then rejoin here.'; }
  else if (reason === R.SERVER_SHUTDOWN || reason === R.ROOM_DELETED) { msg = 'The call ended.'; }
  try { console.warn('[huddle] disconnected reason=', reason); } catch (e) {}
  const dock = $('huddle-dock');
  dock.classList.remove('hidden', 'minimized');
  const sub = $('hd-sub'); if (sub) sub.textContent = 'disconnected';
  const frame = $('hd-frame');
  if (frame) {
    frame.innerHTML = '<div class="hd-fallback">' + msg +
      '<div style="margin-top:14px;display:flex;gap:8px;justify-content:center">' +
      (canRejoin ? '<button id="hd-rejoin" class="hd-cbtn active" style="width:auto;padding:0 16px">Rejoin</button>' : '') +
      '<button id="hd-close2" class="hd-cbtn" style="width:auto;padding:0 16px">Close</button></div></div>';
    const rj = document.getElementById('hd-rejoin');
    if (rj) rj.onclick = () => { activeHuddle = null; joinHuddle(cid); };
    const cl = document.getElementById('hd-close2');
    if (cl) cl.onclick = () => leaveHuddle();
  }
}

// dock controls
$('huddle-btn').addEventListener('click', startHuddle);
{ const _hv = $('hv-start-btn'); if (_hv) _hv.addEventListener('click', () => startHuddle()); }
$('hd-leave').addEventListener('click', () => leaveHuddle());
{ const _iv = $('hd-invite-btn'); if (_iv) _iv.addEventListener('click', () => { const b = $('hd-invite'); if (b && !b.classList.contains('hidden')) closeHvInvite(); else openHvInvite(); }); }
{ const _n = $('hd-cc-notes'); if (_n) _n.addEventListener('click', () => generateAINotes()); }

/* ==================== LEFT NAV RAIL (Messages / Huddles / People) ==================== */
let navTab = 'messages';
function setNavTab(tab) {
  navTab = tab;
  document.querySelectorAll('.rail-btn[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  ['channels', 'messages', 'huddles', 'people', 'chirp', 'email', 'tasks', 'calendar', 'voip'].forEach(t => { const p = $('panel-' + t); if (p) p.classList.toggle('hidden', t !== tab); });
  const title = { channels: 'Channels', messages: 'Messages', huddles: 'HiveVideo', people: 'Contacts', chirp: 'Chirp', email: 'Email', tasks: 'Tasks', calendar: 'Calendar', voip: 'VoIP' }[tab] || 'Channels';
  const st = $('sidebar-title'); if (st) st.textContent = title;
  // Email / Tasks / Calendar / Chirp take over the main area with their own app view; others use the message pane.
  { const ev = $('email-view'); if (ev) ev.classList.toggle('hidden', tab !== 'email'); }
  { const tv = $('tasks-view'); if (tv) tv.classList.toggle('hidden', tab !== 'tasks'); }
  { const cv = $('calendar-view'); if (cv) cv.classList.toggle('hidden', tab !== 'calendar'); }
  { const chv = $('chirp-view'); if (chv) chv.classList.toggle('hidden', tab !== 'chirp'); }
  { const vv = $('voip-view'); if (vv) vv.classList.toggle('hidden', tab !== 'voip'); }
  { const sb = document.querySelector('.sidebar'); if (sb) { sb.classList.toggle('sidebar-collapsed', tab === 'voip'); sb.classList.toggle('sidebar-email-theme', tab === 'email'); } }
  // .email-view is now inset (top:12px) instead of covering .main edge-to-edge
  // like the other overlay views still do, so .main-header -- always present,
  // never otherwise hidden, same white background as the email toolbar --
  // would show through as an uneven sliver in that 12px gap unless hidden here.
  { const mh = document.querySelector('.main-header'); if (mh) mh.classList.toggle('hidden', tab === 'email'); }
  if (tab === 'huddles') renderHuddlesPanel();
  if (tab === 'people') { renderPeoplePanel(); loadContacts().then(renderPeoplePanel); }
  if (tab === 'chirp') openChirpTab();
  if (tab === 'email') { evUserPickedMailbox = false; evAcctMenuOpen = false; openEmailTab(); }
  if (tab === 'tasks') openTasksTabNative();
  if (tab === 'calendar') openCalendarTab();
  if (tab === 'voip') openVoipTab();
  updateMainHeader();
}

// Main title bar reflects the CURRENT activity, not just the last channel.
// Contacts / HiveVideo are section views; Channels / Messages show the open conversation.
function updateMainHeader() {
  const t = $('channel-title'), d = $('channel-desc'); if (!t) return;
  if (navTab === 'people') { t.textContent = 'Contacts'; if (d) d.textContent = 'Your contact directory'; return; }
  if (navTab === 'huddles') { t.textContent = 'HiveVideo'; if (d) d.textContent = 'Start or join a video call'; return; }
  if (navTab === 'chirp') { t.textContent = 'Chirp'; if (d) d.textContent = chirpClockedIn() ? 'Push-to-talk · on' : 'Push-to-talk · off'; return; }
  if (navTab === 'email') { t.textContent = 'Email'; if (d) d.textContent = emailActiveLabel(); return; }
  if (navTab === 'tasks') { t.textContent = 'Tasks'; if (d) d.textContent = 'Who owns what, and by when'; return; }
  if (navTab === 'calendar') { t.textContent = 'Calendar'; if (d) d.textContent = 'Your Outlook calendar'; return; }
  const c = channels.get(currentChannelId);
  if (navTab === 'messages') {
    // Messages is about DMs — only echo the open thing if it's actually a DM.
    if (c && c.type === 'dm') { t.textContent = channelLabel(c); if (d) d.textContent = ''; }
    else { t.textContent = 'Messages'; if (d) d.textContent = ''; }
    return;
  }
  // Channels tab — only echo the open thing if it's a real channel.
  if (c && c.type !== 'dm') { t.textContent = channelLabel(c); if (d) d.textContent = c.description || ''; }
  else { t.textContent = 'Channels'; if (d) d.textContent = ''; }
}
document.querySelectorAll('.rail-btn[data-tab]').forEach(b => b.addEventListener('click', () => setNavTab(b.dataset.tab)));
// placeholder rail buttons (Chirp, Email) — show a "coming soon" toast
document.querySelectorAll('.rail-btn[data-soon]').forEach(b => b.addEventListener('click', () => railToast(b.dataset.soon)));
let railToastT = null;
function railToast(text) {
  let t = document.getElementById('rail-toast');
  if (!t) { t = document.createElement('div'); t.id = 'rail-toast'; t.className = 'rail-toast'; document.body.appendChild(t); }
  t.textContent = text; t.classList.add('show');
  clearTimeout(railToastT); railToastT = setTimeout(() => t.classList.remove('show'), 2600);
}
window.railToast = railToast; // same reason as $/profiles/channels above -- no HiveLogic collision.

// ---- customizable folder order (drag headers to reorder; persisted per panel) ----
function applyStoredOrder(items, keyOf, storeKey) {
  // Dragged into an order once, on any machine -- see hcPref above.
  const order = hcPrefJson('order:' + storeKey, storeKey, []) || [];
  if (!order || !order.length) return items;
  const idx = k => { const i = order.indexOf(k); return i < 0 ? 999 : i; };
  return [...items].sort((a, b) => idx(keyOf(a)) - idx(keyOf(b)));
}
function enableFolderDrag(container, headerSel, folderSel, keyAttr, storeKey) {
  if (!container) return;
  let drag = null;
  container.querySelectorAll(headerSel).forEach(h => {
    const folder = h.closest(folderSel); if (!folder) return;
    h.setAttribute('draggable', 'true'); h.title = 'Drag to reorder · click to collapse';
    h.addEventListener('dragstart', e => { drag = folder; setTimeout(() => folder.classList.add('drag-ghost'), 0); try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'x'); } catch (_) {} });
    h.addEventListener('dragend', () => {
      folder.classList.remove('drag-ghost'); drag = null;
      const order = [...container.querySelectorAll(folderSel)].map(x => x.dataset[keyAttr]).filter(Boolean);
      hcPrefSet('order:' + storeKey, storeKey, order);
    });
    folder.addEventListener('dragover', e => {
      e.preventDefault(); if (!drag || drag === folder) return;
      const r = folder.getBoundingClientRect();
      const after = (e.clientY - r.top) > r.height / 2;
      folder.parentNode.insertBefore(drag, after ? folder.nextSibling : folder);
    });
  });
}

function renderCallLog() {
  const body = $('hv-log-body'); if (!body) return;
  body.innerHTML = '';
  const rows = hvCallLog.filter(r => channels.get(r.channel_id));
  if (!rows.length) {
    const e = document.createElement('div'); e.className = 'hv-log-empty';
    e.textContent = 'No calls yet.';
    body.appendChild(e); return;
  }
  for (const r of rows.slice(0, 20)) {
    const c = channels.get(r.channel_id);
    const row = document.createElement('button'); row.className = 'hv-log-row';
    if (!r.ended_at) row.classList.add('live');

    const who = document.createElement('span'); who.className = 'hv-log-who';
    who.textContent = c.type === 'dm' ? channelLabel(c) : '#' + c.name;

    const meta = document.createElement('span'); meta.className = 'hv-log-meta';
    const dur = hvCallDuration(r);
    meta.textContent = hvCallWhen(r) + ' · ' + dur;
    if (dur === 'no answer') meta.classList.add('missed');

    const left = document.createElement('span'); left.className = 'hv-log-left';
    left.appendChild(who); left.appendChild(meta);
    row.appendChild(left);

    // A transcript is the difference between "a call happened" and "here is
    // what was said", so say which one this row is.
    if (r.transcript) {
      const t = document.createElement('span'); t.className = 'hv-log-tag'; t.textContent = 'transcript';
      row.appendChild(t);
    }
    row.title = r.transcript ? 'Open the channel — this call has a transcript' : 'Open the channel';
    row.onclick = async () => {
      setNavTab('messages');
      if (currentChannelId !== r.channel_id) await openChannel(r.channel_id);
      if (r.transcript) showCallTranscript(r);
    };
    body.appendChild(row);
  }
}

// The transcript is already stored on the call; this just reads it back, with
// the same "send it to Reina" action the live captions panel offers.
function showCallTranscript(row) {
  const c = channels.get(row.channel_id);
  const where = c ? (c.type === 'dm' ? channelLabel(c) : '#' + c.name) : 'call';
  const ov = document.createElement('div'); ov.className = 'hv-tx-overlay';
  const box = document.createElement('div'); box.className = 'hv-tx-box';
  const head = document.createElement('div'); head.className = 'hv-tx-head';
  head.innerHTML = '<span>' + esc(where) + ' — ' + esc(hvCallWhen(row)) + ' · ' + esc(hvCallDuration(row)) + '</span>';
  const x = document.createElement('button'); x.className = 'hv-tx-x'; x.textContent = '✕';
  x.onclick = () => ov.remove(); head.appendChild(x);
  const bodyEl = document.createElement('pre'); bodyEl.className = 'hv-tx-body'; bodyEl.textContent = row.transcript;
  const foot = document.createElement('div'); foot.className = 'hv-tx-foot';
  const ai = document.createElement('button'); ai.className = 'hv-tx-ai'; ai.textContent = '✨ Summarize with Reina';
  ai.onclick = async () => {
    ai.disabled = true; ai.textContent = 'Sending…';
    const prompt = '@reina Please write up notes for this ' + where +
      ' — a short summary, key decisions, and action items (with owners if mentioned):\n\n' + row.transcript;
    try {
      await sb.from('messages').insert({ channel_id: row.channel_id, user_id: me.id, content: prompt.slice(0, 6000) });
      ai.textContent = 'Sent to Reina 🐝';
    } catch (e) { ai.disabled = false; ai.textContent = "Couldn't send — try again"; }
  };
  foot.appendChild(ai);
  box.appendChild(head); box.appendChild(bodyEl); box.appendChild(foot);
  ov.appendChild(box);
  ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
  document.body.appendChild(ov);
}

let hvCollapsed = new Set();
function renderHuddlesPanel() {
  const el = $('panel-huddles'); if (!el) return; el.innerHTML = '';
  // Start HiveVideo CTA
  const cta = document.createElement('button'); cta.className = 'hv-cta';
  cta.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg> Start HiveVideo';
  cta.onclick = () => startHuddle();
  el.appendChild(cta);
  // Active now
  const active = [...huddleState.entries()].filter(([cid, parts]) => (parts || []).length && channels.get(cid));
  if (active.length) {
    const secA = document.createElement('div'); secA.className = 'hp-sec';
    const hA = document.createElement('div'); hA.className = 'hp-head'; hA.textContent = 'Active now'; secA.appendChild(hA);
    active.forEach(([cid, parts]) => {
      const c = channels.get(cid);
      const row = document.createElement('button'); row.className = 'hp-row live';
      const ic = document.createElement('span'); ic.className = 'hp-ic'; ic.textContent = '🎧'; row.appendChild(ic);
      const nm = document.createElement('span'); nm.className = 'hp-name'; nm.textContent = c.type === 'dm' ? channelLabel(c) : '#' + c.name; row.appendChild(nm);
      const bg = document.createElement('span'); bg.className = 'hp-badge'; bg.textContent = parts.length; row.appendChild(bg);
      row.onclick = async () => { setNavTab('messages'); if (currentChannelId !== cid) await openChannel(cid); joinHuddle(cid); };
      secA.appendChild(row);
    });
    el.appendChild(secA);
  }
  // Recent calls. Before this there was no record of a call at all -- the panel
  // could only ever show what was happening right now.
  const secL = document.createElement('div'); secL.className = 'hp-sec'; secL.id = 'hv-log-sec';
  const hL = document.createElement('div'); hL.className = 'hp-head';
  hL.textContent = 'Recent calls';
  secL.appendChild(hL);
  const logBody = document.createElement('div'); logBody.id = 'hv-log-body';
  logBody.innerHTML = '<div class="hv-log-empty">Loading…</div>';
  secL.appendChild(logBody);
  el.appendChild(secL);
  loadCallLog().then(renderCallLog);

  // Channel folders — click a channel to start HiveVideo there (drag headers to reorder)
  const wrap = document.createElement('div'); el.appendChild(wrap);
  const allChans = [...channels.values()].filter(c => c.type !== 'dm' && !c.archived);
  for (const div of applyStoredOrder(DIVISIONS, d => d.key, 'hcHvOrder')) {
    const chans = allChans.filter(c => (c.category || 'channels') === div.key).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    if (!chans.length) continue;
    const collapsed = hvCollapsed.has(div.key);
    const folder = document.createElement('div'); folder.className = 'division' + (collapsed ? ' collapsed' : ''); folder.dataset.key = div.key; folder.style.setProperty('--cat', div.color);
    const head = document.createElement('button'); head.className = 'div-head';
    head.innerHTML = `<span class="fold-grip" aria-hidden="true">⠿</span><span class="div-bar" style="background:${div.color}"></span><span class="div-badge" style="background:${hexA(div.color, .16)};color:${div.color}">${div.icon}</span><span class="div-label">${div.label}</span><span class="div-count"></span><span class="div-chev">▾</span>`;
    head.onclick = () => { hvCollapsed.has(div.key) ? hvCollapsed.delete(div.key) : hvCollapsed.add(div.key); folder.classList.toggle('collapsed'); };
    folder.appendChild(head);
    const body = document.createElement('div'); body.className = 'div-body';
    const ul = document.createElement('ul'); ul.className = 'channel-list';
    chans.forEach(c => {
      const li = document.createElement('li');
      const nm = document.createElement('span'); nm.className = 'cname'; nm.textContent = '# ' + c.name; li.appendChild(nm);
      const call = document.createElement('span'); call.className = 'hp-call'; call.textContent = 'Call'; li.appendChild(call);
      if (huddleParticipants(c.id).length) { const h = document.createElement('span'); h.className = 'huddle-badge'; h.textContent = '🎧'; li.appendChild(h); }
      li.onclick = async () => { setNavTab('messages'); if (currentChannelId !== c.id) await openChannel(c.id); joinHuddle(c.id); };
      ul.appendChild(li);
    });
    body.appendChild(ul); folder.appendChild(body); wrap.appendChild(folder);
  }
  enableFolderDrag(wrap, '.div-head', '.division', 'key', 'hcHvOrder');
}

let contactSearch = '';
let contactsData = [];
const contactOpen = { 'Team': true, 'Vendor': true, 'Client': true, 'External': true };
const CT_ORDER = [['team', 'Team'], ['vendor', 'Vendor'], ['client', 'Client'], ['external', 'External']];
async function loadContacts() {
  try { const { data } = await sb.from('contacts').select('*'); contactsData = data || []; }
  catch (e) { contactsData = []; }
}
function renderPeoplePanel() {
  const el = $('panel-people'); if (!el) return;
  el.innerHTML = '';
  const add = document.createElement('button'); add.className = 'new-channel-cta'; add.id = 'ct-add';
  add.innerHTML = '<span>＋</span> New contact'; add.onclick = () => openContactCard(null);
  el.appendChild(add);
  const search = document.createElement('input');
  search.id = 'ct-search'; search.className = 'ct-search'; search.type = 'text'; search.placeholder = 'Search contacts…'; search.value = contactSearch;
  search.addEventListener('input', () => { contactSearch = search.value; applyContactFilter(); });
  el.appendChild(search);
  applyStoredOrder(CT_ORDER, x => x[0], 'hcContactOrder').forEach(([type, label]) => {
    const list = contactsData.filter(c => (c.contact_type || 'external') === type).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const folder = document.createElement('div'); folder.className = 'ct-folder' + (contactOpen[label] ? '' : ' collapsed'); folder.dataset.folder = label; folder.dataset.type = type;
    const head = document.createElement('button'); head.className = 'ct-head';
    const grip = document.createElement('span'); grip.className = 'fold-grip'; grip.textContent = '⠿'; grip.setAttribute('aria-hidden', 'true'); head.appendChild(grip);
    const chev = document.createElement('span'); chev.className = 'ct-chev'; chev.textContent = '▾'; head.appendChild(chev);
    const fn = document.createElement('span'); fn.className = 'ct-fname'; fn.textContent = label; head.appendChild(fn);
    const fc = document.createElement('span'); fc.className = 'ct-fcount'; fc.textContent = list.length || ''; head.appendChild(fc);
    head.onclick = () => { const col = folder.classList.toggle('collapsed'); contactOpen[label] = !col; };
    folder.appendChild(head);
    const body = document.createElement('div'); body.className = 'ct-body';
    if (!list.length) { const e = document.createElement('div'); e.className = 'ct-empty'; e.textContent = 'None yet — tap ＋ New contact'; body.appendChild(e); }
    list.forEach(c => {
      const row = document.createElement('button'); row.className = 'hp-row ct-row';
      row.dataset.name = ((c.name || '') + ' ' + (c.company || '') + ' ' + (c.email || '')).toLowerCase();
      const prof = c.profile_id ? profiles.get(c.profile_id) : null;
      const av = prof ? (avatarWithPresence ? avatarWithPresence(prof) : avatarEl(prof, 'avatar')) : avatarEl({ display_name: c.name || '?' }, 'avatar');
      av.classList.add('hp-av'); row.appendChild(av);
      const nm = document.createElement('span'); nm.className = 'hp-name'; nm.textContent = c.name || '(no name)';
      if (c.company) { const co = document.createElement('span'); co.className = 'ct-co'; co.textContent = ' · ' + c.company; nm.appendChild(co); }
      row.appendChild(nm);
      const call = document.createElement('span'); call.className = 'hp-call'; call.textContent = 'Open'; row.appendChild(call);
      row.onclick = () => openContactCard(c);
      body.appendChild(row);
    });
    folder.appendChild(body); el.appendChild(folder);
  });
  enableFolderDrag($('panel-people'), '.ct-head', '.ct-folder', 'type', 'hcContactOrder');
  applyContactFilter();
}
function applyContactFilter() {
  const q = (contactSearch || '').trim().toLowerCase();
  document.querySelectorAll('#panel-people .ct-folder').forEach(folder => {
    let any = false;
    folder.querySelectorAll('.ct-row').forEach(row => {
      const match = !q || (row.dataset.name || '').includes(q);
      row.style.display = match ? '' : 'none'; if (match) any = true;
    });
    if (q) { folder.classList.remove('collapsed'); folder.style.display = any ? '' : 'none'; }
    else { folder.style.display = ''; }
  });
}

// Contact card: view / edit a full contact record + quick actions
function openContactCard(c) {
  const isNew = !c;
  c = c || { contact_type: 'vendor', name: '', email: '', phone: '', company: '', title: '', notes: '' };
  const old = document.getElementById('contact-card'); if (old) old.remove();
  const prof = c.profile_id ? profiles.get(c.profile_id) : null;
  const canEdit = me.role === 'owner' || me.role === 'admin';
  const opt = (v, l) => '<option value="' + v + '"' + (c.contact_type === v ? ' selected' : '') + '>' + l + '</option>';
  const ov = document.createElement('div'); ov.id = 'contact-card'; ov.className = 'modal-backdrop';
  ov.innerHTML = '<div class="modal cc-modal">' +
    '<button class="cc-x" id="cc-x" title="Close">✕</button>' +
    '<div class="cc-top"><div class="cc-av" id="cc-av"></div><div class="cc-name" id="cc-name"></div><div class="cc-role" id="cc-role"></div></div>' +
    '<div class="cc-actions">' +
      (c.profile_id ? '<button class="cc-act" id="cc-dm"><span class="cc-act-ic">💬</span>Message</button><button class="cc-act" id="cc-video"><span class="cc-act-ic">🎥</span>Video</button>' : '') +
      '<button class="cc-act" id="cc-email"><span class="cc-act-ic">✉️</span>Email</button>' +
      (c.profile_id ? '<button class="cc-act" id="cc-chirp"><span class="cc-act-ic">📡</span>Chirp</button>' : '') +
    '</div>' +
    '<div class="cc-fields">' +
      '<div class="cc-field"><label>Type</label><select id="cc-f-type" class="rec-input">' + opt('team', 'Team') + opt('vendor', 'Vendor') + opt('client', 'Client') + opt('external', 'External') + '</select></div>' +
      '<div class="cc-field"><label>Name</label><input id="cc-f-name" class="rec-input"></div>' +
      '<div class="cc-field"><label>Company</label><input id="cc-f-company" class="rec-input"></div>' +
      '<div class="cc-field"><label>Title</label><input id="cc-f-title" class="rec-input"></div>' +
      '<div class="cc-field"><label>Email</label><input id="cc-f-email" class="rec-input" type="email"></div>' +
      '<div class="cc-field"><label>Phone</label><input id="cc-f-phone" class="rec-input" type="tel"></div>' +
      '<div class="cc-field"><label>Notes</label><textarea id="cc-f-notes" class="rec-input" rows="3"></textarea></div>' +
    '</div>' +
    '<div class="cc-foot">' + (!isNew && canEdit ? '<button class="cc-del" id="cc-del">Delete</button>' : '') + '<button class="primary-btn" id="cc-save">' + (isNew ? 'Add contact' : 'Save') + '</button></div>' +
    '</div>';
  document.body.appendChild(ov);
  const av = prof ? avatarEl(prof, 'avatar') : avatarEl({ display_name: c.name || '?' }, 'avatar'); av.classList.add('cc-av-img'); $('cc-av').appendChild(av);
  $('cc-name').textContent = c.name || 'New contact';
  $('cc-role').textContent = { team: 'Team · GH Group', vendor: 'Vendor', client: 'Client', external: 'External' }[c.contact_type] || '';
  $('cc-f-name').value = c.name || ''; $('cc-f-company').value = c.company || ''; $('cc-f-title').value = c.title || '';
  $('cc-f-email').value = c.email || ''; $('cc-f-phone').value = c.phone || ''; $('cc-f-notes').value = c.notes || '';
  if (!canEdit) ov.querySelectorAll('.rec-input').forEach(i => i.disabled = true);
  const close = () => ov.remove();
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  $('cc-x').onclick = close;
  const dm = $('cc-dm'); if (dm) dm.onclick = async () => { close(); setNavTab('messages'); await startDM(c.profile_id); };
  const vid = $('cc-video'); if (vid) vid.onclick = async () => { close(); setNavTab('messages'); await startDM(c.profile_id); if (currentChannelId) joinHuddle(currentChannelId); };
  $('cc-email').onclick = () => { const em = ($('cc-f-email').value || '').trim(); if (em) window.location.href = 'mailto:' + em; else railToast('No email on file yet'); };
  const chirp = $('cc-chirp'); if (chirp) chirp.onclick = () => { close(); setNavTab('chirp'); if (!chirpClockedIn()) { chirpApplyGate(); railToast('Turn Chirp on to use it'); } else chirpStartLine(c.profile_id); };
  const del = $('cc-del'); if (del) del.onclick = async () => { if (c.id) { try { await sb.from('contacts').delete().eq('id', c.id); } catch (e) {} } await loadContacts(); renderPeoplePanel(); close(); };
  $('cc-save').onclick = async () => {
    if (!canEdit) { close(); return; }
    const rec = {
      contact_type: $('cc-f-type').value,
      name: ($('cc-f-name').value || '').trim(),
      company: ($('cc-f-company').value || '').trim() || null,
      title: ($('cc-f-title').value || '').trim() || null,
      email: ($('cc-f-email').value || '').trim() || null,
      phone: ($('cc-f-phone').value || '').trim() || null,
      notes: ($('cc-f-notes').value || '').trim() || null,
    };
    if (!rec.name) { $('cc-f-name').focus(); return; }
    try {
      if (isNew) { rec.created_by = me.id; await sb.from('contacts').insert(rec); }
      else { await sb.from('contacts').update(rec).eq('id', c.id); }
    } catch (e) { railToast("Couldn't save — check your access."); }
    await loadContacts(); renderPeoplePanel(); close();
  };
}

// Help overlay
{
  const hb = $('help-btn');
  if (hb) hb.addEventListener('click', () => {
    let ov = document.getElementById('help-overlay');
    if (ov) { ov.remove(); return; }
    ov = document.createElement('div'); ov.id = 'help-overlay'; ov.className = 'modal-backdrop';
    ov.innerHTML = '<div class="modal" style="max-width:440px">' +
      '<h2>HiveConnect — quick help</h2>' +
      '<div style="font-size:13.5px;line-height:1.7;color:var(--mut)">' +
      '<b>Messages</b> — your channels &amp; DMs.<br>' +
      '<b>HiveVideo</b> — start or join a video call in any channel; everyone in it can join.<br>' +
      '<b>People</b> — your team; click someone to message them.<br>' +
      'In a call: <b>▾</b> next to the mic/camera picks your device, <b>CC</b> shows live captions, <b>Record</b> saves the call, <b>✨ AI notes</b> asks Reina to summarize.<br>' +
      'Type <b>@reina</b> in any channel to ask the AI assistant.' +
      '</div>' +
      '<div style="margin-top:18px;text-align:right"><button class="btn-primary" id="help-close">Got it</button></div></div>';
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.addEventListener('click', e => { if (e.target === ov) close(); });
    const cb = document.getElementById('help-close'); if (cb) cb.onclick = close;
  });
}
/* Pop-out lived only as an unlabelled icon in the second row of the in-call
   control bar, which is not where anyone looks for it.

   Chris, 2026-08-23: "its still locked into the view of HiveLogic, it needs to
   be a window on its own that can be pull out of the view of hive logic" -- it
   already could; he just had no way to know that. Window controls belong in
   the title bar next to minimize and expand, which is where every other app
   puts them. The control-bar button stays, so muscle memory keeps working. */
{
  const top = $('hd-popout-top');
  if (top) {
    if ('documentPictureInPicture' in window) {
      top.classList.remove('hidden');
      top.addEventListener('click', () => togglePopout());
    }
    // Left hidden on a browser that can't do it, rather than offering a button
    // that silently does nothing (requestWindow() rejects and we swallow it).
  }
}
$('hd-min').addEventListener('click', () => {
  const d = $('huddle-dock');
  d.style.width = ''; d.style.height = '';   // drop any manual resize so the class controls size
  d.classList.toggle('minimized'); d.classList.remove('expanded');
});
$('hd-expand').addEventListener('click', () => {
  const d = $('huddle-dock');
  d.style.width = ''; d.style.height = '';
  d.style.left = ''; d.style.top = ''; d.style.right = ''; d.style.bottom = '';
  d.classList.toggle('hd-full'); d.classList.remove('minimized', 'expanded');
  if (d.classList.contains('hd-full')) return;
  clampDock();
});

// ---- drag the huddle dock around by its header ----
(function makeDockDraggable() {
  const dock = $('huddle-dock');
  const bar = dock && dock.querySelector('.hd-bar');
  if (!bar) return;
  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
  const start = (cx, cy, e) => {
    if (e.target.closest('.hd-ctl, .hd-leave')) return;   // let buttons work
    const r = dock.getBoundingClientRect();
    dock.style.left = r.left + 'px'; dock.style.top = r.top + 'px';
    dock.style.right = 'auto'; dock.style.bottom = 'auto';
    dragging = true; sx = cx; sy = cy; ox = r.left; oy = r.top;
    dock.classList.add('dragging');
  };
  const move = (cx, cy) => {
    if (!dragging) return;
    const r = dock.getBoundingClientRect();
    let nx = ox + (cx - sx), ny = oy + (cy - sy);
    nx = Math.max(4, Math.min(nx, window.innerWidth - r.width - 4));
    ny = Math.max(4, Math.min(ny, window.innerHeight - r.height - 4));
    dock.style.left = nx + 'px'; dock.style.top = ny + 'px';
  };
  const end = () => { dragging = false; dock.classList.remove('dragging'); };
  bar.addEventListener('mousedown', e => { start(e.clientX, e.clientY, e); e.preventDefault(); });
  window.addEventListener('mousemove', e => move(e.clientX, e.clientY));
  window.addEventListener('mouseup', end);
  bar.addEventListener('touchstart', e => { const t = e.touches[0]; start(t.clientX, t.clientY, e); }, { passive: true });
  window.addEventListener('touchmove', e => { if (dragging) { const t = e.touches[0]; move(t.clientX, t.clientY); e.preventDefault(); } }, { passive: false });
  window.addEventListener('touchend', end);
  window.addEventListener('resize', clampDock);

  // ---- resize the dock by dragging the bottom-right corner ----
  let handle = dock.querySelector('.hd-resize');
  if (!handle) { handle = document.createElement('div'); handle.className = 'hd-resize'; dock.appendChild(handle); }
  let rz = false, rsx = 0, rsy = 0, rw = 0, rh0 = 0;
  const rstart = (cx, cy) => {
    const r = dock.getBoundingClientRect();
    dock.style.left = r.left + 'px'; dock.style.top = r.top + 'px';
    dock.style.right = 'auto'; dock.style.bottom = 'auto';
    rz = true; rsx = cx; rsy = cy; rw = r.width; rh0 = r.height;
    dock.classList.remove('minimized', 'expanded', 'hd-full'); dock.classList.add('dragging');
  };
  const rmove = (cx, cy) => {
    if (!rz) return;
    dock.style.width = Math.max(280, Math.min(rw + (cx - rsx), window.innerWidth - 12)) + 'px';
    dock.style.height = Math.max(210, Math.min(rh0 + (cy - rsy), window.innerHeight - 12)) + 'px';
  };
  const rend = () => { rz = false; dock.classList.remove('dragging'); };
  handle.addEventListener('mousedown', e => { rstart(e.clientX, e.clientY); e.preventDefault(); e.stopPropagation(); });
  window.addEventListener('mousemove', e => rmove(e.clientX, e.clientY));
  window.addEventListener('mouseup', rend);
  handle.addEventListener('touchstart', e => { const t = e.touches[0]; rstart(t.clientX, t.clientY); }, { passive: true });
  window.addEventListener('touchmove', e => { if (rz) { const t = e.touches[0]; rmove(t.clientX, t.clientY); e.preventDefault(); } }, { passive: false });
  window.addEventListener('touchend', rend);
})();

// keep the dock fully on-screen (after expand/resize)
function clampDock() {
  const dock = $('huddle-dock'); if (!dock || dock.classList.contains('hidden')) return;
  requestAnimationFrame(() => {
    const r = dock.getBoundingClientRect();
    if (dock.style.left) {  // only when free-positioned (dragged)
      let nx = Math.max(4, Math.min(r.left, window.innerWidth - r.width - 4));
      let ny = Math.max(4, Math.min(r.top, window.innerHeight - r.height - 4));
      dock.style.left = nx + 'px'; dock.style.top = ny + 'px';
    }
  });
}

// leave the huddle cleanly if the tab closes
window.addEventListener('beforeunload', () => { if (activeHuddle) leaveHuddle(true); });

// ---------- Settings menu ----------
const settingsMenu = $('settings-menu');
$('settings-btn').addEventListener('click', e => {
  e.stopPropagation();
  settingsMenu.classList.toggle('hidden');
});
document.addEventListener('click', e => {
  if (!e.target.closest('#settings-menu') && !e.target.closest('#settings-btn')) settingsMenu.classList.add('hidden');
});
$('sm-profile').addEventListener('click', () => { settingsMenu.classList.add('hidden'); openProfile(); });
$('me-chip').addEventListener('click', openProfile);
$('sm-password').addEventListener('click', () => {
  settingsMenu.classList.add('hidden');
  $('pw-new').value = ''; $('pw-confirm').value = '';
  const msg = $('pw-msg'); msg.classList.add('hidden'); msg.style.color = '';
  $('pw-backdrop').classList.remove('hidden'); $('pw-new').focus();
});
$('sm-admin').addEventListener('click', () => { settingsMenu.classList.add('hidden'); openAdmin(); });
$('sm-notif').addEventListener('click', () => {
  notifsEnabled = !notifsEnabled;
  hcPrefSet('hcNotifs', 'hive_notifs', notifsEnabled ? 'on' : 'off');
  $('sm-notif-state').textContent = notifsEnabled ? 'On' : 'Off';
  if (notifsEnabled && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
});
$('sm-signout').addEventListener('click', async () => { await sb.auth.signOut(); location.reload(); });

// ---------- Dark mode ----------
function applyTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  $('sm-theme-state').textContent = dark ? 'On' : 'Off';
  $('sm-theme-ic').textContent = dark ? '☀️' : '🌙';
  $('sm-theme-label').textContent = dark ? 'Light mode' : 'Dark mode';
}
applyTheme(hcPref('hcTheme', 'hive_theme', 'light') === 'dark' ? 'dark' : 'light');
// The cache painted the last known theme above. When the record lands a moment
// later it may disagree -- he changed it on another machine -- and the record
// is the one that is right.
try { if (window.hlUserSettings) window.hlUserSettings.ready(() => applyTheme(hcPref('hcTheme', 'hive_theme', 'light') === 'dark' ? 'dark' : 'light')); } catch (e) {}
$('sm-theme').addEventListener('click', () => {
  const next = (hcPref('hcTheme', 'hive_theme', 'light') === 'dark') ? 'light' : 'dark';
  hcPrefSet('hcTheme', 'hive_theme', next);
  applyTheme(next);
});

// ================= Audio & mic settings (shared by Chirp + HiveVideo) =================
// One saved mic / speaker / volume, applied everywhere audio plays or is captured.
function audioPrefs() {
  let v = parseFloat(hcPref('hcVolume', 'hive_vol', ''));
  if (isNaN(v)) v = 1;
  return {
    // Deliberately NOT hcPref: which mic and which speaker are about this
    // machine. Carrying the choice across would name a device that is not
    // plugged into the next one. See CLAUDE.md, exception 1.
    mic: localStorage.getItem('hive_mic') || '',
    speaker: localStorage.getItem('hive_speaker') || '',
    vol: Math.max(0, Math.min(1, v)),
  };
}
// Apply saved output device + volume to one <audio>/<video> element.
function applyAudioOut(el) {
  if (!el) return;
  const p = audioPrefs();
  try { el.volume = p.vol; } catch (e) {}
  if (p.speaker && typeof el.setSinkId === 'function') { try { el.setSinkId(p.speaker).catch(() => {}); } catch (e) {} }
}
// Point a LiveKit room's mic input at the saved device.
async function applyMicPref(room) {
  const p = audioPrefs();
  if (p.mic && room && typeof room.switchActiveDevice === 'function') {
    try { await room.switchActiveDevice('audioinput', p.mic); } catch (e) {}
  }
}
// Re-apply output prefs to everything currently playing (on volume/speaker change).
function applyAudioPrefsLive() {
  document.querySelectorAll('audio, video.hd-video').forEach(applyAudioOut);
}

let audioTestStream = null, audioTestRAF = null, audioTestCtx = null;
function stopMicTest() {
  if (audioTestRAF) { cancelAnimationFrame(audioTestRAF); audioTestRAF = null; }
  if (audioTestStream) { try { audioTestStream.getTracks().forEach(t => t.stop()); } catch (e) {} audioTestStream = null; }
  if (audioTestCtx) { try { audioTestCtx.close(); } catch (e) {} audioTestCtx = null; }
  const fill = $('aud-meter-fill'); if (fill) fill.style.width = '0%';
  const btn = $('aud-test'); if (btn) btn.textContent = 'Test mic';
}
async function startMicTest() {
  stopMicTest();
  const p = audioPrefs();
  const constraints = { audio: p.mic ? { deviceId: { exact: p.mic } } : true };
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia(constraints); }
  catch (e) { const m = $('aud-msg'); if (m) { m.textContent = 'Mic blocked — allow microphone access in your browser.'; m.classList.remove('hidden'); } return; }
  const m = $('aud-msg'); if (m) m.classList.add('hidden');
  audioTestStream = stream;
  const btn = $('aud-test'); if (btn) btn.textContent = 'Stop test';
  const Ctx = window.AudioContext || window.webkitAudioContext;
  audioTestCtx = new Ctx();
  const src = audioTestCtx.createMediaStreamSource(stream);
  const an = audioTestCtx.createAnalyser(); an.fftSize = 512;
  src.connect(an);
  const data = new Uint8Array(an.frequencyBinCount);
  const fill = $('aud-meter-fill');
  (function tick() {
    an.getByteTimeDomainData(data);
    let peak = 0; for (let i = 0; i < data.length; i++) { const d = Math.abs(data[i] - 128); if (d > peak) peak = d; }
    if (fill) fill.style.width = Math.min(100, Math.round((peak / 128) * 160)) + '%';
    audioTestRAF = requestAnimationFrame(tick);
  })();
}
async function populateAudioDevices() {
  // Ask for mic once so device labels are readable, then list them.
  try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach(t => t.stop()); } catch (e) {}
  let devices = [];
  try { devices = await navigator.mediaDevices.enumerateDevices(); } catch (e) {}
  const p = audioPrefs();
  function fill(sel, kind, prefVal, base, withDefault) {
    if (!sel) return;
    const list = devices.filter(d => d.kind === kind && d.deviceId);
    sel.innerHTML = '';
    if (withDefault) { const o = document.createElement('option'); o.value = ''; o.textContent = 'System default'; sel.appendChild(o); }
    if (!list.length && kind === 'audioinput') { const o = document.createElement('option'); o.value = ''; o.textContent = 'No microphone found'; sel.appendChild(o); }
    list.forEach((d, i) => { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || (base + ' ' + (i + 1)); if (d.deviceId === prefVal) o.selected = true; sel.appendChild(o); });
  }
  fill($('aud-mic'), 'audioinput', p.mic, 'Microphone', false);
  fill($('aud-speaker'), 'audiooutput', p.speaker, 'Speaker', true);
  const spk = $('aud-speaker');
  if (spk && !('setSinkId' in HTMLMediaElement.prototype)) { spk.disabled = true; const note = $('aud-spk-note'); if (note) note.classList.remove('hidden'); }
}
function openAudioSettings() {
  const bd = $('audio-backdrop'); if (!bd) return;
  const msg = $('aud-msg'); if (msg) msg.classList.add('hidden');
  const p = audioPrefs();
  const vol = $('aud-vol'); if (vol) vol.value = Math.round(p.vol * 100);
  const vl = $('aud-vol-val'); if (vl) vl.textContent = Math.round(p.vol * 100) + '%';
  bd.classList.remove('hidden');
  populateAudioDevices();
}
function closeAudioSettings() { stopMicTest(); const bd = $('audio-backdrop'); if (bd) bd.classList.add('hidden'); }

(function wireAudioSettings() {
  const sm = $('sm-audio');
  if (sm) sm.addEventListener('click', () => { settingsMenu.classList.add('hidden'); openAudioSettings(); });
  const mic = $('aud-mic');
  if (mic) mic.addEventListener('change', () => {
    localStorage.setItem('hive_mic', mic.value);
    if (audioTestStream) startMicTest();                 // retest with the new mic
    if (typeof chirpRoom !== 'undefined' && chirpRoom) applyMicPref(chirpRoom);
    if (typeof lkRoom !== 'undefined' && lkRoom) applyMicPref(lkRoom);
  });
  const spk = $('aud-speaker');
  if (spk) spk.addEventListener('change', () => { localStorage.setItem('hive_speaker', spk.value); applyAudioPrefsLive(); });
  const vol = $('aud-vol');
  if (vol) vol.addEventListener('input', () => {
    const v = (parseInt(vol.value, 10) || 0) / 100;
    hcPrefSet('hcVolume', 'hive_vol', String(v));
    const vl = $('aud-vol-val'); if (vl) vl.textContent = Math.round(v * 100) + '%';
    applyAudioPrefsLive();
  });
  const test = $('aud-test');
  if (test) test.addEventListener('click', () => { if (audioTestStream) stopMicTest(); else startMicTest(); });
  const done = $('aud-done');
  if (done) done.addEventListener('click', closeAudioSettings);
  const bd = $('audio-backdrop');
  if (bd) bd.addEventListener('click', e => { if (e.target === bd) closeAudioSettings(); });
})();

// (legacy DM collapse handler removed — Messages panel now renders its own folders)

// ================= Reusable recipient chip-autocomplete =================
// People you can address (real accounts), enriched with contact-card metadata.
function pickerPeople() {
  return [...profiles.values()]
    .filter(p => p.id !== me.id && p.username !== 'slackarchive' && p.active !== false)
    .map(p => {
      const c = contactsData.find(x => x.profile_id === p.id);
      return {
        id: p.id, name: p.display_name || p.username, username: p.username || '',
        sub: c ? [c.title, c.company].filter(Boolean).join(' · ') : '',
        avatar_url: p.avatar_url, avatar_color: p.avatar_color,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// createRecipientPicker({placeholder, onChange, exclude:Set}) -> {el, getSelected, clear, focus, addById}
function createRecipientPicker(opts = {}) {
  const exclude = opts.exclude || new Set();
  const selected = new Map(); // id -> person
  let active = -1;

  const wrap = document.createElement('div'); wrap.className = 'rp-wrap';
  const chips = document.createElement('div'); chips.className = 'rp-chips';
  const input = document.createElement('input'); input.className = 'rp-input'; input.type = 'text';
  input.placeholder = opts.placeholder || 'Type a name…'; input.autocomplete = 'off';
  const menu = document.createElement('div'); menu.className = 'rp-menu hidden';
  chips.appendChild(input); wrap.appendChild(chips); wrap.appendChild(menu);

  function fire() { if (opts.onChange) opts.onChange([...selected.keys()]); }
  function renderChips() {
    [...chips.querySelectorAll('.rp-chip')].forEach(x => x.remove());
    for (const p of selected.values()) {
      const chip = document.createElement('span'); chip.className = 'rp-chip' + (p.external ? ' rp-chip-ext' : '');
      if (p.external) { const ic = document.createElement('span'); ic.className = 'rp-chip-av rp-chip-extic'; ic.textContent = '✉'; chip.appendChild(ic); }
      else { chip.appendChild(avatarEl({ display_name: p.name, username: p.username, avatar_url: p.avatar_url, avatar_color: p.avatar_color }, 'rp-chip-av')); }
      const nm = document.createElement('span'); nm.textContent = p.external ? p.name : p.name.split(' ')[0]; chip.appendChild(nm);
      const x = document.createElement('button'); x.className = 'rp-chip-x'; x.textContent = '✕';
      x.onclick = () => { selected.delete(p.id); renderChips(); renderMenu(); fire(); input.focus(); };
      chip.appendChild(x);
      chips.insertBefore(chip, input);
    }
  }
  let rows = [];   // current menu items (people and/or an external entry)
  function candidates() {
    const q = input.value.trim().toLowerCase();
    return pickerPeople().filter(p => !selected.has(p.id) && !exclude.has(p.id))
      .filter(p => !q || p.name.toLowerCase().includes(q) || p.username.toLowerCase().includes(q))
      .slice(0, 8);
  }
  function renderMenu() {
    const list = candidates(); menu.innerHTML = ''; active = -1; rows = list.slice();
    const q = input.value.trim();
    // Opt-in: let you invite someone who isn't in the list yet (external guest).
    let ext = null;
    if (opts.allowExternal && q.length >= 2) {
      const exact = list.some(p => p.name.toLowerCase() === q.toLowerCase());
      const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q);
      if (!exact) { ext = { id: 'ext:' + q.toLowerCase(), external: true, email: isEmail ? q : '', name: q, username: '' }; }
    }
    if (!list.length && !ext) { menu.classList.add('hidden'); return; }
    list.forEach(p => {
      const row = document.createElement('div'); row.className = 'rp-item';
      row.appendChild(avatarEl({ display_name: p.name, username: p.username, avatar_url: p.avatar_url, avatar_color: p.avatar_color }, 'rp-item-av'));
      const t = document.createElement('div'); t.className = 'rp-item-txt';
      const n = document.createElement('div'); n.className = 'rp-item-name'; n.textContent = p.name; t.appendChild(n);
      if (p.sub) { const s = document.createElement('div'); s.className = 'rp-item-sub'; s.textContent = p.sub; t.appendChild(s); }
      row.appendChild(t);
      if (onlineUsers.has(p.id)) { const d = document.createElement('span'); d.className = 'rp-item-dot'; row.appendChild(d); }
      row.onclick = () => add(p);
      menu.appendChild(row);
    });
    if (ext) {
      rows.push(ext);
      const row = document.createElement('div'); row.className = 'rp-item rp-ext';
      const ic = document.createElement('span'); ic.className = 'rp-ext-ic'; ic.textContent = '＋'; row.appendChild(ic);
      const t = document.createElement('div'); t.className = 'rp-item-txt';
      const n = document.createElement('div'); n.className = 'rp-item-name'; n.textContent = 'Invite “' + ext.name + '”'; t.appendChild(n);
      const s = document.createElement('div'); s.className = 'rp-item-sub'; s.textContent = ext.email ? 'New external guest — sends an invite link' : 'New external guest — generates an invite link'; t.appendChild(s);
      row.appendChild(t);
      row.onclick = () => add(ext);
      menu.appendChild(row);
    }
    menu.classList.remove('hidden');
  }
  function highlight() {
    [...menu.children].forEach((r, i) => r.classList.toggle('active', i === active));
  }
  function add(p) { selected.set(p.id, p); input.value = ''; renderChips(); renderMenu(); fire(); input.focus(); }

  input.addEventListener('input', renderMenu);
  input.addEventListener('focus', renderMenu);
  input.addEventListener('keydown', e => {
    const rows = [...menu.children];
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, rows.length - 1); highlight(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); highlight(); }
    else if (e.key === 'Enter') {
      if (rows.length) { e.preventDefault(); add(rows[active >= 0 ? active : 0]); }
    } else if (e.key === 'Backspace' && !input.value && selected.size) {
      const last = [...selected.keys()].pop(); selected.delete(last); renderChips(); renderMenu(); fire();
    } else if (e.key === 'Escape') { menu.classList.add('hidden'); }
  });
  document.addEventListener('click', e => { if (!wrap.contains(e.target)) menu.classList.add('hidden'); });

  return {
    el: wrap,
    getSelected: () => [...selected.keys()],
    getItems: () => [...selected.values()],
    clear: () => { selected.clear(); input.value = ''; renderChips(); menu.classList.add('hidden'); fire(); },
    focus: () => input.focus(),
    addById: id => { const p = pickerPeople().find(x => x.id === id); if (p) add(p); },
  };
}

// ================= Group DM support =================
function dmMemberIds(c) { return (c.dm_key || '').split(':').filter(Boolean); }
function dmOtherProfiles(c) { return dmMemberIds(c).filter(id => id !== me.id).map(id => profiles.get(id)).filter(Boolean); }
function isGroupDM(c) { return c && c.type === 'dm' && dmMemberIds(c).length > 2; }
function dmGroupLabel(c) {
  const names = dmOtherProfiles(c).map(p => (p.display_name || 'Someone').split(' ')[0]);
  if (!names.length) return 'Group';
  return names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : '');
}

// Create (or reuse) a multi-person DM; opens it. Returns channel id.
async function startGroupDM(otherIds) {
  const ids = [...new Set(otherIds.filter(Boolean))];
  if (ids.length === 1) { await startDM(ids[0]); return currentChannelId; }
  if (!ids.length) return null;
  const key = [me.id, ...ids].sort().join(':');
  let dm = [...channels.values()].find(c => c.dm_key === key);
  if (!dm) {
    const { data, error } = await sb.from('channels')
      .insert({ type: 'dm', dm_key: key, created_by: me.id }).select().single();
    if (error) {
      const { data: existing } = await sb.from('channels').select('*').eq('dm_key', key).single();
      dm = existing;
    } else {
      dm = data;
      const rows = [me.id, ...ids].map(uid => ({ channel_id: dm.id, user_id: uid }));
      await sb.from('channel_members').insert(rows);
    }
    if (dm) channels.set(dm.id, dm);
  }
  if (!dm) return null;
  if (!memberships.has(dm.id)) {
    const { data: mem } = await sb.from('channel_members').select('*')
      .eq('channel_id', dm.id).eq('user_id', me.id).single();
    if (mem) memberships.set(dm.id, mem);
  }
  renderSidebar();
  await openChannel(dm.id);
  return dm.id;
}

// ================= Inline "New message" compose (no popup) =================
let composePicker = null;
function ensureComposeView() {
  if ($('compose-view')) return;
  // Scope to HiveConnect's own <main class="main"> inside #hiveconnect-root when
  // merge-mounted into HiveLogic -- HiveLogic's own outer shell ALSO has an
  // unrelated <main class="main"> wrapping the entire app (sidebar + every view),
  // and it comes first in the DOM. An unscoped querySelector('.main') matched that
  // one instead of HiveConnect's own, silently appending the compose view outside
  // #hiveconnect-root -- so none of HiveConnect's scoped CSS ever reached it, and it
  // rendered as an unstyled, squished box wherever HiveLogic's own layout happened
  // to place a stray child. Falls back to an unscoped lookup for the standalone
  // HiveConnect deployment, which has no #hiveconnect-root wrapper at all.
  const hcRoot = document.getElementById('hiveconnect-root');
  const main = (hcRoot || document).querySelector('.main'); if (!main) return;
  const v = document.createElement('div'); v.id = 'compose-view'; v.className = 'compose-view hidden';
  v.innerHTML = `
    <div class="cmp-head"><span class="cmp-title">New message</span>
      <button class="icon-btn" id="cmp-close" title="Cancel">✕</button></div>
    <div class="cmp-to-row"><span class="cmp-to-label">To:</span><div id="cmp-picker"></div></div>
    <div class="cmp-fill"></div>
    <div class="cmp-composer">
      <textarea id="compose-input" rows="1" placeholder="Write your message…"></textarea>
      <button class="send-btn" id="compose-send" title="Send">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>
      </button>
    </div>`;
  main.appendChild(v);
  composePicker = createRecipientPicker({ placeholder: 'Start typing a name…', onChange: () => {} });
  $('cmp-picker').appendChild(composePicker.el);
  $('cmp-close').onclick = closeCompose;
  const ta = $('compose-input');
  ta.addEventListener('input', () => autosize(ta));
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); composeSend(); } });
  $('compose-send').onclick = composeSend;
}
function openCompose() {
  ensureComposeView();
  composePicker.clear();
  $('compose-input').value = ''; autosize($('compose-input'));
  $('compose-view').classList.remove('hidden');
  composePicker.focus();
}
function closeCompose() { const v = $('compose-view'); if (v) v.classList.add('hidden'); }
async function composeSend() {
  if (!composePicker) return;
  const ids = composePicker.getSelected();
  const text = $('compose-input').value.trim();
  if (!ids.length) { composePicker.focus(); const r = document.querySelector('.cmp-to-row'); if (r) { r.classList.add('shake'); setTimeout(() => r.classList.remove('shake'), 500); } return; }
  let cid = null;
  if (ids.length === 1) { await startDM(ids[0]); cid = currentChannelId; }
  else { cid = await startGroupDM(ids); }
  closeCompose();
  if (cid && text) { await sendMessage(text); }
}

// Canonical invite-join URL. Invite links must ALWAYS point at the standalone
// HiveConnect page (/hiveconnect/), which has the #join-screen guest flow --
// building them from location.pathname broke every link generated from the
// EMBEDDED HiveConnect inside the main app (pathname "/"), where the main
// HiveLogic shell loads instead and a guest just hits the owner login wall.
// (Found 2026-07-26: a HiveVideo guest invite sent to an external guest's
// phone landed on the login wall instead of the join screen.) The main shell
// also now redirects /?invite=... to /hiveconnect/?invite=... as a safety net
// for links generated before this fix.
function inviteJoinUrl(token) {
  return location.origin + '/hiveconnect/?invite=' + token;
}

// ---- FaceTime-style guest call links (2026-07-26) ----
// A pass (create_video_guest_pass RPC) lets ANYONE with the link join THIS
// call's room with no account -- name-only join page at /hiveconnect/call.html.
// Works for external guests AND team members on phones (opens in any mobile
// browser). Passes expire in 4h / 10 uses; scoped to one room only.
async function makeGuestCallLink() {
  if (!activeHuddle) return null;
  const { data: token, error } = await sb.rpc('create_video_guest_pass', { p_channel: activeHuddle });
  if (error || !token) { window.alert((error && error.message) || 'Could not create a guest link.'); return null; }
  return location.origin + '/hiveconnect/call.html?p=' + token;
}
async function copyGuestCallLink() {
  const u = await makeGuestCallLink(); if (!u) return;
  try { await navigator.clipboard.writeText(u); } catch (e) { window.prompt('Copy this link:', u); }
  const b = $('hdi-copylink'); if (b) { b.textContent = 'Copied \u2713'; setTimeout(() => { if (b) b.innerHTML = '\uD83D\uDD17 Copy guest link'; }, 1600); }
}
async function textGuestCallLink() {
  const inp = $('hdi-phone');
  const digits = ((inp && inp.value) || '').replace(/\D/g, '');
  if (digits.length < 10) { window.alert('Enter a 10-digit cell number first.'); return; }
  const u = await makeGuestCallLink(); if (!u) return;
  let authTok = null;
  try { const _s = await sb.auth.getSession(); authTok = _s && _s.data && _s.data.session && _s.data.session.access_token; } catch (e) {}
  const body = ((me && me.display_name) || 'Someone') + ' is inviting you to a HiveLogic video call. Tap to join: ' + u;
  if (!authTok) {
    try { await navigator.clipboard.writeText(u); } catch (e) {}
    window.alert('Texting runs through the main HiveLogic app -- the link was copied instead; paste it into any text message.');
    return;
  }
  const btn = $('hdi-textlink'); if (btn) { btn.disabled = true; btn.textContent = 'Sending\u2026'; }
  try {
    const r = await fetch('/api/voice?resource=sms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + authTok },
      body: JSON.stringify({ to: digits, body }),
    });
    const d = await r.json().catch(() => ({}));
    if (btn) { btn.disabled = false; btn.textContent = (r.ok && d.ok) ? 'Sent \u2713' : 'Failed'; }
    if (!(r.ok && d.ok)) window.alert((d && d.error) || 'Could not send the text.');
    else if (inp) inp.value = '';
  } catch (e) { if (btn) { btn.disabled = false; btn.textContent = 'Failed'; } window.alert('Could not send the text: ' + e.message); }
  setTimeout(() => { const b = $('hdi-textlink'); if (b) b.innerHTML = '\uD83D\uDCF1 Text link'; }, 2200);
}

// ================= HiveVideo invite (chip picker inside the dock) =================
let hvInvitePicker = null;
function ensureHvInviteUI() {
  const dock = $('huddle-dock'); if (!dock) return;
  if (!$('hd-invite')) {
    const box = document.createElement('div'); box.id = 'hd-invite'; box.className = 'hd-invite hidden';
    box.innerHTML = `
      <div class="hdi-head"><span>Invite to this call</span><button class="hdi-x" id="hdi-close" title="Close">✕</button></div>
      <div id="hdi-picker"></div>
      <div class="hdi-actions">
        <button class="text-btn" id="hdi-skip">Not now</button>
        <button class="primary-btn" id="hdi-send">Invite</button>
      </div>
      <div id="hdi-msg" class="hdi-msg"></div>`;
    const frame = $('hd-frame'); dock.insertBefore(box, frame.nextSibling);
    hvInvitePicker = createRecipientPicker({ placeholder: 'Name, or type an email to invite someone new…', allowExternal: true, onChange: () => {} });
    $('hdi-picker').appendChild(hvInvitePicker.el);
    $('hdi-close').onclick = closeHvInvite;
    $('hdi-skip').onclick = closeHvInvite;
    $('hdi-send').onclick = sendHvInvites;
    // Guest-link row (no-account joins + text-a-cell-number)
    const gr = document.createElement('div');
    gr.className = 'hdi-guestrow';
    gr.innerHTML = '<button class="mini-btn" id="hdi-copylink" title="Anyone with the link can join this call for 4 hours -- no account needed">\uD83D\uDD17 Copy guest link</button>' +
      '<input id="hdi-phone" class="hdi-phone" type="tel" inputmode="tel" placeholder="Cell # \u2014 text a join link" maxlength="14">' +
      '<button class="mini-btn" id="hdi-textlink">\uD83D\uDCF1 Text link</button>';
    box.appendChild(gr);
    $('hdi-copylink').onclick = copyGuestCallLink;
    $('hdi-textlink').onclick = textGuestCallLink;
  }
}
function openHvInvite() {
  ensureHvInviteUI();
  if (hvInvitePicker) hvInvitePicker.clear();
  const m = $('hdi-msg'); if (m) m.textContent = '';
  { const r = $('hdi-result'); if (r) r.remove(); }
  const box = $('hd-invite'); if (box) box.classList.remove('hidden');
  if (hvInvitePicker) hvInvitePicker.focus();
}
function closeHvInvite() { const b = $('hd-invite'); if (b) b.classList.add('hidden'); }
async function sendHvInvites() {
  if (!hvInvitePicker || !activeHuddle) return;
  const items = hvInvitePicker.getItems();
  const msg = $('hdi-msg');
  if (!items.length) { hvInvitePicker.focus(); return; }
  const members = items.filter(p => !p.external);
  const externals = items.filter(p => p.external);
  if (msg) msg.textContent = 'Inviting…';

  // 1) Existing accounts → add to this call's channel (grants room access + rings them).
  const invited = [];
  if (members.length) {
    const rows = members.map(p => ({ channel_id: activeHuddle, user_id: p.id }));
    try {
      await sb.from('channel_members').upsert(rows, { onConflict: 'channel_id,user_id' });
      members.forEach(p => invited.push(p.name.split(' ')[0]));
    } catch (e) { if (msg) msg.textContent = 'Could not add some people — try again.'; }
  }

  // 2) New external guests → generate a single-use guest invite link scoped to THIS call's
  //    channel. Whoever opens it joins as a guest, lands in the channel, and can jump on the call.
  const links = [];
  for (const p of externals) {
    try {
      const { data: token, error } = await sb.rpc('create_invite', {
        p_email: p.email || null, p_role: 'guest', p_channels: [activeHuddle], p_expires_days: 2,
      });
      if (error || !token) continue;
      links.push({ name: p.name, email: p.email, token, url: inviteJoinUrl(token) });
    } catch (e) { /* skip this one */ }
  }

  // Auto-email whoever has an address on file; anyone without one still
  // gets the copyable link below (e.g. to share over text instead).
  if (links.some(l => l.email)) await sendInviteEmails(links);

  hvInvitePicker.clear();
  renderHvInviteResult(invited, links);
}

// Emails every link in `links` that has an address on file, in parallel.
// Tags each with l.emailed (true/false) + l.emailError so callers can show
// per-recipient status; the link itself always stays available to copy,
// this is purely a convenience so most invites need no manual copy/paste.
async function sendInviteEmails(links) {
  const { data: { session } } = await sb.auth.getSession();
  const authToken = session && session.access_token;
  await Promise.all(links.filter(l => l.email).map(async (l) => {
    try {
      const r = await fetch('/api/hiveconnect-invite-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + authToken },
        body: JSON.stringify({ token: l.token, url: l.url, inviterName: me.display_name }),
      });
      const d = await r.json().catch(() => ({}));
      l.emailed = !!(r.ok && d.ok);
      if (!l.emailed) l.emailError = (d && d.error) || 'Could not send email.';
    } catch (e) { l.emailed = false; l.emailError = 'Network error.'; }
  }));
}

// Show the outcome: who was rung in + copyable guest links to send to new external people.
function renderHvInviteResult(invited, links) {
  const box = $('hd-invite'); if (!box) return;
  let res = $('hdi-result'); if (res) res.remove();
  res = document.createElement('div'); res.id = 'hdi-result'; res.className = 'hdi-result';
  if (invited.length) {
    const d = document.createElement('div'); d.className = 'hdi-added'; d.textContent = `📞 Rang in: ${invited.join(', ')}`; res.appendChild(d);
  }
  links.forEach(l => {
    const row = document.createElement('div'); row.className = 'hdi-link';
    const top = document.createElement('div'); top.className = 'hdi-link-top';
    top.textContent = `✉ Invite link for ${l.name}${l.email ? ' (' + l.email + ')' : ''}:${l.email ? (l.emailed ? ' -- emailed' : ' -- ' + (l.emailError || 'could not email, copy link instead')) : ''}`;
    const u = document.createElement('div'); u.className = 'hdi-link-url'; u.textContent = l.url;
    const btn = document.createElement('button'); btn.className = 'mini-btn'; btn.textContent = 'Copy link';
    btn.onclick = () => { navigator.clipboard?.writeText(l.url); btn.textContent = 'Copied ✓'; setTimeout(() => btn.textContent = 'Copy link', 1200); };
    row.appendChild(top); row.appendChild(u); row.appendChild(btn); res.appendChild(row);
  });
  if (!invited.length && !links.length) { const d = document.createElement('div'); d.className = 'hdi-msg'; d.textContent = 'Nothing to invite.'; res.appendChild(d); }
  box.appendChild(res);
  const msg = $('hdi-msg'); if (msg) msg.textContent = '';
  // links need to stay on screen to be copied — only auto-close the pure "rang in" case
  if (!links.length) setTimeout(closeHvInvite, 1600);
}

// ---------- New message (DM) picker ----------
{ const _nd = $('new-dm-btn'); if (_nd) _nd.addEventListener('click', e => { e.stopPropagation(); openCompose(); }); }
$('newdm-close').addEventListener('click', () => $('newdm-backdrop').classList.add('hidden'));
$('newdm-backdrop').addEventListener('click', e => { if (e.target === e.currentTarget) $('newdm-backdrop').classList.add('hidden'); });
$('newdm-filter').addEventListener('input', renderNewDMList);
function openNewDM() {
  $('newdm-filter').value = '';
  renderNewDMList();
  $('newdm-backdrop').classList.remove('hidden');
  $('newdm-filter').focus();
}
function renderNewDMList() {
  const q = $('newdm-filter').value.trim().toLowerCase();
  const box = $('newdm-list'); box.innerHTML = '';
  const people = [...profiles.values()]
    .filter(p => p.id !== me.id && p.username !== 'slackarchive' && p.active !== false)
    .filter(p => !q || p.display_name.toLowerCase().includes(q) || p.username.toLowerCase().includes(q))
    .sort((a, b) => (onlineUsers.has(b.id) - onlineUsers.has(a.id)) || a.display_name.localeCompare(b.display_name));
  for (const p of people) {
    const row = document.createElement('div'); row.className = 'cm-row';
    row.appendChild(avatarWithPresence(p));
    const nm = document.createElement('span'); nm.className = 'cm-name'; nm.textContent = p.display_name; row.appendChild(nm);
    const st = document.createElement('span'); st.className = 'muted'; st.style.fontSize = '11px';
    st.textContent = onlineUsers.has(p.id) ? 'online' : '';
    row.appendChild(st);
    row.style.cursor = 'pointer';
    row.onclick = () => { $('newdm-backdrop').classList.add('hidden'); startDM(p.id); };
    box.appendChild(row);
  }
  if (!people.length) box.innerHTML = '<div class="notif-empty">No one found.</div>';
}

// ---------- My profile (avatar photo + color) ----------
const SWATCHES = ['#f59e0b','#f5793b','#ef4444','#ec4899','#8b5cf6','#6366f1','#3b82f6','#0ea5e9','#14b8a6','#10b981','#84cc16','#59718a','#64748b','#78716c'];
let profileDraft = { avatar_color: null, avatar_url: null };
function openProfile() {
  if (!me) return;
  profileDraft = { avatar_color: me.avatar_color, avatar_url: me.avatar_url || null };
  $('profile-name').value = me.display_name;
  $('profile-msg').classList.add('hidden'); $('profile-upmsg').textContent = '';
  renderProfilePreview(); renderSwatches();
  $('profile-backdrop').classList.remove('hidden');
}
$('profile-cancel').addEventListener('click', () => $('profile-backdrop').classList.add('hidden'));
$('profile-backdrop').addEventListener('click', e => { if (e.target === e.currentTarget) $('profile-backdrop').classList.add('hidden'); });
function renderProfilePreview() {
  const p = { display_name: $('profile-name').value || me.display_name, username: me.username, avatar_color: profileDraft.avatar_color, avatar_url: profileDraft.avatar_url };
  $('profile-avatar').replaceWith(Object.assign(avatarEl(p, 'avatar profile-avatar'), { id: 'profile-avatar' }));
  $('profile-preview-name').textContent = p.display_name;
  $('profile-remove-btn').classList.toggle('hidden', !profileDraft.avatar_url);
}
$('profile-name').addEventListener('input', renderProfilePreview);
function renderSwatches() {
  const box = $('profile-swatches'); box.innerHTML = '';
  SWATCHES.forEach(col => {
    const s = document.createElement('div'); s.className = 'swatch' + (!profileDraft.avatar_url && profileDraft.avatar_color === col ? ' sel' : '');
    s.style.background = col;
    s.onclick = () => { profileDraft.avatar_color = col; profileDraft.avatar_url = null; renderProfilePreview(); renderSwatches(); };
    box.appendChild(s);
  });
}
$('profile-upload-btn').addEventListener('click', () => $('profile-file').click());
$('profile-remove-btn').addEventListener('click', () => { profileDraft.avatar_url = null; renderProfilePreview(); renderSwatches(); });
$('profile-file').addEventListener('change', async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  if (!/^image\//.test(file.type)) { $('profile-upmsg').textContent = 'Please choose an image.'; return; }
  if (file.size > 5 * 1024 * 1024) { $('profile-upmsg').textContent = 'Max 5 MB.'; return; }
  $('profile-upmsg').textContent = 'Uploading…';
  const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
  const path = `avatars/${me.id}/${crypto.randomUUID()}.${ext}`;
  const { error } = await sb.storage.from('attachments').upload(path, file, { contentType: file.type, upsert: true });
  if (error) { $('profile-upmsg').textContent = 'Upload failed.'; return; }
  const { data } = sb.storage.from('attachments').getPublicUrl(path);
  profileDraft.avatar_url = data.publicUrl;
  $('profile-upmsg').textContent = '';
  renderProfilePreview(); renderSwatches();
});
$('profile-save').addEventListener('click', async () => {
  const name = $('profile-name').value.trim() || me.display_name;
  const patch = { display_name: name, avatar_color: profileDraft.avatar_color, avatar_url: profileDraft.avatar_url };
  const { error } = await sb.from('profiles').update(patch).eq('id', me.id);
  if (error) { const m = $('profile-msg'); m.textContent = error.message; m.classList.remove('hidden'); return; }
  Object.assign(me, patch);
  profiles.set(me.id, me);
  // refresh everything that shows my avatar
  $('me-avatar').replaceWith(Object.assign(avatarEl(me), { id: 'me-avatar' }));
  $('me-name').textContent = me.display_name;
  renderSidebar();
  if (currentChannelId) renderMessages();
  $('profile-backdrop').classList.add('hidden');
});

// ---------- Password change ---------- (opened from the Settings menu)
$('pw-cancel').addEventListener('click', () => $('pw-backdrop').classList.add('hidden'));
$('pw-backdrop').addEventListener('click', e => { if (e.target === e.currentTarget) $('pw-backdrop').classList.add('hidden'); });
$('pw-save').addEventListener('click', async () => {
  const a = $('pw-new').value, b = $('pw-confirm').value, msg = $('pw-msg');
  msg.classList.remove('hidden'); msg.style.color = '';
  if (a.length < 8) { msg.textContent = 'Password must be at least 8 characters.'; return; }
  if (a !== b) { msg.textContent = "Passwords don't match."; return; }
  const { error } = await sb.auth.updateUser({ password: a });
  if (error) { msg.textContent = error.message; return; }
  msg.style.color = '#4c8a5f';
  msg.textContent = 'Password updated ✓';
  setTimeout(() => $('pw-backdrop').classList.add('hidden'), 1200);
});

// ---------- Search ----------
const searchInput = $('search-input');
searchInput.addEventListener('keydown', async e => {
  if (e.key === 'Escape') { closeSearch(); searchInput.blur(); return; }
  if (e.key !== 'Enter') return;
  const q = searchInput.value.trim();
  if (q.length < 2) return;
  const panel = $('search-panel'), list = $('search-results');
  $('search-title').textContent = `Results for “${q}”`;
  list.innerHTML = '<div class="notif-empty">Searching…</div>';
  panel.classList.remove('hidden');
  const { data } = await sb.from('messages')
    .select('*')
    .ilike('content', `%${q}%`)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(60);
  list.innerHTML = '';
  if (!data || !data.length) {
    list.innerHTML = '<div class="notif-empty">No matches across your channels & history.</div>';
    return;
  }
  $('search-title').textContent = `${data.length}${data.length === 60 ? '+' : ''} result${data.length === 1 ? '' : 's'} for “${q}”`;
  for (const m of data) {
    const p = profiles.get(m.user_id), ch = channels.get(m.channel_id);
    const d = document.createElement('div');
    d.className = 'notif-item unread';
    const txt = document.createElement('div');
    const when = new Date(m.created_at).toLocaleDateString([], { month: 'short', day: 'numeric', year: '2-digit' });
    txt.innerHTML = `<b></b> in <b></b> · <span class="muted">${when}</span><div class="search-snippet"></div>`;
    const bs = txt.querySelectorAll('b');
    bs[0].textContent = p ? p.display_name : '?';
    bs[1].textContent = ch ? channelLabel(ch) : '?';
    txt.querySelector('.search-snippet').innerHTML = searchSnippet(m.content, q);
    d.appendChild(txt);
    d.onclick = () => { closeSearch(); if (m.channel_id) openChannel(m.channel_id); };
    list.appendChild(d);
  }
});
// snippet centered on the match, with the term highlighted
function searchSnippet(content, q) {
  const idx = content.toLowerCase().indexOf(q.toLowerCase());
  let start = Math.max(0, idx - 50);
  let slice = content.slice(start, start + 160);
  if (start > 0) slice = '…' + slice;
  if (start + 160 < content.length) slice = slice + '…';
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
  return esc(slice).replace(re, '<span class="search-hit">$1</span>');
}

// ============================================================
// ADMIN / SETUP PANEL
// ============================================================
const isAdmin = () => me && (me.role === 'owner' || me.role === 'admin');
function slugUsername(name) {
  return name.trim().toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9]/g, '') || ('user' + Math.floor(Math.random()*1000));
}
let adminTab = 'members', cmChannelId = null;

{ const _ab = $('admin-btn'); if (_ab) _ab.addEventListener('click', openAdmin); }
$('admin-close').addEventListener('click', () => $('admin-overlay').classList.add('hidden'));
document.querySelectorAll('.admin-tab').forEach(t => t.addEventListener('click', () => {
  adminTab = t.dataset.tab;
  document.querySelectorAll('.admin-tab').forEach(x => x.classList.toggle('active', x === t));
  document.querySelectorAll('.admin-pane').forEach(p => p.classList.add('hidden'));
  $('pane-' + adminTab).classList.remove('hidden');
  if (adminTab === 'members') renderMembers();
  if (adminTab === 'channels') renderChannelsAdmin();
  if (adminTab === 'settings') renderSettings();
  if (adminTab === 'integrations') renderIntegrations();
}));

// ---- Integrations / Reina tab ----
function rpcBase() { return window.HIVE_CONFIG.url + '/rest/v1/rpc/'; }
async function renderIntegrations() {
  const reina = [...profiles.values()].find(p => p.username === 'reina');
  if (reina && reina.avatar_url) $('reina-avatar').style.backgroundImage = `url("${reina.avatar_url}")`;
  const { data: settings } = await sb.from('integration_settings').select('reina_read_token').eq('id', 1).maybeSingle();
  const readTok = settings?.reina_read_token || '(none)';
  const base = rpcBase(), anon = window.HIVE_CONFIG.anonKey;
  $('reina-read-url').textContent = base + 'reina_read';
  $('reina-read-curl').textContent =
    `curl -X POST '${base}reina_read' -H 'apikey: ${anon}' -H 'Content-Type: application/json' -d '{"p_token":"${readTok}","p_limit":200}'`;
  // channel dropdown
  const sel = $('wh-channel'); sel.innerHTML = '';
  [...channels.values()].filter(c => c.type !== 'dm').sort((a,b)=>(a.name||'').localeCompare(b.name||'')).forEach(c => {
    const o = document.createElement('option'); o.value = c.id; o.textContent = (c.type==='private'?'🔒 ':'#')+c.name; sel.appendChild(o);
  });
  await renderWebhookList();
}
async function renderWebhookList() {
  const { data: whs } = await sb.from('webhooks').select('*').order('created_at', { ascending: false });
  const box = $('wh-list'); box.innerHTML = '';
  const active = (whs || []).filter(w => !w.revoked);
  if (!active.length) { box.innerHTML = '<div class="notif-empty">No webhooks yet. Generate one above to let Reina post into a channel.</div>'; return; }
  const base = rpcBase(), anon = window.HIVE_CONFIG.anonKey;
  for (const w of active) {
    const ch = channels.get(w.channel_id);
    const row = document.createElement('div'); row.className = 'arow'; row.style.flexDirection = 'column'; row.style.alignItems = 'stretch'; row.style.gap = '6px';
    const top = document.createElement('div'); top.style.display = 'flex'; top.style.alignItems = 'center'; top.style.gap = '10px';
    top.innerHTML = `<div class="arow-main"><div class="arow-name">${ch ? (ch.type==='private'?'🔒 ':'#')+esc(ch.name) : '(deleted)'}</div><div class="arow-sub">${esc(w.label || 'webhook')}${w.last_used_at ? ' · last used '+new Date(w.last_used_at).toLocaleDateString() : ' · never used'}</div></div>`;
    const rev = document.createElement('button'); rev.className = 'mini-btn danger'; rev.textContent = 'Revoke';
    rev.onclick = async () => { if(!confirm('Revoke this webhook? Reina will no longer be able to post through it.')) return; await sb.rpc('revoke_webhook', { p_token: w.token }); renderWebhookList(); };
    top.appendChild(rev);
    row.appendChild(top);
    const curl = `curl -X POST '${base}webhook_post' -H 'apikey: ${anon}' -H 'Content-Type: application/json' -d '{"p_token":"${w.token}","p_text":"Hello from Reina","p_sender":"Reina"}'`;
    const cb = document.createElement('div'); cb.className = 'code-box';
    const code = document.createElement('code'); code.textContent = curl; cb.appendChild(code);
    const copy = document.createElement('button'); copy.className = 'mini-btn'; copy.textContent = 'Copy';
    copy.onclick = () => { navigator.clipboard?.writeText(curl); copy.textContent = 'Copied ✓'; setTimeout(()=>copy.textContent='Copy',1200); };
    cb.appendChild(copy); row.appendChild(cb);
    box.appendChild(row);
  }
}
document.addEventListener('click', e => {
  const btn = e.target.closest('.intg-copy'); if (!btn) return;
  const el = document.getElementById(btn.dataset.copy); if (!el) return;
  navigator.clipboard?.writeText(el.textContent);
  const t = btn.textContent; btn.textContent = 'Copied ✓'; setTimeout(() => btn.textContent = t, 1200);
});
$('wh-create').addEventListener('click', async () => {
  const cid = $('wh-channel').value; const label = $('wh-label').value.trim() || null;
  const { error } = await sb.rpc('create_webhook', { p_channel: cid, p_label: label });
  if (error) { alert(error.message); return; }
  $('wh-label').value = '';
  renderWebhookList();
});
$('reina-rotate').addEventListener('click', async () => {
  if (!confirm('Rotate the read token? Reina will need the new token to keep reading.')) return;
  // new token via update (admin RLS allows)
  const newTok = crypto.randomUUID();
  const { error } = await sb.from('integration_settings').update({ reina_read_token: newTok, updated_at: new Date().toISOString() }).eq('id', 1);
  const msg = $('reina-rotate-msg');
  if (error) { msg.textContent = error.message; return; }
  msg.textContent = 'Rotated ✓'; setTimeout(()=>msg.textContent='',2000);
  renderIntegrations();
});

async function openAdmin() {
  if (!isAdmin()) return;
  $('admin-overlay').classList.remove('hidden');
  // refresh full profile + channel data (admins can see all rows)
  const [{ data: profs }, { data: chans }] = await Promise.all([
    sb.from('profiles').select('*').order('display_name'),
    sb.from('channels').select('*').order('name'),
  ]);
  (profs || []).forEach(p => profiles.set(p.id, p));
  (chans || []).forEach(c => channels.set(c.id, c));
  renderMembers();
}

// ---- Members tab ----
$('member-filter').addEventListener('input', renderMembers);
function renderMembers() {
  const q = $('member-filter').value.trim().toLowerCase();
  const tbl = $('members-table'); tbl.innerHTML = '';
  const list = [...profiles.values()]
    .filter(p => p.username !== 'slackarchive')
    .filter(p => !q || p.display_name.toLowerCase().includes(q) || p.username.toLowerCase().includes(q))
    .sort((a, b) => (a.active === false) - (b.active === false) || a.display_name.localeCompare(b.display_name));
  for (const p of list) {
    const row = document.createElement('div');
    row.className = 'arow' + (p.active === false ? ' inactive' : '');
    row.appendChild(avatarEl(p, 'mini-avatar'));
    const main = document.createElement('div'); main.className = 'arow-main';
    main.innerHTML = `<div class="arow-name"></div><div class="arow-sub">@${esc(p.username)}${p.active === false ? ' · deactivated' : ''}</div>`;
    main.querySelector('.arow-name').textContent = p.display_name;
    row.appendChild(main);
    const act = document.createElement('div'); act.className = 'arow-actions';
    const isMe = p.id === me.id;
    const canManageOwner = me.role === 'owner';
    // role select
    const sel = document.createElement('select'); sel.className = 'arow-select';
    ['owner','admin','member','guest'].forEach(r => {
      const o = document.createElement('option'); o.value = r; o.textContent = r[0].toUpperCase()+r.slice(1);
      if (r === 'owner' && !canManageOwner) o.disabled = true;
      sel.appendChild(o);
    });
    sel.value = p.role || 'member';
    sel.disabled = isMe || (p.role === 'owner' && !canManageOwner);
    sel.onchange = async () => {
      const { error } = await sb.rpc('admin_set_role', { target: p.id, new_role: sel.value });
      if (error) { alert(error.message); sel.value = p.role; return; }
      p.role = sel.value; renderMembers();
    };
    act.appendChild(sel);
    // reset password
    if (!isMe) {
      const rp = document.createElement('button'); rp.className = 'mini-btn'; rp.textContent = 'Reset pw';
      rp.onclick = async () => {
        rp.disabled = true;
        rp.textContent = 'Resetting…';
        try {
          const result = await hiveConnectAccountAction('admin_reset_password', { targetId: p.id });
          showCred('Password reset — ' + p.display_name, result.email, result.password);
        } catch (error) {
          alert(error.message);
        } finally {
          rp.disabled = false;
          rp.textContent = 'Reset pw';
        }
      };
      act.appendChild(rp);
      // activate / deactivate
      if (p.role !== 'owner') {
        const tg = document.createElement('button'); tg.className = 'mini-btn' + (p.active === false ? '' : ' danger');
        tg.textContent = p.active === false ? 'Reactivate' : 'Deactivate';
        tg.onclick = async () => {
          const { error } = await sb.rpc('admin_set_active', { target: p.id, is_active: p.active === false });
          if (error) { alert(error.message); return; }
          p.active = p.active === false; renderMembers();
        };
        act.appendChild(tg);
      }
    }
    row.appendChild(act);
    tbl.appendChild(row);
  }
}

// ---- Invite ----
let invChannelSel = new Set();
$('invite-btn').addEventListener('click', () => {
  $('inv-name').value = ''; $('inv-email').value = ''; $('inv-username').value = ''; $('inv-role').value = 'member';
  $('inv-username').removeAttribute('data-touched');
  $('inv-ch-filter').value = '';
  $('inv-msg').classList.add('hidden');
  invChannelSel = new Set();
  renderInviteChannels();
  updateInviteHint();
  $('invite-backdrop').classList.remove('hidden'); $('inv-name').focus();
});
$('inv-role').addEventListener('change', updateInviteHint);
function updateInviteHint() {
  $('inv-ch-hint').textContent = $('inv-role').value === 'guest'
    ? '(guests ONLY see channels you add here)'
    : '(pick which channels they join now)';
}
$('inv-ch-filter').addEventListener('input', renderInviteChannels);
$('inv-ch-none').addEventListener('click', () => { invChannelSel = new Set(); renderInviteChannels(); });
$('inv-ch-public').addEventListener('click', () => {
  [...channels.values()].filter(c => c.type === 'public' && !c.archived).forEach(c => invChannelSel.add(c.id));
  renderInviteChannels();
});
function renderInviteChannels() {
  const q = $('inv-ch-filter').value.trim().toLowerCase();
  const box = $('inv-channels'); box.innerHTML = '';
  const list = [...channels.values()].filter(c => c.type !== 'dm' && !c.archived)
    .filter(c => !q || (c.name || '').toLowerCase().includes(q))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  for (const c of list) {
    const lbl = document.createElement('label'); lbl.className = 'inv-ch';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = invChannelSel.has(c.id);
    cb.onchange = () => { cb.checked ? invChannelSel.add(c.id) : invChannelSel.delete(c.id); };
    lbl.appendChild(cb);
    const nm = document.createElement('span');
    nm.innerHTML = (c.type === 'private' ? '<span class="lk">🔒</span> ' : '# ');
    const t = document.createElement('span'); t.textContent = c.name; nm.appendChild(t);
    lbl.appendChild(nm);
    box.appendChild(lbl);
  }
  if (!list.length) box.innerHTML = '<div class="notif-empty">No channels.</div>';
}
$('inv-cancel').addEventListener('click', () => $('invite-backdrop').classList.add('hidden'));
$('inv-name').addEventListener('input', () => { if (!$('inv-username').dataset.touched) $('inv-username').value = slugUsername($('inv-name').value); });
$('inv-username').addEventListener('input', () => { $('inv-username').dataset.touched = '1'; });
$('inv-create').addEventListener('click', async () => {
  const name = $('inv-name').value.trim(), email = $('inv-email').value.trim(), un = ($('inv-username').value.trim() || slugUsername(name)).toLowerCase();
  const msg = $('inv-msg');
  if (!name || !email) { msg.textContent = 'Name and email are required.'; msg.classList.remove('hidden'); return; }
  $('inv-create').disabled = true; $('inv-create').textContent = 'Creating…';
  let data;
  try {
    data = await hiveConnectAccountAction('admin_create_user', {
      email,
      displayName: name,
      username: un,
      role: $('inv-role').value,
      channelIds: [...invChannelSel],
    });
  } catch (error) {
    $('inv-create').disabled = false; $('inv-create').textContent = 'Create account';
    msg.textContent = error.message; msg.classList.remove('hidden');
    return;
  }
  $('inv-create').disabled = false; $('inv-create').textContent = 'Create account';
  // refresh profiles so the new person appears
  const { data: np } = await sb.from('profiles').select('*').eq('id', data.id).single();
  if (np) profiles.set(np.id, np);
  $('invite-backdrop').classList.add('hidden');
  const channelCount = Number(data.channelCount) || 0;
  showCred('Account created — ' + name + (channelCount ? ' · added to ' + channelCount + ' channel' + (channelCount===1?'':'s') : ''), data.email, data.password);
  renderMembers(); renderSidebar();
});

// ---- Create invite link ----
let lkChannelSel = new Set();
$('link-btn').addEventListener('click', () => {
  $('lk-email').value = ''; $('lk-role').value = 'member'; $('lk-expiry').value = '14';
  $('lk-ch-filter').value = ''; $('lk-msg').classList.add('hidden');
  lkChannelSel = new Set();
  renderLkChannels(); updateLkHint();
  $('link-backdrop').classList.remove('hidden');
});
$('lk-cancel').addEventListener('click', () => $('link-backdrop').classList.add('hidden'));
$('lk-role').addEventListener('change', updateLkHint);
function updateLkHint() {
  $('lk-ch-hint').textContent = $('lk-role').value === 'guest' ? '(guests ONLY see channels you add here)' : '(pick which channels they join)';
}
$('lk-ch-filter').addEventListener('input', renderLkChannels);
$('lk-ch-none').addEventListener('click', () => { lkChannelSel = new Set(); renderLkChannels(); });
$('lk-ch-public').addEventListener('click', () => {
  [...channels.values()].filter(c => c.type === 'public' && !c.archived).forEach(c => lkChannelSel.add(c.id));
  renderLkChannels();
});
function renderLkChannels() {
  const q = $('lk-ch-filter').value.trim().toLowerCase();
  const box = $('lk-channels'); box.innerHTML = '';
  const list = [...channels.values()].filter(c => c.type !== 'dm' && !c.archived)
    .filter(c => !q || (c.name || '').toLowerCase().includes(q))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  for (const c of list) {
    const lbl = document.createElement('label'); lbl.className = 'inv-ch';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = lkChannelSel.has(c.id);
    cb.onchange = () => { cb.checked ? lkChannelSel.add(c.id) : lkChannelSel.delete(c.id); };
    lbl.appendChild(cb);
    const nm = document.createElement('span');
    nm.innerHTML = (c.type === 'private' ? '<span class="lk">🔒</span> ' : '# ');
    const t = document.createElement('span'); t.textContent = c.name; nm.appendChild(t);
    lbl.appendChild(nm);
    box.appendChild(lbl);
  }
}
$('lk-create').addEventListener('click', async () => {
  const email = $('lk-email').value.trim() || null;
  const role = $('lk-role').value;
  const days = Math.max(1, parseInt($('lk-expiry').value) || 14);
  const msg = $('lk-msg');
  $('lk-create').disabled = true; $('lk-create').textContent = 'Generating…';
  const { data: token, error } = await sb.rpc('create_invite', { p_email: email, p_role: role, p_channels: [...lkChannelSel], p_expires_days: days });
  $('lk-create').disabled = false; $('lk-create').textContent = 'Generate link';
  if (error) { msg.textContent = error.message; msg.classList.remove('hidden'); return; }
  const url = inviteJoinUrl(token);
  let emailNote = '';
  if (email) {
    const link = { email, token, url };
    await sendInviteEmails([link]);
    emailNote = link.emailed ? ' Emailed to ' + email + '.' : ' Could not email it automatically -- copy the link below instead.';
  }
  $('link-backdrop').classList.add('hidden');
  $('linkres-url').textContent = url;
  $('linkres-scope').textContent = (email ? 'Locked to ' + email + '. ' : 'Anyone with the link can use it once. ') +
    (lkChannelSel.size ? 'Joins ' + lkChannelSel.size + ' channel' + (lkChannelSel.size === 1 ? '' : 's') + '.' : '') +
    ' Expires in ' + days + ' days.' + emailNote;
  $('linkres-backdrop').classList.remove('hidden');
});
$('linkres-done').addEventListener('click', () => $('linkres-backdrop').classList.add('hidden'));
$('linkres-copy').addEventListener('click', () => {
  navigator.clipboard?.writeText($('linkres-url').textContent);
  $('linkres-copy').textContent = 'Copied ✓';
  setTimeout(() => $('linkres-copy').textContent = 'Copy link', 1200);
});

// ---- Credential result modal ----
function showCred(title, email, pw) {
  $('cred-title').textContent = title;
  $('cred-email').textContent = email;
  $('cred-pw').textContent = pw;
  $('cred-backdrop').classList.remove('hidden');
}
$('cred-done').addEventListener('click', () => $('cred-backdrop').classList.add('hidden'));
$('cred-copy').addEventListener('click', () => {
  const t = `Email: ${$('cred-email').textContent}\nPassword: ${$('cred-pw').textContent}`;
  navigator.clipboard?.writeText(t);
  $('cred-copy').textContent = 'Copied ✓';
  setTimeout(() => $('cred-copy').textContent = 'Copy', 1200);
});

// ---- Channels tab ----
$('channel-filter').addEventListener('input', renderChannelsAdmin);
$('show-archived').addEventListener('change', renderChannelsAdmin);
async function renderChannelsAdmin() {
  const q = $('channel-filter').value.trim().toLowerCase();
  const showArch = $('show-archived').checked;
  const tbl = $('channels-table'); tbl.innerHTML = '<div class="notif-empty">Loading…</div>';
  // member counts
  const { data: mems } = await sb.from('channel_members').select('channel_id');
  const counts = {};
  (mems || []).forEach(m => counts[m.channel_id] = (counts[m.channel_id] || 0) + 1);
  tbl.innerHTML = '';
  const list = [...channels.values()].filter(c => c.type !== 'dm')
    .filter(c => showArch || !c.archived)
    .filter(c => !q || (c.name || '').toLowerCase().includes(q))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  for (const c of list) {
    const row = document.createElement('div'); row.className = 'arow' + (c.archived ? ' inactive' : '');
    const main = document.createElement('div'); main.className = 'arow-main';
    main.innerHTML = `<div class="arow-name">${c.type === 'private' ? '🔒 ' : '#'}<span class="cn"></span> ${c.archived ? '<span class="archived-tag">archived</span>' : ''}</div><div class="arow-sub">${counts[c.id] || 0} members · ${c.type}</div>`;
    main.querySelector('.cn').textContent = c.name;
    row.appendChild(main);
    const act = document.createElement('div'); act.className = 'arow-actions';
    // division selector
    const cat = document.createElement('select'); cat.className = 'arow-select';
    [['clients','👥 Clients'],['vendors','🚚 Vendors'],['team','🧰 Teams'],['channels','💬 Channels']].forEach(([v,l]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = l; cat.appendChild(o);
    });
    cat.value = c.category || 'channels';
    cat.onchange = async () => {
      const { error } = await sb.rpc('admin_set_category', { cid: c.id, new_cat: cat.value });
      if (error) { alert(error.message); cat.value = c.category; return; }
      c.category = cat.value; renderSidebar();
    };
    act.appendChild(cat);
    // manage members
    const mm = document.createElement('button'); mm.className = 'mini-btn'; mm.textContent = 'Members';
    mm.onclick = () => openChannelMembers(c.id);
    act.appendChild(mm);
    // toggle type
    const tt = document.createElement('button'); tt.className = 'mini-btn'; tt.textContent = c.type === 'private' ? 'Make public' : 'Make private';
    tt.onclick = async () => {
      const nt = c.type === 'private' ? 'public' : 'private';
      const { error } = await sb.rpc('admin_set_channel_type', { cid: c.id, new_type: nt });
      if (error) { alert(error.message); return; }
      c.type = nt; renderChannelsAdmin();
    };
    act.appendChild(tt);
    // archive
    const ar = document.createElement('button'); ar.className = 'mini-btn'; ar.textContent = c.archived ? 'Unarchive' : 'Archive';
    ar.onclick = async () => {
      const { error } = await sb.rpc('admin_archive_channel', { cid: c.id, is_archived: !c.archived });
      if (error) { alert(error.message); return; }
      c.archived = !c.archived; renderChannelsAdmin(); renderSidebar();
    };
    act.appendChild(ar);
    // delete
    const del = document.createElement('button'); del.className = 'mini-btn danger'; del.textContent = 'Delete';
    del.onclick = async () => {
      if (!confirm(`Delete #${c.name} and all its messages? This cannot be undone.`)) return;
      const { error } = await sb.rpc('admin_delete_channel', { cid: c.id });
      if (error) { alert(error.message); return; }
      channels.delete(c.id); renderChannelsAdmin(); renderSidebar();
    };
    act.appendChild(del);
    row.appendChild(act);
    tbl.appendChild(row);
  }
  if (!list.length) tbl.innerHTML = '<div class="notif-empty">No channels match.</div>';
}

// ---- Channel members sub-modal ----
async function openChannelMembers(cid) {
  cmChannelId = cid;
  const c = channels.get(cid);
  $('cm-title').textContent = 'Settings · ' + (c.type === 'private' ? '🔒 ' : '#') + c.name;
  const sel = $('cm-folder');
  if (sel) {
    sel.innerHTML = DIVISIONS.map(d => `<option value="${d.key}"${(c.category || 'channels') === d.key ? ' selected' : ''}>${d.label}</option>`).join('');
    sel.onchange = async () => {
      const cat = sel.value; c.category = cat;
      try { await sb.from('channels').update({ category: cat }).eq('id', cid); } catch (e) {}
      renderSidebar();
    };
  }
  $('cm-add-filter').value = '';
  $('cm-backdrop').classList.remove('hidden');
  await renderCmList();
}
{ const _g = $('channel-settings-btn'); if (_g) _g.addEventListener('click', () => { if (currentChannelId) openChannelMembers(currentChannelId); }); }
$('cm-close').addEventListener('click', () => $('cm-backdrop').classList.add('hidden'));
$('cm-add-filter').addEventListener('input', renderCmList);
async function renderCmList() {
  const { data: mems } = await sb.from('channel_members').select('user_id').eq('channel_id', cmChannelId);
  const memberIds = new Set((mems || []).map(m => m.user_id));
  const q = $('cm-add-filter').value.trim().toLowerCase();
  const box = $('cm-list'); box.innerHTML = '';
  const people = [...profiles.values()].filter(p => p.username !== 'slackarchive' && p.active !== false)
    .filter(p => !q || p.display_name.toLowerCase().includes(q) || p.username.toLowerCase().includes(q))
    .sort((a, b) => memberIds.has(b.id) - memberIds.has(a.id) || a.display_name.localeCompare(b.display_name));
  for (const p of people) {
    const row = document.createElement('div'); row.className = 'cm-row';
    row.appendChild(avatarEl(p, 'mini-avatar'));
    const nm = document.createElement('span'); nm.className = 'cm-name'; nm.textContent = p.display_name; row.appendChild(nm);
    const btn = document.createElement('button'); btn.className = 'mini-btn' + (memberIds.has(p.id) ? ' danger' : '');
    btn.textContent = memberIds.has(p.id) ? 'Remove' : 'Add';
    btn.onclick = async () => {
      const fn = memberIds.has(p.id) ? 'admin_remove_member' : 'admin_add_member';
      const { error } = await sb.rpc(fn, { cid: cmChannelId, uid: p.id });
      if (error) { alert(error.message); return; }
      renderCmList();
    };
    row.appendChild(btn);
    box.appendChild(row);
  }
}

// ---- Settings tab ----
function renderSettings() {
  $('ws-name').value = window.__wsName || 'HiveConnect';
  const chCount = [...channels.values()].filter(c => c.type !== 'dm' && !c.archived).length;
  const people = [...profiles.values()].filter(p => p.username !== 'slackarchive');
  $('settings-stats').innerHTML =
    `<div class="st"><b>${people.filter(p => p.active !== false).length}</b><span>Active members</span></div>` +
    `<div class="st"><b>${chCount}</b><span>Channels</span></div>` +
    `<div class="st"><b>${people.filter(p => p.role === 'admin' || p.role === 'owner').length}</b><span>Admins</span></div>`;
  // Email mailboxes — connect/remove lives here in Settings, not in the email sidebar
  const mb = $('settings-mailboxes');
  if (mb) {
    mb.innerHTML = '';
    if (!evAccounts.length) {
      const empty = document.createElement('div'); empty.textContent = 'No mailboxes connected yet.'; empty.style.cssText = 'color:var(--mut);font-size:12.5px;padding:2px 0'; mb.appendChild(empty);
    } else {
      evAccounts.forEach(a => {
        const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)';
        const nm = document.createElement('span'); nm.textContent = a.username || a.name; nm.style.cssText = 'font-size:13px;font-weight:600;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap'; row.appendChild(nm);
        const rm = document.createElement('button'); rm.className = 'text-btn'; rm.textContent = 'Remove'; rm.onclick = () => { emailRemoveAccount(a); renderSettings(); }; row.appendChild(rm);
        mb.appendChild(row);
      });
    }
    const add = document.createElement('button'); add.className = 'mini-btn'; add.style.marginTop = '10px';
    add.innerHTML = '<span>＋</span> Add mailbox';
    add.onclick = hcAddImapMailbox; mb.appendChild(add);
  }
}
$('ws-save').addEventListener('click', async () => {
  const name = $('ws-name').value.trim() || 'HiveConnect';
  await sb.from('workspace_settings').upsert({ id: 1, name }).then(() => {});
  window.__wsName = name;
  applyWorkspaceName(name);
  const msg = $('ws-msg'); msg.style.color = '#4c8a5f'; msg.textContent = 'Saved ✓'; msg.classList.remove('hidden');
  setTimeout(() => msg.classList.add('hidden'), 1500);
});
function applyWorkspaceName(name) {
  const wm = document.querySelector('.workspace-name .wm');
  if (wm) wm.textContent = name;
  document.title = name;
}
async function loadWorkspaceName() {
  const { data } = await sb.from('workspace_settings').select('name').eq('id', 1).maybeSingle();
  if (data && data.name) { window.__wsName = data.name; applyWorkspaceName(data.name); }
}
function closeSearch() { $('search-panel').classList.add('hidden'); searchInput.value = ''; }
$('search-close').addEventListener('click', closeSearch);

// ---------- Browser notifications ----------
function maybeAskNotifPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}
document.addEventListener('click', function once() {
  if (notifsEnabled) maybeAskNotifPermission();
  document.removeEventListener('click', once);
});
function browserNotify(n) {
  if (!notifsEnabled) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.hasFocus()) return; // bell handles it when you're looking
  const actor = profiles.get(n.actor_id), ch = channels.get(n.channel_id);
  const verb = n.kind === 'mention' ? 'mentioned you' : n.kind === 'thread_reply' ? 'replied to your thread' : 'sent you a message';
  const title = `${actor ? actor.display_name : 'Someone'} ${verb}`;
  const notif = new Notification(title, {
    body: ch ? `in ${channelLabel(ch)}` : 'HiveConnect',
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><polygon points='50,5 90,27 90,73 50,95 10,73 10,27' fill='%23ffc94b'/></svg>",
    tag: n.id,
  });
  notif.onclick = () => { window.focus(); if (n.channel_id) openChannel(n.channel_id); notif.close(); };
}

// ---------- Realtime ----------
function subscribeRealtime() {
  sb.channel('db-changes')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, ({ new: m }) => {
      if (window.hlSfx && m.user_id !== me.id) hlSfx.play('notify');
      const isCurrent = m.channel_id === currentChannelId;
      if (m.thread_parent_id) {
        messagesCache.set(m.id, m);
        if (m.thread_parent_id === currentThreadId) renderThread();
        return;
      }
      if (isCurrent) {
        messagesCache.set(m.id, m);
        renderMessages();
        if (m.user_id !== me.id) markRead(m.channel_id);
      } else if (m.user_id !== me.id) {
        unreads.set(m.channel_id, (unreads.get(m.channel_id) || 0) + 1);
        renderSidebar();
      }
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, ({ new: m }) => {
      if (messagesCache.has(m.id)) {
        messagesCache.set(m.id, m);
        if (m.channel_id === currentChannelId && !m.thread_parent_id) rerenderMessage(m.id);
        if (m.thread_parent_id === currentThreadId || m.id === currentThreadId) renderThread();
        if (!m.thread_parent_id) rerenderMessage(m.id);
      }
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'reactions' }, payload => {
      const r = payload.eventType === 'DELETE' ? payload.old : payload.new;
      if (!r || !r.message_id) return;
      let list = reactionsCache.get(r.message_id) || [];
      if (payload.eventType === 'INSERT') {
        if (!list.some(x => x.user_id === r.user_id && x.emoji === r.emoji)) list.push(r);
      } else if (payload.eventType === 'DELETE') {
        list = list.filter(x => !(x.user_id === r.user_id && x.emoji === r.emoji));
      }
      reactionsCache.set(r.message_id, list);
      rerenderMessage(r.message_id);
      if (currentThreadId) renderThread();
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${me.id}` }, ({ new: n }) => {
      notifications.unshift(n);
      renderBell();
      browserNotify(n);
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'channels' }, ({ new: c }) => {
      channels.set(c.id, c);
      renderSidebar();
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'channel_members', filter: `user_id=eq.${me.id}` }, async ({ new: m }) => {
      if (!memberships.has(m.channel_id)) memberships.set(m.channel_id, m);
      // If I was just added to a channel I don't have yet (e.g. invited into a live call), load it…
      if (!channels.has(m.channel_id)) {
        const { data: c } = await sb.from('channels').select('*').eq('id', m.channel_id).single();
        if (c) channels.set(c.id, c);
      }
      renderSidebar();
      // …then surface any live call there immediately (don't wait for the next presence sync).
      if (typeof updateIncomingCalls === 'function') updateIncomingCalls();
    })
    .subscribe();

  // profiles change rarely; refresh on new user or profile edit (name/avatar/color)
  sb.channel('profiles-changes')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'profiles' }, ({ new: p }) => {
      profiles.set(p.id, p);
      renderSidebar();
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, ({ new: p }) => {
      if (p.id === me.id) return; // my own edits already applied locally
      profiles.set(p.id, p);
      renderSidebar();
      if (currentChannelId) renderMessages();
      if (currentThreadId) renderThread();
    })
    .subscribe();
}

/* ==================================================================
   EMAIL — full Microsoft 365 (Outlook) client, multi-mailbox.
   Uses MSAL (browser) for sign-in + Microsoft Graph for read/send.
   ================================================================== */
const EV_SCOPES = ['User.Read', 'Mail.ReadWrite', 'Mail.Send', 'Calendars.ReadWrite', 'Tasks.ReadWrite', 'offline_access'];
const EV_FOLDERS = [
  { id: 'inbox', name: 'Inbox', icon: '📥' },
  { id: 'sentitems', name: 'Sent', icon: '📤' },
  { id: 'drafts', name: 'Drafts', icon: '📝' },
  { id: 'archive', name: 'Archive', icon: '🗄️' },
  { id: 'junkemail', name: 'Junk', icon: '⚠️' },
  { id: 'deleteditems', name: 'Deleted', icon: '🗑️' },
];
let msalApp = null;
let evAccounts = [];          // MSAL accounts (mailboxes)
let evActive = null;          // active account object
let evFolderId = 'inbox', evFolderName = 'Inbox';
let evMessages = [];          // current list
let evNextLink = null;        // Graph @odata.nextLink for paging into full mailbox history
let evOpenId = null;          // open message id
let evComposeMode = 'new', evComposeSource = null;
let evComposeDraftId = null; // Graph id of the server-side draft this compose session has saved, if any
let evAttachments = [];       // [{name,type,bytes(base64)}]
let evCustomFolders = [];     // user-created folders (beyond the standard six)
/* Inbox mode: 'all' | 'triage'.
   Chris, 2026-08-17: "dump them" -- Microsoft's Focused/Other pills are gone.
   They answered "is this important?" with a line Outlook drew and you could not
   see, and the default sat on 'focused', which meant the Inbox had quietly been
   showing only one of the two piles the whole time. Reina answers the question
   that actually matters -- what does this want from me -- and shows her reason,
   so there is no second opinion worth the confusion. Dropping the pills MUST
   also drop the inferenceClassification filter below, or the Inbox would stay
   stuck on Focused with nothing left to switch it back. */
let evAllInboxes = false;     // unified 'All Inboxes' view across every signed-in mailbox
let evUserPickedMailbox = false; // user chose a specific mailbox this visit (resets on tab entry)
let evAcctMenuOpen = false;   // mailbox dropdown open? (collapsed by default so the sidebar stays clean)
const evSecCollapsed = { favs: false, folders: false, groups: false }; // sidebar section fold state (session-only)
let evGroup = true;           // group the list by conversation (thread view)

// ---- Outlook-style command bar / list interactions (2026-08-24) ----
let evSelected = new Set();      // ids of checked messages, for bulk actions
let evLastUndo = null;           // { kind, ids, fromFolder } snapshot backing the Undo button
let evUndoTimer = null;          // clears evLastUndo ~10s after a bulk action
let evSortBy = 'date', evSortDir = 'desc';   // 'date' | 'from' | 'subject'
let evFocusedTab = 'focused';    // 'focused' | 'other' -- purely a render-time filter, see renderMessageList
function evFavFolders() { return hcPrefJson('hcEmailFavFolders', 'hcEmailFavs', []) || []; }
function evSaveFavFolders(f) { hcPrefSet('hcEmailFavFolders', 'hcEmailFavs', f); }

// Outlook default preset categories (name → color). Applying these "just works" in most mailboxes.
const EV_CATS = [
  { name: 'Red category', color: '#e0483b' },
  { name: 'Orange category', color: '#f2842b' },
  { name: 'Yellow category', color: '#f5c518' },
  { name: 'Green category', color: '#3faa5a' },
  { name: 'Blue category', color: '#2f6fd6' },
  { name: 'Purple category', color: '#8b5cf6' },
];
function evCatColor(name) { const c = EV_CATS.find(x => x.name === name); return c ? c.color : '#8b92a8'; }
// email templates (saved locally)
function evTemplates() { return hcPrefJson('hcEmailTemplates', 'hcEmailTpls', []) || []; }
function evSaveTemplates(t) { hcPrefSet('hcEmailTemplates', 'hcEmailTpls', t); }

function emailConfigured() { const g = (window.HIVE_CONFIG || {}).msGraph; return !!(g && g.clientId); }
function emailActiveLabel() { return evActive ? (evActive.username || '') : ''; }

// ---- mailbox ownership guard ----
// MSAL's account cache is scoped to the browser, not to whichever
// HiveLogic person is currently signed in to HiveConnect. Without this,
// anyone using the same browser/device sees -- and can select -- every
// Microsoft mailbox anyone has ever connected on that machine, not just
// their own. hc_mailbox_links (Supabase, RLS'd to auth.uid()) records
// who actually owns each connected account; ensureMsal() below filters
// every getAllAccounts() call through it, fail-safe to "show nothing"
// until that lookup resolves.
var hcOwnAccountIds = null;
async function hcRefreshOwnAccountIds() {
  try {
    var res = await sb.from('hc_mailbox_links').select('ms_home_account_id');
    if (res.error) throw res.error;
    var fetched = (res.data || []).map(function (r) { return r.ms_home_account_id; });
    var merged = hcOwnAccountIds || [];
    fetched.forEach(function (id) { if (merged.indexOf(id) === -1) merged.push(id); });
    hcOwnAccountIds = merged;
  } catch (e) {
    hcOwnAccountIds = hcOwnAccountIds || [];
  }
  try {
    if ($('email-view')) { openEmailTab(); }
  } catch (e) {}
}
async function hcLinkMailbox(account) {
  if (!account || !account.homeAccountId) return;
  try {
    var u = await sb.auth.getUser();
    var uid = u && u.data && u.data.user && u.data.user.id;
    if (!uid) return;
    await sb.from('hc_mailbox_links').upsert(
      { owner_id: uid, ms_home_account_id: account.homeAccountId, ms_username: account.username || null },
      { onConflict: 'owner_id,ms_home_account_id' }
    );
  } catch (e) {}
  if (hcOwnAccountIds === null) hcOwnAccountIds = [];
  if (hcOwnAccountIds.indexOf(account.homeAccountId) === -1) hcOwnAccountIds.push(account.homeAccountId);
}
async function hcUnlinkMailbox(account) {
  if (!account || !account.homeAccountId) return;
  try {
    var u = await sb.auth.getUser();
    var uid = u && u.data && u.data.user && u.data.user.id;
    if (!uid) return;
    await sb.from('hc_mailbox_links').delete().eq('owner_id', uid).eq('ms_home_account_id', account.homeAccountId);
  } catch (e) {}
  if (hcOwnAccountIds) hcOwnAccountIds = hcOwnAccountIds.filter(function (id) { return id !== account.homeAccountId; });
}
function ensureMsal() {
  if (msalApp) return msalApp;
  if (!emailConfigured()) return null;
  const g = window.HIVE_CONFIG.msGraph;
  msalApp = new msal.PublicClientApplication({
    auth: {
      clientId: g.clientId,
      authority: 'https://login.microsoftonline.com/' + (g.tenant || 'common'),
      redirectUri: location.origin + location.pathname,
    },
    cache: { cacheLocation: 'localStorage', storeAuthStateInCookie: false },
  });
  const hcRealGetAllAccounts = msalApp.getAllAccounts.bind(msalApp);
  msalApp.getAllAccounts = function () {
    const real = hcRealGetAllAccounts();
    if (hcOwnAccountIds === null) return [];
    return real.filter(function (a) { return hcOwnAccountIds.indexOf(a.homeAccountId) !== -1; });
  };
  hcRefreshOwnAccountIds();
  hcRefreshImapAccounts();
  evAccounts = evListAccounts();
  if (evAccounts.length && !evActive) evActive = evAccounts[0];
  return msalApp;
}

async function evToken(acct) {
  const app = ensureMsal(); const tokAcct = acct || evActive; if (!app || !tokAcct) throw new Error('not signed in');
  try { const r = await app.acquireTokenSilent({ scopes: EV_SCOPES, account: tokAcct }); return r.accessToken; }
  catch (e) { try { const r2 = await app.ssoSilent({ scopes: EV_SCOPES, account: tokAcct, loginHint: tokAcct.username }); if (r2 && r2.account && !acct) evActive = r2.account; return r2.accessToken; } catch (e2) { const r = await app.acquireTokenPopup({ scopes: EV_SCOPES, account: tokAcct }); return r.accessToken; } }
}
async function evGraph(path, opts = {}) {
  // IMAP mailboxes (Gmail/iCloud/Yahoo/AOL/custom) have no Microsoft token —
  // route their Graph-shaped calls to /api/mail, which speaks IMAP/SMTP and
  // returns the same JSON shapes. Microsoft accounts fall through unchanged.
  const acct = opts.account || evActive;
  if (acct && acct.provider === 'imap') return evImapGraph(acct, path, opts);
  // Demo mailbox: no external provider at all, just an in-memory sample
  // mailbox so the tab is fully interactive with nothing to sign into.
  if (acct && acct.provider === 'mock') return evMockGraph(path, opts);
  const token = await evToken(opts.account);
  // Support absolute URLs so @odata.nextLink pagination links work directly.
  const url = /^https:\/\//.test(path) ? path : ('https://graph.microsoft.com/v1.0' + path);
  const r = await fetch(url, {
    method: opts.method || 'GET',
    headers: Object.assign({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, opts.headers || {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 204 || r.status === 202) return {};
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || ('Graph ' + r.status));
  return j;
}

// ---- IMAP mailbox support (provider:'imap' accounts) ----
var evImapAccounts = [];
var evMailGoogleOn = true; // Google "Sign in with Google" available (GOOGLE_CLIENT_* set)
var HC_GOOGLE_G = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#4285F4" d="M45 24c0-1.6-.1-3.1-.4-4.5H24v9h11.8c-.5 2.7-2 5-4.3 6.6v5.5h7C42.6 36.8 45 31 45 24z"/><path fill="#34A853" d="M24 46c5.8 0 10.7-1.9 14.3-5.2l-7-5.5c-1.9 1.3-4.4 2.1-7.3 2.1-5.6 0-10.3-3.8-12-8.9H4.8v5.6C8.4 41.1 15.6 46 24 46z"/><path fill="#FBBC05" d="M12 28.5c-.5-1.4-.7-2.9-.7-4.5s.3-3.1.7-4.5v-5.6H4.8C3.3 17.3 2.5 20.5 2.5 24s.8 6.7 2.3 9.6L12 28.5z"/><path fill="#EA4335" d="M24 11.5c3.2 0 6 1.1 8.2 3.2l6.1-6.1C34.7 5.1 29.8 3 24 3 15.6 3 8.4 7.9 4.8 14.9l7.2 5.6c1.7-5.1 6.4-8.9 12-9z"/></svg>';
var HC_MS_LOGO = '<svg viewBox="0 0 23 23" aria-hidden="true"><path fill="#F25022" d="M1 1h10v10H1z"/><path fill="#7FBA00" d="M12 1h10v10H12z"/><path fill="#00A4EF" d="M1 12h10v10H1z"/><path fill="#FFB900" d="M12 12h10v10H12z"/></svg>';
// One-click Google connect: open a popup, run the OAuth flow via /api/mail,
// wait for the "connected" postMessage, then refresh + select the new mailbox.
async function hcGoogleConnect(bd, showErr, gBtn) {
  const pop = window.open('', 'hcgmail', 'width=520,height=680');
  if (gBtn) { gBtn.disabled = true; }
  let j;
  try { j = await evMailApi('goog_start', {}); }
  catch (e) { try { pop && pop.close(); } catch (_) {} if (gBtn) gBtn.disabled = false; showErr(e.message || 'Could not start Google sign-in.'); return; }
  if (!pop) { if (gBtn) gBtn.disabled = false; showErr('Popup blocked — allow popups for this site and try again.'); return; }
  pop.location.href = j.url;
  const email = await new Promise((resolve) => {
    let done = false, bc = null;
    const finish = (v) => { if (done) return; done = true; cleanup(); resolve(v); };
    const onMsg = (ev) => { const d = ev && ev.data; if (!d || d.type !== 'hc-mail-connected') return; try { pop.close(); } catch (e) {} finish(d.email || null); };
    try { bc = new BroadcastChannel('hc-mail-auth'); bc.onmessage = onMsg; } catch (e) {}
    window.addEventListener('message', onMsg);
    const iv = setInterval(() => { if (!done && pop.closed) finish(null); }, 700);
    function cleanup() { clearInterval(iv); window.removeEventListener('message', onMsg); try { bc && bc.close(); } catch (e) {} }
  });
  if (gBtn) gBtn.disabled = false;
  await hcRefreshImapAccounts();
  const acc = (evImapAccounts || []).find(a => email && a.username === email);
  if (acc) { evActive = acc; evAllInboxes = false; evUserPickedMailbox = true; try { bd.remove(); } catch (e) {} openEmailTab(); evToast('Gmail connected ✓'); }
  else if (email) { try { bd.remove(); } catch (e) {} openEmailTab(); evToast('Gmail connected ✓'); }
  else { showErr('Sign-in window closed before finishing — try again.'); }
}
async function evSbToken() {
  try { const s = await sb.auth.getSession(); return (s && s.data && s.data.session && s.data.session.access_token) || null; } catch (e) { return null; }
}
async function evMailApi(action, body) {
  const t = await evSbToken();
  const r = await fetch('/api/mail?action=' + action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error((j.error && j.error.message) || j.error || ('mail ' + r.status)); e.status = r.status; throw e; }
  return j;
}
async function evImapGraph(acct, path, opts = {}) {
  const j = await evMailApi('graph', { account: acct.username, path: path, method: opts.method || 'GET', body: opts.body || null });
  return j;
}

// ---- Demo mailbox (provider:'mock') --------------------------------------
// A UI-only sample mailbox: no Microsoft, no IMAP, nothing to sign into.
// Everything (send, reply, delete, flag, drafts…) is real and interactive
// against this in-memory array, it just never leaves the browser tab — a
// refresh resets it back to the sample set. It plugs into evGraph() the same
// way the IMAP shim does, so every existing call site (selectFolder,
// openEmailMessage, evFlag, evMove, evSendCompose, etc.) needs no changes at
// all — they already only know "Graph-shaped path in, Graph-shaped JSON out."
const EV_MOCK_ACCOUNT = { homeAccountId: 'mock-demo', username: 'demo@hivelogic.local', name: 'Demo Mailbox', provider: 'mock' };
function evMockId() { return 'mock-' + Math.random().toString(36).slice(2) + Date.now().toString(36); }
function evMockPerson(name, address) { return { emailAddress: { name, address } }; }
function evMockMsg(o) {
  return Object.assign({
    id: evMockId(), toRecipients: [], ccRecipients: [], categories: [],
    hasAttachments: false, isRead: true, importance: 'normal',
    inferenceClassification: 'focused', flag: { flagStatus: 'notFlagged' },
    conversationId: evMockId(), body: { contentType: 'HTML', content: '<p>' + (o.bodyPreview || '') + '</p>' },
  }, o);
}
function evMockAgo(hours) { return new Date(Date.now() - hours * 3600000).toISOString(); }
let EV_MOCK_MESSAGES = null;
let EV_MOCK_FOLDERS = []; // custom (non-well-known) folders created in the demo mailbox: {id, displayName}
function evMockSeed() {
  const me = evMockPerson('Demo Mailbox', 'demo@hivelogic.local');
  const threadId = evMockId();
  EV_MOCK_MESSAGES = [
    evMockMsg({ folder: 'inbox', subject: 'Roof leak — urgent', from: evMockPerson('Karen Alvarez', 'karen.alvarez@example.com'), toRecipients: [me], receivedDateTime: evMockAgo(1), isRead: false, importance: 'high', hasAttachments: true, conversationId: threadId, bodyPreview: 'We noticed water coming through the ceiling in the upstairs bedroom after last night\'s storm — can someone come take a look today?', body: { contentType: 'HTML', content: '<p>We noticed water coming through the ceiling in the upstairs bedroom after last night\'s storm.</p><p>Can someone come take a look today? It\'s getting worse.</p><p>— Karen</p>' } }),
    evMockMsg({ folder: 'inbox', subject: 'Invoice #2044 — payment received', from: evMockPerson('Jobber Billing', 'billing@getjobber.com'), toRecipients: [me], receivedDateTime: evMockAgo(3), isRead: true, categories: ['Green category'], bodyPreview: 'Payment of $1,240.00 has been received for invoice #2044.', body: { contentType: 'HTML', content: '<p>Payment of <b>$1,240.00</b> has been received for invoice #2044.</p>' } }),
    evMockMsg({ folder: 'inbox', subject: 'Signed contract attached', from: evMockPerson('Marcus Webb', 'mwebb@example.com'), toRecipients: [me], receivedDateTime: evMockAgo(6), isRead: true, hasAttachments: true, flag: { flagStatus: 'flagged' }, bodyPreview: 'Signed and attached — let us know when you can start.', body: { contentType: 'HTML', content: '<p>Signed and attached. Let us know when you can start.</p>' } }),
    evMockMsg({ folder: 'inbox', subject: 'Photos from job site', from: evMockPerson('Dana Ruiz (Field)', 'dana.ruiz@hivelogic.local'), toRecipients: [me], receivedDateTime: evMockAgo(9), isRead: false, hasAttachments: true, bodyPreview: 'Uploaded today\'s progress photos from the Henderson job.', body: { contentType: 'HTML', content: '<p>Uploaded today\'s progress photos from the Henderson job — framing is done, on schedule.</p>' } }),
    evMockMsg({ folder: 'inbox', subject: 'Team meeting notes — Thursday', from: evMockPerson('Priya Shah', 'priya.shah@hivelogic.local'), toRecipients: [me], receivedDateTime: evMockAgo(20), isRead: true, categories: ['Blue category'], bodyPreview: 'Notes from this week\'s sync are attached below.', body: { contentType: 'HTML', content: '<p>Notes from this week\'s sync:</p><ul><li>Henderson job on track</li><li>New hire starts Monday</li><li>Truck #3 needs service</li></ul>' } }),
    evMockMsg({ folder: 'inbox', subject: 'Question about estimate #1122', from: evMockPerson('Tom Bailey', 'tbailey@example.com'), toRecipients: [me], receivedDateTime: evMockAgo(26), isRead: false, bodyPreview: 'Quick question about the materials line on the estimate you sent over.', body: { contentType: 'HTML', content: '<p>Quick question about the materials line on the estimate you sent over — is that per square foot or total?</p>' } }),
    evMockMsg({ folder: 'inbox', subject: 'Vendor delivery scheduled for Friday', from: evMockPerson('Northgate Supply', 'orders@northgatesupply.example'), toRecipients: [me], receivedDateTime: evMockAgo(30), isRead: true, categories: ['Yellow category'], bodyPreview: 'Your order #88213 is scheduled to arrive Friday between 8am–12pm.', body: { contentType: 'HTML', content: '<p>Your order #88213 is scheduled to arrive Friday between 8am–12pm.</p>' } }),
    evMockMsg({ folder: 'inbox', subject: 'Fall home maintenance tips', from: evMockPerson('Trade Weekly Newsletter', 'news@tradeweekly.example'), toRecipients: [me], receivedDateTime: evMockAgo(40), isRead: true, inferenceClassification: 'other', bodyPreview: '5 things every homeowner should check before winter…', body: { contentType: 'HTML', content: '<p>5 things every homeowner should check before winter…</p>' } }),
    evMockMsg({ folder: 'inbox', subject: 'Re: Roof leak — urgent', from: evMockPerson('Karen Alvarez', 'karen.alvarez@example.com'), toRecipients: [me], receivedDateTime: evMockAgo(0.5), isRead: false, importance: 'high', conversationId: threadId, bodyPreview: 'Thanks for the quick response — tomorrow morning works.', body: { contentType: 'HTML', content: '<p>Thanks for the quick response — tomorrow morning works great.</p>' } }),
    evMockMsg({ folder: 'inbox', subject: 'Limited time offer — act now!!!', from: evMockPerson('DealBlast', 'promo@dealblast.example'), toRecipients: [me], receivedDateTime: evMockAgo(50), isRead: true, inferenceClassification: 'other', bodyPreview: 'Save big on tools this week only.', body: { contentType: 'HTML', content: '<p>Save big on tools this week only.</p>' } }),
    evMockMsg({ folder: 'sentitems', subject: 'Re: Roof leak — urgent', from: me, toRecipients: [evMockPerson('Karen Alvarez', 'karen.alvarez@example.com')], receivedDateTime: evMockAgo(1.5), conversationId: threadId, bodyPreview: 'We can have someone out first thing tomorrow morning.', body: { contentType: 'HTML', content: '<p>We can have someone out first thing tomorrow morning.</p>' } }),
    evMockMsg({ folder: 'sentitems', subject: 'Estimate #1122 attached', from: me, toRecipients: [evMockPerson('Tom Bailey', 'tbailey@example.com')], receivedDateTime: evMockAgo(48), hasAttachments: true, bodyPreview: 'Estimate attached as discussed — let me know if you have questions.', body: { contentType: 'HTML', content: '<p>Estimate attached as discussed — let me know if you have questions.</p>' } }),
    evMockMsg({ folder: 'sentitems', subject: 'Following up on invoice #2039', from: me, toRecipients: [evMockPerson('Linda Osei', 'linda.osei@example.com')], receivedDateTime: evMockAgo(70), bodyPreview: 'Just a friendly follow-up on the invoice sent last week.', body: { contentType: 'HTML', content: '<p>Just a friendly follow-up on the invoice sent last week.</p>' } }),
    evMockMsg({ folder: 'drafts', subject: 'Proposal for Henderson project', from: me, toRecipients: [], receivedDateTime: evMockAgo(4), bodyPreview: 'Draft — attaching the full scope and timeline once finalized.', body: { contentType: 'HTML', content: '<p>Draft — attaching the full scope and timeline once finalized.</p>' } }),
    evMockMsg({ folder: 'drafts', subject: 'Thank you note', from: me, toRecipients: [evMockPerson('Marcus Webb', 'mwebb@example.com')], receivedDateTime: evMockAgo(12), bodyPreview: 'Draft — thanks for choosing us for the project.', body: { contentType: 'HTML', content: '<p>Draft — thanks for choosing us for the project.</p>' } }),
    evMockMsg({ folder: 'archive', subject: 'Completed job — Smith residence', from: evMockPerson('Angela Smith', 'angela.smith@example.com'), toRecipients: [me], receivedDateTime: evMockAgo(200), bodyPreview: 'Everything looks great, thank you for the fast turnaround!', body: { contentType: 'HTML', content: '<p>Everything looks great, thank you for the fast turnaround!</p>' } }),
    evMockMsg({ folder: 'archive', subject: 'Old vendor quote — 2025', from: evMockPerson('BuildRight Materials', 'sales@buildright.example'), toRecipients: [me], receivedDateTime: evMockAgo(900), bodyPreview: 'Quote attached for lumber and fasteners.', body: { contentType: 'HTML', content: '<p>Quote attached for lumber and fasteners.</p>' } }),
    evMockMsg({ folder: 'junkemail', subject: "You've won a prize!!!", from: evMockPerson('Totally Real Prizes', 'winner@totally-real-prizes.example'), toRecipients: [me], receivedDateTime: evMockAgo(60), inferenceClassification: 'other', bodyPreview: 'Click here to claim your reward.', body: { contentType: 'HTML', content: '<p>Click here to claim your reward.</p>' } }),
    evMockMsg({ folder: 'deleteditems', subject: 'Test email', from: me, toRecipients: [me], receivedDateTime: evMockAgo(500), bodyPreview: 'Just testing.', body: { contentType: 'HTML', content: '<p>Just testing.</p>' } }),
  ];
}
function evMockList() { if (!EV_MOCK_MESSAGES) evMockSeed(); return EV_MOCK_MESSAGES; }
function evMockStrip(m) {
  // list/search views never need the full HTML body -- keep the shape but drop it,
  // matching how Graph's own $select would leave it out.
  const c = Object.assign({}, m); delete c.body; return c;
}
async function evMockGraph(path, opts = {}) {
  const list = evMockList();
  const method = (opts.method || 'GET').toUpperCase();
  const clean = path.split('?')[0];
  const query = (path.split('?')[1] || '');

  if (method === 'GET' && /\/me\/mailFolders$/.test(clean)) {
    const std = EV_FOLDERS.map(f => ({ id: f.id, displayName: f.name, wellKnownName: f.id, unreadItemCount: list.filter(m => m.folder === f.id && !m.isRead).length }));
    const custom = EV_MOCK_FOLDERS.map(f => ({ id: f.id, displayName: f.displayName, unreadItemCount: list.filter(m => m.folder === f.id && !m.isRead).length }));
    return { value: std.concat(custom) };
  }
  if (method === 'POST' && /\/me\/mailFolders$/.test(clean)) {
    const created = { id: evMockId(), displayName: (opts.body || {}).displayName || 'New folder' };
    EV_MOCK_FOLDERS.push(created);
    return Object.assign({}, created);
  }
  let fm = clean.match(/\/me\/mailFolders\/([^/]+)\/messages$/);
  if (method === 'GET' && fm) {
    const rows = list.filter(m => m.folder === fm[1]).sort((a, b) => new Date(b.receivedDateTime) - new Date(a.receivedDateTime));
    return { value: rows.map(evMockStrip) };
  }
  if (method === 'GET' && /\/me\/messages$/.test(clean)) {
    const params = new URLSearchParams(query);
    let rows = list.slice();
    const search = params.get('$search');
    if (search) {
      const q = search.replace(/^"|"$/g, '').toLowerCase();
      rows = rows.filter(m => [m.subject, (m.from.emailAddress || {}).name, (m.from.emailAddress || {}).address, m.bodyPreview].join(' ').toLowerCase().includes(q));
    }
    const filter = params.get('$filter') || '';
    if (/flag\/flagStatus eq 'flagged'/.test(filter)) rows = rows.filter(m => m.flag && m.flag.flagStatus === 'flagged');
    else if (/importance eq 'high'/.test(filter)) rows = rows.filter(m => m.importance === 'high');
    const convo = filter.match(/conversationId eq '([^']+)'/);
    if (convo) rows = rows.filter(m => m.conversationId === convo[1]);
    rows.sort((a, b) => new Date(b.receivedDateTime) - new Date(a.receivedDateTime));
    return { value: rows.map(evMockStrip) };
  }
  let idm = clean.match(/\/me\/messages\/([^/]+)$/);
  if (method === 'GET' && idm) {
    const m = list.find(x => x.id === idm[1]);
    if (!m) throw new Error('Message not found');
    return Object.assign({}, m);
  }
  if (method === 'GET' && /\/me\/messages\/[^/]+\/attachments$/.test(clean)) {
    return { value: [] }; // sample mailbox: attachment ICONS show, but there's nothing real to download
  }
  if (method === 'PATCH' && idm) {
    const m = list.find(x => x.id === idm[1]); if (!m) throw new Error('Message not found');
    Object.assign(m, opts.body || {});
    return Object.assign({}, m);
  }
  let mv = clean.match(/\/me\/messages\/([^/]+)\/move$/);
  if (method === 'POST' && mv) {
    const m = list.find(x => x.id === mv[1]); if (!m) throw new Error('Message not found');
    m.folder = (opts.body || {}).destinationId || m.folder;
    return Object.assign({}, m); // unlike real Graph, the mock keeps the same id -- nothing to reconcile for Undo
  }
  let sd = clean.match(/\/me\/messages\/([^/]+)\/send$/);
  if (method === 'POST' && sd) {
    const m = list.find(x => x.id === sd[1]); if (!m) throw new Error('Message not found');
    m.folder = 'sentitems'; m.isRead = true;
    return {};
  }
  if (method === 'POST' && /\/me\/messages$/.test(clean)) {
    const body = opts.body || {};
    const created = evMockMsg(Object.assign({ folder: 'drafts', from: evMockPerson('Demo Mailbox', 'demo@hivelogic.local'), receivedDateTime: new Date().toISOString(), bodyPreview: (body.body && body.body.content || '').replace(/<[^>]+>/g, '').slice(0, 140) }, body));
    list.unshift(created);
    return Object.assign({}, created);
  }
  if (method === 'POST' && /\/me\/sendMail$/.test(clean)) {
    const body = ((opts.body || {}).message) || {};
    const created = evMockMsg(Object.assign({ folder: 'sentitems', from: evMockPerson('Demo Mailbox', 'demo@hivelogic.local'), receivedDateTime: new Date().toISOString(), bodyPreview: (body.body && body.body.content || '').replace(/<[^>]+>/g, '').slice(0, 140) }, body));
    list.unshift(created);
    return {};
  }
  if (method === 'POST' && /\/me\/mailFolders\/inbox\/messageRules$/.test(clean)) return {}; // block-sender rule: no-op in the sample mailbox
  return { value: [] };
}
// Merge IMAP mailboxes alongside Microsoft ones in the account list.
function evListAccounts() {
  const ms = (msalApp && msalApp.getAllAccounts) ? msalApp.getAllAccounts() : [];
  const real = ms.concat(evImapAccounts || []);
  // No real mailbox connected anywhere -- fall back to the sample mailbox so
  // the tab is fully usable with nothing to sign into. The moment a real
  // Microsoft or IMAP account is connected, this stops appearing.
  return real.length ? real : [EV_MOCK_ACCOUNT];
}
async function hcRefreshImapAccounts() {
  try { const j = await evMailApi('accounts', {}); evImapAccounts = j.accounts || []; }
  catch (e) { evImapAccounts = evImapAccounts || []; }
  try { if ($('email-view')) openEmailTab(); } catch (e) {}
}

// ---- open the Email tab: pick the right state ----
function openEmailTab() {
  ensureMsal();
  const connect = $('ev-connect'); if (!$('email-view')) return;
  evAccounts = evListAccounts();
  if (evActive && !evAccounts.some(a => a.homeAccountId === evActive.homeAccountId)) evActive = null;
  if (!evActive) evActive = evAccounts[0] || null;
  // Email opens on the unified All Inboxes view every time; a mailbox the user
  // picks from the switcher sticks until they leave the tab and come back.
  if (!evUserPickedMailbox) evApplyDefaultMailbox();
  // Always paint the sidebar so the second column is never blank.
  renderEmailSidebar();
  const note = $('ev-setup-note'), btn = $('ev-signin');
  const usingSample = !!(evActive && evActive.provider === 'mock');
  if (!emailConfigured() && !usingSample) {
    connect.classList.remove('hidden');
    if (note) { note.classList.remove('hidden'); note.innerHTML = 'Almost there — your admin needs to paste an <b>Azure Application (client) ID</b> into the app config to switch email on. Ask Chris / see the setup checklist.'; }
    if (btn) btn.disabled = true;
    return;
  }
  if (btn) btn.disabled = false;
  if (note) note.classList.add('hidden');
  if (!evActive) { connect.classList.remove('hidden'); return; }
  connect.classList.add('hidden');
  selectFolder(evFolderId, evFolderName);
  // Behind the inbox, not in front of it: labels the mail so the Team To-Do
  // count is right, and paints nothing.
  evTriageBackgroundScan();
}

async function emailSignIn() {
  const app = ensureMsal(); if (!app) return;
  try {
    const r = await app.loginPopup({ scopes: EV_SCOPES, prompt: 'select_account' });
    if (r && r.account) { evActive = r.account; evAllInboxes = false; evUserPickedMailbox = true; await hcLinkMailbox(r.account); }
    evAccounts = app.getAllAccounts();
    openEmailTab();
  } catch (e) { evToast('Sign-in cancelled or failed.'); }
}
async function emailRemoveAccount(acct) {
  if (acct && acct.provider === 'imap') {
    try { await evMailApi('remove_account', { email: acct.username }); } catch (e) {}
    evImapAccounts = (evImapAccounts || []).filter(a => a.homeAccountId !== acct.homeAccountId);
    if (evActive && evActive.homeAccountId === acct.homeAccountId) evActive = null;
    evAccounts = evListAccounts(); if (!evActive) evActive = evAccounts[0] || null;
    openEmailTab();
    return;
  }
  const app = ensureMsal(); if (!app) return;
  try { await app.logoutPopup({ account: acct }); } catch (e) {}
  await hcUnlinkMailbox(acct);
  evAccounts = app.getAllAccounts();
  if (evActive && evActive.homeAccountId === acct.homeAccountId) evActive = evAccounts[0] || null;
  openEmailTab();
}

// ---- add an IMAP mailbox (Gmail / iCloud / Yahoo / AOL / other) ----
function hcAddImapEnsureCss() {
  if (document.getElementById('imapm-css')) return;
  const s = document.createElement('style'); s.id = 'imapm-css';
  s.textContent =
    '.imapm-back{position:fixed;inset:0;background:rgba(22,30,46,.5);z-index:9000;display:flex;align-items:center;justify-content:center;padding:20px}' +
    '.imapm-card{width:100%;max-width:428px;background:#fff;border-radius:16px;box-shadow:0 24px 64px rgba(22,30,46,.30);padding:24px 24px 22px;max-height:92vh;overflow:auto;font-family:inherit}' +
    '.imapm-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}' +
    '.imapm-head h2{margin:0;font-size:20px;font-weight:800;letter-spacing:-.01em;color:#172030}' +
    '.imapm-sub{margin:3px 0 18px;font-size:13px;color:#5c6578}' +
    '.imapm-x{border:none;background:transparent;font-size:16px;color:#8a92a4;cursor:pointer;line-height:1;padding:6px;border-radius:8px;flex:none}' +
    '.imapm-x:hover{background:#f0f1f6;color:#172030}' +
    '.imapm-field{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}' +
    '.imapm-field>label{font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#8a92a4}' +
    '.imapm-field input,.imapm-field select{width:100%;box-sizing:border-box;padding:11px 13px;border:1.5px solid #e3e5ec;border-radius:10px;font-size:14.5px;color:#172030;background:#fff;font-family:inherit;outline:none;transition:border-color .15s,box-shadow .15s}' +
    '.imapm-field input:focus,.imapm-field select:focus{border-color:#5f83a6;box-shadow:0 0 0 3px rgba(95,131,166,.16)}' +
    '.imapm-row{display:flex;gap:10px}.imapm-row .imapm-field{flex:1}' +
    '.imapm-help{font-size:12.5px;color:#4a5468;line-height:1.55;background:#f4f6fa;border:1px solid #e3e5ec;border-radius:10px;padding:11px 13px;margin:0 0 14px}' +
    '.imapm-help a{color:#3b566f;font-weight:700;text-decoration:none}.imapm-help a:hover{text-decoration:underline}' +
    '.imapm-err{font-size:13px;color:#c1544a;background:#f8e7e4;border:1px solid #f0cfca;border-radius:9px;padding:9px 12px;margin:0 0 12px;line-height:1.45}' +
    '.imapm-foot{display:flex;gap:8px;justify-content:flex-end;margin-top:4px}' +
    '.imapm-btn{padding:10px 18px;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;border:1.5px solid transparent;font-family:inherit}' +
    '.imapm-cancel{background:#fff;border-color:#d3d9e5;color:#5c6578}.imapm-cancel:hover{background:#f4f6fa}' +
    '.imapm-save{background:#3b566f;color:#fff}.imapm-save:hover{background:#2f455a}.imapm-save:disabled{opacity:.55;cursor:default}' +
    '.imapm-google{width:100%;display:flex;align-items:center;justify-content:center;gap:10px;padding:12px 14px;border:1.5px solid #dadce0;border-radius:10px;background:#fff;color:#3c4043;font-size:14.5px;font-weight:600;cursor:pointer;font-family:inherit;margin:2px 0 8px}' +
    '.imapm-google:hover{background:#f7f8fa}.imapm-google:disabled{opacity:.6;cursor:default}.imapm-google svg{width:18px;height:18px;flex:none}' +
    '.imapm-alt{display:block;text-align:center;font-size:12.5px;color:#5f83a6;cursor:pointer;margin:0 0 10px}.imapm-alt:hover{text-decoration:underline}' +
    '.imapm-hidden{display:none}';
  document.head.appendChild(s);
}
function hcAddImapMailbox() {
  if (document.getElementById('imapm-back')) return;
  hcAddImapEnsureCss();
  const help = {
    gmail: 'Turn on <b>2-Step Verification</b>, then create an <b>App password</b> at <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">myaccount.google.com/apppasswords</a> and paste the 16-character code here (spaces are fine).',
    icloud: 'Create an <b>app-specific password</b> at <a href="https://account.apple.com" target="_blank" rel="noopener">account.apple.com</a> → Sign-In &amp; Security → App-Specific Passwords, then paste it here.',
    yahoo: 'In Yahoo, turn on <b>IMAP</b>, then generate an <b>app password</b> at <a href="https://login.yahoo.com/account/security" target="_blank" rel="noopener">Account Security</a> and paste it here.',
    aol: 'Generate an <b>app password</b> at <a href="https://login.aol.com/account/security" target="_blank" rel="noopener">AOL Account Security</a> and paste it here.',
    imap: 'Enter your provider’s IMAP and SMTP server settings below, plus your email password (or app password).',
  };
  const bd = document.createElement('div'); bd.id = 'imapm-back'; bd.className = 'imapm-back';
  bd.innerHTML =
    '<div class="imapm-card" role="dialog" aria-modal="true">' +
    '  <div class="imapm-head"><div><h2>Add a mailbox</h2><div class="imapm-sub">Connect Gmail, iCloud, Yahoo, AOL, or any IMAP account.</div></div>' +
    '  <button class="imapm-x" id="imapm-x" aria-label="Close">✕</button></div>' +
    '  <div class="imapm-field"><label for="imapm-provider">Provider</label>' +
    '    <select id="imapm-provider"><option value="microsoft">Microsoft / Outlook</option><option value="gmail">Gmail</option><option value="icloud">iCloud</option><option value="yahoo">Yahoo</option><option value="aol">AOL</option><option value="imap">Other (IMAP)</option></select></div>' +
    '  <button type="button" class="imapm-google imapm-hidden" id="imapm-google">' + HC_GOOGLE_G + ' Sign in with Google</button>' +
    '  <button type="button" class="imapm-google imapm-hidden" id="imapm-ms">' + HC_MS_LOGO + ' Sign in with Microsoft</button>' +
    '  <div class="imapm-alt imapm-hidden" id="imapm-usepw">Use an app password instead</div>' +
    '  <div id="imapm-fields">' +
    '    <div class="imapm-field"><label for="imapm-email">Email address</label><input id="imapm-email" type="email" placeholder="you@example.com" autocomplete="email"></div>' +
    '    <div class="imapm-field"><label for="imapm-pass">App password</label><input id="imapm-pass" type="password" placeholder="app-specific password" autocomplete="off"></div>' +
    '    <div id="imapm-custom" class="imapm-hidden">' +
    '      <div class="imapm-row"><div class="imapm-field"><label>IMAP host</label><input id="imapm-ih" placeholder="imap.example.com"></div><div class="imapm-field" style="max-width:96px"><label>Port</label><input id="imapm-ip" value="993"></div></div>' +
    '      <div class="imapm-row"><div class="imapm-field"><label>SMTP host</label><input id="imapm-sh" placeholder="smtp.example.com"></div><div class="imapm-field" style="max-width:96px"><label>Port</label><input id="imapm-sp" value="465"></div></div>' +
    '    </div>' +
    '  </div>' +
    '  <div class="imapm-help" id="imapm-help"></div>' +
    '  <div class="imapm-err imapm-hidden" id="imapm-err"></div>' +
    '  <div class="imapm-foot"><button class="imapm-btn imapm-cancel" id="imapm-cancel">Cancel</button><button class="imapm-btn imapm-save" id="imapm-save">Connect mailbox</button></div>' +
    '</div>';
  document.body.appendChild(bd);
  const prov = $('imapm-provider'), helpEl = $('imapm-help'), custom = $('imapm-custom'), err = $('imapm-err');
  const gBtn = $('imapm-google'), msBtn = $('imapm-ms'), usePw = $('imapm-usepw'), fields = $('imapm-fields'), saveBtn = $('imapm-save');
  let gmailPwMode = false; // Gmail defaults to one-click Google; this flips to the app-password fallback.
  const close = () => bd.remove();
  const showErr = (t) => { err.textContent = t; err.classList.remove('imapm-hidden'); };
  const syncProv = () => {
    const isMs = prov.value === 'microsoft';
    const gOauth = prov.value === 'gmail' && !gmailPwMode && (evMailGoogleOn !== false);
    const oneClick = isMs || gOauth; // no form fields when it's a one-click sign-in
    gBtn.classList.toggle('imapm-hidden', !gOauth);
    msBtn.classList.toggle('imapm-hidden', !isMs);
    usePw.classList.toggle('imapm-hidden', !gOauth);
    fields.classList.toggle('imapm-hidden', oneClick);
    saveBtn.classList.toggle('imapm-hidden', oneClick);
    custom.classList.toggle('imapm-hidden', prov.value !== 'imap');
    helpEl.innerHTML = isMs ? 'One click — you’ll sign in on Microsoft’s own page.'
      : gOauth ? 'One click — you’ll sign in on Google’s own page, no password to copy.'
      : (prov.value === 'gmail' && gmailPwMode ? help.gmail : (help[prov.value] || ''));
  };
  prov.onchange = () => { gmailPwMode = false; syncProv(); };
  usePw.onclick = () => { gmailPwMode = true; syncProv(); };
  gBtn.onclick = () => hcGoogleConnect(bd, showErr, gBtn);
  msBtn.onclick = () => { close(); try { emailSignIn(); } catch (e) {} };
  syncProv();
  $('imapm-x').onclick = close; $('imapm-cancel').onclick = close;
  bd.addEventListener('click', e => { if (e.target === bd) close(); });
  $('imapm-save').onclick = async () => {
    const email = ($('imapm-email').value || '').trim(); const password = $('imapm-pass').value || '';
    if (!email || !password) { showErr('Email and app password are required.'); return; }
    const btn = $('imapm-save'); btn.disabled = true; btn.textContent = 'Connecting…'; err.classList.add('imapm-hidden');
    const payload = { provider: prov.value, email, password };
    if (prov.value === 'imap') { payload.imapHost = $('imapm-ih').value.trim(); payload.imapPort = $('imapm-ip').value.trim(); payload.smtpHost = $('imapm-sh').value.trim(); payload.smtpPort = $('imapm-sp').value.trim(); }
    try {
      const j = await evMailApi('add_account', payload);
      await hcRefreshImapAccounts();
      if (j.account) { evActive = j.account; evAllInboxes = false; evUserPickedMailbox = true; }
      close(); openEmailTab(); evToast('Mailbox connected ✓');
    } catch (e) { showErr(e.message || 'Could not connect that mailbox.'); btn.disabled = false; btn.textContent = 'Connect mailbox'; }
  };
}

// Default mailbox scope for the Email tab: All Inboxes whenever more than one
// mailbox is connected. Keeps the folder you were in unless it was a per-mailbox
// custom folder, which doesn't exist in the unified view.
function evApplyDefaultMailbox() {
  if (evAccounts.length < 2 || evAllInboxes) return;
  evAllInboxes = true;
  const std = EV_FOLDERS.find(f => f.id === evFolderId);
  if (!std) { evFolderId = 'inbox'; evFolderName = 'All Inboxes'; }
  else evFolderName = std.id === 'inbox' ? 'All Inboxes' : std.name;
}

function evCloseAcctMenu() { if (!evAcctMenuOpen) return; evAcctMenuOpen = false; renderEmailSidebar(); }

// ---- sidebar: mailbox switcher + folders ----
function renderEmailSidebar() {
  const el = $('panel-email'); if (!el) return; el.innerHTML = '';
  const connected = !!evActive;
  // account switcher
  const accWrap = document.createElement('div'); accWrap.className = 'ev-accts';
  const lbl = document.createElement('div'); lbl.className = 'ev-accts-lbl'; lbl.textContent = 'MAILBOXES'; accWrap.appendChild(lbl);
  // One collapsed picker instead of a row per mailbox: the sidebar shows the
  // current scope (All Inboxes by default) and the individual accounts live in
  // a dropdown that stays shut until you ask for it.
  if (evAccounts.length) {
    const multi = evAccounts.length > 1;
    const onAll = multi && evAllInboxes;
    const cur = onAll ? null : evActive;
    const initial = (a) => (a && (a.name || a.username || '?') || '?').trim().charAt(0).toUpperCase();
    const pick = document.createElement('div'); pick.className = 'ev-acct-pick' + (evAcctMenuOpen ? ' open' : '');

    const trig = document.createElement('button'); trig.type = 'button';
    trig.className = 'ev-acct ev-acct-trigger' + (onAll ? ' ev-acct-all' : '');
    const tdot = document.createElement('span'); tdot.className = 'ev-acct-dot';
    tdot.textContent = onAll ? '\u2709' : initial(cur); trig.appendChild(tdot);
    const tnm = document.createElement('span'); tnm.className = 'ev-acct-name';
    tnm.textContent = onAll ? 'All Inboxes' : ((cur && (cur.username || cur.name)) || 'All Inboxes');
    trig.appendChild(tnm);
    if (multi) { const car = document.createElement('span'); car.className = 'ev-acct-caret'; car.textContent = '\u25BE'; trig.appendChild(car); }
    trig.title = multi ? 'Switch mailbox' : (tnm.textContent || '');
    trig.onclick = (e) => { e.stopPropagation(); if (!multi) return; evAcctMenuOpen = !evAcctMenuOpen; renderEmailSidebar(); };
    pick.appendChild(trig);

    if (multi && evAcctMenuOpen) {
      const menu = document.createElement('div'); menu.className = 'ev-acct-menu';
      const all = document.createElement('button'); all.type = 'button';
      all.className = 'ev-acct ev-acct-all' + (evAllInboxes ? ' active' : '');
      const adot = document.createElement('span'); adot.className = 'ev-acct-dot'; adot.textContent = '\u2709'; all.appendChild(adot);
      const at = document.createElement('span'); at.className = 'ev-acct-name'; at.textContent = 'All Inboxes'; all.appendChild(at);
      all.onclick = (e) => {
        e.stopPropagation();
        evAllInboxes = true; evUserPickedMailbox = true; evAcctMenuOpen = false;
        renderEmailSidebar(); selectFolder('inbox', 'All Inboxes');
      };
      menu.appendChild(all);
      const sep = document.createElement('div'); sep.className = 'ev-acct-sep'; menu.appendChild(sep);
      evAccounts.forEach(a => {
        const row = document.createElement('button'); row.type = 'button';
        row.className = 'ev-acct' + (!evAllInboxes && evActive && a.homeAccountId === evActive.homeAccountId ? ' active' : '');
        const dot = document.createElement('span'); dot.className = 'ev-acct-dot'; dot.textContent = initial(a); row.appendChild(dot);
        const t = document.createElement('span'); t.className = 'ev-acct-name'; t.textContent = a.username || a.name; row.appendChild(t);
        const x = document.createElement('span'); x.className = 'ev-acct-x'; x.textContent = '\u2715'; x.title = 'Remove mailbox';
        x.onclick = (e) => { e.stopPropagation(); evAcctMenuOpen = false; emailRemoveAccount(a); };
        row.appendChild(x);
        row.onclick = (e) => {
          e.stopPropagation();
          evAllInboxes = false; evActive = a; evUserPickedMailbox = true; evAcctMenuOpen = false;
          renderEmailSidebar(); selectFolder('inbox', 'Inbox');
        };
        menu.appendChild(row);
      });
      pick.appendChild(menu);
      // click anywhere else closes it
      setTimeout(() => { document.addEventListener('click', evCloseAcctMenu, { once: true }); }, 0);
    }
    accWrap.appendChild(pick);
  }
  // Adding mailboxes lives in Settings (Outlook-style). Only when no REAL
  // mailbox is connected do we show a first-run "Add a mailbox" here so new
  // users aren't stranded — the sample mailbox doesn't count as "connected",
  // or this would vanish the moment the demo data loads and never come back.
  if (!evAccounts.some(a => a.provider !== 'mock')) {
    const add = document.createElement('button'); add.className = 'ev-acct-add';
    add.innerHTML = '<span>＋</span> Add a mailbox';
    add.onclick = hcAddImapMailbox; accWrap.appendChild(add);
  }
  el.appendChild(accWrap);

  // Favourites — pinned folders (standard or custom), for one-click access at
  // the top of the sidebar. Inbox is pinned by default the first time a
  // mailbox connects (matches the reference design); after that it's a real
  // cross-device preference (hcPrefJson), not a per-device setting.
  if (connected && hcPref('hcEmailFavFolders', 'hcEmailFavs', undefined) === undefined) evSaveFavFolders(['inbox']);
  const favIds = evFavFolders();
  {
    const favWrap = document.createElement('div'); favWrap.className = 'ev-favs';
    favWrap.appendChild(evSectionHead('Favourites', 'favs'));
    const favBody = document.createElement('div'); favBody.className = 'ev-sec-body' + (evSecCollapsed.favs ? ' collapsed' : '');
    favIds.forEach(fid => {
      const f = EV_FOLDERS.find(x => x.id === fid) || evCustomFolders.find(x => x.id === fid);
      if (!f) return;
      const row = document.createElement('button'); row.type = 'button'; row.className = 'ev-fav-row' + (connected && evFolderId === fid ? ' active' : '');
      const ic = document.createElement('span'); ic.className = 'ev-fav-ic'; ic.textContent = '★'; row.appendChild(ic);
      const nm = document.createElement('span'); nm.textContent = f.name; row.appendChild(nm);
      row.onclick = () => { if (!evActive) { const c = $('ev-connect'); if (c) c.classList.remove('hidden'); return; } selectFolder(f.id, f.name); };
      favBody.appendChild(row);
    });
    const add = document.createElement('button'); add.type = 'button'; add.className = 'ev-add-fav-link'; add.textContent = 'Add favourite';
    add.onclick = (e) => evAddFavouriteMenu(e, favIds);
    favBody.appendChild(add);
    favWrap.appendChild(favBody);
    el.appendChild(favWrap);
  }

  // folders (always shown; inert until a mailbox is connected)
  const fSec = document.createElement('div'); fSec.className = 'ev-folders-sec';
  fSec.appendChild(evSectionHead('Folders', 'folders'));
  const fWrap = document.createElement('div'); fWrap.className = 'ev-folders ev-sec-body' + (connected ? '' : ' ev-folders-off') + (evSecCollapsed.folders ? ' collapsed' : '');
  EV_FOLDERS.forEach(f => {
    const row = evBuildFolderRow(f, f.icon, connected && f.id === evFolderId, false);
    fWrap.appendChild(row);
  });
  fSec.appendChild(fWrap);
  el.appendChild(fSec);

  // Groups — named lists of people you can compose to in one click. A real,
  // working feature scoped to what this standalone mailbox can actually do;
  // not Outlook 365's shared-mailbox Groups (a different, much bigger thing
  // — its own inbox/calendar/conversations — genuinely out of scope here).
  const groups = evGroups();
  const gSec = document.createElement('div'); gSec.className = 'ev-groups-sec';
  gSec.appendChild(evSectionHead('Groups', 'groups'));
  const gBody = document.createElement('div'); gBody.className = 'ev-sec-body' + (evSecCollapsed.groups ? ' collapsed' : '');
  groups.forEach(g => {
    const row = document.createElement('button'); row.type = 'button'; row.className = 'ev-group-row'; row.title = 'Compose to ' + g.name;
    const ic = document.createElement('span'); ic.className = 'ev-group-ic'; ic.textContent = (g.name || '?').charAt(0).toUpperCase(); row.appendChild(ic);
    const nm = document.createElement('span'); nm.textContent = g.name; row.appendChild(nm);
    const ct = document.createElement('span'); ct.className = 'ev-group-count'; ct.textContent = (g.members || []).length; row.appendChild(ct);
    row.onclick = () => evGroupCompose(g);
    gBody.appendChild(row);
  });
  const newGroup = document.createElement('button'); newGroup.type = 'button'; newGroup.className = 'ev-new-group'; newGroup.textContent = 'Add New Group';
  newGroup.onclick = evCreateGroup;
  gBody.appendChild(newGroup);
  gSec.appendChild(gBody);
  el.appendChild(gSec);

  if (connected) refreshFolderCounts();
}
// one collapsible section header (Favourites / Folders / Groups), matching
// the chevron-fold pattern already used for Chirp's people list.
function evSectionHead(label, key) {
  const head = document.createElement('button'); head.type = 'button'; head.className = 'ev-sec-head' + (evSecCollapsed[key] ? ' collapsed' : '');
  const chev = document.createElement('span'); chev.className = 'ev-sec-chev'; chev.textContent = '▾'; head.appendChild(chev);
  head.appendChild(document.createTextNode(label));
  head.onclick = () => { evSecCollapsed[key] = !evSecCollapsed[key]; renderEmailSidebar(); };
  return head;
}
function evGroups() { return hcPrefJson('hcEmailGroups', 'hcEmailGroups', []) || []; }
function evSaveGroups(g) { hcPrefSet('hcEmailGroups', 'hcEmailGroups', g); }
function evCreateGroup() {
  const name = window.prompt('Group name:'); if (!name || !name.trim()) return;
  const membersRaw = window.prompt('Members (comma-separated email addresses):', '');
  const members = (membersRaw || '').split(',').map(s => s.trim()).filter(Boolean);
  evSaveGroups(evGroups().concat([{ id: evMockId(), name: name.trim(), members }]));
  renderEmailSidebar();
  evToast('Group created ✓');
}
function evGroupCompose(g) {
  openEmailCompose('new', null);
  setTimeout(() => { evSetChips('ev-c-to', g.members || []); }, 30);
}
// one folder row: icon, name, unread count, favourite-pin toggle, and a
// drag-and-drop target so a message row can be dropped onto it to move.
function evBuildFolderRow(f, icon, active, isCustom) {
  const row = document.createElement('button'); row.className = 'ev-folder' + (isCustom ? ' custom' : '') + (active ? ' active' : ''); row.dataset.id = f.id;
  const ic = document.createElement('span'); ic.className = 'ev-folder-ic'; ic.textContent = icon; row.appendChild(ic);
  const nm = document.createElement('span'); nm.className = 'ev-folder-nm'; nm.textContent = f.name; row.appendChild(nm);
  const favs = evFavFolders(); const pinned = favs.includes(f.id);
  const pin = document.createElement('span'); pin.textContent = pinned ? '★' : '☆';
  pin.style.cssText = 'margin-left:4px;cursor:pointer;opacity:' + (pinned ? '1' : '.35') + ';color:#ffc94b;font-size:11px;flex:none';
  pin.title = pinned ? 'Remove from favourites' : 'Add to favourites';
  pin.onclick = (e) => { e.stopPropagation(); const cur = evFavFolders(); const next = pinned ? cur.filter(x => x !== f.id) : cur.concat([f.id]); evSaveFavFolders(next); renderEmailSidebar(); };
  row.appendChild(pin);
  const ct = document.createElement('span'); ct.className = 'ev-folder-ct';
  if (!isCustom) ct.id = 'evfc-' + f.id;
  ct.textContent = f.unread || ''; row.appendChild(ct);
  row.onclick = () => { if (!evActive) { const c = $('ev-connect'); if (c) c.classList.remove('hidden'); return; } selectFolder(f.id, f.name); };
  row.ondragover = (e) => { e.preventDefault(); row.classList.add('dragover'); };
  row.ondragleave = () => row.classList.remove('dragover');
  row.ondrop = (e) => {
    e.preventDefault(); row.classList.remove('dragover');
    const id = e.dataTransfer.getData('text/hc-msg-id'); if (!id) return;
    evMove(id, f.id, 'Moved to ' + f.name);
  };
  return row;
}
async function refreshFolderCounts() {
  try {
    if (evAllInboxes && evAccounts.length > 1) {
      // Unified view: sum unread counts per well-known folder across every mailbox.
      const totals = {};
      const settled = await Promise.allSettled(evAccounts.map(a => evGraph('/me/mailFolders?$select=id,displayName,wellKnownName,unreadItemCount&$top=100', { account: a })));
      settled.forEach(r => {
        if (r.status !== 'fulfilled') return;
        (r.value.value || []).forEach(f => {
          const key = (f.wellKnownName || '').toLowerCase();
          if (key) totals[key] = (totals[key] || 0) + (f.unreadItemCount || 0);
        });
      });
      document.querySelectorAll('#panel-email .ev-folder-ct[id^="evfc-"]').forEach(el => {
        const key = el.id.slice(5); el.textContent = totals[key] ? totals[key] : '';
      });
      evCustomFolders = []; renderCustomFolders(); // custom folders are per-mailbox; hidden in unified view
      return;
    }
    const j = await evGraph('/me/mailFolders?$select=id,displayName,wellKnownName,unreadItemCount&$top=100');
    (j.value || []).forEach(f => {
      const key = (f.wellKnownName || '').toLowerCase();
      const el = $('evfc-' + key); if (el) el.textContent = f.unreadItemCount ? f.unreadItemCount : '';
    });
    // user-created folders (no wellKnownName) shown under "Your folders"
    evCustomFolders = (j.value || []).filter(f => !f.wellKnownName).map(f => ({ id: f.id, name: f.displayName, unread: f.unreadItemCount }));
    renderCustomFolders();
  } catch (e) {}
}
function renderCustomFolders() {
  const wrap = document.querySelector('#panel-email .ev-folders'); if (!wrap) return;
  [...wrap.querySelectorAll('.ev-folder.custom, .ev-cf-sep, .ev-new-folder')].forEach(x => x.remove());
  if (evCustomFolders.length) {
    const sep = document.createElement('div'); sep.className = 'ev-cf-sep'; sep.textContent = 'YOUR FOLDERS'; wrap.appendChild(sep);
    evCustomFolders.forEach(f => {
      const row = evBuildFolderRow(f, '📁', f.id === evFolderId, true);
      wrap.appendChild(row);
    });
  }
  const create = document.createElement('button'); create.type = 'button'; create.className = 'ev-new-folder';
  create.textContent = '+ Create new folder…';
  create.onclick = evCreateFolder;
  wrap.appendChild(create);
}
function evAddFavouriteMenu(e, favIds) {
  const all = EV_FOLDERS.concat(evCustomFolders);
  const options = all.filter(f => !favIds.includes(f.id));
  if (!options.length) { e.stopPropagation(); evToast('Every folder is already a favourite.'); return; }
  evMenu(e, options.map(f => [(f.icon || '📁') + ' ' + f.name, () => { evSaveFavFolders(favIds.concat([f.id])); renderEmailSidebar(); }]));
}
async function evCreateFolder() {
  if (!evActive) { evToast('Connect a mailbox first.'); return; }
  const name = window.prompt('New folder name:'); if (!name || !name.trim()) return;
  if (evActive.provider === 'imap') { evToast('Creating folders isn\'t available yet for this mailbox type.'); return; }
  try {
    await evGraph('/me/mailFolders', { method: 'POST', body: { displayName: name.trim() } });
    evToast('Folder created ✓');
    refreshFolderCounts();
  } catch (e) { evToast('Couldn\'t create folder — ' + (e.message || '')); }
}

async function selectFolder(id, name) {
  evFolderId = id; evFolderName = name; evOpenId = null; evSelected.clear();
  document.querySelectorAll('#panel-email .ev-folder').forEach(b => b.classList.toggle('active', b.dataset.id === id));
  const fn = $('ev-folder-name'); if (fn) fn.textContent = name + (!evAllInboxes && evActive && evActive.username ? ' — ' + evActive.username : '');
  const read = $('ev-read'); if (read) read.innerHTML = '<div class="ev-read-empty">Select a message to read it here.</div>';
  const list = $('ev-list'); if (list) list.innerHTML = '<div class="ev-loading">Loading…</div>';
  try {
    const sel = '$select=id,subject,from,receivedDateTime,isRead,bodyPreview,hasAttachments,flag,conversationId,categories,inferenceClassification,importance';
    const baseUrl = `/me/mailFolders/${id}/messages?${sel}&$top=100&$orderby=receivedDateTime desc`;
    let j;
    // Unified view only fans out on well-known folder ids (inbox, sentitems, ...) which exist in every mailbox.
    if (evAllInboxes && evAccounts.length > 1 && /^[a-z]+$/.test(String(id))) {
      const fetchOne = async (a) => {
        let jj;
        jj = await evGraph(baseUrl, { account: a });   // the whole inbox, not Microsoft's half of it
        return (jj.value || []).map(m => Object.assign(m, { _acct: a.homeAccountId, _acctName: a.username || a.name || '' }));
      };
      const settled = await Promise.allSettled(evAccounts.map(fetchOne));
      const ok = settled.filter(r => r.status === 'fulfilled');
      if (!ok.length && settled.length) throw (settled[0].reason || new Error('All mailboxes failed to load'));
      evMessages = ok.reduce((acc, r) => acc.concat(r.value), [])
        .sort((x, y) => new Date(y.receivedDateTime || 0) - new Date(x.receivedDateTime || 0));
      evNextLink = null; // paging disabled in unified view
    } else {
      j = await evGraph(baseUrl);   // the whole inbox, not Microsoft's half of it
      evMessages = j.value || [];
      evNextLink = j['@odata.nextLink'] || null;
    }
    renderMessageList();
    evPrefetchBriefs();   // so the first click finds Reina already finished
  } catch (e) {
    if (list) list.innerHTML = '<div class="ev-loading">Couldn\'t load mail — ' + esc(e.message) + '</div>';
  }
}
// Starred / Important -- mailbox-wide smart views (Graph $filter, not a real
// folder). Kept separate from selectFolder rather than folded into it: these
// aren't a mode switch on the current folder, they're a different query shape
// entirely, and selectFolder's job stays "load this one real folder."
async function selectSmartFolder(kind) {
  const name = kind === 'starred' ? 'Starred' : 'Important';
  evFolderId = kind; evFolderName = name; evOpenId = null; evSelected.clear();
  document.querySelectorAll('#panel-email .ev-folder').forEach(b => b.classList.toggle('active', b.dataset.id === kind));
  const fn = $('ev-folder-name'); if (fn) fn.textContent = name + (!evAllInboxes && evActive && evActive.username ? ' — ' + evActive.username : '');
  const read = $('ev-read'); if (read) read.innerHTML = '<div class="ev-read-empty">Select a message to read it here.</div>';
  const list = $('ev-list'); if (list) list.innerHTML = '<div class="ev-loading">Loading…</div>';
  const filter = kind === 'starred' ? "flag/flagStatus eq 'flagged'" : "importance eq 'high'";
  const sel = '$select=id,subject,from,receivedDateTime,isRead,bodyPreview,hasAttachments,flag,conversationId,categories,inferenceClassification,importance';
  const baseUrl = `/me/messages?$filter=${encodeURIComponent(filter)}&${sel}&$top=100&$orderby=receivedDateTime desc`;
  try {
    if (evAllInboxes && evAccounts.length > 1) {
      const fetchOne = async (a) => {
        const jj = await evGraph(baseUrl, { account: a });
        return (jj.value || []).map(m => Object.assign(m, { _acct: a.homeAccountId, _acctName: a.username || a.name || '' }));
      };
      const settled = await Promise.allSettled(evAccounts.map(fetchOne));
      const ok = settled.filter(r => r.status === 'fulfilled');
      if (!ok.length && settled.length) throw (settled[0].reason || new Error('All mailboxes failed to load'));
      evMessages = ok.reduce((acc, r) => acc.concat(r.value), [])
        .sort((x, y) => new Date(y.receivedDateTime || 0) - new Date(x.receivedDateTime || 0));
      evNextLink = null;
    } else {
      const j = await evGraph(baseUrl);
      evMessages = j.value || [];
      evNextLink = j['@odata.nextLink'] || null;
    }
    renderMessageList();
  } catch (e) {
    if (list) list.innerHTML = '<div class="ev-loading">Couldn\'t load mail — ' + esc(e.message) + '</div>';
  }
}
/* The Inbox is the Inbox.

   Chris, 2026-08-18: "I dont want the all mail and reina buttons."

   There used to be a pill bar here -- All mail | ⚡ Reina -- which made Reina a
   MODE you had to be in, a second list of the same mail with different rows.
   Two lists of one inbox is one list too many, and it put the thing he wanted
   behind a button he had to remember to press. Her reading now lives in the
   preview pane, on whichever message he opened, which is where he already is.

   (There was a Focused/Other pair here before that, removed 2026-08-17 --
   "dump them".) */

/* ===== Reina, in the preview pane ===========================================
   Chris, 2026-08-18: "I dont want the all mail and reina buttons. I want a
   standard inbox and when you click the email on the list, it populates the big
   preview screen. in the preview it shows a reina summary of the email and a
   suggested action or response. below would be the actual email."

   Right, and it is the third shape this has taken, each one less of a
   destination than the last: a page in the HiveLogic sidebar, then a pill
   inside the mail app, now nothing at all -- just what she has to say about
   the message he already clicked, above the message.

   What changed underneath, and why it matters: the batch classifier reads a
   400-character preview of fifty messages. Opening one reads the WHOLE email,
   which is both a better label and the only way to write a real summary. So the
   brief does all of it in one call -- summary, action, label, reply -- and
   stores it. Opening the same email again is instant and free.

   The batch pass has NOT gone away; it just stopped being visible. It is what
   keeps the "Emails Reina flagged" row on his Team To-Do honest, and with the
   pill gone nothing else would ever trigger it.
============================================================================ */

function evTriageAvailable() {
  // The triage API is a HiveLogic route authenticated with the HiveLogic
  // session. Embedded, this app shares that page's window, so the session is
  // right there. Standalone, it is not.
  return typeof window.hlRequireSession === 'function';
}

const EV_TRIAGE_LABELS = [
  { key: 'needs_reply', name: 'Needs a reply', icon: '📨' },
  { key: 'needs_scheduling', name: 'Needs a time', icon: '📅' },
  { key: 'needs_action', name: 'Needs action', icon: '⚡' },
  { key: 'fyi', name: 'FYI', icon: '👀' },
  { key: 'junk', name: 'Junk', icon: '🗑' },
];
function evTriageEffective(r) { return r.corrected_label || r.label; }

function evTriageApi(action, body) {
  return new Promise((resolve, reject) => {
    if (!evTriageAvailable()) { reject(new Error('Triage needs the HiveLogic app.')); return; }
    window.hlRequireSession(async (sess) => {
      try {
        const r = await fetch('/api/reina/mail-triage?action=' + action, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sess.access_token },
          body: JSON.stringify(body || {}),
        });
        const d = await r.json().catch(() => null);
        if (!r.ok || !d || !d.ok) throw new Error((d && d.error) || ('HTTP ' + r.status));
        resolve(d);
      } catch (e) { reject(e); }
    }, () => reject(new Error('Sign in to HiveLogic to use triage.')));
  });
}

function evDraftToHtml(text) {
  return String(text || '').split('\n')
    .map((line) => '<div>' + (esc(line) || '<br>') + '</div>')
    .join('');
}

function evPutDraftInComposer(text) {
  const bodyEl = $('ev-c-body');
  if (!bodyEl || !text) return false;
  bodyEl.innerHTML = evDraftToHtml(text) + bodyEl.innerHTML;
  return true;
}

function evTriageAccountFor(r) {
  return (evAccounts || []).find((a) => a.homeAccountId === r.home_account_id) || null;
}

async function evTriageFullMessage(r) {
  const acct = evTriageAccountFor(r);
  const cached = evMessages.find((m) => m.id === r.graph_id);
  let src = cached && cached.body && cached.body.content ? cached : null;
  if (!src) {
    src = await evGraph(
      '/me/messages/' + encodeURIComponent(r.graph_id) +
      '?$select=id,internetMessageId,subject,from,toRecipients,ccRecipients,receivedDateTime,body,bodyPreview,conversationId',
      acct ? { account: acct } : undefined
    );
  }
  // The IMAP adapter returns a body but no preview, and the composer quotes the
  // preview. Without this the "On <date>, <name> wrote:" block comes out empty.
  if (src && !src.bodyPreview && src.body && src.body.content) {
    src.bodyPreview = String(src.body.content).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
  }
  return { src, acct };
}

// Scheduling opens the calendar composer prefilled. It does not book anything:
// only he knows whether Thursday is actually free.
function evTriageSchedule(r) {
  setNavTab('calendar');
  setTimeout(() => openCalNew({
    title: r.subject || 'Follow-up',
    attendees: r.from_address || '',
    body: 'From ' + (r.from_name || r.from_address || 'email') + ': ' + (r.subject || ''),
  }), 200);
  evTriageActed(r, 'scheduled');
}

// A real HiveConnect task, owned by him, indistinguishable from one he typed.
async function evTriageTask(r, btn) {
  const was = btn.textContent;
  btn.disabled = true; btn.textContent = '…';
  try {
    const sess = await new Promise((res, rej) => window.hlRequireSession(res, () => rej(new Error('not signed in'))));
    const resp = await fetch('/api/hiveconnect-bridge?action=task_create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sess.access_token },
      body: JSON.stringify({
        title: r.subject || 'Follow up on an email',
        note: 'From ' + (r.from_name || r.from_address || 'email') +
              (r.reason ? ' — ' + r.reason : '') + (r.web_link ? '\n' + r.web_link : ''),
      }),
    });
    const d = await resp.json().catch(() => null);
    if (!resp.ok || !d || !d.ok) throw new Error((d && d.error) || ('HTTP ' + resp.status));
    await evTriageActed(r, 'tasked', 'Added to your tasks');
  } catch (e) {
    evToast('Couldn\'t add that task — ' + e.message);
  } finally { btn.disabled = false; btn.textContent = was; }
}

// The only action that moves mail. The mail app's own archive, on a message he
// tapped, and reversible from the Archive folder.
async function evTriageArchive(r, btn) {
  if (!r.graph_id) { evToast('That message is no longer reachable.'); return; }
  const was = btn ? btn.innerHTML : null;
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    // Against the row's OWN mailbox. Falling back to whichever account happened
    // to be selected is how you move a message in the wrong inbox.
    const acct = evTriageAccountFor(r);
    await evGraph('/me/messages/' + encodeURIComponent(r.graph_id) + '/move',
      { method: 'POST', body: { destinationId: 'archive' }, account: acct || undefined });
    evTriageFiled(r, 'Archived');
    await evTriageActed(r, 'archived', 'Archived');
  } catch (e) {
    // Naming the reason is the difference between "try again" and "tell Claude".
    evToast('Couldn\'t archive that — ' + e.message);
  } finally { if (btn) { btn.disabled = false; btn.innerHTML = was; } }
}

function evTriageIsImap(r) { return String(r.home_account_id || '').startsWith('imap:'); }

/* ---- the brief ----------------------------------------------------------- */

// Cache within the session, so clicking back and forth in a thread does not
// even make the round trip. The server stores it too; this just skips the wait.
const evBriefCache = new Map();

function evBriefRow(m, d, acct) {
  // The one-tap actions were written against a triage row. A message plus its
  // brief IS one, so build it rather than forking every action for the pane.
  const from = (m.from && m.from.emailAddress) || {};
  return {
    message_id: d.messageId,
    graph_id: m.id,
    home_account_id: (acct && acct.homeAccountId) || (evActive && evActive.homeAccountId) || '',
    subject: m.subject || '',
    from_name: from.name || '',
    from_address: from.address || '',
    reason: d.action || '',
    web_link: m.webLink || null,
    draft_text: d.draft || null,
    label: d.modelLabel || d.label || null,
    corrected_label: d.correctedLabel || null,
  };
}

// Record that a message has been dealt with. It drops out of the Team To-Do
// count; the message itself is untouched unless the action moved it.
async function evTriageActed(r, action, note, after) {
  try {
    await evTriageApi('act', { messageId: r.message_id, action });
    if (note) evToast(note);
    if (after) after();
  } catch (e) {
    evToast('Couldn\'t update that — ' + e.message);
  }
}

// Reply: hand Reina's draft to the mail app's OWN composer. He reads it, edits
// it, and presses the send button he already knows. Nothing is ever sent here.
async function evTriageDraft(r, btn) {
  const was = btn.textContent;
  btn.disabled = true; btn.textContent = '…';
  try {
    const { src, acct } = await evTriageFullMessage(r);
    if (acct) evActive = acct;
    openEmailCompose('reply', src);
    evPutDraftInComposer(r.draft_text);
    evToast('Read it before sending');
  } catch (e) {
    evToast('Couldn\'t open that — ' + e.message);
  } finally { btn.disabled = false; btn.textContent = was; }
}

/* A message that has been filed has to LEAVE.

   Chris, 2026-08-18: "move to junk didn't work / unsubscribe didnt work".

   They did work -- the Graph move went out and the mail moved. Nothing on
   screen changed, because these actions only refreshed the folder counts: the
   row stayed in the list, the message stayed open in the preview, and the
   panel still offered to file it again. From the outside that is exactly what a
   dead button looks like, and there is no way for him to tell the difference.

   The mail app's own evMove has always done this properly; the triage actions
   were written without it. So they do what it does -- drop the row, clear the
   pane, repaint -- and the brief cache forgets the message so a re-open cannot
   resurrect a stale panel for mail that is no longer there. */
function evTriageFiled(r, note) {
  if (r.graph_id) {
    evMessages = evMessages.filter((x) => x.id !== r.graph_id);
    if (evOpenId === r.graph_id) {
      evOpenId = null;
      const read = $('ev-read');
      if (read) read.innerHTML = '<div class="ev-read-empty">' + esc(note || 'Filed.') + '</div>';
    }
    renderMessageList();
  }
  if (r.message_id) evBriefCache.delete(r.message_id);
  refreshFolderCounts();
}

// Move it to Junk, not Archive.
//
// Chris, 2026-08-18: "for spam... can you have a way to auto-unsubscribe or just
// push to junk only?" Archive is a filing cabinet -- it hides the message and
// teaches nothing. Junk is the only folder that trains the provider's own
// filter, which is what stops the NEXT one arriving.
async function evTriageJunk(r, btn) {
  if (!r.graph_id) { evToast('That message is no longer reachable.'); return; }
  const was = btn ? btn.innerHTML : null;
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const acct = evTriageAccountFor(r);
    await evGraph('/me/messages/' + encodeURIComponent(r.graph_id) + '/move',
      { method: 'POST', body: { destinationId: 'junkemail' }, account: acct || undefined });
    evTriageFiled(r, 'Moved to Junk');
    await evTriageActed(r, 'archived', 'Moved to Junk — your mail provider will learn from it');
  } catch (e) {
    evToast('Couldn\'t move that — ' + e.message);
  } finally { if (btn) { btn.disabled = false; btn.innerHTML = was; } }
}

// Unsubscribe, on a button he pressed -- never on a timer and never in bulk.
//
// One-click only happens where the sender sent List-Unsubscribe-Post, which is
// their promise to honour a single POST. Anything else opens THEIR page and
// lets him decide, because on actual spam a click is a signal that the address
// is live and read.
async function evUnsubscribe(r, d, btn) {
  const u = d.unsubscribe || {};
  if (u.oneClick) {
    const was = btn.innerHTML;
    btn.disabled = true; btn.textContent = '…';
    try {
      const res = await evTriageApi('unsubscribe', { messageId: r.message_id });
      evToast('Unsubscribed from ' + (res.unsubscribedFrom || 'that sender'));
      // Off the list AND out of the inbox: unsubscribing does not remove the
      // one already sitting there.
      await evTriageJunk(r, null);
    } catch (e) {
      evToast('Couldn\'t unsubscribe — ' + e.message);
    } finally { btn.disabled = false; btn.innerHTML = was; }
    return;
  }
  if (u.web) { window.open(u.web, '_blank', 'noopener'); evToast('Opened their unsubscribe page'); return; }
  if (u.mailto) {
    openEmailCompose('new');
    evSetChips('ev-c-to', [u.mailto]);
    const subj = $('ev-c-subj'); if (subj) subj.value = 'unsubscribe';
    evToast('They only take unsubscribes by email — send this');
    return;
  }
  evToast('No unsubscribe link in that one — move it to Junk instead');
}

/* "Write it a different way."

   Five directions plus a free-text one. Each carries the draft it is replacing,
   so "shorter" means shorter than the one he is looking at rather than shorter
   than nothing -- and asking twice in a row cannot hand back the same words.

   Uses the mail app's own dropdown, so it behaves like every other menu in the
   reading pane. */
const EV_REWRITE_WAYS = [
  ['Try another way', ''],
  ['Shorter', 'Make it noticeably shorter. Cut anything that is not load-bearing.'],
  ['Warmer', 'Make it warmer and more personal, without getting chatty or padded.'],
  ['Firmer', 'Hold the line politely but firmly -- on scope, price or timeline. No apology for the position.'],
  ['More detail', 'Add the specifics this needs: the numbers, dates and next step. Still plain, still his voice.'],
];

function evRewriteMenu(btn, r, d, host, m, acct) {
  const items = EV_REWRITE_WAYS.map(([label, instruction]) =>
    [label, () => evRewriteDraft(r, d, host, m, acct, instruction)]);
  items.push('---');
  items.push(['Say what to change…', () => {
    const how = window.prompt('How should Reina change it?');
    if (how && how.trim()) evRewriteDraft(r, d, host, m, acct, how.trim());
  }]);
  // evMenu positions itself off the button it was opened from and expects an
  // event; the button is all it actually reads.
  evMenu({ stopPropagation() {}, target: btn }, items);
}

async function evRewriteDraft(r, d, host, m, acct, instruction) {
  const box = host.querySelector('.ev-rb-draft-body');
  const was = d.draft;
  if (box) { box.classList.add('ev-rb-rewriting'); box.textContent = 'Reina is rewriting it…'; }
  try {
    const payload = { messageId: r.message_id, instruction, previous: was };
    // The server cannot open an IMAP mailbox, so the browser couriers the body.
    if (evTriageIsImap(r)) {
      const { src } = await evTriageFullMessage(r);
      payload.bodyText = (src && src.body && src.body.content) || (src && src.bodyPreview) || '';
    }
    const res = await evTriageApi('draft', payload);
    d.draft = res.draft;
    d.hasBlanks = !!res.hasBlanks;
    evRenderBrief(host, m, d, acct);
  } catch (e) {
    // Put his draft back rather than leaving him staring at a spinner that lost it.
    d.draft = was;
    evRenderBrief(host, m, d, acct);
    evToast('Couldn\'t rewrite that — ' + e.message);
  }
}

// Reina's read of the open message, rendered above the message itself.
async function evReinaBrief(m, host) {
  if (!host) return;
  const acct = (evAccounts || []).find((a) => a.homeAccountId === (m._acct || (evActive && evActive.homeAccountId))) || evActive || null;
  const isImap = !!(acct && acct.provider === 'imap');
  const from = (m.from && m.from.emailAddress) || {};
  // The RFC822 Message-ID is what the triage table keys on, and for an IMAP
  // message the adapter returns it as conversationId. Falling back to the Graph
  // id keeps a message briefable even when the header is missing.
  const messageId = (isImap ? (m.conversationId || m.id) : (m.internetMessageId || m.conversationId || m.id));

  const cached = evBriefCache.get(messageId);
  if (cached) { evRenderBrief(host, m, cached, acct); return; }

  host.innerHTML = '<div class="ev-rb-load"><span class="ev-rb-star">✦</span> Reina is reading it…</div>';
  try {
    const payload = {
      messageId,
      graphId: m.id,
      homeAccountId: isImap ? String(acct.homeAccountId) : ((acct && acct.homeAccountId) || ''),
      subject: m.subject || '',
      fromAddress: from.address || '',
      fromName: from.name || '',
      receivedAt: m.receivedDateTime || null,
      webLink: m.webLink || null,
    };
    // The server cannot open an IMAP mailbox, so the browser couriers the body
    // it already has. A Microsoft message it fetches itself.
    if (isImap) {
      payload.bodyText = (m.body && m.body.content) || m.bodyPreview || '';
      // List-Unsubscribe lives in the headers, and the server cannot open this
      // mailbox to read them itself.
      payload.headers = m.internetMessageHeaders || [];
    }
    const d = await evTriageApi('brief', payload);
    evBriefCache.set(messageId, d);
    // He may have clicked on to another message while this was in flight.
    if (evOpenId !== m.id) return;
    evRenderBrief(host, m, d, acct);
  } catch (e) {
    // Never silently absent: a missing panel is indistinguishable from an email
    // Reina had nothing to say about.
    host.innerHTML = '<div class="ev-rb-err"><span class="ev-rb-star">✦</span> Reina couldn\'t read this one — ' + esc(e.message) + '</div>';
  }
}

function evRenderBrief(host, m, d, acct) {
  host.innerHTML = '';
  const label = EV_TRIAGE_LABELS.find((L) => L.key === d.label) || null;
  const r = evBriefRow(m, d, acct);

  // ---- header: who is talking, and what she made of it ----------------------
  const head = document.createElement('div'); head.className = 'ev-rb-head';
  const who = document.createElement('span'); who.className = 'ev-rb-who';
  who.innerHTML = '<span class="ev-rb-star">✦</span> Reina';
  head.appendChild(who);
  // ONE control, not a chip and a dropdown saying the same word an inch apart.
  // The verdict IS the thing you change, so it is rendered as what it is: a
  // label you can disagree with.
  //
  // A bare <select> sizes itself to its WIDEST option, so "FYI" rendered as a
  // pill with an inch of dead space after it. So the chip is a span that sizes
  // to its own text, with the select laid transparently over it: real native
  // dropdown behaviour, honest width.
  const verdict = document.createElement('span');
  verdict.className = 'ev-rb-verdict' + (label ? ' ev-rb-' + label.key : '');
  const vtext = document.createElement('span');
  vtext.textContent = label ? label.name : 'Unsorted';
  verdict.appendChild(vtext);
  const caret = document.createElement('span'); caret.className = 'ev-rb-caret'; caret.textContent = '⌄';
  verdict.appendChild(caret);

  const sel = document.createElement('select');
  sel.className = 'ev-rb-pick';
  sel.title = 'What Reina made of it — change it and she learns the sender';
  EV_TRIAGE_LABELS.forEach((o) => {
    const opt = document.createElement('option');
    opt.value = o.key; opt.textContent = o.name;
    if (o.key === d.label) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.onchange = async () => {
    const prev = d.label;
    const picked = sel.value;
    sel.disabled = true;
    try {
      const res = await evTriageApi('correct', { messageId: r.message_id, label: picked });
      d.label = picked; d.correctedLabel = picked;
      evNoteJunk([{ graph_id: r.graph_id, corrected_label: picked }]);
      renderMessageList();
      // A correction to junk is a correction about the SENDER, so the reply she
      // wrote for it is no longer a thing he should be one tap from sending.
      if (picked === 'junk' || picked === 'fyi') d.draft = null;
      evToast(res.learnedFrom ? (res.learnedFrom + ' will be ' + picked.replace(/_/g, ' ') + ' from now on') : 'Label updated');
      evRenderBrief(host, m, d, acct);
    } catch (e) {
      sel.value = prev;
      evToast('Couldn\'t save that — ' + e.message);
    } finally { sel.disabled = false; }
  };
  verdict.appendChild(sel);
  head.appendChild(verdict);
  host.appendChild(head);

  // ---- what it says ---------------------------------------------------------
  if (d.summary) {
    const sum = document.createElement('div'); sum.className = 'ev-rb-summary'; sum.textContent = d.summary;
    host.appendChild(sum);
  }

  // ---- what to do about it --------------------------------------------------
  if (d.action) {
    const act = document.createElement('div'); act.className = 'ev-rb-action';
    const dot = document.createElement('span'); dot.className = 'ev-rb-bullet'; dot.textContent = '→';
    act.appendChild(dot);
    const txt = document.createElement('span'); txt.className = 'ev-rb-action-txt'; txt.textContent = d.action;
    act.appendChild(txt);
    host.appendChild(act);
  }

  // ---- the reply she already wrote ------------------------------------------
  // Shown in full rather than hidden behind a tap: the point of writing it in
  // advance is that reviewing it costs nothing.
  if (d.draft) {
    const box = document.createElement('div'); box.className = 'ev-rb-draft';
    const lbl = document.createElement('div'); lbl.className = 'ev-rb-draft-lbl';
    lbl.textContent = 'Suggested reply';
    const hint = document.createElement('span'); hint.className = 'ev-rb-draft-hint';
    hint.textContent = 'click to edit';
    lbl.appendChild(hint);
    box.appendChild(lbl);

    // Chris, 2026-08-18: "the suggested response needs a way to edit it or
    // change it to create a different anwser."
    //
    // Editable in place. A draft you can only accept or discard is a worse tool
    // than a blank composer -- the whole value is that it is 90% right and the
    // last 10% is his. What he leaves here is what "Use this reply" sends over,
    // and it is written back so a folder change does not eat the edit.
    const body = document.createElement('div');
    body.className = 'ev-rb-draft-body';
    body.contentEditable = 'true';
    body.spellcheck = true;
    body.textContent = d.draft;
    body.onblur = () => {
      const text = body.innerText.replace(/\u00a0/g, ' ').trimEnd();
      if (text === d.draft) return;
      d.draft = text;
      evTriageApi('draft_save', { messageId: r.message_id, draft: text })
        .catch((e) => evToast('Couldn\'t save that edit — ' + e.message));
    };
    box.appendChild(body);
    // A blank she could not fill is the one thing that must not slip past
    // unnoticed into a sent email.
    if (d.hasBlanks) {
      const warn = document.createElement('div'); warn.className = 'ev-rb-warn';
      warn.textContent = '⚠ Fill in the blanks before sending';
      box.appendChild(warn);
    }
    host.appendChild(box);
  }

  // ---- the buttons ----------------------------------------------------------
  // Line icons in the mail app's own idiom, not a row of emoji: this panel sits
  // directly under that toolbar and two icon languages an inch apart is what
  // made it look bolted on.
  const acts = document.createElement('div'); acts.className = 'ev-rb-acts';
  const act = (icon, text, title, fn, kind) => {
    const b = document.createElement('button');
    b.className = 'ev-rb-btn' + (kind ? ' ' + kind : '');
    b.innerHTML = icon + '<span>' + esc(text) + '</span>';
    b.title = title;
    b.onclick = () => fn(b);
    acts.appendChild(b);
    return b;
  };
  if (d.draft) {
    act(EV_RB_ICON.reply, 'Use this reply', 'Opens it in the composer — nothing is sent',
      (b) => evTriageDraft(Object.assign({}, r, { draft_text: d.draft }), b), 'primary');
    // ...or have her write a different one. Each of these carries the draft it
    // is replacing, so "shorter" means shorter than the one he is looking at.
    act(EV_RB_ICON.redo, 'Rewrite', 'Have Reina write it a different way',
      (b) => evRewriteMenu(b, r, d, host, m, acct));
  }
  if (d.label === 'needs_scheduling') act(EV_RB_ICON.calendar, 'Calendar', 'Opens the calendar composer — it books nothing', () => evTriageSchedule(r));
  if (d.label !== 'junk') act(EV_RB_ICON.task, 'Add to tasks', 'Creates a HiveConnect task owned by you', (b) => evTriageTask(r, b));

  // Junk gets its own pair. (Chris, 2026-08-18: "for spam... can you have a way
  // to auto-unsubscribe or just push to junk only?")
  if (d.label === 'junk') {
    if (d.unsubscribe && d.unsubscribe.oneClick) {
      act(EV_RB_ICON.unsub, 'Unsubscribe', 'One-click unsubscribe, then move it to Junk', (b) => evUnsubscribe(r, d, b), 'primary');
    } else if (d.unsubscribe && (d.unsubscribe.web || d.unsubscribe.mailto)) {
      act(EV_RB_ICON.unsub, 'Unsubscribe', 'Opens their unsubscribe page — they do not support one-click', (b) => evUnsubscribe(r, d, b));
    }
    // Junk, not Archive. Archive is a filing cabinet; Junk is the only one that
    // teaches the mail provider's own filter, so the next one never arrives.
    act(EV_RB_ICON.junk, 'Move to Junk', 'Trains your mail provider, so the next one is filtered', (b) => evTriageJunk(r, b));
  } else if (!evTriageIsImap(r)) {
    act(EV_RB_ICON.archive, 'Archive', 'Moves it to Archive — reversible', (b) => evTriageArchive(r, b));
  }
  // Handled leaves the mail exactly where it is -- it only clears the to-do --
  // so the panel has to be the thing that changes, or this button looks dead too.
  if (d.handled) {
    const done = document.createElement('span'); done.className = 'ev-rb-handled';
    done.textContent = 'Handled — off your Team To-Do';
    acts.appendChild(done);
  } else {
    act(EV_RB_ICON.done, 'Handled', 'Takes it off your Team To-Do — the email stays put',
      () => evTriageActed(r, 'dismissed', 'Cleared', () => { d.handled = true; evRenderBrief(host, m, d, acct); }));
  }
  host.appendChild(acts);
}

// The reading-pane toolbar's own icon idiom: 1.7px stroke, currentColor, 24-box.
const EV_RB_SVG = (d) => '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
const EV_RB_ICON = {
  reply: EV_RB_SVG('<path d="M9 15L4 10l5-5"/><path d="M4 10h11a5 5 0 0 1 5 5v3"/>'),
  calendar: EV_RB_SVG('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'),
  task: EV_RB_SVG('<path d="M4 12l5 5L20 6"/>'),
  archive: EV_RB_SVG('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/>'),
  junk: EV_RB_SVG('<path d="M12 3l9 16H3l9-16z"/><path d="M12 9v5M12 17h.01"/>'),
  unsub: EV_RB_SVG('<path d="M3 6h18v12H3z"/><path d="M3 7l9 6 9-6"/><path d="M2 2l20 20"/>'),
  done: EV_RB_SVG('<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>'),
  redo: EV_RB_SVG('<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 4v6h-6"/>'),
};

// Styling lives here rather than in styles-scoped.css for the same reason the
// toolbar's does: this panel only ever exists inside #ev-read, and shipping it
// with the code that builds it keeps the two from drifting apart.
function evEnsureBriefCss() {
  if (document.getElementById('ev-brief-css')) return;
  const st = document.createElement('style'); st.id = 'ev-brief-css';
  st.textContent = [
    /* THE CARD.

       #ev-read is a COLUMN FLEXBOX. Two things follow, and both of them bit:

       * a flex item shrinks by default, so on a narrower window this panel was
         squeezed shorter than its own content and the buttons overlapped the
         text. `flex: none` is not decoration -- it is the fix. (Chris,
         2026-08-18, with a screenshot of exactly that.)
       * a flex item has no horizontal inset unless you give it one, so it ran
         edge to edge. The gutter matches .ev-read-head's 22px so the card lines
         up with the subject above it rather than floating loose.

       And it is TINTED. White on white with a hairline is not a card, it is a
       horizontal rule with opinions -- there was nothing to tell his eye that
       this was Reina talking rather than more email. */
    '.ev-reina-brief{flex:none;margin:14px 22px 18px;padding:18px 20px 16px;border:1px solid var(--line);border-radius:14px;background:linear-gradient(180deg,var(--steel-bg),var(--card));box-shadow:0 1px 2px rgba(16,24,40,.04),0 8px 24px -14px rgba(16,24,40,.18)}',
    '.ev-reina-brief:empty{display:none}',

    '.ev-rb-head{display:flex;align-items:center;gap:10px;margin-bottom:12px}',
    '.ev-rb-who{display:inline-flex;align-items:center;gap:6px;font:800 10px var(--sans);letter-spacing:.16em;text-transform:uppercase;color:var(--steel-deep)}',
    '.ev-rb-star{font-size:11px}',

    // The verdict chip: a span that sizes to its own text, with the real
    // <select> laid transparently over it so the dropdown is still native.
    '.ev-rb-verdict{position:relative;display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border-radius:999px;background:var(--steel-bg);color:var(--slate);font:700 11px var(--sans);cursor:pointer;transition:filter .12s}',
    '.ev-rb-verdict:hover{filter:brightness(.95)}',
    '.ev-rb-caret{font-size:10px;opacity:.55;line-height:1}',
    '.ev-rb-pick{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;appearance:none;-webkit-appearance:none;border:0;background:transparent}',
    '.ev-rb-needs_reply{background:#e3edfb;color:#17529f}',
    '.ev-rb-needs_scheduling{background:#fcefd8;color:#7d5100}',
    '.ev-rb-needs_action{background:#fbe4e4;color:#8a2f2f}',
    '.ev-rb-junk{background:#ececed;color:#63636b}',
    '.ev-rb-fyi{background:#e9edf3;color:#4c5768}',

    // Prose wants a measure. At 1000px a summary reads like a log line.
    '.ev-rb-summary{font:400 14.5px/1.65 var(--sans);color:var(--ink);max-width:68ch}',

    // The action is the point of the card, so it gets the weight and its own
    // band -- not one more sentence in the same paragraph.
    '.ev-rb-action{display:flex;gap:10px;margin:14px -20px -2px;padding:13px 20px 0;border-top:1px solid var(--line)}',
    '.ev-rb-bullet{color:var(--steel-deep);font-weight:800;flex:0 0 auto;line-height:1.5}',
    '.ev-rb-action-txt{font:700 14.5px/1.5 var(--sans);color:var(--ink);max-width:68ch}',

    '.ev-rb-draft{margin-top:14px;padding:13px 15px;border-radius:10px;background:var(--card);border:1px solid var(--line);border-left:3px solid var(--steel-deep)}',
    '.ev-rb-draft-lbl{display:flex;align-items:baseline;gap:8px;font:800 9.5px var(--sans);letter-spacing:.13em;text-transform:uppercase;color:var(--slate);opacity:.7;margin-bottom:7px}',
    '.ev-rb-draft-hint{font-weight:600;letter-spacing:.02em;text-transform:none;opacity:.7}',
    // Editable in place. It has to LOOK editable without shouting -- a field
    // border here would turn a suggestion into a form.
    '.ev-rb-draft-body{font:400 14px/1.65 var(--sans);color:var(--ink);white-space:pre-wrap;max-width:68ch;outline:0;border-radius:6px;margin:-3px -5px;padding:3px 5px;transition:background .12s,box-shadow .12s}',
    '.ev-rb-draft-body:hover{background:rgba(16,24,40,.03)}',
    '.ev-rb-draft-body:focus{background:var(--card);box-shadow:0 0 0 2px var(--steel-deep)}',
    '.ev-rb-rewriting{opacity:.55;font-style:italic}',
    '.ev-rb-warn{margin-top:9px;font:700 11.5px var(--sans);color:#a13d1d}',

    // Buttons in the toolbar's own language: line icons, one filled primary,
    // the rest quiet. Emoji an inch below a row of stroked SVGs is what made
    // this look bolted on.
    '.ev-rb-acts{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:16px}',
    '.ev-rb-btn{display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 14px;border:1px solid var(--line);background:var(--card);color:var(--slate);border-radius:9px;cursor:pointer;font:600 13px var(--sans);transition:background .12s,color .12s,border-color .12s,box-shadow .12s}',
    '.ev-rb-btn:hover{background:var(--steel-bg);color:var(--steel-deep);border-color:var(--steel-deep)}',
    '.ev-rb-btn.primary{background:var(--steel-deep);border-color:var(--steel-deep);color:#fff;box-shadow:0 1px 2px rgba(16,24,40,.12)}',
    '.ev-rb-btn.primary:hover{filter:brightness(1.08);color:#fff}',
    '.ev-rb-btn:disabled{opacity:.45;cursor:default}',
    '.ev-rb-btn svg{flex:0 0 auto;opacity:.85}',
    '.ev-rb-handled{display:inline-flex;align-items:center;gap:6px;font:700 12.5px var(--sans);color:var(--slate);opacity:.75}',

    '.ev-rb-load,.ev-rb-err{display:flex;align-items:center;gap:9px;font:600 13px var(--sans);color:var(--slate)}',
    '.ev-rb-load .ev-rb-star{animation:ev-rb-pulse 1.1s ease-in-out infinite}',
    '@keyframes ev-rb-pulse{0%,100%{opacity:.3}50%{opacity:1}}',

    // The reading pane around it, so the card is not the only considered thing
    // on the screen.
    '#ev-read .ev-read-head{padding:22px 22px 14px}',
    '#ev-read .ev-read-subj{font-size:20px;line-height:1.3;letter-spacing:-.011em;margin-bottom:10px}',
    '#ev-read .ev-read-actions{margin-top:14px;gap:2px}',

    '@media (max-width:760px){.ev-reina-brief{margin:12px 14px 14px;padding:14px 15px}.ev-rb-action{margin-left:-15px;margin-right:-15px;padding-left:15px;padding-right:15px}.ev-rb-btn{flex:1 1 auto;justify-content:center}}',
  ].join('');
  document.head.appendChild(st);
}

/* ---- reading ahead ------------------------------------------------------- */
//
// Chris, 2026-08-18: "it was slow to populate".
//
// It was: opening a message started a full-body read, and he watched it happen.
// The fix is not a faster model, it is not doing the work while he waits. The
// list is already on screen and he is going to click something in it, so the
// top of it gets read in the background and the click finds the answer already
// written.
//
// Bounded and polite. One at a time so it never competes with the message he
// actually opened; only the newest few, because reading fifty emails he will
// never click is spending his money to make nothing faster; and it stops the
// moment the list changes underneath it.
const EV_BRIEF_PREFETCH = 6;
let evPrefetchToken = 0;

async function evPrefetchBriefs() {
  if (!evTriageAvailable()) return;
  const mine = ++evPrefetchToken;
  const batch = (evMessages || []).slice(0, EV_BRIEF_PREFETCH);
  for (const m of batch) {
    if (mine !== evPrefetchToken) return;          // a new folder/list won
    const isImap = String(m._acct || '').startsWith('imap:') ||
                   !!((evActive || {}).provider === 'imap' && !m._acct);
    const key = isImap ? (m.conversationId || m.id) : (m.internetMessageId || m.conversationId || m.id);
    if (!key || evBriefCache.has(key)) continue;
    try {
      // A list row has no body, so the full message has to be fetched first --
      // which is most of why the click felt slow, and all of it now happens early.
      const acct = (evAccounts || []).find((a) => a.homeAccountId === m._acct) || evActive || null;
      const full = await evGraph(
        '/me/messages/' + encodeURIComponent(m.id) +
        '?$select=id,internetMessageId,subject,from,receivedDateTime,body,bodyPreview,conversationId',
        acct ? { account: acct } : undefined
      );
      if (mine !== evPrefetchToken) return;
      const from = (full.from && full.from.emailAddress) || {};
      const payload = {
        messageId: key,
        graphId: full.id || m.id,
        homeAccountId: (acct && acct.homeAccountId) || '',
        subject: full.subject || '',
        fromAddress: from.address || '',
        fromName: from.name || '',
        receivedAt: full.receivedDateTime || null,
      };
      if (acct && acct.provider === 'imap') {
        payload.bodyText = (full.body && full.body.content) || full.bodyPreview || '';
        payload.headers = full.internetMessageHeaders || [];
      }
      const d = await evTriageApi('brief', payload);
      evBriefCache.set(key, d);
      // If he opened this very message while it was in flight, paint it now
      // rather than leaving him on the loading line.
      if (evOpenId === m.id) {
        const host = document.querySelector('#ev-read .ev-reina-brief');
        if (host && host.querySelector('.ev-rb-load')) evRenderBrief(host, full, d, acct);
      }
    } catch (e) { /* one message failing must not stop the rest */ }
  }
}

/* ---- the background pass ------------------------------------------------- */
//
// Invisible, and load-bearing: it is what puts "Emails Reina flagged · 2 to
// answer" on his Team To-Do. With the ⚡ Reina pill gone, nothing else would
// ever label a message he has not personally opened.
//
// Costs exactly what it cost before -- a verdict is written once per message
// and never re-derived, so the second pass over a day's mail is nearly free.
// Deliberately NOT on a timer: he asked what a 30-minute poll would cost and
// has not said to build one.
const EV_TRIAGE_SCAN_MIN_GAP_MS = 5 * 60 * 1000;
let evTriageScanAt = 0;
let evTriageScanning = false;

async function evTriageBackgroundScan() {
  if (!evTriageAvailable()) return;
  if (evTriageScanning || (Date.now() - evTriageScanAt) < EV_TRIAGE_SCAN_MIN_GAP_MS) return;
  evTriageScanning = true;
  evTriageScanAt = Date.now();
  try {
    const d = await evTriageApi('list').catch(() => null);   // the Microsoft mailboxes
    if (d && d.rows) { evNoteJunk(d.rows); renderMessageList(); }
    await evTriageScanImap().catch(() => null);              // and the one it cannot open
  } finally { evTriageScanning = false; }
}

// greenwichhandyman@gmail.com is Gmail over IMAP: its credentials live in the
// other project and only /api/mail can open it. The browser already reads that
// inbox, so it hands the envelopes to Reina for judging rather than teaching the
// server a second mail client with a second thing to break.
async function evTriageScanImap() {
  const imapAccounts = (evAccounts || []).filter((a) => String(a.homeAccountId || '').startsWith('imap:'));
  for (const a of imapAccounts) {
    try {
      const j = await evGraph('/me/mailFolders/inbox/messages?$top=50', { account: a });
      const messages = (j.value || []).map((m) => ({
        messageId: m.conversationId || m.id,   // the RFC822 Message-ID, per the adapter
        graphId: m.id,
        subject: m.subject || '',
        fromAddress: (m.from && m.from.emailAddress && m.from.emailAddress.address) || '',
        fromName: (m.from && m.from.emailAddress && m.from.emailAddress.name) || '',
        receivedAt: m.receivedDateTime || null,
        preview: m.bodyPreview || '',
        isRead: m.isRead === true,
      })).filter((m) => m.messageId);
      if (!messages.length) continue;
      const d = await evTriageApi('classify', { account: String(a.homeAccountId).replace(/^imap:/, ''), messages });
      if (d && d.rows) { evNoteJunk(d.rows); renderMessageList(); }
    } catch (e) { /* one mailbox failing must not take the others down */ }
  }
}

function evFmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const yr = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString([], yr ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: '2-digit' });
}
/* Junk, silenced.

   Chris, 2026-08-18: "I also want reina to silence junk and only show real
   emails that need attention."

   Hidden, not deleted and not moved. Reina is wrong sometimes, and the cost of
   being wrong has to stay recoverable: the count and the "show" link mean a
   real email she mislabelled is one click away, not gone. Move to Junk is still
   there for when he agrees with her.

   Only messages she has actually judged are hidden -- anything unlabelled shows
   as normal, because "not yet read by Reina" is not the same as "junk". */
let evHideJunk = true;
const evJunkIds = new Set();     // graph ids she called junk, filled by the scans

function evNoteJunk(rows) {
  (rows || []).forEach((r) => {
    const label = r.corrected_label || r.label;
    if (label === 'junk' && r.graph_id) evJunkIds.add(r.graph_id);
    else if (r.graph_id) evJunkIds.delete(r.graph_id);   // a correction un-hides it
  });
}

function evVisibleMessages() {
  if (!evHideJunk) return evMessages;
  return evMessages.filter((m) => !evJunkIds.has(m.id));
}

// Focused/Other is a pure render-time filter over already-fetched messages --
// it must never touch the Graph query in selectFolder (2026-08-17 lesson: a
// stuck server-side filter left the Inbox unable to show its own mail).
function evMsgIsOther(m) { return (m.inferenceClassification || 'focused') === 'other'; }
function evFilterFocused(rows) {
  return evFocusedTab === 'other' ? rows.filter(evMsgIsOther) : rows.filter(m => !evMsgIsOther(m));
}
function evSenderLabel(m) { const f = (m.from && m.from.emailAddress) || {}; return f.name || f.address || ''; }
function evSortRows(rows) {
  const dir = evSortDir === 'asc' ? 1 : -1;
  const arr = rows.slice();
  if (evSortBy === 'from') arr.sort((a, b) => dir * evSenderLabel(a).localeCompare(evSenderLabel(b)));
  else if (evSortBy === 'subject') arr.sort((a, b) => dir * (a.subject || '').localeCompare(b.subject || ''));
  else arr.sort((a, b) => dir * (new Date(a.receivedDateTime || 0) - new Date(b.receivedDateTime || 0)));
  return arr;
}
function evAvatarClass(m) {
  if (evAllInboxes && m._acct) return 'acct-' + (Math.max(0, evAccounts.findIndex(x => x.homeAccountId === m._acct)) % 4);
  const addr = (m.from && m.from.emailAddress && (m.from.emailAddress.address || m.from.emailAddress.name)) || '';
  let h = 0; for (let i = 0; i < addr.length; i++) h = (h * 31 + addr.charCodeAt(i)) >>> 0;
  return 'acct-' + (h % 4);
}
function evInitials(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
function evToggleSelect(id, checked) {
  if (checked) evSelected.add(id); else evSelected.delete(id);
  const row = document.querySelector('.ev-item[data-id="' + CSS.escape(id) + '"]');
  if (row) row.classList.toggle('selected', checked);
  evUpdateCmdbarState();
  const listEl = $('ev-list'); if (listEl) listEl.classList.toggle('has-selection', evSelected.size > 0);
  const selAll = $('ev-select-all');
  if (selAll) { const ids = [...document.querySelectorAll('.ev-item')].map(r => r.dataset.id); const selCount = ids.filter(x => evSelected.has(x)).length; selAll.checked = ids.length > 0 && selCount === ids.length; selAll.indeterminate = selCount > 0 && selCount < ids.length; }
}
function evUpdateCmdbarState() {
  const hasSel = evSelected.size > 0, hasOpen = !!evOpenId, active = hasSel || hasOpen;
  ['ev-cmd-delete', 'ev-cmd-archive', 'ev-cmd-report', 'ev-cmd-move', 'ev-cmd-flag'].forEach(id => { const b = $(id); if (b) b.disabled = !active; });
  const canReply = hasOpen && !hasSel; // reply/forward/categorize/print/etc. only make sense against one open message
  const replyBtn = $('ev-cmd-reply'); if (replyBtn) replyBtn.disabled = !canReply;
  const replyCaret = $('ev-cmd-reply-caret'); if (replyCaret) replyCaret.disabled = !canReply;
  const moreBtn = $('ev-cmd-more'); if (moreBtn) moreBtn.disabled = !canReply;
  const undoBtn = $('ev-cmd-undo'); if (undoBtn) undoBtn.disabled = !evLastUndo;
}
function evUpdateListHeadUI(shownRows, counts) {
  counts = counts || { focusedCount: 0, otherCount: 0 };
  const otherBadge = $('ev-fo-other-count');
  if (otherBadge) { if (counts.otherCount > 0) { otherBadge.textContent = String(counts.otherCount); otherBadge.classList.remove('hidden'); } else otherBadge.classList.add('hidden'); }
  const tabFocused = $('ev-tab-focused'), tabOther = $('ev-tab-other');
  if (tabFocused) tabFocused.classList.toggle('active', evFocusedTab === 'focused');
  if (tabOther) tabOther.classList.toggle('active', evFocusedTab === 'other');
  const ids = (shownRows || []).map(m => m.id);
  const selCount = ids.filter(id => evSelected.has(id)).length;
  const selAll = $('ev-select-all');
  if (selAll) { selAll.checked = ids.length > 0 && selCount === ids.length; selAll.indeterminate = selCount > 0 && selCount < ids.length; }
  const sortLabels = { date: 'Received', from: 'Sender', subject: 'Subject' };
  const sortBtn = $('ev-sort-btn'); if (sortBtn) sortBtn.textContent = (sortLabels[evSortBy] || 'Received') + (evSortDir === 'asc' ? ' ↑' : ' ↓');
  const listEl = $('ev-list'); if (listEl) listEl.classList.toggle('has-selection', evSelected.size > 0);
  evUpdateCmdbarState();
}
function renderMessageList() {
  const list = $('ev-list'); if (!list) return; list.innerHTML = '';
  if (!evMessages.length) { list.innerHTML = '<div class="ev-loading">No messages here.</div>'; evUpdateListHeadUI([], null); return; }
  const junkVisible = evVisibleMessages();
  const hidden = evMessages.length - junkVisible.length;
  // conversation grouping: one row per thread (latest message), with a count --
  // computed over junkVisible so a junk-hidden message can never surface as a
  // thread's representative row (it used to iterate evMessages unfiltered).
  let rows = junkVisible;
  const threadCount = {};
  if (evGroup) {
    const seen = new Set(); const grouped = [];
    junkVisible.forEach(m => { const c = m.conversationId || m.id; threadCount[c] = (threadCount[c] || 0) + 1; });
    junkVisible.forEach(m => { const c = m.conversationId || m.id; if (seen.has(c)) return; seen.add(c); grouped.push(m); });
    rows = grouped;
  }
  const otherCount = rows.filter(evMsgIsOther).length;
  const shown = evSortRows(evFilterFocused(rows));
  evUpdateListHeadUI(shown, { focusedCount: rows.length - otherCount, otherCount });
  if (hidden > 0) {
    // Said out loud, with the way back. Silently swallowing mail is how a
    // filter stops being trusted the first time it is wrong.
    const note = document.createElement('div');
    note.className = 'ev-loading';
    note.style.cssText = 'padding:8px 12px;font-size:11px;display:flex;gap:8px;align-items:center';
    note.appendChild(document.createTextNode(hidden + ' hidden as junk'));
    const btn = document.createElement('button');
    btn.textContent = 'show';
    btn.style.cssText = 'background:none;border:0;padding:0;color:var(--steel-deep);font:600 11px var(--sans);cursor:pointer;text-decoration:underline';
    btn.onclick = () => { evHideJunk = false; renderMessageList(); };
    note.appendChild(btn);
    list.appendChild(note);
  } else if (!evHideJunk && evJunkIds.size) {
    const note = document.createElement('div');
    note.className = 'ev-loading';
    note.style.cssText = 'padding:8px 12px;font-size:11px;display:flex;gap:8px;align-items:center';
    note.appendChild(document.createTextNode('showing junk'));
    const btn = document.createElement('button');
    btn.textContent = 'hide it again';
    btn.style.cssText = 'background:none;border:0;padding:0;color:var(--steel-deep);font:600 11px var(--sans);cursor:pointer;text-decoration:underline';
    btn.onclick = () => { evHideJunk = true; renderMessageList(); };
    note.appendChild(btn);
    list.appendChild(note);
  }

  if (!shown.length && rows.length) {
    const empty = document.createElement('div'); empty.className = 'ev-loading';
    empty.textContent = evFocusedTab === 'other' ? 'Nothing in Other.' : 'Nothing in Focused — check Other.';
    list.appendChild(empty);
  }

  shown.forEach(m => {
    const from = (m.from && m.from.emailAddress) ? (m.from.emailAddress.name || m.from.emailAddress.address) : '(no sender)';
    const flagged = !!(m.flag && m.flag.flagStatus === 'flagged');
    const row = document.createElement('div'); row.className = 'ev-item' + (m.isRead ? '' : ' unread') + (m.id === evOpenId ? ' open' : '') + (evSelected.has(m.id) ? ' selected' : '');
    row.dataset.id = m.id;
    row.draggable = true;
    row.ondragstart = (e) => { e.dataTransfer.setData('text/hc-msg-id', m.id); e.dataTransfer.effectAllowed = 'move'; };
    row.oncontextmenu = (e) => { e.preventDefault(); evCtxMenu(e, m); };
    const l = document.createElement('div'); l.className = 'ev-item-l';
    const chk = document.createElement('input'); chk.type = 'checkbox'; chk.className = 'ev-item-check'; chk.checked = evSelected.has(m.id);
    chk.onclick = (e) => e.stopPropagation();
    chk.onchange = () => evToggleSelect(m.id, chk.checked);
    l.appendChild(chk);
    if (!m.isRead) { const d = document.createElement('span'); d.className = 'ev-item-dot'; l.appendChild(d); }
    const star = document.createElement('button'); star.type = 'button'; star.className = 'ev-item-star' + (flagged ? ' on' : ''); star.title = flagged ? 'Unflag' : 'Flag'; star.textContent = flagged ? '★' : '☆';
    star.onclick = (e) => { e.stopPropagation(); evFlag(m.id, !flagged); };
    l.appendChild(star);
    row.appendChild(l);
    const av = document.createElement('span'); av.className = 'ev-avatar ' + evAvatarClass(m); av.textContent = evInitials(from); row.appendChild(av);
    const mid = document.createElement('div'); mid.className = 'ev-item-mid';
    const top = document.createElement('div'); top.className = 'ev-item-top';
    const fn = document.createElement('span'); fn.className = 'ev-item-from'; fn.textContent = from; top.appendChild(fn);
    if (evAllInboxes && m._acctName) {
      const ab = document.createElement('span');
      ab.className = 'ev-item-acct acct-' + (Math.max(0, evAccounts.findIndex(x => x.homeAccountId === m._acct)) % 4);
      ab.textContent = ((m._acctName.split('@')[1] || m._acctName).split('.')[0]) || m._acctName;
      ab.title = m._acctName; top.appendChild(ab);
    }
    const cnt = evGroup && threadCount[m.conversationId || m.id] > 1 ? threadCount[m.conversationId || m.id] : 0;
    if (cnt) { const cc = document.createElement('span'); cc.className = 'ev-item-count'; cc.textContent = cnt; top.appendChild(cc); }
    const dt = document.createElement('span'); dt.className = 'ev-item-date'; dt.textContent = evFmtDate(m.receivedDateTime); top.appendChild(dt);
    mid.appendChild(top);
    const subj = document.createElement('div'); subj.className = 'ev-item-subj';
    if (m.importance === 'high') { const imp = document.createElement('span'); imp.className = 'ev-item-important'; imp.textContent = '!'; imp.title = 'High importance'; subj.appendChild(imp); }
    subj.appendChild(document.createTextNode(m.subject || '(no subject)'));
    if (m.hasAttachments) { const clip = document.createElement('span'); clip.className = 'ev-item-clip'; clip.textContent = ' 📎'; subj.appendChild(clip); }
    mid.appendChild(subj);
    const prev = document.createElement('div'); prev.className = 'ev-item-prev'; prev.textContent = m.bodyPreview || ''; mid.appendChild(prev);
    row.appendChild(mid);
    // hover quick-actions
    const qa = document.createElement('div'); qa.className = 'ev-item-qa';
    const qab = (label, title, fn) => { const b = document.createElement('button'); b.textContent = label; b.title = title; b.onclick = (e) => { e.stopPropagation(); fn(); }; qa.appendChild(b); };
    qab('🗄', 'Archive', () => evMove(m.id, 'archive', 'Archived'));
    qab(m.isRead ? '●' : '✓', m.isRead ? 'Mark unread' : 'Mark read', () => (m.isRead ? evMarkUnread(m.id) : evMarkRead(m.id)));
    qab('🚩', 'Flag', () => evFlag(m.id, !(m.flag && m.flag.flagStatus === 'flagged')));
    qab('🗑', 'Delete', () => evDelete(m.id));
    row.appendChild(qa);
    row.onclick = () => openEmailMessage(m.id);
    list.appendChild(row);
  });
  // Full-history paging: keep loading older mail until the mailbox runs out.
  if (evNextLink) {
    const more = document.createElement('button');
    more.className = 'ev-loadmore';
    more.textContent = 'Load older emails';
    more.onclick = async () => {
      more.disabled = true; more.textContent = 'Loading…';
      try {
        const j = await evGraph(evNextLink);
        evMessages = evMessages.concat(j.value || []);
        evNextLink = j['@odata.nextLink'] || null;
        renderMessageList();
      } catch (e) { more.disabled = false; more.textContent = 'Load older emails'; evToast('Couldn\'t load older mail.'); }
    };
    list.appendChild(more);
  }
}

async function openEmailMessage(id) {
  evOpenId = id;
  // Unified view: switch the token context to the mailbox this message belongs to,
  // so read/reply/flag/move all hit the right account.
  const uMsg = evMessages.find(x => x.id === id);
  if (uMsg && uMsg._acct) { const uAcct = evAccounts.find(x => x.homeAccountId === uMsg._acct); if (uAcct) evActive = uAcct; }
  renderMessageList();
  const read = $('ev-read'); if (read) read.innerHTML = '<div class="ev-loading">Loading…</div>';
  try {
    // internetMessageId is not decoration: it is the key reina_mail_triage is
    // unique on, and what the background scan stores every verdict under. Fetch
    // the message without it and the brief writes a SECOND row under the
    // conversation id instead -- a duplicate the scan will never find, carrying
    // none of his corrections.
    const m = await evGraph(`/me/messages/${id}?$select=id,internetMessageId,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments,isRead,flag,conversationId,categories`);
    renderReadingPane(m);
    if (!m.isRead) { evGraph(`/me/messages/${id}`, { method: 'PATCH', body: { isRead: true } }).then(() => { const it = evMessages.find(x => x.id === id); if (it) { it.isRead = true; renderMessageList(); refreshFolderCounts(); } }); }
  } catch (e) { if (read) read.innerHTML = '<div class="ev-loading">Couldn\'t open — ' + esc(e.message) + '</div>'; }
}

/* Open one specific message from outside this module.
   Chris, 2026-08-19: "when I clicked to open in email, it took me to the inbox,
   not the actual email i tried to open." The Reina notification lives in
   index.html, which cannot reach anything in here -- app.js is loaded as an ES
   module, so openEmailMessage is module-scoped. hlRoloHC opened the TAB and
   there it stopped. This is the missing half.

   The account has to be switched FIRST. Every mailbox call reads evActive for
   its token, so opening a message from the second mailbox while the first one
   is active fetches an id that mailbox has never heard of. */
window.hlOpenEmailMessage = async function (graphId, homeAccountId) {
  if (!graphId) return false;
  if (homeAccountId) {
    const a = evAccounts.find(x => x.homeAccountId === homeAccountId);
    if (a) evActive = a;
    else return false;                   // that mailbox is not connected here
  }
  await openEmailMessage(graphId);
  return true;
};
function evAddrs(list) { return (list || []).map(r => (r.emailAddress && (r.emailAddress.name || r.emailAddress.address)) || '').filter(Boolean).join(', '); }
function evAddrsFull(list) { return (list || []).map(r => { const e = (r && r.emailAddress) || {}; if (e.name && e.address && e.name !== e.address) return e.name + ' <' + e.address + '>'; return e.address || e.name || ''; }).filter(Boolean).join(', '); }
function evAddrsRaw(list) { return (list || []).map(r => r.emailAddress && r.emailAddress.address).filter(Boolean); }
function renderReadingPane(m) {
  const read = $('ev-read'); if (!read) return;
  const from = (m.from && m.from.emailAddress) || {};
  const flagged = m.flag && m.flag.flagStatus === 'flagged';
  read.innerHTML = '';
  const head = document.createElement('div'); head.className = 'ev-read-head';
  const subj = document.createElement('div'); subj.className = 'ev-read-subj';
  if (m.importance === 'high') { const imp = document.createElement('span'); imp.className = 'ev-item-important'; imp.textContent = '!'; imp.title = 'High importance'; subj.appendChild(imp); }
  subj.appendChild(document.createTextNode(m.subject || '(no subject)'));
  const top = document.createElement('div'); top.className = 'ev-read-top';
  const av = document.createElement('span'); av.className = 'ev-avatar ev-avatar-lg ' + evAvatarClass(m); av.textContent = evInitials(from.name || from.address || ''); top.appendChild(av);
  const topRight = document.createElement('div'); topRight.className = 'ev-read-top-right';
  topRight.appendChild(subj);
  const meta = document.createElement('div'); meta.className = 'ev-read-meta';
  meta.innerHTML = '<b>' + esc(from.name || from.address || '') + '</b> &lt;' + esc(from.address || '') + '&gt;<br><span class="muted">To: ' + esc(evAddrsFull(m.toRecipients)) + (m.ccRecipients && m.ccRecipients.length ? ' · Cc: ' + esc(evAddrsFull(m.ccRecipients)) : '') + '</span><span class="ev-read-when">' + esc(new Date(m.receivedDateTime).toLocaleString()) + '</span>';
  topRight.appendChild(meta);
  top.appendChild(topRight);
  head.appendChild(top);
  // action bar — clean icon actions + Reina + More (iCloud/Outlook style)
  evEnsureToolbarCss();
  const bar = document.createElement('div'); bar.className = 'ev-read-actions';
  const sv = (d) => '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
  const act = (html, title, fn, extra) => { const b = document.createElement('button'); b.className = 'ev-act' + (extra ? ' ' + extra : ''); b.innerHTML = html; b.title = title; b.setAttribute('aria-label', title); b.onclick = fn; return b; };
  const sep = () => { const s = document.createElement('span'); s.className = 'ev-act-sep'; return s; };
  bar.appendChild(act(sv('<path d="M9 15L4 10l5-5"/><path d="M4 10h11a5 5 0 0 1 5 5v3"/>'), 'Reply', () => openEmailCompose('reply', m)));
  bar.appendChild(act(sv('<path d="M8 15l-5-5 5-5"/><path d="M13 15l-5-5 5-5"/><path d="M8 10h8a5 5 0 0 1 5 5v3"/>'), 'Reply all', () => openEmailCompose('replyAll', m)));
  bar.appendChild(act(sv('<path d="M15 15l5-5-5-5"/><path d="M20 10H9a5 5 0 0 0-5 5v3"/>'), 'Forward', () => openEmailCompose('forward', m)));
  bar.appendChild(sep());
  bar.appendChild(act(sv('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/>'), 'Archive', () => evMove(m.id, 'archive', 'Archived')));
  bar.appendChild(act(sv('<path d="M3 7l1.8-2h4.4L11 7h7a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7z"/>'), 'Move to folder', (e) => evMoveMenu(e, m.id)));
  bar.appendChild(act(sv('<path d="M4 21V4h13l-2.5 4L17 12H4"/>'), 'Flag / follow-up', (e) => evFlagMenu(e, m, flagged), flagged ? 'ev-act-on' : ''));
  bar.appendChild(act(sv('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'), 'Delete', () => evDelete(m.id)));
  const spacer = document.createElement('span'); spacer.style.flex = '1'; bar.appendChild(spacer);
  bar.appendChild(act('<span class="ev-reina-star">✦</span> Reina', 'Reina AI — summarize, draft, extract', (e) => evReinaMenu(e, m), 'ev-act-reina'));
  bar.appendChild(act(sv('<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>'), 'More', (e) => evMoreMenu(e, m)));
  head.appendChild(bar);
  read.appendChild(head);
  // Reina's read of THIS message, above the message. (Chris, 2026-08-18: "in the
  // preview it shows a reina summary of the email and a suggested action or
  // response. below would be the actual email.") Rendered empty and filled in
  // asynchronously, so the email itself never waits on a model call.
  evEnsureBriefCss();
  const brief = document.createElement('div'); brief.className = 'ev-reina-brief'; read.appendChild(brief);
  evReinaBrief(m, brief);
  const aiOut = document.createElement('div'); aiOut.id = 'ev-ai-out'; aiOut.className = 'ev-ai-out hidden'; read.appendChild(aiOut);
  // body in a sandboxed iframe (safe render of remote HTML)
  const frame = document.createElement('iframe'); frame.className = 'ev-read-frame'; frame.setAttribute('sandbox', '');
  const content = (m.body && (m.body.contentType || '').toLowerCase() === 'html') ? m.body.content : '<pre style="white-space:pre-wrap;font-family:inherit">' + esc((m.body && m.body.content) || '') + '</pre>';
  frame.srcdoc = '<!doctype html><meta charset="utf-8"><base target="_blank"><style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1c2333;font-size:14px;line-height:1.5;margin:14px}img{max-width:100%;height:auto}a{color:#2f6fd6}</style>' + content;
  read.appendChild(frame);
  // conversation thread strip (other messages in this conversation)
  if (m.conversationId) {
    const strip = document.createElement('div'); strip.className = 'ev-thread'; strip.textContent = 'Loading conversation…'; read.appendChild(strip);
    evGraph(`/me/messages?$filter=conversationId eq '${m.conversationId}'&$select=id,subject,from,receivedDateTime,isRead&$orderby=receivedDateTime desc&$top=25`).then(j => {
      const others = (j.value || []).filter(x => x.id !== m.id);
      if (!others.length) { strip.remove(); return; }
      strip.innerHTML = ''; const h = document.createElement('div'); h.className = 'ev-thread-h'; h.textContent = '🧵 Conversation · ' + (others.length + 1) + ' messages'; strip.appendChild(h);
      others.forEach(o => {
        const r = document.createElement('button'); r.className = 'ev-thread-row' + (o.isRead ? '' : ' unread');
        const nm = (o.from && o.from.emailAddress && (o.from.emailAddress.name || o.from.emailAddress.address)) || '';
        r.innerHTML = '<span class="ev-thread-from">' + esc(nm) + '</span><span class="ev-thread-date">' + esc(evFmtDate(o.receivedDateTime)) + '</span>';
        r.onclick = () => openEmailMessage(o.id);
        strip.appendChild(r);
      });
    }).catch(() => strip.remove());
  }
  if (m.hasAttachments) {
    const at = document.createElement('div'); at.className = 'ev-read-attach'; at.textContent = 'Loading attachments…'; read.appendChild(at);
    evGraph(`/me/messages/${m.id}/attachments`).then(j => {
      at.innerHTML = ''; const chips = [];
      (j.value || []).forEach(a => {
        const chip = document.createElement('a'); chip.className = 'ev-attach-chip'; chip.textContent = '📎 ' + (a.name || 'file');
        chip.href = '#';
        chip.addEventListener('click', (ev) => { ev.preventDefault(); evDownloadAttachment(m.id, a, chip); });
        at.appendChild(chip); chips.push(chip);
      });
      if (chips.length > 1) { const all = document.createElement('button'); all.className = 'mini-btn'; all.textContent = '⬇ Download all'; all.onclick = () => chips.forEach((c, i) => setTimeout(() => c.click(), i * 250)); at.appendChild(all); }
      if (!at.children.length) at.remove();
    }).catch(() => at.remove());
  }
}

// Download one attachment reliably: inline bytes if Graph sent them,
// otherwise fetch the raw content ($value) with a fresh token; cloud-link
// attachments (OneDrive/SharePoint references) open their source URL.
async function evDownloadAttachment(msgId, a, chip) {
  const orig = chip.textContent;
  try {
    if (a['@odata.type'] === '#microsoft.graph.referenceAttachment' && a.sourceUrl) { window.open(a.sourceUrl, '_blank', 'noopener'); return; }
    chip.textContent = '\u2B07 ' + (a.name || 'file') + '\u2026';
    let blob;
    if (a.contentBytes) {
      const bin = atob(a.contentBytes);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      blob = new Blob([arr], { type: a.contentType || 'application/octet-stream' });
    } else {
      const token = await evToken();
      const r = await fetch('https://graph.microsoft.com/v1.0/me/messages/' + encodeURIComponent(msgId) + '/attachments/' + encodeURIComponent(a.id) + '/$value', { headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      blob = await r.blob();
    }
    const url = URL.createObjectURL(blob);
    const dl = document.createElement('a');
    dl.href = url; dl.download = a.name || 'attachment';
    document.body.appendChild(dl); dl.click(); dl.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    chip.textContent = orig;
  } catch (e) {
    chip.textContent = orig;
    evToast('Could not download "' + (a.name || 'attachment') + '" -- try again.');
  }
}
async function evFlag(id, on, opts = {}) {
  try {
    await evGraph(`/me/messages/${id}`, { method: 'PATCH', body: { flag: { flagStatus: on ? 'flagged' : 'notFlagged' } }, account: opts.account });
    const it = evMessages.find(x => x.id === id); if (it) { it.flag = it.flag || {}; it.flag.flagStatus = on ? 'flagged' : 'notFlagged'; }
    if (opts.silent) return;
    openEmailMessage(id);
  } catch (e) { if (opts.silent) throw e; evToast('Flag failed.'); }
}
async function evMarkUnread(id, opts = {}) {
  try {
    await evGraph(`/me/messages/${id}`, { method: 'PATCH', body: { isRead: false }, account: opts.account });
    const it = evMessages.find(x => x.id === id); if (it) it.isRead = false;
    if (opts.silent) return;
    renderMessageList(); refreshFolderCounts(); evToast('Marked unread');
  } catch (e) { if (opts.silent) throw e; evToast('Failed.'); }
}
async function evMarkRead(id, opts = {}) {
  try {
    await evGraph(`/me/messages/${id}`, { method: 'PATCH', body: { isRead: true }, account: opts.account });
    const it = evMessages.find(x => x.id === id); if (it) it.isRead = true;
    if (opts.silent) return;
    renderMessageList(); refreshFolderCounts();
  } catch (e) { if (opts.silent) throw e; evToast('Failed.'); }
}
async function evMarkAllRead() {
  const ids = evVisibleMessages().filter(m => !m.isRead).map(m => m.id);
  if (!ids.length) { evToast('Nothing to mark.'); return; }
  const acctFor = (id) => { const m = evMessages.find(x => x.id === id); return (m && m._acct) ? evAccounts.find(a => a.homeAccountId === m._acct) : undefined; };
  await Promise.allSettled(ids.map(id => evMarkRead(id, { silent: true, account: acctFor(id) })));
  renderMessageList(); refreshFolderCounts();
  evToast('Marked ' + ids.length + ' as read');
}
async function evDelete(id, opts = {}) {
  try {
    // Graph/IMAP both mint a NEW id for the moved message -- callers that need
    // to act on it again afterward (bulk Undo) must use the returned id, not `id`.
    const moved = await evGraph(`/me/messages/${id}/move`, { method: 'POST', body: { destinationId: 'deleteditems' }, account: opts.account });
    evMessages = evMessages.filter(x => x.id !== id); if (evOpenId === id) evOpenId = null;
    if (opts.silent) return { id: (moved && moved.id) || id };
    renderMessageList();
    const read = $('ev-read'); if (read && evOpenId === null) read.innerHTML = '<div class="ev-read-empty">Message moved to Deleted.</div>';
    refreshFolderCounts();
  } catch (e) { if (opts.silent) throw e; evToast('Delete failed.'); }
}
async function evMove(id, dest, note, opts = {}) {
  try {
    const moved = await evGraph(`/me/messages/${id}/move`, { method: 'POST', body: { destinationId: dest }, account: opts.account });
    evMessages = evMessages.filter(x => x.id !== id); if (evOpenId === id) evOpenId = null;
    if (opts.silent) return { id: (moved && moved.id) || id };
    renderMessageList();
    const read = $('ev-read'); if (read && evOpenId === null) read.innerHTML = '<div class="ev-read-empty">' + esc(note || 'Moved.') + '</div>';
    refreshFolderCounts(); evToast(note || 'Moved');
  } catch (e) { if (opts.silent) throw e; evToast('Move failed.'); }
}
// small popup menu of folders to move a message into
function evMoveMenu(e, id) {
  e.stopPropagation();
  const old = document.getElementById('ev-move-menu'); if (old) old.remove();
  const menu = document.createElement('div'); menu.id = 'ev-move-menu'; menu.className = 'ev-move-menu';
  const targets = EV_FOLDERS.filter(f => f.id !== evFolderId).concat(evCustomFolders.filter(f => f.id !== evFolderId).map(f => ({ id: f.id, name: f.name, icon: '📁' })));
  targets.forEach(f => {
    const row = document.createElement('div'); row.className = 'ev-move-item'; row.textContent = (f.icon || '📁') + ' ' + f.name;
    row.onclick = () => { menu.remove(); evMove(id, f.id, 'Moved to ' + f.name); };
    menu.appendChild(row);
  });
  document.body.appendChild(menu);
  const r = e.target.getBoundingClientRect();
  menu.style.left = Math.min(r.left, window.innerWidth - 220) + 'px';
  menu.style.top = (r.bottom + 4) + 'px';
  setTimeout(() => document.addEventListener('click', function h() { menu.remove(); document.removeEventListener('click', h); }), 0);
}

// ---- command bar: bulk + single-message actions (2026-08-24) ----
function evGetOpenMessage() { return evOpenId ? evMessages.find(x => x.id === evOpenId) : null; }
// Static confirmation modal (reused for any destructive bulk/single action) --
// falls back to a native confirm() only if the markup somehow isn't present.
function evConfirm(opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const bd = $('ev-confirm-backdrop');
    if (!bd) { resolve(window.confirm(opts.body || opts.title || 'Are you sure?')); return; }
    $('ev-confirm-title').textContent = opts.title || 'Are you sure?';
    $('ev-confirm-body').textContent = opts.body || '';
    const okBtn = $('ev-confirm-ok'); okBtn.textContent = opts.okLabel || 'Delete';
    const cancelBtn = $('ev-confirm-cancel');
    const cleanup = (result) => { bd.classList.add('hidden'); okBtn.onclick = null; cancelBtn.onclick = null; resolve(result); };
    okBtn.onclick = () => cleanup(true);
    cancelBtn.onclick = () => cleanup(false);
    bd.classList.remove('hidden');
  });
}
// One path for every bulk (or "acts on the open message when nothing is
// selected") action. Batches the existing single-message functions with
// {silent:true} so a failure doesn't get swallowed, splices evMessages and
// re-renders ONCE afterward (never relies on a background count refresh --
// 2026-08-18: that's exactly how "move to junk didn't work" happened), and
// resolves each id's own mailbox via m._acct so All-Inboxes selections don't
// silently act against whichever mailbox evActive happens to be.
async function evBulkAction(kind, opts) {
  opts = opts || {};
  const openMsg = evGetOpenMessage();
  const ids = evSelected.size ? [...evSelected] : (openMsg ? [openMsg.id] : []);
  if (!ids.length) return;
  if (kind === 'delete' || kind === 'report') {
    const label = kind === 'delete' ? 'Delete' : 'Report as junk';
    const ok = await evConfirm({
      title: label + ' ' + ids.length + (ids.length === 1 ? ' message?' : ' messages?'),
      body: kind === 'delete' ? 'This moves the message(s) to Deleted.' : 'This moves the message(s) to Junk.',
      okLabel: label,
    });
    if (!ok) return;
  }
  const fromFolder = evFolderId;
  const acctFor = (id) => { const m = evMessages.find(x => x.id === id); return (m && m._acct) ? evAccounts.find(a => a.homeAccountId === m._acct) : undefined; };
  // Captured BEFORE the action runs -- once a message moves it drops out of
  // evMessages, so its _acct (and thus which mailbox Undo must target) would
  // otherwise be unrecoverable.
  const accts = ids.map(acctFor);
  let results;
  if (kind === 'delete') results = await Promise.allSettled(ids.map((id, i) => evDelete(id, { silent: true, account: accts[i] })));
  else if (kind === 'flag') results = await Promise.allSettled(ids.map((id, i) => evFlag(id, true, { silent: true, account: accts[i] })));
  else if (kind === 'unread') results = await Promise.allSettled(ids.map((id, i) => evMarkUnread(id, { silent: true, account: accts[i] })));
  else {
    const dest = kind === 'archive' ? 'archive' : (kind === 'report' ? 'junkemail' : opts.destId);
    if (!dest) return;
    results = await Promise.allSettled(ids.map((id, i) => evMove(id, dest, null, { silent: true, account: accts[i] })));
  }
  // Undo targets AFTER the move -- Graph/IMAP mint a new id on move, the old one is gone.
  const undoItems = [];
  ids.forEach((id, i) => { if (results[i].status === 'fulfilled') undoItems.push({ id: (results[i].value && results[i].value.id) || id, account: accts[i] }); });
  const okCount = undoItems.length, failCount = ids.length - okCount;
  evSelected.clear();
  renderMessageList(); refreshFolderCounts();
  // Starred/Important aren't real folders -- there's nowhere coherent to move
  // a message "back to" (the fetch is mailbox-wide, not one folder), so Undo
  // is honestly unavailable for an action taken from one of those views.
  const fromIsVirtual = fromFolder === 'starred' || fromFolder === 'important';
  if (['delete', 'archive', 'report', 'move'].includes(kind) && okCount && !fromIsVirtual) {
    evLastUndo = { kind, items: undoItems, fromFolder };
    clearTimeout(evUndoTimer); evUndoTimer = setTimeout(() => { evLastUndo = null; evUpdateCmdbarState(); }, 10000);
  }
  evUpdateCmdbarState();
  const verbs = { delete: 'Deleted', archive: 'Archived', report: 'Reported as junk', flag: 'Flagged', unread: 'Marked unread', move: 'Moved to ' + (opts.destName || 'folder') };
  evToast((verbs[kind] || 'Updated') + ' ' + okCount + (failCount ? (' · ' + failCount + ' failed') : ''));
}
async function evUndoBulk() {
  if (!evLastUndo) return;
  const { items, fromFolder } = evLastUndo;
  clearTimeout(evUndoTimer); evLastUndo = null; evUpdateCmdbarState();
  await Promise.allSettled(items.map(it => evMove(it.id, fromFolder, null, { silent: true, account: it.account })));
  selectFolder(evFolderId, evFolderName);
  evToast('Undone');
}
// folder-picker for the toolbar's "Move to" — same target list as evMoveMenu,
// but resolves against the current selection (or the open message) via evBulkAction.
function evBulkMoveMenu(e) {
  const openMsg = evGetOpenMessage();
  const ids = evSelected.size ? [...evSelected] : (openMsg ? [openMsg.id] : []);
  if (!ids.length) return;
  e.stopPropagation();
  const old = document.getElementById('ev-move-menu'); if (old) old.remove();
  const menu = document.createElement('div'); menu.id = 'ev-move-menu'; menu.className = 'ev-move-menu';
  const targets = EV_FOLDERS.filter(f => f.id !== evFolderId).concat(evCustomFolders.filter(f => f.id !== evFolderId).map(f => ({ id: f.id, name: f.name, icon: '📁' })));
  targets.forEach(f => {
    const row = document.createElement('div'); row.className = 'ev-move-item'; row.textContent = (f.icon || '📁') + ' ' + f.name;
    row.onclick = () => { menu.remove(); evBulkAction('move', { destId: f.id, destName: f.name }); };
    menu.appendChild(row);
  });
  document.body.appendChild(menu);
  const btn = (e.currentTarget || e.target).closest('button') || e.target;
  const r = btn.getBoundingClientRect();
  menu.style.left = Math.min(r.left, window.innerWidth - 220) + 'px'; menu.style.top = (r.bottom + 4) + 'px';
  setTimeout(() => document.addEventListener('click', function h() { menu.remove(); document.removeEventListener('click', h); }), 0);
}
// right-click context menu on a list row — reuses the same shared dropdown
// builder (evMenu, defined below) the reading pane's Reina/More menus use.
function evCtxMenu(e, m) {
  const flagged = !!(m.flag && m.flag.flagStatus === 'flagged');
  evMenu(e, [
    ['👁 Open', () => openEmailMessage(m.id)],
    ['↩ Reply', () => openEmailCompose('reply', m)],
    ['↩ Reply all', () => openEmailCompose('replyAll', m)],
    ['↪ Forward', () => openEmailCompose('forward', m)],
    '---',
    [flagged ? '☆ Unflag' : '★ Flag', () => evFlag(m.id, !flagged)],
    ['● Mark unread', () => evMarkUnread(m.id)],
    '---',
    ['🗄 Archive', () => evMove(m.id, 'archive', 'Archived')],
    ['📁 Move to…', (ev) => evMoveMenu(ev, m.id)],
    ['🗑 Delete', async () => { const ok = await evConfirm({ title: 'Delete this message?', body: 'This moves it to Deleted.', okLabel: 'Delete' }); if (ok) evDelete(m.id); }],
  ]);
}
// sort control in the list head
function evSortMenu(e) {
  const opt = (label, by, dir) => [label + (evSortBy === by && evSortDir === dir ? ' ✓' : ''), () => { evSortBy = by; evSortDir = dir; renderMessageList(); }];
  evMenu(e, [
    opt('Received (newest first)', 'date', 'desc'), opt('Received (oldest first)', 'date', 'asc'), '---',
    opt('Sender (A–Z)', 'from', 'asc'), opt('Sender (Z–A)', 'from', 'desc'), '---',
    opt('Subject (A–Z)', 'subject', 'asc'), opt('Subject (Z–A)', 'subject', 'desc'),
  ]);
}

// ---- categories ----
function evCatMenu(e, m) {
  e.stopPropagation();
  const old = document.getElementById('ev-cat-menu'); if (old) old.remove();
  const menu = document.createElement('div'); menu.id = 'ev-cat-menu'; menu.className = 'ev-move-menu';
  const cur = new Set(m.categories || []);
  EV_CATS.forEach(c => {
    const row = document.createElement('div'); row.className = 'ev-move-item';
    row.innerHTML = '<span class="ev-cat-dot" style="background:' + c.color + '"></span> ' + c.name.replace(' category', '') + (cur.has(c.name) ? ' ✓' : '');
    row.onclick = () => { menu.remove(); const has = cur.has(c.name); const next = has ? [...cur].filter(x => x !== c.name) : [...cur, c.name]; evSetCategories(m, next); };
    menu.appendChild(row);
  });
  document.body.appendChild(menu);
  const r = e.target.getBoundingClientRect();
  menu.style.left = Math.min(r.left, window.innerWidth - 220) + 'px'; menu.style.top = (r.bottom + 4) + 'px';
  setTimeout(() => document.addEventListener('click', function h() { menu.remove(); document.removeEventListener('click', h); }), 0);
}
async function evSetCategories(m, cats) {
  try {
    await evGraph('/me/messages/' + m.id, { method: 'PATCH', body: { categories: cats } });
    m.categories = cats; const it = evMessages.find(x => x.id === m.id); if (it) it.categories = cats;
    renderMessageList(); openEmailMessage(m.id); evToast('Category updated');
  } catch (e) { evToast('Category failed.'); }
}

// ---- flag with a follow-up date ----
function evFlagMenu(e, m, flagged) {
  e.stopPropagation();
  const old = document.getElementById('ev-flag-menu'); if (old) old.remove();
  const menu = document.createElement('div'); menu.id = 'ev-flag-menu'; menu.className = 'ev-move-menu';
  const day = 86400000, now = new Date();
  const items = [
    ['📌 Today', 0], ['➡️ Tomorrow', 1], ['🗓️ This week', 5], ['🚩 Flag (no date)', -1],
  ];
  items.forEach(([label, d]) => { const row = document.createElement('div'); row.className = 'ev-move-item'; row.textContent = label; row.onclick = () => { menu.remove(); evSetFlag(m, d < 0 ? null : new Date(now.getTime() + d * day)); }; menu.appendChild(row); });
  if (flagged) { const row = document.createElement('div'); row.className = 'ev-move-item'; row.textContent = '✕ Clear flag'; row.onclick = () => { menu.remove(); evFlag(m.id, false); }; menu.appendChild(row); }
  document.body.appendChild(menu);
  const r = e.target.getBoundingClientRect(); menu.style.left = Math.min(r.left, window.innerWidth - 220) + 'px'; menu.style.top = (r.bottom + 4) + 'px';
  setTimeout(() => document.addEventListener('click', function h() { menu.remove(); document.removeEventListener('click', h); }), 0);
}
async function evSetFlag(m, due) {
  const flag = { flagStatus: 'flagged' };
  if (due) { const iso = due.toISOString(); flag.dueDateTime = { dateTime: iso, timeZone: 'UTC' }; flag.startDateTime = { dateTime: new Date().toISOString(), timeZone: 'UTC' }; }
  try { await evGraph('/me/messages/' + m.id, { method: 'PATCH', body: { flag } }); openEmailMessage(m.id); evToast('Flagged'); } catch (e) { evToast('Flag failed.'); }
}

// ---- print ----
function evPrint(m) {
  const from = (m.from && m.from.emailAddress) || {};
  const content = (m.body && (m.body.contentType || '').toLowerCase() === 'html') ? m.body.content : '<pre>' + esc((m.body && m.body.content) || '') + '</pre>';
  const w = window.open('', '_blank', 'width=800,height=900');
  if (!w) { evToast('Allow popups to print.'); return; }
  w.document.write('<!doctype html><meta charset="utf-8"><title>' + esc(m.subject || 'Email') + '</title>' +
    '<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111;margin:28px}h2{margin:0 0 4px}.meta{color:#555;font-size:13px;margin-bottom:16px;border-bottom:1px solid #ddd;padding-bottom:10px}</style>' +
    '<h2>' + esc(m.subject || '(no subject)') + '</h2><div class="meta"><b>' + esc(from.name || from.address || '') + '</b> &lt;' + esc(from.address || '') + '&gt;<br>To: ' + esc(evAddrs(m.toRecipients)) + '<br>' + esc(new Date(m.receivedDateTime).toLocaleString()) + '</div>' + content);
  w.document.close(); setTimeout(() => { try { w.print(); } catch (e) {} }, 300);
}

// ---- block sender (rule → future mail from them goes to Junk) ----
async function evBlockSender(m) {
  const addr = m.from && m.from.emailAddress && m.from.emailAddress.address; if (!addr) return;
  try {
    await evGraph('/me/mailFolders/inbox/messageRules', { method: 'POST', body: {
      displayName: 'Block ' + addr, sequence: 1, isEnabled: true,
      conditions: { senderContains: [addr] },
      actions: { moveToFolder: 'junkemail', stopProcessingRules: true },
    } });
    await evGraph('/me/messages/' + m.id + '/move', { method: 'POST', body: { destinationId: 'junkemail' } });
    evMessages = evMessages.filter(x => x.id !== m.id); evOpenId = null; renderMessageList();
    const read = $('ev-read'); if (read) read.innerHTML = '<div class="ev-read-empty">Blocked ' + esc(addr) + ' — future mail goes to Junk.</div>';
    evToast('Blocked ' + addr);
  } catch (e) { evToast('Block failed — ' + (e.message || '')); }
}

// ---- AI (Reina) on email — routed through a Supabase Edge Function that holds the model key ----
async function aiComplete(task, payload) {
  const base = (window.HIVE_CONFIG || {}).url, key = (window.HIVE_CONFIG || {}).anonKey;
  const r = await fetch(base + '/functions/v1/email-ai', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, apikey: key },
    body: JSON.stringify(Object.assign({ task }, payload)),
  });
  if (!r.ok) { const t = await r.text().catch(() => ''); const e = new Error(r.status === 404 ? 'not set up' : (t || ('AI error ' + r.status))); e.notSetup = (r.status === 404); throw e; }
  const j = await r.json().catch(() => ({})); return j.text || j.output || j.content || '';
}
function evAiText(m) {
  const c = (m.body && m.body.content) || '';
  const t = (m.body && (m.body.contentType || '').toLowerCase() === 'html') ? c.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ') : c;
  return t.replace(/\s+/g, ' ').trim().slice(0, 6000);
}
async function evAiRun(m, task, label, instruction) {
  const out = $('ev-ai-out'); if (!out) return; out.classList.remove('hidden');
  out.scrollIntoView({ block: 'nearest' });
  out.innerHTML = '<div class="ev-ai-load">✨ ' + esc(label) + '…</div>';
  try {
    const payload = { subject: m.subject || '', from: (m.from && m.from.emailAddress && m.from.emailAddress.address) || '', body: evAiText(m) };
    if (instruction) payload.instruction = instruction;
    const text = await aiComplete(task, payload);
    out.innerHTML = '<div class="ev-ai-head">✨ Reina · ' + esc(label) + '</div><div class="ev-ai-body">' + esc(text).replace(/\n/g, '<br>') + '</div>';
    if (task === 'reply') {
      const b = document.createElement('button'); b.className = 'mini-btn'; b.textContent = '↩ Use as reply';
      b.onclick = () => { openEmailCompose('reply', m); setTimeout(() => { $('ev-c-body').innerHTML = '<div>' + esc(text).replace(/\n/g, '<br>') + '</div>' + evSigHtml(); }, 60); };
      out.appendChild(b);
    }
  } catch (e) {
    if (e.notSetup) out.innerHTML = '<div class="ev-ai-setup">✨ <b>AI isn\'t connected yet.</b> Reina needs an AI key wired up (one-time setup) — then she\'ll summarize threads, draft replies, and pull action items right here.</div>';
    else out.innerHTML = '<div class="ev-ai-setup">AI error: ' + esc(e.message) + '</div>';
  }
}
function evAiSummarize(m) { evAiRun(m, 'summarize', 'Summary'); }
function evAiDraftReply(m) { evAiRun(m, 'reply', 'Draft reply'); }
function evAiExtractTasks(m) { evAiRun(m, 'tasks', 'Action items'); }
function evAiTranslate(m) { evAiRun(m, 'custom', 'Translation', 'You are Reina. Translate the email below into clear, natural English. If it is already English, translate it into Spanish instead. Return only the translation.'); }
// "More" AI menu: rewrite / shorten / tone
// Shared dropdown for the reading-pane toolbar (Reina / More)
function evMenu(e, items) {
  e.stopPropagation();
  const old = document.getElementById('ev-drop-menu'); if (old) old.remove();
  const menu = document.createElement('div'); menu.id = 'ev-drop-menu'; menu.className = 'ev-move-menu';
  items.forEach(it => {
    if (it === '---') { const d = document.createElement('div'); d.className = 'ev-move-sep'; menu.appendChild(d); return; }
    const row = document.createElement('div'); row.className = 'ev-move-item'; row.innerHTML = it[0];
    row.onclick = (ev) => { menu.remove(); it[1](ev); };
    menu.appendChild(row);
  });
  document.body.appendChild(menu);
  const btn = (e.currentTarget || e.target).closest('button') || e.target;
  const r = btn.getBoundingClientRect();
  menu.style.left = Math.min(r.left, window.innerWidth - 250) + 'px'; menu.style.top = (r.bottom + 5) + 'px';
  setTimeout(() => document.addEventListener('click', function h() { menu.remove(); document.removeEventListener('click', h); }), 0);
}
function evReinaMenu(e, m) {
  evMenu(e, [
    ['✦ Summarize', () => evAiSummarize(m)],
    ['↩ Draft a reply', () => evAiDraftReply(m)],
    ['✅ Extract tasks', () => evAiExtractTasks(m)],
    ['🌐 Translate', () => evAiTranslate(m)],
    '---',
    ['✍️ Rewrite / clean up', () => evAiRun(m, 'custom', 'Rewrite', 'You are Reina. Rewrite the email below to be clearer and more professional, keeping all facts. Return only the rewritten version.')],
    ['✂️ Shorten', () => evAiRun(m, 'custom', 'Shortened', 'You are Reina. Rewrite the email below to be much shorter while keeping every key point. Return only the shortened version.')],
    ['💬 Reply — friendly', () => evAiRun(m, 'custom', 'Friendly reply', 'You are Reina drafting a reply for a contracting business owner. Write a warm, friendly, casual reply to the email below. Return only the reply body.')],
    ['👔 Reply — formal', () => evAiRun(m, 'custom', 'Formal reply', 'You are Reina drafting a reply for a contracting business owner. Write a polished, formal, professional reply to the email below. Return only the reply body.')],
    ['⚖️ Reply — firm', () => evAiRun(m, 'custom', 'Firm reply', 'You are Reina drafting a reply for a contracting business owner. Write a polite but firm reply that holds the line (e.g. on scope, price, or timeline). Return only the reply body.')],
  ]);
}
function evMoreMenu(e, m) {
  const from = (m.from && m.from.emailAddress) || {};
  evMenu(e, [
    ['✉ Mark unread', () => evMarkUnread(m.id)],
    ['🏷 Categorize…', (ev) => evCatMenu(ev, m)],
    ['⚠ Mark as junk', () => evMove(m.id, 'junkemail', 'Moved to Junk')],
    '---',
    ['✅ Create task', () => openTaskQuickCreateFromSource({ type: 'email', externalRef: m.id, subject: m.subject || '(no subject)', sender: from.name || from.address || '', preview: (m.bodyPreview || '').slice(0, 200) })],
    ['📅 Schedule meeting', () => { setNavTab('calendar'); setTimeout(() => openCalNew({ title: m.subject || '', attendees: from.address || '', body: 'Re: ' + (m.subject || '') }), 200); }],
    '---',
    ['🖨 Print', () => evPrint(m)],
    ['🚫 Block sender', () => evBlockSender(m)],
  ]);
}
function evEnsureToolbarCss() {
  if (document.getElementById('ev-toolbar-css')) return;
  const st = document.createElement('style'); st.id = 'ev-toolbar-css';
  st.textContent = '#ev-read .ev-read-actions{display:flex;align-items:center;gap:3px;flex-wrap:wrap;padding:4px 0 2px}'
    + '#ev-read .ev-act{appearance:none;-webkit-appearance:none;height:34px;min-width:34px;padding:0 9px;border:0;background:transparent;box-shadow:none;color:var(--slate);border-radius:8px;display:inline-flex;align-items:center;justify-content:center;gap:6px;cursor:pointer;font:600 12.5px var(--sans);transition:background .12s,color .12s}'
    + '#ev-read .ev-act:hover{background:var(--steel-bg);color:var(--steel-deep)}'
    + '#ev-read .ev-act.ev-act-on{color:var(--red)}'
    + '#ev-read .ev-act-reina{color:var(--steel-deep);font-weight:700}#ev-read .ev-reina-star{font-size:13px}'
    + '#ev-read .ev-act-sep{width:1px;height:20px;background:var(--line);margin:0 5px}'
    + '.ev-move-menu .ev-move-sep{height:1px;background:var(--line);margin:5px 0}';
  document.head.appendChild(st);
}
function evAiMoreMenu(e, m) {
  e.stopPropagation();
  const old = document.getElementById('ev-ai-menu'); if (old) old.remove();
  const menu = document.createElement('div'); menu.id = 'ev-ai-menu'; menu.className = 'ev-move-menu';
  const opts = [
    ['🌐 Translate', () => evAiTranslate(m)],
    ['✍️ Rewrite / clean up', () => evAiRun(m, 'custom', 'Rewrite', 'You are Reina. Rewrite the email below to be clearer and more professional, keeping all facts. Return only the rewritten version.')],
    ['✂️ Shorten', () => evAiRun(m, 'custom', 'Shortened', 'You are Reina. Rewrite the email below to be much shorter while keeping every key point. Return only the shortened version.')],
    ['😊 Reply — friendly', () => evAiRun(m, 'custom', 'Friendly reply', 'You are Reina drafting a reply for a contracting business owner. Write a warm, friendly, casual reply to the email below. Return only the reply body.')],
    ['👔 Reply — formal', () => evAiRun(m, 'custom', 'Formal reply', 'You are Reina drafting a reply for a contracting business owner. Write a polished, formal, professional reply to the email below. Return only the reply body.')],
    ['⚖️ Reply — firm', () => evAiRun(m, 'custom', 'Firm reply', 'You are Reina drafting a reply for a contracting business owner. Write a polite but firm reply that holds the line (e.g. on scope, price, or timeline). Return only the reply body.')],
  ];
  opts.forEach(([label, fn]) => { const row = document.createElement('div'); row.className = 'ev-move-item'; row.textContent = label; row.onclick = () => { menu.remove(); fn(); }; menu.appendChild(row); });
  document.body.appendChild(menu);
  const r = e.target.getBoundingClientRect();
  menu.style.left = Math.min(r.left, window.innerWidth - 240) + 'px'; menu.style.top = (r.bottom + 4) + 'px';
  setTimeout(() => document.addEventListener('click', function h() { menu.remove(); document.removeEventListener('click', h); }), 0);
}
// ---- email templates (save / insert) ----
function evTemplateMenu(e) {
  e.stopPropagation();
  const old = document.getElementById('ev-tpl-menu'); if (old) old.remove();
  const menu = document.createElement('div'); menu.id = 'ev-tpl-menu'; menu.className = 'ev-move-menu';
  const tpls = evTemplates();
  tpls.forEach((t, i) => {
    const row = document.createElement('div'); row.className = 'ev-move-item'; row.textContent = '📄 ' + t.name;
    row.onclick = () => { menu.remove(); if (t.subject && !$('ev-c-subj').value) $('ev-c-subj').value = t.subject; $('ev-c-body').innerHTML = t.body + evSigHtml(); };
    const del = document.createElement('span'); del.textContent = ' ✕'; del.style.cssText = 'float:right;color:#c65b4e;cursor:pointer'; del.onclick = (ev) => { ev.stopPropagation(); const a = evTemplates(); a.splice(i, 1); evSaveTemplates(a); menu.remove(); };
    row.appendChild(del); menu.appendChild(row);
  });
  if (!tpls.length) { const em = document.createElement('div'); em.className = 'ev-move-item'; em.style.color = 'var(--mut)'; em.textContent = 'No templates yet'; menu.appendChild(em); }
  const save = document.createElement('div'); save.className = 'ev-move-item'; save.style.borderTop = '1px solid var(--line)'; save.textContent = '＋ Save current as template';
  save.onclick = () => {
    menu.remove();
    const name = window.prompt('Template name:'); if (!name) return;
    const a = evTemplates(); a.push({ name, subject: $('ev-c-subj').value || '', body: $('ev-c-body').innerHTML }); evSaveTemplates(a); evToast('Template saved');
  };
  menu.appendChild(save);
  document.body.appendChild(menu);
  const r = e.target.getBoundingClientRect(); menu.style.left = Math.min(r.left, window.innerWidth - 240) + 'px'; menu.style.top = (r.top - 8) + 'px'; menu.style.transform = 'translateY(-100%)';
  setTimeout(() => document.addEventListener('click', function h() { menu.remove(); document.removeEventListener('click', h); }), 0);
}
// Reina improves the current compose draft in place
async function evAiImproveDraft() {
  const ta = $('ev-c-body'); if (!ta) return;
  const cur = ta.innerText.trim(); if (!cur) { evToast('Write a rough draft first, then Reina polishes it.'); return; }
  evToast('Reina is polishing…');
  try {
    const text = await aiComplete('custom', { body: cur, instruction: 'You are Reina, an assistant for a contracting business owner. Improve the writing below into a clear, professional, friendly email. Fix grammar and tone. Keep it roughly the same length and keep all facts. Return only the improved email body.' });
    if (text) ta.innerHTML = '<div>' + esc(text).replace(/\n/g, '<br>') + '</div>';
  } catch (e) { evToast(e.notSetup ? 'AI not connected.' : 'AI error.'); }
}

// ---- compose / reply / forward ----
// ---- signatures (per mailbox, saved locally) ----
function evSigKey() { return 'hcSig_' + (evActive ? (evActive.username || '').toLowerCase() : 'default'); }
// An email signature is the clearest case of all: it is who he is, not which
// laptop he opened. Keyed per mailbox, because two mailboxes sign off
// differently.
function evGetSig() { return hcPref('sig:' + evSigKey(), evSigKey(), '') || ''; }
function evSetSig(s) { hcPrefSet('sig:' + evSigKey(), evSigKey(), s); }
function evSigHtml() { const s = evGetSig(); return s ? '<br><br><span style="color:#667">--</span><br>' + esc(s).replace(/\n/g, '<br>') : ''; }
function nl2br(s) { return esc(s).replace(/\n/g, '<br>'); }

function openEmailCompose(mode, src) {
  evComposeMode = mode || 'new'; evComposeSource = src || null; evAttachments = []; evComposeDraftId = null;
  const fromSel = $('ev-c-from'); if (fromSel) { fromSel.innerHTML = ''; evAccounts.forEach(a => { const o = document.createElement('option'); o.value = a.homeAccountId; o.textContent = a.username; if (evActive && a.homeAccountId === evActive.homeAccountId) o.selected = true; fromSel.appendChild(o); }); }
  let to = '', cc = '', subj = '', bodyHtml = '';
  const sig = evSigHtml();
  if (src) {
    const fromAddr = src.from && src.from.emailAddress && src.from.emailAddress.address;
    const sSubj = src.subject || '';
    const quoted = '<br><br><blockquote style="border-left:2px solid #ccd;padding-left:10px;color:#556">' +
      'On ' + esc(new Date(src.receivedDateTime).toLocaleString()) + ', ' + esc((src.from && src.from.emailAddress && (src.from.emailAddress.name || src.from.emailAddress.address)) || '') + ' wrote:<br>' +
      nl2br(src.bodyPreview || '') + '</blockquote>';
    if (mode === 'reply' || mode === 'replyAll') {
      to = fromAddr || '';
      if (mode === 'replyAll') { const others = evAddrsRaw(src.toRecipients).concat(evAddrsRaw(src.ccRecipients)).filter(a => a && (!evActive || a.toLowerCase() !== evActive.username.toLowerCase()) && a !== fromAddr); cc = [...new Set(others)].join(', '); }
      subj = /^re:/i.test(sSubj) ? sSubj : 'Re: ' + sSubj;
      bodyHtml = '<div><br></div>' + sig + quoted;
    } else if (mode === 'forward') {
      subj = /^fw:/i.test(sSubj) ? sSubj : 'Fwd: ' + sSubj;
      bodyHtml = '<div><br></div>' + sig + '<br>——— Forwarded message ———' + quoted;
    }
  } else {
    bodyHtml = '<div><br></div>' + sig;
  }
  $('ev-c-title').textContent = mode === 'forward' ? 'Forward' : (mode === 'reply' || mode === 'replyAll') ? 'Reply' : 'New email';
  evSetChips('ev-c-to', evSplitAddrs(to)); evSetChips('ev-c-cc', evSplitAddrs(cc)); evSetChips('ev-c-bcc', []);
  $('ev-c-subj').value = subj; $('ev-c-body').innerHTML = bodyHtml;
  { const imp = $('ev-c-importance'); if (imp) imp.value = 'normal'; }
  { const rc = $('ev-c-receipt'); if (rc) rc.checked = false; }
  { const se = $('ev-c-sigedit'); if (se) se.classList.add('hidden'); const st = $('ev-c-sigtext'); if (st) st.value = evGetSig(); }
  $('ev-c-cc-row').classList.toggle('hidden', !cc); $('ev-c-cctoggle').classList.toggle('hidden', !!cc); $('ev-c-bcc-row').classList.add('hidden'); $('ev-c-bcctoggle').classList.remove('hidden');
  renderComposeAttachments();
  const msg = $('ev-c-msg'); if (msg) msg.classList.add('hidden');
  $('ev-compose-backdrop').classList.remove('hidden');
  (to ? $('ev-c-body') : $('ev-c-to')).focus();
  evCheckDraftRecovery();
}
function evSplitAddrs(s) { return (s || '').split(/[,;]+/).map(x => x.trim()).filter(Boolean); }

// ---- draft autosave (in-flight, unsent draft only — raw localStorage, never
// hcPref/hlUserSettings: this is the one narrow exception to "settings follow
// the user," not a synced preference. Keyed by account+mode+source so a reply
// to message A never clobbers a reply to message B.) ----
function evDraftKey() {
  const acct = (evActive && evActive.homeAccountId) || 'default';
  const src = (evComposeSource && (evComposeSource.id || evComposeSource.internetMessageId)) || 'new';
  return 'hcEmailDraft:' + acct + ':' + evComposeMode + ':' + src;
}
let evDraftSaveTimer = null;
function evSaveDraftNow() {
  try {
    const bd = $('ev-compose-backdrop'); if (!bd || bd.classList.contains('hidden')) return;
    const to = evChipFieldAddresses('ev-c-to'), cc = evChipFieldAddresses('ev-c-cc'), bcc = evChipFieldAddresses('ev-c-bcc');
    const subj = ($('ev-c-subj') || {}).value || '';
    const bodyHtml = ($('ev-c-body') || {}).innerHTML || '';
    if (!to.length && !cc.length && !bcc.length && !subj && !bodyHtml.replace(/<[^>]+>/g, '').trim()) { evClearDraft(); return; }
    localStorage.setItem(evDraftKey(), JSON.stringify({ to, cc, bcc, subj, bodyHtml, ts: Date.now() }));
  } catch (e) {}
}
function evScheduleDraftSave() { clearTimeout(evDraftSaveTimer); evDraftSaveTimer = setTimeout(evSaveDraftNow, 800); }
function evClearDraft() { try { localStorage.removeItem(evDraftKey()); } catch (e) {} }
function evCheckDraftRecovery() {
  const banner = $('ev-c-draft-banner'); if (!banner) return;
  banner.classList.add('hidden');
  let saved;
  try { saved = JSON.parse(localStorage.getItem(evDraftKey()) || 'null'); } catch (e) { saved = null; }
  if (!saved) return;
  const t = $('ev-c-draft-time'); if (t) t.textContent = new Date(saved.ts).toLocaleString();
  banner.classList.remove('hidden');
  $('ev-c-draft-restore').onclick = () => {
    evSetChips('ev-c-to', saved.to || []); evSetChips('ev-c-cc', saved.cc || []); evSetChips('ev-c-bcc', saved.bcc || []);
    $('ev-c-cc-row').classList.toggle('hidden', !(saved.cc || []).length); $('ev-c-bcc-row').classList.toggle('hidden', !(saved.bcc || []).length);
    $('ev-c-subj').value = saved.subj || ''; $('ev-c-body').innerHTML = saved.bodyHtml || '';
    banner.classList.add('hidden');
  };
  $('ev-c-draft-discard').onclick = () => { evClearDraft(); banner.classList.add('hidden'); };
}

// ---- Gmail-style recipient chips (To/Cc/Bcc) ----
// Each field's committed addresses live here; the <input> itself only ever
// holds whatever's still being typed. Replaces the old plain "type a comma
// yourself" text field.
const EV_CHIPS = { 'ev-c-to': [], 'ev-c-cc': [], 'ev-c-bcc': [] };
function evRenderChips(inputId) {
  const input = $(inputId); if (!input) return;
  const field = input.closest('.ev-chipfield'); if (!field) return;
  field.querySelectorAll('.ev-chip').forEach(c => c.remove());
  EV_CHIPS[inputId].forEach((addr, i) => {
    const chip = document.createElement('span'); chip.className = 'ev-chip';
    const label = document.createElement('span'); label.textContent = addr; chip.appendChild(label);
    const x = document.createElement('button'); x.type = 'button'; x.className = 'ev-chip-x'; x.textContent = '✕';
    x.onclick = () => { EV_CHIPS[inputId].splice(i, 1); evRenderChips(inputId); input.focus(); };
    chip.appendChild(x);
    field.insertBefore(chip, input);
  });
}
// Commits whatever's currently typed (splitting on comma/semicolon, so a
// paste of several addresses at once becomes several chips) into chips and
// clears the input. Returns false if there was nothing to commit.
function evCommitChip(inputId) {
  const input = $(inputId); if (!input) return false;
  const parts = evSplitAddrs(input.value);
  if (!parts.length) return false;
  parts.forEach(p => { if (!EV_CHIPS[inputId].includes(p)) EV_CHIPS[inputId].push(p); });
  input.value = '';
  evRenderChips(inputId);
  return true;
}
// Committed chips plus anything still sitting in the input uncommitted
// (e.g. the user typed an address and clicked Send without pressing Enter).
function evChipFieldAddresses(inputId) {
  const input = $(inputId);
  return EV_CHIPS[inputId].concat(evSplitAddrs(input ? input.value : ''));
}
function evSetChips(inputId, addrs) {
  EV_CHIPS[inputId] = (addrs || []).filter(Boolean);
  const input = $(inputId); if (input) input.value = '';
  evRenderChips(inputId);
}
['ev-c-to', 'ev-c-cc', 'ev-c-bcc'].forEach(id => {
  const el = $(id); if (!el) return;
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') { if (el.value.trim()) { e.preventDefault(); evCommitChip(id); } }
    else if (e.key === 'Backspace' && !el.value && EV_CHIPS[id].length) { EV_CHIPS[id].pop(); evRenderChips(id); }
  });
  el.addEventListener('blur', () => evCommitChip(id));
});
function renderComposeAttachments() {
  const box = $('ev-c-attach-list'); if (!box) return; box.innerHTML = '';
  evAttachments.forEach((a, i) => {
    const chip = document.createElement('span'); chip.className = 'ev-cattach';
    chip.textContent = '📎 ' + a.name + ' ';
    const x = document.createElement('button'); x.textContent = '✕'; x.onclick = () => { evAttachments.splice(i, 1); renderComposeAttachments(); };
    chip.appendChild(x); box.appendChild(chip);
  });
}
async function evSendCompose() {
  const to = evChipFieldAddresses('ev-c-to').map(a => ({ emailAddress: { address: a } }));
  const cc = evChipFieldAddresses('ev-c-cc').map(a => ({ emailAddress: { address: a } }));
  const bcc = evChipFieldAddresses('ev-c-bcc').map(a => ({ emailAddress: { address: a } }));
  const subject = $('ev-c-subj').value.trim();
  const bodyHtml = $('ev-c-body').innerHTML;
  const msg = $('ev-c-msg');
  if (!to.length) { msg.textContent = 'Add at least one recipient.'; msg.classList.remove('hidden'); return; }
  // switch active account to the chosen "From"
  const fromId = $('ev-c-from').value; const acc = evAccounts.find(a => a.homeAccountId === fromId); if (acc) evActive = acc;
  const message = {
    subject, body: { contentType: 'HTML', content: bodyHtml },
    toRecipients: to, ccRecipients: cc, bccRecipients: bcc,
    importance: ($('ev-c-importance') ? $('ev-c-importance').value : 'normal'),
    isReadReceiptRequested: !!($('ev-c-receipt') && $('ev-c-receipt').checked),
  };
  if (evAttachments.length) message.attachments = evAttachments.map(a => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: a.name, contentType: a.type || 'application/octet-stream', contentBytes: a.bytes }));
  const send = $('ev-c-send'); send.disabled = true; send.textContent = 'Sending…';
  try {
    if (evComposeDraftId) {
      // A real server draft exists for this session -- update it with the
      // final content, then send THAT draft (moves it out of Drafts), rather
      // than firing a separate /sendMail and leaving a stale duplicate behind.
      await evGraph('/me/messages/' + evComposeDraftId, { method: 'PATCH', body: message });
      await evGraph('/me/messages/' + evComposeDraftId + '/send', { method: 'POST' });
    } else {
      await evGraph('/me/sendMail', { method: 'POST', body: { message, saveToSentItems: true } });
    }
    $('ev-compose-backdrop').classList.add('hidden');
    evComposeDraftId = null;
    evClearDraft();
    evToast('Sent ✓');
    if (evFolderId === 'sentitems') selectFolder('sentitems', 'Sent');
  } catch (e) { msg.textContent = 'Send failed — ' + e.message; msg.classList.remove('hidden'); }
  finally { send.disabled = false; send.textContent = 'Send'; }
}
// Explicit "Save draft" — writes a REAL draft to the mailbox's Drafts folder
// via Graph (distinct from the silent localStorage autosave, which only
// protects against an accidental refresh and never leaves this browser).
// First save creates the draft and remembers its id; later saves in the same
// compose session PATCH that same draft instead of creating duplicates.
async function evSaveDraftToServer() {
  const fromId = $('ev-c-from') ? $('ev-c-from').value : null;
  const fromAcc = fromId ? evAccounts.find(a => a.homeAccountId === fromId) : null;
  if (fromAcc) evActive = fromAcc;
  // /api/mail.js's IMAP adapter only speaks sendMail + move today -- no
  // draft-creation/PATCH support yet. Fail honestly up front rather than
  // let the Graph-shaped call 404 against a mailbox that can't do this.
  if (evActive && evActive.provider === 'imap') { evToast('Save draft isn\'t available yet for this mailbox type — Send still works.'); return; }
  const to = evChipFieldAddresses('ev-c-to').map(a => ({ emailAddress: { address: a } }));
  const cc = evChipFieldAddresses('ev-c-cc').map(a => ({ emailAddress: { address: a } }));
  const bcc = evChipFieldAddresses('ev-c-bcc').map(a => ({ emailAddress: { address: a } }));
  const subject = $('ev-c-subj').value.trim();
  const bodyHtml = $('ev-c-body').innerHTML;
  const message = { subject, body: { contentType: 'HTML', content: bodyHtml }, toRecipients: to, ccRecipients: cc, bccRecipients: bcc };
  const btn = $('ev-c-savedraft'); const was = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    if (evComposeDraftId) await evGraph('/me/messages/' + evComposeDraftId, { method: 'PATCH', body: message });
    else { const created = await evGraph('/me/messages', { method: 'POST', body: message }); evComposeDraftId = (created && created.id) || null; }
    evClearDraft(); // the server now has it -- the local recovery copy is redundant
    evToast('Draft saved');
  } catch (e) { evToast('Save draft failed — ' + (e.message || '')); }
  finally { if (btn) { btn.disabled = false; btn.textContent = was; } }
}

let evToastT = null;
function evToast(text) {
  let t = document.getElementById('ev-toast');
  if (!t) { t = document.createElement('div'); t.id = 'ev-toast'; t.className = 'rail-toast'; document.body.appendChild(t); }
  t.textContent = text; t.classList.add('show');
  clearTimeout(evToastT); evToastT = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---- email event wiring ----
{ const b = $('ev-compose'); if (b) b.addEventListener('click', () => openEmailCompose('new', null)); }
{ const b = $('ev-refresh'); if (b) b.addEventListener('click', () => selectFolder(evFolderId, evFolderName)); }
{ const b = $('ev-signin'); if (b) b.addEventListener('click', emailSignIn); }
{ const b = $('ev-c-close'); if (b) b.addEventListener('click', () => $('ev-compose-backdrop').classList.add('hidden')); }
{ const b = $('ev-c-cancel'); if (b) b.addEventListener('click', () => { evClearDraft(); $('ev-compose-backdrop').classList.add('hidden'); }); }
{ const s = $('ev-c-subj'); if (s) s.addEventListener('input', evScheduleDraftSave); }
{ const bd2 = $('ev-c-body'); if (bd2) bd2.addEventListener('input', evScheduleDraftSave); }
['ev-c-to', 'ev-c-cc', 'ev-c-bcc'].forEach(id => { const el = $(id); if (el) el.addEventListener('blur', evScheduleDraftSave); });
{ const b = $('ev-c-send'); if (b) b.addEventListener('click', evSendCompose); }
{ const b = $('ev-c-savedraft'); if (b) b.addEventListener('click', evSaveDraftToServer); }
{ const b = $('ev-c-cctoggle'); if (b) b.addEventListener('click', () => { $('ev-c-cc-row').classList.remove('hidden'); b.classList.add('hidden'); $('ev-c-cc').focus(); }); }
{ const b = $('ev-c-bcctoggle'); if (b) b.addEventListener('click', () => { $('ev-c-bcc-row').classList.remove('hidden'); b.classList.add('hidden'); $('ev-c-bcc').focus(); }); }
{ const b = $('ev-c-attach'); if (b) b.addEventListener('click', () => $('ev-c-file').click()); }
{ const b = $('ev-c-ai'); if (b) b.addEventListener('click', evAiImproveDraft); }
{ const b = $('ev-c-tpl'); if (b) b.addEventListener('click', evTemplateMenu); }
// rich-text formatting toolbar (execCommand on the contenteditable body)
{ const tb = $('ev-c-toolbar'); if (tb) tb.addEventListener('mousedown', (e) => {
    const btn = e.target.closest('button[data-cmd]'); if (!btn) return;
    e.preventDefault(); $('ev-c-body').focus();
    try { document.execCommand(btn.dataset.cmd, false, null); } catch (_) {}
  }); }
{ const lb = $('ev-c-link'); if (lb) lb.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const url = window.prompt('Link URL:', 'https://'); if (!url) return;
    $('ev-c-body').focus();
    try { document.execCommand('createLink', false, url); } catch (_) {}
  }); }
// signature editor
{ const sb = $('ev-c-sigbtn'); if (sb) sb.addEventListener('click', () => { const e = $('ev-c-sigedit'); if (e) { e.classList.toggle('hidden'); if (!e.classList.contains('hidden')) $('ev-c-sigtext').value = evGetSig(); } }); }
{ const ss = $('ev-c-sigsave'); if (ss) ss.addEventListener('click', () => { evSetSig($('ev-c-sigtext').value); const m = $('ev-c-sigmsg'); if (m) { m.textContent = 'Saved ✓'; setTimeout(() => m.textContent = '', 1500); } }); }
{ const f = $('ev-c-file'); if (f) f.addEventListener('change', async (e) => {
    for (const file of [...e.target.files]) {
      if (file.size > 3 * 1024 * 1024) { evToast(file.name + ' is over 3 MB — skipped'); continue; }
      const b64 = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.readAsDataURL(file); });
      evAttachments.push({ name: file.name, type: file.type, bytes: b64 });
    }
    e.target.value = ''; renderComposeAttachments();
  }); }

// ---- command bar + list head wiring ----
{ const b = $('ev-compose-caret'); if (b) b.addEventListener('click', (e) => evMenu(e, [
    ['✎ New email', () => openEmailCompose('new', null)],
    ['📅 New meeting <span class="rail-soon" style="position:static;margin-left:6px">SOON</span>', () => evToast('Meeting invites from Email are coming soon.')],
  ])); }
{ const b = $('ev-select-all'); if (b) b.addEventListener('change', () => {
    const rows = [...document.querySelectorAll('#ev-list .ev-item[data-id]')];
    if (b.checked) rows.forEach(r => evSelected.add(r.dataset.id));
    else rows.forEach(r => evSelected.delete(r.dataset.id));
    renderMessageList();
  }); }
{ const b = $('ev-tab-focused'); if (b) b.addEventListener('click', () => { evFocusedTab = 'focused'; renderMessageList(); }); }
{ const b = $('ev-tab-other'); if (b) b.addEventListener('click', () => { evFocusedTab = 'other'; renderMessageList(); }); }
{ const b = $('ev-sort-btn'); if (b) b.addEventListener('click', evSortMenu); }
{ const b = $('ev-cmd-delete'); if (b) b.addEventListener('click', () => evBulkAction('delete')); }
{ const b = $('ev-cmd-archive'); if (b) b.addEventListener('click', () => evBulkAction('archive')); }
{ const b = $('ev-cmd-report'); if (b) b.addEventListener('click', () => evBulkAction('report')); }
{ const b = $('ev-cmd-move'); if (b) b.addEventListener('click', evBulkMoveMenu); }
{ const b = $('ev-cmd-reply'); if (b) b.addEventListener('click', () => { const m = evGetOpenMessage(); if (m) openEmailCompose('reply', m); }); }
{ const b = $('ev-cmd-reply-caret'); if (b) b.addEventListener('click', (e) => {
    const m = evGetOpenMessage(); if (!m) return;
    evMenu(e, [
      ['↩ Reply', () => openEmailCompose('reply', m)],
      ['↩ Reply all', () => openEmailCompose('replyAll', m)],
      ['↪ Forward', () => openEmailCompose('forward', m)],
    ]);
  }); }
{ const b = $('ev-cmd-readall'); if (b) b.addEventListener('click', evMarkAllRead); }
{ const b = $('ev-cmd-flag'); if (b) b.addEventListener('click', () => evBulkAction('flag')); }
{ const b = $('ev-cmd-snooze'); if (b) b.addEventListener('click', () => evToast('Snooze is coming soon.')); }
{ const b = $('ev-cmd-undo'); if (b) b.addEventListener('click', evUndoBulk); }
{ const b = $('ev-cmd-more'); if (b) b.addEventListener('click', (e) => { const m = evGetOpenMessage(); if (m) evMoreMenu(e, m); }); }

// ---- keyboard shortcuts (only while the Email tab is visible and focus isn't
// in a text field — mirrors the guard the Chirp push-to-talk listener uses) ----
document.addEventListener('keydown', (e) => {
  const ev = $('email-view'); if (!ev || ev.classList.contains('hidden')) return;
  const cb = $('ev-compose-backdrop'), cf = $('ev-confirm-backdrop');
  if ((cb && !cb.classList.contains('hidden')) || (cf && !cf.classList.contains('hidden'))) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) {
    // focus is already in a field -- let it handle its own keys
  } else {
    if (e.key === '/') { e.preventDefault(); const s = $('ev-search'); if (s) s.focus(); return; }
    if (e.key === 'Escape') { if (evSelected.size) { evSelected.clear(); renderMessageList(); } return; }
    const m = evGetOpenMessage();
    if (e.key === 'x' && m) { evToggleSelect(m.id, !evSelected.has(m.id)); return; }
    if ((e.key === 'Delete' || e.key === '#') && (evSelected.size || m)) { e.preventDefault(); evBulkAction('delete'); return; }
    if (e.key === 'e' && (evSelected.size || m)) { evBulkAction('archive'); return; }
    if (e.key === 'u' && m) { evMarkUnread(m.id); return; }
    if (e.key === 'r' && m) { openEmailCompose('reply', m); return; }
    if (e.key === 'a' && m) { openEmailCompose('replyAll', m); return; }
    if (e.key === 'f' && m) { openEmailCompose('forward', m); return; }
  }
});

// ---- search ----
// Search has to answer for whatever mailbox is open, not just Microsoft ones:
//  * Microsoft mailboxes use Graph $search -- server-side, whole mailbox.
//  * IMAP mailboxes (Gmail/iCloud/Yahoo/custom) send the same $search path to
//    /api/mail, which runs a real IMAP SEARCH over subject/from/to/body across
//    the mailbox. If that route isn't deployed yet the adapter answers
//    { __unsupported }, and rather than show an empty list we match the newest
//    50 envelopes of the open folder and say so in the header.
//  * In All Inboxes mode every mailbox is searched, and each hit carries the
//    _acct tag openEmailMessage() needs to open it against the right account.
const EV_SEARCH_SELECT = '$select=id,subject,from,receivedDateTime,isRead,bodyPreview,hasAttachments,flag,conversationId,categories,inferenceClassification,importance';
function evSearchHaystack(m) {
  const f = (m.from && m.from.emailAddress) || {};
  return [m.subject, f.name, f.address, m.bodyPreview].join(' ').toLowerCase();
}
async function evSearchAccount(acct, q) {
  const imap = !!(acct && acct.provider === 'imap');
  const j = await evGraph(`/me/messages?$search="${encodeURIComponent(q)}"&${EV_SEARCH_SELECT}&$top=${imap ? 50 : 30}`, { account: acct });
  let rows = j.value || [], degraded = false;
  if (imap && j && j.__unsupported) {
    const f = await evGraph(`/me/mailFolders/${evFolderId}/messages?${EV_SEARCH_SELECT}&$top=50`, { account: acct });
    const needle = q.toLowerCase();
    rows = (f.value || []).filter(m => evSearchHaystack(m).includes(needle));
    degraded = true;
  }
  rows.forEach(m => { m._acct = acct.homeAccountId; m._acctName = acct.username || acct.name || ''; });
  return { rows, degraded, partial: !!(j && j.__search && j.__search.partial) };
}
{ const s = $('ev-search'); if (s) s.addEventListener('keydown', async (e) => {
    const list = $('ev-list');
    if (e.key === 'Escape') { s.value = ''; selectFolder(evFolderId, evFolderName); return; }
    if (e.key !== 'Enter') return;
    const q = s.value.trim();
    if (!q) return selectFolder(evFolderId, evFolderName);
    const targets = (evAllInboxes && evAccounts.length > 1) ? evAccounts.slice() : (evActive ? [evActive] : []);
    if (!targets.length) { if (list) list.innerHTML = '<div class="ev-loading">Connect a mailbox first.</div>'; return; }
    if (list) list.innerHTML = '<div class="ev-loading">Searching…</div>';
    try {
      const settled = await Promise.allSettled(targets.map(a => evSearchAccount(a, q)));
      const ok = settled.filter(r => r.status === 'fulfilled').map(r => r.value);
      if (!ok.length) throw ((settled[0] && settled[0].reason) || new Error('search failed'));
      evMessages = ok.reduce((acc, r) => acc.concat(r.rows), [])
        .sort((x, y) => new Date(y.receivedDateTime || 0) - new Date(x.receivedDateTime || 0));
      evOpenId = null;
      evNextLink = null; // results are one page -- never page the old folder in underneath them
      const read = $('ev-read'); if (read) read.innerHTML = '<div class="ev-read-empty">Select a message to read it here.</div>';
      renderMessageList();
      if (!evMessages.length && list) list.innerHTML = '<div class="ev-loading">Nothing matches “' + esc(q) + '”.</div>';
      const note = ok.some(r => r.degraded) ? ' (recent mail only)'
        : (ok.some(r => r.partial) ? ' (partial — some folders timed out)' : '');
      const fn = $('ev-folder-name');
      if (fn) fn.textContent = 'Search: ' + q + note;
    } catch (err) { if (list) list.innerHTML = '<div class="ev-loading">Search failed — ' + esc(err.message) + '</div>'; }
  }); }
{ const bd = $('ev-compose-backdrop'); if (bd) bd.addEventListener('click', e => { /* clicking away must NOT discard the draft — keep the compose open; use ✕ or Discard to close */ }); }
{ const bd = $('ev-confirm-backdrop'); if (bd) bd.addEventListener('click', e => { if (e.target === bd) { const c = $('ev-confirm-cancel'); if (c) c.click(); else bd.classList.add('hidden'); } }); }

/* ==================================================================
   TASKS (Native) — HiveLogic's own action-management system.
   Phase 1. Tables live in this Supabase project: tasks, task_roles,
   task_source_links, task_status_history. See
   sql/hiveconnect/001_tasks_core.sql for the schema.

   NOTE: the legacy Microsoft To-Do–backed "Tasks" view below (openTasksTab /
   loadTasks / renderTasks / tkAdd / tkToggle / tkDelete) is left in place but
   no longer wired to the Tasks tab — Outlook tasks are meant to be imported
   references, not the foundation, per the product spec. Its functions are
   still defined so a future "import from Outlook" pass can reuse them.
   ================================================================== */
const TASK_STATUSES = ['draft', 'unassigned', 'not_started', 'in_progress', 'waiting', 'blocked', 'submitted_for_review', 'revision_required', 'approved', 'completed', 'cancelled'];
const TASK_STATUS_LABEL = { draft: 'Draft', unassigned: 'Unassigned', not_started: 'Not Started', in_progress: 'In Progress', waiting: 'Waiting', blocked: 'Blocked', submitted_for_review: 'Submitted for Review', revision_required: 'Revision Required', approved: 'Approved', completed: 'Completed', cancelled: 'Cancelled' };
const TASK_WAITING_REASONS = ['client', 'vendor', 'material', 'payment', 'permit', 'inspection', 'internal_approval', 'information', 'schedule'];
// Mirrored onto window for the same reason `me` is (see line 8): tasks.js is
// a classic script written against "app.js's top-level consts are global",
// which breaks once hiveconnect-mount.js loads this file as a module. These
// three are read-once-at-declaration, so unlike `me` they need no reassignment
// tracking -- one mirror line here covers every future reference.
window.TASK_STATUSES = TASK_STATUSES;
window.TASK_STATUS_LABEL = TASK_STATUS_LABEL;
window.TASK_WAITING_REASONS = TASK_WAITING_REASONS;

/* ==================================================================
   TASKS (Microsoft To-Do) + CALENDAR (Outlook) — via Graph, per mailbox.
   ================================================================== */
function tcNeedSignin(host) {
  const el = $(host); if (!el) return;
  el.classList.remove('hidden');
  el.innerHTML = '<div class="tc-connect-card"><h2>Connect a mailbox first</h2><p>Sign in on the Email tab, then your Microsoft 365 tasks & calendar show up here.</p><button class="primary-btn" id="' + host + '-go">Go to Email</button></div>';
  const b = $(host + '-go'); if (b) b.onclick = () => setNavTab('email');
}
function evEnsureAccount() { ensureMsal(); evAccounts = msalApp ? msalApp.getAllAccounts() : []; if (!evActive) evActive = evAccounts[0] || null; return evActive; }
function tcParseDate(o) { if (!o || !o.dateTime) return null; const s = o.dateTime; const tz = (o.timeZone || 'UTC'); const iso = /[Z+]/.test(s) ? s : (s + (tz === 'UTC' ? 'Z' : 'Z')); return new Date(iso); }
function tcSidebar(panel, title) { const el = $(panel); if (!el) return; el.innerHTML = '<div class="ev-accts"><div class="ev-accts-lbl">' + esc(title) + '</div><button class="ev-acct active"><span class="ev-acct-dot">' + esc((evActive && (evActive.username || '?').charAt(0).toUpperCase()) || '?') + '</span><span class="ev-acct-name">' + esc(evActive ? evActive.username : '') + '</span></button></div>'; }

// ---- Tasks ----
let tkListId = null;
async function openTasksTab() {
  const conn = $('tk-connect'), list = $('tk-list');
  if (!evEnsureAccount() || !emailConfigured()) { if (list) list.innerHTML = ''; tcNeedSignin('tk-connect'); tcSidebar('panel-tasks', 'TASKS'); return; }
  if (conn) { conn.classList.add('hidden'); conn.innerHTML = ''; }
  tcSidebar('panel-tasks', 'TASKS');
  loadTasks();
}
async function loadTasks() {
  const list = $('tk-list'); if (list) list.innerHTML = '<div class="ev-loading">Loading…</div>';
  try {
    if (!tkListId) {
      const j = await evGraph('/me/todo/lists?$top=25');
      const lists = j.value || [];
      const def = lists.find(l => l.wellknownListName === 'defaultList') || lists[0];
      tkListId = def && def.id;
    }
    if (!tkListId) { if (list) list.innerHTML = '<div class="ev-loading">No task list found.</div>'; return; }
    const j = await evGraph(`/me/todo/lists/${tkListId}/tasks?$top=100&$orderby=createdDateTime desc`);
    renderTasks(j.value || []);
  } catch (e) { if (list) list.innerHTML = '<div class="ev-loading">Couldn\'t load tasks — ' + esc(e.message) + '</div>'; }
}
function renderTasks(tasks) {
  const list = $('tk-list'); if (!list) return; list.innerHTML = '';
  const open = tasks.filter(t => t.status !== 'completed'), done = tasks.filter(t => t.status === 'completed');
  if (!tasks.length) { list.innerHTML = '<div class="ev-loading">No tasks yet — add one above. 🎉</div>'; return; }
  const row = (t) => {
    const r = document.createElement('div'); r.className = 'tk-item' + (t.status === 'completed' ? ' done' : '');
    const cb = document.createElement('button'); cb.className = 'tk-check'; cb.innerHTML = t.status === 'completed' ? '✓' : ''; cb.onclick = () => tkToggle(t.id, t.status !== 'completed'); r.appendChild(cb);
    const mid = document.createElement('div'); mid.className = 'tk-mid';
    const ti = document.createElement('div'); ti.className = 'tk-title'; ti.textContent = t.title || '(untitled)'; mid.appendChild(ti);
    if (t.dueDateTime) { const d = tcParseDate(t.dueDateTime); const due = document.createElement('div'); due.className = 'tk-due'; due.textContent = '📅 ' + d.toLocaleDateString([], { month: 'short', day: 'numeric' }); if (d < new Date() && t.status !== 'completed') due.classList.add('overdue'); mid.appendChild(due); }
    r.appendChild(mid);
    const del = document.createElement('button'); del.className = 'tk-del'; del.textContent = '✕'; del.title = 'Delete'; del.onclick = () => tkDelete(t.id); r.appendChild(del);
    return r;
  };
  open.forEach(t => list.appendChild(row(t)));
  if (done.length) { const h = document.createElement('div'); h.className = 'tk-sec'; h.textContent = 'Completed (' + done.length + ')'; list.appendChild(h); done.forEach(t => list.appendChild(row(t))); }
}
async function tkAdd() {
  const inp = $('tk-new'); const title = inp.value.trim(); if (!title || !tkListId) { if (!tkListId) await loadTasks(); if (!tkListId) return; }
  if (!title) return;
  const body = { title };
  const due = $('tk-due').value; if (due) body.dueDateTime = { dateTime: due + 'T00:00:00', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  inp.value = ''; $('tk-due').value = '';
  try { await evGraph(`/me/todo/lists/${tkListId}/tasks`, { method: 'POST', body }); loadTasks(); } catch (e) { evToast('Add failed.'); }
}
async function tkToggle(id, done) { try { await evGraph(`/me/todo/lists/${tkListId}/tasks/${id}`, { method: 'PATCH', body: { status: done ? 'completed' : 'notStarted' } }); loadTasks(); } catch (e) { evToast('Update failed.'); } }
async function tkDelete(id) { try { await evGraph(`/me/todo/lists/${tkListId}/tasks/${id}`, { method: 'DELETE' }); loadTasks(); } catch (e) { evToast('Delete failed.'); } }
// create a task straight from an email
async function evMailToTask(m) {
  if (!evEnsureAccount()) return;
  try {
    if (!tkListId) { const j = await evGraph('/me/todo/lists?$top=25'); const def = (j.value || []).find(l => l.wellknownListName === 'defaultList') || (j.value || [])[0]; tkListId = def && def.id; }
    if (!tkListId) return evToast('No task list.');
    await evGraph(`/me/todo/lists/${tkListId}/tasks`, { method: 'POST', body: { title: 'Email: ' + (m.subject || '(no subject)'), body: { content: 'From ' + ((m.from && m.from.emailAddress && m.from.emailAddress.address) || '') + '\n\n' + (m.bodyPreview || ''), contentType: 'text' } } });
    evToast('Added to Tasks ✅');
  } catch (e) { evToast('Couldn\'t add task.'); }
}

// ---- Calendar ----
async function openCalendarTab() {
  const list = $('cal-list');
  if (!evEnsureAccount() || !emailConfigured()) { if (list) list.innerHTML = ''; tcNeedSignin('cal-connect'); tcSidebar('panel-calendar', 'CALENDAR'); return; }
  { const c = $('cal-connect'); if (c) { c.classList.add('hidden'); c.innerHTML = ''; } }
  tcSidebar('panel-calendar', 'CALENDAR');
  loadCalendar();
}
async function loadCalendar() {
  const list = $('cal-list'); if (list) list.innerHTML = '<div class="ev-loading">Loading…</div>';
  try {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 28 * 86400000);
    const url = `/me/calendarView?startDateTime=${start.toISOString()}&endDateTime=${end.toISOString()}&$select=subject,start,end,location,organizer,attendees,isAllDay,onlineMeetingUrl,webLink&$orderby=start/dateTime&$top=80`;
    const j = await evGraph(url);
    renderCalendar(j.value || []);
  } catch (e) { if (list) list.innerHTML = '<div class="ev-loading">Couldn\'t load calendar — ' + esc(e.message) + '</div>'; }
}
function renderCalendar(events) {
  const list = $('cal-list'); if (!list) return; list.innerHTML = '';
  if (!events.length) { list.innerHTML = '<div class="ev-loading">Nothing scheduled in the next 4 weeks. Tap ＋ New event.</div>'; return; }
  let curDay = '';
  events.forEach(ev => {
    const s = tcParseDate(ev.start), e = tcParseDate(ev.end);
    const dayKey = s ? s.toDateString() : '';
    if (dayKey !== curDay) { curDay = dayKey; const h = document.createElement('div'); h.className = 'cal-day'; const today = new Date().toDateString() === dayKey; h.textContent = (today ? 'Today · ' : '') + (s ? s.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }) : ''); list.appendChild(h); }
    const row = document.createElement('div'); row.className = 'cal-item';
    const time = document.createElement('div'); time.className = 'cal-time';
    time.textContent = ev.isAllDay ? 'All day' : (s ? s.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');
    row.appendChild(time);
    const mid = document.createElement('div'); mid.className = 'cal-mid';
    const ti = document.createElement('div'); ti.className = 'cal-subj'; ti.textContent = ev.subject || '(no title)'; mid.appendChild(ti);
    const meta = [];
    if (!ev.isAllDay && s && e) meta.push(s.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '–' + e.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
    if (ev.location && ev.location.displayName) meta.push('📍 ' + ev.location.displayName);
    if (ev.attendees && ev.attendees.length) meta.push('👥 ' + ev.attendees.length);
    if (meta.length) { const mt = document.createElement('div'); mt.className = 'cal-meta'; mt.textContent = meta.join('  ·  '); mid.appendChild(mt); }
    row.appendChild(mid);
    if (ev.onlineMeetingUrl || ev.webLink) { const a = document.createElement('a'); a.className = 'mini-btn'; a.target = '_blank'; a.href = ev.onlineMeetingUrl || ev.webLink; a.textContent = ev.onlineMeetingUrl ? 'Join' : 'Open'; row.appendChild(a); }
    list.appendChild(row);
  });
}
function openCalNew(prefill) {
  const p = prefill || {};
  $('cal-c-title').value = p.title || '';
  const d = new Date(); $('cal-c-date').value = d.toISOString().slice(0, 10);
  $('cal-c-start').value = '09:00'; $('cal-c-end').value = '10:00';
  $('cal-c-att').value = p.attendees || ''; $('cal-c-loc').value = ''; $('cal-c-body').value = p.body || '';
  const msg = $('cal-c-msg'); if (msg) msg.classList.add('hidden');
  $('cal-backdrop').classList.remove('hidden'); $('cal-c-title').focus();
}
async function calSave() {
  if (!evEnsureAccount()) return;
  const title = $('cal-c-title').value.trim(); const date = $('cal-c-date').value; const st = $('cal-c-start').value, en = $('cal-c-end').value;
  const msg = $('cal-c-msg');
  if (!title || !date) { msg.textContent = 'Add a title and date.'; msg.classList.remove('hidden'); return; }
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const atts = $('cal-c-att').value.split(/[,;]+/).map(x => x.trim()).filter(Boolean).map(a => ({ emailAddress: { address: a }, type: 'required' }));
  const body = {
    subject: title,
    start: { dateTime: date + 'T' + (st || '09:00') + ':00', timeZone: tz },
    end: { dateTime: date + 'T' + (en || '10:00') + ':00', timeZone: tz },
    attendees: atts,
  };
  if ($('cal-c-loc').value.trim()) body.location = { displayName: $('cal-c-loc').value.trim() };
  if ($('cal-c-body').value.trim()) body.body = { contentType: 'text', content: $('cal-c-body').value.trim() };
  const btn = $('cal-c-save'); btn.disabled = true; btn.textContent = 'Creating…';
  try { await evGraph('/me/events', { method: 'POST', body }); $('cal-backdrop').classList.add('hidden'); evToast('Event created 📅'); loadCalendar(); }
  catch (e) { msg.textContent = 'Failed — ' + e.message; msg.classList.remove('hidden'); }
  finally { btn.disabled = false; btn.textContent = 'Create event'; }
}

// ---- tasks/calendar event wiring ----
{ const b = $('tk-new'); if (b) b.addEventListener('keydown', e => { if (e.key === 'Enter') tkAdd(); }); }
{ const b = $('tk-refresh'); if (b) b.addEventListener('click', loadTasks); }
{ const b = $('cal-refresh'); if (b) b.addEventListener('click', loadCalendar); }
{ const b = $('cal-new'); if (b) b.addEventListener('click', () => openCalNew()); }
{ const b = $('cal-c-close'); if (b) b.addEventListener('click', () => $('cal-backdrop').classList.add('hidden')); }
{ const b = $('cal-c-cancel'); if (b) b.addEventListener('click', () => $('cal-backdrop').classList.add('hidden')); }
{ const b = $('cal-c-save'); if (b) b.addEventListener('click', calSave); }
{ const bd = $('cal-backdrop'); if (bd) bd.addEventListener('click', e => { if (e.target === bd) bd.classList.add('hidden'); }); }

/* ============================================================================
   CHIRP — Nextel-style push-to-talk (1:1, live, hold-to-talk)
   Rides on the same self-hosted LiveKit as HiveVideo, but audio-only + a
   separate Room so it never clobbers a video call. Gated by clock-in +
   availability. "Instant, no answer" is realized with a presence channel:
   when you open a line, the other clocked-in member auto-joins it muted, so
   the moment you hold TALK they hear you live.
   ============================================================================ */
let chirpRoom = null;          // LiveKit Room for the active chirp line
let chirpLineCid = null;       // channel id (DM or crew) of the active line
let chirpPeerId = null;        // the other person's user_id (DM lines only)
let chirpLineKind = 'dm';      // 'dm' | 'group'
let chirpTalking = false;      // is MY mic hot right now
let chirpIncoming = false;     // am I on a line I auto-answered (vs one I opened)
let chirpCtx = null;           // WebAudio ctx for tones
let chirpNet = null;           // presence channel
let chirpPeers = new Map();    // user_id -> { mode, line, name, avatar_url, avatar_color }
let chirpConnecting = false;

const CHIRP_TODAY = () => new Date().toISOString().slice(0, 10);
function chirpClock() { return hcPrefJson('chirpClock', 'chirpClock', {}) || {}; }
function chirpClockedIn() { const c = chirpClock(); return !!(c.in && c.date === CHIRP_TODAY()); }
function chirpMode() { return hcPref('chirpMode', 'chirpMode', 'avail') || 'avail'; }        // avail | quiet
function chirpEffMode() { return chirpClockedIn() ? chirpMode() : 'off'; }             // what others see

function chirpSetClock(on) {
  hcPrefSet('chirpClock', 'chirpClock', on ? { in: true, date: CHIRP_TODAY(), since: Date.now() } : { in: false, date: CHIRP_TODAY() });
  chirpUnlockAudio();
  if (!on && chirpLineCid) chirpHangup();     // clocking out drops any live line
  chirpBroadcast(); renderChirpPanel(); chirpApplyGate(); updateMainHeader();
}
function chirpSetMode(m) { hcPrefSet('chirpMode', 'chirpMode', m); chirpBroadcast(); renderChirpPanel(); }

// ---- tones (Nextel-ish chirps, synthesized) ----
function chirpUnlockAudio() {
  try { chirpCtx = chirpCtx || new (window.AudioContext || window.webkitAudioContext)(); if (chirpCtx.state === 'suspended') chirpCtx.resume(); } catch (e) {}
}
function chirpTone(kind) {
  try {
    chirpUnlockAudio(); if (!chirpCtx) return;
    const seq = kind === 'go'  ? [[1180, 0, .05], [1620, .05, .07]]      // you got the floor
             : kind === 'rx'  ? [[1620, 0, .05], [2000, .06, .08]]      // incoming
             : /* end */        [[900, 0, .06]];
    for (const [f, off, dur] of seq) {
      const o = chirpCtx.createOscillator(), g = chirpCtx.createGain();
      o.type = 'square'; o.frequency.value = f; o.connect(g); g.connect(chirpCtx.destination);
      const t = chirpCtx.currentTime + off;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.16, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.start(t); o.stop(t + dur + 0.02);
    }
  } catch (e) {}
}

// ---- presence (who's clocked in + on which line) ----
function subscribeChirp() {
  if (!me) return;
  const ch = sb.channel('chirp-net', { config: { presence: { key: me.id } } });
  chirpNet = ch;
  ch.on('presence', { event: 'sync' }, () => {
    const state = ch.presenceState ? ch.presenceState() : {};
    const peers = new Map();
    for (const key of Object.keys(state)) {
      const meta = state[key][0]; if (!meta || meta.user_id === me.id) continue;
      peers.set(meta.user_id, meta);
    }
    chirpPeers = peers;
    renderChirpPanel();
    chirpAutoAnswer();
  }).subscribe(async (status) => { if (status === 'SUBSCRIBED') await chirpBroadcast(); });
}
async function chirpBroadcast() {
  if (!chirpNet) return;
  try {
    await chirpNet.track({
      user_id: me.id, name: me.display_name || me.username,
      avatar_url: me.avatar_url, avatar_color: me.avatar_color,
      mode: chirpEffMode(), line: chirpLineCid || null,
    });
  } catch (e) {}
}

// someone on a DM or crew I belong to just opened a line → auto-join it muted so I hear them live
async function chirpAutoAnswer() {
  if (chirpEffMode() === 'off') return;              // I'm clocked out → unreachable
  if (chirpLineCid || chirpConnecting) return;       // already on a line
  for (const [uid, meta] of chirpPeers) {
    if (!meta.line) continue;
    const cid = meta.line;
    let ok = memberships.has(cid);                    // works for DMs AND crews I'm a member of
    if (!ok) { const c = channels.get(cid); ok = !!(c && c.dm_key && c.dm_key.split(':').includes(me.id)); }
    if (!ok) {                                        // brand-new DM not yet local → verify once
      try { const { data } = await sb.from('channels').select('id,dm_key,type').eq('id', cid).single();
        if (data && data.dm_key && data.dm_key.split(':').includes(me.id)) { channels.set(cid, data); ok = true; } } catch (e) {}
    }
    if (ok) { chirpOpenLine(cid, true); return; }
  }
}

// ---- the Chirp tab ----
function openChirpTab() { renderChirpPanel(); chirpApplyGate(); if (!chirpLineCid) chirpShowIdle(); }
function chirpApplyGate() {
  const g = $('chirp-gate'); if (g) g.classList.toggle('hidden', chirpClockedIn());
}
function chirpShowIdle() { const i = $('chirp-idle'), l = $('chirp-line'); if (i) i.classList.remove('hidden'); if (l) l.classList.add('hidden'); }

function chirpPeopleList() {
  // team + client + vendor contacts you can reach — everyone but me
  return pickerPeople();
}
function renderChirpPanel() {
  const host = $('panel-chirp'); if (!host) return;
  const ci = chirpClockedIn(), mode = chirpMode();
  const sb1 = document.createElement('div'); sb1.className = 'chirp-status';
  /* Status toggle (replaces the old Clock in / clock out button — same
     underlying on-shift state and presence behavior, just an on/off switch). */
  const clockRow = document.createElement('div'); clockRow.className = 'chirp-clock chirp-togglerow';
  const lbl = document.createElement('span'); lbl.className = 'chirp-togglelbl'; lbl.textContent = 'Chirp';
  const tgl = document.createElement('button');
  tgl.className = 'chirp-toggle' + (ci ? ' on' : '');
  tgl.title = ci ? 'Turn Chirp off' : 'Turn Chirp on';
  tgl.setAttribute('aria-pressed', ci ? 'true' : 'false');
  const knob = document.createElement('span'); knob.className = 'knob'; tgl.appendChild(knob);
  tgl.onclick = () => chirpSetClock(!ci);
  const st = document.createElement('span'); st.className = 'chirp-tglstate' + (ci ? ' on' : ''); st.textContent = ci ? 'On' : 'Off';
  clockRow.appendChild(lbl); clockRow.appendChild(tgl); clockRow.appendChild(st); sb1.appendChild(clockRow);
  if (ci) { const c = chirpClock(); const sh = document.createElement('div'); sh.className = 'chirp-shift';
    const t = c.since ? new Date(c.since) : null;
    sh.textContent = t ? ('On since ' + t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })) : 'On';
    sb1.appendChild(sh); }
  const modes = document.createElement('div'); modes.className = 'chirp-modes' + (ci ? '' : ' disabled');
  [['avail', 'Available', 'avail'], ['quiet', 'Quiet', 'quiet']].forEach(([m, lbl, cls]) => {
    const b = document.createElement('button'); b.className = 'chirp-mode ' + cls + (mode === m ? ' sel' : '');
    b.innerHTML = '<span class="dot ' + cls + '"></span>' + lbl;
    b.onclick = () => chirpSetMode(m); modes.appendChild(b);
  });
  sb1.appendChild(modes);
  host.innerHTML = ''; host.appendChild(sb1);

  // ---- People: collapsible fold, available pulled to top, unavailable grayed ----
  const rank = { avail: 0, quiet: 1, off: 2 };
  const people = chirpPeopleList()
    .map(p => { const peer = chirpPeers.get(p.id); return { ...p, av: (peer && peer.mode) ? peer.mode : 'off' }; })
    .sort((a, b) => (rank[a.av] - rank[b.av]) || a.name.localeCompare(b.name));
  const availCount = people.filter(p => p.av !== 'off').length;
  const collapsed = hcPref('chirpPeopleCollapsed', 'chirpPeopleCollapsed', '0') === '1';

  const head = document.createElement('div'); head.className = 'chirp-phead chirp-fold chirp-folderhead' + (collapsed ? ' collapsed' : '');
  head.innerHTML = '<span class="chirp-chev">▾</span> 📁 Team <span class="chirp-availct">' + availCount + ' available</span>';
  host.appendChild(head);
  const listWrap = document.createElement('div'); listWrap.className = 'chirp-plist-wrap' + (collapsed ? ' hidden' : '');
  host.appendChild(listWrap);
  head.onclick = () => { const now = !listWrap.classList.contains('hidden'); listWrap.classList.toggle('hidden', now); head.classList.toggle('collapsed', now); hcPrefSet('chirpPeopleCollapsed', 'chirpPeopleCollapsed', now ? '1' : '0'); };

  if (!people.length) { const e = document.createElement('div'); e.className = 'chirp-empty'; e.textContent = 'No teammates yet.'; listWrap.appendChild(e); }
  for (const p of people) {
    const av = p.av;   // avail | quiet | off
    const row = document.createElement('div'); row.className = 'chirp-prow' + (chirpPeerId === p.id ? ' active' : '') + (av === 'off' ? ' chirp-unavail' : '');
    const dot = document.createElement('span'); dot.className = 'chirp-adot ' + av; dot.title = av === 'avail' ? 'Available' : av === 'quiet' ? 'Quiet' : 'Off';
    row.appendChild(dot);
    row.appendChild(avatarEl({ display_name: p.name, username: p.username, avatar_url: p.avatar_url, avatar_color: p.avatar_color }, 'avatar'));
    const meta = document.createElement('div'); meta.className = 'chirp-pmeta';
    const nm = document.createElement('div'); nm.className = 'chirp-pname'; nm.textContent = p.name;
    const sub = document.createElement('div'); sub.className = 'chirp-psub'; sub.textContent = av === 'avail' ? 'Available' : av === 'quiet' ? 'Quiet' : (p.sub || 'Off');
    meta.appendChild(nm); meta.appendChild(sub); row.appendChild(meta);
    const peer = chirpPeers.get(p.id);
    if (peer && peer.line && peer.line === chirpLineCid && chirpLineKind === 'dm') { const l = document.createElement('span'); l.className = 'chirp-plive'; l.textContent = 'LIVE'; row.appendChild(l); }
    row.onclick = () => chirpStartLine(p.id);
    listWrap.appendChild(row);
  }

  // ---- Crews (whole-channel broadcast) ----
  const crews = chirpCrewList();
  if (crews.length) {
    const chead = document.createElement('div'); chead.className = 'chirp-phead'; chead.textContent = 'Chirp a crew'; host.appendChild(chead);
    for (const c of crews) {
      const anyLive = [...chirpPeers.values()].some(p => p.line === c.id);
      const row = document.createElement('div'); row.className = 'chirp-prow' + (chirpLineCid === c.id ? ' active' : '');
      const ic = document.createElement('span'); ic.className = 'chirp-crewic'; ic.textContent = '📢'; row.appendChild(ic);
      const meta = document.createElement('div'); meta.className = 'chirp-pmeta';
      const nm = document.createElement('div'); nm.className = 'chirp-pname'; nm.textContent = c.label;
      const sub = document.createElement('div'); sub.className = 'chirp-psub'; sub.textContent = (c.count ? c.count + ' members' : 'Crew') + (anyLive ? ' · live now' : '');
      meta.appendChild(nm); meta.appendChild(sub); row.appendChild(meta);
      if (chirpLineCid === c.id) { const l = document.createElement('span'); l.className = 'chirp-plive'; l.textContent = 'LIVE'; row.appendChild(l); }
      else if (anyLive) { const l = document.createElement('span'); l.className = 'chirp-plive'; l.textContent = '●'; row.appendChild(l); }
      row.onclick = () => chirpStartGroup(c.id);
      host.appendChild(row);
    }
  }
}
// channels the user can broadcast to (real channels they're a member of / public), not DMs
function chirpCrewList() {
  const out = [];
  for (const c of channels.values()) {
    if (!c || c.type === 'dm') continue;
    if (!(memberships.has(c.id) || c.type === 'public')) continue;
    if (c.name === 'slackarchive') continue;
    out.push({ id: c.id, label: channelLabel(c), count: (huddleParticipants ? 0 : 0) });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

// you tapped a person → open a line to them
async function chirpStartLine(peerId) {
  if (!chirpClockedIn()) { railToast('Turn Chirp on to use it'); setNavTab('chirp'); chirpApplyGate(); return; }
  const peer = chirpPeers.get(peerId);
  if (peer && peer.mode === 'off') { railToast((profiles.get(peerId)?.display_name || 'They') + ' is clocked out'); return; }
  const cid = await chirpEnsureDm(peerId);
  if (!cid) { railToast('Could not open line'); return; }
  chirpOpenLine(cid, false);
}
// you tapped a crew → open a whole-channel line
function chirpStartGroup(cid) {
  if (!chirpClockedIn()) { railToast('Turn Chirp on to use it'); setNavTab('chirp'); chirpApplyGate(); return; }
  chirpOpenLine(cid, false);
}
async function chirpEnsureDm(otherId) {
  const key = [me.id, otherId].sort().join(':');
  let dm = [...channels.values()].find(c => c.dm_key === key);
  if (dm) return dm.id;
  const { data, error } = await sb.from('channels').insert({ type: 'dm', dm_key: key, created_by: me.id }).select().single();
  if (error) { const { data: ex } = await sb.from('channels').select('*').eq('dm_key', key).single(); if (ex) { channels.set(ex.id, ex); return ex.id; } return null; }
  channels.set(data.id, data);
  await sb.from('channel_members').insert([{ channel_id: data.id, user_id: me.id }, { channel_id: data.id, user_id: otherId }]);
  return data.id;
}

// connect to the line's LiveKit room (audio only, muted until you hold TALK)
// cid = a DM channel (1:1) or a real channel (crew broadcast) — kind is derived
async function chirpOpenLine(cid, incoming) {
  if (chirpLineCid === cid) { setNavTab('chirp'); return; }
  if (chirpLineCid) chirpHangup(true);
  const chan = channels.get(cid);
  chirpLineKind = (chan && chan.type !== 'dm') ? 'group' : 'dm';
  chirpPeerId = chirpLineKind === 'dm' ? dmMemberIds(chan || {}).find(id => id !== me.id) : null;
  chirpConnecting = true; chirpIncoming = !!incoming;
  chirpLineCid = cid;
  chirpRenderLine('connecting…');
  if (!incoming) setNavTab('chirp');
  chirpBroadcast();

  if (typeof LivekitClient === 'undefined') { chirpSetStatus('audio engine loading — reload', ''); chirpConnecting = false; return; }
  let token;
  try { const { data, error } = await sb.rpc('livekit_token', { p_channel: cid }); if (error || !data) throw (error || new Error('no token')); token = data; }
  catch (e) { chirpSetStatus('couldn\'t open line', ''); chirpConnecting = false; return; }

  const room = new LivekitClient.Room({ adaptiveStream: false, dynacast: false }); chirpRoom = room;
  const RE = LivekitClient.RoomEvent;
  room
    .on(RE.TrackSubscribed, (track) => {
      if (track.kind !== 'audio') return;
      try {
        const el = track.attach(); el.autoplay = true;
        const quiet = chirpMode() === 'quiet';
        el.muted = quiet;                       // Quiet = don't blast; user taps to listen
        el.id = 'chirp-audio'; document.body.appendChild(el);
        applyAudioOut(el);                      // saved speaker + volume
      } catch (e) {}
    })
    .on(RE.TrackUnsubscribed, (track) => { try { track.detach().forEach(el => el.remove()); } catch (e) {} })
    // peer talking / stopped, over the data channel
    .on(RE.DataReceived, (payload) => {
      try { const d = JSON.parse(new TextDecoder().decode(payload)); if (d && d.t === 'talk') chirpPeerTalking(!!d.on, d.name); } catch (e) {}
    })
    .on(RE.Disconnected, () => { if (chirpRoom === room) chirpHangup(); });
  try { await room.connect(LIVEKIT_URL, token); }
  catch (e) { chirpRoom = null; chirpConnecting = false; chirpSetStatus('connection failed — tap to retry', ''); return; }
  try { await room.localParticipant.setMicrophoneEnabled(false); } catch (e) {}   // start silent
  try { await applyMicPref(room); } catch (e) {}                                  // saved mic device
  chirpConnecting = false;
  chirpSetStatus(incoming ? 'on the line — listening' : 'connected — hold to talk', 'live');
  if (incoming) chirpShowIncomingBar(cid);
  renderChirpPanel();
}

function chirpRenderLine(status) {
  const i = $('chirp-idle'), l = $('chirp-line'); if (i) i.classList.add('hidden'); if (l) l.classList.remove('hidden');
  const avh = $('chirp-peer-av'), nm = $('chirp-peer-name');
  if (chirpLineKind === 'group') {
    const c = channels.get(chirpLineCid);
    if (avh) { avh.innerHTML = '<div class="avatar chirp-crew-av">📢</div>'; }
    if (nm) nm.textContent = c ? channelLabel(c) : 'Crew';
  } else {
    const p = profiles.get(chirpPeerId) || {};
    if (avh) { avh.innerHTML = ''; avh.appendChild(avatarEl({ display_name: p.display_name || 'Chirp', username: p.username, avatar_url: p.avatar_url, avatar_color: p.avatar_color }, 'avatar')); }
    if (nm) nm.textContent = p.display_name || p.username || 'Chirp';
  }
  chirpSetStatus(status || '', '');
}
function chirpSetStatus(text, cls) { const s = $('chirp-peer-status'); if (s) { s.textContent = text; s.className = 'chirp-peer-status' + (cls ? ' ' + cls : ''); } }

function chirpPeerTalking(on, talkerName) {
  const btn = $('chirp-ptt'), wave = $('chirp-wave'), lbl = $('chirp-ptt-lbl');
  if (on) {
    if (chirpMode() !== 'quiet') chirpTone('rx');
    if (btn && !chirpTalking) btn.classList.add('rx');
    if (wave) wave.classList.add('on');
    if (lbl && !chirpTalking) lbl.textContent = 'INCOMING';
    const who = talkerName || (profiles.get(chirpPeerId)?.display_name) || 'Someone';
    chirpSetStatus(who + ' is talking', 'rx');
  } else {
    if (btn) btn.classList.remove('rx');
    if (wave && !chirpTalking) wave.classList.remove('on');
    if (lbl && !chirpTalking) lbl.textContent = 'HOLD TO TALK';
    chirpSetStatus('on the line', 'live');
  }
}

// ---- push to talk ----
async function chirpStartTalk() {
  if (!chirpRoom || chirpTalking || !chirpClockedIn()) return;
  chirpTalking = true;
  const btn = $('chirp-ptt'), lbl = $('chirp-ptt-lbl'), wave = $('chirp-wave');
  if (btn) { btn.classList.add('talking'); btn.classList.remove('rx'); }
  if (lbl) lbl.textContent = 'TALKING…';
  if (wave) wave.classList.add('on');
  chirpTone('go');
  chirpSetStatus('you\'re live', 'live');
  try { await chirpRoom.localParticipant.setMicrophoneEnabled(true); } catch (e) {}
  chirpSignal(true);
}
async function chirpStopTalk() {
  if (!chirpTalking) return;
  chirpTalking = false;
  const btn = $('chirp-ptt'), lbl = $('chirp-ptt-lbl'), wave = $('chirp-wave');
  try { if (chirpRoom) await chirpRoom.localParticipant.setMicrophoneEnabled(false); } catch (e) {}
  chirpSignal(false);
  chirpTone('end');
  if (btn) btn.classList.remove('talking');
  if (lbl) lbl.textContent = 'HOLD TO TALK';
  if (wave) wave.classList.remove('on');
  chirpSetStatus('on the line', 'live');
}
function chirpSignal(on) {
  try { if (chirpRoom) chirpRoom.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ t: 'talk', on, name: (me.display_name || me.username || 'Someone') })), { reliable: true }); } catch (e) {}
}

function chirpHangup(silent) {
  chirpTalking = false;
  try { if (chirpRoom) chirpRoom.disconnect(); } catch (e) {}
  chirpRoom = null;
  const prev = chirpLineCid; chirpLineCid = null; chirpPeerId = null; chirpIncoming = false; chirpLineKind = 'dm';
  try { const a = document.getElementById('chirp-audio'); if (a) a.remove(); } catch (e) {}
  chirpHideIncomingBar();
  if (!silent) { chirpBroadcast(); chirpShowIdle(); renderChirpPanel(); }
}

// ---- incoming floating bar (when a line auto-answers while you're elsewhere) ----
function chirpShowIncomingBar(cid) {
  if (navTab === 'chirp') return;      // already looking at it
  chirpHideIncomingBar();
  const chan = channels.get(cid);
  const isGroup = chan && chan.type !== 'dm';
  const bar = document.createElement('div'); bar.id = 'chirp-incoming'; bar.className = 'chirp-incoming';
  let label;
  if (isGroup) {
    bar.appendChild(Object.assign(document.createElement('div'), { className: 'avatar chirp-crew-av', textContent: '📢' }));
    label = channelLabel(chan);
  } else {
    const p = profiles.get(chirpPeerId) || {};
    bar.appendChild(avatarEl({ display_name: p.display_name || 'Chirp', username: p.username, avatar_url: p.avatar_url, avatar_color: p.avatar_color }, 'avatar'));
    label = p.display_name || 'Someone';
  }
  const txt = document.createElement('div'); txt.className = 'chirp-inc-txt';
  txt.innerHTML = '<b>' + esc(label) + '</b> opened a Chirp ' + (isGroup ? 'crew line' : 'line') + (chirpMode() === 'quiet' ? ' · quiet' : '');
  bar.appendChild(txt);
  const open = document.createElement('button'); open.className = 'chirp-inc-open'; open.textContent = 'Open';
  open.onclick = () => { chirpHideIncomingBar(); setNavTab('chirp'); chirpRenderLine('on the line'); chirpSetStatus('on the line', 'live'); const a = document.getElementById('chirp-audio'); if (a) a.muted = false; };
  bar.appendChild(open);
  const x = document.createElement('button'); x.className = 'chirp-inc-x'; x.textContent = '✕'; x.title = 'Leave line';
  x.onclick = () => chirpHangup();
  bar.appendChild(x);
  document.body.appendChild(bar);
}
function chirpHideIncomingBar() { const b = document.getElementById('chirp-incoming'); if (b) b.remove(); }

// ---- wire PTT button + spacebar + hangup ----
(function wireChirp() {
  const bind = () => {
    const btn = $('chirp-ptt');
    if (btn && !btn._wired) {
      btn._wired = true;
      const down = (e) => { e.preventDefault(); chirpStartTalk(); };
      const up = (e) => { e.preventDefault(); chirpStopTalk(); };
      btn.addEventListener('mousedown', down); btn.addEventListener('touchstart', down, { passive: false });
      window.addEventListener('mouseup', up); btn.addEventListener('touchend', up); btn.addEventListener('touchcancel', up);
      btn.addEventListener('mouseleave', () => { if (chirpTalking) chirpStopTalk(); });
    }
    const hg = $('chirp-hangup'); if (hg && !hg._wired) { hg._wired = true; hg.onclick = () => chirpHangup(); }
    const gci = $('chirp-gate-clockin'); if (gci && !gci._wired) { gci._wired = true; gci.onclick = () => { chirpSetClock(true); openChirpTab(); }; }
  };
  bind();
  // spacebar = PTT while on the Chirp tab and a line is open
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && navTab === 'chirp' && chirpLineCid && !e.repeat) {
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault(); chirpStartTalk();
    }
  });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space' && chirpTalking) { e.preventDefault(); chirpStopTalk(); } });
  // rebind whenever the tab is (re)shown
  const _origSetNav = null; // handled by openChirpTab calling bind via renderChirpPanel? ensure bind runs:
  document.addEventListener('click', (e) => { if (e.target && e.target.closest && e.target.closest('.rail-btn[data-tab="chirp"]')) setTimeout(bind, 0); });
})();
window.addEventListener('beforeunload', () => { if (chirpLineCid) { try { if (chirpRoom) chirpRoom.disconnect(); } catch (e) {} } });

// Eagerly initialize MSAL on every load. The OAuth sign-in popup lands back on THIS
// app (the redirect URI is the app root); MSAL must be instantiated in that popup to
// recognize the returned #code, hand it to the opener, and auto-close. Without this,
// the popup would just render the full app and sit there.
(function initMsalEarly() {
  try {
    if (!emailConfigured() || typeof msal === 'undefined') return;
    const app = ensureMsal();
    if (app && app.handleRedirectPromise) app.handleRedirectPromise().catch(() => {});
  } catch (e) {}
})();

// ---------- Go ----------
// HIVECONNECT MERGE — the only line changed anywhere in this transplanted file
// (replaces the original bare `boot();` call). Primes the Supabase client with
// a session minted by HiveLogic's isolated auth bridge (see
// /public/hiveconnect-mount.js) BEFORE boot() checks for a session, so no
// second login screen ever shows. If no bridged session was provided (e.g.
// this file is ever loaded standalone again), this is a no-op and boot()
// behaves exactly as it always did.
(async function(){
  var bridged = window.__hiveconnectBridgedSession;
  if (!bridged) { boot(); return; }   // standalone: behave exactly as before

  /* Chris, 2026-08-23: "it flashes Hiveconnect, then immediately goes to the
     sign in screen and then loads hiveconnect".
     
     That sign-in screen is HiveConnect's own, and it should never have been
     reachable from inside HiveLogic. This used to be:
     
         await sb.auth.setSession(bridged).catch(function(){});
         boot();
     
     A swallowed catch. When setSession failed, boot() looked for a session,
     found none, and revealed the login screen -- then onAuthStateChange fired
     a moment later and loaded the app over the top of it. Hence the flicker.
     
     Showing that screen is worse than ugly: HiveConnect is a SEPARATE Supabase
     project, so his HiveLogic email and password are not credentials here. A
     login box he cannot log into is not a fallback, it is a dead end. */
  window.__hiveconnectBridging = true;
  var applied = await applyBridgedSession(bridged);
  window.__hiveconnectBridging = false;

  if (applied) { boot(); return; }

  // Say what happened, where he is looking, instead of a login box he cannot
  // use. The mount leaves HiveLogic's own session alone either way.
  if (authScreen) authScreen.classList.add('hidden');
  bridgeFailureNotice();
})();

/* One retry, because the failure this fixes is a timing one.
 *
 * The session is minted through a single-use magic link (see
 * api/hiveconnect-bridge.js and the otp_expired note in
 * hiveconnect-mount.js), and a token that has just been spent or has just
 * aged out fails once and succeeds on a freshly-read one. Retrying blind
 * would be guessing; this re-reads the session afterwards and only calls it
 * applied when the client agrees there IS one. */
async function applyBridgedSession(bridged) {
  for (var attempt = 0; attempt < 2; attempt++) {
    var res = await sb.auth.setSession(bridged).catch(function (e) { return { error: e }; });
    if (!(res && res.error)) {
      // setSession resolving is not the same as a session existing.
      var check = await sb.auth.getSession().catch(function () { return null; });
      if (check && check.data && check.data.session) return true;
    } else {
      window.__hiveconnectBridgeError = String((res.error && res.error.message) || res.error);
    }
    if (attempt === 0) await new Promise(function (r) { setTimeout(r, 400); });
  }
  return false;
}

function bridgeFailureNotice() {
  var host = document.getElementById('app') || document.body;
  if (!host) return;
  var why = window.__hiveconnectBridgeError ? (' (' + window.__hiveconnectBridgeError + ')') : '';
  var box = document.createElement('div');
  box.id = 'hc-bridge-failed';
  box.style.cssText = 'padding:22px;max-width:520px;margin:40px auto;border:1px solid var(--line,#e3e8f0);'
    + 'border-radius:12px;font:14px/1.5 system-ui,sans-serif';
  box.innerHTML = '<div style="font-weight:700;margin-bottom:6px">HiveConnect could not open</div>'
    + '<div style="opacity:.8">Your HiveLogic session is fine — this is the hand-off to HiveConnect that '
    + 'failed' + escapeHtml(why) + '. Reload the page to try again.</div>';
  host.classList.remove('hidden');
  host.appendChild(box);
}
