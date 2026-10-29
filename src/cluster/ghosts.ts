import log from "../modules/logger";
import {
  GHOST_MOVES_PER_DATAGRAM, decodeGhostMoves, encodeGhostMoves, fromWire, idNumber, toWire, type GhostMoveEntry,
} from "./linkproto";
import type { LinkSender } from "./linktransport";
import { MirrorStore, type MirrorEntry } from "./mirrors";
import type { BorderBand } from "./strip";

// Mirroring (spec §3). The owner side looks at its entities every 100 ms and
// tells each neighbour that should hold a copy: GHOST_SPAWN when one comes
// within reach, GHOST_STATE when what it shows changes, GHOST_DESPAWN when it
// leaves; positions go every tick as GHOST_MOVE datagrams. The receiving side
// hands each message to the adapter of that kind. Nothing here knows what a
// player or a creature is: kinds plug in through GhostKind.

/**
 * How long a mirror that was dropped because its entity arrived here is refused a GHOST_SPAWN. Ghost frames ride the bulk
 * lane of the link, behind a backlog of up to 4 x 4 MB (wtlinks.ts), while the handoff or block move that brought the
 * entity here rides the control lane: a spawn sent before the entity left its old node can land after the entity arrived
 * here, and even after it died or moved on, and would make a mirror nothing ever despawns. A minute is well above what
 * that backlog takes to drain at link speed. An entity that really goes back to that peer clears its tombstone at once
 * (handOver), so a legitimate spawn is not refused.
 */
export const GHOST_TOMBSTONE_MS = 60_000;
/** The most tombstones kept; the oldest go first. */
const GHOST_TOMBSTONE_MAX = 4096;

export type GhostKindName = "player" | "creature" | "loot" | "chest" | "gather" | "skeleton" | "groundaoe" | "tornado";

export interface GhostCandidate {
  /** The entity's id. Ghosts.relay must be given the same id, of the same type. */
  id: string | number;
  num: number;
  map: string;
  layerId: string | null;
  x: number;
  y: number;
}

export interface GhostMotion {
  x: number;
  y: number;
  dir: number;
  flags: number;
}

export interface GhostKind {
  name: GhostKindName;
  /**
   * Owner side: every entity of this kind this node owns (the publisher picks those near a border). Given the
   * border band, a kind may leave out the entities outside it: one that is not listed is not visited, and the
   * scan releases any mirror it had.
   */
  candidates(band?: BorderBand): Iterable<GhostCandidate>;
  /** Owner side: the full record a neighbour needs to show it (JSON-safe). */
  snapshot(id: string | number): unknown | null;
  /** Owner side: the fields that change (hp, auras, stealth...), compared field by field each scan. */
  state?(id: string | number): Record<string, unknown> | null;
  /** Owner side: position for GHOST_MOVE. Kinds that never move leave it out. */
  motion?(id: string | number): GhostMotion | null;
  /**
   * The kind calls `Ghosts.touch(kind, id)` whenever an entity's position, direction or movement flags change. The
   * tick then reads `motion` only for touched entities, a fresh spawn, and entities whose keyframe is due. A write
   * the kind misses is shown at the next keyframe at the latest. Touched entities go before the due keyframes, so a crowd
   * that fills the budget every tick delays the keyframes of unmoved entities. A kind that leaves this out is read every tick.
   */
  dirtyMarks?: boolean;
  /**
   * Receiving side: a new mirror, or a known one sent again (update it in place). Return false to refuse it
   * (its id is a local entity here, say): nothing is recorded, so no move, update or despawn follows for it.
   */
  spawn(record: any, from: string): boolean | void;
  move?(id: string | number, x: number, y: number, dir: number, flags: number): void;
  /** Receiving side: only the fields that changed. A null value is a field the owner dropped (or set to null): clear it. */
  update?(id: string | number, changes: Record<string, unknown>): void;
  /** Receiving side: client packets the owner sent to the entity's viewers, for the viewers here. */
  relay?(id: string | number, packets: Uint8Array[], bestEffort: boolean): void;
  despawn(id: string | number, reason: string): void;
  /** The mirror of `id` belongs to `owner` now (a handoff moved the entity): update what the kind keeps of its owner. */
  rehome?(id: string | number, owner: string): void;
}

export type MirrorTargetsFn = (map: string, x: number, y: number, previous: ReadonlySet<string>) => ReadonlySet<string>;

