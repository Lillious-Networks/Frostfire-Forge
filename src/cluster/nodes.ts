import log from "../modules/logger";
import type { ClusterStore } from "./store";

// Who is in the cluster. A node announces itself once (its info outlives it, so
// tickets issued by a node that has since stopped can still be routed) and then
// proves it is alive with a heartbeat that expires. The load report is what the
// coordinator balances blocks by; it expires with the heartbeat.

export interface NodeInfo {
  nodeId: string;
  regionId: string;
  publicHost: string;
  port: number;
  wtPort: number;
  useSSL: boolean;
  startedAt: number;
  /** Where neighbours dial this node's link listener (spec §1, NODE_LINK_HOST / NODE_LINK_PORT). Absent or 0: no links. */
  linkHost?: string;
  linkPort?: number;
  /** Base64 SHA-256 of the link certificate, pinned by the dialer; "" when it cannot be pinned (CA-signed). */
  certHash?: string;
}

export interface LoadReport {
  nodeId: string;
  at: number;
  players: number;
  /** The awake creatures (observed or in combat) this node counts in its blocks' load, not all it holds. */
  creatures: number;
  /** Every live creature in this node's registry, mirrors and corpses left out. Not load: a count to check against (cluster-chaos.ts). */
  creaturesTotal?: number;
  /** Load per block, players + 0.1 x awake creatures (spec §2), key `${map}|${bx},${by}`. */
  blocks: Record<string, number>;
  /**
   * The worst event-loop delay this node saw in the last LAG_WINDOW_MS (LoopLagMeter), in ms. A node that is behind
   * does not answer a block move in time. Absent on a report from an older node: that counts as not lagging.
   */
  lagMs?: number;
}

/** How often the loop-lag meter looks, and how far back its worst value reaches. */
export const LAG_SAMPLE_MS = 250;
export const LAG_WINDOW_MS = 5_000;

/**
 * The event loop's delay: a timer set for LAG_SAMPLE_MS that fires late says the loop was busy that long. `max` is the
 * worst delay of the last LAG_WINDOW_MS, so one slow tick shows for a few reports and then clears. It is the number
 * the game loop's profile logs as the longest tick, but always on (that one only runs with GL_PROFILE).
 */
export class LoopLagMeter {
  private readonly samples: Array<{ at: number; lag: number }> = [];
  private last: number;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.last = this.now();
  }

  /** Starts sampling. The returned timer is cleared with clearInterval. */
  start(): ReturnType<typeof setInterval> {
    this.last = this.now();
    const timer = setInterval(() => this.sample(), LAG_SAMPLE_MS);
    (timer as any).unref?.();
    return timer;
  }

  /** One look: the delay of this firing against its schedule. */
  sample(): void {
    const at = this.now();
    this.samples.push({ at, lag: Math.max(0, at - this.last - LAG_SAMPLE_MS) });
    this.last = at;
    this.trim(at);
  }

  /** The worst delay in the window, in whole ms. */
  max(): number {
    // A loop that is blocked right now has not fired yet: the time since the last firing counts too.
    const at = this.now();
    this.trim(at);
    let worst = Math.max(0, at - this.last - LAG_SAMPLE_MS);
    for (const sample of this.samples) if (sample.lag > worst) worst = sample.lag;
    return Math.round(worst);
  }

  private trim(at: number): void {
    while (this.samples.length > 0 && at - this.samples[0]!.at > LAG_WINDOW_MS) this.samples.shift();
  }
}

// Beat every second or so: three missed beats and the node is dead.
export const ALIVE_TTL_MS = 3000;

const NODES_KEY = "cells:nodes";
const infoKey = (nodeId: string) => `cells:nodeinfo:${nodeId}`;
const aliveKey = (nodeId: string) => `cells:alive:${nodeId}`;
const loadKey = (nodeId: string) => `cells:load:${nodeId}`;

function parse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// The value of a beat from a node that never announced through the registry it beats with (and from nodes of the
// release before beats named their run): whose run it is cannot be told.
const UNKNOWN_RUN_BEAT = "1";

/**
 * The lease margin: a node counts as owner of its blocks until its last good beat is ALIVE_TTL_MS plus this old. The
 * beat's key goes ALIVE_TTL_MS after the store took it, which is never before the beat was sent, and the coordinator
 * then waits out its confirm time and two passes before it takes a block: the node stops well before that.
 */
export const LEASE_MARGIN_MS = 500;

// The tombstone the coordinator leaves where it took a dead node's blocks (coordinator.ts deadKey, which this file
// cannot import: the coordinator imports this one). A test holds the two spellings together.
//
// Tombstones and announcements are sealed (storeseal.ts, security review H1): through the store the node and the
// coordinator use, one written by anyone else reads as missing. So a forged tombstone, or a forged later run under a
// node's id, takes no run; a missing record grants nothing it did not grant before.
export const tombstoneKey = (nodeId: string) => `cells:dead:${nodeId}`;

