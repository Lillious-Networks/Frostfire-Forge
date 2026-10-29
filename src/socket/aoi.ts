import AOI_CONFIG from "../config/aoi.json";
import log from "../modules/logger";
import { notePoseViewer, notePoseRelay, notePoseDatagram } from "./posestats";
import { nextPoseRevision, poseRepeats } from "./posedgram";
import { encodePoseRecord } from "./pose_codec";
import playerCache from "../services/playermanager";
import layerManager, { blockOf, isBaseLayer, MAX_PLAYERS_PER_LAYER } from "../services/layermanager";
import { getEffectsPayload, mirrorEffectsPayload } from "../systems/spelleffects";
import mapIndex from "../services/mapindex";
import parties from "../systems/parties";
import { packetManager } from "./packet_manager";
import spatialGrid from "../services/spatialgrid";
import * as aoiReverse from "../services/aoiReverseIndex";
import { ghosts } from "../cluster/ghosts";
import { entityById, playerLayer } from "../cluster/mirrors";
import { isRecentAttacker } from "../cluster/attackers";
import { forgetLook, holdsLook, noteLook } from "./looks";

// A player is only removed from an AOI once they are this many times the AOI
// radius away - not the instant they cross it. Prevents despawn/respawn packet
// churn for players lingering near the boundary. Enter still uses the plain
// radius, so the band between 1.0x and this value is "sticky, don't re-add".
const AOI_EXIT_HYSTERESIS = (AOI_CONFIG as any).EXIT_HYSTERESIS ?? 1.25;

// Most players one viewer is sent. On a crowded spot the nearest ones win,
// after party members and the selected target. Read per call (not cached at
// load) so the tests can lower it through their aoi.json stand-in.
function maxVisiblePlayers(): number {
  return (AOI_CONFIG as any).MAX_VISIBLE_PLAYERS ?? 150;
}

// Grid cells follow every movement tick (the receiver's movement callback) and
// every AOI update, so a player is at most one tick's travel from the cell they
// are filed under. The radius query keeps this pad as a margin for that and
// for moves made outside the movement tick; the exact distance check uses
// live positions.
const GRID_LAG_PAD_PX = Math.max(128, (Number(AOI_CONFIG.UPDATE_THRESHOLD) || 100) + 32);

// Widest AOI radius any viewer can have: the grid query for position sends uses it,
// while each viewer's own radius is what the distance check uses. Every viewer has
// DEFAULT_RADIUS today; a larger per-viewer radius must raise this or the grid
// query would silently drop those recipients.
const MAX_AOI_RADIUS = Number(AOI_CONFIG.DEFAULT_RADIUS) || 1000;


export interface PlayerAOIState {

  playersInAOI: Set<string>;

  gridX: number;
  gridY: number;

  aoiRadius: number;

  lastAOIUpdatePosition: { x: number; y: number };

  updateThreshold: number;

  mapChangeSequence: number;

  layerId: string | null;
}

// Chunk loadPlayers frames: a single frame with many sprite-laden players can
// exceed the transport's per-stream queue limit (~256KB) and destroy the
// stream. Splitting keeps each frame below that ceiling.
export function sendLoadPlayersChunked(
  sendPacket: (wt: any, packets: any) => void,
  wt: any,
  players: any[],
  snapshotRevision: number | null,
  chunkSize = 8
): void {
  // The viewer's client builds these players anew: what it held of them before no longer counts (socket/looks.ts).
  for (const player of players) if (player) forgetLook(wt, String(player.id));
  for (let i = 0; i < players.length; i += chunkSize) {
    sendPacket(wt, packetManager.loadPlayers({ players: players.slice(i, i + chunkSize), snapshotRevision }));
  }
}

export async function initializePlayerAOI(player: any): Promise<void> {
  const pos = player.location.position;
  const mapName = player.location.map.replaceAll(".json", "");

  let layerId: string;

  if (player.party_id) {
    const partyId = player.party_id;
    const partyLeader = await parties.getPartyLeader(partyId);
    const partyMembers = await parties.getPartyMembers(partyId);
    const isLeader = partyLeader?.toLowerCase() === player.username?.toLowerCase();

    const allPlayers = playerCache.list();
    const memberSet = new Set(partyMembers.map((m: string) => m.toLowerCase()));
    const onlinePartyPlayers = Object.values(allPlayers).filter((p: any) =>
      p.username && memberSet.has(p.username.toLowerCase()) &&
      p.aoi?.layerId &&
      p.location.map.replaceAll(".json", "") === mapName
    );

    if (onlinePartyPlayers.length > 0) {
      if (isLeader) {

        const layerCounts = new Map<string, number>();
        onlinePartyPlayers.forEach((p: any) => {
          if (p.aoi?.layerId) {
            layerCounts.set(p.aoi.layerId, (layerCounts.get(p.aoi.layerId) || 0) + 1);
          }
        });

        let maxCount = 0;
        let targetLayer = null;
        for (const [layer, count] of layerCounts.entries()) {
          if (count > maxCount) {
            maxCount = count;
            targetLayer = layer;
          }
        }

        if (targetLayer) {
          const targetLayerInfo = layerManager.getLayerInfo(targetLayer);
          if (targetLayerInfo && layerManager.countInBlock(targetLayer, blockOf(pos.x, pos.y)) < MAX_PLAYERS_PER_LAYER) {
            layerId = layerManager.assignPlayerToLayer(player.id, mapName, pos.x, pos.y, targetLayer);
          } else {
            layerId = layerManager.assignPlayerToLayer(player.id, mapName, pos.x, pos.y);
          }
        } else {
          layerId = layerManager.assignPlayerToLayer(player.id, mapName, pos.x, pos.y);
        }
      } else {

        const leaderPlayer = onlinePartyPlayers.find((p: any) =>
          p.username?.toLowerCase() === partyLeader?.toLowerCase()
        );

        if (leaderPlayer && leaderPlayer.aoi?.layerId) {
          const leaderLayerId = leaderPlayer.aoi.layerId;
          const leaderLayerInfo = layerManager.getLayerInfo(leaderLayerId);

          if (leaderLayerInfo && layerManager.countInBlock(leaderLayerId, blockOf(pos.x, pos.y)) < MAX_PLAYERS_PER_LAYER) {
            layerId = layerManager.assignPlayerToLayer(player.id, mapName, pos.x, pos.y, leaderLayerId);
          } else {

            layerId = layerManager.assignPlayerToLayer(player.id, mapName, pos.x, pos.y);
          }
        } else {

          layerId = layerManager.assignPlayerToLayer(player.id, mapName, pos.x, pos.y);
        }
      }
    } else {

      layerId = layerManager.assignPlayerToLayer(player.id, mapName, pos.x, pos.y);
    }
  } else {

    layerId = layerManager.assignPlayerToLayer(player.id, mapName, pos.x, pos.y);
  }

  if (player.aoi) return;

  player.aoi = {
    playersInAOI: new Set<string>(),
    gridX: Math.floor(pos.x / AOI_CONFIG.GRID_CELL_SIZE),
    gridY: Math.floor(pos.y / AOI_CONFIG.GRID_CELL_SIZE),
    aoiRadius: AOI_CONFIG.DEFAULT_RADIUS,
    lastAOIUpdatePosition: { x: pos.x, y: pos.y },
    updateThreshold: AOI_CONFIG.UPDATE_THRESHOLD,
    mapChangeSequence: 0,
    layerId: layerId,
    revision: 0,
  };

  if (AOI_CONFIG.USE_SPATIAL_GRID) {
    spatialGrid.addPlayer(player.id, pos.x, pos.y, mapName);
  }
}

function filterPlayersByDistance(
  sourcePlayer: any,
  radius: number,
  map: string
): any[] {
  const radiusSquared = radius * radius;
  const sourcePos = sourcePlayer.location.position;
  // Null when no layer is assigned (shouldn't normally happen): such a player
  // then only sees other players without a layer, as before.
  const sourceLayerId = sourcePlayer.aoi?.layerId || null;
  const sourceMap = map.replaceAll(".json", "");
  const result: any[] = [];

  // AOI candidates are always same-layer (players on other layers are separate
  // instances), taken from the spatial grid cells round the player. A layer of
  // a huge map can hold thousands of players spread over the whole map, so
  // scanning its membership no longer scales; the grid query costs what the
  // local crowd costs. The grid is not layer aware, so other-layer players in
  // those cells are dropped on a map lookup before their objects are touched.
  const ids: Iterable<string> = AOI_CONFIG.USE_SPATIAL_GRID
    ? spatialGrid.getPlayersInRadius(sourcePos.x, sourcePos.y, radius + GRID_LAG_PAD_PX, sourceMap)
    : mapIndex.getPlayersOnMap(sourceMap);
  for (const playerId of ids) {
    if (playerId === sourcePlayer.id) continue;
    // Mirrors of players a neighbouring node owns are in the grid too (cluster mode): seen like local players.
    if (playerLayer(playerId) !== sourceLayerId) continue;
    const player = entityById(playerId);
    if (!player || !player.location) continue;

    const dx = player.location.position.x - sourcePos.x;
    const dy = player.location.position.y - sourcePos.y;
    if (dx * dx + dy * dy <= radiusSquared) {
      result.push(player);
    }
  }

  return result;
}

