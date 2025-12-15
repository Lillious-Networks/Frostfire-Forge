import { getIsLoaded, cachedPlayerId, sendRequest } from "./socket.js";
import { getIsKeyPressed, pressedKeys, setIsMoving, getIsMoving } from "./input.js";
import Cache from "./cache.ts";
let weatherType = null as string | null;
const cache = Cache.getInstance();
import { updateHealthBar, updateStaminaBar } from "./ui.js";
import { updateWeatherCanvas, weather } from './weather.ts';
import { chatInput } from "./chat.js";
import { friendsListSearch } from "./friends.js";
const times = [] as number[];
let lastDirection = "";
let pendingRequest = false;
let cameraX: number = 0, cameraY: number = 0, lastFrameTime: number = 0;
import { canvas, ctx, fpsSlider, healthBar, staminaBar, targetHealthBar, targetStaminaBar, collisionDebugCheckbox, chunkOutlineDebugCheckbox, collisionTilesDebugCheckbox, noPvpDebugCheckbox, wireframeDebugCheckbox, showGridCheckbox } from "./ui.js";

canvas.style.position = 'fixed';

declare global {
  interface Window {
    mapData?: any;
  }
}

const cameraSmoothing = 1;
const snapThreshold = 0.1;
const loadedChunksSet = new Set<string>();
const pendingChunks = new Set<string>();

function lerp(start: number, end: number, amount: number) {
  return start + (end - start) * amount;
}

function updateCamera(currentPlayer: any, deltaTime: number) {
  if (!getIsLoaded()) return;
  if (currentPlayer && window.mapData) {
    const targetX = currentPlayer.position.x;
    const targetY = currentPlayer.position.y;

    // Calculate distance to target
    const distX = Math.abs(targetX - cameraX);
    const distY = Math.abs(targetY - cameraY);

    // If very close, snap directly to avoid micro-jitter
    if (distX < snapThreshold && distY < snapThreshold) {
      cameraX = targetX;
      cameraY = targetY;
    } else {
      // Use frame-rate independent smoothing with adaptive speed
      // Smoother camera that follows more closely
      const baseSmoothness = 1 - Math.pow(1 - cameraSmoothing, deltaTime);
      cameraX = lerp(cameraX, targetX, baseSmoothness);
      cameraY = lerp(cameraY, targetY, baseSmoothness);
    }

    // Clamp camera to map bounds to prevent showing black area outside map
    const mapWidth = window.mapData.width * window.mapData.tilewidth;
    const mapHeight = window.mapData.height * window.mapData.tileheight;
    const halfViewportWidth = window.innerWidth / 2;
    const halfViewportHeight = window.innerHeight / 2;

    // Prevent camera from showing area beyond map edges
    cameraX = Math.max(halfViewportWidth, Math.min(mapWidth - halfViewportWidth, cameraX));
    cameraY = Math.max(halfViewportHeight, Math.min(mapHeight - halfViewportHeight, cameraY));

    if (weatherType) {
      updateWeatherCanvas(cameraX, cameraY);
      weather(weatherType);
    }
  }
}

function getVisibleChunks(): Array<{x: number, y: number}> {
  if (!window.mapData) return [];

  const chunkPixelSize = window.mapData.chunkSize * window.mapData.tilewidth;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  // Calculate camera bounds in world space
  const cameraLeft = cameraX - viewportWidth / 2;
  const cameraTop = cameraY - viewportHeight / 2;
  const cameraRight = cameraX + viewportWidth / 2;
  const cameraBottom = cameraY + viewportHeight / 2;

  // Add padding to load chunks slightly off-screen
  const padding = chunkPixelSize;

  // Convert to chunk coordinates
  const startChunkX = Math.max(0, Math.floor((cameraLeft - padding) / chunkPixelSize));
  const startChunkY = Math.max(0, Math.floor((cameraTop - padding) / chunkPixelSize));
  const endChunkX = Math.min(window.mapData.chunksX - 1, Math.floor((cameraRight + padding) / chunkPixelSize));
  const endChunkY = Math.min(window.mapData.chunksY - 1, Math.floor((cameraBottom + padding) / chunkPixelSize));

  const visible: Array<{x: number, y: number}> = [];
  for (let cy = startChunkY; cy <= endChunkY; cy++) {
    for (let cx = startChunkX; cx <= endChunkX; cx++) {
      visible.push({ x: cx, y: cy });
    }
  }
  return visible;
}

