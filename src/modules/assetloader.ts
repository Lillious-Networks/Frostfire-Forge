import path from "path";
import fs from "fs";
import log from "./logger";
import weapon from "../systems/weapons";
import item from "../systems/items";
import spell from "../systems/spells";
import npc from "../systems/npcs";
import particle from "../systems/particles";
import worlds from "../systems/worlds";
import quest from "../systems/quests";
// import NPC from "../systems/npc_scripting";
import assetCache from "../services/assetCache";
import generate from "../modules/sprites";
import zlib from "zlib";
import * as settings from "../../config/settings.json";
const defaultMap = settings.default_map?.replace(".json", "") || "main";

import assetConfig from "../services/assetConfig";
const assetPath = assetConfig.getAssetConfig();
if (!assetPath || !fs.existsSync(path.join(import.meta.dir, assetPath))) {
  throw new Error(`Asset path not found at ${assetPath}`);
}

const asset = fs.readFileSync(path.join(import.meta.dir, assetPath), "utf-8");
if (!asset) {
  throw new Error("Failed to load asset config");
}

const assetData = JSON.parse(asset);

function loadAnimations() {
  const now = performance.now();

  const animationPath = path.join(import.meta.dir, assetData.animations.path);
  if (!fs.existsSync(animationPath)) {
    console.log("No animations found");
    return;
  }

  const animationFiles = parseAnimations();
  const animations = [] as any[];

  for (const file of animationFiles) {
    if (validateAnimationFile(file)) {
      const buffer = fs.readFileSync(path.join(animationPath, file));
      const compressed = zlib.deflateSync(buffer);

      const originalSize = buffer.length;
      const compressedSize = compressed.length;
      const ratio = (originalSize / compressedSize).toFixed(2);
      const savings = (((originalSize - compressedSize) / originalSize) * 100).toFixed(2);

      log.debug(`Compressed animation: ${file}
  - Original: ${originalSize} bytes
  - Compressed: ${compressedSize} bytes
  - Compression Ratio: ${ratio}x
  - Compression Savings: ${savings}%`);

      animations.push({ name: file, data: compressed });
    }
  }

  assetCache.add("animations", animations);
  log.success(`Loaded ${animations.length} animation(s) in ${(performance.now() - now).toFixed(2)}ms`);
}
loadAnimations();

function loadIcons() {
  const now = performance.now();
  const icons = [] as any[];
  const iconDir = path.join(import.meta.dir, assetData.icons.path);

  if (!fs.existsSync(iconDir)) {
    throw new Error(`Icons directory not found at ${iconDir}`);
  }

  const iconFiles = fs.readdirSync(iconDir).filter((file) => file.endsWith(".png"));

  iconFiles.forEach((file) => {
    const name = file.replace(".png", "");
    const rawData = fs.readFileSync(path.join(iconDir, file));
    const base64Data = rawData.toString("base64");

    log.debug(`Loaded icon: ${name}`);

    const compressedData = zlib.gzipSync(base64Data);

    icons.push({ name, data: compressedData });
    assetCache.add(name, compressedData);

    const originalSize = base64Data.length;
    const compressedSize = compressedData.length;
    const ratio = (originalSize / compressedSize).toFixed(2);
    const savings = (((originalSize - compressedSize) / originalSize) * 100).toFixed(2);

    log.debug(`Compressed icon: ${name}
  - Original: ${originalSize} bytes
  - Compressed: ${compressedSize} bytes
  - Compression Ratio: ${ratio}x
  - Compression Savings: ${savings}%`);
  });

  assetCache.add("icons", icons);
  log.success(`Loaded ${icons.length} icon(s) in ${(performance.now() - now).toFixed(2)}ms`);
}
loadIcons();

// Load world data
const worldNow = performance.now();
await assetCache.add("worlds", await worlds.list());
const world = await assetCache.get("worlds") as WorldData[];
log.success(`Loaded ${world.length} world(s) from the database in ${(performance.now() - worldNow).toFixed(2)}ms`);

