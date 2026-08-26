# Builds and deploys the Frostfire Forge mesh test stack to a local Docker Swarm.
#
# Usage (from anywhere):
#   pwsh -File src/docker/swarm-deploy.ps1
#
# Requires Docker Desktop to be running (the script waits for the daemon).

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$gatewayRoot = Join-Path (Split-Path $repoRoot -Parent) "Frostfire-Forge-Gateway"
$composeFile = Join-Path $repoRoot "src/docker/docker-compose.swarm.yml"
$envFile = Join-Path $repoRoot ".env.swarm"

if (-not (Test-Path -LiteralPath $envFile)) {
    throw ".env.swarm not found at repo root - it is created by default, see .env.swarm."
}
if (-not (Test-Path -LiteralPath (Join-Path $gatewayRoot "src/docker/Dockerfile.dev"))) {
    throw "Gateway repo not found at $gatewayRoot - cannot build the gateway image."
}

function Wait-DockerDaemon {
    Write-Host "Waiting for the Docker daemon (start Docker Desktop if this hangs)..."
    for ($i = 0; $i -lt 60; $i++) {
        docker info *> $null
        if ($LASTEXITCODE -eq 0) { Write-Host "Docker daemon is up."; return }
        Start-Sleep -Seconds 5
    }
    throw "Docker daemon is not reachable. Start Docker Desktop and retry."
}

Wait-DockerDaemon

Write-Host "== Building game server image (frostfire-forge-swarm:latest) =="
docker build -t frostfire-forge-swarm:latest -f "$repoRoot\src\docker\Dockerfile.swarm" "$repoRoot"
if ($LASTEXITCODE -ne 0) { throw "Game server image build failed" }

Write-Host "== Building gateway image (frostfire-gateway-swarm:latest) =="
docker build -t frostfire-gateway-swarm:latest -f "$gatewayRoot\src\docker\Dockerfile.dev" "$gatewayRoot"
if ($LASTEXITCODE -ne 0) { throw "Gateway image build failed" }

$swarmState = (docker info --format "{{.Swarm.LocalNodeState}}" 2>$null)
if ($swarmState -ne "active") {
    Write-Host "== Initializing Docker Swarm =="
    docker swarm init
    if ($LASTEXITCODE -ne 0) { throw "Failed to initialize Docker Swarm" }
} else {
    Write-Host "== Swarm already active =="
}

Write-Host "== Deploying stack 'forge-mesh' =="
docker stack deploy -c $composeFile forge-mesh
if ($LASTEXITCODE -ne 0) { throw "Stack deployment failed" }

Write-Host ""
Write-Host "Deployment requested. Services will come up as MySQL becomes ready."
Write-Host ""
Write-Host "Watch progress:"
Write-Host "  docker service ls"
Write-Host "  docker service logs -f forge-mesh_server-1"
Write-Host "  docker service logs -f forge-mesh_gateway"
Write-Host ""
Write-Host "Once all three servers log '[Mesh] Peer ... authenticated', run the mesh test:"
Write-Host "  bun --env-file=.env.swarm benchmark 90 --host http://localhost:8088 --simulation"
Write-Host ""
Write-Host "Check ghost replication on any server:"
Write-Host "  docker service logs forge-mesh_server-1 --since 1m | findstr Mesh"
