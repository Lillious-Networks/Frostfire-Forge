/**
 * New, blank maps made from the map editor (USER REQUEST 2026-10-19: "Add support for creating new maps within the
 * editor. Allow defining map size, infinite or not and optionally allow creating .world maps. Each map should be blank
 * and upon creation, warp to them.").
 *
 * The editor asks (CREATE_MAP); this checks the request, has the asset server make the map (its modules/mapcreate.ts:
 * a Tiled map file, or a .world directory with every chunk empty), takes it in without a restart
 * (modules/assetloader.ts addCreatedMap) and the receiver warps the admin onto it.
 */
import { serverFetch } from "../modules/https_servers.ts";

export type MapKind = "map" | "world";
export interface CreateMapRequest { name: string; kind: MapKind; width: number; height: number; infinite: boolean; tilesets: string[] }

/** The asset server's rules (it checks them again): the name, a map's size, a world's (whole 64-tile chunks), the tilesets. */
export const MAP_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
export const MAP_MIN = 16, MAP_MAX = 1024, WORLD_CHUNK = 64, WORLD_MIN = 64, WORLD_MAX = 16384, MAX_TILESETS = 16;
const TILESET_RE = /^[A-Za-z0-9 ._-]+\.(png|jpe?g|webp)$/i;

/** Who may make maps: the same as for saving one (SAVE_MAP). */
export function mayCreateMaps(perms: string[]): boolean {
  return perms.includes("server.admin") || perms.includes("server.*");
}

/** The request as the editor sent it, made tidy, or what is wrong with it in words. */
export function readCreateMap(raw: unknown): { request: CreateMapRequest } | { error: string } {
  const r = raw as any;
  const name = typeof r?.name === "string" ? r.name.trim().toLowerCase() : "";
  if (!MAP_NAME_RE.test(name)) return { error: "The name may hold lower case letters, digits, - and _ only, up to 48, starting with a letter or digit." };
  const kind: MapKind | null = r?.kind === "world" ? "world" : r?.kind === "map" ? "map" : null;
  if (!kind) return { error: "Make a map or a world." };
  const width = Number(r?.width), height = Number(r?.height);
  if (kind === "map" && ![width, height].every(n => Number.isInteger(n) && n >= MAP_MIN && n <= MAP_MAX)) return { error: `A map is ${MAP_MIN} to ${MAP_MAX} tiles each way.` };
  if (kind === "world" && ![width, height].every(n => Number.isInteger(n) && n >= WORLD_MIN && n <= WORLD_MAX && n % WORLD_CHUNK === 0)) return { error: `A world is ${WORLD_MIN} to ${WORLD_MAX.toLocaleString()} tiles each way, in steps of ${WORLD_CHUNK}.` };
  const infinite = r?.infinite === true;
  if (kind === "world" && infinite) return { error: "A world has a fixed size: it cannot be infinite." };
  const tilesets = Array.isArray(r?.tilesets) ? [...new Set<string>(r.tilesets.filter((t: unknown) => typeof t === "string"))] : [];
  if (tilesets.length === 0 || tilesets.length > MAX_TILESETS) return { error: `Pick 1 to ${MAX_TILESETS} tilesets.` };
  if (tilesets.some(t => !TILESET_RE.test(t))) return { error: "A tileset's name is not valid." };
  return { request: { name, kind, width, height, infinite, tilesets } };
}

/** Have the asset server make the map. A Tiled map comes back with its data. Throws with the reason when it refuses. */
export async function requestCreateMap(request: CreateMapRequest): Promise<{ kind: MapKind; data?: any }> {
  const assetServerUrl = process.env.ASSET_SERVER_INTERNAL_URL || process.env.ASSET_SERVER_URL || "http://localhost:8081";
  const response = await serverFetch(`${assetServerUrl}/create-map`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...request, authKey: process.env.ASSET_SERVER_AUTH_KEY || process.env.GATEWAY_AUTH_KEY }),
  });
  const result = await response.json().catch(() => ({ error: response.statusText })) as any;
  if (!response.ok || !result?.success) throw new Error(result?.error || `the asset server answered ${response.status}`);
  return { kind: result.kind === "world" ? "world" : "map", ...(result.data ? { data: result.data } : {}) };
}
