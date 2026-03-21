import path from "path";
import fs from "fs";
import log from "./logger";
import item from "../systems/items";
import spell from "../systems/spells";
import npc from "../systems/npcs";
import particle from "../systems/particles";
import worlds from "../systems/worlds";
import quest from "../systems/quests";

import assetCache from "../services/assetCache";
import zlib from "zlib";
import * as settings from "../config/settings.json";
const defaultMap = settings.default_map?.replace(".json", "") || "main";

import assetConfig from "../services/assetConfig";
import mounts from "../systems/mounts";
const assetPath = assetConfig.getAssetConfig() as string;
const assetData = assetConfig.getAssetData() as any;

if (!assetConfig.getAssetConfig()) {
  throw new Error("Asset path not found");
}

const assetLoadingStartTime = performance.now();

function loadAnimations() {
  const now = performance.now();

  const animationPath = path.join(assetPath, assetData.animations.path);
  if (!fs.existsSync(animationPath)) return;

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

function loadSprites() {
  const now = performance.now();
  const sprites = [] as any[];

  const spriteDir = path.join(assetPath, assetData.sprites.path);

  if (!fs.existsSync(spriteDir)) {
    throw new Error(`Sprites directory not found at ${spriteDir}`);
  }

  const spriteFiles = fs.readdirSync(spriteDir).filter((file) => file.endsWith(".png"));

  spriteFiles.forEach((file) => {
    const name = file.replace(".png", "");
    const rawData = fs.readFileSync(path.join(spriteDir, file));
    const base64Data = rawData.toString("base64");

    log.debug(`Loaded sprite: ${name}`);

    const compressedData = zlib.deflateSync(base64Data);

    sprites.push({ name, data: compressedData });
    assetCache.add(`sprite_${name}`, compressedData);

    const originalSize = base64Data.length;
    const compressedSize = compressedData.length;
    const ratio = (originalSize / compressedSize).toFixed(2);
    const savings = (((originalSize - compressedSize) / originalSize) * 100).toFixed(2);

    log.debug(`Compressed sprite: ${name}
  - Original: ${originalSize} bytes
  - Compressed: ${compressedSize} bytes
  - Compression Ratio: ${ratio}x
  - Compression Savings: ${savings}%`);
  });
  assetCache.add("sprites", sprites);
  log.success(`Loaded ${sprites.length} sprite(s) in ${(performance.now() - now).toFixed(2)}ms`);
}
loadSprites();

async function loadSpriteSheetTemplates() {
  const now = performance.now();
  const templates = [] as any[];

  const animationsDir = path.join(assetPath, 'animations');

  const spriteSheetDir = path.join(assetPath, 'spritesheets');

  if (!fs.existsSync(animationsDir)) {
    log.warn('Animations directory not found at ' + animationsDir + ', skipping animation template loading');
    await assetCache.add('spriteSheetTemplates', []);
    return;
  }

  if (!fs.existsSync(spriteSheetDir)) {
    log.warn('Sprite sheets directory not found at ' + spriteSheetDir + ', skipping sprite sheet image loading');
    await assetCache.add('spriteSheetTemplates', []);
    return;
  }

  const templateFiles = fs.readdirSync(animationsDir)
    .filter(file => file.endsWith('.json'));

  if (templateFiles.length === 0) {
    log.warn('No animation templates found in ' + animationsDir);
    await assetCache.add('spriteSheetTemplates', []);
    return;
  }

  templateFiles.forEach(file => {
    const templatePath = path.join(animationsDir, file);
    const templateData = JSON.parse(fs.readFileSync(templatePath, 'utf-8'));

    const templateJson = JSON.stringify(templateData);
    const compressedTemplate = zlib.deflateSync(templateJson);

    const pngFile = templateData.imageSource;
    const pngPath = path.join(spriteSheetDir, pngFile);
    let compressedImage = null;

    if (fs.existsSync(pngPath)) {

      const imageBuffer = fs.readFileSync(pngPath);
      const base64Image = imageBuffer.toString('base64');
      compressedImage = zlib.deflateSync(base64Image);

      const originalTemplateSize = templateJson.length;
      const compressedTemplateSize = compressedTemplate.length;
      const originalImageSize = base64Image.length;
      const compressedImageSize = compressedImage.length;

      log.debug(`Loaded animation template: ${file} with image ${pngFile}
  - Template Original: ${originalTemplateSize} bytes, Compressed: ${compressedTemplateSize} bytes
  - Image Original: ${originalImageSize} bytes, Compressed: ${compressedImageSize} bytes
  - Total Compression Ratio: ${((originalTemplateSize + originalImageSize) / (compressedTemplateSize + compressedImageSize)).toFixed(2)}x`);
    } else {
      log.debug(`Loaded animation template: ${file} (no image - template only, imageSource "${pngFile}" not found)`);
    }

    templates.push({
      name: file.replace('.json', ''),
      template: compressedTemplate,
      image: compressedImage
    });
  });

  function getAllPngFilesRecursive(dir: string, baseDir: string = dir): string[] {
    let results: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {

        results = results.concat(getAllPngFilesRecursive(fullPath, baseDir));
      } else if (entry.name.endsWith('.png')) {

        const relativePath = path.relative(baseDir, fullPath);
        results.push(relativePath);
      }
    }
    return results;
  }

  const allPngFiles = getAllPngFilesRecursive(spriteSheetDir);

  const templatePngFiles = new Set(templateFiles.map(f => {
    const templatePath = path.join(animationsDir, f);
    const templateData = JSON.parse(fs.readFileSync(templatePath, 'utf-8'));
    return templateData.imageSource;
  }));

  allPngFiles.forEach(pngFile => {

    if (templatePngFiles.has(pngFile)) {
      return;
    }

    const pngPath = path.join(spriteSheetDir, pngFile);
    const imageBuffer = fs.readFileSync(pngPath);
    const base64Image = imageBuffer.toString('base64');
    const compressedImage = zlib.deflateSync(base64Image);

    const filename = path.basename(pngFile, '.png');

    templates.push({
      name: filename,
      template: null,
      image: compressedImage
    });

    log.debug(`Loaded sprite sheet image only: ${pngFile} (name: ${filename})`);
  });

  await assetCache.add('spriteSheetTemplates', templates);
  log.success(`Loaded ${templates.length} sprite sheet(s) (${templateFiles.length} with templates, ${templates.length - templateFiles.length} images only) in ${(performance.now() - now).toFixed(2)}ms`);
}
await loadSpriteSheetTemplates();

