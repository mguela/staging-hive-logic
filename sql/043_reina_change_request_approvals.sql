-- 043_reina_change_request_approvals.sql
-- Reina M1a v0.1 -- observe + recommend on a client change request.
--
-- The ONLY schema change M1a needs: let the existing marketing_approvals
-- queue carry Reina's change-request observations. The table already models
-- exactly what we want (a pending, human-approvable recommendation with a
-- title, rationale, confidence, risks, and an optional amount) -- but its two
-- allow-list CHECK constraints predate Reina and reject the values M1a writes:
--
--   * approvable_type has no 'reina_change_request' member
--   * requested_by    has no 'reina' member
--
-- This migration ADDITIVELY widens both allow-lists. It is a strict superset:
-- every previously-legal row stays legal, and no existing code path or row is
-- affected. Postgres CHECK constraints can't be edited in place, so each is
-- dropped (IF EXISTS) and re-added with the new member -- making this file
-- safe to re-run.
--
-- Reina M1a itself performs NO other schema or data writes: its single runtime
-- write is one INSERT into marketing_approvals (status='pending'), which a
-- human still has to approve. No change order, email, or Jobber write happens.

BEGIN;

ALTER TABLE public.marketing_approvals
  DROP CONSTRAINT IF EXISTS marketing_approvals_approvable_type_check;
ALTER TABLE public.marketing_approvals
  ADD CONSTRAINT marketing_approvals_approvable_type_check
  CHECK (approvable_type = ANY (ARRAY[
    'CAMPAIGN_SPEND',
    'GENERATED_VIDEO',
    'WEBSITE_PROMOTION',
    'REVIEW_REPLY',
    'CLAIM_CORRECTION',
    'ACCOUNT_REPAIR',
    'BUDGET_ADJUSTMENT',
    'reina_change_request'
  ]));

ALTER TABLE public.marketing_approvals
  DROP CONSTRAINT IF EXISTS marketing_approvals_requested_by_check;
ALTER TABLE public.marketing_approvals
  ADD CONSTRAINT marketing_approvals_requested_by_check
  CHECK (requested_by = ANY (ARRAY[
    'system',
    'owner',
    'reina'
  ]));

COMMIT;
