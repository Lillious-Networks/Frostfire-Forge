import { packetTypes } from "./types";
import { packetManager } from "./packet_manager";
import log from "../modules/logger";
import player from "../systems/player.ts";
import permissions from "../systems/permissions";
import { getAuthWorker } from "./authentication_pool.ts";
const authentication_queue = new Set<string>();
const authentication_session_queue = new Set<string>();
// Track pending authentications with their websocket, token, and language
const pendingAuthentications = new Map<string, { ws: any; token: string; language: string }>();
import playerCache from "../services/playermanager.ts";
import assetCache from "../services/assetCache";
import { reloadMap } from "../modules/assetloader";
import { clearMapCache } from "../systems/player.ts";
import language from "../systems/language";
import quests from "../systems/quests";
import friends from "../systems/friends";
import parties from "../systems/parties.ts";
import spells from "../systems/spells";
import equipment from "../systems/equipment.ts";
import inventory from "../systems/inventory";
const maps = await assetCache.get("maps");
const worldsCache = await assetCache.get("worlds") as WorldData[];
const mapPropertiesCache = await assetCache.get("mapProperties");
import { decryptPrivateKey, decryptRsa, _privateKey } from "../modules/cipher";
// Load settings
import * as settings from "../config/settings.json";
import { randomBytes } from "../modules/hash";
import { saveMapChunks } from "../modules/assetloader";
import { getPlayerSpriteSheetData, isSpriteSheetSystemAvailable } from "../modules/spriteSheetManager";
const defaultMap = settings.default_map?.replace(".json", "") || "main";

// Animation system configuration
const useSpriteSheets = settings.animation_system?.use_sprite_sheets ?? true;

let restartScheduled: boolean;
let restartTimers: ReturnType<typeof setTimeout>[];

let globalStateRevision: number = 0;

const npcs = await assetCache.get("npcs");
const particles = await assetCache.get("particles");

// Set up worker message listener ONCE at module level
const authWorker = await getAuthWorker();
authWorker.on("message", async (result: any) => {
  const status = result as Authentication;
  const sessionId = result.id;

  // Look up the pending authentication
  const pending = pendingAuthentications.get(sessionId);
  if (!pending) return; // No matching session found

  const { ws, token, language } = pending;

  // Clean up
  pendingAuthentications.delete(sessionId);
  authentication_queue.delete(token);
  authentication_session_queue.delete(sessionId);

  // An error occurred during authentication
  if (status.error && !status.authenticated) {
    sendPacket(ws, packetManager.loginFailed());
    ws.close(1008, status.error);
    log.error(`Authentication error for token ${token}: ${status.error}`);
    return;
  }

  if (status.authenticated && status.completed && status.error) {
    sendPacket(ws, packetManager.loginFailed());
    ws.close(1008, status.error);
    log.error(`Authentication error for token ${token}: ${status.error}`);
    return;
  }

  const playerData = status.data as PlayerData;
  if (status.authenticated && status.completed && playerData) {
    // Reset noclip/stealth in background (fire and forget - don't block login)
    if (!playerData.isAdmin && playerData.isNoclip) {
      player.toggleNoclip(playerData.username).catch(err =>
        log.error(`Failed to toggle noclip: ${err}`)
      );
    }
    if (!playerData.isAdmin && playerData.isStealth) {
      player.toggleStealth(playerData.username).catch(err =>
        log.error(`Failed to toggle stealth: ${err}`)
      );
    }

    const default_map_properties = mapPropertiesCache.find((m: any) => m.name === `${defaultMap}.json`);
    const default_map_spawnpoint_x = default_map_properties ? (default_map_properties.width * default_map_properties.tileWidth) / 2 : 0;
    const default_map_spawnpoint_y = default_map_properties ? (default_map_properties.height * default_map_properties.tileHeight) / 2 : 0;
    const default_map_spawnpoint = { map: `${defaultMap}.json`, x: default_map_spawnpoint_x, y: default_map_spawnpoint_y, direction: "down" };
    const player_map_properties = mapPropertiesCache.find((m: any) => m.name === `${playerData.location?.map}.json`) || default_map_properties;

    const position = playerData.location?.position as PositionData;
    let spawnLocation = default_map_spawnpoint;

    if (playerData.location && position) {
      spawnLocation = {
        map: `${playerData.location.map}.json`,
        x: position.x || (player_map_properties ? (player_map_properties.width * player_map_properties.tileWidth) / 2 : 0),
        y: position.y || (player_map_properties ? (player_map_properties.height * player_map_properties.tileHeight) / 2 : 0),
        direction: position.direction || "down",
      };
    }

    const map =
      maps.find((m: MapData) => m.name === spawnLocation.map) ||
      maps.find((m: MapData) => m.name === `${defaultMap}.json`);
    if (!map) return;

    spawnLocation.map = map.name;

    const incompleteQuest = (playerData.questlog?.incomplete as unknown as Quest[]) || [];
    const completedQuest = (playerData.questlog?.completed as unknown as Quest[]) || [];

    // Fetch fresh worlds from Redis with fallback to cache
    const worldsResult = await assetCache.get("worlds").catch(err => {
      log.error(`[WorldsFetchError] Failed to fetch worlds: ${err}`);
      return worldsCache;
    });

    // Parse worlds data
    const worldData: WorldData[] = Array.isArray(worldsResult)
      ? worldsResult
      : JSON.parse(worldsResult);

    const world = worldData.find(
      (w) => w.name === spawnLocation.map.replace(".json", "")
    );

    const playerCount = (world?.players || 0) + 1;
    const maxPlayers = world?.max_players || 100;
    if (world && maxPlayers && playerCount > maxPlayers) {
      ws.close(1008, "World is full");
      return;
    }

    if (world) {
      world.players = (world.players || 0) + 1;
      // Don't await - let Redis write happen in background
      // Use JSON.stringify for consistency with onDisconnect handler
      assetCache.set("worlds", JSON.stringify(worldData)).catch(err =>
        log.error(`Failed to update world player count: ${err}`)
      );
    }
    log.info(`World: ${spawnLocation.map.replace(".json", "")} now has ${world?.players || 0} players.`);

    // Send weather data - use already-fetched world instead of redundant lookup
    const weather = world?.weather || "clear";
    if (weather) {
      sendPacket(ws, packetManager.weather({ weather }));
    }

    // Add player to cache
    playerCache.add(ws.data.id, {
      username: playerData.username,
      animation: null,
      isAdmin: playerData.isAdmin,
      isStealth: playerData.isStealth,
      isNoclip: playerData.isNoclip,
      id: ws.data.id,
      userid: playerData.id,
      location: {
        map: spawnLocation.map.replace(".json", ""),
        position: {
          x: spawnLocation.x || 0,
          y: spawnLocation.y || 0,
          direction: spawnLocation.direction || "down",
          moving: false,
        },
      },
      language: language || "en",
      ws,
      stats: playerData.stats || {},
      friends: playerData.friends || [],
      attackDelay: 0,
      lastMovementPacket: null,
      permissions: typeof playerData.permissions === "string" ? (playerData.permissions as string).split(",") : playerData.permissions || [],
      movementInterval: null,
      pvp: false,
      last_attack: null,
      invitations: [],
      party_id: playerData.party_id ? Number(playerData.party_id) : null,
      party: playerData.party || null,
      currency: playerData.currency || { copper: 0, silver: 0, gold: 0 },
      isGuest: playerData.isGuest,
      created: performance.now(),
      lastUpdated: performance.now(),
      mounted: false,
      mount_type: null,
      collectables: playerData.collectables || [],
      spellCooldowns: {},
      casting: false,
      lastInterruptTime: 0,
      interruptableSpell: false,
      learnedSpells: playerData.learnedSpells || [],
      inventory: playerData.inventory || [],
      equipment: playerData.equipment || {},
    });

    const stats = await player.synchronizeStats(playerData.username);

    // Prevent health and stamina from exceeding max values
    if (stats.stamina > stats.total_max_stamina) {
      stats.stamina = stats.total_max_stamina;
    }

    if (stats.health > stats.total_max_health) {
      stats.health = stats.total_max_health;
    }

    // Update the player cache with synchronized stats (use session ID, not database user ID)
    const _pcache = playerCache.get(ws.data.id);
    if (_pcache) {
      _pcache.stats = stats;
      playerCache.set(_pcache.id, _pcache);
    }

    const mapData = [
      map?.compressed,
      spawnLocation?.map,
      position?.x || 0,
      position?.y || 0,
      position?.direction || "down",
    ];

    sendPacket(ws, packetManager.loadMap(mapData));

    setImmediate(async () => {
      const snapshotRevision = globalStateRevision;

      const currentPlayersOnMap = filterPlayersByMap(spawnLocation.map);

      const spawnDataForAll = {
        id: ws.data.id,
        userid: playerData.id,
        location: {
          map: spawnLocation.map,
          x: spawnLocation.x || 0,
          y: spawnLocation.y || 0,
          direction: spawnLocation.direction,
        },
        username: playerData.username,
        isAdmin: playerData.isAdmin,
        isGuest: playerData.isGuest,
        isStealth: playerData.isStealth,
        stats: stats || {},
        animation: null,
        friends: playerData.friends || [],
        party_id: playerData.party_id ? Number(playerData.party_id) : null,
        party: playerData.party || [],
        currency: playerData.currency || { copper: 0, silver: 0, gold: 0 },
      };

      const playerDataForLoad: any[] = [];
      // Send spawn packets to all players (O(N))
      for (const p of currentPlayersOnMap) {
        if (!p || !p.ws) continue;
        if (p.ws === ws) {
          sendPacket(p.ws, packetManager.spawnPlayer(spawnDataForAll));
        } else {
          const spawnForOther = {
            id: ws.data.id,
            userid: playerData.id,
            location: {
              map: spawnLocation.map,
              x: spawnLocation.x || 0,
              y: spawnLocation.y || 0,
              direction: spawnLocation.direction,
            },
            username: playerData.username,
            isAdmin: playerData.isAdmin,
            isGuest: playerData.isGuest,
            isStealth: playerData.isStealth,
            stats: stats || {},
            animation: null,
          };
          sendPacket(p.ws, packetManager.spawnPlayer(spawnForOther));
        }

        const loadPlayerData = {
          id: p.id,
          userid: p.userid,
          location: {
            map: p.location.map,
            x: p.location.position.x || 0,
            y: p.location.position.y || 0,
            direction: p.location.position?.direction || "down",
            moving: p.moving || false,
          },
          username: p.username,
          isAdmin: p.isAdmin,
          isGuest: p.isGuest,
          isStealth: p.isStealth,
          stats: p.stats,
          animation: null,
          mounted: p.mounted,
        }
        playerDataForLoad.push(loadPlayerData);
      }

      const loadPlayersData = {
        players: playerDataForLoad,
        snapshotRevision: snapshotRevision
      };

      sendPacket(ws, packetManager.loadPlayers(loadPlayersData));

      if (playerDataForLoad.length > 0) {
        playerDataForLoad.forEach(async (pl) => {
          if (pl.id !== ws.data.id && pl.location.direction) {
            const pcache = playerCache.get(pl.id);
            await sendAnimationTo(
              ws,
              getAnimationNameForDirection(pl.location.direction, !!pcache?.moving),
              pl.id
              // Don't pass snapshotRevision - animations should be applied immediately, not buffered
            );
          }
        });
      }

      if (position?.direction) {
        await sendAnimationTo(
          ws,
          getAnimationNameForDirection(position.direction, false),
          ws.data.id
        );
        for (const other of currentPlayersOnMap) {
          if (other.id !== ws.data.id && other.ws) {
            await sendAnimationTo(
              other.ws,
              getAnimationNameForDirection(position.direction, false),
              ws.data.id
            );
          }
        }
      }

      // Send music
      sendPacket(ws, packetManager.music({ name: 'music_entry' }));

    });
    setImmediate(() => {
      // Get fresh player data at send time
      const currentPlayerData = playerCache.get(ws.data.id);
      if (!currentPlayerData) return;

      // Only iterate through the new player's friends list instead of all players
      const newPlayerFriends = currentPlayerData.friends || [];
      const allPlayers = playerCache.list();

      for (const friendUsername of newPlayerFriends) {
        // Find if this friend is online
        const onlineFriend = Object.values(allPlayers).find(
          (p: any) => p.username === friendUsername && p.ws
        );

        if (onlineFriend) {
          // Notify the friend that the new player is online
          sendPacket(
            onlineFriend.ws,
            packetManager.updateOnlineStatus({
              online: true,
              username: currentPlayerData.username,
            })
          );

          // Notify the new player that this friend is online
          sendPacket(
            currentPlayerData.ws,
            packetManager.updateOnlineStatus({
              online: true,
              username: onlineFriend.username,
            })
          );
        }
      }
    });

    setImmediate(async () => {
      const npcsData = await npcs;
      const npcsInMap = npcsData.filter(
        (npc: Npc) => npc.map === spawnLocation.map.replace(".json", "")
      );
      const npcPackets = await npcsInMap.reduce(
        async (packetsPromise: Promise<any[]>, npc: Npc) => {
          const packets = await packetsPromise;
          const particleArray =
            typeof npc.particles === "string"
              ? (
                await Promise.all(
                  (npc.particles as string)
                    .split(",")
                    .map(async (name) =>
                      (
                        await particles
                      ).find((p: Particle) => p.name === name.trim())
                    )
                )
              ).filter(Boolean)
              : [];
          const npcData = {
            id: npc.id,
            last_updated: npc.last_updated,
            location: {
              x: npc.position.x,
              y: npc.position.y,
              direction: "down",
            },
            script: npc.script,
            hidden: npc.hidden,
            dialog: npc.dialog,
            particles: particleArray,
            quest: npc.quest,
            map: npc.map,
            position: npc.position,
          };
          return [...packets, ...packetManager.createNpc(npcData)];
        },
        Promise.resolve([] as any[])
      );
      if (npcPackets.length) {
        sendPacket(ws, npcPackets);
      }
    });

    // Send client config BEFORE inventory so the config is loaded first
    sendPacket(ws, packetManager.clientConfig(playerData.config || []));
    sendPacket(ws, packetManager.inventory(playerData.inventory));
    sendPacket(ws, packetManager.equipment(playerData.equipment || {}));
    sendPacket(ws, packetManager.collectables(playerData.collectables || []));
    sendPacket(ws, packetManager.spells(playerData.learnedSpells));
    sendPacket(ws, packetManager.questlog(completedQuest, incompleteQuest));
  }
});

