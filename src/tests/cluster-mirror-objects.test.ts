import { expect, mock, spyOn, test } from "bun:test";
import { databaseModule, mockQuery } from "./setup";

// Mirrors of another node's loot, chests, skeletons, tornadoes, ground AOEs and gathering nodes: shown to the players
// here through the read paths, never reached by a writer. Real grid / layer / player modules; only the database is
// stubbed.
mock.module("../controllers/sqldatabase", () => databaseModule({ default: mockQuery }));

// Generated at server start (`bun create-config`) and gitignored, so CI has
// no copy on disk. Mock the values instead of requiring the file.
mock.module("../config/settings.json", () => ({
  default: { creatures: {} },
  creatures: {},
}));

const { default: loot } = await import("../systems/loot");
const { default: lootChest } = await import("../systems/lootChest");
const { default: skeletons } = await import("../systems/skeletons");
const tornadoes = await import("../systems/tornadoes");
const groundAoe = await import("../systems/groundaoe");
const gathering = await import("../systems/gathering");
const playerCache = (await import("../services/playermanager")).default;
const { default: layerManager } = await import("../services/layermanager");
const mapIndex = (await import("../services/mapindex")).default;
const spatialGrid = (await import("../services/spatialgrid")).default;

function decode(packet: Uint8Array): any {
  return JSON.parse(new TextDecoder().decode(packet));
}

function recordingWt(): any {
  const wt: any = { readyState: 1, reliable: [] as any[], datagrams: [] as any[] };
  wt.send = (packet: Uint8Array) => wt.reliable.push(decode(packet));
  wt.sendBestEffort = (packet: Uint8Array) => wt.datagrams.push(decode(packet));
  return wt;
}

// As groundaoe.test.ts adds one: in the player cache, the map index, the grid and a layer.
function addPlayer(id: string, mapName: string, x: number, y: number): any {
  const p: any = {
    id,
    username: `user${id}`,
    location: { map: `${mapName}.json`, position: { x, y, direction: "down" } },
    wt: recordingWt(),
    party: [],
    stats: { health: 50, total_max_health: 100 },
    aoi: { playersInAOI: new Set<string>(), aoiRadius: 1000, layerId: null },
  };
  playerCache.add(id, p);
  p.aoi.layerId = layerManager.assignPlayerToLayer(id, mapName, x, y);
  playerCache.set(id, p);
  mapIndex.addPlayer(id, mapName);
  spatialGrid.addPlayer(id, x, y, mapName);
  return playerCache.get(id);
}

function removePlayer(p: any): void {
  spatialGrid.removePlayer(p.id);
  mapIndex.removePlayer(p.id);
  layerManager.removePlayerFromLayer(p.id);
  playerCache.remove(p.id);
}

test("remote loot shows on the map but cannot be picked up", () => {
  loot.addRemote({ id: "loot_9001", item: "Apple", quantity: 1, quality: "common", iconUrl: "", map: "main", x: 10, y: 10, ownerId: "", ownerName: "", expiresAt: Date.now() + 60_000 });
  expect(loot.getOnMap("main").some((l) => l.id === "loot_9001")).toBe(true);
  const result = loot.pickup({ id: "p", username: "p", location: { map: "main", position: { x: 10, y: 10 } } }, "loot_9001");
  expect(result.success).toBe(false);
  expect(loot.pickupAllNearby({ id: "p", username: "p", location: { map: "main", position: { x: 10, y: 10 } } })).toEqual([]);
  expect([...loot.all()].some((l) => l.id === "loot_9001")).toBe(false);
  expect(loot.removeRemote("loot_9001")?.id).toBe("loot_9001");
  expect(loot.getOnMap("main").some((l) => l.id === "loot_9001")).toBe(false);
});

