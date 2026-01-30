/**
 * Gateway/Load Balancer Server with Sticky Sessions
 *
 * This server acts as a gateway between clients and multiple game server instances.
 * - Game servers register themselves with the gateway
 * - Clients connect to the gateway
 * - Gateway distributes clients across available servers using round-robin
 * - Sticky sessions ensure clients always reconnect to the same server
 * - Implements backpressure handling for WebSocket connections
 */

// Backpressure configuration
const MAX_BUFFER_SIZE = 1024 * 1024 * 1024; // 1GB
const packetQueue = new Map<string, (() => void)[]>();

interface GameServer {
  id: string;
  host: string;
  port: number;
  wsPort: number;
  lastHeartbeat: number;
  activeConnections: number;
  maxConnections: number;
}

interface ClientSession {
  serverId: string;
  lastActivity: number;
  clientId: string;
}

interface GatewayConfig {
  port: number;
  wsPort: number;
  heartbeatInterval: number;
  serverTimeout: number;
  sessionTimeout: number;
}

const config: GatewayConfig = {
  port: 8080,           // HTTP port for server registration
  wsPort: 9000,         // WebSocket port for client connections
  heartbeatInterval: 5000,  // Check server health every 5 seconds
  serverTimeout: 15000,     // Remove server if no heartbeat for 15 seconds
  sessionTimeout: 1800000   // Session timeout: 30 minutes
};

// Store registered game servers
const gameServers: Map<string, GameServer> = new Map();
let roundRobinIndex = 0;

// Sticky session tracking: clientId → ClientSession
const clientSessions: Map<string, ClientSession> = new Map();

// Migration statistics
let totalMigrations = 0;
const migrationHistory: Array<{
  timestamp: number;
  fromServer: string;
  toServer: string;
  clientCount: number;
}> = [];

/**
 * Get the next available server using round-robin load balancing
 */
function getNextServer(): GameServer | null {
  const availableServers = Array.from(gameServers.values()).filter(
    server => server.activeConnections < server.maxConnections
  );

  if (availableServers.length === 0) {
    return null;
  }

  const server = availableServers[roundRobinIndex % availableServers.length];
  roundRobinIndex = (roundRobinIndex + 1) % availableServers.length;

  return server;
}

/**
 * Get server assignment for client with sticky session support
 * If client has an existing session, return that server
 * Otherwise, assign a new server using round-robin
 */
function getServerForClient(clientId: string): GameServer | null {
  // Check if client has an existing session
  const existingSession = clientSessions.get(clientId);

  if (existingSession) {
    // Check if the assigned server is still available and healthy
    const assignedServer = gameServers.get(existingSession.serverId);

    if (assignedServer && assignedServer.activeConnections < assignedServer.maxConnections) {
      // Update last activity timestamp
      existingSession.lastActivity = Date.now();
      console.log(`[Gateway] Returning client ${clientId} to existing server: ${assignedServer.id} (sticky session)`);
      return assignedServer;
    } else {
      // Server is gone or full, remove session and assign new server
      console.log(`[Gateway] Previous server ${existingSession.serverId} unavailable, reassigning client ${clientId}`);
      clientSessions.delete(clientId);
    }
  }

  // No existing session or server unavailable - assign new server
  const server = getNextServer();

  if (server) {
    // Create new session
    clientSessions.set(clientId, {
      serverId: server.id,
      lastActivity: Date.now(),
      clientId
    });
    console.log(`[Gateway] Created new session for client ${clientId} → server ${server.id}`);
  }

  return server;
}

/**
 * Migrate sessions from a dead server to healthy servers
 */
function migrateSessionsFromDeadServer(deadServerId: string): number {
  const sessionsToMigrate: string[] = [];

  // Find all sessions pointing to the dead server
  for (const [clientId, session] of clientSessions.entries()) {
    if (session.serverId === deadServerId) {
      sessionsToMigrate.push(clientId);
    }
  }

  if (sessionsToMigrate.length === 0) {
    return 0;
  }

  // Get available healthy servers
  const healthyServers = Array.from(gameServers.values()).filter(
    server => server.activeConnections < server.maxConnections
  );

  if (healthyServers.length === 0) {
    console.warn(`[Gateway] No healthy servers available for migration from ${deadServerId}`);
    // Delete sessions if no healthy servers available
    for (const clientId of sessionsToMigrate) {
      clientSessions.delete(clientId);
    }
    return 0;
  }

  console.log(`[Gateway] Migrating ${sessionsToMigrate.length} sessions from dead server ${deadServerId}`);

  let migrationIndex = 0;
  let migratedCount = 0;

  // Migrate sessions to healthy servers (round-robin distribution)
  for (const clientId of sessionsToMigrate) {
    const session = clientSessions.get(clientId);
    if (!session) continue;

    // Select next healthy server in round-robin fashion
    const targetServer = healthyServers[migrationIndex % healthyServers.length];
    migrationIndex++;

    // Update session to point to new server
    session.serverId = targetServer.id;
    session.lastActivity = Date.now(); // Reset activity to prevent immediate expiration

    migratedCount++;
    console.log(`[Gateway] Migrated client ${clientId}: ${deadServerId} → ${targetServer.id}`);
  }

  // Record migration in history
  if (migratedCount > 0) {
    const targetServerId = healthyServers[0].id;
    migrationHistory.push({
      timestamp: Date.now(),
      fromServer: deadServerId,
      toServer: migratedCount === 1 ? healthyServers[0].id : `${healthyServers.length} servers`,
      clientCount: migratedCount
    });

    // Keep only last 100 migrations in history
    if (migrationHistory.length > 100) {
      migrationHistory.shift();
    }

    totalMigrations += migratedCount;
  }

  return migratedCount;
}