export default async function packetReceiver(
  server: any,
  ws: any,
  message: string
) {
  try {
    // Check if the message is empty
    if (!message) return ws.close(1008, "Empty message");
    // Check if the message is too large
    const parsedMessage: Packet = tryParsePacket(message) as Packet;
    if (
      message.length >
      (1024 * 1024 * settings?.websocket?.maxPayloadMB || 1024 * 1024) &&
      parsedMessage.type !== "BENCHMARK" &&
      !settings?.websocket?.benchmarkenabled
    )
      return ws.close(1009, "Message too large");
    // Check if the packet is malformed
    if (!parsedMessage) return ws.close(1007, "Malformed message");
    const data = parsedMessage?.data;
    const type = parsedMessage?.type;
    // Check if the packet has a type and data
    if (!type || (!data && data != null))
      return ws.close(1007, "Malformed message");
    // Check if the packet type is valid
    if (
      Object.values(packetTypes).indexOf(
        parsedMessage?.type as unknown as string
      ) === -1
    ) {
      ws.close(1007, "Invalid packet type");
    }

    const currentPlayer = playerCache.get(ws.data.id) || null;

    // Handle the packet
    switch (type) {
      case "BENCHMARK": {
        (data as any)["returned_timestamp"] = Date.now();
        sendPacket(ws, packetManager.benchmark(data));
        break;
      }
      case "PING": {
        sendPacket(ws, packetManager.ping(data));
        break;
      }
      case "PONG": {
        sendPacket(ws, packetManager.pong(data));
        break;
      }
      case "LOGIN": {
        sendPacket(ws, packetManager.login(ws));
        break;
      }
      case "TIME_SYNC": {
        if (!currentPlayer) return;
        currentPlayer.lastUpdated = performance.now();
        break;
      }
      case "AUTH": {
        const token = data?.toString() as string;

        // No token provided
        if (!token) {
          sendPacket(ws, packetManager.loginFailed());
          ws.close(1008, "Invalid token");
          break;
        }

        if (authentication_queue.has(token)) {
          sendPacket(ws, packetManager.loginFailed());
          ws.close(1008, "Authentication already in progress");
          break;
        }

        // Check if this session is already authenticating
        if (authentication_session_queue.has(ws.data.id)) {
          sendPacket(ws, packetManager.loginFailed());
          ws.close(1008, "Session authentication already in progress");
          break;
        }

        // Add token and session to the authentication queues
        authentication_queue.add(token);
        authentication_session_queue.add(ws.data.id);

        // Register this pending authentication
        pendingAuthentications.set(ws.data.id, { ws, token, language: parsedMessage?.language || "en" });

        // Send authentication request to worker (handler is set up at module level)
        authWorker.postMessage({ token, id: ws.data.id });

        break;
      }
      // TODO:Move this to the logout packet
      case "LOGOUT": {
        if (!currentPlayer) return;
        player.setLocation(
          currentPlayer.id,
          currentPlayer.location.map,
          currentPlayer.location.position
        );
        player.logout(currentPlayer.id);
        break;
      }
      case "DISCONNECT": {
        if (!currentPlayer) return;
        player.setLocation(
          currentPlayer.id,
          currentPlayer.location.map,
          currentPlayer.location.position
        );
        player.clearSessionId(currentPlayer.id);
        break;
      }
      case "MOVEXY": {
        if (!currentPlayer) return;

        const baseSpeed = 2;
        const mountSpeedMultiplier = 1.35;
        const speed = currentPlayer.mounted ? baseSpeed * mountSpeedMultiplier : baseSpeed;
        const targetFPS = 60;
        const frameTime = 1000 / targetFPS;
        const lastDirection =
          currentPlayer.location.position?.direction || "down";

        const direction = data.toString().toLowerCase();

        const directions = [
          "up",
          "down",
          "left",
          "right",
          "upleft",
          "upright",
          "downleft",
          "downright",
        ];

        if (direction === "abort") {
          if (currentPlayer.movementInterval) {
            clearInterval(currentPlayer.movementInterval);
            currentPlayer.movementInterval = null;
            currentPlayer.moving = false;
            playerCache.set(currentPlayer.id, currentPlayer);

            globalStateRevision++;
            await sendPositionAnimation(
              ws,
              lastDirection,
              false,
              currentPlayer.mounted,
              currentPlayer.mount_type || "horse",
              undefined,
              globalStateRevision
            );
          }
          return;
        }

        if (currentPlayer.casting && currentPlayer.interruptableSpell) {
          currentPlayer.casting = false;
          currentPlayer.lastInterruptTime = performance.now();
          playerCache.set(currentPlayer.id, currentPlayer);
          const playersInMap = filterPlayersByMap(currentPlayer.location.map);
          playersInMap.forEach((player) => {
            sendPacket(
              player.ws,
              packetManager.castSpell({ id: currentPlayer.id, spell: 'interrupted', time: 1 })
            );
          });
        }

        if (!directions.includes(direction)) return;

        currentPlayer.location.position.direction = direction || "down";
        currentPlayer.moving = true;
        playerCache.set(currentPlayer.id, currentPlayer);

        globalStateRevision++;
        await sendPositionAnimation(
          ws,
          direction,
          true,
          currentPlayer.mounted,
          currentPlayer.mount_type || "horse",
          undefined,
          globalStateRevision
        );

        if (currentPlayer.movementInterval) {
          clearInterval(currentPlayer.movementInterval);
        }

        let lastTime = performance.now();
        let running = false;

        const movePlayer = async () => {
          if (running) return;
          running = true;

          const currentTime = performance.now();
          const deltaTime = currentTime - lastTime;

          if (deltaTime < frameTime) {
            running = false;
            return;
          }

          lastTime = currentTime - (deltaTime % frameTime);

          const tempPosition = { ...currentPlayer.location.position };
          const playerHeight = 40;
          const playerWidth = 24;

          const directionOffsets: Record<string, { dx: number; dy: number }> = {
            up: { dx: 0, dy: -speed },
            down: { dx: 0, dy: speed },
            left: { dx: -speed, dy: 0 },
            right: { dx: speed, dy: 0 },
            upleft: { dx: -speed, dy: -speed },
            upright: { dx: speed, dy: -speed },
            downleft: { dx: -speed, dy: speed },
            downright: { dx: speed, dy: speed },
          };

          const offset = directionOffsets[direction];
          if (!offset) {
            running = false;
            currentPlayer.moving = false;
            playerCache.set(currentPlayer.id, currentPlayer);
            return;
          }

          tempPosition.x = Math.round(tempPosition.x + offset.dx);
          tempPosition.y = Math.round(tempPosition.y + offset.dy);

          const collision = await player.checkIfWouldCollide(
            currentPlayer.location.map,
            {
              x: tempPosition.x,
              y: tempPosition.y,
              direction,
            },
            {
              width: playerWidth,
              height: playerHeight,
            },
            mapPropertiesCache // Pass cached mapProperties to avoid Redis calls
          );

          const isColliding = collision?.value === true;

          if (!isColliding || currentPlayer.isNoclip) {
            currentPlayer.location.position = tempPosition;
          }

          if (isColliding && !currentPlayer.isNoclip) {
            clearInterval(currentPlayer.movementInterval);
            currentPlayer.movementInterval = null;
            currentPlayer.moving = false;
            playerCache.set(currentPlayer.id, currentPlayer);

            globalStateRevision++;
            await sendPositionAnimation(
              ws,
              direction,
              false,
              currentPlayer.mounted,
              currentPlayer.mount_type || "horse",
              undefined,
              globalStateRevision
            );

            const reason = collision.reason;

            // Send collision tile for debugging
            if (reason === "tile_collision" && collision.tile) {
              sendPacket(ws, packetManager.collisionDebug({
                tileX: collision.tile.x,
                tileY: collision.tile.y
              }));
            }

            if (reason === "warp_collision" && collision.warp) {
              const currentMap = currentPlayer.location.map;
              const warp = collision.warp as {
                map: string;
                position: PositionData;
              };

              const result = await player.setLocation(
                currentPlayer.id,
                warp.map.replace(".json", ""),
                {
                  x: warp.position.x || 0,
                  y: warp.position.y || 0,
                  direction: currentPlayer.location.position?.direction || "down",
                }
              );

              // Only proceed if result is an object with affectedRows property
              if (
                result &&
                typeof result === "object" &&
                "affectedRows" in result &&
                (result as { affectedRows: number }).affectedRows !== 0
              ) {
                currentPlayer.location = {
                  map: warp.map.replace(".json", ""),
                  x: warp.position.x || 0,
                  y: warp.position.y || 0,
                  direction: currentPlayer.location.position?.direction || "down",
                };

                if (currentMap !== warp.map) {
                  sendPacket(ws, packetManager.reconnect());
                } else {
                  globalStateRevision++;
                  const movementData = {
                    id: ws.data.id,
                    _data: currentPlayer.location.position,
                    revision: globalStateRevision
                  };
                  sendPacket(ws, packetManager.moveXY(movementData));
                }
              }
            }

            running = false;
            return;
          }

          const playersInMap = filterPlayersByMap(currentPlayer.location.map);
          const targetPlayers = currentPlayer.isStealth
            ? playersInMap.filter((p) => p.isAdmin)
            : playersInMap;

          globalStateRevision++;

          const movementData = {
            id: ws.data.id,
            _data: currentPlayer.location.position,
            revision: globalStateRevision
          };

          targetPlayers.forEach((player) => {
            sendPacket(player.ws, packetManager.moveXY(movementData));
          });

          running = false;
        };

        movePlayer(); // Immediate first step

        currentPlayer.movementInterval = setInterval(movePlayer, 1);
        break;
      }
      case "TELEPORTXY": {
        if (!currentPlayer?.isAdmin) return;
        currentPlayer.location.position = data;
        currentPlayer.location.position.direction = "down";
        // Round position values to nearest tenth
        currentPlayer.location.position.x = Math.round(
          Number(currentPlayer.location.position.x) * 10
        ) / 10;
        currentPlayer.location.position.y = Math.round(
          Number(currentPlayer.location.position.y) * 10
        ) / 10;
        globalStateRevision++;

        if (currentPlayer.isStealth) {
          const playersInMap = filterPlayersByMap(currentPlayer.location.map);
          const playersInMapAdmin = playersInMap.filter((p) => p.isAdmin);
          playersInMapAdmin.forEach((player) => {
            const movementData = {
              id: ws.data.id,
              _data: currentPlayer.location.position,
              revision: globalStateRevision
            };
            sendPacket(player.ws, packetManager.moveXY(movementData));
          });
        } else {
          const playersInMap = filterPlayersByMap(currentPlayer.location.map);
          playersInMap.forEach((player) => {
            const movementData = {
              id: ws.data.id,
              _data: currentPlayer.location.position,
              revision: globalStateRevision
            };
            sendPacket(player.ws, packetManager.moveXY(movementData));
          });
        }
        break;
      }
      case "CHAT": {
        if (!currentPlayer) return;
        if (currentPlayer.isGuest) {
          sendPacket(
            ws,
            packetManager.notify({
              message: "Please create an account to use that feature.",
            })
          );
          return;
        }
        const messageData = data as any;
        const message = messageData?.message;
        const mode = messageData?.mode;

        // Send message to the sender
        const sendMessageToPlayer = (playerWs: any, message: string) => {
          const chatData = {
            id: ws.data.id,
            message,
            username: currentPlayer.username,
          };
          sendPacket(playerWs, packetManager.chat(chatData));
        };

        if (message == null) {
          const playersInMap = filterPlayersByMap(currentPlayer.location.map);
          playersInMap.forEach((player) => {
            sendMessageToPlayer(player.ws, "");
          });
          return;
        }

        let decryptedMessage;
        if (mode && mode == "decrypt") {
          const encryptedMessage = Buffer.from(
            Object.values(message) as number[]
          );
          const privateKey = _privateKey;
          if (!privateKey) return;
          const decryptedPrivateKey = decryptPrivateKey(
            privateKey,
            process.env.RSA_PASSPHRASE || ""
          ).toString();
          decryptedMessage =
            decryptRsa(encryptedMessage, decryptedPrivateKey) || "";
        } else {
          decryptedMessage = message;
        }

        // Send the message to the sender
        sendMessageToPlayer(ws, decryptedMessage as string);

        const cache = playerCache.list();
        let playersInMap = Object.values(cache).filter(
          (p) =>
            p.location.map === currentPlayer.location.map && p.id !== ws.data.id
        );

        if (currentPlayer.isStealth) {
          // Filter only admins in the same map
          playersInMap = playersInMap.filter((p) => p.isAdmin);
        }

        // If there are no players in the map, return
        if (playersInMap.length === 0) return;

        const translations: Record<string, string> = {};

        playersInMap.forEach(async (player) => {
          if (!translations[player.language]) {
            // Skip translation if target language matches source language
            translations[player.language] =
              player.language === currentPlayer.language
                ? decryptedMessage
                : await language.translate(decryptedMessage, player.language);
          }

          const chatData = {
            id: ws.data.id,
            message: translations[player.language],
            username: currentPlayer.username,
          };

          sendPacket(player.ws, packetManager.chat(chatData));
        });
        break;
      }
      case "TYPING": {
        if (!currentPlayer || currentPlayer?.isGuest) return;
        const typingData = {
          id: ws.data.id,
        };
        let playersInMap = filterPlayersByMap(currentPlayer.location.map);
        if (currentPlayer.isStealth) {
          playersInMap = playersInMap.filter((p) => p.isAdmin);
        }
        playersInMap.forEach((player) => {
          sendPacket(player.ws, packetManager.typing(typingData));
        });
        break;
      }
      case "CLIENTCONFIG": {
        if (!currentPlayer) return;
        await player.setConfig(ws.data.id, data);
        break;
      }
      case "SELECTPLAYER": {
        if (!currentPlayer) return;
        const location = data as unknown as LocationData;
        const cache = playerCache.list();
        // Get current player data from cache
        // only get players that are in the same map
        const players = Object.values(cache).filter(
          (p) => p.location.map === currentPlayer.location.map
        );
        // Find the first player that is closest to the selected location within a 25px radius
        const selectedPlayer = players.find(
          (p) =>
            Math.abs(p.location.position.x - Math.floor(Number(location.x))) <
            25 &&
            Math.abs(p.location.position.y - Math.floor(Number(location.y))) <
            25
        );

        if (!selectedPlayer) break;
        if (selectedPlayer.isStealth && !currentPlayer.isAdmin) {
          const selectPlayerData = {
            id: ws.data.id,
            data: null,
          };
          sendPacket(ws, packetManager.selectPlayer(selectPlayerData));
          break;
        } else {
          const selectPlayerData = {
            id: selectedPlayer.id,
            username: selectedPlayer.username,
            stats: selectedPlayer.stats,
          };
          sendPacket(ws, packetManager.selectPlayer(selectPlayerData));
        }
        break;
      }
      case "TARGETCLOSEST": {
        if (!currentPlayer) return;
        const playersInRange = filterPlayersByDistance(
          ws,
          500,
          currentPlayer.location.map
        ).filter((p) => !p.isStealth && p.id !== currentPlayer.id); // Filter out stealth players and self

        const closestPlayer = player.findClosestPlayer(
          currentPlayer,
          playersInRange,
          500
        );

        if (closestPlayer) {
          const selectPlayerData = {
            id: closestPlayer.id || null,
            username: closestPlayer.username || null,
            stats: closestPlayer.stats || null,
          };

          sendPacket(ws, packetManager.selectPlayer(selectPlayerData));
        }
        break;
      }
      case "INSPECTPLAYER": {
        if (currentPlayer) {
          const targetId = (data as any)?.id;
          // If no target ID is provided, inspect self
          const targetPlayer = targetId
            ? playerCache.get(targetId)
            : currentPlayer;

          if (targetPlayer) {
            const inspectPlayerData = {
              id: targetPlayer.id,
              stats: targetPlayer.stats,
              username: targetPlayer.username,
              equipment: targetPlayer.equipment || {},
              inventory: targetPlayer.inventory || [],
            };
            sendPacket(ws, packetManager.inspectPlayer(inspectPlayerData));
          }
        }
        break;
      }
      case "NOCLIP": {
        if (!currentPlayer?.isAdmin) return;
        const isNoclip = await player.toggleNoclip(currentPlayer.username);
        currentPlayer.isNoclip = isNoclip;
        break;
      }
      case "STEALTH": {
        if (!currentPlayer?.isAdmin) return;
        const isStealth = await player.toggleStealth(currentPlayer.username);
        currentPlayer.isStealth = isStealth;
        const playersInMap = filterPlayersByMap(currentPlayer.location.map);
        const stealthData = {
          id: ws.data.id,
          isStealth: currentPlayer.isStealth,
        };
        sendPacket(ws, packetManager.stealth(stealthData));
        playersInMap.forEach((player) => {
          const stealthData = {
            id: ws.data.id,
            isStealth: currentPlayer.isStealth,
          };
          sendPacket(player.ws, packetManager.stealth(stealthData));
        });
        if (!isStealth) {
          globalStateRevision++;
          playersInMap.forEach(async (player) => {
            const moveXYData = {
              id: ws.data.id,
              _data: currentPlayer.location.position,
              revision: globalStateRevision
            };

            if (currentPlayer.location.position?.direction) {
              await sendPositionAnimation(
                ws,
                currentPlayer.location.position?.direction,
                false,
                currentPlayer.mounted,
                currentPlayer.mount_type || "horse",
                undefined,
                globalStateRevision
              );
              sendPacket(player.ws, packetManager.moveXY(moveXYData));
            }
          });
        }
        break;
      }
      case "SAVE_HOTBAR": {
        if (!currentPlayer) return;
        await player.saveHotBarConfig(currentPlayer.username, data as any);
        break;
      }
      case "SAVE_INVENTORY_CONFIG": {
        if (!currentPlayer) return;
        await player.saveInventoryConfig(currentPlayer.username, data as any);
        break;
      }
      case "HOTBAR": {
        if (!currentPlayer) return;
        if (currentPlayer.isGuest) {
          sendPacket(
            ws,
            packetManager.notify({
              message: "Please create an account to use that feature.",
            })
          );
          return;
        }

        // Check if we're currently in an interrupt grace period (1.5 seconds)
        const timeSinceInterrupt = performance.now() - (currentPlayer.lastInterruptTime || 0);
        if (timeSinceInterrupt < 1500) {
          // Still showing interrupt, ignore this cast attempt
          return;
        }

        // Check if the player is casting already - reject the new cast attempt
        const casting = playerCache.get(currentPlayer.id)?.casting;
        if (casting) {
          // Don't interrupt, just reject the new cast
          return;
        }

        // Global cast delay - prevent spamming casts too quickly
        // Get fresh player data from cache to check the actual last cast time
        const freshPlayerForDelay = playerCache.get(currentPlayer.id);
        const lastCastTime = freshPlayerForDelay?.lastCastTime || 0;
        const timeSinceLastCast = performance.now() - lastCastTime;
        const globalCastDelay = 500; // 500ms delay between all casts
        if (timeSinceLastCast < globalCastDelay) {
          return; // Reject cast if too soon after previous cast
        }

        const spell_identifier = (data as any).spell;

        const spell = await spells.find(spell_identifier);
        const spell_id = spell?.id;
        if (!spell || !spell_id) {
          sendPacket(
            ws,
            packetManager.notify({ message: "Invalid spell selected." })
          );
          break;
        }

        // Check if spell identifier is provided
        if (!spell_identifier) {
          sendPacket(
            ws,
            packetManager.notify({ message: "No spell selected." })
          );
          break;
        }

        if (!currentPlayer.learnedSpells?.[spell.name]) {
          sendPacket(ws, packetManager.notify({ message: "You have not learned this spell." }));
          return;
        }

        const target = playerCache.get((data as any).target?.id) || currentPlayer;

        if (!target?.id) {
          sendPacket(
            ws,
            packetManager.notify({ message: "Target player not found." })
          );
          return;
        }

        if (target.isGuest) {
          sendPacket(
            ws,
            packetManager.notify({ message: "You cannot attack guests." })
          );
          return;
        }

        // Check if spell is on cooldown (get fresh data from cache)
        const freshPlayerForCooldown = playerCache.get(currentPlayer.id);
        if (!freshPlayerForCooldown) return;
        freshPlayerForCooldown.spellCooldowns = freshPlayerForCooldown.spellCooldowns || {};
        const spellCooldownEnd = freshPlayerForCooldown.spellCooldowns[spell_id] || 0;
        if (spellCooldownEnd > performance?.now()) {
          return;
        }

        const spell_range = spell.range || 100;
        const spell_damage = spell?.damage;
        const spell_mana = spell?.mana || 0;
        // Set interruptable spell flag so we can check later if movement interrupts it
        currentPlayer.interruptableSpell = !spell?.can_move || false;

        // If spell can't be cast while moving and player is currently moving, reject cast
        if (!spell?.can_move && currentPlayer.moving) {
          // Send interrupted notification to all players in map
          const playersInMap = filterPlayersByMap(currentPlayer.location.map);
          playersInMap.forEach((player) => {
            sendPacket(
              player.ws,
              packetManager.castSpell({ id: currentPlayer.id, spell: 'interrupted', time: 1 })
            );
          });
          currentPlayer.lastInterruptTime = performance.now();
          playerCache.set(currentPlayer.id, currentPlayer);
          return;
        }

        playerCache.set(currentPlayer.id, currentPlayer);

        // If not enough mana, return
        // Get fresh stats from cache to avoid race condition with rapid casts
        const freshPlayerForMana = playerCache.get(currentPlayer.id);
        if (!freshPlayerForMana) return;

        // Calculate actual mana cost as percentage of max stamina
        const actualManaCost = Math.floor(freshPlayerForMana.stats.total_max_stamina * (spell_mana / 100));
        if ((freshPlayerForMana.stats.stamina || 0) < actualManaCost) {
          return;
        }

        // Return if no damage is set
        if (!spell_damage) return;

        // Set lastCastTime IMMEDIATELY to start global cast delay and prevent concurrent casts
        freshPlayerForMana.lastCastTime = performance.now();

        // Set spell on cooldown NOW (includes cast time + cooldown)
        freshPlayerForMana.spellCooldowns = freshPlayerForMana.spellCooldowns || {};
        const totalCooldownTime = (spell.cast_time * 1000) + (spell.cooldown * 1000);
        freshPlayerForMana.spellCooldowns[spell_id] = performance.now() + totalCooldownTime;

        playerCache.set(freshPlayerForMana.id, freshPlayerForMana);

        // Update currentPlayer stats with fresh stats
        currentPlayer.stats = freshPlayerForMana.stats;
        currentPlayer.lastCastTime = freshPlayerForMana.lastCastTime;
        currentPlayer.spellCooldowns = freshPlayerForMana.spellCooldowns;

        const isInParty = currentPlayer?.party?.includes(target?.username) || null;

        // Check if in the same party and spell does damage
        // We can heal party members, but not damage them
        if (isInParty && spell_damage > 0) {
          sendPacket(
            ws,
            packetManager.notify({
              message: "You cannot attack your party members",
            })
          );
          return;
        }

        // If damage is negative, only allow on self or party members (healing)
        if (spell_damage < 0 && target.id !== currentPlayer.id && !isInParty) return;

        const playersInMap = filterPlayersByMap(currentPlayer.location.map);

        const playersInAttackRange = filterPlayersByDistance(
          ws,
          spell_range,
          currentPlayer.location.map
        );

        const canAttack = await player.canAttack(currentPlayer, target,
          {
            width: 24,
            height: 40,
          },
          spell_range
        );

        // Don't check range if targetting self and it's a healing spell
        if (target.id === currentPlayer.id && spell_damage < 0) {
          playersInAttackRange.push(target);
        } else if (!playersInAttackRange.includes(target) || !canAttack?.value) {
          // Check if target is in range and can be attacked
          if (canAttack?.reason == "nopvp") {
            sendPacket(
              ws,
              packetManager.notify({ message: "You are not in a PvP area" })
            );
          }
          if (canAttack?.reason == "path_blocked") {
            sendPacket(
              ws,
              packetManager.notify({ message: "Target is not in line of sight" })
            );
          }
          return;
        }

        // Distance between players
        const distance = Math.sqrt(
          Math.pow(currentPlayer.location.position.x - target.location.position.x, 2) +
          Math.pow(currentPlayer.location.position.y - target.location.position.y, 2)
        );

        // No travel time if targeting self
        let delay = 0;
        if (target.id !== currentPlayer.id) {
          const maxTravelTime = 500; // Maximum travel time in ms
          const speedMultiplier = 1000; // Adjust this to control base travel speed
          // Calculate dynamic travel time based on distance
          // Formula: (distance / speedMultiplier) * 1000 for milliseconds
          const calculatedDelay = (distance / speedMultiplier) * 1000;

          // Apply maximum travel time cap, no minimum
          delay = Math.min(calculatedDelay, maxTravelTime);
        }

        // Set an async timeout to simulate spell casting time
        currentPlayer.casting = true;
        playerCache.set(currentPlayer.id, currentPlayer);
        playersInMap.forEach((player) => {
          sendPacket(
            player.ws,
            packetManager.castSpell({ id: currentPlayer.id, spell: spell.name, time: spell.cast_time })
          );
        });
        await new Promise((resolve) => setTimeout(resolve, spell.cast_time * 1000));
        if (!spell.can_move && !playerCache.get(currentPlayer.id)?.casting) {
          // Cast was interrupted, reset cooldown
          const resetPlayer = playerCache.get(currentPlayer.id);
          if (resetPlayer && resetPlayer.spellCooldowns) {
            delete resetPlayer.spellCooldowns[spell_id];
            playerCache.set(resetPlayer.id, resetPlayer);
          }
          return;
        }
        currentPlayer.casting = false;
        playerCache.set(currentPlayer.id, currentPlayer);

        const canAttack2 = await player.canAttack(currentPlayer, target,
          {
            width: 24,
            height: 40,
          },
          spell_range
        );

        // Re-validate attack conditions after casting because players may have moved behind cover
        if (canAttack2?.reason == "nopvp") {
          playersInMap.forEach((player) => {
            sendPacket(
              player.ws,
              packetManager.castSpell({ id: currentPlayer.id, spell: 'failed', time: 1 })
            );
          });
          // Reset cooldown since spell failed
          const resetPlayer = playerCache.get(currentPlayer.id);
          if (resetPlayer && resetPlayer.spellCooldowns) {
            delete resetPlayer.spellCooldowns[spell_id];
            playerCache.set(resetPlayer.id, resetPlayer);
          }
          return;
        }

        if (canAttack2?.reason == "path_blocked") {
          playersInMap.forEach((player) => {
            sendPacket(
              player.ws,
              packetManager.castSpell({ id: currentPlayer.id, spell: 'failed', time: 1 })
            );
          });
          // Reset cooldown since spell failed
          const resetPlayer = playerCache.get(currentPlayer.id);
          if (resetPlayer && resetPlayer.spellCooldowns) {
            delete resetPlayer.spellCooldowns[spell_id];
            playerCache.set(resetPlayer.id, resetPlayer);
          }
          return;
        }

        if (canAttack2?.reason == "direction") {
          playersInMap.forEach((player) => {
            sendPacket(
              player.ws,
              packetManager.castSpell({ id: currentPlayer.id, spell: 'failed', time: 1 })
            );
          });
          // Reset cooldown since spell failed
          const resetPlayer = playerCache.get(currentPlayer.id);
          if (resetPlayer && resetPlayer.spellCooldowns) {
            delete resetPlayer.spellCooldowns[spell_id];
            playerCache.set(resetPlayer.id, resetPlayer);
          }
          return;
        }

        // Set another timeout to simulate spell travel time on the server
        // If target is self, no travel time
        if (target.id !== currentPlayer.id) {
          playersInMap.forEach((player) => {
            sendPacket(
              player.ws,
              packetManager.projectile({ id: currentPlayer.id, time: delay / 1000, target_id: target.id, spell: spell.name, icon: spell.icon || null })
            );
          });
        }
        await new Promise((resolve) => setTimeout(resolve, delay));

        const playerLevel = currentPlayer.stats.level || 1;

        // Calculate base spell damage with level scaling
        const minDamage = spell_damage < 0 ?
          spell_damage - (playerLevel - 1) * 2 :
          spell_damage + (playerLevel - 1) * 2;
        const maxDamage = spell_damage < 0 ?
          spell_damage - (playerLevel - 1) * 5 :
          spell_damage + (playerLevel - 1) * 5;
        const spellDamage = Math.floor(Math.random() * (Math.abs(maxDamage - minDamage) + 1)) + Math.min(minDamage, maxDamage);

        // Add attacker's stat_damage as flat bonus
        const attackerDamageBonus = currentPlayer.stats.stat_damage || 0;
        const baseDamage = spellDamage + attackerDamageBonus;

        // Calculate crit
        const critChance = currentPlayer.stats.stat_critical_chance || 0;
        const critDamage = currentPlayer.stats.stat_critical_damage || 0;
        const critRoll = Math.random() * 100;
        const isCrit = critRoll < critChance;

        // Apply crit multiplier if crit lands
        let finalDamage = baseDamage;
        if (isCrit) {
          // For healing (negative damage), crit increases the healing amount (makes it more negative)
          // For damage (positive), crit increases the damage amount
          finalDamage = Math.floor(baseDamage * (1 + critDamage / 100));
        }

        // Check targets avoidance stat for damage spells only
        if (finalDamage > 0) {
          const targetAvoidance = target.stats.stat_avoidance || 0;
          const avoidanceRoll = Math.random() * 100;
          if (avoidanceRoll < targetAvoidance) {
            finalDamage = 0;
          }

          // Apply target's armor reduction if attack was not avoided
          // Armor is a % damage reduction (e.g., 25 armor = 25% damage reduction)
          if (finalDamage > 0) {
            const targetArmor = target.stats.stat_armor || 0;
            const armorReduction = Math.min(targetArmor, 75) / 100; // Cap at 75% reduction
            finalDamage = Math.floor(finalDamage * (1 - armorReduction));
          }
        }

        // Re-check mana right before deduction (mana might have changed during cast/projectile delays)
        const finalManaCheck = playerCache.get(currentPlayer.id);
        if (!finalManaCheck || (finalManaCheck.stats.stamina || 0) < actualManaCost) {
          // Reset cooldown since not enough mana
          if (finalManaCheck && finalManaCheck.spellCooldowns) {
            delete finalManaCheck.spellCooldowns[spell_id];
            playerCache.set(finalManaCheck.id, finalManaCheck);
          }
          return;
        }

        // Update currentPlayer with fresh mana value
        currentPlayer.stats.stamina = finalManaCheck.stats.stamina;

        target.stats.health = Math.round(target.stats.health - finalDamage);
        currentPlayer.stats.stamina -= actualManaCost;

        // Ensure stamina doesn't go below 0
        if (currentPlayer.stats.stamina < 0) {
          currentPlayer.stats.stamina = 0;
        }

        // Update cache immediately so concurrent casts see the reduced mana
        playerCache.set(currentPlayer.id, currentPlayer);

        // Handle overhealing
        if (target.stats.health > target.stats.total_max_health) {
          target.stats.health = target.stats.total_max_health;
        }

        // Handle death
        if (target.stats.health <= 0) {
          // Store the death stats before restoration for showing damage numbers
          const deathStats = { ...target.stats };

          target.stats.health = target.stats.total_max_health;
          target.stats.stamina = target.stats.total_max_stamina;

          // Find closest graveyard or use default worldspawn
          const currentMapName = target.location.map;
          const respawnMapProps = mapPropertiesCache.find((m: any) => m.name === `${currentMapName}.json`);

          // Search for graveyards in the map
          let respawnX: number;
          let respawnY: number;

          if (respawnMapProps?.graveyards && Array.isArray(respawnMapProps.graveyards) && respawnMapProps.graveyards.length > 0) {
            // Find closest graveyard to death location
            let closestGraveyard = respawnMapProps.graveyards[0];
            let closestDistance = Math.sqrt(
              Math.pow(target.location.position.x - closestGraveyard.position.x, 2) +
              Math.pow(target.location.position.y - closestGraveyard.position.y, 2)
            );

            for (const graveyard of respawnMapProps.graveyards) {
              const distance = Math.sqrt(
                Math.pow(target.location.position.x - graveyard.position.x, 2) +
                Math.pow(target.location.position.y - graveyard.position.y, 2)
              );

              if (distance < closestDistance) {
                closestDistance = distance;
                closestGraveyard = graveyard;
              }
            }

            respawnX = closestGraveyard.position.x;
            respawnY = closestGraveyard.position.y;
          } else {
            // No graveyards found, use default worldspawn
            const defaultMapProps = mapPropertiesCache.find((m: any) => m.name === `${defaultMap}.json`);
            respawnX = defaultMapProps
              ? (defaultMapProps.width * defaultMapProps.tileWidth) / 2
              : 0;
            respawnY = defaultMapProps
              ? (defaultMapProps.height * defaultMapProps.tileHeight) / 2
              : 0;
          }

          target.location.position = { x: respawnX, y: respawnY, direction: "down" };

          // Give the attacker xp
          const xp = 10;
          const xpResult = await player.increaseXp(currentPlayer.username, xp);

          // Synchronize stats with equipment bonuses after level up
          const syncedStats = await player.synchronizeStats(currentPlayer.username);

          // Update all stats in memory
          if (syncedStats) {
            currentPlayer.stats = syncedStats;
          }

          // Update XP values from increaseXp result
          if (xpResult && typeof xpResult === 'object' && 'xp' in xpResult) {
            currentPlayer.stats.xp = xpResult.xp;
            currentPlayer.stats.level = xpResult.level;
            currentPlayer.stats.max_xp = xpResult.max_xp;
          }

          // Update the player cache with the new stats including XP
          playerCache.set(currentPlayer.id, currentPlayer);

          // Send XP update to attacker
          sendPacket(
            ws,
            packetManager.updateXp({
              id: currentPlayer.id,
              xp: currentPlayer.stats.xp,
              level: currentPlayer.stats.level,
              max_xp: currentPlayer.stats.max_xp,
            })
          );

          // Send full stats update to sync HP/stamina changes
          sendPacket(
            ws,
            packetManager.updateStats({
              target: currentPlayer.id,
              stats: currentPlayer.stats,
            })
          );

          globalStateRevision++;
          playersInMap.forEach((player) => {
            // Send damage numbers for the killing blow BEFORE revive
            sendPacket(
              player.ws,
              packetManager.updateStats({
                id: ws.data.id,
                target: target.id,
                stats: deathStats, // Use the stats from before restoration
                isCrit: isCrit,
                damage: finalDamage,
              })
            );

            sendPacket(
              player.ws,
              packetManager.moveXY({
                id: target.id,
                _data: target.location.position,
                revision: globalStateRevision
              })
            );

            // Send REVIVE packet to restore health after showing the killing blow
            sendPacket(
              player.ws,
              packetManager.revive({
                id: target.id,
                target: target.id,
                stats: target.stats,
              })
            );
          });

          // Send stats to party members who are not in the same map
          sendStatsToPartyMembers(currentPlayer.username, currentPlayer.id, currentPlayer.stats);
          sendStatsToPartyMembers(target.username, target.id, target.stats);
        } else {
          // Always send updated stats to all players in map
          playersInMap.forEach((player) => {
            sendPacket(
              player.ws,
              packetManager.updateStats({
                id: ws.data.id,
                target: target.id,
                stats: target.stats,
                isCrit: isCrit,
                damage: finalDamage,
              })
            );

            sendPacket(
              player.ws,
              packetManager.updateStats({
                id: currentPlayer.id,
                target: currentPlayer.id,
                stats: currentPlayer.stats,
              })
            );
          });

          // Send stats to party members who are not in the same map
          sendStatsToPartyMembers(target.username, target.id, target.stats);
          sendStatsToPartyMembers(currentPlayer.username, currentPlayer.id, currentPlayer.stats);
        }

        // PVP flags + cooldown
        // If healing a party member, don't set pvp flags
        if (!isInParty) {
          currentPlayer.pvp = true;
          target.pvp = true;
        }

        // Update last attack time
        currentPlayer.last_attack = performance.now();
        target.last_attack = performance.now();

        // Spell cooldown was already set at cast start (includes cast time + cooldown)
        playerCache.set(currentPlayer.id, currentPlayer);

        break;
      }
      case "QUESTDETAILS": {
        const questId = data as unknown as number;
        const quest = await quests.find(questId);
        sendPacket(ws, packetManager.questDetails(quest));
        break;
      }
      case "STOPTYPING": {
        if (!currentPlayer || currentPlayer.isGuest) return;
        let playersInMap = filterPlayersByMap(currentPlayer.location.map);
        const stopTypingData = {
          id: ws.data.id,
        };
        if (currentPlayer.isStealth) {
          playersInMap = playersInMap.filter((p) => p.isAdmin);
        }
        playersInMap.forEach((player) => {
          sendPacket(player.ws, packetManager.stopTyping(stopTypingData));
        });
        break;
      }
      case "SAVE_MAP": {
        if (!currentPlayer) return;

        // Check permissions
        const userPermissions = await permissions.get(currentPlayer.username) as string;
        const perms = userPermissions.includes(",") ? userPermissions.split(",") : userPermissions.length ? [userPermissions] : [];
        const hasPermission = perms.includes('server.admin') || perms.includes('server.*');

        if (!hasPermission) {
          sendPacket(ws, packetManager.notify({
            message: 'You do not have permission to save map changes.'
          }));
          return;
        }

        const saveData = data as unknown as { mapName: string, chunks: any[] };

        // Process map save
        try {
          log.info(`Map save requested by ${currentPlayer.username} for map: ${saveData.mapName}, ${saveData.chunks.length} chunks modified`);

          // Find the map in the cache
          const mapIndex = (maps as any[]).findIndex((m: any) => m.name === saveData.mapName);

          if (mapIndex === -1) {
            throw new Error(`Map ${saveData.mapName} not found`);
          }

          // Update each chunk in the map data (in-memory cache)
          saveData.chunks.forEach((chunkData: any) => {
            const chunkKey = `${chunkData.chunkX}-${chunkData.chunkY}`;

            // Update the map's chunks
            if (!maps[mapIndex].chunks) {
              maps[mapIndex].chunks = {};
            }

            maps[mapIndex].chunks[chunkKey] = {
              width: chunkData.width,
              height: chunkData.height,
              layers: chunkData.layers
            };
          });

          // Update the asset cache
          assetCache.add("maps", maps);

          // Write changes to disk for persistence (this also reprocesses collision/no-pvp maps)
          await saveMapChunks(saveData.mapName, saveData.chunks);

          // Clear the map cache to force reload of collision data
          clearMapCache(saveData.mapName);

          // Reload the map to get updated collision data
          const reloadedMap = await reloadMap(saveData.mapName);
          if (reloadedMap) {
            maps[mapIndex].compressed = reloadedMap.compressed;
            maps[mapIndex].data = reloadedMap.data;
            assetCache.add("maps", maps);
            log.info(`Reloaded collision data for map: ${saveData.mapName}`);
          }

          sendPacket(ws, packetManager.notify({
            message: `Map saved successfully! ${saveData.chunks.length} chunks updated.`
          }));

          // Broadcast chunk updates to all players on this map
          const playersInMap = filterPlayersByMap(currentPlayer.location.map);
          const chunkCoords = saveData.chunks.map((chunk: any) => ({
            chunkX: chunk.chunkX,
            chunkY: chunk.chunkY
          }));

          playersInMap.forEach((player) => {
            sendPacket(player.ws, packetManager.updateChunks(chunkCoords));
          });
        } catch (error: any) {
          log.error(`Error saving map: ${error.message}`);
          sendPacket(ws, packetManager.notify({
            message: 'Error saving map changes.'
          }));
        }
        break;
      }
      case "COMMAND": {
        if (!currentPlayer) return;
        if (currentPlayer.isGuest) {
          sendPacket(
            ws,
            packetManager.notify({
              message: "Please create an account to use that feature.",
            })
          );
          return;
        }
        const _data = data as any;
        const command = _data?.command;
        const mode = _data?.mode;

        let decryptedMessage;
        if (mode && mode == "decrypt") {
          const encryptedMessage = Buffer.from(
            Object.values(command) as number[]
          );

          const privateKey = _privateKey;
          if (!privateKey) return;
          const decryptedPrivateKey = decryptPrivateKey(
            privateKey,
            process.env.RSA_PASSPHRASE || ""
          ).toString();
          decryptedMessage =
            decryptRsa(encryptedMessage, decryptedPrivateKey) || "";
        } else {
          decryptedMessage = command;
        }

        const commandParts = decryptedMessage.match(/[^\s"]+|"([^"]*)"/g) || [];
        const commandName = commandParts[0]?.toUpperCase();

        const args = commandParts
          .slice(1)
          .map((arg: any) => (arg.startsWith('"') ? arg.slice(1, -1) : arg));

        switch (commandName) {
          // Party chat
          case "P":
          case "PARTY": {
            if (!currentPlayer) return;
            const message = args.join(" ");
            if (!message) {
              sendPacket(
                ws,
                packetManager.notify({ message: "Please provide a message" })
              );
              break;
            }

            // Get the party members
            const partyId = await player.getPartyIdByUsername(
              currentPlayer.username
            );
            if (!partyId) {
              sendPacket(
                ws,
                packetManager.notify({ message: "You are not in a party" })
              );
              break;
            }

            const partyMembers = await parties.getPartyMembers(partyId);
            if (partyMembers.length === 0 || !partyMembers) {
              sendPacket(
                ws,
                packetManager.notify({ message: "You are not in a party" })
              );
              break;
            }

            partyMembers.forEach(async (member: any) => {
              const session_id = await player.getSessionIdByUsername(member);
              const memberPlayer = playerCache.get(session_id);
              if (memberPlayer) {
                sendPacket(
                  memberPlayer.ws,
                  packetManager.partyChat({
                    id: ws.data.id,
                    message,
                    username:
                      currentPlayer.username.charAt(0).toUpperCase() +
                      currentPlayer.username.slice(1),
                  })
                );
              }
            });

            break;
          }
          // Whisper a player that is online
          case "W":
          case "WHISPER": {
            const username = args[0]?.toLowerCase() || null;
            if (!username) {
              const notifyData = {
                message: "Please provide a username",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            // Find player by username
            // Search by username
            const players = Object.values(playerCache.list());
            const targetPlayer = players.find(
              (p) => p.username.toLowerCase() === username.toLowerCase()
            );

            if (!targetPlayer) {
              const notifyData = {
                message: "Player not found or is not online",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            sendPacket(
              targetPlayer.ws,
              packetManager.whisper({
                id: ws.data.id,
                message: args.slice(1).join(" "),
                // Uppercase the first letter of the username
                username: `<- ${currentPlayer.username.charAt(0).toUpperCase() +
                  currentPlayer.username.slice(1)
                  }`,
              })
            );

            sendPacket(
              ws,
              packetManager.whisper({
                id: targetPlayer.id,
                message: args.slice(1).join(" "),
                username: `-> ${targetPlayer.username.charAt(0).toUpperCase() +
                  targetPlayer.username.slice(1)
                  }`,
              })
            );

            break;
          }
          // Summon a player
          case "SUMMON": {
            // admin.summon or admin.*
            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.summon" || p === "admin.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            const identifier = args[0]?.toLowerCase() || null;
            if (!identifier) {
              const notifyData = {
                message: "Please provide a username or ID",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            // Find player by ID or username
            let targetPlayer;
            if (isNaN(Number(identifier))) {
              // Search by username
              const players = Object.values(playerCache.list());
              targetPlayer = players.find(
                (p) => p.username.toLowerCase() === identifier.toLowerCase()
              );
            } else {
              // Search by ID
              targetPlayer = playerCache.get(identifier);
            }

            if (!targetPlayer) {
              const notifyData = {
                message: "Player not found or is not online",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            // Prevent summoning yourself
            if (targetPlayer.id === currentPlayer.id) {
              const notifyData = {
                message: "You cannot summon yourself",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            // Prevent summoning admins
            if (targetPlayer.isAdmin) {
              const notifyData = {
                message: "You cannot summon other admins",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            // Must be in the same map
            if (targetPlayer.location.map !== currentPlayer.location.map) {
              const notifyData = {
                message: "You can only summon players in the same map",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            // Move the target player to the current player's position
            targetPlayer.location.position = {
              x: currentPlayer.location.position.x,
              y: currentPlayer.location.position.y,
              direction: targetPlayer.location.position?.direction || "down",
            };

            // Update the target player's position in the cache
            playerCache.set(targetPlayer.id, targetPlayer);

            const playersInMap = filterPlayersByMap(currentPlayer.location.map);

            globalStateRevision++;
            playersInMap.forEach((player) => {
              const moveXYData = {
                id: targetPlayer.id,
                _data: targetPlayer.location.position,
                revision: globalStateRevision
              };
              sendPacket(player.ws, packetManager.moveXY(moveXYData));
            });

            // Notify the target player
            sendPacket(
              targetPlayer.ws,
              packetManager.notify({
                message: `You have been summoned by an admin`,
              })
            );

            // Notify the admin
            sendPacket(
              ws,
              packetManager.notify({
                message: `Summoned ${targetPlayer.username.charAt(0).toUpperCase() +
                  targetPlayer.username.slice(1)
                  }`,
              })
            );
            break;
          }
          // Kick a player
          case "KICK":
          case "DISCONNECT": {
            // admin.kick or admin.*
            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.kick" || p === "admin.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }
            const identifier = args[0].toLowerCase() || null;
            if (!identifier) {
              const notifyData = {
                message: "Please provide a username or ID",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            // Find player by ID or username
            let targetPlayer;
            if (isNaN(Number(identifier))) {
              // Search by username
              const players = Object.values(playerCache.list());
              targetPlayer = players.find(
                (p) => p.username.toLowerCase() === identifier.toLowerCase()
              );
            } else {
              // Search by ID
              targetPlayer = playerCache.get(identifier);
            }

            // Prevent disconnecting yourself
            if (targetPlayer?.id === currentPlayer.id) {
              const notifyData = {
                message: "You cannot disconnect yourself",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            if (!targetPlayer) {
              const notifyData = {
                message: "Player not found or is not online",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            // Prevent disconnecting admins
            if (targetPlayer.isAdmin) {
              const notifyData = {
                message: "You cannot disconnect other admins",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            player.kick(targetPlayer.username, targetPlayer.ws);
            const notifyData = {
              message: `Disconnected ${targetPlayer.username.charAt(0).toUpperCase() +
                targetPlayer.username.slice(1)
                } from the server`,
            };
            sendPacket(ws, packetManager.notify(notifyData));
            break;
          }
          // Send a message to all players in the current map
          case "NOTIFY":
          case "BROADCAST": {
            // server.notify or server.*
            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "server.notify" || p === "server.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }
            let message;
            let audience = "ALL";

            // If no audience provided, treat first arg as the message
            if (!args[0]) return;
            if (!["ALL", "ADMINS", "MAP"].includes(args[0].toUpperCase())) {
              message = args.join(" ");
            } else {
              audience = args[0].toUpperCase();
              message = args.slice(1).join(" ");
            }

            if (!message) return;
            const players = Object.values(playerCache.list());

            switch (audience) {
              case "ALL": {
                players.forEach((player) => {
                  const notifyData = {
                    message: message,
                  };
                  sendPacket(player.ws, packetManager.notify(notifyData));
                });
                break;
              }
              case "ADMINS": {
                const playersInMap = filterPlayersByMap(
                  currentPlayer.location.map
                );
                const playersInMapAdmins = playersInMap.filter(
                  (p) => p.isAdmin
                );
                playersInMapAdmins.forEach((player) => {
                  const notifyData = {
                    message: message,
                  };
                  sendPacket(player.ws, packetManager.notify(notifyData));
                });
                break;
              }
              case "MAP": {
                const playersInMap = filterPlayersByMap(
                  currentPlayer.location.map
                );
                playersInMap.forEach((player) => {
                  const notifyData = {
                    message: message,
                  };
                  sendPacket(player.ws, packetManager.notify(notifyData));
                });
                break;
              }
            }
            break;
          }
          // Ban a player
          case "BAN": {
            // admin.ban or admin.*
            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.ban" || p === "admin.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }
            const identifier = args[0].toLowerCase() || null;
            if (!identifier) {
              const notifyData = {
                message: "Please provide a username or ID",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            // Find player by ID or username in cache first
            let targetPlayer;
            if (isNaN(Number(identifier))) {
              // Search by username
              const players = Object.values(playerCache.list());
              targetPlayer = players.find(
                (p) => p.username.toLowerCase() === identifier.toLowerCase()
              );
            } else {
              // Search by ID
              targetPlayer = playerCache.get(identifier);
            }

            // If not found in cache, check database
            if (!targetPlayer) {
              const dbPlayer = (await player.findPlayerInDatabase(
                identifier
              )) as { username: string; banned: number }[];
              targetPlayer = dbPlayer.length > 0 ? dbPlayer[0] : null;
            }

            if (!targetPlayer) {
              const notifyData = {
                message: "Player not found",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            // Prevent banning yourself
            if (targetPlayer.id === currentPlayer.id) {
              const notifyData = {
                message: "You cannot ban yourself",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            // Prevent banning admins
            if (targetPlayer.isAdmin) {
              const notifyData = {
                message: "You cannot ban other admins",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            // Check if the player is already banned
            if (targetPlayer.banned) {
              const notifyData = {
                message: `${targetPlayer.username.charAt(0).toUpperCase() +
                  targetPlayer.username.slice(1)
                  } is already banned`,
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            // Ban the player
            await player.ban(targetPlayer.username, targetPlayer.ws);
            const notifyData = {
              message: `Banned ${targetPlayer.username.charAt(0).toUpperCase() +
                targetPlayer.username.slice(1)
                } from the server`,
            };
            sendPacket(ws, packetManager.notify(notifyData));
            break;
          }
          case "UNBAN": {
            // admin.unban or admin.*
            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.unban" || p === "admin.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }
            const identifier = args[0] || null;
            if (!identifier) {
              const notifyData = {
                message: "Please provide a username or ID",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            const targetPlayer = (await player.findPlayerInDatabase(
              identifier
            )) as { username: string; banned: number }[] as any[];
            if (!targetPlayer) {
              const notifyData = {
                message: "Player not found or is not online",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            // Prevent unbanning yourself
            if (targetPlayer[0].id === currentPlayer.id) {
              const notifyData = {
                message: "You cannot unban yourself",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            // Unban the player
            await player.unban(targetPlayer[0].username);
            const notifyData = {
              message: `Unbanned ${targetPlayer[0].username} from the server`,
            };
            sendPacket(ws, packetManager.notify(notifyData));
            break;
          }
          // Toggle admin status
          case "ADMIN":
          case "SETADMIN": {
            // server.admin or server.*
            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "server.admin" || p === "server.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }
            const identifier = args[0].toLowerCase() || null;
            if (!identifier) {
              const notifyData = {
                message: "Please provide a username or ID",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            // Find player by ID or username in cache first
            let targetPlayer;
            if (isNaN(Number(identifier))) {
              // Search by username
              const players = Object.values(playerCache.list());
              targetPlayer = players.find(
                (p) => p.username.toLowerCase() === identifier.toLowerCase()
              );
            } else {
              // Search by ID
              targetPlayer = playerCache.get(identifier);
            }

            // If not found in cache, check database
            if (!targetPlayer) {
              const dbPlayer = (await player.findPlayerInDatabase(
                identifier
              )) as { username: string; banned: number }[];
              targetPlayer = dbPlayer.length > 0 ? dbPlayer[0] : null;
            }

            // Prevent toggling your own admin status
            if (targetPlayer?.id === currentPlayer.id) {
              const notifyData = {
                message: "You cannot toggle your own admin status",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            // Toggle admin status
            const admin = await player.toggleAdmin(targetPlayer.username);
            // Update player cache if the player is in the cache
            if (targetPlayer) {
              targetPlayer.isAdmin = admin;
              playerCache.set(targetPlayer.id, targetPlayer);
            }
            const notifyData = {
              message: `${targetPlayer.username.charAt(0).toUpperCase() +
                targetPlayer.username.slice(1)
                } is now ${admin ? "an admin" : "not an admin"}`,
            };
            // Reconnect the player if they are in the cache
            if (targetPlayer?.ws) {
              sendPacket(targetPlayer.ws, packetManager.reconnect());
            }
            sendPacket(ws, packetManager.notify(notifyData));
            break;
          }
          // Shutdown the server
          case "SHUTDOWN": {
            // server.shutdown or server.*
            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "server.shutdown" || p === "server.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }
            const players = Object.values(playerCache.list());
            players.forEach((player) => {
              const notifyData = {
                message:
                  "⚠️ Server shutting down - please reconnect in a few minutes ⚠️",
              };
              sendPacket(player.ws, packetManager.notify(notifyData));
            });

            // Wait for 5 seconds
            await new Promise((resolve) => setTimeout(resolve, 5000));
            players.forEach((player) => {
              player.ws.close(1000, "Server is restarting");
            });
            // Keep checking until all players are disconnected
            const checkInterval = setInterval(async () => {
              const remainingPlayers = Object.values(playerCache.list());
              remainingPlayers.forEach((player) => {
                player.ws.close(1000, "Server is restarting");
              });

              if (remainingPlayers.length === 0) {
                clearInterval(checkInterval);
                await player.clear();
                Bun.spawn(["bun", "transpile-production"]);
              }
            }, 100);
            break;
          }
          // Toggle tile editor
          case "TE":
          case "TILEEDITOR": {
            // server.admin or server.*
            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "server.admin" || p === "server.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            // Send command to toggle editor
            sendPacket(ws, packetManager.toggleTileEditor());
            break;
          }
          // Restart the server
          case "RESTART": {
            // server.restart or server.*
            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "server.restart" || p === "server.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            // Check if restart is already scheduled
            if (restartScheduled) {
              restartTimers.forEach((timer) => clearTimeout(timer));
              restartTimers = [];
              restartScheduled = false;

              const players = Object.values(playerCache.list());
              players.forEach((player) => {
                const notifyData = {
                  message: "⚠️ Server restart has been aborted ⚠️",
                };
                sendPacket(player.ws, packetManager.notify(notifyData));
              });
              break;
            }

            // Set restart flag
            restartScheduled = true;
            restartTimers = [];

            const minutes = 15;
            const RESTART_DELAY = minutes * 60000;
            const totalMinutes = Math.floor(RESTART_DELAY / 60000);

            const minuteIntervals = Array.from(
              { length: totalMinutes },
              (_, i) => totalMinutes - i
            );
            const secondIntervals = Array.from(
              { length: 30 },
              (_, i) => 30 - i
            );

            // Minute notifications
            minuteIntervals.forEach((minutes) => {
              restartTimers.push(
                setTimeout(() => {
                  const players = Object.values(playerCache.list());
                  players.forEach((player) => {
                    const notifyData = {
                      message: `⚠️ Server restarting in ${minutes} minute${minutes === 1 ? "" : "s"
                        } ⚠️`,
                    };
                    sendPacket(player.ws, packetManager.notify(notifyData));
                  });
                }, RESTART_DELAY - minutes * 60 * 1000)
              );
            });

            // Second notifications
            secondIntervals.forEach((seconds) => {
              restartTimers.push(
                setTimeout(() => {
                  const players = Object.values(playerCache.list());
                  players.forEach((player) => {
                    const notifyData = {
                      message: `⚠️ Server restarting in ${seconds} second${seconds === 1 ? "" : "s"
                        } ⚠️`,
                    };
                    sendPacket(player.ws, packetManager.notify(notifyData));
                  });
                }, RESTART_DELAY - seconds * 1000)
              );
            });

            // Final exit timeout
            restartTimers.push(
              setTimeout(() => {
                const players = Object.values(playerCache.list());
                players.forEach((player) => {
                  player.ws.close(1000, "Server is restarting");
                });
                // Keep checking until all players are disconnected
                const checkInterval = setInterval(async () => {
                  const remainingPlayers = Object.values(playerCache.list());
                  remainingPlayers.forEach((player) => {
                    player.ws.close(1000, "Server is restarting");
                  });

                  if (remainingPlayers.length === 0) {
                    clearInterval(checkInterval);
                    await player.clear();
                    Bun.spawn(["bun", "transpile-production"]);
                  }
                }, 100);
              }, RESTART_DELAY)
            );
            break;
          }
          // Respawn player by username or ID
          case "RESPAWN": {
            // admin.respawn or admin.*
            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.respawn" || p === "admin.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            let targetPlayer;
            const identifier = args[0].toLowerCase() || null;

            if (!identifier) {
              targetPlayer = currentPlayer;
            } else {
              // Find player by ID or username in cache first
              const players = Object.values(playerCache.list());
              if (isNaN(Number(identifier))) {
                // Search by username
                targetPlayer = players.find(
                  (p) => p.username.toLowerCase() === identifier.toLowerCase()
                );
              } else {
                // Search by ID
                targetPlayer = playerCache.get(identifier);
              }

              // If not found in cache, check database
              if (!targetPlayer) {
                const dbPlayer = (await player.findPlayerInDatabase(
                  identifier
                )) as { username: string }[];
                targetPlayer = dbPlayer.length > 0 ? dbPlayer[0] : null;
              }

              if (!targetPlayer) {
                const notifyData = {
                  message: "Player not found",
                };
                sendPacket(ws, packetManager.notify(notifyData));
                break;
              }
            }

            // Respawn the player
            // Calculate center of map for spawn position
            const defaultMapProps = mapPropertiesCache.find(
              (m: any) => m.name === `${defaultMap}.json`
            );
            const centerX = defaultMapProps
              ? (defaultMapProps.width * defaultMapProps.tileWidth) / 2
              : 0;
            const centerY = defaultMapProps
              ? (defaultMapProps.height * defaultMapProps.tileHeight) / 2
              : 0;

            await player.setLocation(targetPlayer.username, `${defaultMap}`, {
              x: centerX,
              y: centerY,
              direction: "down",
            });

            // Update cache if player is online
            if (playerCache.get(targetPlayer.id)) {
              targetPlayer.location.position = {
                x: centerX,
                y: centerY,
                direction: "down",
              };
              playerCache.set(targetPlayer.id, targetPlayer);
              const playersInMap = filterPlayersByMap(
                targetPlayer.location.map
              );
              globalStateRevision++;
              playersInMap.forEach((player) => {
                const moveData = {
                  id: targetPlayer.id,
                  _data: targetPlayer.location.position,
                  revision: globalStateRevision
                };
                sendPacket(player.ws, packetManager.moveXY(moveData));
              });
            }

            const notifyData = {
              message: `Respawned ${targetPlayer.username.charAt(0).toUpperCase() +
                targetPlayer.username.slice(1)
                }`,
            };
            sendPacket(ws, packetManager.notify(notifyData));
            break;
          }
          // Update permissions for a player
          case "PERMISSION":
          case "PERMISSIONS": {
            // admin.permission or admin.*
            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.permission" || p === "admin.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }
            const mode = args[0]?.toUpperCase() || null;
            if (!mode) {
              const notifyData = {
                message: "Please provide a mode",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            if (
              mode !== "ADD" &&
              mode !== "REMOVE" &&
              mode !== "SET" &&
              mode !== "CLEAR" &&
              mode !== "LIST"
            ) {
              const notifyData = {
                message: "Invalid mode",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            let targetPlayer;
            const identifier = args[1]?.toLowerCase() || null;
            if (!identifier) {
              const notifyData = {
                message: "Please provide a username or ID",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            // Find player by ID or username in cache first
            const players = Object.values(playerCache.list());
            if (isNaN(Number(identifier))) {
              // Search by username
              targetPlayer = players.find(
                (p) => p.username.toLowerCase() === identifier.toLowerCase()
              );
            } else {
              // Search by ID
              targetPlayer = playerCache.get(identifier);
            }

            // If not found in cache, check database
            if (!targetPlayer) {
              const dbPlayer = (await player.findPlayerInDatabase(
                identifier
              )) as { username: string }[];
              targetPlayer = dbPlayer.length > 0 ? dbPlayer[0] : null;
            }

            if (!targetPlayer) {
              const notifyData = {
                message: "Player not found",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            // Permissions is what ever is after the mode unless it's clear or list
            let access;
            let permissionsArray;
            if (mode !== "CLEAR" && mode !== "LIST") {
              access = args.slice(2).join(" ");
              // Check if each permission is valid
              const validPermissions = await permissions.list();
              // Ensure permissions is split by commas
              permissionsArray = access.split(",");
              permissionsArray.forEach((permission: string) => {
                if (!validPermissions.includes(permission)) {
                  const notifyData = {
                    message: `Invalid permission: ${permission}`,
                  };
                  sendPacket(ws, packetManager.notify(notifyData));
                  return;
                }
              });
            }

            switch (mode) {
              case "ADD": {
                if (
                  !currentPlayer.permissions.some(
                    (p: string) =>
                      p === "permission.add" || p === "permission.*"
                  )
                ) {
                  // Prevent setting permissions for yourself
                  if (targetPlayer?.id === currentPlayer.id) {
                    const notifyData = {
                      message: "You cannot set permissions for yourself",
                    };
                    sendPacket(ws, packetManager.notify(notifyData));
                    break;
                  }
                  const notifyData = {
                    message: "Invalid command",
                  };
                  sendPacket(ws, packetManager.notify(notifyData));
                  break;
                }
                await permissions.add(targetPlayer.username, permissionsArray);
                // Update the player cache
                if (targetPlayer.ws) {
                  targetPlayer.permissions = permissionsArray;
                  playerCache.set(targetPlayer.id, targetPlayer);
                }
                const notifyData = {
                  message: `Permissions \`${permissionsArray.join(
                    ", "
                  )}\` added to ${targetPlayer.username.charAt(0).toUpperCase() +
                  targetPlayer.username.slice(1)
                    }`,
                };
                sendPacket(ws, packetManager.notify(notifyData));
                break;
              }
              case "REMOVE": {
                if (
                  !currentPlayer.permissions.some(
                    (p: string) =>
                      p === "permission.remove" || p === "permission.*"
                  )
                ) {
                  // Prevent setting permissions for yourself
                  if (targetPlayer?.id === currentPlayer.id) {
                    const notifyData = {
                      message: "You cannot set permissions for yourself",
                    };
                    sendPacket(ws, packetManager.notify(notifyData));
                    break;
                  }
                  const notifyData = {
                    message: "Invalid command",
                  };
                  sendPacket(ws, packetManager.notify(notifyData));
                  break;
                }
                await permissions.remove(
                  targetPlayer.username,
                  permissionsArray
                );
                // Update the player cache
                if (targetPlayer.ws) {
                  targetPlayer.permissions = permissionsArray;
                  playerCache.set(targetPlayer.id, targetPlayer);
                }
                const notifyData = {
                  message: `Permissions removed from ${targetPlayer.username.charAt(0).toUpperCase() +
                    targetPlayer.username.slice(1)
                    }`,
                };
                sendPacket(ws, packetManager.notify(notifyData));
                break;
              }
              case "SET": {
                if (
                  !currentPlayer.permissions.some(
                    (p: string) =>
                      p === "permission.add" || p === "permission.*"
                  )
                ) {
                  // Prevent setting permissions for yourself
                  if (targetPlayer?.id === currentPlayer.id) {
                    const notifyData = {
                      message: "You cannot set permissions for yourself",
                    };
                    sendPacket(ws, packetManager.notify(notifyData));
                    break;
                  }
                  const notifyData = {
                    message: "Invalid command",
                  };
                  sendPacket(ws, packetManager.notify(notifyData));
                  break;
                }
                await permissions.set(targetPlayer.username, permissionsArray);
                // Update the player cache
                if (targetPlayer.ws) {
                  targetPlayer.permissions = permissionsArray;
                  playerCache.set(targetPlayer.id, targetPlayer);
                }
                const notifyData = {
                  message: `Permissions set for ${targetPlayer.username.charAt(0).toUpperCase() +
                    targetPlayer.username.slice(1)
                    }`,
                };
                sendPacket(ws, packetManager.notify(notifyData));
                break;
              }
              case "CLEAR": {
                if (
                  !currentPlayer.permissions.some(
                    (p: string) =>
                      p === "permission.remove" || p === "permission.*"
                  )
                ) {
                  // Prevent setting permissions for yourself
                  if (targetPlayer?.id === currentPlayer.id) {
                    const notifyData = {
                      message: "You cannot set permissions for yourself",
                    };
                    sendPacket(ws, packetManager.notify(notifyData));
                    break;
                  }
                  const notifyData = {
                    message: "Invalid command",
                  };
                  sendPacket(ws, packetManager.notify(notifyData));
                  break;
                }
                await permissions.clear(targetPlayer.username);
                // Update the player cache
                targetPlayer.permissions = [];
                const p = playerCache.get(targetPlayer.id);
                if (p.ws) {
                  playerCache.set(targetPlayer.id, targetPlayer);
                }
                const notifyData = {
                  message: `Permissions cleared for ${targetPlayer.username.charAt(0).toUpperCase() +
                    targetPlayer.username.slice(1)
                    }`,
                };
                sendPacket(ws, packetManager.notify(notifyData));
                break;
              }
              case "LIST": {
                if (
                  !currentPlayer.permissions.some(
                    (p: string) =>
                      p === "permission.list" || p === "permission.*"
                  )
                ) {
                  const notifyData = {
                    message: "Invalid command",
                  };
                  sendPacket(ws, packetManager.notify(notifyData));
                  break;
                }
                const response =
                  ((await permissions.get(targetPlayer.username)) as string) ||
                  "No permissions found";
                const notifyData = {
                  message: `Permissions for ${targetPlayer.username.charAt(0).toUpperCase() +
                    targetPlayer.username.slice(1)
                    }: ${response.replaceAll(",", ", ")}`,
                };
                sendPacket(ws, packetManager.notify(notifyData));
                break;
              }
            }
            break;
          }
          case "RELOADMAP": {
            // admin.reloadmap or admin.*
            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.reloadmap" || p === "admin.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }
            const mapName = args[0]?.toLowerCase() || null;
            if (!mapName) {
              const notifyData = {
                message: "Please provide a map name",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            // Check if the map exists
            const map = (maps as any[]).find(
              (m) => m.name === `${mapName}.json`
            );
            if (!map) {
              const notifyData = {
                message: `Map ${mapName} not found`,
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            const result = (await reloadMap(mapName)) as MapData | null;
            if (result) {
              const notifyData = {
                message: `Map ${mapName} reloaded successfully`,
              };
              sendPacket(ws, packetManager.notify(notifyData));

              map.compressed = result.compressed;
              map.data = result.data;

              const playersInMap = filterPlayersByMap(
                currentPlayer.location.map
              );
              playersInMap.forEach((player) => {
                const mapData = [
                  result?.compressed,
                  player.location.map,
                  player.location.position?.x || 0,
                  player.location.position?.y || 0,
                  player.location.position?.direction || "down",
                  player.location.position?.moving || false,
                ];
                sendPacket(player.ws, packetManager.loadMap(mapData));
              });
            } else {
              log.error(`Failed to reload map ${mapName}`);
              const notifyData = {
                message: `Failed to reload map ${mapName}`,
              };
              sendPacket(ws, packetManager.notify(notifyData));
            }
            break;
          }
          case "WARP": {
            // Warp to another map
            // admin.warp or admin.*
            if (
              !currentPlayer.permissions.some(
                (p: string) => p === "admin.warp" || p === "admin.*"
              )
            ) {
              const notifyData = {
                message: "You don't have permission to use this command",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }
            const currentMapName = currentPlayer.location.map;

            const mapName = args[0]?.toLowerCase() || null;
            if (!mapName) {
              const notifyData = {
                message: "Please provide a map name",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            if (mapName === currentMapName) {
              const notifyData = {
                message: "You are already in this map",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            const map = (maps as any[]).find(
              (map: MapData) => map.name === `${mapName}.json`
            );

            if (!map) {
              const notifyData = {
                message: "Map not found",
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            const identifier = args[1]?.toLowerCase() || null;
            // If no identifier is provided, warp the current player
            if (!identifier) {
              // Calculate center of map for spawn position
              // Player coordinates are now centered on the sprite
              const mapProps = mapPropertiesCache.find((m: any) => m.name === `${mapName}.json`);
              const centerX = mapProps
                ? (mapProps.width * mapProps.tileWidth) / 2
                : 0;
              const centerY = mapProps
                ? (mapProps.height * mapProps.tileHeight) / 2
                : 0;

              // Warp the current player
              const result = await player.setLocation(
                currentPlayer.id,
                mapName,
                {
                  x: centerX,
                  y: centerY,
                  direction: currentPlayer.location.position?.direction || "down",
                }
              );
              // Check affected rows only if result is an object with affectedRows property
              if (
                result &&
                typeof result === "object" &&
                "affectedRows" in result &&
                (result as { affectedRows: number }).affectedRows != 0
              ) {
                currentPlayer.location = {
                  map: mapName,
                  x: centerX,
                  y: centerY,
                  direction: currentPlayer.location.position?.direction || "down",
                };

                sendPacket(ws, packetManager.reconnect());
              } else {
                const notifyData = {
                  message: "Failed to update location",
                };
                sendPacket(ws, packetManager.notify(notifyData));
              }
              break;
            }

            break;
          }
          default: {
            const notifyData = {
              message: "Invalid command",
            };
            sendPacket(ws, packetManager.notify(notifyData));
            break;
          }
        }
        break;
      }
      case "KICK_PARTY_MEMBER": {
        if (!currentPlayer) return;
        // Get the player's party ID
        const partyId = await parties.getPartyId(currentPlayer.username);
        if (!partyId) {
          sendPacket(
            ws,
            packetManager.notify({ message: "You are not in a party" })
          );
          return;
        }

        const isLeader = await parties.isPartyLeader(currentPlayer.username);
        if (!isLeader) {
          sendPacket(
            ws,
            packetManager.notify({ message: "You are not the party leader" })
          );
          return;
        }

        const member = (data as any)?.username;
        if (!member) {
          sendPacket(
            ws,
            packetManager.notify({ message: "Please provide a username" })
          );
          return;
        }

        // Check if the member is in the party
        const members = await parties.getPartyMembers(partyId);
        if (!members || members?.length === 0) {
          sendPacket(
            ws,
            packetManager.notify({ message: "You are not in a party" })
          );
          return;
        }

        if (!members.includes(member)) {
          sendPacket(
            ws,
            packetManager.notify({
              message: `${member.charAt(0).toUpperCase() + member.slice(1)
                } is not in your party`,
            })
          );
          return;
        }

        // Kick the member from the party
        const result = await parties.remove(member);

        if (typeof result === "boolean" && !result) {
          sendPacket(
            ws,
            packetManager.notify({
              message: `Failed to kick ${member.charAt(0).toUpperCase() + member.slice(1)
                } from the party`,
            })
          );
          return;
        }

        if (typeof result === "boolean" && result) {
          // Party was disbanded
          members.forEach(async (m: string) => {
            const session_id = await player.getSessionIdByUsername(m);
            const p = session_id && playerCache.get(session_id);
            if (p) {
              sendPacket(p.ws, packetManager.updateParty({ members: [] }));
              sendPacket(
                p.ws,
                packetManager.notify({
                  message: "The party has been disbanded",
                })
              );
              p.party = [];
              playerCache.set(p.id, p);
            }
          });
          return;
        }

        if (Array.isArray(result) && result.length > 0) {
          sendPacket(
            ws,
            packetManager.notify({
              message: `${member.charAt(0).toUpperCase() + member.slice(1)
                } has been kicked from the party`,
            })
          );
          currentPlayer.party = [];
          playerCache.set(currentPlayer.id, currentPlayer);
          sendPacket(ws, packetManager.updateParty({ members: [] }));

          // Send the updated party members to all party members
          result.forEach(async (m: string) => {
            const session_id = await player.getSessionIdByUsername(m);
            const p = session_id && playerCache.get(session_id);
            if (p) {
              if (m !== member) {
                sendPacket(
                  p.ws,
                  packetManager.updateParty({ members: result })
                );
                sendPacket(
                  p.ws,
                  packetManager.notify({
                    message: `${currentPlayer.username.charAt(0).toUpperCase() +
                      currentPlayer.username.slice(1)
                      } has kicked ${member.charAt(0).toUpperCase() + member.slice(1)
                      } from the party`,
                  })
                );
                p.party = result;
              } else {
                sendPacket(p.ws, packetManager.updateParty({ members: [] }));
                sendPacket(
                  p.ws,
                  packetManager.notify({
                    message: `You have been kicked from the party`,
                  })
                );
                p.party = [];
              }
              playerCache.set(p.id, p);
            }
          });
        }

        break;
      }
      case "LEAVE_PARTY": {
        if (!currentPlayer) return;
        // Get the player's party ID
        const partyId = await parties.getPartyId(currentPlayer.username);
        if (!partyId) {
          sendPacket(
            ws,
            packetManager.notify({ message: "You are not in a party" })
          );
          return;
        }

        const members = await parties.getPartyMembers(partyId);
        if (!members || members?.length === 0) {
          sendPacket(
            ws,
            packetManager.notify({ message: "You are not in a party" })
          );
          return;
        }

        const result = await parties.leave(currentPlayer.username);

        const type = typeof result;
        if (type === "boolean" && !result) {
          sendPacket(
            ws,
            packetManager.notify({ message: "Failed to leave party" })
          );
          return;
        }

        // Party was deleted
        if (type === "boolean" && result) {
          members.forEach(async (member: string) => {
            const session_id = await player.getSessionIdByUsername(member);
            const p = session_id && playerCache.get(session_id);
            if (p) {
              sendPacket(p.ws, packetManager.updateParty({ members: [] }));
              sendPacket(
                p.ws,
                packetManager.notify({
                  message: "The party has been disbanded",
                })
              );
              p.party = [];
              playerCache.set(p.id, p);
            }
          });
          return;
        }

        if (type === "object" && (result as string[]).length > 0) {
          sendPacket(
            ws,
            packetManager.notify({ message: "You have left the party" })
          );
          currentPlayer.party = [];
          playerCache.set(currentPlayer.id, currentPlayer);
          sendPacket(ws, packetManager.updateParty({ members: [] }));

          // Send the updated party members to all party members
          (result as string[]).forEach(async (member: string) => {
            const session_id = await player.getSessionIdByUsername(member);
            const p = session_id && playerCache.get(session_id);
            if (p) {
              sendPacket(p.ws, packetManager.updateParty({ members: result }));
              sendPacket(
                p.ws,
                packetManager.notify({
                  message: `${currentPlayer.username.charAt(0).toUpperCase() +
                    currentPlayer.username.slice(1)
                    } has left the party`,
                })
              );
              p.party = result;
              playerCache.set(p.id, p);
            }
          });
        }
        break;
      }
      case "INVITE_PARTY": {
        const invited_user = (data as any).id;
        const invitedUser = playerCache.get(invited_user);
        const invitedUserUsername = invitedUser?.username || invited_user;
        if (!currentPlayer || !invited_user || !invitedUserUsername) return;

        if (currentPlayer.isGuest) {
          sendPacket(
            ws,
            packetManager.notify({
              message: "Please create an account to use that feature.",
            })
          );
          return;
        }

        if (invitedUser.isGuest) {
          sendPacket(
            ws,
            packetManager.notify({
              message: `${invitedUserUsername.charAt(0).toUpperCase() +
                invitedUserUsername.slice(1)
                } is a guest and cannot be invited to a party.`,
            })
          );
          return;
        }

        // Get the leaders party ID
        const partyId = await parties.getPartyId(currentPlayer.username);
        if (partyId) {
          // Check if they are the leader
          const isLeader = await parties.isPartyLeader(currentPlayer.username);
          if (!isLeader) {
            sendPacket(
              ws,
              packetManager.notify({ message: "You are not the party leader" })
            );
            return;
          }
        }

        // Check if the invited user is already in a party
        const invitedUserPartyId = await parties.getPartyId(
          invitedUserUsername
        );

        if (invitedUserPartyId) {
          sendPacket(
            ws,
            packetManager.notify({
              message: `${invitedUserUsername.charAt(0).toUpperCase() +
                invitedUserUsername.slice(1)
                } is already in a party`,
            })
          );
          return;
        }

        // Check if the invited user is a party leader
        const invitedUserLeader = await parties.isPartyLeader(
          invitedUserUsername
        );
        if (invitedUserLeader) {
          sendPacket(
            ws,
            packetManager.notify({
              message: `${invitedUserUsername.charAt(0).toUpperCase() +
                invitedUserUsername.slice(1)
                } is already in a party`,
            })
          );
          return;
        }

        const player_username =
          currentPlayer.username.charAt(0).toUpperCase() +
          currentPlayer.username.slice(1);

        const invite_data = {
          action: "INVITE_PARTY",
          message: `${player_username} wants to invite you to their party`,
          originator: currentPlayer.id.toString(),
          authorization: randomBytes(16).toString(),
        };

        if (!invitedUser) {
          sendPacket(
            ws,
            packetManager.notify({
              message: `${invitedUserUsername.charAt(0).toUpperCase() +
                invitedUserUsername.slice(1)
                } is not online`,
            })
          );
          return;
        }

        currentPlayer.invitations.push({
          action: invite_data.action,
          originator: invite_data.originator,
          authorization: invite_data.authorization,
        });

        playerCache.set(currentPlayer.id, currentPlayer);
        // Send the invitation notification to the invited user
        sendPacket(invitedUser.ws, packetManager.invitation(invite_data));
        sendPacket(
          ws,
          packetManager.notify({
            message: `Invitation sent to ${invitedUserUsername.charAt(0).toUpperCase() +
              invitedUserUsername.slice(1)
              }`,
          })
        );
        break;
      }
      case "ADD_FRIEND": {
        const id = (data as any).id;
        if (!id) return;

        if (!currentPlayer) return;

        if (currentPlayer.isGuest) {
          sendPacket(
            ws,
            packetManager.notify({
              message: "Please create an account to use that feature.",
            })
          );
          return;
        }

        // Uppercase the first letter of the username
        const player_username =
          currentPlayer.username.charAt(0).toUpperCase() +
          currentPlayer.username.slice(1);

        const get_friend = playerCache.get(id);
        if (!get_friend) return;

        if (get_friend.isGuest) {
          sendPacket(
            ws,
            packetManager.notify({
              message: `${get_friend.username.charAt(0).toUpperCase() +
                get_friend.username.slice(1)
                } is a guest and cannot be added as a friend.`,
            })
          );
          return;
        }

        const invite_data = {
          action: "FRIEND_REQUEST",
          message: `${player_username} wants to add you as a friend`,
          originator: currentPlayer.id.toString(),
          authorization: randomBytes(16).toString(),
        };

        // Add the invitation to the player's invitations
        // This is used for authentication and verification for the friend request so that we can't force add friends
        currentPlayer.invitations.push({
          action: invite_data.action,
          originator: invite_data.originator,
          authorization: invite_data.authorization,
        });

        playerCache.set(currentPlayer.id, currentPlayer);

        // Send the invitation notification to the friend
        sendPacket(get_friend.ws, packetManager.invitation(invite_data));
        break;
      }
      case "INVITATION_RESPONSE": {
        const { action, originator, authorization, response } = data as any;
        if (!action || !originator || !authorization || !response) return;

        log.info(
          `Invitation response received: ${action}, ${originator}, ${authorization}, ${response}`
        );
        // Find the current player in the cache
        const inviter = playerCache.get(originator);

        if (!inviter) {
          // If the inviter is not found, we can't process the invitation because they might have disconnected
          sendPacket(
            ws,
            packetManager.notify({
              message:
                "Unable to process invitation - user not found or has disconnected",
            })
          );
          return;
        }

        // Find the invitation in the inviter's invitations
        const inviteIndex = inviter.invitations.findIndex(
          (invite: any) =>
            invite.action === action &&
            invite.originator === originator &&
            invite.authorization === authorization
        );

        // If we found the invitation, we can process it
        if (inviteIndex === -1) {
          // If the invitation is not found, we can't process it
          const notifyData = {
            message: "Invitation not found or has already been processed",
          };
          sendPacket(ws, packetManager.notify(notifyData));
          return;
        }

        // Remove the invitation from the inviter's invitations
        inviter.invitations.splice(inviteIndex, 1);
        playerCache.set(inviter.id, inviter);

        switch (action.toUpperCase()) {
          // Process friend request
          case "FRIEND_REQUEST": {
            if (response.toUpperCase() === "ACCEPT") {
              /* Windows mysql bug */
              // If the response is accept, we need to add each other as friends
              const updatedCurrentPlayersFriendsList = await friends.add(
                currentPlayer.username.toLowerCase(),
                inviter.username.toLowerCase()
              );

              // Add the inviter to the current player's friends list as well
              // This is done so that both players can see each other as friends
              const updatedFriendsList = await friends.add(
                inviter.username.toLowerCase(),
                currentPlayer.username.toLowerCase()
              );

              sendPacket(
                ws,
                packetManager.notify({
                  message: `You are now friends with ${inviter.username.charAt(0).toUpperCase() +
                    inviter.username.slice(1)
                    }`,
                })
              );
              sendPacket(
                ws,
                packetManager.updateFriends({
                  friends: updatedCurrentPlayersFriendsList,
                })
              );

              sendPacket(
                inviter.ws,
                packetManager.notify({
                  message: `You are now friends with ${currentPlayer.username.charAt(0).toUpperCase() +
                    currentPlayer.username.slice(1)
                    }`,
                })
              );

              sendPacket(
                inviter.ws,
                packetManager.updateFriends({ friends: updatedFriendsList })
              );
            }
            break;
          }
          case "INVITE_PARTY": {
            // Check if the the party exists
            const partyId = await parties.getPartyId(inviter.username);
            if (response.toUpperCase() === "ACCEPT") {
              // Party already exists, add the player to the party
              if (partyId) {
                // If the party exists, add the player to the party
                const updatedPartyMembers = await parties.add(
                  currentPlayer.username.toLowerCase(),
                  partyId
                );
                if (!updatedPartyMembers) {
                  sendPacket(
                    ws,
                    packetManager.notify({ message: "Failed to join party" })
                  );
                  return;
                }
                sendPacket(
                  ws,
                  packetManager.notify({
                    message: `You have joined ${inviter.username.charAt(0).toUpperCase() +
                      inviter.username.slice(1)
                      }'s party`,
                  })
                );
                sendPacket(
                  inviter.ws,
                  packetManager.notify({
                    message: `${currentPlayer.username.charAt(0).toUpperCase() +
                      currentPlayer.username.slice(1)
                      } has joined your party`,
                  })
                );
                // Send the updated party members to all party members
                updatedPartyMembers.forEach(async (member: string) => {
                  const session_id = await player.getSessionIdByUsername(
                    member
                  );
                  const p = session_id && playerCache.get(session_id);
                  if (p) {
                    sendPacket(
                      p.ws,
                      packetManager.updateParty({
                        members: updatedPartyMembers,
                      })
                    );
                    p.party = updatedPartyMembers;
                    playerCache.set(p.id, p);
                  }
                });
              } else {
                // If the party does not exist, create a new one
                const updatedPartyMembers = await parties.create(
                  inviter.username.toLowerCase(),
                  currentPlayer.username.toLowerCase()
                );
                if (!updatedPartyMembers) {
                  sendPacket(
                    ws,
                    packetManager.notify({ message: "Failed to create party" })
                  );
                  return;
                }
                sendPacket(
                  ws,
                  packetManager.notify({
                    message: `You have joined ${inviter.username.charAt(0).toUpperCase() +
                      inviter.username.slice(1)
                      }'s party`,
                  })
                );
                sendPacket(
                  inviter.ws,
                  packetManager.notify({
                    message: `${currentPlayer.username.charAt(0).toUpperCase() +
                      currentPlayer.username.slice(1)
                      } has joined your party`,
                  })
                );
                sendPacket(
                  inviter.ws,
                  packetManager.updateParty({ members: updatedPartyMembers })
                );
                sendPacket(
                  ws,
                  packetManager.updateParty({ members: updatedPartyMembers })
                );
                (updatedPartyMembers as string[]).forEach(
                  async (member: string) => {
                    const session_id = await player.getSessionIdByUsername(
                      member
                    );
                    const p = session_id && playerCache.get(session_id);
                    if (p) {
                      sendPacket(
                        p.ws,
                        packetManager.updateParty({
                          members: updatedPartyMembers,
                        })
                      );
                      p.party = updatedPartyMembers;
                      playerCache.set(p.id, p);
                    }
                  }
                );
              }
            }
            break;
          }
        }
        break;
      }
      case "REMOVE_FRIEND": {
        const id = (data as any).id;
        const username = (data as any).username;

        if (!currentPlayer) return;
        // Only fetch from cache if ID is provided, otherwise use username
        let get_friend;
        if (id) {
          get_friend = playerCache.get(id);
        } else if (username) {
          // Try to find in cache by username (case-insensitive)
          get_friend = Object.values(playerCache.list()).find(
            (p: any) => p.username.toLowerCase() === username.toLowerCase()
          );
          // If not found in cache, fallback to database
          if (!get_friend) {
            get_friend = await player.findPlayerInDatabase(username);
            // If database returns array, get the first result
            if (Array.isArray(get_friend) && get_friend.length > 0) {
              get_friend = get_friend[0];
            }
          }
        }

        // Remove the friend from the current player's friends list
        const updatedFriendsList = await friends.remove(
          currentPlayer.username.toLowerCase(),
          get_friend?.username?.toLowerCase() || username.toLowerCase()
        );
        // Update the current player's friends list
        const updatedCurrentPlayersFriendsList = await friends.remove(
          get_friend?.username?.toLowerCase() || username.toLowerCase(),
          currentPlayer.username.toLowerCase()
        );

        // If the friend is online, notify them and update their friends list
        if (get_friend?.ws) {
          // Only send an update to the removed friend if they are online
          sendPacket(
            get_friend.ws,
            packetManager.updateFriends({
              friends: updatedCurrentPlayersFriendsList,
            })
          );
        }

        sendPacket(
          ws,
          packetManager.updateFriends({ friends: updatedFriendsList })
        );
        sendPacket(
          ws,
          packetManager.notify({
            message: `You have removed ${get_friend.username.charAt(0).toUpperCase() +
              get_friend.username.slice(1)
              } from your friends list`,
          })
        );
        break;
      }
      case "MOUNT": {
        if (!currentPlayer) return;
        const canMount = player.canMount(currentPlayer);
        const mount = (data as any).mount;
        if (!mount) {
          sendPacket(
            ws,
            packetManager.notify({ message: "No mount type specified." })
          );
          break;
        }

        if (!canMount) {
          sendPacket(
            ws,
            packetManager.notify({
              message: "Mount feature is currently locked.",
            })
          );
          break;
        }


        // Don't validate if unmounting
        if (!currentPlayer.mounted) {
          // Check if the player has the specified mount in their collection
          // Search currentPlayer.collectables for type mount where item matches the requested mount
          const hasMount = currentPlayer.collectables.some((c: any) => c.type === "mount" && c.item === mount);
          if (!hasMount) {
            sendPacket(
              ws,
              packetManager.notify({ message: "You do not have the specified mount." })
            );
            break;
          }
        }

        currentPlayer.mounted = !currentPlayer.mounted;

        if (currentPlayer.mounted) {
          currentPlayer.mount_type = mount;
        } else {
          currentPlayer.mount_type = null;
        }

        playerCache.set(currentPlayer.id, currentPlayer);

        const direction = currentPlayer.location.position?.direction || "down";
        const walking = currentPlayer.moving || false;
        const mounted = currentPlayer.mounted;

        globalStateRevision++;

        await sendPositionAnimation(
          ws,
          direction,
          walking,
          mounted,
          currentPlayer.mount_type,
          currentPlayer.id,
          globalStateRevision
        );

        // If player is currently moving, restart the movement with new speed
        if (currentPlayer.movementInterval) {
          clearInterval(currentPlayer.movementInterval);
          currentPlayer.movementInterval = null;

          // Trigger a new MOVEXY to restart movement with the correct speed
          const moveDirection = currentPlayer.location.position?.direction || "down";
          // Send MOVEXY packet internally to restart movement
          await packetReceiver(server, ws, JSON.stringify({ type: "MOVEXY", data: moveDirection }));
        }
        break;
      }
      case "EQUIP_ITEM": {
        if (!currentPlayer) return;
        const item = (data as any).item;
        const slotIndex = (data as any).slotIndex;
        if (!item) return;
        const equipmentItems = currentPlayer.inventory.filter((invItem: any) => invItem.type === "equipment");
        const foundEquipment = equipmentItems.find((invItem: any) => invItem.name.toLowerCase() === item.toLowerCase());
        const slot = foundEquipment?.equipment_slot;

        // Check level requirement
        if (foundEquipment?.level_requirement) {
          const playerLevel = currentPlayer.stats.level || 1;
          if (playerLevel < foundEquipment.level_requirement) return;
        }

        // Get the currently equipped item in this slot (if any) before replacing it
        const previouslyEquippedItem = currentPlayer.equipment[slot];

        const result = await equipment.equipItem(currentPlayer.username, slot, item);
        if (result) {
          // If there was a previously equipped item, mark it as unequipped in cache
          if (previouslyEquippedItem) {
            const previousItem = currentPlayer.inventory.find((invItem: any) => invItem.name.toLowerCase() === previouslyEquippedItem.toLowerCase());
            if (previousItem) {
              previousItem.equipped = false;
            }
          }

          // Update the players equipment in cache
          currentPlayer.equipment[slot] = item;

          // Update the equipped status in the inventory cache for the newly equipped item
          const inventoryItem = currentPlayer.inventory.find((invItem: any) => invItem.name.toLowerCase() === item.toLowerCase());
          if (inventoryItem) {
            inventoryItem.equipped = true;
          }

          // Handle inventory slot updates if slotIndex was provided
          if (slotIndex !== undefined) {
            // Reload config from database to ensure we have the latest saved configuration
            const freshConfig = await player.getConfig(currentPlayer.username);
            currentPlayer.config = freshConfig;

            // Get current inventory configuration
            const config = currentPlayer.config && currentPlayer.config.length > 0 ? currentPlayer.config[0] : null;
            // inventory_config is already an object from the database (MySQL JSON column)
            const inventoryConfig = config?.inventory_config || {};

            // Simply modify the existing configuration instead of rebuilding
            // If there was a previously equipped item, place it at the slot where the new item was
            if (previouslyEquippedItem) {
              inventoryConfig[slotIndex.toString()] = previouslyEquippedItem;
            }

            // ALWAYS remove the newly equipped item from wherever it was in the configuration
            // (since it's now equipped and shouldn't be in the inventory grid)
            for (const key in inventoryConfig) {
              if (inventoryConfig[key] && inventoryConfig[key].toLowerCase() === item.toLowerCase()) {
                delete inventoryConfig[key];
                break;
              }
            }

            // Remove null values from config to keep it sparse
            for (const key in inventoryConfig) {
              if (inventoryConfig[key] === null) {
                delete inventoryConfig[key];
              }
            }

            // Save the updated configuration
            await player.saveInventoryConfig(currentPlayer.username, inventoryConfig);

            // Reload the config from database and update player cache
            const updatedConfig = await player.getConfig(currentPlayer.username);
            currentPlayer.config = updatedConfig;
            playerCache.set(currentPlayer.id, currentPlayer);
          }

          playerCache.set(currentPlayer.id, currentPlayer);

          const stats = await player.synchronizeStats(currentPlayer.username);
          if (stats) {
            const currentHealth = currentPlayer.stats.health;
            const currentStamina = currentPlayer.stats.stamina;

            currentPlayer.stats = stats;

            // Preserve current health and stamina values, but clamp to new max values
            currentPlayer.stats.health = Math.min(currentHealth, stats.total_max_health);
            currentPlayer.stats.stamina = Math.min(currentStamina, stats.total_max_stamina);

            playerCache.set(currentPlayer.id, currentPlayer);

            sendPacket(
              ws,
              packetManager.updateStats({
                target: currentPlayer.id,
                stats: currentPlayer.stats,
              })
            );

            // Send updated stats to party members
            await sendStatsToPartyMembers(
              currentPlayer.username,
              currentPlayer.id,
              currentPlayer.stats
            );

            const playersInMap = filterPlayersByMap(currentPlayer.location.map);
            // Update equipment for all players in the same map
            playersInMap.forEach((player) => {
              sendPacket(
                player.ws,
                packetManager.updateStats({
                  target: currentPlayer.id,
                  stats: currentPlayer.stats,
                })
              );
            });

            // Send updated client config if inventory config was changed
            if (slotIndex !== undefined) {
              sendPacket(
                ws,
                packetManager.clientConfig(currentPlayer.config || [])
              );
            }

            // Reload inventory from database to get updated equipped flags
            const freshInventory = await inventory.get(currentPlayer.username);
            currentPlayer.inventory = freshInventory;
            playerCache.set(currentPlayer.id, currentPlayer);

            // Send updated inventory and equipment to player
            sendPacket(
              ws,
              packetManager.inventory(currentPlayer.inventory)
            );
            sendPacket(
              ws,
              packetManager.equipment(currentPlayer.equipment)
            );
          }
        }
        break;
      }
      case "UNEQUIP_ITEM": {
        if (!currentPlayer) return;
        const slot = (data as any).slot;
        const targetSlotIndex = (data as any).targetSlotIndex;
        if (!slot) return;

        // Get the currently equipped item in this slot
        const equippedItemName = currentPlayer.equipment[slot];
        if (!equippedItemName) return; // Nothing equipped in this slot

        const result = await equipment.unEquipItem(currentPlayer.username, slot, equippedItemName);
        if (result) {
          // Mark the item as unequipped in cache
          const inventoryItem = currentPlayer.inventory.find((invItem: any) => invItem.name.toLowerCase() === equippedItemName.toLowerCase());
          if (inventoryItem) {
            inventoryItem.equipped = false;
          }

          // Update the players equipment in cache (remove from slot)
          currentPlayer.equipment[slot] = null;

          // Handle inventory slot placement if targetSlotIndex was provided
          if (targetSlotIndex !== undefined) {
            // Reload config from database to ensure we have the latest saved configuration
            const freshConfig = await player.getConfig(currentPlayer.username);
            currentPlayer.config = freshConfig;

            // Get current inventory configuration
            const config = currentPlayer.config && currentPlayer.config.length > 0 ? currentPlayer.config[0] : null;
            // inventory_config is already an object from the database (MySQL JSON column)
            const inventoryConfig = config?.inventory_config || {};

            // Simply place the unequipped item at the target slot index
            inventoryConfig[targetSlotIndex.toString()] = equippedItemName;

            // Remove null values from config to keep it sparse
            for (const key in inventoryConfig) {
              if (inventoryConfig[key] === null) {
                delete inventoryConfig[key];
              }
            }

            // Save the updated configuration
            await player.saveInventoryConfig(currentPlayer.username, inventoryConfig);

            // Reload the config from database and update player cache
            const updatedConfig = await player.getConfig(currentPlayer.username);
            currentPlayer.config = updatedConfig;
          }

          playerCache.set(currentPlayer.id, currentPlayer);

          const stats = await player.synchronizeStats(currentPlayer.username);
          if (stats) {
            const currentHealth = currentPlayer.stats.health;
            const currentStamina = currentPlayer.stats.stamina;

            currentPlayer.stats = stats;

            // Preserve current health and stamina values, but clamp to new max values
            currentPlayer.stats.health = Math.min(currentHealth, stats.total_max_health);
            currentPlayer.stats.stamina = Math.min(currentStamina, stats.total_max_stamina);

            playerCache.set(currentPlayer.id, currentPlayer);

            sendPacket(
              ws,
              packetManager.updateStats({
                target: currentPlayer.id,
                stats: currentPlayer.stats,
              })
            );

            // Send updated stats to party members
            await sendStatsToPartyMembers(
              currentPlayer.username,
              currentPlayer.id,
              currentPlayer.stats
            );

            const playersInMap = filterPlayersByMap(currentPlayer.location.map);
            // Update equipment for all players in the same map
            playersInMap.forEach((player) => {
              sendPacket(
                player.ws,
                packetManager.updateStats({
                  target: currentPlayer.id,
                  stats: currentPlayer.stats,
                })
              );
            });

            // Send updated client config if inventory config was changed
            if (targetSlotIndex !== undefined) {
              sendPacket(
                ws,
                packetManager.clientConfig(currentPlayer.config || [])
              );
            }

            // Reload inventory from database to get updated equipped flags
            const freshInventory = await inventory.get(currentPlayer.username);
            currentPlayer.inventory = freshInventory;
            playerCache.set(currentPlayer.id, currentPlayer);

            // Send updated inventory and equipment to player
            sendPacket(
              ws,
              packetManager.inventory(currentPlayer.inventory)
            );
            sendPacket(
              ws,
              packetManager.equipment(currentPlayer.equipment)
            );
          }
        }
        break;
      }
      // Unknown packet type
      default: {
        log.error(`Unknown packet type: ${type}`);
        break;
      }
    }
  } catch (e) {
    log.error(e as string);
  }
}

// Function to filter players by map
function filterPlayersByMap(map: string) {
  const players = playerCache.list();
  return Object.values(players).filter(
    (p) =>
      p.location.map.replaceAll(".json", "") === map.replaceAll(".json", "")
  );
}

// Function to filter players by distance and map
function filterPlayersByDistance(ws: any, distance: number, map: string) {
  const players = filterPlayersByMap(map);
  const currentPlayer = playerCache.get(ws.data.id);
  return players.filter((p) => {
    const dx = p.location.position.x - currentPlayer.location.position.x;
    const dy = p.location.position.y - currentPlayer.location.position.y;
    return Math.sqrt(dx * dx + dy * dy) <= distance;
  });
}

// Try to parse the packet data
function tryParsePacket(data: any) {
  try {
    return JSON.parse(data.toString());
  } catch (e) {
    log.error(e as string);
    return undefined;
  }
}

function sendPacket(ws: any, packets: any[]) {
  packets.forEach((packet) => {
    ws.send(packet);
  });
}

async function sendStatsToPartyMembers(playerUsername: string, playerId: string, stats: any) {
  // Get the player's party ID first
  const partyId = await parties.getPartyId(playerUsername);
  if (!partyId) return;

  // Get the player's party members
  const partyMembers = await parties.getPartyMembers(partyId);
  if (!partyMembers || partyMembers.length === 0) return;

  // Send stats update to all party members (excluding self, they already get it)
  for (const memberName of partyMembers) {
    if (memberName.toLowerCase() === playerUsername.toLowerCase()) continue;

    const sessionId = await player.getSessionIdByUsername(memberName);
    const partyMember = sessionId && playerCache.get(sessionId);

    if (partyMember && partyMember.ws) {
      sendPacket(
        partyMember.ws,
        packetManager.updateStats({
          target: playerId,
          username: playerUsername, // Include username so client can identify party member
          stats: stats,
        })
      );
    }
  }
}

async function sendSpriteSheetAnimation(ws: any, name: string, playerId?: string, revision?: number) {
  const currentPlayer = playerCache.get(playerId || ws.data.id);
  if (!currentPlayer) return;

  // Get player equipment for armor layers
  const playerEquipment = currentPlayer.equipment || null;

  // Get sprite sheet data for this animation
  const spriteSheetData = await getPlayerSpriteSheetData(name, playerEquipment);

  // Check if at least one layer is available to render
  if (!spriteSheetData.bodySprite && !spriteSheetData.headSprite && !spriteSheetData.bodyArmorSprite && !spriteSheetData.headArmorSprite) {
    log.warn(`No sprite sheet layers available for animation "${name}", player ${currentPlayer.id}`);
    return;
  }

  // Import getSpriteSheetImage and getSpriteSheetTemplate
  const { getSpriteSheetImage, getSpriteSheetTemplate } = await import("../modules/spriteSheetManager");

  // Get base64 image data for each sprite sheet (only if sprite exists)
  const bodyImageData = spriteSheetData.bodySprite ? await getSpriteSheetImage(spriteSheetData.bodySprite.name) : null;
  const headImageData = spriteSheetData.headSprite ? await getSpriteSheetImage(spriteSheetData.headSprite.name) : null;
  const bodyArmorImageData = spriteSheetData.bodyArmorSprite ? await getSpriteSheetImage(spriteSheetData.bodyArmorSprite.name) : null;
  const headArmorImageData = spriteSheetData.headArmorSprite ? await getSpriteSheetImage(spriteSheetData.headArmorSprite.name) : null;

  // Get mount sprite sheet if player is mounted (based on cache mount_type)
  let mountSprite = null;
  let mountImageData = null;
  if (currentPlayer.mounted && currentPlayer.mount_type) {
    const mountTemplateName = `mount_${currentPlayer.mount_type}`;
    mountSprite = await getSpriteSheetTemplate(mountTemplateName);
    if (mountSprite) {
      mountImageData = await getSpriteSheetImage(mountSprite.name);
    }
  }

  const spriteSheetPacketData = {
    id: currentPlayer.id,
    mountSprite: mountSprite ? { ...mountSprite, imageData: mountImageData } : null,
    bodySprite: spriteSheetData.bodySprite ? { ...spriteSheetData.bodySprite, imageData: bodyImageData } : null,
    headSprite: spriteSheetData.headSprite ? { ...spriteSheetData.headSprite, imageData: headImageData } : null,
    bodyArmorSprite: spriteSheetData.bodyArmorSprite ? { ...spriteSheetData.bodyArmorSprite, imageData: bodyArmorImageData } : null,
    headArmorSprite: spriteSheetData.headArmorSprite ? { ...spriteSheetData.headArmorSprite, imageData: headArmorImageData } : null,
    animationState: spriteSheetData.animationState,
    revision: revision,
  };

  const playersInMap = filterPlayersByMap(currentPlayer.location.map);
  const playersInMapAdmins = playersInMap.filter((p) => p.isAdmin);

  if (currentPlayer.isStealth) {
    playersInMapAdmins.forEach((player) => {
      sendPacket(player.ws, packetManager.spriteSheetAnimation(spriteSheetPacketData));
    });
  } else {
    playersInMap.forEach((player) => {
      sendPacket(player.ws, packetManager.spriteSheetAnimation(spriteSheetPacketData));
    });
  }
}

async function sendAnimation(ws: any, name: string, playerId?: string, revision?: number) {
  const currentPlayer = playerCache.get(playerId || ws.data.id);
  if (!currentPlayer) return;

  // Use sprite sheet system only

  if (!useSpriteSheets) {
    log.warn(`Sprite sheet system disabled in config for player ${currentPlayer.id}`);
    return;
  }

  if (!(await isSpriteSheetSystemAvailable())) {
    log.warn(`Sprite sheet system not available for player ${currentPlayer.id}`);
    return;
  }

  await sendSpriteSheetAnimation(ws, name, playerId, revision);
}

function getAnimationNameForDirection(
  direction: string,
  walking: boolean,
  mounted: boolean = false,
  mount_type?: string
): string {
  const normalized = normalizeDirection(direction);
  const action = walking ? "walk" : "idle";
  if (mounted) {
    mount_type = mount_type || "horse";
    return `mount_${mount_type}_${action}_${normalized}.png`;
  }
  return `player_${action}_${normalized}.png`;
}

async function sendPositionAnimation(
  ws: WebSocket,
  direction: string,
  walking: boolean,
  mounted: boolean = false,
  mount_type: string = "",
  playerId?: string,
  revision?: number
) {
  const animation = getAnimationNameForDirection(direction, walking, mounted, mount_type);
  await sendAnimation(ws, animation, playerId, revision);
}

function normalizeDirection(direction: string): string {
  // Return all 8 directions as-is for proper directional animations
  const validDirections = ["down", "up", "left", "right", "downleft", "downright", "upleft", "upright"];
  if (validDirections.includes(direction)) {
    return direction;
  }
  return "down"; // safe fallback for invalid directions
}

async function sendAnimationTo(targetWs: any, name: string, playerId?: string, revision?: number) {
  const targetPlayer = playerCache.get(playerId || targetWs.data.id);
  if (!targetPlayer) return;

  // Use sprite sheet system only
  if (!useSpriteSheets || !(await isSpriteSheetSystemAvailable())) {
    log.warn(`Sprite sheet system not available for player ${targetPlayer.id}`);
    return;
  }

  const playerEquipment = targetPlayer.equipment || null;

  const spriteSheetData = await getPlayerSpriteSheetData(name, playerEquipment);

  // Check if at least one layer is available to render
  if (!spriteSheetData.bodySprite && !spriteSheetData.headSprite && !spriteSheetData.bodyArmorSprite && !spriteSheetData.headArmorSprite) {
    log.warn(`No sprite sheet layers available for animation "${name}", player ${targetPlayer.id}`);
    return;
  }

  // Import getSpriteSheetImage and getSpriteSheetTemplate
  const { getSpriteSheetImage, getSpriteSheetTemplate } = await import("../modules/spriteSheetManager");

  // Get base64 image data for each sprite sheet (only if sprite exists)
  const bodyImageData = spriteSheetData.bodySprite ? await getSpriteSheetImage(spriteSheetData.bodySprite.name) : null;
  const headImageData = spriteSheetData.headSprite ? await getSpriteSheetImage(spriteSheetData.headSprite.name) : null;
  const bodyArmorImageData = spriteSheetData.bodyArmorSprite ? await getSpriteSheetImage(spriteSheetData.bodyArmorSprite.name) : null;
  const headArmorImageData = spriteSheetData.headArmorSprite ? await getSpriteSheetImage(spriteSheetData.headArmorSprite.name) : null;

  // Get mount sprite sheet if player is mounted (based on cache mount_type)
  let mountSprite = null;
  let mountImageData = null;
  if (targetPlayer.mounted && targetPlayer.mount_type) {
    const mountTemplateName = `mount_${targetPlayer.mount_type}`;
    mountSprite = await getSpriteSheetTemplate(mountTemplateName);
    if (mountSprite) {
      mountImageData = await getSpriteSheetImage(mountSprite.name);
    }
  }

  const spriteSheetPacketData = {
    id: targetPlayer.id,
    mountSprite: mountSprite ? { ...mountSprite, imageData: mountImageData } : null,
    bodySprite: spriteSheetData.bodySprite ? { ...spriteSheetData.bodySprite, imageData: bodyImageData } : null,
    headSprite: spriteSheetData.headSprite ? { ...spriteSheetData.headSprite, imageData: headImageData } : null,
    bodyArmorSprite: spriteSheetData.bodyArmorSprite ? { ...spriteSheetData.bodyArmorSprite, imageData: bodyArmorImageData } : null,
    headArmorSprite: spriteSheetData.headArmorSprite ? { ...spriteSheetData.headArmorSprite, imageData: headArmorImageData } : null,
    animationState: spriteSheetData.animationState,
    revision: revision,
  };

  sendPacket(targetWs, packetManager.spriteSheetAnimation(spriteSheetPacketData));
}