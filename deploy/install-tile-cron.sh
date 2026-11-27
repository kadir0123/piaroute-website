#!/bin/bash
set -euo pipefail
chmod 600 /tmp/map.pem
scp -i /tmp/map.pem -o BatchMode=yes /tmp/piaroute-tile-preseed.sh /tmp/piaroute-tile-preseed.cron ubuntu@10.77.0.2:/tmp/
ssh -i /tmp/map.pem -o BatchMode=yes ubuntu@10.77.0.2 "sed -i 's/\r$//' /tmp/piaroute-tile-preseed.sh /tmp/piaroute-tile-preseed.cron && sudo install -m 755 /tmp/piaroute-tile-preseed.sh /usr/local/sbin/piaroute-tile-preseed.sh && sudo install -m 644 /tmp/piaroute-tile-preseed.cron /etc/cron.d/piaroute-tile-preseed && sudo rm -f /tmp/piaroute-tile-preseed.sh /tmp/piaroute-tile-preseed.cron && echo '--- cron ---' && sudo cat /etc/cron.d/piaroute-tile-preseed && echo '--- script ---' && test -f /usr/local/sbin/piaroute-tile-preseed.py && echo generator-ok && sudo docker exec osm-tiles pgrep -a -f 'render_list -m default' || echo not-running"
rm -f /tmp/map.pem
