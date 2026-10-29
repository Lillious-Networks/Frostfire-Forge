import { afterEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { databaseModule } from "./setup";

const sent: string[] = [];
// Whether a stand-in cluster lock was held when each statement reached the database.
const sentWhile: string[] = [];
let lockState = "out";
mock.module("../controllers/sqldatabase", () => databaseModule({ default: async (sql: string) => (sent.push(sql), sentWhile.push(lockState), { affectedRows: 1 }) }));

const { MemoryStore } = await import("../cluster/memorystore");
const { PlayerLockBusy, PlayerLockLost, PlayerLocks } = await import("../cluster/playerlock");
const { atomically, setClusterPlayerLock } = await import("../services/batch");
const { default: log } = await import("../modules/logger");

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  setSystemTime();
  sent.length = 0;
  sentWhile.length = 0;
  lockState = "out";
});

test("a lock is taken, held while the work runs, and released", async () => {
  const store = new MemoryStore();
  const locks = new PlayerLocks(store, "n1");
  const seen = await locks.withLocks(["Alice"], async () => {
    expect(locks.held("alice")).toBe(true);
    return JSON.parse((await store.get("cells:plock:alice"))!);
  });
  expect(seen.node).toBe("n1");
  expect(await store.get("cells:plock:alice")).toBeNull();
  expect(locks.held("alice")).toBe(false);
});

test("a player named epoch locks normally, apart from the epoch counter", async () => {
  const store = new MemoryStore();
  const locks = new PlayerLocks(store, "n1");
  for (const round of [1, 2]) {
    const seen = await locks.withLocks(["Epoch"], async () => {
      expect(locks.held("epoch")).toBe(true);
      return JSON.parse((await store.get("cells:plock:epoch"))!);
    }, { waitMs: 0 });
    expect(seen).toMatchObject({ epoch: round, node: "n1" });
    expect(await store.get("cells:plock:epoch")).toBeNull();
    expect(await store.get("cells:plock-epoch")).toBe(String(round));
  }
});

test("a second locker waits until the first releases", async () => {
  const store = new MemoryStore();
  const one = new PlayerLocks(store, "n1");
  const two = new PlayerLocks(store, "n2");
  const order: string[] = [];
  const first = one.withLocks(["alice"], async () => { order.push("one in"); await wait(60); order.push("one out"); });
  await wait(5);
  const second = two.withLocks(["alice"], async () => { order.push("two in"); }, { waitMs: 1000 });
  await Promise.all([first, second]);
  expect(order).toEqual(["one in", "one out", "two in"]);
});

test("a locker that cannot wait is busy, and its work does not run", async () => {
  const store = new MemoryStore();
  const one = new PlayerLocks(store, "n1");
  const two = new PlayerLocks(store, "n2");
  let ran = false;
  const first = one.withLocks(["alice"], () => wait(50));
  await wait(5);
  await expect(two.withLocks(["alice"], async () => { ran = true; }, { waitMs: 0 })).rejects.toBeInstanceOf(PlayerLockBusy);
  expect(ran).toBe(false);
  await first;
});

test("two lockers of the same pair in opposite order both finish", async () => {
  const store = new MemoryStore();
  const one = new PlayerLocks(store, "n1");
  const two = new PlayerLocks(store, "n2");
  const done: string[] = [];
  await Promise.all([
    one.withLocks(["bob", "alice"], async () => { await wait(30); done.push("one"); }, { waitMs: 1000 }),
    two.withLocks(["alice", "bob"], async () => { await wait(30); done.push("two"); }, { waitMs: 1000 }),
  ]);
  expect(done.sort()).toEqual(["one", "two"]);
});

test("a busy name releases the names taken before it", async () => {
  const store = new MemoryStore();
  const one = new PlayerLocks(store, "n1");
  const two = new PlayerLocks(store, "n2");
  const holding = one.withLocks(["bob"], () => wait(50));
  await wait(5);
  await expect(two.withLocks(["alice", "bob"], async () => {}, { waitMs: 0 })).rejects.toBeInstanceOf(PlayerLockBusy);
  expect(await store.get("cells:plock:alice")).toBeNull();
  await holding;
});

