import { beforeEach, describe, expect, mock, test } from "bun:test";
import { databaseModule } from "./setup";

// Pose counters (socket/posestats.ts): measurement only, the packets sent are those of packet-proto.test.ts.

mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (_sql: string, _params?: any[]) => [],
}));
mock.module("../config/settings.json", () => ({ default: { creatures: {} }, creatures: {} }));

const { packetManager } = await import("../socket/packet_manager");
const { lookSignature } = await import("../socket/looks");
const { broadcastPoseToAOI } = await import("../socket/aoi");
const { getPoseStats, resetPoseStats, notePoseCall } = await import("../socket/posestats");
const playerCache = (await import("../services/playermanager")).default;
const { default: layerManager } = await import("../services/layermanager");
const mapIndex = (await import("../services/mapindex")).default;
const spatialGrid = (await import("../services/spatialgrid")).default;
const aoiReverse = await import("../services/aoiReverseIndex");

const dec = new TextDecoder();
let seq = 0;

function world(viewers: number) {
  playerCache.clear();
  mapIndex.clear();
  spatialGrid.clear();
  aoiReverse._reset();
  const map = `posecount_${++seq}`;
  const make = (id: string, x: number, wt: any) => {
    const p: any = {
      id, username: `u${id}`, location: { map: `${map}.json`, position: { x, y: 0, direction: "down" } }, wt, party: [],
      aoi: { playersInAOI: new Set<string>(), aoiRadius: 1000, layerId: null },
    };
    playerCache.add(id, p);
    p.aoi.layerId = layerManager.assignPlayerToLayer(id, map, x, 0);
    playerCache.set(id, p);
    mapIndex.addPlayer(id, map);
    spatialGrid.addPlayer(id, x, 0, map);
    return playerCache.get(id);
  };
  const got: string[] = [];
  const source = make("1", 0, null);
  for (let i = 0; i < viewers; i++) {
    const id = String(100 + i);
    const wt: any = { readyState: 1, send: () => {}, sendFramed: (p: Uint8Array) => got.push(JSON.parse(dec.decode(p)).type) };
    const viewer = make(id, 10 + i, wt);
    viewer.aoi.playersInAOI.add("1");
    aoiReverse.addViewer("1", viewer.id);
  }
  return { source, got };
}

const sheet = (name: string) => ({ name, templateUrl: `t/${name}`, imageUrl: `i/${name}` });
function look(key: string, state = "walk_down", extra: Record<string, any> = {}) {
  const data = { mountSprite: null, bodySprite: sheet("body"), headSprite: sheet("head"), ...extra };
  const observers: any = { id: "1" };
  for (const [k, v] of Object.entries(data)) if (v) observers[k] = v;
  observers.animationState = state;
  return {
    id: "1", key, signature: lookSignature(data),
    full: packetManager.spriteSheetAnimation(observers), fullFrames: [{}],
    pose: packetManager.spriteSheetPose({ id: "1", animationState: state }), poseFrames: [{}],
  };
}

describe("pose counters", () => {
  beforeEach(() => resetPoseStats());

  test("a first pose, a repeat and a change are counted by call", () => {
    const subject = {};
    notePoseCall(subject, "walk_down", "k1");
    expect(getPoseStats()).toMatchObject({ calls: 1, repeats: 0, byName: { walk_down: 1 } });
    notePoseCall(subject, "walk_down", "k1");
    expect(getPoseStats()).toMatchObject({ calls: 2, repeats: 1, byName: { walk_down: 2 } });
    notePoseCall(subject, "idle_down", "k2");
    expect(getPoseStats()).toMatchObject({ calls: 3, repeats: 1 });
    expect(getPoseStats().byName).toEqual({ walk_down: 2, idle_down: 1 });
  });

  test("names past 64 go under other", () => {
    const subject = {};
    for (let i = 0; i < 70; i++) notePoseCall(subject, `n${i}`, `k${i}`);
    notePoseCall(subject, "n0", "kx");
    const names = getPoseStats().byName;
    expect(Object.keys(names).length).toBe(65);
    expect(names.other).toBe(6);
    expect(names.n0).toBe(2);
  });

  test("viewers: full first, pose-only after, repeats per viewer, packets unchanged", () => {
    const { source, got } = world(2);
    broadcastPoseToAOI(source, look("a"));
    expect(got).toEqual(["SPRITE_SHEET_ANIMATION", "SPRITE_SHEET_ANIMATION"]);
    expect(getPoseStats()).toMatchObject({ full: 2, poseOnly: 0, viewerRepeats: 0 });
    got.length = 0;
    broadcastPoseToAOI(source, look("a"));
    expect(got).toEqual(["SPRITE_SHEET_POSE", "SPRITE_SHEET_POSE"]);
    expect(getPoseStats()).toMatchObject({ full: 2, poseOnly: 2, viewerRepeats: 2 });
    broadcastPoseToAOI(source, look("b", "idle_down"));
    expect(getPoseStats()).toMatchObject({ poseOnly: 4, viewerRepeats: 2 });
  });

  test("a pose without a key counts frames but no repeats; the relay calls are counted for local sources", () => {
    const { source } = world(1);
    const l: any = look("a");
    delete l.key;
    broadcastPoseToAOI(source, l);
    broadcastPoseToAOI(source, l);
    expect(getPoseStats()).toMatchObject({ full: 1, poseOnly: 1, viewerRepeats: 0, relayCalls: 2 });
  });
});
