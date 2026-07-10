#!/usr/bin/env bash
# Provision one JusHub user on the shared brain (JusHub = tenant "yp",
# keeping its proven per-user Model B isolation, namespaced yp-*):
#   source yp-user-<id> + OAuth client scoped
#   write: yp-user-<id>
#   read : yp-user-<id> + the user's role sources + yp-global + platform-knowledge
#
# Usage:  gbrain-new-jushub-user.sh <user-id> [role-slug,role-slug,...]
# The yp-global and yp-role-<slug> sources must exist first (create once):
#   gbrain-new-yp-shared.sh   (see README)
#
# Afterwards, on the JusHub box:
#   jusaihub gbrain-set-client <user-id> yp-user-<id> <client_id> <client_secret> \
#     https://second-brain.yplawfirm.vn/token
#
# Install: sudo install -m 755 gbrain-new-jushub-user.sh /usr/local/bin/
set -euo pipefail

UID_ARG=${1:?usage: gbrain-new-jushub-user.sh <user-id> [role-slug,...]}
ROLES=${2:-}

SRC="yp-user-$UID_ARG"
DIR="/srv/brain-repos/$SRC"
GB="sudo -u gbrain /usr/local/bin/gbrain"

# Role codes with underscores map to hyphenated source ids (hr_manager →
# yp-role-hr-manager) — source ids reject underscores.
FED="$SRC,yp-global,platform-knowledge"
if [ -n "$ROLES" ]; then
  for r in ${ROLES//,/ }; do FED="$FED,yp-role-${r//_/-}"; done
fi

sudo -u gbrain mkdir -p "$DIR"
sudo -u gbrain git -C "$DIR" init -q 2>/dev/null || true

$GB sources add "$SRC" --path "$DIR" --name "JusHub user $UID_ARG" --no-federated

# NB: --scopes is SPACE-separated; --federated-read is comma-separated.
CREDS=$($GB auth register-client "$SRC" \
  --grant-types client_credentials --scopes "read write" \
  --source "$SRC" --federated-read "$FED")
echo "$CREDS"

echo
echo "next (on the JusHub box):"
echo "  jusaihub gbrain-set-client $UID_ARG $SRC <client_id> <client_secret> https://second-brain.yplawfirm.vn/token"
