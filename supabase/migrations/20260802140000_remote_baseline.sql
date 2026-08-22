


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."allocate_co_number"("p_company_id" "text", "p_job_id" "text", "p_company_code" "text" DEFAULT 'CO'::"text") RETURNS TABLE("co_number" "text", "sequence_no" integer)
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_seq integer;
begin
  if p_job_id is null or p_job_id = '' then
    raise exception 'A change order must be chained to a job -- p_job_id is required.';
  end if;

  insert into co_counters (company_id, job_id, next_sequence)
    values (p_company_id, p_job_id, 1)
  on conflict (company_id, job_id)
    do update set next_sequence = co_counters.next_sequence + 1, updated_at = now()
  returning next_sequence into v_seq;

  if v_seq is null then
    v_seq := 1;
  end if;

  co_number := p_company_code || '-' || p_job_id || '-' || lpad(v_seq::text, 2, '0');
  sequence_no := v_seq;
  return next;
end;
$$;


ALTER FUNCTION "public"."allocate_co_number"("p_company_id" "text", "p_job_id" "text", "p_company_code" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."allocate_estimate_number"("p_company_id" "text", "p_company_code" "text" DEFAULT 'EST'::"text") RETURNS TABLE("estimate_number" "text", "sequence_no" integer)
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_seq integer;
begin
  insert into est_counters (company_id, next_sequence)
    values (p_company_id, 1)
  on conflict (company_id)
    do update set next_sequence = est_counters.next_sequence + 1, updated_at = now()
  returning next_sequence into v_seq;

  if v_seq is null then
    v_seq := 1;
  end if;

  estimate_number := p_company_code || '-' || lpad(v_seq::text, 4, '0');
  sequence_no := v_seq;
  return next;
end;
$$;


ALTER FUNCTION "public"."allocate_estimate_number"("p_company_id" "text", "p_company_code" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."allocate_po_number"("p_company_id" "text", "p_scope_key" "text", "p_job_id" "text", "p_company_code" "text" DEFAULT 'PO'::"text") RETURNS TABLE("po_number" "text", "sequence_no" integer)
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  v_seq integer;
begin
  insert into po_counters (company_id, scope_key, next_sequence)
    values (p_company_id, p_scope_key, 1)
  on conflict (company_id, scope_key)
    do update set next_sequence = po_counters.next_sequence + 1, updated_at = now()
  returning next_sequence into v_seq;

  if v_seq is null then
    v_seq := 1;
  end if;

  if p_job_id is not null and p_job_id <> '' then
    po_number := p_company_code || '-' || p_job_id || '-' || lpad(v_seq::text, 2, '0');
  else
    po_number := p_company_code || '-GEN-' || lpad(v_seq::text, 4, '0');
  end if;
  sequence_no := v_seq;
  return next;
end;
$$;


ALTER FUNCTION "public"."allocate_po_number"("p_company_id" "text", "p_scope_key" "text", "p_job_id" "text", "p_company_code" "text") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."purchase_orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "po_number" "text" NOT NULL,
    "job_id" "text",
    "overhead_category" "text",
    "order_type" "text" NOT NULL,
    "lifecycle_status" "text" NOT NULL,
    "not_preapproved" boolean DEFAULT false NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "data" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "job_uuid" "uuid"
);


ALTER TABLE "public"."purchase_orders" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."apply_po_batch_update"("p_updates" "jsonb", "p_seen_bill" "jsonb" DEFAULT NULL::"jsonb") RETURNS SETOF "public"."purchase_orders"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  upd jsonb;
  updated_row purchase_orders%rowtype;
begin
  for upd in select * from jsonb_array_elements(p_updates)
  loop
    update purchase_orders
    set
      po_number = upd->>'po_number',
      job_id = nullif(upd->>'job_id', ''),
      overhead_category = nullif(upd->>'overhead_category', ''),
      order_type = upd->>'order_type',
      lifecycle_status = upd->>'lifecycle_status',
      not_preapproved = (upd->>'not_preapproved')::boolean,
      data = upd->'data',
      version = (upd->>'expected_version')::integer + 1,
      updated_at = now()
    where company_id = upd->>'company_id'
      and data->>'id' = upd->>'po_id'
      and version = (upd->>'expected_version')::integer
    returning * into updated_row;

    if not found then
      raise exception 'CONCURRENT_CONFLICT: purchase order %  was modified by someone else since it was read (expected version %). Rolling back the entire batch so the receipt is never left half-posted.',
        upd->>'po_id', upd->>'expected_version';
    end if;

    return next updated_row;
  end loop;

  if p_seen_bill is not null then
    insert into po_seen_bills (
      company_id, qbo_vendor_id, vendor_name, invoice_number, currency, amount, evidence_hash, source_transaction_id
    ) values (
      p_seen_bill->>'company_id',
      p_seen_bill->>'qbo_vendor_id',
      p_seen_bill->>'vendor_name',
      p_seen_bill->>'invoice_number',
      p_seen_bill->>'currency',
      nullif(p_seen_bill->>'amount', '')::numeric,
      p_seen_bill->>'evidence_hash',
      p_seen_bill->>'source_transaction_id'
    )
    on conflict (company_id, source_transaction_id) do nothing;
  end if;
end;
$$;


ALTER FUNCTION "public"."apply_po_batch_update"("p_updates" "jsonb", "p_seen_bill" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."apply_sensitive_default"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$ begin if new.doc_type in ('contract','payroll') and new.sensitive is not true then new.sensitive := true; end if; return new; end; $$;


ALTER FUNCTION "public"."apply_sensitive_default"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."bookkeeping_audit_log_immutable"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  raise exception 'bookkeeping_audit_log is append-only -- % is not permitted', TG_OP;
end;
$$;


ALTER FUNCTION "public"."bookkeeping_audit_log_immutable"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."can_access_folder"("target" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$ declare granted boolean; begin if public.is_admin() then return true; end if; if target is null then return true; end if; with recursive chain as ( select id, parent_id, is_public from public.folders where id = target union all select f.id, f.parent_id, f.is_public from public.folders f join chain c on f.id = c.parent_id ) select exists ( select 1 from chain c where c.is_public or exists ( select 1 from public.folder_access fa where fa.folder_id = c.id and fa.user_id = auth.uid() ) ) into granted; return coalesce(granted, false); end; $$;


ALTER FUNCTION "public"."can_access_folder"("target" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."can_see_folder"("target" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$ declare visible boolean; begin if target is null or public.can_access_folder(target) then return true; end if; with recursive descendants as ( select id from public.folders where parent_id = target union all select f.id from public.folders f join descendants d on f.parent_id = d.id ) select exists ( select 1 from descendants d join public.folders f on f.id = d.id where f.is_public or exists ( select 1 from public.folder_access fa where fa.folder_id = d.id and fa.user_id = auth.uid() ) ) into visible; return coalesce(visible, false); end; $$;


ALTER FUNCTION "public"."can_see_folder"("target" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$ begin insert into public.profiles (id, email, full_name, role) values ( new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)), case when not exists (select 1 from public.profiles) then 'admin' else 'crew' end ); return new; end; $$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$ select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'); $$;


ALTER FUNCTION "public"."is_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."protect_locked_geocode"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF OLD.geocode_locked IS TRUE AND NEW.geocode_locked IS TRUE THEN
    NEW.lat := OLD.lat;
    NEW.lng := OLD.lng;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."protect_locked_geocode"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prune_monitor_data"("retention_days" integer DEFAULT 90) RETURNS TABLE("activity_samples_deleted" bigint, "pair_attempts_deleted" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  cutoff timestamptz := now() - make_interval(days => greatest(retention_days, 1));
  n_samples bigint;
  n_attempts bigint;
begin
  delete from monitor_activity_samples where sampled_at < cutoff;
  get diagnostics n_samples = row_count;

  delete from monitor_pair_attempts where attempted_at < cutoff;
  get diagnostics n_attempts = row_count;

  return query select n_samples, n_attempts;
end;
$$;


ALTER FUNCTION "public"."prune_monitor_data"("retention_days" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prune_oauth_states"() RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
  delete from public.oauth_states
   where used_at is not null
      or expires_at < now() - interval '1 day';
$$;


ALTER FUNCTION "public"."prune_oauth_states"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prune_portal_rate_limits"() RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
  delete from public.portal_rate_limits where created_at < now() - interval '1 day';
$$;


ALTER FUNCTION "public"."prune_portal_rate_limits"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."snapshot_aggregates"() RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
with inv as (
  select lower(trim(coalesce(invoice_status,''))) as st,
         (coalesce(total,0) - coalesce(payments,0)) as bal,
         due_date
  from public.invoices
)
select jsonb_build_object(
  'counts', jsonb_build_object(
    'clients',       (select count(*) from public.clients),
    'activeClients', (select count(*) from public.clients where is_archived is distinct from true),
    'leads',         (select count(*) from public.clients where is_lead is true),
    'jobs',          (select count(*) from public.jobs),
    'invoices',      (select count(*) from public.invoices)
  ),
  'jobsByStatus', (
    select coalesce(jsonb_object_agg(k, n), '{}'::jsonb)
    from (
      select coalesce(nullif(job_status, ''), 'unknown') as k, count(*) as n
      from public.jobs group by 1
    ) g
  ),
  'ar', jsonb_build_object(
    'openInvoices', (select count(*) from inv where st in ('awaiting_payment','past_due') and bal > 0.01),
    'outstanding',  (select coalesce(round(sum(outstanding), 2), 0) from public.client_ar_outstanding),
    'overdueCount', (select count(*) from inv where st in ('awaiting_payment','past_due') and bal > 0.01 and due_date is not null and due_date < now()),
    'excluded', jsonb_build_object(
      'draftUnsent',       (select jsonb_build_object('count', count(*), 'amount', coalesce(round(sum(bal),2),0)) from inv where st = 'draft'    and bal > 0.01),
      'writtenOffBadDebt', (select jsonb_build_object('count', count(*), 'amount', coalesce(round(sum(bal),2),0)) from inv where st = 'bad_debt' and bal > 0.01),
      'markedPaid',        (select jsonb_build_object('count', count(*), 'amount', coalesce(round(sum(bal),2),0)) from inv where st = 'paid'     and bal > 0.01)
    )
  )
);
$$;


ALTER FUNCTION "public"."snapshot_aggregates"() OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."annotations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "media_id" "uuid" NOT NULL,
    "annotation_type" "text" NOT NULL,
    "data" "jsonb" NOT NULL,
    "frame_time_ms" integer,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "superseded_by" "uuid",
    CONSTRAINT "annotations_annotation_type_check" CHECK (("annotation_type" = ANY (ARRAY['DRAWING'::"text", 'ARROW'::"text", 'LINE'::"text", 'RECTANGLE'::"text", 'CIRCLE'::"text", 'TEXT'::"text", 'MEASUREMENT'::"text", 'BLUR'::"text"])))
);


ALTER TABLE "public"."annotations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."invoices" (
    "jobber_id" "text" NOT NULL,
    "client_id" "text",
    "invoice_number" "text",
    "invoice_status" "text",
    "subject" "text",
    "total" numeric,
    "balance" numeric,
    "subtotal" numeric,
    "tax" numeric,
    "deposit" numeric,
    "discount" numeric,
    "payments" numeric,
    "due_date" timestamp with time zone,
    "issued_date" timestamp with time zone,
    "jobber_web_uri" "text",
    "jobber_created_at" timestamp with time zone,
    "jobber_updated_at" timestamp with time zone,
    "synced_at" timestamp with time zone DEFAULT "now"(),
    "job_id" "text",
    "line_items" "jsonb",
    "uuid_id" "uuid" DEFAULT "gen_random_uuid"(),
    "client_uuid" "uuid",
    "job_uuid" "uuid",
    "company_id" "uuid" DEFAULT '82cf7354-e460-4863-9f01-d67b3ad05d4a'::"uuid"
);


ALTER TABLE "public"."invoices" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."invoice_balances" WITH ("security_invoker"='on') AS
 SELECT "jobber_id",
    "invoice_number",
    "client_id",
    "job_id",
    "invoice_status",
    "total",
    "payments",
    COALESCE("deposit", (0)::numeric) AS "deposit",
    "round"((("total" - "payments") - COALESCE("deposit", (0)::numeric)), 2) AS "computed_balance",
        CASE
            WHEN (("invoice_status" = 'paid'::"text") AND ("abs"((("total" - "payments") - COALESCE("deposit", (0)::numeric))) >= 0.01)) THEN 'residual_on_paid'::"text"
            ELSE 'computed'::"text"
        END AS "balance_source",
    "issued_date",
    "due_date"
   FROM "public"."invoices";


ALTER VIEW "public"."invoice_balances" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."ar_aging" WITH ("security_invoker"='on') AS
 SELECT "jobber_id",
    "invoice_number",
    "client_id",
    "job_id",
    "invoice_status",
    "computed_balance",
    "balance_source",
    "issued_date",
    "due_date",
    GREATEST(0, (CURRENT_DATE - ("due_date")::"date")) AS "days_overdue",
        CASE
            WHEN ("due_date" IS NULL) THEN 'no_due_date'::"text"
            WHEN (CURRENT_DATE <= ("due_date")::"date") THEN 'current'::"text"
            WHEN ((CURRENT_DATE - ("due_date")::"date") <= 30) THEN '1-30'::"text"
            WHEN ((CURRENT_DATE - ("due_date")::"date") <= 60) THEN '31-60'::"text"
            WHEN ((CURRENT_DATE - ("due_date")::"date") <= 90) THEN '61-90'::"text"
            ELSE '90+'::"text"
        END AS "aging_bucket"
   FROM "public"."invoice_balances"
  WHERE (("invoice_status" = ANY (ARRAY['past_due'::"text", 'awaiting_payment'::"text"])) AND ("computed_balance" > (0)::numeric));


ALTER VIEW "public"."ar_aging" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."authnet_payment_events" (
    "id" bigint NOT NULL,
    "notification_id" "text" NOT NULL,
    "event_type" "text",
    "transaction_id" "text",
    "invoice_number" "text",
    "invoice_id" "uuid",
    "transaction_status" "text",
    "outcome" "text" DEFAULT 'received'::"text" NOT NULL,
    "applied_paid" boolean DEFAULT false NOT NULL,
    "raw_event" "jsonb",
    "raw_transaction" "jsonb",
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "processed_at" timestamp with time zone
);


ALTER TABLE "public"."authnet_payment_events" OWNER TO "postgres";


COMMENT ON TABLE "public"."authnet_payment_events" IS 'Audit ledger + idempotency guard for Authorize.Net webhook deliveries. notification_id is unique; an invoice is only marked paid when transaction_status = settledSuccessfully.';



ALTER TABLE "public"."authnet_payment_events" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."authnet_payment_events_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."automation_agent_credentials" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "text" DEFAULT 'ghgrp'::"text" NOT NULL,
    "agent_id" "uuid" NOT NULL,
    "secret_hash" "text" NOT NULL,
    "expires_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    "last_used_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."automation_agent_credentials" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."automation_agent_permissions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "text" DEFAULT 'ghgrp'::"text" NOT NULL,
    "agent_id" "uuid" NOT NULL,
    "scope_type" "text" NOT NULL,
    "canonical_path" "text" NOT NULL,
    "permissions" "jsonb" DEFAULT '["read"]'::"jsonb" NOT NULL,
    "approved_by" "uuid",
    "revoked_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "automation_agent_permissions_scope_type_check" CHECK (("scope_type" = ANY (ARRAY['folder'::"text", 'repository'::"text"])))
);


ALTER TABLE "public"."automation_agent_permissions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."automation_agents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "text" DEFAULT 'ghgrp'::"text" NOT NULL,
    "display_name" "text" NOT NULL,
    "hostname" "text" NOT NULL,
    "platform" "text" DEFAULT 'windows'::"text" NOT NULL,
    "agent_version" "text",
    "status" "text" DEFAULT 'offline'::"text" NOT NULL,
    "paused_at" timestamp with time zone,
    "emergency_stopped_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    "last_heartbeat_at" timestamp with time zone,
    "current_task_id" "uuid",
    "capabilities" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "automation_agents_status_check" CHECK (("status" = ANY (ARRAY['online'::"text", 'offline'::"text", 'paused'::"text", 'emergency_stopped'::"text", 'revoked'::"text"])))
);


ALTER TABLE "public"."automation_agents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."automation_enrollment_codes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "text" DEFAULT 'ghgrp'::"text" NOT NULL,
    "code_hash" "text" NOT NULL,
    "created_by" "uuid",
    "expires_at" timestamp with time zone NOT NULL,
    "used_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."automation_enrollment_codes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."automation_task_approvals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "text" DEFAULT 'ghgrp'::"text" NOT NULL,
    "task_id" "uuid" NOT NULL,
    "scope_hash" "text" NOT NULL,
    "decision" "text" NOT NULL,
    "decided_by" "uuid",
    "reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "automation_task_approvals_decision_check" CHECK (("decision" = ANY (ARRAY['approved'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."automation_task_approvals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."automation_task_events" (
    "id" bigint NOT NULL,
    "tenant_id" "text" DEFAULT 'ghgrp'::"text" NOT NULL,
    "task_id" "uuid",
    "agent_id" "uuid",
    "event_type" "text" NOT NULL,
    "level" "text" DEFAULT 'info'::"text" NOT NULL,
    "message" "text",
    "data" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."automation_task_events" OWNER TO "postgres";


ALTER TABLE "public"."automation_task_events" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."automation_task_events_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."automation_tasks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "text" DEFAULT 'ghgrp'::"text" NOT NULL,
    "agent_id" "uuid" NOT NULL,
    "task_type" "text" NOT NULL,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "scope_hash" "text" NOT NULL,
    "risk_tier" "text" NOT NULL,
    "status" "text" DEFAULT 'pending_approval'::"text" NOT NULL,
    "created_by" "uuid",
    "approved_at" timestamp with time zone,
    "claimed_at" timestamp with time zone,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "lease_expires_at" timestamp with time zone,
    "result_summary" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "automation_tasks_risk_tier_check" CHECK (("risk_tier" = ANY (ARRAY['read_only'::"text", 'write'::"text", 'deploy'::"text"]))),
    CONSTRAINT "automation_tasks_status_check" CHECK (("status" = ANY (ARRAY['pending_approval'::"text", 'queued'::"text", 'claimed'::"text", 'running'::"text", 'succeeded'::"text", 'failed'::"text", 'cancel_requested'::"text", 'cancelled'::"text", 'blocked'::"text"])))
);


ALTER TABLE "public"."automation_tasks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bookkeeping_audit_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "source" "text" NOT NULL,
    "seq" integer NOT NULL,
    "record_id" "text" NOT NULL,
    "previous_hash" "text",
    "hash" "text" NOT NULL,
    "recorded_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "payload" "jsonb" NOT NULL,
    CONSTRAINT "bookkeeping_audit_log_source_check" CHECK (("source" = ANY (ARRAY['ledger'::"text", 'controls'::"text"])))
);


ALTER TABLE "public"."bookkeeping_audit_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bookkeeping_catalog_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "type" "text" NOT NULL,
    "name" "text" NOT NULL,
    "nickname" "text",
    "sku" "text",
    "version" integer DEFAULT 1 NOT NULL,
    "data" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "bookkeeping_catalog_items_type_check" CHECK (("type" = ANY (ARRAY['material'::"text", 'expense'::"text"])))
);


ALTER TABLE "public"."bookkeeping_catalog_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bookkeeping_contractor_profiles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "vendor_key" "text" NOT NULL,
    "data" "jsonb" NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."bookkeeping_contractor_profiles" OWNER TO "postgres";


COMMENT ON TABLE "public"."bookkeeping_contractor_profiles" IS 'One row per company+vendor: 1099/W-9 tracking status feeding contractorTaxReport(). Keyed by a normalized vendor name (see server/bookkeeping/src/catalog.js''s normalizeCatalogTerm), not a formal vendor id -- this app records vendors as free text on expenses/receipts.';



CREATE TABLE IF NOT EXISTS "public"."bookkeeping_evidence_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "filename" "text" NOT NULL,
    "mime_type" "text" NOT NULL,
    "size_bytes" integer NOT NULL,
    "sha256" "text" NOT NULL,
    "data_base64" "text" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "status" "text" DEFAULT 'received'::"text" NOT NULL,
    "resolution" "text",
    "review_note" "text",
    "reviewed_at" timestamp with time zone,
    "reviewed_by" "uuid",
    "document_type" "text",
    "extracted" "jsonb"
);


ALTER TABLE "public"."bookkeeping_evidence_documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bookkeeping_expenses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "status" "text" NOT NULL,
    "transaction_kind" "text",
    "qbo_vendor_id" "text",
    "vendor_name" "text",
    "transaction_date" "date",
    "due_date" "date",
    "payment_account_id" "text",
    "payment_type" "text",
    "receipt_subtotal" numeric,
    "sales_tax_total" numeric,
    "total" numeric,
    "version" integer DEFAULT 1 NOT NULL,
    "data" "jsonb" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "bookkeeping_expenses_status_check" CHECK (("status" = ANY (ARRAY['draft_saved'::"text", 'submitted_for_review'::"text"])))
);


ALTER TABLE "public"."bookkeeping_expenses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bookkeeping_reina_learning" (
    "company_id" "text" NOT NULL,
    "data" "jsonb" NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."bookkeeping_reina_learning" OWNER TO "postgres";


COMMENT ON TABLE "public"."bookkeeping_reina_learning" IS 'One row per company: Reina''s approved-learning memory (server/bookkeeping/src/reina-learning.js''s ensureLearningState() shape), versioned for optimistic-concurrency updates.';



CREATE TABLE IF NOT EXISTS "public"."bookkeeping_sales_tax_entries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "kind" "text" NOT NULL,
    "tax_state" "text" NOT NULL,
    "entry_date" "date" NOT NULL,
    "data" "jsonb" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "bookkeeping_sales_tax_entries_kind_check" CHECK (("kind" = ANY (ARRAY['collected'::"text", 'remitted'::"text"]))),
    CONSTRAINT "bookkeeping_sales_tax_entries_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'void'::"text"])))
);


ALTER TABLE "public"."bookkeeping_sales_tax_entries" OWNER TO "postgres";


COMMENT ON TABLE "public"."bookkeeping_sales_tax_entries" IS 'Manually-logged sales-tax-collected and tax-remitted-to-state entries feeding salesTaxLiability(). Void (not deleted) to preserve an audit trail -- see api/bookkeeping/_sales_tax_store.js.';



CREATE TABLE IF NOT EXISTS "public"."bridge_heartbeats" (
    "id" bigint NOT NULL,
    "source" "text" DEFAULT 'fractal-pc'::"text" NOT NULL,
    "pinged_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "meta" "jsonb"
);


ALTER TABLE "public"."bridge_heartbeats" OWNER TO "postgres";


ALTER TABLE "public"."bridge_heartbeats" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."bridge_heartbeats_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."business_functions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "purpose" "text",
    "division" "text",
    "current_owner" "text",
    "frequency" "text",
    "delivery_model" "text" DEFAULT 'unassessed'::"text",
    "risk_level" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "business_functions_delivery_model_check" CHECK (("delivery_model" = ANY (ARRAY['human_led'::"text", 'ai_assisted_human'::"text", 'automation_with_oversight'::"text", 'vendor_led'::"text", 'internalized'::"text", 'eliminated'::"text", 'unassessed'::"text"]))),
    CONSTRAINT "business_functions_frequency_check" CHECK (("frequency" = ANY (ARRAY['continuous'::"text", 'daily'::"text", 'weekly'::"text", 'monthly'::"text", 'per_job'::"text", 'occasional'::"text"]))),
    CONSTRAINT "business_functions_risk_level_check" CHECK (("risk_level" = ANY (ARRAY['low'::"text", 'medium'::"text", 'high'::"text"])))
);


ALTER TABLE "public"."business_functions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."campaign_activity_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "campaign_id" "uuid" NOT NULL,
    "event" "text" NOT NULL,
    "actor" "text",
    "detail" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."campaign_activity_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."campaign_recipients" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "campaign_id" "uuid" NOT NULL,
    "client_id" "text",
    "target_record_id" "text",
    "target_record_type" "text",
    "sent_at" timestamp with time zone,
    "outcome" "text" DEFAULT 'no_response'::"text" NOT NULL,
    "outcome_value" numeric,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "client_uuid" "uuid",
    CONSTRAINT "campaign_recipients_outcome_check" CHECK (("outcome" = ANY (ARRAY['no_response'::"text", 'responded'::"text", 'booked'::"text"])))
);


ALTER TABLE "public"."campaign_recipients" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."campaign_variants" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "text" DEFAULT 'ghgrp'::"text" NOT NULL,
    "campaign_id" "uuid" NOT NULL,
    "opportunity_id" "uuid",
    "label" "text",
    "channel" "text" DEFAULT 'email'::"text" NOT NULL,
    "subject" "text",
    "body" "text",
    "media_refs" "jsonb",
    "generated_by" "text" DEFAULT 'ai'::"text" NOT NULL,
    "status" "text" DEFAULT 'proposed'::"text" NOT NULL,
    "selected_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "campaign_variants_channel_check" CHECK (("channel" = ANY (ARRAY['email'::"text", 'sms'::"text", 'mail'::"text"]))),
    CONSTRAINT "campaign_variants_generated_by_check" CHECK (("generated_by" = ANY (ARRAY['ai'::"text", 'owner'::"text"]))),
    CONSTRAINT "campaign_variants_status_check" CHECK (("status" = ANY (ARRAY['proposed'::"text", 'selected'::"text", 'rejected'::"text", 'sent'::"text"])))
);


ALTER TABLE "public"."campaign_variants" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."campaigns" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "type" "text" NOT NULL,
    "target_filter" "jsonb",
    "channel" "text" DEFAULT 'email'::"text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "notes" "text",
    "created_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "scheduled_at" timestamp with time zone,
    "updated_by" "text",
    "subject" "text",
    "body" "text",
    CONSTRAINT "campaigns_channel_check" CHECK (("channel" = ANY (ARRAY['email'::"text", 'sms'::"text", 'mail'::"text"]))),
    CONSTRAINT "campaigns_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'active'::"text", 'paused'::"text", 'completed'::"text"]))),
    CONSTRAINT "campaigns_type_check" CHECK (("type" = ANY (ARRAY['estimate_recovery'::"text", 'review_request'::"text", 'reactivation'::"text", 'referral'::"text", 'seasonal'::"text", 'custom'::"text"])))
);


ALTER TABLE "public"."campaigns" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."change_orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "co_number" "text" NOT NULL,
    "job_id" "text" NOT NULL,
    "kind" "text" NOT NULL,
    "lifecycle_status" "text" NOT NULL,
    "auto_approved" boolean DEFAULT false NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "data" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "job_uuid" "uuid"
);


