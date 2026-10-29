import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { AuthDispatcher, LOST_WORKER_ERROR, authWorkerEnv, type AuthAssets, type AuthJob } from "../socket/authdispatch";

// The auth-worker pool's dispatch (socket/authdispatch.ts) with fake workers: every login job goes to the worker
// with the fewest in flight, every worker's answer reaches the one handler (a replacement's too), a worker that
// dies fails its jobs once and at once, a token is never in flight on two workers, and a list that changed reaches
// every worker and the ones started later.

class FakeWorker extends EventEmitter {
  posted: any[] = [];
  terminated = 0;
  constructor(readonly assets: AuthAssets) {
    super();
  }
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated++;
  }
  /** The jobs this worker was given (not the list refreshes). */
  get jobs(): AuthJob[] {
    return this.posted.filter((message) => message && "token" in message);
  }
  /** The answer a real worker gives for a job. */
  answer(job: AuthJob, extra: Record<string, unknown> = {}): void {
    this.emit("message", { authenticated: true, completed: true, error: null, ...extra, token: job.token, id: job.id });
  }
}

function makePool(size: number, options: { failCreateAfter?: number } = {}) {
  const workers: FakeWorker[] = [];
  const results: any[] = [];
  const lost: AuthJob[] = [];
  const debugs: string[] = [];
  const errors: string[] = [];
  const pool = new AuthDispatcher<FakeWorker>({
    size,
    create: (assets) => {
      if (options.failCreateAfter !== undefined && workers.length >= options.failCreateAfter) throw new Error("cannot start");
      const worker = new FakeWorker(assets);
      workers.push(worker);
      return worker;
    },
    debug: (message) => debugs.push(message),
    error: (message) => errors.push(message),
  });
  pool.on("message", (result) => { results.push(result); });
  pool.on("lost", (job) => { lost.push(job); });
  pool.start({ spells: "s0", items: "i0", mounts: "m0" });
  return { pool, workers, results, lost, debugs, errors };
}

let counter = 0;
const job = (token = `token-${++counter}`): AuthJob => ({ token, id: `conn-${++counter}` });

test("jobs spread over every worker of the pool, not one", () => {
  const { pool, workers } = makePool(4);
  expect(pool.size).toBe(4);
  for (let i = 0; i < 8; i++) pool.postMessage(job());
  expect(workers.map((w) => w.jobs.length)).toEqual([2, 2, 2, 2]);
});

test("a job goes to the worker with the fewest in flight, and equals take turns", () => {
  const { pool, workers } = makePool(3);
  const jobs = [job(), job(), job()];
  for (const j of jobs) pool.postMessage(j);
  expect(workers.map((w) => w.jobs.length)).toEqual([1, 1, 1]);
  // Worker 2 (index 1) finishes its job: it is the one with the fewest, though the turn would be worker 1's.
  workers[1].answer(jobs[1]);
  pool.postMessage(job());
  expect(workers.map((w) => w.jobs.length)).toEqual([1, 2, 1]);
  // Busy workers are passed over: workers 0 and 2 hold one, worker 1 holds one (the new job), all equal again.
  pool.postMessage(job());
  expect(workers.map((w) => w.jobs.length)).toEqual([1, 2, 2]);
  // One worker much busier than the rest gets nothing until the others catch up.
  const { pool: other, workers: ws } = makePool(3);
  const first = job();
  other.postMessage(first); // worker 0
  other.postMessage(job()); // worker 1
  other.postMessage(job()); // worker 2
  ws[1].answer(ws[1].jobs[0]);
  ws[2].answer(ws[2].jobs[0]);
  for (let i = 0; i < 4; i++) other.postMessage(job());
  const held = other.stats().map((stat) => stat.inflight);
  expect(held.reduce((sum, n) => sum + n, 0)).toBe(5);
  expect(Math.max(...held) - Math.min(...held)).toBeLessThanOrEqual(1);
  expect(ws[0].jobs[0]).toBe(first);
});

