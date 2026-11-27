#!/bin/bash
set -euo pipefail
chmod 600 /tmp/rota.pem
ssh -i /tmp/rota.pem -o BatchMode=yes -o ConnectTimeout=8 ubuntu@10.77.0.3 "sudo sed -i 's/proxy_read_timeout 90s;/proxy_read_timeout 20s;/' /etc/nginx/sites-enabled/piaroute-rota && sudo nginx -t && sudo systemctl reload nginx && grep -n proxy_read_timeout /etc/nginx/sites-enabled/piaroute-rota"
rm -f /tmp/rota.pem
echo "=== bursts ==="
grep -n "limit_req zone" /etc/nginx/sites-enabled/piaroute
echo "=== status ==="
curl -s -m 8 http://10.77.0.3:8080/overpass/api/status | awk 'NR<=6 {print}'
