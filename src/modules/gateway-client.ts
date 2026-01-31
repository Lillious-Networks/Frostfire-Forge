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

  constructor(config: ServerRegistrationConfig) {
    this.config = config;
  }

  /**
   * Register this server with the gateway
   */
  async register(): Promise<boolean> {
    try {
      log.info(`Attempting to register with gateway at ${this.config.gatewayUrl}/register`);

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
        log.error(`Gateway registration failed with status ${response.status}: ${errorText}`);
        return false;
      }

      const result = await response.json();

      if (result.success) {
        this.registered = true;
        log.success(`Successfully registered with gateway as ${this.config.serverId}`);
        this.startHeartbeat();
        return true;
      }

      log.error(`Gateway registration failed: ${result.error || "Unknown error"}`);
      return false;
    } catch (error) {
      log.error(`Failed to connect to gateway at ${this.config.gatewayUrl}: ${error}`);
      log.warn("Make sure the gateway is running and the URL is correct");
      return false;
    }
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
    this.heartbeatTimer = setInterval(async () => {
      try {
        const cpuUsage = this.getCpuUsage();
        const ramUsage = await this.getRamUsage();

        const response = await fetch(`${this.config.gatewayUrl}/heartbeat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: this.config.serverId,
            activeConnections: this.activeConnections,
            cpuUsage: cpuUsage,
            ramUsage: ramUsage.used,
            ramTotal: ramUsage.total,
            authKey: process.env.GATEWAY_AUTH_KEY
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