test("the answers of every worker reach the handler, each once, as the worker gave them", () => {
  const { pool, workers, results } = makePool(3);
  const jobs = [job(), job(), job()];
  for (const j of jobs) pool.postMessage(j);
  workers.forEach((w, i) => w.answer(jobs[i], { data: { username: `player${i}` } }));
  expect(results.map((r) => r.id)).toEqual(jobs.map((j) => j.id));
  expect(results.map((r) => r.data.username)).toEqual(["player0", "player1", "player2"]);
  // An answer for a job nobody holds (a second answer, or one from the wrong worker) goes nowhere.
  workers[0].answer(jobs[0]);
  workers[0].answer(jobs[1]);
  expect(results.length).toBe(3);
  expect(pool.stats().map((s) => s.inflight)).toEqual([0, 0, 0]);
});

test("a replacement worker has the handler and takes new jobs", () => {
  const { pool, workers, results, errors } = makePool(2);
  workers[0].emit("error", new Error("boom"));
  expect(pool.size).toBe(2);
  expect(workers.length).toBe(3);
  expect(workers[0].terminated).toBe(1);
  expect(errors.some((line) => line.includes("boom"))).toBe(true);
  const replacement = workers[2];
  // New jobs reach it (worker 1 holds one, so the replacement is the one with the fewest).
  const held = job();
  pool.postMessage(held);
  const next = job();
  pool.postMessage(next);
  expect(replacement.jobs.length + workers[1].jobs.length).toBe(2);
  expect(replacement.jobs.length).toBeGreaterThan(0);
  // Its answer reaches the handler.
  const mine = replacement.jobs[0];
  replacement.answer(mine, { data: { username: "late" } });
  expect(results.map((r) => r.id)).toEqual([mine.id]);
  expect(results[0].data.username).toBe("late");
});

test("a worker that dies fails the jobs it held, once each and at once, and the others go on", () => {
  const { pool, workers, results, lost } = makePool(2);
  const a = job(), b = job(), c = job(), d = job();
  for (const j of [a, b, c, d]) pool.postMessage(j);
  // Worker 0 holds a and c, worker 1 holds b and d.
  expect(workers[0].jobs).toEqual([a, c]);
  workers[0].answer(a);
  results.length = 0;
  workers[0].emit("error", new Error("out of memory"));
  // At once: nothing waited for, nothing timed.
  expect(results.length).toBe(1);
  expect(results[0]).toMatchObject({ id: c.id, token: c.token, authenticated: false, completed: true, error: LOST_WORKER_ERROR });
  expect(lost).toEqual([c]);
  // The exit that follows the error fails nothing again, and a late answer from the dead worker is not delivered.
  workers[0].emit("exit", 1);
  workers[0].answer(c);
  expect(results.length).toBe(1);
  expect(workers.length).toBe(3);
  // The other worker's jobs are untouched.
  workers[1].answer(b);
  workers[1].answer(d);
  expect(results.map((r) => r.id)).toEqual([c.id, b.id, d.id]);
  expect(results.filter((r) => r.error === LOST_WORKER_ERROR).length).toBe(1);
});

test("a worker that exits (not an error) with jobs in flight fails them the same way", () => {
  const { pool, workers, results } = makePool(2);
  const a = job();
  pool.postMessage(a);
  workers[0].emit("exit", 0);
  expect(results.map((r) => [r.id, r.error])).toEqual([[a.id, LOST_WORKER_ERROR]]);
  expect(workers.length).toBe(3);
  workers[0].emit("error", new Error("after the exit"));
  expect(results.length).toBe(1);
  expect(workers.length).toBe(3);
});

test("a failed login carries what completeLogin reads as a failed login", () => {
  const { pool, workers, results } = makePool(1);
  pool.postMessage(job());
  workers[0].emit("error", new Error("x"));
  const failed = results[0];
  // receiver.ts completeLogin: `if (status.error && !status.authenticated)` tells the client and closes.
  expect(Boolean(failed.error) && !failed.authenticated).toBe(true);
});