async function loadVisibleChunks() {
  if (!window.mapData) return;

  const visibleChunks = getVisibleChunks();
  const visibleKeys = new Set(visibleChunks.map(c => `${c.x}-${c.y}`));

  // Unload chunks that are far away
  const unloadDistance = window.mapData.chunkSize * window.mapData.tilewidth * 3;
  for (const chunkKey of loadedChunksSet) {
    if (!visibleKeys.has(chunkKey)) {
      const [cx, cy] = chunkKey.split('-').map(Number);
      const chunkPixelSize = window.mapData.chunkSize * window.mapData.tilewidth;
      const chunkCenterX = (cx + 0.5) * chunkPixelSize;
      const chunkCenterY = (cy + 0.5) * chunkPixelSize;
      const distance = Math.hypot(chunkCenterX - cameraX, chunkCenterY - cameraY);

      if (distance > unloadDistance) {
        window.mapData.loadedChunks.delete(chunkKey);
        loadedChunksSet.delete(chunkKey);
      }
    }
  }

  // Load new visible chunks
  for (const chunk of visibleChunks) {
    const chunkKey = `${chunk.x}-${chunk.y}`;

    if (!loadedChunksSet.has(chunkKey) && !pendingChunks.has(chunkKey)) {
      pendingChunks.add(chunkKey);

      window.mapData.requestChunk(chunk.x, chunk.y)
        .then((chunkData: any) => {
          if (chunkData) {
            loadedChunksSet.add(chunkKey);
          }
        })
        .catch((error: any) => {
          console.error(`Failed to load chunk ${chunkKey}:`, error);
        })
        .finally(() => {
          pendingChunks.delete(chunkKey);
        });
    }
  }
}

let chunkLoadThrottle = 0;

function drawAllLayersWithOpacity(layer: 'lower' | 'upper', visibleChunks: any[], offsetX: number, offsetY: number, selectedLayerName: string) {
  if (!ctx || !window.mapData) return;

  const PLAYER_Z_INDEX = 3;
  const selectedLayerLower = selectedLayerName.toLowerCase();
  const isCollisionSelected = selectedLayerLower.includes('collision');
  const isNoPvpSelected = selectedLayerLower.includes('nopvp') || selectedLayerLower.includes('no-pvp');

  for (const chunk of visibleChunks) {
    const chunkKey = `${chunk.x}-${chunk.y}`;
    const chunkData = window.mapData.loadedChunks.get(chunkKey);
    if (!chunkData) continue;

    const chunkPixelSize = window.mapData.chunkSize * window.mapData.tilewidth;
    const chunkWorldX = chunk.x * chunkPixelSize;
    const chunkWorldY = chunk.y * chunkPixelSize;

    const screenX = chunkWorldX + offsetX;
    const screenY = chunkWorldY + offsetY;

    // Get all layers sorted by zIndex
    const sortedLayers = [...chunkData.layers].sort((a: any, b: any) => a.zIndex - b.zIndex);

    // Draw each layer
    for (const chunkLayer of sortedLayers) {
      // Only draw layers that belong to this canvas (lower/upper)
      const belongsToThisCanvas = layer === 'lower'
        ? chunkLayer.zIndex < PLAYER_Z_INDEX
        : chunkLayer.zIndex >= PLAYER_Z_INDEX;

      if (!belongsToThisCanvas) continue;

      const isSelected = chunkLayer.name === selectedLayerName;
      const layerNameLower = chunkLayer.name.toLowerCase();
      const isCollisionLayer = layerNameLower.includes('collision');
      const isNoPvpLayer = layerNameLower.includes('nopvp') || layerNameLower.includes('no-pvp');

      // Skip collision/nopvp layers entirely if not selected (they're shown via debug visualization)
      if ((isCollisionLayer || isNoPvpLayer) && !isSelected) {
        continue;
      }

      // If a collision or no-pvp layer is selected, draw all other layers at full opacity
      // Otherwise use partial opacity for non-selected layers
      if (isCollisionSelected || isNoPvpSelected) {
        // When collision/nopvp is selected, don't draw the collision/nopvp tiles
        // (they're shown via debug boxes instead)
        if (isCollisionLayer || isNoPvpLayer) {
          continue;
        }
        ctx.globalAlpha = 1.0;
      } else {
        ctx.globalAlpha = isSelected ? 1.0 : 0.5;
      }

      // Draw tiles from this layer
      for (let y = 0; y < chunkData.height; y++) {
        for (let x = 0; x < chunkData.width; x++) {
          const tileIndex = chunkLayer.data[y * chunkData.width + x];
          if (tileIndex === 0) continue;

          const tileset = window.mapData.tilesets.find(
            (t: any) => t.firstgid <= tileIndex && tileIndex < t.firstgid + t.tilecount
          );
          if (!tileset) continue;

          const image = window.mapData.images[window.mapData.tilesets.indexOf(tileset)];
          if (!image || !image.complete) continue;

          const localTileIndex = tileIndex - tileset.firstgid;
          const tilesPerRow = Math.floor(tileset.imagewidth / tileset.tilewidth);
          const tileX = (localTileIndex % tilesPerRow) * tileset.tilewidth;
          const tileY = Math.floor(localTileIndex / tilesPerRow) * tileset.tileheight;

          const drawX = screenX + x * window.mapData.tilewidth;
          const drawY = screenY + y * window.mapData.tileheight;

          try {
            ctx.drawImage(
              image,
              tileX, tileY,
              tileset.tilewidth, tileset.tileheight,
              drawX, drawY,
              window.mapData.tilewidth, window.mapData.tileheight
            );
          } catch (error) {
            // Ignore draw errors
          }
        }
      }
    }

    // Reset alpha
    ctx.globalAlpha = 1;
  }
}

