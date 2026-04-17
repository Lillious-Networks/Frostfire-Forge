import path from "path";
import fs from "fs";
import log from "./logger";
import item from "../systems/items";
import spell from "../systems/spells";
import npc from "../systems/npcs";
import entities from "../systems/entities";
import particle from "../systems/particles";
import worlds from "../systems/worlds";
import quest from "../systems/quests";

import assetCache from "../services/assetCache";
import zlib from "zlib";
import * as settings from "../config/settings.json";
const defaultMap = settings.default_map?.replace(".json", "") || "main";
const mapDir = path.join('.', 'src', 'assets', 'maps');
import mounts from "../systems/mounts";

const assetLoadingStartTime = performance.now();

const worldNow = performance.now();
await assetCache.add("worlds", await worlds.list());
const world = await assetCache.get("worlds") as WorldData[];
log.success(`Loaded ${world.length} world(s) from the database in ${(performance.now() - worldNow).toFixed(2)}ms`);

const worldName = settings.world;
if (!world.find((w) => w.name === worldName)) {
  throw new Error(`World name ${worldName} was not loaded correctly from the database\nFound the following worlds: ${world.map((w) => w.name).join(", ")}`);
} else {
  log.success(`World: ${worldName} was loaded correctly from the database`);
}

const itemnow = performance.now();
const itemList = await item.list();

await assetCache.add("items", itemList);
const items = await assetCache.get("items") as Item[];

log.success(`Loaded ${items.length} item(s) from the database in ${(performance.now() - itemnow).toFixed(2)}ms`);

const mountNow = performance.now();

await assetCache.add("mounts", await mounts.list());
const mountList = await assetCache.get("mounts") as Mount[];

log.success(`Loaded ${mountList.length} mount(s) from the database in ${(performance.now() - mountNow).toFixed(2)}ms`);
log.info(`Mounts loaded: ${mountList.map((m) => m.name).join(", ")}`);

const spellnow = performance.now();
const spellList = await spell.list();
// Icons and sprites are now served from asset server, not stored in cache

await assetCache.add("spells", spellList);
const spells = await assetCache.get("spells") as SpellData[];

log.success(`Loaded ${spells.length} spell(s) from the database in ${(performance.now() - spellnow).toFixed(2)}ms`);
log.info(`Spells loaded: ${spells.map((s) => s.name).join(", ")}`);

const npcnow = performance.now();
await assetCache.add("npcs", await npc.list());
const npcs = await assetCache.get("npcs") as Npc[];
log.success(`Loaded ${npcs.length} npc(s) from the database in ${(performance.now() - npcnow).toFixed(2)}ms`);

const entityNow = performance.now();
await assetCache.add("entities", await entities.list());
const entityList = await assetCache.get("entities") as Entity[];
log.success(`Loaded ${entityList.length} entit(ies) from the database in ${(performance.now() - entityNow).toFixed(2)}ms`);

const particleNow = performance.now();
await assetCache.add("particles", await particle.list());
const particles = await assetCache.get("particles") as Particle[];
log.success(`Loaded ${particles.length} particle(s) from the database in ${(performance.now() - particleNow).toFixed(2)}ms`);

const questNow = performance.now();
await assetCache.add("quests", await quest.list());
const quests = await assetCache.get("quests") as Quest[];
log.success(`Loaded ${quests.length} quest(s) from the database in ${(performance.now() - questNow).toFixed(2)}ms`);

const mapProperties: MapProperties[] = [];
function loadAllMaps() {
  const now = performance.now();
  const maps: MapData[] = [];

  if (!fs.existsSync(mapDir)) throw new Error(`Maps directory not found at ${mapDir}`);

  const mapFiles = fs.readdirSync(mapDir).filter(f => f.endsWith(".json"));
  if (mapFiles.length === 0) throw new Error("No maps found in the maps directory");

  for (const file of mapFiles) {
    const map = processMapFile(file);
    if (map) {
      try {
        maps.push(map);
        mapProperties.push({
          name: map.name,
          width: map.data.layers[0].width,
          height: map.data.layers[0].height,
          tileWidth: map.data.tilewidth,
          tileHeight: map.data.tileheight,
          warps: null,
          graveyards: null
        });
        extractAndCompressLayers(map);
      } catch (error) {
        log.error(`Failed to load map ${file}: ${error}`);
        // Remove the map from arrays if it was added
        maps.pop();
        mapProperties.pop();
      }
    }
  }

  const mainMap = maps.find((m) => m.name === `${defaultMap}.json`);
  if (!mainMap) throw new Error(`Default map ${defaultMap} not found in the maps directory`);

  assetCache.add("maps", maps);
  assetCache.add("mapProperties", mapProperties);
  log.success(`Loaded ${maps.length} map(s) in ${(performance.now() - now).toFixed(2)}ms`);
}