test("remote chests show on the map and are not openable here", async () => {
  lootChest.addRemote({ id: "chest_9002", x: 5, y: 5, iconUrl: "", map: "main" });
  expect(lootChest.getOnMap("main").some((c: any) => c.id === "chest_9002")).toBe(true);
  expect(lootChest.getChest("chest_9002")).toBeUndefined();
  expect(await lootChest.open("chest_9002", "p")).toBeNull();
  expect([...lootChest.all()].some((c: any) => c.id === "chest_9002")).toBe(false);
  lootChest.removeRemote("chest_9002");
  expect(lootChest.getOnMap("main").some((c: any) => c.id === "chest_9002")).toBe(false);
});

test("remote skeletons are found in radius, on their layer", () => {
  skeletons.addRemote({ id: "skeleton_9003", username: "x", map: "main", layerId: "main:layer_1", x: 50, y: 50, createdAt: 0, expiresAt: Date.now() + 60_000 });
  expect(skeletons.getInRadius("main", 60, 60, 100).some((s) => s.id === "skeleton_9003")).toBe(true);
  expect(skeletons.getInRadius("main", 60, 60, 100, "main:layer_2").some((s) => s.id === "skeleton_9003")).toBe(false);
  expect(skeletons.getInRadius("main", 600, 600, 100).some((s) => s.id === "skeleton_9003")).toBe(false);
  expect([...skeletons.all()].some((s) => s.id === "skeleton_9003")).toBe(false);
  skeletons.removeRemote("skeleton_9003");
  expect(skeletons.getInRadius("main", 60, 60, 100).some((s) => s.id === "skeleton_9003")).toBe(false);
});

test("remote tornadoes are shown with the local ones, and never pull", async () => {
  tornadoes.resetTornadoes();
  const shows: any[] = [];
  const moved: any[] = [];
  const hurt: any[] = [];
  tornadoes.setTornadoBridge({
    weathers: async () => [{ map: "main", weather: "none" as const }],
    players: () => [{ id: "p", location: { map: "main", position: { x: 100, y: 100 } }, stats: { total_max_health: 100 } }],
    size: () => ({ width: 2000, height: 2000 }),
    walkable: () => true,
    move: (who: any, x: number, y: number) => { moved.push({ id: who.id, x, y }); },
    hurt: (who: any, amount: number) => { hurt.push({ id: who.id, amount }); },
    show: (map, list) => shows.push({ map, ids: list.map((t) => t.id) }),
  });
  expect(tornadoes.setRemoteTornado({ id: "t9004", map: "main", x: 100, y: 100 })).toBe(true);
  await tornadoes.tick(10_000);
  await tornadoes.pull(10_050);
  expect(shows.at(-1)).toEqual({ map: "main", ids: ["t9004"] });
  expect(tornadoes.tornadoesOn("main")).toEqual([]);
  expect(moved).toEqual([]);
  expect(hurt).toEqual([]);
  tornadoes.removeRemoteTornado("t9004");
  await tornadoes.tick(20_000);
  expect(shows.at(-1)).toEqual({ map: "main", ids: [] });
  tornadoes.setTornadoBridge(null);
  tornadoes.resetTornadoes();
});

test("a remote ground AOE is shown to the players near it and never ticks", async () => {
  const map = "mirror_zone_1";
  const viewer = addPlayer("zv1", map, 1000, 1000);
  const zone = {
    id: "groundaoe_9005", spellId: 1, spellName: "Fire Pit", casterId: "elsewhere", casterUsername: "far", mapName: map,
    layerId: viewer.aoi.layerId, x: 1000, y: 1000, radius: 200, duration: 30_000, damageType: "damage", particles: null,
    createdAt: Date.now(), expiresAt: Date.now() + 30_000,
  };
  expect(groundAoe.addRemoteZone(zone)).toBe(true);
  expect(viewer.wt.reliable.some((p: any) => p.type === "GROUND_AOE_SPAWN" && p.data.id === "groundaoe_9005")).toBe(true);
  await groundAoe.processZoneTicks();
  expect(viewer.stats.health).toBe(50);
  expect(groundAoe.getAllZones().some((z) => z.id === "groundaoe_9005")).toBe(false);
  groundAoe.removeRemoteZone("groundaoe_9005");
  expect(viewer.wt.reliable.some((p: any) => p.type === "GROUND_AOE_DESPAWN" && p.data.id === "groundaoe_9005")).toBe(true);
  removePlayer(viewer);
});

