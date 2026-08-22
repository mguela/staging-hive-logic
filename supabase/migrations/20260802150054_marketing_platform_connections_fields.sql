-- sql/054_marketing_platform_connections_fields.sql
-- Phase 15 (Universal Connections framework) of the Marketing Suite build.
-- ADDITIVE ONLY: adds one nullable-safe jsonb column to
-- marketing_platform_connections. No existing column, row, or constraint
-- is touched.
--
-- Why this is needed: the account-metadata columns this table already has
-- (account_name, account_id, login_account_id, note) were designed around
-- OAuth-style platforms (Google Ads, Meta) where a name/ID pair is enough.
-- Once real, non-OAuth connector types are declared with their own field
-- schemas (see CONNECTOR_FIELD_SCHEMAS in api/marketing.js, shipped
-- alongside the connector-catalog slice) -- e.g. website_cms needs a CMS
-- platform choice, a site URL, and an API key; direct_mail needs a vendor
-- name -- those values don't fit the fixed account_name/account_id shape.
-- A single jsonb column lets every connector type store exactly the
-- fields it declared, with no further schema changes needed as new
-- connector types are added later.
alter table marketing_platform_connections
  add column if not exists fields jsonb not null default '{}'::jsonb;
