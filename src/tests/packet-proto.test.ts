import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { databaseModule } from "./setup";

// The protocol packet wave:
//   A. SPRITE_SHEET_POSE: a pose change alone, for viewers that hold the player's sheets (socket/looks.ts).
//   B. CREATURE_MOVE as a binary datagram (socket/creature_move_codec.ts), split by the transport.
// The client's decoders are tested by the Gateway repository, which owns them (its src/modules/protoclient.test.ts), against
// the same layout: the bytes of a known datagram are pinned below.

mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (_sql: string, _params?: any[]) => [],
}));
mock.module("../config/settings.json", () => ({ default: { creatures: {} }, creatures: {} }));

const codec = await import("../socket/creature_move_codec");
const { TransportConnection } = await import("../socket/transport");
const { packetManager } = await import("../socket/packet_manager");
const { CreatureRegistry } = await import("../systems/creatures/registry");
const { CreatureSync } = await import("../systems/creatures/sync");
const { holdsLook, noteLook, forgetLook, lookSignature } = await import("../socket/looks");
const { broadcastPoseToAOI, despawnPlayerFromAllAOI, sendLoadPlayersChunked } = await import("../socket/aoi");
const playerCache = (await import("../services/playermanager")).default;
const { default: layerManager } = await import("../services/layermanager");
const mapIndex = (await import("../services/mapindex")).default;
const spatialGrid = (await import("../services/spatialgrid")).default;
const aoiReverse = await import("../services/aoiReverseIndex");

const dec = new TextDecoder();
const DIRS = ["down", "up", "left", "right", "downleft", "downright", "upleft", "upright"];

// small deterministic generator
let seed = 12345;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000);
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

function randomEntry(): [number, number, number, string, 0 | 1] {
  const pick = int(0, 4);
  const id = pick === 0 ? 0 : pick === 1 ? 0xffffffff : int(0, 0xffffffff);
  const x = pick === 0 ? -0x80000000 : pick === 1 ? 0x7fffffff : int(-0x80000000, 0x7fffffff);
  const y = pick === 0 ? 0x7fffffff : pick === 1 ? -0x80000000 : int(-0x80000000, 0x7fffffff);
  return [id, x, y, DIRS[int(0, 7)], int(0, 1) as 0 | 1];
}

describe("binary CREATURE_MOVE codec", () => {
  test("random entries, extremes included, survive encode -> join -> decode unchanged", () => {
    for (let round = 0; round < 200; round++) {
      const entries = Array.from({ length: int(0, 60) }, randomEntry);
      const records = entries.map((e) => codec.encodeCreatureMove(e)!);
      for (const r of records) expect(r.length).toBe(13);
      const payload = codec.joinCreatureMoves(records);
      expect(payload.length).toBe(3 + 13 * entries.length);
      expect(codec.decodeCreatureMoves(payload)).toEqual(entries);
    }
  });

  test("the layout the client reads: a known datagram is these exact bytes, and the same view into a larger buffer decodes the same", () => {
    // The Gateway's src/modules/protoclient.test.ts decodes these same bytes.
    const payload = codec.joinCreatureMoves([codec.encodeCreatureMove([7, 1, 2, "up", 1])!, codec.encodeCreatureMove([0xffffffff, -0x80000000, 0x7fffffff, "upright", 0])!]);
    expect([...payload]).toEqual([
      0x04, 0x02, 0x00,
      7, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 0x09,
      0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x80, 0xff, 0xff, 0xff, 0x7f, 0x07,
    ]);
    expect(codec.CREATURE_MOVE_HEADER).toBe(0x04);
    const padded = new Uint8Array(payload.length + 7);
    padded.set(payload, 5);
    expect(codec.decodeCreatureMoves(padded.subarray(5, 5 + payload.length))).toEqual([[7, 1, 2, "up", 1], [0xffffffff, -0x80000000, 0x7fffffff, "upright", 0]]);
  });

  test("an entry that does not fit its width has no record, so it goes as JSON", () => {
    expect(codec.encodeCreatureMove([1.5, 0, 0, "down", 1])).toBeNull();
    expect(codec.encodeCreatureMove([-1, 0, 0, "down", 1])).toBeNull();
    expect(codec.encodeCreatureMove([0x100000000, 0, 0, "down", 1])).toBeNull();
    expect(codec.encodeCreatureMove([1, 0x80000000, 0, "down", 1])).toBeNull();
    expect(codec.encodeCreatureMove([1, 0, -0x80000001, "down", 1])).toBeNull();
    expect(codec.encodeCreatureMove([1, NaN, 0, "down", 1])).toBeNull();
    expect(codec.encodeCreatureMove([1, 0, 0, "sideways", 1])).toBeNull();
    expect(codec.encodeCreatureMove([1, 0, 0, "toString", 1])).toBeNull();
  });

  test("a short, empty or foreign datagram decodes to nothing and never throws", () => {
    for (const bytes of [new Uint8Array(0), new Uint8Array([4]), new Uint8Array([4, 9, 0, 1, 2]), new Uint8Array([1, 0, 0]), new Uint8Array([4, 255, 255])]) {
      expect(codec.decodeCreatureMoves(bytes)).toEqual([]);
    }
    // A count larger than the bytes present is cut to the whole records there are.
    const one = codec.joinCreatureMoves([codec.encodeCreatureMove([7, 1, 2, "up", 1])!]);
    one[1] = 50;
    expect(codec.decodeCreatureMoves(one)).toEqual([[7, 1, 2, "up", 1]]);
  });

  test("the binary datagram is 263 bytes for 20 creatures against the JSON packet", () => {
    const entries = Array.from({ length: 20 }, (_, i): [number, number, number, string, 0 | 1] => [100000 + i, 1500 + i * 13, 900 + i, DIRS[i % 8], 1]);
    const bin = packetManager.creatureMoveBinary(entries.map((e) => codec.encodeCreatureMove(e)!))[0];
    const json = packetManager.creatureMove(entries)[0];
    expect(bin.length).toBe(263);
    expect(json.length).toBeGreaterThan(500);
  });
});

