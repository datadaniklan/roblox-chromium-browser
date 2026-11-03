#!/bin/bash
# Installs (or updates) the Roblox browser render server on an Ubuntu host.
# Runs as its own system user under systemd with memory/CPU caps so it can't starve other services.
# Usage: API_KEY=... bash install.sh
set -euo pipefail

BASE=/opt/roblox-browser
PORT=3090
REPO=https://github.com/datadaniklan/roblox-chromium-browser.git

if ss -ltn "sport = :$PORT" | grep -q LISTEN && ! systemctl is-active --quiet roblox-browser; then
  echo "port $PORT is already used by something else" >&2
  exit 1
fi

id rbxbrowser >/dev/null 2>&1 || useradd --system --home-dir "$BASE" --shell /usr/sbin/nologin rbxbrowser

apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
  libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libxkbcommon0 libxcomposite1 \
  libxdamage1 libxfixes3 libxrandr2 libgbm1 libdrm2 libpango-1.0-0 libcairo2 libasound2t64 \
  fonts-liberation fonts-noto-color-emoji >/dev/null
apt-get clean

mkdir -p "$BASE"
if [ -d "$BASE/app/.git" ]; then
  # The checkout is owned by the service user, so tell git (running as root) to trust it
  git -c safe.directory="$BASE/app" -C "$BASE/app" pull -q --ff-only
else
  git clone -q "$REPO" "$BASE/app"
fi
cd "$BASE/app"
npm ci --omit=dev --no-audit --no-fund --loglevel=error

if ! ls "$BASE"/chrome/chrome-headless-shell/*/chrome-headless-shell-linux64/chrome-headless-shell >/dev/null 2>&1; then
  npx -y @puppeteer/browsers install chrome-headless-shell@stable --path "$BASE/chrome" >/dev/null
fi
CHROME=$(ls -d "$BASE"/chrome/chrome-headless-shell/*/chrome-headless-shell-linux64/chrome-headless-shell | tail -1)
chown -R rbxbrowser:rbxbrowser "$BASE"

if [ -n "${API_KEY:-}" ]; then
  umask 077
  cat > "$BASE/browser.env" <<EOF
PORT=$PORT
API_KEY=$API_KEY
HEADLESS=shell
CHROME_PATH=$CHROME
MAX_SESSIONS=8
EOF
  chown root:root "$BASE/browser.env"
fi
sed -i "s|^CHROME_PATH=.*|CHROME_PATH=$CHROME|" "$BASE/browser.env"
grep -q "^COOKIE_FILE=" "$BASE/browser.env" || echo "COOKIE_FILE=$BASE/data/shared-cookies.json" >> "$BASE/browser.env"
mkdir -p "$BASE/data/players"
# Cookie jars hold players' logins: only the service user may read them
chown -R rbxbrowser:rbxbrowser "$BASE/data"
chmod 700 "$BASE/data" "$BASE/data/players"

cat > /etc/systemd/system/roblox-browser.service <<EOF
[Unit]
Description=Roblox browser render server (headless Chromium)
After=network.target

[Service]
User=rbxbrowser
WorkingDirectory=$BASE/app
EnvironmentFile=$BASE/browser.env
ExecStart=/usr/bin/node server.mjs
Restart=always
RestartSec=3
# Stay out of Minecraft's way
Nice=10
MemoryMax=4G
CPUQuota=300%
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
# IPv4 only: Google captchas datacenter IPv6 ranges far more often
RestrictAddressFamilies=AF_INET AF_UNIX AF_NETLINK

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now roblox-browser >/dev/null 2>&1
systemctl restart roblox-browser
sleep 3
systemctl is-active roblox-browser
curl -s "http://127.0.0.1:$PORT/health"; echo
df -h / | tail -1
