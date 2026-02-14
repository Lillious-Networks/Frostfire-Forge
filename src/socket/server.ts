const PROCESS_STARTED_AT = Date.now() - performance.now();
const MAX_BUFFER_SIZE = 1024 * 1024 * 1024; // 1GB
const packetQueue = new Map<string, (() => void)[]>();
import "../utility/validate_config.ts";
import crypto from "crypto";
import { packetManager } from "./packet_manager.ts";
import packetReceiver, { despawnBatchQueue, clearBatchQueuesForPlayer, sendAnimationTo } from "./receiver.ts";
import eventEmitter from "node:events";
export const listener = new eventEmitter();
const event = new eventEmitter();
import log from "../modules/logger.ts";
import player from "../systems/player.ts";
import playerCache from "../services/playermanager.ts";
import packet from "../modules/packet.ts";
import path from "node:path";
import fs from "node:fs";
import { generateKeyPair } from "../modules/cipher.ts";
import { despawnPlayerFromAllAOI, startAutoPartyLayerSync, startAutoLayerCondensation } from "./aoi.ts";

// Load settings
import * as settings from "../config/settings.json";
import assetCache from "../services/assetCache.ts";
import { GatewayClient } from "../modules/gateway-client.ts";

const _cert = path.join(import.meta.dir, "../certs/cert.pem");
const _key = path.join(import.meta.dir, "../certs/key.pem");
const _ca = path.join(import.meta.dir, "../certs/cert.ca-bundle");
const useSSL = process.env.WEB_SOCKET_USE_SSL === "true";
let options: Bun.TLSOptions | undefined = undefined;

if (useSSL) {
  if (!fs.existsSync(_cert) || !fs.existsSync(_key)) {
    log.error(`Attempted to locate certificate and key but failed`);
    log.error(`Certificate: ${_cert}`);
    log.error(`Key: ${_key}`);
    throw new Error("SSL certificate or key is missing");
  }
  try {
    // Read certificate and CA bundle, concatenate them for full chain
    const cert = fs.readFileSync(_cert, 'utf-8');
    const ca = fs.existsSync(_ca) ? fs.readFileSync(_ca, 'utf-8') : '';
    const fullChain = ca ? cert + "\n" + ca : cert;

    options = {
      key: Bun.file(_key),
      cert: fullChain,
      ALPNProtocols: "http/1.1,h2",
    };
    log.success(`SSL enabled for WebSocket with certificate chain`);
  } catch (e) {
    log.error(e as string);
  }
}
const RateLimitOptions: RateLimitOptions = {
  // Maximum amount of requests
  maxRequests: settings?.websocketRatelimit?.maxRequests || 2000,
  // Time in milliseconds to remove rate limiting
  time: settings?.websocketRatelimit?.time || 2000,
  // Maximum window time in milliseconds
  maxWindowTime: settings?.websocketRatelimit?.maxWindowTime || 1000,
};

if (settings?.websocketRatelimit?.enabled) {
  log.success(`Rate limiting enabled for websocket connections`);
} else {
  log.warn(`Rate limiting is disabled for websocket connections`);
}

// Set to store all connected clients
const connections = new Set<Identity>();

// Map to track the amount of requests (changed from Array for O(1) lookups)
const ClientRateLimit = new Map<string, ClientRateLimit>();

const keyPair = generateKeyPair(process.env.RSA_PASSPHRASE);