export interface GhostTiming {
  scanMs?: number;
  /** A kind with more tracked entities than this has its state compared 1/stateSlices of them per scan. Default 200. */
  spreadAbove?: number;
  /** How many scans one round of state comparisons is spread over. Default 5. */
  stateSlices?: number;
  keyframeMs?: number;
  expireMs?: number;
  /** How long a mirror handed over to a new owner is kept while that owner has not sent it again. Default 10_000. */
  handoverExpireMs?: number;
  datagramsPerTick?: number;
  now?: () => number;
}

interface Tracked {
  kind: GhostKindName;
  id: string | number;
  num: number;
  map: string;
  /** Neighbours that hold a mirror of it. */
  peers: Set<string>;
  /** Last state sent, per field, as JSON. */
  state: Record<string, string> | null;
  /** The fields of `state` that were primitive, as sent: an equal value needs no JSON. */
  prim: Record<string, unknown> | null;
  /** Fields in `state`. */
  stateSize: number;
  /** Which scans compare its state when they are spread: (scanGen + slot) % slices === 0. */
  slot: number;
  /** Last motion sent; null until one is sent after a GHOST_SPAWN. */
  motion: GhostMotion | null;
  motionAt: number;
  /** The scan that last saw it among its kind's candidates. */
  scanGen: number;
  /** Its place in Ghosts' list, least recently sent first (flushTick's order). */
  prev: Tracked | null;
  next: Tracked | null;
  listed: boolean;
  /** The kind marks its moves (GhostKind.dirtyMarks): it is in the aware list and read only when dirty or due. */
  aware: boolean;
  /** In the dirty array, waiting for the next tick. */
  dirty: boolean;
  /** The tick that last read its motion. */
  flushGen: number;
}

/** A list of Tracked, least recently sent first. */
class TrackedList {
  head: Tracked | null = null;
  tail: Tracked | null = null;
  size = 0;

  add(tracked: Tracked): void {
    if (tracked.listed) return;
    tracked.prev = this.tail;
    tracked.next = null;
    if (this.tail) this.tail.next = tracked;
    else this.head = tracked;
    this.tail = tracked;
    tracked.listed = true;
    this.size++;
  }

  remove(tracked: Tracked): void {
    if (!tracked.listed) return;
    if (tracked.prev) tracked.prev.next = tracked.next;
    else this.head = tracked.next;
    if (tracked.next) tracked.next.prev = tracked.prev;
    else this.tail = tracked.prev;
    tracked.prev = tracked.next = null;
    tracked.listed = false;
    this.size--;
  }

  clear(): void {
    this.head = this.tail = null;
    this.size = 0;
  }
}

const NO_PEERS: ReadonlySet<string> = new Set();

export class Ghosts {
  private kinds = new Map<GhostKindName, GhostKind>();
  /** Entities with at least one peer, by kind, then by id as the kind gives it. */
  private tracked = new Map<GhostKindName, Map<string | number, Tracked>>();
  /**
   * The same entities in a list, least recently sent a move first (flushTick's order). A list, not a Set: an entity
   * that moves goes to the back every tick, and a Set that loses and gains a member each time churns its table.
   */
  private plain = new TrackedList();
  /** The entities of kinds that mark their moves: flushTick reads only the dirty ones and those whose keyframe is due. */
  private aware = new TrackedList();
  /** Entities touched since the last tick (each once: Tracked.dirty). Holds only tracked entities, and is emptied by the tick. */
  private dirtyList: Tracked[] = [];
  private flushGen = 0;
  private scanGen = 0;
  private slotSeq = 0;
  private mirrors = new MirrorStore();
  /** Entities that arrived here (kind|id): the peer whose mirror was dropped (null: none was there) and until when its spawn is refused. */
  private tombstones = new Map<string, { from: string | null; until: number }>();
  private links: LinkSender | null = null;
  private targets: MirrorTargetsFn | null = null;
  private band: BorderBand | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly scanMs: number;
  private readonly spreadAbove: number;
  private readonly stateSlices: number;
  private readonly keyframeMs: number;
  private readonly expireMs: number;
  private readonly handoverExpireMs: number;
  private readonly datagramsPerTick: number;
  private readonly now: () => number;

  constructor(timing: GhostTiming = {}) {
    this.scanMs = timing.scanMs ?? 100;
    this.spreadAbove = timing.spreadAbove ?? 200;
    this.stateSlices = Math.max(1, Math.floor(timing.stateSlices ?? 5));
    this.keyframeMs = timing.keyframeMs ?? 500;
    this.expireMs = timing.expireMs ?? 2000;
    this.handoverExpireMs = timing.handoverExpireMs ?? 10_000;
    this.datagramsPerTick = timing.datagramsPerTick ?? 16;
    this.now = timing.now ?? Date.now;
  }

