import { expect, test, mock, beforeEach } from "bun:test";

// Duplicate-login (session kick) regression tests.
//
// Bug: when the same user logged in twice, the kick path notified bystanders
// with packetManager.disconnect (type DISCONNECT_MALIFORMED - "you sent
// malformed data, you are disconnected") instead of a DESPAWN_PLAYER. The
// bystander's client treated it as its own disconnection and blanked to the
// loading screen, swallowing the replacement session's spawn that arrived
// right after: one side could see the other, but not vice versa. The kicked
// session was also never removed from the world indices (the later
// onDisconnect early-returns on the cache miss), leaking a ghost id into
// viewers' AOI sets, the reverse index, its layer, the map index and the
// spatial grid.
//
// Uses the real AOI / index modules (only the database is stubbed). Each test
// gets its own map name because LayerManager has no reset.
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
const layerManager = (await import("../services/layermanager")).default;
const mapIndex = (await import("../services/mapindex")).default;
const spatialGrid = (await import("../services/spatialgrid")).default;
const aoiReverse = await import("../services/aoiReverseIndex");
const {
  initializePlayerAOI,
  updatePlayerAOI,
  cleanupKickedSession,
  findPlayersWithTargetInAOI,
} = await import("../socket/aoi");
const { packetManager } = await import("../socket/packet_manager");

let mapSeq = 1000;

function resetWorld() {
  playerCache.clear();
  mapIndex.clear();
  spatialGrid.clear();
  aoiReverse._reset();
}

function decode(packet: Uint8Array) {
  return JSON.parse(new TextDecoder().decode(packet));
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

async function loginPlayer(
  p: any,
  spawn: Map<string, Map<string, any>>,
  despawn: Map<string, Set<string>>
): Promise<void> {
  playerCache.add(p.id, p);
  const cached = playerCache.get(p.id);
  await initializePlayerAOI(cached);
  playerCache.set(cached.id, cached);
  mapIndex.addPlayer(cached.id, cached.location.map);
  await updatePlayerAOI(cached, spawn, despawn);
}

beforeEach(() => resetWorld());

test("bystander notify must be DESPAWN_PLAYER, never DISCONNECT_MALIFORMED", () => {
  // Locks in the packet semantics the kick path relies on: `disconnect` is a
  // self-directed "you are disconnected" signal and must never be sent about
  // a third party; entity removal is DESPAWN_PLAYER.
  const [disc] = packetManager.disconnect("old-session");
  expect(decode(disc).type).toBe("DISCONNECT_MALIFORMED");

  const [despawn] = packetManager.despawnPlayer("old-session", "disconnect");
  const body = decode(despawn);
  expect(body.type).toBe("DESPAWN_PLAYER");
  expect(body.data.id).toBe("old-session");
});

test("kicked session leaves no ghost in any world index", async () => {
  const map = `kicktest${++mapSeq}`;
  const spawn = new Map<string, Map<string, any>>();
  const despawn = new Map<string, Set<string>>();

  await loginPlayer(makePlayer("A", "Alice", map, 500, 500), spawn, despawn);
  await loginPlayer(makePlayer("B", "Bob", map, 510, 510), spawn, despawn);
  const layerId = playerCache.get("A").aoi.layerId;

  // Precondition: mutual visibility established.
  expect(playerCache.get("B").aoi.playersInAOI.has("A")).toBe(true);

  // Simulate the kick of A's session (what receiver.ts does on duplicate
  // login, minus the socket writes): index cleanup + cache removal.
  const kicked = playerCache.get("A");
  cleanupKickedSession(kicked, despawn);
  playerCache.remove("A");

  // No ghost id anywhere.
  expect(layerManager.getPlayersInLayer(layerId)).not.toContain("A");
  expect(layerManager.getPlayerLayer("A")).toBeNull();
  expect([...mapIndex.getPlayersOnMap(map)]).not.toContain("A");
  expect(spatialGrid.hasPlayer("A")).toBe(false);
  // Viewers no longer list the kicked session...
  expect(playerCache.get("B").aoi.playersInAOI.has("A")).toBe(false);
  expect(aoiReverse.getViewers("A").size).toBe(0);
  expect(findPlayersWithTargetInAOI("A")).toEqual([]);
  // ...but B keeps its own healthy state.
  expect(playerCache.get("B").aoi.layerId).toBe(layerId);
  // And B is queued a proper despawn for the kicked session.
  expect(despawn.get("B")?.has("A")).toBe(true);
});

test("replacement session becomes mutually visible after kick cleanup", async () => {
  const map = `kicktest${++mapSeq}`;
  const spawn = new Map<string, Map<string, any>>();
  const despawn = new Map<string, Set<string>>();

  // A and B online and mutually visible.
  await loginPlayer(makePlayer("A", "Alice", map, 500, 500), spawn, despawn);
  await loginPlayer(makePlayer("B", "Bob", map, 510, 510), spawn, despawn);

  // Alice relogs: kick old session, then run the new session's login.
  cleanupKickedSession(playerCache.get("A"), despawn);
  playerCache.remove("A");
  spawn.clear();
  despawn.clear();
  await loginPlayer(makePlayer("A2", "Alice", map, 500, 500), spawn, despawn);

  const a2 = playerCache.get("A2");
  const b = playerCache.get("B");

  // Same layer (no ghost leaked the old session's slot).
  expect(a2.aoi.layerId).toBe(b.aoi.layerId);
  // Mutual visibility with the NEW id only - no stale id lingers.
  expect(a2.aoi.playersInAOI.has("B")).toBe(true);
  expect(b.aoi.playersInAOI.has("A2")).toBe(true);
  expect(b.aoi.playersInAOI.has("A")).toBe(false);
  expect(aoiReverse.getViewers("A2").has("B")).toBe(true);
  expect(aoiReverse.getViewers("B").has("A2")).toBe(true);
  expect(aoiReverse.getViewers("A").size).toBe(0);
  // Spawns queued in both directions for the live sessions.
  expect(spawn.get("B")?.has("A2")).toBe(true);
  expect(spawn.get("A2")?.has("B")).toBe(true);
});
