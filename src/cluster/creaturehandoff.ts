import log from "../modules/logger";
import type { CreatureSpawner } from "../systems/creatures/spawner";
import { AIState, type CreatureInstance } from "../systems/creatures/types";
import type { Ghosts } from "./ghosts";
import { bareMapName, type OwnerAt } from "./handoffwatch";
import type { LinkCalls } from "./linkcalls";

// A creature that walks into a block another node owns moves to that node (cells phase 6, spec §5). It is a
// reservation, then a commit: the receiving node reserves the id for 5 s, the holder casts the creature and turns
// its own copy into a mirror in the same step, and the receiver makes it live. The commit is cast before anything
// changes here, so a lost commit loses the creature (a mirror here, nothing there) and never doubles it. The node
// that owns the creature's spawn slot (its home) keeps the slot as an away slot, and learns of the creature's
// moves and death; the sweeps find what a broken link lost.

export const RESERVE_MS = 5_000;
export const COOLDOWN_MS = 2_000;
export const SWEEP_GRACE_MS = 10_000;
export const OUTBOX_LIMIT = 1_000;
export const CREATURE_HANDOFF_ACK_MS = 2_000;
/** How long the old holder remembers where a creature went, for the home's sweep. */
export const HANDED_KEEP_MS = 60_000;
/** The longest respawn delay a CREATURE_DIED may ask for; a longer one (or none) rolls the slot's own. */
const DIED_DELAY_MAX_MS = 24 * 60 * 60_000;

/** A creature as it travels (Task 16 builds and reads every field past these). */
export interface SerializedCreature { id: number; templateId: number; map: string; x: number; y: number; [field: string]: unknown }
export type CreatureHandoffReply = { ok: boolean; reason?: string };
export type CreatureHandoffResult = "moved" | "refused" | "busy" | "gone";
export type HeldAnswer = { state: "here" } | { state: "moved"; to: string } | { state: "gone" };

export interface CreatureHandoffDeps {
  calls: Pick<LinkCalls, "call" | "cast" | "handle" | "onCast" | "onPeerUp">;
  ghosts: Pick<Ghosts, "handOver" | "adoptMirror">;
  self: string;
  ownerAt: OwnerAt;
  now(): number;
  /** The live creature with this id on this node (not a mirror), or null. */
  creature(id: number): CreatureInstance | null;
  serialize(c: CreatureInstance): SerializedCreature;
  /** Make a creature handed over here live. home null: this node owns its spawn slot. False when it could not be. */
  arrive(s: SerializedCreature, home: string | null): boolean;
  /** Turn the local creature into a mirror of the copy `to` now holds, in place. */
  toMirror(c: CreatureInstance, to: string): void;
  ghostRecord(c: CreatureInstance): any;
  templateKnown(templateId: number): boolean;
  templateName(templateId: number): string;
  /** The creature holds its own live spawn slot on this node. */
  ownsSlot(c: CreatureInstance): boolean;
  spawner: Pick<CreatureSpawner, "markAway" | "moveAway" | "releaseAway" | "dropForeign" | "foreignHome" | "awaySlots" | "foreignCreatures">
    // Cells phase 7 (a slot moving with its block). Optional, so a fake without them still fits.
    & Partial<Pick<CreatureSpawner, "outgoingHome" | "rehome" | "movingOut" | "outgoingTemplate">>;
  /** Remove a foreign creature whose home has no slot for it, with no CREATURE_DIED. */
  despawnForeign(id: number): void;
  /** Pass calls about the creature on to `to` for a while (Task 8). */
  forward(id: number, to: string): void;
}

type OutboxEntry = { peer: string; name: string; body: unknown; what: string };
type Reservation = { from: string; home: string; templateId: number; until: number };

const isId = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;
const shown = (value: unknown) => String(value).slice(0, 64);
const reason = (error: unknown) => shown(error instanceof Error ? error.message : error);
// Functions, not inline tests, so the checks after the await are not narrowed away by the ones before it.
const isDead = (c: CreatureInstance) => c.state === AIState.DEAD;
const isCasting = (c: CreatureInstance) => !!c.casting;

