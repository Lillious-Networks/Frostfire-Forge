# Sticky Sessions Implementation

## Problem

The original gateway implementation used **IP addresses** for session tracking, which caused issues:

1. **Multiple clients from same IP**: All localhost clients or users behind NAT got the same session
2. **Non-deterministic routing**: Each client request could go to a different server
3. **State loss**: Player state (position, inventory) is in server memory, not shared
4. **Race conditions**: Login on Server 1, spawn on Server 2, movement on Server 1...

## Solution: clientId-Based Sticky Sessions

Instead of IP addresses, we now use a **unique client identifier** (`clientId`) passed via WebSocket URL query parameters.

### How It Works

```
Client connects with clientId → Gateway checks session map
  ├─ Session exists? → Return to same server ✅
  └─ New client? → Assign via round-robin → Save session
```

### Client Connection Flow

**First Connection:**
```typescript
// Client provides username or userId as clientId
ws://localhost:9000?clientId=player123

Gateway Response:
{
  type: "server_assignment",
  clientId: "player123",
  server: { host: "localhost", wsPort: 3001 }
}
```

**Subsequent Connections (Sticky!):**
```typescript
// Same clientId → Returns to SAME server
ws://localhost:9000?clientId=player123

Gateway Response:
{
  type: "server_assignment",
  clientId: "player123",
  server: { host: "localhost", wsPort: 3001 }  // Same server!
}
```

**Without clientId:**
```typescript
// No clientId provided → Gateway generates one
ws://localhost:9000

Gateway Response:
{
  type: "server_assignment",
  clientId: "client-a1b2c3d4-...",  // Generated UUID
  server: { host: "localhost", wsPort: 3001 }
}
// Save this clientId for future connections!
```

## Implementation Details

### Gateway Changes

1. **Session Storage**:
   ```typescript
   clientSessions: Map<string, ClientSession>
   // Maps: clientId → { serverId, lastActivity, clientId }
   ```

2. **URL Parameter Extraction**:
   ```typescript
   const url = new URL(req.url);
   const clientId = url.searchParams.get("clientId") || crypto.randomUUID();
   ```

3. **Sticky Session Lookup**:
   ```typescript
   function getServerForClient(clientId: string): GameServer | null {
     const existingSession = clientSessions.get(clientId);
     if (existingSession && serverStillAvailable) {
       return existingSession.server; // Sticky!
     }
     // Otherwise assign new server via round-robin
   }
   ```

4. **Session Cleanup**:
   - **Dead server**: Remove all sessions pointing to that server
   - **Expired session**: Remove sessions inactive for 30+ minutes
   - **Reassignment**: If previous server is full/dead, assign new server

### Client Integration

**For your game client:**

```typescript
// Use username as clientId for sticky sessions
const username = player.username; // or userId, sessionToken, etc.

// Connect to gateway
const gatewayWs = new WebSocket(`ws://localhost:9000?clientId=${username}`);

gatewayWs.onmessage = (event) => {
  const data = JSON.parse(event.data);

  if (data.type === 'server_assignment') {
    // Connect to assigned server
    const gameWs = new WebSocket(`ws://${data.server.host}:${data.server.wsPort}`);
    gatewayWs.close();

    // All future connections with same username will go to same server!
  }
};
```

## Benefits

✅ **State Consistency**: Player always connects to same server (where their state lives)
✅ **Multiple Clients**: Each unique user gets their own session
✅ **Reconnection**: Disconnects/reconnects return to same server
✅ **Load Balancing**: New users still distributed via round-robin
✅ **Automatic Cleanup**: Sessions expire after 30 minutes of inactivity
✅ **Fault Tolerance**: Dead server → clients reassigned automatically

## Configuration

### Gateway (`gateway/config.json`):
```json
{
  "gateway": {
    "sessionTimeout": 1800000  // 30 minutes (in ms)
  },
  "sessions": {
    "enabled": true,
    "timeout": 1800000,
    "cleanupInterval": 60000    // Check every minute
  }
}
```

### Gateway (`gateway/server.ts`):
```typescript
const config: GatewayConfig = {
  sessionTimeout: 1800000  // 30 minutes
};

setInterval(cleanupExpiredSessions, 60000); // Every minute
```

## Testing Sticky Sessions

```bash
# Terminal 1: Start gateway
cd gateway && bun start

# Terminal 2: Start server 1
SERVER_ID=server-1 WEB_SOCKET_PORT=3001 bun run dev

# Terminal 3: Start server 2
SERVER_ID=server-2 WEB_SOCKET_PORT=3002 bun run dev

# Terminal 4: Test with multiple clients
node -e "
const ws1 = new WebSocket('ws://localhost:9000?clientId=user1');
const ws2 = new WebSocket('ws://localhost:9000?clientId=user2');
const ws3 = new WebSocket('ws://localhost:9000?clientId=user1'); // Should go to same server as ws1!
"
```

## Troubleshooting

**Q: Clients still going to different servers?**
- Ensure you're passing `?clientId=xxx` in the WebSocket URL
- Check gateway logs for "sticky session" messages
- Verify same clientId is being used for reconnections

**Q: Session not persisting?**
- Check `sessionTimeout` setting (default: 30 minutes)
- Verify session isn't timing out between connections
- Check gateway logs for "expired sessions" cleanup messages

**Q: How do I clear a stuck session?**
- Wait for session timeout (30 minutes)
- Restart gateway (clears all sessions)
- Or: Use a different clientId

**Q: What should I use as clientId?**
- Best: Username or userId (consistent across sessions)
- Good: Session token from authentication
- Okay: Generated UUID (but must save it!)
- Avoid: Random value on each connection (defeats sticky sessions)

## Migration from IP-based

If you were testing with the old IP-based version:

1. Restart the gateway to clear old sessions
2. Update client code to include `?clientId=xxx` parameter
3. Use username or userId as the clientId
4. Test with multiple clients from same IP - they should go to different servers

## Future Enhancements

Potential improvements:

1. **Redis Storage**: Store sessions in Redis for multi-gateway deployments
2. **Session Migration**: Move client to different server while preserving state
3. **Weighted Routing**: Route based on server load, not just round-robin
4. **Custom Strategies**: Allow different routing strategies per clientId pattern
5. **Session Analytics**: Track session duration, reconnection rates, etc.