/**
 * Remove dead servers that haven't sent heartbeat and migrate their sessions
 */
function cleanupDeadServers() {
  const now = Date.now();
  for (const [id, server] of gameServers.entries()) {
    if (now - server.lastHeartbeat > config.serverTimeout) {
      console.log(`[Gateway] Server died: ${id} (${server.host}:${server.port})`);

      // Migrate sessions before removing server
      const migratedCount = migrateSessionsFromDeadServer(id);

      if (migratedCount > 0) {
        console.log(`[Gateway] Successfully migrated ${migratedCount} sessions from ${id}`);
      } else {
        console.log(`[Gateway] No sessions to migrate from ${id}`);
      }

      // Remove the dead server
      gameServers.delete(id);
    }
  }
}

/**
 * Remove expired client sessions
 */
function cleanupExpiredSessions() {
  const now = Date.now();
  let removedCount = 0;

  for (const [clientId, session] of clientSessions.entries()) {
    if (now - session.lastActivity > config.sessionTimeout) {
      clientSessions.delete(clientId);
      removedCount++;
    }
  }

  if (removedCount > 0) {
    console.log(`[Gateway] Cleaned up ${removedCount} expired sessions`);
  }
}

// Start cleanup intervals
setInterval(cleanupDeadServers, config.heartbeatInterval);
setInterval(cleanupExpiredSessions, 60000); // Clean up sessions every minute

/**
 * Handle WebSocket backpressure
 * Queues actions if buffer is full, executes when buffer has space
 */
function handleBackpressure(ws: any, action: () => void, retryCount = 0) {
  if (retryCount > 20) {
    console.warn("[Gateway] Max retries reached. Action skipped to avoid infinite loop.");
    return;
  }

  if (ws.readyState !== 1) { // 1 = WebSocket.OPEN
    console.warn("[Gateway] WebSocket is not open. Action cannot proceed.");
    return;
  }

  const clientId = ws.data?.clientId;
  if (!clientId) {
    console.warn("[Gateway] No clientId found for WebSocket. Action cannot proceed.");
    return;
  }

  const queue = packetQueue.get(clientId);
  if (!queue) {
    console.warn("[Gateway] No packet queue found for WebSocket. Action cannot proceed.");
    return;
  }

  if (ws.bufferedAmount > MAX_BUFFER_SIZE) {
    const retryInterval = Math.min(50 + retryCount * 50, 500);
    console.log(`[Gateway] Backpressure detected for ${clientId}. Retrying in ${retryInterval}ms (Attempt ${retryCount + 1})`);

    queue.push(action);
    setTimeout(() => handleBackpressure(ws, action, retryCount + 1), retryInterval);
  } else {
    action();

    // Process queued actions while buffer has space
    while (queue.length > 0 && ws.bufferedAmount <= MAX_BUFFER_SIZE) {
      const nextAction = queue.shift();
      if (nextAction) {
        nextAction();
      }
    }
  }
}

/**
 * HTTP Server for game server registration
 */