export class NodeRegistry {
  // What each node announced through this registry; its run is written as the value of its beat.
  private announced = new Map<string, NodeInfo>();
  // When the last good beat of each node was sent (the lease, see leaseValid).
  private lastGoodBeat = new Map<string, number>();
  // The node this registry last announced or beat for: the one leaseValid() answers for.
  private self: string | null = null;
  // The runs that found themselves taken over or superseded (see taken()), by node id: the startedAt of the run.
  private takenRuns = new Map<string, number>();
  // Whether the last look at the node's own announcement failed (logged once per run of failures).
  private checkFailed = false;

  // The clock is monotonic, as the coordinator's waits are: a wall clock stepped back during a partition would
  // stretch the lease past the takeover.
  constructor(private store: ClusterStore, private now: () => number = () => performance.now()) {}

  async announce(info: NodeInfo): Promise<void> {
    this.self = info.nodeId;
    // A run announced here by its own node is a fresh start, unless it is the run already found taken.
    if (this.takenRuns.get(info.nodeId) !== info.startedAt) this.takenRuns.delete(info.nodeId);
    this.announced.set(info.nodeId, info);
    await this.store.set(infoKey(info.nodeId), JSON.stringify(info));
    await this.store.addToSet(NODES_KEY, info.nodeId);
  }

  /**
   * The beat names the run it is from (its startedAt): an old run's beat outlives that run by up to ALIVE_TTL_MS.
   *
   * It first announces the node again when the registry lost it (its id is gone from the set, or its info is gone or
   * names an older run), so a forget that raced the node's announce cannot leave a live run unknown for good. The
   * announcement comes before the beat, as a node beats only after it announced.
   *
   * A run is taken, for good, when:
   *  - a tombstone names it (the coordinator took the node's blocks);
   *  - it held the lease, the lease ran out, and the registry has forgotten it since (only a takeover forgets a run
   *    that was seen live, and the tombstone may have expired in a long stall);
   *  - another run announced under its id with a later start.
   * A taken run does not announce again, writes no beat and has no lease: the node is to stop (taken()).
   *
   * The tombstone is read on every beat, not only after a lapse: a lease granted again just before a takeover writes
   * its tombstone is then revoked by the next beat, whatever the takeover's timing is. That is one more read a second.
   * A tombstone that cannot be read grants nothing: the lease is not extended and nothing is announced.
   *
   * A beat that throws leaves the lease as it was, so it runs out by itself.
   */
  async beat(nodeId: string): Promise<void> {
    this.self = nodeId;
    const info = this.announced.get(nodeId);
    if (info === undefined) {
      // A beat from a node that never announced here: nothing to check, no run to name.
      const sentAt = this.now();
      await this.store.set(aliveKey(nodeId), UNKNOWN_RUN_BEAT, ALIVE_TTL_MS);
      this.lastGoodBeat.set(nodeId, sentAt);
      return;
    }
    if (this.takenRuns.get(nodeId) === info.startedAt) return;
    const sentAt = this.now();
    let stored: NodeInfo | null = null;
    let lost = false;
    try {
      stored = parse<NodeInfo>(await this.store.get(infoKey(nodeId)));
      const listed = (await this.store.members(NODES_KEY)).includes(nodeId);
      lost = !listed || !stored || stored.startedAt !== info.startedAt;
      this.checkFailed = false;
    } catch (error) {
      // Tried again on the next beat; the beat itself goes on, and its own write tells whether the store is away.
      if (!this.checkFailed) log.warn(`Cluster node ${nodeId} could not check its announcement: ${error}`);
      this.checkFailed = true;
    }
    let tombstone: boolean | null;
    try {
      tombstone = await this.tombstoned(nodeId, info.startedAt);
    } catch {
      tombstone = null;
    }
    // Read after the reads above: a beat whose reads were held up past a takeover and the tombstone's expiry must
    // judge the lease as it is now, not as it was when the beat started.
    const held = this.lastGoodBeat.has(nodeId);
    const lapsed = !this.leaseValid(nodeId);
    if (tombstone === true) return this.take(nodeId, info.startedAt, "its tombstone was found");
    if (stored && stored.startedAt > info.startedAt) return this.take(nodeId, info.startedAt, `run ${stored.startedAt} announced under its id`);
    if (lost && held && lapsed) return this.take(nodeId, info.startedAt, "it was forgotten after its lease ran out");
    if (tombstone === null) {
      // Not known whether the run was taken: the beat is written, as before, but the lease is not extended.
      await this.store.set(aliveKey(nodeId), String(info.startedAt), ALIVE_TTL_MS);
      return;
    }
    if (lost) await this.announce(info);
    await this.store.set(aliveKey(nodeId), String(info.startedAt), ALIVE_TTL_MS);
    this.lastGoodBeat.set(nodeId, sentAt);
  }

  // Latches the run as taken and ends its lease now.
  private take(nodeId: string, startedAt: number, why: string): void {
    this.lastGoodBeat.delete(nodeId);
    if (this.takenRuns.get(nodeId) === startedAt) return;
    this.takenRuns.set(nodeId, startedAt);
    log.warn(`Cluster node ${nodeId} is taken over: ${why}`);
  }

  /**
   * Whether the node's run found itself taken over (see beat). Latched for the run: the node is to fence and stop.
   * Without a node id, it answers for the node this registry announced.
   */
  taken(nodeId?: string): boolean {
    const id = nodeId ?? this.self;
    return id !== null && this.takenRuns.has(id);
  }

