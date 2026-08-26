// Mesh configuration: env-driven, no dependency on generated config files so
// the mesh can be toggled per process without `bun create-config` runs.

import type { MeshLinksOptions, MeshPeerDescriptor } from "./links.ts";
import { MESH_PLAYER_ID_ENTITIES_MAX, MESH_PLAYER_ID_OFFSET } from "./protocol.ts";

export function getMeshServerIndex(env: Record<string, string | undefined> = process.env): number {
  const raw = env.MESH_SERVER_INDEX;
  if (!raw) return 0;
  const value = parseInt(raw, 10);
  return Number.isInteger(value) && value >= 1 && value <= 254 ? value : 0;
}

export function parseMeshPeers(raw: string | undefined): MeshPeerDescriptor[] {
  if (!raw) return [];
  const peers: MeshPeerDescriptor[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const serverId = trimmed.slice(0, eq).trim();
    const address = trimmed.slice(eq + 1).trim();
    const colon = address.lastIndexOf(":");
    if (colon <= 0) continue;
    const host = address.slice(0, colon);
    const port = parseInt(address.slice(colon + 1), 10);
    if (!serverId || !host || !Number.isInteger(port) || port <= 0 || port > 65535) continue;
    peers.push({ serverId, host, port });
  }
  return peers;
}

export function loadMeshConfig(env: Record<string, string | undefined> = process.env): MeshLinksOptions {
  const enabled = env.MESH_ENABLED === "true";
  const cluster = env.MESH_CLUSTER ?? "";
  const secret = env.MESH_SECRET || env.GATEWAY_GAME_SERVER_SECRET || "";
  const localServerId = env.SERVER_ID || "default";

  return {
    enabled,
    bindHost: env.MESH_HOST || "0.0.0.0",
    port: parseInt(env.MESH_PORT || "3001", 10),
    cluster,
    secret,
    localServerId,
    serverIndex: getMeshServerIndex(env),
  };
}

export function loadMeshStaticPeers(env: Record<string, string | undefined> = process.env): MeshPeerDescriptor[] {
  return parseMeshPeers(env.MESH_PEERS);
}

export function meshAdvertiseHost(env: Record<string, string | undefined> = process.env): string {
  return env.MESH_ADVERTISE_HOST || env.SERVER_HOST || env.PUBLIC_HOST || "localhost";
}

export function getMeshCellSize(env: Record<string, string | undefined> = process.env): number {
  const value = parseInt(env.MESH_CELL_SIZE || "1024", 10);
  return Number.isInteger(value) && value > 0 ? value : 1024;
}

export function getMeshRegionCells(env: Record<string, string | undefined> = process.env): number {
  const value = parseInt(env.MESH_REGION_CELLS || "1", 10);
  return Number.isInteger(value) && value > 0 ? value : 1;
}

/**
 * AOI exit radius multiplier (hysteresis): players enter at the AOI radius
 * and only leave at radius * multiplier, so entities wandering along the
 * boundary don't flap spawn/despawn every tick. Standard MMO interest
 * management; 1.0 disables it.
 */
export function getAoiExitRadiusMultiplier(env: Record<string, string | undefined> = process.env): number {
  const value = parseFloat(env.AOI_EXIT_RADIUS_MULTIPLIER || "1.25");
  return Number.isFinite(value) && value >= 1 ? value : 1.25;
}

/**
 * Mesh session ids occupy [(0x80+serverIndex)<<24, ...), so raw entity DB ids
 * must stay below that band. Verify at startup; warn (not abort) so a partial
 * schema can't take the whole server down.
 */
export async function assertEntityIdSpace(
  queryFn: (sql: string, params?: unknown[]) => Promise<unknown[]>
): Promise<void> {
  const serverIndex = getMeshServerIndex();
  if (serverIndex <= 0) return;

  const base = (MESH_PLAYER_ID_OFFSET + serverIndex) * 0x1000000;
  try {
    const rows = (await queryFn("SELECT MAX(id) as maxId FROM entities")) as Array<{ maxId?: number | string | null }>;
    const maxId = Number(rows?.[0]?.maxId ?? 0);
    if (maxId >= MESH_PLAYER_ID_ENTITIES_MAX) {
      throw new Error(
        `entity ids reach ${maxId}, colliding with the mesh player id band starting at ${base}`
      );
    }
  } catch (error: any) {
    console.warn(`[Mesh] Entity id space check failed (${error?.message || error}). ` +
      `Entity DB ids must stay below ${MESH_PLAYER_ID_ENTITIES_MAX} while MESH_SERVER_INDEX is set.`);
  }
}