const Server = Bun.serve<Packet, any>({
  port: process.env.WEB_SOCKET_PORT || 3000,
  reusePort: false,
  fetch(req, Server) {
    const id = crypto.randomBytes(32).toString("hex");
    const useragent = req.headers.get("user-agent");
    const chatDecryptionKey = keyPair.publicKey;

    if (!useragent) {
      log.error(`User-Agent header is missing for client with id: ${id}`);
      return new Response("User-Agent header is missing", { status: 400 });
    }

    // Validate connection token from gateway
    const url = new URL(req.url, `http://${req.headers.get("host")}`);
    const token = url.searchParams.get("token");
    const timestamp = url.searchParams.get("timestamp");
    const expiresAt = url.searchParams.get("expiresAt");
    const signature = url.searchParams.get("signature");

    if (!token || !timestamp || !expiresAt || !signature) {
      const ip = req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip") || "unknown";
      const userAgent = req.headers.get("user-agent") || "no user-agent";
      log.warn(`Connection attempt without valid token from: ${ip} (${userAgent})`);
      return new Response("Unauthorized: Missing connection token", { status: 401 });
    }

    // Verify token signature
    const sharedSecret = process.env.GATEWAY_GAME_SERVER_SECRET || "default-secret-change-me";
    const expectedSignature = crypto
      .createHmac("sha256", sharedSecret)
      .update(`${token}:${timestamp}:${expiresAt}`)
      .digest("hex");

    if (signature !== expectedSignature) {
      log.warn(`Connection attempt with invalid token signature from: ${req.headers.get("x-forwarded-for") || "unknown"}`);
      return new Response("Unauthorized: Invalid token", { status: 401 });
    }

    // Check if token is expired
    const now = Date.now();
    if (now > parseInt(expiresAt)) {
      log.warn(`Connection attempt with expired token from: ${req.headers.get("x-forwarded-for") || "unknown"}`);
      return new Response("Unauthorized: Token expired", { status: 401 });
    }

    log.debug(`Valid connection token from gateway for client: ${id}`);

    const success = Server.upgrade(req, { data: { id, useragent, chatDecryptionKey } as any });
    if (!success) {
      log.error(`WebSocket upgrade failed for client with id: ${id}`);
    }
    return success
      ? undefined
      : new Response("WebSocket upgrade error", { status: 400 });
  },
  tls: options,
  websocket: {
    perMessageDeflate: {
      compress: true,
      decompress: true,
    },
    maxPayloadLength: 1024 * 1024 * settings?.websocket?.maxPayloadMB || 1024 * 1024,
    idleTimeout: settings?.websocket?.idleTimeout || 120,
    sendPings: true,
    backpressureLimit: 1024 * 32, // Match our backpressure threshold
    async open(ws: any) {
      ws.binaryType = "arraybuffer";

      if (!ws.data?.id || !ws.data?.useragent || !ws.data?.chatDecryptionKey) {
        log.error(`WebSocket connection missing identity information. Closing connection.`);
        ws.close(1000, "Missing identity information");
        return;
      }

      connections.add({ id: ws.data.id, useragent: ws.data.useragent, chatDecryptionKey: ws.data.chatDecryptionKey });
      packetQueue.set(ws.data.id, []);
      listener.emit("onConnection", ws.data.id);

      if (settings?.websocketRatelimit?.enabled) {
        ClientRateLimit.set(ws.data.id, {
          id: ws.data.id,
          requests: 0,
          rateLimited: false,
          time: null,
          windowTime: 0,
        });
      }

      ws.subscribe("CONNECTION_COUNT" as Subscription["event"]);
      ws.subscribe("BROADCAST" as Subscription["event"]);
      ws.subscribe("DISCONNECT_PLAYER" as Subscription["event"]);

      const timeout = ws.data.useragent.includes("iPhone") || ws.data.useragent.includes("iPad") || ws.data.useragent.includes("Macintosh") ? 1000 : 0;

      setTimeout(() => {
        Server.publish(
          "CONNECTION_COUNT" as Subscription["event"],
          packet.encode(JSON.stringify({
            type: "CONNECTION_COUNT",
            data: connections.size,
          }))
        );
      }, timeout);
    },
    async close(ws: any) {

      if (!ws.data.id) return;
      packetQueue.delete(ws.data.id);

      let clientToDelete;
      for (const client of connections) {
        if (client.id === ws.data.id) {
          clientToDelete = client;
          break;
        }
      }

      if (clientToDelete) {
        const deleted = connections.delete(clientToDelete);
        if (deleted) {
          listener.emit("onDisconnect", { id: ws.data.id });

          const _packet = {
            type: "CONNECTION_COUNT",
            data: connections.size,
          } as unknown as Packet;
          Server.publish(
            "CONNECTION_COUNT" as Subscription["event"],
            packet.encode(JSON.stringify(_packet))
          );
          ws.unsubscribe("CONNECTION_COUNT" as Subscription["event"]);
          ws.unsubscribe("BROADCAST" as Subscription["event"]);
          ws.unsubscribe("DISCONNECT_PLAYER" as Subscription["event"]);

          // Remove from rate limit map (O(1) operation)
          ClientRateLimit.delete(ws.data.id);
        }
        // Disconnect notifications are now handled by AOI system with batching
        // ws.publish("DISCONNECT_PLAYER") removed to avoid duplicate packets
      }
    },
    async message(ws: any, message: any) {
      try {
        if (!ws.data?.id || !message) return;

        message = packet.decode(message);
        const parsedMessage = JSON.parse(message.toString());
        const packetType = parsedMessage?.type;

        const processImmediately = ["TIME_SYNC", "MOVEXY", "STATS", "SERVER_TIME", "ANIMATION"];
        if (processImmediately.includes(packetType)) {
          packetReceiver(null, ws, message.toString());
          return;
        }

        if (settings?.websocketRatelimit?.enabled) {
          const client = ClientRateLimit.get(ws.data.id);
          if (client) {
            if (client.rateLimited) return;

            client.requests++;
            if (client.requests >= RateLimitOptions.maxRequests) {
              client.rateLimited = true;
              client.time = Date.now();
              log.debug(`Client with id: ${ws.data.id} is rate limited`);
              ws.send(
                packet.encode(
                  JSON.stringify({ type: "RATE_LIMITED", data: "Rate limited" })
                )
              );
              return;
            }
          }
        }
        handleBackpressure(ws as any, () => packetReceiver(null, ws, message.toString()));
      } catch (e) {
        log.error(e as string);
      }
    },
  },
});

