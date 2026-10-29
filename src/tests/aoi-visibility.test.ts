import { expect, test, mock, beforeEach, afterAll } from "bun:test";
import { databaseModule } from "./setup";

// Visibility from the spatial grid, capped at MAX_VISIBLE_PLAYERS (nearest
// first, party members and the selected target always in), block changes that
// let an overflow-layer player rejoin a lower layer, and per-block layer
// condensation. Uses the real AOI / index modules (only the database is
// stubbed); each test gets its own map name because LayerManager has no reset.
mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (_sql: string, _params?: any[]) => [],
}));

// A low visibility cap so a few dozen players overflow it. MAX_PLAYERS_PER_LAYER
// (per block) and BLOCK_SIZE_PX stay at their defaults: the layer manager
// singleton may already have been built by another test file.
const CAP = 10;
const aoiConfig: Record<string, any> = {
  DEFAULT_RADIUS: 1000,
  UPDATE_THRESHOLD: 100,
  GRID_CELL_SIZE: 512,
  USE_SPATIAL_GRID: true,
  SPATIAL_GRID_THRESHOLD: 50,
  MAX_PLAYERS_PER_LAYER: 50,
  DEBUG: false,
  MAX_VISIBLE_PLAYERS: CAP,
};
mock.module("../config/aoi.json", () => ({ default: aoiConfig, ...aoiConfig }));
// Later test files may load the AOI module without mocking the config again.
afterAll(() => {
  delete aoiConfig.MAX_VISIBLE_PLAYERS;
});

const { ATTACK_MEMORY_MS, recordAttack, resetAttacks } = await import("../cluster/attackers");
const playerCache = (await import("../services/playermanager")).default;
const layerManager = (await import("../services/layermanager")).default;
const mapIndex = (await import("../services/mapindex")).default;
const spatialGrid = (await import("../services/spatialgrid")).default;
const aoiReverse = await import("../services/aoiReverseIndex");
const {
  initializePlayerAOI,
  updatePlayerAOI,
  condenseLayers,
  despawnPlayerFromAllAOI,
  handleMapChangeAOI,
  broadcastToAOI,
  broadcastToAOIBestEffort,
  broadcastStatsUpdateToAOI,
} = await import("../socket/aoi");

function decode(packet: Uint8Array): any {
  return JSON.parse(new TextDecoder().decode(packet));
}

// A socket stand-in that records what it was sent (reliable and datagram).
function recordingWt(): any {
  const wt: any = { readyState: 1, sent: [] as any[] };
  wt.send = (packet: Uint8Array) => wt.sent.push(decode(packet));
  wt.sendBestEffort = (packet: Uint8Array) => wt.sent.push(decode(packet));
  return wt;
}

const BLOCK = 4096;
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
    wt: { readyState: 1, send: () => {} },
    party: [],
    party_id: null,
    moving: false,
  };
}

async function loginPlayer(
  p: any,
  spawn = new Map<string, Map<string, any>>(),
  despawn = new Map<string, Set<string>>()
): Promise<any> {
  playerCache.add(p.id, p);
  const cached = playerCache.get(p.id);
  await initializePlayerAOI(cached);
  playerCache.set(cached.id, cached);
  mapIndex.addPlayer(cached.id, cached.location.map);
  await updatePlayerAOI(cached, spawn, despawn);
  return cached;
}

async function updateAll(ids: string[]): Promise<void> {
  const spawn = new Map<string, Map<string, any>>();
  const despawn = new Map<string, Set<string>>();
  for (const id of ids) await updatePlayerAOI(playerCache.get(id), spawn, despawn);
}

function dist2(a: any, b: any): number {
  const dx = a.location.position.x - b.location.position.x;
  const dy = a.location.position.y - b.location.position.y;
  return dx * dx + dy * dy;
}

// Every forward edge is in the reverse index and every reverse edge is a
// forward edge (the invariant movement fan-out relies on).
function expectReverseIndexConsistent(ids: string[]): void {
  for (const id of ids) {
    const p = playerCache.get(id);
    for (const seen of p.aoi.playersInAOI) {
      expect(aoiReverse.getViewers(seen).has(id)).toBe(true);
    }
    for (const viewer of aoiReverse.getViewers(id)) {
      expect(playerCache.get(viewer).aoi.playersInAOI.has(id)).toBe(true);
    }
  }
}

