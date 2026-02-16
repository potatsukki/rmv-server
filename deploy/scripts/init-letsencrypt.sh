#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${1:-rmvfabrication.app}"
EMAIL="${2:-}"

if [ -z "$EMAIL" ]; then
  echo "Usage: ./init-letsencrypt.sh <domain> <email>"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CERT_PATH="$DEPLOY_DIR/certbot/conf/live/$DOMAIN"
WEBROOT_PATH="$DEPLOY_DIR/certbot/www"

mkdir -p "$CERT_PATH"
mkdir -p "$WEBROOT_PATH"

if [ ! -f "$CERT_PATH/fullchain.pem" ] || [ ! -f "$CERT_PATH/privkey.pem" ]; then
  echo "Creating temporary self-signed certificate for $DOMAIN"
  openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
    -keyout "$CERT_PATH/privkey.pem" \
    -out "$CERT_PATH/fullchain.pem" \
    -subj "/CN=$DOMAIN"
fi

cd "$DEPLOY_DIR"

docker compose -f docker-compose.prod.yml up -d nginx

echo "Requesting Let's Encrypt certificate for $DOMAIN"
docker compose -f docker-compose.prod.yml run --rm certbot certonly \
  --webroot -w /var/www/certbot \
  -d "$DOMAIN" -d "www.$DOMAIN" \
  --email "$EMAIL" --agree-tos --no-eff-email --rsa-key-size 4096

echo "Reloading nginx"
docker compose -f docker-compose.prod.yml exec nginx nginx -s reload

echo "Done. HTTPS is now configured for $DOMAIN"
