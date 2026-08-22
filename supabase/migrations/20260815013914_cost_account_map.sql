-- sql/073_cost_account_map.sql
--
-- Company Setup + Cost Model V1 — Slice 3 (QuickBooks chart-of-accounts map).
--
-- Global rule table (no company_id) that maps QuickBooks accounts to cost_lines
-- sections + cost_types for import_qbo. Rules are evaluated in sort_order; the
-- FIRST rule whose (type, name-pattern) both match wins. Name-pattern rules
-- come first (most specific), then AccountType-only fallbacks, then a catch-all.
-- Anything that matches NOTHING is routed to the 'Unsorted' section by the API
-- for human review — it is never silently dropped.
--
-- confidence is the match quality carried onto the imported line (100 = type +
-- name matched, 80 = type only, 50 = name only, 20 = catch-all/Unsorted).
--
-- NOT APPLIED TO ANY DATABASE BY CLAUDE.

begin;

create table if not exists public.cost_account_map (
  id uuid primary key default gen_random_uuid(),
  qbo_account_type text,             -- null = match any type
  qbo_account_name_pattern text,     -- null = match any name; else POSIX regex (~*)
  target_section text not null,
  target_cost_type text not null check (target_cost_type in ('fixed','variable','direct','reserve')),
  confidence int not null default 80,
  sort_order int not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.cost_account_map enable row level security;
revoke all on public.cost_account_map from anon, authenticated;
grant all on public.cost_account_map to service_role;
grant select on public.cost_account_map to authenticated;
drop policy if exists cost_account_map_read on public.cost_account_map;
create policy cost_account_map_read on public.cost_account_map
  for select to authenticated using (true);

delete from public.cost_account_map;  -- idempotent re-seed

insert into public.cost_account_map
  (qbo_account_type, qbo_account_name_pattern, target_section, target_cost_type, confidence, sort_order)
values
  -- ── Name-pattern rules (most specific first) ────────────────────────────
  (null, '(labor|wages|field pay|subcontract)', 'Direct Labor',          'direct',   100, 10),
  (null, '(payroll tax|fica|futa|suta|workers.?comp|work comp)', 'Labor Burden', 'direct', 100, 11),
  (null, '(merchant|processing fee|credit card fee|financing fee)', 'Job Costs', 'direct', 90, 12),
  (null, '(materials|consumable|small tools|job supplies)', 'Job Costs',   'direct',   90, 13),
  (null, '(fuel|gas|diesel)',                     'Fleet & Vehicles',      'variable', 95, 20),
  (null, '(vehicle|auto|truck|fleet|mileage)',    'Fleet & Vehicles',      'variable', 90, 21),
  (null, '(rent|lease)',                          'Facilities',            'fixed',    95, 30),
  (null, '(utilit|electric|water|gas bill)',      'Facilities',            'fixed',    85, 31),
  (null, '(internet|phone|telephone|cell)',       'Software & Technology', 'fixed',    80, 32),
  (null, '(software|subscription|saas|app fee)',  'Software & Technology', 'fixed',    90, 33),
  (null, '(insurance|bond)',                      'Insurance & Bonding',   'fixed',    95, 40),
  (null, '(advertis|marketing|lead|seo|ppc)',     'Marketing & Sales',     'variable', 90, 50),
  (null, '(legal|attorney|accounting|cpa|bookkeep|professional fee)', 'Professional Services', 'fixed', 90, 60),
  (null, '(license|permit|dues|association)',      'Professional Services', 'fixed',    80, 61),
  (null, '(training|certification|education)',     'Professional Services', 'fixed',    75, 62),
  (null, '(office|supplies|postage|shipping)',     'Office & Admin',        'fixed',    80, 70),
  (null, '(bank fee|service charge|interest)',     'Office & Admin',        'fixed',    75, 71),
  (null, '(owner|officer)',                        'Owner & Management',    'fixed',    80, 80),
  (null, '(salary|salaries|admin)',               'Office & Admin',        'fixed',    75, 81),
  (null, '(reserve|contingency|warranty|bad debt)','Reserves',             'reserve',  85, 90),
  -- ── AccountType-only fallbacks ──────────────────────────────────────────
  ('Cost of Goods Sold', null, 'Job Costs',        'direct',   80, 200),
  ('Expense',            null, 'Office & Admin',   'fixed',    50, 210),
  ('Other Expense',      null, 'Office & Admin',   'fixed',    45, 211),
  ('Fixed Asset',        null, 'Fleet & Vehicles', 'fixed',    40, 212);

commit;

-- Post-apply check (run manually): select count(*) from public.cost_account_map;
-- Expected: 24
