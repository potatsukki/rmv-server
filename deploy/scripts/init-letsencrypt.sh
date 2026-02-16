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
CERTBOT_CONF_PATH="$DEPLOY_DIR/certbot/conf"
CERTBOT_WWW_PATH="$DEPLOY_DIR/certbot/www"
CERT_PATH="$CERTBOT_CONF_PATH/live/$DOMAIN"

mkdir -p "$CERT_PATH"
mkdir -p "$CERTBOT_WWW_PATH"

if [ ! -f "$CERT_PATH/fullchain.pem" ] || [ ! -f "$CERT_PATH/privkey.pem" ]; then
  echo "Creating temporary self-signed certificate for $DOMAIN"
  openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
    -keyout "$CERT_PATH/privkey.pem" \
    -out "$CERT_PATH/fullchain.pem" \
    -subj "/CN=$DOMAIN"
fi

cd "$DEPLOY_DIR"

docker compose -f docker-compose.prod.yml up -d nginx

if [ -f "$CERT_PATH/fullchain.pem" ]; then
  # Remove temporary self-signed cert so certbot can create a proper lineage.
  if openssl x509 -in "$CERT_PATH/fullchain.pem" -noout -issuer 2>/dev/null | grep -q "CN = $DOMAIN"; then
    echo "Removing temporary self-signed certificate for $DOMAIN"
    rm -rf "$CERT_PATH"
  fi
fi

echo "Requesting Let's Encrypt certificate for $DOMAIN"
# Use the certbot image directly so compose service entrypoint cannot override certonly.
docker run --rm \
  -v "$CERTBOT_CONF_PATH:/etc/letsencrypt" \
  -v "$CERTBOT_WWW_PATH:/var/www/certbot" \
  certbot/certbot certonly \
  --webroot -w /var/www/certbot \
  --cert-name "$DOMAIN" \
  -d "$DOMAIN" -d "www.$DOMAIN" \
  --email "$EMAIL" --agree-tos --no-eff-email --rsa-key-size 4096

if [ ! -e "$CERTBOT_CONF_PATH/live/$DOMAIN" ]; then
  latest_lineage="$(
    ls -1 "$CERTBOT_CONF_PATH/live" \
      | grep "^$DOMAIN" \
      | grep -v "selfsigned" \
      | sort \
      | tail -n 1 || true
  )"
  if [ -n "$latest_lineage" ]; then
    ln -sfn "$latest_lineage" "$CERTBOT_CONF_PATH/live/$DOMAIN"
  fi
fi

echo "Reloading nginx"
docker compose -f docker-compose.prod.yml exec -T nginx nginx -s reload

echo "Done. HTTPS is now configured for $DOMAIN"