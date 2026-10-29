import { randomUUID } from "node:crypto";
import log from "../modules/logger";
import { registerPlayerAction, runOnPlayer } from "./deliver";
import type { ClusterStore } from "./store";

// Items handed over across a border, kept until someone writes them (spec §7). The owner of a corpse, ground loot,
// a chest or a gathering node takes the items off and answers with them; the player's node writes them. An answer
// that is lost used to lose the items. Now the owner parks the hand-over under cells:grant:<id> before it answers,
// and whoever takes that key writes it: the asker when the answer came (claim), else the player's node when the
// owner's recovery asks it to (cells-grant-recover), else the owner itself, to the rows. `take` reads and deletes
// in one step, so one of them gets it and the grant is written at most once.
//
// Corpse money sent to a member on another node (GRANT) carries a grant id too: the receiver marks the id given
// (cells:granted:<id>) before it writes, so a share whose answer was lost can be sent again.
//
// With no store attached nothing is parked, no grant id is made, and every path runs as before.
//
// The owner's checks run only while its node may act as owner (its lease, cells phase 7): a node cut off from the
// store, or taken over, writes no grant to the rows. Each grant a run parks is listed under that run, so when the run
// is over another node adopts what it still checked (adoptFrom).
//
// The grant records are sealed (storeseal.ts, security review H1): a record a node did not write counts as missing.
// A record names its own id, its owner node and the run that parked it; one read under another id, or listed under
// another run, is not taken as that grant. An id put in a run's list by hand is ignored unless its sealed record names
// that run. What a seal cannot stop is a record put back after it was taken (the same sealed bytes): the database
// row of each grant id written (systems/grantwriter.ts) keeps that from being written twice.

export const GRANT_TTL_MS = 600_000;
/** When the owner checks a parked grant, from the park: past the call timeout (10 s), so an answer that came is claimed. */
export const GRANT_RECOVER_DELAYS_MS: readonly number[] = [12_000, 30_000, 60_000];
/** How long a check that failed on the store waits to run again. */
export const GRANT_STORE_RETRY_MS = 30_000;
/** How many times the adoption of a dead run's grants is tried before it is given up. */
export const GRANT_ADOPT_TRIES = 5;
/** The most item rows one grant holds (a corpse or chest holds fewer). */
export const MAX_GRANT_ITEMS = 64;

/** The most grant ids remembered for the once-per-grant re-park warn; past it the memory starts over. */
const REPARKED_KEEP = 4096;
const MAX_COUNT = 2_147_483_647;
const MAX_ID = 128;

export const grantKey = (id: string) => `cells:grant:${id}`;
export const grantedKey = (id: string) => `cells:granted:${id}`;
/** The ids of the grants one run of a node parked and still checks. */
export const runGrantsKey = (nodeId: string, startedAt: number) => `cells:grants:${nodeId}|${startedAt}`;
/** Which node adopts a dead run's grants: the first to set it. */
export const grantAdoptKey = (nodeId: string, startedAt: number) => `cells:grant-adopt:${nodeId}|${startedAt}`;

export interface GrantItem { itemName: string; quantity: number }
export interface HandOver { username: string; items: GrantItem[]; copper: number; call: string }
export interface ParkedGrant extends HandOver {
  id: string;
  owner: string;
  at: number;
  /** The run of `owner` that parked it (its startedAt), or 0 when that run is not known: adoption takes it only from that run's list. */
  run?: number;
}
/** Writes a grant for its player: `player` is the player on this node, or null to write their rows only. Throws when it cannot. */
export type GrantWriter = (grant: ParkedGrant, player: any | null) => Promise<void>;
export interface GrantDeps {
  runOnPlayer(username: string, action: string, args: unknown): Promise<boolean>;
  now(): number;
}
export interface GrantOptions { delays?: readonly number[]; storeRetryMs?: number; ttlMs?: number }
export interface GrantAttachOptions {
  /** The run of this node (its startedAt): the grants it parks are listed under it. None: they are not listed. */
  run?: number;
  /** Whether this node may act as owner now (its lease is valid and its run not taken). Default: always. */
  mayAct?: () => boolean;
}

const lower = (value: unknown) => String(value ?? "").toLowerCase();
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_COUNT;
const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_ID;

