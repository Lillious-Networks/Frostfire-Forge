/**
 * The dispatch of login jobs over the auth-worker pool (authentication_pool.ts), apart from the workers
 * themselves so a test can run it with fake ones.
 *
 * - Every job goes to the worker with the fewest jobs in flight; of equals, the next one after the last chosen.
 * - Every worker's answers reach the same handlers, a replacement's too: the dispatcher attaches its listeners to
 *   each worker it starts, nobody else does.
 * - A worker that errors or exits is dropped, replaced, and its jobs in flight fail at once, each once, with the
 *   answer a failed login gives (`authenticated: false` and an error), so the receiver tells the client and clears
 *   the queue entries as it does for any failed login. A late answer from the dropped worker is ignored.
 * - A job whose token is already in flight goes to the worker that holds it, never to a second one. The AUTH case
 *   (socket/handlers/session.ts) already refuses such a login before it gets here (`authentication_queue`, by
 *   token, is set before the post and cleared by `completeLogin` only when the answer, or the failure above, has
 *   come), so this only makes the guarantee hold without that guard.
 * - The lists the workers copy at their start (spells, items, mounts) are kept here: a refresh reaches every
 *   worker and the copy given to a replacement.
 */

/** What the pool needs of a worker (a worker_threads Worker, or a fake one). */
export interface PoolWorker {
  postMessage(message: unknown): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  terminate(): unknown;
}

/** A login for the worker: the account's token, and the id of the connection (the session claimed for it). */
export interface AuthJob {
  token: string;
  id: string;
  /** The account whose rows were read already: its token reads nothing more (socket/loginprefetch.ts). */
  known?: string;
  /** Not a login: read this player's rows ahead of it, with a `prefetch:` id (socket/loginprefetch.ts). */
  prefetch?: string;
}

/** The lists a worker takes at its start, serialized (null: none). */
export type AuthAssets = Record<string, string | null>;

/** The error a login fails with when its worker stopped. */
export const LOST_WORKER_ERROR = "Authentication failed: the login worker stopped";

interface Slot<W> {
  /** Number for logs; never reused. */
  n: number;
  worker: W;
  /** Ids of the jobs it was given that have not been answered. */
  inflight: Set<string>;
  /** Jobs it was given since it started. */
  dispatched: number;
  dead: boolean;
}

export interface AuthDispatcherOptions<W extends PoolWorker> {
  /** Workers to keep running. */
  size: number;
  /** Starts a worker with the lists as they are now. */
  create: (assets: AuthAssets) => W;
  debug?: (message: string) => void;
  error?: (message: string) => void;
}

export class AuthDispatcher<W extends PoolWorker> {
  private slots: Slot<W>[] = [];
  private cursor = 0;
  private serial = 0;
  private running = false;
  private assets: AuthAssets = {};
  /** Jobs in flight, by id. */
  private jobs = new Map<string, { slot: Slot<W>; job: AuthJob }>();
  /** The worker that holds the jobs in flight of a token. */
  private holders = new Map<string, { slot: Slot<W>; count: number }>();
  private resultHandlers: Array<(result: any) => unknown> = [];
  private lostHandlers: Array<(job: AuthJob) => unknown> = [];

  constructor(private readonly options: AuthDispatcherOptions<W>) {}

  /** Starts the workers with these lists. Does nothing once started. */
  start(assets: AuthAssets): void {
    if (this.running) return;
    this.running = true;
    this.assets = { ...assets };
    for (let i = 0; i < this.options.size; i++) this.spawn();
  }

  get started(): boolean {
    return this.running;
  }

  /** Workers running now. */
  get size(): number {
    return this.slots.length;
  }

  /**
   * "message": called with every worker's answer, as an EventEmitter would (a failure of the handler is the
   * caller's). "lost": called with a job whose worker stopped, just before its failed answer goes to "message".
   */
  on(event: "message", handler: (result: any) => unknown): this;
  on(event: "lost", handler: (job: AuthJob) => unknown): this;
  on(event: string, handler: (arg: any) => unknown): this {
    if (event === "message") this.resultHandlers.push(handler);
    else if (event === "lost") this.lostHandlers.push(handler);
    return this;
  }

