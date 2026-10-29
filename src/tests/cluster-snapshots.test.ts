import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { MemoryStore } from "../cluster/memorystore";
import { SNAPSHOT_TTL_MS, SnapshotWriter, chooseNewer, readSnapshot, snapshotKey, snapshotOf, useSnapshotMaps, type SavedSnapshot } from "../cluster/snapshots";

// The maps a node knows (startCluster sets them from the maps it loaded): a snapshot is read only on one of them.
const MAPS = [{ name: "main", widthPx: 6400, heightPx: 3200 }];
beforeEach(() => { useSnapshotMaps(MAPS); });
afterEach(() => {
  setSystemTime();
  useSnapshotMaps(null);
});

const owned = (name: string, epoch = 4, over: any = {}) => ({
  username: name, ownerEpoch: epoch,
  location: { map: "main.json", position: { x: 101.6, y: 50.2, direction: "left" } },
  stats: { health: 40, max_health: 100, stamina: 20, max_stamina: 50, level: 3 },
  ...over,
});

test("a snapshot carries the epoch, the bare map, the rounded point and the four stats", () => {
  expect(snapshotOf(owned("Hero"), 1000)).toEqual({
    epoch: 4, at: 1000, username: "hero", map: "main", x: 102, y: 50, direction: "left",
    stats: { health: 40, max_health: 100, stamina: 20, max_stamina: 50 },
  });
});

test("no snapshot of a player with no owner epoch, or in a handoff", () => {
  // Guard: the ownerEpoch check. A player whose epoch was never taken (outside cluster mode, or kicked) is not owned.
  expect(snapshotOf(owned("Hero", 0), 1)).toBeNull();
  expect(snapshotOf({ ...owned("Hero"), ownerEpoch: undefined }, 1)).toBeNull();
  // Guard: the handoff check. The new node writes the player once it has it.
  expect(snapshotOf(owned("Hero", 4, { handoff: { to: "b" } }), 1)).toBeNull();
  expect(snapshotOf(owned("Hero", 4, { location: { map: "main.json", position: { x: Number.NaN, y: 1 } } }), 1)).toBeNull();
});

test("writeAll writes owned players in chunks, and the key runs out", async () => {
  setSystemTime(new Date(1_000_000));
  const store = new MemoryStore();
  const players = Array.from({ length: 450 }, (_, i) => owned(`p${i}`));
  players.push(owned("ghost", 0));
  let inFlight = 0;
  let most = 0;
  const set = store.set.bind(store);
  const counted = {
    set: async (key: string, value: string, ttl?: number) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await Promise.resolve();
      await set(key, value, ttl);
      inFlight--;
    },
  };
  const writer = new SnapshotWriter(counted, () => players, { chunk: 200 });
  expect(await writer.writeAll()).toBe(450);
  // Guard: the chunking. Without it 450 writes are in flight at once.
  expect(most).toBeLessThanOrEqual(200);
  expect((await readSnapshot(store, "P7"))?.username).toBe("p7");
  expect(await readSnapshot(store, "ghost")).toBeNull();
  setSystemTime(new Date(1_000_000 + SNAPSHOT_TTL_MS + 1));
  expect(await readSnapshot(store, "p7")).toBeNull();
});

test("a malformed snapshot reads as none", async () => {
  const store = new MemoryStore();
  await store.set(snapshotKey("hero"), "not json");
  expect(await readSnapshot(store, "hero")).toBeNull();
  await store.set(snapshotKey("hero"), JSON.stringify({ epoch: 1, at: 2, username: "hero", map: "main", x: "1", y: 2, direction: "up", stats: null }));
  expect(await readSnapshot(store, "hero")).toBeNull();
  await store.set(snapshotKey("hero"), JSON.stringify({ epoch: 1, at: 2, username: "hero", map: "main", x: 1, y: 2, direction: "up", stats: { health: "x" } }));
  expect(await readSnapshot(store, "hero")).toBeNull();
});

const snap = (epoch: number, at: number): SavedSnapshot => ({ epoch, at, username: "hero", map: "main", x: 1, y: 2, direction: "up", stats: null });

test("the snapshot wins only when it is newer than the save and not from an older owner", () => {
  expect(chooseNewer({ ownerEpoch: 4, savedAt: 1000 }, snap(4, 2000))).toEqual(snap(4, 2000));
  expect(chooseNewer({ ownerEpoch: 4, savedAt: 1000 }, snap(5, 2000))).toEqual(snap(5, 2000));
  // Guard: snap.at > savedAt. After a clean logout the row is newer.
  expect(chooseNewer({ ownerEpoch: 4, savedAt: 2000 }, snap(4, 2000))).toBeNull();
  // Guard: snap.epoch >= ownerEpoch. A node that lost the player kept writing for a moment.
  expect(chooseNewer({ ownerEpoch: 5, savedAt: 1000 }, snap(4, 9000))).toBeNull();
  expect(chooseNewer(null, snap(4, 2000))).toBeNull();
  expect(chooseNewer({ ownerEpoch: 4, savedAt: 1000 }, null)).toBeNull();
});

