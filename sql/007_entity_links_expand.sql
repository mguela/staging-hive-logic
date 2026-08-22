-- 007_entity_links_expand.sql
-- ADDITIVE / ALTER ONLY. Widens media_entity_links.entity_type (created in
-- 006_visual_intel.sql) from its original 8-value check constraint to the
-- full HiveLogicEntityType list the Visual Intelligence UI actually offers
-- in its "Linked to" picker (packages/shared/src/types.ts). The table and
-- its data are untouched -- this only replaces the CHECK constraint so rows
-- with the newer entity types (ESTIMATE, TASK, CREW, EQUIPMENT, PERMIT,
-- etc.) can actually be inserted instead of failing with a constraint
-- violation.
--
-- Run this once in the Supabase SQL editor (Project -> SQL Editor -> New
-- query -> paste -> Run). Safe to run more than once.

alter table media_entity_links drop constraint if exists media_entity_links_entity_type_check;

alter table media_entity_links add constraint media_entity_links_entity_type_check
  check (entity_type in (
    'JOB', 'ESTIMATE', 'ESTIMATE_LINE_ITEM', 'TASK', 'ACTIVITY', 'SCHEDULE_ITEM',
    'CREW', 'EMPLOYEE', 'VENDOR', 'SUBCONTRACTOR', 'EQUIPMENT', 'TRUCK', 'MATERIAL',
    'PURCHASE_ORDER', 'INVOICE', 'CHANGE_ORDER', 'ISSUE', 'WARRANTY', 'INSPECTION',
    'PERMIT', 'CLIENT', 'PROPERTY', 'ASSET', 'COMMUNICATION', 'EXPENSE',
    'FINANCIAL_TRANSACTION',
    -- legacy values already usable before this migration -- kept so any
    -- existing rows from before this change still satisfy the constraint
    'QUOTE', 'REQUEST', 'VISIT', 'TIMESHEET'
  ));