  /** Hands a login to a worker (named as a worker's own method, so the AUTH case reads as it always has). */
  postMessage(job: AuthJob): void {
    const key = String(job.id);
    if (this.jobs.has(key)) {
      this.options.error?.(`[AUTH POOL] A login for connection ${key} is already in flight: the second is not run`);
      return;
    }
    const held = this.holders.get(job.token)?.slot;
    const slot = held ?? this.pick();
    if (!slot) {
      // No worker is running (the replacement could not be started): fail it as a stopped worker would, not hang.
      this.options.error?.(`[AUTH POOL] No worker is running for the login of connection ${key}`);
      queueMicrotask(() => this.failJob(job));
      return;
    }
    slot.inflight.add(key);
    slot.dispatched++;
    this.jobs.set(key, { slot, job });
    const holder = this.holders.get(job.token);
    if (holder) holder.count++;
    else this.holders.set(job.token, { slot, count: 1 });
    this.options.debug?.(`[AUTH POOL] login to worker ${slot.n}: ${slot.inflight.size} in flight there, ${slot.dispatched} given to it so far`);
    try {
      slot.worker.postMessage(job);
    } catch (error) {
      this.retire(slot, `[AUTH POOL] Worker ${slot.n} could not be given a login: ${error}`);
    }
  }

  /** A list changed: every worker gets it, and any worker started later. */
  refresh(key: string, serialized: string | null): void {
    this.assets[key] = serialized;
    for (const slot of [...this.slots]) {
      try {
        slot.worker.postMessage({ [key]: serialized });
      } catch (error) {
        this.retire(slot, `[AUTH POOL] Worker ${slot.n} could not be given the new ${key}: ${error}`);
      }
    }
  }

  /** For each running worker: its number, the jobs in flight, and the jobs given to it since it started. */
  stats(): Array<{ worker: number; inflight: number; dispatched: number }> {
    return this.slots.map((slot) => ({ worker: slot.n, inflight: slot.inflight.size, dispatched: slot.dispatched }));
  }

  /** Stops every worker, without replacing them. Jobs in flight fail. */
  stop(): void {
    this.running = false;
    for (const slot of [...this.slots]) this.retire(slot, null);
    this.assets = {};
  }

  /** The worker with the fewest jobs in flight; of equals, the first after the last chosen. */
  private pick(): Slot<W> | undefined {
    const count = this.slots.length;
    let best: Slot<W> | undefined;
    let bestAt = -1;
    for (let k = 0; k < count; k++) {
      const at = (this.cursor + k) % count;
      const slot = this.slots[at];
      if (!best || slot.inflight.size < best.inflight.size) {
        best = slot;
        bestAt = at;
      }
    }
    if (best) this.cursor = (bestAt + 1) % count;
    return best;
  }

  private spawn(): void {
    let worker: W;
    try {
      worker = this.options.create({ ...this.assets });
    } catch (error) {
      this.options.error?.(`[AUTH POOL] A worker could not be started: ${error}`);
      return;
    }
    const slot: Slot<W> = { n: ++this.serial, worker, inflight: new Set(), dispatched: 0, dead: false };
    worker.on("message", (result: any) => this.receive(slot, result));
    worker.on("error", (error: Error) => this.retire(slot, `[AUTH POOL] Worker error: ${error?.message ?? error}`));
    worker.on("exit", (code: number) => this.retire(slot, code !== 0 ? `[AUTH POOL] Worker exited with code ${code}` : ""));
    this.slots.push(slot);
  }

