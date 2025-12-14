import { canvas, ctx, progressBar, loadingScreen, progressBarContainer } from "../core/ui";
import pako from "../libs/pako.js";

declare global {
  interface Window {
    mapData?: any;
  }
}

interface ChunkData {
  chunkX: number;
  chunkY: number;
  startX: number;
  startY: number;
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  layers: Array<{
    name: string;
    zIndex: number;
    data: number[];
    width: number;
    height: number;
  }>;
  canvas?: HTMLCanvasElement;
  lowerCanvas?: HTMLCanvasElement;
  upperCanvas?: HTMLCanvasElement;
}

export default async function loadMap(data: any): Promise<boolean> {
  try {
    // Show loading screen
    if (loadingScreen) {
      loadingScreen.style.display = "flex";
      loadingScreen.style.opacity = "1";
      loadingScreen.style.transition = "0s";
      progressBar.style.width = "0%";
    }

    // Clear existing map data to force reload
    if (window.mapData) {
      window.mapData.loadedChunks.clear();
    }

    // Clear localStorage cache for this map
    const mapName = data[1];
    if (mapName) {
      clearMapCache(mapName);
    }

    // @ts-expect-error - pako is not defined because it is loaded in the index.html
    const inflated = pako.inflate(
      new Uint8Array(new Uint8Array(data[0].data)),
      { to: "string" }
    );
    const mapData = inflated ? JSON.parse(inflated) : null;

    if (!mapData) {
      throw new Error("Failed to parse map data");
    }

    // Update progress: 10% for starting
    progressBar.style.width = "10%";

    // Load tilesets
    const images = await loadTilesets(mapData.tilesets);
    if (!images.length) throw new Error("No tileset images loaded");

    // Update progress: 30% after tilesets loaded
    progressBar.style.width = "30%";

    // Initialize map metadata
    const CHUNK_SIZE = 25;
    const chunksX = Math.ceil(mapData.width / CHUNK_SIZE);
    const chunksY = Math.ceil(mapData.height / CHUNK_SIZE);

    // Extract spawn position from server data
    const spawnX = data[2] || 0;
    const spawnY = data[3] || 0;

    window.mapData = {
      name: data[1], // Map name from server
      width: mapData.width,
      height: mapData.height,
      tilewidth: mapData.tilewidth,
      tileheight: mapData.tileheight,
      tilesets: mapData.tilesets,
      images: images,
      chunksX: chunksX,
      chunksY: chunksY,
      chunkSize: CHUNK_SIZE,
      loadedChunks: new Map<string, ChunkData>(),
      spawnX: spawnX,
      spawnY: spawnY,
      requestChunk: async (chunkX: number, chunkY: number) => {
        return await requestChunk(chunkX, chunkY);
      },
      getChunkCanvas: (chunkX: number, chunkY: number) => {
        return getChunkCanvas(chunkX, chunkY);
      },
      getChunkLowerCanvas: (chunkX: number, chunkY: number) => {
        return getChunkLowerCanvas(chunkX, chunkY);
      },
      getChunkUpperCanvas: (chunkX: number, chunkY: number) => {
        return getChunkUpperCanvas(chunkX, chunkY);
      },
    };

    // Update progress: 40% after map metadata initialized
    progressBar.style.width = "40%";

    // Load initial chunks around spawn position
    const chunkPixelSize = CHUNK_SIZE * mapData.tilewidth;
    const spawnChunkX = Math.floor(spawnX / chunkPixelSize);
    const spawnChunkY = Math.floor(spawnY / chunkPixelSize);

    // Calculate chunks needed to cover viewport + padding
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const padding = chunkPixelSize * 2; // Extra padding for safety

    // Calculate how many chunks we need in each direction
    const chunksNeededX = Math.ceil((viewportWidth + padding * 2) / chunkPixelSize / 2);
    const chunksNeededY = Math.ceil((viewportHeight + padding * 2) / chunkPixelSize / 2);

    // Load all chunks that could be visible
    const chunksToLoad: Array<{x: number, y: number}> = [];
    for (let dy = -chunksNeededY; dy <= chunksNeededY; dy++) {
      for (let dx = -chunksNeededX; dx <= chunksNeededX; dx++) {
        const chunkX = spawnChunkX + dx;
        const chunkY = spawnChunkY + dy;
        if (chunkX >= 0 && chunkY >= 0 && chunkX < chunksX && chunkY < chunksY) {
          chunksToLoad.push({ x: chunkX, y: chunkY });
        }
      }
    }

    // Load chunks sequentially and update progress
    const totalChunks = chunksToLoad.length;
    let loadedCount = 0;

    for (const chunk of chunksToLoad) {
      const chunkData = await requestChunk(chunk.x, chunk.y);
      if (chunkData && chunkData.canvas) {
        loadedCount++;
      }
      // Progress from 40% to 90% as chunks load
      const chunkProgress = 40 + (loadedCount / totalChunks) * 50;
      progressBar.style.width = `${chunkProgress}%`;
    }

    // Verify all chunks are actually loaded
    const allChunksLoaded = chunksToLoad.every(chunk => {
      const chunkKey = `${chunk.x}-${chunk.y}`;
      return window.mapData.loadedChunks.has(chunkKey);
    });

    if (!allChunksLoaded) {
      console.warn("Not all chunks loaded, retrying...");
      // Retry loading any missing chunks
      for (const chunk of chunksToLoad) {
        const chunkKey = `${chunk.x}-${chunk.y}`;
        if (!window.mapData.loadedChunks.has(chunkKey)) {
          await requestChunk(chunk.x, chunk.y);
        }
      }
    }

    // Update progress: 100% all chunks loaded
    progressBar.style.width = "100%";

    // Set canvas to fixed viewport size with device pixel ratio support
    const dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
    canvas.style.display = "block";
    canvas.style.backgroundColor = "#000000";
    canvas.style.position = "fixed";
    canvas.style.top = "0";
    canvas.style.left = "0";

    // Scale context to match device pixel ratio
    if (ctx) {
      ctx.scale(dpr, dpr);
    }

    // Wait to ensure 100% progress is visible, then hide loading screen
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Hide loading screen after chunks are loaded
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

    return true;
  } catch (error) {
    console.error("Map loading failed:", error);
    throw error;
  }
}

