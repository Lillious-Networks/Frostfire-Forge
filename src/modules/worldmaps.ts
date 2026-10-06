import path from "path";
import fs from "fs";
import crypto from "crypto";
import log from "./logger";
import { removeUnlistedWorlds } from "./mapmirror";

// World maps: a map too large to hold as one Tiled file (the 10240 x 10240 continent) is a directory <id>.world/ in
// the maps folder, written by the map generator and served by the asset server. The game server never needs its
// tiles: it keeps the manifest (size, tile size, tilesets, layer list, objects) and two bitsets, one bit per tile,
// for collision and no-pvp zones. That is about 25 MB for a 10240 x 10240 world.
//
// A world is known everywhere else under the name a Tiled map would have ("<id>.json") and gets the same MapData and
// MapProperties entries, with tile layers that carry no data. Collision and no-pvp are read from the bitsets
// (systems/player.ts), since run lengths with a linear scan do not work at this size.
//
// Worlds are read only: the editor cannot save them yet.

const BITS_MAGIC = 0x42574646; // "FFWB"
const BITS_HEADER_BYTES = 32;
const FORMAT_VERSION = 1;
const ROLE_COLLISION = 1;
const ROLE_NOPVP = 2;

// The files of a world kept here, in the order they are written: the manifest last, so a copy cut short is never
// taken for a whole one.
const WORLD_FILES = ["collision.bits", "nopvp.bits", "manifest.json"] as const;

/** One bit per tile. */
export class WorldBits {
  readonly width: number;
  readonly height: number;
  private readonly blockBytes: number;
  private readonly shift: number;
  private readonly mask: number;

  constructor(private bytes: Uint8Array, chunkSize: number, private readonly chunksX: number, chunksY: number) {
    this.width = chunksX * chunkSize;
    this.height = chunksY * chunkSize;
    this.blockBytes = (chunkSize * chunkSize) >>> 3;
    this.shift = Math.log2(chunkSize);
    this.mask = chunkSize - 1;
  }

  /** 1 when the tile is set, 0 when it is not or lies outside the world. */
  isSet(tileX: number, tileY: number): number {
    if (!(tileX >= 0 && tileY >= 0 && tileX < this.width && tileY < this.height)) return 0;
    const k = ((tileY & this.mask) << this.shift) | (tileX & this.mask);
    const byte = BITS_HEADER_BYTES + ((tileY >> this.shift) * this.chunksX + (tileX >> this.shift)) * this.blockBytes + (k >> 3);
    return (this.bytes[byte]! >> (k & 7)) & 1;
  }

  /**
   * Takes over the bits of a newer copy of the same world (after an editor save). Everything that holds this object
   * (movement's map cache, the creatures' nav grid) reads the new bits from then on.
   */
  adopt(newer: WorldBits): void {
    if (newer.width !== this.width || newer.height !== this.height) throw new Error("the world changed size");
    this.bytes = newer.bytes;
  }
}

export interface WorldMap {
  id: string;
  /** "<id>.json" */
  name: string;
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  collision: WorldBits;
  nopvp: WorldBits;
  /** Where new players start, in pixels (the generator picks a town square). */
  spawn: { x: number; y: number } | null;
  /** The entry of the "maps" cache: the map without its tiles. */
  map: MapData;
  /** The entry of the "mapProperties" cache, set by the loader. Its warps are read by movement. */
  properties: MapProperties | null;
}

const worlds = new Map<string, WorldMap>();
/** The maps folder the worlds were loaded from. */
let worldsDir = "";

/** mapName with or without ".json" */
export function getWorldMap(mapName: string): WorldMap | undefined {
  return worlds.get(mapName.replace(".json", ""));
}