function byPeer<T>(items: T[], peerOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const peer = peerOf(item);
    let list = groups.get(peer);
    if (!list) groups.set(peer, (list = []));
    list.push(item);
  }
  return groups;
}

export class CreatureHandoff {
  private deps: CreatureHandoffDeps | null = null;
  private undo: Array<() => void> = [];
  private readonly reserved = new Map<number, Reservation>();
  private readonly cooling = new Map<number, number>();
  private readonly handedTo = new Map<number, { to: string; at: number }>();
  private readonly suspects = new Map<string, number>();
  private readonly outbox = new Map<string, OutboxEntry>();
  private readonly flushing = new Set<string>();
  private readonly flushAgain = new Set<string>();
  private readonly outboxLimit: number;
  private sweeping = false;

  constructor(opts: { outboxLimit?: number } = {}) {
    this.outboxLimit = opts.outboxLimit ?? OUTBOX_LIMIT;
  }

  start(deps: CreatureHandoffDeps): void {
    this.stop();
    this.deps = deps;
    const { calls } = deps;
    this.undo = [
      calls.handle("CREATURE_HANDOFF", (body, from) => this.onReserve(body, from)),
      calls.onCast("CREATURE_HANDOFF_COMMIT", (body, from) => this.onCommit(body, from)),
      calls.onCast("CREATURE_HANDOFF_ABORT", (body, from) => this.onAbort(body, from)),
      calls.handle("CREATURE_MOVED", (body, from) => this.onMoved(body, from)),
      calls.handle("CREATURE_DIED", (body, from) => this.onDied(body, from)),
      calls.handle("CREATURE_HELD", (body) => this.onHeld(body)),
      calls.handle("CREATURE_SLOT", (body) => this.onSlot(body)),
      calls.onCast("CREATURE_HOME", (body, from) => this.onHome(body, from)),
      calls.onPeerUp((peer) => { void this.flush(peer); }),
    ];
  }

  stop(): void {
    for (const fn of this.undo) fn();
    this.undo = [];
    this.deps = null;
    this.reserved.clear();
    this.cooling.clear();
    this.handedTo.clear();
    this.suspects.clear();
    this.flushing.clear();
    this.flushAgain.clear();
    // The outbox is kept: a death that was not sent yet is still owed when the links come back.
  }

  coolingDown(id: number): boolean {
    const until = this.cooling.get(id);
    if (until === undefined || !this.deps) return false;
    if (this.deps.now() >= until) {
      this.cooling.delete(id);
      return false;
    }
    return true;
  }

  outboxSize(): number {
    return this.outbox.size;
  }

  async handOff(c: CreatureInstance, target: string): Promise<CreatureHandoffResult> {
    const deps = this.deps;
    if (!deps || target === deps.self) return "busy";
    if (c.handoff || c.remote || isDead(c) || isCasting(c) || this.coolingDown(c.id)) return "busy";
    // Its slot is moving out with its block: it stays here until the move is sent or restored, so a restore finds it
    // and never respawns its slot while another node holds it.
    if (deps.spawner.movingOut?.(c.id, deps.now())) return "busy";
    const home = deps.spawner.foreignHome(c.id) ?? deps.self;
    // A creature with no slot of its own here (a stale copy) is not offered: its home would refuse it anyway.
    if (home === deps.self && !deps.ownsSlot(c)) return "busy";
    c.handoff = true;
    try {
      const outcome = await deps.calls.call<CreatureHandoffReply>(
        target, "CREATURE_HANDOFF",
        { id: c.id, templateId: c.templateId, map: bareMapName(c.map), x: c.x, y: c.y, home },
        { timeoutMs: CREATURE_HANDOFF_ACK_MS },
      );
      if (!outcome.ok || !outcome.answer?.ok) {
        deps.calls.cast(target, "CREATURE_HANDOFF_ABORT", { id: c.id });
        this.cool(c.id);
        return "refused";
      }
      // The creature may have died, been handed on or despawned while the call ran.
      if (deps.creature(c.id) !== c || c.remote || isDead(c)) {
        deps.calls.cast(target, "CREATURE_HANDOFF_ABORT", { id: c.id });
        return "gone";
      }
      // Or it started a cast, which is not carried over.
      if (isCasting(c)) {
        deps.calls.cast(target, "CREATURE_HANDOFF_ABORT", { id: c.id });
        this.cool(c.id);
        return "busy";
      }
      // Or its slot changed (a reload, or its home took it back): the reservation was made for the old one.
      if ((deps.spawner.foreignHome(c.id) ?? deps.self) !== home || (home === deps.self && !deps.ownsSlot(c))) {
        deps.calls.cast(target, "CREATURE_HANDOFF_ABORT", { id: c.id });
        this.cool(c.id);
        return "gone";
      }
      const record = deps.ghostRecord(c);
      // The commit goes first. If it cannot be sent, nothing below runs and the creature stays here.
      if (!deps.calls.cast(target, "CREATURE_HANDOFF_COMMIT", { creature: deps.serialize(c), home })) {
        this.cool(c.id);
        return "refused";
      }
      this.letGo(deps, c, target, home, record);
      return "moved";
    } finally {
      c.handoff = false;
    }
  }