function loadIcons() {
  const now = performance.now();
  const icons = [] as any[];
  const iconDir = path.join(assetPath, assetData.icons.path);

  if (!fs.existsSync(iconDir)) {
    throw new Error(`Icons directory not found at ${iconDir}`);
  }

  const iconFiles = fs.readdirSync(iconDir).filter((file) => file.endsWith(".png"));

  iconFiles.forEach((file) => {
    const name = file.replace(".png", "");
    const rawData = fs.readFileSync(path.join(iconDir, file));
    const base64Data = rawData.toString("base64");

    log.debug(`Loaded icon: ${name}`);

    const compressedData = zlib.deflateSync(base64Data);

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
const missingIcon = await assetCache.get("missing_icon");

await Promise.all(itemList.map(async (item: any) => {
  if (item.icon) {
    const iconData = await assetCache.get(item.icon);
    item.icon = iconData || missingIcon || null;
  }
}));
await assetCache.add("items", itemList);
const items = await assetCache.get("items") as Item[];

log.success(`Loaded ${items.length} item(s) from the database in ${(performance.now() - itemnow).toFixed(2)}ms`);

const mountNow = performance.now();
const unfilteredMounts = await mounts.list();

const filteredMounts = unfilteredMounts.filter((m) => {
  const spriteSheetDir = path.join(assetPath, 'spritesheets');
  const mountImageName = `${m.name.toLowerCase()}.png`;
  const mountImagePath = path.join(spriteSheetDir, 'mounts', mountImageName);
  const result = fs.existsSync(mountImagePath);
  if (!result) {
    log.warn(`Mount ${m.name} has no corresponding sprite sheet image (mounts/${mountImageName}) and will be skipped`);
  }
  return result;
});

await Promise.all(filteredMounts.map(async (mount: any) => {
  if (mount.icon) {
    const iconData = await assetCache.get(mount.icon);
    mount.icon = iconData || missingIcon || null;
  }
}));

await assetCache.add("mounts", filteredMounts);
const mountList = await assetCache.get("mounts") as Mount[];

log.success(`Loaded ${mountList.length} mount(s) from the database in ${(performance.now() - mountNow).toFixed(2)}ms`);
log.info(`Mounts loaded: ${mountList.map((m) => m.name).join(", ")}`);

const spellnow = performance.now();
const spellList = await spell.list();
await Promise.all(spellList.map(async (spell: any) => {
  if (spell.icon) {
    const iconData = await assetCache.get(spell.icon);
    const spriteData = await assetCache.get(`sprite_${spell.icon}`);
    spell.icon = iconData || null;
    spell.sprite = spriteData || missingIcon || null;
  }
}));
await assetCache.add("spells", spellList);
const spells = await assetCache.get("spells") as SpellData[];

log.success(`Loaded ${spells.length} spell(s) from the database in ${(performance.now() - spellnow).toFixed(2)}ms`);
log.info(`Spells loaded: ${spells.map((s) => s.name).join(", ")}`);

const npcnow = performance.now();
await assetCache.add("npcs", await npc.list());
const npcs = await assetCache.get("npcs") as Npc[];
log.success(`Loaded ${npcs.length} npc(s) from the database in ${(performance.now() - npcnow).toFixed(2)}ms`);

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
  const mapDir = path.join(assetPath, assetData.maps.path);
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
        warps: null,
        graveyards: null
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
  const mapDir = path.join(assetPath, assetData.maps.path);
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
      const objects = layer.objects;
      objects.forEach((obj: any) => {

        const type = obj?.class?.toLowerCase() || obj?.type?.toLowerCase();
        if (!type) {
          log.warn(`Object in map ${map.name} has no type or class: ${JSON.stringify(obj)}`);
          return;
        }
        const propsMap = new Map(obj.properties?.map((p: any) => [p.name, p.value]));
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
              }
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

      if (graveyards.length > 0) {
        log.debug(`Found ${graveyards.length} graveyard(s) in map ${map.name}`);
        const _map = mapProperties.find(m => m.name.replace(".json", "") === map.name.replace(".json", "")) as MapProperties | undefined;
        if (!_map) {
          log.error(`Map properties not found for ${map.name}`);
          return;
        }
        _map.graveyards = graveyards;
        log.debug(`Extracted ${graveyards.length} graveyard(s) from map ${map.name}`);
      }
    }
  });

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
    const mapDir = path.join(assetPath, assetData.maps.path);
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

export async function reloadMap(mapName: string): Promise<MapData> {
  try {
    const mapDir = path.join(assetPath, assetData.maps.path);
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
      warps: null,
      graveyards: null,
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

function parseAnimations() {
  const animationFiles = fs
    .readdirSync(path.join(assetPath, assetData.animations.path))
    .filter((file) => file.toLowerCase().endsWith(".png"));
  return animationFiles;
}

function validateAnimationFile(file: string) {

  const buffer = fs.readFileSync(
    path.join(assetPath, assetData.animations.path, file)
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

const assetLoadingEndTime = performance.now();
const totalAssetLoadingTime = (assetLoadingEndTime - assetLoadingStartTime).toFixed(2);
log.success(`✔ All assets loaded successfully in ${totalAssetLoadingTime}ms`);