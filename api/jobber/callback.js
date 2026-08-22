// api/jobber/callback.js — Vercel serverless function
// Handles Jobber's OAuth redirect: exchanges the one-time authorization
// code for an access token + refresh token, then stores them in Supabase.
// Tokens are never exposed to the browser or to any chat.

import { encryptSecret } from '../_lib/secrets.js';
import { consumeOAuthState } from '../_lib/oauth-state.js';

export default async function handler(req, res) {
    const { code, error, state } = req.query;

  if (error) {
        return res.redirect(`/?jobber_error=${encodeURIComponent(error)}`);
  }
    if (!code) {
          return res.status(400).send('Missing authorization code from Jobber.');
    }

    // Item 5 (2026-08-01): validate the OAuth state before touching the code.
    // Rejects missing/expired/reused/forged state — defeats CSRF / code
    // injection. The state is consumed (single-use) here.
    const stateCheck = await consumeOAuthState({ provider: 'jobber', state });
    if (!stateCheck.ok) {
          return res.redirect(`/?jobber_error=${encodeURIComponent('invalid_state_' + stateCheck.reason)}`);
    }

  try {
        const tokenRes = await fetch('https://api.getjobber.com/api/oauth/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                          grant_type: 'authorization_code',
                          code,
                          client_id: process.env.JOBBER_CLIENT_ID,
                          client_secret: process.env.JOBBER_CLIENT_SECRET,
                          redirect_uri: process.env.JOBBER_REDIRECT_URI,
                }),
        });

      const tokens = await tokenRes.json();

      if (!tokenRes.ok || !tokens.access_token) {
              console.error('Jobber token exchange failed:', tokens);
              return res.redirect('/?jobber_error=token_exchange_failed');
      }

      // Jobber's token response does not always include expires_in.
      // Fall back to the documented default access token lifetime (60 minutes).
      const expiresInSeconds = Number.isFinite(tokens.expires_in) ? tokens.expires_in : 3600;

      const supabaseRes = await fetch(
              `${process.env.SUPABASE_URL}/rest/v1/integrations?on_conflict=key`,
        {
                  method: 'POST',
                  headers: {
                              apikey: process.env.SUPABASE_SERVICE_KEY,
                              Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
                              'Content-Type': 'application/json',
                              Prefer: 'resolution=merge-duplicates',
                  },
                  body: JSON.stringify({
                              key: 'jobber',
                              access_token: encryptSecret(tokens.access_token),
                              refresh_token: encryptSecret(tokens.refresh_token),
                              expires_at: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
                              updated_at: new Date().toISOString(),
                  }),
        }
            );

      if (!supabaseRes.ok) {
              const errText = await supabaseRes.text();
              console.error('Supabase save failed:', errText);
              return res.redirect('/?jobber_error=storage_failed');
      }

      return res.redirect('/?connected=jobber');
  } catch (err) {
        console.error('Jobber callback error:', err);
        return res.redirect('/?jobber_error=unexpected');
  }
}