// Check if the world name in the config is in the asset cache
const worldName = settings.world;
if (!world.find((w) => w.name === worldName)) {
  throw new Error(`World name ${worldName} was not loaded correctly from the database\nFound the following worlds: ${world.map((w) => w.name).join(", ")}`);
} else {
  log.success(`World: ${worldName} was loaded correctly from the database`);
}

// Load item data
const itemnow = performance.now();
await assetCache.add("items", await item.list());
// For each item, find the icon data and add the compressed data to the item object
const itemList = await assetCache.get("items");
itemList.forEach(async (item: any) => {
  if (item.icon) {
    const iconData = await assetCache.get(item.icon);
    item.icon = iconData || null; // Replace the icon with the compressed data if it exists
  }
});
const items = await assetCache.get("items") as Item[];

log.success(`Loaded ${items.length} item(s) from the database in ${(performance.now() - itemnow).toFixed(2)}ms`);

// Load spell data
const spellnow = performance.now();
await assetCache.add("spells", await spell.list());
const spells = await assetCache.get("spells") as SpellData[];
log.success(`Loaded ${spells.length} spell(s) from the database in ${(performance.now() - spellnow).toFixed(2)}ms`);

// Load weapon data
const weaponnow = performance.now();
await assetCache.add("weapons", await weapon.list());
const weapons = await assetCache.get("weapons") as WeaponData[];
log.success(`Loaded ${weapons.length} weapon(s) from the database in ${(performance.now() - weaponnow).toFixed(2)}ms`);

// Load npc data
const npcnow = performance.now();
await assetCache.add("npcs", await npc.list());
const npcs = await assetCache.get("npcs") as Npc[];
log.success(`Loaded ${npcs.length} npc(s) from the database in ${(performance.now() - npcnow).toFixed(2)}ms`);

// Load particle data
const particleNow = performance.now();
await assetCache.add("particles", await particle.list());
const particles = await assetCache.get("particles") as Particle[];
log.success(`Loaded ${particles.length} particle(s) from the database in ${(performance.now() - particleNow).toFixed(2)}ms`);

// Load quest data
const questNow = performance.now();
await assetCache.add("quests", await quest.list());
const quests = await assetCache.get("quests") as Quest[];
log.success(`Loaded ${quests.length} quest(s) from the database in ${(performance.now() - questNow).toFixed(2)}ms`);

// Load maps
const mapProperties: MapProperties[] = [];
function loadAllMaps() {
  const now = performance.now();
  const mapDir = path.join(import.meta.dir, assetData.maps.path);
  const maps: MapData[] = [];

  if (!fs.existsSync(mapDir)) throw new Error(`Maps directory not found at ${mapDir}`);

  const mapFiles = fs.readdirSync(mapDir).filter(f => f.endsWith(".json"));
  if (mapFiles.length === 0) throw new Error("No maps found in the maps directory");

  for (const file of mapFiles) {
    const map = processMapFile(file);
    if (map) {
      maps.push(map);
      mapProperties.push({
        name: map.name,
        width: map.data.layers[0].width,
        height: map.data.layers[0].height,
        tileWidth: map.data.tilewidth,
        tileHeight: map.data.tileheight,
        warps: null, // Will be set later
      });
      extractAndCompressLayers(map);
    }
  }

  const mainMap = maps.find((m) => m.name === `${defaultMap}.json`);
  if (!mainMap) throw new Error(`Default map ${defaultMap} not found in the maps directory`);

  assetCache.add("maps", maps);
  assetCache.add("mapProperties", mapProperties);
  log.success(`Loaded ${maps.length} map(s) in ${(performance.now() - now).toFixed(2)}ms`);
}

function processMapFile(file: string): MapData | null {
  const mapDir = path.join(import.meta.dir, assetData.maps.path);
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
  };
}

