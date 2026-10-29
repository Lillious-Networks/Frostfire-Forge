import { expect, test } from "bun:test";
import { PlayerDirectory } from "../cluster/directory";
import { MemoryStore } from "../cluster/memorystore";

test("claim points the name at this node, one epoch on", async () => {
  const store = new MemoryStore();
  const a = new PlayerDirectory(store, "a");
  const first = await a.claim("Hero", "11", "main");
  expect(first.previous).toBeNull();
  expect(first.entry).toEqual({ nodeId: "a", playerId: "11", epoch: 1, map: "main" });
  expect(await a.get("hero")).toEqual(first.entry);
});

test("a claim on another node displaces the first and says so", async () => {
  const store = new MemoryStore();
  const a = new PlayerDirectory(store, "a");
  const b = new PlayerDirectory(store, "b");
  await a.claim("hero", "11", "main");
  const second = await b.claim("hero", "22", "main");
  expect(second.previous?.nodeId).toBe("a");
  expect(second.entry.epoch).toBe(2);
  expect(await a.playersOn("a")).toEqual([]);
  expect(await b.playersOn("b")).toEqual(["hero"]);
});

test("a stale release leaves the newer claim", async () => {
  const store = new MemoryStore();
  const a = new PlayerDirectory(store, "a");
  const b = new PlayerDirectory(store, "b");
  const old = await a.claim("hero", "11", "main");
  await b.claim("hero", "22", "main");
  expect(await a.release("hero", old.entry.epoch)).toBe(false);
  expect((await a.get("hero"))?.nodeId).toBe("b");
});

test("a late release of an old claim cannot delete a claim made after the name was freed", async () => {
  const store = new MemoryStore();
  const a = new PlayerDirectory(store, "a");
  const b = new PlayerDirectory(store, "b");
  const c = new PlayerDirectory(store, "c");
  const first = await a.claim("hero", "11", "main");
  const second = await b.claim("hero", "22", "main");
  expect(await b.release("hero", second.entry.epoch)).toBe(true);
  const third = await c.claim("hero", "33", "main");
  expect(third.entry.epoch).toBeGreaterThan(first.entry.epoch);
  expect(await a.release("hero", first.entry.epoch)).toBe(false);
  expect(await c.get("hero")).toEqual(third.entry);
});

test("release removes the entry", async () => {
  const store = new MemoryStore();
  const a = new PlayerDirectory(store, "a");
  const { entry } = await a.claim("hero", "11", "main");
  expect(await a.release("hero", entry.epoch)).toBe(true);
  expect(await a.get("hero")).toBeNull();
  expect(await a.playersOn("a")).toEqual([]);
});

test("sweepNode removes what a node still holds, and only that", async () => {
  const store = new MemoryStore();
  const a = new PlayerDirectory(store, "a");
  const b = new PlayerDirectory(store, "b");
  await a.claim("one", "11", "main");
  await a.claim("two", "12", "main");
  await b.claim("three", "21", "main");
  expect(await b.sweepNode("a")).toBe(2);
  expect(await a.get("one")).toBeNull();
  expect(await a.get("two")).toBeNull();
  expect((await a.get("three"))?.nodeId).toBe("b");
  expect(await a.playersOn("a")).toEqual([]);
  expect(await a.sweepNode("a")).toBe(0);
});

test("sweepNode leaves a name another node has taken since, and drops it from the set", async () => {
  const store = new MemoryStore();
  const a = new PlayerDirectory(store, "a");
  // A name the set still lists although the entry moved on (a crash between the two writes).
  await a.claim("hero", "11", "main");
  await store.set("cells:dir:hero", JSON.stringify({ nodeId: "b", playerId: "22", epoch: 5, map: "main" }));
  expect(await a.sweepNode("a")).toBe(0);
  expect((await a.get("hero"))?.nodeId).toBe("b");
  expect(await a.playersOn("a")).toEqual([]);
});

test("release keeps the name in the node's set when a newer login on the same node has claimed it", async () => {
  const store = new MemoryStore();
  const a = new PlayerDirectory(store, "a");
  const old = await a.claim("hero", "11", "main");
  // The relogin claims the name between the old session's delete and its set update.
  const deleteIfEpoch = store.deleteIfEpoch.bind(store);
  store.deleteIfEpoch = async (key, epoch) => {
    const deleted = await deleteIfEpoch(key, epoch);
    await a.claim("hero", "12", "main");
    return deleted;
  };
  expect(await a.release("hero", old.entry.epoch)).toBe(true);
  expect((await a.get("hero"))?.playerId).toBe("12");
  expect(await a.playersOn("a")).toEqual(["hero"]);
});

test("a claim retried after its swap leaves no stale member in the old node's set", async () => {
  const store = new MemoryStore();
  const a = new PlayerDirectory(store, "a");
  const b = new PlayerDirectory(store, "b");
  await a.claim("hero", "11", "main");
  // The store fails at the set update after the swap (an outage): the claim is run again.
  const removeFromSet = store.removeFromSet.bind(store);
  store.removeFromSet = async () => { throw new Error("CONNECTION_CLOSED"); };
  await expect(b.claim("hero", "22", "main")).rejects.toThrow("CONNECTION_CLOSED");
  store.removeFromSet = removeFromSet;
  expect(await a.playersOn("a")).toEqual(["hero"]);
  const retry = await b.claim("hero", "22", "main");
  expect(retry.previous?.nodeId).toBe("b");
  expect(await a.playersOn("a")).toEqual([]);
  expect(await b.playersOn("b")).toEqual(["hero"]);
});