// Deterministic positions with no distance ties.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

beforeEach(() => resetWorld());

test("200 players in range: each sees the nearest MAX_VISIBLE_PLAYERS (within the member margin)", async () => {
  const map = `vistest${++mapSeq}`;
  const rand = lcg(42);
  const ids: string[] = [];

  // Around a block corner so four blocks of 50 hold all 200 on one layer, all
  // within 440px of the corner (so pairwise inside the 1000px radius).
  for (let i = 0; i < 200; i++) {
    const quadrant = i % 4;
    const angle = (quadrant * 90 + 5 + rand() * 80) * (Math.PI / 180);
    const r = 20 + rand() * 420;
    const id = String(1000 + i);
    ids.push(id);
    await loginPlayer(makePlayer(id, `p${id}`, map, BLOCK + Math.cos(angle) * r, BLOCK + Math.sin(angle) * r));
  }

  const layerId = playerCache.get(ids[0]).aoi.layerId;
  for (const id of ids) expect(playerCache.get(id).aoi.layerId).toBe(layerId);

  // Everyone moves once (an AOI update each).
  await updateAll(ids);

  // Current members keep their place unless a newcomer is EXIT_HYSTERESIS
  // (1.25) times nearer, so a set is the nearest N within that margin: no
  // member is more than 1.25x farther than anyone left out.
  for (const id of ids) {
    const p = playerCache.get(id);
    expect(p.aoi.playersInAOI.size).toBe(CAP);
    let farthestMember = 0;
    let nearestOutside = Infinity;
    for (const o of ids) {
      if (o === id) continue;
      const d2 = dist2(p, playerCache.get(o));
      if (p.aoi.playersInAOI.has(o)) farthestMember = Math.max(farthestMember, d2);
      else nearestOutside = Math.min(nearestOutside, d2);
    }
    expect(farthestMember).toBeLessThanOrEqual(nearestOutside * 1.25 * 1.25);
  }

  // A viewer with no members yet gets exactly the nearest N. One player of
  // block (1,1) logs off first so the newcomer fits on the same layer.
  const leaving = ids.shift()!;
  despawnPlayerFromAllAOI(playerCache.get(leaving), "disconnect");
  mapIndex.removePlayer(leaving);
  playerCache.remove(leaving);
  const fresh = await loginPlayer(makePlayer("9999", "fresh", map, BLOCK + 3, BLOCK + 7));
  expect(fresh.aoi.layerId).toBe(layerId);
  const nearest = ids
    .sort((a, b) => dist2(fresh, playerCache.get(a)) - dist2(fresh, playerCache.get(b)))
    .slice(0, CAP);
  expect([...fresh.aoi.playersInAOI].sort()).toEqual(nearest.sort());
  ids.push("9999");

  expectReverseIndexConsistent(ids);
});

test("a party member farther than the nearest N is still visible", async () => {
  const map = `vistest${++mapSeq}`;
  const ids: string[] = [];
  const viewer = await loginPlayer(makePlayer("V", "Viewer", map, 500, 500));
  ids.push("V");
  for (let i = 0; i < 20; i++) {
    const id = `n${i}`;
    ids.push(id);
    await loginPlayer(makePlayer(id, id, map, 500 + 10 + i * 7, 500 + i * 3));
  }
  // 900px away: inside the radius, outside the nearest 10.
  await loginPlayer(makePlayer("M", "Member", map, 1400, 500));
  ids.push("M");
  viewer.party = ["Member"];

  await updateAll(ids);

  // The member takes one of the cap's places; the rest are the nearest.
  const v = playerCache.get("V");
  expect(v.aoi.playersInAOI.has("M")).toBe(true);
  expect(v.aoi.playersInAOI.size).toBe(CAP);
  expectReverseIndexConsistent(ids);
});

test("the selected target is still visible when farther than the nearest N", async () => {
  const map = `vistest${++mapSeq}`;
  const ids: string[] = [];
  const viewer = await loginPlayer(makePlayer("V", "Viewer", map, 500, 500));
  ids.push("V");
  for (let i = 0; i < 20; i++) {
    const id = `n${i}`;
    ids.push(id);
    await loginPlayer(makePlayer(id, id, map, 500 + 10 + i * 7, 500 + i * 3));
  }
  await loginPlayer(makePlayer("T", "Target", map, 500, 1400));
  ids.push("T");
  viewer.selectedPlayerId = "T";

  await updateAll(ids);

  expect(playerCache.get("V").aoi.playersInAOI.has("T")).toBe(true);
  expectReverseIndexConsistent(ids);
});

