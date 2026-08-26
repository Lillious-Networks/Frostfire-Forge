// Cross-server player replication (mesh Phase 1).
//
// Authority model (v1): every server simulates the players connected to it and
// replicates their state outward; every server renders remote players as
// "ghosts". Ghosts are never simulated locally - positions come from the
// authority's MOVER_BATCH datagrams, spawn/despawn from SPAWN/DESPAWN.
//
// Direction of dependencies: this module imports only leaf modules (services,
// mesh transport, movement batch types). The socket layer (receiver/aoi/server)
// wires it via attachMeshLinks/attachHooks, so there are no import cycles.

import { MeshMessageType, decodeMoverBatch, encodeMoverBatch, encodeInputForward, decodeInputForward, DIRECTION_NAMES } from "./protocol.ts";
import { MeshLinks } from "./links.ts";
import { DIRECTION_MAP } from "../socket/movement_batch.ts";
import type { MoverSnapshot } from "../socket/movement_batch.ts";
import { sendToPlayer } from "./delivery.ts";
import { packetManager } from "../socket/packet_manager.ts";
import playerCache from "../services/playermanager.ts";
import spatialGrid from "../services/spatialgrid.ts";
import log from "../modules/logger.ts";

export interface GhostPlayer {
  id: string;
  username: string;
  map: string;
  position: { x: number; y: number; direction: string };
  isStealth: boolean;
  isVanished: boolean;
  party: string[];
  spawnData: any;
  authorityServerId: string;
  lastUpdateAt: number;
  lastAoiCheckPos: { x: number; y: number };
}

export interface ReplicationHooks {
  updatePlayerAOI: (player: any) => Promise<void>;
  queueDespawn: (receiverId: string, entityId: string) => void;
  ensureMovementGroup: (mapName: string) => void;
  queueLocalMover: (playerId: string, movementData: any) => void;
  handleRemoteInput: (playerId: string, directionIndex: number) => void;
  handleRemotePacket: (playerId: string, packetJson: string) => void;
  handleHandoffRequest: (serverId: string, payload: Uint8Array) => void;
  handleHandoffAccept: (payload: Uint8Array) => void;
  handleHandoffComplete: (payload: Uint8Array) => void;
  handleHandoffAbort: (payload: Uint8Array) => void;
  handleAuthorityDespawn: (serverId: string, playerId: string) => void;
  handleAuthorityDown: (serverId: string) => void;
}

const GHOST_AOI_MOVE_THRESHOLD = 80;

const ghostCache = new Map<string, GhostPlayer>();
const ghostsByMap = new Map<string, Set<string>>();
const aoiRefreshSet = new Set<string>();
const peerConnectionCounts = new Map<string, number>();

let meshLinks: MeshLinks | null = null;
let hooks: ReplicationHooks = {
  updatePlayerAOI: async () => {},
  queueDespawn: () => {},
  ensureMovementGroup: () => {},
  queueLocalMover: () => {},
  handleRemoteInput: () => {},
  handleRemotePacket: () => {},
  handleHandoffRequest: () => {},
  handleHandoffAccept: () => {},
  handleHandoffComplete: () => {},
  handleHandoffAbort: () => {},
  handleAuthorityDespawn: () => {},
  handleAuthorityDown: () => {},
};

export function attachMeshLinks(links: MeshLinks | null): void {
  meshLinks = links;
}

export function attachHooks(partial: Partial<ReplicationHooks>): void {
  hooks = { ...hooks, ...partial };
}

export function isMeshEnabled(): boolean {
  return meshLinks !== null && meshLinks.enabled;
}

export function getGhost(playerId: string): GhostPlayer | undefined {
  return ghostCache.get(playerId);
}

export function getGhostsOnMap(mapName: string): GhostPlayer[] {
  const ids = ghostsByMap.get(mapName);
  if (!ids) return [];
  const ghosts: GhostPlayer[] = [];
  for (const id of ids) {
    const ghost = ghostCache.get(id);
    if (ghost) ghosts.push(ghost);
  }
  return ghosts;
}

export function getGhostMaps(): string[] {
  return Array.from(ghostsByMap.keys());
}

export function hasGhostsOnMap(mapName: string): boolean {
  const ids = ghostsByMap.get(mapName);
  return !!ids && ids.size > 0;
}

export function getGhostCount(): number {
  return ghostCache.size;
}

// ---------------------------------------------------------------------------
// Publishing (authority side)

