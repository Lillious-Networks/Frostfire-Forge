const isCryptoSupported = typeof window?.crypto?.subtle === "object" && Object.keys(window.crypto.subtle).length !== 0;
let cachedPlayerId: string | null = null;
const socket = new WebSocket(`__VAR.WEBSOCKETURL__`);
let sentRequests = 0;
let receivedResponses = 0;
const overlay = document.getElementById("overlay") as HTMLDivElement;
const debugContainer = document.getElementById("debug-container") as HTMLDivElement;
const positionText = document.getElementById("position") as HTMLDivElement;
const packetsSentReceived = document.getElementById("packets-sent-received") as HTMLDivElement;
import * as pako from "../libs/pako.js";
import parseAPNG from '../libs/apng_parser.js';
let userHasInteracted = false;
socket.binaryType = "arraybuffer";
const players = [] as any[];
const npcs = [] as any[];
declare global {
  interface Window {
    mapLayerCanvases?: Array<{ canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, zIndex: number }>;
    playerZIndex?: number;
    mapChunks?: any; 
  }
}
const userInteractionListener = () => {
  if (!userHasInteracted) {
    userHasInteracted = true;
    document.removeEventListener("mousedown", userInteractionListener);
  }
};
document.addEventListener("mousedown", userInteractionListener);
const audioCache = new Map<string, string>();
const npcImage = new Image();
npcImage.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACMAAAAmCAYAAABOFCLqAAABhGlDQ1BJQ0MgcHJvZmlsZQAAKJF9kT1Iw0AcxV9TxQ8qDq0g4pChioNdVMSxVLEIFkpboVUHk0u/oElDkuLiKLgWHPxYrDq4OOvq4CoIgh8g7oKToouU+L+k0CLGg+N+vLv3uHsHCI0KU82uKKBqlpGKx8RsblXseYWAPgQxgSGJmXoivZiB5/i6h4+vdxGe5X3uzzGg5E0G+ETiKNMNi3iDeHbT0jnvE4dYSVKIz4knDbog8SPXZZffOBcdFnhmyMik5olDxGKxg+UOZiVDJZ4hDiuqRvlC1mWF8xZntVJjrXvyFwby2kqa6zRHEccSEkhChIwayqjAQoRWjRQTKdqPefhHHH+SXDK5ymDkWEAVKiTHD/4Hv7s1C9NTblIgBnS/2PbHGNCzCzTrtv19bNvNE8D/DFxpbX+1Acx9kl5va+EjYHAbuLhua/IecLkDDD/pkiE5kp+mUCgA72f0TTkgeAv0r7m9tfZx+gBkqKvlG+DgEBgvUva6x7t7O3v790yrvx+jlHK64ZQ6gAAAAAZiS0dEAAAAAAAA+UO7fwAAAAlwSFlzAAAuIwAALiMBeKU/dgAAAAd0SU1FB+kCCRMwEsjIppIAAAAZdEVYdENvbW1lbnQAQ3JlYXRlZCB3aXRoIEdJTVBXgQ4XAAAB50lEQVRYw+2YvWvCYBDGn7xk0yRUKtqIiBBaUAoOznXv6B9b6GhnN3GRDErQRG2U1w9cStNB35hEjV/5sOBNuYRcft7de88h95LPW7gR4wHg/fURkrCMDYLOE/hofYMAgCQsQeeJ2EBYIgi7OS5UMS3VI4Oi8wSmpTrGhaq7TACgTBpQUYOyyZIkLJESg2+nyYyz46uGCWXS2IVhQKxsfSqhT7fPkuTHvl788mf7TstJ1PU9ZsTvVyTJjyvoNXZKLN7vZfuEOZrsat+nJwluyO4w/wKGPzaY9l0H4Z8MQ72nIUQJ2FsmNVWz5SBs0WRaOC3VoaZquzDpXhOmYUam3pKwhGmYSPea7jKxbEie8Ry2KZMGILB+Wq1hirlFrKcoJS6A1iYzn+0HyGJ8C99gxgHQ1z0ji9bmRjwgLBF2A8uihVWxgg6XiQSiw2WwKlZcFXFNYK2rI0lHkcAk6QhaVz889J6tISC6Uxdqaazh8Qksixa+2sb2COafrgZQtW0W3srZ87UpCAhvLCfUWTCsVN6yXeOrl6wQQWbl1Lj35eoOE9jaqWo64Gg2r3Zd6quaDvmcOTOYcZvBFPwUlsvZgxOe+KloWHZoSyB+Kho2kHdLIH4qGrZ5twTeT0XDNueWAADcLf3B+AfAy/vU2Mt7LwAAAABJRU5ErkJggg==';
const typingImage = new Image();
typingImage.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACsAAAAVCAYAAADfLRcdAAABhWlDQ1BJQ0MgcHJvZmlsZQAAKJF9kT1Iw0AcxV+/qEhF0A4iDhmqONhFRcSpVLEIFkpboVUHk0u/oElDkuLiKLgWHPxYrDq4OOvq4CoIgh8g7oKToouU+L+k0CLGg+N+vLv3uHsHeJtVphj+GKCopp5OxIVcflUIviIAPwYwh3GRGVoys5iF6/i6h4evd1Ge5X7uz9EnFwwGeATiGNN0k3iDeGbT1DjvE4dZWZSJz4kndLog8SPXJYffOJds9vLMsJ5NzxOHiYVSF0tdzMq6QjxNHJEVlfK9OYdlzluclWqdte/JXxgqqCsZrtMcQQJLSCIFARLqqKAKE1FaVVIMpGk/7uIftv0pcknkqoCRYwE1KBBtP/gf/O7WKE5NOkmhOBB4sayPUSC4C7QalvV9bFmtE8D3DFypHX+tCcx+kt7oaJEjoH8buLjuaNIecLkDDD1poi7ako+mt1gE3s/om/LA4C3Qu+b01t7H6QOQpa6Wb4CDQ2CsRNnrLu/u6e7t3zPt/n4A+Ehy3OEAdvwAAAAGYktHRACjAGoAQYpfYckAAAAJcEhZcwAALiMAAC4jAXilP3YAAAAHdElNRQfpBQQTFRn3o6swAAAAGXRFWHRDb21tZW50AENyZWF0ZWQgd2l0aCBHSU1QV4EOFwAAAIVJREFUSMdjZEACqday/xkGGZh99DEjjM3EMITAkHIsI3LUK4nxwSWOXH80YI6y0ZSDs++9+sQwmgxoDViQOchR/+bTtwFzFLI7pIQFRpMBfZMBLtAY/hfOrl/JPCBqR5MB3SqFZ28/DIrSQISPa7Q0GLjSALlOHm0bjKjSYLSnMJoMGBgAuS4u7T48tcgAAAAASUVORK5CYII=';
const onlinecount = document.getElementById("onlinecount") as HTMLDivElement;
const canvas = document.getElementById("game") as HTMLCanvasElement;
const ctx = canvas.getContext("2d");
const progressBar = document.getElementById("progress-bar") as HTMLDivElement;
const progressBarContainer = document.getElementById("progress-bar-container") as HTMLDivElement;
const inventoryUI = document.getElementById("inventory") as HTMLDivElement;
const spellBookUI = document.getElementById("spell-book-container") as HTMLDivElement;
const friendsListUI = document.getElementById("friends-list-container") as HTMLDivElement;
const friendsList = document.getElementById("friends-list-content") as HTMLDivElement;
const friendsListSearch = document.getElementById("friends-list-search") as HTMLInputElement;
const inventoryGrid = document.getElementById("grid") as HTMLDivElement;
const statUI = document.getElementById("stat-screen") as HTMLDivElement;
const chatInput = document.getElementById("chat-input") as HTMLInputElement;
const chatMessages = document.getElementById("chat-messages") as HTMLDivElement;
const loadingScreen = document.getElementById("loading-screen");
const xpBar = document.getElementById("xp-bar") as HTMLDivElement;
const healthBar = document.getElementById(
  "health-progress-bar"
) as HTMLDivElement;
const staminaBar = document.getElementById(
  "stamina-progress-bar"
) as HTMLDivElement;
const targetHealthBar = document.getElementById(
  "target-health-progress-bar"
) as HTMLDivElement;
const targetStaminaBar = document.getElementById(
  "target-stamina-progress-bar"
) as HTMLDivElement;
const pauseMenu = document.getElementById(
  "pause-menu-container"
) as HTMLDivElement;
const optionsMenu = document.getElementById(
  "options-menu-container"
) as HTMLDivElement;
const menuElements = ["options-menu-container"];
const fpsSlider = document.getElementById("fps-slider") as HTMLInputElement;
const musicSlider = document.getElementById("music-slider") as HTMLInputElement;
const effectsSlider = document.getElementById(
  "effects-slider"
) as HTMLInputElement;
const mutedCheckbox = document.getElementById(
  "muted-checkbox"
) as HTMLInputElement;
const healthLabel = document.getElementById("stats-screen-health-label") as HTMLDivElement;
const manaLabel = document.getElementById("stats-screen-mana-label") as HTMLDivElement;
let loaded: boolean = false;
let toggleInventory = false;
let toggleSpellBook = false;
let toggleFriendsList = false;
const times = [] as number[];
let lastFrameTime = 0; 
let controllerConnected = false;
let cameraX = 0;
let cameraY = 0;
let lastSentDirection = "";
canvas.style.position = 'absolute';
let lastUpdate = performance.now(); 
function lerp(start: number, end: number, amount: number) {
  return start + (end - start) * amount;
}
window.addEventListener("gamepadconnected", () => {
  controllerConnected = true;
});
window.addEventListener("gamepaddisconnected", () => {
  controllerConnected = false;
});
const packet = {
  decode(data: ArrayBuffer) {
    const decoder = new TextDecoder();
    return decoder.decode(data);
  },
  encode(data: string) {
    const encoder = new TextEncoder();
    return encoder.encode(data);
  },
};
let lastDirection = "";
let pendingRequest = false;
const cachedViewport = {
  x: 0,
  y: 0,
  w: window.innerWidth,
  h: window.innerHeight,
  padding: 64,
};
const cachedPaddedBounds = {
  x: 0,
  y: 0,
  w: 0,
  h: 0,
};
let lastViewportChunks = new Set<string>();
let viewportUpdateThrottle = 0;
function getViewportChunks(): Set<string> {
  if (!window.mapChunks) return new Set();
  const { chunkPixelSize } = window.mapChunks;
  const padding = chunkPixelSize * 0.5; 
  const viewportLeft = cachedViewport.x - padding;
  const viewportTop = cachedViewport.y - padding;
  const viewportRight = cachedViewport.x + cachedViewport.w + padding;
  const viewportBottom = cachedViewport.y + cachedViewport.h + padding;
  const startChunkX = Math.max(0, Math.floor(viewportLeft / chunkPixelSize));
  const startChunkY = Math.max(0, Math.floor(viewportTop / chunkPixelSize));
  const endChunkX = Math.min(window.mapChunks.chunksX - 1, Math.floor(viewportRight / chunkPixelSize));
  const endChunkY = Math.min(window.mapChunks.chunksY - 1, Math.floor(viewportBottom / chunkPixelSize));
  const visibleChunks = new Set<string>();
  for (let chunkY = startChunkY; chunkY <= endChunkY; chunkY++) {
    for (let chunkX = startChunkX; chunkX <= endChunkX; chunkX++) {
      visibleChunks.add(`${chunkX}-${chunkY}`);
    }
  }
  return visibleChunks;
}
function updateChunkVisibility() {
  if (!window.mapChunks) return;
  const currentViewportChunks = getViewportChunks();
  const chunksChanged = 
    currentViewportChunks.size !== lastViewportChunks.size ||
    [...currentViewportChunks].some(chunk => !lastViewportChunks.has(chunk));
  if (!chunksChanged) return;
  for (const layerName in window.mapChunks.layers) {
    const layer = window.mapChunks.layers[layerName];
    for (const chunkKey in layer.chunkVisibility) {
      layer.chunkVisibility[chunkKey] = false;
    }
  }
  for (const chunkKey of currentViewportChunks) {
    for (const layerName in window.mapChunks.layers) {
      const layer = window.mapChunks.layers[layerName];
      if (layer.chunks[chunkKey]?.hasContent) {
        layer.chunkVisibility[chunkKey] = true;
      }
    }
  }
  window.mapChunks.redrawMainCanvas();
  lastViewportChunks = currentViewportChunks;
}
function updateViewportCache() {
  cachedViewport.w = window.innerWidth;
  cachedViewport.h = window.innerHeight;
  cachedPaddedBounds.w = cachedViewport.w + cachedViewport.padding * 2;
  cachedPaddedBounds.h = cachedViewport.h + cachedViewport.padding * 2;
}
updateViewportCache();
animationLoop();
function animationLoop() {
  if (!ctx) return;
  const fpsTarget = parseFloat(fpsSlider.value);
  const frameDuration = 1000 / fpsTarget;
  const now = performance.now();
  const deltaTime = (now - lastFrameTime) / 1000;
  if (now - lastFrameTime < frameDuration) {
    requestAnimationFrame(animationLoop);
    return;
  }
  lastFrameTime = now;
  const currentPlayer = players.find(p => p.id === cachedPlayerId);
  if (!currentPlayer) {
    requestAnimationFrame(animationLoop);
    return;
  }
  updateCamera(currentPlayer);
  if (isMoving && isKeyPressed) {
    if (document.activeElement === chatInput || document.activeElement === friendsListSearch) {
      isMoving = false;
      lastDirection = "";
      return;
    }
    const keys = pressedKeys;
    let dir = "";
    if (keys.has("KeyW") && keys.has("KeyA")) dir = "UPLEFT";
    else if (keys.has("KeyW") && keys.has("KeyD")) dir = "UPRIGHT";
    else if (keys.has("KeyS") && keys.has("KeyA")) dir = "DOWNLEFT";
    else if (keys.has("KeyS") && keys.has("KeyD")) dir = "DOWNRIGHT";
    else if (keys.has("KeyW")) dir = "UP";
    else if (keys.has("KeyS")) dir = "DOWN";
    else if (keys.has("KeyA")) dir = "LEFT";
    else if (keys.has("KeyD")) dir = "RIGHT";
    if (dir && dir !== lastDirection && !pendingRequest) {
      pendingRequest = true;
      sendRequest({ type: "MOVEXY", data: dir });
      lastDirection = dir;
      setTimeout(() => (pendingRequest = false), 50);
    }
  } else if (isMoving && !isKeyPressed) {
    if (lastDirection !== "") sendRequest({ type: "MOVEXY", data: "ABORT" });
    isMoving = false;
    lastDirection = "";
  }
  cachedViewport.x = window.scrollX;
  cachedViewport.y = window.scrollY;
  cachedPaddedBounds.x = cachedViewport.x - cachedViewport.padding;
  cachedPaddedBounds.y = cachedViewport.y - cachedViewport.padding;
  viewportUpdateThrottle++;
  if (viewportUpdateThrottle >= 5) {
    updateChunkVisibility();
    viewportUpdateThrottle = 0;
  }
  ctx.clearRect(cachedViewport.x, cachedViewport.y, cachedViewport.w, cachedViewport.h);
  const isInView = (x: number, y: number) =>
    x >= cachedPaddedBounds.x &&
    y >= cachedPaddedBounds.y &&
    x <= cachedPaddedBounds.x + cachedPaddedBounds.w &&
    y <= cachedPaddedBounds.y + cachedPaddedBounds.h;
  const visiblePlayers = players.filter(p =>
    isInView(p.position.x, p.position.y) &&
    (p.id === cachedPlayerId || !p.isStealth || (p.isStealth && currentPlayer.isAdmin))
  );
  if (currentPlayer) {
    const { health, max_health, stamina, max_stamina } = currentPlayer.stats;
    const healthPercent = (health / max_health) * 100;
    const staminaPercent = (stamina / max_stamina) * 100;
    updateHealthBar(healthBar, healthPercent);
    updateStaminaBar(staminaBar, staminaPercent);
  }
  const targetPlayer = players.find(p => p.targeted);
  if (targetPlayer) {
    const { health, max_health, stamina, max_stamina } = targetPlayer.stats;
    const healthPercent = (health / max_health) * 100;
    const staminaPercent = (stamina / max_stamina) * 100;
    updateHealthBar(targetHealthBar, healthPercent);
    updateStaminaBar(targetStaminaBar, staminaPercent);
  }
  const visibleNpcs = npcs.filter(npc =>
    isInView(npc.position.x, npc.position.y)
  );
  const playerZ = 3;
  if (window.mapLayerCanvases) {
    for (const layer of window.mapLayerCanvases) {
      if (layer.zIndex < playerZ) {
        ctx.drawImage(
          layer.canvas,
          cachedViewport.x, cachedViewport.y, cachedViewport.w, cachedViewport.h,
          cachedViewport.x, cachedViewport.y, cachedViewport.w, cachedViewport.h
        );
      }
    }
    for (const p of visiblePlayers) p.show(ctx);
    for (const npc of visibleNpcs) {
      npc.show(ctx);
      if (npc.particles) {
        for (const particle of npc.particles) {
          if (particle.visible) {
            npc.updateParticle(particle, npc, ctx, deltaTime);
          }
        }
      }
      npc.dialogue(ctx);
    }
    for (const layer of window.mapLayerCanvases) {
      if (layer.zIndex >= playerZ) {
        ctx.drawImage(
          layer.canvas,
          cachedViewport.x, cachedViewport.y, cachedViewport.w, cachedViewport.h,
          cachedViewport.x, cachedViewport.y, cachedViewport.w, cachedViewport.h
        );
      }
    }
    for (const p of visiblePlayers) p.showChat(ctx);
  }
  if (times.length > 60) times.shift();
  times.push(now);
  requestAnimationFrame(animationLoop);
}
window.addEventListener('resize', () => {
  updateViewportCache();
  lastViewportChunks.clear();
  updateChunkVisibility();
});
const cameraSmoothing = 0.05;
function updateCamera(currentPlayer: any) {
  if (!loaded) return;
  if (currentPlayer) {
    const now = performance.now();
    const deltaTime = Math.min((now - lastUpdate) / 16.67, 2);
    lastUpdate = now;
    const targetX = currentPlayer.position.x - window.innerWidth / 2 + 8;
    const targetY = currentPlayer.position.y - window.innerHeight / 2 + 48;
    const smoothing = 1 - Math.pow(1 - cameraSmoothing, deltaTime);
    cameraX = lerp(cameraX, targetX, smoothing);
    cameraY = lerp(cameraY, targetY, smoothing);
    window.scrollTo(Math.round(cameraX), Math.round(cameraY));
  }
}

