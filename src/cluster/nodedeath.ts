import log from "../modules/logger";
import type { ClusterBus } from "./bus";
import { deadKey, type NodeDeadMessage, type Tombstone } from "./coordinator";
import type { ClusterStore } from "./store";

// What a node does about a node the coordinator found dead (spec §7). The dead node's mirrors here go, the
// creatures of this node it held respawn here, and the creatures it sent here go (its blocks are refilled, and
// their slots respawn on the new owner). Of a node that restarted under the same id, only the creatures it sent
// here go: the link to its new run already resets the mirrors, and an away slot it holds may be a fresh handoff
// to the new run, which the phase 6 sweep asks about instead.
// A notice acts on the run it names, not on the node id. A death notice for a run whose node announced a newer run
// since (or whose run was already told restarted) is handled as a restart: the new run's mirrors and away slots are
// live and stay.
// A node that finds itself dead (a node-dead or a tombstone naming this run) was stalled while the coordinator
// gave its blocks away: it fences itself, kicking its players and exiting, before it acts on what it lost.
// A node-dead can come twice for one run, so a run is handled once, and a step that failed is tried again for that
// run only, a few times, on the check interval.
//
// A notice is acted on only once the store confirms it (security review M1): the bus key alone must not fence a
// healthy node or drop its creatures. A death notice needs the coordinator's tombstone, `cells:dead:<node>`, naming
// the same run; the coordinator writes it before it sends the notice (coordinator.ts takeOver). A restart notice needs
// the node's announcement to name a later run, or such a tombstone. Both records are sealed (storeseal.ts), so only a
// node or the coordinator can have written them. A notice the store denies is dropped and logged, and not remembered
// as handled: the real one may still come. A notice whose record cannot be read waits, and is checked again on the
// check interval (and on a resent copy); for this node's own run that wait never fences: the tombstone watch (check)
// and the beat (nodes.ts, which ends the lease on a tombstone and, unread, does not extend it) fence or stop the node
// once the tombstone can be read. The grants of a run are adopted (deps.adopt) only for a confirmed notice.

export const DEAD_CHECK_MS = 1_000;
// Runs remembered as handled; the oldest go first.
export const HANDLED_KEEP = 256;
// How many times a failed step is tried again before it is given up.
export const RETRY_LIMIT = 5;

const nodeInfoKey = (nodeId: string) => `cells:nodeinfo:${nodeId}`;

/** The `startedAt` a JSON record names, or null when it names none (or cannot be parsed). */
function startedAtOf(raw: string | null): number | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw)?.startedAt;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export interface NodeDeathDeps {
  self: string;
  startedAt: number;
  /** ghosts.dropPeer */
  dropMirrors(peer: string): number;
  /** spawner.releaseAwayHeldBy: away slots `peer` held, respawned here. How many. */
  releaseAwayHeldBy(peer: string): number;
  /** spawner.dropForeignFrom: creatures here whose home is `home`, despawned. How many. */
  dropForeignFrom(home: string): number;
  /** Kicks this node's players and exits. Called at most once. */
  fence(why: string): void;
  /**
   * A confirmed notice: the run's grants are adopted here (grants.adoptFrom). Called once each time a notice is found
   * confirmed, a resent copy of a handled one included (adoption is idempotent). Never for this node's own run.
   */
  adopt?(nodeId: string, startedAt: number): void;
}

type Step = "mirrors" | "away" | "foreign";

interface Pending {
  message: NodeDeadMessage;
  steps: Set<Step>;
  // How many passes had a step fail (a read that fails is not one).
  failures: number;
  // Whether the last nodeinfo read failed (logged once).
  readFailed: boolean;
  // Whether the store confirmed the notice (see the top of the file). False: its record could not be read yet.
  confirmed: boolean;
}

/** What the store says of a notice: it confirms it, denies it, or could not be read. */
type Verdict = "confirmed" | "denied" | "unread";

function messageOf(data: any): NodeDeadMessage | null {
  if (!data || typeof data !== "object") return null;
  if (typeof data.nodeId !== "string" || !data.nodeId) return null;
  if (typeof data.startedAt !== "number" || !Number.isFinite(data.startedAt)) return null;
  return { nodeId: data.nodeId, startedAt: data.startedAt, restarted: data.restarted === true };
}