ALTER TABLE "public"."change_orders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."client_approvals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_ref" "text" NOT NULL,
    "job_ref" "text",
    "kind" "text" NOT NULL,
    "number" "text",
    "title" "text" NOT NULL,
    "description" "text",
    "amount" numeric,
    "payment_terms" "text",
    "doc_url" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "sent_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "responded_at" timestamp with time zone,
    "signer_name" "text",
    "signature_ip" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."client_approvals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."clients" (
    "jobber_id" "text" NOT NULL,
    "first_name" "text",
    "last_name" "text",
    "company_name" "text",
    "name" "text",
    "is_company" boolean,
    "is_lead" boolean,
    "is_archived" boolean,
    "balance" numeric,
    "email" "text",
    "phone" "text",
    "jobber_web_uri" "text",
    "jobber_created_at" timestamp with time zone,
    "jobber_updated_at" timestamp with time zone,
    "synced_at" timestamp with time zone DEFAULT "now"(),
    "phone_e164" "text",
    "uuid_id" "uuid" DEFAULT "gen_random_uuid"(),
    "company_id" "uuid" DEFAULT '82cf7354-e460-4863-9f01-d67b3ad05d4a'::"uuid"
);


ALTER TABLE "public"."clients" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."client_ar_outstanding" WITH ("security_invoker"='true') AS
 SELECT "jobber_id" AS "client_id",
    COALESCE(NULLIF("name", ''::"text"), NULLIF(TRIM(BOTH FROM "concat_ws"(' '::"text", "first_name", "last_name")), ''::"text"), NULLIF("company_name", ''::"text")) AS "client_name",
    "balance" AS "jobber_balance",
    GREATEST("balance", (0)::numeric) AS "outstanding",
    "jobber_web_uri",
    "synced_at"
   FROM "public"."clients" "c"
  WHERE ("balance" > (0)::numeric);


ALTER VIEW "public"."client_ar_outstanding" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."client_audit_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_ref" "text",
    "actor" "text" DEFAULT 'client'::"text" NOT NULL,
    "action" "text" NOT NULL,
    "entity_type" "text",
    "entity_id" "uuid",
    "detail" "jsonb",
    "ip" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."client_audit_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."client_auth_links" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_ref" "text" NOT NULL,
    "token" "text" NOT NULL,
    "purpose" "text" DEFAULT 'login'::"text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "used_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."client_auth_links" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."client_locations" (
    "jobber_id" "text" NOT NULL,
    "street" "text",
    "city" "text",
    "province" "text",
    "postal_code" "text",
    "country" "text",
    "lat" numeric,
    "lng" numeric,
    "geocode_match" boolean,
    "synced_at" timestamp with time zone,
    "geocoded_at" timestamp with time zone,
    "geocode_locked" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."client_locations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."client_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_ref" "text" NOT NULL,
    "job_ref" "text",
    "sender" "text" NOT NULL,
    "body" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "read_at" timestamp with time zone
);


ALTER TABLE "public"."client_messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."client_notifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_ref" "text" NOT NULL,
    "type" "text" NOT NULL,
    "title" "text" NOT NULL,
    "body" "text",
    "action_url" "text",
    "entity_type" "text",
    "entity_id" "uuid",
    "read_at" timestamp with time zone,
    "send_after" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."client_notifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."client_payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_ref" "text" NOT NULL,
    "invoice_ref" "text",
    "amount" numeric NOT NULL,
    "method" "text",
    "status" "text" DEFAULT 'requested'::"text" NOT NULL,
    "note" "text",
    "requested_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."client_payments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."client_photo_shares" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "media_id" "uuid" NOT NULL,
    "client_ref" "text" NOT NULL,
    "job_ref" "text" NOT NULL,
    "shared_by" "uuid",
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "revoked_at" timestamp with time zone
);


ALTER TABLE "public"."client_photo_shares" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."client_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_ref" "text" NOT NULL,
    "token" "text" NOT NULL,
    "user_agent" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_seen_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "revoked_at" timestamp with time zone
);


ALTER TABLE "public"."client_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."co_counters" (
    "company_id" "text" NOT NULL,
    "job_id" "text" NOT NULL,
    "next_sequence" integer DEFAULT 1 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "job_uuid" "uuid"
);


ALTER TABLE "public"."co_counters" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."companies" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "plan" "text" DEFAULT 'internal'::"text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "dba" "text"
);


ALTER TABLE "public"."companies" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contracts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "vendor_id" "uuid",
    "counterparty" "text" NOT NULL,
    "description" "text",
    "start_date" "date",
    "end_date" "date",
    "renewal_date" "date",
    "auto_renews" boolean,
    "termination_cost" "text",
    "doc_link" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "contracts_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'expired'::"text", 'terminated'::"text", 'pending'::"text"])))
);


ALTER TABLE "public"."contracts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "filename" "text" NOT NULL,
    "storage_path" "text" NOT NULL,
    "mime_type" "text",
    "size_bytes" bigint,
    "client_id" "text",
    "client_name" "text",
    "job_id" "text",
    "job_title" "text",
    "folder_id" "uuid",
    "doc_type" "text" DEFAULT 'other'::"text" NOT NULL,
    "sensitive" boolean DEFAULT false NOT NULL,
    "ai_confidence" real,
    "ai_suggested" "jsonb",
    "uploaded_by" "uuid",
    "uploaded_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "client_uuid" "uuid",
    "job_uuid" "uuid",
    CONSTRAINT "documents_doc_type_check" CHECK (("doc_type" = ANY (ARRAY['contract'::"text", 'permit'::"text", 'invoice'::"text", 'estimate'::"text", 'photo'::"text", 'payroll'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."employee_roles" (
    "jobber_id" "text" NOT NULL,
    "lens" "text" DEFAULT 'unassigned'::"text" NOT NULL,
    "division" "text",
    "crew_label" "text",
    "color" "text",
    "sort_order" integer,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_by" "text",
    "permission_role" "text",
    "permission_roles" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    CONSTRAINT "employee_roles_lens_check" CHECK (("lens" = ANY (ARRAY['crew'::"text", 'office'::"text", 'sub'::"text", 'hidden'::"text", 'unassigned'::"text"]))),
    CONSTRAINT "employee_roles_permission_role_check" CHECK (("permission_role" = ANY (ARRAY['owner'::"text", 'partner'::"text", 'office_manager'::"text", 'project_manager'::"text", 'dispatch'::"text", 'accounting'::"text", 'design_sales'::"text", 'marketing'::"text", 'systems_pm'::"text", 'field_crew'::"text", 'subcontractor'::"text"]))),
    CONSTRAINT "employee_roles_permission_roles_check" CHECK (("permission_roles" <@ ARRAY['owner'::"text", 'partner'::"text", 'office_manager'::"text", 'project_manager'::"text", 'dispatch'::"text", 'accounting'::"text", 'design_sales'::"text", 'marketing'::"text", 'systems_pm'::"text", 'field_crew'::"text", 'subcontractor'::"text"]))
);


ALTER TABLE "public"."employee_roles" OWNER TO "postgres";


COMMENT ON TABLE "public"."employee_roles" IS 'Admin-assigned schedule routing (crew/office/sub/hidden) per real Jobber employee. Set via Team > Crew Roster in the app.';



COMMENT ON COLUMN "public"."employee_roles"."permission_role" IS 'Job-function role (2026-07-24, Chris) -- distinct from lens (which schedule board they hit). Drives app permissions and default Command Center landing page. NULL = not yet classified.';



CREATE TABLE IF NOT EXISTS "public"."est_counters" (
    "company_id" "text" NOT NULL,
    "next_sequence" integer DEFAULT 1 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."est_counters" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."estimates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "estimate_number" "text" NOT NULL,
    "client_id" "text" NOT NULL,
    "lifecycle_status" "text" NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "data" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "client_uuid" "uuid"
);


ALTER TABLE "public"."estimates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."expenses" (
    "jobber_id" "text" NOT NULL,
    "title" "text",
    "total" numeric,
    "expense_date" "date",
    "reimbursable_to_user" boolean,
    "job_id" "text",
    "jobber_created_at" timestamp with time zone,
    "jobber_updated_at" timestamp with time zone,
    "synced_at" timestamp with time zone,
    "job_uuid" "uuid"
);


ALTER TABLE "public"."expenses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."external_refs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "entity_type" "text" NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "system" "text" DEFAULT 'jobber'::"text" NOT NULL,
    "external_id" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."external_refs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."field_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tech_id" "uuid" NOT NULL,
    "tech_name" "text",
    "job_ref" "text",
    "visit_ref" "text",
    "client_ref" "text",
    "kind" "text" NOT NULL,
    "payload" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."field_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."folder_access" (
    "folder_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "granted_by" "uuid",
    "granted_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."folder_access" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."folders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "parent_id" "uuid",
    "job_id" "text",
    "job_title" "text",
    "client_id" "text",
    "client_name" "text",
    "is_public" boolean DEFAULT false NOT NULL,
    "is_template" boolean DEFAULT false NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "client_uuid" "uuid",
    "job_uuid" "uuid"
);


ALTER TABLE "public"."folders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."function_assignments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "function_id" "uuid" NOT NULL,
    "assignee_type" "text" NOT NULL,
    "assignee_name" "text" NOT NULL,
    "vendor_id" "uuid",
    "subscription_id" "uuid",
    "role_in_function" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "function_assignments_assignee_type_check" CHECK (("assignee_type" = ANY (ARRAY['employee'::"text", 'vendor'::"text", 'subscription'::"text", 'automation'::"text", 'reina'::"text"])))
);


ALTER TABLE "public"."function_assignments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."hc_mailbox_links" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "ms_home_account_id" "text" NOT NULL,
    "ms_username" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."hc_mailbox_links" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."hc_ms_tokens" (
    "owner_id" "uuid" NOT NULL,
    "home_account_id" "text" NOT NULL,
    "username" "text",
    "name" "text",
    "refresh_token" "text" NOT NULL,
    "access_token" "text",
    "expires_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."hc_ms_tokens" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."hiveconnect_account_map" (
    "hivelogic_user_id" "uuid" NOT NULL,
    "hiveconnect_user_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "hiveconnect_account_map_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'disabled'::"text"])))
);


ALTER TABLE "public"."hiveconnect_account_map" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."integrations" (
    "key" "text" NOT NULL,
    "access_token" "text" NOT NULL,
    "refresh_token" "text",
    "expires_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "realm_id" "text",
    "environment" "text"
);


ALTER TABLE "public"."integrations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."job_signatures" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "text" NOT NULL,
    "visit_id" "text",
    "signed_name" "text" NOT NULL,
    "storage_path" "text" NOT NULL,
    "signed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "captured_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "job_uuid" "uuid"
);


ALTER TABLE "public"."job_signatures" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."job_time_entries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tech_id" "uuid" NOT NULL,
    "tech_name" "text",
    "job_ref" "text",
    "visit_ref" "text",
    "client_ref" "text",
    "kind" "text" NOT NULL,
    "whole_team" boolean DEFAULT false NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ended_at" timestamp with time zone,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."job_time_entries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."job_workflow" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_ref" "text" NOT NULL,
    "deposit_required" numeric,
    "deposit_paid_at" timestamp with time zone,
    "deposit_amount" numeric,
    "setup_complete_at" timestamp with time zone,
    "materials_status" "text" DEFAULT 'not_ordered'::"text" NOT NULL,
    "materials_eta" "date",
    "on_hold_at" timestamp with time zone,
    "on_hold_reason" "text",
    "notes" "text",
    "updated_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "readiness_items" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "readiness_override_at" timestamp with time zone,
    "readiness_override_by" "text",
    "readiness_override_reason" "text",
    "is_tm" boolean DEFAULT false NOT NULL,
    "tm_service_type" "text",
    "tm_rate_hourly" numeric
);


ALTER TABLE "public"."job_workflow" OWNER TO "postgres";


COMMENT ON COLUMN "public"."job_workflow"."readiness_items" IS 'Per-item checklist state for the Job Setup & Readiness gate. Shape: {"gateKey.itemKey": {"done": bool, "at": iso timestamp, "by": text}}. Item keys match GATES in the jsx page script.';



COMMENT ON COLUMN "public"."job_workflow"."readiness_override_at" IS 'When set, a failing gate was manually overridden to unlock scheduling. Always paired with readiness_override_by and readiness_override_reason.';



COMMENT ON COLUMN "public"."job_workflow"."is_tm" IS 'True if this job was created/flagged as Time & Materials (vs fixed-bid). Set at intake via the New Job form checkbox.';



COMMENT ON COLUMN "public"."job_workflow"."tm_service_type" IS 'Key into tm_rate_types.key -- which predetermined rate this T&M job uses.';



COMMENT ON COLUMN "public"."job_workflow"."tm_rate_hourly" IS 'Snapshot of tm_rate_types.rate_hourly at the time this job was created, so later rate-table edits do not silently change already-booked jobs.';



CREATE TABLE IF NOT EXISTS "public"."jobs" (
    "jobber_id" "text" NOT NULL,
    "client_id" "text",
    "job_number" integer,
    "title" "text",
    "job_status" "text",
    "job_type" "text",
    "total" numeric,
    "start_at" timestamp with time zone,
    "end_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "jobber_web_uri" "text",
    "jobber_created_at" timestamp with time zone,
    "jobber_updated_at" timestamp with time zone,
    "synced_at" timestamp with time zone DEFAULT "now"(),
    "uuid_id" "uuid" DEFAULT "gen_random_uuid"(),
    "client_uuid" "uuid",
    "company_id" "uuid" DEFAULT '82cf7354-e460-4863-9f01-d67b3ad05d4a'::"uuid"
);


ALTER TABLE "public"."jobs" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."jobs_enriched" WITH ("security_invoker"='true') AS
 SELECT "j"."jobber_id",
    "j"."client_id",
    "j"."job_number",
    "j"."title",
    "j"."job_status",
    "j"."job_type",
    "j"."total",
    "j"."start_at",
    "j"."end_at",
    "j"."completed_at",
    "j"."jobber_web_uri",
    "j"."jobber_created_at",
    "j"."jobber_updated_at",
    "j"."synced_at",
    COALESCE(NULLIF("c"."name", ''::"text"), NULLIF(TRIM(BOTH FROM "concat_ws"(' '::"text", "c"."first_name", "c"."last_name")), ''::"text"), NULLIF("c"."company_name", ''::"text")) AS "client_name",
    "cl"."lat" AS "gps_lat",
    "cl"."lng" AS "gps_lng",
    "cl"."city" AS "loc_city",
    "cl"."province" AS "loc_province"
   FROM (("public"."jobs" "j"
     LEFT JOIN "public"."clients" "c" ON (("c"."jobber_id" = "j"."client_id")))
     LEFT JOIN "public"."client_locations" "cl" ON ((("cl"."jobber_id" = "j"."client_id") AND ("cl"."lat" IS NOT NULL))));


ALTER VIEW "public"."jobs_enriched" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lead_alerts_sent" (
    "id" bigint NOT NULL,
    "source" "text" NOT NULL,
    "lead_id" "text" NOT NULL,
    "alerted_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lead_alerts_sent" OWNER TO "postgres";


ALTER TABLE "public"."lead_alerts_sent" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."lead_alerts_sent_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."lead_pipeline" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "text" NOT NULL,
    "stage" "text" DEFAULT 'new'::"text" NOT NULL,
    "estimated_value" numeric,
    "lead_source" "text",
    "division" "text",
    "need" "text",
    "phone" "text",
    "service_address" "text",
    "urgency" "text",
    "lost_reason" "text",
    "notes" "text",
    "first_contacted_at" timestamp with time zone,
    "last_contacted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "referred_by_client_id" "text",
    "client_uuid" "uuid",
    CONSTRAINT "lead_pipeline_stage_check" CHECK (("stage" = ANY (ARRAY['new'::"text", 'contacted'::"text", 'estimate_booked'::"text", 'estimate_sent'::"text", 'won'::"text", 'lost'::"text"])))
);


ALTER TABLE "public"."lead_pipeline" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ledger_systems" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "data" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ledger_systems" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."marketing_annotations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "text" DEFAULT 'ghgrp'::"text" NOT NULL,
    "generated_asset_id" "uuid" NOT NULL,
    "annotation_type" "text" NOT NULL,
    "data" "jsonb" NOT NULL,
    "frame_time_ms" integer,
    "correction_text" "text",
    "regenerated_asset_id" "uuid",
    "created_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "superseded_by" "uuid",
    CONSTRAINT "marketing_annotations_annotation_type_check" CHECK (("annotation_type" = ANY (ARRAY['VIDEO_MARK'::"text", 'REGION_CLICK'::"text", 'TEXT_HIGHLIGHT'::"text", 'CORRECTION'::"text"])))
);


ALTER TABLE "public"."marketing_annotations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."marketing_approvals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "text" DEFAULT 'ghgrp'::"text" NOT NULL,
    "approvable_type" "text" NOT NULL,
    "approvable_id" "text",
    "generated_asset_id" "uuid",
    "title" "text" NOT NULL,
    "rationale" "text",
    "preview_text" "text",
    "preview_media_id" "uuid",
    "amount_cents" integer,
    "max_amount_cents" integer,
    "target_description" "text",
    "estimate" "jsonb",
    "confidence" numeric,
    "risks" "jsonb",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "requested_by" "text" DEFAULT 'system'::"text" NOT NULL,
    "decided_by" "text",
    "decided_at" timestamp with time zone,
    "decision_reason" "text",
    "expires_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "marketing_approvals_amount_cents_check" CHECK ((("amount_cents" IS NULL) OR ("amount_cents" >= 0))),
    CONSTRAINT "marketing_approvals_approvable_type_check" CHECK (("approvable_type" = ANY (ARRAY['CAMPAIGN_SPEND'::"text", 'GENERATED_VIDEO'::"text", 'WEBSITE_PROMOTION'::"text", 'REVIEW_REPLY'::"text", 'CLAIM_CORRECTION'::"text", 'ACCOUNT_REPAIR'::"text", 'BUDGET_ADJUSTMENT'::"text", 'reina_change_request'::"text"]))),
    CONSTRAINT "marketing_approvals_max_amount_cents_check" CHECK ((("max_amount_cents" IS NULL) OR ("max_amount_cents" >= 0))),
    CONSTRAINT "marketing_approvals_requested_by_check" CHECK (("requested_by" = ANY (ARRAY['system'::"text", 'owner'::"text", 'reina'::"text"]))),
    CONSTRAINT "marketing_approvals_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text", 'edited'::"text", 'regenerating'::"text", 'needs_input'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."marketing_approvals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."marketing_budget_settings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "text" DEFAULT 'ghgrp'::"text" NOT NULL,
    "monthly_budget_cents" integer DEFAULT 250000 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_by" "text",
    CONSTRAINT "marketing_budget_settings_monthly_budget_cents_check" CHECK ((("monthly_budget_cents" >= 250000) AND ("monthly_budget_cents" <= 1500000)))
);


ALTER TABLE "public"."marketing_budget_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."marketing_channel_budgets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "text" DEFAULT 'ghgrp'::"text" NOT NULL,
    "channel" "text" NOT NULL,
    "monthly_budget_cents" integer DEFAULT 0 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_by" "text",
    "min_viable_spend_cents" integer,
    "daily_max_cents" integer,
    "testing_allowance_cents" integer DEFAULT 0 NOT NULL,
    "paused" boolean DEFAULT false NOT NULL,
    "approval_threshold_cents" integer,
    CONSTRAINT "marketing_channel_budgets_approval_threshold_nonneg" CHECK ((("approval_threshold_cents" IS NULL) OR ("approval_threshold_cents" >= 0))),
    CONSTRAINT "marketing_channel_budgets_channel_check" CHECK (("channel" = ANY (ARRAY['email'::"text", 'sms'::"text", 'google_ads'::"text", 'meta_ads'::"text", 'google_business_profile'::"text", 'website_cms'::"text", 'direct_mail'::"text", 'other'::"text"]))),
    CONSTRAINT "marketing_channel_budgets_daily_max_nonneg" CHECK ((("daily_max_cents" IS NULL) OR ("daily_max_cents" >= 0))),
    CONSTRAINT "marketing_channel_budgets_min_viable_spend_nonneg" CHECK ((("min_viable_spend_cents" IS NULL) OR ("min_viable_spend_cents" >= 0))),
    CONSTRAINT "marketing_channel_budgets_monthly_budget_cents_check" CHECK (("monthly_budget_cents" >= 0)),
    CONSTRAINT "marketing_channel_budgets_testing_allowance_nonneg" CHECK (("testing_allowance_cents" >= 0))
);


ALTER TABLE "public"."marketing_channel_budgets" OWNER TO "postgres";


COMMENT ON COLUMN "public"."marketing_channel_budgets"."min_viable_spend_cents" IS 'Owner-set floor below which this channel is not considered worth running. NULL = not set yet.';



COMMENT ON COLUMN "public"."marketing_channel_budgets"."daily_max_cents" IS 'Owner-set per-day spend cap for this channel. NULL = no daily cap set.';



COMMENT ON COLUMN "public"."marketing_channel_budgets"."testing_allowance_cents" IS 'Protected experiment budget automatic reallocation should not sweep. Defaults to 0.';



COMMENT ON COLUMN "public"."marketing_channel_budgets"."paused" IS 'Owner emergency-pause flag. When true, exclude from automatic allocation. Defaults to false.';



COMMENT ON COLUMN "public"."marketing_channel_budgets"."approval_threshold_cents" IS 'Spend level above which changes require explicit owner approval. NULL = no threshold.';



CREATE TABLE IF NOT EXISTS "public"."marketing_consent_ledger" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "text" NOT NULL,
    "channel" "text" NOT NULL,
    "status" "text" NOT NULL,
    "source" "text" NOT NULL,
    "granted_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "client_uuid" "uuid",
    CONSTRAINT "marketing_consent_ledger_channel_check" CHECK (("channel" = ANY (ARRAY['email'::"text", 'sms'::"text", 'review_request'::"text", 'media_marketing_use'::"text"]))),
    CONSTRAINT "marketing_consent_ledger_source_check" CHECK (("source" = ANY (ARRAY['implicit_customer_relationship'::"text", 'explicit_opt_in'::"text", 'explicit_opt_out'::"text", 'owner_override'::"text"]))),
    CONSTRAINT "marketing_consent_ledger_status_check" CHECK (("status" = ANY (ARRAY['granted'::"text", 'revoked'::"text", 'unknown'::"text"])))
);


ALTER TABLE "public"."marketing_consent_ledger" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."marketing_generated_assets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "text" DEFAULT 'ghgrp'::"text" NOT NULL,
    "media_asset_id" "uuid",
    "campaign_variant_id" "uuid",
    "asset_type" "text" NOT NULL,
    "generation_method" "text" NOT NULL,
    "prompt" "text",
    "provider" "text",
    "provider_model" "text",
    "output_storage_path" "text",
    "output_text" "text",
    "claims_used" "jsonb",
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "approved_by" "text",
    "approved_at" timestamp with time zone,
    "publish_destinations" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "marketing_generated_assets_asset_type_check" CHECK (("asset_type" = ANY (ARRAY['image'::"text", 'video'::"text", 'caption'::"text", 'social_post'::"text", 'ad_copy'::"text", 'landing_page_copy'::"text"]))),
    CONSTRAINT "marketing_generated_assets_generation_method_check" CHECK (("generation_method" = ANY (ARRAY['ai_text'::"text", 'ai_image'::"text", 'ai_video'::"text", 'ai_enhanced'::"text", 'manual'::"text"]))),
    CONSTRAINT "marketing_generated_assets_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'pending_approval'::"text", 'approved'::"text", 'rejected'::"text", 'published'::"text"])))
);


ALTER TABLE "public"."marketing_generated_assets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."marketing_media_assets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "text" DEFAULT 'ghgrp'::"text" NOT NULL,
    "media_id" "uuid" NOT NULL,
    "job_id" "text",
    "client_id" "text",
    "selected_for" "text" DEFAULT 'review'::"text" NOT NULL,
    "permission_status" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "permission_checked_at" timestamp with time zone,
    "selected_by" "text" DEFAULT 'system'::"text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "client_uuid" "uuid",
    "job_uuid" "uuid",
    CONSTRAINT "marketing_media_assets_permission_status_check" CHECK (("permission_status" = ANY (ARRAY['unknown'::"text", 'granted'::"text", 'revoked'::"text", 'owner_override'::"text"]))),
    CONSTRAINT "marketing_media_assets_selected_by_check" CHECK (("selected_by" = ANY (ARRAY['system'::"text", 'owner'::"text"]))),
    CONSTRAINT "marketing_media_assets_selected_for_check" CHECK (("selected_for" = ANY (ARRAY['review'::"text", 'content_studio'::"text", 'ready_for_you'::"text"])))
);