/** What a grant holds, as one line ("2 x Bone, 11 copper"). */
export function describeGrant(grant: Pick<HandOver, "items" | "copper">): string {
  const parts = grant.items.map((item) => `${item.quantity} x ${item.itemName}`);
  if (grant.copper > 0) parts.push(`${grant.copper} copper`);
  return parts.join(", ") || "nothing";
}

/**
 * The items and money an item call's answer hands over: `items` (corpse, chest), `item` as a row (ground loot,
 * `{ item, quantity }`) or `item` as a name with `quantity` (a gathered node), and `copper`.
 */
export function handOverOf(answer: Record<string, unknown>): { items: GrantItem[]; copper: number } {
  const rows: any[] = Array.isArray(answer.items)
    ? answer.items
    : answer.item && typeof answer.item === "object"
      ? [answer.item]
      : typeof answer.item === "string"
        ? [{ itemName: answer.item, quantity: answer.quantity }]
        : [];
  const items = rows.slice(0, MAX_GRANT_ITEMS).map((row) => ({
    itemName: String(row?.itemName ?? row?.item ?? ""),
    quantity: Math.max(1, Math.floor(Number(row?.quantity) || 1)),
  })).filter((item) => item.itemName);
  const copper = Math.max(0, Math.floor(Number(answer.copper) || 0));
  return { items, copper };
}

/**
 * Whether a writer's error was thrown before its batch's transaction was sent (services/batch.ts nothingWritten).
 * The batch module is loaded only here, when a write failed: it loads the database layer, which this module does not
 * need otherwise. The writer that threw has loaded it already.
 */
async function wroteNothing(error: unknown): Promise<boolean> {
  try {
    return (await import("../services/batch")).nothingWritten(error);
  } catch {
    return false;
  }
}

/** A parked grant as the store holds it, or null when it is not one. `id`: the id it was read under, which it must name. */
function grantOf(raw: string | null, id?: string): ParkedGrant | null {
  if (!raw) return null;
  let value: any;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || !isId(value.id) || typeof value.username !== "string" || !value.username || !isCount(value.copper)) return null;
  // Guard (test "a grant record read under another id is not that grant").
  if (id !== undefined && value.id !== id) return null;
  if (!Array.isArray(value.items) || value.items.length > MAX_GRANT_ITEMS) return null;
  const items: GrantItem[] = [];
  for (const item of value.items) {
    if (!item || typeof item.itemName !== "string" || !item.itemName || !isCount(item.quantity) || item.quantity < 1) return null;
    items.push({ itemName: item.itemName, quantity: item.quantity });
  }
  return {
    id: value.id, username: value.username, items, copper: value.copper, call: String(value.call ?? ""),
    owner: String(value.owner ?? ""), at: Number(value.at) || 0, run: Number.isFinite(value.run) ? value.run : 0,
  };
}

interface Pending {
  grant: ParkedGrant;
  timer: ReturnType<typeof setTimeout> | null;
  /** A take of it threw: it may have run, so a grant found gone after that may be lost, not claimed. */
  takeFailed: boolean;
}

export class Grants {
  private store: ClusterStore | null = null;
  /**
   * Counts the detaches (an attach detaches first). A timer set before a stop finds it changed, also when the node
   * attached again with the same store object (tests), and does nothing.
   */
  private generation = 0;
  private self = "";
  /** The list of grants this run parked, or null when the run is not known. */
  private runKey: string | null = null;
  /** This node's run (its startedAt), written on each grant it parks; 0 when not known. */
  private run = 0;
  private mayAct: () => boolean = () => true;
  private writer: GrantWriter | null = null;
  /** The grants parked again here, whose re-park was logged at warn once (parkAgain). */
  private reparked = new Set<string>();
  /** The grants this node parked and still checks, by id: the next check's timer, and whether a take of it failed on the store. */
  private pending = new Map<string, Pending>();
  private readonly delays: readonly number[];
  private readonly storeRetryMs: number;
  private readonly ttlMs: number;

  constructor(private readonly deps: GrantDeps, opts: GrantOptions = {}) {
    this.delays = opts.delays ?? GRANT_RECOVER_DELAYS_MS;
    this.storeRetryMs = opts.storeRetryMs ?? GRANT_STORE_RETRY_MS;
    this.ttlMs = opts.ttlMs ?? GRANT_TTL_MS;
  }