test("a token already in flight goes to the worker that holds it, never to a second", () => {
  const { pool, workers } = makePool(3);
  const first = { token: "same-account", id: "conn-a" };
  pool.postMessage(first);
  // The others are idle and would be chosen first.
  pool.postMessage({ token: "same-account", id: "conn-b" });
  pool.postMessage({ token: "same-account", id: "conn-c" });
  expect(workers.map((w) => w.jobs.length)).toEqual([3, 0, 0]);
  // Other accounts still spread.
  pool.postMessage(job());
  pool.postMessage(job());
  expect(workers.map((w) => w.jobs.length)).toEqual([3, 1, 1]);
  // Once every job of the token is answered, it is free to go anywhere: here to the worker with the fewest.
  for (const j of [...workers[0].jobs]) workers[0].answer(j);
  pool.postMessage({ token: "same-account", id: "conn-d" });
  expect(workers.map((w) => w.jobs.length)).toEqual([4, 1, 1]);
  pool.postMessage({ token: "other-account", id: "conn-e" });
  expect(workers[0].jobs.length).toBe(4);
});

test("a token held by a worker that died is free to go to another", () => {
  const { pool, workers } = makePool(2);
  pool.postMessage({ token: "t", id: "conn-a" });
  workers[0].emit("error", new Error("x"));
  pool.postMessage({ token: "t", id: "conn-b" });
  const holders = workers.filter((w) => w.jobs.some((j) => j.id === "conn-b"));
  expect(holders.length).toBe(1);
  expect(holders[0]).not.toBe(workers[0]);
});

test("one connection's login is not run twice", () => {
  const { pool, workers, errors } = makePool(2);
  const a = job();
  pool.postMessage(a);
  pool.postMessage(a);
  expect(workers.reduce((n, w) => n + w.jobs.length, 0)).toBe(1);
  expect(errors.some((line) => line.includes(a.id))).toBe(true);
});

test("a list that changed reaches every worker, and the copy a replacement starts with is the new one", () => {
  const { pool, workers } = makePool(2);
  expect(workers[0].assets).toEqual({ spells: "s0", items: "i0", mounts: "m0" });
  pool.refresh("spells", "s1");
  pool.refresh("mounts", null);
  for (const w of workers) {
    expect(w.posted).toEqual([{ spells: "s1" }, { mounts: null }]);
  }
  workers[1].emit("exit", 1);
  const replacement = workers[2];
  expect(replacement.assets).toEqual({ spells: "s1", items: "i0", mounts: null });
  // And it receives the refreshes that come after it.
  pool.refresh("items", "i2");
  expect(replacement.posted).toEqual([{ items: "i2" }]);
  expect(workers[0].posted.at(-1)).toEqual({ items: "i2" });
  // The dead one gets none.
  expect(workers[1].posted.at(-1)).toEqual({ mounts: null });
});

test("with no worker to run it, a login fails at once instead of waiting", async () => {
  const { pool, workers, results, lost } = makePool(1, { failCreateAfter: 1 });
  workers[0].emit("error", new Error("x"));
  expect(pool.size).toBe(0);
  const j = job();
  pool.postMessage(j);
  await Promise.resolve();
  expect(results.map((r) => [r.id, r.error])).toEqual([[j.id, LOST_WORKER_ERROR]]);
  expect(lost).toEqual([j]);
});

test("a handler that throws on a failed login does not stop the other failures", () => {
  const { pool, workers, results } = makePool(1);
  pool.on("message", () => { throw new Error("handler broke"); });
  const a = job(), b = job();
  pool.postMessage(a);
  pool.postMessage(b);
  expect(() => workers[0].emit("error", new Error("x"))).not.toThrow();
  expect(results.map((r) => r.id)).toEqual([a.id, b.id]);
});

