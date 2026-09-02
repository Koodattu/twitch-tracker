#!/bin/sh
set -eu

script_dir="$(CDPATH= cd "$(dirname "$0")" && pwd)"
. "$script_dir/backup-lib.sh"

load_backup_settings
now_epoch="$(date -u +%s)"
backup_status "$now_epoch"

if [ "${BACKUP_OFF_HOST_CONFIRMED:-false}" != "true" ]; then
  backup_error "backup_warning reason=no_verified_off_host_copy"
fi

if ! protected="$(known_good_backup)"; then
  backup_error "backup_health_failed reason=no_known_good_backup"
  exit 1
fi

age_seconds=$((now_epoch - $(backup_file_mtime "$protected")))
if [ "$age_seconds" -gt "$BACKUP_HEALTH_MAX_AGE_SECONDS" ]; then
  backup_error "backup_health_failed reason=last_success_too_old age_seconds=$age_seconds max_age_seconds=$BACKUP_HEALTH_MAX_AGE_SECONDS"
  exit 1
fi

set -- $(backup_filesystem_stats)
available_bytes="$1"
used_percent="$2"
if [ "$used_percent" -ge "$BACKUP_CRITICAL_USED_PERCENT" ]; then
  backup_error "backup_health_failed reason=filesystem_critical filesystem_used_percent=$used_percent critical_percent=$BACKUP_CRITICAL_USED_PERCENT"
  exit 1
fi
if [ "$available_bytes" -lt "$BACKUP_MIN_FREE_BYTES" ]; then
  backup_error "backup_health_failed reason=free_space_below_reserve available_bytes=$available_bytes reserve_bytes=$BACKUP_MIN_FREE_BYTES"
  exit 1
fi
if [ "$used_percent" -ge "$BACKUP_WARN_USED_PERCENT" ]; then
  backup_error "backup_capacity_warning filesystem_used_percent=$used_percent warning_percent=$BACKUP_WARN_USED_PERCENT"
fi

set -- $(backup_inventory)
complete_count="$1"
total_bytes="$2"
if [ "$complete_count" -gt "$BACKUP_MAX_COUNT" ] || [ "$total_bytes" -gt "$BACKUP_MAX_TOTAL_BYTES" ]; then
  backup_error "backup_health_failed reason=retention_cap_unsatisfied complete_count=$complete_count total_bytes=$total_bytes max_count=$BACKUP_MAX_COUNT max_total_bytes=$BACKUP_MAX_TOTAL_BYTES"
  exit 1
fi

backup_log "backup_health_ok"
