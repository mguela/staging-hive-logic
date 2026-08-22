// Filled in at deploy time — Supabase project URL + anon (public) key.
// The anon key is safe to ship to browsers; Row Level Security guards the data.
window.HIVE_CONFIG = {
  url: 'https://mzyngawgpxzpsxphswmc.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im16eW5nYXdncHh6cHN4cGhzd21jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMDgxODUsImV4cCI6MjA5OTc4NDE4NX0.-rWSrHX2MtVUIdHFu_gpEOYcJcXh_-GalpsfnmhsMhM',
  livekitUrl: 'wss://video.hiverorder.com',
  // Microsoft 365 email (Outlook) integration. Paste your Azure app registration's
  // Application (client) ID here to switch the Email tab on. tenant 'common' lets any
  // work/personal Microsoft account sign in; use your tenant ID to lock it to ghgrp.net.
  msGraph: { clientId: 'ff9bda24-d7e9-4905-a94e-f3ccc0239eb2', tenant: 'organizations' }
};
