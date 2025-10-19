const PROCESS_STARTED_AT = Date.now() - performance.now();
const MAX_BUFFER_SIZE = 1024 * 1024 * 16; // 16MB
const packetQueue = new Map<string, (() => void)[]>();
import crypto from "crypto";
import { packetManager } from "./packet_manager.ts";
import packetReceiver from "./receiver.ts";
import eventEmitter from "node:events";
export const listener = new eventEmitter();
const event = new eventEmitter();
import log from "../modules/logger";
import player from "../systems/player";
import playerCache from "../services/playermanager.ts";
import packet from "../modules/packet";
import path from "node:path";
import fs from "node:fs";
import { generateKeyPair } from "../modules/cipher";

// Load settings
import * as settings from "../../config/settings.json";
import assetCache from "../services/assetCache.ts";

const _cert = path.join(import.meta.dir, "../certs/cert.pem");
const _key = path.join(import.meta.dir, "../certs/key.pem");
const _https = process.env.WEBSRV_USESSL === "true";
let options: Bun.TLSOptions | undefined = undefined;

if (_https) {
  if (!fs.existsSync(_cert) || !fs.existsSync(_key)) {
    log.error(`Attempted to locate certificate and key but failed`);
    log.error(`Certificate: ${_cert}`);
    log.error(`Key: ${_key}`);
    throw new Error("SSL certificate or key is missing");
  }
  try {
    options = {
      key: Bun.file(_key),
      cert: Bun.file(_cert),
      ALPNProtocols: "http/1.1,h2",
    };
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

// Set to track the amount of requests
const ClientRateLimit = [] as ClientRateLimit[];

const keyPair = generateKeyPair(process.env.RSA_PASSPHRASE);

const WORKER_ID = parseInt(process.env.WORKER_ID || "0");
const WORKER_PORT = parseInt(process.env.WORKER_PORT || "3000");

const Server = Bun.serve<Packet, any>({
  port: WORKER_PORT,
  reusePort: true,
  fetch(req, Server) {
    const id = crypto.randomBytes(32).toString("hex");
    const useragent = req.headers.get("user-agent");
    const chatDecryptionKey = keyPair.publicKey;
    if (!useragent) {
      log.error(`User-Agent header is missing for client with id: ${id}`);
      return new Response("User-Agent header is missing", { status: 400 });
    }

    const success = Server.upgrade(req, { data: { id, useragent, chatDecryptionKey } });
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
    idleTimeout: settings?.websocket?.idleTimeout || 5,
    async open(ws: any) {
      console.log(`Worker ${WORKER_ID}: New Connection: ${ws.data.id} - ${ws.data.useragent}`);
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
        ClientRateLimit.push({
          id: ws.data.id,
          requests: 0,
          rateLimited: false,
          time: null,
          windowTime: 0,
        });

      setInterval(() => {
        const index = ClientRateLimit.findIndex(
          (client) => client.id === ws.data.id
        );
        if (index === -1) return;
        const client = ClientRateLimit[index];

        if (client.rateLimited) {
          client.requests = 0;
          client.windowTime = 0;
          return;
        }
        client.windowTime += 1000;
        if (client.windowTime > RateLimitOptions.maxWindowTime) {
          client.requests = 0;
          client.windowTime = 0;
        }
      }, 1000);
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
    async close(ws: any, code: number, reason: string) {
      console.log(`Worker ${WORKER_ID}: Disconnected: ${ws.data.id} - ${ws.data.useragent} - ${code} - ${reason}`);

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

          for (let i = 0; i < ClientRateLimit.length; i++) {
            if (ClientRateLimit[i].id === ws.data.id) {
              ClientRateLimit.splice(i, 1);
              break;
            }
          }
        }
        ws.publish(
        "DISCONNECT_PLAYER" as Subscription["event"],
        packetManager.disconnect(ws.data.id)[0]
      );
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
          const idx = ClientRateLimit.findIndex((c) => c.id === ws.data.id);
          if (idx !== -1) {
            const client = ClientRateLimit[idx];
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

event.emit("online", { port: WORKER_PORT, workerId: WORKER_ID });

listener.emit("onAwake");
listener.emit("onStart");

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

// Fixed update loop
listener.on("onUpdate", async () => {});

listener.on("onFixedUpdate", async () => {
  if (settings?.websocketRatelimit?.enabled) {
    if (ClientRateLimit.length < 1) return;
    const timestamp = Date.now();
    for (let i = 0; i < ClientRateLimit.length; i++) {
      const client = ClientRateLimit[i];
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

    if (stats.stamina < stats.max_stamina) {
      stats.stamina += Math.floor(stats.max_stamina * 0.01);
      if (stats.stamina > stats.max_stamina) stats.stamina = stats.max_stamina;
      updated = true;
    }

    if (!playerData.pvp && stats.health < stats.max_health) {
      stats.health += Math.floor(stats.max_health * 0.01);
      if (stats.health > stats.max_health) stats.health = stats.max_health;
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
      Server.publish(
        "DISCONNECT_PLAYER" as Subscription["event"],
        packetManager.disconnect(id)[0]
      );

      listener.emit("onDisconnect", { id, reason: "inactive" });

      packetQueue.delete(id);
      for (let i = 0; i < ClientRateLimit.length; i++) {
        if (ClientRateLimit[i].id === id) {
          ClientRateLimit.splice(i, 1);
          break;
        }
      }
    }
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

    if (thisWorld && typeof thisWorld.players === "number" && thisWorld.players > 0) {
      thisWorld.players -= 1;
      await assetCache.set("worlds", JSON.stringify(_worlds));
    }

    console.log(
      `World: ${playerData.location.map.replace(".json", "")} now has ${
        thisWorld?.players || 0
      } players.`
    );

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
    playerCache.remove(playerData.id);

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
  for (const p in cache) {
    const row = cache[p];
    if (!row) continue;
    if (row.isGuest) continue;

    if (!row.stats || !row.location) {
      playerCache.remove(p);
      continue;
    }

    try {
      await player.setStats(row.username, row.stats);
      await player.setLocation(p, row.location.map, row.location.position);
    } catch (e) {
      playerCache.remove(p);
      log.error(e as string);
    }
  }
  const endTime = Date.now();
  log.info(`Player data saved in ${endTime - startTime}ms`);
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
    return ClientRateLimit.filter((client) => client.rateLimited);
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
