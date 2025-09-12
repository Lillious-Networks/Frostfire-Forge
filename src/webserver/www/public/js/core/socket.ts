import { config } from '../web/global.js';
const socket = new WebSocket(config.WEBSOCKET_URL || "ws://localhost:3000");
import './events.ts';
import pako from '../libs/pako.js';
import packet from './packetencoder.ts';
import Cache from "./cache";
const cache = Cache.getInstance();
import { createPlayer } from './player.ts';
import { updateFriendsList } from './friends.ts';
import { createInvitationPopup } from './invites.ts';
import { updateFriendOnlineStatus } from "./friends.js";
import { createPartyUI, canvas, positionText, fpsSlider,
  musicSlider, effectsSlider, mutedCheckbox, statUI, packetsSentReceived,
  onlinecount, progressBar, progressBarContainer, inventoryGrid, chatMessages,
  loadingScreen, healthLabel, manaLabel, notificationContainer, notificationMessage,
} from './ui.ts';
import { playAudio, playMusic } from './audio.ts';
import { updateXp } from './xp.ts';
import { createNPC } from './npc.ts';
import parseAPNG from '../libs/apng_parser.js';
import { getCookie } from './cookies.ts';
socket.binaryType = "arraybuffer";
let sentRequests: number = 0, receivedResponses: number = 0;

let clearNotificationTimeout: any = null;

function sendRequest(data: any) {
  sentRequests++;
  socket.send(packet.encode(JSON.stringify(data)));
}

let cachedPlayerId: string | null = null;

socket.onopen = () => {
  sendRequest({
    type: "PING",
    data: null,
  });
};

socket.onclose = () => {
  // Remove the loading bar if it exists
  progressBarContainer.style.display = 'none';
  showNotification("You have been disconnected from the server", false, true);
};

socket.onerror = () => {
  progressBarContainer.style.display = 'none';
  showNotification("An error occurred while connecting to the server", false, true);
};