export function publishPlayerSpawn(player: any, spawnData: any): void {
  if (!meshLinks || !player) return;
  const mapName = normalizeMap(player.location?.map || spawnData?.location?.map);
  const payload = {
    id: player.id,
    map: mapName,
    spawnData,
  };
  meshLinks.broadcast(MeshMessageType.SPAWN, new TextEncoder().encode(JSON.stringify(payload)), true);
}

export function publishPlayerDespawn(playerId: string, map: string): void {
  if (!meshLinks || !playerId) return;
  const payload = { id: playerId, map: normalizeMap(map) };
  meshLinks.broadcast(MeshMessageType.DESPAWN, new TextEncoder().encode(JSON.stringify(payload)), true);
}

export function publishMoverBatch(mapName: string, movers: MoverSnapshot[]): void {
  if (!meshLinks || movers.length === 0) return;
  const entries = [];
  for (const mover of movers) {
    const id = parseInt(mover.id, 10);
    if (!Number.isInteger(id) || id < 0) continue;
    entries.push({
      id,
      x: Math.round(mover.x),
      y: Math.round(mover.y),
      direction: DIRECTION_MAP[mover.direction] ?? 1,
      stealth: mover.stealth ? 1 : 0,
    });
  }
  if (entries.length === 0) return;

  // Keep each mesh datagram well under the fragmentation threshold: IP
  // fragmentation on Docker Desktop's UDP relay drops whole datagrams when a
  // single fragment is lost, which reads as movement desync.
  const MAX_ENTRIES_PER_DATAGRAM = 100;
  for (let i = 0; i < entries.length; i += MAX_ENTRIES_PER_DATAGRAM) {
    const chunk = entries.slice(i, i + MAX_ENTRIES_PER_DATAGRAM);
    meshLinks.broadcast(MeshMessageType.MOVER_BATCH, encodeMoverBatch(normalizeMap(mapName), chunk), false);
  }
}

/**
 * Reliable animation update for a player whose viewers live on other servers
 * (ghost rendering). Presence servers relay it to everyone with the player in
 * their AOI set.
 */
export function publishPlayerAnimation(player: any, animationData: any): void {
  if (!meshLinks || !player) return;
  const payload = JSON.stringify({
    kind: "player_animation",
    playerId: player.id,
    animationData,
  });
  meshLinks.broadcast(MeshMessageType.STATE_EVENT, new TextEncoder().encode(payload), true);
}

// ---------------------------------------------------------------------------
// Ghost movers for the local flush pipeline

export function getGhostMovers(mapName: string, interestedIds: Set<string>): MoverSnapshot[] {
  const ids = ghostsByMap.get(mapName);
  if (!ids) return [];
  const movers: MoverSnapshot[] = [];
  for (const id of ids) {
    if (!interestedIds.has(id)) continue;
    const ghost = ghostCache.get(id);
    if (!ghost) continue;
    movers.push({
      id: ghost.id,
      x: ghost.position.x,
      y: ghost.position.y,
      direction: ghost.position.direction,
      stealth: ghost.isStealth,
      vanished: ghost.isVanished,
      party: ghost.party,
    });
  }
  return movers;
}

// ---------------------------------------------------------------------------
// Handling (presence side)

export function handleMeshMessage(serverId: string, type: MeshMessageType, payload: Uint8Array): void {
  switch (type) {
    case MeshMessageType.SPAWN:
      handleSpawn(serverId, payload);
      break;
    case MeshMessageType.DESPAWN:
      handleDespawn(serverId, payload);
      break;
    case MeshMessageType.MOVER_BATCH:
      handleMoverBatch(serverId, payload);
      break;
    case MeshMessageType.OUTPUT_FORWARD:
      handleOutputForward(payload);
      break;
    case MeshMessageType.INPUT_FORWARD:
      handleInputForward(payload);
      break;
    case MeshMessageType.INPUT_PACKET:
      handleInputPacket(payload);
      break;
    case MeshMessageType.HANDOFF_REQUEST:
      hooks.handleHandoffRequest(serverId, payload);
      break;
    case MeshMessageType.HANDOFF_ACCEPT:
      hooks.handleHandoffAccept(payload);
      break;
    case MeshMessageType.HANDOFF_COMPLETE:
      hooks.handleHandoffComplete(payload);
      break;
    case MeshMessageType.HANDOFF_ABORT:
      hooks.handleHandoffAbort(payload);
      break;
    case MeshMessageType.CONNECTION_COUNT:
      handleConnectionCount(serverId, payload);
      break;
    case MeshMessageType.STATE_EVENT:
      handleStateEvent(payload);
      break;
    default:
      break;
  }
}

