const PROCESS_STARTED_AT = Date.now() - performance.now();
let lastSessionValidationTime = 0;
// Backpressure gate for deferred packet handling.
//
// NOTE: this is deliberately set above the transport's own drop threshold so
// the gate never trips. Lowering it (tried: 16MB) makes handleBackpressure's
// retry path reachable, and that path is buggy - it BOTH queues the action and
// schedules a retry of the same action, so a packet can be handled twice. For
// AUTH that means a duplicate login, which the server rejects with
// "Authentication already in progress" and closes the connection. At 2000
// clients this broke logins outright.
//
// Fix the double-dispatch in handleBackpressure before lowering this.
const MAX_BUFFER_SIZE = 1024 * 1024 * 1024;
const packetQueue = new Map<string, (() => void)[]>();
import { forgetNpcStream, warmStreamDataWithin } from "../systems/npcStreaming";
import "../utility/validate_config.ts";
import crypto from "crypto";
import { packetManager, regenStatsFrames } from "./packet_manager.ts";
import { packetTypes } from "./types.ts";
import packetReceiver, { despawnBatchQueue, clearBatchQueuesForPlayer, clearPlayerTarget, sendAnimationTo, spriteDataCacheReady, teleportPlayerWrapper, removePlayerFromCleanupMaps, removeFromAuthenticationQueues, releaseDraggedBy, startArea, forceStopPlayerMovement, handoffRecheck, sendPacket, loginPrefetch } from "./receiver.ts";
import eventEmitter from "node:events";
import { listener } from "../modules/event_bus.ts";
import { Events, setPlayerPvp } from "../systems/events";
const event = new eventEmitter();
import log from "../modules/logger.ts";
import player, { ensureAmbienceColumn, ensureLoginColumns, SESSION_HEARTBEAT_MS } from "../systems/player.ts";
import { ensureClassSchema } from "../systems/classes.ts";
import { ensureMailSchema } from "../systems/mail.ts";
import { ensureMailboxSchema } from "../systems/mailboxeditor.ts";
import { ensureGatheringSchema } from "../systems/gathering/editor.ts";
import fishing, { ensureFishingSchema } from "../systems/fishing";
import { ensureFootprintsSchema } from "../systems/footprints";
import { changedOf, clearChanged, ensureAchievementSchema, forgetRows, markChanged } from "../systems/achievements/store.ts";
import { ensureBuyPriceColumn, ensureHomeItemIcon, ensureSoulboundColumn, ensureSpriteSheetColumn } from "../systems/items.ts";
import { ensureMountEditorPermission } from "../systems/mounteditor.ts";
import worlds from "../systems/worlds.ts";
import playerCache from "../services/playermanager.ts";
import { loadTables, forgetPlayer } from "../services/datacache.ts";
import mapIndex from "../services/mapindex";
import spatialGrid from "../services/spatialgrid.ts";
import layerManager from "../services/layermanager.ts";
import gameLoop from "../services/gameloop";
import packet from "../modules/packet.ts";
import fs from "node:fs";
import query from "../controllers/sqldatabase";
import { generateKeyPair } from "../modules/cipher.ts";
import { despawnPlayerFromAllAOI, releasePlayerAOI, startAutoPartyLayerSync, startAutoLayerCondensation, findPlayersWithTargetInAOI } from "./aoi.ts";
import { loadPlugins, registerAllPlugins, mergePluginSpellsIntoCache } from "../modules/plugin_loader.ts";
import { pluginHandlers, warpInterceptors, packetInterceptors } from "./receiver.ts";
import { startWebTransportServer, TransportConnection, frameLimitFor } from "./transport.ts";
import { checkTicket, nodeTicket, type TicketFields } from "./ticket.ts";
import { clusterEnabled, nodeId, nodeLinkBindHost, nodeLinkBindWarning, nodeLinkHost, nodeLinkPort, regionId } from "../cluster/config.ts";
import { broadcastWorld, deliverToPlayer, isOnline } from "../cluster/deliver.ts";
import { clusterBlocks, clusterNodes, clusterStore, startCluster, stopCluster } from "../cluster/index.ts";
import { dotCredit } from "../cluster/dotcredit.ts";
import { forwardTable } from "../cluster/forwarding.ts";
import { ghosts } from "../cluster/ghosts.ts";
import { walkIdleMsOf, walkOf } from "./arrival.ts";
import { sendHandoffBegin, sendHandoffPrepare, sendHandoffStay } from "./handoffprepare.ts";
import { HandoffGiveUp, playerHandoff, type NodeAddress as HandoffNode } from "../cluster/handoff.ts";
import { SHUTDOWN_DEADLINE_MS, arrivalId, boundedStep, guardedTeleport, spendsTicket } from "../cluster/handoffguards.ts";
import { readyIn as consumableReadyIn, setReadyIn as setConsumableReadyIn } from "../systems/consumables.ts";
import { packetsInFlight, waitIdle } from "../cluster/inflight.ts";
import { playerGhostRecord } from "../cluster/kinds/players.ts";
import { onLinksAttached } from "../cluster/linkhooks.ts";
import { clearShared } from "../cluster/clearguard.ts";
import { fencedSaves } from "../cluster/ownerepoch.ts";
import { spendTicket } from "../cluster/ticketspend.ts";
import { WebTransportLinks } from "../cluster/wtlinks.ts";
import { createHttpFilter, blockedSegmentsFrom, windowFromSettings } from "../modules/httpfilter.ts";
import { topicBus } from "./topics.ts";
import { WebTransport } from "@lillious-networks/webtransport-bun";
import { ensureLocalCertificate, computeCertificateHash, certificateSupportsPinning, getCertificateStatus, certificateSanHostnames } from "../utility/local_cert.ts";
import { startHttpsServers, getInternalServerOptions } from "../modules/https_servers.ts";

const httpRouteHandlers = new Map<string, (req: Request) => Promise<Response>>();

import * as settings from "../config/settings.json";
import assetCache from "../services/assetCache.ts";
import dots, { setRemoteDotCaster } from "../systems/dots.ts";
import spellEffects, { getStunsForPlayer, getSlowsForPlayer } from "../systems/spelleffects.ts";
import { forgetSickness, saveOnDisconnect as saveSicknessOnDisconnect } from "../systems/resurrection.ts";
import effectManager from "../services/effectmanager";
import { GatewayClient, resolveUseSSL } from "../modules/gateway-client.ts";
import { isWhitelistEnabled, loadRealmWhitelist, onWhitelistSwitch } from "../services/whitelist.ts";
import { ensureSubscriptionSchema, refreshSubscriptions, subscriptionsReady, refusal as subscriptionRefusal } from "../systems/subscriptions.ts";
import loot from "../systems/loot";
import creatures from "../systems/creatures";
import gathering from "../systems/gathering";
import achievements from "../systems/achievements";
import cooldownManager from "../services/cooldownmanager";
import { installUnhandledRejectionHandler } from "../services/unhandled";
installUnhandledRejectionHandler();

const _cert = process.env.TLS_CERT_PATH;
const _key = process.env.TLS_KEY_PATH;
const _ca = process.env.TLS_CA_PATH;

// Chrome will not accept a system or locally installed root CA for
// WebTransport, only a publicly trusted one or a certificate pinned by
// hash, so this certificate has to stay self-signed and short lived. It
// must therefore carry every address a browser might dial, including the
// LAN one: a name missing from the SAN fails validation even when pinned.
const certHostnames = ["localhost", "127.0.0.1", "::1"];
for (const host of [process.env.PUBLIC_HOST, process.env.SERVER_HOST]) {
  const trimmed = host?.trim();
  if (trimmed && !certHostnames.includes(trimmed)) {
    certHostnames.push(trimmed);
  }
}

