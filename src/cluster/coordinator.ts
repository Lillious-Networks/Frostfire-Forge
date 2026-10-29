import log from "../modules/logger";
import { BlockTable, blockEpochKey, blockKey, blockTableKey, type BlockOwner, type MapBlocks, type StoredBlocks } from "./blocks";
import type { ClusterBus } from "./bus";
import { PlayerDirectory } from "./directory";
import { MapCatalogue, type MapExtent } from "./maps";
// Types only: blockmove.ts loads the block parts, which this standalone process must not load.
import { BlockMoveOrders, type EndedOrder } from "./blockmove";
import { MOVES_KEY, isOpen, moveKey } from "./moveorders";
import { ALIVE_TTL_MS, LEASE_MARGIN_MS, NodeRegistry, type LoadReport, type NodeInfo } from "./nodes";
import { NODE_COOLDOWN_MS, REBALANCE_EVERY_MS, planRebalance } from "./rebalance";
import { splitBlocks } from "./split";
import type { ClusterStore } from "./store";
import { refusedRecord } from "./storeseal";

// The one process per region that hands out blocks. Several may run; one holds
// the lock and acts, the others wait to take over. It gives out blocks that have
// no owner, and takes over the blocks of a node that died (spec §7): the dead
// node's live neighbours fill them as they fill any gap. A block a live node
// owns moves only by a move order (rebalance.ts, blockmove.ts).
//
// The lock is `{ holder, epoch }` with an epoch drawn from a counter, so no two
// holds share one. It is renewed with renewIfEpoch (our epoch, one atomic step
// that only moves the ttl on): a renewal can only ever land on our own hold, and
// the lock always keeps a ttl, so a coordinator that dies at any point lets a
// standby lead once the ttl runs out.
// A leader stalled for longer than the ttl can lose the lock without knowing it.
// It reads the lock before each write and stops if it is not its own, and each
// table is written only over the epoch it was read at (writeIfEpoch), so a stale
// leader cannot write over a newer leader's table. What it can still do, in the
// moment between that read of the lock and the write, is give out blocks of a
// table no one else has changed since: the same blocks a new leader would give out.

/** Held by the leading coordinator; a node that sees it leaves unowned blocks to it (cluster/index.ts). */
export const LOCK_KEY = "cells:coordinator";
const LOCK_EPOCH_KEY = "cells:coordinator:epoch";
// A node missing from this many full passes in a row, and for at least deadConfirmMs since the first, is dead.
const DEAD_PASSES = 2;
const DEAD_CONFIRM_MS = 2000;
export const DEAD_KEY_PREFIX = "cells:dead:";
export const deadKey = (nodeId: string) => `${DEAD_KEY_PREFIX}${nodeId}`;
/** How long a tombstone stays: long past any stall a node could come back from. */
export const TOMBSTONE_TTL_MS = 600_000;

/** Left where a dead node's blocks were taken from: the node, if it was only stalled, finds it and stops. */
export interface Tombstone { nodeId: string; startedAt: number; at: number }
/**
 * Bus "node-dead": a node's run is over (dead, or restarted under the same id). It can come twice for one run (a
 * takeover cut short runs again whole, and a new leader may tell a restart again): receivers must be idempotent.
 */
export interface NodeDeadMessage { nodeId: string; startedAt: number; restarted: boolean }
/** An order its old owner has not started in this long is aborted: the bus message was lost, or the node is gone. */
export const MOVE_START_TIMEOUT_MS = 30_000;
/** An order started this long ago and not taken by its new owner is aborted; the old owner puts the state back. */
export const MOVE_SEND_TIMEOUT_MS = 60_000;
/**
 * A closed order is kept this long, so an old owner still deciding (blockmove.ts, close) reads how it ended. A block
 * whose order closed "too-big" is left out of rebalancing for as long (preflight D11).
 */
export const ORDER_KEEP_MS = 300_000;
/**
 * A block whose order ended aborted rests this long, and its old owner sends nothing to its new owner, before it is ordered again; the rest doubles
 * with each consecutive abort of that block (60 s, 120 s, 240 s ...) up to MOVE_BACKOFF_MAX_MS. A done order clears it.
 * An abort means the pair could not finish a move (a lagging node, a lost message), and the old owner may still be
 * deciding the order: ordering it again at once only finds it busy (blockmove.ts, "already sending a block").
 */
export const MOVE_BACKOFF_MS = 60_000;
export const MOVE_BACKOFF_MAX_MS = 600_000;
/** The rest after the block's `fails`th consecutive abort. */
export const moveBackoffMs = (fails: number) => Math.min(MOVE_BACKOFF_MAX_MS, MOVE_BACKOFF_MS * 2 ** Math.max(0, fails - 1));
// The run of each node last seen live, kept in the store so a new leader still sees a restart that overlapped the
// failover. `live` is false for a run only seen announced (a restart while the node was away): it is not judged
// dead like a run that was seen beating.
const RUN_KEY_PREFIX = "cells:noderun:";
const runKey = (nodeId: string) => `${RUN_KEY_PREFIX}${nodeId}`;
interface NodeRun { startedAt: number; live: boolean }
// The settle wait when only expectedNodes is set: a node that never starts cannot hold back the split for good.
const SETTLE_CAP_MS = 60_000;
// A run never seen live (a cold start with a kept table, a node still booting after a restart) is given this long
// before its blocks are taken. It covers the gap from a node's announce to its first beat. The maps are loaded before
// the announce, so that gap holds only a few store calls (the catalogue, one read and one counter per map) and takes
// milliseconds on a healthy store. The wide margin is for a slow store: a run that still has not beaten after this
// is judged dead for good, and its node must be restarted to come back.
const NEVER_LIVE_GRACE_MS = 60_000;
const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

export interface CoordinatorOptions {
  id?: string;
  lockTtlMs?: number;
  tickMs?: number;
  now?: () => number;
  /**
   * A clock that never steps, for the waits before a takeover (deadConfirmMs, the hold). Default: `now` when it is
   * given (tests move one clock), else performance.now.
   */
  monotonic?: () => number;
  /**
   * The settle rule, for a cold start (CLUSTER_EXPECTED_NODES, CLUSTER_SETTLE_MS): an empty table is
   * not split until `expectedNodes` nodes are live or `settleMs` has passed since this coordinator
   * first saw a live node, whichever comes first. Neither set: split at once. `settleMs` alone: wait
   * that long. `expectedNodes` alone: wait for them, but at most 60 s. Once met, it stays met.
   */
  expectedNodes?: number;
  settleMs?: number;
  /** How long a node must have been missing (over at least two passes) before its blocks are taken over. Default 2000. */
  deadConfirmMs?: number;
  /** How often the leader looks for overloaded nodes (rebalance.ts). Default 10 s; 0 turns rebalancing off. */
  rebalanceEveryMs?: number;
  /** The wait for a lease to lapse before a takeover writes (see takeOver). Tests record it instead. */
  sleep?: (ms: number) => Promise<void>;
}

export class Coordinator {
  private registry: NodeRegistry;
  private catalogue: MapCatalogue;
  private blocks: BlockTable;
  private id: string;
  private lockTtlMs: number;
  private tickMs: number;
  private now: () => number;
  private monotonic: () => number;

