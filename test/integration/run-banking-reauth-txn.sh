#!/usr/bin/env bash
# Transactional integration test for the sub-banking reauth RPC (PR #43).
#
# Spins up a THROWAWAY Postgres in Docker, loads the minimal faithful schema
# (tables + FKs + Supabase roles, columns copied from the canonical baseline)
# plus the new function migration, runs the sequential scenarios, a real
# SET ROLE execution matrix, a true two-connection concurrency race, and an
# optional PostgREST HTTP layer, then tears the containers down. It NEVER
# touches any remote/production database.
#
# Usage (from repo root):  bash test/integration/run-banking-reauth-txn.sh
set -uo pipefail
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# Plain Postgres: the RPC uses only core features (gen_random_uuid, make_interval,
# jsonb_*, ON CONFLICT), and the bootstrap creates the service_role itself — so
# no Supabase image is needed, which avoids that image's flaky two-phase init.
IMG="postgres:17-alpine"
CT="pg_bank_txn_it"
SUB="11111111-1111-1111-1111-111111111111"
GRANT_ID="22222222-2222-2222-2222-222222222222"
BOOTSTRAP="$ROOT/test/integration/_bootstrap_min_schema.sql"
MIGRATION="$ROOT/supabase/migrations/20260802180611_sub_banking_reauth_consume_txn.sql"
SCEN="$ROOT/test/integration/banking_reauth_txn.integration.sql"

# Windows Docker needs Windows-style source paths for `docker cp`; on Linux/mac
# cygpath is absent and the path passes through unchanged.
towin() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
fail() { echo "FAIL: $*"; exit 1; }

cleanup() {
  docker rm -f pgrst_bank_txn_it >/dev/null 2>&1 || true
  docker rm -f "$CT" >/dev/null 2>&1 || true
  docker network rm net_bank_txn_it >/dev/null 2>&1 || true
}
trap cleanup EXIT

cleanup
docker run -d --name "$CT" -e POSTGRES_PASSWORD=postgres "$IMG" >/dev/null || fail "could not start container"
# Wait for STABLE readiness. A successful query is NOT sufficient evidence on
# its own: the official image's entrypoint runs a TEMPORARY server during
# initdb, on the same unix socket, so `select 1` answers during init -- and
# then that server is shut down and the socket disappears before the real one
# starts. The first CI run of this script (2026-08-17) got past a query-only
# check and died on the very next command with
#   psql: error: connection to server on socket ".s.PGSQL.5432" failed:
#   No such file or directory
# So: wait for the entrypoint to announce init is finished, and only then wait
# for a query. Both loops are needed -- the marker rules out the temp server,
# the query rules out answering before the real server is accepting.
INIT=0
for i in $(seq 1 60); do
  if docker logs "$CT" 2>&1 | grep -q "PostgreSQL init process complete"; then INIT=1; break; fi
  sleep 1
done
[ "$INIT" -eq 1 ] || fail "postgres init did not complete (logs: $(docker logs "$CT" 2>&1 | tail -3 | tr '\n' ' '))"

READY=0
for i in $(seq 1 45); do
  if docker exec "$CT" psql -U postgres -d postgres -tAc "select 1" >/dev/null 2>&1; then READY=1; break; fi
  sleep 1
done
[ "$READY" -eq 1 ] || fail "postgres did not become ready"

# Minimal faithful schema for the three tables the RPC touches (columns copied
# verbatim from the canonical baseline). Deterministic and container-init safe.
docker cp "$(towin "$BOOTSTRAP")" "$CT:/tmp/bootstrap.sql" >/dev/null || fail "copy bootstrap"
docker exec "$CT" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f /tmp/bootstrap.sql >/dev/null || fail "bootstrap schema did not apply cleanly"

# New migration must apply cleanly (ON_ERROR_STOP=1).
docker cp "$(towin "$MIGRATION")" "$CT:/tmp/mig.sql" >/dev/null || fail "copy migration"
docker exec "$CT" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f /tmp/mig.sql >/dev/null || fail "migration did not apply cleanly"

