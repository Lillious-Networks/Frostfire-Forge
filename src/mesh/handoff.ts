// Avatar handoff (Phase 2.2): moves simulation authority between servers
// without the client ever disconnecting.
//
// Presence side: when a locally simulated player crosses into a region owned
// by a peer, its full avatar state is sent via HANDOFF_REQUEST. The owner
// builds a connection-less avatar ("remoteAvatar") and starts simulating it;
// the presence keeps the connection, marks the player "remoteSim", forwards
// client input (INPUT_FORWARD / INPUT_PACKET), and feeds the owner's
// MOVER_BATCH stream back into the local movement flush so the client keeps
// rendering itself. Ownership change is announced through the normal SPAWN
// broadcast, which re-points ghost authority on every other server.
//
// Fallbacks: while the roster is incomplete or the owner is unreachable,
// players stay locally simulated. When the authority dies, the presence
// resumes local simulation (resumeLocalSim).

import playerCache from "../services/playermanager.ts";
import mapIndex from "../services/mapindex.ts";
import spatialGrid from "../services/spatialgrid.ts";
import gameLoop from "../services/gameloop.ts";
import log from "../modules/logger.ts";
import { MeshMessageType } from "./protocol.ts";
import * as regions from "./regions.ts";
import type { MeshLinks } from "./links.ts";
import * as replication from "./replication.ts";
import { initializePlayerAOI, despawnPlayerFromAllAOI } from "../socket/aoi.ts";

export interface HandoffHooks {
  spawnBatchQueue: Map<string, Map<string, any>> | null;
  despawnBatchQueue: Map<string, Set<string>> | null;
  updatePlayerAOI: (player: any) => Promise<void>;
  buildSpawnData: (player: any) => Promise<any>;
}

export interface AvatarState {
  playerId: string;
  spawnData: any;
  runtime: {
    stats: any;
    pvp: boolean;
    mounted: boolean;
    mount_type: string | null;
    isStealth: boolean;
    isVanished: boolean;
    isNoclip: boolean;
    isAdmin: boolean;
    isGuest: boolean;
    party: string[] | null;
    guild: any[] | null;
    guild_name: string | null;
    equipment: any;
    equipmentRevision: number;
    spellCooldowns: Record<string, number>;
    castId: number;
    casting: boolean;
    stunnedUntil: number;
    slowPercent: number;
    slowMultiplier: number;
    last_attack: number | null;
    attackDelay: number;
  };
}

let meshLinks: MeshLinks | null = null;
let hooks: HandoffHooks = {
  spawnBatchQueue: null,
  despawnBatchQueue: null,
  updatePlayerAOI: async () => {},
  buildSpawnData: async () => null,
};

export function attachMeshLinks(links: MeshLinks | null): void {
  meshLinks = links;
}

export function attachHandoffHooks(partial: Partial<HandoffHooks>): void {
  hooks = { ...hooks, ...partial };
}

// ---------------------------------------------------------------------------
// Presence side

const HANDOFF_COOLDOWN_MS = 30000;
const HANDOFF_IMBALANCE_THRESHOLD = 10;

let localConnectionCount = 0;

export function setLocalConnectionCount(count: number): void {
  localConnectionCount = count;
}

/**
 * Load-aware authority assignment: a player's avatar migrates to the
 * least-loaded peer (by the connection counts exchanged over the mesh) when
 * the local server is meaningfully busier. Static region ownership was
 * replaced by this because real player distributions cluster (everyone spawns
 * in one region), which pinned the whole load on whichever server happened to
 * own the spawn region.
 */
export async function checkAndHandoff(player: any): Promise<void> {
  if (!meshLinks || !meshLinks.enabled) return;
  if (!player || player.remoteSim || player.handoffPending || player.remoteAvatar) return;
  if (!player.location?.position) return;

  const now = Date.now();
  if (player._lastHandoffAt && now - player._lastHandoffAt < HANDOFF_COOLDOWN_MS) return;

  const desired = meshLinks.getDesiredServerIds();
  if (!regions.isRosterComplete(desired)) return;

  const counts = replication.getPeerCounts();
  let bestServerId: string | null = null;
  let bestCount = Infinity;
  for (const serverId of desired) {
    const count = counts[serverId];
    if (typeof count !== "number") continue;
    if (count < bestCount) {
      bestCount = count;
      bestServerId = serverId;
    }
  }
  if (!bestServerId) return;

  const threshold = Math.max(HANDOFF_IMBALANCE_THRESHOLD, Math.floor(localConnectionCount * 0.15));
  if (localConnectionCount <= bestCount + threshold) return;

  player._lastHandoffAt = now;
  await initiateHandoff(player, bestServerId);
}

