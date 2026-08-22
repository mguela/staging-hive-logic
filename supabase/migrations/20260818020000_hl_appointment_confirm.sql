-- Client-facing confirm/decline for native appointments.
--
-- Additive only: four nullable-or-defaulted columns on hl_appointments. No
-- drops, no renames, no rewrite of existing rows -- every appointment already
-- in the table reads confirm_state = 'unconfirmed', which is true of them.
--
-- TOKEN DISCIPLINE, copied from the sub portal (api/_lib/portal-auth.js):
-- only the SHA-256 hash of the confirm token is stored. The raw token exists
-- in exactly one place -- the link in the customer's email -- and is never
-- written to the database, so a leaked table dump cannot be used to confirm or
-- decline anyone's appointment. Lookup is by hash of the presented token.
alter table public.hl_appointments
  add column if not exists confirm_state text not null default 'unconfirmed',
  add column if not exists confirmed_at timestamptz,
  add column if not exists confirm_token_hash text,
  add column if not exists confirm_expires_at timestamptz;

-- Only three states are meaningful; anything else is a bug writing garbage.
-- NOT VALID so the constraint applies to new writes without forcing a scan or
-- rejecting any row that already exists.
alter table public.hl_appointments
  drop constraint if exists hl_appointments_confirm_state_check;
alter table public.hl_appointments
  add constraint hl_appointments_confirm_state_check
  check (confirm_state in ('unconfirmed', 'confirmed', 'declined')) not valid;

-- The public endpoint's only lookup: find the appointment for a presented
-- token hash. Partial, because the vast majority of rows never get a token.
create index if not exists hl_appointments_confirm_token_idx
  on public.hl_appointments (confirm_token_hash) where confirm_token_hash is not null;
