/* public/labs/cowork/lib/dropzone.js
 * Cowork Labs — Slice 5 (Drop zone). Validation + a shared, synced file list.
 * Storage is behind an uploadAdapter interface; this run ships an in-memory
 * object-URL mock. Real HiveDocs persistence is a later, separate task (see
 * hiveDocsAdapterStub below).
 *
 * Events (envelope `t`):
 *   drop:add  payload <entry>   a file was accepted and "uploaded"
 *
 * Entry: { id, name, size, uploader, url, at }
 */
'use strict';

var MAX_BYTES = 25 * 1024 * 1024; // 25 MB cap
// Extension allowlist (MIME for heic/docx/xlsx is inconsistent across browsers,
// so the extension is the source of truth; MIME is advisory).
var ALLOWED_EXT = ['pdf', 'png', 'jpg', 'jpeg', 'heic', 'docx', 'xlsx'];

function extOf(name) {
  var m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}
function humanSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

// Returns { ok:true } or { ok:false, reason }.
function validateFile(file) {
  if (!file || !file.name) return { ok: false, reason: 'No file.' };
  var ext = extOf(file.name);
  if (ALLOWED_EXT.indexOf(ext) === -1) {
    return { ok: false, reason: 'Unsupported type ".' + (ext || '?') + '" — allowed: ' + ALLOWED_EXT.join(', ') + '.' };
  }
  if (typeof file.size === 'number' && file.size > MAX_BYTES) {
    return { ok: false, reason: 'Too large (' + humanSize(file.size) + ') — 25 MB max.' };
  }
  return { ok: true };
}

/* ---- Upload adapters (the storage seam) ---- */
// In-memory mock: hands back an object URL in the browser, or a data-ish stub
// in node. Never leaves the tab.
function memoryUploadAdapter() {
  var n = 0;
  return {
    name: 'memory',
    upload: function (file) {
      n++;
      var url = (typeof URL !== 'undefined' && URL.createObjectURL && file.blob)
        ? URL.createObjectURL(file.blob)
        : 'memory://' + n + '/' + encodeURIComponent(file.name);
      return Promise.resolve({ id: 'mem-' + n, url: url });
    }
  };
}
// TODO(HiveDocs): real persistence. Wire to the HiveDocs upload endpoint,
// return its document id + signed URL. Left as a stub on purpose — separate,
// reviewed task per the run sheet (no storage schema in this run).
function hiveDocsAdapterStub() {
  return {
    name: 'hivedocs-stub',
    upload: function () { return Promise.reject(new Error('HiveDocs adapter not implemented in labs run')); }
  };
}

/* Shared session file list. Names collide -> "file (2).ext" suffixing. */
function createDropSession(opts) {
  opts = opts || {};
  var adapter = opts.adapter || memoryUploadAdapter();
  var entries = [];

  function nameTaken(name) { return entries.some(function (e) { return e.name === name; }); }
  function uniqueName(name) {
    if (!nameTaken(name)) return name;
    var ext = extOf(name);
    var base = ext ? name.slice(0, name.length - ext.length - 1) : name;
    var i = 2, candidate;
    do { candidate = base + ' (' + i + ')' + (ext ? '.' + ext : ''); i++; } while (nameTaken(candidate));
    return candidate;
  }

  // Validate, upload via adapter, append. Returns { ok, entry?, reason? }.
  function addFile(file, uploader, at) {
    var v = validateFile(file);
    if (!v.ok) return Promise.resolve({ ok: false, reason: v.reason });
    return adapter.upload(file).then(function (res) {
      var entry = {
        id: res.id, name: uniqueName(file.name), size: file.size,
        uploader: uploader || 'unknown', url: res.url, at: at || 0
      };
      entries.push(entry);
      return { ok: true, entry: entry };
    });
  }

  // Remote entry arriving from a peer. Suffix on collision here too so two
  // clients uploading the same name converge to distinct list rows.
  function applyRemote(env) {
    if (!env || env.t !== 'drop:add' || !env.payload) return false;
    var e = env.payload;
    if (entries.some(function (x) { return x.id === e.id; })) return false; // already have it
    entries.push({ id: e.id, name: uniqueName(e.name), size: e.size, uploader: e.uploader, url: e.url, at: e.at });
    return true;
  }

  function list() { return entries.slice(); }
  function count() { return entries.length; }
  return { addFile: addFile, applyRemote: applyRemote, list: list, count: count };
}

var DropZone = {
  MAX_BYTES: MAX_BYTES, ALLOWED_EXT: ALLOWED_EXT,
  extOf: extOf, humanSize: humanSize, validateFile: validateFile,
  memoryUploadAdapter: memoryUploadAdapter, hiveDocsAdapterStub: hiveDocsAdapterStub,
  createDropSession: createDropSession
};
if (typeof module !== 'undefined' && module.exports) { module.exports = DropZone; }
if (typeof window !== 'undefined') { window.CoworkDropZone = DropZone; }
