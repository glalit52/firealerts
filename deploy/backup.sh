#!/usr/bin/env sh
# Dump the PostgreSQL database of the compose stack to a compressed, timestamped file.
#   deploy/backup.sh [output-dir]          (default ./backups, keeps the newest 14)
# Restore with deploy/restore.sh <file>.
set -eu
cd "$(dirname "$0")/.."
out="${1:-backups}"
keep="${BACKUP_KEEP:-14}"
mkdir -p "$out"
file="$out/firealerts-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
docker compose exec -T db pg_dump -U firealerts -d firealerts --no-owner --clean --if-exists | gzip > "$file.part"
mv "$file.part" "$file"
echo "wrote $file ($(du -h "$file" | cut -f1))"
ls -1t "$out"/firealerts-*.sql.gz | tail -n +"$((keep + 1))" | while read -r old; do rm -f -- "$old"; done