// Players a viewer always gets to see when in range, whatever the cap: their
// party members, the player they have selected, and a player who attacked
// them in the last ATTACK_MEMORY_MS (most often from across a border).
function isPriorityFor(viewer: any, other: any): boolean {
  if (viewer.party?.includes(other.username)) return true;
  if (viewer.selectedPlayerId != null && String(viewer.selectedPlayerId) === String(other.id)) return true;
  return isRecentAttacker(String(viewer.id), String(other.id));
}

// Whether `viewer` is shown `other` at all: stealthed and vanished players are
// drawn only for admins, party members and forced viewers.
export function canSee(viewer: any, other: any): boolean {
  return !other.isStealth && !other.isVanished || !!viewer.isAdmin ||
    !!viewer.forceVisibleTo?.has(other.id) || !!viewer.party?.includes(other.username);
}

function distSq(a: any, b: any): number {
  const dx = a.location.position.x - b.location.position.x;
  const dy = a.location.position.y - b.location.position.y;
  return dx * dx + dy * dy;
}

// Caps a viewer's candidates at `cap`: priority players first, then the
// nearest of the rest. Players the viewer is not shown (stealth, vanish) rank
// after everyone they are shown, so they never take a place from a visible
// player; they stay in the set when there is room so an unstealth reaches the
// viewer through the reverse index. Under the cap every candidate is kept.
// Current members rank as if EXIT_HYSTERESIS times nearer, so two players
// trading places by a few pixels around the last place do not swap (a despawn
// and a spawn) on every update.
function capVisible(viewer: any, candidates: any[], cap: number): any[] {
  if (candidates.length <= cap) return candidates;

  const members: Set<string> | undefined = viewer.aoi?.playersInAOI;
  const memberMargin = AOI_EXIT_HYSTERESIS * AOI_EXIT_HYSTERESIS;
  const chosen: any[] = [];
  const rest: { player: any; d2: number }[] = [];
  for (const candidate of candidates) {
    if (isPriorityFor(viewer, candidate)) {
      chosen.push(candidate);
      continue;
    }
    let d2 = canSee(viewer, candidate) ? distSq(viewer, candidate) : Infinity;
    if (members?.has(candidate.id)) d2 /= memberMargin;
    rest.push({ player: candidate, d2 });
  }

  rest.sort((a, b) => a.d2 - b.d2);
  const room = Math.min(rest.length, cap - chosen.length);
  for (let i = 0; i < room; i++) chosen.push(rest[i].player);
  return chosen;
}

// `viewer` is at the cap and `newcomer` is not in their set: if the newcomer is
// clearly nearer (by the EXIT_HYSTERESIS margin, as in capVisible) than the
// viewer's farthest non-priority member, that member is evicted (despawned to
// the viewer) to make room, and true is returned for the caller to add the
// newcomer. Idle players never run an AOI update of their own, so without this
// a player standing still at the cap would never see anyone new walk up.
// Members the viewer is not shown count as farthest; priority members are
// never evicted.
function evictFarthestFor(
  viewer: any,
  newcomer: any,
  spawnBatchQueue?: Map<string, Map<string, any>>,
  despawnBatchQueue?: Map<string, Set<string>>
): boolean {
  if (!canSee(viewer, newcomer)) return false;
  const newcomerD2 = distSq(viewer, newcomer);

  let farthestId: string | null = null;
  // A member is evicted only when newcomerD2 * EXIT_HYSTERESIS^2 < its d2.
  let farthestD2 = newcomerD2 * AOI_EXIT_HYSTERESIS * AOI_EXIT_HYSTERESIS;
  for (const id of viewer.aoi.playersInAOI) {
    const member = entityById(id as string);
    if (!member || !member.location) {
      // A stale id: evict it first.
      farthestId = id as string;
      break;
    }
    if (isPriorityFor(viewer, member)) continue;
    const d2 = canSee(viewer, member) ? distSq(viewer, member) : Infinity;
    if (d2 > farthestD2) {
      farthestId = id as string;
      farthestD2 = d2;
    }
  }
  if (farthestId === null) return false;

  // A spawn of the evicted member still waiting in this batch must not follow
  // the despawn.
  spawnBatchQueue?.get(viewer.id)?.delete(farthestId);
  if (despawnBatchQueue) {
    if (!despawnBatchQueue.has(viewer.id)) {
      despawnBatchQueue.set(viewer.id, new Set());
    }
    despawnBatchQueue.get(viewer.id)!.add(farthestId);
  } else {
    forgetLook(viewer.wt, farthestId);
    sendPacket(viewer.wt, packetManager.despawnPlayer(farthestId, "distance"));
  }
  viewer.aoi.playersInAOI.delete(farthestId);
  // `viewer` can no longer see the evicted member.
  aoiReverse.removeViewer(farthestId, viewer.id);
  viewer.aoi.revision = (viewer.aoi.revision || 0) + 1;
  return true;
}

// Whether `viewer` would keep `target` in its own set on its next update by
// distance alone: same layer and inside the viewer's exit radius. With the cap
// the two sides of a pair can disagree, so one side dropping the other must not
// take the other side's view away with it.
function keepsInView(viewer: any, target: any): boolean {
  const layerId = viewer.aoi?.layerId;
  if (!layerId || layerId !== target.aoi?.layerId) return false;
  if (!viewer.location || !target.location) return false;
  const dx = viewer.location.position.x - target.location.position.x;
  const dy = viewer.location.position.y - target.location.position.y;
  const exitRadius = viewer.aoi.aoiRadius * AOI_EXIT_HYSTERESIS;
  return dx * dx + dy * dy <= exitRadius * exitRadius;
}

// True when one of the player's party members is online on this layer.
function hasPartyMemberOnLayer(player: any, layerId: string | null): boolean {
  if (!layerId || !player.party?.length) return false;
  for (const username of player.party) {
    const member = playerCache.getByUsername(username);
    if (member && member.id !== player.id && layerManager.getPlayerLayer(member.id) === layerId) return true;
  }
  return false;
}

// Moves a player to another layer of their map: the layer manager, their AOI
// state and per-layer world state follow, and everyone who could see them on
// the old layer gets a despawn. The caller then runs updatePlayerAOI, which
// rebuilds their visible set from the new layer, and flushes the queues.
function switchPlayerLayer(
  player: any,
  layerId: string,
  despawnBatchQueue?: Map<string, Set<string>>
): void {
  layerManager.movePlayerToLayer(player.id, layerId);
  player.aoi.layerId = layerId;
  playerCache.set(player.id, player);
  notifyLayerChanged(player.id);
  despawnPlayerFromAllAOI(player, "map_change", despawnBatchQueue);
}

function sendPacket(wt: any, packets: any[]) {
  if (!wt || !wt.send || wt.readyState !== 1) return;
  try {
    packets.forEach((packet) => {
      wt.send(packet);
    });
  } catch (error) {
    // Silently ignore packet send errors
  }
}

// sendPacket for one broadcast's packets going to many viewers: each packet's length-prefixed frame is built once
// (by the first connection that queues it, see TransportConnection.sendFramed) and shared by the rest.
// True when every packet was queued (a connection that reports nothing counts as having queued it).
function sendPacketShared(wt: any, packets: any[], shared: { frame?: Uint8Array }[]): boolean {
  if (!wt || !wt.send || wt.readyState !== 1) return false;
  let queued = true;
  try {
    for (let i = 0; i < packets.length; i++) {
      const result = typeof wt.sendFramed === "function" ? wt.sendFramed(packets[i], shared[i]) : wt.send(packets[i]);
      if (result === false) queued = false;
    }
  } catch (error) {
    // Silently ignore packet send errors
    return false;
  }
  return queued;
}

export function queueSpawnPlayerPacket(
  spawnedPlayer: any
): any {
  if (!spawnedPlayer) return null;

  try {

    const spawnData = {
      id: spawnedPlayer.id,
      userid: spawnedPlayer.userid,
      location: {
        map: spawnedPlayer.location.map,
        x: spawnedPlayer.location.position.x,
        y: spawnedPlayer.location.position.y,
        direction: spawnedPlayer.location.position.direction,
        moving: spawnedPlayer.moving || false,
      },
      username: spawnedPlayer.username,
      isAdmin: spawnedPlayer.isAdmin,
      isGuest: spawnedPlayer.isGuest,
      isStealth: spawnedPlayer.isStealth,
      isVanished: spawnedPlayer.isVanished,
      isNoclip: spawnedPlayer.isNoclip,
      isDead: spawnedPlayer.isDead || false,
      isGhost: spawnedPlayer.isGhost || false,
      ghostTeleportPending: spawnedPlayer.ghostTeleportPending || false,
      stats: spawnedPlayer.stats,
      mounted: spawnedPlayer.mounted,
      animation: null,
      spriteData: null,
      guild: spawnedPlayer.guild || [],
      guild_name: spawnedPlayer.guild_name || null,
      // A mirror carries its owner's effects: the timers live on that node, sent as times they run out.
      effects: spawnedPlayer.remote ? mirrorEffectsPayload(spawnedPlayer.effects) : getEffectsPayload(spawnedPlayer),
    };

    return spawnData;
  } catch (error) {
    return null;
  }
}