socket.onmessage = async (event) => {
  receivedResponses++;
  if (!(event.data instanceof ArrayBuffer)) return;
  const data = JSON.parse(packet.decode(event.data))["data"];
  const type = JSON.parse(packet.decode(event.data))["type"];
  switch (type) {
    case "CONSOLE_MESSAGE": {
      if (!data || !data.message) return;
      window.Notify(data.type, data.message);
      break;
    }
    case "INVITATION": {
      // Show the invitation modal
      createInvitationPopup(data);
      break;
    }
    case "UPDATE_FRIENDS": {
        const currentPlayer = cache.players.find((player) => player.id === cachedPlayerId);
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
      const currentPlayer = cache.players.find((player) => player.id === cachedPlayerId);
      if (currentPlayer) {
        currentPlayer.party = data.members || [];
        createPartyUI(currentPlayer.party);
      }
      break;
    }
    case "ANIMATION": {
      let apng: any;
      try {
          if (cache.animations.has(data?.name)) {
              const inflatedData = cache.animations.get(data?.name)!;
              if (!inflatedData) return;
              apng = parseAPNG(inflatedData);
          } else {
              // @ts-expect-error - pako is not defined because it is loaded in the index.html
              const inflatedData = pako.inflate(new Uint8Array(data?.data?.data));
              if (!inflatedData) return;
              apng = parseAPNG(inflatedData.buffer);
              cache.animations.set(data.name, inflatedData.buffer);
          }

          if (!(apng instanceof Error) && cache.players) {
              const findPlayer = async () => {
                  const player = cache.players.find(p => p.id === data.id);
                  if (player) {
                      player.animation = {
                          frames: apng?.frames,
                          currentFrame: 0,
                          lastFrameTime: performance.now()
                      };
                      // Initialize the frames' images
                      if (apng.frames && apng.frames.length > 0) {
                        apng.frames.forEach((frame: any) => frame.createImage());
                      }
                  } else {
                      // Retry after a short delay
                      await new Promise(resolve => setTimeout(resolve, 100));
                      await findPlayer();
                  }
              };
              
              findPlayer().catch(err => console.error('Error in findPlayer:', err));
          }
      } catch (error) {
          console.error('Failed to process animation data:', error);
      }
      break;
    }
    case "PONG":
      sendRequest({
        type: "LOGIN",
        data: null,
      });
      break;

    case "TIME_SYNC": {
      setTimeout(async () => {
        sendRequest({
              type: "TIME_SYNC",
              data: data,
        });
      }, 5000);
      break;
    }
    case "CONNECTION_COUNT": {
      onlinecount.innerText = `${data} online`;
      break;
    }
    case "SPAWN_PLAYER": {
      await isLoaded();
      createPlayer(data);
      break;
    }
    case "RECONNECT": {
      window.location.reload();
      break;
    }
    case "LOAD_PLAYERS": {
      await isLoaded();
      if (!data) return;
      // Clear existing players that are not the current player
      cache.players.forEach((player, index) => {
        if (player.id !== cachedPlayerId) {
          cache.players.splice(index, 1);
        }
      });

      data.forEach((player: any) => {
        if (player.id != cachedPlayerId) {
          // Check if the player is already created and remove it
          cache.players.forEach((p, index) => {
            if (p.id === player.id) {
              cache.players.splice(index, 1);
            }
          });
          createPlayer(player);
        }
      });
      break;
    }
    case "DISCONNECT_PLAYER": {
      if (!data || !data.id || !data.username) return;

      console.log(`Player (${data.username}) ${data.id} disconnected`);
      updateFriendOnlineStatus(data.username, false);

      // Remove player from the array
      const index = cache.players.findIndex(player => player.id === data.id);
      if (index !== -1) {
        //const wasTargeted = players[index].targeted;

        cache.players.splice(index, 1); // Remove from array

        // If they were targeted, hide target stats
        // if (wasTargeted) {
        //   displayElement(targetStats, false);
        // }
      }

      break;
    }
    case "MOVEXY": {
      const player = cache.players.find((player) => player.id === data.id);
      if (!player) return;

      // Handle movement abort
      if (data._data === "abort") {
        break;
      }

      player.typing = false;

      // Smoothly update player position
      const targetX = canvas.width / 2 + data._data.x;
      const targetY = canvas.height / 2 + data._data.y;
      
      // Update position directly for non-client players
      if (data.id !== cachedPlayerId) {
        player.position.x = targetX;
        player.position.y = targetY;
      } else {
        // For the client player, update position directly to avoid input lag
        player.position.x = targetX;
        player.position.y = targetY;
        
        // Update position text
        positionText.innerText = `Position: ${data._data.x}, ${data._data.y}`;
      }
      break;
    }
    case "CREATE_NPC": {
      await isLoaded();
      if (!data) return;
      console.log("Creating NPC:", data);
      createNPC(data);
      break;
    }
    case "LOAD_MAP":
      {
        // @ts-expect-error - pako is not defined because it is loaded in the index.html
        const inflated = pako.inflate(new Uint8Array(new Uint8Array(data[0].data)), { to: "string" });
        const mapData = inflated ? JSON.parse(inflated) : null;
        const loadTilesets = async (tilesets: any[]) => {
            if (!tilesets?.length) throw new Error("No tilesets found");
            const tilesetPromises = tilesets.map(async (tileset) => {
                const name = tileset.image.split("/").pop();
                const tilesetResponse = await fetch(`/tileset?name=${name}`);
                if (!tilesetResponse.ok) {
                    throw new Error(`Failed to fetch tileset: ${name}`);
                }
                const tilesetData = await tilesetResponse.json();
                // @ts-expect-error - pako is not defined because it is loaded in the index.html
                const inflatedData = pako.inflate(new Uint8Array(tilesetData.tileset.data.data), { to: "string" });
                return new Promise<HTMLImageElement>((resolve, reject) => {
                    const image = new Image();
                    image.onload = () => resolve(image);
                    image.onerror = () => reject(new Error(`Failed to load tileset image: ${name}`));
                    image.src = `data:image/png;base64,${inflatedData}`;
                });
            });
            return Promise.all(tilesetPromises);
        };
        try {
            const images = await loadTilesets(mapData.tilesets);
            if (!images.length) throw new Error("No tileset images loaded");
            await drawMap(images);
        } catch (error) {
            console.error("Map loading failed:", error);
            throw error;
        }
        async function drawMap(images: HTMLImageElement[]): Promise<void> {
          return new Promise((resolve) => {
            const mapWidth = mapData.width * mapData.tilewidth;
            const mapHeight = mapData.height * mapData.tileheight;
            const CHUNK_SIZE = 25; 
            const chunkPixelSize = CHUNK_SIZE * mapData.tilewidth;
            canvas.width = mapWidth;
            canvas.height = mapHeight;
            canvas.style.width = mapWidth + "px";
            canvas.style.height = mapHeight + "px";
            canvas.style.display = "block";
            const mainCtx = canvas.getContext('2d', { willReadFrequently: false });
            if (!mainCtx) throw new Error("Could not get canvas context");
            mainCtx.imageSmoothingEnabled = false;
            const sortedLayers = [...mapData.layers].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
            const visibleTileLayers = sortedLayers.filter(layer => layer.visible && layer.type === "tilelayer");
            const chunksX = Math.ceil(mapData.width / CHUNK_SIZE);
            const chunksY = Math.ceil(mapData.height / CHUNK_SIZE);
            const totalChunks = chunksX * chunksY * visibleTileLayers.length;
            let processedChunks = 0;
            const chunkCanvases: {[key: string]: {[key: string]: HTMLCanvasElement | null}} = {};
            window.mapLayerCanvases = [];
            window.mapChunks = {
              chunksX,
              chunksY,
              chunkSize: CHUNK_SIZE,
              chunkPixelSize,
              layers: {},
              chunks: chunkCanvases,
              redrawMainCanvas: () => {
                mainCtx.clearRect(0, 0, mapWidth, mapHeight);
                const layerNames = Object.keys(window.mapChunks.layers).sort((a, b) => {
                  return (window.mapChunks.layers[a].zIndex || 0) - (window.mapChunks.layers[b].zIndex || 0);
                });
                for (const layerName of layerNames) {
                  const layer = window.mapChunks.layers[layerName];
                  if (!layer.visible) continue;
                  for (let chunkY = 0; chunkY < chunksY; chunkY++) {
                    for (let chunkX = 0; chunkX < chunksX; chunkX++) {
                      const chunkKey = `${chunkX}-${chunkY}`;
                      const chunkCanvas = chunkCanvases[layerName]?.[chunkKey];
                      if (chunkCanvas && layer.chunkVisibility?.[chunkKey] !== false) {
                        if (mainCtx) {
                          if (mainCtx) {
                            mainCtx.drawImage(
                              chunkCanvas,
                              chunkX * chunkPixelSize,
                              chunkY * chunkPixelSize
                            );
                          }
                        }
                      }
                    }
                  }
                }
              },
              hideChunk: (layerName: string, chunkX: number, chunkY: number) => {
                const layer = window.mapChunks.layers[layerName];
                if (layer) {
                  const chunkKey = `${chunkX}-${chunkY}`;
                  layer.chunkVisibility[chunkKey] = false;
                  window.mapChunks.redrawMainCanvas();
                }
              },
              showChunk: (layerName: string, chunkX: number, chunkY: number) => {
                const layer = window.mapChunks.layers[layerName];
                if (layer) {
                  const chunkKey = `${chunkX}-${chunkY}`;
                  layer.chunkVisibility[chunkKey] = true;
                  window.mapChunks.redrawMainCanvas();
                }
              },
              hideChunksByRegion: (x1: number, y1: number, x2: number, y2: number) => {
                const startChunkX = Math.floor(x1 / CHUNK_SIZE);
                const startChunkY = Math.floor(y1 / CHUNK_SIZE);
                const endChunkX = Math.floor(x2 / CHUNK_SIZE);
                const endChunkY = Math.floor(y2 / CHUNK_SIZE);
                for (const layerName in window.mapChunks.layers) {
                  const layer = window.mapChunks.layers[layerName];
                  for (let cy = startChunkY; cy <= endChunkY; cy++) {
                    for (let cx = startChunkX; cx <= endChunkX; cx++) {
                      const chunkKey = `${cx}-${cy}`;
                      layer.chunkVisibility[chunkKey] = false;
                    }
                  }
                }
                window.mapChunks.redrawMainCanvas();
              },
              showChunksByRegion: (x1: number, y1: number, x2: number, y2: number) => {
                const startChunkX = Math.floor(x1 / CHUNK_SIZE);
                const startChunkY = Math.floor(y1 / CHUNK_SIZE);
                const endChunkX = Math.floor(x2 / CHUNK_SIZE);
                const endChunkY = Math.floor(y2 / CHUNK_SIZE);
                for (const layerName in window.mapChunks.layers) {
                  const layer = window.mapChunks.layers[layerName];
                  for (let cy = startChunkY; cy <= endChunkY; cy++) {
                    for (let cx = startChunkX; cx <= endChunkX; cx++) {
                      const chunkKey = `${cx}-${cy}`;
                      layer.chunkVisibility[chunkKey] = true;
                    }
                  }
                }
                window.mapChunks.redrawMainCanvas();
              },
              hideLayer: (layerName: string) => {
                const layer = window.mapChunks.layers[layerName];
                if (layer) {
                  layer.visible = false;
                  window.mapChunks.redrawMainCanvas();
                }
              },
              showLayer: (layerName: string) => {
                const layer = window.mapChunks.layers[layerName];
                if (layer) {
                  layer.visible = true;
                  window.mapChunks.redrawMainCanvas();
                }
              }
            };
            async function processLayer(layer: any, layerIndex: number): Promise<void> {
              const layerName = layer.name.replace(/[^a-zA-Z0-9-_]/g, '-');
              chunkCanvases[layerName] = {};
              window.mapChunks.layers[layerName] = {
                originalName: layer.name,
                zIndex: layer.zIndex || layerIndex,
                visible: true,
                chunkVisibility: {},
                chunks: {}
              };
              const layerCanvas = document.createElement('canvas');
              layerCanvas.width = mapWidth;
              layerCanvas.height = mapHeight;
              if (!window.mapLayerCanvases) {
                window.mapLayerCanvases = [];
              }
              const layerCtx = layerCanvas.getContext('2d', { willReadFrequently: false });
              if (!layerCtx) throw new Error("Could not get canvas context for layer canvas");
              window.mapLayerCanvases.push({
                canvas: layerCanvas,
                ctx: layerCtx,
                zIndex: layer.zIndex || layerIndex
              });
              async function processChunk(chunkX: number, chunkY: number): Promise<void> {
                const startX = chunkX * CHUNK_SIZE;
                const startY = chunkY * CHUNK_SIZE;
                const endX = Math.min(startX + CHUNK_SIZE, mapData.width);
                const endY = Math.min(startY + CHUNK_SIZE, mapData.height);
                const actualChunkWidth = (endX - startX) * mapData.tilewidth;
                const actualChunkHeight = (endY - startY) * mapData.tileheight;
                const chunkCanvas = document.createElement('canvas');
                chunkCanvas.width = actualChunkWidth;
                chunkCanvas.height = actualChunkHeight;
                const chunkCtx = chunkCanvas.getContext('2d', { willReadFrequently: false });
                if (!chunkCtx) return;
                chunkCtx.imageSmoothingEnabled = false;
                let hasContent = false;
                for (let y = startY; y < endY; y++) {
                  for (let x = startX; x < endX; x++) {
                    const tileIndex = layer.data[y * mapData.width + x];
                    if (tileIndex === 0) continue;
                    const tileset = mapData.tilesets.find(
                      (t: any) => t.firstgid <= tileIndex && tileIndex < t.firstgid + t.tilecount
                    );
                    if (!tileset) continue;
                    const image = images[mapData.tilesets.indexOf(tileset)] as HTMLImageElement;
                    if (!image) continue;
                    const localTileIndex = tileIndex - tileset.firstgid;
                    const tilesPerRow = Math.floor(tileset.imagewidth / tileset.tilewidth);
                    const tileX = (localTileIndex % tilesPerRow) * tileset.tilewidth;
                    const tileY = Math.floor(localTileIndex / tilesPerRow) * tileset.tileheight;
                    chunkCtx.drawImage(
                      image,
                      tileX,
                      tileY,
                      tileset.tilewidth,
                      tileset.tileheight,
                      (x - startX) * mapData.tilewidth,
                      (y - startY) * mapData.tileheight,
                      mapData.tilewidth,
                      mapData.tileheight
                    );
                    if (!window.mapLayerCanvases) {
                      window.mapLayerCanvases = [];
                    }
                    const layerCanvasData = window.mapLayerCanvases[window.mapLayerCanvases.length - 1];
                    if (layerCanvasData && layerCanvasData.ctx) {
                      layerCanvasData.ctx.drawImage(
                        image,
                        tileX,
                        tileY,
                        tileset.tilewidth,
                        tileset.tileheight,
                        x * mapData.tilewidth,
                        y * mapData.tileheight,
                        mapData.tilewidth,
                        mapData.tileheight
                      );
                    }
                    hasContent = true;
                  }
                }
                const chunkKey = `${chunkX}-${chunkY}`;
                if (hasContent) {
                  chunkCanvases[layerName][chunkKey] = chunkCanvas;
                } else {
                  chunkCanvases[layerName][chunkKey] = null;
                }
                window.mapChunks.layers[layerName].chunkVisibility[chunkKey] = hasContent;
                window.mapChunks.layers[layerName].chunks[chunkKey] = {
                  x: chunkX,
                  y: chunkY,
                  hasContent
                };
                processedChunks++;
                const progress = (processedChunks / totalChunks) * 100;
                progressBar.style.width = `${Math.min(progress, 100)}%`;
              }
              for (let chunkY = 0; chunkY < chunksY; chunkY++) {
                for (let chunkX = 0; chunkX < chunksX; chunkX++) {
                  await processChunk(chunkX, chunkY);
                  if ((chunkX + chunkY * chunksX) % 5 === 0) {
                    await new Promise(resolve => setTimeout(resolve, 0));
                  }
                }
              }
            }
            let currentLayerIndex = 0;
            async function renderLayers(): Promise<void> {
              for (const layer of sortedLayers) {
                if (!layer.visible || layer.type !== "tilelayer" || layer.name.toLowerCase() === "collisions") {
                  currentLayerIndex++;
                  continue;
                }
                await processLayer(layer, currentLayerIndex);
                currentLayerIndex++;
                await new Promise(resolve => requestAnimationFrame(resolve));
              }
              (window.mapLayerCanvases ?? []).sort((a: any, b: any) => a.zIndex - b.zIndex);
              progressBar.style.width = `100%`;
              resolve();
              setTimeout(() => {
                if (loadingScreen) {
                  loadingScreen.style.transition = "1s";
                  loadingScreen.style.opacity = "0";
                  setTimeout(() => {
                    if (loadingScreen) {
                      loadingScreen.style.display = "none";
                      progressBar.style.width = "0%";
                      progressBarContainer.style.display = "block";
                    }
                  }, 1000);
                }
              }, 1000);
            }
            loaded = true;
            renderLayers();
          });
        }
      }
      break;
    case "LOGIN_SUCCESS":
      {
        const connectionId = JSON.parse(packet.decode(event.data))["data"];
        const chatDecryptionKey = JSON.parse(packet.decode(event.data))["chatDecryptionKey"];
        sessionStorage.setItem("connectionId", connectionId); // Store client's socket ID
        cachedPlayerId = connectionId;
        const sessionToken = getCookie("token");
        if (!sessionToken) {
          window.location.href = "/game";
          return;
        }

        // Store public key
        sessionStorage.setItem("chatDecryptionKey", chatDecryptionKey);

        const language = navigator.language.split("-")[0] || navigator.language || "en";
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
    case "INVENTORY":
      {
        const data = JSON.parse(packet.decode(event.data))["data"];
        const slots = JSON.parse(packet.decode(event.data))["slots"];
        if (data.length > 0) {
          // Assign each item to a slot
          for (let i = 0; i < data.length; i++) {
            // Create a new item slot
            const slot = document.createElement("div");
            slot.classList.add("slot");
            slot.classList.add("ui");
            const item = data[i];
            slot.classList.add(item.quality.toLowerCase() || "empty");

            if (item.icon) {
              // @ts-expect-error - pako is loaded in index.html
              const inflatedData = pako.inflate(new Uint8Array(item.icon.data), { to: "string" });
              const iconImage = new Image();
              iconImage.src = `data:image/png;base64,${inflatedData}`;
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
      const data = JSON.parse(packet.decode(event.data))["data"];
      console.log(data);
      break;
    }
    case "QUESTDETAILS": {
      const data = JSON.parse(packet.decode(event.data))["data"];
      console.log(data);
      break;
    }
    case "CHAT": {
      cache.players.forEach((player) => {
        if (player.id === data.id) {
          // Escape HTML tags before setting chat message
          player.chat = data.message;
          // Username with first letter uppercase
          const username = data?.username?.charAt(0).toUpperCase() + data?.username?.slice(1);
          const timestamp = new Date().toLocaleTimeString();
          // Update chat box
          if (data.message?.trim() !== "" && username) {
            const message = document.createElement("div");
            message.classList.add("message");
            message.style.userSelect = "text";
            // Escape HTML in the message before inserting
            const escapedMessage = data.message.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            message.innerHTML = `${timestamp} ${username}: ${escapedMessage}`;
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
      const player = cache.players.find((player) => player.id === data.id);
      if (!player) return;
      updateXp(data.xp, data.level, data.max_xp);
      player.stats = data;
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
      break;
    }
    case "SELECTPLAYER": {
      const data = JSON.parse(packet.decode(event.data))["data"];

      if (!data || !data.id || !data.username) {
        const target = cache.players.find(p => p.targeted);
        if (target) target.targeted = false;
        //displayElement(targetStats, false);
        break;
      }

      cache.players.forEach((player) => {
        player.targeted = (player.id === data.id);
      });

      // displayElement(targetStats, true);
      break;
    }
    case "STEALTH": {
      const data = JSON.parse(packet.decode(event.data))["data"];
      const currentPlayer = cache.players.find(
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
      const { target, stats } = JSON.parse(packet.decode(event.data))["data"];
      const t = cache.players.find((player) => player.id === target);
      if (t) {
        t.stats = stats;
      }
      break;
    }
    case "REVIVE": {
      const data = JSON.parse(packet.decode(event.data))["data"];
      const target = cache.players.find((player) => player.id === data.target);
      if (!target) return;

      target.stats = data.stats;

      const isSelf = target.id.toString() === cachedPlayerId;

      if (!isSelf) {
        target.targeted = false;
      }

      //displayElement(targetStats, false);
      cache.players.forEach((player) => player.targeted = false);
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
      const name = JSON.parse(packet.decode(event.data))["name"];
      const data = JSON.parse(packet.decode(event.data))["data"];
      const timestamp = JSON.parse(packet.decode(event.data))["timestamp"];
      playMusic(name, data.data.data, timestamp);
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
      const escapedMessage = data.message.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const timestamp = new Date().toLocaleTimeString();
      // Update chat box
      if (data.message?.trim() !== "" && data.username) {
        const message = document.createElement("div");
        message.classList.add("message");
        message.style.userSelect = "text";
        // Username with first letter uppercase
        const username = data.username.charAt(0).toUpperCase() + data.username.slice(1);
        message.innerHTML = `${timestamp} <span class="whisper-username">${username}:</span> <span class="whisper-message">${escapedMessage}</span>`;
        chatMessages.appendChild(message);
        // Scroll to the bottom of the chat messages
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }
      break;
    }
    case "PARTY_CHAT": {
      const data = JSON.parse(packet.decode(event.data))["data"];
      // Escape HTML tags before setting chat message
      const escapedMessage = data.message.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const timestamp = new Date().toLocaleTimeString();
      // Update chat box
      if (data.message?.trim() !== "" && data.username) {
        const message = document.createElement("div");
        message.classList.add("message");
        message.style.userSelect = "text";
        // Username with first letter uppercase
        const username = data.username.charAt(0).toUpperCase() + data.username.slice(1);
        message.innerHTML = `${timestamp} <span class="party-username">${username}:</span> <span class="party-message">${escapedMessage}</span>`;
        chatMessages.appendChild(message);
        // Scroll to the bottom of the chat messages
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }
      break;
    }
    case "CURRENCY": {
      const data = JSON.parse(packet.decode(event.data))["data"];
      console.log("Currency data received:", data);
      break;
    }
    default:
      break;
  }
}

function showNotification(message: string, autoClose: boolean = true, reconnect: boolean = false) {

  if (!notificationContainer || !notificationMessage) return;
  
  notificationMessage.innerText = message;
  notificationContainer.style.display = "flex";
  
  const baseTimeout = 5000; // Base timeout of 5 seconds
  const timePerChar = 100; // Additional time per character in milliseconds
  const timeout = baseTimeout + (message.length * timePerChar);

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
  if (packetsSentReceived.innerText === `Sent: ${sentRequests}, Received: ${receivedResponses}`) return;
  packetsSentReceived.innerText = `Sent: ${sentRequests}, Received: ${receivedResponses}`;
  sentRequests = 0;
  receivedResponses = 0;
}, 1000);

export { sendRequest, cachedPlayerId, getIsLoaded };