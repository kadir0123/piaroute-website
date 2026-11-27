#!/bin/bash
systemctl is-active piaroute-api
sudo -u postgres psql -d piaroute -tAc "select column_name from information_schema.columns where table_name = 'reports' and column_name in ('account_uid','firebase_uid') order by 1"
