#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# Blue-Green Deploy Script
# Usage: ./blue-green-deploy.sh [api|web|both]
#
# Tracks api and web colors INDEPENDENTLY so deploying one service
# never disrupts the other.
#   /opt/rmv/.color-api   — "blue" or "green"
#   /opt/rmv/.color-web   — "blue" or "green"
# ═══════════════════════════════════════════════════════════════════

DEPLOY_DIR="/opt/rmv/rmv-server/deploy"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.prod.yml"
UPSTREAM_FILE="$DEPLOY_DIR/nginx/upstream.conf"
LOCK_FILE="/var/lock/rmv-deploy.lock"

TARGET="${1:-both}"  # api, web, or both

export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1

# ── Acquire exclusive deploy lock (prevents cross-repo races) ────
# Both rmv-server and rmv-web CI/CD call this script; flock ensures
# only one deploy runs at a time on the VPS.
exec 200>"$LOCK_FILE"
echo "Waiting for deploy lock..."
flock -w 600 200 || { echo "FATAL: another deploy is running (lock timeout after 600s)"; exit 1; }
echo "Deploy lock acquired."

# ── Read per-service active colors (AFTER lock to avoid stale reads) ─
read_color() {
  local file="/opt/rmv/.color-$1"
  if [ -f "$file" ]; then cat "$file"; else echo "none"; fi
}

flip_color() {
  if [ "$1" = "blue" ]; then echo "green"; else echo "blue"; fi
}

CUR_API=$(read_color api)
CUR_WEB=$(read_color web)

# Decide next color for whatever we're deploying
if [ "$TARGET" = "api" ]; then
  NEXT_API=$(flip_color "$CUR_API"); NEXT_WEB="$CUR_WEB"
elif [ "$TARGET" = "web" ]; then
  NEXT_API="$CUR_API"; NEXT_WEB=$(flip_color "$CUR_WEB")
else
  NEXT_API=$(flip_color "$CUR_API"); NEXT_WEB=$(flip_color "$CUR_WEB")
fi

echo "========== BLUE-GREEN DEPLOY =========="
echo "  Target : $TARGET"
echo "  API    : $CUR_API -> $NEXT_API"
echo "  Web    : $CUR_WEB -> $NEXT_WEB"
echo "========================================"

cd "$DEPLOY_DIR"

start_ts=$(date +%s)

deploy_service() {
  local service="$1"
  local image_ref="$2"

  if [ -n "$image_ref" ]; then
    echo "Pulling image for $service -> $image_ref"
    if docker pull "$image_ref"; then
      return 0
    fi
    echo "WARN: pull failed for $service, falling back to local build"
  fi

  echo "Building image for $service locally"
  docker compose -f "$COMPOSE_FILE" build "$service"
}

# ── Ensure nginx + certbot are running ───────────────────────────
docker compose -f "$COMPOSE_FILE" up -d nginx certbot 2>/dev/null

# ── Step 1: Pull or build images ─────────────────────────────────
echo ""
echo "[1/5] Preparing images..."
if [ "$TARGET" = "api" ] || [ "$TARGET" = "both" ]; then
  deploy_service "api-$NEXT_API" "${RMV_API_IMAGE:-}:${RMV_IMAGE_TAG:-}"
  if [ $? -ne 0 ]; then echo "FATAL: api-$NEXT_API build failed"; exit 1; fi
fi
if [ "$TARGET" = "web" ] || [ "$TARGET" = "both" ]; then
  deploy_service "web-$NEXT_WEB" "${RMV_WEB_IMAGE:-}:${RMV_IMAGE_TAG:-}"
  if [ $? -ne 0 ]; then echo "FATAL: web-$NEXT_WEB build failed"; exit 1; fi
fi
echo "Image preparation complete."

# ── Step 2: Start new containers ────────────────────────────────
echo ""
echo "[2/5] Starting new containers..."
if [ "$TARGET" = "api" ] || [ "$TARGET" = "both" ]; then
  docker compose -f "$COMPOSE_FILE" --profile "$NEXT_API" up -d --no-deps "api-$NEXT_API"
fi
if [ "$TARGET" = "web" ] || [ "$TARGET" = "both" ]; then
  docker compose -f "$COMPOSE_FILE" --profile "$NEXT_WEB" up -d --no-deps "web-$NEXT_WEB"
fi
echo "Containers started."

# ── Step 3: Health check ────────────────────────────────────────
echo ""
echo "[3/5] Health checking new containers..."

wait_healthy() {
  local container="$1" max="${2:-60}" i=1
  while [ "$i" -le "$max" ]; do
    local st
    st=$(docker inspect -f '{{.State.Health.Status}}' "$container" 2>/dev/null || echo "not-found")
    echo "  [$i/$max] $container -> $st"
    [ "$st" = "healthy" ] && return 0
    if [ "$st" = "unhealthy" ]; then
      echo "  FAILED: $container unhealthy"; docker logs --tail 20 "$container" 2>&1 || true; return 1
    fi
    sleep 3; i=$((i + 1))
  done
  echo "  TIMEOUT: $container"; docker logs --tail 20 "$container" 2>&1 || true; return 1
}

HEALTH_OK=true
if [ "$TARGET" = "api" ] || [ "$TARGET" = "both" ]; then
  wait_healthy "rmv-api-$NEXT_API" 60 || HEALTH_OK=false