  register(kind: GhostKind): void {
    this.kinds.set(kind.name, kind);
  }

  /** With a `band`, the scan visits only entities near a block of another node (see BorderBand). Without one, all. */
  attach(links: LinkSender, targets: MirrorTargetsFn, band?: BorderBand): void {
    if (this.links) this.detach();
    // A LinkSender cannot take a handler back: each one checks that its links are still the attached ones,
    // so nothing reaches a kind after detach (or from an earlier attach).
    const live = () => this.links === links;
    // Handlers first: if the links refuse one (NodeLinks throws on a second handler), nothing is attached.
    links.on("GHOST_SPAWN", (data, from) => { if (live()) this.onSpawn(data, from); });
    links.on("GHOST_STATE", (data, from) => { if (live()) this.onState(data, from); });
    links.on("GHOST_DESPAWN", (data, from) => { if (live()) this.onDespawn(data, from); });
    links.on("GHOST_HANDOVER", (data, from) => { if (live()) this.onHandover(data, from); });
    links.onDatagram((data, from) => { if (live()) this.onMoves(data, from); });
    // An up may be a link replaced by a new HELLO with no down before it (the peer may have restarted, or
    // dropped us first): start over with that peer either way. On a first up there is nothing to forget.
    links.onPeerUp((peer) => { if (live()) this.forgetPeer(peer); });
    links.onPeerDown((peer) => { if (live()) this.forgetPeer(peer); });
    this.links = links;
    this.targets = targets;
    this.band = band ?? null;
    const timer = setInterval(() => this.scan(), this.scanMs);
    (timer as any).unref?.();
    this.timers.add(timer);
  }

  detach(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.links = null;
    this.targets = null;
    this.band = null;
    this.tracked.clear();
    this.plain.clear();
    this.aware.clear();
    this.dirtyList = [];
    for (const entry of this.mirrors.all()) this.despawnHere(entry.num, "detached");
    this.mirrors.clear();
  }

  mirrorCount(): number {
    return this.mirrors.size;
  }

  /** The node a mirrored entity of `kind` came from: where an action on it is sent. Null when it is not mirrored here. */
  ownerOf(kind: GhostKindName, id: string | number): string | null {
    const entry = this.mirrors.get(idNumber(id));
    return entry && entry.kind === kind && String(entry.id) === String(id) ? entry.from : null;
  }

  // ------------------------------------------------------------ owner side

  scan(): void {
    const links = this.links;
    const targets = this.targets;
    if (!links || !targets) return;
    const gen = ++this.scanGen;
    let band = this.band;
    // With no map bordering another node, nothing is a candidate: only the release below runs.
    let looking = true;
    if (band) {
      try {
        band.refresh();
        looking = band.anyBorder();
      } catch (error) {
        // No band this scan: every entity is looked at, as without one.
        log.error(`Mirrors: the border band failed: ${error}`);
        band = null;
      }
    }
    for (const kind of this.kinds.values()) {
      let byId = this.tracked.get(kind.name);
      if (!byId) this.tracked.set(kind.name, (byId = new Map()));
      // A kind with a crowd tracked has its state compared a slice per scan: the rest of the work (who is seen, who
      // holds a mirror, the release below) is every scan, so only a field change can take up to `slices` scans to go out.
      const slices = byId.size > this.spreadAbove ? this.stateSlices : 1;
      try {
        if (looking) for (const candidate of kind.candidates(band ?? undefined)) {
          if (!(candidate.num >= 0)) continue;
          // The band check is inside the try with the rest: one bad candidate (a map that is no string) must not
          // end the list, or the release below would not run for the kind.
          try {
            // Not seen, so released below if it was mirrored (it is out of reach of every peer now).
            if (band && !band.near(candidate.map, candidate.x, candidate.y)) continue;
            this.scanOne(kind, byId, candidate, links, targets, gen, slices);
          } catch (error) {
            log.error(`Mirrors: ${kind.name} ${candidate.id} failed: ${error}`);
            // A failure on one entity is not "gone": scanOne marks it seen first, but the band check may be what threw.
            const known = byId.get(candidate.id);
            if (known) known.scanGen = gen;
          }
        }
      } catch (error) {
        // Not a full list: keep what is tracked rather than call it all gone.
        log.error(`Mirrors: ${kind.name} candidates failed: ${error}`);
        continue;
      }
      // Every mirrored entity not visited this scan is released: it was removed, or it is outside the band (or
      // its map has no border) now, where no peer can hold a mirror. This is the only way a mirror goes when
      // the scan skips an entity, so it covers all of `byId`, not just what the kinds listed.
      for (const tracked of byId.values()) {
        if (tracked.scanGen === gen) continue;
        this.despawnEverywhere(tracked, "gone");
        this.untrack(tracked);
      }
    }
  }

