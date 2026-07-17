const PROCESS_STARTED_AT = Date.now() - performance.now();
let lastSessionValidationTime = 0;
const MAX_BUFFER_SIZE = 1024 * 1024 * 1024;
const packetQueue = new Map<string, (() => void)[]>();
import "../utility/validate_config.ts";
import crypto from "crypto";
import { packetManager } from "./packet_manager.ts";
import { packetTypes } from "./types.ts";
import packetReceiver, { despawnBatchQueue, clearBatchQueuesForPlayer, clearPlayerTarget, sendAnimationTo, spriteDataCacheReady, teleportPlayerWrapper } from "./receiver.ts";
import eventEmitter from "node:events";
import { listener } from "../modules/event_bus.ts";
import { Events } from "../systems/events";
const event = new eventEmitter();
import log from "../modules/logger.ts";
import player from "../systems/player.ts";
import playerCache from "../services/playermanager.ts";
import mapIndex from "../services/mapindex";
import gameLoop from "../services/gameloop";
import packet from "../modules/packet.ts";
import path from "node:path";
import fs from "node:fs";
import query from "../controllers/sqldatabase";
import { generateKeyPair } from "../modules/cipher.ts";
import { despawnPlayerFromAllAOI, startAutoPartyLayerSync, startAutoLayerCondensation, findPlayersWithTargetInAOI } from "./aoi.ts";
import { loadPlugins, registerAllPlugins } from "../modules/plugin_loader.ts";
import { pluginHandlers, warpInterceptors, packetInterceptors } from "./receiver.ts";

const httpRouteHandlers = new Map<string, (req: Request) => Promise<Response>>();

import * as settings from "../config/settings.json";
import assetCache from "../services/assetCache.ts";
import entityCache from "../services/entityCache.ts";
import dots from "../systems/dots.ts";
import { GatewayClient } from "../modules/gateway-client.ts";

const _cert = process.env.WEB_SOCKET_CERT_PATH || path.join(import.meta.dir, "../certs/cert.pem");
const _key = process.env.WEB_SOCKET_KEY_PATH || path.join(import.meta.dir, "../certs/key.pem");
const _ca = process.env.WEB_SOCKET_CA_PATH || path.join(import.meta.dir, "../certs/cert.ca-bundle");
const _https = process.env.WEB_SOCKET_USE_SSL === "true" && fs.existsSync(_cert) && fs.existsSync(_key);
let options: Bun.TLSOptions | undefined = undefined;

if (_https) {
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

// Load realm whitelist from database if WHITELIST=true
export const realmWhitelist = new Set<string>();
export const isWhitelistEnabled = process.env.WHITELIST === 'true';

const realmId = process.env.SERVER_ID || "default";

if (isWhitelistEnabled) {
  query("SELECT username FROM whitelist WHERE realm = ?", [realmId])
    .then((rows: any[]) => {
      for (const row of rows) {
        realmWhitelist.add(row.username.toLowerCase());
      }
      if (realmWhitelist.size > 0) {
        log.success(`Loaded ${realmWhitelist.size} whitelisted usernames for realm ${realmId} from database`);
      } else {
        log.warn(`Whitelist enabled but no usernames found for realm ${realmId}`);
      }
    })
    .catch((error: any) => {
      log.error(`Failed to load whitelist from database: ${error}`);
    });
}

await spriteDataCacheReady;

// Parse allowed CORS origins from environment variable
const ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || "").split(",").filter(o => o.trim());
const ALLOWED_METHODS = "GET,POST";
const ALLOWED_HEADERS = "Content-Type,Authorization";

