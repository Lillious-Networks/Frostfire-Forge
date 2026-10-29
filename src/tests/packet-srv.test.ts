import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { databaseModule } from "./setup";

// The packet wave, server only: the same packets for less CPU and fewer bytes.
//   1. SPRITE_SHEET_ANIMATION is built once per pose, framed once per broadcast, and kept while its inputs hold.
//   2. CREATURE_MOVE entries are serialized once per tick, whoever sees them; the bytes do not change.
//   3. BATCH_MOVEXY leaves the receiver's own entry out (the client skips it).
//   4. The regen tick's UPDATESTATS gives observers only the stats their client reads.

mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (_sql: string, _params?: any[]) => [],
}));
mock.module("../config/settings.json", () => ({ default: { creatures: {} }, creatures: {} }));

const { TransportConnection } = await import("../socket/transport");
const { FrameDecoder, encodeFrame } = await import("../socket/framing");
const { packetManager, observerStats, regenStatsFrames } = await import("../socket/packet_manager");
const { collectReceiverEntries } = await import("../socket/movement_batch");
const { CreatureRegistry } = await import("../systems/creatures/registry");
const { CreatureSync } = await import("../systems/creatures/sync");
const { notePoseCall, notePoseSelf, getPoseStats } = await import("../socket/posestats");
const { createCombatState } = await import("../systems/creatures/threat");
const { createAuras } = await import("../systems/creatures/auras");
const playerCache = (await import("../services/playermanager")).default;
const { default: layerManager } = await import("../services/layermanager");
const mapIndex = (await import("../services/mapindex")).default;
const spatialGrid = (await import("../services/spatialgrid")).default;
const aoiReverse = await import("../services/aoiReverseIndex");
const { broadcastToAOI } = await import("../socket/aoi");
const { lookSignature } = await import("../socket/looks");

const enc = new TextEncoder();
const dec = new TextDecoder();
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

// ---- 1a. the transport frames a broadcast once

function fake(maxFrame = 1024 * 1024, queuedBytes = 0n) {
  const writes: Uint8Array[] = [];
  const session: any = { queuedBytes, close: () => {} };
  const connection = new TransportConnection(session, 1200, maxFrame);
  connection.attachStream({ getWriter: () => ({ write: (chunk: Uint8Array) => { writes.push(chunk); return Promise.resolve(); } }) });
  return { connection, writes, session };
}
const decode = (writes: Uint8Array[]) => {
  const decoder = new FrameDecoder(1024 * 1024);
  return writes.flatMap((w) => decoder.push(w)).map((f) => dec.decode(f));
};

