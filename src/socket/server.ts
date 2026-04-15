const PROCESS_STARTED_AT = Date.now() - performance.now();
const MAX_BUFFER_SIZE = 1024 * 1024 * 1024;
const packetQueue = new Map<string, (() => void)[]>();
import "../utility/validate_config.ts";
import crypto from "crypto";
import { packetManager } from "./packet_manager.ts";
import packetReceiver, { despawnBatchQueue, clearBatchQueuesForPlayer, sendAnimationTo, spriteDataCacheReady } from "./receiver.ts";
import eventEmitter from "node:events";
export const listener = new eventEmitter();
const event = new eventEmitter();
import log from "../modules/logger.ts";
import player from "../systems/player.ts";
import playerCache from "../services/playermanager.ts";
import mapIndex from "../services/mapindex";
import gameLoop from "../services/gameloop";
import packet from "../modules/packet.ts";
import path from "node:path";
import fs from "node:fs";
import { generateKeyPair } from "../modules/cipher.ts";
import { despawnPlayerFromAllAOI, startAutoPartyLayerSync, startAutoLayerCondensation, findPlayersWithTargetInAOI } from "./aoi.ts";

import * as settings from "../config/settings.json";
import assetCache from "../services/assetCache.ts";
import entityCache from "../services/entityCache.ts";
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

    const cert = fs.readFileSync(_cert, 'utf-8');
    const key = fs.readFileSync(_key, 'utf-8');
    const ca = fs.existsSync(_ca) ? fs.readFileSync(_ca, 'utf-8') : '';
    const fullChain = ca ? cert + "\n" + ca : cert;

    options = {
      key: key,
      cert: fullChain,
      ALPNProtocols: "http/1.1,h2",
    };
    log.success(`SSL enabled for WebSocket with certificate chain`);
  } catch (e) {
    log.error(e as string);
  }
}
const RateLimitOptions: RateLimitOptions = {

  maxRequests: settings?.websocketRatelimit?.maxRequests || 2000,

  time: settings?.websocketRatelimit?.time || 2000,

  maxWindowTime: settings?.websocketRatelimit?.maxWindowTime || 1000,
};

if (settings?.websocketRatelimit?.enabled) {
  log.success(`Rate limiting enabled for websocket connections`);
} else {
  log.warn(`Rate limiting is disabled for websocket connections`);
}

const connections = new Set<Identity>();

const ClientRateLimit = new Map<string, ClientRateLimit>();

const keyPair = generateKeyPair(process.env.RSA_PASSPHRASE);

await spriteDataCacheReady;

// Parse allowed CORS origins from environment variable
const ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || "").split(",").filter(o => o.trim());
const ALLOWED_METHODS = "GET,POST";
const ALLOWED_HEADERS = "Content-Type,Authorization";