function isPositiveInt(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function readBits(file: string, role: number, chunkSize: number, chunksX: number, chunksY: number, expectedHash: unknown): WorldBits {
  const bytes = new Uint8Array(fs.readFileSync(file));
  const name = path.basename(file);
  if (bytes.byteLength < BITS_HEADER_BYTES) throw new Error(`${name} is cut short`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== BITS_MAGIC) throw new Error(`${name} is not a bitset file`);
  if (view.getUint16(4, true) !== FORMAT_VERSION || view.getUint16(6, true) !== BITS_HEADER_BYTES) throw new Error(`${name} has an unknown format version`);
  if (view.getUint16(8, true) !== chunkSize || view.getUint16(10, true) !== chunksX || view.getUint16(12, true) !== chunksY) {
    throw new Error(`${name} does not match the size in manifest.json`);
  }
  if (view.getUint16(14, true) !== role) throw new Error(`${name} holds the wrong kind of data`);
  if (bytes.byteLength !== BITS_HEADER_BYTES + chunksX * chunksY * ((chunkSize * chunkSize) >>> 3)) throw new Error(`${name} has the wrong length`);
  const bodyHash = BigInt.asUintN(64, BigInt(Bun.hash.xxHash64(bytes.subarray(BITS_HEADER_BYTES))));
  if (bodyHash !== view.getBigUint64(16, true)) throw new Error(`${name} is damaged`);
  // A sync cut short can leave bitsets of one build beside the manifest of another
  if (bodyHash.toString(16).padStart(16, "0") !== expectedHash) throw new Error(`${name} belongs to another build of the world than manifest.json`);
  return new WorldBits(bytes, chunkSize, chunksX, chunksY);
}

function openWorld(dir: string, id: string): WorldMap {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf-8"));

  if (manifest?.format !== "ffworld") throw new Error("manifest.json is not a world manifest");
  if (manifest.formatVersion !== FORMAT_VERSION) throw new Error(`unsupported world format version ${manifest.formatVersion}`);

  const { width, height, tilewidth, tileheight, chunkSize } = manifest;
  if (!isPositiveInt(width) || !isPositiveInt(height) || !isPositiveInt(tilewidth) || !isPositiveInt(tileheight) || !isPositiveInt(chunkSize)) {
    throw new Error("manifest.json has no valid size");
  }
  if ((chunkSize & (chunkSize - 1)) !== 0 || chunkSize < 8 || width % chunkSize !== 0 || height % chunkSize !== 0) {
    throw new Error("the world size is not a whole number of chunks");
  }
  if (!Array.isArray(manifest.layers) || !Array.isArray(manifest.objects)) throw new Error("manifest.json has no layers or objects");

  const chunksX = width / chunkSize;
  const chunksY = height / chunkSize;
  const collision = readBits(path.join(dir, "collision.bits"), ROLE_COLLISION, chunkSize, chunksX, chunksY, manifest.bitsets?.collision?.hash);
  const nopvp = readBits(path.join(dir, "nopvp.bits"), ROLE_NOPVP, chunkSize, chunksX, chunksY, manifest.bitsets?.nopvp?.hash);

  // The layer list of a Tiled map, in the same order: tile layers without data, object layers with their objects
  const layers = manifest.layers.map((layer: any) => {
    if (layer.type === "objectgroup") {
      return {
        id: layer.id,
        name: layer.name,
        type: "objectgroup",
        visible: layer.visible !== false,
        objects: manifest.objects.filter((object: any) => object.layer === layer.name),
      };
    }
    return {
      id: layer.id,
      name: layer.name,
      type: "tilelayer",
      visible: layer.visible !== false,
      width,
      height,
      ...(layer.properties ? { properties: layer.properties } : {}),
    };
  });

  const name = `${id}.json`;
  const spawn = manifest.spawn && Number.isFinite(manifest.spawn.x) && Number.isFinite(manifest.spawn.y)
    ? { x: Number(manifest.spawn.x), y: Number(manifest.spawn.y) }
    : null;

  return {
    id,
    name,
    width,
    height,
    tileWidth: tilewidth,
    tileHeight: tileheight,
    collision,
    nopvp,
    spawn,
    map: {
      name,
      world: true,
      data: {
        width,
        height,
        tilewidth,
        tileheight,
        tilesets: manifest.tilesets || [],
        infinite: false,
        layers,
        ...(manifest.warps ? { warps: manifest.warps } : {}),
        ...(manifest.graveyards ? { graveyards: manifest.graveyards } : {}),
        // the cave systems of an underworld, as rectangles in tiles (sent to the client with the map)
        ...(Array.isArray(manifest.sections) ? { sections: manifest.sections } : {}),
      },
      compressed: Buffer.alloc(0),
    } as any,
    properties: null,
  };
}

/**
 * Reads every <id>.world directory of the maps folder. A world that cannot be read, or whose name a Tiled map
 * already has, is skipped with an error in the log; the Tiled maps are never affected.
 */
export function loadWorldMaps(mapDir: string, tiledMapNames: Set<string>): WorldMap[] {
  worldsDir = mapDir;
  worlds.clear();
  if (!fs.existsSync(mapDir)) return [];

  for (const entry of fs.readdirSync(mapDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".world")) continue;
    const id = entry.name.slice(0, -".world".length);
    if (!id) continue;
    if (tiledMapNames.has(`${id}.json`)) {
      log.error(`World ${entry.name} skipped: ${id}.json is already a map. Remove one of the two.`);
      continue;
    }
    try {
      const world = openWorld(path.join(mapDir, entry.name), id);
      worlds.set(id, world);
      log.debug(`Loaded world: ${entry.name} (${world.width} x ${world.height} tiles)`);
    } catch (error: any) {
      log.error(`World ${entry.name} skipped: ${error?.message ?? error}`);
    }
  }

  return [...worlds.values()];
}