ALTER TABLE "public"."marketing_media_assets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."marketing_opportunities" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "text" DEFAULT 'ghgrp'::"text" NOT NULL,
    "plan_id" "uuid",
    "opportunity_key" "text" NOT NULL,
    "title" "text",
    "signal" "jsonb",
    "actionable" boolean DEFAULT false NOT NULL,
    "actionable_reason" "text",
    "required_integration" "text",
    "status" "text" DEFAULT 'surfaced'::"text" NOT NULL,
    "campaign_id" "uuid",
    "surfaced_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "acted_at" timestamp with time zone,
    "dismissed_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "marketing_opportunities_opportunity_key_check" CHECK (("opportunity_key" = ANY (ARRAY['unsold_estimates'::"text", 'review_requests'::"text", 'reactivate_customers'::"text", 'seasonal_promotion'::"text", 'neighborhood_expansion'::"text", 'referral_opportunities'::"text"]))),
    CONSTRAINT "marketing_opportunities_status_check" CHECK (("status" = ANY (ARRAY['surfaced'::"text", 'acted_on'::"text", 'dismissed'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."marketing_opportunities" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."marketing_plan_assumptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "text" DEFAULT 'ghgrp'::"text" NOT NULL,
    "gross_margin_pct" numeric(5,2),
    "qualified_lead_rate_per_100" numeric(8,2),
    "close_rate_pct" numeric(5,2),
    "max_new_jobs_per_month" integer,
    "avg_job_value_cents" integer,
    "risk_posture" "text" DEFAULT 'balanced'::"text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_by" "text",
    CONSTRAINT "marketing_plan_assumptions_avg_job_value_cents_check" CHECK ((("avg_job_value_cents" IS NULL) OR ("avg_job_value_cents" >= 0))),
    CONSTRAINT "marketing_plan_assumptions_close_rate_pct_check" CHECK ((("close_rate_pct" IS NULL) OR (("close_rate_pct" >= (0)::numeric) AND ("close_rate_pct" <= (100)::numeric)))),
    CONSTRAINT "marketing_plan_assumptions_gross_margin_pct_check" CHECK ((("gross_margin_pct" IS NULL) OR (("gross_margin_pct" >= (0)::numeric) AND ("gross_margin_pct" <= (100)::numeric)))),
    CONSTRAINT "marketing_plan_assumptions_max_new_jobs_per_month_check" CHECK ((("max_new_jobs_per_month" IS NULL) OR ("max_new_jobs_per_month" >= 0))),
    CONSTRAINT "marketing_plan_assumptions_qualified_lead_rate_per_100_check" CHECK ((("qualified_lead_rate_per_100" IS NULL) OR ("qualified_lead_rate_per_100" >= (0)::numeric))),
    CONSTRAINT "marketing_plan_assumptions_risk_posture_check" CHECK (("risk_posture" = ANY (ARRAY['conservative'::"text", 'balanced'::"text", 'aggressive'::"text"])))
);


ALTER TABLE "public"."marketing_plan_assumptions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."marketing_plans" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "text" DEFAULT 'ghgrp'::"text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "period_start" "date" NOT NULL,
    "period_end" "date" NOT NULL,
    "objective" "text",
    "budget_cents" integer,
    "assumptions_snapshot" "jsonb",
    "forecast" "jsonb",
    "forecast_state" "text",
    "blocked_reasons" "jsonb",
    "rationale" "text",
    "generated_by" "text" DEFAULT 'system'::"text" NOT NULL,
    "superseded_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "marketing_plans_budget_cents_check" CHECK ((("budget_cents" IS NULL) OR ("budget_cents" >= 0))),
    CONSTRAINT "marketing_plans_check" CHECK (("period_end" >= "period_start")),
    CONSTRAINT "marketing_plans_forecast_state_check" CHECK ((("forecast_state" IS NULL) OR ("forecast_state" = ANY (ARRAY['blocked_no_channel'::"text", 'blocked_assumptions'::"text", 'ready'::"text"])))),
    CONSTRAINT "marketing_plans_generated_by_check" CHECK (("generated_by" = ANY (ARRAY['system'::"text", 'owner'::"text"]))),
    CONSTRAINT "marketing_plans_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'active'::"text", 'superseded'::"text", 'archived'::"text"])))
);


ALTER TABLE "public"."marketing_plans" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."marketing_platform_connections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "text" DEFAULT 'ghgrp'::"text" NOT NULL,
    "platform" "text" NOT NULL,
    "state" "text" DEFAULT 'not_connected'::"text" NOT NULL,
    "account_name" "text",
    "account_id" "text",
    "login_account_id" "text",
    "credential_ref" "text",
    "note" "text",
    "last_verified_at" timestamp with time zone,
    "last_error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "marketing_platform_connections_platform_check" CHECK (("platform" = ANY (ARRAY['email'::"text", 'sms'::"text", 'google_ads'::"text", 'meta_ads'::"text", 'google_business_profile'::"text", 'website_cms'::"text", 'ga4'::"text", 'gtm'::"text", 'search_console'::"text", 'youtube'::"text", 'facebook_instagram'::"text", 'microsoft_ads'::"text", 'linkedin'::"text", 'tiktok'::"text", 'direct_mail'::"text"]))),
    CONSTRAINT "marketing_platform_connections_state_check" CHECK (("state" = ANY (ARRAY['not_connected'::"text", 'setup_incomplete'::"text", 'reporting_verified'::"text", 'draft_validated'::"text", 'launch_enabled'::"text", 'needs_attention'::"text"])))
);


ALTER TABLE "public"."marketing_platform_connections" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."marketing_publications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "text" DEFAULT 'ghgrp'::"text" NOT NULL,
    "generated_asset_id" "uuid",
    "approval_id" "uuid",
    "destination_type" "text" NOT NULL,
    "destination_ref" "text",
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "published_at" timestamp with time zone,
    "expires_at" timestamp with time zone,
    "rolled_back_at" timestamp with time zone,
    "rollback_reason" "text",
    "published_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "marketing_publications_destination_type_check" CHECK (("destination_type" = ANY (ARRAY['website_cms'::"text", 'google_business_profile'::"text", 'facebook_instagram'::"text", 'youtube'::"text", 'email'::"text", 'sms'::"text", 'direct_mail'::"text", 'other'::"text"]))),
    CONSTRAINT "marketing_publications_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'scheduled'::"text", 'published'::"text", 'rollback_requested'::"text", 'rolled_back'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."marketing_publications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."marketing_source_evidence" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "text" DEFAULT 'ghgrp'::"text" NOT NULL,
    "generated_asset_id" "uuid" NOT NULL,
    "evidence_type" "text" NOT NULL,
    "job_id" "text",
    "media_id" "uuid",
    "media_analysis_snapshot" "jsonb",
    "claim_text" "text" NOT NULL,
    "verified" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "job_uuid" "uuid",
    CONSTRAINT "marketing_source_evidence_evidence_type_check" CHECK (("evidence_type" = ANY (ARRAY['job_record'::"text", 'media_analysis'::"text", 'review'::"text", 'job_total'::"text", 'client_history'::"text", 'manual_note'::"text"])))
);


ALTER TABLE "public"."marketing_source_evidence" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."marketing_suppressions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "text" NOT NULL,
    "channel" "text" NOT NULL,
    "reason" "text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "client_uuid" "uuid",
    CONSTRAINT "marketing_suppressions_channel_check" CHECK (("channel" = ANY (ARRAY['email'::"text", 'sms'::"text", 'review_request'::"text"]))),
    CONSTRAINT "marketing_suppressions_reason_check" CHECK (("reason" = ANY (ARRAY['bounced'::"text", 'complained'::"text", 'unsubscribed'::"text", 'owner_override'::"text", 'legal_hold'::"text"])))
);


ALTER TABLE "public"."marketing_suppressions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."media" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "text" NOT NULL,
    "media_type" "text" NOT NULL,
    "storage_path" "text" NOT NULL,
    "mime_type" "text",
    "size_bytes" bigint,
    "thumbnail_path" "text",
    "captured_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "gps_lat" numeric,
    "gps_lng" numeric,
    "rotation" smallint DEFAULT 0 NOT NULL,
    "offline_client_id" "text",
    "uploaded_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "job_uuid" "uuid",
    CONSTRAINT "media_media_type_check" CHECK (("media_type" = ANY (ARRAY['PHOTO'::"text", 'VIDEO'::"text"]))),
    CONSTRAINT "media_rotation_check" CHECK (("rotation" = ANY (ARRAY[0, 90, 180, 270])))
);


ALTER TABLE "public"."media" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."media_analysis" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "media_id" "uuid" NOT NULL,
    "description" "text",
    "room" "text",
    "trade" "text",
    "materials" "text"[],
    "damage" "text",
    "safety_issue" "text",
    "confidence" numeric,
    "model" "text",
    "analyzed_at" timestamp with time zone
);


ALTER TABLE "public"."media_analysis" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."media_comments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "media_id" "uuid" NOT NULL,
    "body" "text" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."media_comments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."media_entity_links" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "media_id" "uuid" NOT NULL,
    "entity_type" "text" NOT NULL,
    "entity_id" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "media_entity_links_entity_type_check" CHECK (("entity_type" = ANY (ARRAY['JOB'::"text", 'ESTIMATE'::"text", 'ESTIMATE_LINE_ITEM'::"text", 'TASK'::"text", 'ACTIVITY'::"text", 'SCHEDULE_ITEM'::"text", 'CREW'::"text", 'EMPLOYEE'::"text", 'VENDOR'::"text", 'SUBCONTRACTOR'::"text", 'EQUIPMENT'::"text", 'TRUCK'::"text", 'MATERIAL'::"text", 'PURCHASE_ORDER'::"text", 'INVOICE'::"text", 'CHANGE_ORDER'::"text", 'ISSUE'::"text", 'WARRANTY'::"text", 'INSPECTION'::"text", 'PERMIT'::"text", 'CLIENT'::"text", 'PROPERTY'::"text", 'ASSET'::"text", 'COMMUNICATION'::"text", 'EXPENSE'::"text", 'FINANCIAL_TRANSACTION'::"text", 'QUOTE'::"text", 'REQUEST'::"text", 'VISIT'::"text", 'TIMESHEET'::"text"])))
);


ALTER TABLE "public"."media_entity_links" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."media_tags" (
    "media_id" "uuid" NOT NULL,
    "tag_id" "uuid" NOT NULL
);


ALTER TABLE "public"."media_tags" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."monitor_activity_samples" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "monitor_session_id" "uuid" NOT NULL,
    "sampled_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "activity_level" integer DEFAULT 0 NOT NULL,
    "idle_seconds" integer DEFAULT 0 NOT NULL,
    "active_app" "text",
    "display_count" integer
);


ALTER TABLE "public"."monitor_activity_samples" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."monitor_agents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "employee_id" "uuid" NOT NULL,
    "device_name" "text",
    "platform" "text",
    "agent_version" "text",
    "pairing_code" "text",
    "pairing_code_expires_at" timestamp with time zone,
    "paired_at" timestamp with time zone,
    "last_seen_at" timestamp with time zone,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "agent_token" "text",
    "pair_attempts" integer DEFAULT 0 NOT NULL,
    "agent_token_hash" "text",
    CONSTRAINT "monitor_agents_platform_check" CHECK (("platform" = ANY (ARRAY['windows'::"text", 'mac'::"text"]))),
    CONSTRAINT "monitor_agents_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'active'::"text", 'revoked'::"text"])))
);


ALTER TABLE "public"."monitor_agents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."monitor_pair_attempts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "ip" "text" NOT NULL,
    "attempted_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."monitor_pair_attempts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."monitor_screenshots" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "monitor_session_id" "uuid" NOT NULL,
    "captured_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "display_index" integer DEFAULT 0 NOT NULL,
    "storage_path" "text" NOT NULL,
    "width" integer,
    "height" integer
);


ALTER TABLE "public"."monitor_screenshots" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."monitor_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "employee_id" "uuid" NOT NULL,
    "agent_id" "uuid" NOT NULL,
    "workforce_session_id" "uuid",
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ended_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "consent" "text" DEFAULT 'pending'::"text" NOT NULL,
    CONSTRAINT "monitor_sessions_consent_check" CHECK (("consent" = ANY (ARRAY['pending'::"text", 'allowed'::"text", 'denied'::"text"])))
);


ALTER TABLE "public"."monitor_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."oauth_states" (
    "id" bigint NOT NULL,
    "provider" "text" NOT NULL,
    "state_hash" "text" NOT NULL,
    "user_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "used_at" timestamp with time zone
);


ALTER TABLE "public"."oauth_states" OWNER TO "postgres";


ALTER TABLE "public"."oauth_states" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."oauth_states_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."office_location" (
    "id" "text" NOT NULL,
    "address" "text",
    "lat" numeric,
    "lng" numeric,
    "geocoded_at" timestamp with time zone
);


ALTER TABLE "public"."office_location" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."org_units" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "uuid" NOT NULL,
    "parent_id" "uuid",
    "unit_type" "text" DEFAULT 'division'::"text" NOT NULL,
    "name" "text" NOT NULL,
    "is_primary" boolean DEFAULT false NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "status" "text" DEFAULT 'planned'::"text" NOT NULL,
    CONSTRAINT "org_units_status_check" CHECK (("status" = ANY (ARRAY['operational'::"text", 'planned'::"text"]))),
    CONSTRAINT "org_units_unit_type_check" CHECK (("unit_type" = ANY (ARRAY['division'::"text", 'location'::"text", 'crew'::"text"])))
);


ALTER TABLE "public"."org_units" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payroll_period_costs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "period_start" "date" NOT NULL,
    "period_end" "date" NOT NULL,
    "gross_wages" numeric,
    "employer_taxes" numeric,
    "benefits" numeric,
    "total_cost" numeric,
    "source" "text" DEFAULT 'manual'::"text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "payroll_period_costs_source_check" CHECK (("source" = ANY (ARRAY['manual'::"text", 'gusto'::"text"])))
);


ALTER TABLE "public"."payroll_period_costs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."po_counters" (
    "company_id" "text" NOT NULL,
    "scope_key" "text" NOT NULL,
    "next_sequence" integer DEFAULT 1 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."po_counters" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."po_seen_bills" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_id" "text" NOT NULL,
    "qbo_vendor_id" "text",
    "invoice_number" "text",
    "currency" "text",
    "amount" numeric,
    "evidence_hash" "text",
    "source_transaction_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "vendor_name" "text"
);


ALTER TABLE "public"."po_seen_bills" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."portal_rate_limits" (
    "id" bigint NOT NULL,
    "bucket" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."portal_rate_limits" OWNER TO "postgres";


ALTER TABLE "public"."portal_rate_limits" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."portal_rate_limits_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."product_nicknames" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "vendor_key" "text" NOT NULL,
    "vendor_sku" "text" NOT NULL,
    "nickname" "text" NOT NULL,
    "vendor_title" "text" NOT NULL,
    "brand" "text",
    "unit_price" numeric,
    "image_url" "text",
    "product_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by_user_id" "uuid"
);


ALTER TABLE "public"."product_nicknames" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."product_snapshots" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "product_id" "uuid" NOT NULL,
    "vendor_offer_id" "uuid" NOT NULL,
    "attached_to_type" "text",
    "attached_to_id" "text",
    "title" "text" NOT NULL,
    "vendor_title" "text" NOT NULL,
    "description" "text",
    "image_url" "text",
    "sku" "text",
    "model_number" "text",
    "spec_attributes" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "package_qty" numeric,
    "quantity" numeric DEFAULT 1 NOT NULL,
    "selected_store" "text",
    "quoted_price" numeric NOT NULL,
    "availability_at_capture" "jsonb",
    "source_url" "text",
    "captured_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "captured_by_user_id" "uuid",
    "draft_cart_id" "uuid",
    CONSTRAINT "product_snapshots_attach_xor_draft" CHECK (((("attached_to_type" IS NOT NULL) AND ("attached_to_id" IS NOT NULL) AND ("draft_cart_id" IS NULL)) OR (("attached_to_type" IS NULL) AND ("attached_to_id" IS NULL) AND ("draft_cart_id" IS NOT NULL)))),
    CONSTRAINT "product_snapshots_attached_to_type_check" CHECK (("attached_to_type" = ANY (ARRAY['ESTIMATE_LINE_ITEM'::"text", 'JOB_MATERIAL_LIST'::"text", 'TASK'::"text", 'ACTIVITY'::"text", 'PURCHASE_REQUEST'::"text", 'PURCHASE_ORDER'::"text"])))
);


ALTER TABLE "public"."product_snapshots" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."products" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "standard_name" "text" NOT NULL,
    "name_confidence" numeric,
    "name_reviewed" boolean DEFAULT false NOT NULL,
    "manufacturer" "text",
    "category" "text",
    "description" "text",
    "unit_of_measure" "text",
    "spec_attributes" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "image_primary" "text",
    "created_from" "text" DEFAULT 'vendor-import'::"text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "merged_into_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "products_created_from_check" CHECK (("created_from" = ANY (ARRAY['manual'::"text", 'vendor-import'::"text", 'catalog-feed'::"text"]))),
    CONSTRAINT "products_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'deprecated'::"text", 'merged-into'::"text"])))
);


ALTER TABLE "public"."products" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "full_name" "text",
    "role" "text" DEFAULT 'crew'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "monitoring_enabled" boolean DEFAULT true NOT NULL,
    CONSTRAINT "profiles_role_check" CHECK (("role" = ANY (ARRAY['admin'::"text", 'crew'::"text"])))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."qbo_report_cache" (
    "cache_key" "text" NOT NULL,
    "payload" "jsonb" NOT NULL,
    "computed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."qbo_report_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."quotes" (
    "jobber_id" "text" NOT NULL,
    "quote_number" "text",
    "title" "text",
    "quote_status" "text",
    "total" numeric,
    "client_id" "text",
    "client_name" "text",
    "jobber_created_at" timestamp with time zone,
    "jobber_updated_at" timestamp with time zone,
    "synced_at" timestamp with time zone,
    "client_uuid" "uuid"
);


ALTER TABLE "public"."quotes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."regulated_category_rules" (
    "category" "text" NOT NULL,
    "requires_licensed_approval" boolean DEFAULT true NOT NULL,
    "required_attributes" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "approver_role" "text" DEFAULT 'licensed_trade_lead'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."regulated_category_rules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reina_todo" (
    "id" "text" DEFAULT 'current'::"text" NOT NULL,
    "sections" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "flags" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "content_md" "text",
    "source" "text",
    "generated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."reina_todo" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."requests" (
    "jobber_id" "text" NOT NULL,
    "title" "text",
    "request_status" "text",
    "client_id" "text",
    "jobber_web_uri" "text",
    "jobber_created_at" timestamp with time zone,
    "jobber_updated_at" timestamp with time zone,
    "synced_at" timestamp with time zone,
    "client_uuid" "uuid"
);


ALTER TABLE "public"."requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."review_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "text" NOT NULL,
    "client_id" "text",
    "channel" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "sent_at" timestamp with time zone,
    "dismissed_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "client_uuid" "uuid",
    "job_uuid" "uuid",
    CONSTRAINT "review_requests_channel_check" CHECK (("channel" = ANY (ARRAY['email'::"text", 'sms'::"text"]))),
    CONSTRAINT "review_requests_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'sent'::"text", 'dismissed'::"text"])))
);


ALTER TABLE "public"."review_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."schedule_writeback_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "visit_id" "text" NOT NULL,
    "action" "text" NOT NULL,
    "before" "jsonb" NOT NULL,
    "after" "jsonb",
    "requested_by_email" "text",
    "requested_by_name" "text",
    "freeze_override" boolean DEFAULT false NOT NULL,
    "freeze_blocked" boolean DEFAULT false NOT NULL,
    "success" boolean NOT NULL,
    "user_errors" "jsonb",
    "notified" "jsonb",
    "reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "schedule_writeback_log_action_check" CHECK (("action" = ANY (ARRAY['reschedule'::"text", 'reassign'::"text", 'both'::"text"])))
);


ALTER TABLE "public"."schedule_writeback_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."selftest_reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "tally" "jsonb",
    "shield" "jsonb",
    "results" "jsonb",
    "meta" "jsonb",
    "run_id" "text"
);


ALTER TABLE "public"."selftest_reports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sub_audit_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sub_id" "uuid",
    "actor" "text" DEFAULT 'sub'::"text" NOT NULL,
    "action" "text" NOT NULL,
    "entity_type" "text",
    "entity_id" "uuid",
    "detail" "jsonb",
    "ip" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."sub_audit_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sub_auth_links" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sub_id" "uuid" NOT NULL,
    "token" "text" NOT NULL,
    "purpose" "text" DEFAULT 'login'::"text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "used_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."sub_auth_links" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sub_banking" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sub_id" "uuid" NOT NULL,
    "provider" "text",
    "provider_ref" "text",
    "masked_account" "text",
    "accepts_ach" boolean DEFAULT false NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."sub_banking" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sub_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sub_id" "uuid" NOT NULL,
    "doc_type" "text" NOT NULL,
    "file_url" "text" NOT NULL,
    "expires_at" "date",
    "status" "text" DEFAULT 'current'::"text" NOT NULL,
    "uploaded_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."sub_documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sub_invoices" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sub_id" "uuid" NOT NULL,
    "job_ref" "text",
    "file_url" "text" NOT NULL,
    "amount" numeric,
    "amount_source" "text" DEFAULT 'manual'::"text",
    "status" "text" DEFAULT 'submitted'::"text" NOT NULL,
    "payment_due" "date",
    "submitted_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "paid_at" timestamp with time zone
);


ALTER TABLE "public"."sub_invoices" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sub_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sub_id" "uuid" NOT NULL,
    "sender" "text" NOT NULL,
    "body" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "read_at" timestamp with time zone
);


ALTER TABLE "public"."sub_messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sub_notifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sub_id" "uuid" NOT NULL,
    "type" "text" NOT NULL,
    "title" "text" NOT NULL,
    "body" "text",
    "action_url" "text",
    "entity_type" "text",
    "entity_id" "uuid",
    "read_at" timestamp with time zone,
    "send_after" timestamp with time zone DEFAULT "now"() NOT NULL,
    "sent_sms_at" timestamp with time zone,
    "sent_email_at" timestamp with time zone,
    "sent_chirp_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."sub_notifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sub_rfis" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sub_id" "uuid" NOT NULL,
    "job_ref" "text",
    "question" "text" NOT NULL,
    "answer" "text",
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "answered_at" timestamp with time zone
);


ALTER TABLE "public"."sub_rfis" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sub_rfqs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sub_id" "uuid" NOT NULL,
    "job_ref" "text",
    "title" "text" NOT NULL,
    "scope" "text",
    "doc_urls" "jsonb",
    "due_date" "date",
    "status" "text" DEFAULT 'sent'::"text" NOT NULL,
    "bid_amount" numeric,
    "bid_notes" "text",
    "bid_submitted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."sub_rfqs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sub_schedule_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sub_id" "uuid" NOT NULL,
    "job_ref" "text",
    "title" "text" NOT NULL,
    "start_at" timestamp with time zone NOT NULL,
    "end_at" timestamp with time zone,
    "status" "text" DEFAULT 'proposed'::"text" NOT NULL,
    "change_note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."sub_schedule_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sub_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sub_id" "uuid" NOT NULL,
    "token" "text" NOT NULL,
    "user_agent" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_seen_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "revoked_at" timestamp with time zone
);


ALTER TABLE "public"."sub_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."subcontractors" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "trade" "text",
    "contact_name" "text",
    "phone" "text",
    "email" "text",
    "notes" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "jobber_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "text",
    "updated_by" "text",
    "track_1099" boolean DEFAULT false NOT NULL,
    "w9_on_file" boolean DEFAULT false NOT NULL,
    "tax_id_last4" "text",
    "tax_notes" "text",
    CONSTRAINT "subcontractors_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'inactive'::"text"])))
);


ALTER TABLE "public"."subcontractors" OWNER TO "postgres";


COMMENT ON TABLE "public"."subcontractors" IS 'Subcontractor company directory for the Vendors & Subs page. Optional jobber_id links to employee_roles/users when a sub is also tracked as a Jobber team member for schedule matching (e.g. Pro Custom Home Builders / Albarn Flood).';



COMMENT ON COLUMN "public"."subcontractors"."track_1099" IS 'Whether this vendor/subcontractor is tracked for 1099 reporting. Feeds contractorTaxReport() via api/bookkeeping/_contractor_store.js.';



COMMENT ON COLUMN "public"."subcontractors"."w9_on_file" IS 'Whether a signed W-9 is on file for this vendor/subcontractor.';



COMMENT ON COLUMN "public"."subcontractors"."tax_id_last4" IS 'Last 4 digits only of the vendor''s tax ID (SSN/EIN) -- never the full number.';



COMMENT ON COLUMN "public"."subcontractors"."tax_notes" IS '1099/W-9 tracking notes, separate from the scheduling-facing notes column.';



CREATE TABLE IF NOT EXISTS "public"."subs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "company_name" "text" NOT NULL,
    "contact_name" "text",
    "phone" "text",
    "email" "text",
    "accepts_cc" boolean,
    "ap_contact_name" "text",
    "ap_email" "text",
    "license_number" "text",
    "license_type" "text",
    "status" "text" DEFAULT 'invited'::"text" NOT NULL,
    "preferred_language" "text" DEFAULT 'en'::"text" NOT NULL,
    "notify_sms" boolean DEFAULT true NOT NULL,
    "notify_email" boolean DEFAULT true NOT NULL,
    "notify_chirp" boolean DEFAULT false NOT NULL,
    "calendar_sync_enabled" boolean DEFAULT false NOT NULL,
    "invited_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "onboarded_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."subs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."subscriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "vendor_id" "uuid",
    "category" "text" DEFAULT 'software_platforms'::"text" NOT NULL,
    "what_it_does" "text",
    "relationship_owner" "text",
    "monthly_cost" numeric,
    "cost_source" "text",
    "billing_cycle" "text",
    "renewal_date" "date",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "subscriptions_billing_cycle_check" CHECK (("billing_cycle" = ANY (ARRAY['monthly'::"text", 'annual'::"text", 'usage'::"text", 'other'::"text"]))),
    CONSTRAINT "subscriptions_cost_source_check" CHECK (("cost_source" = ANY (ARRAY['qbo'::"text", 'manual'::"text", 'bank_feed'::"text"]))),
    CONSTRAINT "subscriptions_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'canceled'::"text", 'trial'::"text", 'under_review'::"text"])))
);


ALTER TABLE "public"."subscriptions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sync_cursors" (
    "resource" "text" NOT NULL,
    "cursor" "text",
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."sync_cursors" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sync_log" (
    "id" bigint NOT NULL,
    "ran_at" timestamp with time zone DEFAULT "now"(),
    "status" "text",
    "clients_synced" integer,
    "jobs_synced" integer,
    "invoices_synced" integer,
    "error" "text"
);


ALTER TABLE "public"."sync_log" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."sync_log_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."sync_log_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."sync_log_id_seq" OWNED BY "public"."sync_log"."id";



CREATE TABLE IF NOT EXISTS "public"."tags" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "source" "text" DEFAULT 'MANUAL'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "job_uuid" "uuid",
    CONSTRAINT "tags_source_check" CHECK (("source" = ANY (ARRAY['MANUAL'::"text", 'AI'::"text"])))
);


ALTER TABLE "public"."tags" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."takeoffs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "quote_id" "text" NOT NULL,
    "job_id" "text",
    "title" "text",
    "conditions" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "marks" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "sheets" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "created_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "job_uuid" "uuid"
);


ALTER TABLE "public"."takeoffs" OWNER TO "postgres";


COMMENT ON TABLE "public"."takeoffs" IS 'HiveGrid Live Workbench takeoff data (Phase 1): measured conditions/quantities and markup annotations tied to a real Jobber quote. Plan image/PDF pixels are NOT stored here -- that is an explicit, later Phase 1.5 (Supabase Storage). A restored takeoff shows sheet names/calibration but the user must re-upload the plan graphic to keep marking it up.';



CREATE TABLE IF NOT EXISTS "public"."time_sheet_entries" (
    "jobber_id" "text" NOT NULL,
    "start_at" timestamp with time zone,
    "end_at" timestamp with time zone,
    "final_duration" numeric,
    "user_id" "text",
    "job_id" "text",
    "jobber_created_at" timestamp with time zone,
    "jobber_updated_at" timestamp with time zone,
    "synced_at" timestamp with time zone,
    "job_uuid" "uuid"
);