function renderMap(layer: 'lower' | 'upper' = 'lower') {
  if (!ctx || !window.mapData) return;

  // Ensure image smoothing is disabled for pixel-perfect map rendering
  ctx.imageSmoothingEnabled = false;

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  // Calculate camera offset (center camera on player) and round to avoid seams
  const offsetX = Math.round(viewportWidth / 2 - cameraX);
  const offsetY = Math.round(viewportHeight / 2 - cameraY);

  const visibleChunks = getVisibleChunks();

  // Check if tile editor is active and has a selected layer
  const tileEditor = (window as any).tileEditor;
  const isEditorActive = tileEditor?.isActive;
  const selectedLayer = tileEditor?.selectedLayer;

  // If tile editor is active, draw all layers individually with proper opacity
  if (isEditorActive && selectedLayer) {
    drawAllLayersWithOpacity(layer, visibleChunks, offsetX, offsetY, selectedLayer);
  } else {
    // Normal rendering using pre-rendered chunk canvases
    for (const chunk of visibleChunks) {
      const chunkCanvas = layer === 'lower'
        ? window.mapData.getChunkLowerCanvas(chunk.x, chunk.y)
        : window.mapData.getChunkUpperCanvas(chunk.x, chunk.y);
      if (!chunkCanvas) continue;

      const chunkPixelSize = window.mapData.chunkSize * window.mapData.tilewidth;
      const chunkWorldX = chunk.x * chunkPixelSize;
      const chunkWorldY = chunk.y * chunkPixelSize;

      // Transform chunk position to screen space
      const screenX = chunkWorldX + offsetX;
      const screenY = chunkWorldY + offsetY;

      try {
        ctx.drawImage(chunkCanvas, screenX, screenY);
      } catch (error) {
        console.error(`Error rendering chunk ${chunk.x}-${chunk.y}:`, error);
      }
    }
  }
}