test("a release after the lock ran out does not free the next holder's lock", async () => {
  const store = new MemoryStore();
  const one = new PlayerLocks(store, "n1", { ttlMs: 1000, renewMs: 60_000 });
  const two = new PlayerLocks(store, "n2");
  const start = Date.now();
  let release!: () => void;
  const first = one.withLocks(["alice"], () => new Promise<void>((resolve) => { release = resolve; }));
  await wait(5);
  // n1 stalled past its ttl: n2 takes the lock.
  setSystemTime(new Date(start + 2000));
  let secondHolds!: () => void;
  const gate = new Promise<void>((resolve) => { secondHolds = resolve; });
  let finish!: () => void;
  const second = two.withLocks(["alice"], () => { secondHolds(); return new Promise<void>((resolve) => { finish = resolve; }); }, { waitMs: 0 });
  await gate;
  release();
  await first;
  const value = JSON.parse((await store.get("cells:plock:alice"))!);
  expect(value.node).toBe("n2");
  finish();
  await second;
});

test("a lock held past its ttl is renewed while the work runs", async () => {
  const store = new MemoryStore();
  const one = new PlayerLocks(store, "n1", { ttlMs: 150, renewMs: 30 });
  const two = new PlayerLocks(store, "n2");
  const first = one.withLocks(["alice"], () => wait(400));
  await wait(250);
  await expect(two.withLocks(["alice"], async () => {}, { waitMs: 0 })).rejects.toBeInstanceOf(PlayerLockBusy);
  await first;
});

function brokenStore() {
  const store = new MemoryStore();
  (store as any).setIfAbsent = async () => { throw new Error("redis down"); };
  (store as any).incrBy = async () => { throw new Error("redis down"); };
  return store;
}

test("without Redis, work on local players only runs unlocked", async () => {
  const warn = spyOn(log, "warn").mockImplementation(() => {});
  try {
    const locks = new PlayerLocks(brokenStore(), "n1");
    expect(await locks.withLocks(["alice"], async () => "ran", { isLocal: () => true })).toBe("ran");
  } finally {
    warn.mockRestore();
  }
});

test("without Redis, work that names a player of another node does not run", async () => {
  const locks = new PlayerLocks(brokenStore(), "n1");
  let ran = false;
  await expect(locks.withLocks(["alice", "bob"], async () => { ran = true; }, { isLocal: (name) => name === "alice" })).rejects.toThrow("redis down");
  expect(ran).toBe(false);
});

test("no cluster lock is set until one is asked for", () => {
  const previous = setClusterPlayerLock(null);
  expect(previous).toBeNull();
});

test("a batch runs its transaction inside the cluster lock, with its players sorted", async () => {
  const asked: string[][] = [];
  const previous = setClusterPlayerLock(async (players, work) => {
    asked.push(players);
    lockState = "in";
    try {
      return await work(async () => {});
    } finally {
      lockState = "out";
    }
  });
  try {
    await atomically(["Bob", "alice", "bob"], async (batch) => batch.add({ sql: "UPDATE currency SET copper = 1" }));
    expect(asked).toEqual([["alice", "bob"]]);
    expect(sent).toEqual(["UPDATE currency SET copper = 1"]);
    // Sent while the lock was held, not before it was taken or after it was given up.
    expect(sentWhile).toEqual(["in"]);
  } finally {
    setClusterPlayerLock(previous);
  }
});

test("a batch whose lock was lost writes nothing, and is undone as a failed batch", async () => {
  let checked = 0;
  const previous = setClusterPlayerLock(async (_players, work) => work(async () => {
    checked++;
    throw new PlayerLockLost("alice");
  }));
  try {
    let undone = false;
    let kept = false;
    let afterRan = false;
    await expect(atomically(["alice"], async (batch) => {
      batch.add({ sql: "UPDATE currency SET copper = 3" });
      batch.kept(() => { kept = true; });
      batch.undone(() => { undone = true; });
      batch.after(() => { afterRan = true; });
    })).rejects.toBeInstanceOf(PlayerLockLost);
    expect(checked).toBe(1);
    expect(sent).toEqual([]);
    expect(undone).toBe(true);
    expect(kept).toBe(false);
    expect(afterRan).toBe(false);
  } finally {
    setClusterPlayerLock(previous);
  }
});

test("a batch checks its locks after its work, right before the transaction", async () => {
  const order: string[] = [];
  const previous = setClusterPlayerLock(async (_players, work) => work(async () => { order.push("check"); }));
  try {
    await atomically(["alice"], async (batch) => {
      order.push("work");
      batch.add({ sql: "UPDATE currency SET copper = 4" }, () => order.push("sent"));
    });
    expect(order).toEqual(["work", "check", "sent"]);
  } finally {
    setClusterPlayerLock(previous);
  }
});

test("a work that throws gives its locks back", async () => {
  const store = new MemoryStore();
  const one = new PlayerLocks(store, "n1");
  const two = new PlayerLocks(store, "n2");
  await expect(one.withLocks(["alice", "bob"], async () => { throw new Error("work failed"); })).rejects.toThrow("work failed");
  expect(await store.get("cells:plock:alice")).toBeNull();
  expect(await store.get("cells:plock:bob")).toBeNull();
  expect(one.held("alice")).toBe(false);
  expect(one.held("bob")).toBe(false);
  expect(await two.withLocks(["alice", "bob"], async () => "in", { waitMs: 0 })).toBe("in");
});