export function broadcastPlayerUpdate(player: any): void {
  if (!player || !player.aoi) return;

  const spawnData = queueSpawnPlayerPacket(player);
  if (!spawnData) return;

  // Encode once - the frame is byte-identical for every viewer.
  const spawnFrames = packetManager.spawnPlayer(spawnData);

  const viewers = findPlayersWithTargetInAOI(player.id);
  for (const viewer of viewers) {
    if (viewer.wt) {
      sendPacket(viewer.wt, spawnFrames);
    }
  }
  // Cluster mode: the viewers of this player's mirrors on neighbouring nodes get the new look too.
  if (!player.remote) ghosts.relay("player", String(player.id), spawnFrames, false);
}

export const aoiProf = {
  calls: 0,
  filterMs: 0,
  enteredLoopMs: 0,
  exitedLoopMs: 0,
  tailMs: 0,
  candidateTotal: 0,
  enteredTotal: 0,
  exitedTotal: 0,
  maxCandidates: 0,
};
const AOI_PROFILE =
  process.env.BENCHMARK_PROFILE === "1" || process.env.BENCHMARK_PROFILE === "true";

export async function updatePlayerAOI(
  player: any,
  spawnBatchQueue?: Map<string, Map<string, any>>,
  despawnBatchQueue?: Map<string, Set<string>>
): Promise<void> {
  if (!player || !player.aoi) {
    return;
  }

  const currentMap = player.location.map;
  const currentPos = player.location.position;
  const aoiRadius = player.aoi.aoiRadius;
  const currentSequence = player.aoi.mapChangeSequence;
  const cap = maxVisiblePlayers();

  try {
    // Keep the layer's per-block counts in step with the player. A player
    // parked on an overflow layer because their block was crowded moves down
    // once they reach a block where a lower layer has room - unless party
    // members share their current layer (party sync keeps them together).
    const lowerLayerId = layerManager.updatePlayerBlock(player.id, currentPos.x, currentPos.y);
    if (lowerLayerId && !hasPartyMemberOnLayer(player, player.aoi.layerId)) {
      switchPlayerLayer(player, lowerLayerId, despawnBatchQueue);
    }

    const _p0 = AOI_PROFILE ? performance.now() : 0;

    const playersInRange = filterPlayersByDistance(
      player,
      aoiRadius,
      currentMap
    );

    const _p1 = AOI_PROFILE ? performance.now() : 0;

    if (AOI_CONFIG.USE_SPATIAL_GRID) {
      // Same map key as addPlayer / handleMapChangeAOI: the stored map may
      // carry ".json", and every grid query uses the bare name.
      spatialGrid.updatePlayer(player.id, currentPos.x, currentPos.y, currentMap.replaceAll(".json", ""));
    }

    if (player.aoi.mapChangeSequence !== currentSequence) {
      return;
    }

    const newAOISet = new Set(capVisible(player, playersInRange, cap).map((p) => p.id));
    const oldAOISet = player.aoi.playersInAOI;

    const enteredAOI: string[] = [...newAOISet].filter(id => !oldAOISet.has(id));

    // Exit hysteresis: a player who has merely crossed the AOI radius is NOT
    // dropped until they are past radius * AOI_EXIT_HYSTERESIS. Without this, a
    // player jittering back and forth across the boundary (very common - normal
    // wandering near another player) generates a despawn + re-spawn packet pair
    // on every AOI update. At scale that was ~19k exit events per 5s, each an
    // encode + send + reverse-index mutation, and it dominated the AOI cost.
    //
    // Skipped entirely when the visible set changed wholesale (a warp / map
    // change - oldAOISet is from the old map, none of it is "near the boundary"
    // in any meaningful sense; treating it as sticky just makes a big pointless
    // loop and keeps stale cross-map viewers around for a frame).
    const wholesaleChange =
      oldAOISet.size > 0 && enteredAOI.length === newAOISet.size;
    const exitRadiusSq = aoiRadius * aoiRadius * (AOI_EXIT_HYSTERESIS * AOI_EXIT_HYSTERESIS);
    const exitedAOI: string[] = [];
    const inBand: { id: string; d2: number; priority: boolean }[] = [];
    for (const id of oldAOISet) {
      if (newAOISet.has(id)) continue;
      if (!wholesaleChange) {
        const other = entityById(id as string);
        if (other && other.location && other.aoi?.layerId === player.aoi.layerId) {
          const ex = other.location.position.x - currentPos.x;
          const ey = other.location.position.y - currentPos.y;
          const d2 = ex * ex + ey * ey;
          if (d2 <= exitRadiusSq) {
            inBand.push({ id: id as string, d2, priority: isPriorityFor(player, other) });
            continue;
          }
        }
      }
      exitedAOI.push(id as string);
    }
    // Still within the hysteresis band - keep them visible, nearest first,
    // while the set is under the cap (priority players always). Under the cap
    // this keeps every one of them, as before.
    if (inBand.length > 1) inBand.sort((a, b) => a.d2 - b.d2);
    for (const kept of inBand) {
      if (kept.priority || newAOISet.size < cap) {
        newAOISet.add(kept.id);
      } else {
        exitedAOI.push(kept.id);
      }
    }

    const _p2 = AOI_PROFILE ? performance.now() : 0;

    for (const enteredPlayerId of enteredAOI) {
      const enteredPlayer = entityById(enteredPlayerId);
      if (!enteredPlayer) {
        continue;
      }

      const canSeeEntered = canSee(player, enteredPlayer);
      const canSeePlayer = canSee(enteredPlayer, player);

      if (canSeeEntered && spawnBatchQueue) {
        const spawnData = queueSpawnPlayerPacket(enteredPlayer);
        if (spawnData) {
          if (!spawnBatchQueue.has(player.id)) {
            spawnBatchQueue.set(player.id, new Map());
          }
          spawnBatchQueue.get(player.id)!.set(enteredPlayer.id, spawnData);
        }
      }

      // A mirror does not look back: its own node keeps its view. Only `player` learns of it.
      if (enteredPlayer.remote) continue;

      // Already seen by the entered player: nothing to add or spawn again.
      const enteredSet = enteredPlayer.aoi?.playersInAOI;
      if (enteredSet?.has(player.id)) continue;

      // The entered player starts seeing `player` at once while their own set
      // has room, when `player` is a priority player for them, or when
      // `player` is nearer than their farthest member (who is swapped out).
      // Otherwise their own next update decides.
      const seenBack = !enteredSet || enteredSet.size < cap || isPriorityFor(enteredPlayer, player) ||
        evictFarthestFor(enteredPlayer, player, spawnBatchQueue, despawnBatchQueue);
      if (!seenBack) continue;

      if (canSeePlayer && spawnBatchQueue) {
        const spawnData = queueSpawnPlayerPacket(player);
        if (spawnData) {
          if (!spawnBatchQueue.has(enteredPlayer.id)) {
            spawnBatchQueue.set(enteredPlayer.id, new Map());
          }
          spawnBatchQueue.get(enteredPlayer.id)!.set(player.id, spawnData);
        }
      }

      if (!enteredPlayer.aoi) {
        await initializePlayerAOI(enteredPlayer);
      }
      enteredPlayer.aoi.playersInAOI.add(player.id);
      // enteredPlayer can now see `player`.
      aoiReverse.addViewer(player.id, enteredPlayer.id);
      enteredPlayer.aoi.revision = (enteredPlayer.aoi.revision || 0) + 1;
      playerCache.set(enteredPlayer.id, enteredPlayer);

    }

    const _p3 = AOI_PROFILE ? performance.now() : 0;
    if (AOI_PROFILE) {
      const c = playersInRange.length;
      aoiProf.calls++;
      aoiProf.filterMs += _p1 - _p0;
      aoiProf.enteredLoopMs += _p3 - _p2;
      aoiProf.candidateTotal += c;
      aoiProf.enteredTotal += enteredAOI.length;
      aoiProf.exitedTotal += exitedAOI.length;
      if (c > aoiProf.maxCandidates) aoiProf.maxCandidates = c;
    }

    for (const exitedPlayerId of exitedAOI) {
      const exitedPlayer = entityById(exitedPlayerId);

      if (despawnBatchQueue) {
        if (!despawnBatchQueue.has(player.id)) {
          despawnBatchQueue.set(player.id, new Set());
        }
        despawnBatchQueue.get(player.id)!.add(exitedPlayerId);
      } else {
        forgetLook(player.wt, exitedPlayerId);
        sendPacket(player.wt, packetManager.despawnPlayer(exitedPlayerId, "distance"));
      }

      // A mirror has no view of its own here (and no socket): only `player`'s side changes.
      if (exitedPlayer && exitedPlayer.wt && !exitedPlayer.remote) {
        // Dropped by the cap while the other player would still keep `player`
        // by distance: leave their side to their own update. Not after a warp
        // (wholesale change): a same-map jump sends the new position to the
        // jumper only, so an old neighbour kept here would see them frozen on
        // the spot they left.
        if (!wholesaleChange && exitedPlayer.aoi?.playersInAOI.has(player.id) && keepsInView(exitedPlayer, player)) {
          continue;
        }

        if (exitedPlayer.wt && exitedPlayer.wt.readyState === 1) {
          forgetLook(exitedPlayer.wt, player.id);
          sendPacket(
            exitedPlayer.wt,
            packetManager.despawnPlayer(player.id, "distance")
          );
        } else if (despawnBatchQueue) {

          if (!despawnBatchQueue.has(exitedPlayer.id)) {
            despawnBatchQueue.set(exitedPlayer.id, new Set());
          }
          despawnBatchQueue.get(exitedPlayer.id)!.add(player.id);
        }

        if (exitedPlayer.aoi) {
          exitedPlayer.aoi.playersInAOI.delete(player.id);
          // exitedPlayer can no longer see `player`.
          aoiReverse.removeViewer(player.id, exitedPlayer.id);
          exitedPlayer.aoi.revision = (exitedPlayer.aoi.revision || 0) + 1;
          playerCache.set(exitedPlayer.id, exitedPlayer);
        }
      }
    }

    // Viewers `player` does not see back. Above the cap a viewer can keep
    // `player` while `player` has dropped (or never had) them, so the exit loop
    // above never reaches them; an idle viewer runs no update of their own and
    // would keep `player` frozen where they left. Drop `player` from every such
    // viewer that would not keep them by distance (always after a warp).
    for (const viewerId of [...aoiReverse.getViewers(player.id)]) {
      if (viewerId === String(player.id)) continue;
      const viewer = playerCache.get(viewerId);
      if (newAOISet.has(viewer?.id ?? viewerId)) continue;
      if (viewer?.aoi && !wholesaleChange && keepsInView(viewer, player)) continue;

      aoiReverse.removeViewer(player.id, viewerId);
      if (!viewer?.aoi) continue;
      viewer.aoi.playersInAOI.delete(player.id);
      viewer.aoi.revision = (viewer.aoi.revision || 0) + 1;
      // A spawn of `player` still waiting in this batch must not follow.
      spawnBatchQueue?.get(viewer.id)?.delete(player.id);
      if (viewer.wt && viewer.wt.readyState === 1) {
        forgetLook(viewer.wt, player.id);
        sendPacket(viewer.wt, packetManager.despawnPlayer(player.id, "distance"));
      } else if (despawnBatchQueue) {
        if (!despawnBatchQueue.has(viewer.id)) {
          despawnBatchQueue.set(viewer.id, new Set());
        }
        despawnBatchQueue.get(viewer.id)!.add(player.id);
      }
      playerCache.set(viewer.id, viewer);
    }

    // `player`'s own visible set is being replaced wholesale; reindex the diff
    // so the reverse index reflects who `player` can now see.
    aoiReverse.replaceVisibleSet(player.id, oldAOISet, newAOISet);
    player.aoi.playersInAOI = newAOISet;
    if (enteredAOI.length > 0 || exitedAOI.length > 0) {
      player.aoi.revision = (player.aoi.revision || 0) + 1;
    }
    player.aoi.lastAOIUpdatePosition = { x: currentPos.x, y: currentPos.y };
    player.aoi.gridX = Math.floor(currentPos.x / AOI_CONFIG.GRID_CELL_SIZE);
    player.aoi.gridY = Math.floor(currentPos.y / AOI_CONFIG.GRID_CELL_SIZE);

    playerCache.set(player.id, player);

    if (AOI_PROFILE) {
      const now = performance.now();
      aoiProf.exitedLoopMs += now - _p3;
      // tailMs: replaceVisibleSet + assignments after the exited loop.
    }
  } catch (error) {
    // Silently ignore AOI update errors
  }
}