function remember(set: Set<string>, key: string): void {
  set.add(key);
  if (set.size > HANDLED_KEEP) set.delete(set.values().next().value as string);
}

export class NodeDeath {
  private fenced = false;
  // Notices already handled ("node|startedAt|restarted", as handled: a death notice downgraded to a restart counts
  // as one): a takeover cut short tells the world again.
  private handled = new Set<string>();
  // Runs ("node|startedAt") told restarted, or found to have a newer run: a death notice for them is a restart.
  private restartedRuns = new Set<string>();
  // Notices under way (the nodeinfo read is awaited), by their own key.
  private running = new Set<string>();
  // Notices with steps that failed, or not yet confirmed because the store could not be read, by their own key.
  private pending = new Map<string, Pending>();
  private retrying = false;

  constructor(private store: Pick<ClusterStore, "get">, private deps: NodeDeathDeps) {}

  isFenced(): boolean {
    return this.fenced;
  }

  attach(bus: Pick<ClusterBus, "on">): void {
    bus.on("node-dead", (data) => { void this.onNodeDead(data); });
  }

  async onNodeDead(data: unknown): Promise<void> {
    if (this.fenced) return;
    const message = messageOf(data);
    if (!message) return;
    if (message.nodeId === this.deps.self && !message.restarted && message.startedAt === this.deps.startedAt) {
      await this.fenceIfConfirmed(message);
      return;
    }
    // Any other notice about this node is about a run of it that is over: it has no steps here, only the adoption.
    const key = `${message.nodeId}|${message.startedAt}|${message.restarted}`;
    if (this.running.has(key)) return;
    if (this.handled.has(key)) {
      // A resent copy of a notice confirmed before: its steps are done, and the adoption runs again (it did before
      // the notices were checked, and it is idempotent), so an adoption that gave up gets another go.
      this.adopt(message);
      return;
    }
    // A resent notice with failed steps (or one not yet confirmed) tries again now.
    await this.handle(key, message, this.pending.get(key));
  }

  /**
   * A death notice naming this node's own run: the node fences only when its tombstone names that run. A notice the
   * store denies is ignored; one whose tombstone cannot be read does not fence either: the tombstone watch (check) and
   * the beat read it again every second, and either stops the node once it is there.
   */
  private async fenceIfConfirmed(message: NodeDeadMessage): Promise<void> {
    const verdict = await this.verdict(message);
    if (this.fenced) return;
    // Guard (test "a node-dead naming this run fences only when the tombstone names the run").
    if (verdict === "confirmed") {
      this.fence("the coordinator took this node's blocks");
      return;
    }
    if (verdict === "denied") log.warn(`A node-dead names run ${message.startedAt} of this node (${this.deps.self}), but no tombstone does: it is ignored`);
    else log.warn(`A node-dead names run ${message.startedAt} of this node (${this.deps.self}), but its tombstone could not be read: not fenced on it; the tombstone watch fences once it reads one`);
  }

  /**
   * Whether the store confirms a notice. A death notice: the tombstone names its run (for another node, a tombstone of
   * a later run of it does too: that run is over as well, so this one is). A restart notice: such a tombstone, or the
   * node's announcement of a later run. "unread": the store failed, and nothing is known.
   */
  private async verdict(message: NodeDeadMessage): Promise<Verdict> {
    const own = message.nodeId === this.deps.self && message.startedAt === this.deps.startedAt;
    try {
      const dead = startedAtOf(await this.store.get(deadKey(message.nodeId)));
      if (dead === message.startedAt) return "confirmed";
      if (!own && dead !== null && dead > message.startedAt) return "confirmed";
      if (!message.restarted || own) return "denied";
      const announced = startedAtOf(await this.store.get(nodeInfoKey(message.nodeId)));
      return announced !== null && announced > message.startedAt ? "confirmed" : "denied";
    } catch {
      return "unread";
    }
  }

  /** The adoption of a confirmed notice's grants. Never for this node's own run, which it checks itself. */
  private adopt(message: NodeDeadMessage): void {
    if (this.fenced || !this.deps.adopt) return;
    if (message.nodeId === this.deps.self && message.startedAt === this.deps.startedAt) return;
    try {
      this.deps.adopt(message.nodeId, message.startedAt);
    } catch (error) {
      log.error(`The hand-overs of run ${message.startedAt} of node ${message.nodeId} could not be adopted: ${error}`);
    }
  }

