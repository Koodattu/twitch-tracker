#!/bin/sh
set -eu

script_dir="$(CDPATH= cd "$(dirname "$0")" && pwd)"
. "$script_dir/backup-lib.sh"

load_backup_settings
backup_status
prune_backups
backup_status