test("a recent attacker is still visible when farther than the nearest N, and only while recent", async () => {
  const map = `vistest${++mapSeq}`;
  const ids: string[] = [];
  await loginPlayer(makePlayer("V", "Viewer", map, 500, 500));
  ids.push("V");
  for (let i = 0; i < 20; i++) {
    const id = `n${i}`;
    ids.push(id);
    await loginPlayer(makePlayer(id, id, map, 500 + 10 + i * 7, 500 + i * 3));
  }
  await loginPlayer(makePlayer("A", "Attacker", map, 500, 1400));
  ids.push("A");

  try {
    // No attack recorded: the far player is left out, as before.
    await updateAll(ids);
    expect(playerCache.get("V").aoi.playersInAOI.has("A")).toBe(false);
    expect(playerCache.get("V").aoi.playersInAOI.size).toBe(CAP);

    // A hit from A on V keeps A in V's set, and the cap still holds.
    recordAttack("A", "V");
    await updateAll(ids);
    expect(playerCache.get("V").aoi.playersInAOI.has("A")).toBe(true);
    expect(playerCache.get("V").aoi.playersInAOI.size).toBe(CAP);

    // The memory has run out: A is a plain far player again.
    resetAttacks();
    recordAttack("A", "V", performance.now() - ATTACK_MEMORY_MS - 1);
    await updateAll(ids);
    expect(playerCache.get("V").aoi.playersInAOI.has("A")).toBe(false);
    expectReverseIndexConsistent(ids);
  } finally {
    resetAttacks();
  }
});

test("players on another layer are never visible", async () => {
  const map = `vistest${++mapSeq}`;
  const ids: string[] = [];
  // 60 players in one block: 50 fill layer_1, the other 10 go to layer_2.
  for (let i = 0; i < 60; i++) {
    const id = `l${i}`;
    ids.push(id);
    await loginPlayer(makePlayer(id, id, map, 500 + (i % 10) * 20, 500 + Math.floor(i / 10) * 20));
  }
  await updateAll(ids);

  const layers = new Set(ids.map((id) => playerCache.get(id).aoi.layerId));
  expect(layers.size).toBe(2);
  for (const id of ids) {
    const p = playerCache.get(id);
    for (const seen of p.aoi.playersInAOI) {
      expect(playerCache.get(seen).aoi.layerId).toBe(p.aoi.layerId);
    }
  }
  expectReverseIndexConsistent(ids);
});

test("a player whose map is stored as name.json stays findable in the grid", async () => {
  const name = `vistest${++mapSeq}`;
  const a = await loginPlayer(makePlayer("A", "Alice", `${name}.json`, 500, 500));
  await loginPlayer(makePlayer("B", "Bob", `${name}.json`, 600, 500));

  // Move A two grid cells over (still in range of B) and run its AOI update.
  a.location.position.x = 1300;
  await updateAll(["A", "B"]);

  expect(spatialGrid.getPlayersInRadius(1300, 500, 50, name)).toContain("A");
  expect(playerCache.get("B").aoi.playersInAOI.has("A")).toBe(true);
  expect(playerCache.get("A").aoi.playersInAOI.has("B")).toBe(true);
});

