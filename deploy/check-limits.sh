#!/bin/bash
set -euo pipefail
echo "=== public nginx zones ==="
grep -n "zone=" /etc/nginx/conf.d/piaroute-limits.conf
echo "=== public overpass location ==="
awk '/location \/overpass\//,/^}/' /etc/nginx/sites-enabled/piaroute
echo "=== map timeout ==="
chmod 600 /tmp/rota.pem
ssh -i /tmp/rota.pem -o BatchMode=yes -o ConnectTimeout=8 ubuntu@10.77.0.3 "grep -n proxy_read_timeout /etc/nginx/sites-enabled/piaroute-rota; sudo docker exec overpass strings /app/bin/dispatcher | grep -F limit-client | head"
rm -f /tmp/rota.pem
echo "=== tile public ==="
curl -s -o /dev/null -m 4 -w "tile-public:%{http_code}\n" http://83.119.129.42/ || echo "tile-public:closed"
echo "=== tiny overpass ==="
curl -s -m 12 -o /tmp/ov.out -w "overpass:%{http_code}\n" --data '[out:json][timeout:5];node(1);out;' https://www.piaroute.com/overpass/api/interpreter
head -c 180 /tmp/ov.out; echo
rm -f /tmp/ov.out
