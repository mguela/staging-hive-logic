// api/takeoffs.js - Vercel serverless function
// HiveGrid Live Workbench takeoff persistence. Phase 1 (2026-07-22) saved
// the MEASUREMENT DATA a taker builds in the Live Workbench canvas tool --
// conditions (WBCONDS), marks (WB.marks), and per-sheet metadata (name,
// calibration, scale) -- tied to a real Jobber quote, but deliberately did
// NOT persist the plan image/PDF pixels themselves. Phase 1.5 (2026-07-22)
// closes that gap: uploadTakeoffSheetImage()/signTakeoffSheetImage() below
// push/pull the real sheet pixels through the existing private "media"
// Storage bucket, mirroring api/fieldops.js's photo_add upload and
// api/clientportal.js's signMediaUrl() -- same raw-fetch-against-Supabase-
// REST convention as every other route here (no supabase-js client
// anywhere in this codebase) -- sb() wrapper copied from api/fieldops.js.
import { supabaseRequest } from './_lib/jobber.js';
import { requireUser } from './_lib/auth.js';

async function sb(path, options) {
  const res = await supabaseRequest(path, options);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase error on ${path}: ${res.status} ${body}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}


// Phase 1.5 (2026-07-22): persist the actual plan image/PDF-page pixels for
// a takeoff sheet in the existing private "media" Storage bucket. Kept as
// two separate helpers (upload here, sign below) mirroring the
// uploadDataUrl-then-signMediaUrl split already used by api/subportal.js /
// api/clientportal.js -- uploads and reads are separate concerns, and the
// upload call itself never hands back a signed URL.
async function uploadTakeoffSheetImage(quoteId, sheetIndex, dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) throw new Error('Expected a base64 data URL (e.g. from canvas.toDataURL()).');
  const [, contentType, b64] = match;
  const buf = Buffer.from(b64, 'base64');
  const storagePath = `takeoffs/${quoteId}/sheet-${sheetIndex}-${Date.now()}.png`;
  const up = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/media/${storagePath}`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': contentType,
      'x-upsert': 'true',
    },
    body: buf,
  });
  if (!up.ok) throw new Error(`Sheet image upload failed: ${await up.text()}`);
  return `media/${storagePath}`;
}

// storedPath is whatever uploadTakeoffSheetImage() returned, i.e. bucket-
// prefixed ("media/takeoffs/..."). The sign endpoint below is already scoped
// to the media bucket, so strip that prefix before calling it.
async function signTakeoffSheetImage(storedPath, expiresInSeconds = 3600) {
  const cleanPath = String(storedPath || '').replace(/^media\//, '');
  const res = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/sign/media/${cleanPath}`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: expiresInSeconds }),
  });
  if (!res.ok) return null; // file unreachable -- caller should handle a null URL honestly
  const data = await res.json();
  return data && data.signedURL ? `${process.env.SUPABASE_URL}/storage/v1${data.signedURL}` : null;
}

function shapeTakeoff(row) {
  return {
    id: row.id,
    quoteId: row.quote_id,
    jobId: row.job_id,
    title: row.title,
    conditions: row.conditions || [],
    marks: row.marks || [],
    sheets: row.sheets || [],
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export default async function handler(req, res) {
  const _authedUser = await requireUser(req);
  if (!_authedUser) return res.status(401).json({ ok: false, error: 'Not signed in.' });
  try {
    if (req.method === 'GET' && req.query.action === 'sign') {
      const { path } = req.query;
      if (!path) return res.status(400).json({ ok: false, error: 'path is required' });
      const url = await signTakeoffSheetImage(path, 3600);
      if (!url) return res.status(502).json({ ok: false, error: 'Could not sign that image path.' });
      return res.status(200).json({ ok: true, url, expiresIn: 3600 });
    }

    if (req.method === 'GET') {
      const { quote_id: quoteId, id } = req.query;
      if (id) {
        const rows = await sb(`takeoffs?id=eq.${encodeURIComponent(id)}&select=*`);
        const takeoff = rows && rows[0];
        if (!takeoff) return res.status(404).json({ ok: false, error: 'Takeoff not found' });
        return res.status(200).json({ ok: true, takeoff: shapeTakeoff(takeoff) });
      }
      if (!quoteId) return res.status(400).json({ ok: false, error: 'quote_id is required' });
      const rows = await sb(`takeoffs?quote_id=eq.${encodeURIComponent(quoteId)}&select=*&order=updated_at.desc`);
      return res.status(200).json({ ok: true, takeoffs: (rows || []).map(shapeTakeoff) });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      if (body.action === 'upload_image') {
        const { quote_id: quoteId, sheet_index: sheetIndex, data_url: dataUrl } = body;
        if (!quoteId || sheetIndex === undefined || sheetIndex === null || !dataUrl) {
          return res.status(400).json({ ok: false, error: 'quote_id, sheet_index, and data_url are required' });
        }
        const storagePath = await uploadTakeoffSheetImage(quoteId, sheetIndex, dataUrl);
        return res.status(200).json({ ok: true, storagePath });
      }

      const {
        id,
        quote_id: quoteId,
        job_id: jobId,
        title,
        conditions,
        marks,
        sheets,
        status,
        created_by: createdBy,
      } = body;
      if (!id && !quoteId) return res.status(400).json({ ok: false, error: 'quote_id is required to create a takeoff' });

      const payload = {
        job_id: jobId || null,
        title: title || null,
        conditions: Array.isArray(conditions) ? conditions : [],
        marks: Array.isArray(marks) ? marks : [],
        sheets: Array.isArray(sheets) ? sheets : [],
        status: status || 'draft',
        updated_at: new Date().toISOString(),
      };
      if (quoteId) payload.quote_id = quoteId;
      if (createdBy) payload.created_by = createdBy;

      if (id) {
        const rows = await sb(`takeoffs?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify(payload),
        });
        const takeoff = rows && rows[0];
        if (!takeoff) return res.status(404).json({ ok: false, error: 'Takeoff not found' });
        return res.status(200).json({ ok: true, takeoff: shapeTakeoff(takeoff) });
      }

      const rows = await sb('takeoffs', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(payload),
      });
      const takeoff = rows && rows[0];
      return res.status(200).json({ ok: true, takeoff: takeoff ? shapeTakeoff(takeoff) : null });
    }

    return res.status(405).json({ ok: false, error: 'GET or POST only' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
