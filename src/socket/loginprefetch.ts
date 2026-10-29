// The rows of a player arriving by handoff, read while their client is still on its way (cells phase 6). The old node
// casts HANDOFF_SAVED once its save of the player has landed: from then the rows are the ones the login would read, so
// the auth pool reads them at once. The client's AUTH then only has the token checked (the worker is told the
// username it expects); a token of another account, or a read that failed, logs in by reading everything, as any
// login does. Kept apart from receiver.ts so a test can run it with a fake pool.

import log from "../modules/logger";

/** The id (and token) of a read's job in the auth pool: never a connection's id. */
export const PREFETCH_PREFIX = "prefetch:";
/** How long a read is kept for the AUTH that uses it: an arrival is kept no longer (handoff.ts ARRIVAL_TTL_MS). */
export const PREFETCH_TTL_MS = 10_000;
/** The most reads kept at once (handoff.ts parks no more arrivals than this). */
export const MAX_PREFETCHES = 256;

/** A read for the auth pool: the worker loads `prefetch`'s rows, without claiming a session. */
export interface PrefetchJob {
  token: string;
  id: string;
  prefetch: string;
}

interface Entry {
  username: string;
  data: Promise<PlayerData | null>;
  settle: (data: PlayerData | null) => void;
  at: number;
  /** Given to an AUTH: kept only until the answer settles it. */
  taken: boolean;
}

export class LoginPrefetch {
  /** By the arrival's ticket. */
  private entries = new Map<string, Entry>();

  constructor(private readonly post: (job: PrefetchJob) => void, private readonly now: () => number = Date.now) {}

  /** Whether a pool answer is a read's (see answer) rather than a login's. */
  static owns(result: any): boolean {
    return String(result?.id ?? "").startsWith(PREFETCH_PREFIX);
  }

  /** Reads the rows of `username`, who arrives with this ticket. A second read for the same ticket is not started. */
  start(ticket: string, username: string): void {
    if (!ticket || !username || this.entries.has(ticket)) return;
    this.sweep();
    while (this.entries.size >= MAX_PREFETCHES) this.drop(this.entries.keys().next().value as string);
    let settle!: (data: PlayerData | null) => void;
    const data = new Promise<PlayerData | null>((resolve) => { settle = resolve; });
    this.entries.set(ticket, { username, data, settle, at: this.now(), taken: false });
    const id = PREFETCH_PREFIX + ticket;
    try {
      this.post({ token: id, id, prefetch: username });
    } catch (error) {
      log.debug(`The rows of ${username} were not read ahead of their login: ${error}`);
      this.drop(ticket);
    }
  }

  /** The pool's answer to a read. One that failed settles as null: the AUTH reads everything. */
  answer(result: any): void {
    const ticket = String(result?.id ?? "").slice(PREFETCH_PREFIX.length);
    const entry = this.entries.get(ticket);
    if (!entry) return;
    const data = result?.prefetch === true && !result.error && result.data?.username === entry.username ? result.data as PlayerData : null;
    if (!data) {
      log.debug(`The rows of ${entry.username} were not read ahead of their login: ${result?.error ?? "no rows"}`);
      this.drop(ticket);
      return;
    }
    entry.settle(data);
  }

  /**
   * The read for the connection with this ticket, once: the username it is for and its rows. The rows settle with the
   * pool's answer, as null when the read failed or ran out (PREFETCH_TTL_MS): the login then reads them itself.
   */
  take(ticket: string): { username: string; data: Promise<PlayerData | null> } | null {
    const entry = ticket ? this.entries.get(ticket) : undefined;
    if (!entry || entry.taken) return null;
    if (this.now() - entry.at > PREFETCH_TTL_MS) {
      this.drop(ticket);
      return null;
    }
    entry.taken = true;
    // A read that never answers does not hold the login: it settles as null when it runs out.
    const expire = setTimeout(() => { if (this.entries.get(ticket) === entry) this.drop(ticket); }, Math.max(0, entry.at + PREFETCH_TTL_MS - this.now()));
    (expire as any).unref?.();
    void entry.data.then(() => {
      clearTimeout(expire);
      if (this.entries.get(ticket) === entry) this.entries.delete(ticket);
    });
    return { username: entry.username, data: entry.data };
  }

  /** Reads kept now. */
  get size(): number {
    return this.entries.size;
  }

  private drop(ticket: string): void {
    this.entries.get(ticket)?.settle(null);
    this.entries.delete(ticket);
  }

  private sweep(): void {
    const now = this.now();
    for (const [ticket, entry] of this.entries) if (now - entry.at > PREFETCH_TTL_MS) this.drop(ticket);
  }
}