export function shouldUpdateAOI(player: any): boolean {
  if (!player || !player.aoi) return false;

  const currentPos = player.location.position;
  const lastPos = player.aoi.lastAOIUpdatePosition;

  const dx = currentPos.x - lastPos.x;
  const dy = currentPos.y - lastPos.y;
  const distanceMoved = Math.sqrt(dx * dx + dy * dy);

  const shouldUpdate = distanceMoved > player.aoi.updateThreshold;
  return shouldUpdate;
}

export function broadcastToAOI(
  sourcePlayer: any,
  packetData: any[],
  includeSelf: boolean = true,
  // The packets' shared frames, when the caller keeps them for the next broadcast of the same packets.
  frames?: { frame?: Uint8Array }[]
): void {
  if (!sourcePlayer || !sourcePlayer.aoi) {
    return;
  }

  try {

    if (includeSelf && sourcePlayer.wt) {
      sendPacket(sourcePlayer.wt, packetData);
    }

    // Everyone who sees the source (reverse index), not everyone the source
    // sees: above the visibility cap the two differ.
    const playersInAOI = findPlayersWithTargetInAOI(sourcePlayer.id)
      .filter((p) => p.wt && p.id !== sourcePlayer.id);

    // Built on the first recipient: a broadcast nobody sees allocates nothing.
    let shared: { frame?: Uint8Array }[] | undefined = frames;
    const sharedFor = () => (shared ??= packetData.map(() => ({}) as { frame?: Uint8Array }));

    if (sourcePlayer.isStealth || sourcePlayer.isVanished) {

      const visibleTo = playersInAOI.filter((p) => p.isAdmin || p.party?.includes(sourcePlayer.username));
      visibleTo.forEach((player) => {
        sendPacketShared(player.wt, packetData, sharedFor());
      });
    } else {

      playersInAOI.forEach((player) => {
        sendPacketShared(player.wt, packetData, sharedFor());
      });
    }

    // Cluster mode: the same packets reach the viewers of this player's mirrors on neighbouring nodes.
    if (!sourcePlayer.remote) ghosts.relay("player", String(sourcePlayer.id), packetData, false);
  } catch (error) {
    // Silently ignore broadcast errors
  }
}

/** A player's animation as the two packets that can carry it, and the look the full one holds. */
export interface PoseBroadcast {
  /** The animated player's id. */
  id: string;
  /** lookSignature of the full packet's sheets. */
  signature: string;
  full: any[];
  fullFrames: { frame?: Uint8Array }[];
  pose: any[];
  poseFrames: { frame?: Uint8Array }[];
  /** The pose key (poseKey in receiver.ts), for the repeat counters in posestats.ts only. */
  key?: string;
  /**
   * The animation state the pose packet carries ("walk_down"). With it a viewer that holds the player's look is sent
   * the pose as a datagram with the player's pose revision (socket/posedgram.ts); without it, or when the pose does
   * not fit the datagram, on the reliable stream as before.
   */
  animationState?: string;
  /**
   * The same two packets with the pose revision in them (`poseRev`), for the stream copies a viewer is sent: a late
   * full sheet or stream pose then cannot put an older pose over a newer one the client shows from a datagram. Built
   * only when a viewer needs one, once per change. Absent: the packets above go as they are.
   */
  withRevision?: (revision: number) => { full: any[]; pose: any[] };
}

/**
 * broadcastToAOI for a pose change (observers only): a viewer that holds the player's current look is sent the
 * pose, any other viewer the full sheet, which also records the look for the next time (socket/looks.ts).
 * The pose of a local player goes by datagram, with a revision, and again at POSE_REPEAT_MS after the change
 * (socket/posedgram.ts): one native stream write per viewer and pose change is what stalled a node at 800 players.
 * The full sheet stays on the stream, and so does the pose of a viewer whose connection takes no datagrams.
 * Viewers on other nodes (the ghost relay) always get the full packet: this node does not know what they hold.
 * Who sees the player is decided as in broadcastToAOI.
 */
