#!/bin/bash
set -e

SERVICE_NAME=frostfire-forge-production
PROJECT_DIR=/root/Frostfire-Forge
SERVICE_FILE=$PROJECT_DIR/$SERVICE_NAME.service

echo "🔗 Linking $SERVICE_NAME service..."
sudo systemctl link $SERVICE_FILE || true

echo "🔄 Reloading systemd..."
sudo systemctl daemon-reload

echo "🚀 Starting $SERVICE_NAME..."
sudo systemctl start $SERVICE_NAME

echo "✅ $SERVICE_NAME started"
