# Gateway Quick Start Guide

This guide will help you quickly set up and test the gateway/load balancer with your Frostfire Forge servers.

## What Was Built

A complete gateway/load balancer system that:
- ✅ Runs as a standalone service in `/gateway/`
- ✅ Automatically registers game servers
- ✅ Distributes clients using round-robin load balancing
- ✅ Monitors server health with heartbeats
- ✅ Removes unresponsive servers automatically
- ✅ Integrated with the existing server code
- ✅ Includes test scripts and examples

## Quick Test (5 Minutes)

### 1. Start the Gateway

```bash
cd gateway
bun install  # First time only
bun start
```

You should see:
```
[Gateway] HTTP Server running on http://localhost:8080
[Gateway] WebSocket Server running on ws://localhost:9000
[Gateway] Waiting for game servers to register...
```

### 2. Test Gateway with Mock Servers

Open a new terminal:

```bash
cd gateway
bun run test
```

This will:
- Register 3 mock game servers
- Simulate 5 client connections
- Show load balancing in action
- Display gateway status

You should see clients being distributed across the 3 servers!

### 3. Enable Real Server Integration

Edit `src/config/settings.json` and enable the gateway:

```json
{
  "gateway": {
    "enabled": true,
    "url": "http://localhost:8080",
    "heartbeatInterval": 5000
  }
}
```

### 4. Start Your Game Server

```bash
# From project root
bun run dev
```

Watch the logs - you should see:
```
Successfully registered with gateway as server-xxxxx
```

### 5. Verify Server Registration

```bash
curl http://localhost:8080/status
```

You should see your server listed!

## Running Multiple Servers

To test load balancing with real servers:

```bash
# Terminal 1: Start gateway
cd gateway && bun start

# Terminal 2: Server 1
SERVER_ID=server-1 WEB_SOCKET_PORT=3001 WEBSRV_PORT=8001 bun run dev

# Terminal 3: Server 2
SERVER_ID=server-2 WEB_SOCKET_PORT=3002 WEBSRV_PORT=8002 bun run dev

# Terminal 4: Server 3
SERVER_ID=server-3 WEB_SOCKET_PORT=3003 WEBSRV_PORT=8003 bun run dev

# Terminal 5: Check status
curl http://localhost:8080/status | jq
```

All 3 servers should now be registered with the gateway!

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│                    GATEWAY (Port 8080/9000)             │
│  - Tracks available servers                              │
│  - Receives heartbeats every 5 seconds                   │
│  - Distributes clients round-robin                       │
└─────────────────────────────────────────────────────────┘
     ↑ Registration/Heartbeat           ↑ Client connects
     │                                  │ Gets server assignment
     │                                  ↓
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  Server 1    │  │  Server 2    │  │  Server 3    │
│  Port 3001   │  │  Port 3002   │  │  Port 3003   │
└──────────────┘  └──────────────┘  └──────────────┘
```

## What Was Modified

### New Files Created:
1. `/gateway/server.ts` - Gateway server implementation
2. `/gateway/config.json` - Gateway configuration
3. `/gateway/test-gateway.ts` - Test script
4. `/gateway/example-server-registration.ts` - Example integration code
5. `/gateway/example-client-helper.ts` - Client-side helper
6. `/gateway/client-integration.md` - Client integration guide
7. `/src/modules/gateway-client.ts` - Gateway client module

### Modified Files:
1. `/src/socket/server.ts` - Added gateway registration and heartbeat
2. `/src/config/settings.json` - Added gateway configuration

### Key Changes in Socket Server:

**Import gateway client (line 22):**
```typescript
import { GatewayClient } from "../modules/gateway-client.ts";
```

**Register on startup (line 221-245):**
```typescript
let gatewayClient: GatewayClient | null = null;
if (settings?.gateway?.enabled) {
  gatewayClient = new GatewayClient({...});
  await gatewayClient.register();
}
```

**Update connection count (line 425-428):**
```typescript
if (gatewayClient) {
  gatewayClient.setActiveConnections(connections.size);
}
```

**Graceful shutdown (line 609-624):**
```typescript
async function gracefulShutdown(signal: string) {
  if (gatewayClient) {
    await gatewayClient.unregister();
  }
  process.exit(0);
}
```

## Configuration Options

### Gateway (`gateway/config.json`):
```json
{
  "gateway": {
    "port": 8080,              // HTTP port for server registration
    "wsPort": 9000,            // WebSocket port for client connections
    "heartbeatInterval": 5000, // Check servers every 5 seconds
    "serverTimeout": 15000     // Remove server after 15s no heartbeat
  }
}
```

### Server (`src/config/settings.json`):
```json
{
  "gateway": {
    "enabled": false,           // Enable/disable gateway integration
    "url": "http://localhost:8080",  // Gateway HTTP URL
    "heartbeatInterval": 5000   // Send heartbeat every 5 seconds
  }
}
```

## Environment Variables

Set these when starting servers:

```bash
# Unique server identifier
SERVER_ID=server-1

# Public hostname/IP for clients to connect to
SERVER_HOST=localhost

# WebSocket port (must be unique per server)
WEB_SOCKET_PORT=3001

# HTTP port (must be unique per server)
WEBSRV_PORT=8001
```

## Troubleshooting

### Gateway not starting
```bash
# Check if ports are available
netstat -an | grep 8080
netstat -an | grep 9000

# Try different ports in config.json
```

### Server not registering
```bash
# Check settings.json has gateway.enabled: true
# Check gateway is running
curl http://localhost:8080/status

# Check server logs for errors
# Verify gateway URL is correct
```

### Servers being removed
```bash
# Increase serverTimeout in gateway/config.json
# Check network latency
# Verify heartbeat is less than timeout
```

## Next Steps

1. **Client Integration**: See `gateway/client-integration.md` for updating clients
2. **Production Setup**: Add SSL/TLS, monitoring, multiple gateway instances
3. **Advanced Features**: Sticky sessions, health checks, metrics collection

## API Reference

### POST /register
Register a game server
```bash
curl -X POST http://localhost:8080/register \
  -H "Content-Type: application/json" \
  -d '{"id":"server-1","host":"localhost","port":80,"wsPort":3000,"maxConnections":1000}'
```

### POST /heartbeat
Send heartbeat
```bash
curl -X POST http://localhost:8080/heartbeat \
  -H "Content-Type: application/json" \
  -d '{"id":"server-1","activeConnections":45}'
```

### GET /status
Check gateway status
```bash
curl http://localhost:8080/status | jq
```

## Need Help?

- Check `gateway/README.md` for detailed documentation
- See `gateway/client-integration.md` for client setup
- Review example files in `gateway/` directory