  private scanOne(
    kind: GhostKind, byId: Map<string | number, Tracked>, candidate: GhostCandidate,
    links: LinkSender, targets: MirrorTargetsFn, gen: number, slices: number,
  ): void {
    let tracked = byId.get(candidate.id);
    // Seen before anything here can throw: a failure on one entity is not "gone".
    if (tracked) tracked.scanGen = gen;
    if (tracked && tracked.map !== candidate.map) {
      this.despawnEverywhere(tracked, "map");
      this.untrack(tracked);
      tracked = undefined;
    }
    const found = targets(candidate.map, candidate.x, candidate.y, tracked?.peers ?? NO_PEERS);
    // Nothing near and nothing held: no Set, no state, no record. Most entities stop here.
    if (!tracked && found.size === 0) return;
    const wanted = new Set<string>();
    for (const peer of found) if (links.isUp(peer)) wanted.add(peer);
    if (!tracked) {
      if (wanted.size === 0) return;
      tracked = {
        kind: kind.name, id: candidate.id, num: candidate.num, map: candidate.map,
        peers: new Set(), state: null, prim: null, stateSize: 0, slot: this.slotSeq++, motion: null, motionAt: 0, scanGen: gen,
        prev: null, next: null, listed: false, aware: kind.dirtyMarks === true, dirty: false, flushGen: 0,
      };
      byId.set(candidate.id, tracked);
      this.listAdd(tracked);
    }
    const head = { kind: kind.name, id: candidate.id, num: candidate.num };

    for (const peer of tracked.peers) {
      if (wanted.has(peer)) continue;
      links.send(peer, "GHOST_DESPAWN", { ...head, reason: "left" });
      tracked.peers.delete(peer);
    }
    // Every holder released and none wanted: nothing to compare, so no state is read (or turned into JSON).
    if (wanted.size === 0) {
      this.untrack(tracked);
      return;
    }

    const fresh: string[] = [];
    for (const peer of wanted) if (!tracked.peers.has(peer)) fresh.push(peer);

    // Peers that already hold it get only the fields that changed; new peers get them in the snapshot below.
    // Read when it is this entity's slice, when a peer is about to get the snapshot (so what was last sent is what
    // the snapshot shows), and the first time (the snapshot is the base the changes are measured from).
    if (kind.state && (slices <= 1 || (gen + tracked.slot) % slices === 0 || fresh.length > 0 || !tracked.state)) {
      const state = kind.state(candidate.id) ?? null;
      const changes = state ? this.stateChanges(tracked, state) : null;
      if (changes) for (const peer of tracked.peers) links.send(peer, "GHOST_STATE", { ...head, changes });
    }

    if (fresh.length > 0) {
      const record = kind.snapshot(candidate.id);
      if (record) {
        for (const peer of fresh) {
          if (!links.send(peer, "GHOST_SPAWN", { ...head, record })) continue;
          tracked.peers.add(peer);
          // A move may overtake the spawn and be dropped: send one on the next tick rather than at the keyframe.
          tracked.motion = null;
          this.markDirty(tracked);
        }
      }
    }
    if (tracked.peers.size === 0) this.untrack(tracked);
  }