ALTER TABLE "public"."time_sheet_entries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."timeline_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "text" NOT NULL,
    "label" "text" NOT NULL,
    "source" "text" DEFAULT 'AUTO'::"text" NOT NULL,
    "media_id" "uuid",
    "occurred_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "job_uuid" "uuid",
    CONSTRAINT "timeline_events_source_check" CHECK (("source" = ANY (ARRAY['AUTO'::"text", 'MANUAL'::"text"])))
);


ALTER TABLE "public"."timeline_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tm_invoices" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "invoice_number" "text" NOT NULL,
    "job_ref" "text" NOT NULL,
    "client_id" "text",
    "client_name" "text",
    "job_title" "text",
    "hours" numeric NOT NULL,
    "rate_hourly" numeric NOT NULL,
    "labor_amount" numeric NOT NULL,
    "materials_amount" numeric DEFAULT 0 NOT NULL,
    "total_amount" numeric NOT NULL,
    "notes" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "pay_token" "text" NOT NULL,
    "created_by" "uuid",
    "created_by_name" "text",
    "authnet_transaction_id" "text",
    "authnet_response" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "paid_at" timestamp with time zone,
    "card_rate_bps" integer,
    "card_fee_amount" numeric,
    "cash_amount" numeric,
    "paid_method" "text",
    "paid_amount" numeric,
    "client_uuid" "uuid"
);


ALTER TABLE "public"."tm_invoices" OWNER TO "postgres";


COMMENT ON TABLE "public"."tm_invoices" IS 'Tech-generated T&M invoices, paid via Authorize.Net Accept Hosted (payment link/QR, no hardware). Status is only ever set to paid by the authnet webhook handler after Authorize.Net confirms the charge -- never by the client-side redirect alone.';



COMMENT ON COLUMN "public"."tm_invoices"."rate_hourly" IS 'Snapshot at invoice-generation time, not a live read of tm_rate_types, so a later rate-table edit never changes an already-generated invoice.';



COMMENT ON COLUMN "public"."tm_invoices"."card_rate_bps" IS 'Cash-discount program rate snapshot at invoice creation (400 = 4.00%). NULL on pre-program invoices.';



COMMENT ON COLUMN "public"."tm_invoices"."cash_amount" IS 'Normal price (cash/check/ACH price after the cash discount). total_amount is the posted card-inclusive total.';



COMMENT ON COLUMN "public"."tm_invoices"."paid_method" IS 'card = confirmed by signature-verified Authorize.Net webhook; cash/check/ach = recorded by staff via tm_invoice_mark_paid_offline.';



CREATE TABLE IF NOT EXISTS "public"."tm_rate_types" (
    "key" "text" NOT NULL,
    "label" "text" NOT NULL,
    "rate_hourly" numeric NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."tm_rate_types" OWNER TO "postgres";


COMMENT ON TABLE "public"."tm_rate_types" IS 'Predetermined T&M hourly rates by type of service, per Chris (2026-07-21). Edit/add rows here to expand the New Job T&M dropdown -- never hardcode rates in app code.';



CREATE TABLE IF NOT EXISTS "public"."travel_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tech_id" "uuid" NOT NULL,
    "tech_name" "text",
    "job_ref" "text",
    "visit_ref" "text",
    "client_ref" "text",
    "token" "text" NOT NULL,
    "dest_lat" numeric NOT NULL,
    "dest_lng" numeric NOT NULL,
    "dest_label" "text",
    "start_lat" numeric,
    "start_lng" numeric,
    "last_lat" numeric,
    "last_lng" numeric,
    "eta_minutes" integer,
    "distance_miles" numeric,
    "status" "text" DEFAULT 'en_route'::"text" NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_ping_at" timestamp with time zone,
    "arrived_at" timestamp with time zone
);


ALTER TABLE "public"."travel_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."users" (
    "jobber_id" "text" NOT NULL,
    "name" "text",
    "email" "text",
    "jobber_created_at" timestamp with time zone,
    "jobber_updated_at" timestamp with time zone,
    "synced_at" timestamp with time zone,
    "available_for_scheduling" boolean,
    "status" "text",
    "assigned_vehicle_id" "text",
    "assigned_vehicle_name" "text"
);


ALTER TABLE "public"."users" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vehicles" (
    "jobber_id" "text" NOT NULL,
    "name" "text",
    "make" "text",
    "model" "text",
    "year" integer,
    "license_plate" "text",
    "vin" "text",
    "status" "text",
    "speed" numeric,
    "latitude" numeric,
    "longitude" numeric,
    "gps_updated_at" timestamp with time zone,
    "jobber_updated_at" timestamp with time zone,
    "synced_at" timestamp with time zone,
    "icon_color" "text"
);


ALTER TABLE "public"."vehicles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vendor_offers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "product_id" "uuid" NOT NULL,
    "vendor_key" "text" NOT NULL,
    "connector_type" "text" DEFAULT 'api'::"text" NOT NULL,
    "vendor_sku" "text",
    "store_sku" "text",
    "vendor_title" "text" NOT NULL,
    "manufacturer_model_number" "text",
    "brand" "text",
    "package_qty" numeric,
    "unit_price" numeric,
    "bulk_price_tiers" "jsonb",
    "account_price" numeric,
    "store_availability" "jsonb",
    "delivery_availability" "jsonb",
    "lead_time_days" integer,
    "product_url" "text",
    "image_url" "text",
    "currency" "text" DEFAULT 'USD'::"text" NOT NULL,
    "last_verified_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "refresh_tier" "text" DEFAULT 'active'::"text" NOT NULL,
    "source" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "vendor_offers_connector_type_check" CHECK (("connector_type" = ANY (ARRAY['api'::"text", 'punchout'::"text", 'feed'::"text", 'document_import'::"text"]))),
    CONSTRAINT "vendor_offers_refresh_tier_check" CHECK (("refresh_tier" = ANY (ARRAY['active'::"text", 'standard'::"text", 'cold'::"text"])))
);


ALTER TABLE "public"."vendor_offers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vendors" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "category" "text" NOT NULL,
    "subcategory" "text",
    "what_they_provide" "text",
    "relationship_owner" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "qbo_vendor_ref" "text",
    "jobber_ref" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "vendors_category_check" CHECK (("category" = ANY (ARRAY['workforce'::"text", 'trade_delivery'::"text", 'material_equipment'::"text", 'professional_services'::"text", 'software_platforms'::"text", 'other'::"text"]))),
    CONSTRAINT "vendors_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'inactive'::"text", 'under_review'::"text", 'terminated'::"text"])))
);


ALTER TABLE "public"."vendors" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."visits" (
    "jobber_id" "text" NOT NULL,
    "title" "text",
    "start_at" timestamp with time zone,
    "end_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "is_all_day" boolean,
    "client_id" "text",
    "job_id" "text",
    "jobber_web_uri" "text",
    "jobber_created_at" timestamp with time zone,
    "jobber_updated_at" timestamp with time zone,
    "synced_at" timestamp with time zone,
    "assigned_users" "jsonb",
    "arrival_window_start" timestamp with time zone,
    "arrival_window_end" timestamp with time zone,
    "visit_status" "text",
    "client_uuid" "uuid",
    "job_uuid" "uuid"
);


ALTER TABLE "public"."visits" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."voice_agent_status" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "extension_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'offline'::"text" NOT NULL,
    "status_note" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "voice_agent_status_status_check" CHECK (("status" = ANY (ARRAY['available'::"text", 'on_call'::"text", 'on_break'::"text", 'dnd'::"text", 'offline'::"text", 'wrapping_up'::"text"])))
);


