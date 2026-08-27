// Filled in at deploy time — Supabase project URL + anon (public) key.
// The anon key is safe to ship to browsers; Row Level Security guards the data.
window.HIVE_CONFIG = {
  url: 'https://mzyngawgpxzpsxphswmc.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im16eW5nYXdncHh6cHN4cGhzd21jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMDgxODUsImV4cCI6MjA5OTc4NDE4NX0.-rWSrHX2MtVUIdHFu_gpEOYcJcXh_-GalpsfnmhsMhM',
  livekitUrl: 'wss://video.hiverorder.com',
  // Microsoft 365 email (Outlook) integration. Paste your Azure app registration's
  // Application (client) ID here to switch the Email tab on. tenant 'common' lets any
  // work/personal Microsoft account sign in; use your tenant ID to lock it to ghgrp.net.
  //
  // This file is served byte-identical to every deployment (no per-request
  // templating), so a staging Azure app registration -- a separate one,
  // 2026-08-28, so testing there can never touch mailboxes already connected
  // in production -- is picked by hostname here rather than by editing this
  // file per environment. Its own redirect URIs are registered for
  // staging-hive-logic-ten.vercel.app; api/msmail.js and
  // api/_lib/ms-mailbox-tokens.js pick the matching server-side app via the
  // MS_MAILBOX_CLIENT_ID env var, set only on that deployment.
  msGraph: {
    clientId: (typeof location !== 'undefined' && location.hostname === 'staging-hive-logic-ten.vercel.app')
      ? 'eb965c85-d17f-43b5-a6c6-1508caa6669'
      : 'ff9bda24-d7e9-4905-a94e-f3ccc0239eb2',
    tenant: 'organizations',
  }
};
