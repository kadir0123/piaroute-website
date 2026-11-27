#!/bin/bash
# Overpass 0.7.62 accepts --rate-limit and rejects --time and
# --limit-client-zero on this build (the process aborts).
set -euo pipefail
if sudo docker exec overpass grep -q 'OVERPASS_RATE_LIMIT=2' /app/bin/dispatcher_start.sh; then
  exit 0
fi
sudo docker exec -i overpass python3 - << 'PY'
from pathlib import Path
p = Path("/app/bin/dispatcher_start.sh")
text = p.read_text()
needle = "if [[ -n ${OVERPASS_RATE_LIMIT} ]]; then"
insert = """if [[ -z ${OVERPASS_RATE_LIMIT} ]]; then
	OVERPASS_RATE_LIMIT=2
fi

"""
if "OVERPASS_RATE_LIMIT=2" not in text:
    if needle not in text:
        raise SystemExit("start script shape changed")
    p.write_text(text.replace(needle, insert + needle, 1))
print("patched")
PY
sudo docker restart overpass
