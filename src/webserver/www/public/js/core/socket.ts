import.meta.hot.accept;
import { config } from "../web/global.js";
const socket = new WebSocket(config.WEBSOCKET_URL || "ws://localhost:3000");
const version = config?.VERSION;
import "./events.ts";
import pako from "../libs/pako.js";
import packet from "./packetencoder.ts";
import Cache from "./cache.ts";
import { updateTime } from "./ambience.ts";
import { setWeatherType } from "./renderer.ts";
const cache = Cache.getInstance();
import { createPlayer } from "./player.ts";
import { updateFriendsList } from "./friends.ts";
import { createInvitationPopup } from "./invites.ts";
import { updateFriendOnlineStatus } from "./friends.js";
import loadMap from "./map.ts";
import {
  createPartyUI,
  updatePartyMemberStats,
  positionText,
  fpsSlider,
  musicSlider,
  effectsSlider,
  mutedCheckbox,
  statUI,
  packetsSentReceived,
  onlinecount,
  progressBarContainer,
  inventoryGrid,
  chatMessages,
  healthLabel,
  manaLabel,
  notificationContainer,
  notificationMessage,
  collectablesUI,
  castSpell,
  spellBookUI,
  loadHotbarConfiguration,
  hotbarSlots,
} from "./ui.ts";
import { playAudio, playMusic } from "./audio.ts";
import { updateXp } from "./xp.ts";
import { createNPC } from "./npc.ts";
import parseAPNG from "../libs/apng_parser.js";
import { getCookie } from "./cookies.ts";
socket.binaryType = "arraybuffer";
let sentRequests: number = 0,
  receivedResponses: number = 0;

let clearNotificationTimeout: any = null;

function sendRequest(data: any) {
  sentRequests++;
  socket.send(packet.encode(JSON.stringify(data)));
}

let cachedPlayerId: string | null = null;
let sessionActive: boolean = false;

let snapshotRevision: number | null = null;
let snapshotApplied: boolean = false;
let movementUpdateBuffer: Array<{id: string, data: any, revision: number}> = [];
let animationUpdateBuffer: Array<{id: string, name: string, data: any, revision: number}> = [];

socket.onopen = () => {
  cache.players.clear();
  sessionActive = false;
  cachedPlayerId = null;

  snapshotRevision = null;
  snapshotApplied = false;
  movementUpdateBuffer = [];
  animationUpdateBuffer = [];

  sendRequest({
    type: "PING",
    data: null,
  });
};

socket.onclose = (ev: CloseEvent) => {
  // Remove the loading bar if it exists
  progressBarContainer.style.display = "none";
  showNotification(
    `You have been disconnected from the server: ${ev.code}`,
    false,
    true
  );
};

socket.onerror = (ev: Event) => {
  progressBarContainer.style.display = "none";
  showNotification(
    `An error occurred while connecting to the server: ${ev.type}`,
    false,
    true
  );
};

