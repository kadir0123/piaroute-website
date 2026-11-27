#!/bin/bash
set -euo pipefail
cp -a /etc/nginx/sites-enabled/piaroute /root/piaroute.nginx.bak
python3 - << 'PY'
from pathlib import Path
p = Path("/etc/nginx/sites-enabled/piaroute")
text = p.read_text()
needle = "server_name piaroute.com www.piaroute.com;\n"
insert = needle + "    include /etc/nginx/snippets/edge-secret.conf;\n"
if text.count(needle) < 1:
    raise SystemExit("server_name missing")
text = text.replace(needle, insert, 1)
blocks = {
"""        proxy_pass http://10.77.0.3:8080/osrm-car/;
        proxy_set_header Authorization "";
        proxy_set_header Cookie "";
        proxy_set_header X-Forwarded-For "";
        proxy_set_header X-Real-IP "";
""": "        include /etc/nginx/snippets/edge-redirect.conf;\n",
"""        proxy_pass http://10.77.0.3:8080/osrm-bike/;
        proxy_set_header Authorization "";
        proxy_set_header Cookie "";
        proxy_set_header X-Forwarded-For "";
        proxy_set_header X-Real-IP "";
""": "        include /etc/nginx/snippets/edge-redirect.conf;\n",
"""        proxy_pass http://10.77.0.3:8080/osrm-foot/;
        proxy_set_header Authorization "";
        proxy_set_header Cookie "";
        proxy_set_header X-Forwarded-For "";
        proxy_set_header X-Real-IP "";
""": "        include /etc/nginx/snippets/edge-redirect.conf;\n",
"""        proxy_pass http://10.77.0.3:8080/nominatim/;
        proxy_set_header Authorization "";
        proxy_set_header Cookie "";
        proxy_set_header X-Forwarded-For "";
        proxy_set_header X-Real-IP "";
""": "        include /etc/nginx/snippets/edge-redirect.conf;\n",
"""        proxy_pass http://10.77.0.3:8080/overpass/;
        proxy_set_header Authorization "";
        proxy_set_header Cookie "";
        proxy_set_header X-Forwarded-For "";
        proxy_set_header X-Real-IP "";
        proxy_read_timeout 15s;
""": "        include /etc/nginx/snippets/edge-redirect.conf;\n",
"""        proxy_pass http://10.77.0.2/tile/;
        proxy_set_header Authorization "";
        proxy_set_header Cookie "";
        proxy_set_header X-Forwarded-For "";
        proxy_set_header X-Real-IP "";
        proxy_set_header Host 83.119.129.42;
""": "        include /etc/nginx/snippets/edge-redirect.conf;\n",
}
for old, new in blocks.items():
    if old not in text:
        raise SystemExit("block missing")
    text = text.replace(old, new, 1)
if "10.77.0.3:8080" in text or "10.77.0.2/tile" in text:
    raise SystemExit("proxy left behind")
p.write_text(text)
print("patched")
PY
if ! nginx -t; then
  cp -a /root/piaroute.nginx.bak /etc/nginx/sites-enabled/piaroute
  echo "nginx-test-failed"
  exit 1
fi
systemctl reload nginx
python3 - << 'PY'
import urllib.request
checks = {
    "tile": "https://www.piaroute.com/tile/12/2412/1550.png",
    "route": "https://www.piaroute.com/osrm-car/nearest/v1/driving/32.85,39.92",
    "search": "https://www.piaroute.com/nominatim/search?q=Ankara&format=jsonv2&limit=1",
}
opener = urllib.request.build_opener(urllib.request.HTTPRedirectHandler)
for name, url in checks.items():
    try:
        with urllib.request.urlopen(url, timeout=25) as r:
            body = r.read(24)
            print(name, r.status, r.geturl().split("/")[2], body[:12])
    except Exception as e:
        print(name, getattr(e, "code", type(e).__name__))
req = urllib.request.Request(
    "https://www.piaroute.com/overpass/api/interpreter",
    data=b"data=[out:json][timeout:5];node(1);out;",
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=25) as r:
        print("overpass", r.status, r.geturl().split("/")[2], r.read(20)[:12])
except Exception as e:
    print("overpass", getattr(e, "code", type(e).__name__))
try:
    with urllib.request.urlopen("https://www.piaroute.com/", timeout=15) as r:
        print("home", r.status)
except Exception as e:
    print("home", getattr(e, "code", type(e).__name__))
PY