  /**
   * The fields of `state` that differ from what was last sent, as GHOST_STATE changes (null when none), and what was
   * last sent brought up to date. A primitive equal to the last one sent is unchanged without any JSON; any other
   * field is compared as JSON, as before. Nothing is recorded if a field cannot be turned into JSON.
   */
  private stateChanges(tracked: Tracked, state: Record<string, unknown>): Record<string, unknown> | null {
    const last = tracked.state;
    const prim = tracked.prim;
    // Nothing was sent to compare with (no holder yet, or the first look): this is the base from now on.
    if (!last || !prim || tracked.peers.size === 0) {
      this.rememberState(tracked, state);
      return null;
    }
    let changes: Record<string, unknown> | null = null;
    let updates: Array<[string, string, unknown, boolean]> | null = null;
    let known = 0;
    let reshaped = false;
    for (const field in state) {
      const value = state[field];
      const simple = value === null || (typeof value !== "object" && typeof value !== "function");
      const had = Object.hasOwn(last, field);
      if (had) {
        known++;
        if (simple && prim[field] === value && Object.hasOwn(prim, field)) continue;
      } else {
        reshaped = true;
      }
      const json = JSON.stringify(value ?? null);
      if (had && last[field] === json) {
        // The same JSON: the same value, unless it is a primitive that differs only in kind (undefined for null).
        if (simple) prim[field] = value;
        continue;
      }
      (updates ??= []).push([field, json, value, simple]);
      // undefined would vanish from the JSON frame and leave the mirror's old value: send null.
      (changes ??= {})[field] = value ?? null;
    }
    // A field the kind no longer reports goes as null, so the mirror clears it.
    const dropped = known < tracked.stateSize;
    if (dropped) {
      for (const field of Object.keys(last)) {
        if (Object.hasOwn(state, field)) continue;
        (changes ??= {})[field] = null;
      }
    }
    if (updates) {
      for (const [field, json, value, simple] of updates) {
        last[field] = json;
        if (simple) prim[field] = value;
        else delete prim[field];
      }
    }
    // The fields stay in the order the kind gives them, so that a later drop is sent in that order.
    if (reshaped || dropped) this.rememberState(tracked, state, last);
    return changes;
  }

  /** `state` as what was sent: per field its JSON (taken from `known` where it is there), and its primitives. */
  private rememberState(tracked: Tracked, state: Record<string, unknown>, known?: Record<string, string>): void {
    const json: Record<string, string> = {};
    const prim: Record<string, unknown> = {};
    let size = 0;
    for (const field in state) {
      const value = state[field];
      json[field] = known?.[field] ?? JSON.stringify(value ?? null);
      if (value === null || (typeof value !== "object" && typeof value !== "function")) prim[field] = value;
      size++;
    }
    tracked.state = json;
    tracked.prim = prim;
    tracked.stateSize = size;
  }

  private listAdd(tracked: Tracked): void {
    (tracked.aware ? this.aware : this.plain).add(tracked);
  }

  private listRemove(tracked: Tracked): void {
    (tracked.aware ? this.aware : this.plain).remove(tracked);
  }

  private markDirty(tracked: Tracked): void {
    if (!tracked.aware || tracked.dirty) return;
    tracked.dirty = true;
    this.dirtyList.push(tracked);
  }

  /**
   * An entity of a kind with `dirtyMarks` moved (position, direction or movement flags). Does nothing while the
   * ghosts are not attached (nothing is tracked), for an entity that is not tracked, and for one already marked.
   */
  touch(kind: GhostKindName, id: string | number): void {
    if (!this.links) return;
    // Players are filed under their id as a string; the callers hold it as it is in the cache.
    const tracked = this.tracked.get(kind)?.get(kind === "player" && typeof id !== "string" ? String(id) : id);
    if (tracked) this.markDirty(tracked);
  }

  flushTick(): void {
    const links = this.links;
    if (!links) return;
    const now = this.now();
    const budget = this.datagramsPerTick * GHOST_MOVES_PER_DATAGRAM;
    const perPeer = new Map<string, GhostMoveEntry[]>();
    const gen = ++this.flushGen;
    // Least recently sent first, and each one sent goes to the back: past the budget, the ones left over lead
    // the next tick, so a crowd that moves every tick cannot starve the rest. Moved entries are visited again
    // at the back of the list, so stop after the entries there were at the start.
    let left = this.plain.size;
    for (let tracked = this.plain.head, next: Tracked | null; tracked && left-- > 0; tracked = next) {
      // The next one first: a moved entity goes to the back below.
      next = tracked.next;
      this.sendMotion(tracked, now, budget, perPeer, gen);
    }
    // Kinds that mark their moves: the touched entities first (the ones past the budget stay marked and lead the
    // next tick), then the entries whose keyframe is due. The list is in the order of the last send, so the first
    // entry not yet due ends the walk. An entity read above is not read again (flushGen).
    const dirty = this.dirtyList;
    if (dirty.length > 0) {
      this.dirtyList = [];
      for (const tracked of dirty) {
        // Untracked since it was marked: nothing to send, and it is not kept.
        if (!tracked.dirty || !tracked.listed) { tracked.dirty = false; continue; }
        if (this.sendMotion(tracked, now, budget, perPeer, gen) === "full") this.dirtyList.push(tracked);
        else tracked.dirty = false;
      }
    }
    left = this.aware.size;
    for (let tracked = this.aware.head, next: Tracked | null; tracked && left-- > 0; tracked = next) {
      next = tracked.next;
      if (now - tracked.motionAt < this.keyframeMs) break;
      if (tracked.flushGen === gen) continue;
      this.sendMotion(tracked, now, budget, perPeer, gen);
    }
    for (const [peer, entries] of perPeer) {
      for (const datagram of encodeGhostMoves(entries)) links.sendDatagram(peer, datagram);
    }
  }

