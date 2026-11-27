#!/bin/bash
set -euo pipefail
mapfile -t databases < <(sudo -u postgres psql -d postgres -tAc "SELECT datname FROM pg_database WHERE datistemplate = false AND datallowconn")
for db in "${databases[@]}"; do
  sudo -u postgres psql -d "$db" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE row record;
BEGIN
  FOR row IN
    SELECT n.nspname AS schema_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE c.relname = 'reports'
      AND a.attname = 'firebase_uid'
      AND NOT a.attisdropped
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.reports RENAME COLUMN firebase_uid TO account_uid',
      row.schema_name
    );
  END LOOP;
  FOR row IN
    SELECT n.nspname AS schema_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE c.relname = 'reports'
      AND a.attname = 'firebase_id'
      AND NOT a.attisdropped
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.reports RENAME COLUMN firebase_id TO import_id',
      row.schema_name
    );
  END LOOP;
END $$;
SQL
done
systemctl restart piaroute-api
sleep 1
systemctl is-active piaroute-api
sudo -u postgres psql -d piaroute -tAc "SELECT table_schema || '.' || column_name FROM information_schema.columns WHERE table_name = 'reports' AND column_name IN ('account_uid','firebase_uid') ORDER BY 1"