  attach(store: ClusterStore, self: string, opts: GrantAttachOptions = {}): void {
    // detach counts the generation on.
    this.detach();
    this.store = store;
    this.self = self;
    this.runKey = opts.run === undefined ? null : runGrantsKey(self, opts.run);
    this.run = opts.run ?? 0;
    this.mayAct = opts.mayAct ?? (() => true);
  }

  /**
   * Stops the checks. A grant not yet claimed stays parked until it runs out: its asker can still claim it. Each one is
   * logged by id and by what it holds, so one that runs out unclaimed is on record by name.
   */
  detach(): void {
    for (const { grant, timer } of this.pending.values()) {
      if (timer) clearTimeout(timer);
      log.warn(`Hand-over ${grant.id} for ${grant.username} is no longer checked here: ${describeGrant(grant)} is given only if its asker claims it before it runs out (${this.ttlMs} ms after it was parked)`);
    }
    this.pending.clear();
    this.generation++;
    this.store = null;
    this.runKey = null;
    this.run = 0;
    this.mayAct = () => true;
  }

  attached(): boolean {
    return this.store !== null;
  }

  /** Answers the writer set before. grantwriter.ts sets the engine's when it loads. */
  setWriter(writer: GrantWriter | null): GrantWriter | null {
    const previous = this.writer;
    this.writer = writer;
    return previous;
  }

  newId(): string {
    return `${this.self || "node"}:${randomUUID()}`;
  }

  /**
   * Parks a hand-over and schedules its recovery. The grant id, or null (no store, or the write failed).
   *
   * `id`: a grant that was taken and could not be written is parked again under its own id (security review Important
   * 3). Every copy of one hand-over then shares one grant_writes row (systems/grantwrites.ts), so a copy the store
   * brings back after a rollback, and the re-park, are written at most once between them. The record is this node's
   * now: its owner and run are this node's, so it is listed under this run and adopted from this run's list. Guard
   * (test "a re-parked hand-over keeps its id: a rolled-back copy of it and the re-park are written once").
   */
  async park(handOver: HandOver, id?: string): Promise<string | null> {
    const store = this.store;
    if (!store) return null;
    if (id !== undefined && !isId(id)) {
      log.error(`${handOver.call} for ${handOver.username} (${describeGrant(handOver)}) could not be parked again: ${String(id).slice(0, MAX_ID)} is not a grant id`);
      return null;
    }
    const grant: ParkedGrant = { ...handOver, id: id ?? this.newId(), owner: this.self, at: this.deps.now(), run: this.run };
    try {
      await store.set(grantKey(grant.id), JSON.stringify(grant), this.ttlMs);
    } catch (error) {
      log.error(`${handOver.call} for ${handOver.username} (${describeGrant(handOver)}) could not be parked, so a lost answer loses it: ${error}`);
      return null;
    }
    // Every later line about this grant names only its id: this one ties the id to what it holds.
    log.info(`Hand-over ${grant.id} (${grant.call}) parked for ${grant.username}: ${describeGrant(grant)}`);
    // A check of the same id still scheduled here (a recover on this node took it) is replaced: one entry per id, and the
    // one it replaced is stale (current).
    const before = this.pending.get(grant.id);
    if (before?.timer) clearTimeout(before.timer);
    const entry: Pending = { grant, timer: null, takeFailed: false };
    this.pending.set(grant.id, entry);
    this.schedule(store, entry, 0, this.delays[0] ?? 0);
    await this.list(store, grant);
    return grant.id;
  }

