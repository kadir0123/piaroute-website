#!/bin/bash
set -euo pipefail
avail_kb=$(df -P / | awk 'NR==2 {print $4}')
if [ "$avail_kb" -lt 8000000 ]; then
  echo "disk-low"
  exit 0
fi
if docker exec osm-tiles pgrep -f "render_list -m default" >/dev/null 2>&1; then
  echo "already-running"
  exit 0
fi
python3 /usr/local/sbin/piaroute-tile-preseed.py | docker exec -i osm-tiles render_list -m default -n 1 -l 2
echo "preseed-done"
