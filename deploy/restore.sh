#!/usr/bin/env sh
# Restore a dump written by deploy/backup.sh into the compose stack's database.
# The API and worker are stopped during the restore and started again afterwards.
set -eu
[ $# -eq 1 ] || { echo "usage: $0 <backup.sql.gz>" >&2; exit 2; }
file="$1"
cd "$(dirname "$0")/.."
docker compose stop api worker
gunzip -c "$file" | docker compose exec -T db psql -U firealerts -d firealerts -v ON_ERROR_STOP=1 -q
docker compose start api worker
echo "restored $file"