test("a release that lost its epoch drops the name from its own node's set only", async () => {
  const store = new MemoryStore();
  const a = new PlayerDirectory(store, "a");
  const b = new PlayerDirectory(store, "b");
  const old = await a.claim("hero", "11", "main");
  const taken = await b.claim("hero", "22", "main");
  // The set of a still lists the name (a failed removal earlier).
  await store.addToSet("cells:dirnode:a", "hero");
  expect(await a.release("hero", old.entry.epoch)).toBe(false);
  expect(await a.playersOn("a")).toEqual([]);
  expect(await b.playersOn("b")).toEqual(["hero"]);
  expect(await a.get("hero")).toEqual(taken.entry);
});

test("repairIndex drops a member whose entry names another node or is missing, and keeps a correct one", async () => {
  const store = new MemoryStore();
  const a = new PlayerDirectory(store, "a");
  const b = new PlayerDirectory(store, "b");
  await a.claim("good", "1", "main");
  await b.claim("moved", "2", "main");
  await store.addToSet("cells:dirnode:a", "moved");
  await store.addToSet("cells:dirnode:a", "gone");
  expect(await a.repairIndex()).toBe(2);
  expect(await a.playersOn("a")).toEqual(["good"]);
  expect(await b.playersOn("b")).toEqual(["moved"]);
  expect((await b.get("moved"))?.nodeId).toBe("b");
  expect(await a.repairIndex()).toBe(0);
});

const entryOf = (nodeId: string, epoch = 50) => JSON.stringify({ nodeId, playerId: "9", epoch, map: "main" });
// After the first removal from a node set, the name is claimed by that node (the entry names it from then on).
const claimDuringRemoval = (store: MemoryStore, node: string) => {
  const remove = store.removeFromSet.bind(store);
  let once = true;
  store.removeFromSet = async (key, member) => {
    await remove(key, member);
    if (once) { once = false; await store.set("cells:dir:hero", entryOf(node)); }
  };
};

test("a release that lost its epoch puts the name back when its node claims it during the removal", async () => {
  const store = new MemoryStore();
  const a = new PlayerDirectory(store, "a");
  const b = new PlayerDirectory(store, "b");
  const old = await a.claim("hero", "11", "main");
  await b.claim("hero", "22", "main");
  await store.addToSet("cells:dirnode:a", "hero");
  claimDuringRemoval(store, "a");
  expect(await a.release("hero", old.entry.epoch)).toBe(false);
  expect(await a.playersOn("a")).toEqual(["hero"]);
});

test("a release that deleted the entry puts the name back when its node claims it during the removal", async () => {
  const store = new MemoryStore();
  const a = new PlayerDirectory(store, "a");
  const old = await a.claim("hero", "11", "main");
  claimDuringRemoval(store, "a");
  expect(await a.release("hero", old.entry.epoch)).toBe(true);
  expect(await a.playersOn("a")).toEqual(["hero"]);
});

test("a claim's removal from the old owner's set keeps a member the old owner claimed during it", async () => {
  const store = new MemoryStore();
  const a = new PlayerDirectory(store, "a");
  const b = new PlayerDirectory(store, "b");
  await a.claim("hero", "11", "main");
  claimDuringRemoval(store, "a");
  await b.claim("hero", "22", "main");
  expect(await a.playersOn("a")).toEqual(["hero"]);
});

test("a failed claim's owed node is forgotten at release", async () => {
  const store = new MemoryStore();
  const a = new PlayerDirectory(store, "a");
  const b = new PlayerDirectory(store, "b");
  await a.claim("hero", "11", "main");
  const remove = store.removeFromSet.bind(store);
  store.removeFromSet = async () => { throw new Error("CONNECTION_CLOSED"); };
  await expect(b.claim("hero", "22", "main")).rejects.toThrow();
  store.removeFromSet = remove;
  expect((b as any).owed.size).toBe(1);
  await b.release("hero", 2);
  expect((b as any).owed.size).toBe(0);
});

test("repairIndex does not touch a correct member", async () => {
  const store = new MemoryStore();
  const a = new PlayerDirectory(store, "a");
  await a.claim("good", "1", "main");
  let removals = 0;
  const remove = store.removeFromSet.bind(store);
  store.removeFromSet = async (key, member) => { removals++; await remove(key, member); };
  expect(await a.repairIndex()).toBe(0);
  expect(removals).toBe(0);
  expect(await a.playersOn("a")).toEqual(["good"]);
});

test("repairIndex keeps a member its node claims while the repair drops it", async () => {
  const store = new MemoryStore();
  const a = new PlayerDirectory(store, "a");
  await store.set("cells:dir:hero", entryOf("b"));
  await store.addToSet("cells:dirnode:a", "hero");
  claimDuringRemoval(store, "a");
  expect(await a.repairIndex()).toBe(0);
  expect(await a.playersOn("a")).toEqual(["hero"]);
});

test("repairIndex checks a bounded batch per call and reaches every member over several calls", async () => {
  const store = new MemoryStore();
  const a = new PlayerDirectory(store, "a");
  for (let i = 0; i < 450; i++) await store.addToSet("cells:dirnode:a", `stale${String(i).padStart(3, "0")}`);
  for (let i = 0; i < 50; i++) await a.claim(`good${i}`, String(i), "main");
  expect(await a.repairIndex()).toBeLessThanOrEqual(200);
  for (let pass = 0; pass < 12; pass++) await a.repairIndex();
  const left = await a.playersOn("a");
  expect(left.length).toBe(50);
  expect(left.every((name) => name.startsWith("good"))).toBe(true);
});