/**
 * After an editor save on the asset server: fetches the world's changed files and puts the new collision and no-pvp
 * bits in place, without a restart. The world keeps its objects and its size (a save only changes tiles).
 */
export async function refreshWorldMap(mapName: string): Promise<void> {
  const world = getWorldMap(mapName);
  if (!world || !worldsDir) throw new Error(`${mapName} is not a loaded world`);
  await syncWorldMaps(worldsDir);
  const dir = path.join(worldsDir, `${world.id}.world`);
  const fresh = openWorld(dir, world.id);
  world.collision.adopt(fresh.collision);
  world.nopvp.adopt(fresh.nopvp);
  // a new version has clients drop the chunks they kept of the old one
  if (world.properties) world.properties.version = String(fs.statSync(path.join(dir, "manifest.json")).mtimeMs);
}

function sha256(data: Uint8Array): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function fileHash(file: string): string | null {
  try {
    return sha256(fs.readFileSync(file));
  } catch {
    return null;
  }
}

/**
 * Brings the local copy of every world the asset server has up to date: its manifest and its two bitsets, each
 * fetched only when the local file differs. Never removes a local world. Does nothing when the asset server is not
 * configured, cannot be reached or has no worlds.
 */
export async function syncWorldMaps(mapDir: string): Promise<void> {
  const assetServerUrl = process.env.ASSET_SERVER_INTERNAL_URL || process.env.ASSET_SERVER_URL;
  if (!assetServerUrl) return;

  const authKey = process.env.ASSET_SERVER_AUTH_KEY || process.env.GATEWAY_AUTH_KEY;
  const { serverFetch } = await import("./https_servers.ts");
  const post =(route: string, body: Record<string, unknown>) => serverFetch(`${assetServerUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, authKey }),
  });

  try {
    const response = await post("/world-list", { serverId: process.env.SERVER_ID || "game-server" });
    if (!response.ok) {
      // An asset server without world support answers 404 or a redirect: nothing to sync
      log.debug(`World sync skipped: the asset server answered ${response.status}`);
      return;
    }
    const result = await response.json().catch(() => null) as any;
    if (!result?.success || !Array.isArray(result.worlds)) return;

    for (const world of result.worlds) {
      const id = String(world?.id ?? "");
      if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(id) || id.includes("..")) {
        log.warn(`World sync: skipped a world with an unusable name (${JSON.stringify(world?.id)})`);
        continue;
      }
      const dir = path.join(mapDir, `${id}.world`);
      const outdated = WORLD_FILES.filter(file => fileHash(path.join(dir, file)) !== world.files?.[file]);
      if (outdated.length === 0) continue;

      log.info(`Syncing world ${id} from asset server (${outdated.join(", ")})...`);
      fs.mkdirSync(dir, { recursive: true });
      let complete = true;
      for (const file of outdated) {
        const fileResponse = await post("/world-file", { id, file });
        if (!fileResponse.ok) {
          log.error(`Failed to sync world ${id}: ${file} answered ${fileResponse.status}`);
          complete = false;
          break;
        }
        const bytes = new Uint8Array(await fileResponse.arrayBuffer());
        if (sha256(bytes) !== world.files[file]) {
          log.error(`Failed to sync world ${id}: ${file} arrived damaged`);
          complete = false;
          break;
        }
        const target = path.join(dir, file);
        fs.writeFileSync(`${target}.tmp`, bytes);
        fs.renameSync(`${target}.tmp`, target);
      }
      if (complete) log.success(`Synced world: ${id}`);
    }

    // A local world the asset server no longer lists is removed (modules/mapmirror.ts).
    for (const id of removeUnlistedWorlds(mapDir, result.worlds.map((world: any) => String(world?.id ?? "")))) {
      log.warn(`Removed world ${id}.world: the asset server no longer has it`);
    }
  } catch (error) {
    log.warn(`Failed to sync worlds from asset server: ${error}`);
  }
}