ALTER TABLE "public"."voice_agent_status" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."voice_blocked_numbers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "e164" "text" NOT NULL,
    "reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."voice_blocked_numbers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."voice_call_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "call_id" "uuid" NOT NULL,
    "event_type" "text" NOT NULL,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."voice_call_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."voice_call_flows" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" DEFAULT 'Main Inbound Flow'::"text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "graph" "jsonb" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."voice_call_flows" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."voice_callbacks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "call_id" "uuid",
    "queue_id" "uuid",
    "from_number" "text" NOT NULL,
    "caller_name" "text",
    "reason" "text",
    "recording_sid" "text",
    "recording_url" "text",
    "duration_seconds" integer,
    "transcript" "text",
    "transcript_status" "text" DEFAULT 'not_captured'::"text",
    "ai_summary" "jsonb",
    "status" "text" DEFAULT 'unassigned'::"text" NOT NULL,
    "assigned_extension_id" "uuid",
    "source" "text" DEFAULT 'queue_overflow'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "voice_callbacks_status_check" CHECK (("status" = ANY (ARRAY['unassigned'::"text", 'assigned'::"text", 'completed'::"text", 'dismissed'::"text"]))),
    CONSTRAINT "voice_callbacks_transcript_status_check" CHECK (("transcript_status" = ANY (ARRAY['not_captured'::"text", 'pending'::"text", 'ready'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."voice_callbacks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."voice_calls" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider_call_sid" "text",
    "direction" "text" NOT NULL,
    "from_number" "text" NOT NULL,
    "to_number" "text" NOT NULL,
    "extension_id" "uuid",
    "client_id" "text",
    "job_id" "text",
    "status" "text" DEFAULT 'created'::"text" NOT NULL,
    "conference_sid" "text",
    "caller_call_sid" "text",
    "agent_call_sid" "text",
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "answered_at" timestamp with time zone,
    "ended_at" timestamp with time zone,
    "duration_seconds" integer,
    "recording_sid" "text",
    "recording_url" "text",
    "transcript" "text",
    "transcript_status" "text" DEFAULT 'not_captured'::"text",
    "ai_summary" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "escalation_requested" boolean DEFAULT false NOT NULL,
    "flow_node_id" "text",
    "client_uuid" "uuid",
    "job_uuid" "uuid",
    CONSTRAINT "voice_calls_direction_check" CHECK (("direction" = ANY (ARRAY['inbound'::"text", 'outbound'::"text"]))),
    CONSTRAINT "voice_calls_status_check" CHECK (("status" = ANY (ARRAY['created'::"text", 'routing'::"text", 'ringing'::"text", 'answered'::"text", 'held'::"text", 'transferring'::"text", 'parked'::"text", 'conferenced'::"text", 'voicemail'::"text", 'completed'::"text", 'failed'::"text", 'missed'::"text", 'busy'::"text", 'no-answer'::"text", 'canceled'::"text", 'unknown'::"text"]))),
    CONSTRAINT "voice_calls_transcript_status_check" CHECK (("transcript_status" = ANY (ARRAY['not_captured'::"text", 'pending'::"text", 'ready'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."voice_calls" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."voice_extensions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "extension_number" "text" NOT NULL,
    "display_name" "text" NOT NULL,
    "user_id" "text",
    "direct_number_id" "uuid",
    "forwarding_number" "text",
    "call_waiting_enabled" boolean DEFAULT true NOT NULL,
    "is_operator" boolean DEFAULT false NOT NULL,
    "voicemail_pin" "text",
    "voicemail_greeting_text" "text",
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."voice_extensions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."voice_greetings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "kind" "text" NOT NULL,
    "tts_text" "text",
    "audio_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "voice_greetings_kind_check" CHECK (("kind" = ANY (ARRAY['main_open'::"text", 'main_closed'::"text", 'voicemail'::"text", 'hold'::"text"])))
);


ALTER TABLE "public"."voice_greetings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."voice_known_numbers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "e164" "text" NOT NULL,
    "display_name" "text",
    "jobber_client_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "voice_known_numbers_has_a_name" CHECK ((("display_name" IS NOT NULL) OR ("jobber_client_id" IS NOT NULL)))
);


ALTER TABLE "public"."voice_known_numbers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."voice_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "direction" "text" DEFAULT 'outbound'::"text" NOT NULL,
    "from_number" "text" NOT NULL,
    "to_number" "text" NOT NULL,
    "body" "text" NOT NULL,
    "provider_sid" "text",
    "status" "text" DEFAULT 'queued'::"text" NOT NULL,
    "client_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "client_uuid" "uuid"
);


ALTER TABLE "public"."voice_messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."voice_numbers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "e164" "text" NOT NULL,
    "friendly_name" "text",
    "provider_sid" "text",
    "role" "text" DEFAULT 'main'::"text" NOT NULL,
    "assigned_extension_id" "uuid",
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "voice_numbers_role_check" CHECK (("role" = ANY (ARRAY['main'::"text", 'direct'::"text", 'toll_free'::"text"])))
);


ALTER TABLE "public"."voice_numbers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."voice_queue_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "queue_id" "uuid" NOT NULL,
    "extension_id" "uuid" NOT NULL,
    "priority" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."voice_queue_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."voice_queues" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "ring_order" "text" DEFAULT 'fifo'::"text" NOT NULL,
    "timeout_seconds" integer DEFAULT 30 NOT NULL,
    "overflow_destination" "text" DEFAULT 'voicemail'::"text" NOT NULL,
    "overflow_extension_id" "uuid",
    "hold_music_url" "text",
    "is_default_inbound" boolean DEFAULT false NOT NULL,
    "provider_queue_sid" "text",
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "voice_queues_overflow_destination_check" CHECK (("overflow_destination" = ANY (ARRAY['extension'::"text", 'voicemail'::"text", 'callback'::"text"]))),
    CONSTRAINT "voice_queues_ring_order_check" CHECK (("ring_order" = ANY (ARRAY['fifo'::"text", 'priority'::"text"])))
);


ALTER TABLE "public"."voice_queues" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."voice_schedules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "timezone" "text" DEFAULT 'America/New_York'::"text" NOT NULL,
    "business_hours" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "holidays" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."voice_schedules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."voice_settings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "record_calls" boolean DEFAULT true NOT NULL,
    "recording_channels" "text" DEFAULT 'dual'::"text" NOT NULL,
    "ai_call_summaries" boolean DEFAULT true NOT NULL,
    "recording_consent_message" "text",
    "singleton" boolean DEFAULT true NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "voice_settings_recording_channels_check" CHECK (("recording_channels" = ANY (ARRAY['dual'::"text", 'mono'::"text"]))),
    CONSTRAINT "voice_settings_singleton_check" CHECK (("singleton" = true))
);


ALTER TABLE "public"."voice_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."voice_voicemails" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "call_id" "uuid",
    "extension_id" "uuid",
    "from_number" "text" NOT NULL,
    "recording_sid" "text",
    "recording_url" "text",
    "duration_seconds" integer,
    "transcript" "text",
    "transcript_status" "text" DEFAULT 'not_captured'::"text",
    "ai_summary" "text",
    "read" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "deleted_at" timestamp with time zone,
    CONSTRAINT "voice_voicemails_transcript_status_check" CHECK (("transcript_status" = ANY (ARRAY['not_captured'::"text", 'pending'::"text", 'ready'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."voice_voicemails" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."webhook_events" (
    "id" bigint NOT NULL,
    "topic" "text" NOT NULL,
    "item_id" "text" NOT NULL,
    "account_id" "text",
    "occurred_at" timestamp with time zone,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "error" "text",
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "processed_at" timestamp with time zone
);


ALTER TABLE "public"."webhook_events" OWNER TO "postgres";


ALTER TABLE "public"."webhook_events" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."webhook_events_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."workforce_daily_summaries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "employee_id" "uuid" NOT NULL,
    "summary_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "tasks_completed" "text",
    "plans_tomorrow" "text",
    "blockers" "text",
    "support_needed" "text",
    "hours_worked" "text",
    "submitted_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."workforce_daily_summaries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."workforce_settings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "workday_end_hour" integer DEFAULT 15 NOT NULL,
    "workday_end_minute" integer DEFAULT 30 NOT NULL,
    "idle_warning_minutes" integer DEFAULT 30 NOT NULL,
    "idle_autoclockout_grace_minutes" integer DEFAULT 15 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "monitor_screenshot_interval_minutes" integer DEFAULT 5 NOT NULL,
    "monitor_blur_screenshots" boolean DEFAULT false NOT NULL,
    "dispatch_freeze_window_enabled" boolean DEFAULT true NOT NULL,
    "dispatch_freeze_window_minutes" integer DEFAULT 60 NOT NULL
);


ALTER TABLE "public"."workforce_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."workforce_time_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "employee_id" "uuid" NOT NULL,
    "clock_in" timestamp with time zone DEFAULT "now"() NOT NULL,
    "clock_out" timestamp with time zone,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "status_flag" "text" DEFAULT 'available'::"text" NOT NULL,
    "status_emoji" "text" DEFAULT '✅'::"text" NOT NULL,
    "status_updated_at" timestamp with time zone,
    "on_break" boolean DEFAULT false NOT NULL,
    "break_started_at" timestamp with time zone,
    "total_break_seconds" integer DEFAULT 0 NOT NULL,
    "close_reason" "text"
);


ALTER TABLE "public"."workforce_time_sessions" OWNER TO "postgres";


ALTER TABLE ONLY "public"."sync_log" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."sync_log_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."annotations"
    ADD CONSTRAINT "annotations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."authnet_payment_events"
    ADD CONSTRAINT "authnet_payment_events_notification_id_key" UNIQUE ("notification_id");



ALTER TABLE ONLY "public"."authnet_payment_events"
    ADD CONSTRAINT "authnet_payment_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."automation_agent_credentials"
    ADD CONSTRAINT "automation_agent_credentials_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."automation_agent_permissions"
    ADD CONSTRAINT "automation_agent_permissions_agent_id_canonical_path_key" UNIQUE ("agent_id", "canonical_path");



ALTER TABLE ONLY "public"."automation_agent_permissions"
    ADD CONSTRAINT "automation_agent_permissions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."automation_agents"
    ADD CONSTRAINT "automation_agents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."automation_agents"
    ADD CONSTRAINT "automation_agents_tenant_id_hostname_key" UNIQUE ("tenant_id", "hostname");



ALTER TABLE ONLY "public"."automation_enrollment_codes"
    ADD CONSTRAINT "automation_enrollment_codes_code_hash_key" UNIQUE ("code_hash");



ALTER TABLE ONLY "public"."automation_enrollment_codes"
    ADD CONSTRAINT "automation_enrollment_codes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."automation_task_approvals"
    ADD CONSTRAINT "automation_task_approvals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."automation_task_events"
    ADD CONSTRAINT "automation_task_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."automation_tasks"
    ADD CONSTRAINT "automation_tasks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bookkeeping_audit_log"
    ADD CONSTRAINT "bookkeeping_audit_log_company_id_source_hash_key" UNIQUE ("company_id", "source", "hash");



ALTER TABLE ONLY "public"."bookkeeping_audit_log"
    ADD CONSTRAINT "bookkeeping_audit_log_company_id_source_seq_key" UNIQUE ("company_id", "source", "seq");



ALTER TABLE ONLY "public"."bookkeeping_audit_log"
    ADD CONSTRAINT "bookkeeping_audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bookkeeping_catalog_items"
    ADD CONSTRAINT "bookkeeping_catalog_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bookkeeping_contractor_profiles"
    ADD CONSTRAINT "bookkeeping_contractor_profiles_company_id_vendor_key_key" UNIQUE ("company_id", "vendor_key");



ALTER TABLE ONLY "public"."bookkeeping_contractor_profiles"
    ADD CONSTRAINT "bookkeeping_contractor_profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bookkeeping_evidence_documents"
    ADD CONSTRAINT "bookkeeping_evidence_documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bookkeeping_expenses"
    ADD CONSTRAINT "bookkeeping_expenses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bookkeeping_reina_learning"
    ADD CONSTRAINT "bookkeeping_reina_learning_pkey" PRIMARY KEY ("company_id");



ALTER TABLE ONLY "public"."bookkeeping_sales_tax_entries"
    ADD CONSTRAINT "bookkeeping_sales_tax_entries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bridge_heartbeats"
    ADD CONSTRAINT "bridge_heartbeats_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."business_functions"
    ADD CONSTRAINT "business_functions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."campaign_activity_log"
    ADD CONSTRAINT "campaign_activity_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."campaign_recipients"
    ADD CONSTRAINT "campaign_recipients_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."campaign_variants"
    ADD CONSTRAINT "campaign_variants_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."campaigns"
    ADD CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."change_orders"
    ADD CONSTRAINT "change_orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."client_approvals"
    ADD CONSTRAINT "client_approvals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."client_audit_log"
    ADD CONSTRAINT "client_audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."client_auth_links"
    ADD CONSTRAINT "client_auth_links_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."client_auth_links"
    ADD CONSTRAINT "client_auth_links_token_key" UNIQUE ("token");



ALTER TABLE ONLY "public"."client_locations"
    ADD CONSTRAINT "client_locations_pkey" PRIMARY KEY ("jobber_id");



ALTER TABLE ONLY "public"."client_messages"
    ADD CONSTRAINT "client_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."client_notifications"
    ADD CONSTRAINT "client_notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."client_payments"
    ADD CONSTRAINT "client_payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."client_photo_shares"
    ADD CONSTRAINT "client_photo_shares_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."client_sessions"
    ADD CONSTRAINT "client_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."client_sessions"
    ADD CONSTRAINT "client_sessions_token_key" UNIQUE ("token");



ALTER TABLE ONLY "public"."clients"
    ADD CONSTRAINT "clients_pkey" PRIMARY KEY ("jobber_id");



ALTER TABLE ONLY "public"."co_counters"
    ADD CONSTRAINT "co_counters_pkey" PRIMARY KEY ("company_id", "job_id");



ALTER TABLE ONLY "public"."companies"
    ADD CONSTRAINT "companies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."companies"
    ADD CONSTRAINT "companies_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."contracts"
    ADD CONSTRAINT "contracts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_storage_path_key" UNIQUE ("storage_path");



ALTER TABLE ONLY "public"."employee_roles"
    ADD CONSTRAINT "employee_roles_pkey" PRIMARY KEY ("jobber_id");



ALTER TABLE ONLY "public"."est_counters"
    ADD CONSTRAINT "est_counters_pkey" PRIMARY KEY ("company_id");



ALTER TABLE ONLY "public"."estimates"
    ADD CONSTRAINT "estimates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "expenses_pkey" PRIMARY KEY ("jobber_id");



ALTER TABLE ONLY "public"."external_refs"
    ADD CONSTRAINT "external_refs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."external_refs"
    ADD CONSTRAINT "external_refs_system_entity_type_external_id_key" UNIQUE ("system", "entity_type", "external_id");



ALTER TABLE ONLY "public"."field_requests"
    ADD CONSTRAINT "field_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."folder_access"
    ADD CONSTRAINT "folder_access_pkey" PRIMARY KEY ("folder_id", "user_id");



ALTER TABLE ONLY "public"."folders"
    ADD CONSTRAINT "folders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."function_assignments"
    ADD CONSTRAINT "function_assignments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."hc_mailbox_links"
    ADD CONSTRAINT "hc_mailbox_links_owner_id_ms_home_account_id_key" UNIQUE ("owner_id", "ms_home_account_id");



ALTER TABLE ONLY "public"."hc_mailbox_links"
    ADD CONSTRAINT "hc_mailbox_links_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."hc_ms_tokens"
    ADD CONSTRAINT "hc_ms_tokens_pkey" PRIMARY KEY ("owner_id", "home_account_id");



ALTER TABLE ONLY "public"."hiveconnect_account_map"
    ADD CONSTRAINT "hiveconnect_account_map_hiveconnect_user_id_key" UNIQUE ("hiveconnect_user_id");



ALTER TABLE ONLY "public"."hiveconnect_account_map"
    ADD CONSTRAINT "hiveconnect_account_map_pkey" PRIMARY KEY ("hivelogic_user_id");



ALTER TABLE ONLY "public"."integrations"
    ADD CONSTRAINT "integrations_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "invoices_pkey" PRIMARY KEY ("jobber_id");



ALTER TABLE ONLY "public"."job_signatures"
    ADD CONSTRAINT "job_signatures_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."job_time_entries"
    ADD CONSTRAINT "job_time_entries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."job_workflow"
    ADD CONSTRAINT "job_workflow_job_ref_key" UNIQUE ("job_ref");



ALTER TABLE ONLY "public"."job_workflow"
    ADD CONSTRAINT "job_workflow_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_pkey" PRIMARY KEY ("jobber_id");



ALTER TABLE ONLY "public"."lead_alerts_sent"
    ADD CONSTRAINT "lead_alerts_sent_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lead_alerts_sent"
    ADD CONSTRAINT "lead_alerts_sent_source_lead_id_key" UNIQUE ("source", "lead_id");



ALTER TABLE ONLY "public"."lead_pipeline"
    ADD CONSTRAINT "lead_pipeline_client_id_key" UNIQUE ("client_id");



ALTER TABLE ONLY "public"."lead_pipeline"
    ADD CONSTRAINT "lead_pipeline_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ledger_systems"
    ADD CONSTRAINT "ledger_systems_company_id_key" UNIQUE ("company_id");



ALTER TABLE ONLY "public"."ledger_systems"
    ADD CONSTRAINT "ledger_systems_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."marketing_annotations"
    ADD CONSTRAINT "marketing_annotations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."marketing_approvals"
    ADD CONSTRAINT "marketing_approvals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."marketing_budget_settings"
    ADD CONSTRAINT "marketing_budget_settings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."marketing_budget_settings"
    ADD CONSTRAINT "marketing_budget_settings_tenant_id_key" UNIQUE ("tenant_id");



ALTER TABLE ONLY "public"."marketing_channel_budgets"
    ADD CONSTRAINT "marketing_channel_budgets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."marketing_channel_budgets"
    ADD CONSTRAINT "marketing_channel_budgets_tenant_id_channel_key" UNIQUE ("tenant_id", "channel");



ALTER TABLE ONLY "public"."marketing_consent_ledger"
    ADD CONSTRAINT "marketing_consent_ledger_client_id_channel_key" UNIQUE ("client_id", "channel");



ALTER TABLE ONLY "public"."marketing_consent_ledger"
    ADD CONSTRAINT "marketing_consent_ledger_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."marketing_generated_assets"
    ADD CONSTRAINT "marketing_generated_assets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."marketing_media_assets"
    ADD CONSTRAINT "marketing_media_assets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."marketing_media_assets"
    ADD CONSTRAINT "marketing_media_assets_tenant_id_media_id_key" UNIQUE ("tenant_id", "media_id");



ALTER TABLE ONLY "public"."marketing_opportunities"
    ADD CONSTRAINT "marketing_opportunities_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."marketing_plan_assumptions"
    ADD CONSTRAINT "marketing_plan_assumptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."marketing_plan_assumptions"
    ADD CONSTRAINT "marketing_plan_assumptions_tenant_id_key" UNIQUE ("tenant_id");



ALTER TABLE ONLY "public"."marketing_plans"
    ADD CONSTRAINT "marketing_plans_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."marketing_platform_connections"
    ADD CONSTRAINT "marketing_platform_connections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."marketing_platform_connections"
    ADD CONSTRAINT "marketing_platform_connections_tenant_id_platform_key" UNIQUE ("tenant_id", "platform");



ALTER TABLE ONLY "public"."marketing_publications"
    ADD CONSTRAINT "marketing_publications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."marketing_source_evidence"
    ADD CONSTRAINT "marketing_source_evidence_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."marketing_suppressions"
    ADD CONSTRAINT "marketing_suppressions_client_id_channel_key" UNIQUE ("client_id", "channel");



ALTER TABLE ONLY "public"."marketing_suppressions"
    ADD CONSTRAINT "marketing_suppressions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."media_analysis"
    ADD CONSTRAINT "media_analysis_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."media_comments"
    ADD CONSTRAINT "media_comments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."media_entity_links"
    ADD CONSTRAINT "media_entity_links_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."media"
    ADD CONSTRAINT "media_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."media_tags"
    ADD CONSTRAINT "media_tags_pkey" PRIMARY KEY ("media_id", "tag_id");



ALTER TABLE ONLY "public"."monitor_activity_samples"
    ADD CONSTRAINT "monitor_activity_samples_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."monitor_agents"
    ADD CONSTRAINT "monitor_agents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."monitor_pair_attempts"
    ADD CONSTRAINT "monitor_pair_attempts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."monitor_screenshots"
    ADD CONSTRAINT "monitor_screenshots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."monitor_sessions"
    ADD CONSTRAINT "monitor_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."oauth_states"
    ADD CONSTRAINT "oauth_states_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."office_location"
    ADD CONSTRAINT "office_location_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."org_units"
    ADD CONSTRAINT "org_units_company_id_unit_type_name_key" UNIQUE ("company_id", "unit_type", "name");



ALTER TABLE ONLY "public"."org_units"
    ADD CONSTRAINT "org_units_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payroll_period_costs"
    ADD CONSTRAINT "payroll_period_costs_period_start_period_end_source_key" UNIQUE ("period_start", "period_end", "source");



ALTER TABLE ONLY "public"."payroll_period_costs"
    ADD CONSTRAINT "payroll_period_costs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."po_counters"
    ADD CONSTRAINT "po_counters_pkey" PRIMARY KEY ("company_id", "scope_key");



ALTER TABLE ONLY "public"."po_seen_bills"
    ADD CONSTRAINT "po_seen_bills_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."portal_rate_limits"
    ADD CONSTRAINT "portal_rate_limits_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."product_nicknames"
    ADD CONSTRAINT "product_nicknames_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."product_snapshots"
    ADD CONSTRAINT "product_snapshots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."qbo_report_cache"
    ADD CONSTRAINT "qbo_report_cache_pkey" PRIMARY KEY ("cache_key");



ALTER TABLE ONLY "public"."quotes"
    ADD CONSTRAINT "quotes_pkey" PRIMARY KEY ("jobber_id");



ALTER TABLE ONLY "public"."regulated_category_rules"
    ADD CONSTRAINT "regulated_category_rules_pkey" PRIMARY KEY ("category");



ALTER TABLE ONLY "public"."reina_todo"
    ADD CONSTRAINT "reina_todo_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."requests"
    ADD CONSTRAINT "requests_pkey" PRIMARY KEY ("jobber_id");



ALTER TABLE ONLY "public"."review_requests"
    ADD CONSTRAINT "review_requests_job_id_key" UNIQUE ("job_id");



ALTER TABLE ONLY "public"."review_requests"
    ADD CONSTRAINT "review_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."schedule_writeback_log"
    ADD CONSTRAINT "schedule_writeback_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."selftest_reports"
    ADD CONSTRAINT "selftest_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sub_audit_log"
    ADD CONSTRAINT "sub_audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sub_auth_links"
    ADD CONSTRAINT "sub_auth_links_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sub_auth_links"
    ADD CONSTRAINT "sub_auth_links_token_key" UNIQUE ("token");



ALTER TABLE ONLY "public"."sub_banking"
    ADD CONSTRAINT "sub_banking_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sub_documents"
    ADD CONSTRAINT "sub_documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sub_invoices"
    ADD CONSTRAINT "sub_invoices_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sub_messages"
    ADD CONSTRAINT "sub_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sub_notifications"
    ADD CONSTRAINT "sub_notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sub_rfis"
    ADD CONSTRAINT "sub_rfis_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sub_rfqs"
    ADD CONSTRAINT "sub_rfqs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sub_schedule_items"
    ADD CONSTRAINT "sub_schedule_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sub_sessions"
    ADD CONSTRAINT "sub_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sub_sessions"
    ADD CONSTRAINT "sub_sessions_token_key" UNIQUE ("token");



ALTER TABLE ONLY "public"."subcontractors"
    ADD CONSTRAINT "subcontractors_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."subs"
    ADD CONSTRAINT "subs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sync_cursors"
    ADD CONSTRAINT "sync_cursors_pkey" PRIMARY KEY ("resource");



ALTER TABLE ONLY "public"."sync_log"
    ADD CONSTRAINT "sync_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tags"
    ADD CONSTRAINT "tags_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."takeoffs"
    ADD CONSTRAINT "takeoffs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."time_sheet_entries"
    ADD CONSTRAINT "time_sheet_entries_pkey" PRIMARY KEY ("jobber_id");



ALTER TABLE ONLY "public"."timeline_events"
    ADD CONSTRAINT "timeline_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tm_invoices"
    ADD CONSTRAINT "tm_invoices_invoice_number_key" UNIQUE ("invoice_number");



ALTER TABLE ONLY "public"."tm_invoices"
    ADD CONSTRAINT "tm_invoices_pay_token_key" UNIQUE ("pay_token");



ALTER TABLE ONLY "public"."tm_invoices"
    ADD CONSTRAINT "tm_invoices_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tm_rate_types"
    ADD CONSTRAINT "tm_rate_types_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."travel_sessions"
    ADD CONSTRAINT "travel_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."travel_sessions"
    ADD CONSTRAINT "travel_sessions_token_key" UNIQUE ("token");



ALTER TABLE ONLY "public"."clients"
    ADD CONSTRAINT "uq_clients_uuid" UNIQUE ("uuid_id");



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "uq_jobs_uuid" UNIQUE ("uuid_id");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_pkey" PRIMARY KEY ("jobber_id");



ALTER TABLE ONLY "public"."vehicles"
    ADD CONSTRAINT "vehicles_pkey" PRIMARY KEY ("jobber_id");



ALTER TABLE ONLY "public"."vendor_offers"
    ADD CONSTRAINT "vendor_offers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vendors"
    ADD CONSTRAINT "vendors_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."visits"
    ADD CONSTRAINT "visits_pkey" PRIMARY KEY ("jobber_id");



ALTER TABLE ONLY "public"."voice_agent_status"
    ADD CONSTRAINT "voice_agent_status_extension_id_key" UNIQUE ("extension_id");



ALTER TABLE ONLY "public"."voice_agent_status"
    ADD CONSTRAINT "voice_agent_status_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."voice_blocked_numbers"
    ADD CONSTRAINT "voice_blocked_numbers_e164_key" UNIQUE ("e164");



ALTER TABLE ONLY "public"."voice_blocked_numbers"
    ADD CONSTRAINT "voice_blocked_numbers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."voice_call_events"
    ADD CONSTRAINT "voice_call_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."voice_call_flows"
    ADD CONSTRAINT "voice_call_flows_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."voice_callbacks"
    ADD CONSTRAINT "voice_callbacks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."voice_calls"
    ADD CONSTRAINT "voice_calls_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."voice_calls"
    ADD CONSTRAINT "voice_calls_provider_call_sid_key" UNIQUE ("provider_call_sid");



ALTER TABLE ONLY "public"."voice_extensions"
    ADD CONSTRAINT "voice_extensions_extension_number_key" UNIQUE ("extension_number");



ALTER TABLE ONLY "public"."voice_extensions"
    ADD CONSTRAINT "voice_extensions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."voice_greetings"
    ADD CONSTRAINT "voice_greetings_kind_key" UNIQUE ("kind");



ALTER TABLE ONLY "public"."voice_greetings"
    ADD CONSTRAINT "voice_greetings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."voice_known_numbers"
    ADD CONSTRAINT "voice_known_numbers_e164_key" UNIQUE ("e164");



ALTER TABLE ONLY "public"."voice_known_numbers"
    ADD CONSTRAINT "voice_known_numbers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."voice_messages"
    ADD CONSTRAINT "voice_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."voice_numbers"
    ADD CONSTRAINT "voice_numbers_e164_key" UNIQUE ("e164");



ALTER TABLE ONLY "public"."voice_numbers"
    ADD CONSTRAINT "voice_numbers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."voice_queue_members"
    ADD CONSTRAINT "voice_queue_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."voice_queue_members"
    ADD CONSTRAINT "voice_queue_members_queue_id_extension_id_key" UNIQUE ("queue_id", "extension_id");



ALTER TABLE ONLY "public"."voice_queues"
    ADD CONSTRAINT "voice_queues_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."voice_schedules"
    ADD CONSTRAINT "voice_schedules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."voice_settings"
    ADD CONSTRAINT "voice_settings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."voice_settings"
    ADD CONSTRAINT "voice_settings_singleton_key" UNIQUE ("singleton");



ALTER TABLE ONLY "public"."voice_voicemails"
    ADD CONSTRAINT "voice_voicemails_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."webhook_events"
    ADD CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."workforce_daily_summaries"
    ADD CONSTRAINT "workforce_daily_summaries_employee_id_summary_date_key" UNIQUE ("employee_id", "summary_date");



ALTER TABLE ONLY "public"."workforce_daily_summaries"
    ADD CONSTRAINT "workforce_daily_summaries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."workforce_settings"
    ADD CONSTRAINT "workforce_settings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."workforce_time_sessions"
    ADD CONSTRAINT "workforce_time_sessions_pkey" PRIMARY KEY ("id");



CREATE INDEX "annotations_media_id_idx" ON "public"."annotations" USING "btree" ("media_id");



CREATE INDEX "authnet_payment_events_invoice_idx" ON "public"."authnet_payment_events" USING "btree" ("invoice_id");



CREATE INDEX "authnet_payment_events_transaction_idx" ON "public"."authnet_payment_events" USING "btree" ("transaction_id");



CREATE UNIQUE INDEX "automation_agent_credentials_secret_hash_idx" ON "public"."automation_agent_credentials" USING "btree" ("secret_hash");



CREATE INDEX "automation_agents_tenant_heartbeat_idx" ON "public"."automation_agents" USING "btree" ("tenant_id", "last_heartbeat_at" DESC);



CREATE INDEX "automation_task_events_task_idx" ON "public"."automation_task_events" USING "btree" ("task_id", "created_at");



CREATE INDEX "automation_tasks_agent_status_idx" ON "public"."automation_tasks" USING "btree" ("agent_id", "status", "created_at");



CREATE INDEX "bookkeeping_audit_log_company_idx" ON "public"."bookkeeping_audit_log" USING "btree" ("company_id", "source", "seq");



CREATE INDEX "bookkeeping_catalog_items_company_idx" ON "public"."bookkeeping_catalog_items" USING "btree" ("company_id");



CREATE INDEX "bookkeeping_catalog_items_company_type_idx" ON "public"."bookkeeping_catalog_items" USING "btree" ("company_id", "type");



CREATE INDEX "bookkeeping_contractor_profiles_company_idx" ON "public"."bookkeeping_contractor_profiles" USING "btree" ("company_id");



CREATE INDEX "bookkeeping_evidence_documents_company_idx" ON "public"."bookkeeping_evidence_documents" USING "btree" ("company_id");



CREATE INDEX "bookkeeping_evidence_documents_document_type_idx" ON "public"."bookkeeping_evidence_documents" USING "btree" ("company_id", "document_type");



CREATE INDEX "bookkeeping_evidence_documents_status_idx" ON "public"."bookkeeping_evidence_documents" USING "btree" ("company_id", "status");



CREATE INDEX "bookkeeping_expenses_company_date_idx" ON "public"."bookkeeping_expenses" USING "btree" ("company_id", "transaction_date");



CREATE INDEX "bookkeeping_expenses_company_idx" ON "public"."bookkeeping_expenses" USING "btree" ("company_id");



CREATE INDEX "bookkeeping_expenses_company_status_idx" ON "public"."bookkeeping_expenses" USING "btree" ("company_id", "status");



CREATE INDEX "bookkeeping_sales_tax_entries_company_idx" ON "public"."bookkeeping_sales_tax_entries" USING "btree" ("company_id", "entry_date");



CREATE INDEX "bridge_heartbeats_pinged_idx" ON "public"."bridge_heartbeats" USING "btree" ("pinged_at" DESC);



CREATE UNIQUE INDEX "business_functions_name_uniq" ON "public"."business_functions" USING "btree" ("lower"("name"));



CREATE INDEX "campaign_activity_log_campaign_id_idx" ON "public"."campaign_activity_log" USING "btree" ("campaign_id", "created_at" DESC);



CREATE INDEX "campaign_recipients_campaign_id_sent_at_idx" ON "public"."campaign_recipients" USING "btree" ("campaign_id", "sent_at");



CREATE INDEX "campaign_recipients_campaign_idx" ON "public"."campaign_recipients" USING "btree" ("campaign_id");



CREATE INDEX "campaign_recipients_client_idx" ON "public"."campaign_recipients" USING "btree" ("client_id");



CREATE INDEX "campaign_variants_campaign_idx" ON "public"."campaign_variants" USING "btree" ("campaign_id");



CREATE INDEX "campaign_variants_status_idx" ON "public"."campaign_variants" USING "btree" ("tenant_id", "status");



CREATE INDEX "campaigns_status_idx" ON "public"."campaigns" USING "btree" ("status");



CREATE INDEX "change_orders_company_idx" ON "public"."change_orders" USING "btree" ("company_id");



CREATE INDEX "change_orders_company_job_idx" ON "public"."change_orders" USING "btree" ("company_id", "job_id");



CREATE UNIQUE INDEX "change_orders_company_number_uidx" ON "public"."change_orders" USING "btree" ("company_id", "co_number");



CREATE INDEX "change_orders_company_status_idx" ON "public"."change_orders" USING "btree" ("company_id", "lifecycle_status");



CREATE INDEX "client_approvals_client_idx" ON "public"."client_approvals" USING "btree" ("client_ref", "status");



CREATE INDEX "client_audit_log_client_idx" ON "public"."client_audit_log" USING "btree" ("client_ref", "created_at");



CREATE INDEX "client_auth_links_client_idx" ON "public"."client_auth_links" USING "btree" ("client_ref");



CREATE INDEX "client_auth_links_token_idx" ON "public"."client_auth_links" USING "btree" ("token");



CREATE INDEX "client_locations_geocode_idx" ON "public"."client_locations" USING "btree" ("lat", "lng");



CREATE INDEX "client_messages_client_idx" ON "public"."client_messages" USING "btree" ("client_ref", "created_at");



CREATE INDEX "client_notifications_client_idx" ON "public"."client_notifications" USING "btree" ("client_ref", "read_at");



CREATE INDEX "client_payments_client_idx" ON "public"."client_payments" USING "btree" ("client_ref", "status");



CREATE INDEX "client_photo_shares_client_idx" ON "public"."client_photo_shares" USING "btree" ("client_ref", "revoked_at");



CREATE INDEX "client_photo_shares_job_idx" ON "public"."client_photo_shares" USING "btree" ("job_ref");



CREATE UNIQUE INDEX "client_photo_shares_uidx" ON "public"."client_photo_shares" USING "btree" ("media_id", "client_ref");



CREATE INDEX "client_sessions_client_idx" ON "public"."client_sessions" USING "btree" ("client_ref");



CREATE INDEX "client_sessions_token_idx" ON "public"."client_sessions" USING "btree" ("token");



CREATE INDEX "clients_phone_e164_idx" ON "public"."clients" USING "btree" ("phone_e164");



CREATE INDEX "documents_client_idx" ON "public"."documents" USING "btree" ("client_id");



CREATE INDEX "documents_date_idx" ON "public"."documents" USING "btree" ("uploaded_at" DESC);



CREATE INDEX "documents_folder_idx" ON "public"."documents" USING "btree" ("folder_id");



CREATE INDEX "documents_job_idx" ON "public"."documents" USING "btree" ("job_id");



CREATE INDEX "documents_search_idx" ON "public"."documents" USING "gin" ("to_tsvector"('"english"'::"regconfig", ((((COALESCE("filename", ''::"text") || ' '::"text") || COALESCE("client_name", ''::"text")) || ' '::"text") || COALESCE("job_title", ''::"text"))));



CREATE INDEX "documents_type_idx" ON "public"."documents" USING "btree" ("doc_type");



CREATE INDEX "estimates_company_client_idx" ON "public"."estimates" USING "btree" ("company_id", "client_id");



CREATE INDEX "estimates_company_idx" ON "public"."estimates" USING "btree" ("company_id");



CREATE UNIQUE INDEX "estimates_company_number_uidx" ON "public"."estimates" USING "btree" ("company_id", "estimate_number");



CREATE INDEX "estimates_company_status_idx" ON "public"."estimates" USING "btree" ("company_id", "lifecycle_status");



CREATE INDEX "expenses_job_id_idx" ON "public"."expenses" USING "btree" ("job_id");



CREATE INDEX "field_requests_job_idx" ON "public"."field_requests" USING "btree" ("job_ref");



CREATE INDEX "field_requests_kind_idx" ON "public"."field_requests" USING "btree" ("kind", "created_at");



CREATE INDEX "folders_job_idx" ON "public"."folders" USING "btree" ("job_id");



CREATE INDEX "folders_parent_idx" ON "public"."folders" USING "btree" ("parent_id");



CREATE INDEX "hiveconnect_account_map_hiveconnect_user_id_idx" ON "public"."hiveconnect_account_map" USING "btree" ("hiveconnect_user_id");



CREATE INDEX "idx_invoices_job_id" ON "public"."invoices" USING "btree" ("job_id") WHERE ("job_id" IS NOT NULL);



CREATE INDEX "idx_monitor_activity_session" ON "public"."monitor_activity_samples" USING "btree" ("monitor_session_id", "sampled_at" DESC);



CREATE INDEX "idx_monitor_agents_employee" ON "public"."monitor_agents" USING "btree" ("employee_id");



CREATE INDEX "idx_monitor_agents_pairing_code" ON "public"."monitor_agents" USING "btree" ("pairing_code") WHERE ("pairing_code" IS NOT NULL);



CREATE UNIQUE INDEX "idx_monitor_agents_token" ON "public"."monitor_agents" USING "btree" ("agent_token") WHERE ("agent_token" IS NOT NULL);



CREATE INDEX "idx_monitor_pair_attempts_ip_time" ON "public"."monitor_pair_attempts" USING "btree" ("ip", "attempted_at" DESC);



CREATE INDEX "idx_monitor_screenshots_session" ON "public"."monitor_screenshots" USING "btree" ("monitor_session_id", "captured_at" DESC);



CREATE INDEX "idx_monitor_sessions_agent" ON "public"."monitor_sessions" USING "btree" ("agent_id");



CREATE INDEX "idx_monitor_sessions_employee" ON "public"."monitor_sessions" USING "btree" ("employee_id");



CREATE INDEX "ix_bookkeeping_audit_log_company_id" ON "public"."bookkeeping_audit_log" USING "btree" ("company_id");



CREATE INDEX "ix_bookkeeping_catalog_items_company_id" ON "public"."bookkeeping_catalog_items" USING "btree" ("company_id");



CREATE INDEX "ix_bookkeeping_contractor_profiles_company_id" ON "public"."bookkeeping_contractor_profiles" USING "btree" ("company_id");



CREATE INDEX "ix_bookkeeping_evidence_documents_company_id" ON "public"."bookkeeping_evidence_documents" USING "btree" ("company_id");



CREATE INDEX "ix_bookkeeping_expenses_company_id" ON "public"."bookkeeping_expenses" USING "btree" ("company_id");



CREATE INDEX "ix_bookkeeping_reina_learning_company_id" ON "public"."bookkeeping_reina_learning" USING "btree" ("company_id");



CREATE INDEX "ix_bookkeeping_sales_tax_entries_company_id" ON "public"."bookkeeping_sales_tax_entries" USING "btree" ("company_id");



CREATE INDEX "ix_campaign_recipients_client_uuid" ON "public"."campaign_recipients" USING "btree" ("client_uuid");



CREATE INDEX "ix_change_orders_company_id" ON "public"."change_orders" USING "btree" ("company_id");



CREATE INDEX "ix_change_orders_job_uuid" ON "public"."change_orders" USING "btree" ("job_uuid");



CREATE INDEX "ix_clients_company_id" ON "public"."clients" USING "btree" ("company_id");



CREATE INDEX "ix_co_counters_company_id" ON "public"."co_counters" USING "btree" ("company_id");



CREATE INDEX "ix_co_counters_job_uuid" ON "public"."co_counters" USING "btree" ("job_uuid");



CREATE INDEX "ix_documents_client_uuid" ON "public"."documents" USING "btree" ("client_uuid");



CREATE INDEX "ix_documents_job_uuid" ON "public"."documents" USING "btree" ("job_uuid");



CREATE INDEX "ix_est_counters_company_id" ON "public"."est_counters" USING "btree" ("company_id");



CREATE INDEX "ix_estimates_client_uuid" ON "public"."estimates" USING "btree" ("client_uuid");



CREATE INDEX "ix_estimates_company_id" ON "public"."estimates" USING "btree" ("company_id");



CREATE INDEX "ix_expenses_job_uuid" ON "public"."expenses" USING "btree" ("job_uuid");



CREATE INDEX "ix_folders_client_uuid" ON "public"."folders" USING "btree" ("client_uuid");



CREATE INDEX "ix_folders_job_uuid" ON "public"."folders" USING "btree" ("job_uuid");



CREATE INDEX "ix_invoices_client_uuid" ON "public"."invoices" USING "btree" ("client_uuid");



CREATE INDEX "ix_invoices_company_id" ON "public"."invoices" USING "btree" ("company_id");



CREATE INDEX "ix_invoices_job_uuid" ON "public"."invoices" USING "btree" ("job_uuid");



CREATE INDEX "ix_job_signatures_job_uuid" ON "public"."job_signatures" USING "btree" ("job_uuid");



CREATE INDEX "ix_jobs_client_uuid" ON "public"."jobs" USING "btree" ("client_uuid");



CREATE INDEX "ix_jobs_company_id" ON "public"."jobs" USING "btree" ("company_id");



CREATE INDEX "ix_lead_pipeline_client_uuid" ON "public"."lead_pipeline" USING "btree" ("client_uuid");



CREATE INDEX "ix_ledger_systems_company_id" ON "public"."ledger_systems" USING "btree" ("company_id");



CREATE INDEX "ix_marketing_consent_ledger_client_uuid" ON "public"."marketing_consent_ledger" USING "btree" ("client_uuid");



CREATE INDEX "ix_marketing_media_assets_client_uuid" ON "public"."marketing_media_assets" USING "btree" ("client_uuid");



CREATE INDEX "ix_marketing_media_assets_job_uuid" ON "public"."marketing_media_assets" USING "btree" ("job_uuid");



CREATE INDEX "ix_marketing_source_evidence_job_uuid" ON "public"."marketing_source_evidence" USING "btree" ("job_uuid");



CREATE INDEX "ix_marketing_suppressions_client_uuid" ON "public"."marketing_suppressions" USING "btree" ("client_uuid");



CREATE INDEX "ix_media_job_uuid" ON "public"."media" USING "btree" ("job_uuid");



CREATE INDEX "ix_org_units_company_id" ON "public"."org_units" USING "btree" ("company_id");



CREATE INDEX "ix_po_counters_company_id" ON "public"."po_counters" USING "btree" ("company_id");



CREATE INDEX "ix_po_seen_bills_company_id" ON "public"."po_seen_bills" USING "btree" ("company_id");



CREATE INDEX "ix_purchase_orders_company_id" ON "public"."purchase_orders" USING "btree" ("company_id");



CREATE INDEX "ix_purchase_orders_job_uuid" ON "public"."purchase_orders" USING "btree" ("job_uuid");



CREATE INDEX "ix_quotes_client_uuid" ON "public"."quotes" USING "btree" ("client_uuid");



CREATE INDEX "ix_requests_client_uuid" ON "public"."requests" USING "btree" ("client_uuid");



CREATE INDEX "ix_review_requests_client_uuid" ON "public"."review_requests" USING "btree" ("client_uuid");



CREATE INDEX "ix_review_requests_job_uuid" ON "public"."review_requests" USING "btree" ("job_uuid");



CREATE INDEX "ix_tags_job_uuid" ON "public"."tags" USING "btree" ("job_uuid");



CREATE INDEX "ix_takeoffs_job_uuid" ON "public"."takeoffs" USING "btree" ("job_uuid");



CREATE INDEX "ix_time_sheet_entries_job_uuid" ON "public"."time_sheet_entries" USING "btree" ("job_uuid");



CREATE INDEX "ix_timeline_events_job_uuid" ON "public"."timeline_events" USING "btree" ("job_uuid");



CREATE INDEX "ix_tm_invoices_client_uuid" ON "public"."tm_invoices" USING "btree" ("client_uuid");



CREATE INDEX "ix_visits_client_uuid" ON "public"."visits" USING "btree" ("client_uuid");



CREATE INDEX "ix_visits_job_uuid" ON "public"."visits" USING "btree" ("job_uuid");



CREATE INDEX "ix_voice_calls_client_uuid" ON "public"."voice_calls" USING "btree" ("client_uuid");



CREATE INDEX "ix_voice_calls_job_uuid" ON "public"."voice_calls" USING "btree" ("job_uuid");



CREATE INDEX "ix_voice_messages_client_uuid" ON "public"."voice_messages" USING "btree" ("client_uuid");



CREATE INDEX "job_signatures_job_id_idx" ON "public"."job_signatures" USING "btree" ("job_id");



CREATE INDEX "job_signatures_visit_id_idx" ON "public"."job_signatures" USING "btree" ("visit_id");



CREATE INDEX "job_time_entries_job_idx" ON "public"."job_time_entries" USING "btree" ("job_ref", "started_at");



CREATE INDEX "job_time_entries_tech_open_idx" ON "public"."job_time_entries" USING "btree" ("tech_id", "ended_at");



CREATE INDEX "job_time_entries_visit_idx" ON "public"."job_time_entries" USING "btree" ("visit_ref");



CREATE INDEX "job_workflow_job_ref_idx" ON "public"."job_workflow" USING "btree" ("job_ref");



CREATE INDEX "job_workflow_on_hold_idx" ON "public"."job_workflow" USING "btree" ("on_hold_at");



CREATE INDEX "lead_alerts_sent_alerted_at_idx" ON "public"."lead_alerts_sent" USING "btree" ("alerted_at" DESC);



CREATE INDEX "lead_pipeline_referred_by_idx" ON "public"."lead_pipeline" USING "btree" ("referred_by_client_id") WHERE ("referred_by_client_id" IS NOT NULL);



CREATE INDEX "lead_pipeline_stage_idx" ON "public"."lead_pipeline" USING "btree" ("stage");



CREATE INDEX "lead_pipeline_updated_at_idx" ON "public"."lead_pipeline" USING "btree" ("updated_at");



CREATE INDEX "ledger_systems_company_idx" ON "public"."ledger_systems" USING "btree" ("company_id");



CREATE INDEX "marketing_annotations_active_idx" ON "public"."marketing_annotations" USING "btree" ("generated_asset_id", "created_at" DESC) WHERE ("superseded_by" IS NULL);



CREATE INDEX "marketing_annotations_asset_idx" ON "public"."marketing_annotations" USING "btree" ("generated_asset_id");



CREATE INDEX "marketing_approvals_asset_idx" ON "public"."marketing_approvals" USING "btree" ("generated_asset_id");



CREATE INDEX "marketing_approvals_tenant_status_idx" ON "public"."marketing_approvals" USING "btree" ("tenant_id", "status");



CREATE INDEX "marketing_approvals_type_idx" ON "public"."marketing_approvals" USING "btree" ("approvable_type");



CREATE INDEX "marketing_channel_budgets_tenant_idx" ON "public"."marketing_channel_budgets" USING "btree" ("tenant_id");



CREATE INDEX "marketing_consent_ledger_client_idx" ON "public"."marketing_consent_ledger" USING "btree" ("client_id");



CREATE INDEX "marketing_consent_ledger_status_idx" ON "public"."marketing_consent_ledger" USING "btree" ("channel", "status");



CREATE INDEX "marketing_generated_assets_media_asset_idx" ON "public"."marketing_generated_assets" USING "btree" ("media_asset_id");



CREATE INDEX "marketing_generated_assets_status_idx" ON "public"."marketing_generated_assets" USING "btree" ("tenant_id", "status");



CREATE INDEX "marketing_generated_assets_variant_idx" ON "public"."marketing_generated_assets" USING "btree" ("campaign_variant_id");



CREATE INDEX "marketing_media_assets_client_idx" ON "public"."marketing_media_assets" USING "btree" ("client_id");



CREATE INDEX "marketing_media_assets_job_idx" ON "public"."marketing_media_assets" USING "btree" ("job_id");



CREATE INDEX "marketing_media_assets_selected_for_idx" ON "public"."marketing_media_assets" USING "btree" ("tenant_id", "selected_for");



CREATE INDEX "marketing_opportunities_campaign_idx" ON "public"."marketing_opportunities" USING "btree" ("campaign_id");



CREATE INDEX "marketing_opportunities_plan_idx" ON "public"."marketing_opportunities" USING "btree" ("plan_id");



CREATE INDEX "marketing_opportunities_status_idx" ON "public"."marketing_opportunities" USING "btree" ("tenant_id", "status");



CREATE INDEX "marketing_opportunities_tenant_key_idx" ON "public"."marketing_opportunities" USING "btree" ("tenant_id", "opportunity_key", "surfaced_at" DESC);



CREATE UNIQUE INDEX "marketing_plans_one_active_per_tenant" ON "public"."marketing_plans" USING "btree" ("tenant_id") WHERE ("status" = 'active'::"text");



CREATE INDEX "marketing_plans_period_idx" ON "public"."marketing_plans" USING "btree" ("tenant_id", "period_start", "period_end");



CREATE INDEX "marketing_plans_tenant_status_idx" ON "public"."marketing_plans" USING "btree" ("tenant_id", "status");



CREATE INDEX "marketing_platform_connections_tenant_idx" ON "public"."marketing_platform_connections" USING "btree" ("tenant_id");



CREATE INDEX "marketing_publications_asset_idx" ON "public"."marketing_publications" USING "btree" ("generated_asset_id");



CREATE INDEX "marketing_publications_destination_idx" ON "public"."marketing_publications" USING "btree" ("destination_type");



CREATE INDEX "marketing_publications_tenant_status_idx" ON "public"."marketing_publications" USING "btree" ("tenant_id", "status");



CREATE INDEX "marketing_source_evidence_asset_idx" ON "public"."marketing_source_evidence" USING "btree" ("generated_asset_id");



CREATE INDEX "marketing_source_evidence_job_idx" ON "public"."marketing_source_evidence" USING "btree" ("job_id");



CREATE INDEX "marketing_suppressions_client_idx" ON "public"."marketing_suppressions" USING "btree" ("client_id");



CREATE UNIQUE INDEX "media_analysis_media_id_idx" ON "public"."media_analysis" USING "btree" ("media_id");



CREATE INDEX "media_captured_at_idx" ON "public"."media" USING "btree" ("captured_at" DESC);



CREATE INDEX "media_comments_media_id_idx" ON "public"."media_comments" USING "btree" ("media_id");



CREATE INDEX "media_entity_links_entity_idx" ON "public"."media_entity_links" USING "btree" ("entity_type", "entity_id");



CREATE INDEX "media_entity_links_media_id_idx" ON "public"."media_entity_links" USING "btree" ("media_id");



CREATE INDEX "media_job_id_idx" ON "public"."media" USING "btree" ("job_id");



CREATE UNIQUE INDEX "media_offline_client_id_idx" ON "public"."media" USING "btree" ("offline_client_id") WHERE ("offline_client_id" IS NOT NULL);



CREATE INDEX "monitor_activity_samples_sampled_idx" ON "public"."monitor_activity_samples" USING "btree" ("sampled_at");



CREATE INDEX "monitor_activity_samples_session_idx" ON "public"."monitor_activity_samples" USING "btree" ("monitor_session_id", "sampled_at" DESC);



CREATE INDEX "monitor_agents_employee_status_idx" ON "public"."monitor_agents" USING "btree" ("employee_id", "status");



CREATE INDEX "monitor_agents_pending_idx" ON "public"."monitor_agents" USING "btree" ("employee_id") WHERE ("status" = 'pending'::"text");



CREATE INDEX "monitor_agents_token_hash_idx" ON "public"."monitor_agents" USING "btree" ("agent_token_hash") WHERE ("status" = 'active'::"text");



CREATE INDEX "monitor_pair_attempts_ip_idx" ON "public"."monitor_pair_attempts" USING "btree" ("ip", "attempted_at");



CREATE INDEX "monitor_screenshots_captured_idx" ON "public"."monitor_screenshots" USING "btree" ("captured_at");



CREATE INDEX "monitor_screenshots_session_idx" ON "public"."monitor_screenshots" USING "btree" ("monitor_session_id", "captured_at" DESC);



CREATE INDEX "monitor_sessions_agent_open_idx" ON "public"."monitor_sessions" USING "btree" ("agent_id", "started_at" DESC) WHERE ("ended_at" IS NULL);



CREATE INDEX "monitor_sessions_employee_idx" ON "public"."monitor_sessions" USING "btree" ("employee_id", "started_at" DESC);



CREATE INDEX "monitor_sessions_workforce_idx" ON "public"."monitor_sessions" USING "btree" ("workforce_session_id");



CREATE UNIQUE INDEX "oauth_states_provider_hash_uidx" ON "public"."oauth_states" USING "btree" ("provider", "state_hash");



CREATE INDEX "po_seen_bills_dup_idx" ON "public"."po_seen_bills" USING "btree" ("company_id", "qbo_vendor_id", "invoice_number", "currency", "amount");



CREATE UNIQUE INDEX "po_seen_bills_source_txn_uidx" ON "public"."po_seen_bills" USING "btree" ("company_id", "source_transaction_id");



CREATE INDEX "portal_rate_limits_bucket_time_idx" ON "public"."portal_rate_limits" USING "btree" ("bucket", "created_at");



CREATE INDEX "product_nicknames_nickname_idx" ON "public"."product_nicknames" USING "btree" ("lower"("nickname"));



CREATE INDEX "product_nicknames_vendor_sku_idx" ON "public"."product_nicknames" USING "btree" ("vendor_key", "vendor_sku");



CREATE INDEX "product_snapshots_attached_idx" ON "public"."product_snapshots" USING "btree" ("attached_to_type", "attached_to_id");



CREATE INDEX "product_snapshots_draft_cart_idx" ON "public"."product_snapshots" USING "btree" ("draft_cart_id") WHERE ("draft_cart_id" IS NOT NULL);



CREATE INDEX "product_snapshots_product_id_idx" ON "public"."product_snapshots" USING "btree" ("product_id");



CREATE INDEX "products_category_idx" ON "public"."products" USING "btree" ("category");



CREATE INDEX "products_name_trgm_idx" ON "public"."products" USING "gin" ("to_tsvector"('"english"'::"regconfig", "standard_name"));



CREATE INDEX "products_status_idx" ON "public"."products" USING "btree" ("status");



CREATE INDEX "purchase_orders_company_idx" ON "public"."purchase_orders" USING "btree" ("company_id");



CREATE INDEX "purchase_orders_company_job_idx" ON "public"."purchase_orders" USING "btree" ("company_id", "job_id");



CREATE UNIQUE INDEX "purchase_orders_company_number_uidx" ON "public"."purchase_orders" USING "btree" ("company_id", "po_number");



CREATE INDEX "purchase_orders_company_status_idx" ON "public"."purchase_orders" USING "btree" ("company_id", "lifecycle_status");



CREATE INDEX "quotes_client_id_idx" ON "public"."quotes" USING "btree" ("client_id");



CREATE INDEX "quotes_status_idx" ON "public"."quotes" USING "btree" ("quote_status");



CREATE INDEX "requests_client_id_idx" ON "public"."requests" USING "btree" ("client_id");



CREATE INDEX "requests_updated_at_idx" ON "public"."requests" USING "btree" ("jobber_updated_at" DESC);



CREATE INDEX "review_requests_status_idx" ON "public"."review_requests" USING "btree" ("status");



CREATE INDEX "schedule_writeback_log_created_at_idx" ON "public"."schedule_writeback_log" USING "btree" ("created_at" DESC);



CREATE INDEX "schedule_writeback_log_visit_id_idx" ON "public"."schedule_writeback_log" USING "btree" ("visit_id");



CREATE UNIQUE INDEX "selftest_reports_run_id_uidx" ON "public"."selftest_reports" USING "btree" ("run_id");



CREATE INDEX "sub_audit_log_sub_idx" ON "public"."sub_audit_log" USING "btree" ("sub_id", "created_at");



CREATE INDEX "sub_auth_links_sub_idx" ON "public"."sub_auth_links" USING "btree" ("sub_id");



CREATE INDEX "sub_auth_links_token_idx" ON "public"."sub_auth_links" USING "btree" ("token");



CREATE UNIQUE INDEX "sub_banking_sub_uidx" ON "public"."sub_banking" USING "btree" ("sub_id");



CREATE INDEX "sub_documents_sub_idx" ON "public"."sub_documents" USING "btree" ("sub_id");



CREATE INDEX "sub_invoices_sub_idx" ON "public"."sub_invoices" USING "btree" ("sub_id", "status");



CREATE INDEX "sub_messages_sub_idx" ON "public"."sub_messages" USING "btree" ("sub_id", "created_at");



CREATE INDEX "sub_notifications_sub_idx" ON "public"."sub_notifications" USING "btree" ("sub_id", "read_at");



CREATE INDEX "sub_rfis_sub_idx" ON "public"."sub_rfis" USING "btree" ("sub_id", "status");



CREATE INDEX "sub_rfqs_sub_idx" ON "public"."sub_rfqs" USING "btree" ("sub_id", "status");



CREATE INDEX "sub_schedule_sub_idx" ON "public"."sub_schedule_items" USING "btree" ("sub_id", "start_at");



CREATE INDEX "sub_sessions_sub_idx" ON "public"."sub_sessions" USING "btree" ("sub_id");



CREATE INDEX "sub_sessions_token_idx" ON "public"."sub_sessions" USING "btree" ("token");



CREATE INDEX "subs_email_idx" ON "public"."subs" USING "btree" ("email");



CREATE INDEX "subs_phone_idx" ON "public"."subs" USING "btree" ("phone");



CREATE INDEX "subs_status_idx" ON "public"."subs" USING "btree" ("status");



CREATE UNIQUE INDEX "subscriptions_name_uniq" ON "public"."subscriptions" USING "btree" ("lower"("name"));



CREATE INDEX "tags_job_id_idx" ON "public"."tags" USING "btree" ("job_id");



CREATE UNIQUE INDEX "tags_job_id_name_idx" ON "public"."tags" USING "btree" ("job_id", "lower"("name"));



CREATE INDEX "takeoffs_job_id_idx" ON "public"."takeoffs" USING "btree" ("job_id");



CREATE INDEX "takeoffs_quote_id_idx" ON "public"."takeoffs" USING "btree" ("quote_id");



CREATE INDEX "time_sheet_entries_job_id_idx" ON "public"."time_sheet_entries" USING "btree" ("job_id");



CREATE INDEX "time_sheet_entries_user_id_idx" ON "public"."time_sheet_entries" USING "btree" ("user_id");



CREATE INDEX "timeline_events_job_id_idx" ON "public"."timeline_events" USING "btree" ("job_id");



CREATE INDEX "timeline_events_occurred_at_idx" ON "public"."timeline_events" USING "btree" ("occurred_at" DESC);



CREATE INDEX "travel_sessions_tech_idx" ON "public"."travel_sessions" USING "btree" ("tech_id", "status");



CREATE INDEX "travel_sessions_token_idx" ON "public"."travel_sessions" USING "btree" ("token");



CREATE UNIQUE INDEX "ux_invoices_uuid" ON "public"."invoices" USING "btree" ("uuid_id");



CREATE INDEX "vehicles_status_idx" ON "public"."vehicles" USING "btree" ("status");



CREATE INDEX "vendor_offers_last_verified_idx" ON "public"."vendor_offers" USING "btree" ("last_verified_at");



CREATE INDEX "vendor_offers_product_id_idx" ON "public"."vendor_offers" USING "btree" ("product_id");



CREATE INDEX "vendor_offers_vendor_key_idx" ON "public"."vendor_offers" USING "btree" ("vendor_key");



CREATE UNIQUE INDEX "vendor_offers_vendor_sku_idx" ON "public"."vendor_offers" USING "btree" ("vendor_key", "vendor_sku") WHERE ("vendor_sku" IS NOT NULL);



CREATE UNIQUE INDEX "vendors_name_uniq" ON "public"."vendors" USING "btree" ("lower"("name"));



CREATE INDEX "visits_job_id_idx" ON "public"."visits" USING "btree" ("job_id");



CREATE INDEX "visits_start_at_idx" ON "public"."visits" USING "btree" ("start_at");



CREATE INDEX "voice_call_events_call_idx" ON "public"."voice_call_events" USING "btree" ("call_id");



CREATE INDEX "voice_call_flows_active_idx" ON "public"."voice_call_flows" USING "btree" ("is_active", "updated_at" DESC);



CREATE INDEX "voice_callbacks_queue_idx" ON "public"."voice_callbacks" USING "btree" ("queue_id");



CREATE INDEX "voice_callbacks_status_idx" ON "public"."voice_callbacks" USING "btree" ("status", "created_at" DESC);



CREATE INDEX "voice_calls_client_idx" ON "public"."voice_calls" USING "btree" ("client_id");



CREATE INDEX "voice_calls_extension_idx" ON "public"."voice_calls" USING "btree" ("extension_id");



CREATE INDEX "voice_calls_started_idx" ON "public"."voice_calls" USING "btree" ("started_at" DESC);



CREATE INDEX "voice_queue_members_ext_idx" ON "public"."voice_queue_members" USING "btree" ("extension_id");



CREATE INDEX "voice_queue_members_queue_idx" ON "public"."voice_queue_members" USING "btree" ("queue_id");



CREATE INDEX "voice_queues_active_idx" ON "public"."voice_queues" USING "btree" ("active");



CREATE UNIQUE INDEX "voice_queues_one_default_inbound_idx" ON "public"."voice_queues" USING "btree" ("is_default_inbound") WHERE "is_default_inbound";



CREATE INDEX "voice_voicemails_deleted_idx" ON "public"."voice_voicemails" USING "btree" ("deleted_at");



CREATE INDEX "voice_voicemails_extension_idx" ON "public"."voice_voicemails" USING "btree" ("extension_id");



CREATE INDEX "voice_voicemails_unread_idx" ON "public"."voice_voicemails" USING "btree" ("extension_id", "read");



CREATE INDEX "webhook_events_pending_idx" ON "public"."webhook_events" USING "btree" ("received_at") WHERE ("status" = 'pending'::"text");



CREATE OR REPLACE TRIGGER "bookkeeping_audit_log_no_update" BEFORE DELETE OR UPDATE ON "public"."bookkeeping_audit_log" FOR EACH ROW EXECUTE FUNCTION "public"."bookkeeping_audit_log_immutable"();



CREATE OR REPLACE TRIGGER "documents_sensitive_default" BEFORE INSERT OR UPDATE OF "doc_type" ON "public"."documents" FOR EACH ROW EXECUTE FUNCTION "public"."apply_sensitive_default"();



CREATE OR REPLACE TRIGGER "trg_protect_locked_geocode" BEFORE UPDATE ON "public"."client_locations" FOR EACH ROW EXECUTE FUNCTION "public"."protect_locked_geocode"();



ALTER TABLE ONLY "public"."annotations"
    ADD CONSTRAINT "annotations_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."annotations"
    ADD CONSTRAINT "annotations_superseded_by_fkey" FOREIGN KEY ("superseded_by") REFERENCES "public"."annotations"("id");



ALTER TABLE ONLY "public"."automation_agent_credentials"
    ADD CONSTRAINT "automation_agent_credentials_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."automation_agents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."automation_agent_permissions"
    ADD CONSTRAINT "automation_agent_permissions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."automation_agents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."automation_agents"
    ADD CONSTRAINT "automation_agents_current_task_fk" FOREIGN KEY ("current_task_id") REFERENCES "public"."automation_tasks"("id") DEFERRABLE INITIALLY DEFERRED;



ALTER TABLE ONLY "public"."automation_task_approvals"
    ADD CONSTRAINT "automation_task_approvals_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."automation_tasks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."automation_task_events"
    ADD CONSTRAINT "automation_task_events_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."automation_agents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."automation_task_events"
    ADD CONSTRAINT "automation_task_events_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."automation_tasks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."automation_tasks"
    ADD CONSTRAINT "automation_tasks_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."automation_agents"("id");



ALTER TABLE ONLY "public"."campaign_activity_log"
    ADD CONSTRAINT "campaign_activity_log_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."campaign_recipients"
    ADD CONSTRAINT "campaign_recipients_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."campaign_recipients"
    ADD CONSTRAINT "campaign_recipients_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("jobber_id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."campaign_variants"
    ADD CONSTRAINT "campaign_variants_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."campaign_variants"
    ADD CONSTRAINT "campaign_variants_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "public"."marketing_opportunities"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."client_photo_shares"
    ADD CONSTRAINT "client_photo_shares_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."contracts"
    ADD CONSTRAINT "contracts_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id");



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."employee_roles"
    ADD CONSTRAINT "employee_roles_jobber_id_fkey" FOREIGN KEY ("jobber_id") REFERENCES "public"."users"("jobber_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."campaign_recipients"
    ADD CONSTRAINT "fk_campaign_recipients_client_uuid" FOREIGN KEY ("client_uuid") REFERENCES "public"."clients"("uuid_id");



ALTER TABLE ONLY "public"."change_orders"
    ADD CONSTRAINT "fk_change_orders_job_uuid" FOREIGN KEY ("job_uuid") REFERENCES "public"."jobs"("uuid_id");



ALTER TABLE ONLY "public"."clients"
    ADD CONSTRAINT "fk_clients_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");



ALTER TABLE ONLY "public"."co_counters"
    ADD CONSTRAINT "fk_co_counters_job_uuid" FOREIGN KEY ("job_uuid") REFERENCES "public"."jobs"("uuid_id");



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "fk_documents_client_uuid" FOREIGN KEY ("client_uuid") REFERENCES "public"."clients"("uuid_id");



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "fk_documents_job_uuid" FOREIGN KEY ("job_uuid") REFERENCES "public"."jobs"("uuid_id");



ALTER TABLE ONLY "public"."estimates"
    ADD CONSTRAINT "fk_estimates_client_uuid" FOREIGN KEY ("client_uuid") REFERENCES "public"."clients"("uuid_id");



ALTER TABLE ONLY "public"."expenses"
    ADD CONSTRAINT "fk_expenses_job_uuid" FOREIGN KEY ("job_uuid") REFERENCES "public"."jobs"("uuid_id");



ALTER TABLE ONLY "public"."folders"
    ADD CONSTRAINT "fk_folders_client_uuid" FOREIGN KEY ("client_uuid") REFERENCES "public"."clients"("uuid_id");



ALTER TABLE ONLY "public"."folders"
    ADD CONSTRAINT "fk_folders_job_uuid" FOREIGN KEY ("job_uuid") REFERENCES "public"."jobs"("uuid_id");



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "fk_invoices_client_uuid" FOREIGN KEY ("client_uuid") REFERENCES "public"."clients"("uuid_id");



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "fk_invoices_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");



ALTER TABLE ONLY "public"."invoices"
    ADD CONSTRAINT "fk_invoices_job_uuid" FOREIGN KEY ("job_uuid") REFERENCES "public"."jobs"("uuid_id");



ALTER TABLE ONLY "public"."job_signatures"
    ADD CONSTRAINT "fk_job_signatures_job_uuid" FOREIGN KEY ("job_uuid") REFERENCES "public"."jobs"("uuid_id");



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "fk_jobs_client_uuid" FOREIGN KEY ("client_uuid") REFERENCES "public"."clients"("uuid_id");



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "fk_jobs_company" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");



ALTER TABLE ONLY "public"."lead_pipeline"
    ADD CONSTRAINT "fk_lead_pipeline_client_uuid" FOREIGN KEY ("client_uuid") REFERENCES "public"."clients"("uuid_id");



ALTER TABLE ONLY "public"."marketing_consent_ledger"
    ADD CONSTRAINT "fk_marketing_consent_ledger_client_uuid" FOREIGN KEY ("client_uuid") REFERENCES "public"."clients"("uuid_id");



ALTER TABLE ONLY "public"."marketing_media_assets"
    ADD CONSTRAINT "fk_marketing_media_assets_client_uuid" FOREIGN KEY ("client_uuid") REFERENCES "public"."clients"("uuid_id");



ALTER TABLE ONLY "public"."marketing_media_assets"
    ADD CONSTRAINT "fk_marketing_media_assets_job_uuid" FOREIGN KEY ("job_uuid") REFERENCES "public"."jobs"("uuid_id");



ALTER TABLE ONLY "public"."marketing_source_evidence"
    ADD CONSTRAINT "fk_marketing_source_evidence_job_uuid" FOREIGN KEY ("job_uuid") REFERENCES "public"."jobs"("uuid_id");



ALTER TABLE ONLY "public"."marketing_suppressions"
    ADD CONSTRAINT "fk_marketing_suppressions_client_uuid" FOREIGN KEY ("client_uuid") REFERENCES "public"."clients"("uuid_id");



ALTER TABLE ONLY "public"."media"
    ADD CONSTRAINT "fk_media_job_uuid" FOREIGN KEY ("job_uuid") REFERENCES "public"."jobs"("uuid_id");



ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "fk_purchase_orders_job_uuid" FOREIGN KEY ("job_uuid") REFERENCES "public"."jobs"("uuid_id");



ALTER TABLE ONLY "public"."quotes"
    ADD CONSTRAINT "fk_quotes_client_uuid" FOREIGN KEY ("client_uuid") REFERENCES "public"."clients"("uuid_id");



ALTER TABLE ONLY "public"."requests"
    ADD CONSTRAINT "fk_requests_client_uuid" FOREIGN KEY ("client_uuid") REFERENCES "public"."clients"("uuid_id");



ALTER TABLE ONLY "public"."review_requests"
    ADD CONSTRAINT "fk_review_requests_client_uuid" FOREIGN KEY ("client_uuid") REFERENCES "public"."clients"("uuid_id");



ALTER TABLE ONLY "public"."review_requests"
    ADD CONSTRAINT "fk_review_requests_job_uuid" FOREIGN KEY ("job_uuid") REFERENCES "public"."jobs"("uuid_id");



ALTER TABLE ONLY "public"."tags"
    ADD CONSTRAINT "fk_tags_job_uuid" FOREIGN KEY ("job_uuid") REFERENCES "public"."jobs"("uuid_id");



ALTER TABLE ONLY "public"."takeoffs"
    ADD CONSTRAINT "fk_takeoffs_job_uuid" FOREIGN KEY ("job_uuid") REFERENCES "public"."jobs"("uuid_id");



ALTER TABLE ONLY "public"."time_sheet_entries"
    ADD CONSTRAINT "fk_time_sheet_entries_job_uuid" FOREIGN KEY ("job_uuid") REFERENCES "public"."jobs"("uuid_id");



ALTER TABLE ONLY "public"."timeline_events"
    ADD CONSTRAINT "fk_timeline_events_job_uuid" FOREIGN KEY ("job_uuid") REFERENCES "public"."jobs"("uuid_id");



ALTER TABLE ONLY "public"."tm_invoices"
    ADD CONSTRAINT "fk_tm_invoices_client_uuid" FOREIGN KEY ("client_uuid") REFERENCES "public"."clients"("uuid_id");



ALTER TABLE ONLY "public"."visits"
    ADD CONSTRAINT "fk_visits_client_uuid" FOREIGN KEY ("client_uuid") REFERENCES "public"."clients"("uuid_id");



ALTER TABLE ONLY "public"."visits"
    ADD CONSTRAINT "fk_visits_job_uuid" FOREIGN KEY ("job_uuid") REFERENCES "public"."jobs"("uuid_id");



ALTER TABLE ONLY "public"."voice_calls"
    ADD CONSTRAINT "fk_voice_calls_client_uuid" FOREIGN KEY ("client_uuid") REFERENCES "public"."clients"("uuid_id");



ALTER TABLE ONLY "public"."voice_calls"
    ADD CONSTRAINT "fk_voice_calls_job_uuid" FOREIGN KEY ("job_uuid") REFERENCES "public"."jobs"("uuid_id");



ALTER TABLE ONLY "public"."voice_messages"
    ADD CONSTRAINT "fk_voice_messages_client_uuid" FOREIGN KEY ("client_uuid") REFERENCES "public"."clients"("uuid_id");



ALTER TABLE ONLY "public"."folder_access"
    ADD CONSTRAINT "folder_access_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."folder_access"
    ADD CONSTRAINT "folder_access_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."folder_access"
    ADD CONSTRAINT "folder_access_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."folders"
    ADD CONSTRAINT "folders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."folders"
    ADD CONSTRAINT "folders_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "public"."folders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."function_assignments"
    ADD CONSTRAINT "function_assignments_function_id_fkey" FOREIGN KEY ("function_id") REFERENCES "public"."business_functions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."function_assignments"
    ADD CONSTRAINT "function_assignments_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id");



ALTER TABLE ONLY "public"."function_assignments"
    ADD CONSTRAINT "function_assignments_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id");



