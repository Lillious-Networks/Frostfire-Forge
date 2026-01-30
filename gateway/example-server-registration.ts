/**
 * Example: How game servers should register with the gateway
 *
 * This file demonstrates how to integrate server registration into your game server.
 * Add this code to your game server startup process.
 */

interface ServerRegistrationConfig {
  gatewayUrl: string;
  serverId: string;
  host: string;
  port: number;
  wsPort: number;
  maxConnections: number;
  heartbeatInterval: number;
}

class GatewayClient {
  private config: ServerRegistrationConfig;
  private heartbeatTimer?: Timer;
  private activeConnections: number = 0;

  constructor(config: ServerRegistrationConfig) {
    this.config = config;
  }

  /**
   * Register this server with the gateway
   */
  async register(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.gatewayUrl}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: this.config.serverId,
          host: this.config.host,
          port: this.config.port,
          wsPort: this.config.wsPort,
          maxConnections: this.config.maxConnections
        })
      });

      const result = await response.json();

      if (result.success) {
        console.log(`[Gateway] Successfully registered with gateway as ${this.config.serverId}`);
        this.startHeartbeat();
        return true;
      }

      console.error("[Gateway] Registration failed:", result.error);
      return false;
    } catch (error) {
      console.error("[Gateway] Failed to register:", error);
      return false;
    }
  }

  /**
   * Send periodic heartbeats to the gateway
   */
  private startHeartbeat() {
    this.heartbeatTimer = setInterval(async () => {
      try {
        const response = await fetch(`${this.config.gatewayUrl}/heartbeat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: this.config.serverId,
            activeConnections: this.activeConnections
          })
        });

        const result = await response.json();
        if (!result.success) {
          console.error("[Gateway] Heartbeat failed, re-registering...");
          await this.register();
        }
      } catch (error) {
        console.error("[Gateway] Heartbeat error:", error);
      }
    }, this.config.heartbeatInterval);
  }

  /**
   * Update the active connection count
   */
  setActiveConnections(count: number) {
    this.activeConnections = count;
  }

  /**
   * Unregister from the gateway (call on shutdown)
   */
  async unregister() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    try {
      await fetch(`${this.config.gatewayUrl}/unregister`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: this.config.serverId
        })
      });
      console.log("[Gateway] Unregistered from gateway");
    } catch (error) {
      console.error("[Gateway] Failed to unregister:", error);
    }
  }
}

// ============================================================================
// USAGE EXAMPLE: Add this to your game server startup code
// ============================================================================

/*
import { GatewayClient } from './gateway-client';

// Create gateway client instance
const gatewayClient = new GatewayClient({
  gatewayUrl: "http://localhost:8080",
  serverId: `server-${crypto.randomUUID()}`,  // or use a static ID
  host: "localhost",                          // or your public IP
  port: 80,                                   // Your HTTP port
  wsPort: 3000,                               // Your WebSocket port
  maxConnections: 1000,
  heartbeatInterval: 5000                     // Send heartbeat every 5 seconds
});

// Register with gateway on startup
await gatewayClient.register();

// Update active connections periodically
// In your WebSocket server's open/close handlers:
wsServer.on('connection', () => {
  const activeCount = getActiveConnectionCount(); // Your logic here
  gatewayClient.setActiveConnections(activeCount);
});

// Graceful shutdown - unregister from gateway
process.on('SIGINT', async () => {
  await gatewayClient.unregister();
  process.exit(0);
});
*/

export { GatewayClient };
export type { ServerRegistrationConfig };