// Warn if CORS origins are not configured
if (ALLOWED_ORIGINS.length === 0) {
  log.warn("CORS_ALLOWED_ORIGINS environment variable is not set - cross-origin requests will be blocked");
} else {
  log.info(`CORS allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
}

// Helper function to get CORS headers
function getCORSHeaders(requestOrigin: string | null): Record<string, string> {
  if (!requestOrigin) {
    return {};
  }

  // Check if the request origin is in the allowed list
  const isAllowed = ALLOWED_ORIGINS.some(origin => {
    const cleanOrigin = origin.trim();
    if (cleanOrigin === "*") return true;
    return cleanOrigin === requestOrigin;
  });

  if (!isAllowed) {
    return {};
  }

  return {
    "Access-Control-Allow-Origin": requestOrigin,
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
    "Access-Control-Max-Age": "3600"
  };
}

const Server = Bun.serve<Packet, any>({
  port: process.env.WEB_SOCKET_PORT || 3000,
  reusePort: false,
  fetch(req, Server) {

    const url = new URL(req.url, `http://${req.headers.get("host")}`);
    const requestOrigin = req.headers.get("origin");

    if (req.method === "OPTIONS") {
      const corsHeaders = getCORSHeaders(requestOrigin);

      if (Object.keys(corsHeaders).length === 0) {
        // Origin not allowed
        return new Response(null, { status: 403 });
      }

      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    if (url.pathname === "/ping" && req.method === "GET") {
      const corsHeaders = getCORSHeaders(requestOrigin);

      return new Response(JSON.stringify({ pong: Date.now() }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        }
      });
    }

    const id = parseInt(crypto.randomBytes(2).toString("hex"), 16);
    const useragent = req.headers.get("user-agent") || "unknown";
    const chatDecryptionKey = keyPair.publicKey;

    const token = url.searchParams.get("token");
    const timestamp = url.searchParams.get("timestamp");
    const expiresAt = url.searchParams.get("expiresAt");
    const signature = url.searchParams.get("signature");

    if (!token || !timestamp || !expiresAt || !signature) {
      return new Response("Unauthorized: Missing connection token", { status: 401 });
    }

    const sharedSecret = process.env.GATEWAY_GAME_SERVER_SECRET;
    if (!sharedSecret) {
      log.error("GATEWAY_GAME_SERVER_SECRET environment variable is not set");
      return new Response("Server misconfiguration", { status: 500 });
    }
    const expectedSignature = crypto
      .createHmac("sha256", sharedSecret)
      .update(`${token}:${timestamp}:${expiresAt}`)
      .digest("hex");

    if (signature !== expectedSignature) {
      log.warn(`Connection attempt with invalid token signature from: ${req.headers.get("x-forwarded-for") || "unknown"}`);
      return new Response("Unauthorized: Invalid token", { status: 401 });
    }

    const now = Date.now();
    if (now > parseInt(expiresAt)) {
      log.warn(`Connection attempt with expired token from: ${req.headers.get("x-forwarded-for") || "unknown"}`);
      return new Response("Unauthorized: Token expired", { status: 401 });
    }

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
    backpressureLimit: 1024 * 512,
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

          ClientRateLimit.delete(ws.data.id);
        }

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

listener.on("onAwake", async () => {
  await player.clear();
});

listener.on("onStart", async () => {
  // Load entities into in-memory cache with full health
  try {
    const entitySystem = (await import("../systems/entities")).default;
    await entityCache.initialize(entitySystem);
  } catch (error: any) {
    log.error(`Error initializing entities on server start: ${error.message}`);
  }
});

event.emit("online");

let gatewayClient: GatewayClient | null = null;
const serverId = process.env.SERVER_ID || `server-${crypto.randomBytes(8).toString("hex")}`;
const serverHost = process.env.SERVER_HOST || "localhost";
const publicHost = process.env.PUBLIC_HOST || serverHost;
const wsPort = parseInt(process.env.WEB_SOCKET_PORT || "3000");

gatewayClient = new GatewayClient({
  gatewayUrl: process.env.GATEWAY_URL || "http://localhost:9999",
  serverId,
  description: process.env.SERVER_DESCRIPTION || "",
  host: serverHost,
  publicHost: publicHost,
  port: wsPort,
  wsPort: wsPort,
  maxConnections: settings?.websocket?.maxConnections || 500,
  heartbeatInterval: settings?.gateway?.heartbeatInterval || 5000,
});

await gatewayClient.registerWithRetry();

listener.emit("onAwake");
listener.emit("onStart");

gameLoop.start();

startAutoPartyLayerSync(sendAnimationTo);

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

setInterval(() => {
  const allPlayers = Object.values(playerCache.list());
  const connectedPlayers = allPlayers.filter((p: any) => p?.ws && p.ws.readyState === 1);

  if (connectedPlayers.length === 0) return;

  let totalBuffered = 0;
  let maxBuffered = 0;
  let playersWithBackpressure = 0;
  let maxBufferedPlayer: any = null;
  const BACKPRESSURE_THRESHOLD = 32 * 1024;

  for (const player of connectedPlayers) {
    const buffered = player.ws.bufferedAmount || 0;
    totalBuffered += buffered;

    if (buffered > maxBuffered) {
      maxBuffered = buffered;
      maxBufferedPlayer = player;
    }

    if (buffered > BACKPRESSURE_THRESHOLD) {
      playersWithBackpressure++;
    }
  }

  const avgBufferedBytes = totalBuffered / connectedPlayers.length;
  const movingPlayers = gameLoop.getStats().movingPlayers;

  const formatBuffer = (bytes: number): string => {
    if (bytes >= 1024) {
      return `${(bytes / 1024).toFixed(1)}KB`;
    }
    return `${Math.round(bytes)}B`;
  };

  const avgBufferStr = formatBuffer(avgBufferedBytes);
  const maxBufferStr = formatBuffer(maxBuffered);

  if (playersWithBackpressure > 0 || avgBufferedBytes > 16 * 1024) {
    log.warn(
      `[BACKPRESSURE] Players: ${connectedPlayers.length} (${movingPlayers} moving) | ` +
      `Avg buffer: ${avgBufferStr} | Max: ${maxBufferStr} | ` +
      `${playersWithBackpressure} players over 32KB` +
      (maxBufferedPlayer ? ` | Worst: ${maxBufferedPlayer.username || maxBufferedPlayer.id}` : '')
    );
  } else if (connectedPlayers.length > 50) {

    const tick = Math.floor(Date.now() / 1000);
    if (tick % 10 === 0) {
      log.info(
        `[BACKPRESSURE] Players: ${connectedPlayers.length} (${movingPlayers} moving) | ` +
        `Avg buffer: ${avgBufferStr} | Max: ${maxBufferStr}`
      );
    }
  }
}, 1000);

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
    if (!playerData || inactiveSet.has(playerData.id) || !playerData.ws) continue;

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

    const observers = findPlayersWithTargetInAOI(playerData.id);
    for (const other of observers) {
      if (
        other &&
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

      const stillInCache = playerCache.get(id);
      if (!stillInCache) continue;

      let stillConnected = false;
      for (const client of connections) {
        if (client.id === id) {
          stillConnected = true;
          break;
        }
      }
      if (!stillConnected) continue;

      listener.emit("onDisconnect", { id, reason: "inactive" });

      packetQueue.delete(id);
      ClientRateLimit.delete(id);
    }
  }

  if (gatewayClient) {
    gatewayClient.setActiveConnections(connections.size);
  }
});

