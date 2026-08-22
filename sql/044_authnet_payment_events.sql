-- sql/044_authnet_payment_events.sql
-- Auditable ledger + idempotency guard for Authorize.Net webhook deliveries
-- (2026-08-01, stabilization item 4). api/authnet-webhook.js writes one row
-- per delivered event. notification_id is Authorize.Net's own webhook
-- notificationId and is UNIQUE, so a duplicate/retried delivery is detected
-- and never double-applied.
--
-- Marking tm_invoices paid happens ONLY when transaction_status is
-- 'settledSuccessfully' (a capture/authcapture event is not settlement).
-- Service-role only (RLS enabled, no policies) -- same secure-by-default
-- pattern as tm_invoices / webhook_events.

create table if not exists authnet_payment_events (
  id                 bigint generated always as identity primary key,
  notification_id    text not null unique,        -- Authorize.Net webhook notificationId; idempotency key
  event_type         text,                        -- e.g. net.authorize.payment.authcapture.created
  transaction_id     text,                        -- Authorize.Net transId (payload.id)
  invoice_number     text,                        -- resolved order.invoiceNumber
  invoice_id         uuid,                        -- resolved tm_invoices.id, when matched
  transaction_status text,                        -- settledSuccessfully | capturedPendingSettlement | ...
  outcome            text not null default 'received', -- received | processed | unsettled | ignored | unmatched | unresolved
  applied_paid       boolean not null default false,   -- true only once the invoice was actually marked paid
  raw_event          jsonb,                       -- the verified webhook body, for manual recovery/audit
  raw_transaction    jsonb,                       -- getTransactionDetails snapshot at processing time
  received_at        timestamptz not null default now(),
  processed_at       timestamptz
);

create index if not exists authnet_payment_events_transaction_idx
  on authnet_payment_events (transaction_id);
create index if not exists authnet_payment_events_invoice_idx
  on authnet_payment_events (invoice_id);

alter table authnet_payment_events enable row level security;
-- No permissive policies -- only the service-role key (server-side, via
-- api/authnet-webhook.js) can read/write.

comment on table authnet_payment_events is
  'Audit ledger + idempotency guard for Authorize.Net webhook deliveries. notification_id is unique; an invoice is only marked paid when transaction_status = settledSuccessfully.';