test("an overflow-layer player rejoins a lower layer after walking out of the crowded block", async () => {
  const map = `vistest${++mapSeq}`;
  const ids: string[] = [];
  for (let i = 0; i < 50; i++) {
    const id = `c${i}`;
    ids.push(id);
    await loginPlayer(makePlayer(id, id, map, 500 + (i % 10) * 20, 500 + Math.floor(i / 10) * 20));
  }
  const overflow = await loginPlayer(makePlayer("O", "Over", map, 700, 700));
  const neighbour = await loginPlayer(makePlayer("Q", "Neighbour", map, 720, 700));
  ids.push("O", "Q");
  expect(overflow.aoi.layerId).toBe(`${map}:layer_2`);
  expect(neighbour.aoi.layerId).toBe(`${map}:layer_2`);
  expect(neighbour.aoi.playersInAOI.has("O")).toBe(true);

  // A layer_1 player waiting in the next block.
  const waiting = await loginPlayer(makePlayer("W", "Waiting", map, BLOCK + 600, 700));
  ids.push("W");
  expect(waiting.aoi.layerId).toBe(`${map}:layer_1`);

  overflow.location.position.x = BLOCK + 500;
  await updateAll(["O"]);

  const o = playerCache.get("O");
  expect(o.aoi.layerId).toBe(`${map}:layer_1`);
  expect(layerManager.getPlayerLayer("O")).toBe(`${map}:layer_1`);
  expect(o.aoi.playersInAOI.has("W")).toBe(true);
  expect(playerCache.get("W").aoi.playersInAOI.has("O")).toBe(true);
  // The old layer's viewer no longer has the mover.
  expect(playerCache.get("Q").aoi.playersInAOI.has("O")).toBe(false);
  expectReverseIndexConsistent(ids);
});

test("a block change does not pull a player away from party members on their layer", async () => {
  const map = `vistest${++mapSeq}`;
  for (let i = 0; i < 50; i++) {
    await loginPlayer(makePlayer(`c${i}`, `c${i}`, map, 500 + (i % 10) * 20, 500 + Math.floor(i / 10) * 20));
  }
  const overflow = await loginPlayer(makePlayer("O", "Over", map, 700, 700));
  await loginPlayer(makePlayer("R", "Friend", map, 720, 700));
  overflow.party = ["Friend"];
  expect(overflow.aoi.layerId).toBe(`${map}:layer_2`);

  overflow.location.position.x = BLOCK + 500;
  await updateAll(["O"]);

  expect(playerCache.get("O").aoi.layerId).toBe(`${map}:layer_2`);
  expect(layerManager.getPlayerLayer("O")).toBe(`${map}:layer_2`);
});

test("condensation merges per block: a crowded layer_1 elsewhere does not block the merge", async () => {
  const map = `vistest${++mapSeq}`;
  const L1 = `${map}:layer_1`;
  const L2 = `${map}:layer_2`;
  const ids: string[] = [];

  // Block (0,0): 50 on layer_1 (full) plus one overflow on layer_2.
  for (let i = 0; i < 50; i++) {
    const id = `a${i}`;
    ids.push(id);
    await loginPlayer(makePlayer(id, id, map, 500 + (i % 10) * 20, 500 + Math.floor(i / 10) * 20));
  }
  await loginPlayer(makePlayer("stuck", "stuck", map, 700, 700));
  ids.push("stuck");
  expect(playerCache.get("stuck").aoi.layerId).toBe(L2);

  // Block (1,0): fill layer_1, overflow 5 onto layer_2, then let 45 of the
  // layer_1 players there log off. Layer_1 still has 55 players in all, but
  // only 5 in block (1,0).
  const leaving: string[] = [];
  for (let i = 0; i < 50; i++) {
    const id = `b${i}`;
    await loginPlayer(makePlayer(id, id, map, BLOCK + 500 + (i % 10) * 20, 500 + Math.floor(i / 10) * 20));
    if (i < 45) leaving.push(id);
    else ids.push(id);
  }
  for (let i = 0; i < 5; i++) {
    const id = `o${i}`;
    ids.push(id);
    await loginPlayer(makePlayer(id, id, map, BLOCK + 700 + i * 10, 800));
    expect(playerCache.get(id).aoi.layerId).toBe(L2);
  }
  for (const id of leaving) {
    despawnPlayerFromAllAOI(playerCache.get(id), "disconnect");
    mapIndex.removePlayer(id);
    playerCache.remove(id);
  }
  expect(layerManager.getLayerInfo(L1)!.playerCount).toBe(55);

  await condenseLayers(async () => {});

  for (let i = 0; i < 5; i++) {
    expect(playerCache.get(`o${i}`).aoi.layerId).toBe(L1);
    expect(layerManager.getPlayerLayer(`o${i}`)).toBe(L1);
  }
  // Block (0,0) of layer_1 is still full, so this one stays.
  expect(playerCache.get("stuck").aoi.layerId).toBe(L2);
  expect(layerManager.getPlayerLayer("stuck")).toBe(L2);
  expect(layerManager.countInBlock(L1, "0,0")).toBe(50);
  expect(layerManager.countInBlock(L1, "1,0")).toBe(10);
  expectReverseIndexConsistent(ids);
});

