#!/bin/sh
# Deploys the 3-server mesh stack on a Linux host (native networking - no
# vpnkit relay, kernel-level port forwarding).
#
# Usage (from the repo root, on the Linux box):
#   sh src/docker/mesh-deploy-linux.sh
#
# What it does:
#   1. Builds the game server image from the local repo
#   2. Generates local TLS certs if src/certs is empty
#   3. Creates .env.production from the example if missing (EDIT IT afterwards)
#   4. Starts the three servers via docker compose
#
# Overrides: export any of these before running (or put them in a .env file
# next to this compose file - compose reads both):
#   PUBLIC_HOST               hostname/IP clients use to reach this box
#   DATABASE_HOST/NAME/USER/PASSWORD/PORT
#   GATEWAY_URL / GATEWAY_AUTH_KEY / GATEWAY_GAME_SERVER_SECRET
#   ASSET_SERVER_URL / ASSET_SERVER_PUBLIC_URL / ASSET_SERVER_AUTH_KEY
#   MESH_CLUSTER / MESH_SECRET
set -e

cd "$(dirname "$0")/../.."

echo "== Building game server image =="
docker build -t frostfire-forge-swarm:latest -f src/docker/Dockerfile.swarm .

if [ ! -f src/certs/cert.pem ] || [ ! -f src/certs/key.pem ]; then
  echo "== TLS certs missing - generating local certs =="
  if command -v bun >/dev/null 2>&1; then
    bun install
    bun generate-local-cert
  else
    echo "ERROR: bun is not installed and no certs found in src/certs/"
    echo "Either install bun and rerun, or copy cert.pem/key.pem/cert.ca-bundle"
    echo "from another machine into src/certs/."
    exit 1
  fi
fi

if [ ! -f .env.production ]; then
  cp .env.example .env.production
  echo "== Created .env.production from example - edit it with this box's DB/gateway values =="
fi

# Source the real production values so compose interpolation (${VAR:-default})
# uses THIS host's credentials instead of the built-in defaults.
set -a
. ./.env.production
set +a

if [ -z "$DATABASE_PASSWORD" ] || [ "$DATABASE_PASSWORD" = "your_secure_password" ]; then
  echo "ERROR: DATABASE_PASSWORD in .env.production is still the placeholder."
  echo "Edit .env.production with this host's real MySQL credentials and rerun."
  exit 1
fi

echo "== Starting mesh stack (host networking) =="
docker compose -f src/docker/docker-compose.mesh.linux.yml up -d

echo ""
echo "Check status:   docker compose -f src/docker/docker-compose.mesh.linux.yml ps"
echo "Watch logs:     docker compose -f src/docker/docker-compose.mesh.linux.yml logs -f server-1"
echo "Mesh status:    curl -k https://localhost:3000/mesh-status"