function handleStateEvent(payload: Uint8Array): void {
  let message: any;
  try {
    message = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return;
  }

  if (message?.kind === "player_animation" && typeof message.playerId === "string" && message.animationData) {
    const packets = packetManager.spriteSheetAnimation(message.animationData);
    const allPlayers = Object.values(playerCache.list());
    for (const player of allPlayers) {
      if (!player.aoi) continue;
      const isSelf = player.id === message.playerId && player.remoteSim;
      if (!isSelf && !player.aoi.playersInAOI.has(message.playerId)) continue;
      sendToPlayer(player, packets);
    }
  }
}

function handleConnectionCount(serverId: string, payload: Uint8Array): void {
  let message: any;
  try {
    message = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return;
  }
  if (!message || typeof message.count !== "number") return;
  peerConnectionCounts.set(serverId, message.count);
  log.debug(`[Mesh] Connection count from ${serverId}: ${message.count} (peers: ${peerConnectionCounts.size})`);
}

/** Combined online count: local connections + every mesh peer's connections. */
export function getPeerConnectionCount(): number {
  let total = 0;
  for (const count of peerConnectionCounts.values()) {
    total += count;
  }
  return total;
}

export function getPeerCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [serverId, count] of peerConnectionCounts) {
    counts[serverId] = count;
  }
  return counts;
}

function handleSpawn(serverId: string, payload: Uint8Array): void {
  let message: any;
  try {
    message = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return;
  }
  if (!message || typeof message.id !== "string" || !message.spawnData) return;

  const id = message.id;
  const map = normalizeMap(message.map || message.spawnData?.location?.map);
  if (!map) return;

  // A local player with remote simulation: the SPAWN is the authority
  // re-announcing itself (or the ownership changing) - update routing, not
  // the ghost cache.
  const localPlayer = playerCache.get(id);
  if (localPlayer) {
    if (localPlayer.remoteSim) {
      localPlayer.remoteAuthority = serverId;
      const location = message.spawnData?.location || {};
      if (typeof location.x === "number") localPlayer.location.position.x = Math.round(Number(location.x));
      if (typeof location.y === "number") localPlayer.location.position.y = Math.round(Number(location.y));
    }
    return;
  }

  const spawnData = message.spawnData;
  const location = spawnData.location || {};
  const ghost: GhostPlayer = {
    id,
    username: spawnData.username || "",
    map,
    position: {
      x: Math.round(Number(location.x) || 0),
      y: Math.round(Number(location.y) || 0),
      direction: location.direction || "down",
    },
    isStealth: !!spawnData.isStealth,
    isVanished: !!spawnData.isVanished,
    party: Array.isArray(spawnData.party) ? spawnData.party : [],
    spawnData,
    authorityServerId: serverId,
    lastUpdateAt: Date.now(),
    lastAoiCheckPos: { x: Math.round(Number(location.x) || 0), y: Math.round(Number(location.y) || 0) },
  };

  const existing = ghostCache.get(id);
  const previousMap = existing?.map;
  ghostCache.set(id, ghost);
  indexGhost(ghost);

  if (existing && previousMap !== map) {
    // Map change: remove the ghost from AOI sets on its old map first.
    removeGhostFromLocalAOI(existing);
    unindexGhost(existing);
  }

  log.debug(`[Mesh] Ghost ${ghost.username} (${id}) on ${map} from ${serverId} (total ghosts: ${ghostCache.size})`);

  markLocalPlayersForAOIRefresh(map);
}

function handleDespawn(serverId: string, payload: Uint8Array): void {
  let message: any;
  try {
    message = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return;
  }
  if (!message || typeof message.id !== "string") return;
  const ghost = ghostCache.get(message.id);
  removeGhostFromLocalAOI(ghost);
  if (ghost) unindexGhost(ghost);
  ghostCache.delete(message.id);

  // Avatar cleanup on the authority (presence disconnected) or resume on a
  // presence whose authority explicitly dropped the avatar.
  hooks.handleAuthorityDespawn(serverId, message.id);
}