  /**
   * A run of a node is over (node-dead, or a restart under the same id; this node's own last run too): the grants it
   * still checked are checked here from now on. One node adopts them, the first to set the adopt key. A store that
   * fails, or a lease this node does not hold, is tried again, GRANT_ADOPT_TRIES times in all; past that the run's
   * grants are checked by no one, and only their askers can claim them. How many were adopted.
   */
  async adoptFrom(nodeId: string, startedAt: number, attempt = 1): Promise<number> {
    const store = this.store;
    const generation = this.generation;
    if (!store || !Number.isFinite(startedAt)) return 0;
    const runKey = runGrantsKey(nodeId, startedAt);
    // This run's own list is not adopted: its grants are checked here already.
    if (this.runKey === runKey) return 0;
    let adopted = 0;
    try {
      if (!this.mayAct()) throw new Error("this node does not hold its lease");
      const adoptKey = grantAdoptKey(nodeId, startedAt);
      // A try that won before and then failed finds its own name there.
      if (!(await store.setIfAbsent(adoptKey, this.self, this.ttlMs)) && (await store.get(adoptKey)) !== this.self) return 0;
      for (const id of await store.members(runKey)) {
        if (this.generation !== generation) return adopted;
        if (this.pending.has(id)) continue;
        // Gone: claimed, recovered or written already (or a record that is not sealed, which the store logged).
        const grant = grantOf(await store.get(grantKey(id)), id);
        if (!grant) continue;
        // Guard (test "an id listed under a run its record does not name is not adopted"): only the grants this run
        // parked. A live run's grant listed here by hand stays with its own owner.
        if (grant.owner !== nodeId || grant.run !== startedAt) {
          log.warn(`Hand-over ${grant.id} is listed under run ${startedAt} of node ${nodeId}, but was parked by run ${grant.run} of node ${grant.owner}: not adopted from that list`);
          continue;
        }
        const entry: Pending = { grant, timer: null, takeFailed: false };
        this.pending.set(grant.id, entry);
        this.schedule(store, entry, 0, this.delays[0] ?? 0);
        log.warn(`Hand-over ${grant.id} for ${grant.username} (${describeGrant(grant)}), parked by run ${startedAt} of node ${nodeId}, is checked here now`);
        await this.list(store, grant);
        adopted++;
      }
      await store.del(runKey);
    } catch (error) {
      if (attempt >= GRANT_ADOPT_TRIES) {
        log.error(`The hand-overs parked by run ${startedAt} of node ${nodeId} were not adopted (${error}): any not adopted yet are checked by no one, and are given only if their askers claim them before they run out`);
        return adopted;
      }
      log.warn(`The hand-overs parked by run ${startedAt} of node ${nodeId} could not be adopted (${error}): tried again in ${this.storeRetryMs} ms`);
      const timer = setTimeout(() => {
        // Guard (test "a stop and an attach again with the same store does not run an old adoption retry").
        if (this.generation === generation) void this.adoptFrom(nodeId, startedAt, attempt + 1);
      }, this.storeRetryMs);
      (timer as any).unref?.();
    }
    return adopted;
  }

  /** Lists the grant under this run, for adoption should the run end. A grant not listed is still checked here. */
  private async list(store: ClusterStore, grant: ParkedGrant): Promise<void> {
    const runKey = this.runKey;
    if (!runKey) return;
    try {
      await store.addToSet(runKey, grant.id);
      await store.expire(runKey, this.ttlMs);
    } catch (error) {
      log.warn(`Hand-over ${grant.id} for ${grant.username} (${describeGrant(grant)}) could not be listed for adoption (${error}): should this node die, it is given only if its asker claims it`);
    }
  }

  /** Takes a settled grant off this run's list. A failure leaves an id whose grant is gone, which adoption skips. */
  private unlist(store: ClusterStore, id: string): void {
    const runKey = this.runKey;
    if (!runKey) return;
    void store.removeFromSet(runKey, id).catch(() => {});
  }

  /**
   * A check of `entry` is done with it: off the checks and this run's list. An entry a re-park under the same id
   * replaced (park) is not, since the newer one is listed and checked by that id: removing it would leave the re-park
   * unchecked here and not adoptable. The unlist goes before the write, so a re-park's list comes after it.
   */
  private settle(store: ClusterStore, entry: Pending): void {
    if (!this.current(entry)) return;
    this.pending.delete(entry.grant.id);
    this.unlist(store, entry.grant.id);
  }