test("a busy lock does not run unlocked even when every player is local", async () => {
  const store = new MemoryStore();
  const one = new PlayerLocks(store, "n1");
  const two = new PlayerLocks(store, "n2");
  let ran = false;
  const holding = one.withLocks(["alice"], () => wait(50));
  await wait(5);
  await expect(two.withLocks(["alice"], async () => { ran = true; }, { waitMs: 0, isLocal: () => true })).rejects.toBeInstanceOf(PlayerLockBusy);
  expect(ran).toBe(false);
  await holding;
});

test("a holder whose lock ran out cannot commit after the next holder did", async () => {
  const warn = spyOn(log, "warn").mockImplementation(() => {});
  try {
    const store = new MemoryStore();
    const one = new PlayerLocks(store, "n1", { ttlMs: 200, renewMs: 20 });
    const two = new PlayerLocks(store, "n2");
    let bob = 100;
    let firstRead!: () => void;
    const readDone = new Promise<void>((resolve) => { firstRead = resolve; });
    let goOn!: () => void;
    const resume = new Promise<void>((resolve) => { goOn = resolve; });
    const first = one.withLocks(["bob"], async (check) => {
      const seen = bob;
      firstRead();
      await resume;
      await check();
      bob = seen - 30;
    });
    await readDone;
    // The lock is lost (a Redis restart, say): the next renewal finds it gone.
    await store.del("cells:plock:bob");
    await wait(60);
    expect(one.held("bob")).toBe(false);
    await two.withLocks(["bob"], async (check) => {
      const seen = bob;
      await check();
      bob = seen - 50;
    }, { waitMs: 0 });
    goOn();
    await expect(first).rejects.toBeInstanceOf(PlayerLockLost);
    expect(bob).toBe(50);
  } finally {
    warn.mockRestore();
  }
});

test("check finds a lost lock before any renewal has run", async () => {
  const warn = spyOn(log, "warn").mockImplementation(() => {});
  try {
    const store = new MemoryStore();
    const one = new PlayerLocks(store, "n1", { renewMs: 60_000 });
    await expect(one.withLocks(["alice"], async (check) => {
      await store.del("cells:plock:alice");
      await check();
    })).rejects.toBeInstanceOf(PlayerLockLost);
    expect(one.held("alice")).toBe(false);
  } finally {
    warn.mockRestore();
  }
});

test("when the store fails after a hold, the old holder commits nothing and only the local fallback writes", async () => {
  const warn = spyOn(log, "warn").mockImplementation(() => {});
  const error = spyOn(log, "error").mockImplementation(() => {});
  try {
    const store = new MemoryStore();
    const one = new PlayerLocks(store, "n1", { renewMs: 60_000 });
    const two = new PlayerLocks(store, "n2");
    const commits: string[] = [];
    let held!: () => void;
    const holding = new Promise<void>((resolve) => { held = resolve; });
    let goOn!: () => void;
    const resume = new Promise<void>((resolve) => { goOn = resolve; });
    const first = one.withLocks(["alice", "bob"], async (check) => {
      held();
      await resume;
      await check();
      commits.push("n1");
    });
    await holding;
    // Redis goes down.
    for (const call of ["get", "setIfAbsent", "incrBy", "renewIfEpoch", "deleteIfEpoch"]) {
      (store as any)[call] = async () => { throw new Error("redis down"); };
    }
    await two.withLocks(["bob"], async (check) => {
      await check();
      commits.push("n2");
    }, { isLocal: () => true });
    goOn();
    await expect(first).rejects.toThrow("redis down");
    expect(commits).toEqual(["n2"]);
  } finally {
    warn.mockRestore();
    error.mockRestore();
  }
});

test("an epoch that comes round again does not let the old holder free the new holder's lock", async () => {
  const warn = spyOn(log, "warn").mockImplementation(() => {});
  try {
    const store = new MemoryStore();
    const one = new PlayerLocks(store, "n1", { renewMs: 60_000 });
    const two = new PlayerLocks(store, "n2", { renewMs: 60_000 });
    let release!: () => void;
    const first = one.withLocks(["alice"], () => new Promise<void>((resolve) => { release = resolve; }));
    await wait(5);
    // Redis lost its data: the lock and the counter are gone, so the next hold draws epoch 1 again.
    await store.del("cells:plock:alice");
    await store.del("cells:plock-epoch");
    let secondHolds!: () => void;
    const gate = new Promise<void>((resolve) => { secondHolds = resolve; });
    let finish!: () => void;
    const second = two.withLocks(["alice"], () => { secondHolds(); return new Promise<void>((resolve) => { finish = resolve; }); }, { waitMs: 0 });
    await gate;
    const value = JSON.parse((await store.get("cells:plock:alice"))!);
    expect(value).toMatchObject({ epoch: 1, node: "n2" });
    release();
    await first;
    expect(JSON.parse((await store.get("cells:plock:alice"))!)).toEqual(value);
    finish();
    await second;
  } finally {
    warn.mockRestore();
  }
});

