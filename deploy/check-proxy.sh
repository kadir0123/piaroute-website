#!/bin/bash
set -euo pipefail
awk '/location \/osrm-car\/|location \/osrm-bike\/|location \/osrm-foot\/|location \/nominatim\/|location \/overpass\/|location \/tile\//,/^    }/' /etc/nginx/sites-enabled/piaroute
echo "--- limits ---"
cat /etc/nginx/conf.d/piaroute-limits.conf
