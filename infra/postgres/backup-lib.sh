#!/bin/sh

backup_log() {
  printf '%s\n' "$*"
}

backup_error() {
  printf '%s\n' "$*" >&2
}

is_positive_integer() {
  case "$1" in
    ''|*[!0-9]*|0) return 1 ;;
    *) return 0 ;;
  esac
}

is_non_negative_integer() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

load_backup_settings() {
  BACKUP_DIR="${BACKUP_DIR:-/backups}"
  BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
  BACKUP_MAX_COUNT="${BACKUP_MAX_COUNT:-1}"
  BACKUP_MAX_TOTAL_BYTES="${BACKUP_MAX_TOTAL_BYTES:-10737418240}"
  BACKUP_MIN_FREE_BYTES="${BACKUP_MIN_FREE_BYTES:-5368709120}"
  BACKUP_WARN_USED_PERCENT="${BACKUP_WARN_USED_PERCENT:-80}"
  BACKUP_CRITICAL_USED_PERCENT="${BACKUP_CRITICAL_USED_PERCENT:-90}"
  BACKUP_HEALTH_MAX_AGE_SECONDS="${BACKUP_HEALTH_MAX_AGE_SECONDS:-172800}"
  BACKUP_RETENTION_DRY_RUN="${BACKUP_RETENTION_DRY_RUN:-false}"

  if ! is_positive_integer "$BACKUP_RETENTION_DAYS"; then
    backup_error "BACKUP_RETENTION_DAYS must be a positive integer."
    return 1
  fi
  if ! is_positive_integer "$BACKUP_MAX_COUNT"; then
    backup_error "BACKUP_MAX_COUNT must be a positive integer."
    return 1
  fi
  if ! is_positive_integer "$BACKUP_MAX_TOTAL_BYTES"; then
    backup_error "BACKUP_MAX_TOTAL_BYTES must be a positive integer."
    return 1
  fi
  if ! is_non_negative_integer "$BACKUP_MIN_FREE_BYTES"; then
    backup_error "BACKUP_MIN_FREE_BYTES must be a non-negative integer."
    return 1
  fi
  if ! is_positive_integer "$BACKUP_WARN_USED_PERCENT" || [ "$BACKUP_WARN_USED_PERCENT" -ge 100 ]; then
    backup_error "BACKUP_WARN_USED_PERCENT must be an integer from 1 through 99."
    return 1
  fi
  if ! is_positive_integer "$BACKUP_CRITICAL_USED_PERCENT" || [ "$BACKUP_CRITICAL_USED_PERCENT" -ge 100 ]; then
    backup_error "BACKUP_CRITICAL_USED_PERCENT must be an integer from 1 through 99."
    return 1
  fi
  if [ "$BACKUP_WARN_USED_PERCENT" -ge "$BACKUP_CRITICAL_USED_PERCENT" ]; then
    backup_error "BACKUP_WARN_USED_PERCENT must be lower than BACKUP_CRITICAL_USED_PERCENT."
    return 1
  fi
  if ! is_positive_integer "$BACKUP_HEALTH_MAX_AGE_SECONDS"; then
    backup_error "BACKUP_HEALTH_MAX_AGE_SECONDS must be a positive integer."
    return 1
  fi
  case "$BACKUP_RETENTION_DRY_RUN" in
    true|false) ;;
    *) backup_error "BACKUP_RETENTION_DRY_RUN must be true or false."; return 1 ;;
  esac
  if [ ! -d "$BACKUP_DIR" ]; then
    backup_error "Backup directory does not exist: $BACKUP_DIR"
    return 1
  fi
}

backup_file_size() {
  stat -c '%s' "$1"
}

backup_file_mtime() {
  stat -c '%Y' "$1"
}

backup_filesystem_stats() {
  df -Pk "$BACKUP_DIR" | awk 'NR == 2 { used = $5; sub(/%$/, "", used); print $4 * 1024, used }'
}

backup_marker_filename() {
  marker="$BACKUP_DIR/.last-success"
  if [ ! -s "$marker" ]; then
    return 1
  fi

  awk '
    NF == 2 { print $2; exit }
    NF >= 4 && $1 ~ /^[0-9]+$/ { print $3; exit }
  ' "$marker"
}

validate_backup_filename() {
  case "$1" in
    twitch_tracker_????????T??????Z.dump) return 0 ;;
    *) return 1 ;;
  esac
}

known_good_backup() {
  filename="$(backup_marker_filename)" || return 1
  if ! validate_backup_filename "$filename"; then
    return 1
  fi

  dump="$BACKUP_DIR/$filename"
  checksum="$dump.sha256"
  if [ ! -s "$dump" ] || [ ! -s "$checksum" ]; then
    return 1
  fi
  printf '%s\n' "$dump"
}

complete_backup_files() {
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'twitch_tracker_????????T??????Z.dump' -size +0c -print | sort -r
}

