import { packetTypes } from "./types";
import { packetManager } from "./packet_manager";
import log from "../modules/logger";
import player from "../systems/player";
import permissions from "../systems/permissions";
import inventory from "../systems/inventory";
import cache from "../services/cache";
import assetCache from "../services/assetCache";
import { reloadMap } from "../modules/assetloader";
import language from "../systems/language";
import questlog from "../systems/questlog";
import quests from "../systems/quests";
import generate from "../modules/sprites";
import friends from "../systems/friends";
import currency from "../systems/currency";
import parties from "../systems/parties.ts";
const maps = assetCache.get("maps");
const spritesheets = assetCache.get("spritesheets");
import { decryptPrivateKey, decryptRsa, _privateKey } from "../modules/cipher";
// Load settings
import * as settings from "../../config/settings.json";
import { randomBytes } from "../modules/hash";
const defaultMap = settings.default_map?.replace(".json", "") || "main";

let restartScheduled: boolean;
let restartTimers: ReturnType<typeof setTimeout>[];

// Create sprites from the spritesheets
const spritePromises = spritesheets.map(async (spritesheet: any) => {
  const sprite = await generate(spritesheet);
  return sprite;
});

const sprites = (await Promise.all(spritePromises)).flat();
assetCache.add("sprites", sprites);

