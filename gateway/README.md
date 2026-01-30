# Frostfire Forge Gateway / Load Balancer

A simple gateway/load balancer that distributes client connections across multiple game server instances.

## Architecture

```
┌─────────┐
│ Client  │──┐
└─────────┘  │
             │    ┌─────────────┐     ┌──────────┐
┌─────────┐  ├───→│   Gateway   │────→│ Server 1 │
│ Client  │──┤    │Load Balancer│     └──────────┘
└─────────┘  │    └─────────────┘     ┌──────────┐
             │           ↑             │ Server 2 │
┌─────────┐  │           │             └──────────┘
│ Client  │──┘           │             ┌──────────┐
└─────────┘              └─────────────│ Server 3 │
                    Registration       └──────────┘
                    & Heartbeats
```

## Features

- **Server Registration**: Game servers register themselves with the gateway
- **Health Monitoring**: Automatic heartbeat system to detect failed servers
- **Round-Robin Load Balancing**: Distributes NEW clients evenly across available servers
- **Sticky Sessions**: Clients with same ID always reconnect to the same server
- **Automatic Session Migration**: When a server dies, sessions are automatically migrated to healthy servers
- **Connection Limits**: Respects per-server connection limits
- **Automatic Cleanup**: Removes unresponsive servers and expired sessions automatically
- **Backpressure Handling**: Prevents WebSocket buffer overflow with automatic message queuing

## Quick Start

### 1. Start the Gateway

```bash
cd gateway
bun install
bun start
```

The gateway will start:
- HTTP server on port 8080 (for server registration)
- WebSocket server on port 9000 (for client connections)

### 2. Register Your Game Servers

Add the following code to your game server:

```typescript
import { GatewayClient } from './gateway/example-server-registration';

const gatewayClient = new GatewayClient({
  gatewayUrl: "http://localhost:8080",
  serverId: `server-${crypto.randomUUID()}`,
  host: "localhost",
  port: 80,
  wsPort: 3000,
  maxConnections: 1000,
  heartbeatInterval: 5000
});

await gatewayClient.register();
```

### 3. Connect Clients to Gateway (with Sticky Sessions)

Clients should:
1. Connect to the gateway WebSocket with a `clientId` query parameter
2. Receive server assignment message (includes the clientId)
3. Disconnect from gateway and connect to assigned server
4. **Save the clientId for future connections to maintain sticky sessions**

Example client code:

```typescript
// First connection - use username or userId as clientId for sticky sessions
const username = 'player123';  // Your user identifier
const ws = new WebSocket(`ws://localhost:9000?clientId=${username}`);

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);

  if (data.type === 'server_assignment') {
    console.log('Assigned to server:', data.server);
    console.log('Your clientId:', data.clientId); // Save this!

    // Connect to assigned server
    const gameWs = new WebSocket(`ws://${data.server.host}:${data.server.wsPort}`);
    // ... continue with game connection
    ws.close(); // Close gateway connection
  }
};