async function initiateHandoff(player: any, ownerServerId: string): Promise<void> {
  if (!meshLinks) return;

  let spawnData: any = null;
  try {
    spawnData = await hooks.buildSpawnData(player);
  } catch (error: any) {
    log.warn(`[Mesh] Handoff spawn data failed for ${player.username}: ${error?.message || error}`);
  }

  const state: AvatarState = {
    playerId: player.id,
    spawnData,
    runtime: {
      stats: player.stats || {},
      pvp: !!player.pvp,
      mounted: !!player.mounted,
      mount_type: player.mount_type || null,
      isStealth: !!player.isStealth,
      isVanished: !!player.isVanished,
      isNoclip: !!player.isNoclip,
      isAdmin: !!player.isAdmin,
      isGuest: !!player.isGuest,
      party: player.party || null,
      guild: player.guild || null,
      guild_name: player.guild_name || null,
      equipment: player.equipment || {},
      equipmentRevision: player.equipmentRevision || 0,
      spellCooldowns: player.spellCooldowns || {},
      castId: player.castId || 0,
      casting: !!player.casting,
      stunnedUntil: player.stunnedUntil || 0,
      slowPercent: player.slowPercent || 0,
      slowMultiplier: player.slowMultiplier || 1,
      last_attack: player.last_attack ?? null,
      attackDelay: player.attackDelay || 0,
    },
  };

  player.handoffPending = true;
  const sent = meshLinks.sendToServer(
    ownerServerId,
    MeshMessageType.HANDOFF_REQUEST,
    new TextEncoder().encode(JSON.stringify(state)),
    true
  );
  if (sent) {
    log.info(`[Mesh] Handoff requested for ${player.username} -> ${ownerServerId}`);
  } else {
    player.handoffPending = false;
  }
}

export function handleHandoffAccept(_payload: Uint8Array): void {
  // Presence keeps dual-simulating until COMPLETE; nothing to do on accept.
}

export function handleHandoffComplete(payload: Uint8Array): void {
  let message: any;
  try {
    message = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return;
  }
  const playerId = message?.playerId;
  if (typeof playerId !== "string") return;

  const player = playerCache.get(playerId);
  if (!player || !player.handoffPending) return;

  player.handoffPending = false;
  player.remoteSim = true;
  player.remoteAuthority = message.authority || null;

  gameLoop.unregisterMovingPlayer(player.id);
  player.moving = false;
  if (player._movementState) player._movementState = undefined;

  log.info(`[Mesh] Handoff complete: ${player.username} now simulated by ${player.remoteAuthority}`);
}

export function handleHandoffAbort(payload: Uint8Array): void {
  let message: any;
  try {
    message = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return;
  }
  const player = playerCache.get(String(message?.playerId || ""));
  if (!player) return;
  player.handoffPending = false;
  log.warn(`[Mesh] Handoff aborted for ${player.username}`);
}

// ---------------------------------------------------------------------------
// Authority side

export function handleHandoffRequest(fromServerId: string, payload: Uint8Array): void {
  if (!meshLinks) return;

  let state: AvatarState;
  try {
    state = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return;
  }
  if (!state || typeof state.playerId !== "string") return;

  const playerId = state.playerId;
  const existing = playerCache.get(playerId);
  if (existing && existing.remoteAvatar && existing.remotePresence === fromServerId) {
    // Duplicate request for an avatar we already own - re-acknowledge.
    sendAccept(playerId);
    sendComplete(playerId);
    return;
  }
  if (existing) {
    const abort = JSON.stringify({ playerId, reason: "avatar already exists" });
    meshLinks.sendToServer(fromServerId, MeshMessageType.HANDOFF_ABORT, new TextEncoder().encode(abort), true);
    return;
  }

  buildAvatar(fromServerId, state)
    .then(() => {
      sendAccept(playerId);
      return Promise.resolve();
    })
    .then(() => sendComplete(playerId))
    .catch((error: any) => {
      log.error(`[Mesh] Avatar build failed for ${playerId}: ${error?.message || error}`);
      const abort = JSON.stringify({ playerId, reason: "build failed" });
      meshLinks?.sendToServer(fromServerId, MeshMessageType.HANDOFF_ABORT, new TextEncoder().encode(abort), true);
    });
}

function sendAccept(playerId: string): void {
  if (!meshLinks) return;
  const owner = playerCache.get(playerId);
  if (!owner?.remotePresence) return;
  meshLinks.sendToServer(
    owner.remotePresence,
    MeshMessageType.HANDOFF_ACCEPT,
    new TextEncoder().encode(JSON.stringify({ playerId })),
    true
  );
}

function sendComplete(playerId: string): void {
  if (!meshLinks) return;
  const owner = playerCache.get(playerId);
  if (!owner?.remotePresence) return;
  meshLinks.sendToServer(
    owner.remotePresence,
    MeshMessageType.HANDOFF_COMPLETE,
    new TextEncoder().encode(JSON.stringify({ playerId, authority: localServerId })),
    true
  );
}

let localServerId = "";
export function initHandoff(serverId: string): void {
  localServerId = serverId;
}

