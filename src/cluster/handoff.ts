import log from "../modules/logger";
import type { NodeTicket } from "../socket/ticket";
import type { Ghosts } from "./ghosts";
import type { LinkCalls } from "./linkcalls";
import { PlayerLockBusy, type PlayerLocks } from "./playerlock";

// Moving a player to the node that owns the block they walked into (spec §5).
// The old node (A) asks the new node (B) to take the player (HANDOFF) while
// the player keeps walking. B parks the snapshot as an arrival under the
// ticket token. On a yes, A drains the player (their moves are dropped from
// there, the mover is unregistered, packets in flight finish), takes the
// player's cluster lock (after the drain: a batch of the player's own that was
// running takes the same lock and must not wait on the handoff's) and gives the player up in one synchronous step (snapshot taken, mirrors
// handed over, player released, a mirror kept, forwarding started, commit
// cast), saves, and sends the client a SWITCH with the ticket. A handoff that
// is refused before the drain never stopped the player. The client reconnects
// to B, which gives it the same id and logs it in from the arrival without a
// map load. A step that has started always finishes, so a player is live on
// one node or, after a lost link, on none: never on two.

export const HANDOFF_ACK_MS = 2_000;
export const DRAIN_MS = 2_000;
/** How soon a handoff is tried again after a refusal that will not change on its own (no ticket, a full node, a lost answer). */
export const RETRY_AFTER_MS = 5_000;
/** How soon it is tried again after a refusal that clears in a moment (the lock is busy, the target still holds an earlier try, packets are in flight). */
export const TRANSIENT_RETRY_MS = 300;
/** After a handoff, the player is not handed back to the node they came from for this long, unless they stand well inside it (handoffwatch.ts). */
export const HANDOFF_DWELL_MS = 3_000;
/** A refusal is said once per player and reason in this time. */
const REFUSAL_LOG_MS = 10_000;
/** How long a pre-opened session of the client is held (the client closes it after this long); a prepare is not repeated inside it. */
export const PREPARE_MS = 10_000;
export const ARRIVAL_TTL_MS = 30_000;
export const RECENT_MS = 30_000;

// What a peer's HANDOFF may carry. The peer is a cluster node (the links are
// authenticated), so these only keep a broken node from filling this one.
/** The most arrivals parked at once. */
export const MAX_ARRIVALS = 1_000;
/** The longest username, map name or direction in a snapshot. */
export const MAX_TEXT = 128;
export const MAX_TOKEN = 256;
/** The most creature or player ids a snapshot lists as shown. */
export const MAX_SHOWN_IDS = 10_000;
/** The largest snapshot state, as JSON. */
export const MAX_STATE_BYTES = 64 * 1024;
/** How often the cooldown and "recently" tables are swept. */
const SWEEP_MS = 5_000;

/**
 * An expected give-up before the release (for example, the player's packets did not drain in time): the handoff is
 * refused and tried again soon, said at info and not as an error.
 */
export class HandoffGiveUp extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandoffGiveUp";
  }
}

export interface PlayerSnapshot {
  id: string;
  username: string;
  /** Bare, no ".json". */
  map: string;
  x: number;
  y: number;
  direction: string;
  /** What the client shows now: the new node sends only what differs. */
  creatureIds: number[];
  playerIds: string[];
  /** Effects, cooldowns (remaining ms), sickness: built by deps.snapshot (Task 13), seeded on arrival (Task 14). */
  state: Record<string, unknown>;
}
/** The ticket the client brings to the new node: a node ticket signed for it (socket/ticket.ts). */
export type SwitchTicket = NodeTicket;
export interface NodeAddress { nodeId: string; publicHost: string; port: number; wtPort: number; useSSL: boolean }
export type HandoffReply = { ok: boolean; reason?: string };
export type HandoffResult = "switched" | "refused" | "gone" | "busy";

/**
 * Takes the player's cluster lock (playerlock.ts) for a handoff: answers its release, or null when another writer
 * holds it or the store failed. Never rejects.
 */
export type HandoffLock = (username: string) => Promise<(() => Promise<void>) | null>;

/**
 * The HandoffLock over a PlayerLocks: withLocks with waitMs 0, held open until the release is called. A busy lock is
 * the normal answer while a trade or a mail on another node writes the player; any other failure is logged.
 */
export function holdPlayerLock(locks: Pick<PlayerLocks, "withLocks">, username: string): Promise<(() => Promise<void>) | null> {
  return new Promise((answer) => {
    let letGo!: () => void;
    const released = new Promise<void>((resolve) => { letGo = resolve; });
    const held: Promise<void> = locks.withLocks([username], async () => {
      answer(async () => {
        letGo();
        await held.catch(() => undefined);
      });
      await released;
    }, { waitMs: 0 });
    held.catch((error) => {
      if (!(error instanceof PlayerLockBusy)) log.error(`The player lock of ${username} could not be taken for a handoff, so it waits: ${error}`);
      answer(null);
    });
  });
}