describe("TransportConnection.sendFramed", () => {
  test("writes the same bytes send would, and builds the frame once for any number of connections", async () => {
    const payload = enc.encode(JSON.stringify({ type: "SPRITE_SHEET_ANIMATION", data: { id: "1" } }));
    const viewers = [fake(), fake(), fake()];
    const plain = fake();
    plain.connection.send(payload);

    const shared: { frame?: Uint8Array } = {};
    for (const v of viewers) v.connection.sendFramed(payload, shared);
    await tick();

    expect(shared.frame).toEqual(encodeFrame(payload));
    for (const v of viewers) expect(v.writes[0]).toEqual(plain.writes[0]);
    // One frame object serves every queue (a lone frame is written as it is).
    expect(viewers[0].writes[0]).toBe(shared.frame!);
    expect(viewers[2].writes[0]).toBe(shared.frame!);
  });

  test("a frame already in the shared holder is used, not built again", async () => {
    const payload = enc.encode("abc");
    const given = encodeFrame(payload);
    const shared = { frame: given };
    const v = fake();
    v.connection.sendFramed(payload, shared);
    await tick();
    expect(shared.frame).toBe(given);
    expect(v.writes[0]).toBe(given);
  });

  test("send and sendFramed say whether the payload was queued", async () => {
    const payload = enc.encode("z".repeat(100));
    const ok = fake();
    expect(ok.connection.send(payload)).toBe(true);
    expect(ok.connection.sendFramed(payload, {})).toBe(true);
    expect(fake(16).connection.send(payload)).toBe(false);
    expect(fake(16).connection.sendFramed(payload, {})).toBe(false);
    expect(fake(1024 * 1024, 64n * 1024n * 1024n).connection.sendFramed(payload, {})).toBe(false);
    const closed = fake();
    (closed.connection as any).readyState = 3;
    expect(closed.connection.send(payload)).toBe(false);
    expect(closed.connection.sendFramed(payload, {})).toBe(false);
    expect(ok.connection.sendFramed(new Uint8Array(0), {})).toBe(false);
    await tick();
  });

  test("every guard of send holds: oversized, closed, empty and a full queue drop it without building the frame", async () => {
    const payload = enc.encode("z".repeat(100));

    const small = fake(16);
    const s1: { frame?: Uint8Array } = {};
    small.connection.sendFramed(payload, s1);
    await tick();
    expect(small.writes.length).toBe(0);
    expect(s1.frame).toBeUndefined();

    const closed = fake();
    (closed.connection as any).readyState = 3;
    const s2: { frame?: Uint8Array } = {};
    closed.connection.sendFramed(payload, s2);
    await tick();
    expect(closed.writes.length).toBe(0);
    expect(s2.frame).toBeUndefined();

    const empty = fake();
    const s3: { frame?: Uint8Array } = {};
    empty.connection.sendFramed(new Uint8Array(0), s3);
    expect(s3.frame).toBeUndefined();

    // 64 MB queued: past the 48 MB tripwire.
    const full = fake(1024 * 1024, 64n * 1024n * 1024n);
    const s4: { frame?: Uint8Array } = {};
    full.connection.sendFramed(payload, s4);
    await tick();
    expect(full.writes.length).toBe(0);
    expect(s4.frame).toBeUndefined();

    // A viewer that drops it does not stop the next one from getting it.
    const ok = fake();
    ok.connection.sendFramed(payload, s1);
    await tick();
    expect(decode(ok.writes)).toEqual(["z".repeat(100)]);
  });

  test("frames queued in one turn still leave in one write, in order, mixed with plain sends", async () => {
    const v = fake();
    const shared: { frame?: Uint8Array } = {};
    v.connection.send(enc.encode("a"));
    v.connection.sendFramed(enc.encode("b"), shared);
    v.connection.send(enc.encode("c"));
    await tick();
    expect(v.writes.length).toBe(1);
    expect(decode(v.writes)).toEqual(["a", "b", "c"]);
  });

  test("a movement datagram goes the datagram way, as with send", () => {
    const sent: Uint8Array[] = [];
    const session: any = { queuedBytes: 0n, close: () => {}, datagrams: { sendSync: (p: Uint8Array) => sent.push(p) } };
    const connection = new TransportConnection(session, 1200, 1024 * 1024);
    connection.attachStream({ getWriter: () => ({ write: () => Promise.resolve() }) });
    const move = new Uint8Array([0x02, 1, 2, 3]);
    const shared: { frame?: Uint8Array } = {};
    connection.sendFramed(move, shared);
    expect(sent.length).toBe(1);
    expect(shared.frame).toBeUndefined();
  });
});

// ---- 1b. broadcastToAOI hands every viewer the same frame holder