// Awake event
listener.on("onAwake", async () => {
  await player.clear(); // Clear player sessions on startup
});

// Start event
listener.on("onStart", async () => {});

event.emit("online");

// Initialize gateway client if enabled
let gatewayClient: GatewayClient | null = null;
if (settings?.gateway?.enabled) {
  const serverId = process.env.SERVER_ID || `server-${crypto.randomBytes(8).toString("hex")}`;
  const serverHost = process.env.SERVER_HOST || "localhost";
  const publicHost = process.env.PUBLIC_HOST || serverHost;
  const wsPort = parseInt(process.env.WEB_SOCKET_PORT || "3000");

  gatewayClient = new GatewayClient({
    gatewayUrl: settings.gateway.url,
    serverId,
    host: serverHost,
    publicHost: publicHost,
    port: wsPort,  // WebSocket port (no separate HTTP port anymore)
    wsPort: wsPort,
    maxConnections: settings?.websocket?.maxConnections || 500,
    heartbeatInterval: settings.gateway.heartbeatInterval || 5000,
  });

  // Block until connected to gateway (keeps retrying forever)
  await gatewayClient.registerWithRetry();
}

listener.emit("onAwake");
listener.emit("onStart");

// Start auto party layer sync every 15 seconds
startAutoPartyLayerSync(sendAnimationTo);

// Start auto layer condensation every 5 minutes
startAutoLayerCondensation(sendAnimationTo);

setInterval(() => {
  listener.emit("onUpdate");
}, 1000 / 60);

setInterval(() => {
  listener.emit("onFixedUpdate");
}, 100);

setInterval(() => {
  listener.emit("onSave");
}, 60000);

setInterval(() => {
  listener.emit("onServerTick");
}, 1000);

// Global rate limit window time management (replaces per-client intervals)
// This single interval handles all clients instead of creating 1000+ separate intervals
if (settings?.websocketRatelimit?.enabled) {
  setInterval(() => {
    for (const client of ClientRateLimit.values()) {
      if (client.rateLimited) {
        client.requests = 0;
        client.windowTime = 0;
        continue;
      }
      client.windowTime += 1000;
      if (client.windowTime > RateLimitOptions.maxWindowTime) {
        client.requests = 0;
        client.windowTime = 0;
      }
    }
  }, 1000);
}

// Fixed update loop
listener.on("onUpdate", async () => {});

listener.on("onFixedUpdate", async () => {
  if (settings?.websocketRatelimit?.enabled) {
    if (ClientRateLimit.size < 1) return;
    const timestamp = Date.now();
    for (const client of ClientRateLimit.values()) {
      if (client.rateLimited && client.time) {
        if (timestamp - client.time! > RateLimitOptions.time) {
          client.rateLimited = false;
          client.requests = 0;
          client.time = null;
          log.debug(`Client with id: ${client.id} is no longer rate limited`);
        }
      }
    }
  }
});

