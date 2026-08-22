#!/usr/bin/env bash
# OPTIONAL PostgREST HTTP-layer test for the sub-banking reauth RPC (PR #43).
#
# Stands up a disposable PostgREST in front of the throwaway Postgres container
# passed as $1, and exercises the RPC over HTTP through PostgREST's JWT role
# switching:
#   * a service_role JWT can call the RPC (200, ok field present);
#   * an anon JWT is denied (non-200);
#   * no JWT (default anon) is denied (non-200).
# Non-fatal for the overall suite: on any setup problem it prints a
# POSTGREST_BLOCKER line and exits 1, and the SQL-level role matrix remains the
# authoritative proof of the grant semantics.
set -uo pipefail
export MSYS_NO_PATHCONV=1

PG="${1:?pg container name required}"
PGRST="pgrst_bank_txn_it"
NET="net_bank_txn_it"
IMG="postgrest/postgrest:v12.2.3"
SECRET="reauth-integration-test-secret-0123456789abcd"  # >=32 chars for HS256
SUB="11111111-1111-1111-1111-111111111111"
PORT=3001

blocker() { echo "POSTGREST_BLOCKER: $*"; exit 1; }
cleanup() { docker rm -f "$PGRST" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker pull "$IMG" >/dev/null 2>&1 || blocker "could not pull $IMG"

# authenticator login role PostgREST connects as; it switches into anon/service_role via the JWT.
docker exec "$PG" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c \
  "do \$\$ begin if not exists (select 1 from pg_roles where rolname='authenticator') then create role authenticator login password 'authpw' noinherit; end if; end \$\$;
   grant anon, authenticated, service_role to authenticator;" >/dev/null 2>&1 || blocker "could not create authenticator role"

# Idempotent: reuse the network if a prior run left it, and ignore "already
# connected" for the pg container.
docker network rm "$NET" >/dev/null 2>&1 || true
docker network create "$NET" >/dev/null 2>&1 || true
docker network connect "$NET" "$PG" >/dev/null 2>&1 || true
docker network inspect "$NET" >/dev/null 2>&1 || blocker "could not create or find network $NET"

docker run -d --name "$PGRST" --network "$NET" -p "$PORT:3000" \
  -e PGRST_DB_URI="postgres://authenticator:authpw@$PG:5432/postgres" \
  -e PGRST_DB_SCHEMAS="public" \
  -e PGRST_DB_ANON_ROLE="anon" \
  -e PGRST_JWT_SECRET="$SECRET" \
  "$IMG" >/dev/null 2>&1 || blocker "could not start PostgREST"

# Wait for PostgREST to answer.
UP=0
for i in $(seq 1 30); do
  if curl -fsS "http://localhost:$PORT/" >/dev/null 2>&1; then UP=1; break; fi
  sleep 1
done
[ "$UP" -eq 1 ] || blocker "PostgREST did not become ready (logs: $(docker logs "$PGRST" 2>&1 | tail -3 | tr '\n' ' '))"

# HS256 JWT signer (node is available in this environment).
mkjwt() {
  node -e '
    const c=require("crypto");
    const b64=(o)=>Buffer.from(JSON.stringify(o)).toString("base64url");
    const h=b64({alg:"HS256",typ:"JWT"});
    const p=b64({role:process.argv[1],exp:Math.floor(Date.now()/1000)+3600});
    const s=c.createHmac("sha256",process.argv[2]).update(h+"."+p).digest("base64url");
    process.stdout.write(h+"."+p+"."+s);
  ' "$1" "$SECRET"
}

BODY='{"p_sub_id":"'"$SUB"'","p_token_hash":"'"$(printf 'a%.0s' {1..64})"'","p_provider":"ach","p_provider_ref":null,"p_masked_account":"****1234","p_set_accepts_cc":false,"p_accepts_cc":false}'
RPC="http://localhost:$PORT/rpc/consume_sub_reauth_and_apply_banking"
PASS=0

# Capture body + status code from STDOUT (no temp files — avoids MSYS/native
# path mismatches). Last line is the HTTP code; everything before it is the body.
http_post() { # $1=auth header value (may be empty)
  if [ -n "$1" ]; then
    curl -s -w '\n%{http_code}' -X POST "$RPC" -H "Authorization: Bearer $1" -H "Content-Type: application/json" -d "$BODY"
  else
    curl -s -w '\n%{http_code}' -X POST "$RPC" -H "Content-Type: application/json" -d "$BODY"
  fi
}

# 1) service_role JWT -> 200 with an ok field.
docker exec "$PG" psql -U postgres -d postgres -tA -c "select _reset(now() - interval '30 sec');" >/dev/null
RESP="$(http_post "$(mkjwt service_role)")"; CODE="$(printf '%s' "$RESP" | tail -n1)"; BODYOUT="$(printf '%s' "$RESP" | sed '$d')"
if [ "$CODE" = "200" ] && printf '%s' "$BODYOUT" | grep -q '"ok"'; then
  echo "PASS http: service_role JWT executes the RPC (200, ok present)"; PASS=$((PASS+1))
else
  echo "POSTGREST_BLOCKER: service_role call expected 200/ok, got $CODE $BODYOUT"; exit 1
fi

# 2) anon JWT -> denied (non-200).
docker exec "$PG" psql -U postgres -d postgres -tA -c "select _reset(now() - interval '30 sec');" >/dev/null
RESP="$(http_post "$(mkjwt anon)")"; CODE="$(printf '%s' "$RESP" | tail -n1)"
if [ "$CODE" != "200" ]; then
  echo "PASS http: anon JWT is denied (HTTP $CODE)"; PASS=$((PASS+1))
else
  echo "POSTGREST_BLOCKER: anon call unexpectedly succeeded (200)"; exit 1
fi

# 3) no JWT (default anon) -> denied (non-200).
RESP="$(http_post "")"; CODE="$(printf '%s' "$RESP" | tail -n1)"
if [ "$CODE" != "200" ]; then
  echo "PASS http: unauthenticated (default anon) is denied (HTTP $CODE)"; PASS=$((PASS+1))
else
  echo "POSTGREST_BLOCKER: unauthenticated call unexpectedly succeeded (200)"; exit 1
fi

[ "$PASS" -eq 3 ] && echo "ALL_POSTGREST_SCENARIOS_PASSED"