test("a same-map jump out of range despawns the jumper for old neighbours at once", async () => {
  const map = `vistest${++mapSeq}`;
  const a = await loginPlayer(makePlayer("A", "Alice", map, 500, 500));
  const neighbour = makePlayer("B", "Bob", map, 510, 500);
  neighbour.wt = recordingWt();
  await loginPlayer(neighbour);
  await loginPlayer(makePlayer("C", "Carol", map, 1660, 500));
  expect(playerCache.get("B").aoi.playersInAOI.has("A")).toBe(true);

  // 1150px from B: out of range, but inside B's own exit band. The jump only
  // reaches the jumper, so B must not keep a frozen A.
  neighbour.wt.sent.length = 0;
  await handleMapChangeAOI(a, map, { x: 1660, y: 540 });

  expect(playerCache.get("B").aoi.playersInAOI.has("A")).toBe(false);
  expect(aoiReverse.getViewers("A").has("B")).toBe(false);
  expect(neighbour.wt.sent.some((p: any) => p.type === "DESPAWN_PLAYER" && p.data.id === "A")).toBe(true);
  expect(playerCache.get("A").aoi.playersInAOI.has("C")).toBe(true);
  expectReverseIndexConsistent(["A", "B", "C"]);
});

test("an idle viewer at the cap gets a nearer newcomer swapped in for the farthest", async () => {
  const map = `vistest${++mapSeq}`;
  const ids = ["V"];
  await loginPlayer(makePlayer("V", "Viewer", map, 500, 500));
  // Ten neighbours 100..550px away fill V's set; the farthest is a party
  // member, so the second farthest is the one to go.
  for (let i = 0; i < CAP; i++) {
    const id = `r${i}`;
    ids.push(id);
    await loginPlayer(makePlayer(id, id, map, 500 + 100 + i * 50, 500));
  }
  const viewer = playerCache.get("V");
  viewer.party = [`r${CAP - 1}`];
  await updateAll(ids);
  expect(viewer.aoi.playersInAOI.size).toBe(CAP);

  // V stays put; a newcomer logs in 50px away.
  const spawn = new Map<string, Map<string, any>>();
  const despawn = new Map<string, Set<string>>();
  await loginPlayer(makePlayer("N", "Newcomer", map, 500, 550), spawn, despawn);
  ids.push("N");

  const v = playerCache.get("V");
  expect(v.aoi.playersInAOI.size).toBe(CAP);
  expect(v.aoi.playersInAOI.has("N")).toBe(true);
  expect(v.aoi.playersInAOI.has(`r${CAP - 1}`)).toBe(true);
  expect(v.aoi.playersInAOI.has(`r${CAP - 2}`)).toBe(false);
  expect(despawn.get("V")?.has(`r${CAP - 2}`)).toBe(true);
  expect(spawn.get("V")?.has("N")).toBe(true);
  expectReverseIndexConsistent(ids);
});

test("players the viewer is not shown do not take places under the cap", async () => {
  const map = `vistest${++mapSeq}`;
  const ids = ["V"];
  await loginPlayer(makePlayer("V", "Viewer", map, 500, 500));
  // Three stealthed players right next to V, ten visible ones farther out.
  for (let i = 0; i < 3; i++) {
    const p = makePlayer(`s${i}`, `s${i}`, map, 510 + i * 5, 500);
    p.isStealth = true;
    ids.push(p.id);
    await loginPlayer(p);
  }
  for (let i = 0; i < CAP; i++) {
    ids.push(`v${i}`);
    await loginPlayer(makePlayer(`v${i}`, `v${i}`, map, 500, 700 + i * 20));
  }
  await updateAll(["V"]);

  const v = playerCache.get("V");
  for (let i = 0; i < CAP; i++) expect(v.aoi.playersInAOI.has(`v${i}`)).toBe(true);
  for (let i = 0; i < 3; i++) expect(v.aoi.playersInAOI.has(`s${i}`)).toBe(false);
  expectReverseIndexConsistent(ids);
});

