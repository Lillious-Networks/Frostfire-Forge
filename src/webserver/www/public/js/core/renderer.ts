import { getIsLoaded, cachedPlayerId, sendRequest } from "./socket.js";
import { getIsKeyPressed, pressedKeys, setIsMoving, getIsMoving } from "./input.js";
import Cache from "./cache";
const cache = Cache.getInstance();
import { updateHealthBar, updateStaminaBar } from "./ui.js";
import { chatInput } from "./chat.js";
import { friendsListSearch } from "./friends.js";
let lastUpdate = performance.now();
const times = [] as number[];
let lastDirection = "";
let pendingRequest = false;
let cameraX: number = 0, cameraY: number = 0, lastFrameTime: number = 0;
import { canvas, ctx, fpsSlider, healthBar, staminaBar, targetHealthBar, targetStaminaBar } from "./ui.js";

canvas.style.position = 'absolute';

declare global {
  interface Window {
    mapLayerCanvases?: Array<{ canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, zIndex: number }>;
    playerZIndex?: number;
    mapChunks?: any; 
  }
}

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

function lerp(start: number, end: number, amount: number) {
  return start + (end - start) * amount;
}

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

const cameraSmoothing = 0.05;
function updateCamera(currentPlayer: any) {
  if (!getIsLoaded()) return;
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
  const currentPlayer = cache.players.find(p => p.id === cachedPlayerId);
  if (!currentPlayer) {
    requestAnimationFrame(animationLoop);
    return;
  }
  updateCamera(currentPlayer);
  if (getIsMoving() && getIsKeyPressed()) {
    if (document.activeElement === chatInput || document.activeElement === friendsListSearch) {
      setIsMoving(false);
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
  } else if (getIsMoving() && !getIsKeyPressed()) {
    if (lastDirection !== "") sendRequest({ type: "MOVEXY", data: "ABORT" });
    setIsMoving(false);
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
  const visiblePlayers = cache.players.filter(p =>
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
  const targetPlayer = cache.players.find(p => p.targeted);
  if (targetPlayer) {
    const { health, max_health, stamina, max_stamina } = targetPlayer.stats;
    const healthPercent = (health / max_health) * 100;
    const staminaPercent = (stamina / max_stamina) * 100;
    updateHealthBar(targetHealthBar, healthPercent);
    updateStaminaBar(targetStaminaBar, staminaPercent);
  }
  const visibleNpcs = cache.npcs.filter(npc =>
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

updateViewportCache();
animationLoop();

function setDirection(dir: string) {
  lastDirection = dir;
}

function setPendingRequest(value: boolean) {
  pendingRequest = value;
}

function setCameraX(x: number) {
  cameraX = x;
}

function setCameraY(y: number) {
  cameraY = y;
}

function getCameraX() {
  return cameraX;
}

function getCameraY() {
  return cameraY;
}

export { lastDirection, setDirection, setPendingRequest, canvas, setCameraX, setCameraY, getCameraX, getCameraY, updateChunkVisibility, updateViewportCache, lastViewportChunks };