describe("TransportConnection.sendBestEffort with binary creature moves", () => {
  function conn(maxDatagram = 1200) {
    const datagrams: Uint8Array[] = [];
    const frames: Uint8Array[] = [];
    const session: any = { queuedBytes: 0n, close: () => {}, datagrams: { sendSync: (p: Uint8Array) => datagrams.push(p) } };
    const connection = new TransportConnection(session, maxDatagram, 1024 * 1024);
    connection.attachStream({ getWriter: () => ({ write: (c: Uint8Array) => { frames.push(c); return Promise.resolve(); } }) });
    return { connection, datagrams, frames };
  }
  const records = (n: number) => Array.from({ length: n }, (_, i) => codec.encodeCreatureMove([i, i * 3, -i, DIRS[i % 8], (i % 2) as 0 | 1])!);

  test("a payload within the datagram size is one datagram", () => {
    const c = conn();
    c.connection.sendBestEffort(packetManager.creatureMoveBinary(records(20))[0]);
    expect(c.datagrams.length).toBe(1);
    expect(c.datagrams[0].length).toBe(263);
  });

  test("past it the records are split over datagrams of whole records, none on the stream, none lost or reordered", async () => {
    const c = conn();
    const all = records(250);
    c.connection.sendBestEffort(packetManager.creatureMoveBinary(all)[0]);
    await new Promise((r) => setTimeout(r, 5));
    expect(c.frames.length).toBe(0);
    expect(c.datagrams.length).toBe(Math.ceil(250 / 91));
    for (const d of c.datagrams) expect(d.length).toBeLessThanOrEqual(1200);
    expect(c.datagrams.flatMap((d) => codec.decodeCreatureMoves(d))).toEqual(codec.decodeCreatureMoves(codec.joinCreatureMoves(all)));
  });

  test("a datagram size that holds no record sends it on the stream whole", async () => {
    const c = conn(10);
    c.connection.sendBestEffort(packetManager.creatureMoveBinary(records(2))[0]);
    await new Promise((r) => setTimeout(r, 5));
    expect(c.datagrams.length).toBe(0);
    expect(c.frames.length).toBe(1);
  });
});

