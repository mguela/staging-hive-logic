-- One calendar for subs.
--
-- Additive: one nullable column. A native appointment can now say which
-- subcontractor it belongs to, which is what lets the SAME entry appear on the
-- dispatch board and in that sub's portal instead of the two disconnected
-- schedules the plan describes (sub_schedule_items vs. the board).
--
-- crew_jids cannot carry this: it holds employee Jobber ids, and a sub is not
-- an employee -- it is a row in public.subs with its own id and its own auth
-- realm (sub_sessions).
--
-- sub_schedule_items is deliberately NOT dropped here. The plan retires the
-- second schedule only after parity is proven, and with zero rows in either
-- table today there is nothing to prove it against.
alter table public.hl_appointments
  add column if not exists sub_id uuid;

create index if not exists hl_appointments_sub_idx
  on public.hl_appointments (sub_id) where sub_id is not null;