async function loadTilesets(tilesets: any[]): Promise<HTMLImageElement[]> {
  if (!tilesets?.length) throw new Error("No tilesets found");

  const base64ToUint8Array = (base64: string) => {
    const raw = atob(base64);
    const uint8Array = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++)
      uint8Array[i] = raw.charCodeAt(i);
    return uint8Array;
  };

  const uint8ArrayToBase64 = (bytes: Uint8Array) => {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  };

  const tilesetPromises = tilesets.map(async (tileset) => {
    const name = tileset.image.split("/").pop();
    const response = await fetch(`/tileset?name=${name}`);
    if (!response.ok) throw new Error(`Failed to fetch tileset: ${name}`);

    const tilesetData = await response.json();
    const compressedBase64 = tilesetData.tileset.data;
    const compressedBytes = base64ToUint8Array(compressedBase64);
    // @ts-expect-error - pako is not defined because it is loaded in the index.html
    const inflatedBytes = pako.inflate(compressedBytes);
    const imageBase64 = uint8ArrayToBase64(inflatedBytes);

    return new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = "anonymous";

      image.onload = () => {
        if (image.complete && image.naturalWidth > 0) resolve(image);
        else reject(new Error(`Image loaded but invalid: ${name}`));
      };

      image.onerror = () => {
        reject(new Error(`Failed to load tileset image: ${name}`));
      };

      image.src = `data:image/png;base64,${imageBase64}`;

      setTimeout(() => {
        if (!image.complete)
          reject(new Error(`Timeout loading tileset image: ${name}`));
      }, 15000);
    });
  });

  return Promise.all(tilesetPromises);
}

