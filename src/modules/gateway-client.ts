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
   * Get the gateway URL, upgrading HTTP to HTTPS if gateway supports SSL
   */
  private async getGatewayUrl(): Promise<string> {
    let url = this.config.gatewayUrl;

    // If using HTTP, check if HTTPS is available and upgrade
    if (url.startsWith("http://")) {
      const httpsUrl = url.replace("http://", "https://").replace(":9999", ":9998");
      try {
        // Try a simple HEAD request to see if HTTPS is available
        const testResponse = await fetch(httpsUrl, {
          method: "HEAD",
          signal: AbortSignal.timeout(2000) // 2 second timeout
        });
        if (testResponse.ok || testResponse.status === 404) {
          // HTTPS is available (404 is fine, just means the endpoint exists)
          url = httpsUrl;
        }
      } catch {
        // HTTPS not available, stick with HTTP
      }
    }

    return url;
  }

  /**
   * Register this server with the gateway
   */
  async register(quiet: boolean = false): Promise<boolean> {
    try {
      const gatewayUrl = await this.getGatewayUrl();

      if (!quiet) {
        log.info(`Attempting to register with gateway at ${gatewayUrl}/register`);
      }

      const response = await fetch(`${gatewayUrl}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: this.config.serverId,
          host: this.config.host,
          publicHost: this.config.publicHost || this.config.host,
          port: this.config.port,
          wsPort: this.config.wsPort,
          useSSL: process.env.WEB_SOCKET_USE_SSL === 'true',
          maxConnections: this.config.maxConnections,
          authKey: process.env.GATEWAY_AUTH_KEY
        })
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

        // Sync map checksums with gateway (non-blocking)
        this.syncMapChecksums().catch(error => {
          log.warn(`Map sync failed on registration: ${error}`);
        });

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
        const gatewayUrl = await this.getGatewayUrl();

        const response = await fetch(`${gatewayUrl}/heartbeat`, {
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
          })
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
   * Sync map checksums with gateway and apply updates
   */
  private async syncMapChecksums(): Promise<void> {
    try {
      const { calculateAllMapChecksums, writeMapContent } = await import("./checksums.ts");

      // Calculate local map checksums
      const localChecksums = calculateAllMapChecksums();

      const gatewayUrl = await this.getGatewayUrl();
      const response = await fetch(`${gatewayUrl}/map-checksums`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checksums: localChecksums,
          serverId: this.config.serverId,
          authKey: process.env.GATEWAY_AUTH_KEY
        })
      });

      if (!response.ok) {
        log.error(`Map checksum sync failed with status ${response.status}`);
        return;
      }

      const result = await response.json();

      if (!result.success) {
        log.error(`Map checksum sync failed: ${result.error}`);
        return;
      }

      // Apply outdated maps
      if (result.outdatedMaps && result.outdatedMaps.length > 0) {
        log.info(`Syncing ${result.outdatedMaps.length} map(s) from gateway...`);

        for (const mapUpdate of result.outdatedMaps) {
          const success = writeMapContent(mapUpdate.name, mapUpdate.data);
          if (success) {
            log.success(`Updated map: ${mapUpdate.name}`);
          } else {
            log.error(`Failed to update map: ${mapUpdate.name}`);
          }
        }

        // TODO: Reload all maps and collision data after sync
      } else {
        log.success("All maps are up to date");
      }
    } catch (error) {
      log.error(`Map checksum sync error: ${error}`);
    }
  }

  /**
   * Send updated map to gateway (called after tile editor save)
   */
  async sendMapUpdateToGateway(mapName: string, mapData: any): Promise<boolean> {
    if (!this.registered) {
      log.warn("Not registered with gateway, cannot send map update");
      return false;
    }

    try {
      const gatewayUrl = await this.getGatewayUrl();
      const response = await fetch(`${gatewayUrl}/update-map`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mapName,
          mapData,
          serverId: this.config.serverId,
          authKey: process.env.GATEWAY_AUTH_KEY
        })
      });

      if (!response.ok) {
        log.error(`Failed to send map update to gateway: ${response.status}`);
        return false;
      }

      const result = await response.json();
      if (result.success) {
        log.success(`Map update sent to gateway: ${mapName}`);
        return true;
      } else {
        log.error(`Gateway rejected map update: ${result.error}`);
        return false;
      }
    } catch (error) {
      log.error(`Error sending map update to gateway: ${error}`);
      return false;
    }
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
      const gatewayUrl = await this.getGatewayUrl();
      await fetch(`${gatewayUrl}/unregister`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: this.config.serverId,
          authKey: process.env.GATEWAY_AUTH_KEY
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
