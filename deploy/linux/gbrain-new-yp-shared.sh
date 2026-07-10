#!/usr/bin/env bash
# One-time setup for the JusHub tenant (yp) + the platform-shared source:
#   sources: platform-knowledge, yp-global, yp-role-<code>...
#   client : yp-admin — the JusHub *backend* shared client (admin scope: it
#            backfills/mirrors ai_memory into per-user/role/global sources and
#            is the fallback when a user has no ai_gbrain_client row).
#            Goes into JusHub config.env as GBRAIN_OAUTH_CLIENT_ID/SECRET.
#
# Usage: gbrain-new-yp-shared.sh <role-code>[,<role-code>...]
#   e.g. gbrain-new-yp-shared.sh leader,accountant,hr_manager,ceo
#
# Install: sudo install -m 755 gbrain-new-yp-shared.sh /usr/local/bin/
set -euo pipefail

ROLES=${1:?usage: gbrain-new-yp-shared.sh <role-code>[,<role-code>...]}
GB="sudo -u gbrain /usr/local/bin/gbrain"

# Source ids allow only lowercase alnum + interior hyphens — JusHub role
# codes use underscores (hr_manager), so normalize _ → - (hr-manager).
SOURCES="platform-knowledge yp-global"
for r in ${ROLES//,/ }; do SOURCES="$SOURCES yp-role-${r//_/-}"; done

for SRC in $SOURCES; do
  DIR="/srv/brain-repos/$SRC"
  sudo -u gbrain mkdir -p "$DIR"
  sudo -u gbrain git -C "$DIR" init -q 2>/dev/null || true
  $GB sources add "$SRC" --path "$DIR" --name "$SRC" --no-federated \
    || echo "source $SRC: already exists, skipping"
done

# JusHub backend shared client — admin scope (cross-source mirror/backfill).
# NB: --scopes is SPACE-separated; --federated-read is comma-separated.
CREDS=$($GB auth register-client yp-admin \
  --grant-types client_credentials --scopes "read write admin" \
  --source yp-global --federated-read "$(echo $SOURCES | tr ' ' ',')")
echo "$CREDS"
echo
echo "→ JusHub config.env: GBRAIN_BASE_URL=https://second-brain.yplawfirm.vn/mcp"
echo "                     GBRAIN_OAUTH_CLIENT_ID/SECRET = the pair above"