async function buildAvatar(fromServerId: string, state: AvatarState): Promise<void> {
  const spawn = state.spawnData || {};
  const location = spawn.location || {};
  const mapName = (location.map || "").replaceAll(".json", "");
  const runtime = state.runtime;

  const avatar: any = {
    username: spawn.username || "",
    animation: null,
    isAdmin: runtime.isAdmin,
    isStealth: runtime.isStealth,
    isNoclip: runtime.isNoclip,
    id: state.playerId,
    userid: spawn.userid ?? null,
    location: {
      map: mapName,
      position: {
        x: Math.round(Number(location.x) || 0),
        y: Math.round(Number(location.y) || 0),
        direction: location.direction || "down",
        moving: false,
      },
    },
    language: "en",
    ws: null,
    stats: runtime.stats,
    friends: [],
    attackDelay: runtime.attackDelay,
    lastMovementPacket: null,
    permissions: [],
    pvp: runtime.pvp,
    last_attack: runtime.last_attack,
    invitations: [],
    party_id: null,
    party: runtime.party,
    guild_id: null,
    guild: runtime.guild,
    guild_name: runtime.guild_name,
    currency: { copper: 0, silver: 0, gold: 0 },
    isGuest: runtime.isGuest,
    created: performance.now(),
    lastUpdated: performance.now(),
    mounted: runtime.mounted,
    mount_type: runtime.mount_type,
    collectables: [],
    spellCooldowns: runtime.spellCooldowns,
    casting: runtime.casting,
    lastInterruptTime: 0,
    interruptableSpell: false,
    castId: runtime.castId,
    stunnedUntil: runtime.stunnedUntil,
    spellLockoutUntil: 0,
    slowPercent: runtime.slowPercent,
    slowMultiplier: runtime.slowMultiplier,
    isVanished: runtime.isVanished,
    learnedSpells: {},
    inventory: [],
    equipment: runtime.equipment,
    equipmentRevision: runtime.equipmentRevision,
    remoteAvatar: true,
    remotePresence: fromServerId,
  };

  playerCache.add(avatar.id, avatar);

  await initializePlayerAOI(avatar);
  mapIndex.addPlayer(avatar.id, mapName);

  await hooks.updatePlayerAOI(avatar);

  // Re-publish so every server re-points this player's ghost at us.
  if (state.spawnData) {
    replication.publishPlayerSpawn(avatar, state.spawnData);
  }

  log.info(`[Mesh] Avatar ${avatar.username} (${avatar.id}) now simulated here (presence: ${fromServerId})`);
}

export function cleanupAvatar(avatar: any): void {
  if (!avatar || !avatar.remoteAvatar) return;
  try {
    gameLoop.unregisterMovingPlayer(avatar.id);
    despawnPlayerFromAllAOI(avatar, "disconnect", hooks.despawnBatchQueue ?? undefined);
    spatialGrid.removePlayer(avatar.id);
    mapIndex.removePlayer(avatar.id);
    playerCache.remove(avatar.id);
    log.info(`[Mesh] Avatar ${avatar.username} removed (presence left)`);
  } catch (error: any) {
    log.error(`[Mesh] Avatar cleanup failed: ${error?.message || error}`);
  }
}

export function resumeLocalSim(player: any): void {
  if (!player || !player.remoteSim) return;
  player.remoteSim = false;
  player.remoteAuthority = null;
  player.handoffPending = false;

  spatialGrid.addPlayer(
    player.id,
    player.location.position.x,
    player.location.position.y,
    player.location.map.replaceAll(".json", "")
  );

  log.warn(`[Mesh] Authority for ${player.username} lost - resuming local simulation`);
  if (hooks.buildSpawnData) {
    hooks.buildSpawnData(player)
      .then((spawnData) => {
        if (spawnData) replication.publishPlayerSpawn(player, spawnData);
      })
      .catch(() => {});
  }
}

// True when the local player's avatar is currently simulated by a peer.
export function isRemoteSim(player: any): boolean {
  return !!player?.remoteSim;
}

/**
 * A DESPAWN arrived for a player id. On the authority this removes the avatar
 * (presence disconnected); elsewhere it is a no-op (ghost cleanup is handled
 * by replication).
 */
export function handleAuthorityDespawn(serverId: string, playerId: string): void {
  const player = playerCache.get(playerId);
  if (!player) return;

  if (player.remoteAvatar) {
    cleanupAvatar(player);
    return;
  }

  // Presence-side safety net: if our own authority explicitly dropped the
  // avatar (rare - usually the peer-down path handles it), resume locally.
  if (player.remoteSim && player.remoteAuthority === serverId) {
    resumeLocalSim(player);
  }
}

/** A mesh peer went down: resume local simulation for avatars it hosted. */
export function handleAuthorityDown(serverId: string): void {
  const players = Object.values(playerCache.list());
  for (const player of players) {
    if (player.remoteSim && player.remoteAuthority === serverId) {
      resumeLocalSim(player);
    }
  }
}