export function broadcastPoseToAOI(sourcePlayer: any, look: PoseBroadcast): void {
  if (!sourcePlayer || !sourcePlayer.aoi) {
    return;
  }

  try {
    const playersInAOI = findPlayersWithTargetInAOI(sourcePlayer.id)
      .filter((p) => p.wt && p.id !== sourcePlayer.id);
    const viewers = sourcePlayer.isStealth || sourcePlayer.isVanished
      ? playersInAOI.filter((p) => p.isAdmin || p.party?.includes(sourcePlayer.username))
      : playersInAOI;

    // A mirror is read-only: its poses are the owner's, relayed, and carry no revision of this node.
    const local = !sourcePlayer.remote && typeof look.animationState === "string";
    const revision = local ? nextPoseRevision(sourcePlayer) : 0;
    const record = local ? encodePoseRecord(look.id, revision, look.animationState as string) : null;
    /** The viewers that were sent this pose (or the sheets that hold it) and are sent the current pose again. */
    const repeatTo: string[] = [];
    // The stream copies carry the revision when it fits (the one datagram viewers are sent), built on first use.
    let revised: { full: any[]; pose: any[]; fullFrames: { frame?: Uint8Array }[]; poseFrames: { frame?: Uint8Array }[] } | null = null;
    const streamCopies = () => {
      if (!record || !look.withRevision) return look;
      if (!revised) revised = { ...look.withRevision(revision), fullFrames: [{}], poseFrames: [{}] };
      return revised;
    };

    for (const viewer of viewers) {
      if (holdsLook(viewer.wt, look.id, look.signature)) {
        if (record && typeof viewer.wt.sendPoseRecords === "function" && viewer.wt.sendPoseRecords([record])) {
          notePoseDatagram(viewer.wt, look.id, look.key);
          repeatTo.push(String(viewer.id));
        } else {
          const copies = streamCopies();
          sendPacketShared(viewer.wt, copies.pose, copies.poseFrames);
          notePoseViewer(viewer.wt, look.id, look.key, true);
        }
      } else {
        // Recorded only when the full packet was queued: a dropped one leaves the record as it was, which is what the client holds.
        const copies = streamCopies();
        const queued = sendPacketShared(viewer.wt, copies.full, copies.fullFrames);
        if (queued) {
          noteLook(viewer.wt, look.id, look.signature);
          // The sheets carry the pose; the datagram repeats close a late older datagram's window (a client takes the sheets as a baseline).
          if (record) repeatTo.push(String(viewer.id));
        }
        notePoseViewer(viewer.wt, look.id, look.key, false);
      }
    }

    // A newer change stops the repeats of the older one, whoever it went to.
    if (local) {
      if (record && repeatTo.length > 0) poseRepeats.schedule(sourcePlayer, revision, record, repeatTo);
      else poseRepeats.cancel(look.id);
    }

    if (!sourcePlayer.remote) {
      ghosts.relay("player", String(sourcePlayer.id), look.full, false);
      notePoseRelay();
    }
  } catch (error) {
    // Silently ignore broadcast errors
  }
}

function sendPacketBestEffort(wt: any, packetData: any[]) {
  if (!wt || typeof wt.sendBestEffort !== "function" || wt.readyState !== 1) return;
  try {
    packetData.forEach((packet) => {
      wt.sendBestEffort(packet);
    });
  } catch (error) {
    // Silently ignore best-effort send errors
  }
}

/**
 * Like broadcastToAOI but delivered as unreliable datagrams (loss-tolerant
 * packets: stats, cast bars, animations, etc.). Datagrams bypass the stream
 * backpressure queue, so callers must only send latest-wins payloads.
 */
export function broadcastToAOIBestEffort(
  sourcePlayer: any,
  packetData: any[],
  includeSelf: boolean = true
): void {
  if (!sourcePlayer || !sourcePlayer.aoi) {
    return;
  }

  try {
    const receivers = new Set<any>();

    if (includeSelf && sourcePlayer.wt) {
      receivers.add(sourcePlayer);
    }

    // Everyone who sees the source (reverse index), not everyone the source
    // sees: above the visibility cap the two differ.
    const playersInAOI = findPlayersWithTargetInAOI(sourcePlayer.id)
      .filter((p) => p.wt && p.id !== sourcePlayer.id);

    const visibleTo = sourcePlayer.isStealth || sourcePlayer.isVanished
      ? playersInAOI.filter((p) => p.isAdmin || p.party?.includes(sourcePlayer.username))
      : playersInAOI;

    for (const player of visibleTo) {
      receivers.add(player);
    }

    for (const player of receivers) {
      sendPacketBestEffort(player.wt, packetData);
    }

    // Cluster mode: the same packets reach the viewers of this player's mirrors on neighbouring nodes.
    if (!sourcePlayer.remote) ghosts.relay("player", String(sourcePlayer.id), packetData, true);
  } catch (error) {
    // Silently ignore broadcast errors
  }
}

/**
 * Broadcast a stats update (UPDATESTATS) as datagrams to the target, the
 * caster and everyone who sees either of them (reverse index), deduplicated.
 * Replaces map-wide broadcasts: observers who can see either combatant get the
 * damage popup and fresh absolute stats, everyone else self-corrects via the
 * 1Hz regen tick.
 */
export function broadcastStatsUpdateToAOI(
  target: any,
  caster: any,
  packetData: any[]
): void {
  const receivers = new Map<string, any>();

  const collect = (source: any) => {
    if (!source || !source.aoi) return;
    if (source.wt) receivers.set(String(source.id), source);
    for (const p of findPlayersWithTargetInAOI(source.id)) {
      if (p.wt) receivers.set(String(p.id), p);
    }
  };

  try {
    collect(target);
    collect(caster);
    for (const player of receivers.values()) {
      sendPacketBestEffort(player.wt, packetData);
    }

    // Cluster mode: the target's mirrors' viewers on neighbouring nodes see the hit too.
    if (target?.aoi && !target.remote) ghosts.relay("player", String(target.id), packetData, true);
  } catch (error) {
    // Silently ignore broadcast errors
  }
}

/**
 * Broadcast a packet as datagrams to players on a map whose AOI radius covers
 * the given position. Used for entity-targeted stats broadcasts (entities are
 * not tracked in playersInAOI, so position distance stands in for visibility).
 */
/**
 * Called whenever a player moves to a different layer, so per-layer world state
 * (death skeletons, and anything else keyed by layer) can be resent to them.
 */
let onLayerChanged: ((playerId: string) => void) | null = null;

export function setLayerChangeHandler(fn: (playerId: string) => void): void {
  onLayerChanged = fn;
}

export function notifyLayerChanged(playerId: string): void {
  try {
    onLayerChanged?.(playerId);
  } catch {
    // A failed resync must never break the layer move itself.
  }
}

// Players on a map near a point, from the spatial grid cells round it, so the
// cost is the local crowd and not the map. `radiusFor` gives each candidate's
// own reach (a fixed spell radius, or a viewer's AOI radius); the grid query
// uses `queryRadius`, which must cover the largest reach. The grid is not layer
// aware: other-layer players are dropped on a map lookup, before their objects
// are touched. Undefined keeps every layer; null keeps only players with no
// layer (as filterPlayersByDistance does).
function playersNearPoint(
  x: number,
  y: number,
  map: string,
  queryRadius: number,
  layerId: string | null | undefined,
  radiusFor: (p: any) => number
): any[] {
  const mapName = String(map ?? "").replaceAll(".json", "");
  if (!mapName) return [];

  const ids: Iterable<string> = AOI_CONFIG.USE_SPATIAL_GRID
    ? spatialGrid.getPlayersInRadius(x, y, queryRadius + GRID_LAG_PAD_PX, mapName)
    : mapIndex.getPlayersOnMap(mapName);
  const result: any[] = [];
  for (const playerId of ids) {
    if (layerId !== undefined && layerManager.getPlayerLayer(playerId) !== layerId) continue;
    const p = playerCache.get(playerId);
    const pos = p?.location?.position;
    if (!pos || typeof pos.x !== "number" || typeof pos.y !== "number") continue;
    const radius = radiusFor(p);
    const dx = pos.x - x;
    const dy = pos.y - y;
    if (dx * dx + dy * dy <= radius * radius) result.push(p);
  }
  return result;
}

/**
 * Players within `radius` of a point on a map's layer, for area effects that hit
 * whoever stands in them. Pass the caster's layer: null means "players with no
 * layer", never "every layer"; only undefined reaches every layer.
 */
export function getPlayersNearPoint(
  x: number,
  y: number,
  map: string,
  radius: number,
  layerId: string | null | undefined
): any[] {
  return playersNearPoint(x, y, map, radius, layerId, () => radius);
}

/**
 * Send a packet to the players whose AOI radius covers a position on a map's
 * layer. For things that are not players (loot, markers, effects at a spot):
 * entities are not tracked in playersInAOI, so position distance stands in for
 * visibility. Reliable by default; pass `bestEffort` for latest-wins payloads
 * that may go as datagrams. A null layer reaches every layer on the map.
 */