describe("CreatureSync binary moves", () => {
  function setup(withBinary: boolean) {
    const registry = new CreatureRegistry();
    const sent: any[] = [];
    const sync = new CreatureSync({
      registry,
      getTemplate: () => ({ id: 1 }) as any,
      playersOnMap: () => ["p1", "p2"],
      resolvePlayer: (id: string) => ({ id, wt: id, map: "m", layerId: null, x: 0, y: 0, radius: 5000 }),
      sendSpawn: () => {},
      sendDespawn: () => {},
      sendMoves: (wt, entries, reliable, json) => sent.push({ kind: "json", wt, reliable, entries, json }),
      ...(withBinary ? { sendBinaryMoves: (wt: any, records: Uint8Array[]) => sent.push({ kind: "bin", wt, records }) } : {}),
    });
    const creature = (id: number, dir: string, moving: boolean): any => ({
      id, map: "m", layerId: null, x: 10 + id, y: 20, dir, move: moving ? {} : null, sentX: -1, sentY: -1, sentDir: "", sentMoving: false, templateId: 1,
    });
    return { sync, sent, creature, registry };
  }
  const known = (sync: any, ids: number[]) => { for (const p of ["p1", "p2"]) sync.viewers.set(p, { map: "m", layerId: null, ids: new Set(ids) }); };

  test("moving entries go as binary records encoded once for all viewers; stopped ones stay JSON on the stream", () => {
    const { sync, sent, creature } = setup(true);
    known(sync, [1, 2]);
    sync.flushMoves([creature(1, "left", true), creature(2, "up", false)]);
    const bins = sent.filter((s) => s.kind === "bin");
    expect(bins.length).toBe(2);
    expect(bins[0].records[0]).toBe(bins[1].records[0]);
    expect(codec.decodeCreatureMoves(codec.joinCreatureMoves(bins[0].records))).toEqual([[1, 11, 20, "left", 1]]);
    const stops = sent.filter((s) => s.kind === "json");
    expect(stops.length).toBe(2);
    expect(stops[0].reliable).toBe(true);
    expect(stops[0].entries).toEqual([[2, 12, 20, "up", 0]]);
  });

  test("an entry with an unknown direction is sent as JSON, the rest as binary", () => {
    const { sync, sent, creature } = setup(true);
    known(sync, [1, 2]);
    sync.flushMoves([creature(1, "left", true), creature(2, "weird", true)]);
    const p1 = sent.filter((s) => s.wt === "p1");
    expect(p1.find((s) => s.kind === "bin").records.length).toBe(1);
    expect(p1.find((s) => s.kind === "json").entries).toEqual([[2, 12, 20, "weird", 1]]);
  });

  test("without a binary sender every moving entry goes through sendMoves as before", () => {
    const { sync, sent, creature } = setup(false);
    known(sync, [1]);
    sync.flushMoves([creature(1, "left", true)]);
    expect(sent.every((s) => s.kind === "json")).toBe(true);
    expect(sent.length).toBe(2);
  });
});