  private leader = false;
  // Our hold of the lock, kept while a renewal fails on an error: the next one may still find it ours.
  private lock: { value: string; epoch: number } | null = null;
  private locking: Promise<void> | null = null;
  private ticking: Promise<void> | null = null;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  // Maps whose stored table could not be read: logged once, left alone until it reads again.
  private unreadable = new Set<string>();
  // Maps (by table key) whose table this coordinator run has read: one missing later was deleted, not never written.
  private readonly tablesSeen = new Set<string>();
  // Maps whose table is missing although they were split before: logged once, until the table reads again.
  private readonly missingLogged = new Set<string>();
  private bus: ClusterBus;
  private deadConfirmMs: number;
  // Announced owners seen not live: since when (monotonic), in how many full passes in a row, and which run is judged.
  private missing = new Map<string, { since: number; passes: number; run: NodeRun }>();
  // Known nodes neither live nor owning a block, under a run never seen live: since when (monotonic), in how many full
  // passes in a row, and which run (forgetLeftovers).
  private idle = new Map<string, { since: number; passes: number; startedAt: number }>();
  // Owners never announced, already warned about.
  private warned = new Set<string>();
  // Nodes whose takeover waits for a table that cannot be read, already warned about.
  private heldBack = new Set<string>();
  // A cache of the runs in the store (RUN_KEY_PREFIX), dropped when this coordinator gains the lead.
  private runs = new Map<string, NodeRun>();
  // The hold: after a pass that could not reach the store, or on gaining the lead, every beat may have run out (or
  // this coordinator's counts are stale). Why it is pending; then, from the first full pass after it, since when and
  // over how many passes it has run. No node is confirmed dead while it holds.
  private holdCause: string | null = null;
  private holding = false;
  private holdSince = 0;
  private holdPasses = 0;
  private expectedNodes: number | undefined;
  private settleMs: number;
  // When this coordinator first saw a live node; and whether the settle rule has been met.
  private firstLiveAt: number | null = null;
  private settled = false;
  // The live count when the 60 s cap (not the nodes) met the rule; read and cleared by that pass.
  private capped: number | null = null;
  private orders: BlockMoveOrders;
  private rebalanceEveryMs: number;
  private sleep: (ms: number) => Promise<void>;
  // When the last rebalance pass ran, on the monotonic clock (an interval on this host only): the first leading pass
  // runs one.
  private rebalancedAt = Number.NEGATIVE_INFINITY;
  // Orders closed "too-big", already logged: once per order (preflight D11). Kept in memory only, so a new leader
  // after a failover logs a still-kept one once more.
  private tooBigLogged = new Set<string>();
  // Blocks (map|bx,by) whose orders ended aborted: the run of aborts, when the rest ends, and the pair of the last one.
  // The orders already counted are kept by id. Memory only: a new leader counts the aborted orders still kept.
  // `pair`: whether the old owner is also barred from the new owner meanwhile (not for an order refused because its block is held).
  private moveFails = new Map<string, { fails: number; until: number; from: string; to: string; pair: boolean }>();
  // The rest of the two nodes of an order that aborted unstarted because the old owner was busy ("busy", blockmove.ts),
  // by order id. The block's own run of aborts (moveFails) is not lengthened by it. Dropped with the order.
  private busyRests = new Map<string, { until: number; from: string; to: string }>();
  // The pairs that rest after an order that was given up on without a hold, or that could not be carried out because the
  // new owner did not answer the probe ("unreachable", blockmove.ts), by order id: the old owner sends nothing to that new
  // owner for MOVE_BACKOFF_MS. Neither node is otherwise out: the old owner is free (it holds nothing, or holds one block
  // for its own order) and may send another block elsewhere. Dropped with the order.
  private pairRests = new Map<string, { until: number; from: string; to: string }>();
  private moveCounted = new Set<string>();