  /**
   * Whether the node still holds the lease on its blocks: its last good beat is not older than ALIVE_TTL_MS plus
   * LEASE_MARGIN_MS. A node that is cut off from the store alone stops being the owner of its blocks this way, as the
   * coordinator takes them from a node that does not beat. False before the first good beat, after retire and once
   * the run is taken. Without a node id, it answers for the node this registry announced.
   */
  leaseValid(nodeId?: string): boolean {
    const id = nodeId ?? this.self;
    const last = id === null ? undefined : this.lastGoodBeat.get(id);
    return last !== undefined && this.now() - last <= ALIVE_TTL_MS + LEASE_MARGIN_MS;
  }

  // Whether a tombstone names this run. One that cannot be parsed names nothing; one that cannot be read throws.
  private async tombstoned(nodeId: string, startedAt: number): Promise<boolean> {
    return parse<{ startedAt?: unknown }>(await this.store.get(tombstoneKey(nodeId)))?.startedAt === startedAt;
  }

  report(load: LoadReport): Promise<void> {
    return this.store.set(loadKey(load.nodeId), JSON.stringify(load), ALIVE_TTL_MS);
  }

  /** Announced nodes that are beating, by node id. */
  async live(): Promise<NodeInfo[]> {
    const live: NodeInfo[] = [];
    for (const nodeId of (await this.store.members(NODES_KEY)).sort()) {
      if (!(await this.store.get(aliveKey(nodeId)))) continue;
      const info = await this.info(nodeId);
      if (info) live.push(info);
    }
    return live;
  }

  /** Whether the node's beat is current, read fresh. */
  async isAlive(nodeId: string): Promise<boolean> {
    return (await this.store.get(aliveKey(nodeId))) !== null;
  }

  /**
   * Whether the run `startedAt` is beating, read fresh. A beat that does not name its run (UNKNOWN_RUN_BEAT) is
   * taken as the run's own, as before beats named their run.
   */
  async isAliveAs(nodeId: string, startedAt: number): Promise<boolean> {
    const value = await this.store.get(aliveKey(nodeId));
    return value === String(startedAt) || value === UNKNOWN_RUN_BEAT;
  }

  async info(nodeId: string): Promise<NodeInfo | null> {
    return parse<NodeInfo>(await this.store.get(infoKey(nodeId)));
  }

  /** Reports of live nodes only: a dead node's last report must not count. */
  async loads(): Promise<LoadReport[]> {
    const loads: LoadReport[] = [];
    for (const node of await this.live()) {
      const load = parse<LoadReport>(await this.store.get(loadKey(node.nodeId)));
      if (load) loads.push(load);
    }
    return loads;
  }

  /** Graceful shutdown. The info stays so old tickets still route. */
  async retire(nodeId: string): Promise<void> {
    this.lastGoodBeat.delete(nodeId);
    await this.store.del(aliveKey(nodeId));
    await this.store.del(loadKey(nodeId));
  }

  /** Every node ever announced and not forgotten, live or not. */
  known(): Promise<string[]> {
    return this.store.members(NODES_KEY);
  }

  /**
   * Removes a node the coordinator found dead (its announcement, beat and load report; its old tickets stop routing),
   * but only while its announcement is still the run `startedAt` (or is gone): a node that restarted and announced a
   * new run meanwhile keeps that announcement and that run's beat. Whether it forgot the node.
   *
   * The store has no compare-and-delete on a JSON field, so this is not one atomic step. The announcement is read
   * and deleted in one step (take), so a new run's announcement is never deleted, only put back (a plain set) when
   * it is taken by mistake; only a second new run announcing in that one round trip would be overwritten. The set
   * entry is removed after that and then put back if an announcement is found again (a new run that announced in
   * between, which is then not forgotten). A node beats only after it announces, so once no announcement is found
   * the beat is the old run's; a new run that announces and beats in the last two round trips loses that one beat,
   * and its next beat sets it again.
   */
  async forgetRun(nodeId: string, startedAt: number): Promise<boolean> {
    const current = parse<NodeInfo>(await this.store.get(infoKey(nodeId)));
    if (current && current.startedAt !== startedAt) return false;
    const taken = await this.store.take(infoKey(nodeId));
    const takenInfo = parse<NodeInfo>(taken);
    if (taken !== null && takenInfo && takenInfo.startedAt !== startedAt) {
      // Tried twice: a put-back that fails leaves a live new run unknown until it announces again.
      try {
        await this.store.set(infoKey(nodeId), taken);
      } catch {
        await this.store.set(infoKey(nodeId), taken);
      }
      return false;
    }
    await this.store.removeFromSet(NODES_KEY, nodeId);
    // An announce writes its info before it joins the set: an info found now is a new run, whose set entry belongs.
    if (await this.store.get(infoKey(nodeId))) {
      await this.store.addToSet(NODES_KEY, nodeId);
      return false;
    }
    await this.store.del(aliveKey(nodeId));
    await this.store.del(loadKey(nodeId));
    return true;
  }
}