  /** Read one entity's motion and queue a GHOST_MOVE for its peers if it moved or its keyframe is due. "full" when a peer's budget had no room. */
  private sendMotion(tracked: Tracked, now: number, budget: number, perPeer: Map<string, GhostMoveEntry[]>, gen: number): "sent" | "skipped" | "full" {
    const kind = this.kinds.get(tracked.kind);
    if (!kind?.motion) return "skipped";
    tracked.flushGen = gen;
    let raw: GhostMotion | null;
    try {
      raw = kind.motion(tracked.id);
    } catch (error) {
      log.error(`Mirrors: motion of ${tracked.kind} ${tracked.id} failed: ${error}`);
      return "skipped";
    }
    if (!raw) return "skipped";
    const x = Math.round(raw.x);
    const y = Math.round(raw.y);
    const last = tracked.motion;
    const same = !!last && last.x === x && last.y === y && last.dir === raw.dir && last.flags === raw.flags;
    // Most entities have not moved: they cost no object here.
    if (same && now - tracked.motionAt < this.keyframeMs) return "skipped";
    const motion = { x, y, dir: raw.dir, flags: raw.flags };
    // Past any one peer's budget, it waits for the next tick everywhere: its last-sent motion stays one value.
    for (const peer of tracked.peers) if ((perPeer.get(peer)?.length ?? 0) >= budget) return "full";
    const entry: GhostMoveEntry = { num: tracked.num, ...motion };
    for (const peer of tracked.peers) {
      let list = perPeer.get(peer);
      if (!list) perPeer.set(peer, (list = []));
      list.push(entry);
    }
    tracked.motion = motion;
    // The first move after a spawn puts its keyframe at a random point of the interval: entities spawned in
    // one scan would otherwise all keyframe on the same tick.
    tracked.motionAt = last ? now : now - Math.random() * this.keyframeMs;
    const list = tracked.aware ? this.aware : this.plain;
    if (tracked !== list.tail) {
      list.remove(tracked);
      list.add(tracked);
    }
    return "sent";
  }

  /** `id` as the kind's candidates() gives it (same type: 5 and "5" are two entities here). */
  relay(kind: GhostKindName, id: string | number, packets: Uint8Array[], bestEffort: boolean): void {
    const links = this.links;
    if (!links || packets.length === 0) return;
    const tracked = this.tracked.get(kind)?.get(id);
    if (!tracked || tracked.peers.size === 0) return;
    const message = { kind, id, num: tracked.num, packets: toWire(packets), bestEffort };
    for (const peer of tracked.peers) links.send(peer, "GHOST_STATE", message);
  }

  /**
   * This node handed `id` over to `to` (spec §5). The peers that mirror it keep their mirrors and file them
   * under `to`; this node stops tracking it with no despawn. The caller removes the entity from the local
   * registry in the same synchronous step, so no scan sees it in between.
   */
  handOver(kind: GhostKindName, id: string | number, to: string): void {
    const tracked = this.tracked.get(kind)?.get(id);
    // The entity goes (back) to `to`: its spawn from there is legitimate again.
    this.tombstones.delete(`${kind}|${id}`);
    if (!tracked) return;
    // `to` is told too: it keeps its own mirror for its viewers until the entity arrives.
    for (const peer of tracked.peers) this.links?.send(peer, "GHOST_HANDOVER", { kind, id, num: tracked.num, to });
    tracked.peers.clear();
    this.untrack(tracked);
  }

