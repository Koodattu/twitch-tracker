#!/bin/sh
set -eu

umask 077

if [ "$#" -ne 1 ]; then
  echo "Usage: restore.sh <backup filename>" >&2
  exit 1
fi

if [ -z "${RESTORE_DATABASE:-}" ]; then
  echo "RESTORE_DATABASE must name an existing empty drill database." >&2
  exit 1
fi

if [ "$RESTORE_DATABASE" = "${PGDATABASE:-}" ]; then
  echo "Refusing to restore over the configured production database." >&2
  exit 1
fi

if [ -z "${PGPASSWORD:-}" ]; then
  echo "PGPASSWORD must be set." >&2
  exit 1
fi

filename="$(basename "$1")"
backup_file="/backups/$filename"
checksum_file="${backup_file}.sha256"

if [ ! -s "$backup_file" ] || [ ! -s "$checksum_file" ]; then
  echo "Backup or checksum file is missing." >&2
  exit 1
fi

(cd /backups && sha256sum -c "$(basename "$checksum_file")")
pg_restore --list "$backup_file" >/dev/null
pg_restore \
  --exit-on-error \
  --no-owner \
  --no-privileges \
  --dbname="$RESTORE_DATABASE" \
  "$backup_file"
