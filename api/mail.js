// /api/mail — server-side IMAP/SMTP mail for HiveConnect ("add any email
// account": Gmail, iCloud, Yahoo, AOL, custom domains).
//
// WHY THIS EXISTS: browsers can't speak IMAP/SMTP, and providers like iCloud /
// Yahoo / AOL offer no OAuth — only an app-specific password over IMAP/SMTP.
// This route connects on the user's behalf: it stores the app password
// ENCRYPTED (api/_lib/secrets.js, AES-256-GCM, key only in Vercel env
// TOKEN_ENC_KEY — never in the DB), and on each request opens a short-lived
// IMAP/SMTP connection (connect → do → logout). No persistent connection, so
// it runs on Vercel serverless with no extra infra.
//
// It is a sibling to /api/msmail (Microsoft), NOT a replacement. The frontend
// keeps Microsoft mailboxes on the Graph path untouched; IMAP mailboxes carry
// provider:'imap' and route their Graph-shaped calls here via ?action=graph,
// which translates the Graph-ish path into IMAP/SMTP and returns Graph-shaped
// JSON so app.js's existing renderers work with no changes.
//
// Actions (all POST, JWT in Authorization: Bearer — hc OR main realm):
//   health          -> {configured, providers}
//   add_account      -> {provider,email,password,[host/port overrides]} verify + store
//   accounts         -> list this user's IMAP mailboxes (MSAL-account shaped)
//   remove_account   -> {homeAccountId|email} disconnect
//   graph            -> {account, path, method, body} Graph-shape adapter
//
// Env: HIVECONNECT_SUPABASE_URL/_SERVICE_KEY (+ SUPABASE_URL/_SERVICE_KEY for
// the embedded/main realm), TOKEN_ENC_KEY (required to store passwords).

const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const { simpleParser } = require('mailparser');

