import { canvas, progressBar, loadingScreen, progressBarContainer } from "../core/ui";
import pako from "../libs/pako.js";

export default async function loadMap(data: any): Promise<boolean> {
    // @ts-expect-error - pako is not defined because it is loaded in the index.html
    const inflated = pako.inflate(
        new Uint8Array(new Uint8Array(data[0].data)),
        { to: "string" }
    );
    const mapData = inflated ? JSON.parse(inflated) : null;

    const loadTilesets = async (tilesets: any[]): Promise<HTMLImageElement[]> => {
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
    };

    try {
        const images = await loadTilesets(mapData.tilesets);
        if (!images.length) throw new Error("No tileset images loaded");
        await drawMap(images);
        return true;
    } catch (error) {
        console.error("Map loading failed:", error);
        throw error;
    }

    async function drawMap(images: HTMLImageElement[]): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                const mapWidth = mapData.width * mapData.tilewidth;
                const mapHeight = mapData.height * mapData.tileheight;
                const CHUNK_SIZE = 25;
                const chunkPixelSize = CHUNK_SIZE * mapData.tilewidth;

                canvas.width = mapWidth;
                canvas.height = mapHeight;
                canvas.style.width = mapWidth + "px";
                canvas.style.height = mapHeight + "px";
                canvas.style.display = "block";
                canvas.style.backgroundColor = "#ffffff";

                const mainCtx = canvas.getContext("2d", { willReadFrequently: false, alpha: false });

                if (!mainCtx) {
                    reject(new Error("Could not get main canvas context"));
                    return;
                }

                mainCtx.imageSmoothingEnabled = false;
                mainCtx.fillStyle = "#ffffff";
                mainCtx.fillRect(0, 0, mapWidth, mapHeight);

                const sortedLayers = [...mapData.layers].sort(
                    (a, b) => (a.zIndex || 0) - (b.zIndex || 0)
                );
                const visibleTileLayers = sortedLayers.filter(
                    (layer) => layer.visible && layer.type === "tilelayer"
                );
                const chunksX = Math.ceil(mapData.width / CHUNK_SIZE);
                const chunksY = Math.ceil(mapData.height / CHUNK_SIZE);
                const totalChunks = chunksX * chunksY * visibleTileLayers.length;
                let processedChunks = 0;

                const chunkCanvases: {
                    [key: string]: { [key: string]: HTMLCanvasElement | null };
                } = {};
                window.mapLayerCanvases = [];

                window.mapChunks = {
                    chunksX,
                    chunksY,
                    chunkSize: CHUNK_SIZE,
                    chunkPixelSize,
                    layers: {},
                    chunks: chunkCanvases,
                    redrawMainCanvas: (visibleChunksOnly = false, visibleChunks: Set<string> | null = null) => {
                        if (!mainCtx) return;

                        try {
                            const layerNames = Object.keys(window.mapChunks.layers).sort((a, b) => {
                                return (window.mapChunks.layers[a].zIndex || 0) - (window.mapChunks.layers[b].zIndex || 0);
                            });

                            if (visibleChunksOnly && visibleChunks) {
                                mainCtx.fillStyle = "#ffffff";
                                for (const chunkKey of visibleChunks) {
                                    const [cx, cy] = chunkKey.split('-').map(Number);
                                    mainCtx.fillRect(cx * chunkPixelSize, cy * chunkPixelSize, chunkPixelSize, chunkPixelSize);
                                }

                                for (const layerName of layerNames) {
                                    const layer = window.mapChunks.layers[layerName];
                                    if (!layer.visible) continue;

                                    for (const chunkKey of visibleChunks) {
                                        const [chunkX, chunkY] = chunkKey.split('-').map(Number);
                                        const chunkCanvas = chunkCanvases[layerName]?.[chunkKey];

                                        if (chunkCanvas && layer.chunkVisibility?.[chunkKey] !== false) {
                                            try {
                                                mainCtx.drawImage(chunkCanvas, chunkX * chunkPixelSize, chunkY * chunkPixelSize);
                                            } catch (drawError) {
                                                console.error(`Error drawing chunk ${chunkKey} of layer ${layerName}:`, drawError);
                                            }
                                        }
                                    }
                                }
                            } else {
                                mainCtx.fillStyle = "#ffffff";
                                mainCtx.fillRect(0, 0, mapWidth, mapHeight);

                                for (const layerName of layerNames) {
                                    const layer = window.mapChunks.layers[layerName];
                                    if (!layer.visible) continue;

                                    for (let chunkY = 0; chunkY < chunksY; chunkY++) {
                                        for (let chunkX = 0; chunkX < chunksX; chunkX++) {
                                            const chunkKey = `${chunkX}-${chunkY}`;
                                            const chunkCanvas = chunkCanvases[layerName]?.[chunkKey];

                                            if (chunkCanvas && layer.chunkVisibility?.[chunkKey] !== false) {
                                                try {
                                                    mainCtx.drawImage(chunkCanvas, chunkX * chunkPixelSize, chunkY * chunkPixelSize);
                                                } catch (drawError) {
                                                    console.error(`Error drawing chunk ${chunkKey} of layer ${layerName}:`, drawError);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        } catch (error) {
                            console.error("Error in redrawMainCanvas:", error);
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
                    },
                };

                async function processLayer(layer: any, layerIndex: number): Promise<void> {
                    const layerName = layer.name.replace(/[^a-zA-Z0-9-_]/g, "-");
                    chunkCanvases[layerName] = {};
                    window.mapChunks.layers[layerName] = {
                        originalName: layer.name,
                        zIndex: layer.zIndex || layerIndex,
                        visible: true,
                        chunkVisibility: {},
                        chunks: {},
                    };

                    const layerCanvas = document.createElement("canvas");
                    layerCanvas.width = mapWidth;
                    layerCanvas.height = mapHeight;

                    const layerCtx = layerCanvas.getContext("2d", {
                        willReadFrequently: false,
                        alpha: true,
                    });

                    if (!layerCtx) return;

                    layerCtx.imageSmoothingEnabled = false;
                    layerCtx.clearRect(0, 0, mapWidth, mapHeight);

                    if (!window.mapLayerCanvases) window.mapLayerCanvases = [];

                    window.mapLayerCanvases.push({
                        canvas: layerCanvas,
                        ctx: layerCtx,
                        zIndex: layer.zIndex || layerIndex,
                    });

                    async function processChunk(chunkX: number, chunkY: number): Promise<void> {
                        const startX = chunkX * CHUNK_SIZE;
                        const startY = chunkY * CHUNK_SIZE;
                        const endX = Math.min(startX + CHUNK_SIZE, mapData.width);
                        const endY = Math.min(startY + CHUNK_SIZE, mapData.height);
                        const actualChunkWidth = (endX - startX) * mapData.tilewidth;
                        const actualChunkHeight = (endY - startY) * mapData.tileheight;

                        const chunkCanvas = document.createElement("canvas");
                        chunkCanvas.width = actualChunkWidth;
                        chunkCanvas.height = actualChunkHeight;

                        const chunkCtx = chunkCanvas.getContext("2d", { willReadFrequently: false });

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
                                if (!image || !image.complete || image.naturalWidth === 0) continue;

                                const localTileIndex = tileIndex - tileset.firstgid;
                                const tilesPerRow = Math.floor(tileset.imagewidth / tileset.tilewidth);
                                const tileX = (localTileIndex % tilesPerRow) * tileset.tilewidth;
                                const tileY = Math.floor(localTileIndex / tilesPerRow) * tileset.tileheight;

                                try {
                                    chunkCtx.drawImage(
                                        image,
                                        tileX, tileY,
                                        tileset.tilewidth, tileset.tileheight,
                                        (x - startX) * mapData.tilewidth,
                                        (y - startY) * mapData.tileheight,
                                        mapData.tilewidth, mapData.tileheight
                                    );

                                    const layerCanvasData = window.mapLayerCanvases?.[window.mapLayerCanvases.length - 1];
                                    if (layerCanvasData?.ctx) {
                                        layerCanvasData.ctx.drawImage(
                                            image,
                                            tileX, tileY,
                                            tileset.tilewidth, tileset.tileheight,
                                            x * mapData.tilewidth,
                                            y * mapData.tileheight,
                                            mapData.tilewidth, mapData.tileheight
                                        );
                                    }
                                    hasContent = true;
                                } catch (drawError) {
                                    console.error("Error drawing tile:", drawError);
                                }
                            }
                        }

                        const chunkKey = `${chunkX}-${chunkY}`;
                        chunkCanvases[layerName][chunkKey] = hasContent ? chunkCanvas : null;
                        window.mapChunks.layers[layerName].chunkVisibility[chunkKey] = hasContent;
                        window.mapChunks.layers[layerName].chunks[chunkKey] = { x: chunkX, y: chunkY, hasContent };

                        processedChunks++;
                        const progress = (processedChunks / totalChunks) * 100;
                        progressBar.style.width = `${Math.min(progress, 100)}%`;
                    }

                    for (let chunkY = 0; chunkY < chunksY; chunkY++) {
                        for (let chunkX = 0; chunkX < chunksX; chunkX++) {
                            await processChunk(chunkX, chunkY);
                            if ((chunkX + chunkY * chunksX) % 5 === 0) {
                                await new Promise((resolve) => setTimeout(resolve, 0));
                            }
                        }
                    }
                }

                let currentLayerIndex = 0;
                async function renderLayers(): Promise<void> {
                    try {
                        for (const layer of sortedLayers) {
                            if (!layer.visible || layer.type !== "tilelayer" || layer.name.toLowerCase() === "collisions") {
                                currentLayerIndex++;
                                continue;
                            }
                            await processLayer(layer, currentLayerIndex);
                            currentLayerIndex++;
                            await new Promise((resolve) => requestAnimationFrame(resolve));
                        }

                        (window.mapLayerCanvases ?? []).sort((a: any, b: any) => a.zIndex - b.zIndex);
                        window.mapChunks.redrawMainCanvas();

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
                    } catch (error) {
                        reject(error);
                    }
                }

                renderLayers();
            } catch (error) {
                reject(error);
            }
        });
    }
}