  /** An answer from a worker: it goes on once, and only for a job that worker still holds. */
  private receive(slot: Slot<W>, result: any): void {
    const key = String(result?.id);
    const entry = this.jobs.get(key);
    if (!entry || entry.slot !== slot) {
      this.options.debug?.(`[AUTH POOL] An answer for connection ${key} from worker ${slot.n} was ignored: it holds no such login`);
      return;
    }
    this.release(key, entry);
    for (const handler of this.resultHandlers) handler(result);
  }

  private release(key: string, entry: { slot: Slot<W>; job: AuthJob }): void {
    this.jobs.delete(key);
    entry.slot.inflight.delete(key);
    const holder = this.holders.get(entry.job.token);
    if (holder && --holder.count <= 0) this.holders.delete(entry.job.token);
  }

  /**
   * A worker stopped (error or exit; once, whichever comes first): it is dropped and ended, a new one is started in
   * its place while the pool runs, and every job it held fails.
   */
  private retire(slot: Slot<W>, message: string | null): void {
    if (slot.dead) return;
    slot.dead = true;
    const at = this.slots.indexOf(slot);
    if (at >= 0) this.slots.splice(at, 1);
    this.cursor = this.slots.length > 0 ? this.cursor % this.slots.length : 0;
    try {
      slot.worker.terminate();
    } catch {
      // Already gone.
    }
    const lost: AuthJob[] = [];
    for (const key of [...slot.inflight]) {
      const entry = this.jobs.get(key);
      if (!entry) continue;
      this.release(key, entry);
      lost.push(entry.job);
    }
    if (message !== null && (message || lost.length > 0)) {
      const text = message || "[AUTH POOL] Worker exited";
      this.options.error?.(lost.length > 0 ? `${text} (${lost.length} logins in flight fail)` : text);
    }
    if (this.running) this.spawn();
    for (const job of lost) this.failJob(job);
  }

  /** The answer of a failed login, for a job that has none to wait for. It never throws. */
  private failJob(job: AuthJob): void {
    // Each handler runs in its own try: one that throws synchronously must not skip the others or the failed answer.
    for (const handler of this.lostHandlers) {
      try {
        Promise.resolve(handler(job)).catch((error) => this.options.error?.(`[AUTH POOL] The loss of the login of connection ${job.id} was not handled: ${error}`));
      } catch (error) {
        this.options.error?.(`[AUTH POOL] The loss of the login of connection ${job.id} was not handled: ${error}`);
      }
    }
    const failed = { id: job.id, token: job.token, authenticated: false, completed: true, error: LOST_WORKER_ERROR };
    for (const handler of this.resultHandlers) {
      try {
        Promise.resolve(handler(failed)).catch((error) => this.options.error?.(`[AUTH POOL] The failed login of connection ${job.id} was not handled: ${error}`));
      } catch (error) {
        this.options.error?.(`[AUTH POOL] The failed login of connection ${job.id} was not handled: ${error}`);
      }
    }
  }
}

/** The most threads a worker's database pool may have. */
const MAX_AUTH_DB_THREADS = 64;

/**
 * The environment an auth worker starts with. Each worker imports the database controller, which starts its own
 * pool of database threads (DB_WORKER_POOL_SIZE, 8 by default), each holding up to 10 connections. With every
 * worker of the pool used, the default would let one node open eight times the connections it did when one worker
 * did the logins. A worker runs its queries at most as fast as one thread can, so it gets one thread
 * (AUTH_DB_WORKER_POOL_SIZE changes it): the pool as a whole still reaches as many connections as the one worker
 * did, spread over its workers.
 */
export function authWorkerEnv(env: Record<string, string | undefined>): Record<string, string> {
  const wanted = parseInt(env.AUTH_DB_WORKER_POOL_SIZE || "", 10);
  const threads = Number.isInteger(wanted) && wanted > 0 ? Math.min(wanted, MAX_AUTH_DB_THREADS) : 1;
  const copy: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) copy[name] = value;
  }
  copy.DB_WORKER_POOL_SIZE = String(threads);
  return copy;
}