socket.onmessage = async (event) => {
  receivedResponses++;
  if (!(event.data instanceof ArrayBuffer)) return;
  const data = JSON.parse(packet.decode(event.data))["data"];
  const type = JSON.parse(packet.decode(event.data))["type"];

  switch (type) {
    case "SERVER_TIME": {
      sendRequest({ type: "TIME_SYNC" });
      if (!data) return;
      updateTime(data);
      break;
    }
    case "CAST_SPELL": {
      if (!data || !data.spell || (!data.time && data.time !== 0) || !data.id) return;
      castSpell(data.id, data.spell, data.time);
      break;
    }
    case "PROJECTILE": {
      const player_id = data?.id;
      const target_player_id = data?.target_id;
      const time_to_travel = data?.time;
      const spell = data?.spell;
      const icon = data?.icon;

      if (!player_id || !target_player_id || !time_to_travel) break;

      // Find source and target players
      const sourcePlayer = Array.from(cache.players).find(p => p.id === player_id);
      const targetPlayer = Array.from(cache.players).find(p => p.id === target_player_id);

      if (!sourcePlayer || !targetPlayer) break;

      // Decompress and cache icon if provided and not already cached (same as mount icons)
      if (icon && spell && !cache.projectileIcons.has(spell)) {
        // Check if icon has the correct structure
        if (!icon.data || !Array.isArray(icon.data)) break;

        try {
          // @ts-expect-error - pako is loaded in index.html
          const inflatedData = pako.inflate(
            new Uint8Array(icon.data),
            { to: "string" }
          );
          const iconImage = new Image();
          iconImage.src = `data:image/png;base64,${inflatedData}`;

          // Wait for image to load before caching
          iconImage.onload = () => {
            cache.projectileIcons.set(spell, iconImage);
          };

          iconImage.onerror = (error) => {
            console.error(`Failed to load projectile icon for ${spell}:`, error);
          };
        } catch (error) {
          console.error(`Failed to decompress projectile icon for ${spell}:`, error);
        }
      }

      // Create projectile that follows the target player
      cache.projectiles.push({
        startX: sourcePlayer.position.x,
        startY: sourcePlayer.position.y,
        targetPlayerId: target_player_id,
        currentX: sourcePlayer.position.x,
        currentY: sourcePlayer.position.y,
        startTime: performance.now(),
        duration: time_to_travel * 1000, // Convert to milliseconds
        spell: spell || 'unknown'
      });

      break;
    }
    case "WEATHER": {
      if (!data || !data.weather) return;
      setWeatherType(data.weather);
      break;
    }
    case "CONSOLE_MESSAGE": {
      if (!data || !data.message) return;
      window.Notify(data.type, data.message);
      break;
    }
    case "TOGGLE_TILE_EDITOR": {
      // Import and toggle tile editor
      import('./tileeditor.js').then((module) => {
        module.default.toggle();
      });
      break;
    }
    case "RELOAD_CHUNKS": {
      // Reload all visible chunks to reflect map changes
      if (window.mapData && window.mapData.loadedChunks) {
        const chunksToReload: Array<{x: number, y: number}> = [];
        window.mapData.loadedChunks.forEach((chunk: any, key: string) => {
          const [x, y] = key.split('-').map(Number);
          chunksToReload.push({ x, y });
        });

        // Clear loaded chunks and reload them
        window.mapData.loadedChunks.clear();

        // Reload each chunk
        chunksToReload.forEach(async (pos) => {
          await window.mapData.requestChunk(pos.x, pos.y);
        });
      }
      break;
    }
    case "UPDATE_CHUNKS": {
      // Clear and reload specific chunks that were modified
      if (window.mapData && window.mapData.loadedChunks && data) {
        const chunksToUpdate = data as Array<{chunkX: number, chunkY: number}>;

        // Import clearChunkFromCache function
        import("./map.js").then(({ clearChunkFromCache }) => {
          chunksToUpdate.forEach((chunkCoord: {chunkX: number, chunkY: number}) => {
            const chunkKey = `${chunkCoord.chunkX}-${chunkCoord.chunkY}`;

            // Clear from localStorage cache
            clearChunkFromCache(window.mapData.name, chunkCoord.chunkX, chunkCoord.chunkY);

            // Remove the chunk from memory cache
            if (window.mapData.loadedChunks.has(chunkKey)) {
              window.mapData.loadedChunks.delete(chunkKey);

              // Request the chunk again to reload it with updated data
              window.mapData.requestChunk(chunkCoord.chunkX, chunkCoord.chunkY);
            }
          });
        });
      }
      break;
    }
    case "COLLISION_DEBUG": {
      if (!data || data.tileX === undefined || data.tileY === undefined) return;
      // Store collision tile for rendering
      if (!(window as any).collisionTiles) {
        (window as any).collisionTiles = [];
      }
      (window as any).collisionTiles.push({ x: data.tileX, y: data.tileY, time: Date.now() });
      // Keep only last 10 collision tiles
      if ((window as any).collisionTiles.length > 10) {
        (window as any).collisionTiles.shift();
      }
      break;
    }
    case "INVITATION": {
      // Show the invitation modal
      createInvitationPopup(data);
      break;
    }
    case "UPDATE_FRIENDS": {
      const currentPlayer = cache.players.size
        ? Array.from(cache.players).find((p) => p.id === cachedPlayerId)
        : null;
      if (currentPlayer) {
        currentPlayer.friends = data.friends || [];
        updateFriendsList(data);
      }
      break;
    }
    case "UPDATE_ONLINE_STATUS": {
      updateFriendOnlineStatus(data.username, data.online);
      break;
    }
    case "UPDATE_PARTY": {
      const currentPlayer = cache.players.size
        ? Array.from(cache.players).find((p) => p.id === cachedPlayerId)
        : null;
      if (currentPlayer) {
        currentPlayer.party = data.members || [];
        createPartyUI(currentPlayer.party, Array.from(cache.players));
      }
      break;
    }
    case "ANIMATION": {
      try {
        if (!data?.name || !data?.data) return;

        if (!snapshotApplied && data.revision !== undefined) {
          animationUpdateBuffer.push({
            id: data.id,
            name: data.name,
            data: data.data,
            revision: data.revision
          });
          break;
        }

        let apng: any;
        const cachedData = cache.animations.get(data.name);

        if (cachedData instanceof Uint8Array) {
          apng = parseAPNG(cachedData);
        } else {
          // Check IndexedDB
          const dbData = await getAnimationFromDB(data.name);
          if (dbData) {
            cache.animations.set(data.name, dbData);
            apng = parseAPNG(dbData);
          } else {
            // @ts-expect-error - pako is loaded globally
            const inflated = pako.inflate(new Uint8Array(data.data.data));
            if (!inflated) {
              console.warn(`[ANIMATION] Inflation failed for: ${data.name}`);
              return;
            }

            cache.animations.set(data.name, inflated);
            await saveAnimationToDB(data.name, inflated);
            apng = parseAPNG(inflated);
          }
        }

        if (!(apng instanceof Error) && cache.players) {
          const findPlayer = async () => {
            const player = cache.players.size
              ? Array.from(cache.players).find((p) => p.id === data.id)
              : null;
            if (player) {
              // Preload all images before switching animation
              if (apng.frames && apng.frames.length > 0) {
                // Create images for all frames
                apng.frames.forEach((frame: any) => frame.createImage());

                // Wait for all images to load
                await Promise.all(
                  apng.frames.map((frame: any) => {
                    return new Promise<void>((resolve) => {
                      if (frame.imageElement?.complete) {
                        resolve();
                      } else if (frame.imageElement) {
                        frame.imageElement.onload = () => resolve();
                        frame.imageElement.onerror = () => resolve(); // Resolve even on error to prevent hanging
                      } else {
                        resolve();
                      }
                    });
                  })
                );
              }

              // Now assign the animation with all images preloaded
              player.animation = {
                frames: apng.frames,
                currentFrame: 0,
                lastFrameTime: performance.now(),
              };
            } else {
              await new Promise((resolve) => setTimeout(resolve, 100));
              await findPlayer();
            }
          };

          findPlayer().catch((err) =>
            console.error("Error in findPlayer:", err)
          );
        }
      } catch (error) {
        console.error("Failed to process animation data:", error);
      }
      break;
    }
    case "PONG":
      sendRequest({
        type: "LOGIN",
        data: null,
      });
      break;
    case "CONNECTION_COUNT": {
      onlinecount.innerText = `${data} online`;
      break;
    } 
    case "SPAWN_PLAYER": {
      // Reject spawn packets if session is not yet authenticated
      if (!sessionActive || !cachedPlayerId) {
        break;
      }

      await isLoaded();

      // Remove any existing player with the same username/userid (handles reconnects/refreshes)
      const existingByUsername = Array.from(cache.players).find(
        (p) => p.username === data.username && p.userid === data.userid
      );
      if (existingByUsername) {
        cache.players.delete(existingByUsername);
      }

      createPlayer(data);
      break;
    }
    case "RECONNECT": {
      window.location.reload();
      break;
    }
    case "LOAD_PLAYERS": {
      // Reject load players if session is not yet authenticated
      if (!sessionActive || !cachedPlayerId) {
        break;
      }

      await isLoaded();
      if (!data) return;

      const players = data.players || data;
      snapshotRevision = data.snapshotRevision ?? null;
      (Array.isArray(players) ? players : []).forEach((player: any) => {
        if (player.id != cachedPlayerId) {
          // Check if player already exists by username/userid (not just ID)
          const existingByUsername = Array.from(cache.players).find(
            (p) => p.username === player.username && p.userid === player.userid
          );

          if (!existingByUsername) {
            createPlayer(player);
          }
        }
      });

      snapshotApplied = true;

      const bufferedUpdates = movementUpdateBuffer
        .filter(update => snapshotRevision === null || update.revision > snapshotRevision)
        .sort((a, b) => a.revision - b.revision);

      bufferedUpdates.forEach(update => {
        const player = Array.from(cache.players).find(p => p.id === update.id);
        if (player) {
          player.position.x = update.data.x;
          player.position.y = update.data.y;
          player.typing = false;
        }
      });

      movementUpdateBuffer = [];

      const bufferedAnimations = animationUpdateBuffer
        .filter(update => snapshotRevision === null || update.revision > snapshotRevision)
        .sort((a, b) => a.revision - b.revision);

      for (const update of bufferedAnimations) {
        const player = Array.from(cache.players).find(p => p.id === update.id);
        if (player) {
          try {
            let apng: any;
            const cachedData = cache.animations.get(update.name);

            if (cachedData instanceof Uint8Array) {
              apng = parseAPNG(cachedData);
            } else {
              // Check IndexedDB
              const dbData = await getAnimationFromDB(update.name);
              if (dbData) {
                cache.animations.set(update.name, dbData);
                apng = parseAPNG(dbData);
              } else {
                // @ts-expect-error - pako is loaded globally
                const inflated = pako.inflate(new Uint8Array(update.data.data));
                if (inflated) {
                  cache.animations.set(update.name, inflated);
                  await saveAnimationToDB(update.name, inflated);
                  apng = parseAPNG(inflated);
                }
              }
            }

            if (!(apng instanceof Error)) {
              // Preload all images
              if (apng.frames && apng.frames.length > 0) {
                apng.frames.forEach((frame: any) => frame.createImage());
                await Promise.all(
                  apng.frames.map((frame: any) => {
                    return new Promise<void>((resolve) => {
                      if (frame.imageElement?.complete) {
                        resolve();
                      } else if (frame.imageElement) {
                        frame.imageElement.onload = () => resolve();
                        frame.imageElement.onerror = () => resolve();
                      } else {
                        resolve();
                      }
                    });
                  })
                );
              }

              player.animation = {
                frames: apng.frames,
                currentFrame: 0,
                lastFrameTime: performance.now(),
              };
            }
          } catch (error) {
            console.error("Failed to process buffered animation:", error);
          }
        }
      }

      animationUpdateBuffer = [];

      break;
    }
    case "DISCONNECT_MALIFORMED": {
      if (!data) return;
      const arrayToDisconnect = Array.isArray(data) ? data : [data];
      arrayToDisconnect.forEach((playerData) => {
        const player = Array.from(cache.players).find(
          (player) => player.id === playerData.id
        );
        if (player) {
          cache.players.delete(player);
        }
      });
      break;
    }
    case "DISCONNECT_PLAYER": {
      if (!data || !data.id || !data.username) return;

      updateFriendOnlineStatus(data.username, false);

      // Remove player from the array
      const player = Array.from(cache.players).find(
        (player) => player.id === data.id
      );
      if (player) {
        cache.players.delete(player);
      }
      // If they were targeted, hide target stats
      // if (wasTargeted) {
      //   displayElement(targetStats, false);
      // }
      break;
    }
    case "MOVEXY": {
      if (data._data === "abort") {
        break;
      }

      if (!snapshotApplied && data.revision !== undefined) {
        movementUpdateBuffer.push({
          id: data.id,
          data: data._data,
          revision: data.revision
        });
        break;
      }

      const player = Array.from(cache.players).find(
        (player) => player.id === data.id
      );
      if (!player) return;

      player.typing = false;

      player.position.x = data._data.x;
      player.position.y = data._data.y;

      if (data.id === cachedPlayerId) {
        positionText.innerText = `Position: ${data._data.x}, ${data._data.y}`;
      }
      break;
    }
    case "CREATE_NPC": {
      await isLoaded();
      if (!data) return;
      createNPC(data);
      break;
    }
    case "LOAD_MAP":
      {
        loaded = await loadMap(data);
      }
      break;
    case "LOGIN_SUCCESS":
      {
        const connectionId = JSON.parse(packet.decode(event.data))["data"];
        const chatDecryptionKey = JSON.parse(packet.decode(event.data))[
          "chatDecryptionKey"
        ];
        sessionStorage.setItem("connectionId", connectionId);
        cachedPlayerId = connectionId;
        sessionActive = true;

        cache.players.clear();

        snapshotRevision = null;
        snapshotApplied = false;
        movementUpdateBuffer = [];
        animationUpdateBuffer = [];

        const sessionToken = getCookie("token");
        if (!sessionToken) {
          window.location.href = "/game";
          return;
        }

        // Store public key
        sessionStorage.setItem("chatDecryptionKey", chatDecryptionKey);

        const language =
          navigator.language.split("-")[0] || navigator.language || "en";
        sendRequest({
          type: "AUTH",
          data: sessionToken,
          language,
        });
      }
      break;
    case "LOGIN_FAILED":
      {
        window.location.href = "/";
      }
      break;
    case "SPELLS": {
      const data = JSON.parse(packet.decode(event.data))["data"];
      const slots = JSON.parse(packet.decode(event.data))["slots"];

      const grid = spellBookUI.querySelector("#grid");
      if (!grid) return;

      // Clear existing slots
      grid.querySelectorAll(".slot").forEach((slot) => {
        grid.removeChild(slot);
      });

      // Convert data object to array if needed
      const spellsArray = Array.isArray(data) ? data : Object.values(data);

      if (spellsArray.length > 0) {
        // Assign each spell to a slot
        for (let i = 0; i < spellsArray.length; i++) {
          const spell = spellsArray[i];

          // Create a new slot
          const slot = document.createElement("div");
          slot.classList.add("slot");
          slot.classList.add("ui");
          slot.classList.add("common");

          // Make slot draggable and store spell data
          slot.draggable = true;
          slot.dataset.spellName = spell.name || Object.keys(data)[i] || 'Unknown';

          // Add icon if available
          if (spell.sprite?.data) {
            // @ts-expect-error - pako is loaded in index.html
            const inflatedData = pako.inflate(
              new Uint8Array(spell.sprite.data),
              { to: "string" }
            );
            const iconImage = new Image();
            iconImage.src = `data:image/png;base64,${inflatedData}`;
            // Scale to 32x32
            iconImage.width = 32;
            iconImage.height = 32;
            iconImage.draggable = false;
            iconImage.onload = () => {
              slot.appendChild(iconImage);
            };
          } else {
            // Fallback if no icon
            slot.innerHTML = `${spell.name || Object.keys(data)[i] || 'Unknown'}`;
          }

          // Add dragstart event
          slot.addEventListener("dragstart", (event: DragEvent) => {
            if (event.dataTransfer) {
              event.dataTransfer.effectAllowed = "copy";
              event.dataTransfer.setData("text/plain", slot.dataset.spellName || '');
              // Store the icon data for the drop
              const iconImg = slot.querySelector('img');
              if (iconImg) {
                event.dataTransfer.setData("image/src", iconImg.src);
              }
            }
          });

          // Add click event to cast spell
          slot.addEventListener("click", () => {
            const target = Array.from(cache?.players).find(p => p?.targeted) || null;
            sendRequest({
              type: "HOTBAR",
              data: {
                spell: slot.dataset.spellName,
                target
              }
            });
          });

          grid.appendChild(slot);
        }
      }

      // Create empty slots for remaining space
      const totalSlots = slots || 20; // Default to 20 if slots not provided
      for (let i = spellsArray.length; i < totalSlots; i++) {
        const slot = document.createElement("div");
        slot.classList.add("slot");
        slot.classList.add("empty");
        slot.classList.add("ui");
        grid.appendChild(slot);
      }

      // Populate hotbar slots with icons if they have spell names configured
      hotbarSlots.forEach((hotbarSlot) => {
        const spellName = hotbarSlot.dataset.spellName;
        if (spellName) {

          // Find matching spell in the spellsArray
          const matchingSpell = spellsArray.find((spell: any) =>
            (spell.name || '') === spellName
          );

          if (matchingSpell && matchingSpell.sprite?.data) {

            // @ts-expect-error - pako is loaded in index.html
            const inflatedData = pako.inflate(
              new Uint8Array(matchingSpell.sprite.data),
              { to: "string" }
            );
            const iconImage = new Image();
            iconImage.src = `data:image/png;base64,${inflatedData}`;
            iconImage.width = 32;
            iconImage.height = 32;
            iconImage.draggable = false;

            // Clear and add icon
            hotbarSlot.innerHTML = "";
            hotbarSlot.classList.remove("empty");
            iconImage.onload = () => {
              hotbarSlot.appendChild(iconImage);
            };
          }
        }
      });

      break;
    }
    case "COLLECTABLES":
      {
        const data = JSON.parse(packet.decode(event.data))["data"];
        const slots = JSON.parse(packet.decode(event.data))["slots"];

        const grid = collectablesUI.querySelector("#grid");
        if (!grid) return;

        // Clear existing slots
        grid.querySelectorAll(".slot").forEach((slot) => {
          grid.removeChild(slot);
        });

        if (data.length > 0) {
          // Assign each collectable to a slot
          for (let i = 0; i < data.length; i++) {
            // Create a new slot
            const slot = document.createElement("div");
            slot.classList.add("slot");
            slot.classList.add("ui");
            slot.classList.add("epic");
            // Add icon if available
            if (data[i].icon) {
              // @ts-expect-error - pako is loaded in index.html
              const inflatedData = pako.inflate(
                new Uint8Array(data[i].icon.data),
                { to: "string" }
              );
              const iconImage = new Image();
              iconImage.src = `data:image/png;base64,${inflatedData}`;
              // Scale to 32x32
              iconImage.width = 32;
              iconImage.height = 32;
              iconImage.draggable = false;
              iconImage.onload = () => {
                slot.appendChild(iconImage);
              };
              // Add event listener to summon mount on click
              slot.addEventListener("click", () => {
                // Mounts
                if (data[i].type === "mount") {
                  cache.mount = data[i].item;
                  sendRequest({
                    type: "MOUNT",
                    data: { mount: data[i].item},
                  });
                }
              });
              grid.appendChild(slot);
            } else {
              slot.innerHTML = `${data[i].item}`;
              grid.appendChild(slot);
            }
          }
        }

        // Create empty slots for remaining space
        for (let i = 0; i < slots - data.length; i++) {
          const slot = document.createElement("div");
          slot.classList.add("slot");
          slot.classList.add("empty");
          slot.classList.add("ui");
          grid.appendChild(slot);
        }
        break;
      }
    case "EQUIPMENT": {
      const data = JSON.parse(packet.decode(event.data))["data"];
      console.log("Equipment data received:", data);
      break;
    }
    case "INVENTORY":
      {
        const data = JSON.parse(packet.decode(event.data))["data"];
        const slots = JSON.parse(packet.decode(event.data))["slots"];
        // Clear existing slots
        inventoryGrid.querySelectorAll(".slot").forEach((slot) => {
          inventoryGrid.removeChild(slot);
        });
        if (data.length > 0) {
          // Assign each item to a slot
          for (let i = 0; i < data.length; i++) {
            // Create a new item slot
            const slot = document.createElement("div");
            slot.classList.add("slot");
            slot.classList.add("ui");
            const item = data[i];
            // If item is equipped, don't show it in inventory

            // TODO: Show in equipment viewer instead
            if (item.equipped) {
              slot.classList.add("empty");
              inventoryGrid.appendChild(slot);
              continue;
            }

            slot.classList.add(item.quality.toLowerCase() || "empty");

            if (item.icon) {
              // @ts-expect-error - pako is loaded in index.html
              const inflatedData = pako.inflate(
                new Uint8Array(item.icon.data),
                { to: "string" }
              );
              const iconImage = new Image();
              iconImage.src = `data:image/png;base64,${inflatedData}`;
              iconImage.draggable = false;
              // Scale to 32x32
              iconImage.width = 32;
              iconImage.height = 32;
              iconImage.onload = () => {
                slot.appendChild(iconImage);
              };
              // Overlay item quantity if greater than 1
              if (item.quantity > 1) {
                const quantityLabel = document.createElement("div");
                quantityLabel.classList.add("quantity-label");
                quantityLabel.innerText = `x${item.quantity}`;
                slot.appendChild(quantityLabel);
              }
              // If data.type is equipment, add click event to equip item
                if (item.type === "equipment") {
                slot.addEventListener("dblclick", () => {
                  sendRequest({
                    type: "EQUIP_ITEM",
                    data: { item: item.name },
                  });
                });
              }
              inventoryGrid.appendChild(slot);
            } else {
              slot.innerHTML = `${item.item}${
                item.quantity > 1 ? `<br>x${item.quantity}` : ""
              }`;
              inventoryGrid.appendChild(slot);
            }
          }
        }

        for (let i = 0; i < slots - data.length; i++) {
          const slot = document.createElement("div");
          slot.classList.add("slot");
          slot.classList.add("empty");
          slot.classList.add("ui");
          inventoryGrid.appendChild(slot);
        }
      }
      break;
    case "QUESTLOG": {
      // const data = JSON.parse(packet.decode(event.data))["data"];
      break;
    }
    case "QUESTDETAILS": {
      // const data = JSON.parse(packet.decode(event.data))["data"];
      break;
    }
    case "CHAT": {
      cache.players.forEach((player) => {
        if (player.id === data.id) {
          // Escape HTML tags before setting chat message
          player.chat = data.message;
          player.chatType = "normal"; // Set chat type to normal
          // Username with first letter uppercase
          const username =
            data?.username?.charAt(0)?.toUpperCase() + data?.username?.slice(1);
          const timestamp = new Date().toLocaleTimeString();
          // Update chat box
          if (data.message?.trim() !== "" && username) {
            const message = document.createElement("div");
            message.classList.add("message");
            message.classList.add("ui");
            message.style.userSelect = "text";
            // Escape HTML in the message before inserting
            const escapedMessage = data.message
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;");
            message.innerHTML = `<span>${timestamp} <span ${player.isAdmin ? "class='admin'" : "class='user'"}>${username}: </span><span>${escapedMessage.toString()}</span></span>`;
            chatMessages.appendChild(message);
            // Scroll to the bottom of the chat messages
            chatMessages.scrollTop = chatMessages.scrollHeight;
            // Set typing to false
            player.typing = false;
          }
        }
      });
      break;
    }
    case "TYPING": {
      cache.players.forEach((player) => {
        if (player.id === data.id) {
          player.typing = true;
          // Clear any existing timeout for this player
          if (player.typingTimeout) {
            clearTimeout(player.typingTimeout);
          }
          // Set typing to false after 5 seconds
          player.typingTimeout = setTimeout(() => {
            player.typing = false;
          }, 3000);
        }
      });
      break;
    }
    case "STOPTYPING": {
      cache.players.forEach((player) => {
        if (player.id === data.id) {
          player.typing = false;
        }
      });
      break;
    }
    case "NPCDIALOG": {
      const npc = cache.npcs.find((npc) => npc.id === data.id);
      if (!npc) return;
      npc.dialog = data.dialog;
      break;
    }
    case "STATS": {
      const player = Array.from(cache.players).find(
        (player) => player.id === data.id
      );
      if (!player) return;
      updateXp(data.xp, data.level, data.max_xp);
      player.stats = data;
      player.max_health = data.total_max_health;
      player.max_stamina = data.total_max_stamina;
      console.log(`Stats updated for player ${player.username}:`, data);

      // Update party member UI if this player is in the party
      const currentPlayer = Array.from(cache.players).find(
        (p) => p.id === cachedPlayerId
      );
      if (currentPlayer?.party?.includes(player.username)) {
        updatePartyMemberStats(
          player.username,
          data.health,
          data.total_max_health,
          data.stamina,
          data.total_max_stamina
        );
      }
      break;
    }
    case "CLIENTCONFIG": {
      const data = JSON.parse(packet.decode(event.data))["data"][0];
      fpsSlider.value = data.fps;
      document.getElementById(
        "limit-fps-label"
      )!.innerText = `FPS: (${fpsSlider.value})`;
      musicSlider.value = data.music_volume || 0;
      document.getElementById(
        "music-volume-label"
      )!.innerText = `Music: (${musicSlider.value})`;
      effectsSlider.value = data.effects_volume || 0;
      document.getElementById(
        "effects-volume-label"
      )!.innerText = `Effects: (${effectsSlider.value})`;
      mutedCheckbox.checked = data.muted;
      document.getElementById(
        "muted-checkbox"
      )!.innerText = `Muted: ${mutedCheckbox.checked}`;

      // Load hotbar configuration (async)
      if (data.hotbar_config) {
        loadHotbarConfiguration(data.hotbar_config).catch(err =>
          console.error('Failed to load hotbar configuration:', err)
        );
      }
      break;
    }
    case "SELECTPLAYER": {
      const data = JSON.parse(packet.decode(event.data))["data"];

      if (!data || !data.id || !data.username) {
        const target = Array.from(cache.players).find((p) => p.targeted);
        if (target) target.targeted = false;
        //displayElement(targetStats, false);
        break;
      }

      cache.players.forEach((player) => {
        player.targeted = player.id === data.id;
      });

      // displayElement(targetStats, true);
      break;
    }
    case "STEALTH": {
      const data = JSON.parse(packet.decode(event.data))["data"];
      const currentPlayer = Array.from(cache.players).find(
        (player) => player.id === cachedPlayerId || player.id === cachedPlayerId
      );

      // Abort movement if self
      if (currentPlayer && data.id === currentPlayer.id) {
        sendRequest({
          type: "MOVEXY",
          data: "ABORT",
        });
      }

      cache.players.forEach((player) => {
        if (player.id === data.id) {
          player.isStealth = data.isStealth;
        }

        // Untarget stealthed players
        if (player.isStealth && player.targeted) {
          player.targeted = false;
          //displayElement(targetStats, false);
        }
      });

      break;
    }
    case "UPDATESTATS": {
      const { target, stats, isCrit, username, damage } = JSON.parse(packet.decode(event.data))["data"];
      const t = Array.from(cache.players).find(
        (player) => player.id === target
      );

      // Get current player for party check
      const currentPlayer = Array.from(cache.players).find(
        (player) => player.id === cachedPlayerId
      );

      if (t) {
        // Track health change for damage numbers
        const oldHealth = t.stats.health;
        const newHealth = stats.health;
        const healthDiff = newHealth - oldHealth;

        // Check if this is a revive scenario
        const isRevive = oldHealth <= 0 || (newHealth === stats.total_max_health && healthDiff > stats.total_max_health * 0.5);

        // Show damage/heal numbers if health changed
        if (healthDiff !== 0 && newHealth > 0 && oldHealth > 0 && !isRevive) {
          // Add slight random offset so multiple damage numbers don't overlap
          const randomOffsetX = (Math.random() - 0.5) * 20;
          const randomOffsetY = (Math.random() - 0.5) * 10;

          t.damageNumbers.push({
            value: Math.abs(healthDiff),
            x: t.position.x + randomOffsetX,
            y: t.position.y - 30 + randomOffsetY, // Start above player's head
            startTime: performance.now(),
            isHealing: healthDiff > 0,
            isCrit: isCrit || false,
            isMiss: false,
          });
        } else if (damage === 0 && newHealth > 0 && oldHealth > 0 && !isRevive) {
          // Show "Miss" when incoming damage is exactly 0 (avoided)
          const randomOffsetX = (Math.random() - 0.5) * 20;
          const randomOffsetY = (Math.random() - 0.5) * 10;

          t.damageNumbers.push({
            value: 0,
            x: t.position.x + randomOffsetX,
            y: t.position.y - 30 + randomOffsetY,
            startTime: performance.now(),
            isHealing: false,
            isCrit: false,
            isMiss: true,
          });
        }

        t.stats = stats;
        t.max_health = stats.total_max_health;
        t.max_stamina = stats.total_max_stamina;

        // Update party member UI if this player is in the party
        if (currentPlayer?.party?.includes(t.username)) {
          updatePartyMemberStats(
            t.username,
            stats.health,
            stats.total_max_health,
            stats.stamina,
            stats.total_max_stamina
          );
        }
      } else if (username && currentPlayer?.party?.includes(username)) {
        // Player not in visible cache but is a party member and we have their username
        // Update their party frame directly
        updatePartyMemberStats(
          username,
          stats.health,
          stats.total_max_health,
          stats.stamina,
          stats.total_max_stamina
        );
      }
      break;
    }
    case "REVIVE": {
      const data = JSON.parse(packet.decode(event.data))["data"];
      const target = Array.from(cache.players).find(
        (player) => player.id === data.target
      );
      if (!target) return;

      target.stats = data.stats;
      target.max_health = data.stats.total_max_health;
      target.max_stamina = data.stats.total_max_stamina;

      const isSelf = target.id.toString() === cachedPlayerId;

      if (!isSelf) {
        target.targeted = false;
      }

      //displayElement(targetStats, false);
      cache.players.forEach((player) => (player.targeted = false));

      // Update party member UI if this player is in the party
      const currentPlayer = Array.from(cache.players).find(
        (player) => player.id === cachedPlayerId
      );
      if (currentPlayer?.party?.includes(target.username)) {
        updatePartyMemberStats(
          target.username,
          data.stats.health,
          data.stats.total_max_health,
          data.stats.stamina,
          data.stats.total_max_stamina
        );
      }
      break;
    }
    case "UPDATE_XP": {
      const data = JSON.parse(packet.decode(event.data))["data"];
      // Only update the xp bar if the current player is the target
      if (data.id === cachedPlayerId) {
        updateXp(data.xp, data.level, data.max_xp);
      }
      break;
    }
    case "AUDIO": {
      const name = JSON.parse(packet.decode(event.data))["name"];
      const data = JSON.parse(packet.decode(event.data))["data"];
      const pitch = JSON.parse(packet.decode(event.data))["pitch"] || 1;
      const timestamp = JSON.parse(packet.decode(event.data))["timestamp"];
      playAudio(name, data.data.data, pitch, timestamp);
      break;
    }
    case "MUSIC": {
      const data = JSON.parse(packet.decode(event.data))["data"];
      const name = data.name;
      await playMusic(name);
      break;
    }
    case "INSPECTPLAYER": {
      const data = JSON.parse(packet.decode(event.data))["data"];
      // Add the player ID as an attribute to the target stats container
      statUI.setAttribute("data-id", data.id);
      healthLabel!.innerText = `Health: (${data.stats.health})`;
      manaLabel!.innerText = `Mana: (${data.stats.stamina})`;
      statUI.style.transition = "1s";
      statUI.style.left = "10";
      break;
    }
    case "NOTIFY": {
      const data = JSON.parse(packet.decode(event.data))["data"];
      showNotification(data.message, true, false);
      break;
    }
    case "WHISPER": {
      const data = JSON.parse(packet.decode(event.data))["data"];
      // Escape HTML tags before setting chat message
      const escapedMessage = data.message
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      const timestamp = new Date().toLocaleTimeString();
      // Update chat box
      if (data.message?.trim() !== "" && data.username) {
        const message = document.createElement("div");
        message.classList.add("message");
        message.classList.add("ui");
        message.style.userSelect = "text";
        // Username with first letter uppercase
        const username =
          data?.username?.charAt(0)?.toUpperCase() + data?.username?.slice(1);
        message.innerHTML = `<span>${timestamp} <span class="whisper-username">${username}:</span> <span class="whisper-message">${escapedMessage}</span></span>`;
        chatMessages.appendChild(message);
        // Scroll to the bottom of the chat messages
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }
      break;
    }
    case "PARTY_CHAT": {
      const data = JSON.parse(packet.decode(event.data))["data"];
      // Escape HTML tags before setting chat message
      const escapedMessage = data.message
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      const timestamp = new Date().toLocaleTimeString();

      // Set overhead chat for party members
      cache.players.forEach((player) => {
        if (player.id === data.id) {
          player.chat = data.message;
          player.chatType = "party";

          // Set timeout to clear party chat
          setTimeout(() => {
            const currentPlayer = Array.from(cache.players).find(p => p.id === data.id);
            if (currentPlayer?.chat === data.message && currentPlayer?.chatType === "party") {
              currentPlayer.chat = "";
              currentPlayer.chatType = "global";
            }
          }, 7000 + data.message.length * 35);
        }
      });

      // Update chat box
      if (data.message?.trim() !== "" && data.username) {
        const message = document.createElement("div");
        message.classList.add("message");
        message.classList.add("ui");
        message.style.userSelect = "text";
        // Username with first letter uppercase
        const username =
          data?.username?.charAt(0)?.toUpperCase() + data?.username?.slice(1);
        message.innerHTML = `<span>${timestamp} <span class="party-username">${username}:</span> <span class="party-message">${escapedMessage}</span></span>`;
        chatMessages.appendChild(message);
        // Scroll to the bottom of the chat messages
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }
      break;
    }
    case "CURRENCY": {
      break;
    }
    default:
      break;
  }
};

