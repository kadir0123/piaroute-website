#!/bin/bash
set -euo pipefail
echo "disk"
df -h / | awk 'NR==1 || NR==2 {print}'
echo "photos"
du -sh /var/lib/piaroute/photos 2>/dev/null || true
find /var/lib/piaroute/photos -type f | wc -l
echo "db"
sudo -u postgres psql -d piaroute -c "SELECT pg_size_pretty(pg_database_size('piaroute')) AS db;"
sudo -u postgres psql -d piaroute -c "SELECT relname, pg_size_pretty(pg_total_relation_size(oid)) AS size FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace ORDER BY pg_total_relation_size(oid) DESC LIMIT 8;"
echo "cron"
crontab -l 2>/dev/null || echo "root-cron-empty"
ls -d /var/backups /var/lib/piaroute/backups 2>/dev/null || echo "no-backup-dir"
echo "timers"
systemctl list-timers --all --no-pager | awk 'NR==1 || /backup|postgres|piaroute/ {print}'