function extractAndCompressLayers(map: MapData) {
  const collisions: number[][] = [];
  const noPvpZones: number[][] = [];
  const warps: any[] = [];

  map.data.layers.forEach((layer: any) => {
    // Collisions
    if (layer.properties?.[0]?.name.toLowerCase() === "collision" && layer.properties[0].value === true) {
      collisions.push(layer.data);
    }
    // No PvP zones
    if (layer.properties?.[0]?.name.toLowerCase() === "nopvp" && layer.properties[0].value === true) {
      noPvpZones.push(layer.data);
    }

    // Check if layer is an object group
    if (layer.type === "objectgroup") {
      const objects = layer.objects;
      objects.forEach((obj: any) => {
        // UI references "class" but JSON references "type"
        // They are the same thing in Tiled, but we check both for compatibility
        const type = obj?.class?.toLowerCase() || obj?.type?.toLowerCase();
        if (!type) {
          log.warn(`Object in map ${map.name} has no type or class: ${JSON.stringify(obj)}`);
          return;
        }
        switch (type) {
          // Warp objects
          case "warp": {
                        const _map = obj.properties?.find((p: any) => p.name === "map")?.value;
            const x = obj.properties?.find((p: any) => p.name === "x")?.value;
            const y = obj.properties?.find((p: any) => p.name === "y")?.value;

            // Normalize position: top-left (map) is (0,0), canvas center is (0,0)
            const mapWidth = map.data.width * map.data.tilewidth;
            const mapHeight = map.data.height * map.data.tileheight;
            const posX = Math.floor(obj.x - mapWidth / 2);
            const posY = Math.floor(obj.y - mapHeight / 2);
            const width = Math.floor(obj.width);
            const height = Math.floor(obj.height);

            if (_map && x !== undefined && y !== undefined) {
              warps.push({
                name: obj.name,
                map: _map,
                x: x,
                y: y,
                position: {
                  x: posX,
                  y: posY,
                },
                size: {
                  width: width,
                  height: height,
                },
              });
            } else {
              log.warn(`Invalid warp object in map ${map.name}: ${JSON.stringify(obj)}`);
            }
          }
          break;
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
        _map.warps = warps.reduce((acc, warp) => {
          acc[warp.name] = {
            map: warp.map,
            position: warp.position,
            x: warp.x,
            y: warp.y,
            size: warp.size
          };
          return acc;
        }, {} as { [key: string]: { map: string; position: any; x: number; y: number; size: { width: number; height: number; }; } });
        log.debug(`Extracted ${warps.length} warp(s) from map ${map.name}`);
      }
    }    
  });

  let width: number | null = null;
  let height: number | null = null;

  // Find the first layer that has a defined width and height
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

export async function reloadMap(mapName: string): Promise<MapData> {
  try {
    const mapDir = path.join(import.meta.dir, assetData.maps.path);
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
    const newProps: MapProperties = {
      name: newMap.name,
      width: newMap.data.layers[0].width,
      height: newMap.data.layers[0].height,
      tileWidth: newMap.data.tilewidth,
      tileHeight: newMap.data.tileheight,
      warps: null, // Will be set later
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

    log.success(`Reloaded map: ${file}`);
    return newMap;
  } catch (error) {
    log.error(`Failed to reload map: ${mapName}: ${error}`);
    throw error; // Let the caller handle the error
  }
}

loadAllMaps();

// Load tilesets
async function loadTilesets() {
  const now = performance.now();
  const tilesets = [] as TilesetData[];
  const tilesetDir = path.join(import.meta.dir, assetData.tilesets.path);

  if (!fs.existsSync(tilesetDir)) {
    throw new Error(`Tilesets directory not found at ${tilesetDir}`);
  }

  const tilesetFiles = fs.readdirSync(tilesetDir);
  tilesetFiles.forEach((file) => {
    // Read raw file as Buffer
    const tilesetData = fs.readFileSync(path.join(tilesetDir, file));
    // Compress using gzip
    const compressedData = zlib.gzipSync(tilesetData);

    const originalSize = tilesetData.length;
    const compressedSize = compressedData.length;
    const ratio = (originalSize / compressedSize).toFixed(2);
    const savings = (((originalSize - compressedSize) / originalSize) * 100).toFixed(2);

    log.debug(`Loaded tileset: ${file}`);
    log.debug(`Compressed tileset: ${file}
  - Original: ${originalSize} bytes
  - Compressed: ${compressedSize} bytes
  - Compression Ratio: ${ratio}x
  - Compression Savings: ${savings}%`);

    tilesets.push({ name: file, data: compressedData });
  });

  // Store as Base64 strings to work with JSON.stringify in Redis
  await assetCache.add(
    "tilesets",
    tilesets.map(t => ({
      name: t.name,
      data: t.data.toString("base64") // encode buffer as base64
    }))
  );

  log.success(`Loaded ${tilesets.length} tileset(s) in ${(performance.now() - now).toFixed(2)}ms`);
}

await loadTilesets();

function tryParse(data: string): any {
  try {
    return JSON.parse(data);
  } catch (e: any) {
    log.error(e);
    return null;
  }
}

function loadSoundEffects() {
  const now = performance.now();
  const soundEffects = [] as SoundData[];
  const soundEffectDir = path.join(import.meta.dir, assetData.sfx.path);

  if (!fs.existsSync(soundEffectDir)) {
    throw new Error(`Sound effects directory not found at ${soundEffectDir}`);
  }

  const soundEffectFiles = fs.readdirSync(soundEffectDir).filter((file) => file.endsWith(".mp3"));

  soundEffectFiles.forEach((file) => {
    const name = file.replace(".mp3", "");
    const data = fs.readFileSync(path.join(soundEffectDir, file), "base64");
    const compressedData = zlib.gzipSync(data);

    const originalSize = data.length;
    const compressedSize = compressedData.length;
    const ratio = (originalSize / compressedSize).toFixed(2);
    const savings = (((originalSize - compressedSize) / originalSize) * 100).toFixed(2);

    log.debug(`Loaded sound effect: ${name}`);
    log.debug(`Compressed sound effect: ${name}
  - Original: ${originalSize} bytes
  - Compressed: ${compressedSize} bytes
  - Compression Ratio: ${ratio}x
  - Compression Savings: ${savings}%`);

    soundEffects.push({ name, data: compressedData });
  });

  assetCache.add("audio", soundEffects);
  log.success(`Loaded ${soundEffects.length} sound effect(s) in ${(performance.now() - now).toFixed(2)}ms`);
}
loadSoundEffects();

async function loadSpriteSheets() {
  const spritesheetnow = performance.now();
  const spritesheets = [] as SpriteSheetData[];
  const spriteDir = path.join(import.meta.dir, assetData.spritesheets.path);
  if (!fs.existsSync(spriteDir)) {
    throw new Error(`Sprites directory not found at ${spriteDir}`);
  }

  // Not a folder
  fs.readdirSync(spriteDir).filter((file) => file.endsWith(".png")).map((file) => {
    const name = file.replace(".png", "");
    const data = fs.readFileSync(path.join(spriteDir, file), "base64");
    const buffer = Buffer.from(data, "base64");
    log.debug(`Loaded sprite sheet: ${name}`);
    spritesheets.push({ name, width: 24, height: 40, data: buffer });
  });

  assetCache.add("spritesheets", spritesheets);
  log.success(`Loaded ${spritesheets.length} sprite sheet(s) in ${(performance.now() - spritesheetnow).toFixed(2)}ms`);

  const sprites = [] as SpriteData[];
  const spritenow = performance.now();
  const spritePromises = spritesheets.map(async (spritesheet: any) => {
    const sprite = await generate(spritesheet) as any;
    return sprite;
  });

  const spriteData = await Promise.all(spritePromises);
  spriteData.forEach((sprite) => {
    sprites.push(sprite);
  });

  log.success(`Generated ${sprites.length} sprite(s) in ${(performance.now() - spritenow).toFixed(2)}ms`);
}

await loadSpriteSheets();

function parseAnimations() {
  const animationFiles = fs
    .readdirSync(path.join(import.meta.dir, assetData.animations.path))
    .filter((file) => file.toLowerCase().endsWith(".png"));
  return animationFiles;
}

function validateAnimationFile(file: string) {
  // Check for PNG byte
  const buffer = fs.readFileSync(
    path.join(import.meta.dir, assetData.animations.path, file)
  );
  if (
    buffer[0] !== 0x89 ||
    buffer[1] !== 0x50 ||
    buffer[2] !== 0x4e ||
    buffer[3] !== 0x47
  ) {
    return false;
  }
  return true;
}