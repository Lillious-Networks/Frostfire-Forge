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
   * Get container RAM usage in MB (or system RAM if not in container)
   */
  private async getRamUsage(): Promise<{ used: number; total: number }> {
    try {
      // Try to read container memory from cgroup (Docker/Kubernetes)
      // Try cgroup v2 first (newer Docker)
      const currentFile = Bun.file('/sys/fs/cgroup/memory.current');
      if (await currentFile.exists()) {
        const currentText = await currentFile.text();
        const currentBytes = currentText.trim();
        const usedMem = parseInt(currentBytes) / (1024 * 1024);

        // Check if there's a memory limit set
        const maxFile = Bun.file('/sys/fs/cgroup/memory.max');
        if (await maxFile.exists()) {
          const maxText = await maxFile.text();
          const maxBytes = maxText.trim();

          // If max is "max", no limit set - report used vs host total
          if (maxBytes === 'max') {
            const hostTotal = os.totalmem() / (1024 * 1024);
            return {
              used: Math.round(usedMem),
              total: Math.round(hostTotal)
            };
          }

          // Has a limit - report used vs limit
          const totalMem = parseInt(maxBytes) / (1024 * 1024);
          return {
            used: Math.round(usedMem),
            total: Math.round(totalMem)
          };
        }

        // No limit file, use host total
        const hostTotal = os.totalmem() / (1024 * 1024);
        return {
          used: Math.round(usedMem),
          total: Math.round(hostTotal)
        };
      }

      // Try cgroup v1 (older Docker)
      const usageFile = Bun.file('/sys/fs/cgroup/memory/memory.usage_in_bytes');
      if (await usageFile.exists()) {
        const usageText = await usageFile.text();
        const currentBytes = usageText.trim();
        const usedMem = parseInt(currentBytes) / (1024 * 1024);

        // Check if there's a memory limit set
        const limitFile = Bun.file('/sys/fs/cgroup/memory/memory.limit_in_bytes');
        if (await limitFile.exists()) {
          const limitText = await limitFile.text();
          const maxBytes = limitText.trim();
          const totalMem = parseInt(maxBytes) / (1024 * 1024);
          const hostTotal = os.totalmem() / (1024 * 1024);

          // If limit is unrealistically large (no real limit), use actual container usage vs host total
          if (totalMem > hostTotal) {
            return {
              used: Math.round(usedMem),
              total: Math.round(hostTotal)
            };
          }

          // Has a real limit - report used vs limit
          return {
            used: Math.round(usedMem),
            total: Math.round(totalMem)
          };
        }

        // No limit file, use host total
        const hostTotal = os.totalmem() / (1024 * 1024);
        return {
          used: Math.round(usedMem),
          total: Math.round(hostTotal)
        };
      }
    } catch (error) {
      // If reading cgroup fails, fall back to host memory
      log.debug(`Failed to read container memory, using host memory: ${error}`);
    }

    // Not in a container or reading failed - use host memory
    return this.getHostRamUsage();
  }

  /**
   * Get host RAM usage in MB
   */
  private getHostRamUsage(): { used: number; total: number } {
    const totalMem = os.totalmem() / (1024 * 1024); // Convert to MB
    const freeMem = os.freemem() / (1024 * 1024);   // Convert to MB
    const usedMem = totalMem - freeMem;

    return {
      used: Math.round(usedMem),
      total: Math.round(totalMem)
    };
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
