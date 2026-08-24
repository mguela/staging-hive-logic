// api/_lib/supabase-storage.js
// Thin, dependency-free helpers over Supabase Storage's REST API, in the same
// raw-fetch style the rest of this codebase uses for third-party services
// (see api/_lib/jobber.js, api/_lib/voice.js) rather than pulling in the
// supabase-js SDK server-side.
//
// Three operations, because three are all the reel pipeline needs: put an
// object, get a signed URL for a private one, and get the stable public URL
// for a public one. The distinction matters and is not cosmetic -- customer
// job photos live in the private `media` bucket and must only ever be read
// through a short-lived signed URL, while a finished marketing video has to
// sit at a permanent public URL because Instagram and TikTok fetch it
// server-side (see the bucket comment in the growth engine migration).

function serviceHeaders() {
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_KEY is not set -- cannot reach Supabase Storage.');
  return { apikey: key, Authorization: `Bearer ${key}` };
}

function storageBase() {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error('SUPABASE_URL is not set -- cannot reach Supabase Storage.');
  return url.replace(/\/+$/, '') + '/storage/v1';
}

// Uploads bytes to bucket/path. `body` is an ArrayBuffer, Buffer, or
// Uint8Array. Overwrites by default (x-upsert) so a re-render of the same
// reel replaces its file instead of accumulating orphans.
export async function storageUpload(bucket, path, body, contentType, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const res = await fetchImpl(`${storageBase()}/object/${bucket}/${path}`, {
    method: 'POST',
    headers: {
      ...serviceHeaders(),
      'Content-Type': contentType,
      'x-upsert': opts.upsert === false ? 'false' : 'true',
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`Storage upload to ${bucket}/${path} failed (${res.status}): ${await res.text()}`);
  }
  return { bucket, path };
}

// A time-limited URL for an object in a PRIVATE bucket. Used for customer job
// photos, which must never get a permanent public link.
export async function storageSignedUrl(bucket, path, expiresInSeconds = 3600, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const res = await fetchImpl(`${storageBase()}/object/sign/${bucket}/${path}`, {
    method: 'POST',
    headers: { ...serviceHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: expiresInSeconds }),
  });
  if (!res.ok) {
    throw new Error(`Storage sign for ${bucket}/${path} failed (${res.status}): ${await res.text()}`);
  }
  const body = await res.json();
  // Supabase returns a root-relative signedURL like "/object/sign/...?token=..."
  const signed = String(body.signedURL || body.signedUrl || '');
  if (!signed) throw new Error(`Storage sign for ${bucket}/${path} returned no URL.`);
  return signed.startsWith('http') ? signed : storageBase() + signed.replace(/^\/storage\/v1/, '');
}

// The permanent URL for an object in a PUBLIC bucket. No network call --
// public object URLs in Supabase are pure string construction.
export function storagePublicUrl(bucket, path) {
  return `${storageBase()}/object/public/${bucket}/${path}`;
}
