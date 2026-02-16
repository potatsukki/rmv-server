# Production Deployment (Nginx + Docker)

This project is deployed on a single VPS using Docker Compose.

## Server layout

- `/opt/rmv/rmv-server` - backend repo
- `/opt/rmv/rmv-web` - frontend repo
- `/opt/rmv/rmv-server/deploy/docker-compose.prod.yml` - stack definition

## One-time server bootstrap

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg git
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
```

Clone repos:

```bash
mkdir -p /opt/rmv
git clone https://github.com/potatsukki/rmv-server.git /opt/rmv/rmv-server
git clone https://github.com/potatsukki/rmv-web.git /opt/rmv/rmv-web
```

Create env file:

```bash
cp /opt/rmv/rmv-server/.env.production.example /opt/rmv/rmv-server/.env
# edit /opt/rmv/rmv-server/.env and fill required values
```

## Start stack

```bash
cd /opt/rmv/rmv-server/deploy
docker compose -f docker-compose.prod.yml up -d --build
```

## SSL certificate (Let's Encrypt)

After DNS A records point to the VPS, run:

```bash
cd /opt/rmv/rmv-server/deploy
chmod +x scripts/init-letsencrypt.sh
./scripts/init-letsencrypt.sh rmvfabrication.app you@example.com
```

## GitHub Actions secrets

Set these in BOTH repos (`rmv-server`, `rmv-web`):

- `VPS_HOST`
- `VPS_USERNAME`
- `VPS_PASSWORD`

Push to `main` triggers build + deploy.