backup_inventory() {
  count=0
  total=0
  for dump in $(complete_backup_files); do
    if [ ! -s "$dump.sha256" ]; then
      continue
    fi
    size="$(backup_file_size "$dump")"
    count=$((count + 1))
    total=$((total + size))
  done
  printf '%s %s\n' "$count" "$total"
}

backup_status() {
  now_epoch="${1:-$(date -u +%s)}"
  set -- $(backup_inventory)
  complete_count="$1"
  total_bytes="$2"
  set -- $(backup_filesystem_stats)
  available_bytes="$1"
  used_percent="$2"
  marker_age_seconds="unknown"
  marker_filename="unknown"

  if known_good="$(known_good_backup)"; then
    marker_filename="$(basename "$known_good")"
    marker_age_seconds=$((now_epoch - $(backup_file_mtime "$known_good")))
  fi

  backup_log "backup_status complete_count=$complete_count total_bytes=$total_bytes available_bytes=$available_bytes filesystem_used_percent=$used_percent last_success=$marker_filename last_success_age_seconds=$marker_age_seconds"
}

backup_preflight() {
  set -- $(backup_filesystem_stats)
  available_bytes="$1"
  used_percent="$2"

  if [ "$used_percent" -ge "$BACKUP_CRITICAL_USED_PERCENT" ]; then
    backup_error "backup_preflight_failed reason=filesystem_critical filesystem_used_percent=$used_percent critical_percent=$BACKUP_CRITICAL_USED_PERCENT"
    return 1
  fi
  if [ "$used_percent" -ge "$BACKUP_WARN_USED_PERCENT" ]; then
    backup_error "backup_capacity_warning filesystem_used_percent=$used_percent warning_percent=$BACKUP_WARN_USED_PERCENT"
  fi

  previous_size=0
  if previous="$(known_good_backup)"; then
    previous_size="$(backup_file_size "$previous")"
  fi
  required_bytes=$((BACKUP_MIN_FREE_BYTES + previous_size))
  if [ "$available_bytes" -lt "$required_bytes" ]; then
    backup_error "backup_preflight_failed reason=insufficient_free_space available_bytes=$available_bytes required_bytes=$required_bytes reserve_bytes=$BACKUP_MIN_FREE_BYTES estimated_dump_bytes=$previous_size"
    return 1
  fi
}

remove_backup_pair() {
  dump="$1"
  checksum="$dump.sha256"
  if [ "$BACKUP_RETENTION_DRY_RUN" = "true" ]; then
    backup_log "backup_prune_would_remove filename=$(basename "$dump") bytes=$(backup_file_size "$dump")"
    return 0
  fi

  rm -f "$checksum" "$dump"
  backup_log "backup_pruned filename=$(basename "$dump")"
}

prune_backups() {
  now_epoch="${1:-$(date -u +%s)}"
  if ! protected="$(known_good_backup)"; then
    backup_error "backup_prune_skipped reason=no_known_good_backup"
    return 1
  fi

  retention_seconds=$((BACKUP_RETENTION_DAYS * 86400))
  kept_count=1
  kept_bytes="$(backup_file_size "$protected")"
  capacity_exhausted=false

  for dump in $(complete_backup_files); do
    checksum="$dump.sha256"
    if [ ! -s "$checksum" ]; then
      backup_error "backup_incomplete_ignored filename=$(basename "$dump") reason=missing_checksum"
      continue
    fi

    size="$(backup_file_size "$dump")"
    mtime="$(backup_file_mtime "$dump")"
    age_seconds=$((now_epoch - mtime))

    if [ "$dump" = "$protected" ]; then
      continue
    fi

    remove_reason=""
    if [ "$capacity_exhausted" = "true" ]; then
      remove_reason="newer_backups_reached_capacity"
    elif [ "$age_seconds" -gt "$retention_seconds" ]; then
      remove_reason="older_than_retention_window"
    elif [ "$kept_count" -ge "$BACKUP_MAX_COUNT" ]; then
      remove_reason="maximum_count"
      capacity_exhausted=true
    elif [ $((kept_bytes + size)) -gt "$BACKUP_MAX_TOTAL_BYTES" ]; then
      remove_reason="maximum_total_bytes"
      capacity_exhausted=true
    fi

    if [ -n "$remove_reason" ]; then
      backup_log "backup_prune_selected filename=$(basename "$dump") reason=$remove_reason"
      remove_backup_pair "$dump"
      continue
    fi

    kept_count=$((kept_count + 1))
    kept_bytes=$((kept_bytes + size))
  done

  if [ "$kept_count" -gt "$BACKUP_MAX_COUNT" ] || [ "$kept_bytes" -gt "$BACKUP_MAX_TOTAL_BYTES" ]; then
    backup_error "backup_capacity_unsatisfied complete_count=$kept_count total_bytes=$kept_bytes max_count=$BACKUP_MAX_COUNT max_total_bytes=$BACKUP_MAX_TOTAL_BYTES protected_backup=$(basename "$protected")"
    return 1
  fi

  backup_log "backup_prune_complete complete_count=$kept_count total_bytes=$kept_bytes dry_run=$BACKUP_RETENTION_DRY_RUN"
}
