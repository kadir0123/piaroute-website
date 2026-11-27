#!/bin/bash
set -euo pipefail
umask 077
if [ ! -s /etc/piaroute-edge.secret ]; then
  openssl rand -hex 32 > /etc/piaroute-edge.secret
fi
chmod 600 /etc/piaroute-edge.secret
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y libnginx-mod-http-perl
install -d -m 755 /etc/nginx/snippets
cat > /etc/nginx/conf.d/edge-mint.conf << 'EOF'
perl_set $edge_expires 'sub { return (int(time() / 3600) + 1) * 3600; }';
perl_set $edge_md5 'sub {
    use Digest::MD5 qw(md5);
    use MIME::Base64 qw(encode_base64);
    my $r = shift;
    my $e = (int(time() / 3600) + 1) * 3600;
    my $plain = $e . $r->variable("uri") . $r->variable("remote_addr") . " " . $r->variable("edge_secret");
    my $b = encode_base64(md5($plain), "");
    $b =~ tr|+\/|-_|;
    $b =~ s/=+\z//;
    return $b;
}';
EOF
python3 - << 'PY'
from pathlib import Path
secret = Path("/etc/piaroute-edge.secret").read_text().strip()
Path("/etc/nginx/snippets/edge-secret.conf").write_text(f'set $edge_secret "{secret}";\n')
Path("/etc/nginx/snippets/edge-secret.conf").chmod(0o600)
PY
cat > /etc/nginx/snippets/edge-redirect.conf << 'EOF'
set $edge_go "https://harita.piaroute.com/e/$edge_expires/$edge_md5$uri$is_args$args";
return 307 $edge_go;
EOF
chmod 600 /tmp/rota.pem
scp -i /tmp/rota.pem -o BatchMode=yes /etc/piaroute-edge.secret ubuntu@10.77.0.3:/tmp/edge.secret
scp -i /tmp/rota.pem -o BatchMode=yes /tmp/harita.conf.tpl /tmp/harita-guard.conf /tmp/harita-limits.conf /tmp/setup-rota.sh ubuntu@10.77.0.3:/tmp/
ssh -i /tmp/rota.pem -o BatchMode=yes ubuntu@10.77.0.3 "sed -i 's/\r$//' /tmp/setup-rota.sh /tmp/harita.conf.tpl /tmp/harita-guard.conf /tmp/harita-limits.conf && sudo bash /tmp/setup-rota.sh"
echo "=== direct checks ==="
python3 - << 'PY'
import base64, hashlib, socket, time, urllib.request
from pathlib import Path
secret = Path("/etc/piaroute-edge.secret").read_text().strip()
src = "38.210.77.96"
exp = (int(time.time()) // 3600 + 1) * 3600
uri = "/tile/12/2412/1550.png"
plain = f"{exp}{uri}{src} {secret}".encode()
sig = base64.urlsafe_b64encode(hashlib.md5(plain).digest()).decode().rstrip("=")
url = f"https://harita.piaroute.com/e/{exp}/{sig}{uri}"
def code(u):
    try:
        with urllib.request.urlopen(u, timeout=20) as r:
            body = r.read(16)
            return r.status, body[:8]
    except Exception as e:
        if hasattr(e, "code"):
            return e.code, b""
        return type(e).__name__, b""
print("signed", code(url))
print("unsigned", code("https://harita.piaroute.com/tile/12/2412/1550.png"))
PY