// ---------- Google "Sign in with Google" (OAuth2 / XOAUTH2 over IMAP+SMTP) ----------
// Gmail's smooth path: the user clicks Sign in with Google, approves on
// Google's own page, and we store an encrypted refresh token (no password).
// We mint short-lived access tokens on demand and connect to Gmail's IMAP/SMTP
// with XOAUTH2. Requires Vercel env GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET and
// the redirect URI below registered on the Google OAuth client.
const GOOGLE = {
  clientId: (process.env.GOOGLE_CLIENT_ID || '').trim(),
  clientSecret: (process.env.GOOGLE_CLIENT_SECRET || '').trim(),
  redirect: 'https://hivelogic-live.vercel.app/api/mail',
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  scope: 'https://mail.google.com/ openid email',
};
function googleConfigured() { return !!(GOOGLE.clientId && GOOGLE.clientSecret); }
function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function decodeJwt(jwt) { try { return JSON.parse(Buffer.from(String(jwt).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch (e) { return {}; } }
function ghmac(s) { return crypto.createHmac('sha256', GOOGLE.clientSecret || 'x').update(s).digest('hex'); }
function makeGState(uid, realm) { const ts = Date.now().toString(); const nonce = crypto.randomBytes(9).toString('hex'); const p = `${uid}.${realm}.${ts}.${nonce}`; return Buffer.from(`${p}.${ghmac(p)}`, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function readGState(state) {
  try {
    const parts = Buffer.from(String(state).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8').split('.');
    const sig = parts.pop(); const [uid, realm, ts, nonce] = parts;
    if (!uid || !realm || !ts || !nonce || !sig || !REALMS[realm]) return null;
    if (ghmac(`${uid}.${realm}.${ts}.${nonce}`) !== sig) return null;
    if (Date.now() - Number(ts) > 15 * 60 * 1000) return null;
    return { uid, realm };
  } catch (e) { return null; }
}
async function googleAccessToken(refreshToken) {
  const body = new URLSearchParams({ client_id: GOOGLE.clientId, client_secret: GOOGLE.clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken });
  const r = await fetch(GOOGLE.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) { const e = new Error(j.error_description || j.error || ('google token ' + r.status)); e.google = j; throw e; }
  return j.access_token;
}

// ---------- provider presets ----------
const PRESETS = {
  gmail:  { imap_host: 'imap.gmail.com',       imap_port: 993, imap_secure: true,  smtp_host: 'smtp.gmail.com',       smtp_port: 465, smtp_secure: true,  label: 'Gmail' },
  icloud: { imap_host: 'imap.mail.me.com',     imap_port: 993, imap_secure: true,  smtp_host: 'smtp.mail.me.com',     smtp_port: 587, smtp_secure: false, label: 'iCloud' },
  yahoo:  { imap_host: 'imap.mail.yahoo.com',  imap_port: 993, imap_secure: true,  smtp_host: 'smtp.mail.yahoo.com',  smtp_port: 465, smtp_secure: true,  label: 'Yahoo' },
  aol:    { imap_host: 'imap.aol.com',         imap_port: 993, imap_secure: true,  smtp_host: 'smtp.aol.com',         smtp_port: 465, smtp_secure: true,  label: 'AOL' },
  imap:   { imap_host: '',                     imap_port: 993, imap_secure: true,  smtp_host: '',                     smtp_port: 465, smtp_secure: true,  label: 'Other (IMAP)' },
};

// ---------- realms (same dual-project model as msmail.js) ----------
const REALMS = {
  hc:   { url: process.env.HIVECONNECT_SUPABASE_URL, key: process.env.HIVECONNECT_SUPABASE_SERVICE_KEY },
  main: { url: process.env.SUPABASE_URL,             key: process.env.SUPABASE_SERVICE_KEY },
};
function configured() { return !!((REALMS.hc.url && REALMS.hc.key) || (REALMS.main.url && REALMS.main.key)); }

// secrets.js is ESM; this file is CommonJS — dynamic import (same as msmail.js).
async function getSecretsLib() { return import('./_lib/secrets.js'); }

// ---------- Supabase REST (service role, per realm) ----------
async function dbFetch(realm, path, opts = {}) {
  const R = REALMS[realm];
  const r = await fetch(R.url + path, {
    method: opts.method || 'GET',
    headers: Object.assign({ apikey: R.key, Authorization: 'Bearer ' + R.key, 'Content-Type': 'application/json' }, opts.headers || {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 204) return null;
  const text = await r.text();
  let j = null; try { j = text ? JSON.parse(text) : null; } catch (e) {}
  if (!r.ok) throw new Error(`supabase ${r.status}: ${text.slice(0, 200)}`);
  return j;
}

async function requireUser(req) {
  const auth = req.headers.authorization || '';
  const jwt = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!jwt) return null;
  for (const realm of ['hc', 'main']) {
    const R = REALMS[realm];
    if (!R.url || !R.key) continue;
    try {
      const r = await fetch(R.url + '/auth/v1/user', { headers: { apikey: R.key, Authorization: 'Bearer ' + jwt } });
      if (!r.ok) continue;
      const u = await r.json().catch(() => null);
      if (u && u.id) return { uid: u.id, realm };
    } catch (e) {}
  }
  return null;
}

// ---------- small helpers ----------
function b64urlEncode(s) { return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64urlDecode(s) { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); }
function accountId(email) { return 'imap:' + email.toLowerCase(); }
function accountShape(row) {
  return { homeAccountId: accountId(row.email_address), username: row.email_address, name: row.display_name || row.email_address, provider: 'imap' };
}
function esc(v) { return encodeURIComponent(v); }

// Graph well-known folder id  <->  IMAP special-use / path
const WELL_KNOWN = {
  inbox: 'INBOX',
  sentitems: '\\Sent',
  drafts: '\\Drafts',
  deleteditems: '\\Trash',
  junkemail: '\\Junk',
  archive: '\\Archive',
};
function graphFolderId(folder) {
  if (String(folder.path).toUpperCase() === 'INBOX') return 'inbox';
  const su = folder.specialUse || '';
  for (const [gid, tag] of Object.entries(WELL_KNOWN)) { if (gid !== 'inbox' && su === tag) return gid; }
  return 'imf_' + b64urlEncode(folder.path);
}
function resolveFolderPath(folderId, folderList) {
  if (!folderId || folderId === 'inbox') return 'INBOX';
  if (folderId.startsWith('imf_')) return b64urlDecode(folderId.slice(4));
  const tag = WELL_KNOWN[folderId];
  if (tag) { const f = (folderList || []).find(x => (x.specialUse || '') === tag); if (f) return f.path; }
  return folderId; // fall back to a literal path
}

// ---------- IMAP connection ----------
// creds is { pass } for app-password accounts or { accessToken } for OAuth.
function imapAuth(acct, creds) {
  const user = acct.username || acct.email_address;
  return creds.accessToken ? { user, accessToken: creds.accessToken } : { user, pass: creds.pass };
}
function smtpAuth(acct, creds) {
  const user = acct.username || acct.email_address;
  return creds.accessToken ? { type: 'OAuth2', user, accessToken: creds.accessToken } : { user, pass: creds.pass };
}
async function openImap(acct, creds) {
  const client = new ImapFlow({
    host: acct.imap_host, port: acct.imap_port, secure: !!acct.imap_secure,
    auth: imapAuth(acct, creds),
    logger: false, emitLogs: false,
  });
  await client.connect();
  return client;
}
// Resolve the live credential (decrypt app password, or mint a fresh Google
// access token from the stored refresh token) right before connecting.
async function resolveCreds(acct) {
  const { decryptSecret } = await getSecretsLib();
  if (acct.auth_type === 'oauth') {
    const refresh = decryptSecret(acct.oauth_refresh_enc);
    return { accessToken: await googleAccessToken(refresh) };
  }
  return { pass: decryptSecret(acct.app_password_enc) };
}

// ---------- Graph-shape mappers ----------
function addr(a) { return a ? { name: a.name || '', address: (a.address || '').toLowerCase() } : null; }
function addrList(arr) { return (arr || []).map(a => ({ emailAddress: addr(a) })).filter(x => x.emailAddress); }
function flagHas(flags, name) { return flags && flags.has ? flags.has(name) : (Array.isArray(flags) && flags.indexOf(name) !== -1); }
function toIso(d) { const x = d instanceof Date ? d : (d ? new Date(d) : new Date()); return isNaN(x) ? new Date().toISOString() : x.toISOString(); }
function envToMessage(path, msg) {
  const env = msg.envelope || {};
  const flags = msg.flags || new Set();
  return {
    id: 'im_' + b64urlEncode(path + '\n' + msg.uid),
    subject: env.subject || '(no subject)',
    from: env.from && env.from[0] ? { emailAddress: addr(env.from[0]) } : { emailAddress: { name: '', address: '' } },
    toRecipients: addrList(env.to),
    ccRecipients: addrList(env.cc),
    receivedDateTime: toIso(msg.internalDate || env.date),
    isRead: flagHas(flags, '\\Seen'),
    bodyPreview: '',
    hasAttachments: hasAttachments(msg.bodyStructure),
    flag: { flagStatus: flagHas(flags, '\\Flagged') ? 'flagged' : 'notFlagged' },
    conversationId: env.messageId || ('im_' + msg.uid),
    categories: [],
    inferenceClassification: 'focused',
  };
}
function hasAttachments(struct) {
  if (!struct) return false;
  const walk = (n) => {
    if (!n) return false;
    if (n.disposition && String(n.disposition).toLowerCase() === 'attachment') return true;
    if (Array.isArray(n.childNodes)) return n.childNodes.some(walk);
    return false;
  };
  return walk(struct);
}

// ---------- IMAP search ----------
// Graph answers $search from a server-side index. IMAP has SEARCH, which is
// the real equivalent: the server reads every message in the folder, so a hit
// is a hit no matter how old, and body text counts -- something the envelope
// list here can never do, since bodyPreview comes back empty over IMAP.
const SEARCH_BUDGET_MS = 15000; // stop opening folders after this and say so
const SEARCH_MAX_FOLDERS = 8;
// Which folders a mailbox-wide search covers. Gmail-style accounts expose an
// \\All folder that already holds every message, so one SELECT is the whole
// mailbox. Everyone else gets Inbox, Sent, Archive, then whatever else fits --
// minus Trash and Junk, which are noise in a search for real mail.
function searchFolderPaths(folders) {
  const selectable = (folders || []).filter(f => !(f.flags && f.flags.has && f.flags.has('\\Noselect')));
  const all = selectable.find(f => (f.specialUse || '') === '\\All');
  if (all) return [all.path];
  const rank = (f) => {
    if (String(f.path).toUpperCase() === 'INBOX') return 0;
    const su = f.specialUse || '';
    return su === '\\Sent' ? 1 : (su === '\\Archive' ? 2 : 3);
  };
  return selectable
    .filter(f => ['\\Trash', '\\Junk'].indexOf(f.specialUse || '') === -1)
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, SEARCH_MAX_FOLDERS)
    .map(f => f.path);
}
// SUBJECT/FROM/TO/BODY rather than IMAP TEXT: TEXT matches the raw MIME, so a
// base64 attachment "contains" almost any word you care to search for.
async function searchFolder(client, path, q, top) {
  const lock = await client.getMailboxLock(path);
  try {
    const uids = await client.search({ or: [{ subject: q }, { from: q }, { to: q }, { body: q }] }, { uid: true });
    if (!uids || !uids.length) return [];
    const newest = uids.slice(-top); // UIDs ascend with arrival, so the tail is the newest
    const out = [];
    for await (const msg of client.fetch(newest.join(','), { uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: true }, { uid: true })) {
      out.push(envToMessage(path, msg));
    }
    return out;
  } finally { lock.release(); }
}


// ---------- the Graph-shape adapter ----------
// Translates a subset of Microsoft Graph mail paths into IMAP/SMTP operations.
async function graphAdapter(acct, creds, path, method, body) {
  method = (method || 'GET').toUpperCase();
  const clean = String(path).split('?')[0];
  const query = String(path).indexOf('?') >= 0 ? String(path).slice(String(path).indexOf('?') + 1) : '';
  const qp = new URLSearchParams(query);

  // POST /me/sendMail  -> SMTP send (as the user's own mailbox)
  if (method === 'POST' && /\/me\/sendMail$/.test(clean)) {
    return sendMail(acct, creds, (body && body.message) || {});
  }

  const client = await openImap(acct, creds);
  try {
    const folders = await client.list();

    // GET /me/mailFolders  -> folder list with counts
    if (method === 'GET' && /\/me\/mailFolders$/.test(clean)) {
      const value = [];
      for (const f of folders) {
        if (f.flags && (f.flags.has ? f.flags.has('\\Noselect') : false)) continue;
        let total = 0, unread = 0;
        try { const st = await client.status(f.path, { messages: true, unseen: true }); total = st.messages || 0; unread = st.unseen || 0; } catch (e) {}
        const gid = graphFolderId(f);
        value.push({ id: gid, displayName: f.name || f.path, wellKnownName: gid.startsWith('imf_') ? null : gid, totalItemCount: total, unreadItemCount: unread });
      }
      return { value };
    }


    // GET /me/messages?$search="q"                    -> search the mailbox
    // GET /me/mailFolders/{id}/messages?$search="q"   -> search one folder
    // Must be tested before the plain listing routes below, which share these
    // paths and would otherwise answer a search with the folder's newest page.
    const rawSearch = qp.get('$search');
    if (method === 'GET' && rawSearch && /\/me\/(messages|mailFolders\/[^/]+\/messages)$/.test(clean)) {
      const q = String(rawSearch).replace(/^"|"$/g, '').trim();
      const top = Math.min(parseInt(qp.get('$top') || '30', 10) || 30, 50);
      if (!q) return { value: [] };
      const fm = clean.match(/\/me\/mailFolders\/([^/]+)\/messages$/);
      const paths = fm ? [resolveFolderPath(decodeURIComponent(fm[1]), folders)] : searchFolderPaths(folders);
      const deadline = Date.now() + SEARCH_BUDGET_MS;
      let hits = [], searched = 0, partial = false;
      for (const p of paths) {
        if (Date.now() > deadline) { partial = true; break; }
        // One folder that refuses to open must not lose the folders that did.
        try { hits = hits.concat(await searchFolder(client, p, q, top)); searched++; }
        catch (e) { partial = true; }
      }
      hits.sort((a, b) => new Date(b.receivedDateTime || 0) - new Date(a.receivedDateTime || 0));
      return { value: hits.slice(0, top), __search: { folders: searched, of: paths.length, partial } };
    }

    // GET /me/mailFolders/{id}/messages  -> newest N envelopes in that folder
    let m = clean.match(/\/me\/mailFolders\/([^/]+)\/messages$/);
    if (method === 'GET' && m) {
      const folderId = decodeURIComponent(m[1]);
      const p = resolveFolderPath(folderId, folders);
      const top = Math.min(parseInt(qp.get('$top') || '25', 10) || 25, 50);
      const lock = await client.getMailboxLock(p);
      try {
        const exists = client.mailbox && client.mailbox.exists ? client.mailbox.exists : 0;
        if (!exists) return { value: [] };
        const start = Math.max(1, exists - top + 1);
        const out = [];
        for await (const msg of client.fetch(`${start}:${exists}`, { uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: true })) {
          out.push(envToMessage(p, msg));
        }
        out.reverse(); // newest first
        return { value: out };
      } finally { lock.release(); }
    }

    // GET /me/messages/{id}  -> one full message (body + parsed)
    m = clean.match(/\/me\/messages\/([^/]+)$/);
    if (method === 'GET' && m) {
      const { path: p, uid } = decodeMsgId(decodeURIComponent(m[1]));
      const lock = await client.getMailboxLock(p);
      try {
        const msg = await client.fetchOne(String(uid), { source: true, flags: true, envelope: true, internalDate: true }, { uid: true });
        if (!msg || !msg.source) throw new Error('message not found');
        const parsed = await simpleParser(msg.source);
        const flags = msg.flags || new Set();
        return {
          id: 'im_' + b64urlEncode(p + '\n' + uid),
          subject: parsed.subject || '(no subject)',
          from: { emailAddress: parsed.from && parsed.from.value && parsed.from.value[0] ? { name: parsed.from.value[0].name || '', address: (parsed.from.value[0].address || '').toLowerCase() } : { name: '', address: '' } },
          toRecipients: parsedAddrList(parsed.to),
          ccRecipients: parsedAddrList(parsed.cc),
          receivedDateTime: toIso(msg.internalDate || parsed.date),
          isRead: flagHas(flags, '\\Seen'),
          hasAttachments: !!(parsed.attachments && parsed.attachments.length),
          flag: { flagStatus: flagHas(flags, '\\Flagged') ? 'flagged' : 'notFlagged' },
          conversationId: parsed.messageId || ('im_' + uid),
          categories: [],
          inferenceClassification: 'focused',
          // Graph's shape for raw headers. Reina reads List-Unsubscribe out of
          // this to tell a mailing list you can leave from spam you cannot.
          internetMessageHeaders: [...(parsed.headers || new Map()).entries()].map(([name, value]) => ({
            name,
            value: Array.isArray(value) ? value.join(', ') : String(value && value.text ? value.text : value),
          })),
          body: { contentType: parsed.html ? 'html' : 'text', content: parsed.html || parsed.textAsHtml || parsed.text || '' },
        };
      } finally { lock.release(); }
    }

    // GET /me/messages/{id}/attachments  -> attachment metadata + bytes
    m = clean.match(/\/me\/messages\/([^/]+)\/attachments$/);
    if (method === 'GET' && m) {
      const { path: p, uid } = decodeMsgId(decodeURIComponent(m[1]));
      const lock = await client.getMailboxLock(p);
      try {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        const parsed = await simpleParser(msg && msg.source ? msg.source : Buffer.from(''));
        const value = (parsed.attachments || []).map((a, i) => ({
          '@odata.type': '#microsoft.graph.fileAttachment',
          id: String(i), name: a.filename || ('attachment-' + i), contentType: a.contentType || 'application/octet-stream',
          size: a.size || (a.content ? a.content.length : 0),
          contentBytes: a.content ? a.content.toString('base64') : null,
          isInline: !!a.related, contentId: a.cid || null,
        }));
        return { value };
      } finally { lock.release(); }
    }

    // PATCH /me/messages/{id}  -> currently supports isRead
    m = clean.match(/\/me\/messages\/([^/]+)$/);
    if (method === 'PATCH' && m) {
      const { path: p, uid } = decodeMsgId(decodeURIComponent(m[1]));
      const lock = await client.getMailboxLock(p);
      try {
        if (body && body.isRead === true) await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
        if (body && body.isRead === false) await client.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true });
        if (body && body.flag && body.flag.flagStatus === 'flagged') await client.messageFlagsAdd(String(uid), ['\\Flagged'], { uid: true });
        if (body && body.flag && body.flag.flagStatus === 'notFlagged') await client.messageFlagsRemove(String(uid), ['\\Flagged'], { uid: true });
        return {};
      } finally { lock.release(); }
    }

    // POST /me/messages/{id}/move  -> file it somewhere else
    //
    // The adapter had no move at all, which is why the mail app could archive a
    // Microsoft message and silently could not touch a Gmail one. That matters
    // most for junk: Gmail is where the spam is, and Junk is the only folder
    // that teaches the provider's own filter.
    m = clean.match(/\/me\/messages\/([^/]+)\/move$/);
    if (method === 'POST' && m) {
      const { path: p, uid } = decodeMsgId(decodeURIComponent(m[1]));
      const folders = await client.list();
      const dest = resolveFolderPath(String((body && body.destinationId) || ''), folders);
      // A move to a folder this account does not have would silently do nothing
      // -- and the caller would report success on mail that never went anywhere.
      if (!dest || !folders.some((f) => f.path === dest)) {
        const e = new Error('this mailbox has no ' + ((body && body.destinationId) || 'such') + ' folder');
        e.status = 409; throw e;
      }
      const lock = await client.getMailboxLock(p);
      try {
        const moved = await client.messageMove(String(uid), dest, { uid: true });
        return { id: 'im_' + b64urlEncode(dest + '\n' + ((moved && moved.uidMap && [...moved.uidMap.values()][0]) || uid)) };
      } finally { lock.release(); }
    }

    // Unhandled Graph path — degrade gracefully instead of crashing the UI.
    return { value: [], __unsupported: clean };
  } finally {
    try { await client.logout(); } catch (e) {}
  }
}

function decodeMsgId(id) {
  const raw = id.startsWith('im_') ? b64urlDecode(id.slice(3)) : id;
  const nl = raw.lastIndexOf('\n');
  return { path: raw.slice(0, nl), uid: parseInt(raw.slice(nl + 1), 10) };
}
function parsedAddrList(field) {
  if (!field || !field.value) return [];
  return field.value.map(a => ({ emailAddress: { name: a.name || '', address: (a.address || '').toLowerCase() } })).filter(x => x.emailAddress.address);
}
// ---------- SMTP send ----------
const EV_MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;        // matches the composer's own per-file limit
const EV_MAX_ATTACHMENTS_TOTAL_BYTES = 20 * 1024 * 1024; // combined cap for one send
async function sendMail(acct, creds, message) {
  const transport = nodemailer.createTransport({
    host: acct.smtp_host, port: acct.smtp_port, secure: !!acct.smtp_secure,
    auth: smtpAuth(acct, creds),
  });
  const toArr = (message.toRecipients || []).map(r => r.emailAddress && r.emailAddress.address).filter(Boolean);
  const ccArr = (message.ccRecipients || []).map(r => r.emailAddress && r.emailAddress.address).filter(Boolean);
  const bccArr = (message.bccRecipients || []).map(r => r.emailAddress && r.emailAddress.address).filter(Boolean);
  const isHtml = message.body && (message.body.contentType || '').toLowerCase() === 'html';
  const mail = {
    from: { name: acct.display_name || '', address: acct.email_address },
    to: toArr, cc: ccArr, bcc: bccArr,
    subject: message.subject || '',
    [isHtml ? 'html' : 'text']: (message.body && message.body.content) || '',
  };
  if (Array.isArray(message.attachments)) {
    // The composer enforces 3 MB/file client-side, but that's advisory --
    // this is the same evGraph()-shaped body a direct API call could send
    // with anything in it, and decoding an unbounded base64 payload into a
    // Buffer on serverless is a real memory/timeout risk.
    let total = 0;
    mail.attachments = message.attachments.map(a => {
      const content = a.contentBytes ? Buffer.from(a.contentBytes, 'base64') : undefined;
      if (content) {
        if (content.length > EV_MAX_ATTACHMENT_BYTES) throw new Error((a.name || 'Attachment') + ' is too large — the limit is 3 MB per file.');
        total += content.length;
      }
      return { filename: a.name, content: content, contentType: a.contentType };
    }).filter(a => a.content);
    if (total > EV_MAX_ATTACHMENTS_TOTAL_BYTES) throw new Error('Attachments are too large together — the limit is 20 MB per email.');
  }
  // Note: we don't APPEND to the Sent folder. Gmail/Yahoo auto-file SMTP sends
  // (appending would duplicate them); iCloud/custom may not show a Sent copy
  // until a later phase adds provider-aware Sent handling. Sending is reliable.
  await transport.sendMail(mail);
  return {};
}

// ---------- account management ----------
// Pull the most specific message a mail server / library gives us.
function errText(e) {
  if (!e) return 'unknown error';
  const parts = [e.responseText, e.response, e.serverResponseCode, e.code, e.message].filter(Boolean);
  return (parts[0] ? String(parts[0]) : String(e)).slice(0, 200);
}
// SECURITY: add_account's imap_host/smtp_host come straight from a signed-in
// user's request body for a custom (non-preset) mailbox. Without this check,
// pointing them at an internal address turns this route into an SSRF/port-
// scan oracle -- the caller can't reach those hosts directly, but this
// server can, and the connect/auth error text it gets back (timeout vs.
// refused vs. protocol mismatch) differentiates what's actually there.
function isPrivateOrReservedIp(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 127 || a === 10 || a === 0) return true;              // loopback, 10/8, "this network"
    if (a === 172 && b >= 16 && b <= 31) return true;                // 172.16/12
    if (a === 192 && b === 168) return true;                        // 192.168/16
    if (a === 169 && b === 254) return true;                        // link-local, incl. cloud metadata (169.254.169.254)
    if (a === 100 && b >= 64 && b <= 127) return true;               // 100.64/10 (carrier-grade NAT)
    return false;
  }
  if (v === 6) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return true;
    if (low.startsWith('fe80:') || low.startsWith('fc') || low.startsWith('fd')) return true; // link-local / unique-local
    if (low.startsWith('::ffff:')) return isPrivateOrReservedIp(low.slice(7)); // IPv4-mapped
    return false;
  }
  return false;
}
async function assertPublicHost(host) {
  const h = String(host || '').trim().toLowerCase();
  if (!h) throw new Error('Host is required.');
  if (h === 'localhost') throw new Error('That host isn\'t reachable from here.');
  if (net.isIP(h)) {
    if (isPrivateOrReservedIp(h)) throw new Error('That host isn\'t reachable from here.');
    return;
  }
  let addrs;
  try { addrs = await dns.lookup(h, { all: true }); }
  catch (e) { throw new Error('Could not resolve ' + h + '.'); }
  if (!addrs.length) throw new Error('Could not resolve ' + h + '.');
  for (const a of addrs) {
    if (isPrivateOrReservedIp(a.address)) throw new Error('That host isn\'t reachable from here.');
  }
}
async function verifyConnection(acct, creds) {
  // Reject before ever opening a socket -- resolving is enough to leak
  // whether an internal name exists via DNS timing/NXDOMAIN alone otherwise,
  // but the connect attempt itself is the louder oracle this closes.
  await assertPublicHost(acct.imap_host);
  await assertPublicHost(acct.smtp_host);
  // Prove IMAP login works, then SMTP login — reporting WHICH failed and why,
  // so the user sees a real reason instead of a generic "command failed".
  let client;
  try { client = await openImap(acct, creds); await client.list(); }
  catch (e) { throw new Error('IMAP sign-in failed — ' + errText(e)); }
  finally { try { if (client) await client.logout(); } catch (e) {} }
  try {
    const transport = nodemailer.createTransport({ host: acct.smtp_host, port: acct.smtp_port, secure: !!acct.smtp_secure, auth: smtpAuth(acct, creds) });
    await transport.verify();
  } catch (e) { throw new Error('SMTP sign-in failed — ' + errText(e)); }
}

// ---------- handler ----------
module.exports = async (req, res) => {
  const q = req.query || {};
  // A GET with ?code (or ?error) and no action is Google's OAuth redirect back.
  const action = q.action || ((q.code || q.error) ? 'goog_callback' : 'health');
  const body = (typeof req.body === 'object' && req.body) ? req.body : {};

  try {
    if (action === 'health') {
      return res.status(200).json({ configured: configured(), googleConfigured: googleConfigured(), providers: Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, { label: v.label }])) });
    }

    // --- Google OAuth redirect (public; authenticated by the signed state) ---
    if (action === 'goog_callback') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const fail = (m) => res.status(200).send('<!doctype html><body style="font-family:sans-serif;padding:24px"><b>Couldn\'t connect Gmail.</b><br>' + escHtml(m) + '<br><br>You can close this window and try again.</body>');
      if (q.error) return fail(String(q.error_description || q.error));
      const gw = readGState(q.state || '');
      if (!gw) return fail('The sign-in link expired — please try again.');
      // Single-use, same as api/msmail.js's callback (Item 5): claim the
      // state's hash exactly once so a replayed callback (same code
      // delivered twice) is rejected instead of silently re-running. Fails
      // open on a store error -- the state's own HMAC signature + expiry
      // still protect it either way.
      try {
        const { claimOAuthStateOnce, hashState } = await import('./_lib/oauth-state.js');
        const claim = await claimOAuthStateOnce({ provider: 'gmail', stateHash: hashState(q.state) });
        if (!claim.ok) return fail('This sign-in link was already used — please reconnect the mailbox.');
      } catch (e) { /* fail open: signature + expiry still protect the state */ }
      let tok;
      try {
        const p = new URLSearchParams({ client_id: GOOGLE.clientId, client_secret: GOOGLE.clientSecret, grant_type: 'authorization_code', code: q.code, redirect_uri: GOOGLE.redirect });
        const r = await fetch(GOOGLE.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: p.toString() });
        tok = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(tok.error_description || tok.error || ('token ' + r.status));
      } catch (e) { return fail(String(e.message || e)); }
      if (!tok.refresh_token) return fail('Google did not return a reconnect token. In your Google Account → Security → Third-party access, remove HiveLogic Mail, then try connecting again.');
      const claims = tok.id_token ? decodeJwt(tok.id_token) : {};
      const email = String(claims.email || '').toLowerCase();
      if (!email) return fail('Could not read your Google email address.');
      const { encryptSecret } = await getSecretsLib();
      const pr = PRESETS.gmail;
      const row = {
        owner_id: gw.uid, provider: 'gmail', auth_type: 'oauth', email_address: email, display_name: email, username: email,
        imap_host: pr.imap_host, imap_port: pr.imap_port, imap_secure: pr.imap_secure,
        smtp_host: pr.smtp_host, smtp_port: pr.smtp_port, smtp_secure: pr.smtp_secure,
        app_password_enc: null, oauth_refresh_enc: encryptSecret(tok.refresh_token),
        last_verified_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString(),
      };
      await dbFetch(gw.realm, '/rest/v1/hc_mail_accounts?on_conflict=owner_id,email_address', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: [row] });
      await dbFetch(gw.realm, '/rest/v1/hc_mailbox_links?on_conflict=owner_id,ms_home_account_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: [{ owner_id: gw.uid, ms_home_account_id: accountId(email), ms_username: email }] });
      const APP_ORIGIN = 'https://hivelogic-live.vercel.app';
      return res.status(200).send('<!doctype html><body style="font-family:sans-serif;padding:24px">✅ <b>' + escHtml(email) + '</b> connected.<script>var m={type:"hc-mail-connected",email:' + JSON.stringify(email) + '};try{new BroadcastChannel("hc-mail-auth").postMessage(m)}catch(e){};try{window.opener&&window.opener.postMessage(m,' + JSON.stringify(APP_ORIGIN) + ')}catch(e){};setTimeout(function(){window.close()},600);</script></body>');
    }

    if (!configured()) return res.status(503).json({ error: 'mail backend not configured (missing HiveConnect Supabase env)' });

    const who = await requireUser(req);
    if (!who) return res.status(401).json({ error: 'not signed in' });
    const { uid, realm } = who;

    // --- start Google sign-in: return the Google authorize URL to open ---
    if (action === 'goog_start') {
      if (!googleConfigured()) return res.status(503).json({ error: 'Google sign-in isn\'t set up yet (missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).' });
      const u = new URL(GOOGLE.authUrl);
      u.searchParams.set('client_id', GOOGLE.clientId);
      u.searchParams.set('redirect_uri', GOOGLE.redirect);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('scope', GOOGLE.scope);
      u.searchParams.set('access_type', 'offline');
      u.searchParams.set('prompt', 'consent');
      u.searchParams.set('state', makeGState(uid, realm));
      return res.status(200).json({ url: u.toString() });
    }

    // --- add / verify / store a mailbox ---
    if (action === 'add_account') {
      const email = String(body.email || '').trim().toLowerCase();
      const providerKey = PRESETS[body.provider] ? body.provider : 'imap';
      const preset = PRESETS[providerKey];
      // App passwords are displayed grouped for readability — Gmail with spaces
      // ("abcd efgh ijkl mnop"), iCloud with dashes ("abcd-efgh-ijkl-mnop") — and
      // get pasted that way. Different servers disagree on whether the separators
      // must be removed, so rather than guess we try BOTH forms and keep whichever
      // actually authenticates. For a custom IMAP password we try the exact value
      // first (it may legitimately contain spaces/dashes), then the stripped form.
      const rawPass = String(body.password || '');
      const trimmed = rawPass.trim();
      const stripped = trimmed.replace(/[\s-]/g, '');
      const candidates = [...new Set(providerKey === 'imap' ? [trimmed, stripped] : [stripped, trimmed])].filter(Boolean);
      if (!email || !candidates.length) return res.status(400).json({ error: 'email and app password are required' });

      const acct = {
        email_address: email, display_name: (body.displayName || '').trim() || email, username: (body.username || email).trim(),
        imap_host: (body.imapHost || preset.imap_host).trim(), imap_port: parseInt(body.imapPort || preset.imap_port, 10), imap_secure: body.imapSecure != null ? !!body.imapSecure : preset.imap_secure,
        smtp_host: (body.smtpHost || preset.smtp_host).trim(), smtp_port: parseInt(body.smtpPort || preset.smtp_port, 10), smtp_secure: body.smtpSecure != null ? !!body.smtpSecure : preset.smtp_secure,
      };
      if (!acct.imap_host || !acct.smtp_host) return res.status(400).json({ error: 'IMAP/SMTP host is required for a custom account' });
      const validPort = (p) => Number.isInteger(p) && p > 0 && p <= 65535;
      if (!validPort(acct.imap_port) || !validPort(acct.smtp_port)) return res.status(400).json({ error: 'IMAP/SMTP port must be a number between 1 and 65535' });

      // SECURITY: refuse to store a real password unless encryption is armed.
      const { encryptSecret, isEncrypted } = await getSecretsLib();

      // Try each candidate; keep the one that authenticates.
      let usedPass = null, lastErr = null;
      for (const cand of candidates) {
        try { await verifyConnection(acct, { pass: cand }); usedPass = cand; break; }
        catch (e) { lastErr = e; }
      }
      if (usedPass == null) return res.status(400).json({ error: String((lastErr && lastErr.message) || 'sign-in failed').slice(0, 220) });

      const enc = encryptSecret(usedPass);
      if (!isEncrypted(enc)) return res.status(500).json({ error: 'server cannot encrypt credentials (TOKEN_ENC_KEY not configured) — mailbox not saved' });

      const row = Object.assign({}, acct, { owner_id: uid, provider: providerKey, app_password_enc: enc, auth_type: 'password', oauth_refresh_enc: null, last_verified_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() });
      await dbFetch(realm, '/rest/v1/hc_mail_accounts?on_conflict=owner_id,email_address', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: [row] });
      // Mirror into hc_mailbox_links so app.js's ownership filter surfaces it.
      await dbFetch(realm, '/rest/v1/hc_mailbox_links?on_conflict=owner_id,ms_home_account_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: [{ owner_id: uid, ms_home_account_id: accountId(email), ms_username: email }] });
      return res.status(200).json({ account: accountShape(row) });
    }

    if (action === 'accounts') {
      const rows = await dbFetch(realm, `/rest/v1/hc_mail_accounts?owner_id=eq.${uid}&select=email_address,display_name`) || [];
      return res.status(200).json({ accounts: rows.map(accountShape) });
    }

    if (action === 'remove_account') {
      const email = String(body.email || (body.homeAccountId || '').replace(/^imap:/, '')).trim().toLowerCase();
      if (!email) return res.status(400).json({ error: 'email or homeAccountId required' });
      await dbFetch(realm, `/rest/v1/hc_mail_accounts?owner_id=eq.${uid}&email_address=eq.${esc(email)}`, { method: 'DELETE' });
      await dbFetch(realm, `/rest/v1/hc_mailbox_links?owner_id=eq.${uid}&ms_home_account_id=eq.${esc(accountId(email))}`, { method: 'DELETE' });
      return res.status(200).json({ ok: true });
    }

    // --- the Graph-shape adapter ---
    if (action === 'graph') {
      const email = String((body.account || '').replace(/^imap:/, '')).trim().toLowerCase();
      if (!email) return res.status(400).json({ error: 'account required' });
      const rows = await dbFetch(realm, `/rest/v1/hc_mail_accounts?owner_id=eq.${uid}&email_address=eq.${esc(email)}&select=*&limit=1`) || [];
      const acct = rows[0];
      if (!acct) return res.status(404).json({ error: 'mailbox not connected' });
      try {
        const creds = await resolveCreds(acct);
        const out = await graphAdapter(acct, creds, body.path || '/me/mailFolders', body.method || 'GET', body.body || null);
        return res.status(200).json(out);
      } catch (e) {
        return res.status(502).json({ error: { message: 'mailbox error: ' + String(e.message || e).slice(0, 200) } });
      }
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
};