test("the wait is one deadline for all the names, not one per name", async () => {
  const store = new MemoryStore();
  const holders = ["a", "b", "c"].map((name, index) => new PlayerLocks(store, `h${index}`).withLocks([name], () => wait(90 * (index + 1))));
  await wait(5);
  const locks = new PlayerLocks(store, "n1");
  const start = Date.now();
  await expect(locks.withLocks(["a", "b", "c"], async () => {}, { waitMs: 100 })).rejects.toBeInstanceOf(PlayerLockBusy);
  expect(Date.now() - start).toBeLessThan(170);
  await Promise.all(holders);
});

test("a store that does not answer an acquire makes the locker busy, and a late set is given up", async () => {
  const warn = spyOn(log, "warn").mockImplementation(() => {});
  try {
    const store = new MemoryStore();
    const real = store.setIfAbsent.bind(store);
    store.setIfAbsent = async (key, value, ttlMs) => { await wait(400); return real(key, value, ttlMs); };
    const locks = new PlayerLocks(store, "n1");
    let ran = false;
    const start = Date.now();
    await expect(locks.withLocks(["alice"], async () => { ran = true; }, { waitMs: 0, isLocal: () => true })).rejects.toBeInstanceOf(PlayerLockBusy);
    expect(Date.now() - start).toBeLessThan(380);
    expect(ran).toBe(false);
    await wait(450);
    expect(await store.get("cells:plock:alice")).toBeNull();
    expect(locks.held("alice")).toBe(false);
  } finally {
    warn.mockRestore();
  }
});

test("a store that does not answer a renewal counts the lock as lost", async () => {
  const warn = spyOn(log, "warn").mockImplementation(() => {});
  const error = spyOn(log, "error").mockImplementation(() => {});
  try {
    const store = new MemoryStore();
    const locks = new PlayerLocks(store, "n1", { renewMs: 50 });
    let committed = false;
    await expect(locks.withLocks(["alice"], async (check) => {
      store.renewIfEpoch = () => new Promise<boolean>(() => {});
      await check();
      committed = true;
    })).rejects.toBeInstanceOf(PlayerLockLost);
    expect(committed).toBe(false);
  } finally {
    warn.mockRestore();
    error.mockRestore();
  }
});

test("with no cluster lock set, a batch runs as before", async () => {
  const previous = setClusterPlayerLock(null);
  try {
    let kept = false;
    let afterRan = false;
    const answer = await atomically(["alice"], async (batch) => {
      batch.add({ sql: "UPDATE currency SET copper = 2" });
      batch.kept(() => { kept = true; });
      batch.after(() => { afterRan = true; });
      return "done";
    });
    expect(answer).toBe("done");
    expect(sent).toEqual(["UPDATE currency SET copper = 2"]);
    expect(kept).toBe(true);
    expect(afterRan).toBe(true);
  } finally {
    setClusterPlayerLock(previous);
  }
});

test("after an epoch comes round again, the old holder's check finds its lock lost", async () => {
  const warn = spyOn(log, "warn").mockImplementation(() => {});
  try {
    const store = new MemoryStore();
    const one = new PlayerLocks(store, "n1", { renewMs: 60_000 });
    const two = new PlayerLocks(store, "n2", { renewMs: 60_000 });
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    const first = one.withLocks(["alice"], async (check) => { await paused; await check(); });
    await wait(5);
    // Redis lost its data: the next hold draws epoch 1 again, the old holder's own epoch.
    await store.del("cells:plock:alice");
    await store.del("cells:plock-epoch");
    let finish!: () => void;
    const second = two.withLocks(["alice"], () => new Promise<void>((resolve) => { finish = resolve; }), { waitMs: 0 });
    await wait(5);
    resume();
    await expect(first).rejects.toBeInstanceOf(PlayerLockLost);
    expect(JSON.parse((await store.get("cells:plock:alice"))!)).toMatchObject({ epoch: 1, node: "n2" });
    finish();
    await second;
  } finally {
    warn.mockRestore();
  }
});
