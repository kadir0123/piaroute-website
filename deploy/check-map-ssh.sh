#!/bin/bash
set -euo pipefail
echo "--- key files ---"
find /root /home /opt /etc -name '*.pem' -o -name 'id_*' 2>/dev/null | awk '$0 !~ /proc/ {print}'
echo "--- ports ---"
for p in 22 4383 8080 80 443; do
  timeout 3 bash -c "echo >/dev/tcp/10.77.0.3/$p" 2>/dev/null && echo "10.77.0.3:$p open" || echo "10.77.0.3:$p closed"
  timeout 3 bash -c "echo >/dev/tcp/83.119.137.212/$p" 2>/dev/null && echo "public:$p open" || echo "public:$p closed"
done