export function broadcastToAOIAtPosition(
  x: number,
  y: number,
  map: string,
  packetData: any[],
  layerId: string | null | undefined,
  options?: { bestEffort?: boolean }
): void {
  // A null layer here means every layer (shared things like death skeletons).
  const viewers = playersNearPoint(
    x, y, map, MAX_AOI_RADIUS, layerId ?? undefined,
    (p) => p.aoi?.aoiRadius || AOI_CONFIG.DEFAULT_RADIUS
  );
  for (const p of viewers) {
    if (options?.bestEffort) sendPacketBestEffort(p.wt, packetData);
    else sendPacket(p.wt, packetData);
  }
}

export function broadcastToAOIBestEffortAtPosition(
  x: number,
  y: number,
  map: string,
  packetData: any[],
  /** Restrict to viewers on this layer. Null/undefined reaches every layer. */
  layerId?: string | null
): void {
  broadcastToAOIAtPosition(x, y, map, packetData, layerId, { bestEffort: true });
}

/**
 * Cluster mode: brings local viewers up to date with a mirrored player (it moved, appeared or changed
 * stealth). A viewer who is not walking runs no AOI update of their own, so without this they would
 * never see a mirror come or go. Mirrors never look back; only local viewers change.
 */
export function updateMirrorViewers(
  mirror: any,
  spawnQueue?: Map<string, Map<string, any>>,
  despawnQueue?: Map<string, Set<string>>
): void {
  const pos = mirror?.location?.position;
  if (!pos) return;
  const map = String(mirror.location.map ?? "").replaceAll(".json", "");
  const layerId = mirror.aoi?.layerId ?? null;
  const cap = maxVisiblePlayers();
  const near = new Set<string>();
  // playersNearPoint resolves through playerCache, so mirrors are never among the viewers.
  for (const viewer of playersNearPoint(pos.x, pos.y, map, MAX_AOI_RADIUS, layerId, (p) => p.aoi?.aoiRadius || AOI_CONFIG.DEFAULT_RADIUS)) {
    if (!viewer.aoi || viewer.remote || viewer.id === mirror.id) continue;
    near.add(String(viewer.id));
    if (viewer.aoi.playersInAOI.has(mirror.id)) continue;
    // At the cap a nearer mirror takes the farthest member's place, as for a local newcomer.
    if (viewer.aoi.playersInAOI.size >= cap && !isPriorityFor(viewer, mirror) &&
      !evictFarthestFor(viewer, mirror, spawnQueue, despawnQueue)) continue;
    viewer.aoi.playersInAOI.add(mirror.id);
    aoiReverse.addViewer(mirror.id, viewer.id);
    viewer.aoi.revision = (viewer.aoi.revision || 0) + 1;
    if (!spawnQueue || !canSee(viewer, mirror)) continue;
    const spawnData = queueSpawnPlayerPacket(mirror);
    if (!spawnData) continue;
    if (!spawnQueue.has(viewer.id)) spawnQueue.set(viewer.id, new Map());
    spawnQueue.get(viewer.id)!.set(mirror.id, spawnData);
  }
  for (const viewerId of [...aoiReverse.getViewers(mirror.id)]) {
    if (near.has(viewerId)) continue;
    const viewer = playerCache.get(viewerId);
    if (viewer?.aoi && keepsInView(viewer, mirror)) continue;
    dropViewer(mirror.id, viewerId, viewer, spawnQueue, despawnQueue);
  }
}

/** Cluster mode: a mirror is gone; every local viewer forgets it (and any spawn of it still queued for them). */
export function dropMirrorViewers(mirrorId: string, spawnQueue?: Map<string, Map<string, any>>): void {
  for (const viewerId of [...aoiReverse.getViewers(mirrorId)]) {
    dropViewer(mirrorId, viewerId, playerCache.get(viewerId), spawnQueue);
  }
}

function dropViewer(
  mirrorId: string,
  viewerId: string,
  viewer: any,
  spawnQueue?: Map<string, Map<string, any>>,
  despawnQueue?: Map<string, Set<string>>
): void {
  aoiReverse.removeViewer(mirrorId, viewerId);
  if (!viewer?.aoi) return;
  viewer.aoi.playersInAOI.delete(mirrorId);
  viewer.aoi.revision = (viewer.aoi.revision || 0) + 1;
  // A spawn of the mirror still waiting in this batch must not follow the despawn.
  spawnQueue?.get(viewer.id)?.delete(mirrorId);
  if (viewer.wt && viewer.wt.readyState === 1) {
    forgetLook(viewer.wt, mirrorId);
    sendPacket(viewer.wt, packetManager.despawnPlayer(mirrorId, "distance"));
  } else if (despawnQueue) {
    if (!despawnQueue.has(viewer.id)) despawnQueue.set(viewer.id, new Set());
    despawnQueue.get(viewer.id)!.add(mirrorId);
  }
}

/**
 * The caster and everyone who sees them (reverse index, so it holds when the
 * visibility cap makes the two directions differ): who a cast bar goes to.
 * Stealth does not filter it; a client with no entity for the caster draws
 * nothing from a cast packet.
 */
export function castAudience(caster: any): any[] {
  if (!caster) return [];
  const audience: any[] = [];
  if (caster.wt) audience.push(caster);
  for (const viewer of findPlayersWithTargetInAOI(caster.id)) {
    if (viewer.wt && viewer.id !== caster.id) audience.push(viewer);
  }
  return audience;
}

// The caster's own copy stays on the reliable stream (their cast bar and
// cooldown UI must not lose an "interrupted"); observers get a datagram.
function sendCastSplit(audience: any[], casterId: string, packetData: any[]): void {
  for (const p of audience) {
    if (String(p.id) === String(casterId)) sendPacket(p.wt, packetData);
    else sendPacketBestEffort(p.wt, packetData);
  }
}

/**
 * Broadcast a cosmetic cast-state packet (CAST_SPELL variants): reliable to the
 * caster, loss-tolerant datagrams to everyone who sees them.
 */
export function broadcastCastToAOI(caster: any, packetData: any[]): void {
  try {
    sendCastSplit(castAudience(caster), caster.id, packetData);
    // Cluster mode: observers of the caster's mirrors on neighbouring nodes (datagrams, as observers here).
    if (caster && !caster.remote) ghosts.relay("player", String(caster.id), packetData, true);
  } catch (error) {
    // Silently ignore broadcast errors
  }
}

// Who got each caster's ground-AoE casting preview, until it is cleared. The
// client removes a preview only on a despawn with its id, and the viewers can
// change during the cast, so the despawn goes to the same people.
const groundPreviewAudience = new Map<string, Set<string>>();

/** Send a ground-AoE casting preview like a cast bar, remembering who got it. */
export function broadcastGroundPreviewToAOI(caster: any, packetData: any[]): void {
  try {
    const audience = castAudience(caster);
    const key = String(caster.id);
    const seen = groundPreviewAudience.get(key) ?? new Set<string>();
    for (const p of audience) seen.add(String(p.id));
    groundPreviewAudience.set(key, seen);
    sendCastSplit(audience, caster.id, packetData);
    // Cluster mode: observers of the caster's mirrors on neighbouring nodes.
    if (!caster.remote) ghosts.relay("player", String(caster.id), packetData, true);
  } catch (error) {
    // Silently ignore broadcast errors
  }
}

/** Drop a caster's preview record (they left, so there is nothing to clear it later). */
export function forgetGroundPreview(casterId: string | number): void {
  groundPreviewAudience.delete(String(casterId));
}

/**
 * Remove a caster's casting preview (reliably) from everyone who got it plus
 * everyone who sees the caster now.
 */
export function clearGroundPreviewForAOI(caster: any, despawnPacket: any[]): void {
  try {
    const key = String(caster.id);
    const recipients = groundPreviewAudience.get(key) ?? new Set<string>();
    groundPreviewAudience.delete(key);
    for (const p of castAudience(caster)) recipients.add(String(p.id));
    for (const id of recipients) sendPacket(playerCache.get(id)?.wt, despawnPacket);
    // Cluster mode: the caster's mirrors' viewers now (reliable: a preview left behind never clears).
    if (!caster.remote) ghosts.relay("player", String(caster.id), despawnPacket, false);
  } catch (error) {
    // Silently ignore broadcast errors
  }
}

export function findPlayersWithTargetInAOI(targetId: number | string): any[] {
  // O(viewers) via the reverse index instead of an O(all players) cache scan.
  // The index is the source of truth (it normalises ids to strings, which the
  // raw `playersInAOI.has()` check did not); we only re-validate that the
  // viewer still exists and is a live AOI participant.
  const result: any[] = [];
  for (const viewerId of aoiReverse.getViewers(targetId)) {
    const player = playerCache.get(viewerId);
    if (player && player.aoi) {
      result.push(player);
    }
  }
  return result;
}

