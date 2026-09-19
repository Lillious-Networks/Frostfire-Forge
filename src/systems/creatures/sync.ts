import { aurasPayload } from "./auras";
import { SYNC_EXIT_HYSTERESIS } from "./constants";

import { CreatureRegistry } from "./registry";
import type { CreatureInstance, CreatureMoveEntry, CreatureSnapshot, CreatureTemplate } from "./types";

/**
 * Creature spawns sent to one player per AOI refresh. A player arriving in a
 * dense area gets them over a few refreshes (300ms apart) rather than paying
 * for hundreds of snapshots in a single tick.
 */
const MAX_ENTER_PER_REFRESH = 150;

const EMPTY: ReadonlySet<string> = new Set();

/** Stable bucket for a player id, so each player lands in the same slice every cycle. */
function sliceOf(playerId: string, slices: number): number {
  let hash = 0;
  for (let i = 0; i < playerId.length; i++) hash = (hash * 31 + playerId.charCodeAt(i)) | 0;
  return Math.abs(hash) % slices;
}

export function toSnapshot(instance: CreatureInstance, template: CreatureTemplate): CreatureSnapshot {
  return {
    id: instance.id,
    templateId: instance.templateId,
    name: template.name,
    subname: template.subname,
    level: instance.level,
    rank: template.rank,
    stance: template.stance,
    creatureType: template.creature_type,
    health: instance.health,
    maxHealth: instance.maxHealth,
    x: Math.round(instance.x),
    y: Math.round(instance.y),
    dir: instance.dir,
    moving: instance.move !== null,
    state: instance.state,
    victimId: instance.combat.threat.victimId,
    tap: instance.combat.tapper ? "other" : "none",
    lootable: false,
    casting: instance.casting
      ? {
          spell: instance.casting.spellName,
          durationMs: instance.casting.endsAt - instance.casting.startedAt,
          remainingMs: Math.max(0, instance.casting.endsAt - Date.now()),
          targetId: instance.casting.target.kind === "creature" ? `creature:${instance.casting.target.id}` : instance.casting.target.id,
        }
      : null,
    auras: aurasPayload(instance.auras, Date.now()),
    spriteType: template.sprite_type,
    sprite: template.sprite,
    spriteLayers: null,
    scale: template.scale,
  };
}

/**
 * Which creatures a viewer should start / stop seeing. Enter uses the plain
 * radius; exit uses radius * hysteresis so creatures near the edge don't churn.
 */
export function diffVisibility(
  known: ReadonlySet<number>,
  nearby: Iterable<CreatureInstance>,
  stillInExitRange: (id: number) => boolean
): { enter: number[]; exit: number[] } {
  const enter: number[] = [];
  const exit: number[] = [];
  const nearbyIds = new Set<number>();
  for (const c of nearby) {
    nearbyIds.add(c.id);
    if (!known.has(c.id)) enter.push(c.id);
  }
  for (const id of known) {
    if (!nearbyIds.has(id) && !stillInExitRange(id)) exit.push(id);
  }
  return { enter, exit };
}

/** Shared creatures are visible from every layer; layered ones only from their own. */
export const visibleOnLayer = (c: CreatureInstance, layerId: string | null): boolean =>
  c.layerId === null || c.layerId === layerId;

export interface SyncPlayer {
  id: string;
  wt: any;
  map: string;
  layerId: string | null;
  x: number;
  y: number;
  radius: number;
}

export interface SyncDeps {
  registry: CreatureRegistry;
  getTemplate(id: number): CreatureTemplate | undefined;
  /** Every connected, in-world player id on `map`. */
  playersOnMap(map: string): Iterable<string>;
  /** Resolve a player id to its sync view, or null if gone / not in world. */
  resolvePlayer(id: string): SyncPlayer | null;
  sendSpawn(wt: any, snapshots: CreatureSnapshot[]): void;
  sendDespawn(wt: any, ids: number[]): void;
  /** Position updates; `reliable` is used for stop packets so final positions are never lost. */
  sendMoves(wt: any, entries: CreatureMoveEntry[], reliable: boolean): void;
  /** Per-viewer fields (tap state, lootable) applied to snapshots before sending. */
  decorate?(snapshot: CreatureSnapshot, creature: CreatureInstance, playerId: string): void;
}

