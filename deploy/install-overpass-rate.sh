#!/bin/bash
set -euo pipefail
chmod 600 /tmp/rota.pem
scp -i /tmp/rota.pem -o BatchMode=yes -P 22 /tmp/overpass-rate.sh ubuntu@10.77.0.3:/tmp/overpass-rate.sh
ssh -i /tmp/rota.pem -o BatchMode=yes -o ConnectTimeout=8 ubuntu@10.77.0.3 "sed -i 's/\r$//' /tmp/overpass-rate.sh && sudo install -m 755 /tmp/overpass-rate.sh /usr/local/sbin/overpass-rate.sh && sudo tee /etc/cron.d/overpass-rate >/dev/null << 'EOF'
15 * * * * root /usr/local/sbin/overpass-rate.sh >> /var/log/overpass-rate.log 2>&1
EOF
sudo rm -f /tmp/overpass-rate.sh && sudo /usr/local/sbin/overpass-rate.sh && echo cron-ok"
rm -f /tmp/rota.pem /tmp/overpass-rate.sh
