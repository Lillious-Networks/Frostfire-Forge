#!/usr/bin/env bash
# Run a docker compose command against the cluster test stack on Docker Engine
# in the "ffcluster" WSL2 distro (see docker-compose.cluster.wsl.yml).
#
# From Windows (any shell), in the engine repo root:
#   wsl -d ffcluster -- bash src/docker/cluster-wsl.sh up -d --build
#   wsl -d ffcluster -- bash src/docker/cluster-wsl.sh ps
#   wsl -d ffcluster -- bash src/docker/cluster-wsl.sh down
#
# The WSL2 address changes when WSL restarts; this script reads it each time,
# so run `down` and `up` again after a reboot. The distro stops when no WSL
# session is attached, taking the stack with it: keep one open, for example
#   wsl -d ffcluster -u root -- sleep infinity
# Stop the Docker Desktop copy of
# the test stack first: both publish 127.0.0.1:18081 and the other TCP ports.
set -euo pipefail

cd "$(dirname "$0")/../.."
WSL_HOST_IP="$(hostname -I | awk '{print $1}')"
export WSL_HOST_IP
echo "cluster-wsl: nodes advertise ${WSL_HOST_IP}" >&2

exec docker compose \
  -f src/docker/docker-compose.cluster.yml \
  -f src/docker/docker-compose.cluster.wsl.yml \
  --env-file src/docker/cluster.env \
  "$@"