export interface HandoffDeps {
  calls: Pick<LinkCalls, "call" | "cast" | "handle" | "onCast">;
  ghosts: Pick<Ghosts, "handOver" | "adoptMirror">;
  self: string;
  ownerAt(map: string, x: number, y: number): string | null;
  now(): number;
  /** The local player with this id, or null. */
  player(id: string): any | null;
  playerByUsername(username: string): any | null;
  /**
   * Stop the player's movement and wait (at most `ms`) until the packets it sent before are handled. Throw HandoffGiveUp
   * to give up quietly. Called after the target said yes (the player walks until then), except for a warp, which
   * drains first.
   */
  drain(player: any, ms: number): Promise<void>;
  /**
   * Whether the player may still go, asked once they are drained: the reason they may not (they started a trade or a
   * cast while the answer was awaited), or null. The refusal is tried again soon.
   */
  recheck?(player: any, target: string): string | null;
  /**
   * A drained player stays here (the handoff was refused or failed before the release): undo what the drain did to
   * their movement, so the client is not left walking a player the server no longer moves.
   */
  undrain?(player: any): void | Promise<void>;
  /**
   * The player is stopped for a handoff that keeps their walk (not a warp): called right before the drain. From here
   * this node sends them no more steps, so their client walks them on by itself (HANDOFF_BEGIN) until the new node has
   * them; told at the SWITCH, it drew the player standing through the drain and the save first.
   */
  begin?(player: any): void;
  /** A begun player stays here (the handoff was given up after begin): their client stops walking them on. Called before undrain. */
  stay?(player: any): void;
  snapshot(player: any): PlayerSnapshot;
  /** The record a mirror of the player is built from (the player ghost kind's record). */
  ghostRecord(player: any): any;
  /** A node ticket for `target`, or null (no secret). */
  ticket(player: any, target: string): SwitchTicket | null;
  node(target: string): NodeAddress | null;
  /** Remove the player from this node with none of a disconnect's effects (Task 13). Synchronous. */
  release(player: any): void;
  /** Save stats and location as a disconnect does, without clearing the session. */
  save(player: any): Promise<void>;
  /** Send the SWITCH and close the connection once it is sent. */
  sendSwitch(player: any, node: NodeAddress, ticket: SwitchTicket, resume: boolean): Promise<void>;
  /** Pass calls and deliveries for the player on to `to` for a while (Task 8). */
  forward(playerId: string, username: string, to: string): void;
  /**
   * Tells the player's client which node it will be sent to, so it can open a session there before the SWITCH (null: drop
   * the one it opened). Carries the node's address only: no ticket, nothing of the player.
   */
  prepare?(player: any, node: NodeAddress | null): void;
  /**
   * The old node's save of the player arriving with this ticket has landed (HANDOFF_SAVED): their rows may be read
   * for the login now, before the client gets here (socket/loginprefetch.ts).
   */
  saved?(token: string, username: string): void;
  /** How long A waits for the HANDOFF answer: HANDOFF_ACK_MS unless a test sets it. */
  ackMs?: number;
}

/** The marks of one handoff, in the order they were reached: a name and the time in ms. Kept on the handoff, one array per handoff. */
type Marks = Array<[string, number]>;

/** The steps the new node marks on an arrival, in the order they happen (see landed). */
export type LandingStep = "open" | "auth_rx" | "worker_done" | "rows_done" | "cached" | "done_sent" | "first_move";

interface Arrival {
  snapshot: PlayerSnapshot;
  from: string;
  fullLoad: boolean;
  expiresAt: number;
  committed: boolean;
  /** When the commit came (deps.now()): the resumed walk makes up the time from there (socket/arrival.ts). */
  committedAt: number;
  idClaimed: boolean;
  /** When the new node reached each step of taking this player in. */
  marks: Marks;
  /** When the login took the arrival: the marks of one not finished are said after RECENT_MS. */
  takenAt: number;
}

/** One line for a finished handoff: total, then the time each mark came after the one before it. */
function summary(username: string, from: string, to: string, marks: Marks): string {
  const first = marks[0]?.[1] ?? 0;
  const last = marks[marks.length - 1]?.[1] ?? first;
  let line = `[handoff] ${username} ${from}->${to} total=${last - first}`;
  for (let i = 1; i < marks.length; i++) line += ` ${marks[i][0]}=+${marks[i][1] - marks[i - 1][1]}`;
  return line;
}

/** A crossing slower than this (total, in ms) is said at info so slow handoffs stay visible; a faster one is said at debug. */
export const SLOW_CROSSING_MS = 100;

/** The level a finished handoff's summary line is logged at: info only when it took longer than SLOW_CROSSING_MS. */
export function crossingLogLevel(totalMs: number): "info" | "debug" {
  return totalMs > SLOW_CROSSING_MS ? "info" : "debug";
}

