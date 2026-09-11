#!/bin/sh
set -eu

script_dir="$(CDPATH= cd "$(dirname "$0")" && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT INT TERM HUP
mkdir "$test_root/bin" "$test_root/backups"
export BACKUP_DIR="$test_root/backups" PATH="$test_root/bin:$PATH"
export BACKUP_INTERVAL_SECONDS=86400 BACKUP_RUN_ONCE=true BACKUP_FORCE_NOW=true
export BACKUP_MIN_FREE_BYTES=0 BACKUP_OFF_HOST_CONFIRMED=true PGPASSWORD=synthetic-test-password
export BACKUP_MAX_COUNT=1 BACKUP_MAX_TOTAL_BYTES=100000
export TEST_FAILURE_FILE="$test_root/fail"

cat > "$test_root/bin/df" <<'SH'
#!/bin/sh
printf 'Filesystem 1024-blocks Used Available Capacity Mounted\nfixture 1000000 10000 990000 1%% /\n'
SH
cat > "$test_root/bin/pg_dump" <<'SH'
#!/bin/sh
[ ! -e "$TEST_FAILURE_FILE" ] || exit 1
for argument do
  case "$argument" in --file=*) printf 'synthetic dump\n' > "${argument#--file=}" ;; esac
done
SH
cat > "$test_root/bin/pg_restore" <<'SH'
#!/bin/sh
exit 0
SH
chmod +x "$test_root/bin/df" "$test_root/bin/pg_dump" "$test_root/bin/pg_restore"

sh "$script_dir/backup.sh" > "$test_root/output" 2>&1
[ -s "$BACKUP_DIR/.last-success" ]
cp "$BACKUP_DIR/.last-success" "$test_root/previous-success"
touch "$TEST_FAILURE_FILE"
if sh "$script_dir/backup.sh" > "$test_root/output" 2>&1; then
  echo 'Expected failed backup attempt' >&2; exit 1
fi
grep -q 'backup_attempt_failed retry_seconds=300' "$test_root/output"
[ -s "$BACKUP_DIR/.last-failure" ]
cmp "$BACKUP_DIR/.last-success" "$test_root/previous-success"
if sh "$script_dir/backup-health.sh" > "$test_root/health" 2>&1; then
  echo 'Expected failed health after unsuccessful attempt' >&2; exit 1
fi
grep -q 'reason=last_attempt_failed' "$test_root/health"

rm "$TEST_FAILURE_FILE"
sh "$script_dir/backup.sh" > "$test_root/output" 2>&1
[ ! -e "$BACKUP_DIR/.last-failure" ]
sh "$script_dir/backup-health.sh" > "$test_root/health" 2>&1
echo 'backup retry tests passed'