describe("broadcastToAOI framing", () => {
  let seq = 0;
  function world(viewers: number) {
    playerCache.clear();
    mapIndex.clear();
    spatialGrid.clear();
    aoiReverse._reset();
    const map = `pktsrv_${++seq}`;
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
    const holders: any[] = [];
    const wts: any[] = [];
    const source = make("1", 0, null);
    for (let i = 0; i < viewers; i++) {
      const wt: any = { readyState: 1, send: () => { throw new Error("plain send used"); }, sendFramed: (_p: Uint8Array, shared: any) => holders.push(shared) };
      wts.push(wt);
      const viewer = make(String(100 + i), 10 + i, wt);
      viewer.aoi.playersInAOI.add("1");
      aoiReverse.addViewer("1", viewer.id);
    }
    return { source, holders, wts };
  }
  const packet = [enc.encode('{"type":"T","data":1}')] as any[];

  test("all viewers share one holder per packet", () => {
    const { source, holders } = world(4);
    broadcastToAOI(source, packet, false);
    expect(holders.length).toBe(4);
    expect(new Set(holders).size).toBe(1);
  });

  test("a holder the caller keeps is the one used", () => {
    const { source, holders } = world(2);
    const kept = [{ frame: encodeFrame(packet[0]) }];
    broadcastToAOI(source, packet, false, kept);
    expect(holders[0]).toBe(kept[0]);
    expect(holders[1]).toBe(kept[0]);
  });

  test("a stealthed source: only admins and party members get it, all through the one holder", () => {
    const { source, holders } = world(3);
    source.isStealth = true;
    playerCache.get("100").isAdmin = true;
    playerCache.get("101").party = [source.username];
    broadcastToAOI(source, packet, false);
    expect(holders.length).toBe(2);
    expect(holders[0]).toBe(holders[1]);
    source.isStealth = false;
    source.isVanished = true;
    holders.length = 0;
    broadcastToAOI(source, packet, false);
    expect(holders.length).toBe(2);
  });

  test("a broadcast nobody receives still sends nothing", () => {
    const { source, holders } = world(0);
    broadcastToAOI(source, packet, false);
    expect(holders.length).toBe(0);
  });

  test("a connection without sendFramed gets the packet through send", () => {
    const { source, wts } = world(1);
    const got: Uint8Array[] = [];
    delete wts[0].sendFramed;
    wts[0].send = (p: Uint8Array) => got.push(p);
    broadcastToAOI(source, packet, false);
    expect(got).toEqual([packet[0]]);
  });
});

// ---- 1c. the pose packet: built once per pose, kept while its inputs hold, invalidated on every change

// sendSpriteSheetAnimation lives in the receiver, which a test cannot import (it starts the server): its source is cut
// out and run with the names it uses handed in (line endings normalised).
const source = readFileSync(join(import.meta.dir, "..", "socket", "receiver.ts"), "utf8").replace(/\r\n/g, "\n");
const from = source.indexOf("/** The layer fields of a SPRITE_SHEET_ANIMATION packet");
const to = source.indexOf("async function sendAnimation(");
if (from < 0 || to <= from) throw new Error("the pose code was not found in receiver.ts");
const transpiler = new Bun.Transpiler({ loader: "ts" });
const POSE_NAMES = ["playerCache", "equipmentSheetsToken", "getPlayerSpriteSheetData", "getMountSpriteUrl", "packetManager", "sendPacket", "broadcastPoseToAOI", "lookSignature", "log", "drawnEquipment", "notePoseCall", "notePoseSelf"];
const makePose = new Function(`"use strict";
${transpiler.transformSync(
  `function make({ ${POSE_NAMES.join(", ")} }: any) {
${source.slice(from, to).replace(/^export /gm, "")}
return { sendSpriteSheetAnimation, poseData };
}`,
)}
return make;`)() as (given: Record<string, any>) => { sendSpriteSheetAnimation: (...a: any[]) => Promise<void>; poseData: (...a: any[]) => any };

const LAYERS = ["mountSprite", "bodySprite", "headSprite", "armorHelmetSprite", "armorShoulderguardsSprite", "armorNeckSprite", "armorHandsSprite", "armorChestSprite", "armorFeetSprite", "armorLegsSprite", "armorWeaponSprite"];
const SLOT_TO_FIELD: Record<string, string> = { helmet: "armorHelmetSprite", shoulderguards: "armorShoulderguardsSprite", necklace: "armorNeckSprite", gloves: "armorHandsSprite", chestplate: "armorChestSprite", boots: "armorFeetSprite", pants: "armorLegsSprite", weapon: "armorWeaponSprite" };
const sheet = (name: string) => ({ name, templateUrl: `t/${name}`, imageUrl: `i/${name}` });