function handleMoverBatch(serverId: string, payload: Uint8Array): void {
  const decoded = decodeMoverBatch(payload);
  if (!decoded) return;

  const now = Date.now();
  let anyMoved = false;
  let anyUpdated = false;
  const movedPositions: Array<{ x: number; y: number }> = [];

  for (const entry of decoded.movers) {
    const id = String(entry.id);

    // A local player whose avatar is simulated by a peer: feed the authority's
    // position back into the local movement pipeline (self-echo + viewer
    // batches) instead of the ghost cache.
    const localPlayer = playerCache.get(id);
    if (localPlayer?.remoteSim) {
      localPlayer.remoteAuthority = serverId;

      const prevX = localPlayer.location.position.x;
      const prevY = localPlayer.location.position.y;
      const dx = entry.x - prevX;
      const dy = entry.y - prevY;

      localPlayer.location.position.x = entry.x;
      localPlayer.location.position.y = entry.y;
      localPlayer.location.position.direction = DIRECTION_NAMES[entry.direction] ?? "down";
      localPlayer.moving = true;

      if (spatialGrid.hasPlayer(id)) {
        spatialGrid.updatePlayer(id, entry.x, entry.y, decoded.mapName);
      }

      hooks.queueLocalMover(id, {
        i: id,
        d: { x: entry.x, y: entry.y, dr: localPlayer.location.position.direction },
        r: 0,
        s: entry.stealth !== 0 ? 1 : 0,
      });
      anyUpdated = true;

      // The client's own-avatar renderer is driven by the per-tick 0x02 echo
      // it normally receives; batch entries alone make self movement jittery.
      sendToPlayer(
        localPlayer,
        packetManager.moveXY({
          i: id,
          d: { x: entry.x, y: entry.y, dr: localPlayer.location.position.direction },
          r: 0,
          s: entry.stealth !== 0 ? 1 : 0,
        })
      );

      // The avatar itself needs AOI refreshes too (its interest set froze when
      // simulation left this server).
      if (dx * dx + dy * dy > GHOST_AOI_MOVE_THRESHOLD * GHOST_AOI_MOVE_THRESHOLD) {
        movedPositions.push({ x: entry.x, y: entry.y });
        anyMoved = true;
      }
      continue;
    }

    const ghost = ghostCache.get(id);
    if (!ghost) continue;
    if (ghost.map !== decoded.mapName) continue;

    ghost.position.x = entry.x;
    ghost.position.y = entry.y;
    ghost.position.direction = DIRECTION_NAMES[entry.direction] ?? "down";
    ghost.isStealth = entry.stealth !== 0;
    ghost.lastUpdateAt = now;
    anyUpdated = true;

    const dx = ghost.position.x - ghost.lastAoiCheckPos.x;
    const dy = ghost.position.y - ghost.lastAoiCheckPos.y;
    if (dx * dx + dy * dy > GHOST_AOI_MOVE_THRESHOLD * GHOST_AOI_MOVE_THRESHOLD) {
      ghost.lastAoiCheckPos = { x: ghost.position.x, y: ghost.position.y };
      movedPositions.push({ x: ghost.position.x, y: ghost.position.y });
      anyMoved = true;
    }
  }

  if (anyUpdated) {
    // Keep a movement group alive for this map so the flush loop delivers the
    // forwarded positions even when no local player is moving.
    hooks.ensureMovementGroup(decoded.mapName);
  }
  if (anyMoved) {
    markPlayersNearMovedGhosts(decoded.mapName, movedPositions);
  }
}

function handleInputForward(payload: Uint8Array): void {
  const decoded = decodeInputForward(payload);
  if (!decoded) return;
  hooks.handleRemoteInput(decoded.playerId, decoded.directionIndex);
}

function handleInputPacket(payload: Uint8Array): void {
  let message: any;
  try {
    message = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return;
  }
  if (!message || typeof message.playerId !== "string" || typeof message.packet !== "string") return;
  hooks.handleRemotePacket(message.playerId, message.packet);
}

function handleOutputForward(payload: Uint8Array): void {
  let message: any;
  try {
    message = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return;
  }
  if (!message || typeof message.playerId !== "string" || !Array.isArray(message.packets)) return;

  const player = playerCache.get(message.playerId);
  if (!player || !player.ws) return;

  for (const encoded of message.packets) {
    if (typeof encoded !== "string") continue;
    try {
      const binary = atob(encoded);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      sendToPlayer(player, bytes);
    } catch {
      // malformed payload - drop
    }
  }
}

// ---------------------------------------------------------------------------
// Presence -> authority input routing (used by receiver for remoteSim players)

export function forwardMoveInput(player: any, directionIndex: number): void {
  if (!meshLinks || !player?.remoteAuthority) return;
  meshLinks.sendToServer(
    player.remoteAuthority,
    MeshMessageType.INPUT_FORWARD,
    encodeInputForward(player.id, directionIndex),
    false
  );
}

export function forwardPacketInput(player: any, packetJson: string): void {
  if (!meshLinks || !player?.remoteAuthority) return;
  const payload = JSON.stringify({ playerId: player.id, packet: packetJson });
  meshLinks.sendToServer(
    player.remoteAuthority,
    MeshMessageType.INPUT_PACKET,
    new TextEncoder().encode(payload),
    true
  );
}

