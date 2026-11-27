#!/bin/bash
set -euo pipefail
chmod 600 /tmp/rota.pem
ssh -i /tmp/rota.pem -o BatchMode=yes -o ConnectTimeout=8 ubuntu@10.77.0.3 "sudo timeout 20 docker exec overpass grep -n -E 'OVERPASS_RATE_LIMIT|OVERPASS_TIME|OVERPASS_SPACE' /app/docker-entrypoint.sh"
rm -f /tmp/rota.pem
