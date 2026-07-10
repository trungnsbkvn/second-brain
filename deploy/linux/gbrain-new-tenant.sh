#!/usr/bin/env bash
# Provision one business tenant on the shared brain:
#   1 gbrain source (tenant-<slug>, own git-backed dir) +
#   1 OAuth client_credentials client bound to that source, with read of the
#   shared platform-knowledge source, + budget/bound limits via psql
#   (the auth CLI has no flags for the rental columns).
#
# Usage:  gbrain-new-tenant.sh <slug> "<Display Name>" [budget_usd_per_day]
# Prints the client credentials ONCE — hand to the tenant over a secure
# channel; the secret is stored hashed and can never be recovered.
#
# Install: sudo install -m 755 gbrain-new-tenant.sh /usr/local/bin/
set -euo pipefail

SLUG=${1:?usage: gbrain-new-tenant.sh <slug> "<Display Name>" [budget_usd_per_day]}
NAME=${2:?display name required}
BUDGET=${3:-5}

[[ "$SLUG" =~ ^[a-z0-9][a-z0-9-]{1,30}$ ]] || { echo "bad slug: $SLUG (lowercase a-z0-9-)"; exit 1; }

SRC="tenant-$SLUG"
DIR="/srv/brain-repos/$SRC"
# /usr/local/bin/gbrain wrapper sources /etc/gbrain.env when DATABASE_URL is
# unset, so running as the gbrain user Just Works.
GB="sudo -u gbrain /usr/local/bin/gbrain"

# 1. Source dir (git-backed → per-tenant export/backup granularity).
sudo -u gbrain mkdir -p "$DIR"
sudo -u gbrain git -C "$DIR" init -q 2>/dev/null || true

# 2. gbrain source — NOT federated (platform-knowledge reads are granted
#    explicitly per client, never via the source-level federated flag).
$GB sources add "$SRC" --path "$DIR" --name "$NAME" --no-federated

# 3. OAuth client: write scope = own source; read = own source + shared knowledge.
# NB: --scopes is SPACE-separated; --federated-read is comma-separated.
CREDS=$($GB auth register-client "$SRC-agent" \
  --grant-types client_credentials --scopes "read write" \
  --source "$SRC" --federated-read "$SRC,platform-knowledge")
echo "$CREDS"

CLIENT_ID=$(echo "$CREDS" | grep -oE 'gbrain_cl_[A-Za-z0-9_-]+' | head -1)
[ -n "$CLIENT_ID" ] || { echo "ERROR: could not parse client_id from register-client output"; exit 1; }

# 4. Rental limits (columns exist; CLI has no flags for them).
sudo -u postgres psql -q gbrain -c \
  "UPDATE oauth_clients SET budget_usd_per_day=$BUDGET, bound_source_id='$SRC', bound_max_concurrent=2 WHERE client_id='$CLIENT_ID';"

echo
echo "tenant $SLUG provisioned: source=$SRC client_id=$CLIENT_ID budget=\$$BUDGET/day"
echo "REMINDER: secret above is shown ONCE. Token URL: https://second-brain.yplawfirm.vn/token"