fi
if [ "$TARGET" = "web" ] || [ "$TARGET" = "both" ]; then
  wait_healthy "rmv-web-$NEXT_WEB" 40 || HEALTH_OK=false
fi

if [ "$HEALTH_OK" != "true" ]; then
  echo ""
  echo "ROLLBACK: Health check failed — stopping new containers"
  [ "$TARGET" = "api" ] || [ "$TARGET" = "both" ] && docker stop "rmv-api-$NEXT_API" 2>/dev/null
  [ "$TARGET" = "web" ] || [ "$TARGET" = "both" ] && docker stop "rmv-web-$NEXT_WEB" 2>/dev/null
  exit 1
fi
echo "All new containers healthy!"

# ── Step 4: Switch nginx upstream (ZERO-DOWNTIME CUTOVER) ───────
echo ""
echo "[4/5] Switching nginx upstream..."

# Resolve colors for upstream (handle first-ever deploy where "none")
UP_API="$NEXT_API"
UP_WEB="$NEXT_WEB"
[ "$NEXT_API" = "none" ] && UP_API="$CUR_API"
[ "$NEXT_WEB" = "none" ] && UP_WEB="$CUR_WEB"

# Save backup of current upstream
cp "$UPSTREAM_FILE" "$UPSTREAM_FILE.bak" 2>/dev/null || true

UPSTREAM_CONTENT="# api=$UP_API  web=$UP_WEB  (switched at $(date -u +%Y-%m-%dT%H:%M:%SZ))
upstream api_upstream {
  server api-$UP_API:5000;
}

upstream web_upstream {
  server web-$UP_WEB:80;
}"

# Write to host file (persists across container restarts)
echo "$UPSTREAM_CONTENT" > "$UPSTREAM_FILE"

# Write directly into container (bypasses bind-mount inode issues)
echo "$UPSTREAM_CONTENT" | docker exec -i rmv-nginx tee /etc/nginx/conf.d/upstream.conf > /dev/null

# Config test
docker exec rmv-nginx nginx -t 2>&1
if [ $? -ne 0 ]; then
  echo "FATAL: nginx config test failed — rolling back"
  cp "$UPSTREAM_FILE.bak" "$UPSTREAM_FILE" 2>/dev/null || true
  docker exec rmv-nginx sh -c "cat /etc/nginx/conf.d/upstream.conf.bak > /etc/nginx/conf.d/upstream.conf" 2>/dev/null || \
    docker cp "$UPSTREAM_FILE" rmv-nginx:/etc/nginx/conf.d/upstream.conf 2>/dev/null || true
  [ "$TARGET" = "api" ] || [ "$TARGET" = "both" ] && docker stop "rmv-api-$NEXT_API" 2>/dev/null
  [ "$TARGET" = "web" ] || [ "$TARGET" = "both" ] && docker stop "rmv-web-$NEXT_WEB" 2>/dev/null
  exit 1
fi

docker exec rmv-nginx nginx -s reload
echo "Nginx reloaded — traffic switched!"

# ── Step 5: Stop OLD containers (only the ones we replaced) ─────
echo ""
echo "[5/5] Cleaning up old containers..."
sleep 5  # Let in-flight requests finish

if [ "$TARGET" = "api" ] || [ "$TARGET" = "both" ]; then
  if [ "$CUR_API" != "none" ] && [ "$CUR_API" != "$NEXT_API" ]; then
    docker stop "rmv-api-$CUR_API" 2>/dev/null || true
    docker rm -f "rmv-api-$CUR_API" 2>/dev/null || true
    echo "Stopped api-$CUR_API"
  fi
fi
if [ "$TARGET" = "web" ] || [ "$TARGET" = "both" ]; then
  if [ "$CUR_WEB" != "none" ] && [ "$CUR_WEB" != "$NEXT_WEB" ]; then
    docker stop "rmv-web-$CUR_WEB" 2>/dev/null || true
    docker rm -f "rmv-web-$CUR_WEB" 2>/dev/null || true
    echo "Stopped web-$CUR_WEB"
  fi
fi

# Save new active colors
if [ "$TARGET" = "api" ] || [ "$TARGET" = "both" ]; then
  echo "$NEXT_API" > "/opt/rmv/.color-api"
fi
if [ "$TARGET" = "web" ] || [ "$TARGET" = "both" ]; then
  echo "$NEXT_WEB" > "/opt/rmv/.color-web"
fi

# Clean up backup + old containers.
# Do not prune images here: on a small VPS that destroys the layer cache and
# makes every subsequent blue-green deploy rebuild from scratch.
rm -f "$UPSTREAM_FILE.bak"
docker container prune -f 2>/dev/null || true

end_ts=$(date +%s)
elapsed=$((end_ts - start_ts))

echo ""
echo "========== DEPLOY COMPLETE =========="
echo "  API color: $(cat /opt/rmv/.color-api 2>/dev/null || echo none)"
echo "  Web color: $(cat /opt/rmv/.color-web 2>/dev/null || echo none)"
echo "  Duration : ${elapsed}s"
echo "  Running:"
docker ps --format '  {{.Names}}\t{{.Status}}' | grep rmv
echo "====================================="
exit 0
