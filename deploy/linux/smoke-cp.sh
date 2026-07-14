#!/usr/bin/env bash
# smoke-cp.sh — post-merge / post-deploy smoke for the control plane + pack
# registry (UPSTREAM.md §C). Asserts the v124 schema landed and the catalog
# gate is armed. Every check degrades gracefully when its input is absent, so
# it's safe to run with only a subset of env set.
#
# Env:
#   BASE          HTTP origin of the running box (default http://127.0.0.1:3131)
#   DATABASE_URL  optional — psql schema assertion (v124 columns/table)
#   TENANT_TOKEN  optional — a tenant OAuth access token → catalog 200 check
#   ADMIN_TOKEN   optional — the admin bootstrap token → publish-auth check
set -uo pipefail

BASE="${BASE:-http://127.0.0.1:3131}"
fails=0
pass() { printf "  ✓ %s\n" "$1"; }
fail() { printf "  ✗ %s\n" "$1"; fails=$((fails + 1)); }

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "smoke-cp against $BASE"

# 1. Server up.
if [ "$(code "$BASE/health")" = "200" ]; then pass "GET /health 200"; else fail "GET /health not 200"; fi

# 2. v124 schema (optional — needs psql + DATABASE_URL).
if [ -n "${DATABASE_URL:-}" ] && command -v psql >/dev/null 2>&1; then
  if psql "$DATABASE_URL" -tAc "SELECT eval_score, artifact_path FROM cp_positions LIMIT 0" >/dev/null 2>&1; then
    pass "cp_positions has v124 columns (eval_score, artifact_path)"
  else fail "cp_positions missing v124 columns — migrate to LATEST"; fi
  if psql "$DATABASE_URL" -tAc "SELECT 1 FROM cp_position_rating LIMIT 0" >/dev/null 2>&1; then
    pass "cp_position_rating table exists"
  else fail "cp_position_rating table missing"; fi
else
  echo "  – schema check skipped (set DATABASE_URL + install psql)"
fi

# 3. Catalog gate armed: unauthenticated tenant catalog MUST 401 (never leak).
c=$(code "$BASE/api/catalog/positions")
if [ "$c" = "401" ]; then pass "GET /api/catalog/positions unauthenticated → 401 (gate armed)"
else fail "GET /api/catalog/positions unauthenticated → $c (expected 401)"; fi

# 4. Authenticated catalog (optional — needs a tenant token).
if [ -n "${TENANT_TOKEN:-}" ]; then
  c=$(code -H "Authorization: Bearer $TENANT_TOKEN" "$BASE/api/catalog/positions")
  if [ "$c" = "200" ]; then pass "GET /api/catalog/positions with tenant token → 200"
  else fail "GET /api/catalog/positions with tenant token → $c (expected 200)"; fi
else
  echo "  – authenticated catalog check skipped (set TENANT_TOKEN)"
fi

# 5. Vendor publish auth (optional): a bootstrap-token request with an empty
#    body should 400 (bad request) — proving the token PASSED auth (≠ 401).
if [ -n "${ADMIN_TOKEN:-}" ]; then
  c=$(code -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "X-Pack-Slug: smoke-test" \
        --data-binary '' "$BASE/admin/api/cp/positions/publish")
  if [ "$c" = "400" ]; then pass "publish with admin token → 400 (auth ok, empty body rejected)"
  elif [ "$c" = "401" ]; then fail "publish with admin token → 401 (token rejected)"
  else fail "publish with admin token → $c (expected 400)"; fi
else
  echo "  – publish-auth check skipped (set ADMIN_TOKEN)"
fi

echo
if [ "$fails" = 0 ]; then echo "smoke-cp: OK"; else echo "smoke-cp: $fails check(s) FAILED"; exit 1; fi
