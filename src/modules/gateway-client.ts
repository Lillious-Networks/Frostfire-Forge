/**
 * Gateway Client Module
 *
 * Handles registration and communication with the gateway/load balancer
 */

import log from "./logger.ts";
import os from "os";

interface ServerRegistrationConfig {
  gatewayUrl: string;
  serverId: string;
  host: string;
  publicHost?: string;  // External hostname for clients (optional, defaults to host)
  port: number;
  wsPort: number;
  maxConnections: number;
  heartbeatInterval: number;
}

class GatewayClient {
  private config: ServerRegistrationConfig;
  private heartbeatTimer?: Timer;
  private activeConnections: number = 0;
  private registered: boolean = false;
  private reconnectTimer?: Timer;
  private reconnectAttempts: number = 0;
  private maxReconnectDelay: number = 30000; // Max 30 seconds between retries

  constructor(config: ServerRegistrationConfig) {
    this.config = config;
  }

  /**
   * Register this server with the gateway
   */
  async register(quiet: boolean = false): Promise<boolean> {
    try {
      if (!quiet) {
        log.info(`Attempting to register with gateway at ${this.config.gatewayUrl}/register`);
      }

      const response = await fetch(`${this.config.gatewayUrl}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: this.config.serverId,
          host: this.config.host,
          publicHost: this.config.publicHost || this.config.host,
          port: this.config.port,
          wsPort: this.config.wsPort,
          maxConnections: this.config.maxConnections,
          authKey: process.env.GATEWAY_AUTH_KEY
        }),
        redirect: "follow"
      });

      if (!response.ok) {
        const errorText = await response.text();
        if (!quiet) {
          log.error(`Gateway registration failed with status ${response.status}: ${errorText}`);
        }
        return false;
      }

      const result = await response.json();

      if (result.success) {
        this.registered = true;
        this.reconnectAttempts = 0; // Reset counter on success
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = undefined;
        }
        log.success(`Successfully registered with gateway as ${this.config.serverId}`);
        this.startHeartbeat();
        return true;
      }

      if (!quiet) {
        log.error(`Gateway registration failed: ${result.error || "Unknown error"}`);
      }
      return false;
    } catch (error) {
      if (!quiet) {
        log.error(`Failed to connect to gateway at ${this.config.gatewayUrl}: ${error}`);
      }
      return false;
    }
  }

  /**
   * Register with automatic retry using exponential backoff
   * Blocks until successfully registered
   */
  async registerWithRetry(): Promise<void> {
    log.info(`Connecting to gateway at ${this.config.gatewayUrl}...`);

    while (true) {
      const success = await this.register(this.reconnectAttempts > 0);

      if (success) {
        return;
      }

      this.reconnectAttempts++;

      // Calculate exponential backoff: 1s, 2s, 4s, 8s, 16s, up to max (30s)
      const delay = Math.min(
        1000 * Math.pow(2, Math.min(this.reconnectAttempts - 1, 5)),
        this.maxReconnectDelay
      );

      // Only log every 10 attempts to avoid spam
      if (this.reconnectAttempts === 1) {
        log.warn(`Failed to connect to gateway. Retrying...`);
      } else if (this.reconnectAttempts % 10 === 0) {
        log.warn(`Still attempting to connect to gateway (attempt ${this.reconnectAttempts})...`);
      }

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  /**
   * Start automatic reconnection on disconnect
   */
  private startReconnect() {
    if (this.reconnectTimer) {
      return; // Already reconnecting
    }

    const attemptReconnect = async () => {
      const success = await this.register(true); // Quiet retry

      if (!success) {
        this.reconnectAttempts++;

        const delay = Math.min(
          1000 * Math.pow(2, Math.min(this.reconnectAttempts - 1, 5)),
          this.maxReconnectDelay
        );

        // Only log every 10 attempts
        if (this.reconnectAttempts % 10 === 0) {
          log.warn(`Attempting to reconnect to gateway (attempt ${this.reconnectAttempts})...`);
        }

        this.reconnectTimer = setTimeout(attemptReconnect, delay);
      }
    };

    log.warn("Lost connection to gateway, reconnecting...");
    this.reconnectTimer = setTimeout(attemptReconnect, 1000);
  }

  /**
   * Get system CPU usage percentage
   */
  private getCpuUsage(): number {
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;

    cpus.forEach((cpu) => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type as keyof typeof cpu.times];
      }
      totalIdle += cpu.times.idle;
    });

    const idle = totalIdle / cpus.length;
    const total = totalTick / cpus.length;
    const usage = 100 - ~~(100 * idle / total);

    return Math.max(0, Math.min(100, usage));
  }


  /**
   * Get process RAM usage (RSS - Resident Set Size) in MB
   */
  private getProcessRamUsage(): number {
    const memUsage = process.memoryUsage();
    // RSS = Resident Set Size (total memory allocated for the process)
    return Math.round(memUsage.rss / (1024 * 1024) * 10) / 10; // Round to 1 decimal
  }

  /**
   * Send periodic heartbeats to the gateway
   */
  private startHeartbeat() {
    let previousRtt: number | null = null;

    this.heartbeatTimer = setInterval(async () => {
      try {
        const cpuUsage = this.getCpuUsage();
        const ramUsage = this.getProcessRamUsage();
        const sendTime = Date.now();

        const response = await fetch(`${this.config.gatewayUrl}/heartbeat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: this.config.serverId,
            activeConnections: this.activeConnections,
            cpuUsage: cpuUsage,
            ramUsage: ramUsage,
            authKey: process.env.GATEWAY_AUTH_KEY,
            timestamp: sendTime,
            rtt: previousRtt // Send previous RTT for gateway to use
          }),
          redirect: "follow"
        });

        const receiveTime = Date.now();
        const currentRtt = receiveTime - sendTime;

        const result = await response.json();
        if (!result.success) {
          log.warn("Gateway heartbeat failed, reconnecting...");
          this.registered = false;
          if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
          }
          this.startReconnect();
        } else {
          // Store RTT for next heartbeat
          previousRtt = currentRtt;
        }
      } catch (error) {
        log.error(`Gateway heartbeat error: ${error}`);
        this.registered = false;
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = undefined;
        }
        this.startReconnect();
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
          authKey: process.env.GATEWAY_AUTH_KEY
        }),
        redirect: "follow"
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