test("no second spawn is queued to a player who already sees the viewer", async () => {
  const map = `vistest${++mapSeq}`;
  const a = await loginPlayer(makePlayer("A", "Alice", map, 500, 500));
  await loginPlayer(makePlayer("B", "Bob", map, 510, 500));
  // A forgets B (as after a cap eviction); B still sees A.
  a.aoi.playersInAOI.delete("B");
  aoiReverse.removeViewer("B", "A");

  const spawn = new Map<string, Map<string, any>>();
  await updatePlayerAOI(a, spawn, new Map());

  expect(spawn.get("A")?.has("B")).toBe(true);
  expect(spawn.get("B")?.has("A") ?? false).toBe(false);
  expectReverseIndexConsistent(["A", "B"]);
});

test("broadcasts reach who sees the source, not who the source sees", async () => {
  const map = `vistest${++mapSeq}`;
  // Far apart so no visibility forms on its own; the asymmetric pair is set
  // up by hand: S sees X (X does not see S), Y sees S (S does not see Y).
  const s = await loginPlayer(makePlayer("S", "Source", map, 500, 500));
  const x = makePlayer("X", "Seen", map, 5000, 500);
  const y = makePlayer("Y", "Watcher", map, 500, 5000);
  x.wt = recordingWt();
  y.wt = recordingWt();
  await loginPlayer(x);
  await loginPlayer(y);

  s.aoi.playersInAOI.add("X");
  aoiReverse.addViewer("X", "S");
  y.aoi.playersInAOI.add("S");
  aoiReverse.addViewer("S", "Y");

  const packet = new TextEncoder().encode(JSON.stringify({ type: "TEST_EVENT", data: null }));
  broadcastToAOI(s, [packet], false);
  broadcastToAOIBestEffort(s, [packet], false);
  broadcastStatsUpdateToAOI(s, null, [packet]);

  expect(y.wt.sent.filter((p: any) => p.type === "TEST_EVENT").length).toBe(3);
  expect(x.wt.sent.filter((p: any) => p.type === "TEST_EVENT").length).toBe(0);
});

test("an idle viewer the mover does not see back drops the mover once out of range", async () => {
  const map = `vistest${++mapSeq}`;
  const viewer = makePlayer("V", "Viewer", map, 500, 500);
  viewer.wt = recordingWt();
  await loginPlayer(viewer);
  await loginPlayer(makePlayer("P", "Mover", map, 600, 500));
  // P's ten nearest are a cluster just past P, so V (100px) is left out of
  // P's set; V sees P (100px) and the nine nearest of the cluster.
  const ids = ["V", "P"];
  for (let i = 0; i < CAP; i++) {
    const id = `k${i}`;
    ids.push(id);
    await loginPlayer(makePlayer(id, id, map, 605 + i * 5, 500));
  }
  await updateAll(ids);
  await updateAll(ids);
  expect(playerCache.get("V").aoi.playersInAOI.has("P")).toBe(true);
  expect(playerCache.get("P").aoi.playersInAOI.has("V")).toBe(false);

  // A short step keeps P inside V's exit radius: V keeps P.
  const p = playerCache.get("P");
  p.location.position.x = 700;
  await updateAll(["P"]);
  expect(playerCache.get("V").aoi.playersInAOI.has("P")).toBe(true);

  // Past V's exit radius: V (idle, no update of its own) gets the despawn.
  viewer.wt.sent.length = 0;
  p.location.position.x = 1800;
  await updateAll(["P"]);
  expect(playerCache.get("V").aoi.playersInAOI.has("P")).toBe(false);
  expect(aoiReverse.getViewers("P").has("V")).toBe(false);
  expect(viewer.wt.sent.some((packet: any) => packet.type === "DESPAWN_PLAYER" && packet.data.id === "P")).toBe(true);
  expectReverseIndexConsistent(ids);
});

