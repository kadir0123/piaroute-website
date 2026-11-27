#!/bin/bash
set -euo pipefail
echo "--- reach ---"
ip -4 route | awk '$1 ~ /^10\.77/ || $0 ~ /10\.77/ {print}'
echo "--- headers ---"
for u in \
  http://10.77.0.3:8080/overpass/api/interpreter \
  http://10.77.0.3:8080/nominatim/status \
  http://10.77.0.3:8080/osrm-car/nearest/v1/driving/30.5,39.7
 do
  code=$(curl -s -o /dev/null -m 8 -w '%{http_code}' "$u" || echo fail)
  echo "$code $u"
done
echo "--- ssh keys on this host ---"
ls /root/.ssh 2>/dev/null | awk '{print}'