function poseWorld() {
  const state = { token: {} as object | null, sheetOf: (item: string) => item.toLowerCase() };
  const calls = { sheets: 0 };
  const self = { sent: [] as any[][] };
  const broadcasts: Array<{ packets: any[]; frames: any[]; id: string; signature: string; pose: any[]; key?: string }> = [];
  const player: any = { id: "7", mounted: false, mount_type: "", equipment: null, wt: { data: { id: "7" } } };
  const given = {
    playerCache: { get: () => player },
    equipmentSheetsToken: () => state.token,
    getPlayerSpriteSheetData: async (animation: string, equipment: any) => {
      calls.sheets++;
      const out: any = { bodySprite: sheet("player_body_base"), headSprite: sheet("player_head_base"), animationState: animation.replace(/^player_/, "") };
      for (const field of Object.values(SLOT_TO_FIELD)) out[field] = null;
      for (const [slot, field] of Object.entries(SLOT_TO_FIELD)) {
        const item = equipment?.[slot];
        if (item && item !== "null") out[field] = sheet(state.sheetOf(item));
      }
      return out;
    },
    getMountSpriteUrl: (type: string | null) => (type ? sheet(`mount_${type.toLowerCase()}`) : null),
    packetManager,
    sendPacket: (_wt: any, packets: any[]) => self.sent.push(packets),
    // The full packet and its frame holder are what the observers get when they hold no sheets (a pose alone: packet-proto.test.ts).
    broadcastPoseToAOI: (_p: any, look: any) => broadcasts.push({ packets: look.full, frames: look.fullFrames, id: look.id, signature: look.signature, pose: look.pose, key: look.key }),
    lookSignature,
    log: { warn: () => {}, debug: () => {} },
    drawnEquipment: (p: any) => p?.equipment || null,
    notePoseCall,
    notePoseSelf,
  };
  const pose = makePose(given);
  const send = (animation = "walk_down", revision?: number) => pose.sendSpriteSheetAnimation(player.wt, animation, undefined, revision);
  const parse = (packets: any[]) => JSON.parse(dec.decode(packets[0])).data;
  return { state, calls, self, broadcasts, player, send, parse, pose };
}