listener.on("onServerTick", async () => {
  const playersObj = playerCache.list() as any;
  const players = Object.values(playersObj) as any[];

  const inactiveSet = new Set<string>();
  const nowEpoch = Date.now();

  for (const p of players) {
    if (!p || !p.id) continue;

    const rawLU = typeof p.lastUpdated === "number" ? p.lastUpdated : 0;
    const lastUpdatedEpoch =
      rawLU > 1e11
        ? rawLU
        : rawLU > 0
        ? PROCESS_STARTED_AT + rawLU
        : nowEpoch;

    const wsClosed = !p.ws || p.ws.readyState !== WebSocket.OPEN;
    const tooIdle = (nowEpoch - lastUpdatedEpoch) > 30000;

    if (wsClosed || tooIdle) {
      inactiveSet.add(p.id);
    }
  }

  for (const playerData of players) {
    if (!playerData || inactiveSet.has(playerData.id)) continue;

    handleBackpressure(playerData.ws, () =>
      playerData.ws.send(packetManager.serverTime()[0])
    );

    const rawLA = typeof playerData.last_attack === "number" ? playerData.last_attack : 0;
    const lastAttackEpoch =
      rawLA > 1e11 ? rawLA :
      rawLA > 0 ? (PROCESS_STARTED_AT + rawLA) :
      0;

    if (lastAttackEpoch && (nowEpoch - lastAttackEpoch) > 5000) {
      playerData.pvp = false;
    }

    const { stats } = playerData;
    if (!stats) continue;

    let updated = false;

    if (stats.stamina < stats.total_max_stamina) {
      stats.stamina += Math.max(1, Math.floor(stats.total_max_stamina * 0.05));
      if (stats.stamina > stats.total_max_stamina) stats.stamina = stats.total_max_stamina;
      updated = true;
    }

    if (!playerData.pvp && stats.health < stats.total_max_health) {
      stats.health += Math.max(1, Math.floor(stats.total_max_health * 0.01));
      if (stats.health > stats.total_max_health) stats.health = stats.total_max_health;
      updated = true;
    }

    if (!updated) continue;

    const updateStatsData = {
      id: playerData.id,
      target: playerData.id,
      stats,
    };

    handleBackpressure(playerData.ws, () =>
      playerData.ws.send(packetManager.updateStats(updateStatsData)[0])
    );

    for (const other of players) {
      if (
        other &&
        other.id !== playerData.id &&
        other.location?.map === playerData.location?.map &&
        !inactiveSet.has(other.id) &&
        other.ws &&
        other.ws.readyState === WebSocket.OPEN
      ) {
        handleBackpressure(other.ws, () =>
          other.ws.send(packetManager.updateStats(updateStatsData)[0])
        );
      }
    }
  }
  if (inactiveSet.size > 0) {
    for (const id of inactiveSet) {
      // Check if player still exists in cache AND connections - they might have been removed by websocket close handler
      const stillInCache = playerCache.get(id);
      if (!stillInCache) continue;

      // CRITICAL: Also check if they're still in the connections Set
      // If not, the websocket close handler already handled their disconnect
      let stillConnected = false;
      for (const client of connections) {
        if (client.id === id) {
          stillConnected = true;
          break;
        }
      }
      if (!stillConnected) continue;

      // Disconnect notifications are now handled by AOI system with batching
      // Server.publish("DISCONNECT_PLAYER") removed to avoid duplicate packets

      listener.emit("onDisconnect", { id, reason: "inactive" });

      packetQueue.delete(id);
      ClientRateLimit.delete(id);
    }
  }

  // Update gateway with current connection count
  if (gatewayClient) {
    gatewayClient.setActiveConnections(connections.size);
  }
});

listener.on("onConnection", (data) => {
  if (!data) return;
  log.debug(`New connection: ${data}`);
});

listener.on("onDisconnect", async (data) => {
  if (!data) return;

  try {
    const playerData = playerCache.get(data.id);
    if (!playerData) return;

    // CRITICAL: Clear movement interval FIRST to stop queuing new movements
    if (playerData.movementInterval) {
      clearInterval(playerData.movementInterval);
      playerData.movementInterval = null;
    }

    // CRITICAL: Remove from cache IMMEDIATELY to prevent batch timers from processing this player
    playerCache.remove(playerData.id);

    // Clear all batch queue entries for this player
    clearBatchQueuesForPlayer(playerData.id, playerData.location.map);

    // Despawn player from all other players' AOI with batching
    despawnPlayerFromAllAOI(playerData, "disconnect", despawnBatchQueue);

    // Now do async cleanup operations (player already removed from cache, so no batch packets sent)
    let _worlds: WorldData[] = [];
    try {
      const cachedWorlds = await assetCache.get("worlds");
      if (cachedWorlds) {
        _worlds = Array.isArray(cachedWorlds)
          ? cachedWorlds
          : JSON.parse(cachedWorlds);
      }
    } catch (err) {
      log.error(`[WorldsFetchError] Failed to fetch worlds: ${err}`);
      _worlds = [];
    }

    const thisWorld = _worlds.find(
      (w) => w.name === playerData?.location?.map?.replace(".json", "")
    ) || null;

    if (thisWorld) {
      // Decrement player count, ensuring it never goes below 0
      thisWorld.players = Math.max(0, (thisWorld.players || 0) - 1);
      await assetCache.set("worlds", JSON.stringify(_worlds));
      log.info(
        `World: ${playerData.location.map.replace(".json", "")} now has ${
          thisWorld.players
        } players. (${data.reason})`
      );
    }

    if (!playerData.isGuest) {
      if (playerData?.stats) {
        await player.setStats(playerData.username, playerData.stats);
      }

      if (playerData?.id && playerData?.location) {
        await player.setLocation(
          playerData.id,
          playerData.location.map,
          playerData.location.position
        );
      }
    }

    await player.clearSessionId(playerData.id);

    log.debug(`Disconnected: ${playerData.username} Reason: ${data.reason}`);
  } catch (e) {
    log.error(e as string);
  }
});

