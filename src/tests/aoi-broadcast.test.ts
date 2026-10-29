import { expect, test, mock, beforeEach } from "bun:test";
import { databaseModule } from "./setup";

// Sends from a point or from a player's viewers reach only the players near
// them, on the same layer. Uses the real grid / layer / reverse-index modules
// (only the database is stubbed); each test builds its own little world.
mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (_sql: string, _params?: any[]) => [],
}));

const playerCache = (await import("../services/playermanager")).default;
const { default: layerManager, blockOf } = await import("../services/layermanager");
const mapIndex = (await import("../services/mapindex")).default;
const spatialGrid = (await import("../services/spatialgrid")).default;
const aoiReverse = await import("../services/aoiReverseIndex");
const {
  broadcastToAOIAtPosition,
  broadcastToAOIBestEffortAtPosition,
  broadcastCastToAOI,
  broadcastGroundPreviewToAOI,
  clearGroundPreviewForAOI,
  cleanupKickedSession,
  getPlayersNearPoint,
} = await import("../socket/aoi");

function decode(packet: Uint8Array): any {
  return JSON.parse(new TextDecoder().decode(packet));
}

// A socket stand-in that records what it was sent and how.
function recordingWt(): any {
  const wt: any = { readyState: 1, reliable: [] as any[], datagrams: [] as any[] };
  wt.send = (packet: Uint8Array) => wt.reliable.push(decode(packet));
  wt.sendBestEffort = (packet: Uint8Array) => wt.datagrams.push(decode(packet));
  return wt;
}

const PACKET = [new TextEncoder().encode(JSON.stringify({ type: "TEST", data: 1 }))] as any[];
let mapSeq = 0;
let map = "";

beforeEach(() => {
  playerCache.clear();
  mapIndex.clear();
  spatialGrid.clear();
  aoiReverse._reset();
  map = `bcast_${++mapSeq}`;
});

// Fills layer_1 of the map's block at (x, y) with players that exist only in the
// layer manager, so the next player to arrive lands on layer_2.
function fillFirstLayer(mapName: string, x: number, y: number): void {
  const block = blockOf(x, y);
  for (let i = 0; layerManager.countInBlock(`${mapName}:layer_1`, block) < 50; i++) {
    layerManager.assignPlayerToLayer(`filler_${mapName}_${i}`, mapName, x, y);
  }
}

// A player on `map` (or `onMap`), filed in the grid and in a layer, as a
// logged-in player is. `secondLayer` puts them on layer_2 of the map instead of
// layer_1.
function addPlayer(id: string, x: number, y: number, opts: { onMap?: string; secondLayer?: boolean } = {}): any {
  const mapName = opts.onMap ?? map;
  if (opts.secondLayer) fillFirstLayer(mapName, x, y);
  const p: any = {
    id,
    username: `user${id}`,
    location: { map: `${mapName}.json`, position: { x, y, direction: "down" } },
    wt: recordingWt(),
    party: [],
    aoi: { playersInAOI: new Set<string>(), aoiRadius: 1000, layerId: null },
  };
  playerCache.add(id, p);
  const layerId = layerManager.assignPlayerToLayer(id, mapName, x, y);
  p.aoi.layerId = layerId;
  playerCache.set(id, p);
  mapIndex.addPlayer(id, mapName);
  spatialGrid.addPlayer(id, x, y, mapName);
  return playerCache.get(id);
}

function makeSeen(viewer: any, seen: any): void {
  viewer.aoi.playersInAOI.add(seen.id);
  aoiReverse.addViewer(seen.id, viewer.id);
}

const got = (p: any) => ({ reliable: p.wt.reliable.length, datagrams: p.wt.datagrams.length });

test("getPlayersNearPoint: radius, layer and map filtering from the grid", () => {
  const a = addPlayer("1", 1000, 1000);
  addPlayer("2", 1300, 1000);                              // 300 px away
  addPlayer("3", 3000, 1000);                              // too far
  const other = addPlayer("4", 1100, 1000, { onMap: `${map}_b` });
  const layerOf = a.aoi.layerId;
  const ids = (list: any[]) => list.map((p) => p.id).sort();

  expect(ids(getPlayersNearPoint(1000, 1000, `${map}.json`, 500, layerOf))).toEqual(["1", "2"]);
  expect(ids(getPlayersNearPoint(1000, 1000, map, 100, layerOf))).toEqual(["1"]);
  // Other layers are separate instances, never candidates.
  expect(ids(getPlayersNearPoint(1000, 1000, map, 500, `${map}:layer_9`))).toEqual([]);
  expect(ids(getPlayersNearPoint(1000, 1000, `${map}_b`, 500, other.aoi.layerId))).toEqual(["4"]);
});

