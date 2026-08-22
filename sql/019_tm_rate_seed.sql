-- 019_tm_rate_seed.sql
--
-- tm_rate_types (created by 016_job_tm.sql) came up empty in production --
-- the seed row for Chris's confirmed $225/hr general T&M rate never landed.
-- This just re-runs that insert. Idempotent (on conflict do nothing), safe
-- to run even if 016 is later re-applied and seeds correctly on its own.
--
-- ADDITIVE ONLY. Safe to run more than once.

insert into tm_rate_types (key, label, rate_hourly)
values ('general', 'General T&M (any work/repair)', 225)
on conflict (key) do nothing;