describe("SPRITE_SHEET_ANIMATION", () => {
  test("the broadcast carries the pose key and the pose counters follow the sends", async () => {
    const w = poseWorld();
    const before = getPoseStats();
    await w.send("walk_down");
    await w.send("walk_down");
    await w.send("idle_down");
    const keys = w.broadcasts.map((b) => b.key);
    expect(keys.every((k) => typeof k === "string" && k.length > 0)).toBe(true);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    const after = getPoseStats();
    expect(after.self - before.self).toBe(w.self.sent.length);
    expect(after.self - before.self).toBe(3);
    expect(after.calls - before.calls).toBe(3);
    expect(after.repeats - before.repeats).toBe(1);
  });

  test("a repeat of the same pose is the same packets and frame holder, with no sheet lookup", async () => {
    const w = poseWorld();
    w.player.equipment = { helmet: "Iron Helm", chestplate: "Plate" };
    await w.send("walk_down", 3);
    await w.send("walk_down", 4);
    expect(w.calls.sheets).toBe(1);
    expect(w.broadcasts[1].packets).toBe(w.broadcasts[0].packets);
    expect(w.broadcasts[1].frames).toBe(w.broadcasts[0].frames);
    expect(w.self.sent[1]).toBe(w.self.sent[0]);
  });

  test("a walker alternating poses is answered from the kept packets; only the last four poses are kept", async () => {
    const w = poseWorld();
    for (let i = 0; i < 5; i++) { await w.send("walk_down"); await w.send("idle_down"); }
    expect(w.calls.sheets).toBe(2);
    for (const pose of ["walk_up", "idle_up", "walk_left"]) await w.send(pose);
    expect(w.calls.sheets).toBe(5);
    // walk_down and idle_down were the oldest two of five: dropped; walk_up, idle_up, walk_left and idle_down stay.
    await w.send("idle_up");
    await w.send("walk_left");
    expect(w.calls.sheets).toBe(5);
    await w.send("walk_down");
    expect(w.calls.sheets).toBe(6);
  });

  test("a new pose, direction, mount, dismount, equip, unequip or item swap builds a new packet that shows it", async () => {
    const w = poseWorld();
    const observers = async (animation = "walk_down") => { await w.send(animation); return w.parse(w.broadcasts[w.broadcasts.length - 1].packets); };

    expect((await observers()).animationState).toBe("walk_down");
    expect((await observers("idle_left")).animationState).toBe("idle_left");
    expect(w.calls.sheets).toBe(2);

    w.player.equipment = { weapon: "Sword" };
    expect((await observers("idle_left")).armorWeaponSprite.name).toBe("sword");
    w.player.equipment = { weapon: "Axe" };
    expect((await observers("idle_left")).armorWeaponSprite.name).toBe("axe");
    w.player.equipment = { weapon: "null" };
    expect((await observers("idle_left")).armorWeaponSprite).toBeUndefined();
    w.player.equipment = { weapon: "Axe", helmet: "Iron Helm" };
    const geared = await observers("idle_left");
    expect(geared.armorWeaponSprite.name).toBe("axe");
    expect(geared.armorHelmetSprite.name).toBe("iron helm");

    w.player.mounted = true;
    w.player.mount_type = "Unicorn";
    expect((await observers("idle_left")).mountSprite.name).toBe("mount_unicorn");
    w.player.mount_type = "Horse";
    expect((await observers("idle_left")).mountSprite.name).toBe("mount_horse");
    w.player.mounted = false;
    expect((await observers("idle_left")).mountSprite).toBeUndefined();

    // The own copy shows the change too.
    w.player.equipment = null;
    await w.send("idle_left");
    const own = w.parse(w.self.sent[w.self.sent.length - 1]);
    expect(own.armorWeaponSprite).toBeNull();
    expect(own.armorHelmetSprite).toBeNull();
  });

  test("a change of the item-to-sheet table, or an expired one, is never answered from the kept packet", async () => {
    const w = poseWorld();
    w.player.equipment = { helmet: "Iron Helm" };
    expect((w.parse((await w.send(), w.broadcasts[0].packets))).armorHelmetSprite.name).toBe("iron helm");

    // The editor gave the helm another sheet: the table is a new object.
    w.state.token = {};
    w.state.sheetOf = () => "helm_v2";
    await w.send();
    expect(w.parse(w.broadcasts[1].packets).armorHelmetSprite.name).toBe("helm_v2");
    expect(w.calls.sheets).toBe(2);

    // The table expired (a write dropped it): rebuilt, and not kept, as the table read may not be the one used.
    w.state.token = null;
    await w.send();
    await w.send();
    expect(w.calls.sheets).toBe(4);
    // Back to a held table: kept again.
    w.state.token = {};
    await w.send();
    await w.send();
    expect(w.calls.sheets).toBe(5);
  });

  test("no equipment at all does not depend on the table", async () => {
    const w = poseWorld();
    w.state.token = null;
    await w.send();
    await w.send();
    expect(w.calls.sheets).toBe(1);
  });

  test("the kept packet belongs to the player object: another player with the same pose builds their own", async () => {
    const w = poseWorld();
    await w.send();
    expect(w.parse(w.broadcasts[0].packets).id).toBe("7");
    const w2 = poseWorld();
    w2.player.id = "9";
    await w2.send();
    expect(w2.parse(w2.broadcasts[0].packets).id).toBe("9");
    expect(w2.broadcasts[0].packets).not.toBe(w.broadcasts[0].packets);
  });

  test("the client reads every field alike: observers' packet equals the full one wherever the client looks", async () => {
    const w = poseWorld();
    w.player.equipment = { helmet: "Iron Helm", boots: "Boots" };
    w.player.mounted = true;
    w.player.mount_type = "Horse";
    await w.send("walk_right", 12);
    const observers = w.parse(w.broadcasts[0].packets);
    const own = w.parse(w.self.sent[0]);
    // The own copy has every layer, null when empty, and no revision (the client reads it only for the legacy ANIMATION).
    expect(Object.keys(own)).toEqual(["id", ...LAYERS, "animationState"]);
    expect(own.armorNeckSprite).toBeNull();
    expect("revision" in own).toBe(false);
    // Observers' copy: a missing layer is what the client takes null for (`data.x || null`, `data.x?.name`).
    expect("revision" in observers).toBe(false);
    for (const field of LAYERS) expect(observers[field] || null).toEqual(own[field] || null);
    expect(observers.armorNeckSprite?.name).toBe(own.armorNeckSprite?.name);
    expect(observers.id).toBe(own.id);
    expect(observers.animationState).toBe(own.animationState);
    // And is smaller.
    expect(w.broadcasts[0].packets[0].length).toBeLessThan(w.self.sent[0][0].length);
  });

  test("the own copy is byte-identical to the packet sent before this change (nulls kept, revision absent)", async () => {
    const w = poseWorld();
    w.player.equipment = { chestplate: "Plate" };
    await w.send("idle_up");
    const spriteSheetData = await (async () => {
      const out: any = { bodySprite: sheet("player_body_base"), headSprite: sheet("player_head_base"), animationState: "idle_up" };
      for (const field of Object.values(SLOT_TO_FIELD)) out[field] = null;
      out.armorChestSprite = sheet("plate");
      return out;
    })();
    // What the old code built, with revision undefined as it was for the first sender in a flush.
    const old = {
      id: "7", mountSprite: null,
      bodySprite: spriteSheetData.bodySprite || null, headSprite: spriteSheetData.headSprite || null,
      armorHelmetSprite: null, armorShoulderguardsSprite: null, armorNeckSprite: null, armorHandsSprite: null,
      armorChestSprite: spriteSheetData.armorChestSprite, armorFeetSprite: null, armorLegsSprite: null, armorWeaponSprite: null,
      animationState: spriteSheetData.animationState, revision: undefined,
    };
    expect(dec.decode(w.self.sent[0][0])).toBe(dec.decode(packetManager.spriteSheetAnimation(old)[0]));
  });

  test("the look handed to the broadcast is signed from the sheets sent: it changes with equipment, mount and the sheet table, not with the pose", async () => {
    const w = poseWorld();
    const signature = async (animation = "walk_down") => { await w.send(animation); return w.broadcasts[w.broadcasts.length - 1].signature; };
    const base = await signature();
    expect(base).toBe(lookSignature(w.parse(w.broadcasts[0].packets)));
    // The pose alone is not part of the look.
    expect(await signature("idle_left")).toBe(base);
    expect(await signature("walk_up")).toBe(base);

    w.player.equipment = { weapon: "Sword" };
    const sword = await signature();
    expect(sword).not.toBe(base);
    w.player.equipment = { weapon: "Axe" };
    const axe = await signature();
    expect(axe).not.toBe(sword);
    w.player.equipment = null;
    expect(await signature()).toBe(base);

    w.player.mounted = true;
    w.player.mount_type = "Horse";
    const horse = await signature();
    expect(horse).not.toBe(base);
    w.player.mount_type = "Unicorn";
    expect(await signature()).not.toBe(horse);
    w.player.mounted = false;
    expect(await signature()).toBe(base);

    // The sheet table was edited: the same item has another sheet.
    w.player.equipment = { helmet: "Iron Helm" };
    const helm = await signature();
    w.state.token = {};
    w.state.sheetOf = () => "helm_v2";
    expect(await signature()).not.toBe(helm);
  });

  test("the pose handed to the broadcast names the player and the state", async () => {
    const w = poseWorld();
    await w.send("idle_right");
    const sent = w.broadcasts[0];
    expect(sent.id).toBe("7");
    expect(JSON.parse(dec.decode(sent.pose[0]))).toEqual({ type: "SPRITE_SHEET_POSE", data: { id: "7", animationState: "idle_right" } });
  });

  test("the shared frame holder frames the observers' packet", async () => {
    const w = poseWorld();
    await w.send();
    const { packets, frames } = w.broadcasts[0];
    const v = fake();
    v.connection.sendFramed(packets[0], frames[0]);
    await tick();
    expect(frames[0].frame).toEqual(encodeFrame(packets[0]));
  });
});

