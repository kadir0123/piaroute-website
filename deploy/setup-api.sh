#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y postgresql postgresql-contrib nodejs npm

systemctl enable --now postgresql

if ! id piaroute >/dev/null 2>&1; then
  useradd --system --home /opt/piaroute-api --shell /usr/sbin/nologin piaroute
fi

install -d -o piaroute -g piaroute /opt/piaroute-api
install -m 644 -o piaroute -g piaroute /root/server.js /opt/piaroute-api/server.js

cat > /opt/piaroute-api/package.json <<'EOF'
{
  "name": "piaroute-api",
  "private": true,
  "dependencies": { "pg": "^8.13.1", "nodemailer": "^6.9.16" }
}
EOF
chown piaroute:piaroute /opt/piaroute-api/package.json
sudo -u piaroute npm install --prefix /opt/piaroute-api --omit=dev

DBPASS="$(openssl rand -hex 24)"
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'piaroute') THEN
    CREATE ROLE piaroute LOGIN PASSWORD '${DBPASS}';
  ELSE
    ALTER ROLE piaroute WITH LOGIN PASSWORD '${DBPASS}';
  END IF;
END
\$\$;
SQL

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = 'piaroute'" | grep -q 1; then
  sudo -u postgres createdb -O piaroute piaroute
fi

install -m 644 /root/schema.sql /tmp/piaroute-schema.sql
sudo -u postgres psql -d piaroute -v ON_ERROR_STOP=1 -f /tmp/piaroute-schema.sql
rm -f /tmp/piaroute-schema.sql
sudo -u postgres psql -d piaroute -v ON_ERROR_STOP=1 -c "GRANT ALL PRIVILEGES ON TABLE applications TO piaroute;"

umask 077
cat > /etc/piaroute-api.env <<EOF
DATABASE_URL=postgres://piaroute:${DBPASS}@127.0.0.1:5432/piaroute
IP_HASH_SALT=$(openssl rand -hex 32)
ALLOWED_ORIGINS=http://38.210.77.96,https://www.piaroute.com,https://piaroute.com,http://www.piaroute.com,http://piaroute.com
NODE_ENV=production
EOF
chown root:piaroute /etc/piaroute-api.env
chmod 640 /etc/piaroute-api.env

cat > /etc/systemd/system/piaroute-api.service <<'EOF'
[Unit]
Description=Piaroute waitlist API
After=network.target postgresql.service

[Service]
User=piaroute
Group=piaroute
WorkingDirectory=/opt/piaroute-api
EnvironmentFile=/etc/piaroute-api.env
ExecStart=/usr/bin/node /opt/piaroute-api/server.js
Restart=on-failure
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now piaroute-api

cat > /etc/nginx/sites-available/piaroute <<'EOF'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    root /var/www/html;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        try_files $uri $uri/ =404;
    }
}
EOF

ln -sfn /etc/nginx/sites-available/piaroute /etc/nginx/sites-enabled/piaroute
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

sleep 1
curl -fsS http://127.0.0.1/api/health
echo
curl -fsS -X POST http://127.0.0.1/api/apply \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://38.210.77.96' \
  -d '{"email":"kurulum-test@piaroute.local","privacy_ok":true}'
echo
sudo -u postgres psql -d piaroute -c "DELETE FROM applications WHERE email = 'kurulum-test@piaroute.local';"
echo "API hazir"
