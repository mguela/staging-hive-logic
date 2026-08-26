-- jomell, 2026-08-26: "lets start with the timesheet... we will copy it
-- into our own [Time & Timesheets tab]... once clicked on an empty date, a
-- window will popup its the 'create timesheet entry'."
--
-- time_sheet_entries is a Jobber-synced table (jobber_id primary key,
-- api/jobber/sync-extended.js's TimeSheetEntries query/mapTimeSheetEntry)
-- with no notes/label column at all -- Jobber's own timesheet API, as
-- queried there, never carries one. The Create Timesheet Entry popup needs
-- somewhere to put its Notes field. HiveLogic-created rows use their own
-- 'HL-TSE-<uuid>' jobber_id namespace (same convention as HL-INV-/HL-JOB-/
-- HL-CO-), so they are never touched by the Jobber sync -- this column is
-- populated only by HiveLogic's own create action and stays null on every
-- real synced entry, same as jobs.hl_closed_at's discipline.

begin;

alter table public.time_sheet_entries add column if not exists note text;

comment on column public.time_sheet_entries.note is
  'Set only by HiveLogic''s own Create Timesheet Entry action (api/track1.js''s handleCreateTimesheetEntry). Jobber''s own synced entries never populate this -- their query does not carry a notes field.';

commit;
