#!/bin/bash
set -euo pipefail
install -d -m 755 /var/www/harita
install -m 600 /tmp/edge.secret /etc/piaroute-edge.secret
rm -f /tmp/edge.secret
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y certbot
install -m 644 /tmp/harita-limits.conf /etc/nginx/conf.d/harita-limits.conf
install -m 644 /tmp/harita-guard.conf /etc/nginx/snippets/harita-guard.conf
# Port 80 only until the certificate exists.
python3 - << 'PY'
from pathlib import Path
text = Path("/tmp/harita.conf.tpl").read_text()
block, _, _rest = text.partition("\nserver {\n    listen 443 ssl;")
Path("/etc/nginx/sites-available/harita").write_text(block)
PY
ln -sfn /etc/nginx/sites-available/harita /etc/nginx/sites-enabled/harita
nginx -t
systemctl reload nginx
if [ ! -f /etc/letsencrypt/live/harita.piaroute.com/fullchain.pem ]; then
  certbot certonly --webroot -w /var/www/harita -d harita.piaroute.com --non-interactive --agree-tos --register-unsafely-without-email
fi
python3 - << 'PY'
from pathlib import Path
secret = Path("/etc/piaroute-edge.secret").read_text().strip()
if len(secret) < 32:
    raise SystemExit("secret too short")
text = Path("/tmp/harita.conf.tpl").read_text().replace("__SECRET__", secret)
Path("/etc/nginx/sites-available/harita").write_text(text)
Path("/etc/nginx/sites-available/harita").chmod(0o640)
PY
nginx -t
systemctl reload nginx
rm -f /tmp/harita.conf.tpl /tmp/harita-guard.conf /tmp/harita-limits.conf /tmp/setup-rota.sh
echo rota-https-ready
