# Client Integration - Complete Implementation

The client code has been updated to support gateway connections with sticky sessions using `clientId` query parameters.

## What Was Changed

### 1. Client Code (`src/webserver/www/public/js/core/socket.ts`)

**Added Gateway Support:**
- `getClientId()` - Gets or generates a unique client identifier
  - Tries localStorage first
  - Falls back to username from cookie
  - Generates UUID if needed
- `connectThroughGateway()` - Connects to gateway and receives server assignment
  - Adds `?clientId=xxx` to gateway URL
  - Handles server assignment response
  - Stores clientId for future connections
- `initializeSocket()` - Main connection orchestrator
  - Checks if gateway is enabled
  - Routes through gateway or connects directly
  - Falls back to direct connection if gateway fails
- `setupSocketHandlers()` - Wraps all socket event handlers

**Connection Flow:**
```
1. initializeSocket() is called on page load
2. If GATEWAY_ENABLED=true:
   - Get clientId (from localStorage, cookie, or generate)
   - Connect to gateway with ?clientId=xxx
   - Receive server assignment
   - Connect to assigned game server
3. If GATEWAY_ENABLED=false:
   - Connect directly to game server
```

### 2. Global Config (`src/webserver/www/public/js/web/global.ts`)

Added configuration variables:
```typescript
GATEWAY_ENABLED: '__VAR.GATEWAY_ENABLED__',
GATEWAY_URL: '__VAR.GATEWAY_URL__'
```

### 3. Transpiler (`src/utility/transpiler.ts`)

Added environment variable replacements:
```typescript
{ key: "__VAR.GATEWAY_ENABLED__", value: process.env.GATEWAY_ENABLED, defaultvalue: "false" },
{ key: "__VAR.GATEWAY_URL__", value: process.env.GATEWAY_URL, defaultvalue: "ws://localhost:9000" }
```

### 4. Environment Variables (`.env.local`)

Added client-side gateway configuration:
```bash
GATEWAY_ENABLED=false          # Enable gateway routing for clients
GATEWAY_URL=ws://localhost:9000  # Gateway WebSocket URL
```

## How It Works

### ClientId Generation

**Priority Order:**
1. **Saved in localStorage**: `gateway_clientId`
2. **Username from cookie**: `user-{username}`
3. **Generated UUID**: `client-{uuid}`

**Why This Matters:**
- Username-based: Players always go to same server across browser sessions
- UUID-based: Unique per browser, maintains stickiness within session
- LocalStorage: Persists even after page reload

### Sticky Session Flow

**First Connection:**
```
1. Client generates/retrieves clientId: "user-john"
2. Connects to gateway: ws://localhost:9000?clientId=user-john
3. Gateway assigns Server 1 (round-robin)
4. Gateway saves session: user-john → Server 1
5. Client connects to Server 1
6. ClientId stored in localStorage
```

**Subsequent Connections:**
```
1. Client retrieves clientId from localStorage: "user-john"
2. Connects to gateway: ws://localhost:9000?clientId=user-john
3. Gateway finds existing session: user-john → Server 1
4. Gateway returns Server 1 (sticky!)
5. Client connects to Server 1 (same server as before)
```

## Testing

### Enable Gateway for Clients

**Option 1: Environment Variable**
```bash
GATEWAY_ENABLED=true bun run dev
```

**Option 2: Update .env.local**
```bash
# Edit .env.local
GATEWAY_ENABLED=true
GATEWAY_URL=ws://localhost:9000

# Then run
bun run dev
```

### Test Sticky Sessions

**Setup:**
```bash
# Terminal 1: Start gateway
cd gateway && bun start

# Terminal 2: Server 1
SERVER_ID=server-1 WEB_SOCKET_PORT=3001 WEBSRV_PORT=8001 bun run dev

# Terminal 3: Server 2
SERVER_ID=server-2 WEB_SOCKET_PORT=3002 WEBSRV_PORT=8002 bun run dev
```

**Test:**
1. Open browser to http://localhost:8001
2. Check browser console - should see:
   ```
   [Gateway] Connecting through gateway...
   [Gateway] Assigned to server: { host: "localhost", wsPort: 3001 }
   [Gateway] Client ID: user-yourname
   ```

3. Check localStorage:
   - Open DevTools → Application → LocalStorage
   - Should see `gateway_clientId` with your ID