  /** The steps a notice owes when first handled: none for this node's own last run, the foreign creatures for a restart. */
  private firstSteps(message: NodeDeadMessage): Set<Step> {
    if (message.nodeId === this.deps.self) return new Set();
    return new Set<Step>(message.restarted || this.restartedRuns.has(`${message.nodeId}|${message.startedAt}`) ? ["foreign"] : ["mirrors", "away", "foreign"]);
  }

  /** Tries the failed steps of every notice again, once each. Bounded by RETRY_LIMIT per notice. */
  async retry(): Promise<void> {
    if (this.retrying || this.fenced) return;
    this.retrying = true;
    try {
      for (const [key, pending] of [...this.pending]) {
        if (this.fenced) return;
        // A resent copy may have finished (or replaced) this notice meanwhile: its old steps are not run again.
        if (this.pending.get(key) !== pending) continue;
        if (!this.running.has(key)) await this.handle(key, pending.message, pending);
      }
    } finally {
      this.retrying = false;
    }
  }

  async check(): Promise<boolean> {
    if (this.fenced) return true;
    let tombstone: Tombstone | null = null;
    try {
      const raw = await this.store.get(deadKey(this.deps.self));
      tombstone = raw ? JSON.parse(raw) : null;
    } catch {
      // Redis away, or not a tombstone: nothing is known, so nothing is done.
      return false;
    }
    if (!tombstone || tombstone.startedAt !== this.deps.startedAt) return false;
    this.fence("this node's tombstone was found");
    return true;
  }

  start(everyMs = DEAD_CHECK_MS): () => void {
    let checking = false;
    const timer = setInterval(() => {
      if (checking || this.fenced) return;
      checking = true;
      this.check().then(() => this.retry()).finally(() => { checking = false; });
    }, everyMs);
    (timer as any).unref?.();
    return () => clearInterval(timer);
  }

  private async handle(key: string, message: NodeDeadMessage, again?: Pending): Promise<void> {
    const peer = message.nodeId;
    const run = `${peer}|${message.startedAt}`;
    this.running.add(key);
    try {
      if (!again?.confirmed) {
        const verdict = await this.verdict(message);
        if (this.fenced) return;
        if (verdict === "denied") {
          // Guard (test "a node-dead no tombstone names drops nothing and adopts nothing"). Not remembered as handled:
          // the coordinator's own notice for the run may still come.
          this.pending.delete(key);
          log.warn(`A node-dead for run ${message.startedAt} of node ${peer}${message.restarted ? " (restarted)" : ""} is not confirmed by the store (no tombstone${message.restarted ? " or later announcement" : ""} names it): it is ignored`);
          return;
        }
        if (verdict === "unread") {
          if (!again) log.error(`A node-dead for run ${message.startedAt} of node ${peer} could not be checked against the store: it waits, and is checked again`);
          this.keepPending(key, { message, steps: again?.steps ?? this.firstSteps(message), failures: again?.failures ?? 0, readFailed: false, confirmed: false });
          return;
        }
        this.adopt(message);
      }
      let restarted = message.restarted || this.restartedRuns.has(run);
      // The steps still owed. The creatures the dead node sent here go whatever the nodeinfo read says (they go for a
      // restart too, and a Redis outage must not leave them standing while their slots respawn on the new owner); the
      // mirrors and away slots wait for the read.
      const owed = new Set<Step>(again?.confirmed ? again.steps : this.firstSteps(message));
      let readFailed = false;
      if (!restarted && (owed.has("mirrors") || owed.has("away"))) {
        // Read as late as the steps allow: a new run announced under this id is live, and its mirrors and away
        // slots are not the dead run's.
        try {
          const raw = await this.store.get(nodeInfoKey(peer));
          // A record that cannot be parsed counts as none, not as an outage: an outage keeps the notice waiting.
          let current: unknown = null;
          try {
            current = raw ? JSON.parse(raw)?.startedAt : null;
          } catch {
            current = null;
          }
          if (typeof current === "number" && current !== message.startedAt) restarted = true;
        } catch (error) {
          readFailed = true;
          if (!again?.readFailed) log.error(`Reading the announcement of node ${peer} failed, its mirrors and away slots wait: ${error}`);
        }
      }
      if (this.fenced) return;
      if (restarted) {
        remember(this.restartedRuns, run);
        owed.delete("mirrors");
        owed.delete("away");
      }
      // Already handled as a restart (the notice itself, or a death notice downgraded to one).
      const effective = `${peer}|${message.startedAt}|${restarted}`;
      if (effective !== key && this.handled.has(effective)) {
        this.settle(key, message, new Set(), false, again);
        return;
      }
      const failed = new Set<Step>();
      let mirrors = 0;
      let away = 0;
      let foreign = 0;
      let ran = 0;
      for (const step of owed) {
        if (readFailed && step !== "foreign") continue;
        ran++;
        if (step === "mirrors") mirrors = this.step(failed, step, `Dropping the mirrors of dead node ${peer}`, () => this.deps.dropMirrors(peer));
        else if (step === "away") away = this.step(failed, step, `Releasing the away slots dead node ${peer} held`, () => this.deps.releaseAwayHeldBy(peer));
        else foreign = this.step(failed, step, `Dropping the creatures of dead node ${peer}`, () => this.deps.dropForeignFrom(peer));
      }
      const what = restarted ? "restarted" : "is dead";
      if (ran > 0) log.warn(`Node ${peer} ${what}: ${mirrors} mirror(s), ${away} away slot(s) and ${foreign} foreign creature(s) dropped`);
      // What is still owed: the steps that failed, and the ones that waited for the read.
      const rest = new Set<Step>(failed);
      if (readFailed) for (const step of owed) if (step !== "foreign") rest.add(step);
      this.settle(key, message, rest, readFailed, again, failed.size > 0, effective);
    } finally {
      this.running.delete(key);
    }
  }