function processMapFile(file: string): MapData | null {
  const fullPath = path.join(mapDir, file);
  const parsed = tryParse(fs.readFileSync(fullPath, "utf-8"));

  if (!parsed) {
    log.error(`Failed to parse ${file} as a map`);
    return null;
  }

  const jsonString = JSON.stringify(parsed);
  const compressedData = zlib.gzipSync(jsonString);

  log.debug(`Loaded map: ${file}`);
  log.debug(`Compressed map: ${file}
  - Original: ${jsonString.length} bytes
  - Compressed: ${compressedData.length} bytes
  - Compression Ratio: ${(jsonString.length / compressedData.length).toFixed(2)}x
  - Compression Savings: ${(((jsonString.length - compressedData.length) / jsonString.length) * 100).toFixed(2)}%`);

  return {
    name: file,
    data: parsed,
    compressed: compressedData,
  } as any;
}

function extractAndCompressLayers(map: MapData) {
  const collisions: number[][] = [];
  const noPvpZones: number[][] = [];
  const warps: any[] = [];
  const graveyards: any[] = [];

  map.data.layers.forEach((layer: any) => {

    if (layer.type === "objectgroup") {
      return;
    }

    const layerName = layer.name ? layer.name.toLowerCase() : "";

    if ((layer.properties?.[0]?.name.toLowerCase() === "collision" && layer.properties[0].value === true) ||
        layerName.includes("collision")) {
      collisions.push(layer.data);
    }

    if ((layer.properties?.[0]?.name.toLowerCase() === "nopvp" && layer.properties[0].value === true) ||
        layerName.includes("nopvp") || layerName.includes("no-pvp")) {
      noPvpZones.push(layer.data);
    }
  });

  map.data.layers.forEach((layer: any) => {
    if (layer.type === "objectgroup") {
      const layerName = layer.name;
      const objects = layer.objects;
      objects.forEach((obj: any) => {

        // Get type from object's class/type, or fallback to layer name (e.g., "Graveyards" layer)
        const type = obj?.class?.toLowerCase() || obj?.type?.toLowerCase() || layerName?.toLowerCase();
        if (!type) {
          log.warn(`Object in map ${map.name} has no type or class: ${JSON.stringify(obj)}`);
          return;
        }
        // Ensure properties is an array (skip if not)
        const propsArray = Array.isArray(obj.properties) ? obj.properties : [];
        const propsMap = new Map(propsArray.map((p: any) => [p.name, p.value]));
        switch (type) {

          case "warp": {
            const _map = propsMap.get("map");
            const x = propsMap.get("x");
            const y = propsMap.get("y");

            if (_map && x !== undefined && y !== undefined) {
              warps.push({
                name: obj.name,
                map: _map,
                x: x,
                y: y,
                position: {
                  x: Math.floor(obj.x),
                  y: Math.floor(obj.y),
                },
                size: {
                  width: Math.floor(obj.width),
                  height: Math.floor(obj.height),
                },
                layer: layerName,
              });
            } else {
              log.warn(`Invalid warp object in map ${map.name}: ${JSON.stringify(obj)}`);
            }
            break;
          }

          case "graveyard": {
            graveyards.push({
              name: obj.name,
              position: {
                x: Math.floor(obj.x),
                y: Math.floor(obj.y),
              },
              layer: layerName,
            });
            break;
          }
          default:
            log.warn(`Unknown object or object type in map ${map.name}: ${JSON.stringify(obj)}`);
        }
      });

      if (warps.length > 0) {
        log.debug(`Found ${warps.length} warp(s) in map ${map.name}`);
        const _map = mapProperties.find(m => m.name.replace(".json", "") === map.name.replace(".json", "")) as MapProperties | undefined;
        if (!_map) {
          log.error(`Map properties not found for ${map.name}`);
          return;
        }
        _map.warps = warps.map(warp => ({
          name: warp.name,
          map: warp.map,
          position: warp.position,
          x: warp.x,
          y: warp.y,
          size: warp.size,
          layer: warp.layer
        }));
        log.debug(`Extracted ${warps.length} warp(s) from map ${map.name}`);
      }

      if (graveyards.length > 0) {
        log.debug(`Found ${graveyards.length} graveyard(s) in map ${map.name}`);
        const _map = mapProperties.find(m => m.name.replace(".json", "") === map.name.replace(".json", "")) as MapProperties | undefined;
        if (!_map) {
          log.error(`Map properties not found for ${map.name}`);
          return;
        }
        _map.graveyards = graveyards.map(graveyard => ({
          name: graveyard.name,
          position: graveyard.position,
          layer: graveyard.layer
        }));
        log.debug(`Extracted ${graveyards.length} graveyard(s) from map ${map.name}`);
      }
    }
  });

  // Check if graveyards and warps are saved in the map JSON properties
  // These take precedence over extracted object group data
  const _map = mapProperties.find(m => m.name.replace(".json", "") === map.name.replace(".json", "")) as MapProperties | undefined;
  if (_map) {
    // Only update if not already extracted from object groups or if map file has explicit saved data
    if (map.data.graveyards && (!_map.graveyards || (_map.graveyards as any[]).length === 0)) {
      _map.graveyards = map.data.graveyards;
    } else if (map.data.graveyards && _map.graveyards) {
      // If there's saved data in the map file AND extracted data, merge them
      // Create a map of extracted graveyards by name to preserve layer info
      const extractedMap = new Map((_map.graveyards as any[]).map(g => [g.name, g]));
      const savedGraveyards = Array.isArray(map.data.graveyards) ? map.data.graveyards : Object.values(map.data.graveyards);

      // Merge: saved data takes precedence, but preserve layer from extracted data
      const merged = savedGraveyards.map((saved: any) => {
        const extracted = extractedMap.get(saved.name);
        return {
          ...saved,
          layer: extracted?.layer || saved.layer
        };
      });

      _map.graveyards = merged;
    }

    if (map.data.warps && (!_map.warps || (_map.warps as any[]).length === 0)) {
      _map.warps = map.data.warps;
    } else if (map.data.warps && _map.warps) {
      // If there's saved data in the map file AND extracted data, merge them
      // Create a map of extracted warps by name to preserve layer info
      const extractedMap = new Map((_map.warps as any[]).map(w => [w.name, w]));
      const savedWarps = Array.isArray(map.data.warps) ? map.data.warps : Object.values(map.data.warps);

      // Merge: saved data takes precedence, but preserve layer from extracted data
      const merged = savedWarps.map((saved: any) => {
        const extracted = extractedMap.get(saved.name);
        return {
          ...saved,
          layer: extracted?.layer || saved.layer
        };
      });

      _map.warps = merged;
    }
  }

  let width: number | null = null;
  let height: number | null = null;

  for (const layer of map.data.layers) {
    if (layer.type !== "objectgroup") {
      if (layer.width && layer.height) {
        width = layer.width;
        height = layer.height;
        break;
      }
    }
  }

  if (width === null || height === null) {
    log.error(`Failed to find width and height for map ${map.name}`);
    throw new Error(`Invalid map data for ${map.name}`);
  }

  const tileCount = width * height;

  function compressLayer(layers: number[][], label: "collision" | "nopvp") {
    const rawMap = new Array(tileCount).fill(0);

    layers.forEach(layer => {
      for (let i = 0; i < layer.length; i++) {
        if (layer[i] !== 0) rawMap[i] = 1;
      }
    });

    const compressed: (number | [number, number])[] = [Number(width), Number(height)];
    let current = rawMap[0];
    let count = 1;
    for (let i = 1; i < rawMap.length; i++) {
      if (rawMap[i] === current) {
        count++;
      } else {
        compressed.push(current, count);
        current = rawMap[i];
        count = 1;
      }
    }
    compressed.push(current, count);

    const rawBytes = new Uint8Array(rawMap).length;
    const compressedBytes = new Uint8Array(compressed.flat()).length;

    const ratio = (rawBytes / compressedBytes).toFixed(2);
    const savings = (((rawBytes - compressedBytes) / rawBytes) * 100).toFixed(2);

    if (compressedBytes >= rawBytes) {
      log.error(`Failed to compress ${label} map for ${map.name}
  - Original: ${rawBytes} bytes
  - Compressed: ${compressedBytes} bytes`);
      throw new Error(`Failed to compress ${label} map`);
    }

    log.debug(`Compressed ${label} map for ${map.name}
  - Original: ${rawBytes} bytes
  - Compressed: ${compressedBytes} bytes
  - Compression Ratio: ${ratio}x
  - Compression Savings: ${savings}%`);

    assetCache.addNested(map.name.replace(".json", ""), label, compressed);
  }

  if (collisions.length > 0) compressLayer(collisions, "collision");
  if (noPvpZones.length > 0) compressLayer(noPvpZones, "nopvp");
}

