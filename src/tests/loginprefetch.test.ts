import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { LoginPrefetch, MAX_PREFETCHES, PREFETCH_PREFIX, PREFETCH_TTL_MS, type PrefetchJob } from "../socket/loginprefetch";

const make = () => {
  const jobs: PrefetchJob[] = [];
  let now = 1_000;
  const prefetch = new LoginPrefetch((job) => jobs.push(job), () => now);
  return { prefetch, jobs, advance: (ms: number) => { now += ms; } };
};
const rows = (username: string) => ({ username } as unknown as PlayerData);

test("a read goes to the pool under a prefetch id, and the AUTH takes its rows once", async () => {
  const { prefetch, jobs } = make();
  prefetch.start("t1", "ann");
  expect(jobs).toEqual([{ token: `${PREFETCH_PREFIX}t1`, id: `${PREFETCH_PREFIX}t1`, prefetch: "ann" }]);
  expect(LoginPrefetch.owns(jobs[0])).toBe(true);
  expect(LoginPrefetch.owns({ id: "42" })).toBe(false);
  prefetch.answer({ id: jobs[0].id, prefetch: true, data: rows("ann"), error: null });
  const taken = prefetch.take("t1");
  expect(taken?.username).toBe("ann");
  expect(await taken?.data).toEqual(rows("ann"));
  expect(prefetch.take("t1")).toBeNull();
});

test("an AUTH that comes before the answer waits for it", async () => {
  const { prefetch, jobs } = make();
  prefetch.start("t1", "ann");
  const taken = prefetch.take("t1")!;
  prefetch.answer({ id: jobs[0].id, prefetch: true, data: rows("ann"), error: null });
  expect(await taken.data).toEqual(rows("ann"));
  await Promise.resolve();
  expect(prefetch.size).toBe(0);
});

test("a failed read, rows of another player, or a stopped worker's answer settle as null", async () => {
  for (const answer of [
    { prefetch: true, data: null, error: "boom" },
    { prefetch: true, data: rows("bob"), error: null },
    { authenticated: false, completed: true, error: "Authentication failed: the login worker stopped" },
  ]) {
    const { prefetch, jobs } = make();
    prefetch.start("t1", "ann");
    const taken = prefetch.take("t1")!;
    prefetch.answer({ id: jobs[0].id, ...answer });
    expect(await taken.data).toBeNull();
  }
});

test("a read not taken in time is not used, and the store holds no more than its cap", async () => {
  const { prefetch, jobs, advance } = make();
  prefetch.start("t1", "ann");
  prefetch.answer({ id: jobs[0].id, prefetch: true, data: rows("ann"), error: null });
  advance(PREFETCH_TTL_MS + 1);
  expect(prefetch.take("t1")).toBeNull();
  for (let i = 0; i < MAX_PREFETCHES + 5; i++) prefetch.start(`k${i}`, `p${i}`);
  expect(prefetch.size).toBe(MAX_PREFETCHES);
  expect(prefetch.take("k0")).toBeNull();
});

test("a second read for the same ticket is not started, and a pool that throws leaves nothing kept", () => {
  const { prefetch, jobs } = make();
  prefetch.start("t1", "ann");
  prefetch.start("t1", "ann");
  expect(jobs.length).toBe(1);
  const broken = new LoginPrefetch(() => { throw new Error("no pool"); });
  broken.start("t2", "ann");
  expect(broken.size).toBe(0);
});

test("the wiring: the old node casts HANDOFF_SAVED after its save, the new node reads ahead, AUTH only checks the token", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const handoff = read("../cluster/handoff.ts");
  const server = read("../socket/server.ts");
  const receiver = read("../socket/receiver.ts");
  const worker = read("../socket/authentication.ts");
  expect(handoff.indexOf('deps.calls.cast(target, "HANDOFF_SAVED"')).toBeGreaterThan(handoff.indexOf("await deps.save(player);"));
  expect(handoff.indexOf('deps.calls.cast(target, "HANDOFF_SAVED"')).toBeLessThan(handoff.indexOf("deps.sendSwitch(player, node, ticket"));
  expect(handoff).toContain('deps.calls.onCast("HANDOFF_SAVED"');
  expect(server).toContain("saved: (token, username) => loginPrefetch.start(token, username),");
  expect(receiver).toContain("if (LoginPrefetch.owns(result)) return loginPrefetch.answer(result);");
  expect(worker).toContain("if (known && known === username) {");
});
