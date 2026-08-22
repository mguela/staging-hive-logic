-- 033_card_pricing.sql
-- ADDITIVE ONLY. Safe to run more than once (IF NOT EXISTS guards).
-- Run once in the Supabase SQL editor.
--
-- Cash-discount (dual-price) program on T&M invoices (Chris, 2026-07-26;
-- processor: United Payment Corp / Authorize.Net — Sal's 4% program).
-- Full pricing rules + compliance framing documented in
-- server/bookkeeping/src/card-pricing.js. Estimates and Change Orders get
-- the same fields inside their jsonb `data` documents — no migration needed
-- there; this migration only covers tm_invoices' real columns.
--
-- Meaning of the columns:
--   total_amount     (existing) becomes the POSTED total (fee included) —
--                    what the invoice displays and what a card payment charges.
--   cash_amount      the normal price (labor + materials at normal rates) —
--                    what cash/check/ACH payers pay after the cash discount.
--   card_fee_amount  total_amount − cash_amount, snapshotted at creation.
--   card_rate_bps    program rate snapshot (400 = 4.00%); a later rate change
--                    never touches an already-generated invoice.
--   paid_method      'card' (set by the Authorize.Net webhook) or
--                    'cash' | 'check' | 'ach' (set by the tech's
--                    tm_invoice_mark_paid_offline action).
--   paid_amount      the dollars actually collected ($total for card,
--                    $cash for offline methods).
-- Invoices created before this migration have NULLs in the new columns and
-- keep behaving exactly as before (no fee, no discount).

alter table tm_invoices add column if not exists card_rate_bps integer;
alter table tm_invoices add column if not exists card_fee_amount numeric;
alter table tm_invoices add column if not exists cash_amount numeric;
alter table tm_invoices add column if not exists paid_method text;
alter table tm_invoices add column if not exists paid_amount numeric;

comment on column tm_invoices.card_rate_bps is
  'Cash-discount program rate snapshot at invoice creation (400 = 4.00%). NULL on pre-program invoices.';
comment on column tm_invoices.cash_amount is
  'Normal price (cash/check/ACH price after the cash discount). total_amount is the posted card-inclusive total.';
comment on column tm_invoices.paid_method is
  'card = confirmed by signature-verified Authorize.Net webhook; cash/check/ach = recorded by staff via tm_invoice_mark_paid_offline.';