/**
 * World-index cleanup for a session killed by a duplicate login (same user
 * logging in again). The normal disconnect path does all of this in the
 * server's onDisconnect handler, but that handler early-returns on the cache
 * miss left behind by the kick - so without this the stale id lingers in
 * viewers' AOI sets, the reverse index, its layer (leaking playerCount),
 * the map index and the spatial grid.
 *
 * Deliberately does NOT touch username-keyed state (cooldowns, dots, friends
 * presence): the same user is still online via the new session.
 */
export function cleanupKickedSession(
  kickedPlayer: any,
  despawnBatchQueue?: Map<string, Set<string>>
): void {
  if (!kickedPlayer) return;
  try {
    despawnPlayerFromAllAOI(kickedPlayer, "disconnect", despawnBatchQueue);
    // despawnPlayerFromAllAOI early-returns without aoi (a session killed
    // mid-login); the index removals below are safe no-ops when absent.
    layerManager.removePlayerFromLayer(kickedPlayer.id);
    mapIndex.removePlayer(kickedPlayer.id);
    if (AOI_CONFIG.USE_SPATIAL_GRID) {
      spatialGrid.removePlayer(kickedPlayer.id);
    }
  } catch {
    // Hygiene must never break the login that triggered the kick.
  }
}

export function despawnPlayerFromAllAOI(
  departingPlayer: any,
  reason: "map_change" | "disconnect" = "map_change",
  despawnBatchQueue?: Map<string, Set<string>>
): void {
  // Before the aoi check: a session killed mid-login leaves no preview record either.
  if (reason === "disconnect" && departingPlayer) forgetGroundPreview(departingPlayer.id);
  if (!departingPlayer || !departingPlayer.aoi) return;

  try {

    const affectedPlayers = findPlayersWithTargetInAOI(departingPlayer.id);

    affectedPlayers.forEach((player) => {
      if (despawnBatchQueue) {

        if (!despawnBatchQueue.has(player.id)) {
          despawnBatchQueue.set(player.id, new Set());
        }
        despawnBatchQueue.get(player.id)!.add(departingPlayer.id);
      } else {

        forgetLook(player.wt, departingPlayer.id);
        sendPacket(
          player.wt,
          packetManager.despawnPlayer(departingPlayer.id, reason)
        );
      }

      if (player.aoi) {
        player.aoi.playersInAOI.delete(departingPlayer.id);
        // `player` can no longer see the departing player.
        aoiReverse.removeViewer(departingPlayer.id, player.id);
        player.aoi.revision = (player.aoi.revision || 0) + 1;
        playerCache.set(player.id, player);
      }
    });

    // Nobody sees the departing player any more, on either map. Also drop the
    // departing player as a viewer of everyone else: on disconnect its forward
    // set is cleared below; on map_change it keeps a stale set that the
    // follow-up updatePlayerAOI would otherwise diff against, but clearing here
    // keeps the reverse index tight regardless.
    aoiReverse.clearViewed(departingPlayer.id);
    aoiReverse.clearViewer(departingPlayer.id);

    if (reason === "disconnect") {
      departingPlayer.aoi.playersInAOI.clear();
      departingPlayer.aoi.revision = (departingPlayer.aoi.revision || 0) + 1;
      layerManager.removePlayerFromLayer(departingPlayer.id);

      if (AOI_CONFIG.USE_SPATIAL_GRID) {
        spatialGrid.removePlayer(departingPlayer.id);
      }
    }
  } catch (error) {
    // Silently ignore despawn errors
  }
}

/**
 * A player handed to another node (cells phase 6): out of every AOI index of this node, with no despawn. Who sees
 * the player keeps the entry and the reverse index: the mirror that replaces the player next is shown to them with
 * no despawn and spawn in between (updateMirrorViewers skips a viewer that already has the id).
 */
export function releasePlayerAOI(player: any): void {
  if (!player) return;
  forgetGroundPreview(player.id);
  // As a viewer of others only: who sees the player stays, for the mirror.
  aoiReverse.clearViewer(player.id);
  if (player.aoi) {
    player.aoi.playersInAOI.clear();
    player.aoi.revision = (player.aoi.revision || 0) + 1;
  }
  layerManager.removePlayerFromLayer(player.id);
  mapIndex.removePlayer(player.id);
  if (AOI_CONFIG.USE_SPATIAL_GRID) spatialGrid.removePlayer(player.id);
}

export async function handleMapChangeAOI(
  player: any,
  newMapName: string,
  newPosition: { x: number; y: number },
  spawnBatchQueue?: Map<string, Map<string, any>>,
  despawnBatchQueue?: Map<string, Set<string>>
): Promise<void> {
  if (!player) return;

  try {

    if (!player.aoi) {
      await initializePlayerAOI(player);
    }

    const oldMapName = player.location.map;

    const oldMap = oldMapName.replaceAll(".json", "");
    const newMap = newMapName.replaceAll(".json", "");

    if (oldMap !== newMap) {

      player.aoi.mapChangeSequence++;

      despawnPlayerFromAllAOI(player, "map_change", undefined);

      const newLayerId = layerManager.assignPlayerToLayer(player.id, newMap, newPosition.x, newPosition.y);
      player.aoi.layerId = newLayerId;
      notifyLayerChanged(player.id);

      if (AOI_CONFIG.USE_SPATIAL_GRID) {
        spatialGrid.removePlayer(player.id);
        spatialGrid.addPlayer(player.id, newPosition.x, newPosition.y, newMap);
      }
    }

    const oldMapForIndex = player.location.map;
    player.location.map = newMapName;
    player.location.position.x = Math.round(newPosition.x);
    player.location.position.y = Math.round(newPosition.y);
    ghosts.touch("player", player.id);

    if (oldMap !== newMap) {
      mapIndex.movePlayer(player.id, oldMapForIndex, newMapName);
    }
    player.aoi.gridX = Math.floor(newPosition.x / AOI_CONFIG.GRID_CELL_SIZE);
    player.aoi.gridY = Math.floor(newPosition.y / AOI_CONFIG.GRID_CELL_SIZE);
    player.aoi.lastAOIUpdatePosition = { x: newPosition.x, y: newPosition.y };
    playerCache.set(player.id, player);

    // On a same-map jump the layer is kept; updatePlayerAOI moves the block
    // count to the new position (and the player to a lower layer if the new
    // block has room there).
    const _mcStart = AOI_PROFILE ? performance.now() : 0;
    await updatePlayerAOI(player, spawnBatchQueue, despawnBatchQueue);
    if (AOI_PROFILE) {
      const dt = performance.now() - _mcStart;
      if (dt > 20) {
        log.info(`[profile:mapchange] updatePlayerAOI ${oldMap}->${newMap} took ${dt.toFixed(0)}ms`);
      }
    }
  } catch (error) {
    // Silently ignore map change errors
  }
}

export function getPlayerLayerInfo(playerId: string): { layerId: string | null; layerName: string | null } {
  const player = playerCache.get(playerId);
  if (!player || !player.aoi) {
    return { layerId: null, layerName: null };
  }

  const layerId = player.aoi.layerId;
  const layerName = layerId ? layerManager.getLayerName(layerId) : null;

  return { layerId, layerName };
}

export { layerManager };

interface AOIPlayer {
  id: string;
  username: string;
  aoi?: PlayerAOIState;
  wt?: any;
  location: { map: string; position: { x: number; y: number; direction?: string } };
  moving?: boolean;
  mounted?: boolean;
  mount_type?: string;
  casting?: boolean;
  isAdmin?: boolean;
  forceVisibleTo?: Set<string>;
  isStealth?: boolean;
  isNoclip?: boolean;
  stats?: any;
  isGuest?: boolean;
  userid?: string;
}

