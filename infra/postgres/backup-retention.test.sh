#!/bin/sh
set -eu

script_dir="$(CDPATH= cd "$(dirname "$0")" && pwd)"
. "$script_dir/backup-lib.sh"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_exists() {
  [ -e "$1" ] || fail "expected $1 to exist"
}

assert_missing() {
  [ ! -e "$1" ] || fail "expected $1 to be absent"
}

create_complete_backup() {
  filename="$1"
  size="$2"
  dd if=/dev/zero of="$BACKUP_DIR/$filename" bs=1 count="$size" status=none
  printf 'test  %s\n' "$filename" > "$BACKUP_DIR/$filename.sha256"
}

mark_known_good() {
  filename="$1"
  size="$(backup_file_size "$BACKUP_DIR/$filename")"
  printf '%s test %s %s\n' "$(date -u +%s)" "$filename" "$size" > "$BACKUP_DIR/.last-success"
}

reset_case() {
  case_dir="$test_root/$1"
  mkdir "$case_dir"
  BACKUP_DIR="$case_dir"
  BACKUP_RETENTION_DAYS=30
  BACKUP_MAX_COUNT=10
  BACKUP_MAX_TOTAL_BYTES=1000
  BACKUP_MIN_FREE_BYTES=0
  BACKUP_WARN_USED_PERCENT=80
  BACKUP_CRITICAL_USED_PERCENT=90
  BACKUP_HEALTH_MAX_AGE_SECONDS=172800
  BACKUP_RETENTION_DRY_RUN=false
  export BACKUP_DIR BACKUP_RETENTION_DAYS BACKUP_MAX_COUNT BACKUP_MAX_TOTAL_BYTES
  export BACKUP_MIN_FREE_BYTES BACKUP_WARN_USED_PERCENT BACKUP_CRITICAL_USED_PERCENT
  export BACKUP_HEALTH_MAX_AGE_SECONDS BACKUP_RETENTION_DRY_RUN
  load_backup_settings
}

test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT INT TERM HUP

reset_case count_cap
create_complete_backup twitch_tracker_20260104T000000Z.dump 4
create_complete_backup twitch_tracker_20260103T000000Z.dump 4
create_complete_backup twitch_tracker_20260102T000000Z.dump 4
create_complete_backup twitch_tracker_20260101T000000Z.dump 4
mark_known_good twitch_tracker_20260104T000000Z.dump
BACKUP_MAX_COUNT=2
export BACKUP_MAX_COUNT
prune_backups "$(date -u +%s)" >/dev/null
assert_exists "$BACKUP_DIR/twitch_tracker_20260104T000000Z.dump"
assert_exists "$BACKUP_DIR/twitch_tracker_20260103T000000Z.dump"
assert_missing "$BACKUP_DIR/twitch_tracker_20260102T000000Z.dump"
assert_missing "$BACKUP_DIR/twitch_tracker_20260101T000000Z.dump"

reset_case marker_not_newest
create_complete_backup twitch_tracker_20260103T000000Z.dump 4
create_complete_backup twitch_tracker_20260102T000000Z.dump 4
create_complete_backup twitch_tracker_20260101T000000Z.dump 4
mark_known_good twitch_tracker_20260101T000000Z.dump
BACKUP_MAX_COUNT=2
export BACKUP_MAX_COUNT
prune_backups "$(date -u +%s)" >/dev/null
assert_exists "$BACKUP_DIR/twitch_tracker_20260103T000000Z.dump"
assert_missing "$BACKUP_DIR/twitch_tracker_20260102T000000Z.dump"
assert_exists "$BACKUP_DIR/twitch_tracker_20260101T000000Z.dump"

reset_case byte_cap
create_complete_backup twitch_tracker_20260104T000000Z.dump 4
create_complete_backup twitch_tracker_20260103T000000Z.dump 3
create_complete_backup twitch_tracker_20260102T000000Z.dump 2
mark_known_good twitch_tracker_20260104T000000Z.dump
BACKUP_MAX_TOTAL_BYTES=7
export BACKUP_MAX_TOTAL_BYTES
prune_backups "$(date -u +%s)" >/dev/null
assert_exists "$BACKUP_DIR/twitch_tracker_20260104T000000Z.dump"
assert_exists "$BACKUP_DIR/twitch_tracker_20260103T000000Z.dump"
assert_missing "$BACKUP_DIR/twitch_tracker_20260102T000000Z.dump"

reset_case newest_good_preserved
create_complete_backup twitch_tracker_20260102T000000Z.dump 20
create_complete_backup twitch_tracker_20260101T000000Z.dump 2
mark_known_good twitch_tracker_20260102T000000Z.dump
BACKUP_MAX_COUNT=1
BACKUP_MAX_TOTAL_BYTES=10
export BACKUP_MAX_COUNT BACKUP_MAX_TOTAL_BYTES
if prune_backups "$(date -u +%s)" >/dev/null 2>&1; then
  fail "expected an unsatisfied cap when the protected backup exceeds it"
fi
assert_exists "$BACKUP_DIR/twitch_tracker_20260102T000000Z.dump"
assert_missing "$BACKUP_DIR/twitch_tracker_20260101T000000Z.dump"

reset_case incomplete_ignored
create_complete_backup twitch_tracker_20260102T000000Z.dump 4
create_complete_backup twitch_tracker_20260101T000000Z.dump 4
dd if=/dev/zero of="$BACKUP_DIR/twitch_tracker_20260103T000000Z.dump" bs=1 count=5 status=none
mark_known_good twitch_tracker_20260102T000000Z.dump
BACKUP_MAX_COUNT=1
export BACKUP_MAX_COUNT
prune_backups "$(date -u +%s)" >/dev/null 2>&1
assert_exists "$BACKUP_DIR/twitch_tracker_20260103T000000Z.dump"
assert_exists "$BACKUP_DIR/twitch_tracker_20260102T000000Z.dump"
assert_missing "$BACKUP_DIR/twitch_tracker_20260101T000000Z.dump"

reset_case missing_marker
create_complete_backup twitch_tracker_20260101T000000Z.dump 4
if prune_backups "$(date -u +%s)" >/dev/null 2>&1; then
  fail "expected pruning without a known-good marker to fail"
fi
assert_exists "$BACKUP_DIR/twitch_tracker_20260101T000000Z.dump"

reset_case retention_boundary
create_complete_backup twitch_tracker_20260102T000000Z.dump 4
create_complete_backup twitch_tracker_20260101T000000Z.dump 4
mark_known_good twitch_tracker_20260102T000000Z.dump
old="$BACKUP_DIR/twitch_tracker_20260101T000000Z.dump"
old_mtime="$(backup_file_mtime "$old")"
BACKUP_RETENTION_DAYS=1
export BACKUP_RETENTION_DAYS
prune_backups "$((old_mtime + 86400))" >/dev/null
assert_exists "$old"
prune_backups "$((old_mtime + 86401))" >/dev/null
assert_missing "$old"

reset_case dry_run
create_complete_backup twitch_tracker_20260102T000000Z.dump 4
create_complete_backup twitch_tracker_20260101T000000Z.dump 4
mark_known_good twitch_tracker_20260102T000000Z.dump
BACKUP_MAX_COUNT=1
BACKUP_RETENTION_DRY_RUN=true
export BACKUP_MAX_COUNT BACKUP_RETENTION_DRY_RUN
prune_backups "$(date -u +%s)" >/dev/null
assert_exists "$BACKUP_DIR/twitch_tracker_20260102T000000Z.dump"
assert_exists "$BACKUP_DIR/twitch_tracker_20260101T000000Z.dump"

printf 'backup retention tests passed\n'