// Create text on bottom right that displays the version at half opacity
if (version) {
  const versionText = document.createElement("div");
  versionText.style.position = "fixed";
  versionText.style.bottom = "5px";
  versionText.style.right = "10px";
  versionText.style.fontSize = "14px";
  versionText.style.color = "rgba(255, 255, 255, 0.5)";
  versionText.style.zIndex = "1000";
  versionText.style.userSelect = "none";
  versionText.innerText = `v${version}`;
  document.body.appendChild(versionText);
}

function showNotification(
  message: string,
  autoClose: boolean = true,
  reconnect: boolean = false
) {
  if (!notificationContainer || !notificationMessage) return;

  notificationMessage.innerText = message;
  notificationContainer.style.display = "flex";

  const baseTimeout = 5000; // Base timeout of 5 seconds
  const timePerChar = 100; // Additional time per character in milliseconds
  const timeout = baseTimeout + message.length * timePerChar;

  if (autoClose) {
    // Clear any existing timeout
    if (clearNotificationTimeout) {
      clearTimeout(clearNotificationTimeout);
    }
    clearNotificationTimeout = setTimeout(() => {
      if (!notificationContainer || !notificationMessage) return;
      notificationContainer.style.display = "none";
      // If reconnect is true, redirect after hiding notification
      if (reconnect) {
        if (window.navigator.userAgent === "@Electron/Frostfire-Forge-Client") {
          window.close(); // Close the Electron window
        } else {
          // If not in Electron, redirect to home page
          window.location.href = "/";
        }
      }
    }, timeout);
  } else if (reconnect) {
    // If not auto-closing but need to reconnect
    setTimeout(() => {
      if (window.navigator.userAgent === "@Electron/Frostfire-Forge-Client") {
        window.close(); // Close the Electron window
      } else {
        window.location.href = "/";
      }
    }, timeout);
  }
}

let loaded: boolean = false;

function getIsLoaded() {
  return loaded;
}

async function isLoaded() {
  // Check every second if the map is loaded
  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      if (loaded) {
        clearInterval(interval);

        resolve();
      }
    }, 10);
  });
}

setInterval(() => {
  if (
    packetsSentReceived.innerText ===
    `Sent: ${sentRequests}, Received: ${receivedResponses}`
  )
    return;
  packetsSentReceived.innerText = `Sent: ${sentRequests}, Received: ${receivedResponses}`;
  sentRequests = 0;
  receivedResponses = 0;
}, 1000);

// Utility IndexedDB wrapper
async function openAnimationDB() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("AnimationCache", 1);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains("animations")) {
        db.createObjectStore("animations");
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getAnimationFromDB(
  name: string
): Promise<Uint8Array | undefined> {
  const db = await openAnimationDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("animations", "readonly");
    const store = tx.objectStore("animations");
    const req = store.get(name);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveAnimationToDB(name: string, data: Uint8Array) {
  const db = await openAnimationDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction("animations", "readwrite");
    const store = tx.objectStore("animations");
    const req = store.put(data, name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export { sendRequest, cachedPlayerId, getIsLoaded };