/** Says the summary of a finished handoff (see crossingLogLevel for the level). */
function sayCrossing(username: string, from: string, to: string, marks: Marks): void {
  const first = marks[0]?.[1] ?? 0;
  const last = marks[marks.length - 1]?.[1] ?? first;
  log[crossingLogLevel(last - first)](summary(username, from, to, marks));
}

/** The tables one start() to stop() owns: a handoff still running after a stop writes to its own, not the next. */
interface Session {
  /** Players being handed off from here, by username. */
  leaving: Set<string>;
  retryAt: Map<string, number>;
  /** Players whose handoff was refused as too big, said out loud once: by username, until a handoff of theirs is done. */
  tooBig: Set<string>;
  /** When each refusal was last said, by username and reason: one line per player and reason in REFUSAL_LOG_MS. */
  said: Map<string, number>;
}

const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

/** Runtime player ids are decimal integers (cluster ids): the ghosts take Number(id) as the mirror number. */
const isPlayerId = (value: unknown): value is string => typeof value === "string" && /^\d{1,16}$/.test(value) && Number.isSafeInteger(Number(value));

function jsonSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Infinity;
  }
}

function validSnapshot(raw: any): PlayerSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  if (!isPlayerId(raw.id) || !isText(raw.username, MAX_TEXT)) return null;
  if (!isText(raw.map, MAX_TEXT) || !Number.isFinite(raw.x) || !Number.isFinite(raw.y)) return null;
  if (raw.direction !== undefined && !isText(raw.direction, MAX_TEXT)) return null;
  for (const list of [raw.creatureIds, raw.playerIds]) {
    if (list !== undefined && (!Array.isArray(list) || list.length > MAX_SHOWN_IDS)) return null;
  }
  if (raw.state !== undefined && (!raw.state || typeof raw.state !== "object" || Array.isArray(raw.state))) return null;
  if (raw.state !== undefined && jsonSize(raw.state) > MAX_STATE_BYTES) return null;
  return {
    id: raw.id,
    username: raw.username,
    map: raw.map,
    x: raw.x,
    y: raw.y,
    direction: raw.direction ?? "down",
    creatureIds: (raw.creatureIds ?? []).filter((n: unknown) => typeof n === "number" && Number.isSafeInteger(n)),
    playerIds: (raw.playerIds ?? []).filter((n: unknown) => isText(n, MAX_TEXT) || (typeof n === "number" && Number.isSafeInteger(n))).map(String),
    state: raw.state ?? {},
  };
}

export class PlayerHandoff {
  private deps: HandoffDeps | null = null;
  private undo: Array<() => void> = [];
  private session: Session = { leaving: new Set(), retryAt: new Map(), tooBig: new Set(), said: new Map() };
  /** Handoffs still running, across stops: shutdown waits for them (idle). */
  private running = new Set<Promise<HandoffResult>>();
  /** Players handed to this node, by ticket token. */
  private arrivals = new Map<string, Arrival>();
  private arrivedAt = new Map<string, number>();
  /** The node each recent arrival came from, by username: the dwell keeps them from being sent straight back. */
  private arrivedFrom = new Map<string, string>();
  /** Arrivals taken by a login and not yet seen to move, by ticket token: the new node's marks are said when they do. */
  private landing = new Map<string, Arrival>();
  private departedAt = new Map<string, number>();
  /** The node each player's client was told to pre-open a session to, and when, by username. */
  private prepared = new Map<string, { target: string; at: number }>();
  private lastSweep = -Infinity;
  /** The player's cluster lock, set by startCluster (Task 21). Null: handoffs take no lock, as in phase 6. */
  private lock: HandoffLock | null = null;

  /** Answers the lock set before. Kept across start and stop: startCluster sets it, stopCluster sets it back. */
  setLock(lock: HandoffLock | null): HandoffLock | null {
    const previous = this.lock;
    this.lock = lock;
    return previous;
  }

  start(deps: HandoffDeps): void {
    this.stop();
    this.deps = deps;
    this.undo.push(deps.calls.handle("HANDOFF", (body, from) => this.onHandoff(body, from)));
    this.undo.push(deps.calls.onCast("HANDOFF_ABORT", (body, from) => this.onAbort(body, from)));
    this.undo.push(deps.calls.onCast("HANDOFF_COMMIT", (body, from) => this.onCommit(body, from)));
    this.undo.push(deps.calls.onCast("HANDOFF_SAVED", (body, from) => this.onSaved(body, from)));
  }

  /**
   * Stop answering. A handoff already running finishes with the deps it started with (a step that has started
   * always finishes); `idle()` waits for it, so a shutdown does not exit between a release and its save.
   */
  stop(): void {
    for (const undo of this.undo.splice(0)) undo();
    this.deps = null;
    this.session = { leaving: new Set(), retryAt: new Map(), tooBig: new Set(), said: new Map() };
    this.arrivals.clear();
    this.arrivedAt.clear();
    this.arrivedFrom.clear();
    this.landing.clear();
    this.departedAt.clear();
    this.prepared.clear();
    this.lastSweep = -Infinity;
  }

