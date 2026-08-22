-- Job Setup & Readiness Gate: extends job_workflow (sql/014) with real
-- checklist-item tracking + a logged override trail. Matches the 5-gate/
-- 12-item structure already sketched in the page's own mockup (GATES array
-- in public/index.html, if-jsx), confirmed with Chris 2026-07-21 as the
-- real spec to build against.
alter table job_workflow
  add column if not exists readiness_items jsonb not null default '{}'::jsonb,
  add column if not exists readiness_override_at timestamptz,
  add column if not exists readiness_override_by text,
  add column if not exists readiness_override_reason text;

comment on column job_workflow.readiness_items is
  'Per-item checklist state for the Job Setup & Readiness gate. Shape: {"<gateKey>.<itemKey>": {"done": bool, "at": iso timestamp, "by": text}}. Item keys match GATES in the jsx page script.';
comment on column job_workflow.readiness_override_at is
  'When set, a failing gate was manually overridden to unlock scheduling. Always paired with readiness_override_by and readiness_override_reason -- the gate refuses silently, only a logged human override bypasses it.';
