#!/bin/bash
set -euo pipefail
wg show | awk '{
  if ($1=="peer:" || $1=="endpoint:" || $1=="allowed" || $1=="interface:" || $1=="listening") print
}'
echo "--- status ---"
curl -s -m 8 http://10.77.0.3:8080/overpass/api/status | head -n 40
echo
echo "--- listen on gateway ---"
curl -s -m 5 -D - -o /dev/null http://10.77.0.3:8080/ | head -n 15