  /** A mirror of an entity this node just handed to `from`: held as if `from` had sent it, and expiring unless it does. */
  adoptMirror(kind: GhostKindName, record: any, from: string): boolean {
    if (!this.links || record?.id == null || from === this.links.self) return false;
    const num = idNumber(record.id);
    this.tombstones.delete(`${kind}|${record.id}`);
    const before = this.mirrors.get(num);
    this.onSpawn({ kind, id: record.id, num, record }, from);
    const entry = this.mirrors.get(num);
    // An entry that was already there and was not replaced means the spawn was refused.
    if (!entry || entry === before || entry.from !== from || entry.kind !== kind) return false;
    this.expireUnlessSent(entry, this.handoverExpireMs);
    return true;
  }

  /**
   * Drop this node's mirror of `id` with no despawn sent anywhere. Called once the entity is local here (it
   * arrived by a handoff): the kind sees it local and drops the mirror as shadowed, so viewers keep it.
   */
  dropMirror(kind: GhostKindName, id: string | number): void {
    const num = idNumber(id);
    const entry = this.mirrors.get(num);
    const mine = !!entry && entry.kind === kind && String(entry.id) === String(id);
    // Also when no mirror is held yet: its spawn may still be on the way behind the bulk frames of the link.
    const key = `${kind}|${id}`;
    this.tombstones.delete(key);
    this.tombstones.set(key, { from: mine ? entry!.from : null, until: this.now() + GHOST_TOMBSTONE_MS });
    while (this.tombstones.size > GHOST_TOMBSTONE_MAX) {
      const oldest = this.tombstones.keys().next().value;
      if (oldest === undefined) break;
      this.tombstones.delete(oldest);
    }
    if (mine) this.despawnHere(num, "arrived");
  }

  // Whether a spawn of (kind, id) from `from` is refused: the entity arrived here less than GHOST_TOMBSTONE_MS ago.
  private refusedSpawn(kind: string, id: string | number, from: string): boolean {
    const key = `${kind}|${id}`;
    const stone = this.tombstones.get(key);
    if (!stone) return false;
    if (this.now() >= stone.until) {
      this.tombstones.delete(key);
      return false;
    }
    return stone.from === null || stone.from === from;
  }

  /**
   * A peer that died (bus "node-dead"): no tracked entity counts it as a holder any more, and its mirrors here
   * despawn now rather than when their expiry runs out. How many mirrors went.
   */
  dropPeer(peer: string): number {
    this.dropHolder(peer);
    let dropped = 0;
    for (const entry of this.mirrors.fromPeer(peer)) {
      this.despawnHere(entry.num, "node-dead");
      dropped++;
    }
    return dropped;
  }

  /** No tracked entity counts `peer` as a holder any more; one left with no holder is untracked. */
  private dropHolder(peer: string): void {
    for (const list of [this.plain, this.aware]) {
      for (let tracked = list.head, next: Tracked | null; tracked; tracked = next) {
        next = tracked.next;
        if (tracked.peers.delete(peer) && tracked.peers.size === 0) this.untrack(tracked);
      }
    }
  }

  private untrack(tracked: Tracked): void {
    const byId = this.tracked.get(tracked.kind);
    if (byId?.get(tracked.id) === tracked) byId.delete(tracked.id);
    this.listRemove(tracked);
    tracked.dirty = false;
  }

  private despawnEverywhere(tracked: Tracked, reason: string): void {
    for (const peer of tracked.peers) {
      this.links?.send(peer, "GHOST_DESPAWN", { kind: tracked.kind, id: tracked.id, num: tracked.num, reason });
    }
    tracked.peers.clear();
  }

  // ------------------------------------------------------------ receiving side

  private onSpawn(data: any, from: string): void {
    const kind = this.kinds.get(data?.kind);
    const id = data?.id;
    const num = Number(data?.num);
    if (!kind || (typeof id !== "string" && typeof id !== "number") || data?.record == null) return;
    // The number is what moves address it by: it must be the id's, or moves would reach another entity.
    if (num < 0 || idNumber(id) !== num) return;
    // The kind files the record under its own id: a different one would leave a mirror that nothing despawns.
    if (String(data.record?.id) !== String(id)) return;
    if (this.refusedSpawn(kind.name, id, from)) return;
    let accepted: boolean | void;
    try {
      accepted = kind.spawn(data.record, from);
    } catch (error) {
      log.error(`Mirrors: spawn of ${kind.name} ${id} failed: ${error}`);
      // The kind may have stored the record before it threw: leave no entry that nothing despawns.
      try {
        kind.despawn(id, "failed");
      } catch (cleanup) {
        log.error(`Mirrors: cleanup of ${kind.name} ${id} failed: ${cleanup}`);
      }
      if (this.mirrors.get(num)?.kind === kind.name) this.mirrors.remove(num);
      return;
    }
    // Refused: record nothing, and leave a mirror already held under this number as it is.
    if (accepted === false) return;
    // The same number under another kind is a stale mirror: its own kind drops it.
    const old = this.mirrors.get(num);
    if (old && old.kind !== kind.name) this.despawnHere(num, "replaced");
    // A new entry each time, even for a resend: expiry tells a resent mirror from a stale one by the entry.
    this.mirrors.set({ kind: kind.name, id, num, from, confirmedAt: this.now() });
  }

