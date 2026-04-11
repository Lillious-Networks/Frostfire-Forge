

import log from "./logger.ts";
import os from "os";

class GatewayClient {
  private config: ServerRegistrationConfig;
  private heartbeatTimer?: Timer;
  private activeConnections: number = 0;
  private registered: boolean = false;
  private reconnectTimer?: Timer;
  private reconnectAttempts: number = 0;
  private maxReconnectDelay: number = 30000;
  private mapSyncPromise: Promise<void> | null = null;
  private mapSyncResolver: (() => void) | null = null;

  constructor(config: ServerRegistrationConfig) {
    this.config = config;
  }

  private async getGatewayUrl(): Promise<string> {
    return this.config.gatewayUrl;
  }

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
          description: this.config.description || "",
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
        this.reconnectAttempts = 0;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = undefined;
        }
        log.success(`Successfully registered with gateway as ${this.config.serverId}`);
        this.startHeartbeat();

        // Create a promise that resolves when map sync completes
        this.mapSyncPromise = new Promise((resolve) => {
          this.mapSyncResolver = resolve;
        });

        this.syncMapChecksums().then(() => {
          if (this.mapSyncResolver) {
            this.mapSyncResolver();
          }
        }).catch(error => {
          log.warn(`Map sync failed on registration: ${error}`);
          if (this.mapSyncResolver) {
            this.mapSyncResolver(); // Resolve anyway after all retries exhausted
          }
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

  async registerWithRetry(): Promise<void> {
    log.info(`Connecting to gateway at ${this.config.gatewayUrl}...`);

    while (true) {
      const success = await this.register(this.reconnectAttempts > 0);

      if (success) {
        return;
      }

      this.reconnectAttempts++;

      const delay = Math.min(
        1000 * Math.pow(2, Math.min(this.reconnectAttempts - 1, 5)),
        this.maxReconnectDelay
      );

      if (this.reconnectAttempts === 1) {
        log.warn(`Failed to connect to gateway. Retrying...`);
      } else if (this.reconnectAttempts % 10 === 0) {
        log.warn(`Still attempting to connect to gateway (attempt ${this.reconnectAttempts})...`);
      }

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  private startReconnect() {
    if (this.reconnectTimer) {
      return;
    }

    const attemptReconnect = async () => {
      const success = await this.register(true);

      if (!success) {
        this.reconnectAttempts++;

        const delay = Math.min(
          1000 * Math.pow(2, Math.min(this.reconnectAttempts - 1, 5)),
          this.maxReconnectDelay
        );

        if (this.reconnectAttempts % 10 === 0) {
          log.warn(`Attempting to reconnect to gateway (attempt ${this.reconnectAttempts})...`);
        }

        this.reconnectTimer = setTimeout(attemptReconnect, delay);
      }
    };

    log.warn("Lost connection to gateway, reconnecting...");
    this.reconnectTimer = setTimeout(attemptReconnect, 1000);
  }

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

  private getProcessRamUsage(): number {
    const memUsage = process.memoryUsage();

    return Math.round(memUsage.rss / (1024 * 1024) * 10) / 10;
  }

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
            rtt: previousRtt
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

  setActiveConnections(count: number) {
    this.activeConnections = count;
  }

  private async syncMapChecksums(attempt: number = 1, maxAttempts: number = 30): Promise<void> {
    try {
      const { calculateAllMapChecksums, writeMapContent } = await import("./checksums.ts");

      const localChecksums = calculateAllMapChecksums();

      const assetServerUrl = this.config.assetServerUrl || process.env.ASSET_SERVER_URL;
      if (!assetServerUrl) {
        log.warn("Asset server URL not configured, skipping map sync");
        return;
      }

      try {
        const response = await fetch(`${assetServerUrl}/map-checksums`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            checksums: localChecksums,
            serverId: this.config.serverId,
            authKey: process.env.ASSET_SERVER_AUTH_KEY || process.env.GATEWAY_AUTH_KEY
          })
        });

        if (!response.ok) {
          throw new Error(`Map checksum sync failed with status ${response.status}`);
        }

        const result = await response.json();

        if (!result.success) {
          throw new Error(result.error || "Unknown error");
        }

        if (result.outdatedMaps && result.outdatedMaps.length > 0) {
          log.info(`Syncing ${result.outdatedMaps.length} map(s) from asset server...`);

          for (const mapUpdate of result.outdatedMaps) {
            const success = writeMapContent(mapUpdate.name, mapUpdate.data);
            if (success) {
              log.success(`Updated map: ${mapUpdate.name}`);
            } else {
              log.error(`Failed to update map: ${mapUpdate.name}`);
            }
          }

        } else {
          log.success("All maps are up to date");
        }
      } catch (syncError) {
        if (attempt < maxAttempts) {
          const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 30000); // Exponential backoff, max 30s
          log.warn(`Map checksum sync failed (attempt ${attempt}/${maxAttempts}): ${syncError}. Retrying in ${delayMs}ms...`);

          await new Promise(resolve => setTimeout(resolve, delayMs));
          return this.syncMapChecksums(attempt + 1, maxAttempts);
        } else {
          throw new Error(`Map checksum sync failed after ${maxAttempts} attempts: ${syncError}`);
        }
      }
    } catch (error) {
      log.error(`Map checksum sync error: ${error}`);
    }
  }

  async sendMapUpdateToGateway(mapName: string, mapData: any): Promise<boolean> {
    try {
      const assetServerUrl = this.config.assetServerUrl || process.env.ASSET_SERVER_URL;
      if (!assetServerUrl) {
        log.error("Asset server URL not configured, cannot send map update");
        return false;
      }
      const response = await fetch(`${assetServerUrl}/update-map`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mapName,
          mapData,
          serverId: this.config.serverId,
          authKey: process.env.ASSET_SERVER_AUTH_KEY || process.env.GATEWAY_AUTH_KEY
        })
      });

      if (!response.ok) {
        log.error(`Failed to send map update to asset server: ${response.status}`);
        return false;
      }

      const result = await response.json();
      if (result.success) {
        log.success(`Map update sent to asset server: ${mapName}`);
        return true;
      } else {
        log.error(`Asset server rejected map update: ${result.error}`);
        return false;
      }
    } catch (error) {
      log.error(`Error sending map update to asset server: ${error}`);
      return false;
    }
  }

  isRegistered(): boolean {
    return this.registered;
  }

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

  async waitForMapSync(timeoutMs: number = 300000): Promise<void> {
    if (!this.mapSyncPromise) {
      throw new Error("Map sync not started - gateway registration failed");
    }

    try {
      const timeoutPromise = new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("Map sync timeout")), timeoutMs)
      );
      await Promise.race([this.mapSyncPromise, timeoutPromise]);
      log.success("Map sync completed successfully");
    } catch (error) {
      log.error(`CRITICAL: Map sync failed - cannot start engine without synced maps: ${error}`);
      throw error; // Re-throw to prevent engine startup
    }
  }
}

export { GatewayClient };
