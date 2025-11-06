import { getIsLoaded, cachedPlayerId, sendRequest } from "./socket.js";
import { getIsKeyPressed, pressedKeys, setIsMoving, getIsMoving } from "./input.js";
import Cache from "./cache";
let weatherType = null as string | null;
const cache = Cache.getInstance();
import { updateHealthBar, updateStaminaBar } from "./ui.js";
import { updateWeatherCanvas, weather } from './weather.ts';
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

  const { chunkPixelSize, chunksX, chunksY } = window.mapChunks;
  const paddingPx = chunkPixelSize * 0.5;

  const left = Math.max(0, Math.floor((cachedViewport.x - paddingPx) / chunkPixelSize));
  const top = Math.max(0, Math.floor((cachedViewport.y - paddingPx) / chunkPixelSize));
  const right = Math.min(chunksX - 1, Math.floor((cachedViewport.x + cachedViewport.w + paddingPx) / chunkPixelSize));
  const bottom = Math.min(chunksY - 1, Math.floor((cachedViewport.y + cachedViewport.h + paddingPx) / chunkPixelSize));

  const visible = new Set<string>();
  for (let cy = top; cy <= bottom; cy++) {
    for (let cx = left; cx <= right; cx++) {
      visible.add(`${cx}-${cy}`);
    }
  }
  return visible;
}

function updateChunkVisibility() {
  if (!window.mapChunks) return;
  const currentViewportChunks = getViewportChunks();
  const chunksChanged =
    currentViewportChunks.size !== lastViewportChunks.size ||
    [...currentViewportChunks].some(chunk => !lastViewportChunks.has(chunk));
  if (!chunksChanged) return;

  // Collect chunks that need to be redrawn (old + new visible chunks)
  const chunksToRedraw = new Set([...lastViewportChunks, ...currentViewportChunks]);

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

  // Use optimized partial redraw instead of full canvas redraw
  window.mapChunks.redrawMainCanvas(true, chunksToRedraw);
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
    if (weatherType) {
      updateWeatherCanvas(cameraX, cameraY);
      weather(weatherType);
    }
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

  // Cache players array to avoid repeated Array.from() calls
  const playersArray = Array.from(cache.players);
  const currentPlayer = playersArray.find(player => player.id === cachedPlayerId);
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

  // Disable image smoothing for better performance without hardware acceleration
  ctx.imageSmoothingEnabled = false;

  const isInView = (x: number, y: number) =>
    x >= cachedPaddedBounds.x &&
    y >= cachedPaddedBounds.y &&
    x <= cachedPaddedBounds.x + cachedPaddedBounds.w &&
    y <= cachedPaddedBounds.y + cachedPaddedBounds.h;
  const visiblePlayers = playersArray.filter(p =>
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
  const targetPlayer = playersArray.find(p => p.targeted);
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
    for (const p of visiblePlayers) p.show(ctx, currentPlayer);
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
    for (const p of visiblePlayers) p.showChat(ctx, currentPlayer);
  }
  if (times.length > 60) times.shift();
  times.push(now);
  requestAnimationFrame(animationLoop);
  `requestAnimationFrame(weather);`
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

function getWeatherType() {
  return weatherType;
}

function setWeatherType(type: string | null) {
  weatherType = type;
}

export { lastDirection, setDirection, setPendingRequest, canvas, setCameraX, setCameraY, getCameraX, getCameraY, updateChunkVisibility, updateViewportCache, lastViewportChunks, setWeatherType, getWeatherType };