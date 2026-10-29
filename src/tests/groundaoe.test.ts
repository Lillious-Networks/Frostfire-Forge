import { expect, test, mock, beforeEach, afterEach } from "bun:test";
import { databaseModule } from "./setup";

// A ground AoE zone belongs to its caster's layer: it is announced to the players near it on that layer, ticks hit
// only that layer's players inside its radius, and a late joiner is sent only the zones of their layer in range.
// Real grid / layer / player modules; only the database is stubbed.
mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (_sql: string, _params?: any[]) => [],
}));

const playerCache = (await import("../services/playermanager")).default;
const { default: layerManager, blockOf } = await import("../services/layermanager");
const mapIndex = (await import("../services/mapindex")).default;
const spatialGrid = (await import("../services/spatialgrid")).default;
const aoiReverse = await import("../services/aoiReverseIndex");
const groundAoe = await import("../systems/groundaoe");
const { resetEntityIds, useWorldIds } = await import("../cluster/entityids");

function decode(packet: Uint8Array): any {
  return JSON.parse(new TextDecoder().decode(packet));
}

function recordingWt(): any {
  const wt: any = { readyState: 1, reliable: [] as any[], datagrams: [] as any[] };
  wt.send = (packet: Uint8Array) => wt.reliable.push(decode(packet));
  wt.sendBestEffort = (packet: Uint8Array) => wt.datagrams.push(decode(packet));
  return wt;
}

let mapSeq = 0;
let map = "";

beforeEach(() => {
  playerCache.clear();
  mapIndex.clear();
  spatialGrid.clear();
  aoiReverse._reset();
  map = `zone_${++mapSeq}`;
});

afterEach(() => {
  // stops the tick scheduler
  groundAoe.clearZonesForMap(map);
  resetEntityIds();
});

function fillFirstLayer(mapName: string, x: number, y: number): void {
  const block = blockOf(x, y);
  for (let i = 0; layerManager.countInBlock(`${mapName}:layer_1`, block) < 50; i++) {
    layerManager.assignPlayerToLayer(`filler_${mapName}_${i}`, mapName, x, y);
  }
}