interface ViewerState {
  map: string;
  layerId: string | null;
  ids: Set<number>;
}

export class CreatureSync {
  private viewers = new Map<string, ViewerState>();
  /** creature id -> players who currently see it */
  private observers = new Map<number, Set<string>>();

  constructor(private readonly deps: SyncDeps) {}

  /** Ids of creatures a player currently knows about (for tests / debug). */
  knownBy(playerId: string): ReadonlySet<number> {
    return this.viewers.get(playerId)?.ids ?? new Set();
  }

  /** Creatures at least one player can see; everything else is dormant. */
  observedIds(): IterableIterator<number> {
    return this.observers.keys();
  }

  isObserved(id: number): boolean {
    return this.observers.has(id);
  }

  forget(playerId: string): void {
    const state = this.viewers.get(playerId);
    if (!state) return;
    for (const id of state.ids) this.unobserve(id, playerId);
    this.viewers.delete(playerId);
  }

  /**
   * Recompute visibility for players in one slice of the population.
   *
   * Every player still gets refreshed once per `slices` calls, but the work is
   * spread across ticks instead of landing on one: with hundreds of players,
   * each doing a radius query over a crowded map, doing them all together was
   * the single most expensive thing in the creature tick.
   */
  refresh(slice = 0, slices = 1): void {
    const maps = new Set<string>(this.deps.registry.mapsWithCreatures());
    for (const v of this.viewers.values()) maps.add(v.map);

    const seen = new Set<string>();
    for (const map of maps) {
      for (const playerId of this.deps.playersOnMap(map)) {
        if (seen.has(playerId)) continue;
        seen.add(playerId);
        if (slices > 1 && sliceOf(playerId, slices) !== slice) continue;
        const player = this.deps.resolvePlayer(playerId);
        if (player) this.refreshPlayer(player);
      }
    }

    // Anyone we track who wasn't on one of those maps has left the world or
    // moved to a map without creatures. The client clears its creature list on
    // LOAD_MAP, so they are simply forgotten without a despawn packet. `seen`
    // holds every player on those maps, not just this slice, so this stays
    // correct when slicing.
    for (const playerId of [...this.viewers.keys()]) {
      if (!seen.has(playerId)) this.forget(playerId);
    }
  }

  refreshPlayer(player: SyncPlayer): void {
    let state = this.viewers.get(player.id);
    if (state && state.map === player.map && state.layerId !== player.layerId) {
      // Same map, new layer: the client keeps its list, so despawn the old layer's copies.
      const stale = [...state.ids].filter((id) => {
        const c = this.deps.registry.get(id);
        return !c || !visibleOnLayer(c, player.layerId);
      });
      for (const id of stale) {
        state.ids.delete(id);
        this.unobserve(id, player.id);
      }
      if (stale.length > 0) this.deps.sendDespawn(player.wt, stale);
      state.layerId = player.layerId;
    }
    if (!state || state.map !== player.map) {
      if (state) this.forget(player.id);
      state = { map: player.map, layerId: player.layerId, ids: new Set() };
      this.viewers.set(player.id, state);
    }

    const nearby = this.deps.registry
      .queryRadius(player.map, player.x, player.y, player.radius)
      .filter((c) => visibleOnLayer(c, player.layerId));
    const exitR = player.radius * SYNC_EXIT_HYSTERESIS;
    const exitR2 = exitR * exitR;
    const { enter, exit } = diffVisibility(state.ids, nearby, (id) => {
      const c = this.deps.registry.get(id);
      if (!c || c.map !== player.map || !visibleOnLayer(c, player.layerId)) return false;
      const dx = c.x - player.x;
      const dy = c.y - player.y;
      return dx * dx + dy * dy <= exitR2;
    });

    if (exit.length > 0) {
      for (const id of exit) {
        state.ids.delete(id);
        this.unobserve(id, player.id);
      }
      this.deps.sendDespawn(player.wt, exit);
    }

    if (enter.length > 0) {
      const snapshots: CreatureSnapshot[] = [];
      // Entering a crowded map would otherwise build every snapshot in one
      // tick - hundreds of them, blowing well past the 100ms budget. Spread
      // the backlog over the next few refreshes instead; the rest are picked
      // up on the following pass because they stay outside `state.ids`.
      const batch = enter.length > MAX_ENTER_PER_REFRESH ? enter.slice(0, MAX_ENTER_PER_REFRESH) : enter;
      for (const id of batch) {
        const c = this.deps.registry.get(id);
        const t = c ? this.deps.getTemplate(c.templateId) : undefined;
        if (!c || !t) continue;
        state.ids.add(id);
        this.observe(id, player.id);
        const snapshot = toSnapshot(c, t);
        this.deps.decorate?.(snapshot, c, player.id);
        snapshots.push(snapshot);
      }
      if (snapshots.length > 0) this.deps.sendSpawn(player.wt, snapshots);
    }
  }