  /**
   * Step 6, once the commit went out: one synchronous step, so no scan or tick sees the creature half moved. The
   * target makes the creature live from the commit, so this copy must end a mirror whatever throws here: each part
   * runs on its own, in order, and one that throws is logged with the creature's name and stops none of the others.
   */
  private letGo(deps: CreatureHandoffDeps, c: CreatureInstance, target: string, home: string, record: unknown): void {
    const name = this.named(c.templateId, c.id);
    const step = (what: string, fn: () => void) => {
      try {
        fn();
      } catch (error) {
        log.warn(`Creature ${name} handed to ${shown(target)}: ${what} failed (${reason(error)})`);
      }
    };
    step("handing its mirrors over", () => deps.ghosts.handOver("creature", c.id, target));
    step("giving up its slot", () => {
      if (home !== deps.self) deps.spawner.dropForeign(c.id);
      else if (!deps.spawner.markAway(c.id, target)) {
        // No live slot here to keep away: the target holds it as this node's foreign creature, and its sweep
        // removes it when this node answers it has no slot for it.
        log.warn(`Creature ${name} handed to ${shown(target)} had no live slot here to keep: ${shown(target)} removes it at its sweep`);
      }
    });
    step("turning it into a mirror", () => deps.toMirror(c, target));
    // Never left live here, even when toMirror threw: the copy on the target is the creature now.
    if (!c.remote) c.remote = true;
    step("adopting its mirror", () => deps.ghosts.adoptMirror("creature", record, target));
    step("forwarding its calls", () => deps.forward(c.id, target));
    if (home !== deps.self && home !== target) this.send(home, "CREATURE_MOVED", { id: c.id, holder: target }, name);
    this.handedTo.set(c.id, { to: target, at: deps.now() });
  }

  /** A foreign creature left the world here: tell its home (CREATURE_DIED), now or when the link is back. */
  died(id: number, templateId: number, home: string, opts: { respawn: boolean; delayMs: number | null }): void {
    this.send(home, "CREATURE_DIED", { id, respawn: !!opts.respawn, delayMs: opts.delayMs ?? null }, this.named(templateId, id));
  }

  /** A block's old owner: the slot of creature `id`, which `holder` holds, moved with its block to `home`. */
  tellHome(holder: string, id: number, home: string): boolean {
    return this.deps ? this.deps.calls.cast(holder, "CREATURE_HOME", { id, home }) : false;
  }

  /** Where the slot of creature `id` went with its block, while this node still answers for it; else null. */
  private movedTo(id: number): string | null {
    const deps = this.deps;
    const to = deps?.spawner.outgoingHome?.(id, deps.now()) ?? null;
    return to && to !== deps?.self ? to : null;
  }

  /**
   * Whether the slot of creature `id` is moving out with its block, the move not yet sent or put back. Its new home
   * is not known then (movedTo answers null), and a move put back keeps the slot here.
   */
  private slotMoving(id: number): boolean {
    const deps = this.deps;
    return !!deps?.spawner.movingOut?.(id, deps.now());
  }