// Warn if CORS origins are not configured
if (ALLOWED_ORIGINS.length === 0) {
  log.warn("CORS_ALLOWED_ORIGINS environment variable is not set - cross-origin requests will be blocked");
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
  development: false,
  fetch(req, Server) {
    const url = new URL(req.url, `http://${req.headers.get("host")}`);
    const requestOrigin = req.headers.get("origin");

    // Return 200 OK
    if (url.pathname === "/status" && req.method === "GET") {
      return new Response(JSON.stringify({ status: "ok" }));
    }

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

    const routeKey = `${req.method}:${url.pathname}`;
    const httpHandler = httpRouteHandlers.get(routeKey);
    if (httpHandler) {
      return httpHandler(req);
    }


    const id = parseInt(crypto.randomBytes(4).toString("hex"), 16);
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

    if (ALLOWED_ORIGINS.length > 0) {
      const origin = req.headers.get("Origin");
      if (origin && !ALLOWED_ORIGINS.some(o => o.trim() === origin)) {
        log.warn(`Connection attempt with disallowed origin: ${origin} from: ${req.headers.get("x-forwarded-for") || "unknown"}`);
        return new Response("Forbidden: Origin not allowed", { status: 403 });
      }
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
    perMessageDeflate: false,
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
          listener.emit("onDisconnect", { id: ws.data.id, reason: "player_left" });

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

listener.on(Events.AWAKE, async () => {
  await player.clear();
});

listener.on(Events.START, async () => {
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
  assetServerUrl: process.env.ASSET_SERVER_URL || "http://localhost:8000",
});

await gatewayClient.registerWithRetry();

listener.emit(Events.AWAKE);
listener.emit(Events.START);

gameLoop.start();
startAutoPartyLayerSync(sendAnimationTo);
startAutoLayerCondensation(sendAnimationTo);

try {
  await loadPlugins(listener);

  const engineApi: EngineAPI = {
    addPacketTypes: (types: string[]) => {
      for (const t of types) {
        (packetTypes as any)[t] = t;
      }
      log.success(`Registered ${types.length} plugin packet types`);
    },
    addPacketBuilders: (builders: Record<string, (...args: unknown[]) => unknown>): void => {
      for (const [name, fn] of Object.entries(builders)) {
        (packetManager as any)[name] = fn;
      }
      log.success(`Registered ${Object.keys(builders).length} plugin packet builders`);
    },
    registerHandlers: (handlers: Record<string, PluginHandlerFn>) => {
      for (const [type, handler] of Object.entries(handlers)) {
        pluginHandlers.set(type, handler);
      }
      log.success(`Registered ${Object.keys(handlers).length} plugin packet handlers`);
    },
    onWarpCollision: (interceptor: (warp: any, ws: any, player: any, sendPacket: any) => Promise<boolean>) => {
      warpInterceptors.push(interceptor);
    },
    onPacket: (interceptor: (type: string, data: any, ws: any, player: any) => boolean) => {
      packetInterceptors.push(interceptor);
    },
    addHttpRoute: (method: string, route: string, handler: (req: Request) => Promise<Response>) => {
      httpRouteHandlers.set(`${method}:${route}`, handler);
      log.success(`Registered plugin HTTP route: ${method} ${route}`);
    },
    teleportPlayer: async (playerObj: any, mapName: string, x: number, y: number) => {
      await teleportPlayerWrapper(playerObj, mapName, x, y);
    },
  };

  const registered = await registerAllPlugins(engineApi, listener);
  if (registered.length > 0) {
    log.success(`Auto-starting ${registered.length} plugin(s): ${registered.join(", ")}`);
  }
} catch (err) {
  log.warn(`Plugin loading skipped: ${err}`);
}

setInterval(() => {
  listener.emit(Events.UPDATE);
}, 1000 / 60);

setInterval(() => {
  listener.emit(Events.FIXED_UPDATE);
}, 100);

setInterval(() => {
  listener.emit(Events.SAVE);
}, 60000);

setInterval(() => {
  listener.emit(Events.SERVER_TICK);
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

listener.on(Events.UPDATE, async () => {});

listener.on(Events.FIXED_UPDATE, async () => {
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

listener.on(Events.SERVER_TICK, async () => {
  const playersObj = playerCache.list() as any;
  const players = Object.values(playersObj) as any[];

  const inactiveSet = new Map<string, string>();
  const nowEpoch = Date.now();

  for (const p of players) {
    if (!p || !p.id) continue;

    if (typeof p.created === "number" && p.created > 0 && (nowEpoch - (PROCESS_STARTED_AT + p.created)) < 5000) continue;

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
      inactiveSet.set(p.id, "inactive");
    }
  }

  if (nowEpoch - lastSessionValidationTime > 60000) {
    lastSessionValidationTime = nowEpoch;
    const userIds = players
      .filter((p: any) => p?.userid && !inactiveSet.has(p.id))
      .map((p: any) => Number(p.userid));

    if (userIds.length > 0) {
      try {
        const dbResults = await query(
          "SELECT id, session_id FROM accounts WHERE id IN (?)",
          [userIds]
        ) as any[];

        const dbSessionMap = new Map<string, string>();
        for (const r of dbResults) {
          dbSessionMap.set(String(r.id ?? ""), String(r.session_id ?? ""));
        }

        for (const p of players) {
          if (!p?.userid || inactiveSet.has(p.id)) continue;

          const createdEpoch = typeof p.created === "number" && p.created > 0 ? PROCESS_STARTED_AT + p.created : 0;
          if (createdEpoch > 0 && (nowEpoch - createdEpoch) < 10000) continue;

          const dbSid = dbSessionMap.get(String(p.userid)) || "";
          if (dbSid !== String(p.id)) {
            log.info(
              `[Session] Stale session detected for ${
                p.username
              } (local: ${p.id}, db: ${dbSid || "cleared"})`
            );
            inactiveSet.set(p.id, "session_stolen");
          }
        }
      } catch (e) {
        log.error(`[Session] Validation query failed: ${e}`);
      }
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
    for (const [id, reason] of inactiveSet) {

      const stillInCache = playerCache.get(id);
      if (!stillInCache) continue;

      let stillConnected = false;
      for (const client of connections) {
        if (client.id == id) {
          stillConnected = true;
          break;
        }
      }
      if (!stillConnected) continue;

      if (reason === "session_stolen" && stillInCache.ws?.readyState === WebSocket.OPEN) {
        try {
          stillInCache.ws.send(
            packetManager.notify({
              message: "You have been logged in from another location.",
            })
          );
        } catch {
          console.error(`Failed to send session stolen notification to player ${id}`);
        }
        packetQueue.delete(id);
        ClientRateLimit.delete(id);
        try {
          stillInCache.ws.close(1000, "Logged in from another location");
        } catch {
          console.error(`Failed to close WebSocket for player ${id}`);
        }
        continue;
      }

      listener.emit("onDisconnect", { id, reason });

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

    if (data.reason === "session_stolen" && playerData.ws?.readyState === WebSocket.OPEN) {
      try {
        playerData.ws.send(
          packetManager.notify({
            message: "You have been logged in from another location.",
          })
        );
      } catch (err) {
        console.error(`Failed to send session stolen notification to player ${data.id}`);
      }
      try {
        playerData.ws.close(1000, "Logged in from another location");
      } catch (err) {
        console.error(`Failed to close WebSocket for player ${data.id}`);
      }
    }

    gameLoop.unregisterMovingPlayer(playerData.id);

    dots.clearDots(playerData.id);

    playerCache.remove(playerData.id);

    mapIndex.removePlayer(playerData.id);

    clearBatchQueuesForPlayer(playerData.id, playerData.location.map);

    clearPlayerTarget(playerData.id);

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

listener.on(Events.SAVE, async () => {
  const cache = playerCache.list();
  if (!cache) return;
  if (Object.keys(cache).length < 1) return;
  log.info("Saving player data...");
  const startTime = Date.now();

  const sessionInvalidSet = new Set<string>();
  const nonGuestPlayers = Object.entries(cache).filter(
    ([, row]: [string, any]) => row && !row.isGuest && row.userid
  );

  if (nonGuestPlayers.length > 0) {
    try {
      const userIds = nonGuestPlayers.map(([, row]: [string, any]) => Number(row.userid));
      const dbResults = await query(
        "SELECT id, session_id FROM accounts WHERE id IN (?)",
        [userIds]
      ) as any[];

      const dbSessionMap = new Map<string, string>();
      for (const r of dbResults) {
        dbSessionMap.set(String(r.id ?? ""), String(r.session_id ?? ""));
      }

      for (const [playerId, row] of nonGuestPlayers) {
        const dbSid = dbSessionMap.get(String(row.userid)) || "";
        if (dbSid !== String(playerId)) {
          sessionInvalidSet.add(playerId);
          log.info(
            `[Save] Skipping save for ${row.username} — session stolen (local: ${playerId}, db: ${dbSid || "cleared"})`
          );
        }
      }
    } catch (e) {
      log.error(`[Save] Session validation failed: ${e}`);
    }
  }

  const savePromises = Object.entries(cache).map(async ([playerId, row]) => {
    if (!row) return { success: false, playerId, reason: "no_row" };
    if (row.isGuest) return { success: true, playerId, reason: "guest_skipped" };
    if (row.saveLocked) return { success: true, playerId, reason: "save_locked" };
    if (sessionInvalidSet.has(playerId)) {
      playerCache.remove(playerId);
      return { success: false, playerId, reason: "session_stolen" };
    }

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