export async function syncPartyLayers(
  partyLeaderUsername: string,
  partyMemberUsernames: string[],
  playerCache: any,
  sendAnimationToFn: (targetWs: any, name: string, playerId: string) => Promise<void>
): Promise<void> {
  try {

    const allPlayers: { [id: string]: AOIPlayer } = playerCache.list();

    const leaderPlayer = Object.values(allPlayers).find((p: AOIPlayer) =>
      p.username && p.username.toLowerCase() === partyLeaderUsername.toLowerCase()
    );

    if (!leaderPlayer || !leaderPlayer.aoi) {
      return;
    }

    const onlineMembers: any[] = [];
    const memberPlayerIds: string[] = [];

    const usernameIndex = new Map<string, any>();
    for (const player of Object.values(allPlayers)) {
      if (player.username) {
        usernameIndex.set(player.username.toLowerCase(), player);
      }
    }

    const leaderLower = partyLeaderUsername.toLowerCase();
    for (const memberUsername of partyMemberUsernames) {
      if (memberUsername.toLowerCase() === leaderLower) {
        continue;
      }

      const memberPlayer = usernameIndex.get(memberUsername.toLowerCase());

      if (memberPlayer && memberPlayer.aoi) {
        onlineMembers.push(memberPlayer);
        memberPlayerIds.push(memberPlayer.id);
      }
    }

    if (onlineMembers.length === 0) {
      return;
    }

    const mapName = leaderPlayer.location.map.replaceAll(".json", "");

    const membersOnSameMap = onlineMembers.filter(m =>
      m.location.map.replaceAll(".json", "") === mapName
    );

    if (membersOnSameMap.length === 0) {
      return;
    }

    const memberIdsOnSameMap = membersOnSameMap.map(m => m.id);

    const targetLayerId = layerManager.syncPartyToLeaderLayer(
      leaderPlayer.id,
      memberIdsOnSameMap,
      mapName
    );

    if (!targetLayerId) {
      return;
    }

    const spawnBatchQueue = new Map<string, Map<string, any>>();
    const despawnBatchQueue = new Map<string, Set<string>>();

    const movedPlayers: any[] = [];

    for (const member of membersOnSameMap) {
      const oldLayerId = member.aoi?.layerId;
      const actualLayerId = layerManager.getPlayerLayer(member.id);

      if (actualLayerId && actualLayerId !== oldLayerId && member.aoi) {
        // The layer manager has already moved them; this brings the rest along.
        switchPlayerLayer(member, actualLayerId, despawnBatchQueue);
        movedPlayers.push({ player: member, oldLayerId });
      }
    }

    for (const { player } of movedPlayers) {
      await updatePlayerAOI(player, spawnBatchQueue, despawnBatchQueue);
    }

    let totalSpawns = 0;
    let totalDespawns = 0;

    for (const [playerId, spawnsMap] of spawnBatchQueue.entries()) {
      const player = playerCache.get(playerId);
      if (player && player.wt) {
        const spawnsArray = Array.from(spawnsMap.values());
        if (spawnsArray.length > 0) {
          totalSpawns += spawnsArray.length;
          sendLoadPlayersChunked(sendPacket, player.wt, spawnsArray, null);

          for (const spawnData of spawnsArray) {
            // A mirror that came into view is drawn too.
            const spawnedPlayer = entityById(spawnData.id);
            if (spawnedPlayer && spawnedPlayer.location?.position?.direction) {

              const direction = spawnedPlayer.location.position.direction;
              const walking = spawnedPlayer.moving || false;
              const mounted = spawnedPlayer.mounted || false;
              const mountType = spawnedPlayer.mount_type || "unicorn";
              const casting = spawnedPlayer.casting || false;

              let animationName: string;

              if (casting) {
                const castAction = walking ? "cast_walk" : "cast_idle";
                animationName = `player_${castAction}_${direction}.png`;
              } else if (mounted) {
                const action = walking ? "walk" : "idle";
                animationName = `mount_${mountType}_${action}_${direction}.png`;
              } else {
                const action = walking ? "walk" : "idle";
                animationName = `player_${action}_${direction}.png`;
              }

              await sendAnimationToFn(player.wt, animationName, spawnedPlayer.id);
            }
          }
        }
      }
    }

    for (const [playerId, despawnSet] of despawnBatchQueue.entries()) {
      const player = playerCache.get(playerId);
      if (player && player.wt) {
        if (despawnSet.size > 0) {
          totalDespawns += despawnSet.size;
          despawnSet.forEach((despawnPlayerId) => {
            forgetLook(player.wt, despawnPlayerId);
            sendPacket(player.wt, packetManager.despawnPlayer(despawnPlayerId, "map_change"));
          });
        }
      }
    }

  } catch (error) {
    // Silently ignore party layer sync errors
  }
}

export function startAutoPartyLayerSync(
  sendAnimationToFn: (targetWs: any, name: string, playerId: string) => Promise<void>
): void {
  setInterval(async () => {
    try {

      const allParties = await parties.getAllParties();

      if (!allParties || allParties.length === 0) {
        return;
      }

      const allPlayers = playerCache.list();

      const usernameIndex = new Map<string, any>();
      for (const player of Object.values(allPlayers)) {
        if (player.username) {
          usernameIndex.set(player.username.toLowerCase(), player);
        }
      }

      for (const party of allParties) {
        if (!party.leader || !party.members || party.members.length === 0) {
          continue;
        }

        const leaderPlayer = usernameIndex.get(party.leader.toLowerCase());

        if (!leaderPlayer || !leaderPlayer.aoi?.layerId) {
          continue;
        }

        const leaderLayerId = leaderPlayer.aoi.layerId;
        const leaderMapName = leaderPlayer.location.map.replaceAll(".json", "");

        const onlineMembers: any[] = [];
        let needsSync = false;
        const leaderLower = party.leader.toLowerCase();

        for (const memberUsername of party.members) {
          if (memberUsername.toLowerCase() === leaderLower) {
            continue;
          }

          const memberPlayer = usernameIndex.get(memberUsername.toLowerCase());

          if (memberPlayer && memberPlayer.aoi?.layerId) {
            const memberMapName = memberPlayer.location.map.replaceAll(".json", "");

            if (memberMapName === leaderMapName) {
              onlineMembers.push(memberPlayer);

              if (memberPlayer.aoi.layerId !== leaderLayerId) {
                needsSync = true;
              }
            }
          }
        }

        if (needsSync && onlineMembers.length > 0) {
          await syncPartyLayers(
            party.leader,
            party.members,
            playerCache,
            sendAnimationToFn
          );
        }
      }
    } catch (error) {
      // Silently ignore auto party sync errors
    }
  }, 15000);
}

export function startAutoLayerCondensation(
  sendAnimationToFn: (targetWs: any, name: string, playerId: string) => Promise<void>
): void {
  setInterval(() => condenseLayers(sendAnimationToFn), 300000);
}

// One condensation pass, per player and per block: every player on an overflow
// layer (above layer 1) moves to the lowest layer of their map with room in the
// block they stand in. Never to a higher-numbered layer, and whole-layer counts
// play no part (one layer of a big map spreads over many blocks). Lower layers
// go first, so a layer_3 player can take a place layer_2 players just left.
export async function condenseLayers(
  sendAnimationToFn: (targetWs: any, name: string, playerId: string) => Promise<void>
): Promise<void> {
  try {
    const overflowLayers = [...layerManager.getAllLayers().keys()]
      .filter((layerId) => !isBaseLayer(layerId))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (overflowLayers.length === 0) {
      return;
    }

    let condensed = false;
    const spawnBatchQueue = new Map<string, Map<string, any>>();
    const despawnBatchQueue = new Map<string, Set<string>>();

    for (const layerId of overflowLayers) {
      for (const playerId of layerManager.getPlayersInLayer(layerId)) {
        const player = playerCache.get(playerId);
        if (!player || !player.aoi) continue;

        // Counts are live, so players moved earlier in this pass are included.
        const targetLayerId = layerManager.lowerLayerWithRoom(playerId);
        if (!targetLayerId) continue;

        switchPlayerLayer(player, targetLayerId, despawnBatchQueue);
        await updatePlayerAOI(player, spawnBatchQueue, despawnBatchQueue);
        condensed = true;
      }
    }

    if (condensed) {

      for (const [playerId, spawnsMap] of spawnBatchQueue.entries()) {
        const player = playerCache.get(playerId);
        if (player && player.wt) {
          const spawnsArray = Array.from(spawnsMap.values());
          if (spawnsArray.length > 0) {
            sendLoadPlayersChunked(sendPacket, player.wt, spawnsArray, null);

            for (const spawnData of spawnsArray) {
              // A mirror that came into view is drawn too.
              const spawnedPlayer = entityById(spawnData.id);
              if (spawnedPlayer && spawnedPlayer.location?.position?.direction) {
                const direction = spawnedPlayer.location.position.direction;
                const walking = spawnedPlayer.moving || false;
                const mounted = spawnedPlayer.mounted || false;
                const mountType = spawnedPlayer.mount_type || "unicorn";
                const casting = spawnedPlayer.casting || false;

                let animationName: string;
                if (casting) {
                  const castAction = walking ? "cast_walk" : "cast_idle";
                  animationName = `player_${castAction}_${direction}.png`;
                } else if (mounted) {
                  const action = walking ? "walk" : "idle";
                  animationName = `mount_${mountType}_${action}_${direction}.png`;
                } else {
                  const action = walking ? "walk" : "idle";
                  animationName = `player_${action}_${direction}.png`;
                }

                await sendAnimationToFn(player.wt, animationName, spawnedPlayer.id);
              }
            }
          }
        }
      }

      for (const [playerId, despawnSet] of despawnBatchQueue.entries()) {
        const player = playerCache.get(playerId);
        if (player && player.wt && despawnSet.size > 0) {
          despawnSet.forEach((despawnPlayerId) => {
            forgetLook(player.wt, despawnPlayerId);
            sendPacket(player.wt, packetManager.despawnPlayer(despawnPlayerId, "map_change"));
          });
        }
      }

    }
  } catch (error) {
    // Silently ignore auto layer condensation errors
  }
}