  /**
   * Ask the other side of each away slot and each foreign creature whether it still exists. One sweep at a time;
   * the peers are asked in parallel, so a slow peer delays only its own checks.
   */
  async sweep(): Promise<void> {
    const deps = this.deps;
    if (!deps || this.sweeping) return;
    this.sweeping = true;
    try {
      await Promise.all([...new Set([...this.outbox.values()].map((e) => e.peer))].map((peer) => this.flush(peer)));
      this.prune(deps.now());
      await Promise.all([
        ...[...byPeer(deps.spawner.awaySlots(), (s) => s.holder)].map(([holder, slots]) => this.sweepHeld(deps, holder, slots)),
        ...[...byPeer(deps.spawner.foreignCreatures(), (f) => f.home)].map(([home, list]) => this.sweepSlots(deps, home, list)),
      ]);
      // A suspicion whose slot or creature went another way (a death, a reload) is dropped.
      const live = new Set([
        ...deps.spawner.awaySlots().map((s) => `held:${s.instanceId}`),
        ...deps.spawner.foreignCreatures().map((f) => `slot:${f.instanceId}`),
      ]);
      for (const key of [...this.suspects.keys()]) if (!live.has(key)) this.suspects.delete(key);
    } finally {
      this.sweeping = false;
    }
  }

  /** Forget what has run out: where creatures went, reservations, and cooldowns. */
  private prune(now: number): void {
    for (const [id, handed] of [...this.handedTo]) if (now - handed.at > HANDED_KEEP_MS) this.handedTo.delete(id);
    for (const [id, r] of [...this.reserved]) if (now > r.until) this.reserved.delete(id);
    for (const [id, until] of [...this.cooling]) if (now >= until) this.cooling.delete(id);
  }

  /** Home side: is each creature away at `holder` still there? */
  private async sweepHeld(deps: CreatureHandoffDeps, holder: string, slots: Array<{ instanceId: number; templateId: number }>): Promise<void> {
    for (const slot of slots) {
      const outcome = await deps.calls.call<HeldAnswer>(holder, "CREATURE_HELD", { id: slot.instanceId }, { timeoutMs: CREATURE_HANDOFF_ACK_MS });
      if (!outcome.ok) continue;
      const key = `held:${slot.instanceId}`;
      const answer = outcome.answer;
      if (answer?.state === "here") {
        this.suspects.delete(key);
      } else if (answer?.state === "moved" && typeof answer.to === "string" && answer.to && answer.to !== deps.self) {
        this.suspects.delete(key);
        deps.spawner.moveAway(slot.instanceId, answer.to);
      } else if (this.suspected(key, deps.now())) {
        log.warn(`Creature ${this.named(slot.templateId, slot.instanceId)} held by ${shown(holder)} was lost: its slot respawns`);
        deps.spawner.releaseAway(slot.instanceId, deps.now(), { respawn: true });
      }
    }
  }

  /** Holder side: does each foreign creature from `home` still have its slot there? */
  private async sweepSlots(deps: CreatureHandoffDeps, home: string, list: Array<{ instanceId: number }>): Promise<void> {
    for (const foreign of list) {
      const outcome = await deps.calls.call<{ gone: boolean }>(home, "CREATURE_SLOT", { id: foreign.instanceId }, { timeoutMs: CREATURE_HANDOFF_ACK_MS });
      if (!outcome.ok) continue;
      const key = `slot:${foreign.instanceId}`;
      if (!outcome.answer?.gone) this.suspects.delete(key);
      else if (this.suspected(key, deps.now())) {
        const c = deps.creature(foreign.instanceId);
        log.warn(`Creature ${this.named(c?.templateId ?? 0, foreign.instanceId)} has no slot at ${shown(home)} any more: removed here`);
        deps.despawnForeign(foreign.instanceId);
      }
    }
  }

  /** True when `key` was already found gone at least SWEEP_GRACE_MS ago; else it starts (or keeps) its wait. */
  private suspected(key: string, now: number): boolean {
    const since = this.suspects.get(key);
    if (since === undefined) {
      this.suspects.set(key, now);
      return false;
    }
    if (now - since < SWEEP_GRACE_MS) return false;
    this.suspects.delete(key);
    return true;
  }