// Security review L1: the times of two different owners are two nodes' clocks, never compared.
test("a snapshot of a later owner epoch wins whatever the times say", () => {
  // The later owner's clock runs behind the row's writer: its snapshot is still the newer state.
  expect(chooseNewer({ ownerEpoch: 4, savedAt: 9000 }, snap(5, 1000))).toEqual(snap(5, 1000));
  expect(chooseNewer({ ownerEpoch: 4, savedAt: 9000 }, snap(5, 9000))).toEqual(snap(5, 9000));
});

test("a snapshot of an older owner epoch loses whatever the times say, and one epoch compares the times", () => {
  expect(chooseNewer({ ownerEpoch: 5, savedAt: 1 }, snap(4, 99_999))).toBeNull();
  expect(chooseNewer({ ownerEpoch: 5, savedAt: 1000 }, snap(5, 1001))).toEqual(snap(5, 1001));
  expect(chooseNewer({ ownerEpoch: 5, savedAt: 1000 }, snap(5, 999))).toBeNull();
});

// Security review H1, the bounds: a snapshot puts a login where it says, so one is taken only where this node can put one.
const stored = (over: any = {}) =>
  JSON.stringify({ epoch: 4, at: 2000, username: "hero", map: "main", x: 100, y: 50, direction: "left", stats: null, ...over });

test("a snapshot inside a known map, facing a known way, is read, edges included", async () => {
  const store = new MemoryStore();
  await store.set(snapshotKey("hero"), stored());
  expect((await readSnapshot(store, "Hero"))?.x).toBe(100);
  await store.set(snapshotKey("hero"), stored({ x: 0, y: 0 }));
  expect(await readSnapshot(store, "hero")).not.toBeNull();
  await store.set(snapshotKey("hero"), stored({ x: 6400, y: 3200, direction: "upright" }));
  expect(await readSnapshot(store, "hero")).not.toBeNull();
});

test("a snapshot outside its map, on a map not known here, or facing no known way is not read", async () => {
  const store = new MemoryStore();
  for (const over of [
    { x: -1 }, { y: -1 }, { x: 6401 }, { y: 3201 }, { x: 1e12, y: 1e12 },
    { map: "elsewhere" }, { map: "main.json" }, { map: "../main" },
    { direction: "sideways" }, { direction: "" },
  ]) {
    await store.set(snapshotKey("hero"), stored(over));
    expect(await readSnapshot(store, "hero")).toBeNull();
  }
});

test("a snapshot of another player is not read for this one", async () => {
  const store = new MemoryStore();
  await store.set(snapshotKey("hero"), stored({ username: "villain" }));
  expect(await readSnapshot(store, "hero")).toBeNull();
});

test("before any maps are known no snapshot is read", async () => {
  const store = new MemoryStore();
  await store.set(snapshotKey("hero"), stored());
  useSnapshotMaps(null);
  expect(await readSnapshot(store, "hero")).toBeNull();
  // The previous maps come back from the setter, as startCluster's teardown puts them back.
  expect(useSnapshotMaps(MAPS)).toBeNull();
  const previous = useSnapshotMaps(null);
  expect(previous?.get("main")?.widthPx).toBe(6400);
  useSnapshotMaps(previous);
  expect((await readSnapshot(store, "hero"))?.username).toBe("hero");
});

test("a direction outside the known ones is written as down", () => {
  expect(snapshotOf(owned("Hero", 4, { location: { map: "main", position: { x: 1, y: 1, direction: "<script>" } } }), 1)?.direction).toBe("down");
});

test("start writes on its interval, never two passes at once, and stop ends it", async () => {
  const store = new MemoryStore();
  let passes = 0;
  let overlap = false;
  let running = false;
  const slow = {
    set: async (key: string, value: string, ttl?: number) => {
      if (running) overlap = true;
      running = true;
      passes++;
      await new Promise((resolve) => setTimeout(resolve, 30));
      await store.set(key, value, ttl);
      running = false;
    },
  };
  const stop = new SnapshotWriter(slow, () => [owned("hero")], { everyMs: 5 }).start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  stop();
  const after = passes;
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(passes).toBeGreaterThan(0);
  expect(passes).toBeLessThanOrEqual(after + 1);
  // Guard: the `writing` flag in start(). Without it a slow store gets passes on top of each other.
  expect(overlap).toBe(false);
});

test("writeAll stamps each snapshot with the time of the pass, and counts only the writes the store took", async () => {
  const store = new MemoryStore();
  const set = store.set.bind(store);
  const refusing = {
    set: async (key: string, value: string, ttl?: number) => {
      if (key === snapshotKey("p1")) throw new Error("store down");
      await set(key, value, ttl);
    },
  };
  const writer = new SnapshotWriter(refusing, () => [owned("p0"), owned("p1"), owned("p2")], { now: () => 777_000 });
  // Guard: only fulfilled writes are counted.
  expect(await writer.writeAll()).toBe(2);
  // Guard: the stamp. A snapshot stamped 0 never wins over a saved row, which turns recovery off.
  expect((await readSnapshot(store, "p0"))?.at).toBe(777_000);
  expect(chooseNewer({ ownerEpoch: 4, savedAt: 776_999 }, await readSnapshot(store, "p2"))?.username).toBe("p2");
  expect(await readSnapshot(store, "p1")).toBeNull();
});
