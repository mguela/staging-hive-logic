-- Crew lead seeding: subcontractors are not leads by default.
--
-- 20260817120000_crew_chaining.sql seeded employee_roles.is_lead from the crew_label
-- convention ("Team 3" leads, "Team 3 helper" rides along) across lens in ('crew','sub').
-- Checked against real prod data afterwards, that was wrong for subs: the most common
-- multi-person job in the live schedule is one subcontractor company plus one employee,
-- and flagging both left 27 of 46 crew jobs with two leads and no way to choose. Lead
-- election then fell through to the old positional heuristic, so the flag set in user
-- setup was not actually deciding who leads — the exact thing the feature exists to fix.
--
-- Excluding subs took decisive election from 12/46 to 38/46 on that same real data. It
-- also matches who should hold the crew clock: a lead's tap writes an hl_clock row per
-- crew member for payroll, and a sub company placeholder is not a payroll identity.
--
-- Two rows in prod were corrected by hand when this was found (2026-08-17); this migration
-- is what keeps a FRESH INSTALL from reproducing the same seed, since go-live is a fresh
-- install rather than a migration of this database.
--
-- Dispatch can still put a sub in charge of a specific job — that election lives on
-- hl_crew_overrides.lead_jid and is untouched here. This only changes the default.

update public.employee_roles
set is_lead = false,
    updated_at = now(),
    updated_by = coalesce(updated_by, 'crew lead seed: subs are not leads by default')
where lens = 'sub'
  and is_lead;