function animationLoop() {
  if (!ctx) return;
  // Pixel perfect
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

  // Initialize camera to spawn position on first frame
  if (cameraX === 0 && cameraY === 0 && window.mapData) {
    cameraX = window.mapData.spawnX || currentPlayer.position.x;
    cameraY = window.mapData.spawnY || currentPlayer.position.y;
  }

  updateCamera(currentPlayer, deltaTime * 60);

  // Update window camera values for tile editor
  (window as any).cameraX = cameraX;
  (window as any).cameraY = cameraY;

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

  // Load visible chunks periodically
  chunkLoadThrottle++;
  if (chunkLoadThrottle >= 10) {
    loadVisibleChunks();
    chunkLoadThrottle = 0;
  }

  // Clear viewport
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  ctx.imageSmoothingEnabled = false;

  // Render lower map layers (below players/NPCs) - skip in wireframe mode
  if (!wireframeDebugCheckbox.checked) {
    renderMap('lower');
  }

  // Calculate viewport bounds in world space for entity culling
  const viewportLeft = cameraX - window.innerWidth / 2;
  const viewportTop = cameraY - window.innerHeight / 2;
  const viewportRight = cameraX + window.innerWidth / 2;
  const viewportBottom = cameraY + window.innerHeight / 2;
  const padding = 64;

  const isInView = (x: number, y: number) =>
    x >= viewportLeft - padding &&
    y >= viewportTop - padding &&
    x <= viewportRight + padding &&
    y <= viewportBottom + padding;

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

  // Save context state
  ctx.save();

  // Translate to camera space (round to avoid subpixel rendering)
  const offsetX = Math.round(window.innerWidth / 2 - cameraX);
  const offsetY = Math.round(window.innerHeight / 2 - cameraY);
  ctx.translate(offsetX, offsetY);

  // Ensure image smoothing is disabled for crisp pixel art rendering
  ctx.imageSmoothingEnabled = false;

  // Render in wireframe mode or normal mode
  if (wireframeDebugCheckbox.checked) {
    // Wireframe mode: render entities as boxes
    ctx.strokeStyle = 'rgba(0, 255, 255, 0.8)';
    ctx.fillStyle = 'rgba(0, 255, 255, 0.2)';
    ctx.lineWidth = 2;

    // Draw players as wireframe boxes
    for (const p of visiblePlayers) {
      const width = 24;
      const height = 40;
      const x = p.position.x - width / 2;
      const y = p.position.y - height / 2;

      ctx.fillRect(x, y, width, height);
      ctx.strokeRect(x, y, width, height);

      // Draw player name above
      ctx.fillStyle = 'rgba(255, 255, 255, 1)';
      ctx.font = '12px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(p.username || 'Player', p.position.x, y - 5);
      ctx.fillStyle = 'rgba(0, 255, 255, 0.2)';
    }

    // Draw NPCs as wireframe boxes
    ctx.strokeStyle = 'rgba(255, 165, 0, 0.8)';
    ctx.fillStyle = 'rgba(255, 165, 0, 0.2)';

    for (const npc of visibleNpcs) {
      const width = 32;
      const height = 48;
      const x = npc.position.x - width / 2;
      const y = npc.position.y - height / 2;

      ctx.fillRect(x, y, width, height);
      ctx.strokeRect(x, y, width, height);

      // Draw NPC name above
      ctx.fillStyle = 'rgba(255, 255, 255, 1)';
      ctx.font = '12px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(npc.name || 'NPC', npc.position.x, y - 5);
      ctx.fillStyle = 'rgba(255, 165, 0, 0.2)';
    }
  } else {
    // Normal mode: render sprites
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

    for (const p of visiblePlayers) p.showChat(ctx, currentPlayer);
  }

  // Restore context
  ctx.restore();

  // Render upper map layers (above players/NPCs) - skip in wireframe mode
  if (!wireframeDebugCheckbox.checked) {
    renderMap('upper');
  } else {
    // In wireframe mode, draw chunk grid
    ctx.save();
    const offsetX = Math.round(window.innerWidth / 2 - cameraX);
    const offsetY = Math.round(window.innerHeight / 2 - cameraY);
    ctx.translate(offsetX, offsetY);

    if (window.mapData) {
      const visibleChunks = getVisibleChunks();
      ctx.strokeStyle = 'rgba(128, 128, 128, 0.5)';
      ctx.lineWidth = 1;

      for (const chunk of visibleChunks) {
        const chunkPixelSize = window.mapData.chunkSize * window.mapData.tilewidth;
        const chunkWorldX = chunk.x * chunkPixelSize;
        const chunkWorldY = chunk.y * chunkPixelSize;

        // Draw grid lines for tiles within chunk
        for (let i = 0; i <= window.mapData.chunkSize; i++) {
          // Vertical lines
          const lineX = chunkWorldX + (i * window.mapData.tilewidth);
          ctx.beginPath();
          ctx.moveTo(lineX, chunkWorldY);
          ctx.lineTo(lineX, chunkWorldY + chunkPixelSize);
          ctx.stroke();

          // Horizontal lines
          const lineY = chunkWorldY + (i * window.mapData.tileheight);
          ctx.beginPath();
          ctx.moveTo(chunkWorldX, lineY);
          ctx.lineTo(chunkWorldX + chunkPixelSize, lineY);
          ctx.stroke();
        }
      }
    }

    ctx.restore();
  }

  // Render debug visuals on top of everything
  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.imageSmoothingEnabled = false;

  // Render collision debug boxes (blue boxes for collision tiles)
  if (collisionDebugCheckbox.checked && (window as any).collisionTiles && window.mapData) {
    const collisionTiles = (window as any).collisionTiles as Array<{ x: number; y: number; time: number }>;
    const currentTime = Date.now();
    const maxAge = 3000; // Keep collision tiles visible for 3 seconds

    // Filter out old collision tiles
    (window as any).collisionTiles = collisionTiles.filter(tile => currentTime - tile.time < maxAge);

    // Render blue boxes for recent collisions
    ctx.fillStyle = 'rgba(0, 100, 255, 0.5)';
    ctx.strokeStyle = 'rgba(0, 150, 255, 0.8)';
    ctx.lineWidth = 2;

    for (const tile of (window as any).collisionTiles) {
      const tileWorldX = tile.x * window.mapData.tilewidth;
      const tileWorldY = tile.y * window.mapData.tileheight;

      // Only render if in view
      if (isInView(tileWorldX, tileWorldY)) {
        ctx.fillRect(tileWorldX, tileWorldY, window.mapData.tilewidth, window.mapData.tileheight);
        ctx.strokeRect(tileWorldX, tileWorldY, window.mapData.tilewidth, window.mapData.tileheight);
      }
    }
  }

  // Render chunk outline debug (green outlines around loaded chunks)
  if (chunkOutlineDebugCheckbox.checked && window.mapData) {
    const visibleChunks = getVisibleChunks();

    ctx.strokeStyle = 'rgba(0, 255, 0, 0.8)';
    ctx.lineWidth = 3;

    for (const chunk of visibleChunks) {
      const chunkPixelSize = window.mapData.chunkSize * window.mapData.tilewidth;
      const chunkWorldX = chunk.x * chunkPixelSize;
      const chunkWorldY = chunk.y * chunkPixelSize;

      // Draw outline around chunk
      ctx.strokeRect(chunkWorldX, chunkWorldY, chunkPixelSize, chunkPixelSize);
    }
  }

  // Render collision tiles debug (red outlines around all collision tiles)
  if (collisionTilesDebugCheckbox.checked && window.mapData) {
    const visibleChunks = getVisibleChunks();

    ctx.strokeStyle = 'rgba(255, 0, 0, 0.6)';
    ctx.fillStyle = 'rgba(255, 0, 0, 0.2)';
    ctx.lineWidth = 1;

    for (const chunk of visibleChunks) {
      const chunkKey = `${chunk.x}-${chunk.y}`;
      const chunkData = window.mapData.loadedChunks.get(chunkKey);

      if (!chunkData) continue;

      const chunkPixelSize = window.mapData.chunkSize * window.mapData.tilewidth;
      const chunkWorldX = chunk.x * chunkPixelSize;
      const chunkWorldY = chunk.y * chunkPixelSize;

      // Find collision layer (layer name contains "collision" case-insensitive)
      const collisionLayer = chunkData.layers.find((layer: any) =>
        layer.name && layer.name.toLowerCase().includes('collision')
      );

      if (collisionLayer) {
        // Draw outline for each collision tile
        for (let y = 0; y < chunkData.height; y++) {
          for (let x = 0; x < chunkData.width; x++) {
            const tileIndex = collisionLayer.data[y * chunkData.width + x];

            // If tile has a value (non-zero means collision)
            if (tileIndex !== 0) {
              const tileWorldX = chunkWorldX + (x * window.mapData.tilewidth);
              const tileWorldY = chunkWorldY + (y * window.mapData.tileheight);

              ctx.fillRect(tileWorldX, tileWorldY, window.mapData.tilewidth, window.mapData.tileheight);
              ctx.strokeRect(tileWorldX, tileWorldY, window.mapData.tilewidth, window.mapData.tileheight);
            }
          }
        }
      }
    }
  }

  // Render no-pvp zones debug (green outlines around all no-pvp tiles)
  if (noPvpDebugCheckbox.checked && window.mapData) {
    const visibleChunks = getVisibleChunks();

    ctx.strokeStyle = 'rgba(0, 255, 0, 0.6)';
    ctx.fillStyle = 'rgba(0, 255, 0, 0.2)';
    ctx.lineWidth = 1;

    for (const chunk of visibleChunks) {
      const chunkKey = `${chunk.x}-${chunk.y}`;
      const chunkData = window.mapData.loadedChunks.get(chunkKey);

      if (!chunkData) continue;

      const chunkPixelSize = window.mapData.chunkSize * window.mapData.tilewidth;
      const chunkWorldX = chunk.x * chunkPixelSize;
      const chunkWorldY = chunk.y * chunkPixelSize;

      // Find no-pvp layer (layer name contains "nopvp" or "no-pvp" case-insensitive)
      const noPvpLayer = chunkData.layers.find((layer: any) =>
        layer.name && (layer.name.toLowerCase().includes('nopvp') || layer.name.toLowerCase().includes('no-pvp'))
      );

      if (noPvpLayer) {
        // Draw outline for each no-pvp tile
        for (let y = 0; y < chunkData.height; y++) {
          for (let x = 0; x < chunkData.width; x++) {
            const tileIndex = noPvpLayer.data[y * chunkData.width + x];

            // If tile has a value (non-zero means no-pvp zone)
            if (tileIndex !== 0) {
              const tileWorldX = chunkWorldX + (x * window.mapData.tilewidth);
              const tileWorldY = chunkWorldY + (y * window.mapData.tileheight);

              ctx.fillRect(tileWorldX, tileWorldY, window.mapData.tilewidth, window.mapData.tileheight);
              ctx.strokeRect(tileWorldX, tileWorldY, window.mapData.tilewidth, window.mapData.tileheight);
            }
          }
        }
      }
    }
  }

  // Render tile grid overlay
  if (showGridCheckbox.checked && window.mapData) {
    const visibleChunks = getVisibleChunks();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = 1;

    for (const chunk of visibleChunks) {
      const chunkPixelSize = window.mapData.chunkSize * window.mapData.tilewidth;
      const chunkWorldX = chunk.x * chunkPixelSize;
      const chunkWorldY = chunk.y * chunkPixelSize;

      // Draw vertical grid lines
      for (let x = 0; x <= window.mapData.chunkSize; x++) {
        const lineX = chunkWorldX + (x * window.mapData.tilewidth);
        ctx.beginPath();
        ctx.moveTo(lineX, chunkWorldY);
        ctx.lineTo(lineX, chunkWorldY + chunkPixelSize);
        ctx.stroke();
      }

      // Draw horizontal grid lines
      for (let y = 0; y <= window.mapData.chunkSize; y++) {
        const lineY = chunkWorldY + (y * window.mapData.tileheight);
        ctx.beginPath();
        ctx.moveTo(chunkWorldX, lineY);
        ctx.lineTo(chunkWorldX + chunkPixelSize, lineY);
        ctx.stroke();
      }
    }
  }

  ctx.restore();

  // Render tile editor preview if active
  if ((window as any).tileEditor) {
    ctx.save();
    const offsetX = Math.round(window.innerWidth / 2 - cameraX);
    const offsetY = Math.round(window.innerHeight / 2 - cameraY);
    ctx.translate(offsetX, offsetY);
    (window as any).tileEditor.renderPreview();
    ctx.restore();
  }

  if (times.length > 60) times.shift();
  times.push(now);
  requestAnimationFrame(animationLoop);
}

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

// Export camera for other modules
(window as any).cameraX = cameraX;
(window as any).cameraY = cameraY;

function getWeatherType() {
  return weatherType;
}

function setWeatherType(type: string | null) {
  weatherType = type;
}

export {
  lastDirection,
  setDirection,
  setPendingRequest,
  canvas,
  setCameraX,
  setCameraY,
  getCameraX,
  getCameraY,
  setWeatherType,
  getWeatherType
};
