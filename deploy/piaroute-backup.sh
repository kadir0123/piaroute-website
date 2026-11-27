#!/bin/bash
# Hesap, bildirim ve fotoğraf yedeği. Aynı diskte durur; sunucu giderse bu klasör de gider.
# İkinci kopya başka bir makinede tutulur.
set -euo pipefail
umask 077
root=/var/lib/piaroute/backups
stamp=$(date +%Y%m%d-%H%M)
day="$root/$stamp"
mkdir -p "$day"
sudo -u postgres pg_dump -Fc -d piaroute > "$day/piaroute.dump"
tar -C /var/lib/piaroute -cf "$day/photos.tar" photos
cp /etc/piaroute-api.env "$day/piaroute-api.env"
chmod 600 "$day/piaroute.dump" "$day/photos.tar" "$day/piaroute-api.env"
find "$root" -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +
echo "backup-ok $stamp"
if rsync -a --delete -e "ssh -i /root/.ssh/piaroute-backup -p 4383 -o BatchMode=yes" "$root/" root@104.249.8.168:; then
  echo "push-ok $stamp"
else
  echo "push-failed $stamp"
fi
