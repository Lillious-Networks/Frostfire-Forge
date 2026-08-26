// Deterministic region ownership (Phase 2.2).
//
// Until the gateway's region table exists, region ownership is computed
// statically: the map is tiled into MESH_CELL_SIZE-pixel cells grouped into
// MESH_REGION_CELLS x MESH_REGION_CELLS regions, and each region is assigned to
// a roster member by hashing the region key. All servers agree because the
// roster (server index -> server id) is learned through the HELLO handshake.
//
// Handoffs only run when the roster is complete (every configured peer has
// reported its index), so a partially connected cluster degrades to
// "everyone simulates locally" instead of double-simulating.

import { fnv1a32 } from "./protocol.ts";
import { getMeshCellSize, getMeshRegionCells } from "./config.ts";

export interface RosterMember {
  serverId: string;
  index: number;
}

const peerIndexes = new Map<string, number>();
let selfServerId = "";
let selfIndex = 0;

export function initRegions(serverId: string, index: number): void {
  selfServerId = serverId;
  selfIndex = index;
}

export function learnPeerIndex(serverId: string, index: number): void {
  if (index > 0) peerIndexes.set(serverId, index);
}

export function forgetPeerIndex(serverId: string): void {
  peerIndexes.delete(serverId);
}

export function getRoster(): RosterMember[] {
  const roster: RosterMember[] = [];
  if (selfServerId) roster.push({ serverId: selfServerId, index: selfIndex });
  for (const [serverId, index] of peerIndexes) {
    roster.push({ serverId, index });
  }
  roster.sort((a, b) => a.index - b.index);
  return roster;
}

/**
 * True when every member of the desired peer set has reported its index.
 * Provide desiredServerIds from MeshLinks.getDesiredServerIds().
 */
export function isRosterComplete(desiredServerIds: string[]): boolean {
  if (selfIndex <= 0) return false;
  for (const serverId of desiredServerIds) {
    if (!peerIndexes.has(serverId)) return false;
  }
  return true;
}

export function regionSize(): number {
  return getMeshCellSize() * getMeshRegionCells();
}

export function regionOf(map: string, x: number, y: number): { map: string; regionX: number; regionY: number } {
  const size = regionSize();
  return {
    map: (map || "").replaceAll(".json", ""),
    regionX: Math.floor(x / size),
    regionY: Math.floor(y / size),
  };
}

export function regionKey(map: string, regionX: number, regionY: number): string {
  return `${map.replaceAll(".json", "")}:${regionX}:${regionY}`;
}

/**
 * The server that owns the region containing (x, y). Returns null when the
 * region is locally owned, undefined when ownership cannot be decided
 * (roster incomplete), or a serverId string for a remote owner.
 */
export function getRegionOwner(map: string, x: number, y: number, desiredServerIds: string[]): string | null | undefined {
  if (!isRosterComplete(desiredServerIds)) return undefined;
  const roster = getRoster();
  if (roster.length <= 1) return null;

  const { regionX, regionY } = regionOf(map, x, y);
  const hash = fnv1a32(regionKey(map, regionX, regionY));
  const owner = roster[hash % roster.length];
  return owner.serverId === selfServerId ? null : owner.serverId;
}

export function isRemoteRegion(owner: string | null | undefined): owner is string {
  return typeof owner === "string";
}