# Sequential scenarios (valid / rollback stages / reuse / forged / expired / wrong-purpose).
docker cp "$(towin "$SCEN")" "$CT:/tmp/itest.sql" >/dev/null || fail "copy scenarios"
docker exec "$CT" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f /tmp/itest.sql 2>&1 | grep -E "PASS|FAIL|ALL_SEQUENTIAL"
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "a sequential scenario failed"

# Real SET ROLE execution matrix: service_role executes a valid call (proving
# SECURITY INVOKER table access), and anon is denied at execute time.
docker exec "$CT" psql -U postgres -d postgres -tA -c "select _reset(now() - interval '30 sec');" >/dev/null || fail "reset for role tests"
SR_OK="$(docker exec "$CT" psql -U postgres -d postgres -tA -c "set role service_role; select (public.consume_sub_reauth_and_apply_banking('$SUB', repeat('a',64), 'ach', null, '****1234', false, false))->>'ok';" 2>&1 | grep -oE 'true|false' | head -1)"
[ "$SR_OK" = "true" ] || fail "service_role could not execute the function (got: $SR_OK)"
echo "PASS role: service_role executes and has SECURITY INVOKER table access"
docker exec "$CT" psql -U postgres -d postgres -tA -c "select _reset(now() - interval '30 sec');" >/dev/null
ANON_OUT="$(docker exec "$CT" psql -U postgres -d postgres -tA -c "set role anon; select public.consume_sub_reauth_and_apply_banking('$SUB', repeat('b',64), 'ach', null, '****1234', false, false);" 2>&1)"
if echo "$ANON_OUT" | grep -qi "permission denied"; then
  echo "PASS role: anon is denied execute (permission denied)"
else
  fail "anon was NOT denied execute (got: $ANON_OUT)"
fi

# Concurrency: two sessions race the same grant; exactly one must complete.
docker exec "$CT" psql -U postgres -d postgres -tA -c "select _reset(now() - interval '30 sec');" >/dev/null || fail "reset for concurrency"
docker exec "$CT" psql -U postgres -d postgres -tA -c \
  "begin; select 'A_OK='||((public.consume_sub_reauth_and_apply_banking('$SUB', repeat('a',64), 'achA', null, '****1111', false, false))->>'ok'); select pg_sleep(3); commit;" >/tmp/A.txt 2>&1 &
APID=$!
sleep 1
docker exec "$CT" psql -U postgres -d postgres -tA -c \
  "begin; select 'B_OK='||((public.consume_sub_reauth_and_apply_banking('$SUB', repeat('a',64), 'achB', null, '****2222', false, false))->>'ok'); commit;" >/tmp/B.txt 2>&1
wait $APID
A="$(grep -oE 'A_OK=(true|false)' /tmp/A.txt | head -1)"
B="$(grep -oE 'B_OK=(true|false)' /tmp/B.txt | head -1)"
ROWS="$(docker exec "$CT" psql -U postgres -d postgres -tA -c "select count(*) from sub_banking where sub_id='$SUB';")"
if [ "$A" = "A_OK=true" ] && [ "$B" = "B_OK=false" ] && [ "$ROWS" = "1" ]; then
  echo "PASS 6: two simultaneous submissions -> exactly one complete change ($A $B rows=$ROWS)"
else
  fail "concurrency ($A $B rows=$ROWS)"
fi
echo "ALL_INTEGRATION_SCENARIOS_PASSED"

# ---- OPTIONAL: PostgREST HTTP layer (non-fatal; reports PASS lines or a blocker) ----
if [ "${SKIP_POSTGREST:-0}" != "1" ]; then
  bash "$ROOT/test/integration/run-banking-reauth-postgrest.sh" "$CT" || echo "POSTGREST_LAYER: see blocker above"
fi