// ---- 2. CREATURE_MOVE: the nested serialization is done once per tick

const template = { id: 1, name: "Kobold" } as any;
const creature = (id: number, x: number, y: number, dir = "down", moving = true) => ({
  id, templateId: 1, spawnId: id, poolId: null, map: "main", x, y, dir, homeX: x, homeY: y,
  level: 2, health: 60, maxHealth: 60, state: "idle" as const, spawnedAt: 0, layerId: null as string | null,
  move: moving ? ({} as any) : null, waitUntil: 0, patrolIndex: 0, patrolForward: true, sentX: -1, sentY: -1, sentDir: "up", sentMoving: !moving, combat: createCombatState(), auras: createAuras(), casting: null, abilityStates: new Map(),
});

describe("CREATURE_MOVE", () => {
  test("creatureMoveJson is byte-identical to creatureMove for the same entries", () => {
    const dirs = ["up", "down", "left", "right", "upleft", "upright", "downleft", "downright"];
    for (const count of [0, 1, 2, 5, 20, 40]) {
      const entries = Array.from({ length: count }, (_, i) => [i + 1, i * 37 - 100, 5000 - i * 11, dirs[i % 8], (i % 3 === 0 ? 0 : 1)]);
      const old = packetManager.creatureMove(entries)[0];
      const next = packetManager.creatureMoveJson(entries.map((e) => JSON.stringify(e)))[0];
      expect(next).toEqual(old);
      // So the 1200 byte datagram limit falls at the same entry.
      expect(next.length > 1200).toBe(old.length > 1200);
    }
  });

  test("a tick nobody sees serializes nothing", () => {
    const registry = new CreatureRegistry(128);
    const sync = new CreatureSync({
      registry, getTemplate: () => template, playersOnMap: () => [], resolvePlayer: () => null,
      sendSpawn: () => {}, sendDespawn: () => {}, sendMoves: () => {},
    });
    const cs = [creature(1, 10, 10), creature(2, 20, 10)];
    for (const c of cs) registry.add(c as any);
    const original = JSON.stringify;
    let calls = 0;
    (JSON as any).stringify = (...args: any[]) => { calls++; return (original as any)(...args); };
    try { sync.flushMoves(cs as any); } finally { (JSON as any).stringify = original; }
    expect(calls).toBe(0);
  });

  test("flushMoves serializes each entry once however many viewers, and hands the viewers exactly the entries' JSON", () => {
    const registry = new CreatureRegistry(128);
    const sent: Array<{ player: string; reliable: boolean; entries: any[]; json: string[] }> = [];
    const players = new Map<string, any>();
    const sync = new CreatureSync({
      registry,
      getTemplate: () => template,
      playersOnMap: (map) => [...players.values()].filter((p) => p.map === map).map((p) => p.id),
      resolvePlayer: (id) => players.get(id) ?? null,
      sendSpawn: () => {},
      sendDespawn: () => {},
      sendMoves: (wt, entries, reliable, json) => sent.push({ player: wt, reliable, entries, json }),
    });
    const cs = [creature(1, 10, 10), creature(2, 20, 10, "left"), creature(3, 30, 10, "up", false), creature(4, 40, 10)];
    for (const c of cs) registry.add(c as any);
    for (const id of ["a", "b", "c", "d", "e"]) players.set(id, { id, wt: id, map: "main", layerId: null, x: 0, y: 0, radius: 500 });
    sync.refresh();
    sent.length = 0;

    const original = JSON.stringify;
    let calls = 0;
    (JSON as any).stringify = (...args: any[]) => { calls++; return (original as any)(...args); };
    try {
      sync.flushMoves(cs as any);
    } finally {
      (JSON as any).stringify = original;
    }
    expect(calls).toBe(4);
    expect(sent.length).toBe(10);
    for (const s of sent) {
      expect(s.json).toEqual(s.entries.map((e) => JSON.stringify(e)));
      const next = packetManager.creatureMoveJson(s.json)[0];
      expect(next).toEqual(packetManager.creatureMove(s.entries)[0]);
    }
    expect(sent.filter((s) => s.reliable).every((s) => s.entries.length === 1 && s.entries[0][0] === 3)).toBe(true);
  });
});