const npcs = assetCache.get("npcs");
const particles = assetCache.get("particles");

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
      Object.values(packetTypes).indexOf(parsedMessage?.type as unknown as string) === -1
    ) {
      ws.close(1007, "Invalid packet type");
    }

    const currentPlayer = cache.get(ws.data.id) || null;

    // Handle the packet
    switch (type) {
      case "BENCHMARK": {
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
        sendPacket(ws, packetManager.timeSync(data, ws));
        break;
      }
      // TODO:Move this to the auth packet
      case "AUTH": {
              const auth = await player.setSessionId(data.toString(), ws.data.id);
              if (!auth) {
                sendPacket(ws, packetManager.loginFailed());
                ws.close(1008, "Already logged in");
                break;
              }
              const getUsername = (await player.getUsernameBySession(ws.data.id)) as any[];
              const username = getUsername[0]?.username as string;
              ws.data.username = username;
              const id = getUsername[0]?.id as string;
              const [
                access,
                itemsRaw,
                questLogRaw,
                stats,
                playerCurrency,
                friendsList,
                partyId,
                clientConfig,
                location,
                isAdmin,
                isGuest,
                isStealthInitial,
                isNoclipInitial
              ] = await Promise.all([
                permissions.get(username),
                inventory.get(username),
                questlog.get(username),
                player.getStats(username),
                currency.get(username),
                friends.list(username),
                parties.getPartyId(username),
                player.getConfig(username),
                player.getLocation({ username }),
                player.isAdmin(username),
                player.isGuest(username),
                player.isStealth(username),
                player.isNoclip(username)
              ]);
              const items = (itemsRaw || []).slice(0, 30);
              const incompleteQuest = questLogRaw?.incomplete || [];
              const completedQuest = questLogRaw?.completed || [];
              let isStealth = isStealthInitial;
              let isNoclip = isNoclipInitial;
              if (!isAdmin && isStealth) {
                await player.toggleStealth(username);
                isStealth = false;
              }
              if (!isAdmin && isNoclip) {
                await player.toggleNoclip(username);
                isNoclip = false;
              }
              let partyMembers: string[] = [];
              if (partyId) {
                partyMembers = await parties.getPartyMembers(partyId);
              }
              sendPacket(ws, packetManager.inventory(items));
              sendPacket(ws, packetManager.questlog(completedQuest, incompleteQuest));
              sendPacket(ws, packetManager.clientConfig(clientConfig));
              const position = location?.position as PositionData;
              let spawnLocation;
              if (
                !location ||
                (!position?.x && position.x !== 0) ||
                (!position?.y && position.y !== 0)
              ) {
                spawnLocation = { map: `${defaultMap}.json`, x: 0, y: 0 };
              } else {
                spawnLocation = {
                  map: `${location.map}.json`,
                  x: position.x || 0,
                  y: position.y || 0,
                  direction: position.direction,
                };
              }
              const map =
                maps.find((m: MapData) => m.name === spawnLocation.map) ||
                maps.find((m: MapData) => m.name === `${defaultMap}.json`);
              if (!map) return;
              spawnLocation.map = map.name;
              await player.setLocation(ws.data.id, spawnLocation.map.replace(".json", ""), {
                x: spawnLocation.x,
                y: spawnLocation.y,
                direction: spawnLocation.direction || "down"
              });
              cache.add(ws.data.id, {
                username,
                animation: null,
                isAdmin,
                isStealth,
                isNoclip,
                id: ws.data.id,
                userid: id,
                location: {
                  map: spawnLocation.map.replace(".json", ""),
                  position: {
                    x: spawnLocation.x || 0,
                    y: spawnLocation.y || 0,
                    direction: spawnLocation.direction || "down",
                    moving: false,
                  },
                },
                language: parsedMessage?.language || "en",
                ws,
                stats,
                friends: friendsList || [],
                attackDelay: 0,
                lastMovementPacket: null,
                permissions: typeof access === "string" ? access.split(",") : [],
                movementInterval: null,
                pvp: false,
                last_attack: null,
                invitations: [],
                party: partyMembers,
                currency: playerCurrency,
                isGuest,
              });
              log.debug(
                `Spawn location for ${username}: ${spawnLocation.map.replace(".json", "")} at ${spawnLocation.x},${spawnLocation.y}`
              );
              const mapData = [
                map?.compressed,
                spawnLocation?.map,
                position?.x || 0,
                position?.y || 0,
                position?.direction || "down",
              ];
              sendPacket(ws, packetManager.loadMap(mapData));
              const allPlayers = cache.list() as Record<string, any>;
              const currentPlayerData = allPlayers[ws.data.id];
              const playersOnMap = filterPlayersByMap(spawnLocation.map);
              const playerDataForLoad: any[] = [];
              for (const p of playersOnMap) {
                playerDataForLoad.push({
                  id: p.id,
                  userid: p.userid,
                  location: {
                    map: p.location.map,
                    x: p.location.position.x || 0,
                    y: p.location.position.y || 0,
                    direction: p.location.position.direction,
                  },
                  username: p.username,
                  isAdmin: p.isAdmin,
                  isGuest: p.isGuest,
                  isStealth: p.isStealth,
                  stats: p.stats,
                  animation: null
                });
              }
              sendPacket(ws, packetManager.loadPlayers(playerDataForLoad));
              const spawnDataForAll = {
                id: ws.data.id,
                userid: id,
                location: {
                  map: spawnLocation.map,
                  x: spawnLocation.x || 0,
                  y: spawnLocation.y || 0,
                  direction: spawnLocation.direction,
                },
                username,
                isAdmin,
                isGuest,
                isStealth,
                stats,
                animation: null,
                friends: friendsList,
                party: partyMembers,
                currency: playerCurrency,
              };
              for (const p of playersOnMap) {
                if (!p || !p.ws) continue;
                if (p.ws === ws) {
                  sendPacket(p.ws, packetManager.spawnPlayer(spawnDataForAll));
                } else {
                  const spawnForOther = {
                    id: ws.data.id,
                    userid: id,
                    location: {
                      map: spawnLocation.map,
                      x: spawnLocation.x || 0,
                      y: spawnLocation.y || 0,
                      direction: spawnLocation.direction,
                    },
                    username,
                    isAdmin,
                    isGuest,
                    isStealth,
                    stats,
                    animation: null
                  };
                  sendPacket(p.ws, packetManager.spawnPlayer(spawnForOther));
                }
                if (position.direction && ws.data.id === p.id) {
                  sendPositionAnimation(p.ws, position.direction, false);
                }
              }
              if (playerDataForLoad.length > 0) {
                playerDataForLoad.forEach((pl) => {
                  if (pl.id !== ws.data.id && pl.location.direction) {
                    const pcache = cache.get(pl.id);
                    sendAnimation(ws, getAnimationNameForDirection(pl.location.direction, pcache?.moving), pl.id);
                  }
                });
              }
              setImmediate(() => {
                for (const [, p] of Object.entries(allPlayers)) {
                  const playerObj = p as any;
                  if (!playerObj.ws || playerObj.ws.id === ws.data.id) continue;
                  const isFriendOfNew = (currentPlayerData.friends || []).some((f: any) => f === playerObj.username);
                  const isFriendOfOther = (playerObj.friends || []).some((f: any) => f === currentPlayerData.username);
                  if (isFriendOfNew) {
                    sendPacket(playerObj.ws, packetManager.updateOnlineStatus({
                      online: true,
                      username: currentPlayerData.username,
                    }));
                  }
                  if (isFriendOfOther) {
                    sendPacket(currentPlayerData.ws, packetManager.updateOnlineStatus({
                      online: true,
                      username: playerObj.username,
                    }));
                  }
                }
              });
              setImmediate(() => {
                const npcsInMap = npcs.filter(
                  (npc: Npc) => npc.map === spawnLocation.map.replace(".json", "")
                );
                const npcPackets = npcsInMap.reduce((packets: any[], npc: Npc) => {
                  const particleArray =
                    typeof npc.particles === "string"
                      ? (npc.particles as string)
                          .split(",")
                          .map((name) =>
                            particles.find((p: Particle) => p.name === name.trim())
                          )
                          .filter(Boolean)
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
                }, [] as any[]);
                if (npcPackets.length) {
                  sendPacket(ws, npcPackets);
                }
              });
              setImmediate(() => {
                const musicData = {
                  name: "music_entry",
                  data: assetCache
                    .get("audio")
                    .find((a: SoundData) => a.name === "music_entry"),
                };
                if (!musicData.data) {
                  sendPacket(ws, packetManager.consoleMessage({ type: "error", message: `Music file not found: ${musicData.name}` }));
                } else {
                  sendPacket(ws, packetManager.music(musicData));
                }
              });
              break;
      }
      // TODO:Move this to the logout packet
      case "LOGOUT": {
        if (!currentPlayer) return;
        await player.setLocation(
          currentPlayer.id,
          currentPlayer.location.map,
          currentPlayer.location.position
        );
        await player.logout(currentPlayer.id);
        break;
      }
      case "DISCONNECT": {
        if (!currentPlayer) return;
        await player.setLocation(
          currentPlayer.id,
          currentPlayer.location.map,
          currentPlayer.location.position
        );
        await player.clearSessionId(currentPlayer.id);
        break;
      }
      case "MOVEXY": {
        if (!currentPlayer) return;

        const speed = 2;
        const targetFPS = 60;
        const frameTime = 1000 / targetFPS;
        const lastDirection = currentPlayer.location.position.direction || "down";
        currentPlayer.moving = true;

        const direction = data.toString().toLowerCase();

        const directions = [
          "up", "down", "left", "right",
          "upleft", "upright", "downleft", "downright"
        ];

        if (direction === "abort") {
          if (currentPlayer.movementInterval) {
            clearInterval(currentPlayer.movementInterval);
            currentPlayer.movementInterval = null;
            currentPlayer.moving = false;
            cache.set(currentPlayer.id, currentPlayer);
            sendPositionAnimation(ws, lastDirection, false);
          }
          return;
        }

        if (!directions.includes(direction)) return;

        currentPlayer.location.position.direction = direction;
        sendPositionAnimation(ws, direction, true);

        if (currentPlayer.movementInterval) {
          clearInterval(currentPlayer.movementInterval);
        }

        let lastTime = performance.now();
        let running = false;

        const movePlayer = async () => {
          if (running) return;
          running = true;
          currentPlayer.moving = true;

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
            cache.set(currentPlayer.id, currentPlayer);
            return;
          }

          tempPosition.x += offset.dx;
          tempPosition.y += offset.dy;

          const collision = player.checkIfWouldCollide(
            currentPlayer.location.map,
            {
              x: tempPosition.x,
              y: tempPosition.y,
              direction,
            },
            {
              width: playerWidth,
              height: playerHeight,
            }
          );

          const isColliding = collision?.value === true;

          if (!isColliding || currentPlayer.isNoclip) {
            currentPlayer.location.position = tempPosition;
          }

          if (isColliding && !currentPlayer.isNoclip) {
            clearInterval(currentPlayer.movementInterval);
            currentPlayer.movementInterval = null;
            sendPositionAnimation(ws, direction, false);

            const reason = collision.reason;

            if (reason === "warp_collision" && collision.warp) {
              const currentMap = currentPlayer.location.map;
              const warp = collision.warp as { map: string; position: PositionData };

              const result = await player.setLocation(
                currentPlayer.id,
                warp.map.replace(".json", ""),
                {
                  x: warp.position.x || 0,
                  y: warp.position.y || 0,
                  direction: currentPlayer.location.position.direction,
                }
              );

              // Only proceed if result is an object with affectedRows property
              if (result && typeof result === "object" && "affectedRows" in result && (result as { affectedRows: number }).affectedRows !== 0) {
                currentPlayer.location = {
                  map: warp.map.replace(".json", ""),
                  x: warp.position.x || 0,
                  y: warp.position.y || 0,
                  direction: currentPlayer.location.position.direction,
                };

                if (currentMap !== warp.map) {
                  sendPacket(ws, packetManager.reconnect());
                } else {
                  const movementData = {
                    id: ws.data.id,
                    _data: currentPlayer.location.position,
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

          const movementData = {
            id: ws.data.id,
            _data: currentPlayer.location.position,
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
        if (currentPlayer.isStealth) {
          const playersInMap = filterPlayersByMap(currentPlayer.location.map);
          const playersInMapAdmin = playersInMap.filter((p) => p.isAdmin);
          currentPlayer.location.position.x = Math.floor(
            Number(currentPlayer.location.position.x)
          );
          currentPlayer.location.position.y = Math.floor(
            Number(currentPlayer.location.position.y)
          );
          playersInMapAdmin.forEach((player) => {
            const movementData = {
              id: ws.data.id,
              _data: currentPlayer.location.position,
            };
            sendPacket(player.ws, packetManager.moveXY(movementData));
          });
        } else {
          const playersInMap = filterPlayersByMap(currentPlayer.location.map);
          playersInMap.forEach((player) => {
            const movementData = {
              id: ws.data.id,
              _data: currentPlayer.location.position,
            };
            sendPacket(player.ws, packetManager.moveXY(movementData));
          });
        }
        break;
      }
      case "CHAT": {
        if (!currentPlayer) return;
        if (currentPlayer.isGuest) {
          sendPacket(ws, packetManager.notify({ message: "Please create an account to use that feature." }));
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

        const playerCache = cache.list();
        let playersInMap = Object.values(playerCache).filter(
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
            translations[player.language] = await language.translate(decryptedMessage, player.language);
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
        const playerCache = cache.list();
        // Get current player data from cache
        // only get players that are in the same map
        const players = Object.values(playerCache).filter(
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
          const inspectPlayerData = {
            id: currentPlayer?.id,
            stats: currentPlayer?.stats,
            username: currentPlayer?.username,
          };
          sendPacket(ws, packetManager.inspectPlayer(inspectPlayerData));
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
        // Send the player's new position and current animation to all players when unstealthing
        if (!isStealth) {
          playersInMap.forEach((player) => {
            const moveXYData = {
              id: ws.data.id,
              _data: currentPlayer.location.position,
            };

            if (currentPlayer.location.position.direction) {
              sendPositionAnimation(ws, currentPlayer.location.position.direction, false);
              sendPacket(player.ws, packetManager.moveXY(moveXYData));
            }
          });
        }
        break;
      }
      case "ATTACK": {
        if (!currentPlayer) return;
        if (currentPlayer.isGuest) {
          sendPacket(ws, packetManager.notify({ message: "Please create an account to use that feature." }));
          return;
        }
        if (currentPlayer.attackDelay > performance.now()) return;
        if (currentPlayer.stats.stamina < 10) return;

        const _data = data as any;
        const target = cache.get(_data.id);
        if (!target) return;

        if (target.isGuest) {
          sendPacket(ws, packetManager.notify({ message: "You cannot attack guests." }));
          return;
        }

        // Check if in the same party
        if (currentPlayer.party.includes(target.username)) {
          sendPacket(ws, packetManager.notify({ message: "You cannot attack your party members" }));
          return;
        }

        const playersInMap = filterPlayersByMap(currentPlayer.location.map);
        const playersNearBy = filterPlayersByDistance(ws, 700, currentPlayer.location.map);
        const playersInAttackRange = filterPlayersByDistance(ws, 60, currentPlayer.location.map);
        const playersInMapAdminNearBy = playersNearBy.filter((p) => p.isAdmin);

        const canAttack = player.canAttack(currentPlayer, target, {
          width: 24,
          height: 40,
        }) as { value: boolean; reason: string } | null;

        // Check if target is in range and can be attacked
        if (!playersInAttackRange.includes(target) || !canAttack?.value) {
          if (canAttack?.reason == "nopvp") {
            sendPacket(ws, packetManager.notify({ message: "You are not in a PvP area" }));
          }
          return;
        }

        // Generate a number for the pitch of the audio
        const pitch = Math.random() * 0.1 + 0.95;

        // Random whole number between 10 and 25
        const damage = Math.floor(Math.random() * (25 - 10 + 1) + 10);
        const stamina = 10;

        target.stats.health = Math.round(target.stats.health - damage);
        currentPlayer.stats.stamina -= stamina;

        // Ensure stamina doesn't go below 0
        if (currentPlayer.stats.stamina < 0) {
          currentPlayer.stats.stamina = 0;
        }

        const audioData = {
          name: "attack_sword",
          data: assetCache
            .get("audio")
            .find((a: SoundData) => a.name === "attack_sword"),
          pitch: pitch,
          timestamp: performance.now(),
        };

        // Audio packet rules (stealth vs normal)
        if (currentPlayer.isStealth) {
          playersInMapAdminNearBy.forEach((player) => {
            sendPacket(player.ws, packetManager.audio(audioData));
          });
        } else {
          playersNearBy.forEach((player) => {
            sendPacket(player.ws, packetManager.audio(audioData));
          });
        }

        // Handle death
        if (target.stats.health <= 0) {
          target.stats.health = target.stats.max_health;
          target.stats.stamina = target.stats.max_stamina;
          target.location.position = { x: 0, y: 0, direction: "down" };

          // Give the attacker xp
          const xp = 10;
          const updatedStats = await player.increaseXp(currentPlayer.username, xp) as StatsData;
          currentPlayer.stats.xp = updatedStats.xp;
          currentPlayer.stats.level = updatedStats.level;
          currentPlayer.stats.max_xp = updatedStats.max_xp;

          // Send XP update to attacker
          sendPacket(ws, packetManager.updateXp({
            id: currentPlayer.id,
            xp: currentPlayer.stats.xp,
            level: currentPlayer.stats.level,
            max_xp: currentPlayer.stats.max_xp,
          }));

          playersInMap.forEach((player) => {
            sendPacket(player.ws, packetManager.moveXY({
              id: target.id,
              _data: target.location.position,
            }));

            sendPacket(player.ws, packetManager.revive({
              id: target.id,
              target: target.id,
              stats: target.stats,
            }));
          });
        } else {
          // Always send updated stats to all players in map
          playersInMap.forEach((player) => {
            sendPacket(player.ws, packetManager.updateStats({
              id: ws.data.id,
              target: target.id,
              stats: target.stats,
            }));

            sendPacket(player.ws, packetManager.updateStats({
              id: currentPlayer.id,
              target: currentPlayer.id,
              stats: currentPlayer.stats,
            }));
          });
        }

        // PVP flags + cooldown
        currentPlayer.pvp = true;
        target.pvp = true;
        currentPlayer.last_attack = performance.now();
        target.last_attack = performance.now();

        // Simple cooldown (no await/setTimeout, no reset to 0)
        currentPlayer.attackDelay = performance.now() + 1000;

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
      case "COMMAND": {
        if (!currentPlayer) return;
        if (currentPlayer.isGuest) {
          sendPacket(ws, packetManager.notify({ message: "Please create an account to use that feature." }));
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

        const args = commandParts.slice(1).map((arg: any) => 
          arg.startsWith('"') ? arg.slice(1, -1) : arg
        );

        switch (commandName) {
          // Party chat
          case "P":
          case "PARTY": {
            if (!currentPlayer) return;
            const message = args.join(" ");
            if (!message) {
              sendPacket(ws, packetManager.notify({message: "Please provide a message"}));
              break;
            }

            // Get the party members
            const partyId = await player.getPartyIdByUsername(currentPlayer.username);
            if (!partyId) {
              sendPacket(ws, packetManager.notify({message: "You are not in a party"}));
              break;
            }

            const partyMembers = await parties.getPartyMembers(partyId);
            if (partyMembers.length === 0 || !partyMembers) {
              sendPacket(ws, packetManager.notify({message: "You are not in a party"}));
              break;
            }

            partyMembers.forEach(async (member: any) => {
              const session_id = await player.getSessionIdByUsername(member);
              const memberPlayer = cache.get(session_id);
              if (memberPlayer) {
                sendPacket(memberPlayer.ws, packetManager.partyChat({
                  id: ws.data.id,
                  message,
                  username: currentPlayer.username.charAt(0).toUpperCase() + currentPlayer.username.slice(1),
                }));
              } else {
                sendPacket(ws, packetManager.notify({
                  message: `Player ${member.username} is not online`
                }));
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
            const players = Object.values(cache.list());
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

            sendPacket(targetPlayer.ws, packetManager.whisper({
              id: ws.data.id,
              message: args.slice(1).join(" "),
              // Uppercase the first letter of the username
              username: `<- ${currentPlayer.username.charAt(0).toUpperCase() + currentPlayer.username.slice(1)}`
            }));

            sendPacket(ws, packetManager.whisper({
              id: targetPlayer.id,
              message: args.slice(1).join(" "),
              username: `-> ${targetPlayer.username.charAt(0).toUpperCase() + targetPlayer.username.slice(1)}`
            }));

            break;
          }
          // Summon a player
          case "SUMMON": {
            // admin.summon or admin.*
            if (!currentPlayer.permissions.some(
              (p: string) => p === "admin.summon" || p === "admin.*"
            )) {
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
              const players = Object.values(cache.list());
              targetPlayer = players.find(
                (p) => p.username.toLowerCase() === identifier.toLowerCase()
              );
            } else {
              // Search by ID
              targetPlayer = cache.get(identifier);
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
              direction: targetPlayer.location.position.direction,
            };

            // Update the target player's position in the cache
            cache.set(targetPlayer.id, targetPlayer);

            // Broadcast the movement to all players in the map
            const playersInMap = filterPlayersByMap(
              currentPlayer.location.map
            );

            playersInMap.forEach((player) => {
              const moveXYData = {
                id: targetPlayer.id,
                _data: targetPlayer.location.position,
              };
              sendPacket(player.ws, packetManager.moveXY(moveXYData));
            });

            // Notify the target player
            sendPacket(targetPlayer.ws, packetManager.notify({message: `You have been summoned by an admin`}));

            // Notify the admin
            sendPacket(ws, packetManager.notify({message: `Summoned ${targetPlayer.username.charAt(0).toUpperCase() + targetPlayer.username.slice(1)}`}));
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
              const players = Object.values(cache.list());
              targetPlayer = players.find(
                (p) => p.username.toLowerCase() === identifier.toLowerCase()
              );
            } else {
              // Search by ID
              targetPlayer = cache.get(identifier);
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
              message: `Disconnected ${targetPlayer.username.charAt(0).toUpperCase() + targetPlayer.username.slice(1)} from the server`,
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
            const players = Object.values(cache.list());

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
              const players = Object.values(cache.list());
              targetPlayer = players.find(
                (p) => p.username.toLowerCase() === identifier.toLowerCase()
              );
            } else {
              // Search by ID
              targetPlayer = cache.get(identifier);
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
                message: `${targetPlayer.username.charAt(0).toUpperCase() + targetPlayer.username.slice(1)} is already banned`,
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            // Ban the player
            await player.ban(targetPlayer.username, targetPlayer.ws);
            const notifyData = {
              message: `Banned ${targetPlayer.username.charAt(0).toUpperCase() + targetPlayer.username.slice(1)} from the server`,
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
              const players = Object.values(cache.list());
              targetPlayer = players.find(
                (p) => p.username.toLowerCase() === identifier.toLowerCase()
              );
            } else {
              // Search by ID
              targetPlayer = cache.get(identifier);
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
              cache.set(targetPlayer.id, targetPlayer);
            }
            const notifyData = {
              message: `${targetPlayer.username.charAt(0).toUpperCase() + targetPlayer.username.slice(1)} is now ${admin ? "an admin" : "not an admin"}`,
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
            const players = Object.values(cache.list());
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
              const remainingPlayers = Object.values(cache.list());
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

              const players = Object.values(cache.list());
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
                  const players = Object.values(cache.list());
                  players.forEach((player) => {
                    const notifyData = {
                      message: `⚠️ Server restarting in ${minutes} minute${
                        minutes === 1 ? "" : "s"
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
                  const players = Object.values(cache.list());
                  players.forEach((player) => {
                    const notifyData = {
                      message: `⚠️ Server restarting in ${seconds} second${
                        seconds === 1 ? "" : "s"
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
                const players = Object.values(cache.list());
                players.forEach((player) => {
                  player.ws.close(1000, "Server is restarting");
                });
                // Keep checking until all players are disconnected
                const checkInterval = setInterval(async () => {
                  const remainingPlayers = Object.values(cache.list());
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
              const players = Object.values(cache.list());
              if (isNaN(Number(identifier))) {
                // Search by username
                targetPlayer = players.find(
                  (p) => p.username.toLowerCase() === identifier.toLowerCase()
                );
              } else {
                // Search by ID
                targetPlayer = cache.get(identifier);
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
            await player.setLocation(targetPlayer.username, `${defaultMap}`, {
              x: 0,
              y: 0,
              direction: "down",
            });

            // Update cache if player is online
            if (cache.get(targetPlayer.id)) {
              targetPlayer.location.position = {
                x: 0,
                y: 0,
                direction: "down",
              };
              cache.set(targetPlayer.id, targetPlayer);
              const playersInMap = filterPlayersByMap(
                targetPlayer.location.map
              );
              playersInMap.forEach((player) => {
                const moveData = {
                  id: targetPlayer.id,
                  _data: targetPlayer.location.position,
                };
                sendPacket(player.ws, packetManager.moveXY(moveData));
              });
            }

            const notifyData = {
              message: `Respawned ${targetPlayer.username.charAt(0).toUpperCase() + targetPlayer.username.slice(1)}`,
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
            const players = Object.values(cache.list());
            if (isNaN(Number(identifier))) {
              // Search by username
              targetPlayer = players.find(
                (p) => p.username.toLowerCase() === identifier.toLowerCase()
              );
            } else {
              // Search by ID
              targetPlayer = cache.get(identifier);
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
                  cache.set(targetPlayer.id, targetPlayer);
                }
                const notifyData = {
                  message: `Permissions \`${permissionsArray.join(", ")}\` added to ${targetPlayer.username.charAt(0).toUpperCase() + targetPlayer.username.slice(1)}`,
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
                  cache.set(targetPlayer.id, targetPlayer);
                }
                const notifyData = {
                  message: `Permissions removed from ${targetPlayer.username.charAt(0).toUpperCase() + targetPlayer.username.slice(1)}`,
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
                  cache.set(targetPlayer.id, targetPlayer);
                }
                const notifyData = {
                  message: `Permissions set for ${targetPlayer.username.charAt(0).toUpperCase() + targetPlayer.username.slice(1)}`,
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
                const p = cache.get(targetPlayer.id);
                if (p.ws) {
                  cache.set(targetPlayer.id, targetPlayer);
                }
                const notifyData = {
                  message: `Permissions cleared for ${targetPlayer.username.charAt(0).toUpperCase() + targetPlayer.username.slice(1)}`,
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
                  message: `Permissions for ${
                    targetPlayer.username.charAt(0).toUpperCase() + targetPlayer.username.slice(1)
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
            const map = (maps as any[]).find((m) => m.name === `${mapName}.json`);
            if (!map) {
              const notifyData = {
                message: `Map ${mapName} not found`,
              };
              sendPacket(ws, packetManager.notify(notifyData));
              break;
            }

            const result = await reloadMap(mapName) as MapData | null;
            if (result) {
              console.log(`Map ${mapName} reloaded successfully`);
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
                  player.location.x || 0,
                  player.location.y || 0,
                  player.location.direction || "down",
                  player.location.moving || false
                ];
                sendPacket(player.ws, packetManager.loadMap(mapData));
              });
            } else {
              console.error(`Failed to reload map ${mapName}`);
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

            const map =
              (maps as any[]).find(
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
              // Warp the current player
              const result = await player.setLocation(
                currentPlayer.id,
                mapName,
                {
                  x: 0,
                  y: 0,
                  direction: currentPlayer.location.position.direction,
                }
              );
              // Check affected rows only if result is an object with affectedRows property
              if (result && typeof result === "object" && "affectedRows" in result && (result as { affectedRows: number }).affectedRows != 0) {
                currentPlayer.location = {
                  map: mapName,
                  x: 0,
                  y: 0,
                  direction: currentPlayer.location.position.direction,
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
          sendPacket(ws, packetManager.notify({ message: "You are not in a party" }));
          return;
        }

        const isLeader = await parties.isPartyLeader(currentPlayer.username);
        if (!isLeader) {
          sendPacket(ws, packetManager.notify({ message: "You are not the party leader" }));
          return;
        }

        const member = (data as any)?.username;
        if (!member) {
          sendPacket(ws, packetManager.notify({ message: "Please provide a username" }));
          return;
        }

        // Check if the member is in the party
        const members = await parties.getPartyMembers(partyId);
        if (!members || members?.length === 0) {
          sendPacket(ws, packetManager.notify({ message: "You are not in a party" }));
          return;
        }

        if (!members.includes(member)) {
          sendPacket(ws, packetManager.notify({ message: `${member.charAt(0).toUpperCase() + member.slice(1)} is not in your party` }));
          return;
        }

        // Kick the member from the party
        const result = await parties.remove(member);

        if (typeof result === "boolean" && !result) {
          sendPacket(ws, packetManager.notify({ message: `Failed to kick ${member.charAt(0).toUpperCase() + member.slice(1)} from the party` }));
          return;
        }

        if (typeof result === "boolean" && result) {
          // Party was disbanded
          members.forEach(async (m: string) => {
            const session_id = await player.getSessionIdByUsername(m);
            const p = session_id && cache.get(session_id);
            if (p) {
              sendPacket(p.ws, packetManager.updateParty({ members: [] }));
              sendPacket(p.ws, packetManager.notify({ message: "The party has been disbanded" }));
              p.party = [];
              cache.set(p.id, p);
            }
          });
          return;
        }
        
        if (Array.isArray(result) && result.length > 0) {
          sendPacket(ws, packetManager.notify({ message: `${member.charAt(0).toUpperCase() + member.slice(1)} has been kicked from the party` }));
          currentPlayer.party = [];
          cache.set(currentPlayer.id, currentPlayer);
          sendPacket(ws, packetManager.updateParty({ members: [] }));

          // Send the updated party members to all party members
          result.forEach(async (m: string) => {
            const session_id = await player.getSessionIdByUsername(m);
            const p = session_id && cache.get(session_id);
            if (p) {
              if (m !== member) {
                sendPacket(p.ws, packetManager.updateParty({ members: result }));
                sendPacket(p.ws, packetManager.notify({ message: `${currentPlayer.username.charAt(0).toUpperCase() + currentPlayer.username.slice(1)} has kicked ${member.charAt(0).toUpperCase() + member.slice(1)} from the party` }));
                p.party = result;
              } else {
                sendPacket(p.ws, packetManager.updateParty({ members: [] }));
                sendPacket(p.ws, packetManager.notify({ message: `You have been kicked from the party` }));
                p.party = [];
              }
              cache.set(p.id, p);
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
          sendPacket(ws, packetManager.notify({ message: "You are not in a party" }));
          return;
        }

        const members = await parties.getPartyMembers(partyId);
        if (!members || members?.length === 0) {
          sendPacket(ws, packetManager.notify({ message: "You are not in a party" }));
          return;
        }

        const result = await parties.leave(currentPlayer.username);

        const type = typeof result;
        if (type === "boolean" && !result) {
          sendPacket(ws, packetManager.notify({ message: "Failed to leave party" }));
          return;
        }

        // Party was deleted
        if (type === "boolean" && result) {
          members.forEach(async (member: string) => {
            const session_id = await player.getSessionIdByUsername(member);
            const p = session_id && cache.get(session_id);
            if (p) {
              sendPacket(p.ws, packetManager.updateParty({ members: [] }));
              sendPacket(p.ws, packetManager.notify({ message: "The party has been disbanded" }));
              p.party = [];
              cache.set(p.id, p);
            }
          });
          return;
        }

        if (type === "object" && (result as string[]).length > 0) {
          sendPacket(ws, packetManager.notify({ message: "You have left the party" }));
          currentPlayer.party = [];
          cache.set(currentPlayer.id, currentPlayer);
          sendPacket(ws, packetManager.updateParty({ members: [] }));

          // Send the updated party members to all party members
          (result as string[]).forEach(async (member: string) => {
            const session_id = await player.getSessionIdByUsername(member);
            const p = session_id && cache.get(session_id);
            if (p) {
              sendPacket(p.ws, packetManager.updateParty({ members: result }));
              sendPacket(p.ws, packetManager.notify({ message: `${currentPlayer.username.charAt(0).toUpperCase() + currentPlayer.username.slice(1)} has left the party` }));
              p.party = result;
              cache.set(p.id, p);
            }
          });
        }
        break;
      }
      case "INVITE_PARTY": {
        const invited_user = (data as any).id;
        const invitedUser = cache.get(invited_user);
        const invitedUserUsername = invitedUser?.username || invited_user;
        if (!currentPlayer || !invited_user || !invitedUserUsername) return;

        if (currentPlayer.isGuest) {
          sendPacket(ws, packetManager.notify({ message: "Please create an account to use that feature." }));
          return;
        }

        if (invitedUser.isGuest) {
          sendPacket(ws, packetManager.notify({ message: `${invitedUserUsername.charAt(0).toUpperCase() + invitedUserUsername.slice(1)} is a guest and cannot be invited to a party.` }));
          return;
        }

        // Get the leaders party ID
        const partyId = await parties.getPartyId(currentPlayer.username);
        if (partyId) {
          // Check if they are the leader
          const isLeader = await parties.isPartyLeader(currentPlayer.username);
          if (!isLeader) {
            sendPacket(ws, packetManager.notify({ message: "You are not the party leader" }));
            return;
          }
        }

        // Check if the invited user is already in a party
        const invitedUserPartyId = await parties.getPartyId(invitedUserUsername);

        if (invitedUserPartyId) {
          sendPacket(ws, packetManager.notify({ message: `${invitedUserUsername.charAt(0).toUpperCase() + invitedUserUsername.slice(1)} is already in a party` }));
          return;
        }

        // Check if the invited user is a party leader
        const invitedUserLeader = await parties.isPartyLeader(invitedUserUsername);
        if (invitedUserLeader) {
          sendPacket(ws, packetManager.notify({ message: `${invitedUserUsername.charAt(0).toUpperCase() + invitedUserUsername.slice(1)} is already in a party` }));
          return;
        }

        const player_username = currentPlayer.username.charAt(0).toUpperCase() + currentPlayer.username.slice(1);

        const invite_data = {
          action: "INVITE_PARTY",
          message: `${player_username} wants to invite you to their party`,
          originator: currentPlayer.id.toString(),
          authorization: randomBytes(16).toString(),
        }
      

        if (!invitedUser) {
          sendPacket(ws, packetManager.notify({ message: `${invitedUserUsername.charAt(0).toUpperCase() + invitedUserUsername.slice(1)} is not online` }));
          return;
        }

        currentPlayer.invitations.push({
          action: invite_data.action,
          originator: invite_data.originator,
          authorization: invite_data.authorization,
        });

        cache.set(currentPlayer.id, currentPlayer);
        // Send the invitation notification to the invited user
        sendPacket(invitedUser.ws, packetManager.invitation(invite_data));
        sendPacket(ws, packetManager.notify({ message: `Invitation sent to ${invitedUserUsername.charAt(0).toUpperCase() + invitedUserUsername.slice(1)}` }));
      break;
      }
      case "ADD_FRIEND": {
        const id = (data as any).id;
        if (!id) return;

        if (!currentPlayer) return;

        if (currentPlayer.isGuest) {
          sendPacket(ws, packetManager.notify({ message: "Please create an account to use that feature." }));
          return;
        }

        // Uppercase the first letter of the username
        const player_username = currentPlayer.username.charAt(0).toUpperCase() + currentPlayer.username.slice(1);

        const get_friend = cache.get(id);
        if (!get_friend) return;

        if (get_friend.isGuest) {
          sendPacket(ws, packetManager.notify({ message: `${get_friend.username.charAt(0).toUpperCase() + get_friend.username.slice(1)} is a guest and cannot be added as a friend.` }));
          return;
        }

        const invite_data = {
          action: "FRIEND_REQUEST",
          message: `${player_username} wants to add you as a friend`,
          originator: currentPlayer.id.toString(),
          authorization: randomBytes(16).toString(),
        }
        
        // Add the invitation to the player's invitations
        // This is used for authentication and verification for the friend request so that we can't force add friends
        currentPlayer.invitations.push({
          action: invite_data.action,
          originator: invite_data.originator,
          authorization: invite_data.authorization,
        });

        cache.set(currentPlayer.id, currentPlayer);

        // Send the invitation notification to the friend
        sendPacket(get_friend.ws, packetManager.invitation(invite_data));
        break;
      }
      case "INVITATION_RESPONSE": {
        const { action, originator, authorization, response } = data as any;
        if (!action || !originator || !authorization || !response) return;

        log.info(`Invitation response received: ${action}, ${originator}, ${authorization}, ${response}`);
        // Find the current player in the cache
        const inviter = cache.get(originator);
        
        if (!inviter) {
          // If the inviter is not found, we can't process the invitation because they might have disconnected
          sendPacket(ws, packetManager.notify({message: "Unable to process invitation - user not found or has disconnected"}));
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
        cache.set(inviter.id, inviter);

        switch (action.toUpperCase()) {
          // Process friend request
          case "FRIEND_REQUEST": {
            if (response.toUpperCase() === "ACCEPT") {
              // If the response is accept, we need to add each other as friends
              const updatedCurrentPlayersFriendsList = await friends.add(currentPlayer.username.toLowerCase(), inviter.username.toLowerCase());
              sendPacket(ws, packetManager.notify({message: `You are now friends with ${inviter.username.charAt(0).toUpperCase() + inviter.username.slice(1)}`}));
              sendPacket(ws, packetManager.updateFriends({ friends: updatedCurrentPlayersFriendsList }));

              // Add the inviter to the current player's friends list as well
              // This is done so that both players can see each other as friends
              const updatedFriendsList = await friends.add(inviter.username.toLowerCase(), currentPlayer.username.toLowerCase());
              sendPacket(inviter.ws, packetManager.notify({message: `You are now friends with ${currentPlayer.username.charAt(0).toUpperCase() + currentPlayer.username.slice(1)}`}));
              sendPacket(inviter.ws, packetManager.updateFriends({ friends: updatedFriendsList }));
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
                const updatedPartyMembers = await parties.add(currentPlayer.username.toLowerCase(), partyId);
                if (!updatedPartyMembers) {
                  sendPacket(ws, packetManager.notify({ message: "Failed to join party" }));
                  return;
                }
                sendPacket(ws, packetManager.notify({ message: `You have joined ${inviter.username.charAt(0).toUpperCase() + inviter.username.slice(1)}'s party` }));
                sendPacket(inviter.ws, packetManager.notify({ message: `${currentPlayer.username.charAt(0).toUpperCase() + currentPlayer.username.slice(1)} has joined your party` }));
                // Send the updated party members to all party members
                updatedPartyMembers.forEach(async (member: string) => {
                  const session_id = await player.getSessionIdByUsername(member);
                  const p = session_id && cache.get(session_id);
                  if (p) {
                    sendPacket(p.ws, packetManager.updateParty({ members: updatedPartyMembers }));
                    p.party = updatedPartyMembers;
                    cache.set(p.id, p);
                  }
                });
              } else {
                // If the party does not exist, create a new one
                const updatedPartyMembers = await parties.create(inviter.username.toLowerCase(), currentPlayer.username.toLowerCase());
                if (!updatedPartyMembers) {
                  sendPacket(ws, packetManager.notify({ message: "Failed to create party" }));
                  return;
                }
                sendPacket(ws, packetManager.notify({ message: `You have joined ${inviter.username.charAt(0).toUpperCase() + inviter.username.slice(1)}'s party` }));
                sendPacket(inviter.ws, packetManager.notify({ message: `${currentPlayer.username.charAt(0).toUpperCase() + currentPlayer.username.slice(1)} has joined your party` }));
                sendPacket(inviter.ws, packetManager.updateParty({ members: updatedPartyMembers }));
                sendPacket(ws, packetManager.updateParty({ members: updatedPartyMembers }));
                (updatedPartyMembers as string[]).forEach(async (member: string) => {
                  const session_id = await player.getSessionIdByUsername(member);
                  const p = session_id && cache.get(session_id);
                  if (p) {
                    sendPacket(p.ws, packetManager.updateParty({ members: updatedPartyMembers }));
                    p.party = updatedPartyMembers;
                    cache.set(p.id, p);
                  }
                });
              }
            }
            break;
          }
        }
      break;
      }
      // Not working when freidn is onlien
      case "REMOVE_FRIEND": {
        const id = (data as any).id;
        const username = (data as any).username;

        if (!currentPlayer) return;
        // Only fetch from cache if ID is provided, otherwise use username
        let get_friend;
        if (id) {
          get_friend = cache.get(id);
        } else if (username) {
          // Try to find in cache by username (case-insensitive)
          get_friend = Object.values(cache.list()).find(
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
        const updatedFriendsList = await friends.remove(currentPlayer.username.toLowerCase(), get_friend?.username?.toLowerCase() || username.toLowerCase());

        // If the friend is online, notify them and update their friends list
        if (get_friend?.ws) {
          // Only send an update to the removed friend if they are online
          sendPacket(get_friend.ws, packetManager.updateFriends({ friends: updatedFriendsList }));
        }

        // Update the current player's friends list
        const updatedCurrentPlayersFriendsList = await friends.remove(get_friend?.username?.toLowerCase() || username.toLowerCase(), currentPlayer.username.toLowerCase());
        sendPacket(ws, packetManager.updateFriends({ friends: updatedCurrentPlayersFriendsList }));
        sendPacket(ws, packetManager.notify({ message: `You have removed ${get_friend.username.charAt(0).toUpperCase() + get_friend.username.slice(1)} from your friends list` }));
        break;
      }
      // Unknown packet type
      default: {
        break;
      }
    }
  } catch (e) {
    log.error(e as string);
  }
}

// Function to filter players by map
function filterPlayersByMap(map: string) {
  const players = cache.list();
  return Object.values(players).filter(
    (p) =>
      p.location.map.replaceAll(".json", "") === map.replaceAll(".json", "")
  );
}

// Function to filter players by distance and map
function filterPlayersByDistance(ws: any, distance: number, map: string) {
  const players = filterPlayersByMap(map);
  const currentPlayer = cache.get(ws.data.id);
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

function sendAnimation(ws: any, name: string, playerId?: string) {
  const currentPlayer = cache.get(playerId || ws.data.id);
  if (!currentPlayer) return;

  const animationData = getAnimation(name);
  if (!animationData) return;

  currentPlayer.animation = {
    frames: animationData?.data,
    currentFrame: 0,
    lastFrameTime: performance?.now(),
  };

  const animationPacketData = {
    id: currentPlayer?.id,
    name: name,
    data: animationData?.data,
  };

  cache.set(currentPlayer.id, currentPlayer);

  const playersInMap = filterPlayersByMap(currentPlayer.location.map);
  const playersInMapAdmins = playersInMap.filter((p) => p.isAdmin);

  if (currentPlayer.isStealth) {
    playersInMapAdmins.forEach((player) => {
      sendPacket(player.ws, packetManager.animation(animationPacketData));
    });
  } else {
    playersInMap.forEach((player) => {
      sendPacket(player.ws, packetManager.animation(animationPacketData));
    });
  }
}

function getAnimation(name: string) {
  const animationData = assetCache.get("animations").find((a: any) => a.name === name);
  if (!animationData) {
    console.log("Animation not found");
    return;
  }
  return animationData;
}

function getAnimationNameForDirection(direction: string, walking: boolean): string {
  const normalized = normalizeDirection(direction);
  const action = walking ? "walk" : "idle";
  return `player_${action}_${normalized}.png`;
}

function sendPositionAnimation(ws: WebSocket, direction: string, walking: boolean) {
  const animation = getAnimationNameForDirection(direction, walking);
  sendAnimation(ws, animation);
}

function normalizeDirection(direction: string): string {
  switch (direction) {
    case "down":
    case "downleft":
    case "downright":
      return "down";
    case "up":
    case "upleft":
    case "upright":
      return "up";
    case "left":
      return "left";
    case "right":
      return "right";
    default:
      return "down"; // safe fallback
  }
}