listener.on("onConnection", (data) => {
  if (!data) return;
});

listener.on("onDisconnect", async (data) => {
  if (!data) return;

  try {
    const playerData = playerCache.get(data.id);
    if (!playerData) return;

    gameLoop.unregisterMovingPlayer(playerData.id);

    playerCache.remove(playerData.id);

    mapIndex.removePlayer(playerData.id);

    clearBatchQueuesForPlayer(playerData.id, playerData.location.map);

    despawnPlayerFromAllAOI(playerData, "disconnect", despawnBatchQueue);

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

  const savePromises = Object.entries(cache).map(async ([playerId, row]) => {
    if (!row) return { success: false, playerId, reason: "no_row" };
    if (row.isGuest) return { success: true, playerId, reason: "guest_skipped" };

    if (!row.stats || !row.location) {
      playerCache.remove(playerId);
      return { success: false, playerId, reason: "invalid_data" };
    }

    try {

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

  const results = await Promise.allSettled(savePromises);

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

  if (!ws || ws.readyState !== WebSocket.OPEN) {
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

async function gracefulShutdown(signal: string) {
  log.info(`Received ${signal}, shutting down gracefully...`);

  gameLoop.stop();

  if (gatewayClient) {
    await gatewayClient.unregister();
  }

  log.info("Shutdown complete");
  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

export { gatewayClient };
