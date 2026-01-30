# Client Integration with Gateway

This document explains how to update your game client to connect through the gateway/load balancer.

## Overview

There are two approaches to integrate clients with the gateway:

### Option 1: Gateway Returns Server Info (Current Implementation)

The gateway assigns a server and returns its connection details to the client. The client then connects directly to that server.

**Advantages:**
- No proxy overhead - direct connection between client and server
- Gateway is lightweight and scalable
- Simple implementation

**Disadvantages:**
- Clients need to handle two-step connection
- Clients need to know gateway URL

### Option 2: Gateway Proxies Connections (Future Enhancement)

The gateway maintains persistent connections and proxies all traffic between clients and servers.

**Advantages:**
- Transparent to clients
- Can implement sticky sessions easily
- Advanced routing capabilities

**Disadvantages:**
- Gateway becomes a bottleneck
- Higher latency
- More complex implementation

## Current Implementation (Option 1)

### How It Works

```
1. Client connects to Gateway WebSocket (ws://localhost:9000)
2. Gateway assigns a server using round-robin
3. Gateway sends server assignment to client
4. Client disconnects from gateway
5. Client connects to assigned game server
```

### Example Client Code

```typescript
// Step 1: Connect to gateway
const gatewayUrl = 'ws://localhost:9000';
const gatewaySocket = new WebSocket(gatewayUrl);

gatewaySocket.onopen = () => {
  console.log('Connected to gateway, waiting for server assignment...');
};

gatewaySocket.onmessage = (event) => {
  const data = JSON.parse(event.data);

  if (data.type === 'server_assignment') {
    console.log('Assigned to server:', data.server);

    // Close gateway connection
    gatewaySocket.close();

    // Connect to assigned game server
    const gameUrl = `ws://${data.server.host}:${data.server.wsPort}`;
    const gameSocket = new WebSocket(gameUrl);

    gameSocket.onopen = () => {
      console.log('Connected to game server');
      // Continue with normal game logic...
    };

    // ... rest of game socket handlers
  } else if (data.type === 'error') {
    console.error('Gateway error:', data.message);
  }
};
```

## Integrating with Frostfire Forge Client

### Modify src/webserver/www/public/js/core/socket.ts

**Current code (line 3):**
```typescript
const socket = new WebSocket(config.WEBSOCKET_URL || "ws://localhost:3000");
```

**Option 1: Direct Gateway Integration (Breaking Change)**

Replace the WebSocket connection with gateway logic:

```typescript
let socket: WebSocket;

// Check if gateway is enabled
if (config.GATEWAY_ENABLED) {
  // Connect to gateway first
  const gatewaySocket = new WebSocket(config.GATEWAY_URL || "ws://localhost:9000");

  gatewaySocket.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === 'server_assignment') {
      // Close gateway connection
      gatewaySocket.close();

      // Connect to assigned server
      const gameUrl = `ws://${data.server.host}:${data.server.wsPort}`;
      socket = new WebSocket(gameUrl);
      socket.binaryType = "arraybuffer";

      // Initialize game after connection
      socket.onopen = () => {
        console.log('Connected to game server via gateway');
        initializeGame();
      };

      // ... rest of socket handlers
    }
  };
} else {
  // Direct connection (existing behavior)
  socket = new WebSocket(config.WEBSOCKET_URL || "ws://localhost:3000");
  socket.binaryType = "arraybuffer";
  initializeGame();
}
```

**Option 2: Add Gateway URL to Config (Simpler)**

Update `src/webserver/www/public/js/web/global.ts` to add:

```typescript
export const config = {
  // ... existing config
  GATEWAY_ENABLED: false,
  GATEWAY_URL: "ws://localhost:9000",
  // ... rest of config
};
```

Then clients can manually enable gateway mode by setting `GATEWAY_ENABLED` to `true`.

### Update Environment Variables

Add to your `.env` file:

```bash
# Gateway settings
GATEWAY_ENABLED=false
GATEWAY_URL=ws://localhost:9000
```

## Testing the Integration

1. **Start the Gateway:**
   ```bash
   cd gateway
   bun start
   ```

2. **Start Multiple Game Servers:**

   Enable gateway in settings:
   ```json
   {
     "gateway": {
       "enabled": true,
       "url": "http://localhost:8080",
       "heartbeatInterval": 5000
     }
   }
   ```

   Start servers with different IDs:
   ```bash
   # Terminal 1
   SERVER_ID=server-1 WEB_SOCKET_PORT=3001 bun run dev

   # Terminal 2
   SERVER_ID=server-2 WEB_SOCKET_PORT=3002 bun run dev

   # Terminal 3
   SERVER_ID=server-3 WEB_SOCKET_PORT=3003 bun run dev
   ```

3. **Verify Registration:**
   ```bash
   curl http://localhost:8080/status
   ```

   Should show all 3 servers registered.

4. **Test Client Connections:**

   Multiple clients connecting should be distributed across the 3 servers in round-robin fashion.

## Production Considerations

For production use, consider:

1. **DNS/Load Balancer**: Put gateway behind a load balancer
2. **Health Checks**: Implement active health checks (ping/pong)
3. **SSL/TLS**: Enable secure connections for gateway
4. **Session Affinity**: Implement sticky sessions if needed
5. **Metrics**: Add monitoring for connection distribution
6. **Fallback**: Implement fallback to direct connection if gateway fails
7. **Auto-Discovery**: Servers could auto-discover gateway via service discovery

## Environment Variables Reference

**Server-side:**
- `SERVER_ID` - Unique identifier for this server instance
- `SERVER_HOST` - Public hostname/IP for this server
- `WEB_SOCKET_PORT` - WebSocket port for this server
- `WEBSRV_PORT` - HTTP port for this server

**Client-side:**
- `GATEWAY_ENABLED` - Whether to use gateway (true/false)
- `GATEWAY_URL` - WebSocket URL for gateway

## Troubleshooting

**Clients can't connect through gateway:**
- Verify gateway is running: `curl http://localhost:8080/status`
- Check browser console for WebSocket errors
- Ensure CORS is properly configured
- Verify gateway URL in client config

**Servers not appearing in gateway:**
- Check `settings.json` has `gateway.enabled: true`
- Verify gateway URL is correct in settings
- Check server logs for registration errors
- Verify network connectivity to gateway

**Uneven distribution:**
- Check server connection limits in gateway
- Verify all servers are healthy
- Check gateway logs for server timeouts
