-- Schedule "+ Add" form: make the client a REFERENCE, not a typed label.
--
-- Chris's ask (2026-08-21): "client > existing > auto pop info". The form now
-- picks a real client and auto-fills their phone, email and address from the
-- record -- but hl_appointments only had `client text`, the display name. So
-- the pick was cosmetic: nothing tied the appointment back to the client it
-- was booked for, exactly the way job_ref had to be added because typing a
-- job number tied a visit to nothing.
--
-- `client_ref` is the client's jobber_id, matching how job_ref stores the
-- job's jobber_id and how visits.client_id already references clients. Plain
-- text with no FK for the same reason the rest of the schedule uses text refs:
-- clients arrive from the Jobber mirror and from HiveLogic ('HL-...' ids), and
-- a hard FK would make an appointment fail to save because a sync had not
-- landed yet.
--
-- `client` (the name) is deliberately KEPT and still written. It is the label
-- the board renders, and it must survive a client being renamed or archived --
-- a card that silently changes what it says is worse than a stale name.
--
-- ADDITIVE ONLY. No backfill: the 0 appointments that exist predate the picker
-- and have no client to point at. Idempotent -- safe if it ever re-runs.

alter table public.hl_appointments
  add column if not exists client_ref text;

comment on column public.hl_appointments.client_ref is
  'clients.jobber_id this appointment was booked for. Null for internal/shop work with no client, and for rows created before the client picker shipped (2026-08-21). The display name stays in `client`.';

-- The board loads a date range and then asks "what else is on for this
-- client?" when a dispatcher opens one. Without this that is a seq scan over
-- every appointment; partial because the column is null for internal work.
create index if not exists hl_appointments_client_ref_idx
  on public.hl_appointments (client_ref)
  where client_ref is not null;