test("stopping the pool ends every worker, replaces none, and fails what was in flight", () => {
  const { pool, workers, results } = makePool(2);
  const a = job();
  pool.postMessage(a);
  pool.stop();
  expect(pool.size).toBe(0);
  expect(pool.started).toBe(false);
  expect(workers.map((w) => w.terminated)).toEqual([1, 1]);
  expect(workers.length).toBe(2);
  expect(results.map((r) => r.id)).toEqual([a.id]);
  workers[0].emit("exit", 0);
  expect(workers.length).toBe(2);
});

test("jobs per worker are counted at debug level; a login adds no error line", () => {
  const { pool, workers, debugs, errors } = makePool(2);
  const a = job(), b = job(), c = job();
  for (const j of [a, b, c]) pool.postMessage(j);
  expect(pool.stats()).toEqual([
    { worker: 1, inflight: 2, dispatched: 2 },
    { worker: 2, inflight: 1, dispatched: 1 },
  ]);
  expect(debugs.length).toBe(3);
  expect(debugs[2]).toContain("worker 1");
  expect(debugs[2]).toContain("2 given to it so far");
  workers[0].answer(a);
  expect(pool.stats()[0]).toEqual({ worker: 1, inflight: 1, dispatched: 2 });
  expect(errors).toEqual([]);
});

test("an auth worker's database pool is one thread unless AUTH_DB_WORKER_POOL_SIZE says more", () => {
  const base = { DB_WORKER_POOL_SIZE: "8", DATABASE_HOST: "db", UNSET: undefined };
  const env = authWorkerEnv(base);
  expect(env.DB_WORKER_POOL_SIZE).toBe("1");
  // Everything else is handed on, and the caller's environment is left as it was.
  expect(env.DATABASE_HOST).toBe("db");
  expect("UNSET" in env).toBe(false);
  expect(base.DB_WORKER_POOL_SIZE).toBe("8");
  expect(authWorkerEnv({ AUTH_DB_WORKER_POOL_SIZE: "3" }).DB_WORKER_POOL_SIZE).toBe("3");
  expect(authWorkerEnv({ AUTH_DB_WORKER_POOL_SIZE: "500" }).DB_WORKER_POOL_SIZE).toBe("64");
  for (const bad of ["0", "-2", "abc", ""]) {
    expect(authWorkerEnv({ AUTH_DB_WORKER_POOL_SIZE: bad }).DB_WORKER_POOL_SIZE).toBe("1");
  }
});

test("the receiver and the pool use the dispatcher: one answer handler on the pool, no single worker held", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const receiver = read("../socket/receiver.ts");
  const pool = read("../socket/authentication_pool.ts");
  const session = read("../socket/handlers/session.ts");
  expect(receiver).toContain("export const authWorker = await getAuthPool();");
  expect(receiver.match(/authWorker\.on\("message"/g)?.length).toBe(1);
  expect(receiver).toContain('authWorker.on("lost"');
  expect(pool).not.toContain("authWorkers[");
  expect(pool).not.toContain("getAuthWorker");
  expect(pool).toContain("new AuthDispatcher<Worker>(");
  expect(pool).toContain("authWorkerEnv(process.env)");
  expect(session).toContain("authWorker.postMessage({ token, id: wt.data.id });");
  // The refreshes go through the dispatcher, which keeps the copy for replacements.
  expect(pool.match(/pool\.refresh\(/g)?.length).toBe(3);
});

test("a lost handler that throws synchronously still lets the result handlers answer the failed login", () => {
  const { pool, workers, results, errors } = makePool(1);
  pool.on("lost", () => { throw new Error("lost handler broke"); });
  const a = job();
  pool.postMessage(a);
  expect(() => workers[0].emit("error", new Error("x"))).not.toThrow();
  expect(results.map((r) => [r.id, r.error])).toEqual([[a.id, LOST_WORKER_ERROR]]);
  expect(errors.some((message) => message.includes(`The loss of the login of connection ${a.id}`))).toBe(true);
});