  private onState(data: any, from: string): void {
    const entry = this.mirrors.get(Number(data?.num));
    if (!entry || entry.from !== from) return;
    const kind = this.kinds.get(entry.kind);
    if (!kind) return;
    try {
      if (data.changes && typeof data.changes === "object") kind.update?.(entry.id, data.changes);
      if (Array.isArray(data.packets)) kind.relay?.(entry.id, fromWire(data.packets), !!data.bestEffort);
    } catch (error) {
      log.error(`Mirrors: state of ${entry.kind} ${entry.id} failed: ${error}`);
    }
  }

  private onDespawn(data: any, from: string): void {
    const num = Number(data?.num);
    const entry = this.mirrors.get(num);
    if (!entry || entry.from !== from) return;
    this.despawnHere(num, String(data.reason ?? "gone"));
  }

  private onHandover(data: any, from: string): void {
    const num = Number(data?.num);
    const entry = this.mirrors.get(num);
    const to = typeof data?.to === "string" ? data.to : "";
    // Only the node this mirror came from can hand it on.
    if (!entry || entry.from !== from || entry.kind !== data?.kind || !to || to === from) return;
    if (to === this.links?.self) {
      // The entity is coming here: keep showing the mirror until it arrives (dropMirror), or not for long.
      this.expireUnlessSent(entry, this.handoverExpireMs);
      return;
    }
    const moved: MirrorEntry = { ...entry, from: to, confirmedAt: this.now() };
    this.mirrors.set(moved);
    try {
      this.kinds.get(entry.kind)?.rehome?.(entry.id, to);
    } catch (error) {
      log.error(`Mirrors: rehome of ${entry.kind} ${entry.id} failed: ${error}`);
    }
    this.expireUnlessSent(moved, this.handoverExpireMs);
  }

  /** Despawn `entry` after `ms` unless a later spawn replaced it (a resend stores a new entry). */
  private expireUnlessSent(entry: MirrorEntry, ms: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.mirrors.get(entry.num) === entry) this.despawnHere(entry.num, "expired");
    }, ms);
    (timer as any).unref?.();
    this.timers.add(timer);
  }

  private onMoves(data: Uint8Array, from: string): void {
    for (const move of decodeGhostMoves(data)) {
      const entry = this.mirrors.get(move.num);
      if (!entry || entry.from !== from) continue;
      try {
        this.kinds.get(entry.kind)?.move?.(entry.id, move.x, move.y, move.dir, move.flags);
      } catch (error) {
        log.error(`Mirrors: move of ${entry.kind} ${entry.id} failed: ${error}`);
      }
    }
  }

  /** A peer's link went down or was replaced: start over with it, both ways. */
  private forgetPeer(peer: string): void {
    // Everything is sent again when the link is up: the next scan finds the peer missing from `peers`.
    this.dropHolder(peer);
    // The mirrors held now expire unless the peer sends them again first. A resend stores a new entry,
    // so the entries themselves mark "not confirmed since": a clock can tie inside one ms.
    const stale = new Set<MirrorEntry>(this.mirrors.fromPeer(peer));
    if (stale.size === 0) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      for (const entry of this.mirrors.fromPeer(peer)) {
        if (stale.has(entry)) this.despawnHere(entry.num, "expired");
      }
    }, this.expireMs);
    (timer as any).unref?.();
    this.timers.add(timer);
  }

  private despawnHere(num: number, reason: string): void {
    const entry = this.mirrors.remove(num);
    if (!entry) return;
    try {
      this.kinds.get(entry.kind)?.despawn(entry.id, reason);
    } catch (error) {
      log.error(`Mirrors: despawn of ${entry.kind} ${entry.id} failed: ${error}`);
    }
  }
}

/** The node's mirrors. Not attached outside cluster mode, so every call returns at once there. */
export const ghosts = new Ghosts();

export { idNumber };