export function removeGhostsFromServer(serverId: string): void {
  const removed: GhostPlayer[] = [];
  for (const ghost of ghostCache.values()) {
    if (ghost.authorityServerId === serverId) removed.push(ghost);
  }
  for (const ghost of removed) {
    removeGhostFromLocalAOI(ghost);
    unindexGhost(ghost);
    ghostCache.delete(ghost.id);
  }
  if (removed.length > 0) {
    log.warn(`[Mesh] Removed ${removed.length} ghost(s) after ${serverId} went down`);
  }

  peerConnectionCounts.delete(serverId);

  // Players whose avatars were simulated by the dead server resume locally.
  hooks.handleAuthorityDown(serverId);
}

export function flushAoIRefreshQueue(): void {
  if (aoiRefreshSet.size === 0) return;
  const pending = Array.from(aoiRefreshSet);
  aoiRefreshSet.clear();

  const minIntervalMs = getAoiRefreshMinIntervalMs();
  const now = Date.now();

  for (const playerId of pending) {
    const player = playerCache.get(playerId);
    if (!player || !player.aoi || !player.ws) continue;

    // AOI recomputation is the most expensive per-player operation in the mesh
    // path (grid query + set diffs + spawn/despawn queueing). Under a moving
    // ghost crowd every player would be marked on every mover batch, so cap
    // the rate per player - ghost entries/leaves are picked up within one
    // interval instead of instantly.
    const lastRefresh = player._lastMeshAoiRefresh || 0;
    if (now - lastRefresh < minIntervalMs) continue;
    player._lastMeshAoiRefresh = now;

    hooks.updatePlayerAOI(player).catch(() => {});
  }
}

function getAoiRefreshMinIntervalMs(): number {
  const value = parseInt(process.env.MESH_AOI_REFRESH_MIN_MS || "500", 10);
  return Number.isInteger(value) && value >= 0 ? value : 500;
}

// ---------------------------------------------------------------------------
// Internals

function markLocalPlayersForAOIRefresh(mapName: string): void {
  const allPlayers = Object.values(playerCache.list());
  for (const player of allPlayers) {
    if (!player.aoi || !player.ws) continue;
    if (normalizeMap(player.location?.map) !== mapName) continue;
    aoiRefreshSet.add(player.id);
  }
}

/**
 * Targeted refresh marking: only players whose AOI (with hysteresis margin)
 * could actually contain one of the moved positions get refreshed. Marking the
 * whole map per mover batch made every player recompute AOI 4x/sec under
 * random-walk benchmark load.
 */
function markPlayersNearMovedGhosts(mapName: string, movedPositions: Array<{ x: number; y: number }>): void {
  if (movedPositions.length === 0) return;

  const allPlayers = Object.values(playerCache.list());
  for (const player of allPlayers) {
    if (!player.aoi || !player.ws) continue;
    if (normalizeMap(player.location?.map) !== mapName) continue;

    const reach = ((player.aoi.aoiRadius || 1000) * 1.25 + 160);
    const reachSquared = reach * reach;
    const px = player.location?.position?.x ?? 0;
    const py = player.location?.position?.y ?? 0;

    for (const pos of movedPositions) {
      const dx = pos.x - px;
      const dy = pos.y - py;
      if (dx * dx + dy * dy <= reachSquared) {
        aoiRefreshSet.add(player.id);
        break;
      }
    }
  }
}

function removeGhostFromLocalAOI(ghost: GhostPlayer | undefined): void {
  if (!ghost) return;
  const allPlayers = Object.values(playerCache.list());
  for (const player of allPlayers) {
    if (!player.aoi || !player.aoi.playersInAOI.has(ghost.id)) continue;
    player.aoi.playersInAOI.delete(ghost.id);
    player.aoi.revision = (player.aoi.revision || 0) + 1;
    hooks.queueDespawn(player.id, ghost.id);
  }
}

function indexGhost(ghost: GhostPlayer): void {
  let ids = ghostsByMap.get(ghost.map);
  if (!ids) {
    ids = new Set();
    ghostsByMap.set(ghost.map, ids);
  }
  ids.add(ghost.id);
}

function unindexGhost(ghost: GhostPlayer): void {
  const ids = ghostsByMap.get(ghost.map);
  if (!ids) return;
  ids.delete(ghost.id);
  if (ids.size === 0) {
    ghostsByMap.delete(ghost.map);
  }
}

function normalizeMap(map: string | null | undefined): string {
  return (map || "").replaceAll(".json", "");
}

export function clearGhosts(): void {
  ghostCache.clear();
  ghostsByMap.clear();
  aoiRefreshSet.clear();
}
