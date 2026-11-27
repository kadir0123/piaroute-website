#!/bin/bash
set -euo pipefail
echo "=== before ==="
sudo -u postgres psql -d piaroute -v ON_ERROR_STOP=1 -At << 'SQL'
SELECT 'reports ' || count(*) FROM reports
UNION ALL
SELECT 'confirmations ' || count(*) FROM report_confirmations;
SQL
sudo -u postgres psql -d piaroute -v ON_ERROR_STOP=1 -At -c "COPY (SELECT photo_path FROM reports WHERE photo_path IS NOT NULL AND photo_path <> '') TO STDOUT" > /tmp/report-photos.list
chmod 600 /tmp/report-photos.list
removed=0
while IFS= read -r name || [ -n "$name" ]; do
  base=$(basename -- "$name")
  if [[ "$base" =~ ^[A-Za-z0-9._-]+$ ]] && [ -f "/var/lib/piaroute/photos/$base" ]; then
    rm -f "/var/lib/piaroute/photos/$base"
    removed=$((removed + 1))
  fi
done < /tmp/report-photos.list
rm -f /tmp/report-photos.list
sudo -u postgres psql -d piaroute -v ON_ERROR_STOP=1 << 'SQL'
BEGIN;
DELETE FROM report_confirmations;
DELETE FROM reports;
COMMIT;
SQL
echo "photos-removed $removed"
echo "=== after ==="
sudo -u postgres psql -d piaroute -v ON_ERROR_STOP=1 -At << 'SQL'
SELECT 'reports ' || count(*) FROM reports
UNION ALL
SELECT 'confirmations ' || count(*) FROM report_confirmations
UNION ALL
SELECT 'users ' || count(*) FROM app_users;
SQL
