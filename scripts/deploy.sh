#!/usr/bin/env bash
# Deploy ke VPS Ubuntu (24 jam via pm2). Jalankan dari laptop: bash scripts/deploy.sh root@37.60.232.191
# Butuh: ssh + scp (Git Bash OK). Password ditanya 2x (scp lalu ssh). Upload: kode + .env lokal (DNS_PINS dikosongkan — hanya perlu di Indonesia).
set -euo pipefail
TARGET="${1:?pakai: bash scripts/deploy.sh user@host}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
tar czf "$TMP/app.tgz" -C "$DIR" --exclude=node_modules --exclude=.git --exclude=launches.jsonl --exclude=.env .
sed 's/^DNS_PINS=.*/DNS_PINS=/' "$DIR/.env" > "$TMP/.env"
ssh "$TARGET" "mkdir -p /opt/launch-bot"
scp "$TMP/app.tgz" "$TMP/.env" "$TARGET:/opt/launch-bot/"
rm -rf "$TMP"
ssh "$TARGET" bash -s <<'EOF'
set -e
cd /opt/launch-bot && chmod 600 .env
tar xzf app.tgz && rm app.tgz
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs >/dev/null 2>&1
fi
echo "node $(node -v)"
npm install --omit=dev --no-audit --no-fund 2>&1 | tail -1
command -v pm2 >/dev/null || npm i -g pm2 >/dev/null 2>&1
pm2 delete launch-bot >/dev/null 2>&1 || true
pm2 start src/index.js --name launch-bot --time
pm2 save >/dev/null
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
sleep 6
pm2 logs launch-bot --nostream --lines 15
EOF