function addPlayer(id: string, x: number, y: number, opts: { onMap?: string; secondLayer?: boolean } = {}): any {
  const mapName = opts.onMap ?? map;
  if (opts.secondLayer) fillFirstLayer(mapName, x, y);
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

// A healing zone, so a tick touches only the caster and their party (no PvP rules in the way).
function spawn(caster: any, x = 1000, y = 1000, radius = 200) {
  return groundAoe.spawnZone({
    spellId: 1,
    spellName: "Mend",
    casterId: caster.id,
    casterUsername: caster.username,
    mapName: `${map}.json`,
    position: { x, y },
    radius,
    duration: 30,
    tickInterval: 1,
    damagePerTick: -10,
    damageType: "heal",
    particles: null,
    effects: null,
    spell: null,
  });
}

const types = (p: any) => p.wt.reliable.map((m: any) => m.type);

test("spawn: the zone takes the caster's layer and a plain map name, and only near same-layer players are told", () => {
  const caster = addPlayer("1", 1000, 1000);
  const near = addPlayer("2", 1500, 1000);
  const far = addPlayer("3", 5000, 1000);
  const otherLayer = addPlayer("4", 1000, 1000, { secondLayer: true });
  const otherMap = addPlayer("5", 1000, 1000, { onMap: `${map}_b` });

  const zone = spawn(caster);

  expect(zone.layerId).toBe(caster.aoi.layerId);
  expect(zone.mapName).toBe(map);
  expect(types(caster)).toEqual(["GROUND_AOE_SPAWN"]);
  expect(types(near)).toEqual(["GROUND_AOE_SPAWN"]);
  expect(types(far)).toEqual([]);
  expect(types(otherLayer)).toEqual([]);
  expect(types(otherMap)).toEqual([]);
  // reliable: a lost spawn would leave a zone nobody sees
  expect(near.wt.datagrams.length).toBe(0);
  expect(groundAoe.getZonesOnMap(`${map}.json`)).toEqual([zone]);
});

test("despawn: reaches the same nearby players on the layer, not the rest of the map", () => {
  const caster = addPlayer("1", 1000, 1000);
  const near = addPlayer("2", 1500, 1000);
  const far = addPlayer("3", 5000, 1000);
  const otherLayer = addPlayer("4", 1000, 1000, { secondLayer: true });
  const zone = spawn(caster);

  expect(groundAoe.removeZone(zone.id)).toBe(true);

  expect(types(near)).toEqual(["GROUND_AOE_SPAWN", "GROUND_AOE_DESPAWN"]);
  expect(types(far)).toEqual([]);
  expect(types(otherLayer)).toEqual([]);
});

test("clearing a map despawns its zones to the players near each, on its layer", () => {
  const caster = addPlayer("1", 1000, 1000);
  const near = addPlayer("2", 1500, 1000);
  const otherLayer = addPlayer("4", 1000, 1000, { secondLayer: true });
  spawn(caster);

  groundAoe.clearZonesForMap(`${map}.json`);

  expect(types(near)).toEqual(["GROUND_AOE_SPAWN", "GROUND_AOE_DESPAWN"]);
  expect(types(otherLayer)).toEqual([]);
  expect(groundAoe.getZonesOnMap(map)).toEqual([]);
});

test("a tick hits the caster's party on the layer inside the radius, not a twin on another layer or one out of range", async () => {
  const caster = addPlayer("1", 1000, 1000);
  const inside = addPlayer("2", 1100, 1000);
  const outside = addPlayer("3", 1300, 1000);                        // 300 px from the centre, radius 200
  const twin = addPlayer("4", 1000, 1000, { secondLayer: true });    // standing in the zone, on layer_2
  caster.party = ["user2", "user3", "user4"];
  playerCache.set("1", caster);

  const zone = spawn(caster);
  zone.nextTickAt = 0;
  await groundAoe.processZoneTicks();

  expect(caster.stats.health).toBe(60);
  expect(inside.stats.health).toBe(60);
  expect(outside.stats.health).toBe(50);
  expect(twin.stats.health).toBe(50);
});

test("a caster with no layer makes a zone that touches only players with no layer", async () => {
  const caster = addPlayer("1", 1000, 1000);
  const loose = addPlayer("2", 1100, 1000);
  const layered = addPlayer("3", 1050, 1000);
  layerManager.removePlayerFromLayer("1");
  layerManager.removePlayerFromLayer("2");
  caster.party = ["user2", "user3"];
  playerCache.set("1", caster);

  const zone = spawn(caster);
  expect(zone.layerId).toBeNull();
  zone.nextTickAt = 0;
  await groundAoe.processZoneTicks();

  expect(loose.stats.health).toBe(60);
  expect(layered.stats.health).toBe(50);
  expect(types(layered)).toEqual([]);
  expect(types(loose)).toEqual(["GROUND_AOE_SPAWN"]);
});

test("getZonesInRange: only zones of that layer within range, whatever the map name's spelling", () => {
  const caster = addPlayer("1", 1000, 1000);
  const twinCaster = addPlayer("2", 1000, 1000, { secondLayer: true });
  const here = spawn(caster, 1000, 1000);
  spawn(caster, 6000, 1000);                      // same layer, out of range
  spawn(twinCaster, 1000, 1000);                  // in range, other layer

  const ids = (list: any[]) => list.map((z) => z.id);
  expect(ids(groundAoe.getZonesInRange(`${map}.json`, caster.aoi.layerId, 1400, 1000, 1000))).toEqual([here.id]);
  expect(ids(groundAoe.getZonesInRange(map, caster.aoi.layerId, 1400, 1000, 1000))).toEqual([here.id]);
  expect(ids(groundAoe.getZonesInRange(map, caster.aoi.layerId, 1400, 1000, 100))).toEqual([]);
  expect(groundAoe.getZonesInRange(`${map}_b`, caster.aoi.layerId, 1400, 1000, 1000)).toEqual([]);
  expect(groundAoe.getZonesInRange(map, "nowhere:layer_1", 1400, 1000, 1000)).toEqual([]);
});

// Moves a player the way the game does: position and grid cell.
function walkTo(p: any, x: number, y: number): void {
  p.location.position = { ...p.location.position, x, y };
  playerCache.set(p.id, p);
  spatialGrid.updatePlayer(p.id, x, y, map);
}

test("a player who walks into view after the spawn gets it on the next pass, and one who walks out gets the despawn", async () => {
  const caster = addPlayer("1", 1000, 1000);
  const walker = addPlayer("2", 5000, 1000);                         // out of sight at the spawn
  const zone = spawn(caster);
  expect(types(walker)).toEqual([]);

  walkTo(walker, 1800, 1000);                                        // inside 1000 px of the centre
  await groundAoe.processZoneTicks();
  expect(types(walker)).toEqual(["GROUND_AOE_SPAWN"]);
  expect(walker.wt.reliable[0].data.id).toBe(zone.id);
  expect(walker.wt.reliable[0].data.duration).toBeGreaterThan(0);

  // still in view: not sent twice
  await groundAoe.processZoneTicks();
  expect(types(walker)).toEqual(["GROUND_AOE_SPAWN"]);

  walkTo(walker, 5000, 1000);
  await groundAoe.processZoneTicks();
  expect(types(walker)).toEqual(["GROUND_AOE_SPAWN", "GROUND_AOE_DESPAWN"]);
  expect(types(caster)).toEqual(["GROUND_AOE_SPAWN"]);
});

test("removal reaches exactly the zone's viewers, wherever they have walked, and not a player never shown it", () => {
  const caster = addPlayer("1", 1000, 1000);
  const stayed = addPlayer("2", 1200, 1000);
  const walkedOff = addPlayer("3", 1300, 1000);
  const zone = spawn(caster);

  walkTo(walkedOff, 9000, 1000);                                     // no pass has run: still a viewer
  const notYet = addPlayer("4", 5000, 1000);
  walkTo(notYet, 1400, 1000);                                        // near now, but no pass has shown it to them

  expect([...zone.viewers].sort()).toEqual(["1", "2", "3"]);
  groundAoe.removeZone(zone.id);

  expect(types(stayed)).toEqual(["GROUND_AOE_SPAWN", "GROUND_AOE_DESPAWN"]);
  expect(types(walkedOff)).toEqual(["GROUND_AOE_SPAWN", "GROUND_AOE_DESPAWN"]);
  expect(types(notYet)).toEqual([]);
  expect(zone.viewers.size).toBe(0);
});

test("resync after a layer change despawns the old layer's zones and sends the new layer's, once", async () => {
  const caster = addPlayer("1", 1000, 1000);
  const mover = addPlayer("3", 1100, 1000);                          // layer_1, sees the caster's zone
  const twinCaster = addPlayer("2", 1000, 1000, { secondLayer: true });
  const old = spawn(caster);
  const other = spawn(twinCaster);
  expect(types(mover)).toEqual(["GROUND_AOE_SPAWN"]);

  layerManager.movePlayerToLayer("3", twinCaster.aoi.layerId);
  groundAoe.resyncZonesFor(playerCache.get("3"));

  expect(mover.wt.reliable.map((m: any) => [m.type, m.data.id])).toEqual([
    ["GROUND_AOE_SPAWN", old.id],
    ["GROUND_AOE_DESPAWN", old.id],
    ["GROUND_AOE_SPAWN", other.id],
  ]);
  expect(old.viewers.has("3")).toBe(false);

  // the pass has nothing more to send them
  await groundAoe.processZoneTicks();
  expect(mover.wt.reliable.length).toBe(3);
});

test("a fresh login is sent the zone again even if the zone remembers that id", () => {
  const caster = addPlayer("1", 1000, 1000);
  const back = addPlayer("2", 1200, 1000);
  spawn(caster);
  groundAoe.resyncZonesFor(back, true);
  expect(types(back)).toEqual(["GROUND_AOE_SPAWN", "GROUND_AOE_SPAWN"]);
});

test("a zone is named by a world entity id", () => {
  const caster = addPlayer("1", 1000, 1000);
  useWorldIds({ next: () => 4242 } as any);
  expect(spawn(caster).id).toBe("groundaoe_4242");
});

test("when no id can be had the zone is not made, and nothing of it is left behind", () => {
  const caster = addPlayer("1", 1000, 1000);
  useWorldIds({ next: () => { throw new Error("No world ids left"); } } as any);
  expect(() => spawn(caster)).toThrow(/No world ids left/);
  expect(groundAoe.getZonesOnMap(map)).toEqual([]);
  expect(types(caster)).toEqual([]);
});

test("a send that throws does not stop the pass: the zone still ticks", async () => {
  const caster = addPlayer("1", 1000, 1000);
  const walker = addPlayer("2", 5000, 1000);
  walker.wt.send = () => { throw new Error("stream closed"); };
  const zone = spawn(caster);
  walkTo(walker, 1800, 1000);                                        // into view: the pass sends it the spawn
  zone.nextTickAt = 0;

  await groundAoe.processZoneTicks();

  expect(caster.stats.health).toBe(60);
});
