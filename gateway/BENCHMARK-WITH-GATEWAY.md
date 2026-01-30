# Benchmark Tool with Gateway Support

The CLI benchmark tool now supports testing gateway/load balancer functionality with sticky sessions.

## What Changed

The benchmark tool (`src/utility/benchmark-cli.ts`) has been updated with:

1. **Gateway CLI Flags**:
   - `--gateway` - Enable gateway routing
   - `--gateway-url <url>` - Specify gateway URL

2. **Environment Variables**:
   - `GATEWAY_ENABLED` - Enable/disable gateway (true/false)
   - `GATEWAY_URL` - Gateway WebSocket URL

3. **Gateway Connection Logic**:
   - Each client generates a unique `clientId` (format: `benchmark-{uuid}`)
   - Clients connect through gateway to get server assignment
   - Falls back to direct connection if gateway fails

4. **Display Updates**:
   - Shows gateway status in benchmark output
   - Indicates when clients are routing through gateway

## Usage

### Basic Gateway Test

Test load balancing across multiple servers:

```bash
# Terminal 1: Start gateway
cd gateway && bun start

# Terminal 2: Server 1
SERVER_ID=server-1 SERVER_HOST=localhost WEB_SOCKET_PORT=3001 WEBSRV_PORT=8001 bun run dev

# Terminal 3: Server 2
SERVER_ID=server-2 SERVER_HOST=localhost WEB_SOCKET_PORT=3002 WEBSRV_PORT=8002 bun run dev

# Terminal 4: Run benchmark with gateway
bun src/utility/benchmark-cli.ts --clients 100 --duration 60 --gateway
```

### Custom Gateway URL

```bash
bun src/utility/benchmark-cli.ts --clients 50 --gateway-url ws://gateway.example.com:9000
```

### With Environment File

Set gateway in `.env.local`:
```bash
GATEWAY_ENABLED=true
GATEWAY_URL=ws://localhost:9000
```

Then run:
```bash
bun --env-file=.env.local src/utility/benchmark-cli.ts --clients 100
```

### Direct Connection (No Gateway)

```bash
# Default behavior - connects directly to game server
bun src/utility/benchmark-cli.ts --clients 50 --ws ws://localhost:3000
```

## What It Tests

### Load Distribution

Each client:
1. Gets a unique `clientId`: `benchmark-{uuid}`
2. Connects to gateway with `?clientId=xxx`
3. Gateway assigns a server (round-robin)
4. Client connects to assigned server
5. Simulates gameplay (movement, time sync)

**Expected Result**: Clients should be evenly distributed across all registered servers.

### Sticky Sessions

Since each client has a unique ID:
- First connection → assigned to a server
- That clientId will stick to that server for 30 minutes
- Different clients get different assignments

**To Test Reconnection**:
You'd need to modify the benchmark to reconnect clients with the same clientId (currently generates new IDs each run).

## Example Output

### With Gateway Enabled:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Frostfire Forge CLI Benchmark
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Clients:  100
  Duration: 60s
  Host:     http://localhost:80
  Gateway:  Enabled → ws://localhost:9000
  Note: Each client will be assigned to a server via gateway

  Environment:
  GATEWAY_ENABLED: true
  GATEWAY_URL: ws://localhost:9000

────────────────────────────────────────────────────────────

[timestamp] ℹ Starting benchmark...
[timestamp] ℹ Creating 100 guest accounts (via gateway)...
```

### Gateway Status Check

During the benchmark, check gateway distribution:

```bash
# In another terminal
curl http://localhost:8080/status | jq

# Should show clients distributed across servers:
{
  "totalServers": 2,
  "totalActiveSessions": 100,
  "servers": [
    {
      "id": "server-1",
      "host": "localhost",
      "wsPort": 3001,
      "activeConnections": 50
    },
    {
      "id": "server-2",
      "host": "localhost",
      "wsPort": 3002,
      "activeConnections": 50
    }
  ]
}
```

## Verification

To verify gateway load balancing is working:

1. **Check Gateway Logs**:
   ```
   [Gateway] Created new session for client benchmark-xxx → server server-1
   [Gateway] Created new session for client benchmark-yyy → server server-2
   [Gateway] Created new session for client benchmark-zzz → server server-1
   ```

2. **Check Server Connection Counts**:
   ```bash
   curl http://localhost:8080/status | jq '.servers[].activeConnections'
   ```
   Should show roughly equal distribution.

3. **Check Individual Server Logs**:
   Each server should show ~50 connections (for 100 clients with 2 servers).

## Troubleshooting

### All Clients Going to Same Server

**Problem**: Clients not distributing across servers

**Causes**:
1. Only one server is registered
   - Check: `curl http://localhost:8080/status`
   - Fix: Start multiple servers with different `SERVER_ID` and `SERVER_HOST`

2. Servers have same host:port
   - Check: Gateway logs show same address
   - Fix: Set unique `SERVER_HOST` and `WEB_SOCKET_PORT` for each server

### Gateway Connection Failures

**Problem**: `Gateway connection failed for client X, using direct`

**Causes**:
1. Gateway not running
   - Check: Gateway should be on port 9000
   - Fix: `cd gateway && bun start`

2. Wrong gateway URL
   - Check: `--gateway-url` or `GATEWAY_URL`
   - Fix: Use correct gateway address

3. Gateway timeout
   - Check: Gateway logs for errors
   - Fix: Increase timeout in benchmark code or check network

### No Sticky Session Testing

**Note**: Current implementation generates new clientIds for each benchmark run, so sticky sessions aren't tested across runs.

**To test sticky sessions**:
Modify benchmark to save and reuse clientIds between runs.

## Performance Considerations

### Gateway Overhead

Each client adds:
- 1 gateway connection (brief)
- 1 game server connection (persistent)
- ~100ms additional latency for initial assignment

### Batch Size

Benchmark creates clients in batches:
- Batch size: 2 clients
- Batch delay: 500ms
- For 100 clients: ~25 seconds to create all

This prevents overwhelming the gateway during connection surge.

### Recommended Test Parameters

- **Small test**: 50 clients, 60s
- **Medium test**: 100 clients, 120s
- **Large test**: 500 clients, 300s

## Advanced Usage

### Test Multiple Gateway Instances

If you have multiple gateway instances behind a load balancer:

```bash
bun src/utility/benchmark-cli.ts \
  --clients 200 \
  --gateway-url ws://loadbalancer.example.com:9000
```

### Test Failover

1. Start benchmark with 100 clients
2. During run, stop one game server
3. Gateway should mark server as dead
4. New clients should only go to remaining servers

### Stress Test Gateway

```bash
bun src/utility/benchmark-cli.ts \
  --clients 1000 \
  --duration 300 \
  --gateway
```

Monitor gateway CPU/memory during test.

## Summary

✅ **Gateway flag added** to benchmark CLI
✅ **Unique clientIds** generated per client
✅ **Load balancing** tested automatically
✅ **Fallback to direct** if gateway unavailable
✅ **Distribution verification** via gateway status endpoint

Use this to test your gateway deployment before going to production!
