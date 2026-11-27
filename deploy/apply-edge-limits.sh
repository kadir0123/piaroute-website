#!/bin/bash
set -euo pipefail
python3 - << 'PY'
from pathlib import Path
limits = Path("/etc/nginx/conf.d/piaroute-limits.conf")
limits.write_text("""server_tokens off;
limit_req_zone $binary_remote_addr zone=piaroute_tile:10m rate=40r/s;
limit_req_zone $binary_remote_addr zone=piaroute_route:10m rate=1r/s;
limit_req_zone $binary_remote_addr zone=piaroute_search:10m rate=1r/s;
limit_req_zone $binary_remote_addr zone=piaroute_overpass:10m rate=6r/m;
limit_conn_zone $binary_remote_addr zone=piaroute_overpass_conn:10m;
limit_req_status 429;
""")
site = Path("/etc/nginx/sites-enabled/piaroute")
text = site.read_text()
text = text.replace("limit_req zone=piaroute_route burst=20 nodelay;", "limit_req zone=piaroute_route burst=6 nodelay;")
text = text.replace("limit_req zone=piaroute_search burst=12 nodelay;", "limit_req zone=piaroute_search burst=6 nodelay;")
text = text.replace(
    "limit_req zone=piaroute_overpass burst=8 nodelay;\n        proxy_pass http://10.77.0.3:8080/overpass/;",
    "limit_req zone=piaroute_overpass burst=3 nodelay;\n        limit_conn piaroute_overpass_conn 2;\n        client_max_body_size 16k;\n        proxy_pass http://10.77.0.3:8080/overpass/;",
)
text = text.replace("proxy_read_timeout 25s;", "proxy_read_timeout 15s;")
text = text.replace("limit_req zone=piaroute_tile burst=150 nodelay;", "limit_req zone=piaroute_tile burst=200 nodelay;")
text = text.replace("limit_req zone=piaroute_tile burst=60 nodelay;", "limit_req zone=piaroute_tile burst=200 nodelay;")
site.write_text(text)
PY
nginx -t
systemctl reload nginx
echo edge-ok