listener.on("onSave", async () => {
  const cache = playerCache.list();
  if (!cache) return;
  if (Object.keys(cache).length < 1) return;
  log.info("Saving player data...");
  const startTime = Date.now();

  // Build array of save promises for parallel execution
  const savePromises = Object.entries(cache).map(async ([playerId, row]) => {
    if (!row) return { success: false, playerId, reason: "no_row" };
    if (row.isGuest) return { success: true, playerId, reason: "guest_skipped" };

    if (!row.stats || !row.location) {
      playerCache.remove(playerId);
      return { success: false, playerId, reason: "invalid_data" };
    }

    try {
      // Execute both save operations in parallel for each player
      await Promise.all([
        player.setStats(row.username, row.stats),
        player.setLocation(playerId, row.location.map, row.location.position)
      ]);
      return { success: true, playerId };
    } catch (e) {
      playerCache.remove(playerId);
      log.error(`Failed to save player ${playerId}: ${e as string}`);
      return { success: false, playerId, error: e };
    }
  });

  // Execute all saves in parallel
  const results = await Promise.allSettled(savePromises);

  // Count successes and failures
  const successful = results.filter(r => r.status === "fulfilled" && r.value.success).length;
  const failed = results.filter(r => r.status === "rejected" || (r.status === "fulfilled" && !r.value.success)).length;

  const endTime = Date.now();
  log.info(`Player data saved in ${endTime - startTime}ms (${successful} successful, ${failed} failed/skipped)`);
});

export const events = {
  GetOnlineCount() {
    return connections.size;
  },
  GetOnlineData() {
    return connections;
  },
  Broadcast(_packet: string) {
    log.debug(`Broadcasting packet: ${_packet}`);
    Server.publish(
      "BROADCAST" as Subscription["event"],
      packet.encode(JSON.stringify(_packet))
    );
  },
  GetClientRequests() {
    return ClientRateLimit;
  },
  GetRateLimitedClients() {
    return Array.from(ClientRateLimit.values()).filter((client) => client.rateLimited);
  },
};


function handleBackpressure(ws: any, action: () => void, retryCount = 0) {
  if (retryCount > 20) {
    log.warn("Max retries reached. Action skipped to avoid infinite loop.");
    return;
  }

  if (ws.readyState !== WebSocket.OPEN) {
    log.warn("WebSocket is not open. Action cannot proceed.");
    return;
  }

  const queue = packetQueue.get(ws.data.id);
  if (!queue) {
    log.warn("No packet queue found for WebSocket. Action cannot proceed.");
    return;
  }

  if (ws.bufferedAmount > MAX_BUFFER_SIZE) {
    const retryInterval = Math.min(50 + retryCount * 50, 500);
    log.debug(`Backpressure detected. Retrying in ${retryInterval}ms (Attempt ${retryCount + 1})`);

    queue.push(action);
    setTimeout(() => handleBackpressure(ws, action, retryCount + 1), retryInterval);
  } else {
    action();

    while (queue.length > 0 && ws.bufferedAmount <= MAX_BUFFER_SIZE) {
      const nextAction = queue.shift();
      if (nextAction) {
        nextAction();
      }
    }
  }
}

// Graceful shutdown handler
async function gracefulShutdown(signal: string) {
  log.info(`Received ${signal}, shutting down gracefully...`);

  // Unregister from gateway if enabled
  if (gatewayClient) {
    await gatewayClient.unregister();
  }

  log.info("Shutdown complete");
  process.exit(0);
}

// Register shutdown handlers
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
