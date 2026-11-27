#!/bin/bash
set -euo pipefail
chmod 600 /tmp/map.pem
ssh -i /tmp/map.pem -o BatchMode=yes -o ConnectTimeout=8 ubuntu@10.77.0.2 'sudo bash -s' << 'EOS'
set -euo pipefail
if docker exec osm-tiles pgrep -f render_list >/dev/null 2>&1; then
  echo already-running
  exit 0
fi
echo "38043 24569 16" | docker exec -i osm-tiles render_list -m default -n 1 -l 2
cat > /usr/local/sbin/piaroute-tile-preseed.py << 'PY'
import math
import sys

def y_of(lat, n):
    lr = math.radians(lat)
    return int((1 - math.log(math.tan(lr) + 1 / math.cos(lr)) / math.pi) / 2 * n)

def emit(west, south, east, north, z0, z1):
    for z in range(z0, z1 + 1):
        n = 2 ** z
        x0 = max(0, int((west + 180) / 360 * n))
        x1 = min(n - 1, int((east + 180) / 360 * n))
        y0 = max(0, y_of(north, n))
        y1 = min(n - 1, y_of(south, n))
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                sys.stdout.write(f"{x} {y} {z}\n")

emit(25.6, 35.6, 45.0, 42.3, 0, 14)
cities = [
    (28.4, 40.8, 29.6, 41.4),
    (32.4, 39.7, 33.2, 40.2),
    (26.8, 38.2, 27.4, 38.6),
    (28.7, 40.0, 29.4, 40.4),
    (30.4, 36.7, 31.0, 37.1),
]
for west, south, east, north in cities:
    emit(west, south, east, north, 15, 16)
PY
chmod 755 /usr/local/sbin/piaroute-tile-preseed.py
nohup bash -c 'python3 /usr/local/sbin/piaroute-tile-preseed.py | docker exec -i osm-tiles render_list -m default -n 1 -l 2' > /var/log/piaroute-tile-preseed.log 2>&1 &
sleep 2
echo started
docker exec osm-tiles pgrep -a -f render_list || echo not-seen
tail -n 5 /var/log/piaroute-tile-preseed.log || true
EOS
rm -f /tmp/map.pem