  private cool(id: number): void {
    if (this.deps) this.cooling.set(id, this.deps.now() + COOLDOWN_MS);
  }

  private named(templateId: number, id: number): string {
    return `${this.deps?.templateName(templateId) ?? `template ${templateId}`} (${id})`;
  }

  /** Queue a call to `peer` and try to send it now. `what` names the creature in the log if it is dropped. */
  private send(peer: string, name: string, body: { id: number; [field: string]: unknown }, what: string): void {
    const key = `${peer}|${name}|${body.id}`;
    this.outbox.delete(key);
    while (this.outbox.size >= this.outboxLimit) {
      const [oldestKey, oldest] = this.outbox.entries().next().value as [string, OutboxEntry];
      this.outbox.delete(oldestKey);
      log.warn(`${oldest.name} for creature ${oldest.what} to ${oldest.peer} dropped: the outbox is full`);
    }
    this.outbox.set(key, { peer, name, body, what });
    void this.flush(peer);
  }

  private async flush(peer: string): Promise<void> {
    const deps = this.deps;
    if (!deps) return;
    if (this.flushing.has(peer)) {
      // Asked again while running (the link came back, or a new entry): the running loop tries once more.
      this.flushAgain.add(peer);
      return;
    }
    this.flushing.add(peer);
    // Entries the peer refused for now in this run: kept, and passed over so they do not hold up the ones behind them.
    const deferred = new Set<string>();
    try {
      // Entries queued while this runs are sent by the same loop.
      for (;;) {
        const next = [...this.outbox].find(([key, entry]) => entry.peer === peer && !deferred.has(key));
        if (!next) return;
        const [key, entry] = next;
        this.flushAgain.delete(peer);
        const outcome = await deps.calls.call(peer, entry.name, entry.body, { timeoutMs: CREATURE_HANDOFF_ACK_MS });
        if (!outcome.ok && outcome.why !== "failed" && outcome.why !== "too-big") {
          // The link is down or slow: kept for the peer's next up, or the next sweep.
          if (this.flushAgain.delete(peer)) continue;
          return;
        }
        if (outcome.ok && (outcome.answer as { ok?: unknown } | undefined)?.ok === false) {
          // The peer cannot act on it yet (the creature's slot is moving out with its block there): kept for the
          // next sweep, which sends it again.
          deferred.add(key);
          continue;
        }
        if (this.outbox.get(key) === entry) this.outbox.delete(key);
        // The peer ran it and it threw (or it has no handler), or it is too big to send: sending it again would fail
        // the same way and hold up every later entry for that peer. Its home's sweep frees the slot once the creature
        // is found gone.
        if (!outcome.ok) {
          const why = outcome.why === "too-big" ? "it is too big to send" : "the call failed there";
          log.warn(`${entry.name} for creature ${entry.what} to ${entry.peer} dropped: ${why}`);
        }
      }
    } finally {
      this.flushing.delete(peer);
    }
  }

  private onReserve(body: any, from: string): CreatureHandoffReply {
    const deps = this.deps;
    if (!deps) return { ok: false, reason: "stopped" };
    const { id, templateId, map, x, y, home } = body ?? {};
    if (!isId(id) || !isId(templateId) || typeof map !== "string" || !Number.isFinite(x) || !Number.isFinite(y) || typeof home !== "string" || !home) {
      return { ok: false, reason: "malformed" };
    }
    const now = deps.now();
    if (deps.creature(id)) return { ok: false, reason: "here" };
    const held = this.reserved.get(id);
    if (held && held.until > now && held.from !== from) return { ok: false, reason: "reserved" };
    if (deps.ownerAt(bareMapName(map), x, y) !== deps.self) return { ok: false, reason: "owner" };
    if (home === deps.self && !this.holdsAwaySlot(id, from)) return { ok: false, reason: "slot" };
    if (!deps.templateKnown(templateId)) return { ok: false, reason: "template" };
    this.reserved.set(id, { from, home, templateId, until: now + RESERVE_MS });
    return { ok: true };
  }

