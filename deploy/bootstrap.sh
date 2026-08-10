#!/usr/bin/env bash
#
# Idempotent DuoLang deployment for a fresh Oracle Cloud VM (Ubuntu or Oracle Linux).
# Safe to re-run: every step checks its own state first, and an existing .env is
# never overwritten.
#
# Usage, on the target VM:
#   sudo bash bootstrap.sh duolang.longiq.xyz
#
# TLS is only attempted when the domain already resolves to this host's public IP,
# so it's fine to run before the DNS record exists and re-run afterwards.

set -euo pipefail

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  echo "usage: sudo bash bootstrap.sh <domain>" >&2
  exit 1
fi

REPO_URL="${REPO_URL:-https://github.com/longiq/duo_lang.git}"
APP_DIR=/opt/duolang
APP_USER=duolang

if [ "$(id -u)" -ne 0 ]; then
  echo "must run as root (use sudo)" >&2
  exit 1
fi

log() { printf '\n== %s\n' "$*"; }

# --- package manager -------------------------------------------------------
if command -v apt-get >/dev/null 2>&1; then
  PKG=apt
elif command -v dnf >/dev/null 2>&1; then
  PKG=dnf
else
  echo "no supported package manager (need apt-get or dnf)" >&2
  exit 1
fi

# --- swap (these VMs ship with 1GB RAM and no swap) ------------------------
log "swap"
if [ -f /swapfile ] || swapon --show --noheadings | grep -q .; then
  echo "swap already present, skipping"
else
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  echo "1G swapfile created"
fi

# --- packages --------------------------------------------------------------
log "packages"
if ! command -v node >/dev/null 2>&1; then
  if [ "$PKG" = apt ]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
  else
    dnf module install -y nodejs:20
  fi
fi
for p in nginx certbot git; do
  command -v "$p" >/dev/null 2>&1 && continue
  if [ "$PKG" = apt ]; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y nginx certbot python3-certbot-nginx
  else
    dnf install -y nginx certbot python3-certbot-nginx git
  fi
  break
done
echo "node $(node --version), nginx $(nginx -v 2>&1 | sed 's/.*\///')"

# --- firewall: open 80/443 ------------------------------------------------
# Oracle images ship an iptables INPUT chain ending in REJECT, so new ACCEPT
# rules must be inserted above it rather than appended.
log "firewall"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  echo "ufw rules ensured"
fi
if command -v iptables >/dev/null 2>&1; then
  reject_line=$(iptables -L INPUT -n --line-numbers | awk '$2=="REJECT"{print $1; exit}')
  for port in 80 443; do
    if iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
      echo "iptables: port $port already allowed"
    elif [ -n "$reject_line" ]; then
      iptables -I INPUT "$reject_line" -p tcp --dport "$port" -j ACCEPT
      echo "iptables: inserted allow for $port above REJECT"
    else
      iptables -A INPUT -p tcp --dport "$port" -j ACCEPT
      echo "iptables: appended allow for $port"
    fi
  done
  # Persist if the host has a mechanism for it; harmless when it doesn't.
  netfilter-persistent save >/dev/null 2>&1 || service iptables save >/dev/null 2>&1 || \
    echo "note: no iptables persistence tool found; rules may not survive reboot"
fi
echo "reminder: Oracle Cloud also needs ingress rules for 80/443 in the VCN security list"

# --- app user and code ----------------------------------------------------
log "app code"
id "$APP_USER" >/dev/null 2>&1 || useradd -r -m -s /usr/sbin/nologin "$APP_USER"
git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true

if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch origin
  # This is a deployment checkout with no local work, so match origin exactly.
  git -C "$APP_DIR" reset --hard origin/main
else
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund
echo "at $(git log --oneline -1)"

# --- environment file -----------------------------------------------------
log "environment"
if [ -f "$APP_DIR/.env" ]; then
  echo ".env exists, leaving untouched"
else
  cat >"$APP_DIR/.env" <<'ENVEOF'
GEMINI_API_KEY=REPLACE_ME
GEMINI_MODEL=gemini-2.0-flash
PORT=3000
HOST=127.0.0.1
ENVEOF
  echo ".env created with a placeholder key -- edit it before the app can translate"
fi
chown root:"$APP_USER" "$APP_DIR/.env"
chmod 640 "$APP_DIR/.env"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
chown root:"$APP_USER" "$APP_DIR/.env"

# --- systemd --------------------------------------------------------------
log "systemd"
cp "$APP_DIR/deploy/duolang.service" /etc/systemd/system/duolang.service
systemctl daemon-reload
systemctl enable duolang >/dev/null 2>&1
systemctl restart duolang
sleep 2
systemctl is-active duolang

# --- nginx ----------------------------------------------------------------
log "nginx"
if [ -d /etc/nginx/sites-available ]; then
  site=/etc/nginx/sites-available/duolang
  link=/etc/nginx/sites-enabled/duolang
else
  # Oracle Linux nginx has no sites-available; use conf.d instead.
  site=/etc/nginx/conf.d/duolang.conf
  link=""
fi

# Never clobber an existing config: certbot rewrites it in place to add the TLS
# listener, so overwriting with the plain-HTTP template would silently take
# HTTPS down on every re-run.
if [ -f "$site" ]; then
  echo "$site already exists, leaving untouched"
  if ! diff -q <(sed "s/YOUR_DOMAIN/$DOMAIN/" "$APP_DIR/deploy/nginx.conf") "$site" >/dev/null 2>&1; then
    echo "note: it differs from deploy/nginx.conf (expected once certbot has edited it)."
    echo "      To adopt template changes: back up $site, delete it, re-run this script,"
    echo "      then re-run certbot to restore TLS."
  fi
else
  sed "s/YOUR_DOMAIN/$DOMAIN/" "$APP_DIR/deploy/nginx.conf" >"$site"
  echo "wrote $site"
fi
[ -n "$link" ] && ln -sfn "$site" "$link"
nginx -t
systemctl enable nginx >/dev/null 2>&1 || true
systemctl reload nginx 2>/dev/null || systemctl start nginx

# --- TLS ------------------------------------------------------------------
log "tls"
public_ip=$(curl -s -4 --max-time 10 ifconfig.me || true)
resolved=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)
if [ -z "$resolved" ]; then
  echo "SKIP: $DOMAIN does not resolve yet."
  echo "      Add an A record -> ${public_ip:-this host}, then re-run this script."
elif [ -n "$public_ip" ] && [ "$resolved" != "$public_ip" ]; then
  echo "SKIP: $DOMAIN resolves to $resolved but this host is $public_ip."
  echo "      Fix DNS, then re-run this script."
elif [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  echo "certificate already present for $DOMAIN"
else
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
    --register-unsafely-without-email --redirect
fi

log "done"
echo "app:   https://$DOMAIN"
echo "logs:  journalctl -u duolang -f"
echo "check: systemctl status duolang"
if grep -q 'REPLACE_ME' "$APP_DIR/.env"; then
  echo
  echo "ACTION REQUIRED: put a real Gemini API key in $APP_DIR/.env, then:"
  echo "  sudo systemctl restart duolang"
fi