ALTER TABLE ONLY "public"."hc_mailbox_links"
    ADD CONSTRAINT "hc_mailbox_links_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lead_pipeline"
    ADD CONSTRAINT "lead_pipeline_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("jobber_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lead_pipeline"
    ADD CONSTRAINT "lead_pipeline_referred_by_client_id_fkey" FOREIGN KEY ("referred_by_client_id") REFERENCES "public"."clients"("jobber_id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."marketing_annotations"
    ADD CONSTRAINT "marketing_annotations_generated_asset_id_fkey" FOREIGN KEY ("generated_asset_id") REFERENCES "public"."marketing_generated_assets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."marketing_annotations"
    ADD CONSTRAINT "marketing_annotations_regenerated_asset_id_fkey" FOREIGN KEY ("regenerated_asset_id") REFERENCES "public"."marketing_generated_assets"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."marketing_annotations"
    ADD CONSTRAINT "marketing_annotations_superseded_by_fkey" FOREIGN KEY ("superseded_by") REFERENCES "public"."marketing_annotations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."marketing_approvals"
    ADD CONSTRAINT "marketing_approvals_generated_asset_id_fkey" FOREIGN KEY ("generated_asset_id") REFERENCES "public"."marketing_generated_assets"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."marketing_approvals"
    ADD CONSTRAINT "marketing_approvals_preview_media_id_fkey" FOREIGN KEY ("preview_media_id") REFERENCES "public"."media"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."marketing_consent_ledger"
    ADD CONSTRAINT "marketing_consent_ledger_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("jobber_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."marketing_generated_assets"
    ADD CONSTRAINT "marketing_generated_assets_campaign_variant_id_fkey" FOREIGN KEY ("campaign_variant_id") REFERENCES "public"."campaign_variants"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."marketing_generated_assets"
    ADD CONSTRAINT "marketing_generated_assets_media_asset_id_fkey" FOREIGN KEY ("media_asset_id") REFERENCES "public"."marketing_media_assets"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."marketing_media_assets"
    ADD CONSTRAINT "marketing_media_assets_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("jobber_id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."marketing_media_assets"
    ADD CONSTRAINT "marketing_media_assets_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."marketing_opportunities"
    ADD CONSTRAINT "marketing_opportunities_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."marketing_opportunities"
    ADD CONSTRAINT "marketing_opportunities_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."marketing_plans"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."marketing_plans"
    ADD CONSTRAINT "marketing_plans_superseded_by_fkey" FOREIGN KEY ("superseded_by") REFERENCES "public"."marketing_plans"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."marketing_publications"
    ADD CONSTRAINT "marketing_publications_approval_id_fkey" FOREIGN KEY ("approval_id") REFERENCES "public"."marketing_approvals"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."marketing_publications"
    ADD CONSTRAINT "marketing_publications_generated_asset_id_fkey" FOREIGN KEY ("generated_asset_id") REFERENCES "public"."marketing_generated_assets"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."marketing_source_evidence"
    ADD CONSTRAINT "marketing_source_evidence_generated_asset_id_fkey" FOREIGN KEY ("generated_asset_id") REFERENCES "public"."marketing_generated_assets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."marketing_source_evidence"
    ADD CONSTRAINT "marketing_source_evidence_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."marketing_suppressions"
    ADD CONSTRAINT "marketing_suppressions_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("jobber_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."media_analysis"
    ADD CONSTRAINT "media_analysis_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."media_comments"
    ADD CONSTRAINT "media_comments_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."media_entity_links"
    ADD CONSTRAINT "media_entity_links_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."media_tags"
    ADD CONSTRAINT "media_tags_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."media_tags"
    ADD CONSTRAINT "media_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."monitor_activity_samples"
    ADD CONSTRAINT "monitor_activity_samples_monitor_session_id_fkey" FOREIGN KEY ("monitor_session_id") REFERENCES "public"."monitor_sessions"("id");



ALTER TABLE ONLY "public"."monitor_agents"
    ADD CONSTRAINT "monitor_agents_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."monitor_screenshots"
    ADD CONSTRAINT "monitor_screenshots_monitor_session_id_fkey" FOREIGN KEY ("monitor_session_id") REFERENCES "public"."monitor_sessions"("id");



ALTER TABLE ONLY "public"."monitor_sessions"
    ADD CONSTRAINT "monitor_sessions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."monitor_agents"("id");



ALTER TABLE ONLY "public"."monitor_sessions"
    ADD CONSTRAINT "monitor_sessions_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."monitor_sessions"
    ADD CONSTRAINT "monitor_sessions_workforce_session_id_fkey" FOREIGN KEY ("workforce_session_id") REFERENCES "public"."workforce_time_sessions"("id");



ALTER TABLE ONLY "public"."org_units"
    ADD CONSTRAINT "org_units_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id");



