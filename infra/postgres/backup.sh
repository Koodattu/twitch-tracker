#!/bin/sh
set -eu

umask 077

temp_file=""
checksum_temp=""

cleanup() {
  if [ -n "$temp_file" ]; then rm -f "$temp_file"; fi
  if [ -n "$checksum_temp" ]; then rm -f "$checksum_temp"; fi
}

trap cleanup EXIT
trap 'cleanup; exit 0' INT TERM HUP

case "${BACKUP_RETENTION_DAYS:-}" in
  ''|*[!0-9]*|0) echo "BACKUP_RETENTION_DAYS must be a positive integer." >&2; exit 1 ;;
esac

case "${BACKUP_INTERVAL_SECONDS:-}" in
  ''|*[!0-9]*|0) echo "BACKUP_INTERVAL_SECONDS must be a positive integer." >&2; exit 1 ;;
esac

if [ -z "${PGPASSWORD:-}" ]; then
  echo "PGPASSWORD must be set." >&2
  exit 1
fi

while true; do
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  filename="twitch_tracker_${timestamp}.dump"
  final_file="/backups/${filename}"
  checksum_file="${final_file}.sha256"
  temp_file="/backups/.${filename}.tmp"
  checksum_temp="/backups/.${filename}.sha256.tmp"

  pg_dump \
    --format=custom \
    --no-owner \
    --no-privileges \
    --file="$temp_file"
  pg_restore --list "$temp_file" >/dev/null

  hash="$(sha256sum "$temp_file" | awk '{print $1}')"
  printf '%s  %s\n' "$hash" "$filename" > "$checksum_temp"
  mv "$temp_file" "$final_file"
  temp_file=""
  mv "$checksum_temp" "$checksum_file"
  checksum_temp=""

  last_success_temp="/backups/.last-success.tmp"
  printf '%s %s\n' "$timestamp" "$filename" > "$last_success_temp"
  mv "$last_success_temp" /backups/.last-success

  find /backups -type f \( -name 'twitch_tracker_*.dump' -o -name 'twitch_tracker_*.dump.sha256' \) \
    -mtime "+${BACKUP_RETENTION_DAYS}" -delete

  sleep "$BACKUP_INTERVAL_SECONDS"
done
