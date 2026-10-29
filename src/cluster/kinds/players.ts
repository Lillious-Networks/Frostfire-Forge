import AOI_CONFIG from "../../config/aoi.json";
import { AOI_UPDATE_MS } from "../../services/gameloop";
import playerCache from "../../services/playermanager";
import spatialGrid from "../../services/spatialgrid";
import * as aoiReverse from "../../services/aoiReverseIndex";
import { broadcastToAOI, broadcastToAOIBestEffort, canSee, dropMirrorViewers, queueSpawnPlayerPacket, updateMirrorViewers } from "../../socket/aoi";
import { getEffectsState } from "../../systems/spelleffects";
import type { GhostCandidate, GhostKind } from "../ghosts";
import { FLAG_MOVING, FLAG_STEALTH, directionCode, directionName } from "../linkproto";
import { mirrorPlayers } from "../mirrors";

// Players as mirrors (spec §3): the owner sends what a viewer's client is shown
// of a player; the mirror is a player-shaped record that AOI, spawn and movement
// sends read like a local player, but it is not in playerCache and has no socket.

export interface PlayerGhostDeps {
  queueMove(mirror: any, final: boolean): void;
  spawnQueue: Map<string, Map<string, any>>;
  despawnQueue: Map<string, Set<string>>;
}

const bare = (map: unknown) => {
  const name = String(map ?? "");
  return name.endsWith(".json") ? name.slice(0, -5) : name;
};

// Fields a GHOST_STATE may not touch: they are the mirror's own bookkeeping, or arrive by spawn and move only.
const KEPT = new Set(["id", "userid", "username", "location", "moving", "remote", "mirrorFrom", "aoi", "wt", "_viewersAt", "_stateStealth", "_moveStealth"]);
// A change to one of these can show or hide the player for a viewer, or move them to other viewers.
// isStealth is not here: the mirror's own value is worked out from two inputs (see stealthOf).
const VISIBILITY = ["isVanished", "isDead", "isGhost", "layerId"];

// A mirror's stealth has two inputs. The spawn record and GHOST_STATE are reliable and in order, so their
// value is the authority. The stealth flag on a move comes sooner, but datagrams are unordered and carry
// no sequence, so a late one may be stale. The mirror is stealthed while either says so: a move can hide
// the player at once, and a stale move without the flag can never show a player the state says is hidden.
// A stale move with the flag, after the stealth ended, is undone by the next move or keyframe without it.
const stealthOf = (mirror: any) => !!(mirror._stateStealth || mirror._moveStealth);

function shown(player: any) {
  return {
    isAdmin: !!player.isAdmin, isGuest: !!player.isGuest, isStealth: !!player.isStealth, isVanished: !!player.isVanished,
    isNoclip: !!player.isNoclip, isDead: !!player.isDead, isGhost: !!player.isGhost, ghostTeleportPending: !!player.ghostTeleportPending,
    stats: player.stats ?? null, mounted: !!player.mounted, mount_type: player.mount_type ?? null,
    guild: player.guild ?? null, guild_name: player.guild_name ?? null,
    equipment: player.equipment ?? null, equipmentRevision: player.equipmentRevision ?? 0,
    // party_id picks the corpse-loot owner for a tapper seen as a mirror (creatures/kill.ts), who has no party row here.
    casting: !!player.casting, party: [...(player.party ?? [])], party_id: player.party_id ?? null, pvp: !!player.pvp,
    // Times the effects run out, not seconds left: the state is compared every scan, and a countdown
    // would send every timed effect to the neighbours once a second.
    effects: getEffectsState(player),
  };
}

export function playerGhostRecord(player: any): any {
  const pos = player.location.position;
  return {
    id: String(player.id), userid: player.userid, username: player.username,
    layerId: player.aoi?.layerId ?? null,
    location: { map: bare(player.location.map), position: { x: Number(pos.x), y: Number(pos.y), direction: pos.direction ?? "down" } },
    moving: !!player.moving,
    ...shown(player),
  };
}

/**
 * The mirror of a player who is local here now (a relog, or a move to this node, while the old node's despawn
 * is still on its way): forget it without a word to viewers. The id is the local player's now, so are the
 * viewers' entries for it, and a despawn would hide the local player from them.
 */
function dropShadowed(id: string): void {
  if (!mirrorPlayers.delete(id)) return;
  // The grid entry is the mirror's only while the local player has not been filed under the id yet.
  if (spatialGrid.isRemote(id)) spatialGrid.removePlayer(id);
}

// A login takes the id over at once, before anything else from the old node reaches the mirror (relayed packets
// would otherwise go to the local player's viewers). Does nothing outside cluster mode: there are no mirrors.
playerCache.onAdd((key) => dropShadowed(String(key)));