  /**
   * The asker takes the grant: true only for the one caller that got it. `handed` is what the answer carried, for the
   * log line when the store fails: a take that ran on the store but whose reply was lost leaves the grant to nobody.
   */
  async claim(id: string, handed?: Pick<HandOver, "items" | "copper">): Promise<boolean> {
    const store = this.store;
    if (!store) {
      log.warn(`Hand-over ${id} could not be claimed: the cluster store is not attached, so its owner gives it later`);
      return false;
    }
    try {
      return (await store.take(grantKey(id))) !== null;
    } catch (error) {
      log.error(`Hand-over ${id} could not be claimed (${error}): ${handed ? describeGrant(handed) : "what it holds"} may be lost, if the store took it before it failed; else its owner gives it later`);
      return false;
    }
  }

  /**
   * Marks a money grant id given: true the first time, false when it was given before. With no store it is always
   * true. Throws when the store cannot set the mark: the caller does not give it, since a share sent again after a
   * mark that was never set would be given twice. A share that may exist twice becomes one that is lost by name.
   */
  async firstApply(id: string): Promise<boolean> {
    const store = this.store;
    if (!store) return true;
    return await store.setIfAbsent(grantedKey(id), "1", this.ttlMs);
  }

  async unapply(id: string): Promise<void> {
    try {
      await this.store?.del(grantedKey(id));
    } catch (error) {
      log.error(`Money grant ${id} keeps its once-only mark after a failed write, so a second send of it is not given: ${error}`);
    }
  }

  /** cells-grant-recover, on the player's node. */
  async recoverHere(player: any, args: unknown): Promise<void> {
    const id = (args as any)?.id;
    if (!isId(id)) return;
    const grant = await this.takeGrant(id);
    if (!grant) return;
    // The bus runs an action on the player it names: one for someone else is written to that player's rows.
    await this.write(grant, lower(grant.username) === lower(player?.username) ? player : null);
  }

  /**
   * Whether `entry` is still the one checked for its id. A re-park under the same id (park) replaces it: the stale one
   * schedules, checks and settles nothing from then on, so one id has one chain of checks, and the re-park stays
   * pending and listed. Guard (test "a re-park under the same id on this node replaces its check: one chain of checks
   * per id").
   */
  private current(entry: Pending): boolean {
    return this.pending.get(entry.grant.id) === entry;
  }

  private schedule(store: ClusterStore, entry: Pending, step: number, ms: number): void {
    // Detached meanwhile (detach logged it, and the store it was parked in is no longer this node's to check), or stale.
    if (!this.current(entry) || this.store !== store) return;
    const timer = setTimeout(() => {
      entry.timer = null;
      void this.check(store, entry, step);
    }, ms);
    (timer as any).unref?.();
    entry.timer = timer;
  }

  private async check(store: ClusterStore, entry: Pending, step: number): Promise<void> {
    if (this.store !== store || !this.current(entry)) return;
    const grant = entry.grant;
    // A node that may not act as owner (its lease lapsed, or its run was taken) writes nothing: checked again later.
    if (!this.mayAct()) {
      this.retryLater(store, entry, step, "this node does not hold its lease");
      return;
    }
    let held: string | null;
    try {
      held = await store.get(grantKey(grant.id));
    } catch (error) {
      this.retryLater(store, entry, step, error);
      return;
    }
    if (held === null) {
      // Claimed or recovered: nothing more to do. After a take here that failed on the store, that take may have run
      // and its value gone with the failed reply: nobody has written it.
      if (entry.takeFailed) log.error(`Hand-over ${grant.id} for ${grant.username} may be lost: ${describeGrant(grant)} (a take of it here failed on the store, and it is gone now)`);
      this.settle(store, entry);
      return;
    }
    // Still held: a take here that failed did not run, so a later "gone" is a claim, not a loss.
    entry.takeFailed = false;
    const last = step >= this.delays.length - 1;
    if (!last) {
      let sent = false;
      try {
        sent = await this.deps.runOnPlayer(grant.username, "cells-grant-recover", { id: grant.id });
      } catch (error) {
        log.error(`Hand-over ${grant.id} for ${grant.username}: the recover action could not be sent: ${error}`);
      }
      if (sent) {
        this.schedule(store, entry, step + 1, this.delays[step + 1]! - this.delays[step]!);
        return;
      }
    }
    // The player is on no node, or the action did not take it: written to the rows from here.
    let taken: string | null;
    try {
      taken = await store.take(grantKey(grant.id));
    } catch (error) {
      entry.takeFailed = true;
      this.retryLater(store, entry, step, error);
      return;
    }
    this.settle(store, entry);
    const parked = grantOf(taken, grant.id);
    if (!parked) {
      // Taken by someone else between the read and the take (nothing to do), or a value that is not a grant.
      if (taken !== null) log.error(`Hand-over ${grant.id} for ${grant.username} is lost: ${describeGrant(grant)} (the store held a value that is not a grant)`);
      return;
    }
    log.warn(`Hand-over ${parked.id} for ${parked.username} (${describeGrant(parked)}) was not claimed: it is written to their rows from here`);
    await this.write(parked, null);
  }