test("a remote gathering node is sent to viewers here and cannot be taken", () => {
  const node = { id: 9006, areaId: 1, map: "main", layerId: "L1", x: 100, y: 0, item: "Copper Ore", tile: "9006" };
  expect(gathering.addRemoteGatherNode(node)).toBe(true);
  const wt = recordingWt();
  gathering.sync.refreshPlayer({ id: "gv1", wt, map: "main", layerId: "L1", x: 0, y: 0, radius: 500 });
  expect(wt.reliable.some((p: any) => p.type === "GATHER_NODE_SPAWN" && p.data.nodes.some((n: any) => n.id === 9006))).toBe(true);
  expect(gathering.spawner.take(9006, Date.now())).toBeNull();
  expect([...gathering.spawner.all()].some((n) => n.id === 9006)).toBe(false);
  gathering.removeRemoteGatherNode(9006);
  gathering.sync.forget("gv1");
});

// ------------------------------------------------------------------ the ghost kinds

const { ghosts } = await import("../cluster/ghosts");
const { registerObjectGhosts } = await import("../cluster/kinds/objects");
registerObjectGhosts();
const kind = (name: string): any => (ghosts as any).kinds.get(name);

test("remote loot and chests reach every player on the map, as local ones do", () => {
  const map = "mirror_loot_1";
  // Far outside any sight radius of the drop.
  const viewer = addPlayer("lv1", map, 9000, 9000);
  const types = () => viewer.wt.reliable.map((p: any) => `${p.type}:${p.data?.id ?? p.data}`);
  const drop = { id: "loot_9101", item: "Apple", quantity: 1, quality: "common", iconUrl: "", map, x: 10, y: 10, ownerId: "", ownerName: "", expiresAt: Date.now() + 60_000 };
  expect(kind("loot").spawn(drop, "b")).toBe(true);
  expect(viewer.wt.reliable.some((p: any) => p.type === "LOOT_SPAWN" && p.data.id === "loot_9101")).toBe(true);
  kind("loot").despawn("loot_9101", "gone");
  expect(viewer.wt.reliable.some((p: any) => p.type === "LOOT_DESPAWN")).toBe(true);
  expect(kind("chest").spawn({ id: "chest_9102", x: 10, y: 10, iconUrl: "", map }, "b")).toBe(true);
  expect(viewer.wt.reliable.some((p: any) => p.type === "LOOT_CHEST_SPAWN" && p.data.id === "chest_9102")).toBe(true);
  kind("chest").despawn("chest_9102", "gone");
  expect(viewer.wt.reliable.some((p: any) => p.type === "LOOT_CHEST_DESPAWN")).toBe(true);
  expect(types().length).toBe(4);
  removePlayer(viewer);
});

