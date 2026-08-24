// api/user-settings.js -- a preference, keyed by the person who set it.
//
// Chris, 2026-08-23: "as a full HiveLogic Rule, settings changed should follow
// the user not the device. for every part of Hivelogic"
//
// Before this existed there was nowhere for a personal preference to live.
// company_settings, voice_settings and workforce_settings are all
// company-scoped -- putting a personal preference in one of those sets it for
// everybody -- so every preference in the app had defaulted to localStorage,
// which is the device. Theme set on the office desktop, still light on the
// laptop. Email templates written once, gone on the next machine.
//
// That failure never gets reported, because it does not look broken. It looks
// like the app forgot, and the person quietly sets it again.
//
// GET  returns the whole blob; the page reads it once on load.
// POST merges the keys it is given, so two tabs writing different preferences
//      do not clobber each other -- a whole-object PUT would.

import { supabaseRequest as defaultSupabaseRequest } from './_lib/jobber.js';
import { requireApiAuth } from './_lib/guard.js';

function jsonError(res, status, error) { return res.status(status).json({ ok: false, error }); }
const enc = (v) => encodeURIComponent(String(v));

// A preference is small, and a page that can write anything into a jsonb blob
// is a page that can fill the row with whatever it likes.
export const MAX_KEYS = 100;
export const MAX_KEY_LENGTH = 64;
export const MAX_VALUE_BYTES = 16 * 1024;

/**
 * What is allowed into the blob.
 *
 * Values are stored as given -- a preference can honestly be a string, a
 * number, a boolean or a small object -- but the SIZE is bounded, because
 * "settings" is the obvious place for someone to start stashing a document.
 */
export function validateSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { valid: false, error: 'Settings must be an object of keys.' };
  }
  const keys = Object.keys(patch);
  if (!keys.length) return { valid: false, error: 'Nothing to save.' };
  if (keys.length > MAX_KEYS) return { valid: false, error: `Too many settings at once (max ${MAX_KEYS}).` };
  for (const key of keys) {
    if (!key || key.length > MAX_KEY_LENGTH) {
      return { valid: false, error: `Setting name is too long (max ${MAX_KEY_LENGTH}).` };
    }
    const value = patch[key];
    if (value === undefined) return { valid: false, error: `"${key}" has no value. Send null to clear it.` };
    let size;
    try { size = Buffer.byteLength(JSON.stringify(value) || '', 'utf8'); }
    catch (_) { return { valid: false, error: `"${key}" cannot be stored.` }; }
    if (size > MAX_VALUE_BYTES) {
      return { valid: false, error: `"${key}" is too large (max ${MAX_VALUE_BYTES} bytes).` };
    }
  }
  return { valid: true };
}

/**
 * Merge, never replace.
 *
 * Two tabs open, one changes the theme and the other collapses a pane: a
 * whole-object write from either would silently drop the other's change. A
 * null clears one key rather than writing null into it, so "unset" and "set to
 * nothing" stay different.
 */
export function mergeSettings(current, patch) {
  const out = Object.assign({}, (current && typeof current === 'object' && !Array.isArray(current)) ? current : {});
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === null) delete out[key];
    else out[key] = value;
  }
  return out;
}

async function readSettings(ownerId, deps) {
  const r = await deps.supabaseRequest(`profiles?id=eq.${enc(ownerId)}&select=settings`);
  if (!r.ok) { const e = new Error('could not read your settings'); e.status = 502; throw e; }
  const rows = (await r.json().catch(() => [])) || [];
  const settings = rows[0] && rows[0].settings;
  return (settings && typeof settings === 'object' && !Array.isArray(settings)) ? settings : {};
}

export default async function handler(req, res, injected = {}) {
  const deps = Object.assign({
    supabaseRequest: defaultSupabaseRequest,
    fetchImpl: (...a) => fetch(...a),
  }, injected);

  res.setHeader('Cache-Control', 'no-store');

  // Never from the request body. A page that could name its own owner could
  // read and rewrite anyone's preferences.
  const auth = await requireApiAuth(req, { fetchImpl: deps.fetchImpl });
  if (!auth.ok || !auth.user || !auth.user.id) {
    return jsonError(res, 401, 'Not signed in — log into HiveLogic first.');
  }
  const ownerId = auth.user.id;

  try {
    if (req.method === 'GET') {
      return res.status(200).json({ ok: true, settings: await readSettings(ownerId, deps) });
    }
    if (req.method !== 'POST') return jsonError(res, 405, 'GET or POST only');

    const body = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}));
    const patch = body && typeof body.settings === 'object' ? body.settings : body;
    const check = validateSettingsPatch(patch);
    if (!check.valid) return jsonError(res, 400, check.error);

    const merged = mergeSettings(await readSettings(ownerId, deps), patch);
    const w = await deps.supabaseRequest(`profiles?id=eq.${enc(ownerId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ settings: merged }),
    });
    if (!w.ok) { const e = new Error('could not save that setting'); e.status = 502; throw e; }
    return res.status(200).json({ ok: true, settings: merged });
  } catch (e) {
    return jsonError(res, e.status || 500, String(e.message || e).slice(0, 200));
  }
}