// Event listener for joystick movement
window.addEventListener("gamepadjoystick", (e: CustomEventInit) => {
  if (!loaded) return;
  if (pauseMenu.style.display == "block") return;

  // Get the joystick coordinates
  const x = e.detail.x;
  const y = e.detail.y;

  // Check if joystick is in neutral position (increased deadzone)
  const deadzone = 0.5;
  if (Math.abs(x) < deadzone && Math.abs(y) < deadzone) {
    if (lastSentDirection !== "ABORT") {
      sendRequest({
        type: "MOVEXY",
            data: "ABORT",
      });
      lastSentDirection = "ABORT";
    }
    return;
  }

  // Determine the angle in degrees
  const angle = Math.atan2(y, x) * (180 / Math.PI);

  // Determine direction based on angle ranges
  let direction = "";
  if (angle >= -22.5 && angle < 22.5) {
    direction = "RIGHT";
  } else if (angle >= 22.5 && angle < 67.5) {
    direction = "DOWNRIGHT";
  } else if (angle >= 67.5 && angle < 112.5) {
    direction = "DOWN";
  } else if (angle >= 112.5 && angle < 157.5) {
    direction = "DOWNLEFT";
  } else if (angle >= 157.5 || angle < -157.5) {
    direction = "LEFT";
  } else if (angle >= -157.5 && angle < -112.5) {
    direction = "UPLEFT";
  } else if (angle >= -112.5 && angle < -67.5) {
    direction = "UP";
  } else if (angle >= -67.5 && angle < -22.5) {
    direction = "UPRIGHT";
  }

  // Only send if direction changed
  if (direction && direction !== lastSentDirection) {
    if (pauseMenu.style.display == "block") return;
    sendRequest({
      type: "MOVEXY",
          data: direction,
    });
    lastSentDirection = direction;
  }
});

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

