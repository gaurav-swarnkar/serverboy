#!/usr/bin/env bash
# Install Serverboy on an Ubuntu/Debian server as a systemd service, optionally published
# on a domain with HTTPS (Nginx + Let's Encrypt) so you can open it from your phone anywhere.
#
# Run from the serverboy folder on the server:
#   sudo bash scripts/install-on-server.sh panel.example.com you@example.com
# Without a domain it only listens on 127.0.0.1 (reach it through an SSH tunnel).
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
APP_DIR=/opt/serverboy
DATA_DIR=/var/lib/serverboy
ENV_FILE=/etc/serverboy.env
PORT=3000
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "$(id -u)" -ne 0 ]; then echo "Please run with sudo."; exit 1; fi
if [ -n "$DOMAIN" ] && ! [[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then echo "Invalid domain: $DOMAIN"; exit 1; fi
if [ ! -f "$SRC_DIR/server.js" ]; then echo "Run this script from inside the serverboy folder."; exit 1; fi

export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a

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
chown -R serverboy:serverboy "$DATA_DIR"
chmod 700 "$DATA_DIR"

NEW_PASSWORD=""
if [ ! -f "$ENV_FILE" ]; then
  NEW_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 20)"
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

  if [ -n "$EMAIL" ]; then
    echo "==> Getting a free HTTPS certificate"
    apt-get install -y certbot python3-certbot-nginx
    certbot --nginx --non-interactive --agree-tos --redirect -m "$EMAIL" -d "$DOMAIN"
  fi
fi

echo
echo "=================================================================="
echo " Serverboy is installed and running (systemctl status serverboy)"
if [ -n "$DOMAIN" ] && [ -n "$EMAIL" ]; then
  echo " Open on any device:  https://$DOMAIN"
elif [ -n "$DOMAIN" ]; then
  echo " WARNING: no email given, so no HTTPS yet. Do not log in over plain http."
  echo " Get a certificate:  sudo certbot --nginx -d $DOMAIN"
else
  echo " Listening on 127.0.0.1:$PORT only. From your computer run:"
  echo "   ssh -L 3000:127.0.0.1:3000 <user>@<server-ip>"
  echo " and open http://127.0.0.1:3000"
fi
if [ -n "$NEW_PASSWORD" ]; then
  echo " Admin password: $NEW_PASSWORD"
else
  echo " Admin password: unchanged (see ADMIN_PASSWORD in $ENV_FILE)"
fi
echo " Inside Serverboy, add this same server with host 127.0.0.1."
echo "=================================================================="