describe("pose packet selection", () => {
  let seq = 0;
  function world(viewers: number) {
    playerCache.clear();
    mapIndex.clear();
    spatialGrid.clear();
    aoiReverse._reset();
    const map = `pktproto_${++seq}`;
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
    const got: Array<{ viewer: string; kind: string }> = [];
    const wts: any[] = [];
    const source = make("1", 0, null);
    for (let i = 0; i < viewers; i++) {
      const id = String(100 + i);
      const wt: any = { readyState: 1, send: () => {}, sendFramed: (p: Uint8Array) => got.push({ viewer: id, kind: JSON.parse(dec.decode(p)).type }) };
      wts.push(wt);
      const viewer = make(id, 10 + i, wt);
      viewer.aoi.playersInAOI.add("1");
      aoiReverse.addViewer("1", viewer.id);
    }
    return { source, got, wts, make, map };
  }
  const sheet = (name: string) => ({ name, templateUrl: `t/${name}`, imageUrl: `i/${name}` });
  const look = (extra: Record<string, any> = {}, state = "walk_down") => {
    const data = { mountSprite: null, bodySprite: sheet("body"), headSprite: sheet("head"), ...extra };
    const observers: any = { id: "1" };
    for (const [k, v] of Object.entries(data)) if (v) observers[k] = v;
    observers.animationState = state;
    return {
      id: "1",
      signature: lookSignature(data),
      full: packetManager.spriteSheetAnimation(observers),
      fullFrames: [{}],
      pose: packetManager.spriteSheetPose({ id: "1", animationState: state }),
      poseFrames: [{}],
    };
  };

  test("a viewer is sent the full sheets first, then only poses while its look holds", () => {
    const { source, got } = world(2);
    broadcastPoseToAOI(source, look());
    expect(got.map((g) => g.kind)).toEqual(["SPRITE_SHEET_ANIMATION", "SPRITE_SHEET_ANIMATION"]);
    got.length = 0;
    broadcastPoseToAOI(source, look({}, "idle_down"));
    broadcastPoseToAOI(source, look({}, "walk_up"));
    expect(got.map((g) => g.kind)).toEqual(Array(4).fill("SPRITE_SHEET_POSE"));
  });

  test("equip mid-stream: the changed look goes in full to every viewer, then poses again", () => {
    const { source, got } = world(2);
    broadcastPoseToAOI(source, look());
    got.length = 0;
    broadcastPoseToAOI(source, look({ armorWeaponSprite: sheet("sword") }, "walk_down"));
    expect(got.map((g) => g.kind)).toEqual(["SPRITE_SHEET_ANIMATION", "SPRITE_SHEET_ANIMATION"]);
    got.length = 0;
    broadcastPoseToAOI(source, look({ armorWeaponSprite: sheet("sword") }, "idle_down"));
    expect(got.map((g) => g.kind)).toEqual(["SPRITE_SHEET_POSE", "SPRITE_SHEET_POSE"]);
    // Unequip: back to the bare look is another change.
    got.length = 0;
    broadcastPoseToAOI(source, look());
    expect(got.map((g) => g.kind)).toEqual(["SPRITE_SHEET_ANIMATION", "SPRITE_SHEET_ANIMATION"]);
  });

  test("mount and dismount are look changes", () => {
    const { source, got } = world(1);
    broadcastPoseToAOI(source, look());
    got.length = 0;
    broadcastPoseToAOI(source, look({ mountSprite: sheet("mount_horse") }));
    broadcastPoseToAOI(source, look({ mountSprite: sheet("mount_horse") }, "idle_down"));
    broadcastPoseToAOI(source, look({ mountSprite: sheet("mount_unicorn") }, "idle_down"));
    broadcastPoseToAOI(source, look({}, "idle_down"));
    expect(got.map((g) => g.kind)).toEqual(["SPRITE_SHEET_ANIMATION", "SPRITE_SHEET_POSE", "SPRITE_SHEET_ANIMATION", "SPRITE_SHEET_ANIMATION"]);
  });

  test("a new viewer gets the full sheets while the others get the pose", () => {
    const { source, got, make } = world(2);
    broadcastPoseToAOI(source, look());
    got.length = 0;
    const wt: any = { readyState: 1, send: () => {}, sendFramed: (p: Uint8Array) => got.push({ viewer: "late", kind: JSON.parse(dec.decode(p)).type }) };
    const late = make("300", 20, wt);
    late.aoi.playersInAOI.add("1");
    aoiReverse.addViewer("1", "300");
    broadcastPoseToAOI(source, look({}, "idle_left"));
    expect(got.find((g) => g.viewer === "late")!.kind).toBe("SPRITE_SHEET_ANIMATION");
    expect(got.filter((g) => g.viewer !== "late").every((g) => g.kind === "SPRITE_SHEET_POSE")).toBe(true);
    expect(got.length).toBe(3);
  });

  test("a spawn that sent the sheets counts, and one that did not clears the record", () => {
    const { source, got, wts } = world(1);
    broadcastPoseToAOI(source, look());
    forgetLook(wts[0], "1");
    got.length = 0;
    broadcastPoseToAOI(source, look());
    expect(got.map((g) => g.kind)).toEqual(["SPRITE_SHEET_ANIMATION"]);
    // The spawn path records what it sent, in the shape of its data (null layers).
    forgetLook(wts[0], "1");
    noteLook(wts[0], "1", lookSignature({ mountSprite: null, bodySprite: sheet("body"), headSprite: sheet("head"), armorHelmetSprite: null }));
    got.length = 0;
    broadcastPoseToAOI(source, look());
    expect(got.map((g) => g.kind)).toEqual(["SPRITE_SHEET_POSE"]);
  });

  test("a full sheet the connection dropped leaves no record", () => {
    const { source, got, wts } = world(2);
    broadcastPoseToAOI(source, look());
    // The first viewer's queue drops the next full packet; the second takes it.
    wts[0].sendFramed = () => false;
    broadcastPoseToAOI(source, look({ armorWeaponSprite: sheet("sword") }, "idle_down"));
    wts[0].sendFramed = (p: Uint8Array) => got.push({ viewer: "100", kind: JSON.parse(dec.decode(p)).type });
    got.length = 0;
    // Neither the old look nor the dropped one is held: the viewer is sent the full sheets again.
    broadcastPoseToAOI(source, look({ armorWeaponSprite: sheet("sword") }, "walk_up"));
    expect(got.map((g) => g.kind)).toEqual(["SPRITE_SHEET_ANIMATION", "SPRITE_SHEET_POSE"]);
  });

  test("a player leaving the viewer's view clears the record, so a return gets the full sheets", () => {
    const { source, got, wts } = world(2);
    broadcastPoseToAOI(source, look());
    despawnPlayerFromAllAOI(source, "disconnect");
    for (const wt of wts) expect(holdsLook(wt, "1", look().signature)).toBe(false);
    // Back in view (the aoi was emptied by the despawn): the next pose is in full.
    got.length = 0;
    for (const id of ["100", "101"]) {
      playerCache.get(id).aoi.playersInAOI.add("1");
      aoiReverse.addViewer("1", id);
    }
    source.aoi.playersInAOI.add("100");
    broadcastPoseToAOI(source, look({}, "idle_down"));
    expect(got.map((g) => g.kind)).toEqual(["SPRITE_SHEET_ANIMATION", "SPRITE_SHEET_ANIMATION"]);
  });

  test("a spawn packet through sendLoadPlayersChunked clears the record of the players in it, and no other", () => {
    const wt: any = { readyState: 1 };
    noteLook(wt, "1", "x");
    noteLook(wt, "2", "x");
    noteLook(wt, "3", "x");
    const sent: any[] = [];
    sendLoadPlayersChunked((_wt: any, packets: any) => sent.push(packets), wt, [{ id: "1" }, { id: "2" }], null);
    expect(sent.length).toBe(1);
    expect(holdsLook(wt, "1", "x")).toBe(false);
    expect(holdsLook(wt, "2", "x")).toBe(false);
    expect(holdsLook(wt, "3", "x")).toBe(true);
  });

  test("every place the server sends a player's despawn or spawn to a viewer clears the viewer's record first", () => {
    const root = join(import.meta.dir, "..");
    const sites = /packetManager\.(despawnPlayer|loadPlayers|loadPlayersJson|batchDisconnectPlayer)\(/;
    const missing: string[] = [];
    let found = 0;
    for (const file of new Bun.Glob("**/*.ts").scanSync({ cwd: root })) {
      const path = file.split("\\").join("/");
      if (path.startsWith("tests/") || path.startsWith("cluster/") || path.endsWith("packet_manager.ts")) continue;
      const lines = readFileSync(join(root, file), "utf8").replace(/\r\n/g, "\n").split("\n");
      lines.forEach((line, i) => {
        if (!sites.test(line) || /^\s*\/\//.test(line)) return;
        found++;
        if (!lines.slice(Math.max(0, i - 8), i + 1).some((l) => l.includes("forgetLook("))) missing.push(`${file}:${i + 1}`);
      });
    }
    expect(found).toBeGreaterThanOrEqual(15);
    expect(missing).toEqual([]);
  });

  test("a stealthed source reaches only admins and party members, with the same selection", () => {
    const { source, got } = world(3);
    source.isStealth = true;
    playerCache.get("100").isAdmin = true;
    playerCache.get("101").party = [source.username];
    broadcastPoseToAOI(source, look());
    expect(got.map((g) => g.viewer).sort()).toEqual(["100", "101"]);
  });

  test("the signature follows the sheet names and urls only, not the pose or the shape of the data", () => {
    expect(lookSignature({ bodySprite: sheet("b"), animationState: "x" })).toBe(lookSignature({ bodySprite: sheet("b"), headSprite: null, armorHelmetSprite: null, animationState: "y" }));
    expect(lookSignature({ bodySprite: sheet("b") })).not.toBe(lookSignature({ bodySprite: sheet("c") }));
    expect(lookSignature({ bodySprite: sheet("b"), armorHelmetSprite: sheet("h") })).not.toBe(lookSignature({ bodySprite: sheet("b"), armorNeckSprite: sheet("h") }));
  });

  test("the pose packet is small and carries the id and the pose", () => {
    const p = packetManager.spriteSheetPose({ id: "123456", animationState: "walk_down" })[0];
    expect(JSON.parse(dec.decode(p))).toEqual({ type: "SPRITE_SHEET_POSE", data: { id: "123456", animationState: "walk_down" } });
    expect(p.length).toBeLessThan(90);
  });

  test("holdsLook is false for a connection never sent anything, and for a missing one", () => {
    expect(holdsLook({}, "1", "x")).toBe(false);
    expect(holdsLook(null, "1", "x")).toBe(false);
  });
});

describe("look records", () => {
  test("a connection's record is bounded: past the cap it starts again, so the next poses go out in full", () => {
    const wt = {};
    for (let i = 0; i < 512; i++) noteLook(wt, `s${i}`, "x");
    expect(holdsLook(wt, "s0", "x")).toBe(true);
    noteLook(wt, "new", "x");
    expect(holdsLook(wt, "s0", "x")).toBe(false);
    expect(holdsLook(wt, "new", "x")).toBe(true);
  });
});