const animationCache = new Map<string, string>();

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
        const currentPlayer = players.find((player) => player.id === cachedPlayerId);
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
      const currentPlayer = players.find((player) => player.id === cachedPlayerId);
      if (currentPlayer) {
        currentPlayer.party = data.members || [];
        createPartyUI(currentPlayer.party);
      }
      break;
    }
    case "ANIMATION": {
      let apng: any;
      try {
          if (animationCache.has(data?.name)) {
              const inflatedData = animationCache.get(data?.name)!;
              if (!inflatedData) return;
              apng = parseAPNG(inflatedData);
          } else {
              // @ts-expect-error - pako is not defined because it is loaded in the index.html
              const inflatedData = pako.inflate(new Uint8Array(data?.data?.data));
              if (!inflatedData) return;
              apng = parseAPNG(inflatedData.buffer);
              animationCache.set(data.name, inflatedData.buffer);
          }

          if (!(apng instanceof Error) && players) {
              const findPlayer = async () => {
                  const player = players.find(p => p.id === data.id);
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
      players.forEach((player, index) => {
        if (player.id !== cachedPlayerId) {
          players.splice(index, 1);
        }
      });

      data.forEach((player: any) => {
        if (player.id != cachedPlayerId) {
          // Check if the player is already created and remove it
          players.forEach((p, index) => {
            if (p.id === player.id) {
              players.splice(index, 1);
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
      const index = players.findIndex(player => player.id === data.id);
      if (index !== -1) {
        //const wasTargeted = players[index].targeted;

        players.splice(index, 1); // Remove from array

        // If they were targeted, hide target stats
        // if (wasTargeted) {
        //   displayElement(targetStats, false);
        // }
      }

      break;
    }
    case "MOVEXY": {
      const player = players.find((player) => player.id === data.id);
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
                    loadingScreen.style.display = "none";
                    progressBar.style.width = "0%";
                    progressBarContainer.style.display = "block";
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
          window.location.href = "/";
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
      players.forEach((player) => {
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
      players.forEach((player) => {
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
      players.forEach((player) => {
        if (player.id === data.id) {
          player.typing = false;
        }
      });
      break;
    }
    case "NPCDIALOG": {
      const npc = npcs.find((npc) => npc.id === data.id);
      if (!npc) return;
      npc.dialog = data.dialog;
      break;
    }
    case "STATS": {
      const player = players.find((player) => player.id === data.id);
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
        const target = players.find(p => p.targeted);
        if (target) target.targeted = false;
        //displayElement(targetStats, false);
        break;
      }

      players.forEach((player) => {
        player.targeted = (player.id === data.id);
      });

      // displayElement(targetStats, true);
      break;
    }
    case "STEALTH": {
      const data = JSON.parse(packet.decode(event.data))["data"];
      const currentPlayer = players.find(
        (player) => player.id === cachedPlayerId || player.id === cachedPlayerId
      );

      // Abort movement if self
      if (currentPlayer && data.id === currentPlayer.id) {
        sendRequest({
          type: "MOVEXY",
          data: "ABORT",
        });
      }

      players.forEach((player) => {
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
      const t = players.find((player) => player.id === target);
      if (t) {
        t.stats = stats;
      }
      break;
    }
    case "REVIVE": {
      const data = JSON.parse(packet.decode(event.data))["data"];
      const target = players.find((player) => player.id === data.target);
      if (!target) return;

      target.stats = data.stats;

      const isSelf = target.id.toString() === cachedPlayerId;

      if (!isSelf) {
        target.targeted = false;
      }

      //displayElement(targetStats, false);
      players.forEach((player) => player.targeted = false);
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

function updateXp(xp: number, level: number, max_xp: number) {
  const xscale = Math.max(0, Math.min(1, xp / max_xp)) || 0;
  xpBar.animate([
    { transform: `scaleX(${xscale})` }
  ], {
    duration: 0,
    fill: 'forwards'
  });
}

function playMusic(name: string, data: Uint8Array, timestamp: number): void {
  if (!userHasInteracted) {
    setTimeout(() => {
      playMusic(name, data, timestamp);
    }, 100);
    return;
  }
  // Check if the audio is already cached, if not, inflate the data
    // @ts-expect-error - pako is not defined because it is loaded in the index.html
    const cachedAudio = timestamp < performance.now() - 3.6e+6 ? pako.inflate(new Uint8Array(data),{ to: 'string' }) : audioCache.get(name)|| pako.inflate(new Uint8Array(data), { to: 'string' });
    const music = new Audio(`data:audio/wav;base64,${cachedAudio}`);
    if (!music) {
      console.error("Failed to create audio element");
      return;
    }
    const musicVolume = Number(musicSlider.value);
    music.volume = mutedCheckbox.checked || musicVolume === 0 ? 0 : musicVolume / 100;
    music.loop = true;
    try {
      music.play();
      // Cache the audio
      audioCache.set(name, cachedAudio);
      startMusicInterval(music);
    } catch (e) {
      console.error(e);
    }
}

function startMusicInterval(music: any) {
  setInterval(() => {
    const musicVolume = Number(musicSlider.value);
    music.volume = mutedCheckbox.checked || musicVolume === 0 ? 0 : musicVolume / 100;
  }, 100);
}

function playAudio(name: string, data: Uint8Array, pitch: number, timestamp: number): void {
  // Keep retrying to play the audio until the user has interacted with the page
  if (!userHasInteracted) {
    setTimeout(() => {
      playAudio(name, data, pitch, timestamp);
    }, 100);
    return;
  }
  // Get mute status
  if (mutedCheckbox.checked) return;
  // Get effects volume
  const volume = effectsSlider.value === "0" ? 0 : Number(effectsSlider.value) / 100;
  // Check if the audio is already cached, if not, inflate the data
  // @ts-expect-error - pako is not defined because it is loaded in the index.html
  const cachedAudio = timestamp < performance.now() - 3.6e+6 ? pako.inflate(new Uint8Array(data),{ to: 'string' }) : audioCache.get(name)|| pako.inflate(new Uint8Array(data), { to: 'string' });
  const audio = new Audio(`data:audio/wav;base64,${cachedAudio}`);
  if (!audio) {
    console.error("Failed to create audio element");
    return;
  }
  audio.playbackRate = pitch;
  audio.volume = volume;
  // Auto play
  audio.autoplay = true;

  try {
    audio.play();
    // Cache the audio
    audioCache.set(name, cachedAudio);
  } catch (e) {
    console.error(e);
  }  
}

function getCookie(cname: string) {
  const name = cname + "=";
  const decodedCookie = decodeURIComponent(document.cookie);
  const ca = decodedCookie.split(";");
  for (let i = 0; i < ca.length; i++) {
    let c = ca[i];
    while (c.charAt(0) == " ") {
      c = c.substring(1);
    }
    if (c.indexOf(name) == 0) {
      return c.substring(name.length, c.length);
    }
  }
  return "";
}

let isKeyPressed = false;
let isMoving = false;
const pressedKeys = new Set();
const movementKeys = new Set(["KeyW", "KeyA", "KeyS", "KeyD"]);
let lastTypingPacket = 0;
let typingTimer: number | null = null;

chatInput.addEventListener("input", () => {
  // Clear any existing timer
  if (typingTimer) {
    window.clearTimeout(typingTimer);
  }

  // Send typing packet if enough time has passed since last one
  if (lastTypingPacket + 1000 < performance.now()) {
    sendRequest({
      type: "TYPING",
      data: null,
    });
    lastTypingPacket = performance.now();
  }

  // Set new timer to send another packet after delay
  typingTimer = window.setTimeout(() => {
    if (chatInput.value.length > 0) {
      sendRequest({
        type: "TYPING",
        data: null,
      });
      lastTypingPacket = performance.now();
    }
  }, 1000);
});

const cooldowns: { [key: string]: number } = {};
const COOLDOWN_DURATION = 500; // milliseconds

// Keyboard event handler configuration

const keyHandlers = {
  F2: () => toggleDebugContainer(),
  Escape: () => handleEscapeKey(),
  KeyB: () => {
    toggleInventory = toggleUI(inventoryUI, toggleInventory, -350);
  },
  KeyP: () => {
    if (toggleFriendsList) {
      toggleFriendsList = toggleUI(friendsListUI, toggleFriendsList, -425);
    }

    toggleSpellBook = toggleUI(spellBookUI, toggleSpellBook, -425);
  },
  KeyO: () => {
    if (toggleSpellBook) {
      toggleSpellBook = toggleUI(spellBookUI, toggleSpellBook, -425);
    }

    toggleFriendsList = toggleUI(friendsListUI, toggleFriendsList, -425);
  },
  KeyC: () => handleStatsUI(),
  KeyX: () => sendRequest({ type: "STEALTH", data: null }),
  KeyZ: () => sendRequest({ type: "NOCLIP", data: null }),
  Enter: async () => handleEnterKey(),
  Space: () => handleSpaceKey(),
} as const;

// Movement keys configuration
const blacklistedKeys = new Set([
  'ContextMenu',
  'AltLeft',
  'AltRight',
  'ControlLeft',
  'ControlRight',
  'ShiftLeft',
  'ShiftRight',
  'F1',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'Tab',
]);

// Helper functions
function toggleDebugContainer() {
  debugContainer.style.display = debugContainer.style.display === "block" ? "none" : "block";
}

function toggleUI(element: HTMLElement, toggleFlag: boolean, hidePosition: number) {
  element.style.transition = "1s";
  element.style.right = toggleFlag ? hidePosition.toString() : "10";
  return !toggleFlag;
}

function handleStatsUI() {
  const isCurrentPlayerStats = statUI.getAttribute("data-id") === cachedPlayerId;
  if (statUI.style.left === "10px" && isCurrentPlayerStats) {
    statUI.style.transition = "1s";
    statUI.style.left = "-570";
  } else {
    sendRequest({ type: "INSPECTPLAYER", data: null });
  }
}

function handleEscapeKey() {
  stopMovement();
  chatInput.blur();
  
  const isPauseMenuVisible = pauseMenu.style.display === "block";
  pauseMenu.style.display = isPauseMenuVisible ? "none" : "block";
  
  // Close other menus
  menuElements.forEach(elementId => {
    const element = document.getElementById(elementId);
    if (element?.style.display === "block") {
      element.style.display = "none";
    }
  });
}

async function handleEnterKey() {
  // Check if friendslist search is focused
  if (friendsListSearch === document.activeElement) return;
  const isTyping = chatInput === document.activeElement;
  
  if (!isTyping) {
    sentRequests++;
    chatInput.focus();
    return;
  }

  sendRequest({ type: "STOPTYPING", data: null });
  
  const message = chatInput.value.trim();
  if (!message) {
    chatInput.value = "";
    chatInput.blur();
    return;
  }

  if (message.startsWith("/")) {
    await handleCommand(message);
  } else {
    await handleChatMessage(message);
  }

  chatInput.value = "";
}

async function handleCommand(message: string) {
  const command = message.substring(1);
  if (isCryptoSupported) {
    const chatDecryptionKey = sessionStorage.getItem("chatDecryptionKey");
    if (!chatDecryptionKey) return;
    const encryptedMessage = await encryptRsa(chatDecryptionKey, command || " ");
    sendRequest({
      type: "COMMAND",
      data: { command: encryptedMessage, mode: "decrypt" }
    });
  } else {
    sentRequests++;
    sendRequest({
      type: "COMMAND",
      data: { command: command || " ", }
    });
  }
}

async function handleChatMessage(message: string) {

  if (isCryptoSupported) {
    const chatDecryptionKey = sessionStorage.getItem("chatDecryptionKey");
    if (!chatDecryptionKey) return;
    
    const encryptedMessage = await encryptRsa(chatDecryptionKey, message || " ");
    sendRequest({
      type: "CHAT",
      data: { message: encryptedMessage, mode: "decrypt" }
    });
  } else {
    sentRequests++;
    sendRequest({
      type: "CHAT",
      data: { message: message || " ", mode: null }
    });
  }

  // Set timeout to clear chat
  setTimeout(() => {
    const currentPlayer = players.find(p => p.id === cachedPlayerId);
    if (currentPlayer?.chat === message) {
      sendRequest({ type: "CHAT", data: null });
    }
  }, 7000 + message.length * 35);
}

function handleSpaceKey() {
  const target = players.find(player => player.targeted);
  if (target) {
    sendRequest({ type: "ATTACK", data: target });
  }
}

let contextMenuKeyTriggered = false;
// Main keyboard event handlers
window.addEventListener("keydown", async (e) => {
  if (e.key === 'ContextMenu' || e.code === 'ContextMenu') {
    contextMenuKeyTriggered = true;
  }
  // Prevent blacklisted keys
  if (blacklistedKeys.has(e.code)) {
    // Check for tab
    if (e.code === "Tab" && !contextMenuKeyTriggered) {
      const target = players.find(player => player.targeted);
      if (target) {
        target.targeted = false;
      }
      //displayElement(targetStats, false);
      sendRequest({ type: "TARGETCLOSEST", data: null });
      e.preventDefault();
      return;
    }
    
    e.preventDefault();
    return;
  }
  if (!loaded || (pauseMenu.style.display === "block" && e.code !== "Escape")) return;
  if ((chatInput === document.activeElement || document.activeElement == friendsListSearch) && !["Enter", "Escape"].includes(e.code)) return;

  // Handle movement keys
  if (movementKeys.has(e.code)) {
    pressedKeys.add(e.code);
    if (!isKeyPressed) {
      isKeyPressed = true;
      if (!isMoving) {
        handleKeyPress();
      }
    }
  }

  // Handle other mapped keys
  const now = Date.now();
  const handler = keyHandlers[e.code as keyof typeof keyHandlers];
  if (!handler) return;
  // Prevent repeated calls within cooldown
  if (cooldowns[e.code] && now - cooldowns[e.code] < COOLDOWN_DURATION) return;

  cooldowns[e.code] = now;

  try {
    await handler();
  } catch (err) {
    console.error(`Error handling key ${e.code}:`, err);
  }
});

window.addEventListener("keyup", (e) => {
  if (chatInput === document.activeElement) return;
  if (movementKeys.has(e.code)) {
    pressedKeys.delete(e.code);
    if (pressedKeys.size === 0) {
      isKeyPressed = false;
    }
  }
});

function handleKeyPress() {
  if (!loaded || controllerConnected || pauseMenu.style.display === "block" || isMoving) return;
  isMoving = true;
  lastDirection = "";
  pendingRequest = false;
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

function createNPC(data: any) {
  const npc: {
    id: string;
    position: { x: number; y: number };
    dialog: string;
    particles?: Particle[];
    hidden?: boolean;
    quest: number | null;
    show: (context: CanvasRenderingContext2D) => void;
    updateParticle: (particle: Particle, npc: any, context: CanvasRenderingContext2D, deltaTime: number) => void;
    dialogue: (context: CanvasRenderingContext2D) => void;
  } = {
    id: data.id,
    dialog: data.dialog || "",
    position: {
      x: canvas.width / 2 + data.location.x,
      y: canvas.height / 2 + data.location.y,
    },
    particles: data.particles || [],
    quest: data.quest || null,
    dialogue: function (this: typeof npc, context: CanvasRenderingContext2D) {
      if (this.dialog) {
        if (this.dialog.trim() !== "") {
          context.fillStyle = "black";
          context.fillStyle = "white";
          context.font = "14px 'Comic Relief'";
          context.textAlign = "center";
          
          const lines = getLines(context, this.dialog, 500).reverse();
          let startingPosition = this.position.y;

          for (let i = 0; i < lines.length; i++) {
            startingPosition -= 15;
            context.fillText(lines[i], this.position.x + 16, startingPosition);
          }
        }
      }
    },
    show: function (this: typeof npc, context: CanvasRenderingContext2D) {
      if (!npcImage || !context) return;

      context.globalAlpha = 1;

      if (!data?.hidden) {
        context.drawImage(npcImage, this.position.x, this.position.y, npcImage.width, npcImage.height);
      }
    },
    updateParticle: async (particle: Particle, npc: any, context: CanvasRenderingContext2D, deltaTime: number) => {
      // Initialize particle arrays and timing for each type if they don't exist
      if (!npc.particleArrays) {
        npc.particleArrays = {};
        npc.lastEmitTime = {};
      }
      
      const currentTime = performance.now();
      const emitInterval = (particle.interval || 1) * 16.67; // Convert to milliseconds (60fps = 16.67ms)
      
      // Initialize or get the last emit time for this particle type
      if (!npc.lastEmitTime[particle.name || '']) {
        npc.lastEmitTime[particle.name || ''] = currentTime;
      }
      
      // Initialize particle array if it doesn't exist
      if (!npc.particleArrays[particle.name || '']) {
        npc.particleArrays[particle.name || ''] = [];
      }

      // Check if it's time to emit a new particle
      if (currentTime - npc.lastEmitTime[particle.name || ''] >= emitInterval) {
        const randomLifetimeExtension = Math.random() * (particle.staggertime || 0);
        const baseLifetime = particle.lifetime || 1000;
        const windDirection = typeof particle.weather === 'object' ? particle.weather.wind_direction : null;
        const windSpeed = typeof particle.weather === 'object' ? particle.weather.wind_speed || 0 : 0;

        // Default wind bias to 0
        const windBias = {
          x: 0,
          y: 0
        }

        if (windDirection !== null && (windDirection === 'left' || windDirection === 'right')) {
          // Apply wind direction bias to initial position
          const windDirectionRad = (windDirection === 'left' ? 180 : 
                                  windDirection === 'right' ? 0 : 180) * Math.PI / 180;
          windBias.x = Math.cos(windDirectionRad) * windSpeed * 0.5;
          windBias.y = Math.sin(windDirectionRad) * windSpeed * 0.5;
        }

        const newParticle: Particle = {
          ...particle,
          localposition: { 
            x: Number(particle.localposition?.x || 0) + (Math.random() < 0.5 ? -1 : 1) * Math.random() * Number(particle.spread.x),
            y: Number(particle.localposition?.y || 0) + (Math.random() < 0.5 ? -1 : 1) * Math.random() * Number(particle.spread.y)
          },
          velocity: { 
            x: Number(particle.velocity.x || 0) + windBias.x,
            y: Number(particle.velocity.y || 0) + windBias.y
          },
          lifetime: baseLifetime + randomLifetimeExtension,
          currentLife: baseLifetime + randomLifetimeExtension,
          opacity: particle.opacity || 1,
          visible: true,
          size: particle.size || 5,
          color: particle.color || 'white',
          gravity: { ...particle.gravity },
          weather: typeof particle.weather === 'object' ? { ...particle.weather } : 'none'
        };

        // Remove oldest particle if we exceed the maximum amount
        if (npc.particleArrays[particle.name || ''].length >= particle.amount) {
          npc.particleArrays[particle.name || ''].shift();
        }
        
        npc.particleArrays[particle.name || ''].push(newParticle);
        npc.lastEmitTime[particle.name || ''] = currentTime;
      }

      // Update and render existing particles for this type
      const particles = npc.particleArrays[particle.name || ''];
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        
        // Decrease lifetime
        p.currentLife -= deltaTime * 1000;

        // Remove dead particles
        if (p.currentLife <= 0) {
          particles.splice(i, 1);
          continue;
        }

        if (!p.localposition) {
          p.localposition = { x: 0, y: 0 };
        }

        // Apply gravity and wind effects
        if (p.velocity && p.gravity) {
          const windDirection = typeof p.weather === 'object' ? p.weather.wind_direction : null;
          const windSpeed = typeof p.weather === 'object' ? p.weather.wind_speed || 0 : 0;
          const windForce = {
            x: 0,
            y: 0
          };

          if (windDirection !== 'none' && (windDirection === 'left' || windDirection === 'right')) {
            const windDirectionRad = (windDirection === 'left' ? 180 : 0) * Math.PI / 180;
            windForce.x = Math.cos(windDirectionRad) * windSpeed * 0.01;
            windForce.y = Math.sin(windDirectionRad) * windSpeed * 0.01;
          }

          // Update velocity with gravity and wind
          p.velocity.x += p.gravity.x * deltaTime + windForce.x;
          p.velocity.y += p.gravity.y * deltaTime + windForce.y;
          
          // Cap velocity considering wind influence
          const maxVelocity = {
            x: particle.velocity.x + (windSpeed * 0.2),
            y: particle.velocity.y + (windSpeed * 0.2)
          };
          
          p.velocity.x = Math.min(Math.max(p.velocity.x, -maxVelocity.x), maxVelocity.x);
          p.velocity.y = Math.min(Math.max(p.velocity.y, -maxVelocity.y), maxVelocity.y);
          
          // Update position
          p.localposition.x += p.velocity.x * deltaTime;
          p.localposition.y += p.velocity.y * deltaTime;
        }

        // Calculate render position
        const centerX = npc.position.x + 16 - (p.size / 2);
        const centerY = npc.position.y + 24 - (p.size / 2);
        const renderX = centerX + p.localposition.x;
        const renderY = centerY + p.localposition.y;

        // Calculate fade in/out alpha
        const fadeInDuration = p.lifetime * 0.4;
        const fadeOutDuration = p.lifetime * 0.4;
        let alpha;

        if (p.lifetime - p.currentLife < fadeInDuration) {
          // Fade in
          alpha = ((p.lifetime - p.currentLife) / fadeInDuration) * p.opacity;
        } else if (p.currentLife < fadeOutDuration) {
          // Fade out
          alpha = (p.currentLife / fadeOutDuration) * p.opacity;
        } else {
          // Fully visible
          alpha = p.opacity;
        }
        
        context.globalAlpha = alpha;

        // Draw particle as a circle
        context.beginPath();
        context.arc(renderX + p.size/2, renderY + p.size/2, p.size/2, 0, Math.PI * 2);
        context.fillStyle = p.color || "white";
        context.fill();
      }

      // Reset global alpha for other rendering
      context.globalAlpha = 1;
    }
  };

  npcs.push(npc);
  
  // Execute the npc script in a sandboxed environment where "this" refers to the npc object
  (async function () {
    try {
      await isLoaded();
      new Function(
        "with(this) { " + decodeURIComponent(data.script) + " }"
      ).call(npc);
    } catch (e) {
      console.error(`NPC script error (ID: ${npc.id}):`, e);
    }
  }).call(npc);
}

async function initializeAnimationWithWorker(animationData: any): Promise<any> {
  if (!animationData?.data?.data) return null;

  return new Promise((resolve) => {
    const worker = new Worker('animationWorker.js');

    worker.onmessage = (event) => {
      const { framesInfo, error } = event.data;
      if (error) {
        console.error('Animation Worker error:', error);
        resolve(null);
      } else {
        // Now create actual Image elements *on the main thread* to avoid worker complexity
        // We'll create empty Image objects for each frame as a placeholder
        // You can enhance this by sending URLs or blobs from server or worker

        const frames = framesInfo.map((frame : any) => {
          const img = new Image(frame.width, frame.height);
          // You will need to assign img.src somewhere after
          // For now, leave blank or assign a placeholder
          return {
            imageElement: img,
            width: frame.width,
            height: frame.height,
            delay: frame.delay
          };
        });

        resolve({
          frames,
          currentFrame: 0,
          lastFrameTime: performance.now()
        });
      }
      worker.terminate();
    };

    worker.postMessage(animationData);
  });
}

async function createPlayer(data: any) {
  if (data.id === cachedPlayerId) {
    positionText.innerText = `Position: ${data.location.x}, ${data.location.y}`;
  }

  updateFriendOnlineStatus(data.username, true);

  console.log(`
    Username: ${data.username}
    UserID: ${data.userid}
    WebSocket ID: ${data.id}
    Animation: ${data.animation ? "Loaded" : "None"}
    Friends: ${data.friends ? data.friends.join(", ") : "None"}
    Position: (${data.location.x}, ${data.location.y})
    Stealth: ${data.isStealth ? "Yes" : "No"}
    Admin: ${data.isAdmin ? "Yes" : "No"}
    Guest: ${data.isGuest ? "Yes" : "No"}
    Party: ${data.party ? data.party.join(", ") : "None"}
    Stats: ${JSON.stringify(data.stats, null, 2)}
  `);

  const animationPromise = initializeAnimationWithWorker(data.animation);

  const player = {
    id: data.id,
    username: data.username,
    userid: data.userid,
    animation: null as null | Awaited<ReturnType<typeof initializeAnimationWithWorker>>,
    friends: data.friends || [],
    position: {
      x: canvas.width / 2 + data.location.x,
      y: canvas.height / 2 + data.location.y,
    },
    chat: "",
    isStealth: data.isStealth,
    isAdmin: data.isAdmin,
    isGuest: data.isGuest || false,
    _adminColorHue: Math.floor(Math.random() * 360),
    targeted: false,
    stats: data.stats,
    typing: false,
    typingTimeout: null as NodeJS.Timeout | null,
    typingImage: typingImage,
    party: data.party || null,
    showChat: function (context: CanvasRenderingContext2D) {
      if (this.chat) {
        if (this.chat.trim() !== "") {
          context.fillStyle = "black";
          context.fillStyle = "white";
          context.textAlign = "center";
          context.shadowBlur = 1;
          context.shadowColor = "black";
          context.shadowOffsetX = 1;
          context.shadowOffsetY = 1;
          context.font = "14px 'Comic Relief'";
          const lines = getLines(context, this.chat, 500).reverse();
          let startingPosition = this.position.y;

          for (let i = 0; i < lines.length; i++) {
            startingPosition -= 20;
            const textWidth = context.measureText(lines[i]).width;
            context.fillStyle = "rgba(0, 0, 0, 0.2)";
            context.fillRect(
              this.position.x + 16 - textWidth/2 - 5,
              startingPosition - 17,
              textWidth + 10,
              20
            );
            context.fillStyle = "white";
            context.fillText(lines[i], this.position.x + 16, startingPosition);
          }
        }
      }

      if (this.typing && this.typingImage) {
        // Show typing image at top left, using image's natural dimensions
        // Update opacity to 0.5 if the player is in stealth mode
        if (this.isStealth) {
          context.globalAlpha = 0.8;
        }

        // Add a shadow to the typing image
        context.shadowColor = "black";
        context.shadowBlur = 2;
        context.shadowOffsetX = 0;
        context.shadowOffsetY = 0;
        // Shrink the image in half
        
        context.drawImage(
          this.typingImage,
          this.position.x - this.typingImage.width + 15, 
          this.position.y - this.typingImage.height + 15,
          this.typingImage.width / 1.5,
          this.typingImage.height / 1.5
        );
        
        // Reset opacity
        context.globalAlpha = 1;
        context.shadowColor = "transparent";
        context.shadowBlur = 0;
      }

      // Reset shadow settings
      context.shadowColor = "transparent";
      context.shadowBlur = 0;
      context.shadowOffsetX = 0;
      context.shadowOffsetY = 0;
    },
    renderAnimation: function (context: CanvasRenderingContext2D) {
        if (this.isStealth) {
        context.globalAlpha = 0.5;
      } else {
        context.globalAlpha = 1;
      }

      if (!this.animation?.frames?.length) {
        return;
      }

      const now = performance.now();
      const frame = this.animation.frames[this.animation.currentFrame];
      
      if (now - this.animation.lastFrameTime > frame.delay) {
        this.animation.currentFrame = (this.animation.currentFrame + 1) % this.animation.frames.length;
        this.animation.lastFrameTime = now;
      }

      if (frame.imageElement?.complete) {
        context.drawImage(
          frame.imageElement,
          this.position.x + 16 - frame.width/2,
          this.position.y + 24 - frame.height/2,
          frame.width,
          frame.height
        );
      }

      // Reset global alpha for other rendering
      context.globalAlpha = 1;
    },
    show: function (context: CanvasRenderingContext2D) {
      let shadow: { width: number; height: number; fillStyle: string; borderColor: string } = { width: 0, height: 0, fillStyle: "black", borderColor: "black" };
      if (this.targeted) {
        shadow = {
          width: 18,
          height: 7,
          fillStyle: "rgba(255, 0, 0, 0.35)",
          borderColor: "rgba(255, 0, 0, 0.8)"
        };
      } else {
        shadow = {
          width: 15,
          height: 5,
          fillStyle: "rgba(0, 0, 0, 0.35)",
          borderColor: "transparent"
        };
      }

      // Outer ring (darker)
      context.save();
      context.beginPath();
      context.ellipse(
        this.position.x + 16,
        this.position.y + 40,
        shadow.width,
        shadow.height,
        0,
        0,
        Math.PI * 2
      );
      context.strokeStyle = shadow.borderColor;
      context.lineWidth = 1;
      context.stroke();

      // Inner fill (lighter)
      context.beginPath();
      context.ellipse(
        this.position.x + 16,
        this.position.y + 40,
        shadow.width,
        shadow.height,
        0,
        0,
        Math.PI * 2
      );
      context.fillStyle = shadow.fillStyle;
      context.fill();
      context.closePath();
      context.restore();

      context.globalAlpha = 1;
      context.font = "14px 'Comic Relief'";
      
      // Opacity for stealth mode
      if (this.isStealth) {
        context.fillStyle = "rgba(97, 168, 255, 1)";
      } else {
        context.fillStyle = "white";
      }

      // Draw the player's username
      context.textAlign = "center";

      const currentPlayer = players.find(player => player.id === cachedPlayerId);
      if (!currentPlayer) return;
      
      // Determine color for player name
      let nameColor: string | undefined;

      const isCurrent = data.id === currentPlayer?.id;
      const isVisible = !this.isStealth;

      // Admin color animation (only when visible)
      if (this.isAdmin && isVisible) {
        this._adminColorHue = (this._adminColorHue + 2) % 360;
        nameColor = `hsl(${this._adminColorHue}, 100%, 50%)`;
      }

      if (isCurrent && isVisible && !this.isAdmin) {
        nameColor = "#ffe561";
      } else if (this.isStealth) {
        nameColor = "rgba(97, 168, 255, 1)";
      } else if (!nameColor) {
        if (currentPlayer.party?.includes(this.username)) {
          nameColor = "#00ff88ff";
        } else if (currentPlayer.friends.includes(this.username)) {
          nameColor = "#00b7ffff";
        } else {
          nameColor = "#FFFFFF";
        }
      }

      context.fillStyle = nameColor;


      context.shadowColor = "black";
      context.shadowBlur = 2;
      context.shadowOffsetX = 0;
      context.strokeStyle = "black";
      
      // Uppercase the first letter of the username
      if (this.isGuest) {
        data.username = "Guest";
      } else {
        data.username = data.username.charAt(0).toUpperCase() + data.username.slice(1);
      }

      context.strokeText(
        data.username,
        this.position.x + 16,
        this.position.y + 65
      );
      context.fillText(
        data.username,
        this.position.x + 16,
        this.position.y + 65
      );

      // Draw the player's health bar below the player's name with a width of 100px, centered below the player name
      if (!this.isStealth) {
        if (data.id === cachedPlayerId || this.targeted) {
          context.fillStyle = "rgba(0, 0, 0, 0.8)";
          context.fillRect(this.position.x - 34, this.position.y + 71, 100, 3);

          // Update the shadowblur to 2
          context.shadowBlur = 2;
        
          // Set health bar color based on health percentage
          const healthPercent = this.stats.health / this.stats.max_health;
          if (healthPercent < 0.3) {
            context.fillStyle = "#C81D1D"; // red
          } else if (healthPercent < 0.5) {
            context.fillStyle = "#C87C1D"; // orange
          } else if (healthPercent < 0.8) {
            context.fillStyle = "#C8C520"; // yellow
          } else {
            context.fillStyle = "#519D41"; // green
          }
          
          context.fillRect(
            this.position.x - 34,
            this.position.y + 71,
            healthPercent * 100,
            3
          );
        }

        // Draw the player's stamina bar below the player's health bar with a width of 75px, centered below the player's health bar
        // Check if current player is the same as the player we are drawing
        if (data.id === cachedPlayerId || this.targeted) {
        context.fillStyle = "rgba(0, 0, 0, 0.8)";
        context.fillRect(this.position.x - 34, this.position.y + 76, 100, 3);
        context.fillStyle = "#469CD9";
        context.fillRect(
          this.position.x - 34,
            this.position.y + 76,
            (this.stats.stamina / this.stats.max_stamina) * 100,
            3
          );
        }

        if (data.id === cachedPlayerId || this.targeted) {
          // Draw the player's level on the left side of the health bar
          context.textAlign = "left";
          context.font = "12px 'Comic Relief'";
          context.fillStyle = "white";
          // Text shadow for better visibility
          context.shadowColor = "black";
          context.shadowBlur = 2;
          context.fillText(`${this.stats.level}`, this.position.x - 50, this.position.y + 81);
        }
      }

      // Reset shadow settings
      context.shadowColor = "transparent";
      context.shadowBlur = 0;

      this.renderAnimation(context);
    },
  };

  players.push(player);

  player.animation = await animationPromise;

  if (data.id === cachedPlayerId) {
    cameraX = player.position.x - window.innerWidth / 2 + 8;
    cameraY = player.position.y - window.innerHeight / 2 + 48;
    window.scrollTo(cameraX, cameraY);
    updateFriendsList({friends: data.friends || []});
    createPartyUI(data.party || []);
    updateXp(data.stats.xp, data.stats.level, data.stats.max_xp);
  }
}

function getLines(ctx: any, text: string, maxWidth: number) {
  const words = text.split(" ");
  const lines = [];
  let currentLine = words[0];

  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    const width = ctx.measureText(currentLine + " " + word).width;
    if (width < maxWidth) {
      currentLine += " " + word;
    } else {
      lines.push(currentLine);
      currentLine = word;
    }
  }
  lines.push(currentLine);
  return lines;
}

// Snap to player's position on resize
window.addEventListener("resize", () => {
  updateViewportCache();
  const currentPlayer = players.find((player) => player.id === cachedPlayerId);
  if (currentPlayer) {
    cameraX = currentPlayer.position.x - window.innerWidth / 2 + 8;
    cameraY = currentPlayer.position.y - window.innerHeight / 2 + 48;
    window.scrollTo(cameraX, cameraY);
  }
  // Remove the context menu on resize
  if (document.getElementById("context-menu")) {
    document.getElementById("context-menu")!.remove();
  }
});

// Prevent unfocusing the window
window.addEventListener("blur", () => {
  isKeyPressed = false;
  // Clear the pressedKeys set
  pressedKeys.clear();
});

// Helper function to update health bar styling
function updateHealthBar(bar: HTMLDivElement, healthPercent: number) {
  const xscale = Math.max(0, Math.min(1, healthPercent / 100)) || 0;
  bar.animate([
    { transform: `scaleX(${xscale})` }
  ], {
    duration: 0,
    fill: 'forwards'
  });

  // Avoid clearing and re-adding class if unnecessary
  let colorClass = "green";
  if (healthPercent < 30) {
    colorClass = "red";
  } else if (healthPercent < 50) {
    colorClass = "orange";
  } else if (healthPercent < 80) {
    colorClass = "yellow";
  }

  const current = Array.from(bar.classList).find(c =>
    ["green", "yellow", "orange", "red"].includes(c)
  );

  if (current !== colorClass) {
    bar.classList.remove("green", "yellow", "orange", "red");
    bar.classList.add(colorClass);
  }

  // Ensure base class is set
  if (!bar.classList.contains("ui")) {
    bar.classList.add("ui");
  }
}

function updateStaminaBar(bar: HTMLDivElement, staminaPercent: number) {
  const xscale = Math.max(0, Math.min(1, staminaPercent / 100)) || 0;
  bar.animate([
    { transform: `scaleX(${xscale})` }
  ], {
    duration: 0,
    fill: 'forwards'
  });
}

document
  .getElementById("pause-menu-action-back")
  ?.addEventListener("click", () => {
    pauseMenu.style.display = "none";
  });

document
  .getElementById("pause-menu-action-options")
  ?.addEventListener("click", () => {
    // If any other menu is open, close all other menus
    pauseMenu.style.display = "none";
    optionsMenu.style.display = "block";
  });

document
  .getElementById("pause-menu-action-exit")
  ?.addEventListener("click", () => {
    sendRequest({
      type: "LOGOUT",
          data: null,
    });
    window.location.href = "/";
  });

fpsSlider.addEventListener("input", () => {
  document.getElementById(
    "limit-fps-label"
  )!.innerText = `FPS: (${fpsSlider.value})`;
});

musicSlider.addEventListener("input", () => {
  document.getElementById(
    "music-volume-label"
  )!.innerText = `Music: (${musicSlider.value})`;
});

effectsSlider.addEventListener("input", () => {
  document.getElementById(
    "effects-volume-label"
  )!.innerText = `Effects: (${effectsSlider.value})`;
});

[fpsSlider, musicSlider, effectsSlider, mutedCheckbox].forEach(element => {
  element.addEventListener("change", () => {
    sendRequest({
      type: "CLIENTCONFIG",
          data: {
            fps: parseInt(fpsSlider.value),
            music_volume: parseInt(musicSlider.value) || 0,
            effects_volume: parseInt(effectsSlider.value) || 0,
            muted: mutedCheckbox.checked,
          } as ConfigData,
    });
  });
});

const partyContextActions: Record<string, { only_self: boolean, allowed_self: boolean, label: string, handler: (username: string) => void }> = {
  'kick-player': {
    label: 'Kick',
    allowed_self: false,
    only_self: false,
    handler: (username) => {
      sendRequest({
        type: "KICK_PARTY_MEMBER",
        data: { username: username },
      });
    }
  },
  'leave-party': {
    label: 'Leave Party',
    allowed_self: true,
    only_self: true,
    handler: (username) => {
      sendRequest({
        type: "LEAVE_PARTY",
        data: { username: username },
      });
    }
  },
}

const contextActions: Record<string, { allowed_self: boolean, label: string, handler: (id: string) => void }> = {
  'inspect-player': {
    label: 'Inspect',
    allowed_self: true,
    handler: (id) => {
      console.log(`Inspecting player ${id}`);
    }
  },
  'send-message': {
    label: 'Send Message',
    allowed_self: false,
    handler: (id) => {
      // Update the document to add /w and the player's username
      const chatInput = document.getElementById("chat-input") as HTMLInputElement;
      const username = players.find(player => player.id === id)?.username || null;
      if (!username) return;
      chatInput.value = `/w ${username} `;
      chatInput.focus();
    }
  },
  'invite-to-party': {
    label: 'Invite to Party',
    allowed_self: false,
    handler: (id) => {
      sendRequest({
        type: "INVITE_PARTY",
        data: { id: id },
      });
    }
  },
  'add-friend': {
    label: 'Add Friend',
    allowed_self: false,
    handler: (id) => {
      sendRequest({
        type: "ADD_FRIEND",
        data: { id: id },
      });
    }
  },
  'remove-friend': {
    label: 'Remove Friend',
    allowed_self: false,
    handler: (id) => {
      sendRequest({
        type: "REMOVE_FRIEND",
        data: { id: id },
      });
    }
  },
  'invite-to-guild': {
    label: 'Invite to Guild',
    allowed_self: false,
    handler: (id) => {
      console.log(`Inviting ${id} to guild`);
    }
  },
  'block-player': {
    label: 'Block Player',
    allowed_self: false,
    handler: (id) => {
      console.log(`Blocking player ${id}`);
    }
  },
  'report-player': {
    label: 'Report Player',
    allowed_self: false,
    handler: (id) => {
      console.log(`Reporting player ${id}`);
    }
  },
};


function createPartyContextMenu(event: MouseEvent, username: string) {
  if (!loaded) return;
  document.getElementById("context-menu")?.remove();

  const contextMenu = document.createElement("div");
  contextMenu.id = 'context-menu';
  contextMenu.style.left = `${event.clientX}px`;
  contextMenu.style.top = `${event.clientY}px`;

  // If we are off the screen, adjust position
  if (event.clientX + 200 > window.innerWidth) {
    contextMenu.style.left = `${event.clientX - 200}px`;
  }

  if (event.clientX - 200 < 0) {
    contextMenu.style.left = `${event.clientX + 50}px`;
  }

  if (event.clientY + 150 > window.innerHeight) {
    contextMenu.style.top = `${event.clientY - 150}px`;
  }

  if (event.clientY - 150 < 0) {
    contextMenu.style.top = `${event.clientY + 50}px`;
  }

  contextMenu.dataset.username = username.toLowerCase();
  const ul = document.createElement("ul");
  const currentPlayer = players.find(player => player.id === cachedPlayerId);
  const isSelf = currentPlayer?.username.toLowerCase() === username.toLowerCase();
  Object.entries(partyContextActions).forEach(([action, { label, handler, only_self, allowed_self }]) => {
    if (only_self && !isSelf) return; // Skip actions that are only for self
    if (!allowed_self && isSelf) return; // Skip actions that are not allowed for self

    const li = document.createElement("li");
    li.id = `context-${action}`;
    li.innerText = label;

    li.onclick = (e) => {
      e.stopPropagation();
      handler(username);
      contextMenu.remove();
    };

    ul.appendChild(li);
  });

  contextMenu.appendChild(ul);
  overlay.appendChild(contextMenu);
  document.addEventListener("click", () => contextMenu.remove(), { once: true });
}

function createContextMenu(event: MouseEvent, id: string) {
  if (!loaded) return;
  document.getElementById("context-menu")?.remove();

  const contextMenu = document.createElement("div");
  contextMenu.id = 'context-menu';
  contextMenu.style.left = `${event.clientX}px`;
  contextMenu.style.top = `${event.clientY}px`;
  // If we are off the screen, adjust position
  if (event.clientX + 200 > window.innerWidth) {
    contextMenu.style.left = `${event.clientX - 200}px`;
  }

  if (event.clientX - 200 < 0) {
    contextMenu.style.left = `${event.clientX + 50}px`;
  }

  if (event.clientY + 150 > window.innerHeight) {
    contextMenu.style.top = `${event.clientY - 150}px`;
  }

  if (event.clientY - 150 < 0) {
    contextMenu.style.top = `${event.clientY + 50}px`;
  }
  
  contextMenu.dataset.id = id;

  const ul = document.createElement("ul");
  const isSelf = id === cachedPlayerId;
  const currentPlayer = players.find(player => player.id === cachedPlayerId);
  const targetedPlayer = players.find(player => player.id === id);
  const isFriend = currentPlayer?.friends?.includes(targetedPlayer?.username?.toString()) || false;
  const isInParty = currentPlayer?.party?.includes(targetedPlayer?.username?.toString()) || false;

  Object.entries(contextActions).forEach(([action, { label, handler, allowed_self }]) => {
    if (!allowed_self && isSelf) return;

    // Skip "invite-to-party" if already in party
    if (action === 'invite-to-party' && isInParty) return;

    // Skip "add-friend" if already friends
    if (action === 'add-friend' && isFriend) return;

    // Skip "remove-friend" if not friends
    if (action === 'remove-friend' && !isFriend) return;

    const li = document.createElement("li");
    li.id = `context-${action}`;
    li.innerText = label;

    li.onclick = (e) => {
      e.stopPropagation();
      handler(id);
      contextMenu.remove();
    };

    ul.appendChild(li);
  });

  contextMenu.appendChild(ul);
  overlay.appendChild(contextMenu);

  document.addEventListener("click", () => contextMenu.remove(), { once: true });
}

// Capture click and get coordinates from canvas
document.addEventListener("contextmenu", (event) => {
  if (!loaded) return;
  if (contextMenuKeyTriggered) {
    event.preventDefault();
    contextMenuKeyTriggered = false;
    return;
  }
  // Handle right-click on the UI
  if ((event.target as HTMLElement)?.classList.contains("ui")) {
    // Check if we clicked on a party member
    const partyMember = (event.target as HTMLElement).closest(".party-member") as HTMLElement;
    if (partyMember) {
      const username = partyMember.dataset.username;
      if (username) {
        createPartyContextMenu(event, username);
      }
      event.preventDefault();
      return;
    }
    return;
  }
  // Check where we clicked on the canvas
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;

  // Did we click on a player?
  const clickedPlayer = players.find(player => {
    const playerX = player.position.x + 16; // Center of the player
    const playerY = player.position.y + 24; // Center of the player
    return (
      x >= playerX - 16 && x <= playerX + 16 &&
      y >= playerY - 24 && y <= playerY + 24
    );
  });

  if (clickedPlayer) {
    const id = clickedPlayer.id;
    // Create context menu for the clicked player
    createContextMenu(event, id);
    return; // Stop further processing
  }

  // Remove any existing context menu
  const existingMenu = document.getElementById("context-menu");
  if (existingMenu) existingMenu.remove();
  const moveX = Math.floor(x - canvas.width / 2 - 16);
  const moveY = Math.floor(y - canvas.height / 2 - 24);
  sendRequest({
    type: "TELEPORTXY",
        data: { x: moveX, y: moveY },
  });
});

document.addEventListener("click", (event) => {
  // Check if we clicked on a player
  if (!loaded) return;
  if ((event.target as HTMLElement)?.classList.contains("ui")) return;
  // If we don't click on the context menu, remove it
  const contextMenu = document.getElementById("context-menu");
  if (contextMenu && !contextMenu.contains(event.target as Node)) {
    contextMenu.remove();
  }

  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;

  const moveX = x - canvas.width / 2 - 16;
  const moveY = y - canvas.height / 2 - 24;
  // Untarget any currently targeted player
  const target = players.find(player => player.targeted);
  if (target) {
    target.targeted = false;
  }

  sendRequest({
    type: "SELECTPLAYER",
    data: { x: moveX, y: moveY },
  });
});

async function encryptRsa(chatDecryptionKey: string, data: string) {
  const cleanedKey = cleanBase64Key(chatDecryptionKey);
  const importedKey = await window.crypto.subtle.importKey(
    "spki",
    new Uint8Array(atob(cleanedKey).split('').map(c => c.charCodeAt(0))),
    {
      name: "RSA-OAEP",
      hash: "SHA-256"
    },
    false,
    ["encrypt"]
  );

  const encoded = new TextEncoder().encode(data);
  const encrypted = await window.crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    importedKey,
    encoded
  );

  return new Uint8Array(encrypted);
}

function cleanBase64Key(base64Key: string): string {
  return base64Key.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s+/g, '');
}

/* Notifications */
const notificationContainer = document.getElementById("game-notification-container");
const notificationMessage = document.getElementById("game-notification-message");
let clearNotificationTimeout: any = null;

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

// Add these event listeners near other chat input related code
chatInput.addEventListener("focus", () => {
  stopMovement();
});

friendsListSearch.addEventListener("focus", () => {
  stopMovement();
});

chatInput.addEventListener("blur", () => {
  // Send abort packet when chat is closed
  sendRequest({
    type: "MOVEXY",
    data: "ABORT",
  });
  // Clear pressed keys to prevent continued movement
  pressedKeys.clear();
  isKeyPressed = false;
  isMoving = false;
});

function sendRequest(data: any) {
  sentRequests++;
  socket.send(packet.encode(JSON.stringify(data)));
}

setInterval(() => {
  if (packetsSentReceived.innerText === `Sent: ${sentRequests}, Received: ${receivedResponses}`) return;
  packetsSentReceived.innerText = `Sent: ${sentRequests}, Received: ${receivedResponses}`;
  sentRequests = 0;
  receivedResponses = 0;
}, 1000);

function stopMovement() {
  // Send abort packet when chat is opened
  sendRequest({
    type: "MOVEXY",
    data: "ABORT",
  });
  // Clear pressed keys to prevent continued movement
  pressedKeys.clear();
  isKeyPressed = false;
  isMoving = false;
}

// Create invitation popup model
function createInvitationPopup(invitationData: any) {
  // Check if the popup already exists
  const existingPopup = document.getElementById("invitation-popup");
  if (existingPopup) {
    // If it exists, remove it
    existingPopup.remove();
  }
  const popup = document.createElement("div");
  popup.id = "invitation-popup";
  popup.className = "popup";
  popup.innerHTML = `
    <h2>Invitation</h2>
    <p>${invitationData.message}</p>
    <button id="accept-invitation">Accept</button>
    <button id="decline-invitation">Decline</button>
  `;

  document.body.appendChild(popup);

  const acceptButton = document.getElementById("accept-invitation");
  const declineButton = document.getElementById("decline-invitation");
  let data;

  switch (invitationData.action.toUpperCase()) {
    case "FRIEND_REQUEST": {
      data = {
        type: "INVITATION_RESPONSE",
        data: {
          authorization: invitationData.authorization,
          originator: invitationData.originator,
          action: "FRIEND_REQUEST",
        },
      }
    }
    break;
    case "INVITE_PARTY": {
      data = {
        type: "INVITATION_RESPONSE",
        data: {
          authorization: invitationData.authorization,
          originator: invitationData.originator,
          action: "INVITE_PARTY",
        },
      }
    }
    break;  
  }

  if (!data) return;

  // Add event listeners for accept and decline buttons
  acceptButton?.addEventListener("click", () => {
    data.data.response = "ACCEPT";
    sendRequest(data);
    popup.remove();
  });

  declineButton?.addEventListener("click", () => {
    data.data.response = "DECLINE";
    sendRequest(data);
    popup.remove();
  });
}

function updateFriendOnlineStatus(friendName: string, isOnline: boolean) {
  setTimeout(() => {
    const list = Array.from(friendsList.querySelectorAll('.friend-name')) as HTMLElement[];
    if (!list.length) {
      return;
    }
    list.forEach((item: HTMLElement) => {
      const name = item.innerText.toLowerCase();
      if (name === friendName.toLowerCase()) {
        const statusElement = item.nextElementSibling as HTMLElement;
        if (statusElement) {
          statusElement.classList.toggle("online", isOnline);
          statusElement.classList.toggle("offline", !isOnline);
          statusElement.innerText = isOnline ? "Online" : "Offline";
        }
      }
    });
    }, 2000); // Delay to ensure the friends list is fully loaded
}

function updateFriendsList(data: any) {
    const currentPlayer = players.find(player => player.id === cachedPlayerId);
    if (!currentPlayer || !data?.friends) return;

    const list = Array.from(friendsList.querySelectorAll('.friend-name')) as HTMLElement[];

    // Step 1: Remove friends from UI that are no longer in data.friends
    list.forEach((item: HTMLElement) => {
        const name = item.innerText.toLowerCase();
        if (!data.friends.map((f: string) => f.toLowerCase()).includes(name)) {
            item.parentElement?.remove(); // Remove the whole friend-item div
        }
    });

    // Step 2: Add new friends from data.friends if they don't exist in UI
    data.friends.forEach((friend: string) => {
        const exists = list.some(item => item.innerText.toLowerCase() === friend.toLowerCase());
        if (!exists) {
            const friendElement = document.createElement("div");
            friendElement.classList.add("friend-item", "ui");

            const friendName = document.createElement("div");
            friendName.classList.add("friend-name");
            friendName.classList.add("ui");
            friendName.innerText = friend.charAt(0).toUpperCase() + friend.slice(1);
            friendElement.appendChild(friendName);

            const friendStatus = document.createElement("div");
            const isOnline = players.some(player => player.username.toLowerCase() === friend.toLowerCase() && player.id !== cachedPlayerId);
            friendStatus.classList.add("friend-status", isOnline ? "online" : "offline");
            friendStatus.classList.add("ui");
            friendStatus.innerText = isOnline ? "Online" : "Offline";
            friendElement.appendChild(friendStatus);

            // Create the remove button ("X")
            const removeButton = document.createElement("button");
            removeButton.innerText = "X";
            removeButton.classList.add("remove-friend-button");
            removeButton.classList.add("ui");

            // Add the click event handler
            removeButton.onclick = () => {
                sendRequest({
                    type: "REMOVE_FRIEND",
                    data: { username: friend },
                });
            };

            friendElement.appendChild(removeButton);
            friendsList.appendChild(friendElement);
        }
    });
}

friendsListSearch.addEventListener("input", () => {
  const searchTerm = friendsListSearch.value.toLowerCase();
  const friendItems = Array.from(friendsList.querySelectorAll('.friend-item')) as HTMLElement[];
  if (!searchTerm) {
    // If search term is empty, show all items
    friendItems.forEach(item => {
      item.style.display = 'block'; // Reset display to default
    });
    return;
  }

  friendItems.forEach(item => {
    const friendName = item.querySelector('.friend-name')?.textContent?.toLowerCase() || '';
    if (friendName.includes(searchTerm)) {
      item.style.display = 'block'; // Show matching items
    } else {
      item.style.display = 'none'; // Hide non-matching items
    }
  });
});

// Create party UI
function createPartyUI(partyMembers: string[]) {
  const partyContainer = document.getElementById("party-container");
  if (!partyContainer) return;

  // If no party members, remove all current ones and exit
  if (partyMembers.length === 0) {
    const existingMembers = partyContainer.querySelectorAll(".party-member");
    existingMembers.forEach(member => partyContainer.removeChild(member));
    return;
  }

  const existingElements = Array.from(
    partyContainer.querySelectorAll(".party-member-username")
  );

  const existingNames = new Map<string, HTMLElement>();
  existingElements.forEach(el => {
    const name = el.textContent?.toLowerCase();
    if (name) {
      const container = el.closest(".party-member") as HTMLElement;
      if (container) {
        existingNames.set(name, container);
      }
    }
  });

  const desiredNames = new Set(partyMembers.map(name => name.toLowerCase()));

  // Remove members no longer in the list
  for (const [name, el] of existingNames.entries()) {
    if (!desiredNames.has(name)) {
      partyContainer.removeChild(el);
    }
  }

  // Sort alphabetically by username
  partyMembers.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  // Add new members
  for (const member of partyMembers) {
    const lowerName = member.toLowerCase();
    if (!existingNames.has(lowerName)) {
      const memberElement = document.createElement("div");
      memberElement.className = "party-member ui";
      memberElement.dataset.username = lowerName;

      const usernameElement = document.createElement("div");
      usernameElement.className = "party-member-username ui";
      usernameElement.innerText = member.charAt(0).toUpperCase() + member.slice(1);

      memberElement.appendChild(usernameElement);
      partyContainer.appendChild(memberElement);
    }
  }
}


// function displayElement(element: HTMLElement, display: boolean) {
//     element.animate([
//       { transform: `scaleX(${display ? 1 : 0})` },
//     ], {
//       duration: 0,
//       fill: "forwards"
//     });
// }