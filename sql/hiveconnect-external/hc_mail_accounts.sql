-- Run this in the SUPABASE SQL EDITOR FOR THE HIVECONNECT PROJECT
-- (ref mzyngawgpxzpsxphswmc, url https://mzyngawgpxzpsxphswmc.supabase.co)
-- NOT the main HiveLogic project (sqhusuuhlmcmkeowdrga) — HiveConnect mail
-- auth resolves auth.uid() against its own project, exactly like
-- hc_mailbox_links / hc_ms_tokens.
--
-- Stores IMAP/SMTP mailbox connections for the "add any email account"
-- feature (Gmail, iCloud, Yahoo, AOL, custom domains). The app-specific
-- password is stored ONLY as ciphertext written by api/_lib/secrets.js
-- (AES-256-GCM, "enc:v1:..."). The encryption key lives in the Vercel env
-- var TOKEN_ENC_KEY, never in this database, so a leaked service key or a
-- DB backup alone cannot decrypt a mailbox password.
--
-- The backend (api/mail.js) uses the service-role key and bypasses RLS; the
-- per-user policy below only guards any direct anon/browser read. Each
-- connected mailbox is ALSO mirrored into hc_mailbox_links (with a synthetic
-- "imap:<email>" id) so app.js's existing hcOwnAccountIds ownership filter
-- surfaces it in the inbox with no change to that table.

create table if not exists hc_mail_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  provider text not null default 'imap',        -- 'gmail' | 'icloud' | 'yahoo' | 'aol' | 'imap'
  email_address text not null,
  display_name text,
  -- IMAP (read)
  imap_host text not null,
  imap_port integer not null default 993,
  imap_secure boolean not null default true,
  -- SMTP (send as the user's own mailbox)
  smtp_host text not null,
  smtp_port integer not null default 465,
  smtp_secure boolean not null default true,    -- true = implicit TLS (465); false = STARTTLS (587)
  -- login username (usually == email_address; NOT a secret) + the encrypted app password
  username text not null,
  app_password_enc text,                        -- AES-256-GCM ciphertext ("enc:v1:..."); null for OAuth accounts
  -- OAuth accounts (Gmail "Sign in with Google") store an encrypted refresh
  -- token instead of a password and connect via XOAUTH2.
  auth_type text not null default 'password',   -- 'password' | 'oauth'
  oauth_refresh_enc text,                        -- AES-256-GCM ciphertext of the Google refresh token
  last_verified_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, email_address)
);

create index if not exists hc_mail_accounts_owner_idx on hc_mail_accounts (owner_id);

alter table hc_mail_accounts enable row level security;

-- Each person can only ever see/add/remove their own mailboxes. (The backend
-- service-role key bypasses this; it protects any direct browser access.)
create policy "own mail accounts only"
  on hc_mail_accounts
  for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);
