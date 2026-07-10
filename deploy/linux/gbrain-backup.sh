#!/usr/bin/env bash
# Nightly backup: pg_dump (custom format) + tenant source repos tarball.
#
# Install:
#   sudo install -m 755 gbrain-backup.sh /usr/local/bin/gbrain-backup.sh
#   sudo crontab -e   →   30 2 * * * /usr/local/bin/gbrain-backup.sh
#
# Restore drill (Phase 1 verification gate):
#   sudo -u postgres createdb gbrain_restore_test
#   sudo -u postgres pg_restore -d gbrain_restore_test /var/backups/gbrain/gbrain-<date>.dump
#   sudo -u postgres psql gbrain_restore_test -c 'SELECT count(*) FROM pages;'
#   sudo -u postgres dropdb gbrain_restore_test
#
# Offsite: configure rclone and uncomment the last line (single box = no HA;
# the offsite copy IS the disaster-recovery story).
set -euo pipefail

DEST=/var/backups/gbrain
KEEP_DAYS=14
STAMP=$(date +%F)

mkdir -p "$DEST"

# Postgres — custom format (compressed, pg_restore-able).
sudo -u postgres pg_dump -Fc gbrain > "$DEST/gbrain-$STAMP.dump"

# Tenant source repos (git dirs under /srv/brain-repos) — per-tenant restore
# granularity that pg_restore can't give (re-import per source).
tar -C /srv -czf "$DEST/brain-repos-$STAMP.tgz" brain-repos

find "$DEST" -type f -mtime +"$KEEP_DAYS" -delete

# rclone copy "$DEST" remote:gbrain-backups   # CHANGE-ME: offsite target
echo "backup ok: $DEST/gbrain-$STAMP.dump + brain-repos-$STAMP.tgz"