export async function saveMapChunks(mapName: string, chunks: any[]): Promise<void> {
  try {
    const file = mapName.endsWith(".json") ? mapName : `${mapName}.json`;
    const fullPath = path.join(mapDir, file);

    if (!fs.existsSync(fullPath)) {
      throw new Error(`Map ${file} not found`);
    }

    const mapData = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
    const CHUNK_SIZE = mapData.tilewidth;
    const chunkSize = CHUNK_SIZE;

    for (const chunk of chunks) {
      const startX = chunk.chunkX * chunkSize;
      const startY = chunk.chunkY * chunkSize;

      log.debug(`Saving chunk (${chunk.chunkX}, ${chunk.chunkY}) - startX: ${startX}, startY: ${startY}, mapData.width: ${mapData.width}`);

      for (const chunkLayer of chunk.layers) {

        const mapLayer = mapData.layers.find((l: any) => l.name === chunkLayer.name);

        if (mapLayer && mapLayer.data) {
          log.debug(`  Layer: ${chunkLayer.name}, layer width: ${mapLayer.width}, layer height: ${mapLayer.height}`);

          for (let y = 0; y < chunk.height; y++) {
            for (let x = 0; x < chunk.width; x++) {
              const chunkIndex = y * chunk.width + x;
              const mapX = startX + x;
              const mapY = startY + y;
              const mapIndex = mapY * mapLayer.width + mapX;

              if (mapIndex < mapLayer.data.length) {
                mapLayer.data[mapIndex] = chunkLayer.data[chunkIndex];
              }
            }
          }
        }
      }
    }

    fs.writeFileSync(fullPath, JSON.stringify(mapData, null, 2), "utf-8");
    log.success(`Saved ${chunks.length} chunk(s) to ${file}`);

    try {
      const collisions: number[][] = [];
      const noPvpZones: number[][] = [];

      mapData.layers.forEach((layer: any) => {
        if (layer.type !== "objectgroup") {
          const layerName = layer.name ? layer.name.toLowerCase() : "";
          if (layerName.includes("collision")) {
            collisions.push(layer.data);
          } else if (layerName.includes("nopvp") || layerName.includes("no-pvp")) {
            noPvpZones.push(layer.data);
          }
        }
      });

      let width: number | null = null;
      let height: number | null = null;

      for (const layer of mapData.layers) {
        if (layer.type !== "objectgroup" && layer.width && layer.height) {
          width = layer.width;
          height = layer.height;
          break;
        }
      }

      if (width && height) {
        const tileCount = width * height;

        if (collisions.length > 0) {
          const rawMap = new Array(tileCount).fill(0);
          collisions.forEach(layer => {
            for (let i = 0; i < layer.length; i++) {
              if (layer[i] !== 0) rawMap[i] = 1;
            }
          });

          const compressed: (number | [number, number])[] = [Number(width), Number(height)];
          let current = rawMap[0];
          let count = 1;
          for (let i = 1; i < rawMap.length; i++) {
            if (rawMap[i] === current) {
              count++;
            } else {
              compressed.push(current, count);
              current = rawMap[i];
              count = 1;
            }
          }
          compressed.push(current, count);

          assetCache.addNested(mapName.replace(".json", ""), "collision", compressed);
          log.success(`Reprocessed collision map for ${mapName}`);
        }

        if (noPvpZones.length > 0) {
          const rawMap = new Array(tileCount).fill(0);
          noPvpZones.forEach(layer => {
            for (let i = 0; i < layer.length; i++) {
              if (layer[i] !== 0) rawMap[i] = 1;
            }
          });

          const compressed: (number | [number, number])[] = [Number(width), Number(height)];
          let current = rawMap[0];
          let count = 1;
          for (let i = 1; i < rawMap.length; i++) {
            if (rawMap[i] === current) {
              count++;
            } else {
              compressed.push(current, count);
              current = rawMap[i];
              count = 1;
            }
          }
          compressed.push(current, count);

          assetCache.addNested(mapName.replace(".json", ""), "nopvp", compressed);
          log.success(`Reprocessed no-pvp map for ${mapName}`);
        }
      }
    } catch (collisionError) {
      log.error(`Failed to reprocess collision maps for ${mapName}: ${collisionError}`);

    }
  } catch (error) {
    log.error(`Failed to save map chunks: ${mapName}: ${error}`);
    throw error;
  }
}