ALTER TABLE ONLY "public"."org_units"
    ADD CONSTRAINT "org_units_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "public"."org_units"("id");



ALTER TABLE ONLY "public"."product_snapshots"
    ADD CONSTRAINT "product_snapshots_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id");



ALTER TABLE ONLY "public"."product_snapshots"
    ADD CONSTRAINT "product_snapshots_vendor_offer_id_fkey" FOREIGN KEY ("vendor_offer_id") REFERENCES "public"."vendor_offers"("id");



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_merged_into_id_fkey" FOREIGN KEY ("merged_into_id") REFERENCES "public"."products"("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sub_audit_log"
    ADD CONSTRAINT "sub_audit_log_sub_id_fkey" FOREIGN KEY ("sub_id") REFERENCES "public"."subs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sub_auth_links"
    ADD CONSTRAINT "sub_auth_links_sub_id_fkey" FOREIGN KEY ("sub_id") REFERENCES "public"."subs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sub_banking"
    ADD CONSTRAINT "sub_banking_sub_id_fkey" FOREIGN KEY ("sub_id") REFERENCES "public"."subs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sub_documents"
    ADD CONSTRAINT "sub_documents_sub_id_fkey" FOREIGN KEY ("sub_id") REFERENCES "public"."subs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sub_invoices"
    ADD CONSTRAINT "sub_invoices_sub_id_fkey" FOREIGN KEY ("sub_id") REFERENCES "public"."subs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sub_messages"
    ADD CONSTRAINT "sub_messages_sub_id_fkey" FOREIGN KEY ("sub_id") REFERENCES "public"."subs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sub_notifications"
    ADD CONSTRAINT "sub_notifications_sub_id_fkey" FOREIGN KEY ("sub_id") REFERENCES "public"."subs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sub_rfis"
    ADD CONSTRAINT "sub_rfis_sub_id_fkey" FOREIGN KEY ("sub_id") REFERENCES "public"."subs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sub_rfqs"
    ADD CONSTRAINT "sub_rfqs_sub_id_fkey" FOREIGN KEY ("sub_id") REFERENCES "public"."subs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sub_schedule_items"
    ADD CONSTRAINT "sub_schedule_items_sub_id_fkey" FOREIGN KEY ("sub_id") REFERENCES "public"."subs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sub_sessions"
    ADD CONSTRAINT "sub_sessions_sub_id_fkey" FOREIGN KEY ("sub_id") REFERENCES "public"."subs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id");



ALTER TABLE ONLY "public"."timeline_events"
    ADD CONSTRAINT "timeline_events_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vendor_offers"
    ADD CONSTRAINT "vendor_offers_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."voice_agent_status"
    ADD CONSTRAINT "voice_agent_status_extension_id_fkey" FOREIGN KEY ("extension_id") REFERENCES "public"."voice_extensions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."voice_call_events"
    ADD CONSTRAINT "voice_call_events_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "public"."voice_calls"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."voice_callbacks"
    ADD CONSTRAINT "voice_callbacks_assigned_extension_id_fkey" FOREIGN KEY ("assigned_extension_id") REFERENCES "public"."voice_extensions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."voice_callbacks"
    ADD CONSTRAINT "voice_callbacks_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "public"."voice_calls"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."voice_callbacks"
    ADD CONSTRAINT "voice_callbacks_queue_id_fkey" FOREIGN KEY ("queue_id") REFERENCES "public"."voice_queues"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."voice_calls"
    ADD CONSTRAINT "voice_calls_extension_id_fkey" FOREIGN KEY ("extension_id") REFERENCES "public"."voice_extensions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."voice_extensions"
    ADD CONSTRAINT "voice_extensions_direct_number_fk" FOREIGN KEY ("direct_number_id") REFERENCES "public"."voice_numbers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."voice_known_numbers"
    ADD CONSTRAINT "voice_known_numbers_jobber_client_id_fkey" FOREIGN KEY ("jobber_client_id") REFERENCES "public"."clients"("jobber_id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."voice_numbers"
    ADD CONSTRAINT "voice_numbers_assigned_extension_id_fkey" FOREIGN KEY ("assigned_extension_id") REFERENCES "public"."voice_extensions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."voice_queue_members"
    ADD CONSTRAINT "voice_queue_members_extension_id_fkey" FOREIGN KEY ("extension_id") REFERENCES "public"."voice_extensions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."voice_queue_members"
    ADD CONSTRAINT "voice_queue_members_queue_id_fkey" FOREIGN KEY ("queue_id") REFERENCES "public"."voice_queues"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."voice_queues"
    ADD CONSTRAINT "voice_queues_overflow_extension_id_fkey" FOREIGN KEY ("overflow_extension_id") REFERENCES "public"."voice_extensions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."voice_voicemails"
    ADD CONSTRAINT "voice_voicemails_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "public"."voice_calls"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."voice_voicemails"
    ADD CONSTRAINT "voice_voicemails_extension_id_fkey" FOREIGN KEY ("extension_id") REFERENCES "public"."voice_extensions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."workforce_daily_summaries"
    ADD CONSTRAINT "workforce_daily_summaries_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."workforce_time_sessions"
    ADD CONSTRAINT "workforce_time_sessions_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."profiles"("id");



ALTER TABLE "public"."annotations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."authnet_payment_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."automation_agent_credentials" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."automation_agent_permissions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."automation_agents" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."automation_enrollment_codes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."automation_task_approvals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."automation_task_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."automation_tasks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."bookkeeping_audit_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."bookkeeping_catalog_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."bookkeeping_contractor_profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."bookkeeping_evidence_documents" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."bookkeeping_expenses" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."bookkeeping_reina_learning" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."bookkeeping_sales_tax_entries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."bridge_heartbeats" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."business_functions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."campaign_activity_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."campaign_recipients" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."campaign_variants" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."campaigns" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."change_orders" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."client_approvals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."client_audit_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."client_auth_links" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."client_locations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."client_messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."client_notifications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."client_payments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."client_photo_shares" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."client_sessions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."clients" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."co_counters" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."companies" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."contracts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."documents" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "documents: admins can delete" ON "public"."documents" FOR DELETE TO "authenticated" USING ("public"."is_admin"());



CREATE POLICY "documents: authenticated can insert" ON "public"."documents" FOR INSERT TO "authenticated" WITH CHECK (("uploaded_by" = "auth"."uid"()));



CREATE POLICY "documents: read gated by sensitivity and folder" ON "public"."documents" FOR SELECT TO "authenticated" USING (((("sensitive" = false) OR "public"."is_admin"()) AND "public"."can_see_folder"("folder_id")));



CREATE POLICY "documents: update own or admin" ON "public"."documents" FOR UPDATE TO "authenticated" USING ((("uploaded_by" = "auth"."uid"()) OR "public"."is_admin"())) WITH CHECK ((("uploaded_by" = "auth"."uid"()) OR "public"."is_admin"()));



ALTER TABLE "public"."employee_roles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."est_counters" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."estimates" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."expenses" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."external_refs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."field_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."folder_access" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "folder_access: read own grants, or as admin/manager" ON "public"."folder_access" FOR SELECT TO "authenticated" USING ((("user_id" = "auth"."uid"()) OR "public"."is_admin"() OR (EXISTS ( SELECT 1
   FROM "public"."folders" "f"
  WHERE (("f"."id" = "folder_access"."folder_id") AND ("f"."created_by" = "auth"."uid"()))))));



CREATE POLICY "folder_access: share by admin or folder creator" ON "public"."folder_access" FOR INSERT TO "authenticated" WITH CHECK (("public"."is_admin"() OR (EXISTS ( SELECT 1
   FROM "public"."folders" "f"
  WHERE (("f"."id" = "folder_access"."folder_id") AND ("f"."created_by" = "auth"."uid"()))))));



CREATE POLICY "folder_access: unshare by admin or folder creator" ON "public"."folder_access" FOR DELETE TO "authenticated" USING (("public"."is_admin"() OR (EXISTS ( SELECT 1
   FROM "public"."folders" "f"
  WHERE (("f"."id" = "folder_access"."folder_id") AND ("f"."created_by" = "auth"."uid"()))))));



ALTER TABLE "public"."folders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "folders: delete if admin or creator" ON "public"."folders" FOR DELETE TO "authenticated" USING (("public"."is_admin"() OR ("created_by" = "auth"."uid"())));



CREATE POLICY "folders: insert if admin or has access to parent" ON "public"."folders" FOR INSERT TO "authenticated" WITH CHECK ((("created_by" = "auth"."uid"()) AND ("public"."is_admin"() OR (("parent_id" IS NOT NULL) AND "public"."can_access_folder"("parent_id")))));



CREATE POLICY "folders: select if can see" ON "public"."folders" FOR SELECT TO "authenticated" USING ("public"."can_see_folder"("id"));



CREATE POLICY "folders: update if admin, creator, or has access" ON "public"."folders" FOR UPDATE TO "authenticated" USING (("public"."is_admin"() OR ("created_by" = "auth"."uid"()) OR "public"."can_access_folder"("id"))) WITH CHECK (("public"."is_admin"() OR ("created_by" = "auth"."uid"()) OR "public"."can_access_folder"("id")));



ALTER TABLE "public"."function_assignments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."hc_mailbox_links" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."hc_ms_tokens" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."hiveconnect_account_map" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."integrations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."invoices" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."job_signatures" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."job_time_entries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."job_workflow" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."jobs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lead_alerts_sent" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lead_pipeline" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ledger_systems" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."marketing_annotations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."marketing_approvals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."marketing_budget_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."marketing_channel_budgets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."marketing_consent_ledger" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."marketing_generated_assets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."marketing_media_assets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."marketing_opportunities" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."marketing_plan_assumptions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."marketing_plans" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."marketing_platform_connections" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."marketing_publications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."marketing_source_evidence" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."marketing_suppressions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."media" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."media_analysis" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."media_comments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."media_entity_links" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."media_tags" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."monitor_activity_samples" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."monitor_agents" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."monitor_pair_attempts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."monitor_screenshots" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."monitor_sessions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."oauth_states" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."office_location" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."org_units" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "own mailbox links only" ON "public"."hc_mailbox_links" USING (("auth"."uid"() = "owner_id")) WITH CHECK (("auth"."uid"() = "owner_id"));



ALTER TABLE "public"."payroll_period_costs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."po_counters" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."po_seen_bills" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."portal_rate_limits" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."product_nicknames" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."product_snapshots" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."products" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles: admins can update" ON "public"."profiles" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text")))));



CREATE POLICY "profiles: read for all authenticated" ON "public"."profiles" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."purchase_orders" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."qbo_report_cache" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."quotes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."regulated_category_rules" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."reina_todo" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."review_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."schedule_writeback_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "service role full access" ON "public"."voice_call_flows" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service role full access campaign_recipients" ON "public"."campaign_recipients" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service role full access campaign_variants" ON "public"."campaign_variants" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service role full access campaigns" ON "public"."campaigns" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service role full access marketing_annotations" ON "public"."marketing_annotations" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service role full access marketing_approvals" ON "public"."marketing_approvals" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service role full access marketing_budget_settings" ON "public"."marketing_budget_settings" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service role full access marketing_channel_budgets" ON "public"."marketing_channel_budgets" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service role full access marketing_consent_ledger" ON "public"."marketing_consent_ledger" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service role full access marketing_generated_assets" ON "public"."marketing_generated_assets" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service role full access marketing_media_assets" ON "public"."marketing_media_assets" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service role full access marketing_opportunities" ON "public"."marketing_opportunities" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service role full access marketing_plan_assumptions" ON "public"."marketing_plan_assumptions" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service role full access marketing_plans" ON "public"."marketing_plans" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service role full access marketing_platform_connections" ON "public"."marketing_platform_connections" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service role full access marketing_publications" ON "public"."marketing_publications" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service role full access marketing_source_evidence" ON "public"."marketing_source_evidence" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "service role full access marketing_suppressions" ON "public"."marketing_suppressions" USING (("auth"."role"() = 'service_role'::"text")) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."sub_audit_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sub_auth_links" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sub_banking" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sub_documents" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sub_invoices" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sub_messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sub_notifications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sub_rfis" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sub_rfqs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sub_schedule_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sub_sessions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."subcontractors" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."subs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."subscriptions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sync_cursors" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sync_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tags" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."takeoffs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."time_sheet_entries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."timeline_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tm_invoices" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tm_rate_types" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."travel_sessions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."users" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."vehicles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."vendor_offers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."vendors" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."visits" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."voice_blocked_numbers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."voice_call_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."voice_call_flows" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."voice_calls" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."voice_extensions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."voice_greetings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."voice_known_numbers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."voice_messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."voice_numbers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."voice_schedules" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."voice_voicemails" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."webhook_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."workforce_daily_summaries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."workforce_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."workforce_time_sessions" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";






ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."voice_agent_status";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."voice_callbacks";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."voice_calls";



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";






















































































































