export function playerGhostKind(deps: PlayerGhostDeps): GhostKind {
  const local = (id: string | number) => playerCache.get(String(id));

  const queueSpawn = (viewerId: string, mirror: any, spawnData: any) => {
    deps.despawnQueue.get(viewerId)?.delete(mirror.id);
    let queued = deps.spawnQueue.get(viewerId);
    if (!queued) deps.spawnQueue.set(viewerId, (queued = new Map()));
    queued.set(mirror.id, spawnData);
  };

  // A local stealth toggle despawns the player for the viewers who lose it and spawns it again for them on
  // the way back (socket/handlers/commands.ts, STEALTH). The owner's despawns and spawns go map-wide there, not through AOI, so
  // the mirror does the same for its own viewers when the hidden flag flips.
  // Unlike that handler, party members and forced viewers keep the player here, as AOI shows them.
  const hiddenChanged = (mirror: any, hidden: boolean) => {
    const spawnData = hidden ? null : queueSpawnPlayerPacket(mirror);
    if (!hidden && !spawnData) return;
    // The viewers who are shown it while hidden: they see no change.
    const asHidden = { id: mirror.id, username: mirror.username, isStealth: true };
    for (const viewerId of aoiReverse.getViewers(mirror.id)) {
      const viewer = playerCache.get(viewerId);
      if (!viewer?.wt || canSee(viewer, asHidden)) continue;
      if (hidden) {
        deps.spawnQueue.get(viewerId)?.delete(mirror.id);
        let queued = deps.despawnQueue.get(viewerId);
        if (!queued) deps.despawnQueue.set(viewerId, (queued = new Set()));
        queued.add(mirror.id);
      } else {
        queueSpawn(viewerId, mirror, spawnData);
      }
    }
  };

  const isHidden = (player: any) => !!(player?.isStealth || player?.isVanished);

  return {
    name: "player",
    // The movement writers report through Ghosts.touch (socket/handlers/movement.ts, socket/aoi.ts, relocate and the editor move in socket/receiver.ts); any other write shows at the keyframe.
    dirtyMarks: true,

    *candidates(band): Iterable<GhostCandidate> {
      for (const player of Object.values(playerCache.list()) as any[]) {
        const pos = player?.location?.position;
        if (!player?.aoi || !pos || player.remote) continue;
        const x = Number(pos.x);
        const y = Number(pos.y);
        // The band takes the map as the player has it (it reads a .json spelling itself), so no candidate is built
        // for a player it skips. Ghosts.scan checks again, for the kinds that do not filter.
        if (band && !band.near(String(player.location.map ?? ""), x, y)) continue;
        const map = bare(player.location.map);
        yield { id: String(player.id), num: Number(player.id), map, layerId: player.aoi.layerId ?? null, x, y };
      }
    },

    snapshot: (id) => {
      const player = local(id);
      return player?.location?.position ? playerGhostRecord(player) : null;
    },

    // layerId goes with the state: Ghosts starts a mirror over on a map change only, so a layer switch
    // reaches the mirror as a change here.
    state: (id) => {
      const player = local(id);
      return player ? { layerId: player.aoi?.layerId ?? null, ...shown(player) } : null;
    },

    motion: (id) => {
      const player = local(id);
      const pos = player?.location?.position;
      if (!pos) return null;
      return { x: Number(pos.x), y: Number(pos.y), dir: directionCode(pos.direction), flags: (player.isStealth ? FLAG_STEALTH : 0) | (player.moving ? FLAG_MOVING : 0) };
    },

    spawn: (record, from) => {
      const id = String(record?.id ?? "");
      const pos = record?.location?.position;
      if (!id || !pos || !Number.isFinite(Number(pos.x)) || !Number.isFinite(Number(pos.y))) return false;
      // A local player is never shadowed; an older mirror of the id is dropped.
      if (local(id)) {
        dropShadowed(id);
        return false;
      }
      const map = bare(record.location.map);
      const old = mirrorPlayers.get(id);
      const layerId = record.layerId ?? null;
      const aoi = old?.aoi ?? { playersInAOI: new Set<string>(), aoiRadius: AOI_CONFIG.DEFAULT_RADIUS, revision: 0 };
      aoi.layerId = layerId;
      // Sent again (after a link flap, say): the new record replaces the old one whole, so a field it leaves
      // out is gone here too.
      const mirror = {
        ...record,
        id,
        location: { map, position: { x: Number(pos.x), y: Number(pos.y), direction: pos.direction ?? "down" } },
        remote: true,
        mirrorFrom: from,
        aoi,
        _viewersAt: Date.now(),
        // The record is the owner's view at one moment, so the move input starts from it too.
        _stateStealth: !!record.isStealth,
        _moveStealth: !!record.isStealth,
        isStealth: !!record.isStealth,
      };
      mirrorPlayers.set(id, mirror);
      spatialGrid.addPlayer(id, mirror.location.position.x, mirror.location.position.y, map, true);
      if (old) {
        // Sent again after a gap (a link flap, or a new owner): what changed in it was never sent as a change.
        // The viewers who keep it lose or regain it as for a stealth toggle, and the rest are sent it afresh
        // for its look.
        if (isHidden(old) !== isHidden(mirror)) hiddenChanged(mirror, isHidden(mirror));
        const spawnData = queueSpawnPlayerPacket(mirror);
        for (const viewerId of spawnData ? aoiReverse.getViewers(id) : []) {
          const viewer = playerCache.get(viewerId);
          if (viewer?.wt && canSee(viewer, mirror)) queueSpawn(viewerId, mirror, spawnData);
        }
      }
      updateMirrorViewers(mirror, deps.spawnQueue, deps.despawnQueue);
    },

    // A handoff moved the player to another node: its mirror here now answers to that node.
    rehome: (id, owner) => {
      const mirror = mirrorPlayers.get(String(id));
      if (mirror) mirror.mirrorFrom = owner;
    },

    move: (id, x, y, dir, flags) => {
      const key = String(id);
      if (local(key)) return dropShadowed(key);
      const mirror = mirrorPlayers.get(key);
      if (!mirror) return;
      const pos = mirror.location.position;
      const direction = directionName(dir);
      const moving = (flags & FLAG_MOVING) !== 0;
      // The move carries the stealth flag, and comes sooner than the state scan: hide the mirror now, so its
      // steps and the owner's relayed packets are not sent to viewers who no longer see it. See stealthOf
      // for why a move without the flag shows it only when the state agrees.
      const moveStealth = (flags & FLAG_STEALTH) !== 0;
      if (moveStealth !== !!mirror._moveStealth) {
        const wasHidden = isHidden(mirror);
        mirror._moveStealth = moveStealth;
        mirror.isStealth = stealthOf(mirror);
        if (isHidden(mirror) !== wasHidden) {
          hiddenChanged(mirror, isHidden(mirror));
          mirror._viewersAt = Date.now();
          updateMirrorViewers(mirror, deps.spawnQueue, deps.despawnQueue);
        }
      }
      // A keyframe: nothing changed.
      if (pos.x === x && pos.y === y && pos.direction === direction && !!mirror.moving === moving) return;
      pos.x = x;
      pos.y = y;
      pos.direction = direction;
      mirror.moving = moving;
      spatialGrid.updatePlayer(key, x, y, mirror.location.map);
      deps.queueMove(mirror, !moving);
      // Throttled like a local walker's own AOI update, but always on a stop: no move follows it, so an
      // idle viewer the mirror stopped next to would otherwise never be told.
      const now = Date.now();
      if (!moving || now - (mirror._viewersAt ?? 0) >= AOI_UPDATE_MS) {
        mirror._viewersAt = now;
        updateMirrorViewers(mirror, deps.spawnQueue, deps.despawnQueue);
      }
    },

    update: (id, changes) => {
      const key = String(id);
      if (local(key)) return dropShadowed(key);
      const mirror = mirrorPlayers.get(key);
      if (!mirror) return;
      const hidden = isHidden(mirror);
      let visibility = false;
      for (const [field, value] of Object.entries(changes)) {
        if (KEPT.has(field)) continue;
        if (field === "isStealth") {
          mirror._stateStealth = !!value;
          continue;
        }
        if (VISIBILITY.includes(field) && (value ?? null) !== (mirror[field] ?? null)) visibility = true;
        // The owner sends a field whole (stats included); null is a field it dropped.
        if (value === null) delete mirror[field];
        else mirror[field] = value;
      }
      mirror.isStealth = stealthOf(mirror);
      if ("layerId" in changes) mirror.aoi.layerId = mirror.layerId ?? null;
      if (isHidden(mirror) !== hidden) visibility = true;
      if (!visibility) return;
      // Before the viewer update: a viewer it adds below is sent the right thing by it already.
      if (isHidden(mirror) !== hidden) hiddenChanged(mirror, isHidden(mirror));
      updateMirrorViewers(mirror, deps.spawnQueue, deps.despawnQueue);
    },

    relay: (id, packets, bestEffort) => {
      const key = String(id);
      if (local(key)) return dropShadowed(key);
      const mirror = mirrorPlayers.get(key);
      if (!mirror) return;
      // The stealth filter applies as for a local player.
      if (bestEffort) broadcastToAOIBestEffort(mirror, packets, false);
      else broadcastToAOI(mirror, packets, false);
    },

    despawn: (id) => {
      const key = String(id);
      if (local(key)) return dropShadowed(key);
      if (!mirrorPlayers.has(key)) return;
      if (spatialGrid.isRemote(key)) spatialGrid.removePlayer(key);
      dropMirrorViewers(key, deps.spawnQueue);
      aoiReverse.clearViewed(key);
      mirrorPlayers.delete(key);
    },
  };
}
