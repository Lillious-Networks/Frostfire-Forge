#!/bin/bash
set -e

SERVICE_NAME=frostfire-forge-production

echo "🛑 Stopping $SERVICE_NAME..."
sudo systemctl stop $SERVICE_NAME || true

echo "✅ $SERVICE_NAME stopped"