export async function saveMapProperties(mapName: string, graveyards?: any, warps?: any): Promise<void> {
  try {
    const file = mapName.endsWith(".json") ? mapName : `${mapName}.json`;
    const fullPath = path.join(mapDir, file);

    if (!fs.existsSync(fullPath)) {
      throw new Error(`Map ${file} not found`);
    }

    const mapData = JSON.parse(fs.readFileSync(fullPath, "utf-8"));

    // Add graveyards and warps properties to the map file (for custom use)
    if (graveyards !== undefined) {
      mapData.graveyards = graveyards;
    }
    if (warps !== undefined) {
      mapData.warps = warps;
    }

    // Update Tiled object layers with the objects
    if (graveyards !== undefined) {
      let graveyardLayer = mapData.layers.find((l: any) => l.name === "Graveyards" && l.type === "objectgroup");
      // Create the layer if it doesn't exist
      if (!graveyardLayer) {
        graveyardLayer = {
          draworder: "topdown",
          id: Math.max(...mapData.layers.map((l: any) => l.id || 0), 0) + 1,
          name: "Graveyards",
          objects: [],
          opacity: 1,
          type: "objectgroup",
          visible: true,
          x: 0,
          y: 0
        };
        mapData.layers.push(graveyardLayer);
      }
      if (graveyardLayer) {
        // Create a map of existing objects by name for ID preservation
        const existingObjMap = new Map(graveyardLayer.objects?.map((obj: any) => [obj.name, obj]) || []);
        let nextId = Math.max(1, ...(graveyardLayer.objects?.map((o: any) => o.id || 0) || [1])) + 1;

        // Convert graveyards array/object to Tiled objects array
        const graveyardsArray = Array.isArray(graveyards) ? graveyards : Object.entries(graveyards).map(([name, data]: [string, any]) => ({ name, ...data }));

        graveyardLayer.objects = graveyardsArray.map((data: any) => {
          const name = data.name;
          const existingObj = existingObjMap.get(name) as any;
          const objId = existingObj?.id || nextId++;

          // Convert custom properties to Tiled format (array of {name, value, type})
          const tiledProperties: any[] = [];
          if (data && typeof data === 'object') {
            Object.entries(data).forEach(([propName, propValue]: [string, any]) => {
              // Skip position, layer, name, and x/y as those are handled specially
              if (propName !== 'position' && propName !== 'layer' && propName !== 'name' && propName !== 'x' && propName !== 'y') {
                tiledProperties.push({
                  name: propName,
                  type: typeof propValue,
                  value: propValue
                });
              }
            });
          }

          return {
            ...existingObj,
            id: objId,
            name: name,
            type: "graveyard",
            x: data.position?.x || data.x || 0,
            y: data.position?.y || data.y || 0,
            width: 0,
            height: 0,
            rotation: 0,
            visible: true,
            point: true,
            properties: tiledProperties.length > 0 ? tiledProperties : undefined
          };
        });
      }
    }

    if (warps !== undefined) {
      let warpLayer = mapData.layers.find((l: any) => l.name === "Warps" && l.type === "objectgroup");
      // Create the layer if it doesn't exist
      if (!warpLayer) {
        warpLayer = {
          draworder: "topdown",
          id: Math.max(...mapData.layers.map((l: any) => l.id || 0), 0) + 1,
          name: "Warps",
          objects: [],
          opacity: 1,
          type: "objectgroup",
          visible: true,
          x: 0,
          y: 0
        };
        mapData.layers.push(warpLayer);
      }
      if (warpLayer) {
        // Create a map of existing objects by name for ID preservation
        const existingObjMap = new Map(warpLayer.objects?.map((obj: any) => [obj.name, obj]) || []);
        let nextId = Math.max(1, ...(warpLayer.objects?.map((o: any) => o.id || 0) || [1])) + 1;

        // Convert warps array/object to Tiled objects array
        const warpsArray = Array.isArray(warps) ? warps : Object.entries(warps).map(([name, data]: [string, any]) => ({ name, ...data }));

        warpLayer.objects = warpsArray.map((data: any) => {
          const name = data.name;
          const existingObj = existingObjMap.get(name) as any;
          const objId = existingObj?.id || nextId++;

          // Convert custom properties to Tiled format (array of {name, value, type})
          const tiledProperties: any[] = [];
          if (data && typeof data === 'object') {
            Object.entries(data).forEach(([propName, propValue]: [string, any]) => {
              // Skip position, size, layer, and name as those are handled specially, but KEEP map, x, y
              if (propName !== 'position' && propName !== 'size' && propName !== 'layer' && propName !== 'name') {
                tiledProperties.push({
                  name: propName,
                  type: typeof propValue,
                  value: propValue
                });
              }
            });
          }

          return {
            ...existingObj,
            id: objId,
            name: name,
            type: "warp",
            x: data.position?.x || data.x || 0,
            y: data.position?.y || data.y || 0,
            width: data.size?.width || 32,
            height: data.size?.height || 32,
            rotation: 0,
            visible: true,
            properties: tiledProperties.length > 0 ? tiledProperties : undefined
          };
        });
      }
    }

    fs.writeFileSync(fullPath, JSON.stringify(mapData, null, 2), "utf-8");
    log.success(`Saved graveyards/warps properties for ${file}`);
  } catch (error) {
    log.error(`Failed to save map properties for ${mapName}: ${error}`);
    throw error;
  }
}

