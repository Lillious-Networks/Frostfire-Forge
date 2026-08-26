const PROCESS_STARTED_AT = Date.now() - performance.now();
let lastSessionValidationTime = 0;
const MAX_BUFFER_SIZE = 1024 * 1024 * 1024;
const packetQueue = new Map<string, (() => void)[]>();
import "../utility/validate_config.ts";
import crypto from "crypto";
import { packetManager } from "./packet_manager.ts";
import { packetTypes } from "./types.ts";
import packetReceiver, { despawnBatchQueue, spawnBatchQueue, movementBatchQueue, clearBatchQueuesForPlayer, clearPlayerTarget, sendAnimationTo, spriteDataCacheReady, teleportPlayerWrapper, removePlayerFromCleanupMaps, removeFromAuthenticationQueues } from "./receiver.ts";
import eventEmitter from "node:events";
import { listener } from "../modules/event_bus.ts";
import { Events, setPlayerPvp } from "../systems/events";
const event = new eventEmitter();
import log from "../modules/logger.ts";
import player from "../systems/player.ts";
import worlds from "../systems/worlds.ts";
import playerCache from "../services/playermanager.ts";
import mapIndex from "../services/mapindex";
import gameLoop from "../services/gameloop";
import packet from "../modules/packet.ts";
import fs from "node:fs";
import query from "../controllers/sqldatabase";
import { generateKeyPair } from "../modules/cipher.ts";
import { despawnPlayerFromAllAOI, startAutoPartyLayerSync, startAutoLayerCondensation, findPlayersWithTargetInAOI, updatePlayerAOI } from "./aoi.ts";
import { loadPlugins, registerAllPlugins, mergePluginSpellsIntoCache } from "../modules/plugin_loader.ts";
import { pluginHandlers, warpInterceptors, packetInterceptors } from "./receiver.ts";
import { startWebTransportServer, TransportConnection } from "./transport.ts";
import { topicBus } from "./topics.ts";
import { connect } from "@webtransport-bun/webtransport";
import { ensureLocalCertificate, computeCertificateHash, certificateSupportsPinning } from "../utility/local_cert.ts";

const httpRouteHandlers = new Map<string, (req: Request) => Promise<Response>>();

import * as settings from "../config/settings.json";
import assetCache from "../services/assetCache.ts";
import entityCache from "../services/entityCache.ts";
import dots from "../systems/dots.ts";
import spellEffects, { getStunsForPlayer, getSlowsForPlayer } from "../systems/spelleffects.ts";
import effectManager from "../services/effectmanager";
import { GatewayClient } from "../modules/gateway-client.ts";
import loot from "../systems/loot";
import cooldownManager from "../services/cooldownmanager";
import { MeshLinks } from "../mesh/links.ts";
import { loadMeshConfig, loadMeshStaticPeers, meshAdvertiseHost, getMeshServerIndex, assertEntityIdSpace } from "../mesh/config.ts";
import * as meshReplication from "../mesh/replication.ts";
import * as meshHandoff from "../mesh/handoff.ts";
import * as meshDelivery from "../mesh/delivery.ts";
import * as regions from "../mesh/regions.ts";
import { MeshMessageType } from "../mesh/protocol.ts";
import { sendToPlayer, sendBestEffortToPlayer } from "../mesh/delivery.ts";
import { dispatchRemoteAvatarInput, dispatchRemoteAvatarPacket, buildMeshSpawnPayload } from "./receiver.ts";

const _cert = process.env.TLS_CERT_PATH;
const _key = process.env.TLS_KEY_PATH;
const _ca = process.env.TLS_CA_PATH;

if (_cert && _key) {
  await ensureLocalCertificate({ certPath: _cert, keyPath: _key, caPath: _ca });
}

const _https = process.env.HTTP_USE_SSL === "true" && !!_cert && !!_key && fs.existsSync(_cert) && fs.existsSync(_key);
let options: Bun.TLSOptions | undefined = undefined;
let webTransportTls: { certPem: string; keyPem: string } | null = null;