// Subsequent connections - use same clientId to return to same server!
const ws2 = new WebSocket(`ws://localhost:9000?clientId=${username}`);
// Will be assigned to the SAME server as before (sticky session)
```

**Important**: If you don't provide a `clientId`, the gateway will generate one and return it. Save this ID for future connections!

## API Endpoints

### POST /register
Register a game server with the gateway.

**Request:**
```json
{
  "id": "server-1",
  "host": "localhost",
  "port": 80,
  "wsPort": 3000,
  "maxConnections": 1000
}
```

**Response:**
```json
{
  "success": true,
  "serverId": "server-1"
}
```

### POST /heartbeat
Send heartbeat to keep server registration alive.

**Request:**
```json
{
  "id": "server-1",
  "activeConnections": 45
}
```

**Response:**
```json
{
  "success": true
}
```

### POST /unregister
Unregister a server from the gateway.

**Request:**
```json
{
  "id": "server-1"
}
```

**Response:**
```json
{
  "success": true
}
```

### GET /status
Check gateway status and registered servers.

**Response:**
```json
{
  "totalServers": 3,
  "totalActiveSessions": 150,
  "totalMigrations": 47,
  "recentMigrations": [
    {
      "timestamp": 1706543210000,
      "fromServer": "server-3",
      "toServer": "2 servers",
      "clientCount": 23
    }
  ],
  "servers": [
    {
      "id": "server-1",
      "host": "localhost",
      "port": 80,
      "wsPort": 3000,
      "activeConnections": 45,
      "maxConnections": 1000,
      "lastHeartbeat": 1706543210000
    }
  ]
}
```

## Configuration

Edit `config.json` to customize:

```json
{
  "gateway": {
    "port": 8080,
    "wsPort": 9000,
    "heartbeatInterval": 5000,
    "serverTimeout": 15000
  },
  "loadBalancing": {
    "strategy": "round-robin",
    "maxConnectionsPerServer": 1000
  }
}
```

## How It Works

1. **Server Registration**: Game servers send POST request to `/register` with their connection details
2. **Heartbeat**: Servers send periodic heartbeats to `/heartbeat` with current connection count
3. **Client Connection**: Clients connect to gateway WebSocket (port 9000) with optional `clientId`
4. **Sticky Session Check**: Gateway checks if this `clientId` has an existing session
   - If yes → Return client to their previous server
   - If no → Use round-robin to select next available server
5. **Server Assignment**: Gateway sends server details to client (includes `clientId`)
6. **Direct Connection**: Client disconnects from gateway and connects directly to assigned server
7. **Session Persistence**: Client's `clientId` → server mapping is saved for 30 minutes
8. **Health Check**: Gateway removes servers that miss heartbeats (timeout: 15 seconds)
9. **Session Migration**: When a server dies, all its sessions are automatically migrated to healthy servers
10. **Session Cleanup**: Expired sessions are cleaned up every minute

## Load Balancing Strategy

Currently implements **round-robin with sticky sessions**:
- **New clients**: Servers are selected in rotation (round-robin)
- **Returning clients**: Always assigned to their previous server (sticky session)
- Only servers with available capacity are considered
- If previous server is unavailable/full, client is reassigned to a new server
- Session timeout: 30 minutes of inactivity
- If all servers are full, clients receive an error

## Development

```bash
# Run in development mode with auto-reload
bun dev

# Run the test script (registers 3 mock servers and simulates 5 clients)
bun run test

# Check gateway status
curl http://localhost:8080/status
```

## Production Considerations

For production deployments, consider:

1. **Proxy Mode**: Implement full proxy mode where gateway maintains connections
2. **Sticky Sessions**: Use session affinity for stateful connections
3. **Health Checks**: Active health checks beyond heartbeats
4. **Metrics**: Add monitoring and metrics collection
5. **Security**: Add authentication for server registration
6. **SSL/TLS**: Enable secure connections
7. **Horizontal Scaling**: Multiple gateway instances with shared state (Redis)

## Documentation

For detailed information about specific features:

- **[SESSION-MIGRATION.md](./SESSION-MIGRATION.md)** - Complete guide to automatic session migration
- **[STICKY-SESSIONS.md](./STICKY-SESSIONS.md)** - Sticky session implementation details
- **[BACKPRESSURE.md](./BACKPRESSURE.md)** - Backpressure handling system
- **[CLIENT-INTEGRATION-COMPLETE.md](./CLIENT-INTEGRATION-COMPLETE.md)** - Client integration guide
- **[BENCHMARK-WITH-GATEWAY.md](./BENCHMARK-WITH-GATEWAY.md)** - Benchmark tool usage with gateway
- **[QUICKSTART.md](./QUICKSTART.md)** - Quick start guide

## Troubleshooting

**Servers not appearing in /status**
- Check server is sending heartbeats every 5 seconds
- Verify gateway URL is correct in server config
- Check network connectivity

**Clients can't connect**
- Verify gateway WebSocket is running on port 9000
- Check firewall rules
- Ensure game servers are registered and healthy

**Servers being removed**
- Increase `serverTimeout` in config.json
- Check network latency between server and gateway
- Verify heartbeat interval is less than timeout