if (_cert && _key) {
  await ensureLocalCertificate({
    certPath: _cert,
    keyPath: _key,
    caPath: _ca,
    hostnames: certHostnames,
  });
}

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

// Fail fast on an expired certificate instead of serving cryptic QUIC
// handshake failures (error 46 / CERTIFICATE_VERIFY_FAILED). CA-signed
// certificates are never auto-regenerated, so expiry needs operator action:
// reissue via your CA, or `bun renew-lan-cert` for local mkcert setups.
const certStatus = getCertificateStatus(webTransportTls.certPem);
if (!certStatus.parseable || certStatus.expired) {
  log.error(`WebTransport TLS certificate is expired or unreadable (valid: ${certStatus.validFrom} -> ${certStatus.validTo}).`);
  log.error(`Clients fail with CERTIFICATE_VERIFY_FAILED until it is renewed. Reissue the certificate (CA-signed setups: renew via your CA or run \`bun renew-lan-cert\`), then restart the server.`);
  throw new Error(`WebTransport TLS certificate expired on ${certStatus.validTo}. Renew the certificate and restart.`);
}
log.info(`WebTransport TLS certificate valid until ${certStatus.validTo} (${certStatus.daysRemaining} days remaining)`);
if ((certStatus.daysRemaining ?? 0) < 3) {
  log.warn(`WebTransport TLS certificate expires in ${certStatus.daysRemaining} days (${certStatus.validTo}). Renew it soon to avoid client handshake failures.`);
}

// A self-signed certificate missing a name was regenerated above; a CA-signed
// one is the operator's to reissue, and until then browsers dialing that name
// fail both /wt-cert-hash ("Failed to fetch") and the WebTransport handshake.
const certSanHostnames = certificateSanHostnames(webTransportTls.certPem);
const uncoveredHostnames = certHostnames.filter((host) => !certSanHostnames.includes(host));
if (uncoveredHostnames.length > 0) {
  log.warn(`WebTransport TLS certificate does not cover ${uncoveredHostnames.join(", ")} (covers: ${certSanHostnames.join(", ")}). Clients connecting to those addresses will fail. Reissue it with them included (local mkcert setups: \`bun renew-lan-cert ${uncoveredHostnames.map((host) => `--host ${host}`).join(" ")}\`), then restart the server.`);
}
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
// Every system is imported by now, so each cached table is known: read them
// before a connection can ask for one.
// The subscription columns and tables first, before the first login and before the table caches
// read them. A failure is said once and leaves subscriptions off: it never stops the start.
await ensureSubscriptionSchema();
// The Ambience and Weather sliders' columns (clientconfig.ambience_volume, weather_volume), the same way: added if
// missing, never stops the start.
await ensureAmbienceColumn();
// The accounts columns every login reads (token_expires, twofa_pending, email_verified), the same way.
await ensureLoginColumns();
// Other realms on this database refuse a login of an account this realm holds while this keeps vouching for it.
setInterval(() => {
  player.markSessionsHeld().catch((error) => log.warn(`Sessions could not be marked as held: ${error}`));
}, SESSION_HEARTBEAT_MS).unref();
// The classes table and accounts.class_id (characters), the same way.
await ensureClassSchema();
// The mail table, the same way.
await ensureMailSchema();
// The mailboxes placed by hand (/mailbox), the same way.
await ensureMailboxSchema();
// The gathering areas (/gathering), the same way.
await ensureGatheringSchema();
// The fishable tiles (the map editor's Fishing tab), the same way.
await ensureFishingSchema();
// The footprints set on tiles (the map editor's Footprints tab), the same way.
await ensureFootprintsSchema();
// The achievements (/achievements) and each player's progress, the same way: before the table caches are read.
await ensureAchievementSchema();
// items.soulbound, the same way: before the items are read.
await ensureSoulboundColumn();
// items.buy_price, the same way.
await ensureBuyPriceColumn();
// items.sprite_sheet, the same way.
await ensureSpriteSheetColumn();
// The mount editor's permission, so it can be granted from the list of permissions.
await ensureMountEditorPermission();
// The home item's icon, when it has none: before the items are read.
await ensureHomeItemIcon();
await loadTables();
await refreshSubscriptions();

const realmId = process.env.SERVER_ID || "default";

