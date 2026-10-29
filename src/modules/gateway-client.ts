

import log from "./logger.ts";
import os from "os";
import fs from "node:fs";
import { serverFetch } from "./https_servers.ts";
import { isWhitelistEnabled } from "../services/whitelist.ts";
import { pvpEnabled } from "../systems/pvpzone.ts";
import { reportOf, type BlockReportSource } from "../cluster/blockreport.ts";
import * as settings from "../config/settings.json";

const defaultMap: string = (settings as { default_map?: string }).default_map?.replace(".json", "") || "main";

// Block owners reach the Gateway (POST /blocks) when a table changes: changes of one burst go out together, this long
// after the first of them, with the state of the moment.
const BLOCKS_COALESCE_MS = 250;
// A report that failed is tried again this many times, this far apart; the next registration sends every map anyway.
const BLOCKS_RETRY_MS = 2000;
const BLOCKS_RETRIES = 3;

// Evaluate the TLS state at registration time rather than at import time:
// the local certificate provisioning (ensureLocalCertificate) runs after
// module imports, so an import-time check would report useSSL=false even
// though the listeners are serving TLS.
export function resolveUseSSL(): boolean {
  const _cert = process.env.TLS_CERT_PATH;
  const _key = process.env.TLS_KEY_PATH;
  return process.env.HTTP_USE_SSL === "true" && !!_cert && !!_key && fs.existsSync(_cert) && fs.existsSync(_key);
}