export async function reloadMap(mapName: string): Promise<MapData> {
  try {
    const file = mapName.endsWith(".json") ? mapName : `${mapName}.json`;
    const fullPath = path.join(mapDir, file);

    if (!fs.existsSync(fullPath)) {
      throw new Error(`Map ${file} not found`);
    }

    const newMap = processMapFile(file);
    if (!newMap) {
      throw new Error(`Failed to load map ${file}`);
    }

    assetCache.removeNested(mapName, "collision");
    assetCache.removeNested(mapName, "nopvp");

    extractAndCompressLayers(newMap);

    const maps = await assetCache.get("maps") as MapData[];
    const mapProps = await assetCache.get("mapProperties") as MapProperties[];

    const index = maps.findIndex(m => m.name === file);

    // Get the updated mapProperties from the cache (extractAndCompressLayers updated it)
    const existingProps = mapProps.find(m => m.name.replace(".json", "") === newMap.name.replace(".json", ""));
    const existingGraveyards = existingProps?.graveyards;
    const existingWarps = existingProps?.warps;

    const newProps: MapProperties = {
      name: newMap.name,
      width: newMap.data.layers[0].width,
      height: newMap.data.layers[0].height,
      tileWidth: newMap.data.tilewidth,
      tileHeight: newMap.data.tileheight,
      warps: existingWarps || null,
      graveyards: existingGraveyards || null,
    };

    if (index >= 0) {
      maps[index] = newMap;
      mapProps[index] = newProps;
    } else {
      maps.push(newMap);
      mapProps.push(newProps);
    }

    assetCache.add("maps", maps);
    assetCache.add("mapProperties", mapProps);

    return newMap;
  } catch (error) {
    log.error(`Failed to reload map: ${mapName}: ${error}`);
    throw error;
  }
}

loadAllMaps();

function tryParse(data: string): any {
  try {
    return JSON.parse(data);
  } catch (e: any) {
    log.error(e);
    return null;
  }
}

const assetLoadingEndTime = performance.now();
const totalAssetLoadingTime = (assetLoadingEndTime - assetLoadingStartTime).toFixed(2);
log.success(`✔ All assets loaded successfully in ${totalAssetLoadingTime}ms`);