// Turned on later (/whitelist on, the control panel), the usernames are loaded then.
if (isWhitelistEnabled()) {
  loadRealmWhitelist()
    .then((size) => {
      if (size > 0) {
        log.success(`Loaded ${size} whitelisted usernames for realm ${realmId} from database`);
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

const gamePort = parseInt(process.env.WEBSRV_PORTSSL || process.env.GAME_PORT || "3000");
const httpInternalPort = parseInt(process.env.WEBSRV_INTERNAL_PORT || "3002");

Bun.serve({
  hostname: "127.0.0.1",
  port: httpInternalPort,
  reusePort: true,
  development: false,
  ...getInternalServerOptions(_cert!, _key!, _ca),
  fetch(req) {
    const url = new URL(req.url, `http://${req.headers.get("host")}`);
    const requestOrigin = req.headers.get("origin");

    // Return 200 OK
    if (url.pathname === "/status" && req.method === "GET") {
      return new Response(JSON.stringify({ status: "ok" }));
    }

    // Creature system health, for the creature load test. Read-only counters and
    // tick timings; no player or account data. ?reset=1 starts a fresh window.
    // Only for a caller with the server's GATEWAY_AUTH_KEY (Authorization: Bearer).
    if (url.pathname === "/creature-stats" && req.method === "GET") {
      if (!holdsServerKey(req)) return new Response("Unauthorized", { status: 401 });
      const snapshot = creatures.stats();
      if (url.searchParams.get("reset") === "1") creatures.resetStats();
      return new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
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

    // The start area the gateway's character page pans over: the default map and the spawn, no player or creature.
    if (url.pathname === "/start-area" && req.method === "GET") {
      const area = startArea();
      return new Response(JSON.stringify(area ?? { error: "The start map is not loaded" }), {
        status: area ? 200 : 404,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", ...getCORSHeaders(requestOrigin) },
      });
    }

    const routeKey = `${req.method}:${url.pathname}`;
    const httpHandler = httpRouteHandlers.get(routeKey);
    if (httpHandler) {
      return httpHandler(req);
    }

    return new Response("Not found", { status: 404 });
  },
});

// settings.json webserverRatelimit and src/config/security.cfg, applied at the
// edge before a request reaches the API.
const securityCfgPath = new URL("../config/security.cfg", import.meta.url);
let blockedSegments: string[] = [];
try {
  if (fs.existsSync(securityCfgPath)) blockedSegments = blockedSegmentsFrom(fs.readFileSync(securityCfgPath, "utf8"));
} catch (error) {
  log.warn(`security.cfg could not be read, so no path is blocked: ${error}`);
}
const httpFilter = createHttpFilter({
  enabled: (settings as any)?.webserverRatelimit?.enabled !== false,
  windowMs: windowFromSettings((settings as any)?.webserverRatelimit?.windowMs),
  max: Number((settings as any)?.webserverRatelimit?.max) || 500,
  blockedSegments,
});

/** Whether a request carries the server's GATEWAY_AUTH_KEY as a bearer token, compared in constant time. */
function holdsServerKey(req: Request): boolean {
  const key = process.env.GATEWAY_AUTH_KEY;
  const given = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1];
  if (!key || !given) return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(key).digest();
  return crypto.timingSafeEqual(a, b);
}

const httpServers = startHttpsServers({
  name: "Game Server",
  sslEnabled: process.env.HTTP_USE_SSL === "true",
  httpPort: parseInt(process.env.WEBSRV_PORT || "") || gamePort,
  httpsPort: gamePort,
  internalPort: httpInternalPort,
  certPath: _cert,
  keyPath: _key,
  caPath: _ca,
  // The WebTransport listener owns UDP on the public port (QUIC shares the
  // port number with the HTTP API), so the edge proxy must not enable
  // HTTP/3 - Bun.serve would try to bind the same UDP port.
  http3: false,
  log,
  filterRequest: (req, ip) => httpFilter(req, ip),
});

/**
 * A connection ticket from the Gateway, or from another node (a SWITCH; see
 * ticket.ts): signed, unexpired, from an allowed origin, and not used before;
 * in cluster mode, for this node. What comes back is the account it is for,
 * which the login must match, and the origin it was signed for.
 */
function validateConnectionToken(fields: TicketFields): { account: string; origin: string } | null {
  const sharedSecret = process.env.GATEWAY_GAME_SERVER_SECRET;
  if (!sharedSecret) {
    log.error("GATEWAY_GAME_SERVER_SECRET environment variable is not set");
    return null;
  }
  const cluster = clusterEnabled();
  const checked = checkTicket(fields, sharedSecret, ALLOWED_ORIGINS, Date.now(), cluster ? nodeId() : "", cluster);
  if (!checked.ok) {
    log.warn(`Connection attempt refused: ${checked.reason}`);
    return null;
  }
  return { account: checked.account, origin: checked.origin };
}

function onTransportOpen(connection: TransportConnection) {
  const id = connection.data.id;
  // A node ticket opens one connection in the whole cluster (cells phase 6): spent now, checked by AUTH. Only a
  // SWITCH ticket: the Gateway's own tickets are not spent. Outside cluster mode there is no store, so none is.
  const store = clusterStore();
  const token = String(connection.data.ticketToken ?? "");
  connection.data.ticketSpent = spendsTicket(store, token)
    ? spendTicket(store, token, Number(connection.data.ticketExpiresAt) || 0)
    : null;

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

  // In cluster mode this is the count of this node's connections only. The
  // region-wide count is the gateway's: it sums the online nodes' connection
  // counts per region (collapseRegions), and that is what the realm list shows.
  // Loss-tolerant status fan-out: a datagram, not a reliable frame - at 1000+
  // connections the per-second broadcast to every player would otherwise
  // contend for each connection's ordered stream queue.
  topicBus.publishBestEffort(
    "CONNECTION_COUNT",
    packet.encode(JSON.stringify({
      type: "CONNECTION_COUNT",
      data: connections.size,
    }))
  );
}

setInterval(() => {
  if (!connectionCountDirty) return;
  broadcastConnectionCount();
}, 1000);

// Low-cost reliable-stream queue health sampling: surfaces connections whose
// stream queue is backing up. bufferedAmount caches its native metrics
// snapshot per connection for 250ms, so this stays cheap at 1000+ players.
let lastStreamQueueLogAt = 0;
setInterval(() => {
  const backedUp: Array<{ id: string; kb: number }> = [];
  let maxBytes = 0;
  for (const playerData of Object.values(playerCache.list())) {
    const wt = playerData.wt;
    if (!wt || wt.readyState !== 1) continue;
    const bytes = wt.bufferedAmount;
    if (bytes > 256 * 1024) {
      backedUp.push({ id: playerData.id, kb: Math.round(bytes / 1024) });
      if (bytes > maxBytes) maxBytes = bytes;
    }
  }
  if (backedUp.length > 0) {
    const now = Date.now();
    if (now - lastStreamQueueLogAt > 60000) {
      lastStreamQueueLogAt = now;
      backedUp.sort((a, b) => b.kb - a.kb);
      log.warn(
        `[StreamQueue] ${backedUp.length} connection(s) with backed-up stream queues (max ${Math.round(maxBytes / 1024)}KB): ` +
        backedUp.slice(0, 5).map((p) => `${p.id}=${p.kb}KB`).join(", ")
      );
    }
  }
}, 10000);

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

// Latency-sensitive packets that bypass the backpressure queue. Hoisted to a
// module-level Set: this was an array literal rebuilt and linearly scanned on
// every single inbound packet.
// HANDOFF_GAP with them: a change of key in a handoff's gap is taken in the order of the moves around it.
const PROCESS_IMMEDIATELY = new Set(["MOVEXY", "STATS", "SERVER_TIME", "ANIMATION", "HANDOFF_GAP"]);

const MSG_PROFILE = process.env.BENCHMARK_PROFILE === "1" || process.env.BENCHMARK_PROFILE === "true";
const msgProf: Record<string, { n: number; ms: number }> = {};
if (MSG_PROFILE) {
  setInterval(() => {
    const parts = Object.entries(msgProf)
      .sort((a, b) => b[1].ms - a[1].ms)
      .map(([t, v]) => `${t}=${v.n}/${v.ms.toFixed(0)}ms`)
      .join(" ");
    log.info(`[profile:inbound] ${parts || "(none)"}`);
    for (const k of Object.keys(msgProf)) delete msgProf[k];
  }, 5000).unref();
}

function onTransportMessage(connection: TransportConnection, message: string) {
  const _mp0 = MSG_PROFILE ? performance.now() : 0;
  let _mpType = "?";
  try {
    if (!connection.data?.id || !message) return;

    // Before the parse: a packet larger than this player may send is not read at all.
    if (message.length > frameLimitFor(playerCache.get(connection.data.id), MAX_FRAME_BYTES, !!(settings as any)?.webtransport?.benchmarkenabled)) {
      connection.close(1009, "Message too large");
      return;
    }

    const parsedMessage = JSON.parse(message);
    const packetType = parsedMessage?.type;
    _mpType = packetType || "?";

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

    // Liveness: any inbound packet proves the client is alive, so refresh the
    // idle timestamp here rather than relying on a dedicated TIME_SYNC.
    // Movement alone is not enough - a player can legitimately stand still
    // while chatting, casting, trading or managing inventory - so every packet
    // type counts. This is the single funnel all inbound packets pass through.
    const activePlayer = playerCache.get(connection.data.id);
    if (activePlayer) {
      activePlayer.lastUpdated = performance.now();
    }

    // Hand the already-parsed object down so packetReceiver doesn't parse the
    // same JSON a second time.
    if (PROCESS_IMMEDIATELY.has(packetType)) {
      packetReceiver(null, connection, message, parsedMessage);
      return;
    }

    handleBackpressure(connection as any, () => packetReceiver(null, connection, message, parsedMessage));
  } catch (e) {
    log.error(e as string);
  } finally {
    if (MSG_PROFILE) {
      const rec = msgProf[_mpType] ?? (msgProf[_mpType] = { n: 0, ms: 0 });
      rec.n++;
      rec.ms += performance.now() - _mp0;
    }
  }
}

/** The largest frame the server takes from anyone (webtransport.maxPayloadMB): players get less, see frameLimitFor. */
const MAX_FRAME_BYTES = 1024 * 1024 * (((settings as any)?.webtransport?.maxPayloadMB) || 1);

const NO_RATE_LIMIT = Number.MAX_SAFE_INTEGER;

// Handshake rate limits default to safe production values, but benchmarking
// needs them disabled. Set WT_HANDSHAKE_RATE_LIMIT_DISABLED=true to remove
// the handshake caps.
const handshakeLimitsDisabled = process.env.WT_HANDSHAKE_RATE_LIMIT_DISABLED === "true";

const webTransportRateLimits = {
  // Handshake caps are DoS guards, but the old defaults (100/s, 200 burst)
  // throttled legitimate 1000+ player login waves to ~10s of handshake time.
  // Raised defaults keep bursts cheap while still bounding per-prefix abuse.
  handshakesPerSec: handshakeLimitsDisabled
    ? NO_RATE_LIMIT
    : (settings as any)?.webtransport?.rateLimits?.handshakesPerSec ?? 1000,
  handshakesBurst: handshakeLimitsDisabled
    ? NO_RATE_LIMIT
    : (settings as any)?.webtransport?.rateLimits?.handshakesBurst ?? 2000,
  handshakesBurstPerPrefix: handshakeLimitsDisabled
    ? NO_RATE_LIMIT
    : (settings as any)?.webtransport?.rateLimits?.handshakesBurstPerPrefix ?? 500,
  streamsPerSec: (settings as any)?.webtransport?.rateLimits?.streamsPerSec ?? 2000,
  streamsBurst: (settings as any)?.webtransport?.rateLimits?.streamsBurst ?? 4000,
  datagramsPerSec: (settings as any)?.webtransport?.rateLimits?.datagramsPerSec ?? 500000,
  datagramsBurst: (settings as any)?.webtransport?.rateLimits?.datagramsBurst ?? 200000,
  datagramsPerSecPerConnection: (settings as any)?.webtransport?.rateLimits?.datagramsPerSecPerConnection ?? 240,
  datagramsBurstPerConnection: (settings as any)?.webtransport?.rateLimits?.datagramsBurstPerConnection ?? 480,
  maxConcurrentStreams: (settings as any)?.webtransport?.rateLimits?.maxConcurrentStreams ?? 16,
};

const serverHost = process.env.SERVER_HOST || "localhost";
const publicHost = process.env.PUBLIC_HOST || serverHost;

// Cells phase 6: a player handed to the node that owns the block they walked into. The handoff itself is
// cluster/handoff.ts; these are its engine side. Nothing here runs outside cluster mode. It sits above
// startCluster: the link hook below is registered before startCluster runs the hooks, and what the hook
// reads (the constants here) is set by then.

/** The live nodes' addresses, read every 2 s while the links are up: a handoff finds its target without a store read. */
const nodeAddresses = new Map<string, HandoffNode>();
/** Whether the link hook is running: a read that ends after it stopped leaves the addresses empty. */
let nodeAddressesLive = false;

let nodeAddressesRead: Promise<void> | null = null;

/** Reads the live nodes' addresses again; a read already running is shared. */
function refreshNodeAddresses(): Promise<void> {
  nodeAddressesRead ??= readNodeAddresses().finally(() => { nodeAddressesRead = null; });
  return nodeAddressesRead;
}

async function readNodeAddresses(): Promise<void> {
  try {
    const live = (await clusterNodes()?.live()) ?? [];
    if (!nodeAddressesLive) return;
    nodeAddresses.clear();
    for (const n of live) {
      nodeAddresses.set(n.nodeId, { nodeId: n.nodeId, publicHost: n.publicHost, port: n.port, wtPort: n.wtPort, useSSL: n.useSSL });
    }
  } catch (error) {
    log.warn(`Node addresses not refreshed (the last ones are kept): ${error}`);
  }
}

/** Whether a connection of this node has `id` open. */
function connectionOpen(id: string): boolean {
  for (const client of connections) if (String(client.id) === id) return true;
  return false;
}

/**
 * What travels with a handed-off player beside the rows saved to the database (Deviation 18: Task 14's seedArrival
 * reads exactly these fields). Cooldowns and the last attack are performance.now() values here, so they travel as
 * remaining or elapsed milliseconds; the effects already hold Date.now() deadlines.
 */
function handoffState(p: any): {
  dots: any[]; barriers: any[]; stuns: any[]; slows: any[];
  cooldowns: Record<string, number>;
  lockoutMs: number;
  sickUntil: number;
  deadState: 0 | 1 | 2;
  corpse: any | null;
  pvp: boolean;
  lastAttackAgoMs: number | null;
  mounted: boolean;
  mount_type: string | null;
  /** The shared consumable cooldown left (ms, 0 when ready): the arrival sets it with consumables' setReadyIn. */
  consumableReadyIn: number;
  /** The direction the player is walking (one of the eight), or null when they stand: the new node goes on walking. */
  walk: string | null;
  /** How long that walk has not stepped (ms): the drain stopped the mover, and the new node makes the time up. */
  walkIdleMs: number;
  /** The player's pose revision (socket/posedgram.ts): the new node counts on from it, so it never sends a lower one. */
  poseRev: number;
} {
  const id = String(p.id);
  const now = performance.now();
  const cooldowns: Record<string, number> = {};
  for (const [spellId, end] of Object.entries(cooldownManager.getActiveCooldowns(p.username))) {
    const left = Math.round(Number(end) - now);
    if (left > 0) cooldowns[spellId] = left;
  }
  const lockout = cooldownManager.getLockout(p.username);
  return {
    dots: dots.getPlayerDots(id) || [],
    barriers: Array.isArray(p.barriers) ? p.barriers : [],
    stuns: getStunsForPlayer(id) || [],
    slows: getSlowsForPlayer(id) || [],
    cooldowns,
    lockoutMs: lockout > now ? Math.round(lockout - now) : 0,
    sickUntil: Number(p.resurrectionSickUntil) || 0,
    deadState: p.isGhost ? 2 : p.isDead ? 1 : 0,
    corpse: p.corpse ?? null,
    pvp: !!p.pvp,
    lastAttackAgoMs: typeof p.last_attack === "number" ? Math.max(0, Math.round(now - p.last_attack)) : null,
    mounted: !!p.mounted,
    mount_type: p.mount_type ?? null,
    consumableReadyIn: consumableReadyIn(p.username),
    walk: walkOf(p),
    walkIdleMs: walkIdleMsOf(p, now),
    poseRev: Number.isSafeInteger(p.poseRev) && p.poseRev > 0 ? p.poseRev : 0,
  };
}

/**
 * Takes a handed-off player off this node in the handoff's synchronous step. Not a disconnect: the session, the
 * row cache, the creature threat and the friends' view of them stay; what travelled in the snapshot is dropped here.
 * It never throws (handoff.ts): each step is tried on its own, so one that fails cannot stop the ones after it.
 */
function releaseHandedOff(p: any): void {
  const id = String(p.id);
  const lower = String(p.username || "").toLowerCase();
  // First: from here on playerCache.set refuses the player, and presence holds its directory entry.
  p.handedOff = true;
  if (p.wt?.data) p.wt.data.handedOff = true;
  const steps: Array<[string, () => void]> = [
    ["clean up its state", () => {
      try {
        cleanupPlayerState(p, { despawn: false });
      } finally {
        // Whatever failed in there, the player does not stay live here: the handoff goes on and the client is
        // sent on, so a player still in the cache would be on two nodes.
        // Nor does it stay in the spatial indexes, if the cleanup threw before it reached them (each removal is idempotent).
        const removals: Array<[string, () => void]> = [
          ["player cache", () => { if (playerCache.get(id) === p) playerCache.remove(id); }],
          ["map index", () => mapIndex.removePlayer(id)],
          ["spatial grid", () => spatialGrid.removePlayer(id)],
          ["layer", () => layerManager.removePlayerFromLayer(id)],
        ];
        for (const [where, remove] of removals) {
          try {
            remove();
          } catch (error) {
            log.error(`Handoff release of ${p.username}: not removed from the ${where}: ${error}`);
          }
        }
      }
    }],
    // The login path restores these by username: a later login here must not find stale copies.
    ["drop its cooldowns", () => cooldownManager.removePlayer(p.username)],
    ["drop its saved effects", () => {
      if (!lower) return;
      effectManager.saveDots(lower, []);
      effectManager.saveBarriers(lower, []);
      effectManager.saveStuns(lower, []);
      effectManager.saveSlows(lower, []);
    }],
    ["forget its sickness", () => forgetSickness(p)],
    // It travels in the snapshot (consumableReadyIn): a hand-back here must not find the old one.
    ["drop its consumable cooldown", () => setConsumableReadyIn(p.username, 0)],
    ["close its creature editor", () => creatures.closeEditorFor(id)],
    ["forget its creatures", () => creatures.sync.forget(id)],
    ["forget its gathering nodes", () => gathering.sync.forget(id)],
    ["end its fishing", () => { fishing.endSession(id); }],
    ["release whom it drags", () => releaseDraggedBy(p.id)],
    ["clear its login queues", () => {
      if (p.wt?.data?.connectionToken) removeFromAuthenticationQueues(String(p.wt.data.id || p.id), p.wt.data.connectionToken);
    }],
  ];
  for (const [what, step] of steps) {
    try {
      step();
    } catch (error) {
      log.error(`Handoff release of ${p.username}: could not ${what}: ${error}`);
    }
  }
}

/**
 * A handed-off player's stats and place, saved before the SWITCH sends them on. The twin of the saves in the
 * onDisconnect listener below (the world count, setStats, setLocation); kept apart because that listener is run
 * by tests with its own names. A failure throws: the handoff logs it (the new node may load older stats).
 */
async function saveHandedOff(p: any): Promise<void> {
  try {
    // A warp hands off with the location already set to the destination (Task 14): the count it leaves is the old map's.
    await worlds.adjustPlayerCount(p?.handoffFromMap || p?.location?.map || "", -1);
  } catch (error) {
    log.error(`[WorldsFetchError] Failed to update world player count: ${error}`);
  }
  if (!p.isGuest && fencedSaves(p)) {
    // Cluster mode: only while this node still owns the player (cells phase 7). A fenced player with no location
    // is not saved at all: an unfenced stats write could land after the new owner's. The achievement progress is
    // dropped only once the save has said another node owns the player (settleFencedLeave); with no save, whether
    // this node owns the player is not known, and the progress is flushed (max-only, it rolls nothing back).
    const taken = takeAchievementProgress(p.username);
    let owned: boolean | null = null;
    try {
      if (p.location) {
        const saved = await player.saveFenced(p.username, p.ownerEpoch, p.stats ?? null, p.location);
        if (saved === "fenced") log.info(`[Save] ${p.username} was not saved at handoff: another node owns the player now`);
        owned = saved === "saved";
      }
    } finally {
      await settleFencedLeave(p, owned, taken);
    }
    return;
  }
  try {
    // Achievement progress since the last save tick, as a disconnect's PLAYER_DISCONNECT would flush it.
    await achievements.onLeave({ player: p });
  } catch (error) {
    log.error(`Handoff of ${p?.username}: achievement progress not flushed: ${error}`);
  }
  if (!p.isGuest) {
    if (p.stats) await player.setStats(p.username, p.stats);
    if (p.id && p.location) await player.setLocation(p.id, p.location.map, p.location.position);
  }
}

/**
 * Cluster mode (cells phase 7): a leaving player's achievement progress is written only while this node owns the
 * player. It is taken from the store before the leave can flush it (a disconnect's PLAYER_DISCONNECT flushes it at
 * once), and settled by settleFencedLeave once the fenced save has answered. Answers what was taken.
 */
function takeAchievementProgress(username: string): Map<number, number> {
  const taken = changedOf(username);
  for (const id of taken.keys()) clearChanged(username, id);
  return taken;
}

/**
 * Settles a fenced leave (a disconnect or a handoff) once its save has answered: `owned` is true when the save was
 * made, false when it was refused, and null when the save threw or there was nothing to save (no location).
 * Owned, or not known: the taken progress goes back, under anything counted since, and is flushed, as an unfenced
 * leave does. A refused save means another node owns the player: the progress is dropped, and so are the effects and
 * sickness kept here for a later login, which are stale now. A newer session of the player live here took the owner
 * epoch from this one, so this node still owns the player: then nothing is dropped.
 */
async function settleFencedLeave(p: any, owned: boolean | null, taken: Map<number, number>): Promise<void> {
  const username = String(p?.username ?? "");
  if (!username) return;
  const live = playerCache.getByUsername(username);
  const newerHere = !!live && String(live.id) !== String(p.id);
  if (owned !== false || newerHere) {
    const since = changedOf(username);
    for (const [id, progress] of taken) markChanged(username, id, Math.max(progress, since.get(id) ?? 0));
    try {
      await achievements.onLeave({ player: p });
    } catch (error) {
      log.error(`Leave of ${username}: achievement progress not flushed: ${error}`);
    }
    return;
  }
  // Anything counted since the take is dropped with it.
  takeAchievementProgress(username);
  const lower = username.toLowerCase();
  const drops: Array<[string, () => unknown]> = [
    ["achievement rows", () => forgetRows(username)],
    ["saved effects", () => {
      effectManager.saveDots(lower, []);
      effectManager.saveBarriers(lower, []);
      effectManager.saveStuns(lower, []);
      effectManager.saveSlows(lower, []);
    }],
    ["sickness", () => forgetSickness(p)],
  ];
  for (const [what, drop] of drops) {
    try {
      await drop();
    } catch (error) {
      log.error(`Leave of ${username}: the ${what} kept here were not dropped: ${error}`);
    }
  }
  log.info(`[Save] ${username}'s achievement progress, effects and sickness were dropped here: another node owns the player now`);
}

/**
 * How long a shutdown waits for the handoffs still running, at most (and never past the shutdown deadline). A run is
 * at most drain (2 s) + answer (2 s) + save, then the SWITCH; the save is what must not be cut, and the SWITCH's
 * wait for the client's close is not needed on a node that is going down.
 */
const HANDOFF_IDLE_MS = 6_000;

/**
 * The part of the shutdown deadline kept for leaving the cluster (stopCluster), at the end: the steps before it end
 * this long before the deadline, so presence is always released, however long they take.
 */
const STOP_MS = 3_000;

/**
 * How long a shutdown waits for the gateway's unregister, at most (it has no timeout of its own). The time it does
 * not use goes to the steps after it, so a slow gateway cannot take the achievement flush's time.
 */
const UNREGISTER_MS = 2_000;

// Registered at load, before startCluster below runs the hooks; it runs only when startCluster attaches the links.
onLinksAttached((ctx) => {
  const secret = process.env.GATEWAY_GAME_SERVER_SECRET || "";
  playerHandoff.start({
    calls: ctx.calls,
    ghosts,
    self: ctx.self,
    ownerAt: ctx.ownerAt,
    now: Date.now,
    player: (id) => playerCache.get(String(id)) ?? null,
    playerByUsername: (username) => playerCache.getByUsername(username) ?? null,
    // Called once the target has said yes (a warp: first), so the player has walked until now.
    drain: async (p, ms) => {
      gameLoop.unregisterMovingPlayer(p.id);
      // A packet still running would be copied half done: the handoff is given up (and tried again soon).
      if (!(await waitIdle(String(p.id), ms))) throw new HandoffGiveUp(`packets still running after ${ms} ms (${packetsInFlight(String(p.id))} in flight)`);
      // A move that was running when the drain began may have registered the mover again before it ended.
      gameLoop.unregisterMovingPlayer(p.id);
    },
    recheck: handoffRecheck,
    // The client is told where the next node is (or to drop the session it opened for it).
    prepare: (p, node) => sendHandoffPrepare(p.wt, node),
    // The client walks the player on from the drain (this node sends no more steps), and stops if the handoff is given up.
    begin: (p) => sendHandoffBegin(p.wt, p),
    stay: (p) => sendHandoffStay(p.wt, p),
    // A drained player kept here is stopped where they stand, and the client told so: it was walking, and its moves
    // during the drain were dropped.
    undrain: (p) => forceStopPlayerMovement(p),
    snapshot: (p) => ({
      id: String(p.id),
      username: p.username,
      map: String(p.location?.map ?? "").replace(/\.json$/, ""),
      x: Number(p.location?.position?.x) || 0,
      y: Number(p.location?.position?.y) || 0,
      direction: p.location?.position?.direction || "down",
      creatureIds: [...creatures.sync.knownBy(String(p.id))],
      playerIds: [...(p.aoi?.playersInAOI ?? [])].map(String),
      state: handoffState(p),
    }),
    ghostRecord: playerGhostRecord,
    ticket: (p, target) => (secret
      ? nodeTicket(secret, String(p.wt?.data?.ticketOrigin ?? ""), String(p.wt?.data?.ticketAccount ?? ""), target)
      : null),
    node: (target) => {
      const address = nodeAddresses.get(target);
      // A node not known yet (it joined since the last read): read again, for the next try.
      if (!address) void refreshNodeAddresses();
      return address ?? null;
    },
    release: releaseHandedOff,
    save: saveHandedOff,
    // The SWITCH must arrive before the close, as for a login switch. The connection is closed whatever the send
    // did: the player is released here, and a client left on this node would never be told.
    sendSwitch: async (p, node, ticket, resume) => {
      const wt = p.wt;
      try {
        await wt.sendThenClose(packetManager.switchNode(node, ticket, { resume }), 1000, "switch");
      } finally {
        try {
          wt?.close?.(1000, "switch");
        } catch (error) {
          log.debug(`Handoff of ${p.username}: close after the SWITCH failed: ${error}`);
        }
      }
    },
    forward: (playerId, username, to) => forwardTable.addPlayer(playerId, username, to),
    saved: (token, username) => loginPrefetch.start(token, username),
  });
  const previousCaster = setRemoteDotCaster(dotCredit);
  nodeAddressesLive = true;
  void refreshNodeAddresses();
  const refresh = setInterval(() => void refreshNodeAddresses(), 2_000);
  (refresh as any).unref?.();
  return () => {
    clearInterval(refresh);
    nodeAddressesLive = false;
    setRemoteDotCaster(previousCaster);
    playerHandoff.stop();
    nodeAddresses.clear();
  };
});

// The node is announced with the address the gateway registration below advertises.
// Node links (spec §1): their own WebTransport listener with the engine's certificate. Neighbours pin its
// hash; a CA-signed certificate cannot be pinned, so it is announced as "" and verified by name instead.
const linkPort = clusterEnabled() ? nodeLinkPort(gamePort) : 0;
const linkBindHost = nodeLinkBindHost();
const linkTransport = linkPort > 0
  ? new WebTransportLinks({ hostname: linkBindHost, port: linkPort, certPem: webTransportTls!.certPem, keyPem: webTransportTls!.keyPem })
  : null;
if (linkTransport) {
  // Bound to every interface, the link port is only safe behind a firewall: said once, at start.
  log.info(`Node links listen on ${linkBindHost} UDP port ${linkPort}`);
  const bindWarning = nodeLinkBindWarning(linkBindHost, linkPort);
  if (bindWarning) log.warn(bindWarning);
}
// The assets are loaded; before the node takes a player (or a handoff), read the NPC and particle lists and the map
// chunk indexes once, so the first arrival does not wait for them. Never throws.
await warmStreamDataWithin();
// A link port in use makes startCluster throw: the node does not start without its links.
// The link hello is signed with a key derived from CLUSTER_LINK_SECRET (startCluster reads it), not the gateway secret.
const cluster = await startCluster(
  undefined,
  {
    publicHost, port: gamePort, wtPort: gamePort, useSSL: resolveUseSSL(),
    linkHost: nodeLinkHost(), linkPort,
    certHash: certificateSupportsPinning(webTransportTls!.certPem) ? localCertHash : "",
  },
  {},
  { transport: linkTransport }
).catch((error) => {
  log.error(`The cluster node could not start${linkPort > 0 ? ` (link port ${linkPort})` : ""}: ${error}`);
  process.exit(1);
});
// The link hook's first read ran inside startCluster, before the node registry was there: read now.
if (cluster) void refreshNodeAddresses();

const webTransportServer = await startWebTransportServer({
  port: gamePort,
  allocateId: cluster
    ? (token: string) => {
        // A handoff arrival keeps its id, unless a connection here still has it open (a quick hand-back): then it
        // gets a new one, and its login is a full load (Deviation 4).
        const kept = arrivalId(playerHandoff.claimArrivalId(token), connectionOpen);
        if (kept !== null) return kept;
        const id = cluster.ids.tryNext();
        return id === null ? null : String(id);
      }
    : undefined,
  certPem: webTransportTls!.certPem,
  keyPem: webTransportTls!.keyPem,
  chatDecryptionKey: keyPair.publicKey,
  maxFrameSize: MAX_FRAME_BYTES,
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

// The startup probe pins the server's own certificate by hash, so there is no
// verification to skip: pinning bypasses name and chain checks by design and
// accepts exactly this certificate. TLS_INSECURE_SKIP_VERIFY is therefore no
// longer consulted.
//
// The host still has to reach our own listener. 127.0.0.1 always does, and
// pinning does not require it to match a SAN.
const probeHost = "127.0.0.1";

async function verifyWebTransportListener(port: number): Promise<void> {
  try {
    // The probe targets our own listener, so it pins that certificate by hash
    // rather than skipping verification or supplying a CA. This transport has
    // no insecureSkipVerify, and pinning is the stricter check regardless: it
    // accepts exactly this certificate and nothing else.
    const probe = new WebTransport(`https://${probeHost}:${port}`, {
      serverCertificateHashes: [
        {
          algorithm: "sha-256",
          // computeCertificateHash returns base64; the option wants the bytes.
          value: new Uint8Array(
            Buffer.from(computeCertificateHash(webTransportTls!.certPem), "base64")
          ),
        },
      ],
    });
    await probe.ready;
    try {
      probe.close({ closeCode: 0, reason: "startup-probe" });
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

// In a cluster only the first node of the region clears the shared guests and parties (cluster/startclear.ts, clearguard.ts).
listener.on(Events.AWAKE, async () => {
  await clearShared(() => player.clear());
});


event.emit("online");

let gatewayClient: GatewayClient | null = null;
const serverId = process.env.SERVER_ID || `server-${crypto.randomBytes(8).toString("hex")}`;

gatewayClient = new GatewayClient({
  // Cluster mode: each node of the realm registers under its own node id.
  ...(cluster ? { nodeId: nodeId(), regionId: regionId() } : {}),
  gatewayUrl: process.env.GATEWAY_INTERNAL_URL || process.env.GATEWAY_URL || "http://localhost:9999",
  serverId,
  description: process.env.SERVER_DESCRIPTION || "",
  host: serverHost,
  publicHost: publicHost,
  port: gamePort,
  wtPort: gamePort,
  wtEnabled: true,
  maxConnections: (settings as any)?.webtransport?.maxSessions || 2000,
  heartbeatInterval: settings?.gateway?.heartbeatInterval || 5000,
  assetServerUrl: process.env.ASSET_SERVER_INTERNAL_URL || process.env.ASSET_SERVER_URL || "http://localhost:8000",
});

// Cluster mode: the Gateway is told who owns which block (on registering, and on each change), so a login can go
// straight to the owner of the saved point. Set before registering: the first registration sends every table.
const blockTable = cluster ? clusterBlocks() : null;
if (blockTable) gatewayClient.reportBlocksFrom(blockTable);

await gatewayClient.registerWithRetry();

// The realm list shows whether this realm is whitelisted: tell the gateway as soon as that is switched.
onWhitelistSwitch(() => {
  void gatewayClient?.heartbeatNow();
});

listener.emit(Events.AWAKE);
listener.emit(Events.START);

gameLoop.start();
await creatures.init();
await gathering.init();
await fishing.init();
await achievements.init();
startAutoPartyLayerSync(sendAnimationTo);
startAutoLayerCondensation(sendAnimationTo);

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
    teleportPlayer: async (playerObj: any, mapName: string, x: number, y: number): Promise<boolean> => {
      // In cluster mode a player being handed off is not moved (false: the plugin may try again after the handoff),
      // and the move counts as in flight for the handoff's wait.
      return await guardedTeleport(clusterEnabled(), playerObj, () => teleportPlayerWrapper(playerObj, mapName, x, y));
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

    const wsClosed = !p.wt || p.wt.readyState !== 1;

    // The client no longer sends a periodic TIME_SYNC heartbeat, so a genuinely
    // AFK player can sit for minutes without sending anything. An open QUIC
    // session is itself proof of life (WebTransport's own idle timeout, default
    // 120s, tears down dead sessions and flips readyState), so only sweep
    // players whose socket is gone. `lastUpdated` still tracks real activity
    // and is refreshed by any inbound packet in onTransportMessage.
    if (wsClosed) {
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
    if (!playerData || inactiveSet.has(playerData.id) || !playerData.wt) continue;

    // SERVER_TIME is no longer pushed on this 1Hz loop. The client anchors the
    // clock once at login and advances it locally; browser clock drift is
    // seconds-per-day, far below the per-minute resolution the time-of-day
    // system reacts to. At 2000 players this removed 2000 datagrams/sec.

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

    // Corpses awaiting release and ghosts do not regenerate; pin them at 0
    // so the death state can never be healed out from under the state flags.
    if (playerData.isDead || playerData.isGhost) {
      stats.health = 0;
      stats.stamina = 0;
      continue;
    }

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

    // Encode once per audience: the player and their party members get the full stats, other observers the
    // few fields their client reads (observerStats). Latest-wins absolute stats delivered as loss-tolerant
    // datagrams (this repeats every tick, so a dropped one self-heals).
    const frames = regenStatsFrames(playerData, stats);
    playerData.wt.sendBestEffort(frames.full);

    // O(observers) via the AOI reverse index - was an O(all players) cache
    // scan per regenerating player, i.e. O(n^2) per tick.
    for (const other of findPlayersWithTargetInAOI(playerData.id)) {
      if (
        !inactiveSet.has(other.id) &&
        other.wt &&
        other.wt.readyState === 1
      ) {
        other.wt.sendBestEffort(frames.frameFor(other));
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

      if (reason === "session_stolen" && stillInCache.wt?.readyState === 1) {
        try {
          sendPacket(
            stillInCache.wt,
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
          // drain: the notice above may still wait in the outbox behind a write in flight; a plain close would drop it.
          stillInCache.wt.close(1000, "Logged in from another location", { drain: true });
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

function cleanupPlayerState(playerData: any, { despawn = true }: { despawn?: boolean } = {}) {
    const id = playerData.id;
    const username = playerData.username?.toLowerCase();

    gameLoop.unregisterMovingPlayer(id);
    dots.clearDots(id);
    spellEffects.clearStuns(id);
    spellEffects.clearSlows(id);
    spellEffects.clearVanishes(id);
    playerCache.remove(id);
    forgetNpcStream(id);
    mapIndex.removePlayer(id);
    clearBatchQueuesForPlayer(id);
    clearPlayerTarget(id);
    removePlayerFromCleanupMaps(id);
    if (username) cooldownManager.removePlayer(username);
    // A handoff (cells phase 6) despawns nothing: the player's mirror takes its place for the viewers.
    if (despawn) despawnPlayerFromAllAOI(playerData, "disconnect", despawnBatchQueue);
    else releasePlayerAOI(playerData);
}

listener.on("onDisconnect", async (data) => {
  if (!data) return;

  let left: string | null = null;
  // Cluster mode: the leave whose achievement progress is held back from PLAYER_DISCONNECT's flush (settleFencedLeave).
  let fencedLeave: { p: any; taken: Map<number, number> } | null = null;
  try {
    const playerData = playerCache.get(data.id);
    if (!playerData) return;
    left = playerData.username || null;

    if (data.reason === "session_stolen" && playerData.wt?.readyState === 1) {
      try {
        sendPacket(
          playerData.wt,
          packetManager.notify({
            message: "You have been logged in from another location.",
          })
        );
      } catch (err) {
        console.error(`Failed to send session stolen notification to player ${data.id}`);
      }
      try {
        // drain: the notice above may still wait in the outbox behind a write in flight; a plain close would drop it.
        playerData.wt.close(1000, "Logged in from another location", { drain: true });
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
        saveSicknessOnDisconnect(playerData);
      }

      loot.scheduleCleanup(playerData.username);
    }

    cleanupPlayerState(playerData);
    releaseDraggedBy(playerData.id);
    if (!playerData.isGuest && left && fencedSaves(playerData)) {
      fencedLeave = { p: playerData, taken: takeAchievementProgress(left) };
    }
    // Before the saves below: they wait on the database, and what listens
    // (creature combat, plugins) should not wait with them or miss a throw.
    listener.emit(Events.PLAYER_DISCONNECT, { player: playerData });

    if (playerData.wt?.data?.connectionToken) {
        removeFromAuthenticationQueues(
            String(playerData.wt.data.id || playerData.id),
            playerData.wt.data.connectionToken
        );
    }

    let worldPlayerCount: number | null = null;
    try {
      // A warp's handoff sets the location to the destination first (Task 14): a player who leaves while it runs is
      // counted off the map they were on, as saveHandedOff counts them.
      worldPlayerCount = await worlds.adjustPlayerCount(playerData?.handoffFromMap || playerData?.location?.map || "", -1);
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
      if (fencedSaves(playerData)) {
        // Cluster mode: only while this node still owns the player (cells phase 7). With no location nothing is
        // saved: an unfenced stats write could land after the new owner's. Who owns the player is then not known
        // (owned stays null), and the leave settles as one this node owns.
        let owned: boolean | null = null;
        try {
          if (playerData.location) {
            const saved = await player.saveFenced(playerData.username, playerData.ownerEpoch, playerData.stats ?? null, playerData.location);
            if (saved === "fenced") log.info(`[Save] ${playerData.username} was not saved at disconnect: another node owns the player now`);
            owned = saved === "saved";
          }
        } finally {
          const settling = fencedLeave;
          fencedLeave = null;
          if (settling) await settleFencedLeave(settling.p, owned, settling.taken);
        }
      } else {
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
    }

    // In a cluster, a newer login on another node displaced this session: the player is still online there.
    const onlineElsewhere = clusterEnabled() && !!left && (await isOnline(left));
    if (!onlineElsewhere && playerData.friends && Array.isArray(playerData.friends) && playerData.friends.length > 0) {
      // Friends on any node (cluster/deliver.ts); a friend who is not online is skipped.
      const offline = packetManager.updateOnlineStatus({ online: false, username: playerData.username });
      await Promise.all(playerData.friends.map((friendUsername: string) => deliverToPlayer(friendUsername, [offline[0]])));
    }

    await player.clearSessionId(playerData.id);
  } catch (e) {
    log.error(e as string);
  } finally {
    // A throw before the fenced save answered: what was taken goes back, as an unfenced leave would flush it.
    if (fencedLeave) {
      const settling: { p: any; taken: Map<number, number> } = fencedLeave;
      fencedLeave = null;
      await settleFencedLeave(settling.p, null, settling.taken).catch((e) => log.error(e as string));
    }
    // Last, so the saves above are not held again once they are forgotten.
    // Not when the player is already back in: those are the new login's rows.
    if (left && !playerCache.getByUsername(left)) {
      await forgetPlayer(left).catch((e) => log.error(e as string));
    }
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
      // accounts.subscribed is only asked for once the start-time step has made sure it exists.
      const withSubscribed = subscriptionsReady();
      const dbResults = await query(
        withSubscribed
          ? "SELECT id, session_id, subscribed FROM accounts WHERE id IN (?)"
          : "SELECT id, session_id FROM accounts WHERE id IN (?)",
        [userIds]
      ) as any[];

      const dbSessionMap = new Map<string, string>();
      const dbSubscribedMap = new Map<string, boolean>();
      for (const r of dbResults) {
        dbSessionMap.set(String(r.id ?? ""), String(r.session_id ?? ""));
        if (withSubscribed) dbSubscribedMap.set(String(r.id ?? ""), Number(r.subscribed) === 1);
      }

      for (const [playerId, row] of nonGuestPlayers) {
        const dbSid = dbSessionMap.get(String(row.userid)) || "";
        // A fenced player's owner epoch decides (the save below is fenced on it), not the session id.
        if (!fencedSaves(row) && dbSid !== String(playerId)) {
          sessionInvalidSet.add(playerId);
          log.info(
            `[Save] Skipping save for ${row.username} - session stolen (local: ${playerId}, db: ${dbSid || "cleared"})`
          );
          continue;
        }
        // A subscription paid for (or ended) while the player is online: the Gateway wrote the account, so take it from there.
        const subscribed = dbSubscribedMap.get(String(row.userid));
        if (subscribed !== undefined) row.isSubscribed = subscribed;
        // Ended while online, and logging in is locked: the same as being refused at the login.
        if (subscribed === false && subscriptionRefusal(row, "login")) {
          log.info(`[Subscriptions] Disconnecting ${row.username} - not subscribed, and logging in is locked`);
          try {
            if (row.wt?.readyState === 1) sendPacket(row.wt, packetManager.notify({ message: subscriptionRefusal(row, "login") ?? "" }));
          } catch {
            // The connection is going anyway.
          }
          void player.kick(row.username, row.wt);
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
      cleanupPlayerState(row);
      return { success: false, playerId, reason: "session_stolen" };
    }

    if (!row.stats || !row.location) {
      cleanupPlayerState(row);
      return { success: false, playerId, reason: "invalid_data" };
    }

    try {
      if (fencedSaves(row)) {
        const saved = await player.saveFenced(row.username, row.ownerEpoch, row.stats, row.location);
        if (saved === "fenced") {
          // Another node owns the player now: this session is the stale one.
          log.info(`[Save] Skipping save for ${row.username} - another node owns the player (epoch ${row.ownerEpoch})`);
          cleanupPlayerState(row);
          // Only this connection is closed. player.kick would log out whichever session the name has here, and the
          // account's session is the new owner's.
          try {
            row.wt?.close?.(1000, "Logged in from another location", { drain: true });
          } catch {
            // The connection is going anyway.
          }
          return { success: false, playerId, reason: "owner_epoch" };
        }
        return { success: true, playerId };
      }
      await Promise.all([
        player.setStats(row.username, row.stats),
        player.setLocation(playerId, row.location.map, row.location.position)
      ]);
      return { success: true, playerId };
    } catch (e) {
      playerCache.remove(playerId);
      forgetNpcStream(playerId);
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
    // Every logged-in player, on every node when clustered.
    void broadcastWorld([packet.encode(JSON.stringify(_packet))]).catch((error) => log.error(`Broadcast failed: ${error}`));
  },
  GetClientRequests() {
    return ClientRateLimit;
  },
  GetRateLimitedClients() {
    return Array.from(ClientRateLimit.values()).filter((client) => client.rateLimited);
  },
};

function handleBackpressure(wt: any, action: () => void, retryCount = 0) {
  if (retryCount > 20) {
    log.warn("Max retries reached. Action skipped to avoid infinite loop.");
    return;
  }

  if (!wt || wt.readyState !== 1) {
    log.warn("Connection is not open. Action cannot proceed.");
    return;
  }

  const queue = packetQueue.get(wt.data.id);
  if (!queue) {
    log.warn("No packet queue found for connection. Action cannot proceed.");
    return;
  }

  if (wt.bufferedAmount > MAX_BUFFER_SIZE) {
    const retryInterval = Math.min(50 + retryCount * 50, 500);
    log.debug(`Backpressure detected. Retrying in ${retryInterval}ms (Attempt ${retryCount + 1})`);

    queue.push(action);
    setTimeout(() => handleBackpressure(wt, action, retryCount + 1), retryInterval);
  } else {
    action();

    while (queue.length > 0 && wt.bufferedAmount <= MAX_BUFFER_SIZE) {
      const nextAction = queue.shift();
      if (nextAction) {
        nextAction();
      }
    }
  }
}

async function gracefulShutdown(signal: string) {
  // One deadline for the whole shutdown, from the signal (SHUTDOWN_DEADLINE_MS, under the compose files' 20 s stop
  // grace): each step below waits at most its own cap and never past it, and a step cut short is logged.
  const deadline = Date.now() + SHUTDOWN_DEADLINE_MS;
  // In cluster mode the last STOP_MS of it are kept for leaving the cluster: every step before that one ends by
  // stepsDeadline. With CLUSTER=false there is no such step, and the steps have the whole deadline.
  const stepsDeadline = cluster ? deadline - STOP_MS : deadline;
  log.info(`Received ${signal}, shutting down gracefully...`);

  gameLoop.stop();

  // Achievement progress is written on the 60 s save tick: write what changed since, so a restart loses none of it
  // (USER REQUEST 2026-10-17: "flush achievement progress on engine shutdown"). At most ACHIEVEMENT_FLUSH_MS, so a
  // database that does not answer cannot hold the shutdown. It runs alongside the handoff wait and the unregister, so
  // running handoffs that take their whole HANDOFF_IDLE_MS cannot leave it no time.
  const ACHIEVEMENT_FLUSH_MS = 5_000;
  const achievementsFlushed = boundedStep("writing the achievement progress", () => achievements.onSave(), stepsDeadline, ACHIEVEMENT_FLUSH_MS);

  // Cells phase 6: no handoff starts from here on, and one already running finishes (its release is done, so its
  // save and SWITCH must be too) before the connections close and the process exits. At most HANDOFF_IDLE_MS.
  if (cluster) {
    playerHandoff.stop();
    await boundedStep("waiting for the running handoffs (their saves may be lost)", () => playerHandoff.idle(), stepsDeadline, HANDOFF_IDLE_MS);
  }

  if (gatewayClient) {
    const client = gatewayClient;
    await boundedStep("unregistering from the gateway", () => client.unregister(), stepsDeadline, UNREGISTER_MS);
  }

  try {
    webTransportServer.stop();
  } catch (error) {
    log.debug(`Failed to close WebTransport server: ${error}`);
  }

  try {
    httpServers.proxy.stop();
    httpServers.redirect?.stop();
  } catch (error) {
    log.debug(`Failed to close HTTP servers: ${error}`);
  }

  // The achievement write started with the shutdown (above): wait for it here, then write once more what was earned
  // while the connections were still open (the handoff wait and the unregister), before the process exits.
  await achievementsFlushed;
  await boundedStep("writing the achievement progress earned since", () => achievements.onSave(), stepsDeadline, ACHIEVEMENT_FLUSH_MS);

  // This node's players are gone with it: stopCluster drops its mirrors and links, clears its directory entries
  // and makes the node leave the live nodes. It logs a step that fails, and the wait is a little time only, so
  // Redis cannot hold the shutdown. It has the STOP_MS kept for it at the end of the deadline.
  if (cluster) {
    await boundedStep("leaving the cluster", () => stopCluster(), deadline, STOP_MS);
  }

  log.info("Shutdown complete");
  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

export { gatewayClient, gracefulShutdown };