  /** This node (the home) has an away slot for `id`, and `from` holds it. */
  private holdsAwaySlot(id: number, from: string): boolean {
    const slot = this.deps?.spawner.awaySlots().find((s) => s.instanceId === id);
    return !!slot && slot.holder === from;
  }

  private onCommit(body: any, from: string): void {
    const deps = this.deps;
    if (!deps) return;
    const s = body?.creature;
    const id = s?.id;
    const home = body?.home;
    if (!isId(id) || typeof home !== "string" || !home) {
      log.warn(`A creature handed over by ${shown(from)} was lost: its commit is malformed (${shown(s?.id)})`);
      return;
    }
    const held = this.reserved.get(id);
    if (held && held.from === from) this.reserved.delete(id);
    const templateId = isId(s.templateId) ? s.templateId : (held?.templateId ?? 0);
    if (deps.creature(id)) {
      // A live copy is here already: the one sent is dropped, and the slot stays with the live one.
      log.warn(`Creature ${this.named(templateId, id)} handed over by ${shown(from)} was dropped: a live copy is here`);
      return;
    }
    if (!held || held.from !== from || deps.now() > held.until) {
      this.lost(id, templateId, home, from, "no reservation");
      return;
    }
    // The commit is bound to its reservation: the creature reserved is the one that arrives, for the home checked.
    if (home !== held.home || s.templateId !== held.templateId || typeof s.map !== "string" || !Number.isFinite(s.x) || !Number.isFinite(s.y)) {
      this.lost(id, held.templateId, held.home, from, "its commit does not match its reservation");
      return;
    }
    if (home === deps.self && !this.holdsAwaySlot(id, from)) {
      // Coming home, but the away slot went in the reservation window (a data reload released it, or it moved to
      // another holder). Its slot may hold a fresh copy already, so it is not made live uncounted: it is lost here.
      log.warn(`Creature ${this.named(templateId, id)} handed back by ${shown(from)} was lost: its away slot here is no longer held for it`);
      return;
    }
    let placed: boolean;
    try {
      placed = deps.arrive(s as SerializedCreature, home === deps.self ? null : home);
    } catch (error) {
      // Placed or not? A copy that became live before the throw is kept (it holds the slot); otherwise it is lost.
      placed = !!deps.creature(id);
      log.warn(`Creature ${this.named(templateId, id)} handed over by ${shown(from)} threw while being placed (${reason(error)})${placed ? ": it is live here" : ""}`);
    }
    if (!placed) {
      this.lost(id, templateId, home, from, "it could not be placed");
      return;
    }
    this.handedTo.delete(id);
  }

  /** A creature handed over here never became live: log it by name, and free its slot at its home when that is safe. */
  private lost(id: number, templateId: number, home: string, from: string, why: string): void {
    const deps = this.deps!;
    const name = this.named(templateId, id);
    const lead = `Creature ${name} handed over by ${shown(from)} was lost (${why})`;
    if (this.handedTo.has(id)) {
      // This node held the creature live and handed it on since: the commit is a stale copy of an earlier handoff
      // (the creature lives on), or a later handoff back here failed. Freeing the slot could double it, so nothing is
      // freed: the home's sweep finds out which, and frees the slot only when the creature is gone.
      log.warn(`${lead}, or is a stale copy: this node handed it on before, so its slot is left to the home's sweep`);
      return;
    }
    if (home === deps.self) {
      // Only the slot `from` holds is freed: a slot another node holds has its live creature there.
      if (this.holdsAwaySlot(id, from)) {
        log.warn(`${lead}: its slot here respawns`);
        deps.spawner.releaseAway(id, deps.now(), { respawn: true });
      } else {
        log.warn(`${lead}: its slot here is not held by ${shown(from)}, so it is left as it is`);
      }
    } else {
      log.warn(`${lead}: its home ${shown(home)} is told to respawn it`);
      this.send(home, "CREATURE_DIED", { id, respawn: true, delayMs: null }, name);
    }
  }

  private onAbort(body: any, from: string): void {
    const id = Number(body?.id);
    const held = this.reserved.get(id);
    if (held && held.from === from) this.reserved.delete(id);
  }