const httpServer = Bun.serve({
  port: config.port,
  async fetch(req) {
    const url = new URL(req.url);

    // Server registration endpoint
    if (url.pathname === "/register" && req.method === "POST") {
      try {
        const body = await req.json();
        const { id, host, port, wsPort, maxConnections } = body;

        if (!id || !host || !port || !wsPort) {
          return new Response(JSON.stringify({ error: "Missing required fields" }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          });
        }

        const server: GameServer = {
          id,
          host,
          port,
          wsPort,
          lastHeartbeat: Date.now(),
          activeConnections: 0,
          maxConnections: maxConnections || 1000
        };

        gameServers.set(id, server);
        console.log(`[Gateway] Server registered: ${id} (${host}:${port}, ws:${wsPort})`);

        return new Response(JSON.stringify({ success: true, serverId: id }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: "Invalid request body" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // Server heartbeat endpoint
    if (url.pathname === "/heartbeat" && req.method === "POST") {
      try {
        const body = await req.json();
        const { id, activeConnections } = body;

        const server = gameServers.get(id);
        if (server) {
          server.lastHeartbeat = Date.now();
          server.activeConnections = activeConnections || 0;

          return new Response(JSON.stringify({ success: true }), {
            headers: { "Content-Type": "application/json" }
          });
        }

        return new Response(JSON.stringify({ error: "Server not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: "Invalid request body" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // Server unregister endpoint
    if (url.pathname === "/unregister" && req.method === "POST") {
      try {
        const body = await req.json();
        const { id } = body;

        if (gameServers.delete(id)) {
          console.log(`[Gateway] Server unregistered: ${id}`);
          return new Response(JSON.stringify({ success: true }), {
            headers: { "Content-Type": "application/json" }
          });
        }

        return new Response(JSON.stringify({ error: "Server not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: "Invalid request body" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // Status endpoint
    if (url.pathname === "/status" && req.method === "GET") {
      const servers = Array.from(gameServers.values()).map(s => ({
        id: s.id,
        host: s.host,
        port: s.port,
        wsPort: s.wsPort,
        activeConnections: s.activeConnections,
        maxConnections: s.maxConnections,
        lastHeartbeat: s.lastHeartbeat
      }));

      return new Response(JSON.stringify({
        totalServers: gameServers.size,
        totalActiveSessions: clientSessions.size,
        totalMigrations: totalMigrations,
        recentMigrations: migrationHistory.slice(-10), // Last 10 migrations
        servers
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response("Gateway Load Balancer", { status: 200 });
  }
});

/**
 * Extract client ID from URL query parameters or generate one
 */
function getClientId(url: URL): string {
  const clientId = url.searchParams.get("clientId");
  if (clientId) {
    return clientId;
  }

  // Generate a unique client ID if not provided
  return `client-${crypto.randomUUID()}`;
}

/**
 * WebSocket Server for client connections with sticky session support
 */
const wsServer = Bun.serve({
  port: config.wsPort,
  websocket: {
    message(ws: any, message) {
      // Forward message to the assigned game server
      // This is a simple pass-through implementation
      // Use backpressure handling when sending
      handleBackpressure(ws, () => {
        ws.send(message);
      });
    },
    open(ws: any) {
      const clientId = ws.data?.clientId || "unknown";
      console.log(`[Gateway] Client connected: ${clientId}, finding server...`);

      // Initialize packet queue for backpressure handling
      packetQueue.set(clientId, []);

      // Use sticky session logic
      const server = getServerForClient(clientId);
      if (!server) {
        handleBackpressure(ws, () => {
          ws.send(JSON.stringify({
            type: "error",
            message: "No available servers"
          }));
        });
        // Close after a short delay to allow message to be sent
        setTimeout(() => ws.close(), 100);
        return;
      }

      // Send server assignment to client with backpressure handling
      handleBackpressure(ws, () => {
        ws.send(JSON.stringify({
          type: "server_assignment",
          clientId: clientId,
          server: {
            host: server.host,
            port: server.port,
            wsPort: server.wsPort
          }
        }));
      });

      console.log(`[Gateway] Client ${clientId} assigned to server: ${server.id} (${server.host}:${server.wsPort})`);

      // Client should now disconnect from gateway and connect to assigned server
      // In a more sophisticated implementation, the gateway could proxy the connection
    },
    close(ws: any) {
      const clientId = ws.data?.clientId;
      if (clientId) {
        // Clean up packet queue
        packetQueue.delete(clientId);
        console.log(`[Gateway] Client disconnected: ${clientId}`);
      } else {
        console.log("[Gateway] Client disconnected");
      }
    },
    error(ws, error) {
      console.error("[Gateway] WebSocket error:", error);
    }
  },
  fetch(req, server) {
    // Extract client ID from URL query params
    const url = new URL(req.url);
    const clientId = getClientId(url);

    // Upgrade to WebSocket with client data
    if (server.upgrade(req, { data: { clientId } })) {
      return;
    }
    return new Response("Gateway WebSocket Server", { status: 200 });
  }
});

console.log(`[Gateway] HTTP Server running on http://localhost:${config.port}`);
console.log(`[Gateway] WebSocket Server running on ws://localhost:${config.wsPort}`);
console.log(`[Gateway] Waiting for game servers to register...`);