test("each kind refuses a spawn whose id is one of this node's own", async () => {
  const owner = { id: "own1", username: "own1", location: { map: "main", position: { x: 20, y: 20 } } };
  const own = loot.create(owner, "Apple", 1, "", "common", null);
  expect(kind("loot").spawn({ ...own, x: 999 }, "b")).toBe(false);
  expect(loot.get(own.id)!.x).toBe(20);
  loot.despawn(own.id);

  const chestId = lootChest.spawn("main", 30, 30);
  expect(kind("chest").spawn({ id: chestId, x: 999, y: 999, iconUrl: "", map: "main" }, "b")).toBe(false);
  expect(lootChest.getChest(chestId)!.x).toBe(30);
  lootChest.despawn(chestId);

  const bones = skeletons.spawn("main", 40, 40, "own1")!;
  expect(bones).not.toBeNull();
  expect(kind("skeleton").spawn({ ...bones, x: 999 }, "b")).toBe(false);
  expect(skeletons.get(bones.id)!.x).toBe(40);
  skeletons.despawn(bones.id);

  const zone = groundAoe.spawnZone({
    spellId: 1, spellName: "Fire Pit", casterId: "own1", casterUsername: "own1", mapName: "main", position: { x: 50, y: 50 },
    radius: 10, duration: 30, tickInterval: 1, damagePerTick: 0, damageType: "damage", particles: null, effects: null, spell: null,
  });
  expect(kind("groundaoe").spawn({ id: zone.id, mapName: "main", x: 999, y: 999, radius: 10, createdAt: 0, expiresAt: Date.now() + 1000 }, "b")).toBe(false);
  expect(groundAoe.findZoneById(zone.id)!.position.x).toBe(50);
  // The snapshot reads the zone by its id.
  expect(kind("groundaoe").snapshot(zone.id).x).toBe(50);
  groundAoe.removeZone(zone.id);

  tornadoes.resetTornadoes();
  tornadoes.setTornadoBridge({
    weathers: async () => [],
    players: () => [],
    size: () => ({ width: 2000, height: 2000 }),
    walkable: () => true,
    move: () => {},
    hurt: () => {},
    show: () => {},
  });
  const twister = tornadoes.spawn("main", [{ id: "p", location: { map: "main", position: { x: 1, y: 1 } }, stats: {} }], "tornado", Date.now())!;
  expect(twister).not.toBeNull();
  const x = twister.x;
  expect(kind("tornado").spawn({ id: twister.id, map: "main", x: 5, y: 5 }, "b")).toBe(false);
  // A move or a despawn sent for it does not reach it either.
  kind("tornado").move(twister.id, 7, 7, 1, 0);
  kind("tornado").despawn(twister.id, "gone");
  expect(tornadoes.tornadoesOn("main")[0].x).toBe(x);
  tornadoes.setTornadoBridge(null);
  tornadoes.resetTornadoes();

  const node = { id: 9107, areaId: 1, map: "main", layerId: "L1", x: 1, y: 1, item: "Copper Ore", tile: "9107" };
  const get = spyOn(gathering.spawner, "get").mockImplementation((id: number) => (id === 9107 ? (node as any) : undefined));
  expect(kind("gather").spawn({ ...node, x: 999 }, "b")).toBe(false);
  get.mockRestore();
});

test("each kind refuses a record with a position that is not a number, and keeps only the known fields of loot", async () => {
  const map = "mirror_bad_1";
  const drop = { id: "loot_9301", item: "Apple", quantity: 1, quality: "common", iconUrl: "", map, x: 10, y: 10, ownerId: "", ownerName: "", expiresAt: Date.now() + 60_000 };
  for (const bad of [Number.NaN, null, "12", Infinity]) {
    expect(kind("loot").spawn({ ...drop, x: bad }, "b")).toBe(false);
    expect(kind("loot").spawn({ ...drop, quantity: bad }, "b")).toBe(false);
    expect(kind("chest").spawn({ id: "chest_9302", x: bad, y: 1, iconUrl: "", map }, "b")).toBe(false);
    expect(kind("skeleton").spawn({ id: "skeleton_9303", username: "x", map, x: 1, y: bad, createdAt: 0, expiresAt: 1 }, "b")).toBe(false);
    expect(kind("groundaoe").spawn({ id: "zone_9304", mapName: map, x: bad, y: 1, radius: 10 }, "b")).toBe(false);
    expect(kind("tornado").spawn({ id: "tornado_9305", map, x: bad, y: 1 }, "b")).toBe(false);
    expect(kind("gather").spawn({ id: 9306, areaId: 1, map, layerId: "L1", x: bad, y: 1, item: "Copper Ore", tile: "9306" }, "b")).toBe(false);
  }
  expect(loot.getOnMap(map)).toEqual([]);
  expect(lootChest.getOnMap(map)).toEqual([]);
  expect(skeletons.getInRadius(map, 1, 1, 100)).toEqual([]);
  expect(groundAoe.findZoneById("zone_9304")).toBeUndefined();
  const wt = recordingWt();
  gathering.sync.refreshPlayer({ id: "gv2", wt, map, layerId: "L1", x: 0, y: 0, radius: 500 });
  expect(wt.reliable.some((p: any) => p.type === "GATHER_NODE_SPAWN")).toBe(false);
  gathering.sync.forget("gv2");

  expect(kind("loot").spawn({ ...drop, injected: { evil: true } }, "b")).toBe(true);
  expect(Object.keys(loot.getOnMap(map)[0]).sort()).toEqual(Object.keys(drop).sort());
  kind("loot").despawn("loot_9301", "gone");

  // A move to a position that is not a number leaves a mirrored tornado where it is.
  const shows: any[] = [];
  tornadoes.resetTornadoes();
  tornadoes.setTornadoBridge({
    weathers: async () => [{ map: "main", weather: "none" as const }],
    players: () => [],
    size: () => ({ width: 2000, height: 2000 }),
    walkable: () => true,
    move: () => {},
    hurt: () => {},
    show: (_map, list) => shows.push(list.map((t) => ({ id: t.id, x: t.x, y: t.y }))),
  });
  expect(kind("tornado").spawn({ id: "t9307", map: "main", x: 5, y: 5 }, "b")).toBe(true);
  kind("tornado").move("t9307", Number.NaN, 7, 1, 0);
  await tornadoes.tick(10_000);
  expect(shows.at(-1)).toEqual([{ id: "t9307", x: 5, y: 5 }]);
  tornadoes.setTornadoBridge(null);
  tornadoes.resetTornadoes();
});

