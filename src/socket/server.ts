const PROCESS_STARTED_AT = Date.now() - performance.now();
const MAX_BUFFER_SIZE = 1024 * 1024 * 16; // 16MB
const packetQueue = new Map<string, (() => void)[]>();
import crypto from "crypto";
import { packetManager } from "./packet_manager.ts";
import packetReceiver from "./receiver.ts";
export const listener = new eventEmitter();
import { event } from "../systems/events";
import eventEmitter from "node:events";
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

const Server = Bun.serve<Packet, any>({
  fetch(req, Server) {
    // Upgrade the request to a WebSocket connection
    // and generate a random id for the client
    const id = crypto.randomBytes(32).toString("hex");
    const useragent = req.headers.get("user-agent");
    // Base64 encode the public key
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
    perMessageDeflate: false, // Enable per-message deflate compression
    maxPayloadLength: 1024 * 1024 * settings?.websocket?.maxPayloadMB || 1024 * 1024, // 1MB
    // Seconds to wait for the connection to close
    idleTimeout: settings?.websocket?.idleTimeout || 5,
    async open(ws: any) {
      console.log(`New Connection: ${ws.data.id} - ${ws.data.useragent}`);
      ws.binaryType = "arraybuffer";
      // Add the client to the set of connected clients
      if (!ws.data?.id || !ws.data?.useragent || !ws.data?.chatDecryptionKey) {
        log.error(`WebSocket connection missing identity information. Closing connection.`);
        ws.close(1000, "Missing identity information");
        return;
      }

      connections.add({ id: ws.data.id, useragent: ws.data.useragent, chatDecryptionKey: ws.data.chatDecryptionKey });
      packetQueue.set(ws.data.id, []);
      // Emit the onConnection event
      listener.emit("onConnection", ws.data.id);
      // Add the client to the clientRequests array
      if (settings?.websocketRatelimit?.enabled) {
        ClientRateLimit.push({
          id: ws.data.id,
          requests: 0,
          rateLimited: false,
          time: null,
          windowTime: 0,
        });
      // Track the clients window time and reset the requests count
      // if the window time is greater than the max window time
      setInterval(() => {
        const index = ClientRateLimit.findIndex(
          (client) => client.id === ws.data.id
        );
        if (index === -1) return;
        const client = ClientRateLimit[index];
        // Return if the client is rate limited
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

      // Subscribe to the CONNECTION_COUNT event and publish the current count
      ws.subscribe("CONNECTION_COUNT" as Subscription["event"]);
      ws.subscribe("BROADCAST" as Subscription["event"]);
      ws.subscribe("DISCONNECT_PLAYER" as Subscription["event"]);

      // Set timeout to 1000 if user agent is an iOS or Mac device due to a bug with Safari not allowing immediate messages
      const timeout = ws.data.useragent.includes("iPhone") || ws.data.useragent.includes("iPad") || ws.data.useragent.includes("Macintosh") ? 1000 : 0;
      
      setTimeout(() => {
        // Publish the connection count to all clients
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
      console.log(`Disconnected: ${ws.data.id} - ${ws.data.useragent} - ${code} - ${reason}`);
      // Remove the client from the set of connected clients
      if (!ws.data.id) return;
      packetQueue.delete(ws.data.id);
      // Find the client object in the set
      let clientToDelete;
      for (const client of connections) {
        if (client.id === ws.data.id) {
          clientToDelete = client;
          break;
        }
      }
      // Check if we found the client object
      if (clientToDelete) {
        const deleted = connections.delete(clientToDelete);
        if (deleted) {
          // Emit the onDisconnect event
          listener.emit("onDisconnect", { id: ws.data.id });

          // Publish the new connection count and unsubscribe from the event
          const _packet = {
            type: "CONNECTION_COUNT",
            data: connections.size,
          } as unknown as Packet;
          Server.publish(
            "CONNECTION_COUNT" as Subscription["event"],
            packet.encode(JSON.stringify(_packet))
          );
          ws.unsubscribe("CONNECTION_COUNT" as Subscription["event"]);
          // Unsubscribe from the BROADCAST event
          ws.unsubscribe("BROADCAST" as Subscription["event"]);
          ws.unsubscribe("DISCONNECT_PLAYER" as Subscription["event"]);
          // Remove the client from clientRequests
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
        // Check if the request has an identity and a message and if the message is an ArrayBuffer
        if (!ws.data?.id || !message) return;
        // Decode the message
        message = packet.decode(message);
        const parsedMessage = JSON.parse(message.toString());
        const packetType = parsedMessage?.type;

        const processImmediately = ["TIME_SYNC", "MOVEXY", "STATS", "SERVER_TIME", "ANIMATION"];
        if (processImmediately.includes(packetType)) {
          // Process immediately, independent of backpressure/ratelimit
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

// Register the Server as online
event.emit("online", Server);

// Fixed update loop
listener.on("onUpdate", async () => {});

// Fixed update loop
listener.on("onFixedUpdate", async () => {
  {
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
  }
});

// Server tick (every 1 second)
listener.on("onServerTick", async () => {
  const playersObj = playerCache.list() as any;
  const players = Object.values(playersObj) as any[];

  // De-dupe disconnect processing across overlapping ticks
  const inactiveSet = new Set<string>();

  const nowEpoch = Date.now();

  // PASS 1: find truly inactive players
  for (const p of players) {
    if (!p || !p.id) continue;

    // Normalize lastUpdated to epoch ms regardless of its source clock:
    const rawLU = typeof p.lastUpdated === "number" ? p.lastUpdated : 0;
    const lastUpdatedEpoch =
      rawLU > 1e11               // looks like Date.now()
        ? rawLU
        : rawLU > 0              // looks like performance.now()
        ? PROCESS_STARTED_AT + rawLU
        : nowEpoch;              // if missing, treat as "just updated" to avoid insta-purge

    const wsClosed = !p.ws || p.ws.readyState !== WebSocket.OPEN;

    // Use a less aggressive idle window; only purge if socket is closed OR idle for >30s
    const tooIdle = (nowEpoch - lastUpdatedEpoch) > 30000;

    if (wsClosed || tooIdle) {
      inactiveSet.add(p.id);
    }
  }

  // PASS 2: process active players only
  for (const playerData of players) {
    if (!playerData || inactiveSet.has(playerData.id)) continue;

    handleBackpressure(playerData.ws, () =>
      playerData.ws.send(packetManager.serverTime()[0])
    );

    // Normalize last_attack as well, then apply same-epoch logic
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

    // to self
    handleBackpressure(playerData.ws, () =>
      playerData.ws.send(packetManager.updateStats(updateStatsData)[0])
    );

    // to others on the same map, but skip anyone we marked inactive this tick
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

  // PASS 3: remove and notify exactly once per inactive id (no O(N×K))
  if (inactiveSet.size > 0) {
    for (const id of inactiveSet) {
      // 2a) Send the packet the client uses to remove the render
      Server.publish(
        "DISCONNECT_PLAYER" as Subscription["event"],
        packetManager.disconnect(id)[0]
      );

      // 2b) Run the same server-side cleanup as a real close.
      //     onDisconnect will decrement world counts, persist, clear session, and remove from cache.
      listener.emit("onDisconnect", { id, reason: "inactive" });

      // 2c) Hygiene: drop queued actions & rate-limit entry for this id
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


// On new connection
listener.on("onConnection", (data) => {
  if (!data) return;
  log.debug(`New connection: ${data}`);
});

// On disconnect
listener.on("onDisconnect", async (data) => {
  if (!data) return;

  try {
    const playerData = playerCache.get(data.id);
    if (!playerData) return;

    // Ensure worlds are stored/retrieved as JSON array
    let _worlds: WorldData[] = [];
    try {
      const cachedWorlds = await assetCache.get("worlds");
      if (cachedWorlds) {
        _worlds = Array.isArray(cachedWorlds)
          ? cachedWorlds
          : JSON.parse(cachedWorlds); // handle string case
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

      // Always set back as JSON string to avoid type mismatch
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

// Save loop
listener.on("onSave", async () => {
  log.info("Saving player data...");
  const cache = playerCache.list();
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
});

// Exported Server events
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
  // Check retry limit to avoid infinite retry loop
  if (retryCount > 20) {
    log.warn("Max retries reached. Action skipped to avoid infinite loop.");
    return;
  }

  // Ensure WebSocket is open
  if (ws.readyState !== WebSocket.OPEN) {
    log.warn("WebSocket is not open. Action cannot proceed.");
    return;
  }

  // Ensure there is a packet queue
  const queue = packetQueue.get(ws.data.id);
  if (!queue) {
    log.warn("No packet queue found for WebSocket. Action cannot proceed.");
    return;
  }

  // If there's backpressure, add the current action to the queue and retry later
  if (ws.bufferedAmount > MAX_BUFFER_SIZE) {
    const retryInterval = Math.min(50 + retryCount * 50, 500); // Capped at 500ms
    log.debug(`Backpressure detected. Retrying in ${retryInterval}ms (Attempt ${retryCount + 1})`);
    
    // Queue the action to be retried
    queue.push(action);

    // Retry after backpressure clears
    setTimeout(() => handleBackpressure(ws, action, retryCount + 1), retryInterval);
  } else {
    // Process the action if no backpressure, then process all queued actions
    action();

    // Process queued actions while the buffer allows
    while (queue.length > 0 && ws.bufferedAmount <= MAX_BUFFER_SIZE) {
      const nextAction = queue.shift();
      if (nextAction) {
        nextAction();
      }
    }
  }
}