test("two players trading the last place by 1px do not swap on every update", async () => {
  const map = `vistest${++mapSeq}`;
  const ids = ["V"];
  const viewer = makePlayer("V", "Viewer", map, 500, 500);
  viewer.wt = recordingWt();
  await loginPlayer(viewer);
  // Nine fixed neighbours take the first nine places.
  for (let i = 0; i < CAP - 1; i++) {
    const id = `f${i}`;
    ids.push(id);
    await loginPlayer(makePlayer(id, id, map, 500 + 50 + i * 20, 500));
  }
  // A and B contend for the tenth place, about 500px away.
  await loginPlayer(makePlayer("A", "A", map, 500, 1000));
  await loginPlayer(makePlayer("B", "B", map, 500, 1)); // 499px: B is nearer at first
  ids.push("A", "B");
  await updateAll(ids);
  const v = playerCache.get("V");
  expect(v.aoi.playersInAOI.size).toBe(CAP);
  const holder = v.aoi.playersInAOI.has("A") ? "A" : "B";
  const other = holder === "A" ? "B" : "A";
  expect(v.aoi.playersInAOI.has(other)).toBe(false);

  viewer.wt.sent.length = 0;
  for (let step = 0; step < 6; step++) {
    // Alternate which of the two is 1px nearer.
    const holderNearer = step % 2 === 1;
    playerCache.get(holder).location.position.y = holder === "A" ? (holderNearer ? 1000 : 1002) : (holderNearer ? 0 : -2);
    playerCache.get(other).location.position.y = other === "A" ? (holderNearer ? 1002 : 1000) : (holderNearer ? -2 : 0);
    await updateAll(["A", "B", "V"]);
    expect(v.aoi.playersInAOI.has(holder)).toBe(true);
    expect(v.aoi.playersInAOI.has(other)).toBe(false);
  }
  expect(viewer.wt.sent.some((packet: any) => packet.type === "DESPAWN_PLAYER")).toBe(false);
  expectReverseIndexConsistent(ids);
});

test("an idle viewer at the cap keeps its farthest member over a newcomer only slightly nearer", async () => {
  const map = `vistest${++mapSeq}`;
  const ids = ["V"];
  await loginPlayer(makePlayer("V", "Viewer", map, 500, 500));
  for (let i = 0; i < CAP; i++) {
    const id = `r${i}`;
    ids.push(id);
    await loginPlayer(makePlayer(id, id, map, 500 + 100 + i * 50, 500)); // farthest at 550px
  }
  await updateAll(ids);
  const v = playerCache.get("V");
  expect(v.aoi.playersInAOI.size).toBe(CAP);

  // 540px away: nearer than the farthest member, but not by the margin.
  const despawn = new Map<string, Set<string>>();
  await loginPlayer(makePlayer("N", "Newcomer", map, 500, 1040), new Map(), despawn);
  ids.push("N");
  expect(v.aoi.playersInAOI.has("N")).toBe(false);
  expect(v.aoi.playersInAOI.has(`r${CAP - 1}`)).toBe(true);
  expect(despawn.get("V")?.has(`r${CAP - 1}`) ?? false).toBe(false);
  expectReverseIndexConsistent(ids);
});

test("condensation moves overflow players down per player and never moves anyone up", async () => {
  const map = `vistest${++mapSeq}`;
  const L1 = `${map}:layer_1`;
  const L2 = `${map}:layer_2`;
  const base: string[] = [];
  const overflow: string[] = [];
  for (let i = 0; i < 50; i++) {
    const id = `b${i}`;
    base.push(id);
    await loginPlayer(makePlayer(id, id, map, 500 + (i % 10) * 20, 500 + Math.floor(i / 10) * 20));
  }
  // 30 on layer_2 (the old whole-layer rule left a layer of 25+ alone).
  for (let i = 0; i < 30; i++) {
    const id = `o${i}`;
    overflow.push(id);
    await loginPlayer(makePlayer(id, id, map, 520 + (i % 10) * 20, 520 + Math.floor(i / 10) * 20));
    expect(playerCache.get(id).aoi.layerId).toBe(L2);
  }
  // 40 of layer_1 log off: layer_1 (10) is now smaller than layer_2 (30).
  for (const id of base.splice(0, 40)) {
    despawnPlayerFromAllAOI(playerCache.get(id), "disconnect");
    mapIndex.removePlayer(id);
    playerCache.remove(id);
  }

  await condenseLayers(async () => {});

  for (const id of base) expect(layerManager.getPlayerLayer(id)).toBe(L1);
  for (const id of overflow) {
    expect(layerManager.getPlayerLayer(id)).toBe(L1);
    expect(playerCache.get(id).aoi.layerId).toBe(L1);
  }
  expect(layerManager.getLayerInfo(L2)).toBeNull();
  expect(layerManager.countInBlock(L1, "0,0")).toBe(40);
  expectReverseIndexConsistent([...base, ...overflow]);
});