test("a mirrored tornado moves and resetTornadoes clears it", async () => {
  tornadoes.resetTornadoes();
  const shows: any[] = [];
  tornadoes.setTornadoBridge({
    weathers: async () => [{ map: "main", weather: "none" as const }],
    players: () => [],
    size: () => ({ width: 2000, height: 2000 }),
    walkable: () => true,
    move: () => {},
    hurt: () => {},
    show: (map, list) => shows.push({ map, list: list.map((t) => ({ id: t.id, x: t.x, y: t.y })) }),
  });
  expect(kind("tornado").spawn({ id: "t9108", map: "main", x: 100, y: 100 }, "b")).toBe(true);
  kind("tornado").move("t9108", 150, 160, 1, 0);
  await tornadoes.tick(10_000);
  expect(shows.at(-1)).toEqual({ map: "main", list: [{ id: "t9108", x: 150, y: 160 }] });
  tornadoes.resetTornadoes();
  // A move after the reset brings nothing back.
  kind("tornado").move("t9108", 1, 1, 1, 0);
  await tornadoes.tick(20_000);
  expect(shows.filter((s) => s.list.some((t: any) => t.id === "t9108")).length).toBe(1);
  expect(tornadoes.setRemoteTornado({ id: "t9109", map: "main", x: 5, y: 5 })).toBe(true);
  await tornadoes.tick(30_000);
  expect(shows.at(-1)).toEqual({ map: "main", list: [{ id: "t9109", x: 5, y: 5 }] });
  tornadoes.resetTornadoes();
  tornadoes.setTornadoBridge(null);
});

test("the gathering kind lists its nodes map by map", () => {
  const nodes = [{ id: 9109, map: "ga", layerId: "L1" }, { id: 9110, map: "gb", layerId: "L2" }];
  const all = spyOn(gathering.spawner, "nodeMaps").mockImplementation(() => ["ga", "gb"]);
  const onMap = spyOn(gathering.spawner, "nodesOnMap").mockImplementation(function* (map: string) {
    for (const n of nodes) if (n.map === map) yield { ...n, areaId: 1, x: 0, y: 0, item: "Ore", tile: String(n.id) } as any;
  });
  expect([...kind("gather").candidates()].map((c: any) => `${c.map}:${c.id}`)).toEqual(["ga:9109", "gb:9110"]);
  all.mockRestore();
  onMap.mockRestore();
});
