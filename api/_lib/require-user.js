// api/_lib/require-user.js
// Shared Supabase-session auth check, extracted from api/marketing.js's
// local requireUser so new endpoint files (api/ads.js) don't duplicate the
// raw fetch-and-verify logic. Behavior is identical: verify the bearer
// value against Supabase's own /auth/v1/user endpoint -- no local secret
// comparison, no shortcuts.

export async function requireUser(req) {
  const auth = req.headers.authorization || '';
  const value = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!value) return null;
  try {
    const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${value}`,
      },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}
