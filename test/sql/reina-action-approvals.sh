#!/usr/bin/env bash
#
# Proof that supabase/migrations/20260823230000_reina_action_approvals.sql
# enforces what its comments claim. NOT part of `npm test` -- it needs a real
# Postgres, and CI has none. Run it before changing that migration:
#
#   test/sql/reina-action-approvals.sh supabase/migrations/20260823230000_reina_action_approvals.sql
#
# It builds its own throwaway cluster (initdb, trust auth, unix socket, no
# sudo), applies the migration, asserts every rule, and deletes the cluster.
# Verified on Postgres 18 under WSL Ubuntu, 2026-08-23: 22/22.
#
# An approval that can be spent twice, spent by the wrong account, spent after
# expiry, or bypassed entirely is the whole risk of letting Reina act. None of
# that is provable by reading the SQL, so it is proved here instead.
set -euo pipefail

PGBIN=/usr/lib/postgresql/18/bin
DATA=$HOME/pg_reina_actions_test
PORT=54329
SOCK=$HOME/pg_reina_sock
MIG="$1"

rm -rf "$DATA" "$SOCK"
mkdir -p "$DATA" "$SOCK"

"$PGBIN/initdb" -D "$DATA" -U postgres --auth=trust >/dev/null 2>&1
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $SOCK -c listen_addresses=''" -l "$DATA/log" -w start >/dev/null

export PGHOST=$SOCK PGPORT=$PORT PGUSER=postgres
psql -q -c 'create database reina_test' postgres

run() { psql -q -v ON_ERROR_STOP=1 -d reina_test "$@"; }
ask() { psql -At -v ON_ERROR_STOP=1 -d reina_test -c "$1"; }

# --- Dependencies the migration expects to already exist -------------------
run <<'SQL'
create schema if not exists extensions;
create extension if not exists pgcrypto schema extensions;
create table public.profiles (id uuid primary key);
create role service_role;
create role anon;
create role authenticated;
create function public.reina_pilot_prepare_deadline(p_deadline_at timestamptz)
returns boolean language plpgsql as $fn$
begin
  return p_deadline_at is not null
     and p_deadline_at > clock_timestamp()
     and p_deadline_at <= clock_timestamp() + interval '15 seconds';
end;
$fn$;
insert into public.profiles (id) values
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222');
SQL

# --- The migration under test ----------------------------------------------
run -f "$MIG"
echo "MIGRATION APPLIED"


blocked() { # constraint_name sql  -> BLOCKED when the table refuses the write
  local out
  out=$(psql -At -d reina_test -c "$2" 2>&1) || true
  case "$out" in *"$1"*) echo BLOCKED ;; *) echo "ALLOWED($out)" ;; esac
}
fail=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then printf '  ok   %-52s %s\n' "$1" "$3"
  else printf '  FAIL %-52s expected=%s got=%s\n' "$1" "$2" "$3"; fail=1; fi
}

OWNER=11111111-1111-4111-8111-111111111111
OTHER=22222222-2222-4222-8222-222222222222
DL="clock_timestamp() + interval '5 seconds'"
DIGEST=$(printf 'a%.0s' $(seq 1 64))
POL="'{\"operation\":\"reina.action.send_email\"}'::jsonb"

issue() { # approval_id kind sensitivity expiry_expr
  ask "select public.reina_action_issue_approval('$OWNER','rp.conv','t.$1','$1','$2','$3','{\"to\":[\"a@b.com\"]}'::jsonb, $4, $POL, $DL)->>'status'"
}

check "issue a comms approval"            issued    "$(issue rap.one send_email comms "clock_timestamp() + interval '5 minutes'")"
check "the same id cannot be issued twice" duplicate "$(issue rap.one send_email comms "clock_timestamp() + interval '5 minutes'")"
check "an unknown action kind is refused"  invalid   "$(issue rap.bad transfer_funds financial "clock_timestamp() + interval '5 minutes'")"
check "an approval good for a day is refused" invalid "$(issue rap.long send_email comms "clock_timestamp() + interval '24 hours'")"

consume() { ask "select public.reina_action_consume_approval('$1','$2','$DIGEST', $POL, $DL)->>'status'"; }
check "the owner may spend it, once"       consumed  "$(consume $OWNER rap.one)"
check "spending it again does nothing"     duplicate "$(consume $OWNER rap.one)"

check "issue a second approval"            issued    "$(issue rap.two send_email comms "clock_timestamp() + interval '5 minutes'")"
check "another account cannot spend it"    not_found "$(consume $OTHER rap.two)"
check "and the owner still can afterwards" consumed  "$(consume $OWNER rap.two)"

check "issue a third approval"             issued    "$(issue rap.three send_email financial "clock_timestamp() + interval '5 minutes'")"
check "rejecting is allowed"               rejected  "$(ask "select public.reina_action_reject_approval('$OWNER','rap.three', $DL)->>'status'")"
check "a rejected approval cannot be spent" rejected "$(consume $OWNER rap.three)"
check "a rejected approval cannot re-reject" not_found "$(ask "select public.reina_action_reject_approval('$OWNER','rap.three', $DL)->>'status'")"

check "an approval that never existed"     not_found "$(consume $OWNER rap.ghost)"
check "a junk digest is refused"           invalid   "$(ask "select public.reina_action_consume_approval('$OWNER','rap.two','not-a-digest', $POL, $DL)->>'status'")"

# Expiry: issue with a one-second life, wait it out.
check "issue a short-lived approval"       issued    "$(issue rap.four send_email comms "clock_timestamp() + interval '1 second'")"
sleep 2
check "an expired approval cannot be spent" expired  "$(consume $OWNER rap.four)"

check "outcome recorded once"              recorded  "$(ask "select public.reina_action_record_outcome('$OWNER','rap.one','sent', $DL)->>'status'")"
check "outcome cannot be overwritten"      not_found "$(ask "select public.reina_action_record_outcome('$OWNER','rap.one','failed', $DL)->>'status'")"
check "an unapproved action cannot record" not_found "$(ask "select public.reina_action_record_outcome('$OWNER','rap.three','sent', $DL)->>'status'")"

# The constraint that matters most: nothing executed without an approval.
check "executed-without-approval is rejected by the table" BLOCKED "$(blocked reina_action_executed_needs_approval_check "insert into public.reina_action_approvals (approval_id, owner_principal_id, conversation_id, turn_id, action_kind, sensitivity, proposal, policy_reference, expires_at, executed_digest) values ('rap.forge','$OWNER','rp.c','t.f','send_email','comms','{}'::jsonb,'{}'::jsonb, clock_timestamp() + interval '5 minutes', repeat('a',64))")"

check "approved and rejected cannot both be set" BLOCKED "$(blocked reina_action_single_verdict_check "update public.reina_action_approvals set rejected_at = clock_timestamp() where approval_id = 'rap.one'")"

"$PGBIN/pg_ctl" -D "$DATA" -w stop >/dev/null 2>&1 || true
rm -rf "$DATA" "$SOCK"

if [ "$fail" = "0" ]; then echo "ALL MIGRATION CHECKS PASSED"; else echo "MIGRATION CHECKS FAILED"; exit 1; fi