  /** Resolves once every handoff running now has ended. */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.running]);
  }

  /** A handoff of this player is running. */
  pending(username: string): boolean {
    return this.session.leaving.has(username);
  }

  /** A handoff of this player failed a moment ago: none is tried again yet. */
  coolingDown(username: string): boolean {
    const at = this.session.retryAt.get(username);
    return at !== undefined && !!this.deps && this.deps.now() < at;
  }

  /**
   * The player walks toward a border to `target`: their client is told the node's address, once per PREPARE_MS and
   * target, and opens a session there ahead of the SWITCH. Nothing about the player leaves this node. Answers whether
   * a prepare was sent.
   */
  prepare(player: any, target: string): boolean {
    const deps = this.deps;
    const username = String(player?.username ?? "");
    if (!deps?.prepare || !username || target === deps.self) return false;
    // A handoff of this player is running: the SWITCH follows by itself.
    if (this.session.leaving.has(username)) return false;
    const now = deps.now();
    const held = this.prepared.get(username);
    if (held && held.target === target && now - held.at < PREPARE_MS) return false;
    const address = deps.node(target);
    if (!address) return false;
    try {
      deps.prepare(player, address);
    } catch (error) {
      log.warn(`Prepare of ${username} for ${target} not sent: ${error}`);
      return false;
    }
    this.prepared.set(username, { target, at: now });
    return true;
  }

  /** The player no longer walks toward the border they were prepared for: their client drops the session it opened. */
  unprepare(player: any): void {
    const deps = this.deps;
    const username = String(player?.username ?? "");
    if (!deps || !this.prepared.delete(username)) return;
    try {
      deps.prepare?.(player, null);
    } catch (error) {
      log.warn(`Prepare of ${username} not withdrawn: ${error}`);
    }
  }

  handOff(player: any, target: string, opts: { fullLoad?: boolean } = {}): Promise<HandoffResult> {
    const run = this.run(player, target, opts);
    this.running.add(run);
    run.then(() => this.running.delete(run), () => this.running.delete(run));
    return run;
  }

  private async run(player: any, target: string, opts: { fullLoad?: boolean }): Promise<HandoffResult> {
    const deps = this.deps;
    const session = this.session;
    const lock = this.lock;
    const username = String(player?.username ?? "");
    const id = String(player?.id ?? "");
    if (!deps || !username || !id || target === deps.self) return "refused";
    if (session.leaving.has(username)) return "busy";
    this.sweep(deps);
    // The pending flag: the watch starts no second handoff of this player. The player is not frozen by it.
    session.leaving.add(username);
    const marks: Marks = [["t0", deps.now()]];
    const mark = (step: string) => { marks.push([step, deps.now()]); };
    const t0 = marks[0][1];
    // Set once the player's moves are dropped and their mover is gone: only then is there anything to undo.
    let drained = false;
    // Set once the client was told it walks the player on (begin): a handoff given up then tells it to stay.
    let begun = false;
    let switched = false;
    let token = "";
    // The player's cluster lock, while held: let go right after the save, or in finally on any other way out.
    let unlock: (() => Promise<void>) | null = null;
    const letGo = async () => {
      const release = unlock;
      unlock = null;
      if (!release) return;
      try {
        await release();
      } catch (error) {
        log.error(`Handoff of ${username} to ${target}: the player lock was not let go (it runs out on its own): ${error}`);
      }
    };
    // From here the client's moves are dropped (socket/receiver.ts) and the player stands still.
    const drain = async () => {
      drained = true;
      player.handoff = true;
      // A walk that goes on (not a warp): the client walks the player on from their last step, as the new node does.
      if (!opts.fullLoad && deps.begin) {
        begun = true;
        try {
          deps.begin(player);
        } catch (error) {
          log.warn(`Handoff of ${username} to ${target}: the client was not told the walk is handed on: ${error}`);
        }
      }
      await deps.drain(player, DRAIN_MS);
      mark("drained");
    };
    // A trade, mail or purchase on another node may be writing this player's rows: the handoff waits for its turn
    // (tried again soon) instead of saving here while it lands. Answers how the handoff ends, or null to go on.
    const takeLock = async (): Promise<HandoffResult | null> => {
      if (lock) {
        unlock = await lock(username);
        if (!unlock) return this.refused(deps, session, username, target, token, "locked", t0, true);
        if (deps.player(id) !== player) {
          if (token) deps.calls.cast(target, "HANDOFF_ABORT", { username, token });
          return "gone";
        }
      }
      mark("locked");
      return null;
    };
    // Before the player is stopped: a busy lock (a write for this player on another node) refuses now, while they walk.
    // The lock is taken and let go at once; the real one is taken after the drain.
    const peekLock = async (): Promise<HandoffResult | null> => {
      if (!lock) return null;
      const free = await lock(username);
      if (!free) return this.refused(deps, session, username, target, token, "locked", t0, true);
      try {
        await free();
      } catch (error) {
        log.error(`Handoff of ${username} to ${target}: the player lock was not let go after a look (it runs out on its own): ${error}`);
      }
      return null;
    };
    try {
      let ticket: SwitchTicket;
      let node: NodeAddress;
      const fullLoad = !!opts.fullLoad;
      // Until the answer the player is only here: any failure keeps them, and they are tried again soon or in a while.
      try {
        // A warp drains first: the player is placed at the destination and has no walk to keep.
        if (fullLoad) await drain();
        if (deps.player(id) !== player) return "gone";
        if (fullLoad) {
          const stopped = await takeLock();
          if (stopped) return stopped;
        }
        const madeTicket = deps.ticket(player, target);
        if (!madeTicket) return this.refused(deps, session, username, target, "", "no ticket", t0, false);
        const address = deps.node(target);
        // A node not known yet is read again by the node (server.ts): the next try finds it.
        if (!address) return this.refused(deps, session, username, target, "", "no node address", t0, true);
        ticket = madeTicket;
        node = address;
        token = ticket.token;
        const outcome = await deps.calls.call<HandoffReply>(target, "HANDOFF", { snapshot: deps.snapshot(player), token, fullLoad }, { timeoutMs: deps.ackMs ?? HANDOFF_ACK_MS });
        mark("acked");
        if (!outcome.ok || !outcome.answer?.ok) {
          // A timed-out call may still have parked the arrival on the target: the abort removes it.
          const why = outcome.ok ? String(outcome.answer?.reason ?? "refused") : outcome.why;
          return this.refused(deps, session, username, target, token, why, t0, why === "arriving" || why === "busy");
        }
        // The target said yes. The player has walked on while it was asked: they are stopped now, as late as possible.
        if (!fullLoad) {
          if (deps.player(id) !== player) {
            deps.calls.cast(target, "HANDOFF_ABORT", { username, token });
            return "gone";
          }
          const busy = await peekLock();
          if (busy) return busy;
          if (deps.player(id) !== player) {
            deps.calls.cast(target, "HANDOFF_ABORT", { username, token });
            return "gone";
          }
          await drain();
          // The lock is taken after the drain: a batch of the player's own that was running takes the same lock and
          // must finish first (the drain waits for it), so the handoff cannot hold the lock while it waits.
          const stopped = await takeLock();
          if (stopped) return stopped;
        }
        if (deps.player(id) === player) {
          const blocked = deps.recheck?.(player, target) ?? null;
          if (blocked) return this.refused(deps, session, username, target, token, `blocked: ${blocked}`, t0, true);
        }
      } catch (error) {
        // A drain that gave up is the one refusal that already froze the player: it waits the long time.
        if (error instanceof HandoffGiveUp) return this.refused(deps, session, username, target, token, error.message, t0, false);
        log.error(`Handoff of ${username} to ${target} failed before the answer, so the player stays here: ${error}`);
        return this.refused(deps, session, username, target, token, `failed before the answer: ${error}`, t0, false);
      }
      // The player may have disconnected during the call: the disconnect already saved and released them.
      if (deps.player(id) !== player) {
        deps.calls.cast(target, "HANDOFF_ABORT", { username, token });
        return "gone";
      }
      // From here to the commit nothing awaits: no scan, packet or tick sees the player half moved. The last move is
      // applied (the player is drained), so the snapshot is where they stand. Until the release the player is still
      // only here, so a failure gives up the handoff and keeps them.
      let snapshot: PlayerSnapshot;
      try {
        snapshot = deps.snapshot(player);
        // They may have walked back out of the target's block while the answer was awaited.
        if (deps.ownerAt(snapshot.map, snapshot.x, snapshot.y) !== target) {
          return this.refused(deps, session, username, target, token, "moved out of the target's block", t0, true);
        }
        const record = deps.ghostRecord(player);
        deps.ghosts.handOver("player", id, target);
        try {
          deps.release(player);
        } catch (error) {
          // Whether the player is still here decides the outcome: here, they stay; not here, the handoff goes on.
          if (deps.player(id) === player) throw error;
          log.error(`Handoff of ${username} to ${target}: the release failed after removing the player: ${error}`);
        }
        // The player is released: what follows only helps, and none of it may stop the commit.
        try {
          deps.ghosts.adoptMirror("player", record, target);
        } catch (error) {
          log.error(`Handoff of ${username} to ${target}: no mirror kept: ${error}`);
        }
        try {
          deps.forward(id, username, target);
        } catch (error) {
          log.error(`Handoff of ${username} to ${target}: forwarding not started: ${error}`);
        }
      } catch (error) {
        // If the mirrors were handed over already, the peers file theirs under the target until they expire, and
        // this node tracks the player again at its next scan.
        log.warn(`Handoff of ${username} to ${target} given up before the release, so the player stays here: ${error}`);
        return this.refused(deps, session, username, target, token, `failed before the release: ${error}`, t0, false);
      }
      mark("released");
      // The player is gone from here: whatever happens next, the client is sent on with the ticket.
      switched = true;
      let committed = false;
      try {
        committed = deps.calls.cast(target, "HANDOFF_COMMIT", { username, token, snapshot });
      } catch (error) {
        log.error(`Handoff of ${username} to ${target}: commit not sent: ${error}`);
      }
      // Without the commit the target logs the player in from the database: the client must load the map.
      if (!committed) log.warn(`Handoff of ${username} to ${target}: commit not sent, so the login there loads from the database`);
      this.departedAt.set(username, deps.now());
      session.tooBig.delete(username);
      let saved = false;
      try {
        await deps.save(player);
        saved = true;
      } catch (error) {
        log.error(`Handoff of ${username} to ${target}: save failed, so ${target} may load older stats: ${error}`);
      }
      mark("saved");
      // The target may read the player's rows for the login now, while the SWITCH is on its way to the client.
      if (saved) {
        try {
          deps.calls.cast(target, "HANDOFF_SAVED", { username, token });
        } catch (error) {
          log.debug(`Handoff of ${username} to ${target}: HANDOFF_SAVED not sent, so the login there reads the rows itself: ${error}`);
        }
      }
      // The save has landed: another writer may go on, and the new node reads the rows after it.
      await letGo();
      mark("unlocked");
      try {
        // The call queues and flushes the frame itself; the wait after it is for the client's close.
        const sent = deps.sendSwitch(player, node, ticket, !fullLoad && committed);
        mark("switch_sent");
        sayCrossing(username, deps.self, target, marks);
        await sent;
      } catch (error) {
        log.error(`Handoff of ${username} to ${target}: SWITCH not sent: ${error}`);
      }
      return "switched";
    } finally {
      await letGo();
      session.leaving.delete(username);
      if (switched) this.prepared.delete(username);
      if (!switched && drained) player.handoff = false;
      // Kept here after the drain: their movement is put right. A player who left ("gone") is not touched, and
      // neither is one who was never drained (the handoff was refused first and they never stopped).
      if (!switched && begun && deps.stay && deps.player(id) === player) {
        try {
          deps.stay(player);
        } catch (error) {
          log.warn(`Handoff of ${username} to ${target}: the client was not told to stay: ${error}`);
        }
      }
      if (!switched && drained && deps.undrain && deps.player(id) === player) {
        try {
          await deps.undrain(player);
        } catch (error) {
          log.warn(`Handoff of ${username} to ${target}: movement not restored after the refusal: ${error}`);
        }
      }
    }
  }

  /** The arrival a connection with this ticket brings, once. resume: the client keeps its world. */
  takeArrival(token: string, username: string, id: string): { snapshot: PlayerSnapshot; resume: boolean; committedAt: number } | null {
    const arrival = this.liveArrival(token);
    if (!arrival || !arrival.committed || arrival.snapshot.username !== username) return null;
    this.arrivals.delete(token);
    const now = this.deps!.now();
    this.arrivedAt.set(username, now);
    this.arrivedFrom.set(username, arrival.from);
    // A node that only receives arrivals sweeps here, and holds no more than MAX_ARRIVALS unseen ones.
    this.sweep(this.deps!);
    while (this.landing.size >= MAX_ARRIVALS) this.landing.delete(this.landing.keys().next().value as string);
    // Kept until the player first moves: that is the last mark of the new node's line.
    arrival.takenAt = now;
    // The caller reads the whole snapshot; what is kept until the first move is the identity and the marks only.
    const snapshot = arrival.snapshot;
    arrival.snapshot = { id: snapshot.id, username: snapshot.username, map: snapshot.map, x: snapshot.x, y: snapshot.y, direction: snapshot.direction, creatureIds: [], playerIds: [], state: {} };
    this.landing.set(token, arrival);
    return { snapshot, resume: arrival.snapshot.id === id && !arrival.fullLoad, committedAt: arrival.committedAt };
  }

  /**
   * The new node reached `step` for the player who came with this ticket (marks are kept per handoff, so this costs
   * one push). A ticket that is not a handoff's, or a step already marked, is ignored.
   */
  landed(token: string, step: LandingStep): void {
    const deps = this.deps;
    if (!deps || !token) return;
    const arrival = this.arrivals.get(token) ?? this.landing.get(token);
    if (!arrival) return;
    for (const [name] of arrival.marks) if (name === step) return;
    const now = deps.now();
    // The line counts from the open; a connection that did not claim the id (a new id was given) counts from its first mark.
    if (arrival.marks.length === 0 && step !== "open") arrival.marks.push(["open", now]);
    arrival.marks.push([step, now]);
  }

  /** The player first moved on the new node: the line with the times of taking them in is said, once. */
  firstMove(token: string): void {
    const arrival = this.landing.get(token);
    if (!arrival || !this.deps) return;
    this.landing.delete(token);
    arrival.marks.push(["first_move", this.deps.now()]);
    this.sayLanding(arrival);
  }

  private sayLanding(arrival: Arrival): void {
    sayCrossing(arrival.snapshot.username, arrival.from, this.deps!.self, arrival.marks);
  }

  /**
   * The player came from `from` less than HANDOFF_DWELL_MS ago: the watch does not hand them back unless they stand
   * well inside the block they were handed from (handoffwatch.ts).
   */
  dwellingFrom(username: string, from: string): boolean {
    const at = this.arrivedAt.get(username);
    if (at === undefined || !this.deps || this.arrivedFrom.get(username) !== from) return false;
    return this.deps.now() - at < HANDOFF_DWELL_MS;
  }

  /** The id an arriving connection keeps, given once per arrival. */
  claimArrivalId(token: string): string | null {
    const arrival = this.liveArrival(token);
    if (!arrival || !arrival.committed || arrival.idClaimed) return null;
    if (this.deps!.player(arrival.snapshot.id)) return null;
    arrival.idClaimed = true;
    this.landed(token, "open");
    return arrival.snapshot.id;
  }

  arrivedRecently(username: string): boolean {
    return this.recent(this.arrivedAt, username);
  }

  departedRecently(username: string): boolean {
    return this.recent(this.departedAt, username);
  }

  private recent(map: Map<string, number>, username: string): boolean {
    const at = map.get(username);
    if (at === undefined || !this.deps) return false;
    if (this.deps.now() - at <= RECENT_MS) return true;
    map.delete(username);
    return false;
  }

  /** Drops spent cooldowns and old "recently" entries, at most once per SWEEP_MS. */
  private sweep(deps: HandoffDeps): void {
    const now = deps.now();
    if (now - this.lastSweep < SWEEP_MS) return;
    this.lastSweep = now;
    for (const [username, at] of this.session.retryAt) if (now >= at) this.session.retryAt.delete(username);
    for (const [key, at] of this.session.said) if (now - at >= REFUSAL_LOG_MS) this.session.said.delete(key);
    for (const map of [this.arrivedAt, this.departedAt]) {
      for (const [username, at] of map) if (now - at > RECENT_MS) map.delete(username);
    }
    for (const [username, held] of this.prepared) if (now - held.at >= PREPARE_MS) this.prepared.delete(username);
    for (const username of this.arrivedFrom.keys()) if (!this.arrivedAt.has(username)) this.arrivedFrom.delete(username);
    // A player who never moved after arriving: the line is said without the last mark.
    for (const [token, arrival] of this.landing) {
      if (now - arrival.takenAt <= RECENT_MS) continue;
      this.landing.delete(token);
      this.sayLanding(arrival);
    }
  }

  /**
   * Gives up the handoff: the arrival parked on the target is aborted, and the next try is set (TRANSIENT_RETRY_MS for a
   * reason that clears in a moment, RETRY_AFTER_MS for the rest). Every refusal is said at info with the player, the
   * target, the reason and the time since the handoff started, once per player and reason in REFUSAL_LOG_MS.
   */
  private refused(deps: HandoffDeps, session: Session, username: string, target: string, token: string, why: string, t0: number, transient: boolean): HandoffResult {
    if (token) {
      try {
        deps.calls.cast(target, "HANDOFF_ABORT", { username, token });
      } catch (error) {
        log.error(`Handoff of ${username} to ${target}: abort not sent, so the arrival there expires: ${error}`);
      }
    }
    const retryMs = transient ? TRANSIENT_RETRY_MS : RETRY_AFTER_MS;
    const now = deps.now();
    // A refusal that will not clear soon: the client drops the session it opened for this handoff (the entry stays, so
    // it is not prepared again before PREPARE_MS). One that clears in a moment keeps it for the next try.
    if (!transient && this.prepared.has(username)) {
      const walker = deps.playerByUsername(username);
      if (walker) {
        try {
          deps.prepare?.(walker, null);
        } catch (error) {
          log.warn(`Prepare of ${username} not withdrawn: ${error}`);
        }
      }
    }
    session.retryAt.set(username, now + retryMs);
    // A snapshot the target finds malformed, or a target that is full, will not change on its own: say so out loud. A
    // snapshot too big for the link will not either, and is tried again every RETRY_AFTER_MS: said out loud once per
    // player, until a handoff of theirs is done.
    let loud = why === "malformed" || why === "full";
    if (why === "too-big") {
      loud = !session.tooBig.has(username);
      session.tooBig.add(username);
    }
    const key = `${username}|${why.split(":")[0].slice(0, 48)}`;
    const last = session.said.get(key);
    if (last !== undefined && now - last < REFUSAL_LOG_MS) return "refused";
    session.said.set(key, now);
    (loud ? log.warn : log.info)(`[handoff] ${username} ${deps.self}->${target} not done (${why}) after ${now - t0} ms: tried again in ${retryMs} ms at the earliest`);
    return "refused";
  }

  private liveArrival(token: string): Arrival | null {
    const deps = this.deps;
    if (!deps || !token) return null;
    const arrival = this.arrivals.get(token);
    if (!arrival) return null;
    if (deps.now() > arrival.expiresAt) {
      this.arrivals.delete(token);
      return null;
    }
    return arrival;
  }

  private onHandoff(body: any, from: string): HandoffReply {
    const deps = this.deps;
    if (!deps) return { ok: false, reason: "stopped" };
    const snapshot = validSnapshot(body?.snapshot);
    const token = isText(body?.token, MAX_TOKEN) ? body.token : "";
    if (!snapshot || !token) {
      log.warn(`Handoff from ${from} refused: ${snapshot ? "no token" : "malformed snapshot"}`);
      return { ok: false, reason: "malformed" };
    }
    this.sweep(deps);
    for (const [key, arrival] of [...this.arrivals]) {
      if (deps.now() > arrival.expiresAt) this.arrivals.delete(key);
    }
    // A second copy of the same call (the link resent it) is a yes again; the token from anyone else is not.
    const same = this.arrivals.get(token);
    if (same) return same.from === from && same.snapshot.username === snapshot.username ? { ok: true } : { ok: false, reason: "token" };
    if (deps.player(snapshot.id) || deps.playerByUsername(snapshot.username)) return { ok: false, reason: "here" };
    for (const arrival of this.arrivals.values()) {
      if (arrival.snapshot.username === snapshot.username || arrival.snapshot.id === snapshot.id) return { ok: false, reason: "arriving" };
    }
    if (deps.ownerAt(snapshot.map, snapshot.x, snapshot.y) !== deps.self) return { ok: false, reason: "owner" };
    if (this.arrivals.size >= MAX_ARRIVALS) {
      log.warn(`Handoff of ${snapshot.username} from ${from} refused: ${MAX_ARRIVALS} arrivals already parked`);
      return { ok: false, reason: "full" };
    }
    this.arrivals.set(token, {
      snapshot, from, fullLoad: !!body?.fullLoad, expiresAt: deps.now() + ARRIVAL_TTL_MS, committed: false, committedAt: 0, idClaimed: false, marks: [], takenAt: 0,
    });
    return { ok: true };
  }

  private onAbort(body: any, from: string): void {
    const token = typeof body?.token === "string" ? body.token : "";
    const arrival = this.arrivals.get(token);
    if (arrival && arrival.from === from && !arrival.committed) this.arrivals.delete(token);
  }

  private onSaved(body: any, from: string): void {
    const deps = this.deps;
    const token = typeof body?.token === "string" ? body.token : "";
    const arrival = this.arrivals.get(token);
    if (!deps?.saved || !arrival || arrival.from !== from) return;
    try {
      deps.saved(token, arrival.snapshot.username);
    } catch (error) {
      log.warn(`Handoff of ${arrival.snapshot.username} from ${from}: the rows were not read ahead of the login: ${error}`);
    }
  }

  private onCommit(body: any, from: string): void {
    const deps = this.deps;
    const token = typeof body?.token === "string" ? body.token : "";
    const arrival = this.arrivals.get(token);
    if (!deps || !arrival || arrival.from !== from) return;
    arrival.committed = true;
    arrival.committedAt = deps.now();
    // The final snapshot replaces the first only for the same player. Its position is taken only where this node
    // owns the block, as checked for the first; elsewhere the player arrives at the first snapshot's point.
    const snapshot = validSnapshot(body?.snapshot);
    if (!snapshot || snapshot.id !== arrival.snapshot.id || snapshot.username !== arrival.snapshot.username) return;
    if (deps.ownerAt(snapshot.map, snapshot.x, snapshot.y) === deps.self) {
      arrival.snapshot = snapshot;
      return;
    }
    log.warn(`Handoff of ${snapshot.username} from ${from}: the commit names ${snapshot.map} (${snapshot.x}, ${snapshot.y}), not owned here; kept ${arrival.snapshot.map} (${arrival.snapshot.x}, ${arrival.snapshot.y})`);
    const { map, x, y } = arrival.snapshot;
    arrival.snapshot = { ...snapshot, map, x, y };
  }
}

/** This node's player handoff: started by a link hook in cluster mode (Task 13), never otherwise. */
export const playerHandoff = new PlayerHandoff();