test("getPlayersNearPoint: a player one layer over is skipped even when standing on the point", () => {
  addPlayer("1", 1000, 1000);
  const twin = addPlayer("2", 1000, 1000, { secondLayer: true });
  const ids = getPlayersNearPoint(1000, 1000, map, 500, twin.aoi.layerId).map((p) => p.id);
  expect(ids).toEqual(["2"]);
});

test("getPlayersNearPoint: a player a little off their filed grid cell is still found by live position", () => {
  const p = addPlayer("1", 1000, 1000);
  // Walked 90 px since the grid was last updated: filed in the old cell.
  p.location.position.x = 1090;
  playerCache.set("1", p);
  // Live distance is 410 px.
  expect(getPlayersNearPoint(1500, 1000, map, 420, p.aoi.layerId).map((q) => q.id)).toEqual(["1"]);
  expect(getPlayersNearPoint(1500, 1000, map, 400, p.aoi.layerId).length).toBe(0);
});

test("broadcastToAOIAtPosition: reaches in-radius viewers on the layer, reliable by default", () => {
  const near = addPlayer("1", 1000, 1000);
  const edge = addPlayer("2", 1900, 1000);                // inside 1000 px of the point
  const far = addPlayer("3", 2500, 1000);                 // outside
  const otherLayer = addPlayer("4", 1000, 1000, { secondLayer: true });
  const otherMap = addPlayer("5", 1000, 1000, { onMap: `${map}_b` });

  broadcastToAOIAtPosition(1000, 1000, `${map}.json`, PACKET, near.aoi.layerId);

  expect(got(near)).toEqual({ reliable: 1, datagrams: 0 });
  expect(got(edge)).toEqual({ reliable: 1, datagrams: 0 });
  expect(got(far)).toEqual({ reliable: 0, datagrams: 0 });
  expect(got(otherLayer)).toEqual({ reliable: 0, datagrams: 0 });
  expect(got(otherMap)).toEqual({ reliable: 0, datagrams: 0 });
});

test("broadcastToAOIAtPosition: bestEffort sends datagrams instead", () => {
  const a = addPlayer("1", 1000, 1000);
  const b = addPlayer("2", 1200, 1000);
  broadcastToAOIAtPosition(1000, 1000, map, PACKET, a.aoi.layerId, { bestEffort: true });
  expect(got(a)).toEqual({ reliable: 0, datagrams: 1 });
  expect(got(b)).toEqual({ reliable: 0, datagrams: 1 });
});

test("broadcastToAOIAtPosition: a null layer reaches every layer on the map", () => {
  const a = addPlayer("1", 1000, 1000);
  const b = addPlayer("2", 1000, 1000, { secondLayer: true });
  broadcastToAOIAtPosition(1000, 1000, map, PACKET, null);
  expect(got(a).reliable).toBe(1);
  expect(got(b).reliable).toBe(1);
});

test("broadcastToAOIAtPosition: skips sockets that are not open or cannot do datagrams", () => {
  const a = addPlayer("1", 1000, 1000);
  const b = addPlayer("2", 1100, 1000);
  b.wt.readyState = 3;
  delete a.wt.sendBestEffort;
  broadcastToAOIAtPosition(1000, 1000, map, PACKET, a.aoi.layerId, { bestEffort: true });
  expect(got(a).datagrams).toBe(0);
  expect(got(b).datagrams).toBe(0);
  expect(() => broadcastToAOIAtPosition(1, 1, "", PACKET, null)).not.toThrow();
});

test("broadcastToAOIBestEffortAtPosition: same recipients as before for the layer, datagrams only", () => {
  const a = addPlayer("1", 1000, 1000);
  const b = addPlayer("2", 1500, 1000);
  const far = addPlayer("3", 4000, 1000);
  const otherLayer = addPlayer("4", 1000, 1000, { secondLayer: true });
  broadcastToAOIBestEffortAtPosition(1000, 1000, map, PACKET, a.aoi.layerId);
  expect(got(a)).toEqual({ reliable: 0, datagrams: 1 });
  expect(got(b)).toEqual({ reliable: 0, datagrams: 1 });
  expect(got(far)).toEqual({ reliable: 0, datagrams: 0 });
  expect(got(otherLayer)).toEqual({ reliable: 0, datagrams: 0 });
});