const bareMapName = (map: string): string => (map.endsWith(".json") ? map.slice(0, -5) : map);
// What identifies a report's table: its epoch and a hash of its owners and nodes.
const reportSignature = (report: { epoch: number; owners: string; nodes: string[] }): string => `${report.epoch}:${Bun.hash(`${report.nodes.join(",")}|${report.owners}`)}`;

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
  private previousRtt: number | null = null;
  // Cluster mode: the block table the Gateway is told of, the maps changed since the last report, and the queue the
  // reports go through (one at a time, so an older state never lands after a newer one).
  private blocksSource: BlockReportSource | null = null;
  private stopBlocksWatch: (() => void) | null = null;
  private blocksPending = new Set<string>();
  private blocksTimer?: Timer;
  private blocksQueue: Promise<void> = Promise.resolve();
  // Maps whose last report did not get through (until one does), the ones already warned of, and what is under way:
  // reports in the queue and retries waiting on their timer. A good heartbeat sends the dirty maps again.
  private blocksDirty = new Set<string>();
  private blocksWarned = new Set<string>();
  // Maps already warned of as not encodable: its own flag, so the warning for failed sends is not used up by this one.
  private blocksUnencodableWarned = new Set<string>();
  private blocksInFlight = 0;
  private blocksRetrying = 0;
  // Maps the gateway refused for good (a 400: it has no room for them, or does not take the report), each with the table
  // it refused. Such a map is not sent again until its table changes, or the node registers again.
  private blocksRefused = new Map<string, string>();
  /** How long changes of one burst are held to go out together (settable for tests). */
  blocksCoalesceMs = BLOCKS_COALESCE_MS;
  blocksRetryMs = BLOCKS_RETRY_MS;
  /** The map a fresh character starts on: its report goes first, so the gateway never lacks it for lack of room. */
  blocksFirstMap = defaultMap;

  constructor(config: ServerRegistrationConfig) {
    this.config = config;
  }

  // In cluster mode the gateway knows each node of the realm by its node id; otherwise by the server id.
  private get registrationId(): string {
    return this.config.nodeId || this.config.serverId;
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

      const response = await serverFetch(`${gatewayUrl}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: this.registrationId,
          // Cluster mode only: which node of the realm this is, and the region the realm serves.
          ...(this.config.nodeId ? { nodeId: this.config.nodeId, regionId: this.config.regionId } : {}),
          description: this.config.description || "",
          host: this.config.host,
          publicHost: this.config.publicHost || this.config.host,
          port: this.config.port,
          wtPort: this.config.wtPort ?? this.config.port,
          wtEnabled: this.config.wtEnabled !== false,
          // Legacy field: older gateway versions require wsPort during registration
          wsPort: this.config.wtPort ?? this.config.port,
          useSSL: resolveUseSSL(),
          maxConnections: this.config.maxConnections,
          authKey: process.env.GATEWAY_AUTH_KEY,
          whitelisted: isWhitelistEnabled(),
          // The realm list shows a PvP badge from this; PVP is read once, at start.
          pvp: pvpEnabled()
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
        log.success(`Successfully registered with gateway as ${this.registrationId}`);
        await this.sendHeartbeat();
        this.startHeartbeat();
        // A gateway that restarted (or never heard of this node) learns every table now, not at the next change.
        this.reportAllBlocks();

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

    return Math.round((memUsage.heapUsed + memUsage.external) / (1024 * 1024) * 10) / 10;
  }
  private async sendHeartbeat(): Promise<void> {
    try {
      const cpuUsage = this.getCpuUsage();
      const ramUsage = this.getProcessRamUsage();
      const sendTime = Date.now();
      const gatewayUrl = await this.getGatewayUrl();

      const response = await serverFetch(`${gatewayUrl}/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: this.registrationId,
          activeConnections: this.activeConnections,
          cpuUsage: cpuUsage,
          ramUsage: ramUsage,
          authKey: process.env.GATEWAY_AUTH_KEY,
          timestamp: sendTime,
          rtt: this.previousRtt ?? Date.now() - sendTime,
          // Sent every time: the whitelist can be switched while the server runs.
          whitelisted: isWhitelistEnabled()
        })
      });

      this.previousRtt = Date.now() - sendTime;

      const result = await response.json();
      if (result.success) {
        this.resendDirtyBlocks();
      } else {
        log.warn("Gateway heartbeat failed, reconnecting...");
        this.registered = false;
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = undefined;
        }
        this.startReconnect();
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
  }

  private startHeartbeat() {
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), this.config.heartbeatInterval);
  }

  // A heartbeat ahead of the timer, for a change the gateway should not wait to hear of.
  async heartbeatNow(): Promise<void> {
    if (this.registered) {
      await this.sendHeartbeat();
    }
  }

  setActiveConnections(count: number) {
    this.activeConnections = count;
  }

  /**
   * Cluster mode: tells the Gateway which node owns which block (POST /blocks), so a login can be sent to the owner
   * of the saved point. Every map goes out when the node registers (also when it registers again), and a map goes
   * out again when its table changes. Not with the heartbeat. Without a node id (cluster off) nothing is ever sent.
   */
  reportBlocksFrom(source: BlockReportSource): void {
    if (!this.config.nodeId) return;
    this.stopBlocksWatch?.();
    this.blocksSource = source;
    this.stopBlocksWatch = source.onChange((map) => this.blocksChanged(map));
  }

  // Changes of one burst are sent together, after the first of them; the table is read when they go (last state wins).
  private blocksChanged(map: string): void {
    this.blocksPending.add(map);
    if (this.blocksTimer) return;
    this.blocksTimer = setTimeout(() => {
      this.blocksTimer = undefined;
      const maps = [...this.blocksPending];
      this.blocksPending.clear();
      this.queueBlocks(maps);
    }, this.blocksCoalesceMs);
  }

  private reportAllBlocks(): void {
    const source = this.blocksSource;
    if (!source || !this.registered) return;
    // Every map goes now, which covers what was waiting for the timer.
    clearTimeout(this.blocksTimer);
    this.blocksTimer = undefined;
    this.blocksPending.clear();
    // A gateway that restarted may hold more than the one that refused (and a node that registers again is told afresh).
    this.blocksRefused.clear();
    this.queueBlocks(source.maps());
  }

  // A report that used up its retries stays dirty. The gateway is told of it again at the next good heartbeat (once,
  // with the table as it is then): a gateway that was away for a while must not keep an older epoch for long.
  private resendDirtyBlocks(): void {
    if (this.blocksDirty.size === 0 || !this.blocksSource || !this.registered) return;
    if (this.blocksInFlight > 0 || this.blocksRetrying > 0) return;
    this.queueBlocks([...this.blocksDirty], BLOCKS_RETRIES);
  }

  private queueBlocks(maps: string[], attempt: number = 0): void {
    if (maps.length === 0) return;
    this.blocksInFlight++;
    this.blocksQueue = this.blocksQueue
      .then(() => this.sendBlocks(maps, attempt))
      .catch((error) => { log.error(`Could not report the block owners to the gateway: ${error}`); })
      .finally(() => { this.blocksInFlight--; });
  }

  private async sendBlocks(maps: string[], attempt: number): Promise<void> {
    const source = this.blocksSource;
    if (!source || !this.registered) return;
    const failed: string[] = [];
    const refused: string[] = [];
    let lastError: unknown = null;
    // The map a new character starts on goes first, the others as they came.
    const first = bareMapName(this.blocksFirstMap);
    for (const map of [...maps.filter((name) => bareMapName(name) === first), ...maps.filter((name) => bareMapName(name) !== first)]) {
      const report = reportOf(source, map);
      if (!report) {
        this.blocksDirty.delete(map);
        this.blocksRefused.delete(map);
        if (source.epochOf(map) >= 1) {
          // A real table that cannot be encoded (too many blocks or owners, a long node name): told once, by name.
          if (!this.blocksUnencodableWarned.has(map)) {
            this.blocksUnencodableWarned.add(map);
            log.warn(`The block owners of ${map} cannot be reported to the gateway (too many blocks or owners, or a node name that is too long) and are skipped until the table changes.`);
          }
        } else {
          // No table any more: a later failure is told again.
          this.blocksUnencodableWarned.delete(map);
          this.blocksWarned.delete(map);
        }
        continue;
      }
      // It can be encoded again: if it becomes unencodable later, that is told again.
      this.blocksUnencodableWarned.delete(map);
      // Refused for good, and the table is the one that was refused: nothing new to say.
      const signature = reportSignature(report);
      if (this.blocksRefused.get(map) === signature) {
        this.blocksDirty.delete(map);
        continue;
      }
      try {
        const gatewayUrl = await this.getGatewayUrl();
        const response = await serverFetch(`${gatewayUrl}/blocks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: this.registrationId, authKey: process.env.GATEWAY_AUTH_KEY, ...report })
        });
        // A gateway that does not know the node (it restarted: the next heartbeat registers again, which sends every
        // map) or that has no such route (an older one) is not asked again.
        if (response.status === 404) {
          this.blocksDirty.delete(map);
          this.blocksWarned.delete(map);
          continue;
        }
        // A 400 (no room for the map, a report the gateway does not take) or a 413 will be the same answer next time.
        if (response.status === 400 || response.status === 413) {
          const detail = await response.json().catch(() => null);
          this.blocksRefused.set(map, signature);
          this.blocksDirty.delete(map);
          this.blocksWarned.delete(map);
          refused.push(map);
          lastError = `status ${response.status}${detail?.error ? `: ${detail.error}` : ""}`;
          continue;
        }
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(`status ${response.status}${result?.error ? `: ${result.error}` : ""}`);
        this.blocksDirty.delete(map);
        this.blocksWarned.delete(map);
        this.blocksRefused.delete(map);
      } catch (error) {
        failed.push(map);
        this.blocksDirty.add(map);
        lastError = error;
      }
    }
    // Told once, by name: it is not sent again until its table changes.
    if (refused.length > 0) log.warn(`The gateway refused the block owners of ${refused.join(", ")} and is not sent them again until they change: ${lastError}`);
    if (failed.length === 0) return;
    if (attempt < BLOCKS_RETRIES) {
      this.blocksRetrying++;
      const timer = setTimeout(() => {
        this.blocksRetrying--;
        this.queueBlocks(failed, attempt + 1);
      }, this.blocksRetryMs);
      (timer as any).unref?.();
    } else {
      // One warning per map until it gets through, not one per heartbeat.
      const fresh = failed.filter((map) => !this.blocksWarned.has(map));
      for (const map of fresh) this.blocksWarned.add(map);
      if (fresh.length > 0) log.warn(`The gateway was not told the block owners of ${fresh.join(", ")}, and is asked again at the next heartbeat: ${lastError}`);
    }
  }

  private async syncMapChecksums(attempt: number = 1, maxAttempts: number = 30): Promise<void> {
    try {
      const { calculateAllMapChecksums, writeMapContent } = await import("./checksums.ts");

      const localChecksums = calculateAllMapChecksums();

      const assetServerUrl = this.config.assetServerUrl || process.env.ASSET_SERVER_INTERNAL_URL || process.env.ASSET_SERVER_URL;
      if (!assetServerUrl) {
        log.warn("Asset server URL not configured, skipping map sync");
        return;
      }

      try {
        const response = await serverFetch(`${assetServerUrl}/map-checksums`, {
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
              const { refreshMapVersion } = await import("./assetloader.ts");
              refreshMapVersion(mapUpdate.name);
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
      const assetServerUrl = this.config.assetServerUrl || process.env.ASSET_SERVER_INTERNAL_URL || process.env.ASSET_SERVER_URL;
      if (!assetServerUrl) {
        log.error("Asset server URL not configured, cannot send map update");
        return false;
      }
      const response = await serverFetch(`${assetServerUrl}/update-map`, {
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
    // Nothing more is reported once the node leaves.
    this.stopBlocksWatch?.();
    this.stopBlocksWatch = null;
    this.blocksSource = null;
    clearTimeout(this.blocksTimer);
    this.blocksTimer = undefined;
    this.blocksPending.clear();
    this.blocksDirty.clear();
    this.blocksWarned.clear();
    this.blocksUnencodableWarned.clear();
    this.blocksRefused.clear();

    if (!this.registered) {
      return;
    }

    try {
      const gatewayUrl = await this.getGatewayUrl();
      await serverFetch(`${gatewayUrl}/unregister`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: this.registrationId,
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
