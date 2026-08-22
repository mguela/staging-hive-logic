-- Adds availability-status tracking to the Time Clock feature.
-- Purely additive: new columns with safe defaults, no data loss, no rewrites of existing rows.
-- Run this once in the Supabase SQL editor (or via `psql`) against the production database.

ALTER TABLE workforce_time_sessions
  ADD COLUMN IF NOT EXISTS status_flag text NOT NULL DEFAULT 'available',
  ADD COLUMN IF NOT EXISTS status_emoji text NOT NULL DEFAULT '✅',
  ADD COLUMN IF NOT EXISTS status_updated_at timestamptz;
