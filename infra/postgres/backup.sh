#!/bin/sh
set -eu

umask 077

temp_file=""
checksum_temp=""
last_success_temp=""

cleanup() {
  if [ -n "$temp_file" ]; then rm -f "$temp_file"; fi
  if [ -n "$checksum_temp" ]; then rm -f "$checksum_temp"; fi
  if [ -n "$last_success_temp" ]; then rm -f "$last_success_temp"; fi
}

trap cleanup EXIT
trap 'exit 0' INT TERM HUP

script_dir="$(CDPATH= cd "$(dirname "$0")" && pwd)"
. "$script_dir/backup-lib.sh"

load_backup_settings

case "${BACKUP_INTERVAL_SECONDS:-}" in
  ''|*[!0-9]*|0) echo "BACKUP_INTERVAL_SECONDS must be a positive integer." >&2; exit 1 ;;
esac

if [ "${BACKUP_OFF_HOST_CONFIRMED:-false}" != "true" ]; then
  backup_error "backup_warning reason=no_verified_off_host_copy"
fi

if [ -z "${PGPASSWORD:-}" ]; then
  echo "PGPASSWORD must be set." >&2
  exit 1
fi

initial_delay="$(backup_seconds_until_due "$BACKUP_INTERVAL_SECONDS")"
if [ "$initial_delay" -gt 0 ]; then
  backup_log "backup_scheduled reason=current_backup_still_fresh delay_seconds=$initial_delay"
  sleep "$initial_delay"
fi

create_backup() {
  if ! backup_preflight; then
    return 1
  fi

  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  filename="twitch_tracker_${timestamp}.dump"
  final_file="${BACKUP_DIR}/${filename}"
  checksum_file="${final_file}.sha256"
  temp_file="${BACKUP_DIR}/.${filename}.tmp"
  checksum_temp="${BACKUP_DIR}/.${filename}.sha256.tmp"

  if ! pg_dump \
    --format=custom \
    --compress="${BACKUP_COMPRESSION:-gzip:6}" \
    --no-owner \
    --no-privileges \
    --file="$temp_file"; then
    backup_error "backup_failed stage=pg_dump"
    return 1
  fi
  if ! pg_restore --list "$temp_file" >/dev/null; then
    backup_error "backup_failed stage=archive_validation"
    return 1
  fi

  if ! hash="$(sha256sum "$temp_file" | awk '{print $1}')"; then
    backup_error "backup_failed stage=checksum"
    return 1
  fi
  printf '%s  %s\n' "$hash" "$filename" > "$checksum_temp"
  mv "$checksum_temp" "$checksum_file"
  checksum_temp=""
  mv "$temp_file" "$final_file"
  temp_file=""

  size="$(backup_file_size "$final_file")"
  last_success_temp="${BACKUP_DIR}/.last-success.tmp"
  printf '%s %s %s %s\n' "$(date -u +%s)" "$timestamp" "$filename" "$size" > "$last_success_temp"
  mv "$last_success_temp" "${BACKUP_DIR}/.last-success"
  last_success_temp=""

  backup_log "backup_created filename=$filename bytes=$size compression=${BACKUP_COMPRESSION:-gzip:6}"
  if ! prune_backups; then
    backup_error "backup_warning stage=retention"
  fi
  backup_status
}

while true; do
  if ! create_backup; then
    cleanup
    backup_error "backup_attempt_failed retry_seconds=$BACKUP_INTERVAL_SECONDS"
  fi

  sleep "$BACKUP_INTERVAL_SECONDS"
done
