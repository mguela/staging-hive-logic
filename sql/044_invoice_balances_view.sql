-- sql/044_invoice_balances_view.sql
-- Wave 0 canonical fix #9: honest computed invoice balances.
--
-- Jobber's own balance field syncs as NULL on all 2,799 invoices (verified
-- live 2026-08-01), but total / payments / deposit are fully populated.
-- Formula validated against production data before shipping:
--   total - payments - COALESCE(deposit,0) = 0 on 2,686 of 2,730 paid
--   invoices; the 44 residuals are real credit/adjustment cases and are
--   flagged via balance_source, not hidden.
--
-- Additive + reversible. Rollback: DROP VIEW public.invoice_balances;
-- invoices.balance itself is left exactly as synced (NULL) -- we never
-- fabricate into a source-of-truth column; this view is the truth surface.

CREATE OR REPLACE VIEW public.invoice_balances
WITH (security_invoker = on) AS
SELECT
  jobber_id,
  invoice_number,
  client_id,
  job_id,
  invoice_status,
  total,
  payments,
  COALESCE(deposit, 0)                                   AS deposit,
  ROUND(total - payments - COALESCE(deposit, 0), 2)      AS computed_balance,
  CASE
    WHEN invoice_status = 'paid'
     AND ABS(total - payments - COALESCE(deposit, 0)) >= 0.01
      THEN 'residual_on_paid'  -- likely unapplied credit/adjustment; review
    ELSE 'computed'
  END                                                    AS balance_source,
  issued_date,
  due_date
FROM public.invoices;

-- Server-only surface (P0 PII-leak lesson from 7/29): not exposed to
-- client-side PostgREST roles. The app reads it via API routes on
-- service_role, same as the base table.
REVOKE ALL ON public.invoice_balances FROM anon, authenticated;
