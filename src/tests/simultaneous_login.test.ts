import { expect, test, mock, beforeEach } from "bun:test";

// Two players logging in at the same exact time must end up mutually visible:
// each side's `playersInAOI` contains the other, the reverse index agrees, and
// a spawn is queued in BOTH directions. Uses the real AOI module (only the
// database is stubbed); each test gets its own map name because LayerManager
// has no reset and layers are keyed by map.
mock.module("../controllers/sqldatabase", () => ({
  default: async (_sql: string, _params?: any[]) => [],
}));

// Generated at server start (`bun create-config`) and gitignored, so CI has
// no copy on disk. Mock the values instead of requiring the file.
mock.module("../config/aoi.json", () => ({
  default: {
    DEFAULT_RADIUS: 1000,
    UPDATE_THRESHOLD: 100,
    GRID_CELL_SIZE: 512,
    USE_SPATIAL_GRID: true,
    SPATIAL_GRID_THRESHOLD: 50,
    MAX_PLAYERS_PER_LAYER: 50,
    DEBUG: false,
  },
}));

const playerCache = (await import("../services/playermanager")).default;
const mapIndex = (await import("../services/mapindex")).default;
const spatialGrid = (await import("../services/spatialgrid")).default;
const aoiReverse = await import("../services/aoiReverseIndex");
const { initializePlayerAOI, updatePlayerAOI } = await import("../socket/aoi");

let mapSeq = 0;

function resetWorld() {
  playerCache.clear();
  mapIndex.clear();
  spatialGrid.clear();
  aoiReverse._reset();
}

function makePlayer(id: string, username: string, map: string, x: number, y: number): any {
  return {
    id,
    username,
    location: { map, position: { x, y, direction: "down" } },
    ws: { readyState: 1, send: () => {} },
    party: [],
    party_id: null,
    moving: false,
  };
}

// Full login-sequence equivalent for one player: cache add -> AOI init ->
// map index -> AOI update (mirrors the auth-complete path in receiver.ts).
async function loginPlayer(
  p: any,
  spawnBatchQueue: Map<string, Map<string, any>>,
  despawnBatchQueue: Map<string, Set<string>>
): Promise<void> {
  playerCache.add(p.id, p);
  const cached = playerCache.get(p.id);
  await initializePlayerAOI(cached);
  playerCache.set(cached.id, cached);
  mapIndex.addPlayer(cached.id, cached.location.map);
  await updatePlayerAOI(cached, spawnBatchQueue, despawnBatchQueue);
}

beforeEach(() => resetWorld());

test("sequential logins are mutually visible with spawns queued both ways", async () => {
  const map = `simtest${++mapSeq}`;
  const spawn = new Map<string, Map<string, any>>();
  const despawn = new Map<string, Set<string>>();

  await loginPlayer(makePlayer("A", "Alice", map, 500, 500), spawn, despawn);
  await loginPlayer(makePlayer("B", "Bob", map, 510, 510), spawn, despawn);

  const a = playerCache.get("A");
  const b = playerCache.get("B");

  // Same layer, same map.
  expect(a.aoi.layerId).toBe(b.aoi.layerId);
  // Mutual forward visibility.
  expect(a.aoi.playersInAOI.has("B")).toBe(true);
  expect(b.aoi.playersInAOI.has("A")).toBe(true);
  // Reverse index agrees in both directions.
  expect(aoiReverse.getViewers("A").has("B")).toBe(true);
  expect(aoiReverse.getViewers("B").has("A")).toBe(true);
  // A spawn is queued for each side.
  expect(spawn.get("A")?.has("B")).toBe(true);
  expect(spawn.get("B")?.has("A")).toBe(true);
});

test("concurrent logins converge to mutual visibility (no lost spawn)", async () => {
  const map = `simtest${++mapSeq}`;
  const spawn = new Map<string, Map<string, any>>();
  const despawn = new Map<string, Set<string>>();

  // Both players are already in the cache (auth completed for both) and their
  // AOI updates run concurrently - the simultaneous-login interleaving.
  const a = makePlayer("A", "Alice", map, 500, 500);
  const b = makePlayer("B", "Bob", map, 510, 510);
  playerCache.add(a.id, a);
  playerCache.add(b.id, b);
  await initializePlayerAOI(playerCache.get("A"));
  await initializePlayerAOI(playerCache.get("B"));
  mapIndex.addPlayer("A", map);
  mapIndex.addPlayer("B", map);

  await Promise.all([
    updatePlayerAOI(playerCache.get("A"), spawn, despawn),
    updatePlayerAOI(playerCache.get("B"), spawn, despawn),
  ]);

  const pa = playerCache.get("A");
  const pb = playerCache.get("B");

  expect(pa.aoi.layerId).toBe(pb.aoi.layerId);
  expect(pa.aoi.playersInAOI.has("B")).toBe(true);
  expect(pb.aoi.playersInAOI.has("A")).toBe(true);
  expect(aoiReverse.getViewers("A").has("B")).toBe(true);
  expect(aoiReverse.getViewers("B").has("A")).toBe(true);
  // At least one direction queued each spawn; whoever ran second may have
  // found the other already present (entered-loop dedup), but the union must
  // cover both directions exactly once across the two updates.
  expect(spawn.get("A")?.has("B")).toBe(true);
  expect(spawn.get("B")?.has("A")).toBe(true);
});

test("late joiner's update heals an early update that ran before they existed", async () => {
  const map = `simtest${++mapSeq}`;
  const spawn = new Map<string, Map<string, any>>();
  const despawn = new Map<string, Set<string>>();

  // A logs in and updates while B does not exist anywhere yet.
  await loginPlayer(makePlayer("A", "Alice", map, 500, 500), spawn, despawn);
  expect(playerCache.get("A").aoi.playersInAOI.size).toBe(0);

  // B logs in afterwards: B's own update must queue BOTH directions so A
  // learns about B without having to move.
  await loginPlayer(makePlayer("B", "Bob", map, 510, 510), spawn, despawn);

  expect(playerCache.get("B").aoi.playersInAOI.has("A")).toBe(true);
  expect(playerCache.get("A").aoi.playersInAOI.has("B")).toBe(true);
  expect(spawn.get("A")?.has("B")).toBe(true);
  expect(spawn.get("B")?.has("A")).toBe(true);
});

test("forward sets and reverse index stay consistent after mutual login", async () => {
  const map = `simtest${++mapSeq}`;
  const spawn = new Map<string, Map<string, any>>();
  const despawn = new Map<string, Set<string>>();

  await loginPlayer(makePlayer("A", "Alice", map, 500, 500), spawn, despawn);
  await loginPlayer(makePlayer("B", "Bob", map, 510, 510), spawn, despawn);

  // For every player, every id in their forward set must list them as a
  // viewer in the reverse index (the invariant movement broadcast relies on).
  for (const id of ["A", "B"]) {
    const p = playerCache.get(id);
    for (const seen of p.aoi.playersInAOI) {
      expect(aoiReverse.getViewers(seen).has(id)).toBe(true);
    }
  }
});