// ---------- one mailbox send, for callers that are not this route ----------
//
// Reina needs to send from the signed-in person's own mailbox after they have
// approved a draft (api/reina-action.js). She goes through the SAME account
// lookup, credential decryption and SMTP transport as the mail UI does -- she
// gets no private path to a mailbox, and no way to send from an address the
// user has not actually connected.
//
// Callers must have already checked that a human approved this send. Nothing
// here can tell an approved send from an unapproved one; that is the point of
// keeping the approval in the database and consuming it before calling this.
module.exports.sendMailForUser = async function sendMailForUser({ uid, realm, from, message }) {
  if (!uid || !realm || !message) return { ok: false, error: 'invalid request' };
  const wanted = String(from || '').trim().toLowerCase();
  const rows = await dbFetch(realm, `/rest/v1/hc_mail_accounts?owner_id=eq.${uid}&select=*`) || [];
  if (!rows.length) return { ok: false, error: 'no mailbox connected' };
  // An explicit from must be one of THEIR mailboxes. Falling back to the first
  // connected account when the requested address is not theirs would let a
  // wrong-but-plausible address quietly send as someone else.
  const acct = wanted ? rows.find(r => String(r.email_address || '').toLowerCase() === wanted) : rows[0];
  if (!acct) return { ok: false, error: 'that mailbox is not connected' };
  try {
    const creds = await resolveCreds(acct);
    await sendMail(acct, creds, message);
    return { ok: true, from: acct.email_address };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
};

// The addresses this person can legitimately send from, for the approval popup.
module.exports.mailboxesForUser = async function mailboxesForUser({ uid, realm }) {
  if (!uid || !realm) return [];
  const rows = await dbFetch(realm, `/rest/v1/hc_mail_accounts?owner_id=eq.${uid}&select=email_address,display_name`) || [];
  return rows.map(r => ({ address: r.email_address, name: r.display_name || '' })).filter(r => r.address);
};

// Exposed for test/mail-ssrf-guard.test.mjs -- the SSRF/attachment-size
// checks are the security-critical pure logic in this file; everything else
// needs a live IMAP/SMTP/DB connection to exercise.
module.exports.isPrivateOrReservedIp = isPrivateOrReservedIp;
module.exports.assertPublicHost = assertPublicHost;
module.exports.EV_MAX_ATTACHMENT_BYTES = EV_MAX_ATTACHMENT_BYTES;
module.exports.EV_MAX_ATTACHMENTS_TOTAL_BYTES = EV_MAX_ATTACHMENTS_TOTAL_BYTES;

// Same bearer-to-user resolution the mail UI uses, so a caller acting for a
// person resolves them exactly as this route would, against the same realms.
module.exports.resolveMailUser = requireUser;