4. Reload the page multiple times:
   - Should always connect to the **same server**
   - Console should show "sticky session" in gateway logs

5. Open incognito/different browser:
   - Will get a **different clientId**
   - May be assigned to a **different server**
   - But will stick to that server on reload

### Verify Distribution

Connect 4 different clients (different browsers or incognito windows):

1. Each should get a unique clientId
2. They should be distributed across servers (round-robin)
3. Each client should stick to its assigned server

**Expected:**
```
Client 1 (user-alice)  → Server 1
Client 2 (user-bob)    → Server 2
Client 3 (user-charlie)→ Server 1
Client 4 (user-dave)   → Server 2
```

## Configuration Options

### Disable Gateway (Default)

In `.env.local`:
```bash
GATEWAY_ENABLED=false
```

Clients connect directly to game server (no gateway).

### Enable Gateway

In `.env.local`:
```bash
GATEWAY_ENABLED=true
GATEWAY_URL=ws://localhost:9000
```

All clients route through gateway with sticky sessions.

### Custom Gateway URL

For production:
```bash
GATEWAY_ENABLED=true
GATEWAY_URL=wss://gateway.yourdomain.com
```

## Browser Console Commands

**Check Client ID:**
```javascript
localStorage.getItem('gateway_clientId')
```

**Clear Session (Force Reassignment):**
```javascript
localStorage.removeItem('gateway_clientId')
location.reload()
```

**Manually Set Client ID:**
```javascript
localStorage.setItem('gateway_clientId', 'my-custom-id')
location.reload()
```

## Troubleshooting

### All Clients Go to Same Server

**Problem:** Multiple clients getting assigned to same server

**Causes:**
1. All clients using same clientId
   - Check: `localStorage.getItem('gateway_clientId')` in each browser
   - Fix: Clear localStorage and reload

2. Gateway not running
   - Check: Gateway console should show connections
   - Fix: Start gateway with `cd gateway && bun start`

3. Only one server is registered
   - Check: `curl http://localhost:8080/status`
   - Fix: Start multiple servers with different SERVER_IDs

### Clients Not Using Gateway

**Problem:** Clients connecting directly instead of through gateway

**Causes:**
1. GATEWAY_ENABLED not set to "true"
   - Check: .env.local has `GATEWAY_ENABLED=true`
   - Fix: Update and restart server

2. Transpiler not running
   - Check: `src/webserver/www/public/js/web/global.js` (compiled file)
   - Fix: Run `bun run transpiler`

3. Browser cache
   - Check: Hard reload (Ctrl+Shift+R)
   - Fix: Clear browser cache

### Session Not Persisting

**Problem:** Clients getting reassigned on reconnect

**Causes:**
1. localStorage being cleared
   - Check: Browser settings / incognito mode
   - Fix: Use normal browser mode

2. Session expired (30 min timeout)
   - Check: Gateway logs for "expired sessions"
   - Fix: Increase `sessionTimeout` in gateway config

3. Different clientId on reconnect
   - Check: clientId in console logs
   - Fix: Ensure username cookie persists

## Production Considerations

### Security

1. **HTTPS/WSS**: Use secure WebSocket connections
   ```bash
   GATEWAY_URL=wss://gateway.yourdomain.com
   ```

2. **CORS**: Configure gateway to accept requests from your domain

3. **Rate Limiting**: Gateway already has connection limits

### Performance

1. **Gateway Location**: Place gateway geographically close to users

2. **Multiple Gateways**: Run multiple gateway instances behind a load balancer

3. **Session Storage**: Consider Redis for session storage (multi-gateway deployments)

### Monitoring

1. **Gateway Status**: Monitor `/status` endpoint
   ```bash
   curl https://gateway.yourdomain.com:8080/status
   ```

2. **Client Errors**: Check browser console for gateway errors

3. **Session Metrics**: Track `totalActiveSessions` from status endpoint

## Summary

✅ **Client code updated** to support gateway connections
✅ **ClientId-based sticky sessions** implemented
✅ **Automatic fallback** to direct connection if gateway fails
✅ **Username-based clientIds** for cross-session persistence
✅ **LocalStorage persistence** for same-browser stickiness
✅ **Environment variable configuration** for easy toggling
✅ **Backward compatible** - works without gateway (default)

**Result:** Clients now properly load balance across servers while maintaining session stickiness. Each unique user always connects to the same game server, preventing state corruption.