// ---- 3. BATCH_MOVEXY: the receiver's own entry stays out

describe("BATCH_MOVEXY self entry", () => {
  const mover = (id: string, x = 0): any => ({ id, x, y: 0, direction: "down", stealth: false, vanished: false, party: [] });
  const info = (selfId?: string): any => ({ x: 0, y: 0, isAdmin: false, username: "u", selfId });

  test("the receiver's own entry is left out, the others stay in order", () => {
    const movers = [mover("1"), mover("2"), mover("3")];
    const set = new Set(["1", "2", "3"]);
    expect(collectReceiverEntries(set, movers, info("2"), 0).map((e) => e.id)).toEqual([1, 3]);
    expect(collectReceiverEntries(set, movers, info(), 0).map((e) => e.id)).toEqual([1, 2, 3]);
  });

  test("a receiver whose only mover is itself gets no entries (so no batch)", () => {
    expect(collectReceiverEntries(new Set(["5"]), [mover("5")], info("5"), 0)).toEqual([]);
  });

  test("the indexed walk leaves it out too, and the tally does not count it", () => {
    const movers = [mover("1"), mover("2"), mover("3"), mover("4")];
    const index = new Map(movers.map((m, i) => [m.id, i] as [string, number]));
    const tally = { full: 0, far: 0 };
    const entries = collectReceiverEntries(new Set(["2", "4"]), movers, info("4"), 0, 500, 3, index, tally);
    expect(entries.map((e) => e.id)).toEqual([2]);
    expect(tally).toEqual({ full: 1, far: 0 });
  });
});

