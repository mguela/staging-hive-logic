-- 004_qbo_integration.sql
-- ADDITIVE ONLY. QuickBooks reuses the existing `integrations` table (the
-- same one Jobber's tokens already live in, keyed by `key`) instead of a new
-- table -- api/_lib/jobber.js's saveTokens()/getStoredTokens() already prove
-- this table's shape works for exactly this kind of OAuth token storage.
-- This migration ONLY adds two nullable columns QuickBooks needs that
-- Jobber's row doesn't use (realm_id, environment); it does not touch the
-- Jobber row, its columns, or any other row in this table.
--
-- Run this once in the Supabase SQL editor before hitting /api/qbo.
-- Safe to run more than once (IF NOT EXISTS guards).

alter table if exists integrations
  add column if not exists realm_id text;

alter table if exists integrations
  add column if not exists environment text;
