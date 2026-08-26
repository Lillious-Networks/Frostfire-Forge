# Tears down the Frostfire Forge mesh test stack.
#
# Usage:
#   pwsh -File src/docker/swarm-teardown.ps1 [-LeaveSwarm]

param(
    [switch]$LeaveSwarm
)

$ErrorActionPreference = "Continue"

Write-Host "== Removing stack 'forge-mesh' =="
docker stack rm forge-mesh

Write-Host "== Waiting for services to shut down =="
Start-Sleep -Seconds 10

if ($LeaveSwarm) {
    Write-Host "== Leaving Docker Swarm =="
    docker swarm leave --force
}

Write-Host "== Removing test volumes (MySQL data) =="
docker volume rm forge-mesh_mysql forge-mesh-forge-mesh-mysql 2>$null

Write-Host "Done. Remaining services:"
docker service ls
