import type { CallRedirect } from "./linkcalls";

// Where a player or creature went, for a few seconds after a handoff (cells phase 6). A call or a delivery that a
// peer sent before it learned of the handoff reaches the old owner; the old owner passes it on, once, to the new one.
// After FORWARD_TTL_MS every peer has the new owner from GHOST_HANDOVER and the directory, so nothing is passed on.

export const FORWARD_TTL_MS = 5_000;
/** Entries kept at most; past it the oldest go first. A handoff storm cannot grow the table without bound. */
export const FORWARD_MAX_ENTRIES = 10_000;

/** A key whose id or name part is empty names nobody: it is never stored and never matches. */
const emptyKey = (key: string) => key.endsWith(":");

export class ForwardTable {
  private readonly entries = new Map<string, { to: string; until: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = FORWARD_TTL_MS,
    private readonly maxEntries = FORWARD_MAX_ENTRIES,
  ) {}

  /** How many entries are held, expired ones not yet dropped included. */
  get size(): number {
    return this.entries.size;
  }

  add(key: string, to: string): void {
    if (emptyKey(key) || !to) return;
    // Deleting first moves a re-added key to the back, so insertion order is expiry order (the time to live is one value).
    this.entries.delete(key);
    this.entries.set(key, { to, until: this.now() + this.ttlMs });
    this.prune();
  }

  /** Drops expired entries from the front, then the oldest while the table is over its cap. */
  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && now <= entry.until) break;
      this.entries.delete(key);
    }
  }

  /** Where `key` went, while its entry lasts; null after. */
  to(key: string): string | null {
    if (emptyKey(key)) return null;
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (this.now() > entry.until) {
      this.entries.delete(key);
      return null;
    }
    return entry.to;
  }

  addPlayer(id: string, username: string, to: string): void {
    this.add(`player:${id}`, to);
    this.add(`user:${username.toLowerCase()}`, to);
  }

  addCreature(id: number, to: string): void {
    this.add(`creature:${id}`, to);
  }

  /** The player is back on this node (or logged in here again): nothing for them is passed on. */
  forgetPlayer(id: string, username: string): void {
    this.entries.delete(`player:${id}`);
    this.entries.delete(`user:${username.toLowerCase()}`);
  }

  forgetCreature(id: number): void {
    this.entries.delete(`creature:${id}`);
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * The redirect for linkCalls.setRedirect. A call that names a player or creature this node handed off a moment
 * ago runs on the node that has it now. Every other call runs here. The trade calls are not redirected: the trade
 * link keeps its own partners, and a trading player is not handed off.
 */
export function redirectCall(table: ForwardTable): CallRedirect {
  // A field that is missing or empty is not a key: `player:undefined` and `user:` must match nothing.
  const player = (id: unknown) => (typeof id === "string" || typeof id === "number" ? table.to(`player:${id}`) : null);
  const user = (name: unknown) => (typeof name === "string" ? table.to(`user:${name.toLowerCase()}`) : null);
  const creature = (id: unknown) => (typeof id === "number" && Number.isFinite(id) ? table.to(`creature:${id}`) : null);
  return (name, body) => {
    if (name === "APPLY_EFFECT") {
      const op = body?.op;
      if (op === "player_hit" || op === "creature_on_player") return player(body?.target);
      if (op === "creature_hit" || op === "creature_threat") return creature(body?.target);
      return null;
    }
    if (name === "APPLY_REWARD") return player(body?.playerId) ?? user(body?.username);
    if (name === "GRANT") return user(body?.username);
    return null;
  };
}

/** This node's table: filled by the handoffs, read by the redirect and the delivery forwarder (Task 13). */
export const forwardTable = new ForwardTable();