test("broadcastCastToAOI: caster reliable, viewers datagrams, nobody else", () => {
  const caster = addPlayer("1", 1000, 1000);
  const viewer = addPlayer("2", 1200, 1000);
  const blind = addPlayer("3", 1300, 1000);               // near, but does not see the caster
  const farViewer = addPlayer("4", 9000, 9000);           // sees the caster (cap-asymmetric case)
  makeSeen(viewer, caster);
  makeSeen(farViewer, caster);
  // The caster sees blind, but blind does not see the caster: not a recipient.
  makeSeen(caster, blind);

  broadcastCastToAOI(caster, PACKET);

  expect(got(caster)).toEqual({ reliable: 1, datagrams: 0 });
  expect(got(viewer)).toEqual({ reliable: 0, datagrams: 1 });
  expect(got(farViewer)).toEqual({ reliable: 0, datagrams: 1 });
  expect(got(blind)).toEqual({ reliable: 0, datagrams: 0 });
});

test("broadcastCastToAOI: the caster gets exactly one reliable copy and a closed viewer socket is skipped", () => {
  const caster = addPlayer("1", 1000, 1000);
  const viewer = addPlayer("2", 1200, 1000);
  makeSeen(viewer, caster);
  makeSeen(caster, viewer);
  viewer.wt.readyState = 3;

  broadcastCastToAOI(caster, PACKET);

  expect(got(caster)).toEqual({ reliable: 1, datagrams: 0 });
  expect(got(viewer)).toEqual({ reliable: 0, datagrams: 0 });
  expect(() => broadcastCastToAOI(null, PACKET)).not.toThrow();
});

test("ground preview: the despawn reaches the viewers who got the preview, even after they walked out", () => {
  const caster = addPlayer("1", 1000, 1000);
  const stayed = addPlayer("2", 1200, 1000);
  const left = addPlayer("3", 1300, 1000);
  makeSeen(stayed, caster);
  makeSeen(left, caster);

  broadcastGroundPreviewToAOI(caster, PACKET);
  expect(got(left)).toEqual({ reliable: 0, datagrams: 1 });

  // `left` walks out of the caster's sight during the cast; `late` walks in.
  aoiReverse.removeViewer(caster.id, left.id);
  const late = addPlayer("4", 1400, 1000);
  makeSeen(late, caster);

  clearGroundPreviewForAOI(caster, PACKET);

  expect(got(caster).reliable).toBe(2);   // preview + despawn, both reliable
  expect(got(stayed)).toEqual({ reliable: 1, datagrams: 1 });
  expect(got(left)).toEqual({ reliable: 1, datagrams: 1 });
  expect(got(late)).toEqual({ reliable: 1, datagrams: 0 });

  // The record is spent: a second clear only reaches the current audience.
  clearGroundPreviewForAOI(caster, PACKET);
  expect(got(left).reliable).toBe(1);
});

test("broadcastEffectsUpdate: the player and whoever sees them, not everyone on the map", async () => {
  const { broadcastEffectsUpdate } = await import("../systems/spelleffects");
  const target = addPlayer("1", 1000, 1000);
  const viewer = addPlayer("2", 1200, 1000);
  const stranger = addPlayer("3", 1300, 1000);            // same map and layer, does not see the target
  const hidden = addPlayer("4", 1400, 1000);              // sees the target, but the target is vanished
  makeSeen(viewer, target);
  makeSeen(hidden, target);
  target.isVanished = true;

  broadcastEffectsUpdate(target);

  expect(got(target).reliable).toBe(1);
  expect(got(viewer).reliable).toBe(0);                   // vanished: only admins and party see it
  expect(got(hidden).reliable).toBe(0);
  expect(got(stranger).reliable).toBe(0);

  target.isVanished = false;
  broadcastEffectsUpdate(target);
  expect(got(viewer).reliable).toBe(1);
  expect(got(hidden).reliable).toBe(1);
  expect(got(stranger).reliable).toBe(0);
});

test("getPlayersNearPoint: null means players with no layer, undefined means every layer", () => {
  const layered = addPlayer("1", 1000, 1000);
  const loose = addPlayer("2", 1100, 1000);
  layerManager.removePlayerFromLayer("2");
  const ids = (list: any[]) => list.map((p) => p.id).sort();

  expect(ids(getPlayersNearPoint(1000, 1000, map, 500, null))).toEqual(["2"]);
  expect(ids(getPlayersNearPoint(1000, 1000, map, 500, layered.aoi.layerId))).toEqual(["1"]);
  expect(ids(getPlayersNearPoint(1000, 1000, map, 500, undefined))).toEqual(["1", "2"]);
  expect(loose.aoi.layerId).not.toBeNull();
});

test("ground preview: a disconnecting caster's record is dropped", () => {
  const caster = addPlayer("1", 1000, 1000);
  const left = addPlayer("2", 1300, 1000);
  makeSeen(left, caster);
  broadcastGroundPreviewToAOI(caster, PACKET);
  aoiReverse.removeViewer(caster.id, left.id);

  cleanupKickedSession(caster);
  clearGroundPreviewForAOI(caster, PACKET);

  expect(got(left)).toEqual({ reliable: 0, datagrams: 1 });
});
