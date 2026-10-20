/**
 * The footstep sounds the map editor sets on tiles (USER REQUEST 2026-10-19: "a separate tab that allows selecting
 * multiple tiles to share a sound (picked from asset server)").
 *
 * They are kept on the asset server, in one list for every map (its modules/tilesounds.ts: by tileset picture and tile
 * id, "" for no sound), which the game clients read from it and lay over the `footstep_sound` tile properties of their
 * map. A save comes here from the editor (SAVE_TILE_SOUNDS): checked, passed on to the asset server, and the list it
 * answers with sent to every player online (TILE_SOUNDS), so the change is heard at once without a map reload.
 */
import { serverFetch } from "../modules/https_servers.ts";

export type TileSounds = Record<string, Record<string, string>>;
export interface TileSoundChange { tileset: string; ids: number[]; sound: string | null }

/** The asset server's limits (it checks them again): changes in a save, tiles in a change, a tile id, name lengths. */
export const MAX_CHANGES = 64, MAX_IDS = 65536, MAX_TILE_ID = 1_000_000, MAX_KEY = 64, MAX_SOUND = 128;
const NAME_RE = /^[a-z0-9 ._-]+$/;

/** Who may save: the same as for saving a map (SAVE_MAP). */
export function mayEditTileSounds(perms: string[]): boolean {
  return perms.includes("server.admin") || perms.includes("server.*");
}

/**
 * A save as the editor sent it, made tidy (names in lower case and trimmed, each tile once, in order), or what is
 * wrong with it in words.
 */
export function readTileSoundChanges(raw: unknown): { changes: TileSoundChange[] } | { error: string } {
  const list = (raw as any)?.changes;
  if (!Array.isArray(list) || list.length === 0) return { error: "Nothing to save." };
  if (list.length > MAX_CHANGES) return { error: `At most ${MAX_CHANGES} changes can be saved at once.` };
  const changes: TileSoundChange[] = [];
  for (const c of list) {
    const tileset = typeof c?.tileset === "string" ? c.tileset.trim().toLowerCase() : "";
    if (!tileset || tileset.length > MAX_KEY || !NAME_RE.test(tileset)) return { error: "A change names no valid tileset." };
    if (!Array.isArray(c.ids) || c.ids.length === 0 || c.ids.length > MAX_IDS) return { error: `Pick 1 to ${MAX_IDS.toLocaleString()} tiles.` };
    if (c.ids.some((id: unknown) => !Number.isInteger(id) || (id as number) < 0 || (id as number) >= MAX_TILE_ID)) return { error: "A tile id is not valid." };
    let sound: string | null = null;
    if (c.sound !== null && c.sound !== undefined) {
      if (typeof c.sound !== "string") return { error: "The sound is not valid." };
      const name = c.sound.trim().toLowerCase();
      if (name !== "" && (name.length > MAX_SOUND || !NAME_RE.test(name))) return { error: "The sound's name is not valid." };
      sound = name;
    }
    changes.push({ tileset, ids: [...new Set<number>(c.ids)].sort((a, b) => a - b), sound });
  }
  return { changes };
}

/** Pass the changes to the asset server; returns the whole list as it is now. Throws with the reason when it refuses. */
export async function saveTileSounds(changes: TileSoundChange[]): Promise<TileSounds> {
  const assetServerUrl = process.env.ASSET_SERVER_INTERNAL_URL || process.env.ASSET_SERVER_URL || "http://localhost:8081";
  const response = await serverFetch(`${assetServerUrl}/save-tile-sounds`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ changes, authKey: process.env.ASSET_SERVER_AUTH_KEY || process.env.GATEWAY_AUTH_KEY }),
  });
  const result = await response.json().catch(() => ({ error: response.statusText })) as any;
  if (!response.ok || !result?.success) throw new Error(result?.error || `the asset server answered ${response.status}`);
  return result.tilesets && typeof result.tilesets === "object" ? result.tilesets : {};
}