// Chunk cache functions
const CACHE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 1 day

function getCacheKey(mapName: string, chunkX: number, chunkY: number): string {
  return `chunk_${mapName}_${chunkX}_${chunkY}`;
}

function saveChunkToCache(mapName: string, chunkX: number, chunkY: number, chunkData: ChunkData): void {
  try {
    const cacheKey = getCacheKey(mapName, chunkX, chunkY);
    const cacheData = {
      timestamp: Date.now(),
      data: chunkData,
    };
    localStorage.setItem(cacheKey, JSON.stringify(cacheData));
  } catch (error) {
    console.warn('Failed to save chunk to cache:', error);
  }
}

function loadChunkFromCache(mapName: string, chunkX: number, chunkY: number): ChunkData | null {
  try {
    const cacheKey = getCacheKey(mapName, chunkX, chunkY);
    const cached = localStorage.getItem(cacheKey);

    if (!cached) return null;

    const cacheData = JSON.parse(cached);
    const age = Date.now() - cacheData.timestamp;

    // Check if cache is expired
    if (age > CACHE_EXPIRY_MS) {
      localStorage.removeItem(cacheKey);
      return null;
    }

    return cacheData.data;
  } catch (error) {
    console.warn('Failed to load chunk from cache:', error);
    return null;
  }
}

function clearMapCache(mapName?: string): void {
  try {
    const keys = Object.keys(localStorage);
    for (const key of keys) {
      if (mapName) {
        // Clear specific map's chunks
        if (key.startsWith(`chunk_${mapName}_`)) {
          localStorage.removeItem(key);
        }
      } else {
        // Clear all chunk caches
        if (key.startsWith('chunk_')) {
          localStorage.removeItem(key);
        }
      }
    }
    console.log(`Cleared chunk cache${mapName ? ` for map: ${mapName}` : ''}`);
  } catch (error) {
    console.warn('Failed to clear chunk cache:', error);
  }
}

async function requestChunk(chunkX: number, chunkY: number): Promise<ChunkData | null> {
  if (!window.mapData) return null;

  const chunkKey = `${chunkX}-${chunkY}`;

  // Return memory cached chunk if available
  if (window.mapData.loadedChunks.has(chunkKey)) {
    return window.mapData.loadedChunks.get(chunkKey)!;
  }

  // Validate bounds
  if (chunkX < 0 || chunkY < 0 || chunkX >= window.mapData.chunksX || chunkY >= window.mapData.chunksY) {
    return null;
  }

  try {
    // Check localStorage cache first
    const cachedChunkData = loadChunkFromCache(window.mapData.name, chunkX, chunkY);
    let chunkData: ChunkData;

    if (cachedChunkData) {
      // Use cached data
      chunkData = cachedChunkData;
    } else {
      // Fetch from server
      const response = await fetch(
        `/map-chunk?map=${window.mapData.name}&x=${chunkX}&y=${chunkY}&size=${window.mapData.chunkSize}`
      );

      if (!response.ok) {
        console.error(`Failed to fetch chunk ${chunkKey}`);
        return null;
      }

      chunkData = await response.json() as ChunkData;

      // Save to localStorage cache
      saveChunkToCache(window.mapData.name, chunkX, chunkY, chunkData);
    }

    // Render chunk to separate lower and upper canvases for proper z-ordering
    const { lowerCanvas, upperCanvas } = await renderChunkToCanvas(chunkData);
    chunkData.lowerCanvas = lowerCanvas;
    chunkData.upperCanvas = upperCanvas;
    chunkData.canvas = lowerCanvas; // Keep for backwards compatibility

    // Cache the chunk in memory
    window.mapData.loadedChunks.set(chunkKey, chunkData);

    return chunkData;
  } catch (error) {
    console.error(`Error requesting chunk ${chunkKey}:`, error);
    return null;
  }
}