  // A notice with nothing owed is done. One with steps owed waits for a retry. Steps that failed count towards
  // RETRY_LIMIT, then are given up; a read that fails does not: it is an outage, and the notice stays until the read works.
  private settle(key: string, message: NodeDeadMessage, owed: Set<Step>, readFailed: boolean, again: Pending | undefined, stepFailed = false, effective?: string): void {
    if (owed.size === 0) {
      this.pending.delete(key);
      remember(this.handled, key);
      if (effective) remember(this.handled, effective);
      return;
    }
    const failures = (again?.failures ?? 0) + (stepFailed ? 1 : 0);
    if (stepFailed && failures > RETRY_LIMIT) {
      this.pending.delete(key);
      remember(this.handled, key);
      log.error(`Gave up on the steps of node-dead for ${message.nodeId} run ${message.startedAt} that failed ${RETRY_LIMIT} times: ${[...owed].join(", ")}`);
      return;
    }
    this.keepPending(key, { message, steps: owed, failures, readFailed, confirmed: true });
  }

  // Keeps a notice for a retry. At most HANDLED_KEEP wait: past that the oldest one not yet confirmed goes (it is a
  // notice the store could not check, so nothing of it was done), else the oldest.
  private keepPending(key: string, entry: Pending): void {
    this.pending.delete(key);
    this.pending.set(key, entry);
    if (this.pending.size <= HANDLED_KEEP) return;
    let drop: string | undefined;
    for (const [k, p] of this.pending) {
      if (!p.confirmed) { drop = k; break; }
    }
    drop ??= this.pending.keys().next().value as string;
    const dropped = this.pending.get(drop)!;
    this.pending.delete(drop);
    log.error(`Too many node-dead notices wait: the one for run ${dropped.message.startedAt} of node ${dropped.message.nodeId} is dropped (${dropped.confirmed ? `its steps ${[...dropped.steps].join(", ")} are not done` : "it was never confirmed"})`);
  }

  private fence(why: string): void {
    if (this.fenced) return;
    this.fenced = true;
    log.error(`Cluster node ${this.deps.self} is fenced: ${why}`);
    try {
      this.deps.fence(why);
    } catch (error) {
      log.error(`Fencing cluster node ${this.deps.self} failed: ${error}`);
    }
  }

  private step(failed: Set<Step>, step: Step, what: string, run: () => number): number {
    try {
      return run();
    } catch (error) {
      failed.add(step);
      log.error(`${what} failed: ${error}`);
      return 0;
    }
  }
}