  constructor(private store: ClusterStore, bus: ClusterBus, options: CoordinatorOptions = {}) {
    this.bus = bus;
    this.registry = new NodeRegistry(store);
    this.catalogue = new MapCatalogue(store);
    this.blocks = new BlockTable(store);
    // Attached so that write tells the nodes ("blocks-changed").
    this.blocks.attach(bus);
    this.id = options.id ?? `coordinator-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    this.lockTtlMs = options.lockTtlMs ?? 5000;
    this.tickMs = options.tickMs ?? 1000;
    this.now = options.now ?? Date.now;
    this.orders = new BlockMoveOrders(store, this.now);
    this.monotonic = options.monotonic ?? options.now ?? (() => performance.now());
    this.expectedNodes = options.expectedNodes;
    this.settleMs = options.settleMs ?? 0;
    this.deadConfirmMs = options.deadConfirmMs ?? DEAD_CONFIRM_MS;
    this.rebalanceEveryMs = options.rebalanceEveryMs ?? REBALANCE_EVERY_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  async start(): Promise<void> {
    if (this.timers.length > 0) return;
    const run = (what: string, work: () => Promise<void>) =>
      work().catch((error) => log.error(`Coordinator ${this.id}: ${what} failed: ${error}`));
    // Renewed five times per ttl: a renewal or two may fail without losing the lock.
    this.timers.push(setInterval(() => run("lock renewal", () => this.holdLock()), Math.max(1, Math.floor(this.lockTtlMs / 5))));
    this.timers.push(setInterval(() => run("tick", () => this.tick()), this.tickMs));
    await run("tick", () => this.tick());
  }

  /** Stops, and gives the lock up so a standby leads at once. */
  async stop(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    await this.ticking?.catch(() => {});
    await this.locking;
    const lock = this.lock;
    const wasLeader = this.leader;
    this.leader = false;
    this.lock = null;
    if (!lock) return;
    try {
      await this.store.deleteIfEpoch(LOCK_KEY, lock.epoch);
    } catch (error) {
      log.error(`Coordinator ${this.id} could not give up the lock (it runs out on its own): ${error}`);
    }
    if (wasLeader) log.info(`Coordinator ${this.id} stepped down`);
  }

  isLeader(): boolean {
    return this.leader;
  }

  /** One pass: hold (or try for) the lock, and as leader give out the blocks that have no owner. */
  tick(): Promise<void> {
    this.ticking ??= this.pass().finally(() => { this.ticking = null; });
    return this.ticking;
  }

  private async pass(): Promise<void> {
    await this.holdLock();
    if (!this.leader) return;
    try {
      await this.assign();
    } catch (error) {
      // Any throw, not only a store error: a store failure that shows up as something else must not let a takeover
      // through. A bug that throws only delays takeovers.
      this.lostStore(error);
      throw error;
    }
  }

  // The store failed part way: the absences counted so far say nothing (beats could not land), so they start over,
  // and the first full pass after it starts the hold (see watchDead).
  private lostStore(error: unknown): void {
    this.holdCause ??= `the store failed (${error})`;
    this.missing.clear();
    this.idle.clear();
  }

  // Counts kept from an earlier spell as leader are stale (the node may have beaten meanwhile), and a new leader
  // cannot know how long a node has really been gone: it starts over, under the hold.
  private gainedLead(): void {
    this.holdCause ??= "it took the lead";
    this.missing.clear();
    this.idle.clear();
    this.runs.clear();
  }

  // One renewal or attempt at a time; a tick that comes during one waits for it.
  private holdLock(): Promise<void> {
    this.locking ??= this.renewOrAcquire()
      .catch((error) => {
        // Stop acting at once: without the store there is no knowing whether the lock is still ours.
        if (this.leader) log.error(`Coordinator ${this.id} could not renew the lock, standing by: ${error}`);
        this.leader = false;
        this.lostStore(error);
      })
      .finally(() => { this.locking = null; });
    return this.locking;
  }

  private async renewOrAcquire(): Promise<void> {
    if (this.lock) {
      if (await this.store.renewIfEpoch(LOCK_KEY, this.lock.epoch, this.lockTtlMs)) {
        if (!this.leader) {
          log.success(`Coordinator ${this.id} leads again`);
          this.gainedLead();
        }
        this.leader = true;
        return;
      }
      if (this.leader) log.warn(`Coordinator ${this.id} lost the lock, standing by`);
      this.leader = false;
      this.lock = null;
    }
    const epoch = await this.store.incrBy(LOCK_EPOCH_KEY, 1);
    const value = JSON.stringify({ holder: this.id, epoch });
    if (await this.store.setIfAbsent(LOCK_KEY, value, this.lockTtlMs)) {
      this.lock = { value, epoch };
      this.leader = true;
      this.gainedLead();
      log.success(`Coordinator ${this.id} leads`);
    }
  }

  // Right before a write: the lock may have run out (a stall) since it was last renewed.
  private async confirm(): Promise<boolean> {
    if (!this.leader || !this.lock) return false;
    if ((await this.store.get(LOCK_KEY)) === this.lock.value) return true;
    this.leader = false;
    log.warn(`Coordinator ${this.id} lost the lock, standing by`);
    return false;
  }

  private async assign(): Promise<void> {
    const liveNodes = await this.registry.live();
    const live = liveNodes.map((node) => node.nodeId);
    if (live.length === 0) return;
    await this.watchRestarts(liveNodes);
    // The move orders first, before any other table write of the pass: a block a new owner took in is committed to
    // it before the old owner hears of another table change, on which its spawner reviews the slots it let go
    // (preflight C5). A takeover then finds the block with the node that has its state. And a node whose order
    // closed this pass may be planned again by the same pass.
    await this.settleMoves(live);
    if (!this.leader) return;
    const settled = this.settledWith(live.length);
    // Set on the one pass where the cap met the rule: logged only if that pass splits an empty table.
    let capped = this.capped;
    this.capped = null;
    let waiting = false; // an empty table held back by the settle rule this pass
    const loads = await this.registry.loads();
    const absent = new Map<string, number>(); // owner not live: blocks it holds
    for (const extent of await this.catalogue.all()) {
      if (!this.leader) return;
      const stored = await this.readTable(extent.name);
      if (stored.state === "corrupt") {
        if (!this.unreadable.has(extent.name)) {
          this.unreadable.add(extent.name);
          log.error(`The block table of map ${extent.name} cannot be read: the coordinator leaves it alone until it can`);
        }
        continue;
      }
      if (this.unreadable.delete(extent.name)) log.success(`The block table of map ${extent.name} can be read again`);
      const table = stored.state === "ok" ? stored.table : { epoch: 0, owners: {} };
      for (const owner of Object.values(table.owners)) {
        if (owner?.nodeId && !live.includes(owner.nodeId)) absent.set(owner.nodeId, (absent.get(owner.nodeId) ?? 0) + 1);
      }
      // A split is final (owned blocks never move): it waits until the nodes starting with this one are live.
      if (!settled && Object.keys(table.owners).length === 0) {
        waiting = true;
        continue;
      }
      // Logged with the first empty table the cap lets through, not when nothing was waiting (a late leader).
      if (capped !== null && Object.keys(table.owners).length === 0) {
        log.info(`Coordinator ${this.id} settle cap reached: splitting over ${capped}/${this.expectedNodes} nodes`);
        capped = null;
      }
      const given = this.place(extent, table, live, loads);
      if (given.size === 0) continue;
      if (!(await this.confirm())) return;
      // From the map's counter, so a table written after the stored one was deleted still has a higher epoch than
      // any a node has cached (a node never takes a lower one); and never at or below the table it replaces.
      const next = this.withOwners(table, given, await this.blocks.nextEpoch(extent.name, table.epoch));
      // Over the table as it was read: if another (newer) leader wrote since, this one is out of date.
      if (!(await this.blocks.writeIfEpoch(extent.name, stored.state === "ok" ? stored.table.epoch : 0, next))) {
        log.warn(`The block table of map ${extent.name} changed while the coordinator was assigning: skipped until the next pass`);
        continue;
      }
      log.info(`Coordinator ${this.id} assigned blocks of map ${extent.name} (epoch ${next.epoch})`);
    }
    if (waiting) {
      const of = this.expectedNodes === undefined ? "" : `/${this.expectedNodes}`;
      const limit = this.settleLimit();
      const left = limit > 0 ? `, at most ${Math.ceil((limit - (this.now() - this.firstLiveAt!)) / 1000)} s more` : "";
      log.info(`Coordinator ${this.id} waiting for ${live.length}${of} nodes before splitting new maps${left}`);
    }
    // Only after a full pass: a pass cut short has not seen every owner.
    await this.watchDead(absent, live, loads);
    await this.rebalance(live, loads);
  }

  // The stored table of a map. Block tables are sealed (storeseal.ts), and one whose seal does not open reads as
  // missing through the sealed store. Here it is a table that cannot be read, never an absent one: an absent table is
  // split afresh, which would give its blocks a second time while the nodes still hold them by the table they cached.
  // Like a corrupt table, it is left alone (no split, no refill, no commit) and holds back the takeover of a dead node
  // until it can be read: an operator puts the table back (a backup, or the cluster's own secret if it was changed).
  // Guard (test "a block table whose seal does not open is never split afresh").
  //
  // The same holds for a table that is missing although the map was split before (security review sec7, Important
  // 1): deleting a key needs no store key, so a party that can write Redis could otherwise make this coordinator split
  // the map afresh while the nodes still serve its blocks. The evidence of an earlier split, either of:
  // - the map's epoch counter is above 0 (every table write raises it, a first split included);
  // - this coordinator run has read a table for the map (it survives the counter being deleted too).
  // Not the nodes' load reports: they count where players stand, and a node hosts players on a map that has no table
  // yet (the unowned grace), so they would hold back a first split. Guard (test "a block table deleted while the
  // cluster runs is left alone: no block is given a second time").
  //
  // A real first split still runs: no counter and no table seen. Re-splitting a map on purpose is done with the
  // cluster stopped: delete both its table and its counter, then start a coordinator.
  private async readTable(map: string): Promise<StoredBlocks> {
    const stored = await this.blocks.readStored(map);
    const key = blockTableKey(map);
    if (stored.state !== "absent") {
      this.tablesSeen.add(key);
      if (this.missingLogged.delete(key)) log.success(`The block table of map ${map} is back`);
      return stored;
    }
    if (await refusedRecord(this.store, key)) return { state: "corrupt" };
    const counter = await this.blocks.epochCounter(map);
    const seen = this.tablesSeen.has(key);
    if (!seen && (counter === null || counter === 0)) return stored;
    if (!this.missingLogged.has(key)) {
      this.missingLogged.add(key);
      const why = seen ? "this coordinator read it before" : `its epoch counter is ${counter}`;
      log.error(`The block table of map ${map} is missing, but the map was split before (${why}): it is left alone, so no block is given a second time. Put the table back from a backup; to split the map afresh, stop the cluster and delete ${key} and ${blockEpochKey(map)}`);
    }
    return { state: "corrupt" };
  }

  // The settle rule (see CoordinatorOptions): whether empty tables may be split now, with `live` nodes live.
  private settledWith(live: number): boolean {
    if (this.settled) return true;
    const now = this.now();
    this.firstLiveAt ??= now;
    const enough = this.expectedNodes !== undefined && live >= this.expectedNodes;
    const limit = this.settleLimit();
    const timeUp = limit > 0 && now - this.firstLiveAt >= limit;
    this.settled = limit <= 0 || enough || timeUp;
    // Only the cap (no settleMs of its own) is worth a line: it means an expected node never came.
    if (this.settled && !enough && this.settleMs <= 0 && this.expectedNodes !== undefined) this.capped = live;
    return this.settled;
  }

  // How long the settle rule waits at most, from the first live node: 0 when it does not wait.
  private settleLimit(): number {
    if (this.settleMs > 0) return this.settleMs;
    return this.expectedNodes === undefined ? 0 : SETTLE_CAP_MS;
  }

  // A live node with another startedAt than last seen restarted under the same id: what its last run held (mirrors,
  // away slots, foreign creatures on its neighbours) is not true any more. Its blocks stay with it.
  // A run is recorded live only on a beat that names it: the old run's beat outlives that run by up to ALIVE_TTL_MS,
  // and a new run seen only through it is still judged as never seen live.
  private async watchRestarts(nodes: NodeInfo[]): Promise<void> {
    for (const node of nodes) {
      const run = await this.runOf(node.nodeId);
      if (run && run.startedAt === node.startedAt && run.live) continue;
      const beating = await this.registry.isAliveAs(node.nodeId, node.startedAt);
      if (run && run.startedAt === node.startedAt && !beating) continue;
      // Read fresh: the view of this pass can be older than a run record another leader wrote since, and a notice
      // from it could name the node's current run.
      const fresh = await this.registry.info(node.nodeId);
      if (fresh?.startedAt !== node.startedAt) continue;
      if (!(await this.confirm())) return;
      if (run && run.startedAt !== node.startedAt) {
        log.warn(`Node ${node.nodeId} restarted: its last run is told dead`);
        await this.bus.toWorld("node-dead", { nodeId: node.nodeId, startedAt: run.startedAt, restarted: true } satisfies NodeDeadMessage);
      }
      // Only once the world was told: a notice that failed is sent on a later pass.
      await this.setRun(node.nodeId, { startedAt: node.startedAt, live: beating });
    }
  }

  private async runOf(nodeId: string): Promise<NodeRun | null> {
    const cached = this.runs.get(nodeId);
    if (cached) return cached;
    const raw = await this.store.get(runKey(nodeId));
    let run: NodeRun | null = null;
    try {
      const parsed = raw ? JSON.parse(raw) : null;
      if (typeof parsed?.startedAt === "number") run = { startedAt: parsed.startedAt, live: parsed.live === true };
    } catch {
      run = null;
    }
    if (run) this.runs.set(nodeId, run);
    return run;
  }

  private async setRun(nodeId: string, run: NodeRun): Promise<void> {
    await this.store.set(runKey(nodeId), JSON.stringify(run));
    this.runs.set(nodeId, run);
  }

  // The run an absent node is judged by: the one last seen live. A node that announced a new run since (it restarted
  // and has not beaten yet) has its old run told dead, keeps its blocks, and its new run is judged as never seen live.
  // `known` is the node's announcement when the caller has just read it.
  private async judgedRun(nodeId: string, known?: NodeInfo): Promise<NodeRun> {
    const info = known ?? (await this.registry.info(nodeId));
    const run = await this.runOf(nodeId);
    if (!run) return { startedAt: info?.startedAt ?? 0, live: false };
    if (!info || info.startedAt === run.startedAt) return run;
    log.warn(`Node ${nodeId} restarted and has not beaten yet: its last run is told dead, its blocks stay`);
    await this.bus.toWorld("node-dead", { nodeId, startedAt: run.startedAt, restarted: true } satisfies NodeDeadMessage);
    const next: NodeRun = { startedAt: info.startedAt, live: false };
    await this.setRun(nodeId, next);
    return next;
  }

  // Run at the start of each full pass. A pending cause starts the hold; it ends once both the beat's ttl plus two
  // passes of time and two more full passes have gone by. Both: the ttl is a time, and slow passes must not cut the
  // number of looks a node gets.
  private advanceHold(clock: number): void {
    const length = ALIVE_TTL_MS + DEAD_PASSES * this.tickMs;
    if (this.holdCause !== null) {
      log.info(`Coordinator ${this.id}: ${this.holdCause}: no node is taken over for ${Math.ceil(length / 1000)} s and ${DEAD_PASSES} passes`);
      this.holdCause = null;
      this.holding = true;
      this.holdSince = clock;
      this.holdPasses = 0;
      return;
    }
    if (!this.holding) return;
    this.holdPasses++;
    if (this.holdPasses >= DEAD_PASSES && clock - this.holdSince >= length) this.holding = false;
  }

  // Owners not live after a full pass: an announced one is taken over once confirmed dead; one never announced keeps
  // its blocks, with one warning (a table written by hand, or a node id mistyped, is not a death).
  private async watchDead(absent: Map<string, number>, live: string[], loads: LoadReport[]): Promise<void> {
    const clock = this.monotonic();
    this.advanceHold(clock);
    const known = new Set(await this.registry.known());
    let cut = false;
    for (const [nodeId, count] of absent) {
      if (!known.has(nodeId)) {
        if (!this.warned.has(nodeId)) {
          this.warned.add(nodeId);
          log.warn(`Node ${nodeId} owns ${count} block(s) but was never announced: they are left with it`);
        }
        continue;
      }
      const run = await this.judgedRun(nodeId);
      let seen = this.missing.get(nodeId);
      // Another run than the one counted so far: its count starts over.
      if (!seen || seen.run.startedAt !== run.startedAt || seen.run.live !== run.live) seen = { since: clock, passes: 0, run };
      seen.passes++;
      this.missing.set(nodeId, seen);
      const wait = seen.run.live ? this.deadConfirmMs : Math.max(this.deadConfirmMs, NEVER_LIVE_GRACE_MS);
      if (seen.passes < DEAD_PASSES || clock - seen.since < wait || this.holding) continue;
      const outcome = await this.takeOver(nodeId, seen.run.startedAt, live, loads);
      if (outcome === "done") this.missing.delete(nodeId);
      if (outcome === "cut") {
        // The lock (or the table) was lost: the other nodes wait for the next pass, but the clean-up below still runs.
        cut = true;
        break;
      }
    }
    // Back, or owning nothing any more: a later absence starts over.
    for (const nodeId of [...this.missing.keys()]) if (!absent.has(nodeId)) this.missing.delete(nodeId);
    for (const nodeId of [...this.warned]) if (!absent.has(nodeId)) this.warned.delete(nodeId);
    for (const nodeId of [...this.heldBack]) if (!absent.has(nodeId)) this.heldBack.delete(nodeId);
    if (!cut) await this.forgetLeftovers(known, live, absent);
  }

  // A takeover cut short after its last table write leaves the node announced but owning nothing, so it is never
  // absent again: each known node that is not live, owns no block, and has a tombstone for its current run is
  // forgotten here.
  // A run never seen live that owns nothing is never absent either (a new run kept by a takeover that then died
  // before its first beat, or a node that died while it booted): it is forgotten once it has not been live for
  // NEVER_LIVE_GRACE_MS, the wait a run never seen live gets before its blocks are taken. Its node, if it was only
  // slow, does not come back: its next beat finds its lease lapsed and its announcement gone, takes the run
  // (nodes.ts), and the node fences itself and stays down until it is restarted. A run once seen live keeps its
  // announcement, as a retired node does, so its old tickets still route.
  private async forgetLeftovers(known: Set<string>, live: string[], absent: Map<string, number>): Promise<void> {
    // A table that cannot be read may still hold its blocks.
    if (this.unreadable.size > 0) return;
    const clock = this.monotonic();
    const idle = new Set<string>();
    for (const nodeId of known) {
      if (absent.has(nodeId) || live.includes(nodeId)) continue;
      const raw = await this.store.get(deadKey(nodeId));
      const info = await this.registry.info(nodeId);
      if (!raw) {
        if (info && (await this.watchIdle(nodeId, info, clock))) idle.add(nodeId);
        continue;
      }
      let tombstone: Tombstone | null = null;
      try {
        tombstone = JSON.parse(raw) as Tombstone;
      } catch {
        tombstone = null;
      }
      if (typeof tombstone?.startedAt !== "number") continue;
      if (info && info.startedAt !== tombstone.startedAt) {
        // The run kept by the takeover.
        if (await this.watchIdle(nodeId, info, clock)) idle.add(nodeId);
        continue;
      }
      if (await this.registry.isAlive(nodeId)) continue;
      if (!(await this.confirm())) return;
      if (await this.forgetNode(nodeId, tombstone.startedAt)) log.warn(`Node ${nodeId} was taken over but still announced: it is forgotten now`);
    }
    // Live again, owning blocks again, or forgotten: a later spell starts over.
    for (const nodeId of [...this.idle.keys()]) if (!idle.has(nodeId)) this.idle.delete(nodeId);
  }

  // Counts a known node that is neither live nor owns a block, under its announced run `info`, and forgets it once
  // that run, never seen live, has been so for DEAD_PASSES passes and NEVER_LIVE_GRACE_MS. Whether it is still
  // counted (false once forgotten, or when its run was seen live).
  // "Seen live" means seen beating by a leading coordinator. A run that beat only while no coordinator led, then
  // stalled for NEVER_LIVE_GRACE_MS or more while it owned no block, is forgotten here too; when it comes back, its
  // beat finds the lease lapsed and the announcement gone and takes it (nodes.ts), so that node stays down until it
  // is restarted. Accepted: the window needs a leaderless spell and a long stall, and no block is at stake.
  private async watchIdle(nodeId: string, info: NodeInfo, clock: number): Promise<boolean> {
    // Tells an older recorded run dead, as for an absent node: its node restarted and the new run never beat.
    const run = await this.judgedRun(nodeId, info);
    if (run.live && run.startedAt === info.startedAt) return false;
    let seen = this.idle.get(nodeId);
    if (!seen || seen.startedAt !== info.startedAt) seen = { since: clock, passes: 0, startedAt: info.startedAt };
    seen.passes++;
    this.idle.set(nodeId, seen);
    if (seen.passes < DEAD_PASSES || clock - seen.since < Math.max(this.deadConfirmMs, NEVER_LIVE_GRACE_MS) || this.holding) return true;
    // Read fresh: a beat since this pass read the registry means the run is up after all.
    if (await this.registry.isAlive(nodeId)) return true;
    if (!(await this.confirm())) return true;
    if (!(await this.forgetNode(nodeId, info.startedAt))) return true;
    log.warn(`Node ${nodeId} announced run ${info.startedAt} but never beat, and owns no block: it is forgotten`);
    return false;
  }

  // Forgets the run `startedAt` only: a new run that announced while it was taken over keeps its announcement and is
  // judged as never seen live from the next pass. The run record goes either way. Whether the node was forgotten.
  private async forgetNode(nodeId: string, startedAt: number): Promise<boolean> {
    // The run first: a crash in between leaves a tombstoned node, which forgetLeftovers finishes.
    await this.store.del(runKey(nodeId));
    this.runs.delete(nodeId);
    const forgotten = await this.registry.forgetRun(nodeId, startedAt);
    this.heldBack.delete(nodeId);
    return forgotten;
  }

  // Each step can run twice without harm, so a takeover cut short (a write that lost to a newer leader, Redis gone
  // part way) runs again whole on the next pass. It acts only on the run `startedAt` that was judged dead.
  // "done": taken over and forgotten. "kept": not now (the node is back, restarted, or a table cannot be read); the
  // next pass looks again. "cut": the lock or a table write was lost.
  private async takeOver(nodeId: string, startedAt: number, live: string[], loads: LoadReport[]): Promise<"done" | "kept" | "cut"> {
    // Read fresh, as late as can be: a beat or a new run since this pass read the registry means this run is not
    // the one to end (a restart is told on the next pass, by judgedRun).
    if (await this.registry.isAlive(nodeId)) return "kept";
    if (((await this.registry.info(nodeId))?.startedAt ?? startedAt) !== startedAt) return "kept";
    // A table that cannot be read may hold blocks of the node: forgetting it would strand them there for good.
    const extents = await this.catalogue.all();
    for (const extent of extents) {
      if ((await this.readTable(extent.name)).state !== "corrupt") continue;
      if (!this.heldBack.has(nodeId)) {
        this.heldBack.add(nodeId);
        log.warn(`Node ${nodeId} is dead, but the block table of map ${extent.name} cannot be read: it is taken over once it can`);
      }
      return "kept";
    }
    if (!(await this.confirm())) return "cut";
    // First: a node that was only stalled finds it on its next beat and stops before it acts on what it lost.
    const tombstone: Tombstone = { nodeId, startedAt, at: this.now() };
    await this.store.set(deadKey(nodeId), JSON.stringify(tombstone), TOMBSTONE_TTL_MS);
    // A beat of this run that landed after the read above holds the node's lease for up to ALIVE_TTL_MS plus
    // LEASE_MARGIN_MS from when it was sent. Nothing of the node is given out until that lease has lapsed: its next
    // beat finds the tombstone and the node stops acting as owner meanwhile. The lock is renewed on its own timer.
    if (await this.registry.isAliveAs(nodeId, startedAt)) {
      log.warn(`Node ${nodeId} beat while it was taken over: its blocks are given out once its lease has lapsed`);
      await this.sleep(ALIVE_TTL_MS + LEASE_MARGIN_MS);
      if (!(await this.confirm())) return "cut";
    }
    // Its players may log in elsewhere at once; its neighbours drop what they held of it.
    // Only the dead run's entries: a new run that announced since may already hold logins of its own.
    const stillDead = async () => ((await this.registry.info(nodeId))?.startedAt ?? startedAt) === startedAt;
    const cleared = await new PlayerDirectory(this.store, this.id).sweepNode(nodeId, stillDead);
    // Sent again if this takeover is cut short and runs again: receivers must be idempotent.
    await this.bus.toWorld("node-dead", { nodeId, startedAt, restarted: false } satisfies NodeDeadMessage);
    // Its open move orders before its blocks: none it started is left for a new owner to take in after the refill.
    if (!(await this.settleOrdersOf(nodeId, live))) return "cut";
    let moved = 0;
    for (const extent of extents) {
      const stored = await this.readTable(extent.name);
      if (stored.state === "corrupt") return "kept";
      if (stored.state !== "ok") continue;
      const owners = { ...stored.table.owners };
      let theirs = 0;
      for (const [key, owner] of Object.entries(owners)) {
        if (owner?.nodeId !== nodeId) continue;
        delete owners[key];
        theirs++;
      }
      if (theirs === 0) continue;
      const stripped: MapBlocks = { epoch: stored.table.epoch, owners };
      const given = this.fill(extent, stripped, live, loads);
      if (!(await this.confirm())) return "cut";
      const next = this.withOwners(stripped, given, await this.blocks.nextEpoch(extent.name, stored.table.epoch));
      if (!(await this.blocks.writeIfEpoch(extent.name, stored.table.epoch, next))) {
        log.warn(`The block table of map ${extent.name} changed while node ${nodeId} was taken over: again next pass`);
        return "cut";
      }
      moved += theirs;
    }
    const forgotten = await this.forgetNode(nodeId, startedAt);
    log.warn(`Node ${nodeId} is dead: ${moved} block(s) given to its neighbours, ${cleared} player(s) cleared from the directory`);
    if (!forgotten) log.warn(`Node ${nodeId} announced a new run while it was taken over: that run is kept`);
    return "done";
  }

  // Every rebalanceEveryMs: orders for the blocks planRebalance moves, each told to its old owner, which carries it
  // out (blockmove.ts). A node already in an open order, or in one that was done within NODE_COOLDOWN_MS, is left out of the plan.
  private async rebalance(live: string[], loads: LoadReport[]): Promise<void> {
    if (this.rebalanceEveryMs <= 0) return;
    const clock = this.monotonic();
    if (clock - this.rebalancedAt < this.rebalanceEveryMs) return;
    this.rebalancedAt = clock;
    // Wall time for the plan: it is compared with each owner's `since`, stored by whichever coordinator gave the block.
    const now = this.now();
    const busy = new Set<string>();
    // Blocks whose order closed "too-big" (map|bx,by): left out until that order is removed (preflight D11). Blocks
    // resting after an aborted order (MOVE_BACKOFF_MS) are left out the same way.
    const tooBig = new Set<string>();
    const listed = ((await this.orders.all()) as EndedOrder[]).sort((a, b) => a.at - b.at);
    for (const order of listed) {
      this.countMove(order);
      if (!isOpen(order)) {
        if (order.reason === "too-big" && now - order.at <= ORDER_KEEP_MS) tooBig.add(`${order.map}|${blockKey(order.bx, order.by)}`);
        // A block that moved lately: both nodes rest (rebalance.ts NODE_COOLDOWN_MS). `at` is when it closed. An aborted
        // order moved nothing, but it rests the pair and the block for longer (countMove, MOVE_BACKOFF_MS). The orders are
        // in the store, so a new leader keeps the rest.
        if (order.state === "done" && now - order.at < NODE_COOLDOWN_MS) {
          busy.add(order.from);
          busy.add(order.to);
        }
        continue;
      }
      busy.add(order.from);
      busy.add(order.to);
    }
    const ids = new Set(listed.map((order) => order.id));
    for (const id of [...this.moveCounted]) if (!ids.has(id)) this.moveCounted.delete(id);
    for (const id of [...this.busyRests.keys()]) if (!ids.has(id)) this.busyRests.delete(id);
    for (const id of [...this.pairRests.keys()]) if (!ids.has(id)) this.pairRests.delete(id);
    // New owners a node sends nothing to for now (planRebalance noReceiveFrom), by old owner.
    const noReceiveFrom = new Map<string, Set<string>>();
    const bar = (from: string, to: string) => {
      const set = noReceiveFrom.get(from) ?? new Set<string>();
      set.add(to);
      noReceiveFrom.set(from, set);
    };
    for (const rest of this.pairRests.values()) {
      if (now >= rest.until) continue;
      bar(rest.from, rest.to);
    }
    for (const rest of this.busyRests.values()) {
      if (now >= rest.until) continue;
      busy.add(rest.from);
      busy.add(rest.to);
    }
    for (const [key, rest] of [...this.moveFails]) {
      // A block's run of aborts is forgotten once its rest is over and a further full rest has passed with no new
      // abort, so the count does not live as long as the coordinator.
      if (now >= rest.until + moveBackoffMs(rest.fails)) {
        this.moveFails.delete(key);
        continue;
      }
      if (now >= rest.until) continue;
      // The block rests, and the old owner sends nothing to that new owner. The old owner itself is not out: an order
      // that ended aborted may leave it holding the block (blockmove.ts), and it carries out another block's order meanwhile.
      tooBig.add(key);
      if (rest.pair) bar(rest.from, rest.to);
    }
    const tables: Array<{ map: string; table: MapBlocks }> = [];
    // Whether every table was read: only then is a node that owns no block in them known to own none.
    let complete = true;
    for (const extent of await this.catalogue.all()) {
      const stored = await this.readTable(extent.name);
      if (stored.state === "ok") tables.push({ map: extent.name, table: this.withoutTooBig(extent.name, stored.table, tooBig, now) });
      if (stored.state === "corrupt") complete = false;
    }
    const liveSet = new Set(live);
    const moves = planRebalance({
      now,
      tables,
      loads: loads.filter((load) => liveSet.has(load.nodeId)),
      busy,
      noReceiveFrom,
      live: complete ? live : undefined,
    });
    for (const move of moves) {
      if (!(await this.confirm())) return;
      const order = await this.orders.create({ map: move.map, bx: move.bx, by: move.by, from: move.from, to: move.to, blockEpoch: move.blockEpoch });
      log.info(`Coordinator ${this.id} orders block ${move.bx},${move.by} of map ${move.map} from ${move.from} to ${move.to} (load ${move.load})`);
      await this.bus.toNode(move.from, "block-move", { id: order.id });
    }
  }

  // Counts a closed order once towards its block's run of aborts: an aborted order lengthens the block's rest, a done
  // one ends the run. One closed "too-big" has its own rule. Called oldest order first.
  private countMove(order: EndedOrder): void {
    if (isOpen(order) || this.moveCounted.has(order.id)) return;
    this.moveCounted.add(order.id);
    const key = `${order.map}|${blockKey(order.bx, order.by)}`;
    if (order.state === "done") {
      this.moveFails.delete(key);
      return;
    }
    if (order.reason === "too-big") return;
    if (order.reason === "unreachable") {
      // The new owner did not answer the probe: nothing was taken out and nothing is held, so the block is not at fault
      // (its run of aborts is left as it is, and it may go to another new owner at once). The pair rests.
      this.pairRests.set(order.id, { until: order.at + MOVE_BACKOFF_MS, from: order.from, to: order.to });
      log.warn(`Move order ${order.id} (block ${order.bx},${order.by} of map ${order.map}, ${order.from} to ${order.to}) ended aborted, ${order.to} not answering: ${order.from} sends it nothing for ${MOVE_BACKOFF_MS} ms, the block's count is unchanged`);
      return;
    }
    if (order.reason === "busy") {
      // Aborted unstarted: the old owner was already sending another block, or still held an earlier move of this one.
      // That is not this block's failure, so its run is left as it is; the two nodes still rest.
      this.busyRests.set(order.id, { until: order.at + MOVE_BACKOFF_MS, from: order.from, to: order.to });
      log.warn(`Move order ${order.id} (block ${order.bx},${order.by} of map ${order.map}, ${order.from} to ${order.to}) ended aborted, the old owner being busy: the two nodes rest ${MOVE_BACKOFF_MS} ms, the block's count is unchanged`);
      return;
    }
    const fails = (this.moveFails.get(key)?.fails ?? 0) + 1;
    // "held": the old owner still holds this block from an earlier order. Only the block rests (and longer each time), no node
    // and no pair: the old owner can give another block meanwhile.
    const pair = order.reason !== "held";
    this.moveFails.set(key, { fails, until: order.at + moveBackoffMs(fails), from: order.from, to: order.to, pair });
    if (!pair) {
      log.warn(`Move order ${order.id} (block ${order.bx},${order.by} of map ${order.map}, ${order.from} to ${order.to}) ended aborted, the block being held by ${order.from}: the block rests ${moveBackoffMs(fails)} ms (${fails} in a row), no node rests`);
      return;
    }
    log.warn(`Move order ${order.id} (block ${order.bx},${order.by} of map ${order.map}, ${order.from} to ${order.to}) ended aborted: the block rests ${moveBackoffMs(fails)} ms, and ${order.from} sends nothing to ${order.to} meanwhile (${fails} in a row)`);
  }

  // The table as the plan sees it: a block in `tooBig` counts as given out just now, so the plan's block-age rule
  // passes it over (and picks another block), while it still counts as its owner's and as a neighbour. Only the
  // plan's copy changes; the stored table is not written.
  private withoutTooBig(map: string, table: MapBlocks, tooBig: ReadonlySet<string>, now: number): MapBlocks {
    let owners: Record<string, BlockOwner> | null = null;
    for (const [key, owner] of Object.entries(table.owners)) {
      if (!owner || !tooBig.has(`${map}|${key}`)) continue;
      owners ??= { ...table.owners };
      owners[key] = { ...owner, since: now };
    }
    return owners ? { epoch: table.epoch, owners } : table;
  }

  // Carries the move orders on (blockmove.ts). A sent order is committed in the table; an order its old owner never
  // started, or never got taken, is aborted; a closed one is removed once ORDER_KEEP_MS have passed. A sent order is
  // never aborted: the new owner took its parts in, and an abort would let the old owner put them back.
  private async settleMoves(live: string[]): Promise<void> {
    const now = this.now();
    const orders = (await this.orders.all()) as EndedOrder[];
    for (const order of orders) {
      if (!this.leader) return;
      const age = now - order.at;
      const what = `Move order ${order.id} (block ${order.bx},${order.by} of map ${order.map}, ${order.from} to ${order.to})`;
      if (order.state === "sent") {
        if (!(await this.confirm())) return;
        if (await this.commitMove(order, live)) await this.orders.swap(order.id, "sent", "done");
        continue;
      }
      if (order.state === "ordered" && age > MOVE_START_TIMEOUT_MS) {
        if (!(await this.confirm())) return;
        if (await this.orders.swapWith(order.id, "ordered", "aborted", { reason: "not-started" })) log.warn(`${what} was not started in ${MOVE_START_TIMEOUT_MS} ms: aborted`);
        continue;
      }
      if (order.state === "sending" && age > MOVE_SEND_TIMEOUT_MS) {
        if (!(await this.confirm())) return;
        if (await this.orders.swap(order.id, "sending", "aborted")) {
          log.warn(`${what} was not taken by ${order.to} in ${MOVE_SEND_TIMEOUT_MS} ms: aborted, and ${order.from} puts the block's state back if it still holds it`);
        }
        continue;
      }
      if (isOpen(order)) continue;
      if (order.reason === "too-big" && !this.tooBigLogged.has(order.id)) {
        this.tooBigLogged.add(order.id);
        log.warn(`${what} was too big to send: the block stays with ${order.from}, and is not moved for ${ORDER_KEEP_MS} ms`);
      }
      if (age > ORDER_KEEP_MS) {
        if (!(await this.confirm())) return;
        // Only the order as read, closed, at its revision: a closed order never opens again, and a key written since
        // (at another revision) is left alone.
        if (await this.store.deleteIfEpoch(moveKey(order.id), order.epoch)) await this.store.removeFromSet(MOVES_KEY, order.id);
      }
    }
    // Logged ids of orders no longer listed: their order was removed.
    const listed = new Set(orders.map((order) => order.id));
    for (const id of [...this.tooBigLogged]) if (!listed.has(id)) this.tooBigLogged.delete(id);
  }

  // The block to the order's new owner, over the table as read. True when the order is finished: committed, or found
  // not to be committable (both logged). False to try again next pass: the table cannot be read, or it changed.
  private async commitMove(order: EndedOrder, live: string[]): Promise<boolean> {
    const stored = await this.readTable(order.map);
    if (stored.state !== "ok") return false;
    const key = blockKey(order.bx, order.by);
    const owner = stored.table.owners[key];
    const where = `block ${order.bx},${order.by} of map ${order.map}`;
    // A pass cut short after its write, or a takeover that gave the block to the new owner anyway.
    if (owner?.nodeId === order.to) return true;
    // Only the block as it was when the order was made: rebalancing writes orders during this coordinator's hold, and
    // a takeover or another order may have moved the block since.
    if (owner?.nodeId !== order.from || owner.epoch !== order.blockEpoch) {
      const parts = order.parts?.length ? order.parts.join(", ") : "its parts";
      log.error(`Move order ${order.id}: ${where} changed hands before the commit (it is ${owner ? `${owner.nodeId}'s at ${owner.epoch}` : "unowned"}): left as it is, and the ${parts} ${order.to} took in are stranded there`);
      return true;
    }
    // A new owner already taken over (forgotten, or its run tombstoned) took the parts in after its takeover: a node
    // stalled past it that handled the BLOCK_MOVE before its beat fenced it. watchDead leaves the blocks of a node it
    // does not know with that node, so the block is refilled here, as a takeover would, and the parts are lost with it.
    if (await this.gone(order.to)) return await this.refillMove(order, stored.table, live);
    // Whether or not the new owner is live: the block goes where its state is. A new owner that only missed beats
    // keeps it; one that dies later is taken over (watchDead: tombstone, node-dead, refill), which drops the old
    // owner's foreign creatures of it. Left on the old owner, the block would have its slots on both nodes
    // (preflight C5).
    const epoch = await this.blocks.nextEpoch(order.map, stored.table.epoch);
    const next: MapBlocks = { epoch, owners: { ...stored.table.owners, [key]: { nodeId: order.to, epoch, since: this.now() } } };
    if (!(await this.blocks.writeIfEpoch(order.map, stored.table.epoch, next))) {
      log.warn(`The block table of map ${order.map} changed while move order ${order.id} was committed: again next pass`);
      return false;
    }
    log.info(`Coordinator ${this.id} moved ${where} from ${order.from} to ${order.to} (epoch ${epoch})`);
    return true;
  }

  // Whether a node is gone for good: forgotten, or its announced run has a tombstone (taken over, not yet forgotten).
  // A tombstone of an older run names a node that restarted since: that one is not gone.
  private async gone(nodeId: string): Promise<boolean> {
    if (!(await this.registry.known()).includes(nodeId)) return true;
    const raw = await this.store.get(deadKey(nodeId));
    if (!raw) return false;
    let tombstone: Tombstone | null;
    try {
      tombstone = JSON.parse(raw) as Tombstone;
    } catch {
      return false;
    }
    if (typeof tombstone?.startedAt !== "number") return false;
    const info = await this.registry.info(nodeId);
    return !info || info.startedAt === tombstone.startedAt;
  }

  // The block of a sent order whose new owner is gone, over `table` as read (the block still the old owner's at the
  // order's epoch): given to a live node as a takeover gives a block (fill), or back to the old owner when the fill
  // gives it to no one. What the new owner took in is logged lost there by name. True when it is written (the order
  // is finished); false to try again next pass.
  private async refillMove(order: EndedOrder, table: MapBlocks, live: string[]): Promise<boolean> {
    const key = blockKey(order.bx, order.by);
    const where = `block ${order.bx},${order.by} of map ${order.map}`;
    const others = live.filter((nodeId) => nodeId !== order.to);
    const owners = { ...table.owners };
    delete owners[key];
    const stripped: MapBlocks = { epoch: table.epoch, owners };
    const extent = (await this.catalogue.all()).find((map) => map.name === order.map);
    const filled = extent && others.length > 0 ? this.fill(extent, stripped, others, await this.registry.loads()).get(key) : undefined;
    const to = filled ?? (others.includes(order.from) ? order.from : undefined);
    if (!to) {
      log.warn(`Move order ${order.id}: ${order.to} is gone and no live node can take ${where}: again next pass`);
      return false;
    }
    const next = this.withOwners(stripped, new Map([[key, to]]), await this.blocks.nextEpoch(order.map, table.epoch));
    if (!(await this.blocks.writeIfEpoch(order.map, table.epoch, next))) {
      log.warn(`The block table of map ${order.map} changed while move order ${order.id} was refilled: again next pass`);
      return false;
    }
    const parts = order.parts?.length ? order.parts.join(", ") : "parts";
    log.error(`Move order ${order.id}: ${order.to} took ${where} in from ${order.from} but is gone (taken over): the block is given to ${to} instead (epoch ${next.epoch}), and the ${parts} ${order.to} took in are lost there`);
    return true;
  }

  // A takeover's first table step: the dead node's open move orders are closed before its blocks are refilled. One its
  // new owner has not taken in (ordered, sending) is aborted, so that owner, whose table may lag the refill, takes
  // nothing in. One taken in (sent) is committed to its new owner, or refilled when that one is gone too (commitMove),
  // so the refill that follows finds the block no longer the dead node's and leaves it out. False when the lock or a
  // table write was lost: the takeover runs again next pass.
  private async settleOrdersOf(nodeId: string, live: string[]): Promise<boolean> {
    for (const listed of (await this.orders.all()) as EndedOrder[]) {
      if (listed.from !== nodeId || !isOpen(listed)) continue;
      let order: EndedOrder | null = listed;
      // A swap that fails found the order moved on (the new owner took it in): read again, and act on what it is now.
      for (let tries = 0; order && isOpen(order) && tries < 3; tries++) {
        if (!(await this.confirm())) return false;
        const what = `Move order ${order.id} (block ${order.bx},${order.by} of map ${order.map}, ${order.from} to ${order.to})`;
        if (order.state === "sent") {
          if (!(await this.commitMove(order, live))) return false;
          await this.orders.swap(order.id, "sent", "done");
          break;
        }
        if (await this.orders.swap(order.id, order.state, "aborted")) {
          log.warn(`${what} is aborted: ${nodeId} is dead, and its blocks are given out`);
          break;
        }
        order = (await this.orders.get(order.id)) as EndedOrder | null;
      }
    }
    return true;
  }

  /**
   * The map's unowned blocks given out (block key to node id); empty when none are.
   * An empty table is split among all live nodes; otherwise each unowned block
   * goes to a live neighbour (see `fill`). Owned blocks never change.
   */
  private place(extent: MapExtent, table: MapBlocks, live: string[], loads: LoadReport[]): Map<string, string> {
    if (Object.keys(table.owners).length === 0) {
      // Weighed from the latest load reports: 1 + the block's reported load. That load is players + 0.1 x awake
      // creatures (CREATURE_LOAD in index.ts), so the split uses the same creature weight as the rebalance; no
      // weight of its own is set here.
      const players = new Map<string, number>();
      for (const load of loads) {
        for (const [key, count] of Object.entries(load.blocks ?? {})) {
          const [map, block] = key.split("|");
          if (map === extent.name && block) players.set(block, (players.get(block) ?? 0) + (Number(count) || 0));
        }
      }
      return splitBlocks(extent.blocksX, extent.blocksY, live, (bx, by) => 1 + (players.get(blockKey(bx, by)) ?? 0));
    }
    return this.fill(extent, table, live, loads);
  }

  /** The table with the blocks `given` out at the map's new `epoch`. */
  private withOwners(table: MapBlocks, given: Map<string, string>, epoch: number): MapBlocks {
    // A block with no owner has no epoch to add one to: it takes the map's new epoch, which is above any it had.
    const since = this.now();
    const owners: Record<string, BlockOwner> = { ...table.owners };
    for (const [key, nodeId] of given) owners[key] = { nodeId, epoch, since };
    return { epoch, owners };
  }

  /**
   * Unowned blocks to the live node that owns the most of their four neighbours (ties:
   * fewer players, then node id). It runs in waves, each judged on the owners before
   * it, so a gap between two nodes fills from both sides. A block with no live
   * neighbour left goes to the least loaded node and spreads from there.
   */
  private fill(extent: MapExtent, table: MapBlocks, live: string[], loads: LoadReport[]): Map<string, string> {
    const players = new Map(loads.map((load) => [load.nodeId, load.players ?? 0]));
    const isLive = new Set(live);
    const rank = (a: [string, number], b: [string, number]) =>
      b[1] - a[1] || (players.get(a[0]) ?? 0) - (players.get(b[0]) ?? 0) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

    const given = new Map<string, string>();
    const ownerAt = (bx: number, by: number) => given.get(blockKey(bx, by)) ?? table.owners[blockKey(bx, by)]?.nodeId;
    let free: Array<[number, number]> = [];
    for (let by = 0; by < extent.blocksY; by++) {
      for (let bx = 0; bx < extent.blocksX; bx++) if (!table.owners[blockKey(bx, by)]) free.push([bx, by]);
    }

    while (free.length > 0) {
      const wave: Array<[string, string]> = [];
      for (const [bx, by] of free) {
        const around = new Map<string, number>();
        for (const [dx, dy] of NEIGHBOURS) {
          const nodeId = ownerAt(bx + dx, by + dy);
          if (nodeId && isLive.has(nodeId)) around.set(nodeId, (around.get(nodeId) ?? 0) + 1);
        }
        if (around.size > 0) wave.push([blockKey(bx, by), [...around].sort(rank)[0]![0]]);
      }
      if (wave.length === 0) {
        const [bx, by] = free[0]!;
        wave.push([blockKey(bx, by), live.map((nodeId): [string, number] => [nodeId, 0]).sort(rank)[0]![0]]);
      }
      for (const [key, nodeId] of wave) given.set(key, nodeId);
      free = free.filter(([bx, by]) => !given.has(blockKey(bx, by)));
    }
    return given;
  }
}
