#!/bin/bash
set -eu
token=$(tr -d '\r\n' < /root/erasure-token)
if ! grep -q '^ERASURE_TOKEN=' /etc/piaroute-api.env; then
  printf 'ERASURE_TOKEN=%s\n' "$token" >> /etc/piaroute-api.env
fi
rm -f /root/erasure-token /root/set-erasure-token.sh
systemctl restart piaroute-api
systemctl is-active piaroute-api