  /** Push a freshly spawned creature to players already in range. */
  onSpawn(instance: CreatureInstance): void {
    for (const playerId of this.deps.playersOnMap(instance.map)) {
      const player = this.deps.resolvePlayer(playerId);
      if (!player || !visibleOnLayer(instance, player.layerId)) continue;
      const dx = instance.x - player.x;
      const dy = instance.y - player.y;
      if (dx * dx + dy * dy > player.radius * player.radius) continue;
      this.refreshPlayer(player);
    }
  }

  /** Tell everyone who knew about a creature that it is gone. */
  onDespawn(instance: CreatureInstance): void {
    for (const [playerId, state] of this.viewers) {
      if (!state.ids.delete(instance.id)) continue;
      const player = this.deps.resolvePlayer(playerId);
      if (player) this.deps.sendDespawn(player.wt, [instance.id]);
    }
    this.observers.delete(instance.id);
  }

  /**
   * Send position changes for creatures that moved (best-effort) or stopped
   * (reliable) since the last call, to the players who can see them.
   */
  flushMoves(candidates: Iterable<CreatureInstance>): void {
    const moving = new Map<number, CreatureMoveEntry>();
    const stopped = new Map<number, CreatureMoveEntry>();
    for (const c of candidates) {
      const isMoving = c.move !== null;
      const x = Math.round(c.x);
      const y = Math.round(c.y);
      const changed = x !== c.sentX || y !== c.sentY || c.dir !== c.sentDir;
      if (!changed && isMoving === c.sentMoving) continue;
      const entry: CreatureMoveEntry = [c.id, x, y, c.dir, isMoving ? 1 : 0];
      (isMoving ? moving : stopped).set(c.id, entry);
      c.sentX = x;
      c.sentY = y;
      c.sentDir = c.dir;
      c.sentMoving = isMoving;
    }
    if (moving.size === 0 && stopped.size === 0) return;

    for (const [playerId, state] of this.viewers) {
      let movingOut: CreatureMoveEntry[] | null = null;
      let stoppedOut: CreatureMoveEntry[] | null = null;
      for (const id of state.ids) {
        const m = moving.get(id);
        if (m) (movingOut ??= []).push(m);
        const s = stopped.get(id);
        if (s) (stoppedOut ??= []).push(s);
      }
      if (!movingOut && !stoppedOut) continue;
      const player = this.deps.resolvePlayer(playerId);
      if (!player) continue;
      if (movingOut) this.deps.sendMoves(player.wt, movingOut, false);
      if (stoppedOut) this.deps.sendMoves(player.wt, stoppedOut, true);
    }
  }

  /** Players who can currently see a creature. */
  viewersOf(id: number): ReadonlySet<string> {
    return this.observers.get(id) ?? EMPTY;
  }

  /** Send packets to every player who can see the creature. */
  sendToViewers(id: number, send: (wt: any) => void): void {
    const viewers = this.observers.get(id);
    if (!viewers) return;
    for (const playerId of viewers) {
      const player = this.deps.resolvePlayer(playerId);
      if (player) send(player.wt);
    }
  }

  private observe(id: number, playerId: string): void {
    let set = this.observers.get(id);
    if (!set) {
      set = new Set();
      this.observers.set(id, set);
    }
    set.add(playerId);
  }

  private unobserve(id: number, playerId: string): void {
    const set = this.observers.get(id);
    if (!set) return;
    set.delete(playerId);
    if (set.size === 0) this.observers.delete(id);
  }
}