  private retryLater(store: ClusterStore, entry: Pending, step: number, error: unknown): void {
    const grant = entry.grant;
    // Stale (a re-park under the same id replaced it): the newer entry has its own checks.
    if (!this.current(entry)) return;
    if (this.deps.now() + this.storeRetryMs - grant.at < this.ttlMs) {
      log.warn(`Hand-over ${grant.id} for ${grant.username} could not be checked (${error}): checked again in ${this.storeRetryMs} ms`);
      this.schedule(store, entry, step, this.storeRetryMs);
      return;
    }
    this.pending.delete(grant.id);
    log.error(`Hand-over ${grant.id} for ${grant.username} is lost: ${describeGrant(grant)} (the store failed until it ran out: ${error})`);
  }

  private async takeGrant(id: string): Promise<ParkedGrant | null> {
    const store = this.store;
    if (!store) return null;
    let taken: string | null;
    try {
      taken = await store.take(grantKey(id));
    } catch (error) {
      // Its park line on the owner names what it holds.
      log.error(`Hand-over ${id} could not be taken (${error}): it may be lost, if the store took it before it failed; else its owner's next check has it`);
      return null;
    }
    const grant = grantOf(taken, id);
    if (!grant && taken !== null) log.error(`Hand-over ${id} is lost: the store held a value that is not a grant`);
    return grant;
  }

  private async write(grant: ParkedGrant, player: any | null): Promise<void> {
    const writer = this.writer;
    if (!writer) {
      log.error(`Hand-over ${grant.id} for ${grant.username} is lost: ${describeGrant(grant)}: no grant writer is set`);
      return;
    }
    try {
      await writer(grant, player);
    } catch (error) {
      // Thrown before its transaction was sent (the player's lock held on another node, a lock store that timed out):
      // nothing was written, and the grant, already taken off the store, is parked again under its own id. Any other
      // failure may come after the commit: parked again, it could be given twice, so it is logged lost by name.
      if (await wroteNothing(error) && await this.parkAgain(grant, error)) return;
      log.error(`Hand-over ${grant.id} for ${grant.username} is lost: ${describeGrant(grant)}: ${error}`);
    }
  }

  /**
   * Parks a grant that could not be written again, under its own id (park). False when it could not be parked. The
   * first re-park of a grant here is a warn, later ones info (security review Minor 9): a grant whose bounds are not read
   * yet is parked again at every check until they are.
   */
  private async parkAgain(grant: ParkedGrant, error: unknown): Promise<boolean> {
    // Guard (test "a re-parked hand-over keeps its id: a rolled-back copy of it and the re-park are written once").
    const id = await this.park({ username: grant.username, items: grant.items, copper: grant.copper, call: grant.call }, grant.id);
    if (!id) return false;
    // Guard (test "a re-park of the same hand-over warns once, then logs at info").
    const first = !this.reparked.has(id);
    if (first) {
      if (this.reparked.size >= REPARKED_KEEP) this.reparked.clear();
      this.reparked.add(id);
    }
    (first ? log.warn : log.info)(`Hand-over ${grant.id} for ${grant.username} could not be written (${error}): nothing was written, so it is parked again as hand-over ${id}`);
    return true;
  }
}

/** The node's grants. Nothing is parked until startCluster attaches the store (Task 21). */
export const grants = new Grants({ runOnPlayer, now: Date.now });

registerPlayerAction(
  "cells-grant-recover",
  (player, args) => grants.recoverHere(player, args),
  (args) => `hand-over ${String(args?.id).slice(0, MAX_ID)} stays parked for its owner's next check`,
);