GRANT ALL ON FUNCTION "public"."allocate_co_number"("p_company_id" "text", "p_job_id" "text", "p_company_code" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."allocate_co_number"("p_company_id" "text", "p_job_id" "text", "p_company_code" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."allocate_co_number"("p_company_id" "text", "p_job_id" "text", "p_company_code" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."allocate_estimate_number"("p_company_id" "text", "p_company_code" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."allocate_estimate_number"("p_company_id" "text", "p_company_code" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."allocate_estimate_number"("p_company_id" "text", "p_company_code" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."allocate_po_number"("p_company_id" "text", "p_scope_key" "text", "p_job_id" "text", "p_company_code" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."allocate_po_number"("p_company_id" "text", "p_scope_key" "text", "p_job_id" "text", "p_company_code" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."allocate_po_number"("p_company_id" "text", "p_scope_key" "text", "p_job_id" "text", "p_company_code" "text") TO "service_role";



GRANT ALL ON TABLE "public"."purchase_orders" TO "anon";
GRANT ALL ON TABLE "public"."purchase_orders" TO "authenticated";
GRANT ALL ON TABLE "public"."purchase_orders" TO "service_role";



GRANT ALL ON FUNCTION "public"."apply_po_batch_update"("p_updates" "jsonb", "p_seen_bill" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."apply_po_batch_update"("p_updates" "jsonb", "p_seen_bill" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."apply_po_batch_update"("p_updates" "jsonb", "p_seen_bill" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."apply_sensitive_default"() TO "anon";
GRANT ALL ON FUNCTION "public"."apply_sensitive_default"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."apply_sensitive_default"() TO "service_role";



GRANT ALL ON FUNCTION "public"."bookkeeping_audit_log_immutable"() TO "anon";
GRANT ALL ON FUNCTION "public"."bookkeeping_audit_log_immutable"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."bookkeeping_audit_log_immutable"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."can_access_folder"("target" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."can_access_folder"("target" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."can_access_folder"("target" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."can_see_folder"("target" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."can_see_folder"("target" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."can_see_folder"("target" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."handle_new_user"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_admin"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "service_role";



GRANT ALL ON FUNCTION "public"."protect_locked_geocode"() TO "anon";
GRANT ALL ON FUNCTION "public"."protect_locked_geocode"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."protect_locked_geocode"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."prune_monitor_data"("retention_days" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."prune_monitor_data"("retention_days" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."prune_monitor_data"("retention_days" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."prune_monitor_data"("retention_days" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."prune_oauth_states"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."prune_oauth_states"() TO "anon";
GRANT ALL ON FUNCTION "public"."prune_oauth_states"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."prune_oauth_states"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."prune_portal_rate_limits"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."prune_portal_rate_limits"() TO "anon";
GRANT ALL ON FUNCTION "public"."prune_portal_rate_limits"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."prune_portal_rate_limits"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."snapshot_aggregates"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."snapshot_aggregates"() TO "service_role";


















GRANT ALL ON TABLE "public"."annotations" TO "anon";
GRANT ALL ON TABLE "public"."annotations" TO "authenticated";
GRANT ALL ON TABLE "public"."annotations" TO "service_role";



GRANT ALL ON TABLE "public"."invoices" TO "anon";
GRANT ALL ON TABLE "public"."invoices" TO "authenticated";
GRANT ALL ON TABLE "public"."invoices" TO "service_role";



GRANT ALL ON TABLE "public"."invoice_balances" TO "service_role";



GRANT ALL ON TABLE "public"."ar_aging" TO "service_role";



GRANT ALL ON TABLE "public"."authnet_payment_events" TO "anon";
GRANT ALL ON TABLE "public"."authnet_payment_events" TO "authenticated";
GRANT ALL ON TABLE "public"."authnet_payment_events" TO "service_role";



GRANT ALL ON SEQUENCE "public"."authnet_payment_events_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."authnet_payment_events_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."authnet_payment_events_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."automation_agent_credentials" TO "anon";
GRANT ALL ON TABLE "public"."automation_agent_credentials" TO "authenticated";
GRANT ALL ON TABLE "public"."automation_agent_credentials" TO "service_role";



GRANT ALL ON TABLE "public"."automation_agent_permissions" TO "anon";
GRANT ALL ON TABLE "public"."automation_agent_permissions" TO "authenticated";
GRANT ALL ON TABLE "public"."automation_agent_permissions" TO "service_role";



GRANT ALL ON TABLE "public"."automation_agents" TO "anon";
GRANT ALL ON TABLE "public"."automation_agents" TO "authenticated";
GRANT ALL ON TABLE "public"."automation_agents" TO "service_role";



GRANT ALL ON TABLE "public"."automation_enrollment_codes" TO "anon";
GRANT ALL ON TABLE "public"."automation_enrollment_codes" TO "authenticated";
GRANT ALL ON TABLE "public"."automation_enrollment_codes" TO "service_role";



GRANT ALL ON TABLE "public"."automation_task_approvals" TO "anon";
GRANT ALL ON TABLE "public"."automation_task_approvals" TO "authenticated";
GRANT ALL ON TABLE "public"."automation_task_approvals" TO "service_role";



GRANT ALL ON TABLE "public"."automation_task_events" TO "anon";
GRANT ALL ON TABLE "public"."automation_task_events" TO "authenticated";
GRANT ALL ON TABLE "public"."automation_task_events" TO "service_role";



GRANT ALL ON SEQUENCE "public"."automation_task_events_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."automation_task_events_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."automation_task_events_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."automation_tasks" TO "anon";
GRANT ALL ON TABLE "public"."automation_tasks" TO "authenticated";
GRANT ALL ON TABLE "public"."automation_tasks" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."bookkeeping_audit_log" TO "anon";
GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."bookkeeping_audit_log" TO "authenticated";
GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."bookkeeping_audit_log" TO "service_role";



GRANT ALL ON TABLE "public"."bookkeeping_catalog_items" TO "anon";
GRANT ALL ON TABLE "public"."bookkeeping_catalog_items" TO "authenticated";
GRANT ALL ON TABLE "public"."bookkeeping_catalog_items" TO "service_role";



GRANT ALL ON TABLE "public"."bookkeeping_contractor_profiles" TO "anon";
GRANT ALL ON TABLE "public"."bookkeeping_contractor_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."bookkeeping_contractor_profiles" TO "service_role";



GRANT ALL ON TABLE "public"."bookkeeping_evidence_documents" TO "anon";
GRANT ALL ON TABLE "public"."bookkeeping_evidence_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."bookkeeping_evidence_documents" TO "service_role";



GRANT ALL ON TABLE "public"."bookkeeping_expenses" TO "anon";
GRANT ALL ON TABLE "public"."bookkeeping_expenses" TO "authenticated";
GRANT ALL ON TABLE "public"."bookkeeping_expenses" TO "service_role";



GRANT ALL ON TABLE "public"."bookkeeping_reina_learning" TO "anon";
GRANT ALL ON TABLE "public"."bookkeeping_reina_learning" TO "authenticated";
GRANT ALL ON TABLE "public"."bookkeeping_reina_learning" TO "service_role";



GRANT ALL ON TABLE "public"."bookkeeping_sales_tax_entries" TO "anon";
GRANT ALL ON TABLE "public"."bookkeeping_sales_tax_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."bookkeeping_sales_tax_entries" TO "service_role";



GRANT ALL ON TABLE "public"."bridge_heartbeats" TO "anon";
GRANT ALL ON TABLE "public"."bridge_heartbeats" TO "authenticated";
GRANT ALL ON TABLE "public"."bridge_heartbeats" TO "service_role";



GRANT ALL ON SEQUENCE "public"."bridge_heartbeats_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."bridge_heartbeats_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."bridge_heartbeats_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."business_functions" TO "service_role";



GRANT ALL ON TABLE "public"."campaign_activity_log" TO "anon";
GRANT ALL ON TABLE "public"."campaign_activity_log" TO "authenticated";
GRANT ALL ON TABLE "public"."campaign_activity_log" TO "service_role";



GRANT ALL ON TABLE "public"."campaign_recipients" TO "anon";
GRANT ALL ON TABLE "public"."campaign_recipients" TO "authenticated";
GRANT ALL ON TABLE "public"."campaign_recipients" TO "service_role";



GRANT ALL ON TABLE "public"."campaign_variants" TO "anon";
GRANT ALL ON TABLE "public"."campaign_variants" TO "authenticated";
GRANT ALL ON TABLE "public"."campaign_variants" TO "service_role";



GRANT ALL ON TABLE "public"."campaigns" TO "anon";
GRANT ALL ON TABLE "public"."campaigns" TO "authenticated";
GRANT ALL ON TABLE "public"."campaigns" TO "service_role";



GRANT ALL ON TABLE "public"."change_orders" TO "anon";
GRANT ALL ON TABLE "public"."change_orders" TO "authenticated";
GRANT ALL ON TABLE "public"."change_orders" TO "service_role";



GRANT ALL ON TABLE "public"."client_approvals" TO "anon";
GRANT ALL ON TABLE "public"."client_approvals" TO "authenticated";
GRANT ALL ON TABLE "public"."client_approvals" TO "service_role";



GRANT ALL ON TABLE "public"."clients" TO "anon";
GRANT ALL ON TABLE "public"."clients" TO "authenticated";
GRANT ALL ON TABLE "public"."clients" TO "service_role";



GRANT ALL ON TABLE "public"."client_ar_outstanding" TO "service_role";



GRANT ALL ON TABLE "public"."client_audit_log" TO "anon";
GRANT ALL ON TABLE "public"."client_audit_log" TO "authenticated";
GRANT ALL ON TABLE "public"."client_audit_log" TO "service_role";



GRANT ALL ON TABLE "public"."client_auth_links" TO "anon";
GRANT ALL ON TABLE "public"."client_auth_links" TO "authenticated";
GRANT ALL ON TABLE "public"."client_auth_links" TO "service_role";



GRANT ALL ON TABLE "public"."client_locations" TO "anon";
GRANT ALL ON TABLE "public"."client_locations" TO "authenticated";
GRANT ALL ON TABLE "public"."client_locations" TO "service_role";



GRANT ALL ON TABLE "public"."client_messages" TO "anon";
GRANT ALL ON TABLE "public"."client_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."client_messages" TO "service_role";



GRANT ALL ON TABLE "public"."client_notifications" TO "anon";
GRANT ALL ON TABLE "public"."client_notifications" TO "authenticated";
GRANT ALL ON TABLE "public"."client_notifications" TO "service_role";



GRANT ALL ON TABLE "public"."client_payments" TO "anon";
GRANT ALL ON TABLE "public"."client_payments" TO "authenticated";
GRANT ALL ON TABLE "public"."client_payments" TO "service_role";



GRANT ALL ON TABLE "public"."client_photo_shares" TO "anon";
GRANT ALL ON TABLE "public"."client_photo_shares" TO "authenticated";
GRANT ALL ON TABLE "public"."client_photo_shares" TO "service_role";



GRANT ALL ON TABLE "public"."client_sessions" TO "anon";
GRANT ALL ON TABLE "public"."client_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."client_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."co_counters" TO "anon";
GRANT ALL ON TABLE "public"."co_counters" TO "authenticated";
GRANT ALL ON TABLE "public"."co_counters" TO "service_role";



GRANT ALL ON TABLE "public"."companies" TO "service_role";



GRANT ALL ON TABLE "public"."contracts" TO "service_role";



GRANT ALL ON TABLE "public"."documents" TO "anon";
GRANT ALL ON TABLE "public"."documents" TO "authenticated";
GRANT ALL ON TABLE "public"."documents" TO "service_role";



GRANT ALL ON TABLE "public"."employee_roles" TO "anon";
GRANT ALL ON TABLE "public"."employee_roles" TO "authenticated";
GRANT ALL ON TABLE "public"."employee_roles" TO "service_role";



GRANT ALL ON TABLE "public"."est_counters" TO "anon";
GRANT ALL ON TABLE "public"."est_counters" TO "authenticated";
GRANT ALL ON TABLE "public"."est_counters" TO "service_role";



GRANT ALL ON TABLE "public"."estimates" TO "anon";
GRANT ALL ON TABLE "public"."estimates" TO "authenticated";
GRANT ALL ON TABLE "public"."estimates" TO "service_role";



GRANT ALL ON TABLE "public"."expenses" TO "anon";
GRANT ALL ON TABLE "public"."expenses" TO "authenticated";
GRANT ALL ON TABLE "public"."expenses" TO "service_role";



GRANT ALL ON TABLE "public"."external_refs" TO "service_role";



GRANT ALL ON TABLE "public"."field_requests" TO "anon";
GRANT ALL ON TABLE "public"."field_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."field_requests" TO "service_role";



GRANT ALL ON TABLE "public"."folder_access" TO "anon";
GRANT ALL ON TABLE "public"."folder_access" TO "authenticated";
GRANT ALL ON TABLE "public"."folder_access" TO "service_role";



GRANT ALL ON TABLE "public"."folders" TO "anon";
GRANT ALL ON TABLE "public"."folders" TO "authenticated";
GRANT ALL ON TABLE "public"."folders" TO "service_role";



GRANT ALL ON TABLE "public"."function_assignments" TO "service_role";



GRANT ALL ON TABLE "public"."hc_mailbox_links" TO "anon";
GRANT ALL ON TABLE "public"."hc_mailbox_links" TO "authenticated";
GRANT ALL ON TABLE "public"."hc_mailbox_links" TO "service_role";



GRANT ALL ON TABLE "public"."hc_ms_tokens" TO "anon";
GRANT ALL ON TABLE "public"."hc_ms_tokens" TO "authenticated";
GRANT ALL ON TABLE "public"."hc_ms_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."hiveconnect_account_map" TO "anon";
GRANT ALL ON TABLE "public"."hiveconnect_account_map" TO "authenticated";
GRANT ALL ON TABLE "public"."hiveconnect_account_map" TO "service_role";



GRANT ALL ON TABLE "public"."integrations" TO "anon";
GRANT ALL ON TABLE "public"."integrations" TO "authenticated";
GRANT ALL ON TABLE "public"."integrations" TO "service_role";



GRANT ALL ON TABLE "public"."job_signatures" TO "anon";
GRANT ALL ON TABLE "public"."job_signatures" TO "authenticated";
GRANT ALL ON TABLE "public"."job_signatures" TO "service_role";



GRANT ALL ON TABLE "public"."job_time_entries" TO "anon";
GRANT ALL ON TABLE "public"."job_time_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."job_time_entries" TO "service_role";



GRANT ALL ON TABLE "public"."job_workflow" TO "anon";
GRANT ALL ON TABLE "public"."job_workflow" TO "authenticated";
GRANT ALL ON TABLE "public"."job_workflow" TO "service_role";



GRANT ALL ON TABLE "public"."jobs" TO "anon";
GRANT ALL ON TABLE "public"."jobs" TO "authenticated";
GRANT ALL ON TABLE "public"."jobs" TO "service_role";



GRANT ALL ON TABLE "public"."jobs_enriched" TO "service_role";



GRANT ALL ON TABLE "public"."lead_alerts_sent" TO "anon";
GRANT ALL ON TABLE "public"."lead_alerts_sent" TO "authenticated";
GRANT ALL ON TABLE "public"."lead_alerts_sent" TO "service_role";



GRANT ALL ON SEQUENCE "public"."lead_alerts_sent_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."lead_alerts_sent_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."lead_alerts_sent_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."lead_pipeline" TO "anon";
GRANT ALL ON TABLE "public"."lead_pipeline" TO "authenticated";
GRANT ALL ON TABLE "public"."lead_pipeline" TO "service_role";



GRANT ALL ON TABLE "public"."ledger_systems" TO "anon";
GRANT ALL ON TABLE "public"."ledger_systems" TO "authenticated";
GRANT ALL ON TABLE "public"."ledger_systems" TO "service_role";



GRANT ALL ON TABLE "public"."marketing_annotations" TO "anon";
GRANT ALL ON TABLE "public"."marketing_annotations" TO "authenticated";
GRANT ALL ON TABLE "public"."marketing_annotations" TO "service_role";



GRANT ALL ON TABLE "public"."marketing_approvals" TO "anon";
GRANT ALL ON TABLE "public"."marketing_approvals" TO "authenticated";
GRANT ALL ON TABLE "public"."marketing_approvals" TO "service_role";



GRANT ALL ON TABLE "public"."marketing_budget_settings" TO "anon";
GRANT ALL ON TABLE "public"."marketing_budget_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."marketing_budget_settings" TO "service_role";



GRANT ALL ON TABLE "public"."marketing_channel_budgets" TO "anon";
GRANT ALL ON TABLE "public"."marketing_channel_budgets" TO "authenticated";
GRANT ALL ON TABLE "public"."marketing_channel_budgets" TO "service_role";



GRANT ALL ON TABLE "public"."marketing_consent_ledger" TO "anon";
GRANT ALL ON TABLE "public"."marketing_consent_ledger" TO "authenticated";
GRANT ALL ON TABLE "public"."marketing_consent_ledger" TO "service_role";



GRANT ALL ON TABLE "public"."marketing_generated_assets" TO "anon";
GRANT ALL ON TABLE "public"."marketing_generated_assets" TO "authenticated";
GRANT ALL ON TABLE "public"."marketing_generated_assets" TO "service_role";



GRANT ALL ON TABLE "public"."marketing_media_assets" TO "anon";
GRANT ALL ON TABLE "public"."marketing_media_assets" TO "authenticated";
GRANT ALL ON TABLE "public"."marketing_media_assets" TO "service_role";



GRANT ALL ON TABLE "public"."marketing_opportunities" TO "anon";
GRANT ALL ON TABLE "public"."marketing_opportunities" TO "authenticated";
GRANT ALL ON TABLE "public"."marketing_opportunities" TO "service_role";



GRANT ALL ON TABLE "public"."marketing_plan_assumptions" TO "anon";
GRANT ALL ON TABLE "public"."marketing_plan_assumptions" TO "authenticated";
GRANT ALL ON TABLE "public"."marketing_plan_assumptions" TO "service_role";



GRANT ALL ON TABLE "public"."marketing_plans" TO "anon";
GRANT ALL ON TABLE "public"."marketing_plans" TO "authenticated";
GRANT ALL ON TABLE "public"."marketing_plans" TO "service_role";



GRANT ALL ON TABLE "public"."marketing_platform_connections" TO "anon";
GRANT ALL ON TABLE "public"."marketing_platform_connections" TO "authenticated";
GRANT ALL ON TABLE "public"."marketing_platform_connections" TO "service_role";



GRANT ALL ON TABLE "public"."marketing_publications" TO "anon";
GRANT ALL ON TABLE "public"."marketing_publications" TO "authenticated";
GRANT ALL ON TABLE "public"."marketing_publications" TO "service_role";



GRANT ALL ON TABLE "public"."marketing_source_evidence" TO "anon";
GRANT ALL ON TABLE "public"."marketing_source_evidence" TO "authenticated";
GRANT ALL ON TABLE "public"."marketing_source_evidence" TO "service_role";



GRANT ALL ON TABLE "public"."marketing_suppressions" TO "anon";
GRANT ALL ON TABLE "public"."marketing_suppressions" TO "authenticated";
GRANT ALL ON TABLE "public"."marketing_suppressions" TO "service_role";



GRANT ALL ON TABLE "public"."media" TO "anon";
GRANT ALL ON TABLE "public"."media" TO "authenticated";
GRANT ALL ON TABLE "public"."media" TO "service_role";



GRANT ALL ON TABLE "public"."media_analysis" TO "anon";
GRANT ALL ON TABLE "public"."media_analysis" TO "authenticated";
GRANT ALL ON TABLE "public"."media_analysis" TO "service_role";



GRANT ALL ON TABLE "public"."media_comments" TO "anon";
GRANT ALL ON TABLE "public"."media_comments" TO "authenticated";
GRANT ALL ON TABLE "public"."media_comments" TO "service_role";



GRANT ALL ON TABLE "public"."media_entity_links" TO "anon";
GRANT ALL ON TABLE "public"."media_entity_links" TO "authenticated";
GRANT ALL ON TABLE "public"."media_entity_links" TO "service_role";



GRANT ALL ON TABLE "public"."media_tags" TO "anon";
GRANT ALL ON TABLE "public"."media_tags" TO "authenticated";
GRANT ALL ON TABLE "public"."media_tags" TO "service_role";



GRANT ALL ON TABLE "public"."monitor_activity_samples" TO "anon";
GRANT ALL ON TABLE "public"."monitor_activity_samples" TO "authenticated";
GRANT ALL ON TABLE "public"."monitor_activity_samples" TO "service_role";



GRANT ALL ON TABLE "public"."monitor_agents" TO "anon";
GRANT ALL ON TABLE "public"."monitor_agents" TO "authenticated";
GRANT ALL ON TABLE "public"."monitor_agents" TO "service_role";



GRANT ALL ON TABLE "public"."monitor_pair_attempts" TO "anon";
GRANT ALL ON TABLE "public"."monitor_pair_attempts" TO "authenticated";
GRANT ALL ON TABLE "public"."monitor_pair_attempts" TO "service_role";



GRANT ALL ON TABLE "public"."monitor_screenshots" TO "anon";
GRANT ALL ON TABLE "public"."monitor_screenshots" TO "authenticated";
GRANT ALL ON TABLE "public"."monitor_screenshots" TO "service_role";



GRANT ALL ON TABLE "public"."monitor_sessions" TO "anon";
GRANT ALL ON TABLE "public"."monitor_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."monitor_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."oauth_states" TO "anon";
GRANT ALL ON TABLE "public"."oauth_states" TO "authenticated";
GRANT ALL ON TABLE "public"."oauth_states" TO "service_role";



GRANT ALL ON SEQUENCE "public"."oauth_states_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."oauth_states_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."oauth_states_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."office_location" TO "anon";
GRANT ALL ON TABLE "public"."office_location" TO "authenticated";
GRANT ALL ON TABLE "public"."office_location" TO "service_role";



GRANT ALL ON TABLE "public"."org_units" TO "service_role";



GRANT ALL ON TABLE "public"."payroll_period_costs" TO "service_role";



GRANT ALL ON TABLE "public"."po_counters" TO "anon";
GRANT ALL ON TABLE "public"."po_counters" TO "authenticated";
GRANT ALL ON TABLE "public"."po_counters" TO "service_role";



GRANT ALL ON TABLE "public"."po_seen_bills" TO "anon";
GRANT ALL ON TABLE "public"."po_seen_bills" TO "authenticated";
GRANT ALL ON TABLE "public"."po_seen_bills" TO "service_role";



GRANT ALL ON TABLE "public"."portal_rate_limits" TO "anon";
GRANT ALL ON TABLE "public"."portal_rate_limits" TO "authenticated";
GRANT ALL ON TABLE "public"."portal_rate_limits" TO "service_role";



GRANT ALL ON SEQUENCE "public"."portal_rate_limits_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."portal_rate_limits_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."portal_rate_limits_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."product_nicknames" TO "anon";
GRANT ALL ON TABLE "public"."product_nicknames" TO "authenticated";
GRANT ALL ON TABLE "public"."product_nicknames" TO "service_role";



GRANT ALL ON TABLE "public"."product_snapshots" TO "anon";
GRANT ALL ON TABLE "public"."product_snapshots" TO "authenticated";
GRANT ALL ON TABLE "public"."product_snapshots" TO "service_role";



GRANT ALL ON TABLE "public"."products" TO "anon";
GRANT ALL ON TABLE "public"."products" TO "authenticated";
GRANT ALL ON TABLE "public"."products" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."qbo_report_cache" TO "service_role";



GRANT ALL ON TABLE "public"."quotes" TO "anon";
GRANT ALL ON TABLE "public"."quotes" TO "authenticated";
GRANT ALL ON TABLE "public"."quotes" TO "service_role";



GRANT ALL ON TABLE "public"."regulated_category_rules" TO "anon";
GRANT ALL ON TABLE "public"."regulated_category_rules" TO "authenticated";
GRANT ALL ON TABLE "public"."regulated_category_rules" TO "service_role";



GRANT ALL ON TABLE "public"."reina_todo" TO "anon";
GRANT ALL ON TABLE "public"."reina_todo" TO "authenticated";
GRANT ALL ON TABLE "public"."reina_todo" TO "service_role";



GRANT ALL ON TABLE "public"."requests" TO "anon";
GRANT ALL ON TABLE "public"."requests" TO "authenticated";
GRANT ALL ON TABLE "public"."requests" TO "service_role";



GRANT ALL ON TABLE "public"."review_requests" TO "anon";
GRANT ALL ON TABLE "public"."review_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."review_requests" TO "service_role";



GRANT ALL ON TABLE "public"."schedule_writeback_log" TO "anon";
GRANT ALL ON TABLE "public"."schedule_writeback_log" TO "authenticated";
GRANT ALL ON TABLE "public"."schedule_writeback_log" TO "service_role";



GRANT ALL ON TABLE "public"."selftest_reports" TO "anon";
GRANT ALL ON TABLE "public"."selftest_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."selftest_reports" TO "service_role";



GRANT ALL ON TABLE "public"."sub_audit_log" TO "anon";
GRANT ALL ON TABLE "public"."sub_audit_log" TO "authenticated";
GRANT ALL ON TABLE "public"."sub_audit_log" TO "service_role";



GRANT ALL ON TABLE "public"."sub_auth_links" TO "anon";
GRANT ALL ON TABLE "public"."sub_auth_links" TO "authenticated";
GRANT ALL ON TABLE "public"."sub_auth_links" TO "service_role";



GRANT ALL ON TABLE "public"."sub_banking" TO "anon";
GRANT ALL ON TABLE "public"."sub_banking" TO "authenticated";
GRANT ALL ON TABLE "public"."sub_banking" TO "service_role";



GRANT ALL ON TABLE "public"."sub_documents" TO "anon";
GRANT ALL ON TABLE "public"."sub_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."sub_documents" TO "service_role";



GRANT ALL ON TABLE "public"."sub_invoices" TO "anon";
GRANT ALL ON TABLE "public"."sub_invoices" TO "authenticated";
GRANT ALL ON TABLE "public"."sub_invoices" TO "service_role";



GRANT ALL ON TABLE "public"."sub_messages" TO "anon";
GRANT ALL ON TABLE "public"."sub_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."sub_messages" TO "service_role";



GRANT ALL ON TABLE "public"."sub_notifications" TO "anon";
GRANT ALL ON TABLE "public"."sub_notifications" TO "authenticated";
GRANT ALL ON TABLE "public"."sub_notifications" TO "service_role";



GRANT ALL ON TABLE "public"."sub_rfis" TO "anon";
GRANT ALL ON TABLE "public"."sub_rfis" TO "authenticated";
GRANT ALL ON TABLE "public"."sub_rfis" TO "service_role";



GRANT ALL ON TABLE "public"."sub_rfqs" TO "anon";
GRANT ALL ON TABLE "public"."sub_rfqs" TO "authenticated";
GRANT ALL ON TABLE "public"."sub_rfqs" TO "service_role";



GRANT ALL ON TABLE "public"."sub_schedule_items" TO "anon";
GRANT ALL ON TABLE "public"."sub_schedule_items" TO "authenticated";
GRANT ALL ON TABLE "public"."sub_schedule_items" TO "service_role";



GRANT ALL ON TABLE "public"."sub_sessions" TO "anon";
GRANT ALL ON TABLE "public"."sub_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."sub_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."subcontractors" TO "anon";
GRANT ALL ON TABLE "public"."subcontractors" TO "authenticated";
GRANT ALL ON TABLE "public"."subcontractors" TO "service_role";



GRANT ALL ON TABLE "public"."subs" TO "anon";
GRANT ALL ON TABLE "public"."subs" TO "authenticated";
GRANT ALL ON TABLE "public"."subs" TO "service_role";



GRANT ALL ON TABLE "public"."subscriptions" TO "service_role";



GRANT ALL ON TABLE "public"."sync_cursors" TO "anon";
GRANT ALL ON TABLE "public"."sync_cursors" TO "authenticated";
GRANT ALL ON TABLE "public"."sync_cursors" TO "service_role";



GRANT ALL ON TABLE "public"."sync_log" TO "anon";
GRANT ALL ON TABLE "public"."sync_log" TO "authenticated";
GRANT ALL ON TABLE "public"."sync_log" TO "service_role";



GRANT ALL ON SEQUENCE "public"."sync_log_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."sync_log_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."sync_log_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."tags" TO "anon";
GRANT ALL ON TABLE "public"."tags" TO "authenticated";
GRANT ALL ON TABLE "public"."tags" TO "service_role";



GRANT ALL ON TABLE "public"."takeoffs" TO "anon";
GRANT ALL ON TABLE "public"."takeoffs" TO "authenticated";
GRANT ALL ON TABLE "public"."takeoffs" TO "service_role";



GRANT ALL ON TABLE "public"."time_sheet_entries" TO "anon";
GRANT ALL ON TABLE "public"."time_sheet_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."time_sheet_entries" TO "service_role";



GRANT ALL ON TABLE "public"."timeline_events" TO "anon";
GRANT ALL ON TABLE "public"."timeline_events" TO "authenticated";
GRANT ALL ON TABLE "public"."timeline_events" TO "service_role";



GRANT ALL ON TABLE "public"."tm_invoices" TO "anon";
GRANT ALL ON TABLE "public"."tm_invoices" TO "authenticated";
GRANT ALL ON TABLE "public"."tm_invoices" TO "service_role";



GRANT ALL ON TABLE "public"."tm_rate_types" TO "anon";
GRANT ALL ON TABLE "public"."tm_rate_types" TO "authenticated";
GRANT ALL ON TABLE "public"."tm_rate_types" TO "service_role";



GRANT ALL ON TABLE "public"."travel_sessions" TO "anon";
GRANT ALL ON TABLE "public"."travel_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."travel_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."users" TO "anon";
GRANT ALL ON TABLE "public"."users" TO "authenticated";
GRANT ALL ON TABLE "public"."users" TO "service_role";



GRANT ALL ON TABLE "public"."vehicles" TO "anon";
GRANT ALL ON TABLE "public"."vehicles" TO "authenticated";
GRANT ALL ON TABLE "public"."vehicles" TO "service_role";



GRANT ALL ON TABLE "public"."vendor_offers" TO "anon";
GRANT ALL ON TABLE "public"."vendor_offers" TO "authenticated";
GRANT ALL ON TABLE "public"."vendor_offers" TO "service_role";



GRANT ALL ON TABLE "public"."vendors" TO "service_role";



GRANT ALL ON TABLE "public"."visits" TO "anon";
GRANT ALL ON TABLE "public"."visits" TO "authenticated";
GRANT ALL ON TABLE "public"."visits" TO "service_role";



GRANT ALL ON TABLE "public"."voice_agent_status" TO "anon";
GRANT ALL ON TABLE "public"."voice_agent_status" TO "authenticated";
GRANT ALL ON TABLE "public"."voice_agent_status" TO "service_role";



GRANT ALL ON TABLE "public"."voice_blocked_numbers" TO "anon";
GRANT ALL ON TABLE "public"."voice_blocked_numbers" TO "authenticated";
GRANT ALL ON TABLE "public"."voice_blocked_numbers" TO "service_role";



GRANT ALL ON TABLE "public"."voice_call_events" TO "anon";
GRANT ALL ON TABLE "public"."voice_call_events" TO "authenticated";
GRANT ALL ON TABLE "public"."voice_call_events" TO "service_role";



GRANT ALL ON TABLE "public"."voice_call_flows" TO "anon";
GRANT ALL ON TABLE "public"."voice_call_flows" TO "authenticated";
GRANT ALL ON TABLE "public"."voice_call_flows" TO "service_role";



GRANT ALL ON TABLE "public"."voice_callbacks" TO "anon";
GRANT ALL ON TABLE "public"."voice_callbacks" TO "authenticated";
GRANT ALL ON TABLE "public"."voice_callbacks" TO "service_role";



GRANT ALL ON TABLE "public"."voice_calls" TO "anon";
GRANT ALL ON TABLE "public"."voice_calls" TO "authenticated";
GRANT ALL ON TABLE "public"."voice_calls" TO "service_role";



GRANT ALL ON TABLE "public"."voice_extensions" TO "anon";
GRANT ALL ON TABLE "public"."voice_extensions" TO "authenticated";
GRANT ALL ON TABLE "public"."voice_extensions" TO "service_role";



GRANT ALL ON TABLE "public"."voice_greetings" TO "anon";
GRANT ALL ON TABLE "public"."voice_greetings" TO "authenticated";
GRANT ALL ON TABLE "public"."voice_greetings" TO "service_role";



GRANT ALL ON TABLE "public"."voice_known_numbers" TO "anon";
GRANT ALL ON TABLE "public"."voice_known_numbers" TO "authenticated";
GRANT ALL ON TABLE "public"."voice_known_numbers" TO "service_role";



GRANT ALL ON TABLE "public"."voice_messages" TO "anon";
GRANT ALL ON TABLE "public"."voice_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."voice_messages" TO "service_role";



GRANT ALL ON TABLE "public"."voice_numbers" TO "anon";
GRANT ALL ON TABLE "public"."voice_numbers" TO "authenticated";
GRANT ALL ON TABLE "public"."voice_numbers" TO "service_role";



GRANT ALL ON TABLE "public"."voice_queue_members" TO "anon";
GRANT ALL ON TABLE "public"."voice_queue_members" TO "authenticated";
GRANT ALL ON TABLE "public"."voice_queue_members" TO "service_role";



GRANT ALL ON TABLE "public"."voice_queues" TO "anon";
GRANT ALL ON TABLE "public"."voice_queues" TO "authenticated";
GRANT ALL ON TABLE "public"."voice_queues" TO "service_role";



GRANT ALL ON TABLE "public"."voice_schedules" TO "anon";
GRANT ALL ON TABLE "public"."voice_schedules" TO "authenticated";
GRANT ALL ON TABLE "public"."voice_schedules" TO "service_role";



GRANT ALL ON TABLE "public"."voice_settings" TO "anon";
GRANT ALL ON TABLE "public"."voice_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."voice_settings" TO "service_role";



GRANT ALL ON TABLE "public"."voice_voicemails" TO "anon";
GRANT ALL ON TABLE "public"."voice_voicemails" TO "authenticated";
GRANT ALL ON TABLE "public"."voice_voicemails" TO "service_role";



GRANT ALL ON TABLE "public"."webhook_events" TO "anon";
GRANT ALL ON TABLE "public"."webhook_events" TO "authenticated";
GRANT ALL ON TABLE "public"."webhook_events" TO "service_role";



GRANT ALL ON SEQUENCE "public"."webhook_events_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."webhook_events_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."webhook_events_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."workforce_daily_summaries" TO "anon";
GRANT ALL ON TABLE "public"."workforce_daily_summaries" TO "authenticated";
GRANT ALL ON TABLE "public"."workforce_daily_summaries" TO "service_role";



GRANT ALL ON TABLE "public"."workforce_settings" TO "anon";
GRANT ALL ON TABLE "public"."workforce_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."workforce_settings" TO "service_role";



GRANT ALL ON TABLE "public"."workforce_time_sessions" TO "anon";
GRANT ALL ON TABLE "public"."workforce_time_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."workforce_time_sessions" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