if (_cert && _key && fs.existsSync(_cert) && fs.existsSync(_key)) {
  try {
    const cert = fs.readFileSync(_cert, 'utf-8').replace(/^\uFEFF/, '').trim();
    const key = fs.readFileSync(_key, 'utf-8').replace(/^\uFEFF/, '').trim();
    const ca = _ca && fs.existsSync(_ca) ? fs.readFileSync(_ca, 'utf-8').replace(/^\uFEFF/, '').trim() : '';
    const fullChain = ca ? cert + "\n" + ca : cert;

    webTransportTls = {
      certPem: fullChain,
      keyPem: key,
    };

    if (_https) {
      options = {
        key: key,
        cert: fullChain,
      };
      log.success(`SSL enabled for HTTP server with certificate chain`);
    }
  } catch (e) {
    log.error(e as string);
  }
}

if (!webTransportTls) {
  log.error(`Attempted to locate certificate and key but failed`);
  log.error(`Certificate: ${_cert || "(TLS_CERT_PATH not set)"}`);
  log.error(`Key: ${_key || "(TLS_KEY_PATH not set)"}`);
  throw new Error("WebTransport requires a TLS certificate and key. Set TLS_CERT_PATH and TLS_KEY_PATH to your certificate files, or run `bun generate-local-cert` to create a local certificate");
}

const localCertHash = computeCertificateHash(webTransportTls.certPem);
const RateLimitOptions: RateLimitOptions = {

  maxRequests: settings?.packetRatelimit?.maxRequests || 2000,

  time: settings?.packetRatelimit?.time || 2000,

  maxWindowTime: settings?.packetRatelimit?.maxWindowTime || 1000,
};

