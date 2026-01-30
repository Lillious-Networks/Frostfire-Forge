/**
 * Gateway Client Module
 *
 * Handles registration and communication with the gateway/load balancer
 */

import log from "./logger.ts";

interface ServerRegistrationConfig {
  gatewayUrl: string;
  serverId: string;
  host: string;
  port: number;
  wsPort: number;
  maxConnections: number;
  heartbeatInterval: number;
  authKey: string;
}

class GatewayClient {
  private config: ServerRegistrationConfig;
  private heartbeatTimer?: Timer;
  private activeConnections: number = 0;
  private registered: boolean = false;

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
          maxConnections: this.config.maxConnections,
          authKey: this.config.authKey
        })
      });

      const result = await response.json();

      if (result.success) {
        this.registered = true;
        log.success(`Successfully registered with gateway as ${this.config.serverId}`);
        this.startHeartbeat();
        return true;
      }

      log.error(`Gateway registration failed: ${result.error}`);
      return false;
    } catch (error) {
      log.error(`Failed to register with gateway: ${error}`);
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
            activeConnections: this.activeConnections,
            authKey: this.config.authKey
          })
        });

        const result = await response.json();
        if (!result.success) {
          log.warn("Gateway heartbeat failed, re-registering...");
          this.registered = false;
          await this.register();
        }
      } catch (error) {
        log.error(`Gateway heartbeat error: ${error}`);
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
   * Check if registered with gateway
   */
  isRegistered(): boolean {
    return this.registered;
  }

  /**
   * Unregister from the gateway (call on shutdown)
   */
  async unregister() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    if (!this.registered) {
      return;
    }

    try {
      await fetch(`${this.config.gatewayUrl}/unregister`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: this.config.serverId,
          authKey: this.config.authKey
        })
      });
      this.registered = false;
      log.success("Unregistered from gateway");
    } catch (error) {
      log.error(`Failed to unregister from gateway: ${error}`);
    }
  }
}

export { GatewayClient };
export type { ServerRegistrationConfig };