  private onMoved(body: any, from: string): { ok: boolean; reason?: string } {
    const deps = this.deps;
    const id = body?.id;
    const holder = body?.holder;
    // A holder the sweep could never ask (empty, or this node) would strand the slot.
    if (!deps || !isId(id) || typeof holder !== "string" || !holder || holder === deps.self) return { ok: true };
    // Only the node that holds the creature can say where it went.
    if (this.holdsAwaySlot(id, from)) {
      deps.spawner.moveAway(id, holder);
      return { ok: true };
    }
    // Its slot is moving out with its block, and the move is not decided: refused, so the sender's outbox keeps the
    // report and sends it again once the move is sent (the new home is told) or put back (the slot is away here again).
    if (this.slotMoving(id)) return { ok: false, reason: "moving" };
    // Its slot moved with its block: the new holder learns the new home, as the block's old holders did when it was
    // sent. Only the creature's home can rehome it there, so a stray CREATURE_MOVED changes nothing.
    const moved = this.movedTo(id);
    if (moved) deps.calls.cast(holder, "CREATURE_HOME", { id, home: moved });
    return { ok: true };
  }

  private onDied(body: any, from: string): { ok: boolean; reason?: string } {
    const deps = this.deps;
    const id = body?.id;
    if (!deps || !isId(id)) return { ok: true };
    const asked = body?.delayMs;
    const delayMs = typeof asked === "number" && Number.isFinite(asked) && asked >= 0 && asked <= DIED_DELAY_MAX_MS ? asked : null;
    const slot = deps.spawner.awaySlots().find((s) => s.instanceId === id);
    if (!slot) {
      // As in onMoved: kept by the sender until the move of its slot is decided.
      if (this.slotMoving(id)) return { ok: false, reason: "moving" };
      // The slot moved with its block, and the holder did not know yet: the new home frees it.
      const moved = this.movedTo(id);
      if (moved) {
        const name = this.named(deps.spawner.outgoingTemplate?.(id) ?? 0, id);
        this.send(moved, "CREATURE_DIED", { id, respawn: body?.respawn !== false, delayMs }, name);
        return { ok: true };
      }
    } else if (slot.holder !== from) {
      log.debug(`CREATURE_DIED for ${id} from ${shown(from)}, held by ${slot.holder}`);
    }
    deps.spawner.releaseAway(id, deps.now(), { respawn: body?.respawn !== false, delayMs });
    return { ok: true };
  }

  private onHeld(body: any): HeldAnswer {
    const deps = this.deps;
    const id = body?.id;
    if (!deps || !isId(id)) return { state: "gone" };
    if (deps.creature(id)) return { state: "here" };
    const handed = this.handedTo.get(id);
    return handed ? { state: "moved", to: handed.to } : { state: "gone" };
  }

  private onSlot(body: any): { gone: boolean } {
    const deps = this.deps;
    const id = body?.id;
    if (!deps || !isId(id)) return { gone: false };
    // A slot that just moved with its block is not gone: the holder learns its new home from CREATURE_HOME. Nor is one
    // still moving out: a move put back keeps it here.
    return { gone: !deps.spawner.awaySlots().some((s) => s.instanceId === id) && this.movedTo(id) === null && !this.slotMoving(id) };
  }

  private onHome(body: any, from: string): void {
    const deps = this.deps;
    const id = body?.id;
    const home = body?.home;
    if (!deps || !isId(id) || typeof home !== "string" || !home) return;
    // Only the creature's home can hand its slot on.
    if (deps.spawner.foreignHome(id) !== from) return;
    if (!deps.spawner.rehome?.(id, home === deps.self ? null : home)) {
      log.warn(`Creature ${this.named(deps.creature(id)?.templateId ?? 0, id)}: its home ${shown(from)} moved its slot to ${shown(home)}, which this node could not take; its sweep asks ${shown(from)} again`);
    }
  }
}

/** This node's creature handoff: started by a link hook in cluster mode (Task 16), never otherwise. */
export const creatureHandoff = new CreatureHandoff();