if (settings?.packetRatelimit?.enabled) {
  log.success(`Rate limiting enabled for connections`);
} else {
  log.warn(`Rate limiting is disabled for connections`);
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

const gamePort = parseInt(process.env.GAME_PORT || "3000");

Bun.serve<Packet, any>({
  port: gamePort,
  reusePort: false,
  development: false,
  fetch(req) {
    const url = new URL(req.url, `http://${req.headers.get("host")}`);
    const requestOrigin = req.headers.get("origin");

    // Return 200 OK
    if (url.pathname === "/status" && req.method === "GET") {
      return new Response(JSON.stringify({ status: "ok" }));
    }

    if (url.pathname === "/mesh-status" && req.method === "GET") {
      const players = Object.values(playerCache.list());
      const remoteSimPlayers = players.filter((p: any) => p.remoteSim);
      const avatars = players.filter((p: any) => p.remoteAvatar);

      return new Response(JSON.stringify({
        enabled: meshConfig.enabled,
        serverId,
        meshServerIndex: getMeshServerIndex(),
        connections: connections.size,
        peers: meshLinks.getConnectedServerIds(),
        peerCounts: meshReplication.getPeerCounts(),
        ghosts: meshReplication.getGhostCount(),
        ghostMaps: meshReplication.getGhostMaps(),
        roster: regions.getRoster(),
        remoteSimPlayers: remoteSimPlayers.map((p: any) => ({ id: p.id, username: p.username, authority: p.remoteAuthority, map: p.location?.map })),
        avatars: avatars.map((p: any) => ({ id: p.id, username: p.username, presence: p.remotePresence, map: p.location?.map })),
      }), { status: 200, headers: { "Content-Type": "application/json" } });
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

    if (url.pathname === "/wt-cert-hash" && req.method === "GET") {
      const corsHeaders = getCORSHeaders(requestOrigin);
      const headers = {
        "Content-Type": "application/json",
        ...corsHeaders
      };

      if (!certificateSupportsPinning(webTransportTls!.certPem)) {
        return new Response(JSON.stringify({ error: "Certificate is not suitable for pinning" }), {
          status: 404,
          headers
        });
      }

      return new Response(JSON.stringify({
        algorithm: "sha-256",
        value: localCertHash,
      }), {
        status: 200,
        headers
      });
    }

    const routeKey = `${req.method}:${url.pathname}`;
    const httpHandler = httpRouteHandlers.get(routeKey);
    if (httpHandler) {
      return httpHandler(req);
    }

    return new Response("Not found", { status: 404 });
  },
  tls: options,
});

function validateConnectionToken(
  token: string | null,
  timestamp: string | null,
  expiresAt: string | null,
  signature: string | null,
  origin: string | null
): boolean {
  if (!token || !timestamp || !expiresAt || !signature) {
    return false;
  }

  const sharedSecret = process.env.GATEWAY_GAME_SERVER_SECRET;
  if (!sharedSecret) {
    log.error("GATEWAY_GAME_SERVER_SECRET environment variable is not set");
    return false;
  }

  const expectedSignature = crypto
    .createHmac("sha256", sharedSecret)
    .update(`${token}:${timestamp}:${expiresAt}`)
    .digest("hex");

  if (signature !== expectedSignature) {
    log.warn(`Connection attempt with invalid token signature`);
    return false;
  }

  if (Date.now() > parseInt(expiresAt)) {
    log.warn(`Connection attempt with expired token`);
    return false;
  }

  if (ALLOWED_ORIGINS.length > 0 && !ALLOWED_ORIGINS.includes("*")) {
    if (!origin || !ALLOWED_ORIGINS.some(o => o.trim() === origin)) {
      log.warn(`Connection attempt with disallowed origin: ${origin}`);
      return false;
    }
  }

  return true;
}

function onTransportOpen(connection: TransportConnection) {
  const id = connection.data.id;

  connections.add({ id, useragent: connection.data.useragent, chatDecryptionKey: connection.data.chatDecryptionKey });
  packetQueue.set(id, []);
  listener.emit("onConnection", id);

  if (settings?.packetRatelimit?.enabled) {
    ClientRateLimit.set(id, {
      id,
      requests: 0,
      rateLimited: false,
      time: null,
      windowTime: 0,
    });
  }

  connection.subscribe("CONNECTION_COUNT");
  connection.subscribe("BROADCAST");
  connection.subscribe("DISCONNECT_PLAYER");

  const timeout = connection.data.useragent.includes("iPhone") || connection.data.useragent.includes("iPad") || connection.data.useragent.includes("Macintosh") ? 1000 : 0;

  setTimeout(() => {
    broadcastConnectionCount();
  }, timeout);
}

let lastConnectionCountBroadcast = 0;
let connectionCountDirty = false;

function broadcastConnectionCount() {
  const now = Date.now();
  if (now - lastConnectionCountBroadcast < 500) {
    connectionCountDirty = true;
    return;
  }

  lastConnectionCountBroadcast = now;
  connectionCountDirty = false;

  topicBus.publish(
    "CONNECTION_COUNT",
    packet.encode(JSON.stringify({
      type: "CONNECTION_COUNT",
      data: {
        count: connections.size + meshReplication.getPeerConnectionCount(),
        serverId,
      },
    }))
  );
}

setInterval(() => {
  if (!connectionCountDirty) return;
  broadcastConnectionCount();
}, 1000);

function onTransportClose(connection: TransportConnection) {
  const id = connection.data.id;
  if (!id) return;

  packetQueue.delete(id);

  let clientToDelete;
  for (const client of connections) {
    if (client.id === id) {
      clientToDelete = client;
      break;
    }
  }

  if (clientToDelete) {
    const deleted = connections.delete(clientToDelete);
    if (deleted) {
      listener.emit("onDisconnect", { id, reason: "player_left" });

      broadcastConnectionCount();
      connection.unsubscribe("CONNECTION_COUNT");
      connection.unsubscribe("BROADCAST");
      connection.unsubscribe("DISCONNECT_PLAYER");

      ClientRateLimit.delete(id);
    }
  }
}

function onTransportMessage(connection: TransportConnection, message: string) {
  try {
    if (!connection.data?.id || !message) return;

    const parsedMessage = JSON.parse(message);
    const packetType = parsedMessage?.type;

    if (settings?.packetRatelimit?.enabled) {
      const client = ClientRateLimit.get(connection.data.id);
      if (client) {
        if (client.rateLimited) return;

        client.requests++;
        if (client.requests >= RateLimitOptions.maxRequests) {
          client.rateLimited = true;
          client.time = Date.now();
          log.debug(`Client with id: ${connection.data.id} is rate limited`);
          connection.send(
            packet.encode(
              JSON.stringify({ type: "RATE_LIMITED", data: "Rate limited" })
            )
          );
          return;
        }
      }
    }

    const processImmediately = ["TIME_SYNC", "MOVEXY", "STATS", "SERVER_TIME", "ANIMATION"];
    if (processImmediately.includes(packetType)) {
      packetReceiver(null, connection, message);
      return;
    }

    handleBackpressure(connection as any, () => packetReceiver(null, connection, message));
  } catch (e) {
    log.error(e as string);
  }
}

const NO_RATE_LIMIT = Number.MAX_SAFE_INTEGER;

// Handshake rate limits default to safe production values, but benchmarking
// needs them disabled. Set WT_HANDSHAKE_RATE_LIMIT_DISABLED=true to remove
// the handshake caps.
const handshakeLimitsDisabled = process.env.WT_HANDSHAKE_RATE_LIMIT_DISABLED === "true";

const webTransportRateLimits = {
  handshakesPerSec: handshakeLimitsDisabled
    ? NO_RATE_LIMIT
    : (settings as any)?.webtransport?.rateLimits?.handshakesPerSec ?? 100,
  handshakesBurst: handshakeLimitsDisabled
    ? NO_RATE_LIMIT
    : (settings as any)?.webtransport?.rateLimits?.handshakesBurst ?? 200,
  handshakesBurstPerPrefix: handshakeLimitsDisabled
    ? NO_RATE_LIMIT
    : (settings as any)?.webtransport?.rateLimits?.handshakesBurstPerPrefix ?? 50,
  streamsPerSec: (settings as any)?.webtransport?.rateLimits?.streamsPerSec ?? 2000,
  streamsBurst: (settings as any)?.webtransport?.rateLimits?.streamsBurst ?? 4000,
  datagramsPerSec: (settings as any)?.webtransport?.rateLimits?.datagramsPerSec ?? 500000,
  datagramsBurst: (settings as any)?.webtransport?.rateLimits?.datagramsBurst ?? 200000,
};

const webTransportServer = startWebTransportServer({
  port: gamePort,
  certPem: webTransportTls!.certPem,
  keyPem: webTransportTls!.keyPem,
  chatDecryptionKey: keyPair.publicKey,
  maxFrameSize: 1024 * 1024 * (((settings as any)?.webtransport?.maxPayloadMB) || 1),
  maxDatagramSize: (settings as any)?.webtransport?.maxDatagramSize || 1200,
  authTimeoutMs: (settings as any)?.webtransport?.authTimeoutMs || 10000,
  idleTimeoutMs: ((settings as any)?.webtransport?.idleTimeout || 120) * 1000,
  maxSessions: (settings as any)?.webtransport?.maxSessions || 2000,
  rateLimits: webTransportRateLimits,
  handlers: {
    validateConnectionToken,
    onOpen: onTransportOpen,
    onClose: onTransportClose,
    onMessage: onTransportMessage,
  },
});

log.info(
  `[WebTransport] maxSessions=${(settings as any)?.webtransport?.maxSessions || 2000} | ` +
  `handshakeLimitsDisabled=${handshakeLimitsDisabled} | handshakesPerSec=${webTransportRateLimits.handshakesPerSec} | handshakesBurst=${webTransportRateLimits.handshakesBurst} | handshakesBurstPerPrefix=${webTransportRateLimits.handshakesBurstPerPrefix}`
);

const webTransportPort = gamePort;

// Startup probe TLS handling. Defaults to skipping verification (the probe
// targets the server's own listener, whose certificate may be self-signed).
// Set TLS_INSECURE_SKIP_VERIFY=false to verify the probe against the server's
// own certificate instead.
const probeInsecureSkipVerify = process.env.TLS_INSECURE_SKIP_VERIFY !== "false";

// The probe URL must match the certificate's SANs when verification is
// enabled - 127.0.0.1 is only valid while skipping verification.
const probeHost = probeInsecureSkipVerify
  ? "127.0.0.1"
  : (process.env.PUBLIC_HOST || process.env.SERVER_HOST || "localhost")
      .replace(/^https?:\/\//, "")
      .replace(/:\d+$/, "");

async function verifyWebTransportListener(port: number): Promise<void> {
  try {
    const tlsOptions = probeInsecureSkipVerify
      ? { insecureSkipVerify: true }
      : { caPem: webTransportTls!.certPem };
    const probe = await connect(`https://${probeHost}:${port}`, { tls: tlsOptions });
    try {
      probe.close({ code: 0, reason: "startup-probe" });
    } catch (error: any) {
      log.debug(`[WebTransport] Startup probe close failed: ${error?.message || error}`);
    }
  } catch (error: any) {
    throw new Error(`WebTransport server failed to accept connections on UDP port ${port}: ${error?.message || error}`);
  }
}

try {
  await verifyWebTransportListener(webTransportPort);
  log.success(`WebTransport listening on UDP port ${webTransportPort}`);
} catch (error: any) {
  log.error(error?.message || String(error));
  throw error;
}

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

const meshConfig = loadMeshConfig();
const meshLinks = new MeshLinks(meshConfig);
const meshPort = meshConfig.enabled ? meshConfig.port : null;

gatewayClient = new GatewayClient({
  gatewayUrl: process.env.GATEWAY_URL || "http://localhost:9999",
  serverId,
  description: process.env.SERVER_DESCRIPTION || "",
  host: serverHost,
  publicHost: publicHost,
  port: gamePort,
  wtPort: gamePort,
  wtEnabled: true,
  maxConnections: (settings as any)?.webtransport?.maxSessions || 2000,
  heartbeatInterval: settings?.gateway?.heartbeatInterval || 5000,
  assetServerUrl: process.env.ASSET_SERVER_URL || "http://localhost:8000",
  meshEnabled: meshConfig.enabled,
  meshPort,
  meshAdvertiseHost: meshConfig.enabled ? meshAdvertiseHost() : null,
  meshCluster: meshConfig.enabled ? meshConfig.cluster : null,
  meshServerIndex: meshConfig.enabled ? getMeshServerIndex() || null : null,
});

// Start the mesh before gateway registration: the mesh does not depend on the
// gateway (peer lists come from static config or later gateway endpoints), and
// registerWithRetry loops forever while the gateway is unreachable.
if (meshConfig.enabled) {
  try {
    await assertEntityIdSpace(query);
    meshReplication.attachMeshLinks(meshLinks);
    meshDelivery.attachMeshLinks(meshLinks);
    meshHandoff.attachMeshLinks(meshLinks);
    meshHandoff.initHandoff(serverId);
    regions.initRegions(serverId, getMeshServerIndex());
    meshReplication.attachHooks({
      updatePlayerAOI: (p) => updatePlayerAOI(p, spawnBatchQueue, despawnBatchQueue),
      queueDespawn: (receiverId, entityId) => {
        if (!despawnBatchQueue.has(receiverId)) {
          despawnBatchQueue.set(receiverId, new Set());
        }
        despawnBatchQueue.get(receiverId)!.add(entityId);
      },
      ensureMovementGroup: (mapName) => {
        if (!movementBatchQueue.has(mapName)) {
          movementBatchQueue.set(mapName, new Map());
        }
      },
      queueLocalMover: (playerId, movementData) => {
        const mover = playerCache.get(playerId);
        if (!mover) return;
        const groupKey = mover.aoi?.layerId || mover.location?.map;
        if (!movementBatchQueue.has(groupKey)) {
          movementBatchQueue.set(groupKey, new Map());
        }
        movementBatchQueue.get(groupKey)!.set(playerId, movementData);
      },
      handleRemoteInput: (playerId, directionIndex) =>
        dispatchRemoteAvatarInput(playerId, directionIndex),
      handleRemotePacket: (playerId, packetJson) =>
        dispatchRemoteAvatarPacket(playerId, packetJson),
      handleHandoffRequest: (peerServerId, payload) =>
        meshHandoff.handleHandoffRequest(peerServerId, payload),
      handleHandoffAccept: (payload) => meshHandoff.handleHandoffAccept(payload),
      handleHandoffComplete: (payload) => meshHandoff.handleHandoffComplete(payload),
      handleHandoffAbort: (payload) => meshHandoff.handleHandoffAbort(payload),
      handleAuthorityDespawn: (peerServerId, playerId) =>
        meshHandoff.handleAuthorityDespawn(peerServerId, playerId),
      handleAuthorityDown: (peerServerId) => meshHandoff.handleAuthorityDown(peerServerId),
    });
    meshHandoff.attachHandoffHooks({
      updatePlayerAOI: (p) => updatePlayerAOI(p, spawnBatchQueue, despawnBatchQueue),
      buildSpawnData: (p) => buildMeshSpawnPayload(p),
    });
    meshLinks.setPeerList(loadMeshStaticPeers());
    meshLinks.onMessage((peerServerId, type, payload) => {
      meshReplication.handleMeshMessage(peerServerId, type, payload);
    });
    meshLinks.onPeerDown((peerServerId) => {
      meshReplication.removeGhostsFromServer(peerServerId);
    });
    await meshLinks.start();

    // Count propagation gets its own lightweight interval: the SERVER_TICK
    // handler is the heaviest loop on the server and would delay both the
    // peer exchange and the client-facing global total under load.
    setInterval(() => {
      meshHandoff.setLocalConnectionCount(connections.size);
      meshLinks.broadcast(
        MeshMessageType.CONNECTION_COUNT,
        new TextEncoder().encode(JSON.stringify({ count: connections.size })),
        false
      );
      broadcastConnectionCount();
    }, 1000);

    // Periodically refresh AOI for local players whose ghost sets changed
    // (ghost spawns/despawns/teleports arriving from mesh peers).
    setInterval(() => {
      meshReplication.flushAoIRefreshQueue();
    }, 250);

    log.success(`[Mesh] Mesh links listening on UDP ${process.env.MESH_HOST || "0.0.0.0"}:${process.env.MESH_PORT || "3001"} (cluster "${meshConfig.cluster}")`);
  } catch (error: any) {
    log.error(`[Mesh] Failed to start mesh links: ${error?.message || error}`);
  }
}

// Registration retries in the background: the game loop and mesh must boot
// even while the gateway is unreachable. In production registration succeeds
// within the first attempt, so this is equivalent to the old blocking await.
gatewayClient.registerWithRetry().catch((error: any) => {
  log.error(`Gateway registration loop failed: ${error?.message || error}`);
});

listener.emit(Events.AWAKE);
listener.emit(Events.START);

gameLoop.start();
if (!meshConfig.enabled) {
  // Layer maintenance only applies when layers bound visibility. Meshed maps
  // bypass layers entirely (AOI radius is the only cap).
  startAutoPartyLayerSync(sendAnimationTo);
  startAutoLayerCondensation(sendAnimationTo);
}

try {
  await loadPlugins(listener);
  await mergePluginSpellsIntoCache();

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
    onWarpCollision: (interceptor: (warp: any, wt: any, player: any, sendPacket: any) => Promise<boolean>) => {
      warpInterceptors.push(interceptor);
    },
    onPacket: (interceptor: (type: string, data: any, wt: any, player: any) => boolean) => {
      packetInterceptors.push(interceptor);
    },
    addHttpRoute: (method: string, route: string, handler: (req: Request) => Promise<Response>) => {
      httpRouteHandlers.set(`${method}:${route}`, handler);
      log.success(`Registered plugin HTTP route: ${method} ${route}`);
    },
    teleportPlayer: async (playerObj: any, mapName: string, x: number, y: number) => {
      await teleportPlayerWrapper(playerObj, mapName, x, y);
    },
    registerSpell: async (spell: SpellData) => {
      if (!spell || !spell.name) {
        log.warn("Plugin tried to register a spell without a name -- skipping");
        return;
      }
      if (!spell.effects || !Array.isArray(spell.effects)) {
        spell.effects = [];
      }
      if (typeof spell.damage !== "number") spell.damage = spell.damage ?? 0;
      if (typeof spell.mana !== "number") spell.mana = spell.mana ?? 0;
      if (typeof spell.range !== "number") spell.range = spell.range ?? 0;
      if (typeof spell.cast_time !== "number") spell.cast_time = spell.cast_time ?? 0;
      if (typeof spell.cooldown !== "number") spell.cooldown = spell.cooldown ?? 0;
      if (typeof spell.can_move !== "number") spell.can_move = spell.can_move ?? 0;
      if (!spell.type) spell.type = "spell";

      const existingSpells = await assetCache.get("spells") as SpellData[] || [];
      if (existingSpells.some((s: SpellData) => s.name === spell.name)) {
        log.warn(`Plugin tried to register duplicate spell "${spell.name}" -- skipping`);
        return;
      }

      existingSpells.unshift(spell);
      await assetCache.set("spells", existingSpells);
      log.success(`Plugin registered spell: ${spell.name}`);
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
  listener.emit(Events.FIXED_UPDATE);
}, 100);

setInterval(() => {
  listener.emit(Events.SAVE);
}, 60000);

setInterval(() => {
  listener.emit(Events.SERVER_TICK);
}, 1000);

if (settings?.packetRatelimit?.enabled) {
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

listener.on(Events.FIXED_UPDATE, async () => {
  if (settings?.packetRatelimit?.enabled) {
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

    const wsClosed = p.remoteAvatar ? false : (!p.ws || p.ws.readyState !== 1);
    const tooIdle = p.remoteAvatar ? false : (nowEpoch - lastUpdatedEpoch) > 30000;

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
        const dbSessionMap = new Map<string, string>();

        // Chunk the IN-clause query so a 2000-player validation never blocks
        // the database pool (and the event loop) with one giant query.
        const VALIDATION_CHUNK_SIZE = 200;
        for (let i = 0; i < userIds.length; i += VALIDATION_CHUNK_SIZE) {
          const chunk = userIds.slice(i, i + VALIDATION_CHUNK_SIZE);
          const dbResults = await query(
            "SELECT id, session_id FROM accounts WHERE id IN (?)",
            [chunk]
          ) as any[];

          for (const r of dbResults) {
            dbSessionMap.set(String(r.id ?? ""), String(r.session_id ?? ""));
          }
        }

        for (const p of players) {
          if (!p?.userid || inactiveSet.has(p.id)) continue;

          const createdEpoch = typeof p.created === "number" && p.created > 0 ? PROCESS_STARTED_AT + p.created : 0;
          if (createdEpoch > 0 && (nowEpoch - createdEpoch) < 10000) continue;

          const dbSid = dbSessionMap.get(String(p.userid)) || "";
          if (dbSid !== String(p.id)) {
            inactiveSet.set(p.id, "session_stolen");
          }
        }
      } catch (e) {
        log.error(`Validation query failed: ${e}`);
      }
    }
  }

  for (const playerData of players) {
    if (!playerData || inactiveSet.has(playerData.id) || (!playerData.ws && !playerData.remoteAvatar)) continue;

    // SERVER_TIME is sent every second to every player; deliver it as an
    // unreliable datagram so it never queues behind the reliable stream.
    sendBestEffortToPlayer(playerData, packetManager.serverTime()[0]);

    const rawLA = typeof playerData.last_attack === "number" ? playerData.last_attack : 0;
    const lastAttackEpoch =
      rawLA > 1e11 ? rawLA :
      rawLA > 0 ? (PROCESS_STARTED_AT + rawLA) :
      0;

    if (lastAttackEpoch && (nowEpoch - lastAttackEpoch) > 5000 && !playerData.isVanished) {
      setPlayerPvp(playerData, false);
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
      sendToPlayer(playerData, packetManager.updateStats(updateStatsData)[0])
    );

    const observers = findPlayersWithTargetInAOI(playerData.id);
    for (const other of observers) {
      if (
        other &&
        !inactiveSet.has(other.id) &&
        other.ws &&
        other.ws.readyState === 1
      ) {
        handleBackpressure(other.ws, () =>
          sendToPlayer(other, packetManager.updateStats(updateStatsData)[0])
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

      if (reason === "session_stolen" && stillInCache.ws?.readyState === 1) {
        sendToPlayer(
          stillInCache,
          packetManager.notify({
            message: "You have been logged in from another location.",
          })
        );
        packetQueue.delete(id);
        ClientRateLimit.delete(id);
        try {
          stillInCache.ws.close(1000, "Logged in from another location");
        } catch {
          console.error(`Failed to close connection for player ${id}`);
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

function cleanupPlayerState(playerData: any) {
    const id = playerData.id;
    const username = playerData.username?.toLowerCase();

    gameLoop.unregisterMovingPlayer(id);
    dots.clearDots(id);
    spellEffects.clearStuns(id);
    spellEffects.clearSlows(id);
    spellEffects.clearVanishes(id);
    playerCache.remove(id);
    mapIndex.removePlayer(id);
    clearBatchQueuesForPlayer(id);
    clearPlayerTarget(id);
    removePlayerFromCleanupMaps(id);
    if (username) cooldownManager.removePlayer(username);
    despawnPlayerFromAllAOI(playerData, "disconnect", despawnBatchQueue);
}

listener.on("onDisconnect", async (data) => {
  if (!data) return;

  try {
    const playerData = playerCache.get(data.id);
    if (!playerData) return;

    if (data.reason === "session_stolen" && playerData.ws?.readyState === 1) {
      sendToPlayer(
        playerData,
        packetManager.notify({
          message: "You have been logged in from another location.",
        })
      );
      try {
        playerData.ws.close(1000, "Logged in from another location");
      } catch (err) {
        console.error(`Failed to close connection for player ${data.id}`);
      }
    }

    if (!playerData.isGuest) {
      const username = playerData.username?.toLowerCase();
      if (username) {
        effectManager.saveDots(username, dots.getPlayerDots(String(playerData.id)) || []);
        effectManager.saveBarriers(username, playerData.barriers || []);
        effectManager.saveStuns(username, getStunsForPlayer(String(playerData.id)) || []);
        effectManager.saveSlows(username, getSlowsForPlayer(String(playerData.id)) || []);
      }

      loot.scheduleCleanup(playerData.username);
    }

    if (meshReplication.isMeshEnabled() && playerData.location?.map) {
      meshReplication.publishPlayerDespawn(playerData.id, playerData.location.map);
    }

    cleanupPlayerState(playerData);

    if (playerData.ws?.data?.connectionToken) {
        removeFromAuthenticationQueues(
            String(playerData.ws.data.id || playerData.id),
            playerData.ws.data.connectionToken
        );
    }

    let worldPlayerCount: number | null = null;
    try {
      worldPlayerCount = await worlds.adjustPlayerCount(playerData?.location?.map || "", -1);
    } catch (err) {
      log.error(`[WorldsFetchError] Failed to update world player count: ${err}`);
    }

    if (worldPlayerCount !== null) {
      // log.info(
      //   `World: ${playerData.location.map.replace(".json", "")} now has ${
      //     worldPlayerCount
      //   } players. (${data.reason})`
      // );
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

    if (playerData.friends && Array.isArray(playerData.friends) && playerData.friends.length > 0) {
      const allPlayers = playerCache.list();
      const usernameIndex = new Map<string, any>();
      for (const p of Object.values(allPlayers)) {
        if (p.ws && p.username) {
          usernameIndex.set(p.username.toLowerCase(), p);
        }
      }
      for (const friendUsername of playerData.friends) {
        const onlineFriend = usernameIndex.get(friendUsername.toLowerCase());
        if (onlineFriend?.ws?.readyState === 1) {
          sendToPlayer(onlineFriend, packetManager.updateOnlineStatus({ online: false, username: playerData.username })[0]);
        }
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
            `[Save] Skipping save for ${row.username} - session stolen (local: ${playerId}, db: ${dbSid || "cleared"})`
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
    if (row.remoteSim) return { success: true, playerId, reason: "remote_sim_skipped" };
    if (sessionInvalidSet.has(playerId)) {
      cleanupPlayerState(row);
      return { success: false, playerId, reason: "session_stolen" };
    }

    if (!row.stats || !row.location) {
      cleanupPlayerState(row);
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
    topicBus.publish(
      "BROADCAST",
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

  if (!ws) {
    // Remote avatar: no local connection queue - deliver immediately (the
    // mesh relay applies its own flow control).
    action();
    return;
  }

  if (ws.readyState !== 1) {
    log.warn("Connection is not open. Action cannot proceed.");
    return;
  }

  const queue = packetQueue.get(ws.data.id);
  if (!queue) {
    log.warn("No packet queue found for connection. Action cannot proceed.");
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

  meshLinks.stop();

  if (gatewayClient) {
    await gatewayClient.unregister();
  }

  try {
    await webTransportServer.close();
  } catch (error) {
    log.debug(`Failed to close WebTransport server: ${error}`);
  }

  log.info("Shutdown complete");
  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

export { gatewayClient };

