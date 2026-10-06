import fs from "fs";
import path from "path";

// The maps folder is a copy of the asset server's. The startup sync
// (modules/assetloader.ts, modules/worldmaps.ts) only ever adds or replaces,
// so a map the asset server has dropped would otherwise stay here and keep
// being loaded: a leftover <id>.json even hides the world of the same name.
// These remove what the asset server no longer lists. They are only called
// after it has answered with its full list.

/**
 * Removes the Tiled map files (`<name>.json`) of `mapDir` that are not in `listed`, and answers their names.
 * An empty `listed` removes nothing: the game server cannot start without a map, so an asset server that lists
 * none is taken for one pointed at the wrong folder.
 */
export function removeUnlistedMaps(mapDir: string, listed: Iterable<string>): string[] {
  const keep = new Set(listed);
  if (keep.size === 0 || !fs.existsSync(mapDir)) return [];

  const removed: string[] = [];
  for (const entry of fs.readdirSync(mapDir, { withFileTypes: true })) {
    // Dot files are the folder's own (.map-checksums-cache.json), not maps.
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.startsWith(".")) continue;
    if (keep.has(entry.name)) continue;
    fs.rmSync(path.join(mapDir, entry.name), { force: true });
    removed.push(entry.name);
  }
  return removed;
}

/**
 * Removes the world directories (`<id>.world`) of `mapDir` whose id is not in `listedIds`, and answers their ids.
 */
export function removeUnlistedWorlds(mapDir: string, listedIds: Iterable<string>): string[] {
  if (!fs.existsSync(mapDir)) return [];
  const keep = new Set(listedIds);

  const removed: string[] = [];
  for (const entry of fs.readdirSync(mapDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".world")) continue;
    const id = entry.name.slice(0, -".world".length);
    if (!id || keep.has(id)) continue;
    fs.rmSync(path.join(mapDir, entry.name), { recursive: true, force: true });
    removed.push(id);
  }
  return removed;
}