async function renderChunkToCanvas(chunkData: ChunkData): Promise<{lowerCanvas: HTMLCanvasElement, upperCanvas: HTMLCanvasElement}> {
  if (!window.mapData) throw new Error("Map data not initialized");

  const pixelWidth = chunkData.width * window.mapData.tilewidth;
  const pixelHeight = chunkData.height * window.mapData.tileheight;

  // Create two canvases for proper z-ordering
  const lowerCanvas = document.createElement("canvas");
  const upperCanvas = document.createElement("canvas");

  lowerCanvas.width = pixelWidth;
  lowerCanvas.height = pixelHeight;
  upperCanvas.width = pixelWidth;
  upperCanvas.height = pixelHeight;

  const lowerCtx = lowerCanvas.getContext("2d", { willReadFrequently: false, alpha: true });
  const upperCtx = upperCanvas.getContext("2d", { willReadFrequently: false, alpha: true });

  if (!lowerCtx || !upperCtx) throw new Error("Failed to get canvas context");

  lowerCtx.imageSmoothingEnabled = false;
  upperCtx.imageSmoothingEnabled = false;
  lowerCtx.clearRect(0, 0, pixelWidth, pixelHeight);
  upperCtx.clearRect(0, 0, pixelWidth, pixelHeight);

  // Sort layers by zIndex
  const sortedLayers = [...chunkData.layers].sort((a, b) => a.zIndex - b.zIndex);

  // Player z-index threshold: layers 0-2 go below, layers 3+ go above
  const PLAYER_Z_INDEX = 3;

  // Draw each layer to appropriate canvas
  for (const layer of sortedLayers) {
    const ctx = layer.zIndex < PLAYER_Z_INDEX ? lowerCtx : upperCtx;

    for (let y = 0; y < chunkData.height; y++) {
      for (let x = 0; x < chunkData.width; x++) {
        const tileIndex = layer.data[y * chunkData.width + x];
        if (tileIndex === 0) continue;

        const tileset = window.mapData.tilesets.find(
          (t: any) => t.firstgid <= tileIndex && tileIndex < t.firstgid + t.tilecount
        );
        if (!tileset) continue;

        const image = window.mapData.images[window.mapData.tilesets.indexOf(tileset)];
        if (!image || !image.complete || image.naturalWidth === 0) continue;

        const localTileIndex = tileIndex - tileset.firstgid;
        const tilesPerRow = Math.floor(tileset.imagewidth / tileset.tilewidth);
        const tileX = (localTileIndex % tilesPerRow) * tileset.tilewidth;
        const tileY = Math.floor(localTileIndex / tilesPerRow) * tileset.tileheight;

        try {
          ctx.drawImage(
            image,
            tileX, tileY,
            tileset.tilewidth, tileset.tileheight,
            x * window.mapData.tilewidth,
            y * window.mapData.tileheight,
            window.mapData.tilewidth, window.mapData.tileheight
          );
        } catch (drawError) {
          console.error("Error drawing tile:", drawError);
        }
      }
    }
  }

  return { lowerCanvas, upperCanvas };
}

function getChunkCanvas(chunkX: number, chunkY: number): HTMLCanvasElement | null {
  if (!window.mapData) return null;

  const chunkKey = `${chunkX}-${chunkY}`;
  const chunk = window.mapData.loadedChunks.get(chunkKey);

  return chunk?.canvas || null;
}

function getChunkLowerCanvas(chunkX: number, chunkY: number): HTMLCanvasElement | null {
  if (!window.mapData) return null;

  const chunkKey = `${chunkX}-${chunkY}`;
  const chunk = window.mapData.loadedChunks.get(chunkKey);

  return chunk?.lowerCanvas || null;
}

function getChunkUpperCanvas(chunkX: number, chunkY: number): HTMLCanvasElement | null {
  if (!window.mapData) return null;

  const chunkKey = `${chunkX}-${chunkY}`;
  const chunk = window.mapData.loadedChunks.get(chunkKey);

  return chunk?.upperCanvas || null;
}

export { clearMapCache };
