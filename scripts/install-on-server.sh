#!/usr/bin/env bash
# Install Serverboy on an Ubuntu/Debian server as a systemd service, published with HTTPS
# (Nginx + Let's Encrypt) so you can open it from your phone anywhere.
#
# One command, no domain needed (uses a free <ip>.sslip.io address):
#   curl -fsSL https://raw.githubusercontent.com/gaurav-swarnkar/serverboy/ccr-af56e66b-azkhkc/scripts/install-on-server.sh | sudo bash
#
# Or from a checkout:   sudo bash scripts/install-on-server.sh [domain|auto|none] [email]
#   auto (default)  use <public-ip>.sslip.io, which needs no DNS setup
#   none            only listen on 127.0.0.1 (reach it through an SSH tunnel)
# Private repo: set SERVERBOY_REPO=https://<token>@github.com/gaurav-swarnkar/serverboy.git
set -euo pipefail

DOMAIN="${1:-auto}"
EMAIL="${2:-}"
REPO="${SERVERBOY_REPO:-https://github.com/gaurav-swarnkar/serverboy.git}"
APP_DIR=/opt/serverboy
DATA_DIR=/var/lib/serverboy
ENV_FILE=/etc/serverboy.env
PORT=3000

if [ "$(id -u)" -ne 0 ]; then echo "Please run with sudo."; exit 1; fi

export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a

# Use the checkout this script lives in, or download the code when run through curl | bash.
SRC_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "$(dirname "${BASH_SOURCE[0]}")/../server.js" ]; then
  SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
else
  echo "==> Downloading Serverboy"
  command -v git >/dev/null || { apt-get update -y && apt-get install -y git; }
  SRC_DIR="$(mktemp -d)"
  trap 'rm -rf "$SRC_DIR"' EXIT
  if ! GIT_TERMINAL_PROMPT=0 git clone -q --depth 1 "$REPO" "$SRC_DIR"; then
    echo "Could not download $REPO."
    echo "If the repository is private, make it public or set SERVERBOY_REPO with a token (see README)."
    exit 1
  fi
fi

if [ "$DOMAIN" = "auto" ]; then
  # Azure metadata service first (no internet needed), then a public lookup.
  IP="$(curl -fs -m 5 -H Metadata:true 'http://169.254.169.254/metadata/instance/network/interface/0/ipv4/ipAddress/0/publicIpAddress?api-version=2021-02-01&format=text' || true)"
  [ -n "$IP" ] || IP="$(curl -4 -fs -m 10 https://api.ipify.org || true)"
  if ! [[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then echo "Could not detect this server's public IP. Pass a domain instead."; exit 1; fi
  DOMAIN="${IP//./-}.sslip.io"
  echo "==> Using free address $DOMAIN (sslip.io points it at $IP)"
elif [ "$DOMAIN" = "none" ]; then
  DOMAIN=""
fi
if [ -n "$DOMAIN" ] && ! [[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then echo "Invalid domain: $DOMAIN"; exit 1; fi

echo "==> Installing system packages"
apt-get update -y
apt-get install -y curl ca-certificates rsync
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "==> Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
NODE_BIN="$(command -v node)"

echo "==> Copying Serverboy to $APP_DIR"
id serverboy >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin serverboy
mkdir -p "$APP_DIR" "$DATA_DIR"
rsync -a --delete --exclude node_modules --exclude data --exclude .git --exclude .env "$SRC_DIR/" "$APP_DIR/"
(cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund)
chown -R root:root "$APP_DIR"
# The service user must be able to read the code (a mktemp source dir is 0700).
chmod -R u=rwX,go=rX "$APP_DIR"
chown -R serverboy:serverboy "$DATA_DIR"
chmod 700 "$DATA_DIR"

HTTPS_OK=0
if [ ! -f "$ENV_FILE" ]; then
  NEW_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 16)"
  cat > "$ENV_FILE" <<EOF
HOST=127.0.0.1
PORT=$PORT
DATA_DIR=$DATA_DIR
TRUST_PROXY=1
ADMIN_PASSWORD=$NEW_PASSWORD
EOF
  chmod 600 "$ENV_FILE"
fi

echo "==> Creating systemd service"
cat > /etc/systemd/system/serverboy.service <<EOF
[Unit]
Description=Serverboy server control panel
After=network-online.target
Wants=network-online.target

[Service]
User=serverboy
Group=serverboy
EnvironmentFile=$ENV_FILE
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN $APP_DIR/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable serverboy >/dev/null
systemctl restart serverboy

if [ -n "$DOMAIN" ]; then
  echo "==> Publishing on $DOMAIN with Nginx"
  apt-get install -y nginx
  cat > "/etc/nginx/sites-available/$DOMAIN" <<EOF
# Serverboy control panel (installed by scripts/install-on-server.sh)
server {
    listen 80;
    server_name $DOMAIN;
    client_max_body_size 1024M;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600s;
    }
}
EOF
  ln -sf "/etc/nginx/sites-available/$DOMAIN" "/etc/nginx/sites-enabled/$DOMAIN"
  nginx -t
  systemctl reload nginx || systemctl restart nginx
  if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow 'Nginx Full' >/dev/null; fi

  echo "==> Getting a free HTTPS certificate"
  apt-get install -y certbot python3-certbot-nginx
  if [ -n "$EMAIL" ]; then CERT_EMAIL=(-m "$EMAIL"); else CERT_EMAIL=(--register-unsafely-without-email); fi
  if certbot --nginx --non-interactive --agree-tos --redirect "${CERT_EMAIL[@]}" -d "$DOMAIN"; then
    HTTPS_OK=1
  else
    echo "Certificate request failed. Usually port 80 is not open in the Azure Network Security Group."
  fi
fi

echo
echo "=================================================================="
echo " Serverboy is installed and running (systemctl status serverboy)"
if [ -n "$DOMAIN" ] && [ "$HTTPS_OK" = 1 ]; then
  echo " Open on any device:  https://$DOMAIN"
elif [ -n "$DOMAIN" ]; then
  echo " HTTPS is NOT set up yet, so do not log in over plain http."
  echo " Open ports 80 and 443 in Azure (VM > Networking), then run this installer again."
else
  echo " Listening on 127.0.0.1:$PORT only. From your computer run:"
  echo "   ssh -L 3000:127.0.0.1:3000 <user>@<server-ip>"
  echo " and open http://127.0.0.1:3000"
fi
echo " Admin password: $(grep '^ADMIN_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)"
echo "   (if you changed it under Settings, use your new one instead)"
echo " Inside Serverboy, add this same server with host 127.0.0.1."
echo "=================================================================="