// ---- 4. UPDATESTATS for observers

describe("observer stats", () => {
  const stats = { health: 820, max_health: 1000, total_max_health: 1150, stamina: 300, max_stamina: 400, total_max_stamina: 450, level: 23, xp: 12345, max_xp: 20000, stat_critical_damage: 12, stat_critical_chance: 8, stat_armor: 14, stat_damage: 41, stat_health: 60, stat_stamina: 20, stat_avoidance: 5, absorbtion: 0 };

  test("health, stamina and both totals are always there; nothing the client never reads for another player", () => {
    const out = observerStats(stats);
    expect(out.health).toBe(820);
    expect(out.stamina).toBe(300);
    expect(out.total_max_health).toBe(1150);
    expect(out.total_max_stamina).toBe(450);
    for (const gone of ["xp", "max_xp", "max_health", "max_stamina", "stat_health", "stat_stamina"]) expect(gone in out).toBe(false);
  });

  test("absorbtion stays: the nameplate and target frame draw the shield from it", () => {
    expect(observerStats({ ...stats, absorbtion: 35 }).absorbtion).toBe(35);
    expect(observerStats({ ...stats, absorbtion: 0 }).absorbtion).toBe(0);
    expect("absorbtion" in observerStats({ health: 1, stamina: 1, total_max_health: 1, total_max_stamina: 1 })).toBe(false);
  });

  test("regen audience: the player and party members get the full frame, other observers the trimmed one", () => {
    const player = { id: "7", username: "ann" };
    const frames = regenStatsFrames(player, stats);
    const parse = (b: Uint8Array) => JSON.parse(dec.decode(b)).data;
    expect(frames.full).toEqual(packetManager.updateStats({ id: "7", target: "7", stats })[0]);
    expect(parse(frames.full).stats.xp).toBe(12345);
    const friend = frames.frameFor({ party: ["ann", "bob"] });
    expect(friend).toBe(frames.full);
    const stranger = frames.frameFor({ party: ["zed"] });
    const none = frames.frameFor({});
    expect(stranger).not.toBe(frames.full);
    expect(none).toBe(stranger);
    expect(parse(stranger)).toEqual({ target: "7", stats: observerStats(stats) });
    expect("xp" in parse(stranger).stats).toBe(false);
  });

  test("the inspect window's fields stay, so a window open on the player shows the same numbers", () => {
    const out = observerStats(stats);
    expect(out.level).toBe(23);
    expect(out.stat_damage).toBe(41);
    expect(out.stat_armor).toBe(14);
    expect(out.stat_critical_chance).toBe(8);
    expect(out.stat_critical_damage).toBe(12);
    expect(out.stat_avoidance).toBe(5);
  });

  test("the client's merge of the partial stats ends where the full ones would for every field it displays", () => {
    const before = { ...stats, health: 800, stamina: 280 };
    const full = { ...before, ...stats };
    const partial = { ...before, ...observerStats(stats) };
    for (const key of ["health", "stamina", "total_max_health", "total_max_stamina", "level", "stat_damage", "stat_armor", "stat_critical_chance", "stat_critical_damage", "stat_avoidance"]) {
      expect((partial as any)[key]).toBe((full as any)[key]);
    }
  });

  test("smaller than the full packet", () => {
    const full = packetManager.updateStats({ id: "1", target: "1", stats })[0];
    const part = packetManager.updateStats({ target: "1", stats: observerStats(stats) })[0];
    expect(part.length).toBeLessThan(full.length);
    expect(JSON.parse(dec.decode(part)).data.target).toBe("1");
  });

  test("a field the player lacks is not invented", () => {
    const out = observerStats({ health: 1, stamina: 2, total_max_health: 3, total_max_stamina: 4 });
    expect(Object.keys(out)).toEqual(["health", "stamina", "total_max_health", "total_max_stamina"]);
  });
});
