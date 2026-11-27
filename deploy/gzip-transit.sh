#!/bin/bash
set -euo pipefail
if ! nginx -V 2>&1 | grep -q gzip_static; then
  echo "no-gzip-static"
  exit 1
fi
cd /var/www/html/transit-packs
for name in istanbul-iett.json izmir-metro.json izmir-tram.json konya.json; do
  gzip -9 -c "$name" > "$name.gz"
  chmod 644 "$name.gz"
done
ls -lh
python3 - << 'PY'
from pathlib import Path
p = Path("/etc/nginx/sites-enabled/piaroute")
text = p.read_text()
block = """    location /transit-packs/ {
        gzip_static on;
        gzip_vary on;
        add_header Cache-Control "public, max-age=86400";
    }

"""
if "location /transit-packs/" not in text:
    needle = "    location / {\n"
    if needle not in text:
        raise SystemExit("location missing")
    text = text.replace(needle, block + needle, 1)
    Path("/root/piaroute.nginx.bak").write_bytes(p.read_bytes())
    p.write_text(text)
print("config-ok")
PY
nginx -t
systemctl reload nginx
echo "=== headers ==="
curl -sI -m 15 -H 'Accept-Encoding: gzip' https://www.piaroute.com/transit-packs/istanbul-iett.json | awk 'BEGIN{IGNORECASE=1} /HTTP|content-type|content-encoding|content-length|vary/'
echo "=== sizes ==="
curl -s -m 20 -o /dev/null -w "istanbul-wire:%{size_download}\n" -H 'Accept-Encoding: gzip' https://www.piaroute.com/transit-packs/istanbul-iett.json
curl -s -m 20 -o /dev/null -w "konya-wire:%{size_download}\n" -H 'Accept-Encoding: gzip' https://www.piaroute.com/transit-packs/konya.json
curl -s -m 20 -o /dev/null -w "istanbul-plain:%{size_download}\n" -H 'Accept-Encoding: identity' https://www.piaroute.com/transit-packs/istanbul-iett.json
python3 - << 'PY'
import gzip
from pathlib import Path
raw = gzip.open("/var/www/html/transit-packs/istanbul-iett.json.gz", "rb").read(1)
print("json-start", raw)
PY
