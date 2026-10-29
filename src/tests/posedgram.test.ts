import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { databaseModule } from "./setup";

// Viewer pose changes by datagram (socket/posedgram.ts, socket/pose_codec.ts, broadcastPoseToAOI): a viewer's copy of
// a pose change is a datagram with the player's pose revision, not a stream frame (one native write each, the cost
// that stalled a node at 800 players). The current pose is sent again at 100 and 400 ms, a newer change stops the
// repeats of the older one, and the revision keeps rising across a handoff. What a client needs to see a player for
// the first time stays on the stream. The client half is the Gateway's src/modules/posedgram.test.ts.

mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (_sql: string, _params?: any[]) => [],
}));
mock.module("../config/settings.json", () => ({ default: { creatures: {} }, creatures: {} }));

const { TransportConnection } = await import("../socket/transport");
const { FrameDecoder } = await import("../socket/framing");
const { packetManager } = await import("../socket/packet_manager");
const { broadcastPoseToAOI } = await import("../socket/aoi");
const { lookSignature } = await import("../socket/looks");
const { POSE_DATAGRAM_HEADER, decodePoseDatagram, encodePoseRecord, packPoseRecords } = await import("../socket/pose_codec");
const { POSE_REPEAT_MS, PoseRepeater, arrivedPoseRevision, nextPoseRevision, poseRepeats } = await import("../socket/posedgram");
const { getPoseStats, resetPoseStats, notePoseCall, notePoseSelf } = await import("../socket/posestats");
const { ghosts } = await import("../cluster/ghosts");
const playerCache = (await import("../services/playermanager")).default;
const { default: layerManager } = await import("../services/layermanager");
const mapIndex = (await import("../services/mapindex")).default;
const spatialGrid = (await import("../services/spatialgrid")).default;
const aoiReverse = await import("../services/aoiReverseIndex");

const dec = new TextDecoder();
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

// ---- a clock the repeater is driven by

function clock() {
  let t = 1_000_000;
  const timers: Array<{ at: number; fn: () => void }> = [];
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => { const h = { at: t + ms, fn }; timers.push(h); return h; },
    clearTimer: (h: unknown) => { const i = timers.indexOf(h as any); if (i >= 0) timers.splice(i, 1); },
    /** Runs every timer due within `ms`, in order, with the time at each one's due moment. */
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = Math.max(t, next.at);
        next.fn();
      }
      t = end;
    },
    pending: () => timers.length,
  };
}

// ---- a connection over a fake session: stream writes and datagrams are kept, a datagram can be dropped on the way

interface Sent { at: number; bytes: Uint8Array; lost: boolean }

function connection(time: { now(): number }, drop: (n: number, bytes: Uint8Array) => boolean = () => false) {
  const stream: Uint8Array[] = [];
  const datagrams: Sent[] = [];
  let count = 0;
  const take = (bytes: Uint8Array) => { datagrams.push({ at: time.now(), bytes: bytes.slice(), lost: drop(count++, bytes) }); };
  const session: any = {
    queuedBytes: 0n,
    close: () => {},
    datagrams: { sendSync: (p: Uint8Array) => take(p), sendSyncBatch: (ps: Uint8Array[]) => ps.forEach(take) },
  };
  const wt = new TransportConnection(session, 1200, 1024 * 1024);
  wt.attachStream({ getWriter: () => ({ write: (chunk: Uint8Array) => { stream.push(chunk.slice()); return Promise.resolve(); } }) });
  const frames = () => {
    const decoder = new FrameDecoder(1024 * 1024);
    return stream.flatMap((w) => decoder.push(w)).map((f) => JSON.parse(dec.decode(f)));
  };
  return { wt, stream, datagrams, frames, session };
}

// ---- a world: one source (id 1) and viewers that see it

let seq = 0;
function world(viewerCount: number, drop?: (viewer: number, n: number, bytes: Uint8Array) => boolean) {
  playerCache.clear();
  mapIndex.clear();
  spatialGrid.clear();
  aoiReverse._reset();
  const time = clock();
  poseRepeats.configure({ now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer });
  const map = `posedgram_${++seq}`;
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
  const self = connection(time);
  const source = make("1", 0, self.wt);
  const viewers: Array<ReturnType<typeof connection> & { id: string }> = [];
  const addViewer = (id: string, x: number) => {
    const n = viewers.length;
    const c = Object.assign(connection(time, drop ? (k, b) => drop(n, k, b) : undefined), { id });
    viewers.push(c);
    const viewer = make(id, x, c.wt);
    viewer.aoi.playersInAOI.add("1");
    aoiReverse.addViewer("1", viewer.id);
    return c;
  };
  for (let i = 0; i < viewerCount; i++) addViewer(String(100 + i), 10 + i);
  return { time, source, self, viewers, make, addViewer };
}

const sheet = (name: string) => ({ name, templateUrl: `t/${name}`, imageUrl: `i/${name}` });
function look(state = "walk_down", extra: Record<string, any> = {}, id = "1") {
  const data = { mountSprite: null, bodySprite: sheet("body"), headSprite: sheet("head"), ...extra };
  const observers: any = { id };
  for (const [k, v] of Object.entries(data)) if (v) observers[k] = v;
  observers.animationState = state;
  return {
    id, key: `k:${state}`, signature: lookSignature(data),
    full: packetManager.spriteSheetAnimation(observers), fullFrames: [{}],
    pose: packetManager.spriteSheetPose({ id, animationState: state }), poseFrames: [{}],
    animationState: state,
  };
}

const poses = (c: { datagrams: Sent[] }) => c.datagrams.flatMap((d) => decodePoseDatagram(d.bytes).map((e) => ({ at: d.at, ...e })));
const kinds = (c: { frames(): any[] }) => c.frames().map((f) => f.type);

beforeEach(() => resetPoseStats());
afterEach(() => poseRepeats.configure({}));

// ---- the client's rule, as the Gateway's posepacket.ts has it: a pose is applied only for a player the client knows,
// ---- and only if its revision is newer than the one shown; a reliable sheet or pose is the new baseline.

function viewerScreen() {
  const shown = new Map<string, { revision: number; state: string }>();
  return {
    shown,
    reliable(id: string, state: string, revision?: number) {
      // As the Gateway's posepacket.ts: a copy with a revision older than the one shown is late and keeps the pose shown.
      const now = shown.get(id);
      if (revision !== undefined && now && revision < now.revision) return;
      shown.set(id, { revision: revision ?? 0, state });
    },
    datagram(bytes: Uint8Array) {
      for (const e of decodePoseDatagram(bytes)) {
        const now = shown.get(e.id);
        if (!now || e.revision <= now.revision) continue;
        shown.set(e.id, { revision: e.revision, state: e.state });
      }
    },
  };
}

describe("a viewer's pose change goes by datagram", () => {
  test("a viewer that holds the look gets a datagram with the pose and revision, and no stream frame", async () => {
    const w = world(3);
    broadcastPoseToAOI(w.source, look());
    await tick();
    for (const v of w.viewers) expect(kinds(v)).toEqual(["SPRITE_SHEET_ANIMATION"]);
    const framesBefore = w.viewers.map((v) => v.stream.length);

    broadcastPoseToAOI(w.source, look("idle_down"));
    await tick();
    w.viewers.forEach((v, i) => {
      expect(v.stream.length).toBe(framesBefore[i]);
      expect(kinds(v)).not.toContain("SPRITE_SHEET_POSE");
      const sent = v.datagrams.filter((d) => d.bytes[0] === POSE_DATAGRAM_HEADER);
      expect(sent.length).toBe(1);
      expect(poses(v).at(-1)).toMatchObject({ id: "1", revision: 2, state: "idle_down" });
    });
    // The source's own connection is sent nothing here (its copy is the receiver's).
    expect(w.self.datagrams.length).toBe(0);
    expect(w.self.stream.length).toBe(0);
  });

  test("a datagram is within the datagram size and starts with its own header", () => {
    const w = world(1);
    broadcastPoseToAOI(w.source, look());
    broadcastPoseToAOI(w.source, look("cast_walk_downright"));
    const d = w.viewers[0].datagrams[0].bytes;
    expect(d[0]).toBe(0x05);
    expect(d.length).toBeLessThanOrEqual(1200);
    expect(d.length).toBe(3 + 9 + "cast_walk_downright".length);
  });

  test("the counters tell stream pose frames from datagram sends and repeats", () => {
    const w = world(2);
    broadcastPoseToAOI(w.source, look());
    expect(getPoseStats()).toMatchObject({ full: 2, poseOnly: 0, datagram: 0, datagramRepeats: 0 });
    broadcastPoseToAOI(w.source, look("idle_down"));
    expect(getPoseStats()).toMatchObject({ full: 2, poseOnly: 0, datagram: 2, datagramRepeats: 0 });
    w.time.advance(100);
    expect(getPoseStats()).toMatchObject({ poseOnly: 0, datagram: 2, datagramRepeats: 2 });
    w.time.advance(300);
    expect(getPoseStats()).toMatchObject({ datagram: 2, datagramRepeats: 4 });
    w.time.advance(1100);
    expect(getPoseStats()).toMatchObject({ datagram: 2, datagramRepeats: 6 });
  });

  test("a connection that takes no datagrams, or a pose that has no record, still gets the stream frame", async () => {
    const w = world(2);
    broadcastPoseToAOI(w.source, look());
    const got: string[] = [];
    // A stand-in without the datagram path (an older fake, a connection type that has none): the pose goes on the stream as before.
    const plain: any = { readyState: 1, send: () => {}, sendFramed: (p: Uint8Array) => got.push(JSON.parse(dec.decode(p)).type) };
    const late = w.make("300", 20, plain);
    late.aoi.playersInAOI.add("1");
    aoiReverse.addViewer("1", "300");
    broadcastPoseToAOI(w.source, look());
    got.length = 0;
    broadcastPoseToAOI(w.source, look("idle_down"));
    expect(got).toEqual(["SPRITE_SHEET_POSE"]);
    expect(getPoseStats().poseOnly).toBe(1);

    // No animationState (a caller of the old shape): everything on the stream.
    const old: any = look("idle_left");
    delete old.animationState;
    got.length = 0;
    const before = w.viewers.map((v) => v.datagrams.length);
    broadcastPoseToAOI(w.source, old);
    await tick();
    expect(got).toEqual(["SPRITE_SHEET_POSE"]);
    expect(w.viewers.map((v) => v.datagrams.length)).toEqual(before);
    expect(kinds(w.viewers[0])).toContain("SPRITE_SHEET_POSE");

    // A player id that does not fit the datagram's u32 has no record: the broadcast takes the stream.
    expect(encodePoseRecord("not-a-number", 1, "walk_down")).toBeNull();
    const odd = world(1);
    const oddLook: any = look("walk_down", {}, "not-a-number");
    broadcastPoseToAOI(odd.source, oddLook);
    const sentBefore = odd.viewers[0].datagrams.length;
    broadcastPoseToAOI(odd.source, oddLook);
    expect(odd.viewers[0].datagrams.length).toBe(sentBefore);
    expect(poseRepeats.size).toBe(0);
  });
});

describe("what a client needs to see a player for the first time stays reliable", () => {
  test("a viewer that does not hold the look (spawn, entering the view, a changed look) gets the full sheet on the stream", async () => {
    const w = world(1);
    broadcastPoseToAOI(w.source, look());
    await tick();
    expect(kinds(w.viewers[0])).toEqual(["SPRITE_SHEET_ANIMATION"]);
    expect(w.viewers[0].datagrams.length).toBe(0);

    // A viewer entering the view later: the full sheet, not a datagram pose.
    const late = w.addViewer("300", 20);
    broadcastPoseToAOI(w.source, look("idle_left"));
    await tick();
    expect(kinds(late)).toEqual(["SPRITE_SHEET_ANIMATION"]);
    expect(late.datagrams.length).toBe(0);
    // The one that held the look got the datagram.
    expect(poses(w.viewers[0]).map((p) => p.state)).toEqual(["idle_left"]);

    // A changed look (equipment, mount): the full sheet again, for everyone.
    const sword = { armorWeaponSprite: sheet("sword") };
    broadcastPoseToAOI(w.source, look("idle_left", sword));
    await tick();
    expect(kinds(w.viewers[0])).toEqual(["SPRITE_SHEET_ANIMATION", "SPRITE_SHEET_ANIMATION"]);
    expect(kinds(late)).toEqual(["SPRITE_SHEET_ANIMATION", "SPRITE_SHEET_ANIMATION"]);
  });

  test("the player's own copy and the mirror relay stay as they were", async () => {
    const relayed: Array<{ kind: string; id: string; packets: any[] }> = [];
    const original = (ghosts as any).relay;
    (ghosts as any).relay = (kind: string, id: string, packets: any[]) => { relayed.push({ kind, id, packets }); };
    try {
      const w = world(2);
      const first = look();
      broadcastPoseToAOI(w.source, first);
      const second = look("idle_down");
      broadcastPoseToAOI(w.source, second);
      await tick();
      // The relay gets the full packet of each change, whatever the local viewers got.
      expect(relayed.map((r) => [r.kind, r.id])).toEqual([["player", "1"], ["player", "1"]]);
      expect(relayed[0].packets).toBe(first.full);
      expect(relayed[1].packets).toBe(second.full);
      // The relay is not a datagram: the only datagrams are the local viewers'.
      expect(w.viewers.every((v) => poses(v).length === 1)).toBe(true);
      expect(w.self.datagrams.length).toBe(0);
    } finally {
      (ghosts as any).relay = original;
    }
  });

  test("a mirror's pose is the owner's, relayed: no datagram, no revision of this node", async () => {
    const w = world(1);
    w.source.remote = true;
    broadcastPoseToAOI(w.source, look());
    const before = w.source.poseRev;
    broadcastPoseToAOI(w.source, look("idle_down"));
    await tick();
    expect(w.viewers[0].datagrams.length).toBe(0);
    expect(kinds(w.viewers[0]).at(-1)).toBe("SPRITE_SHEET_POSE");
    expect(w.source.poseRev).toBe(before);
    expect(before).toBeUndefined();
    expect(poseRepeats.size).toBe(0);
  });

  test("the own copy of sendSpriteSheetAnimation rides the stream and the viewers' copy the datagram", async () => {
    // sendSpriteSheetAnimation lives in the receiver, which a test cannot import: cut out and run as packet-srv.test.ts does.
    const source = readFileSync(join(import.meta.dir, "..", "socket", "receiver.ts"), "utf8").replace(/\r\n/g, "\n");
    const from = source.indexOf("/** The layer fields of a SPRITE_SHEET_ANIMATION packet");
    const to = source.indexOf("async function sendAnimation(");
    if (from < 0 || to <= from) throw new Error("the pose code was not found in receiver.ts");
    const names = ["playerCache", "equipmentSheetsToken", "getPlayerSpriteSheetData", "getMountSpriteUrl", "packetManager", "sendPacket", "broadcastPoseToAOI", "lookSignature", "log", "drawnEquipment", "notePoseCall", "notePoseSelf"];
    const make = new Function(`"use strict";
${new Bun.Transpiler({ loader: "ts" }).transformSync(`function make({ ${names.join(", ")} }: any) {
${source.slice(from, to).replace(/^export /gm, "")}
return { sendSpriteSheetAnimation };
}`)}
return make;`)() as (given: Record<string, any>) => { sendSpriteSheetAnimation: (...a: any[]) => Promise<void> };

    const w = world(2);
    const token = {};
    const pose = make({
      playerCache: { get: () => w.source },
      equipmentSheetsToken: () => token,
      getPlayerSpriteSheetData: async (animation: string) => ({ bodySprite: sheet("body"), headSprite: sheet("head"), animationState: animation.replace(/^player_/, "").replace(/\.png$/, "") }),
      getMountSpriteUrl: () => null,
      packetManager,
      sendPacket: (wt: any, packets: any[]) => { for (const p of packets) wt.send(p); },
      broadcastPoseToAOI,
      lookSignature,
      log: { warn: () => {}, debug: () => {} },
      drawnEquipment: () => null,
      notePoseCall,
      notePoseSelf,
    });

    await pose.sendSpriteSheetAnimation(w.source.wt, "player_walk_down.png");
    await tick();
    // First: the own copy and the full sheet of each viewer, all on the stream, no datagram.
    expect(kinds(w.self)).toEqual(["SPRITE_SHEET_ANIMATION"]);
    for (const v of w.viewers) { expect(kinds(v)).toEqual(["SPRITE_SHEET_ANIMATION"]); expect(v.datagrams.length).toBe(0); }

    await pose.sendSpriteSheetAnimation(w.source.wt, "player_idle_left.png");
    await tick();
    // The own copy is a stream frame again; the viewers' copy is a datagram.
    expect(kinds(w.self)).toEqual(["SPRITE_SHEET_ANIMATION", "SPRITE_SHEET_ANIMATION"]);
    expect(w.self.datagrams.length).toBe(0);
    for (const v of w.viewers) {
      expect(kinds(v)).toEqual(["SPRITE_SHEET_ANIMATION"]);
      expect(poses(v).at(-1)).toMatchObject({ id: "1", state: "idle_left", revision: 2 });
    }
  });

  test("no other code sends a pose by datagram: spawn, entering the view and a landing have no such call", () => {
    const root = join(import.meta.dir, "..");
    const users: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { if (name !== "tests" && name !== "node_modules") walk(path); continue; }
        if (name.endsWith(".ts") && /sendPoseRecords/.test(readFileSync(path, "utf8"))) users.push(path.slice(root.length + 1).replace(/\\/g, "/"));
      }
    };
    walk(root);
    expect(users.sort()).toEqual(["socket/aoi.ts", "socket/posedgram.ts", "socket/transport.ts"]);
    // And inside aoi.ts it is the pose broadcast that calls it: the nearest function above the call is broadcastPoseToAOI.
    const aoi = readFileSync(join(root, "socket", "aoi.ts"), "utf8").replace(/\r\n/g, "\n");
    const at = aoi.indexOf(".sendPoseRecords(");
    const above = aoi.slice(0, at);
    expect(above.lastIndexOf("\nexport function broadcastPoseToAOI")).toBe(above.lastIndexOf("\nexport function "));
    expect(aoi.indexOf(".sendPoseRecords(", aoi.indexOf(".sendPoseRecords(") + 1)).toBe(-1);
  });
});

describe("the repeat schedule", () => {
  test("the schedule is three repeats, at 100, 400 and 1500 ms", () => {
    expect([...POSE_REPEAT_MS]).toEqual([100, 400, 1500]);
  });

  test("the current pose and revision go again at 100, 400 and 1500 ms to the same viewers, and then stop", () => {
    const w = world(2);
    broadcastPoseToAOI(w.source, look());
    broadcastPoseToAOI(w.source, look("walk_up"));
    const t0 = w.time.now();
    for (const v of w.viewers) expect(poses(v).map((p) => p.at - t0)).toEqual([0]);

    w.time.advance(99);
    for (const v of w.viewers) expect(poses(v).length).toBe(1);
    w.time.advance(1);
    for (const v of w.viewers) expect(poses(v).map((p) => p.at - t0)).toEqual([0, 100]);
    w.time.advance(299);
    for (const v of w.viewers) expect(poses(v).length).toBe(2);
    w.time.advance(1);
    for (const v of w.viewers) expect(poses(v).map((p) => p.at - t0)).toEqual([0, 100, 400]);
    w.time.advance(1099);
    for (const v of w.viewers) expect(poses(v).length).toBe(3);
    w.time.advance(1);
    for (const v of w.viewers) {
      expect(poses(v).map((p) => p.at - t0)).toEqual([0, 100, 400, 1500]);
      for (const p of poses(v)) expect(p).toMatchObject({ id: "1", revision: 2, state: "walk_up" });
    }
    // Bounded: nothing more, and nothing left pending.
    w.time.advance(60_000);
    for (const v of w.viewers) expect(poses(v).length).toBe(4);
    expect(poseRepeats.size).toBe(0);
    expect(w.time.pending()).toBe(0);
  });

  test("a newer change cancels the repeats of the older one: only the newest pose and revision are repeated", () => {
    const w = world(2);
    broadcastPoseToAOI(w.source, look());
    broadcastPoseToAOI(w.source, look("walk_up"));
    const t0 = w.time.now();
    w.time.advance(50);
    broadcastPoseToAOI(w.source, look("idle_up"));
    w.time.advance(1000);
    for (const v of w.viewers) {
      const got = poses(v);
      expect(got.map((p) => [p.at - t0, p.revision, p.state])).toEqual([
        [0, 2, "walk_up"],
        [50, 3, "idle_up"],
        [150, 3, "idle_up"],
        [450, 3, "idle_up"],
      ]);
    }
  });

  test("a change that reaches no datagram viewer still stops the older repeats", () => {
    const w = world(1);
    broadcastPoseToAOI(w.source, look());
    broadcastPoseToAOI(w.source, look("walk_up"));
    expect(poseRepeats.size).toBe(1);
    // The look changes: the viewer is sent the full sheet and is repeated to as well, with the new revision.
    broadcastPoseToAOI(w.source, look("idle_up", { armorWeaponSprite: sheet("sword") }));
    w.time.advance(1000);
    const got = poses(w.viewers[0]);
    expect(got.map((p) => [p.revision, p.state])).toEqual([[2, "walk_up"], [3, "idle_up"], [3, "idle_up"]]);
    // The viewer leaves the view, then the player changes pose: nobody to repeat to, nothing pending.
    w.viewers[0].wt.readyState = 3;
    broadcastPoseToAOI(w.source, look("walk_left", { armorWeaponSprite: sheet("sword") }));
    expect(poseRepeats.size).toBe(0);
  });

  test("a repeat is not sent to a viewer who left the view, closed the connection, or after the player is gone", () => {
    const w = world(3);
    broadcastPoseToAOI(w.source, look());
    broadcastPoseToAOI(w.source, look("walk_up"));
    // viewer 0 left the view; viewer 1 closed; viewer 2 stays.
    aoiReverse.removeViewer("1", w.viewers[0].id);
    w.viewers[1].wt.readyState = 3;
    w.time.advance(100);
    expect(poses(w.viewers[0]).length).toBe(1);
    expect(poses(w.viewers[1]).length).toBe(1);
    expect(poses(w.viewers[2]).length).toBe(2);
    // The player logs out (or is handed off): the 400 ms repeat is dropped.
    playerCache.remove("1");
    w.time.advance(400);
    expect(poses(w.viewers[2]).length).toBe(2);
    expect(poseRepeats.size).toBe(0);
  });

  test("a player handed off stops repeating, even while the old record is still in the cache", () => {
    const w = world(1);
    broadcastPoseToAOI(w.source, look());
    broadcastPoseToAOI(w.source, look("walk_up"));
    w.source.handedOff = true;
    w.time.advance(1000);
    expect(poses(w.viewers[0]).length).toBe(1);
  });

  test("repeats of several players due together leave a connection as one datagram of whole records", () => {
    const w = world(1);
    const others = ["2", "3", "4"].map((id) => {
      const p = w.make(id, 5, null);
      aoiReverse.addViewer(id, w.viewers[0].id);
      w.viewers[0] && playerCache.get(w.viewers[0].id).aoi.playersInAOI.add(id);
      return p;
    });
    for (const p of [w.source, ...others]) {
      broadcastPoseToAOI(p, look("walk_down", {}, String(p.id)));
      broadcastPoseToAOI(p, look("idle_down", {}, String(p.id)));
    }
    const sent = w.viewers[0].datagrams.length;
    expect(sent).toBe(4);
    w.time.advance(100);
    // One datagram carries the four repeats.
    expect(w.viewers[0].datagrams.length).toBe(sent + 1);
    const repeat = decodePoseDatagram(w.viewers[0].datagrams.at(-1)!.bytes);
    expect(repeat.map((p) => p.id).sort()).toEqual(["1", "2", "3", "4"]);
    expect(new Set(repeat.map((p) => p.state))).toEqual(new Set(["idle_down"]));
  });
});

describe("a lost datagram is repaired", () => {
  // Four sends per viewer: with the change, at 100, 400 and 1500 ms. Drop all but one; the viewer ends on the current pose.
  for (const survivor of [0, 1, 2, 3]) {
    test(`only send ${survivor} (of 0 change, 1 at 100 ms, 2 at 400 ms, 3 at 1500 ms) gets through: the viewer shows the current pose`, () => {
      const w = world(2, (_v, n) => n !== survivor);
      const screens = w.viewers.map(() => viewerScreen());
      broadcastPoseToAOI(w.source, look());
      screens.forEach((s) => s.reliable("1", "walk_down"));
      broadcastPoseToAOI(w.source, look("idle_right"));
      w.time.advance(2000);
      w.viewers.forEach((v, i) => {
        expect(v.datagrams.length).toBe(4);
        for (const d of v.datagrams) if (!d.lost) screens[i].datagram(d.bytes);
        expect(screens[i].shown.get("1")).toEqual({ revision: 2, state: "idle_right" });
      });
    });
  }

  test("the last repeat is at 1500 ms: a viewer converges within it, and with every datagram lost it keeps the old pose until the next change", () => {
    const w = world(1, () => true);
    const screen = viewerScreen();
    broadcastPoseToAOI(w.source, look());
    screen.reliable("1", "walk_down");
    broadcastPoseToAOI(w.source, look("idle_right"));
    w.time.advance(10_000);
    const sends = w.viewers[0].datagrams;
    expect(sends.map((d) => d.at - sends[0].at)).toEqual([0, 100, 400, 1500]);
    for (const d of sends) if (!d.lost) screen.datagram(d.bytes);
    expect(screen.shown.get("1")).toEqual({ revision: 0, state: "walk_down" });

    // The next change repairs it.
    w.viewers[0].session.datagrams.sendSync = (p: Uint8Array) => screen.datagram(p);
    broadcastPoseToAOI(w.source, look("walk_left"));
    expect(screen.shown.get("1")).toEqual({ revision: 3, state: "walk_left" });
  });

  test("a late older datagram, a duplicate and reordered ones never put an older pose back", () => {
    const w = world(1);
    const screen = viewerScreen();
    broadcastPoseToAOI(w.source, look());
    screen.reliable("1", "walk_down");
    broadcastPoseToAOI(w.source, look("walk_up"));
    w.time.advance(30);
    broadcastPoseToAOI(w.source, look("idle_up"));
    w.time.advance(2000);
    const datagrams = w.viewers[0].datagrams.map((d) => d.bytes);
    // Deliver in the worst order: newest first, then everything else reversed and doubled.
    const newest = datagrams.filter((d) => decodePoseDatagram(d)[0].revision === 3);
    const older = datagrams.filter((d) => decodePoseDatagram(d)[0].revision === 2);
    expect(newest.length).toBe(4);
    expect(older.length).toBe(1);
    screen.datagram(newest[0]);
    for (const d of [...older, ...newest, ...older, ...newest].reverse()) screen.datagram(d);
    expect(screen.shown.get("1")).toEqual({ revision: 3, state: "idle_up" });
  });
});

describe("the stream copies of a viewer's pose carry the revision", () => {
  const streamed = (c: { frames(): any[] }) => c.frames().filter((f) => f.type === "SPRITE_SHEET_ANIMATION" || f.type === "SPRITE_SHEET_POSE");
  // The receiver builds them with withRevision; here it stands in with the same packets.
  const withRevision = (id: string, state: string, extra: Record<string, any> = {}) => (poseRev: number) => {
    const data: any = { id, bodySprite: sheet("body"), headSprite: sheet("head"), animationState: state, ...extra };
    return {
      full: packetManager.spriteSheetAnimation({ ...data, poseRev }),
      pose: packetManager.spriteSheetPose({ id, animationState: state, poseRev }),
    };
  };

  test("a full sheet sent to a viewer that does not hold the look carries the revision of the datagram viewers", async () => {
    const w = world(2);
    broadcastPoseToAOI(w.source, { ...look(), withRevision: withRevision("1", "walk_down") });
    await tick();
    for (const v of w.viewers) expect(streamed(v).map((f) => [f.type, f.data.poseRev])).toEqual([["SPRITE_SHEET_ANIMATION", 1]]);
    // A viewer that enters the view later is sent the sheet with the new revision; the others the datagram of that revision.
    const late = w.addViewer("300", 20);
    broadcastPoseToAOI(w.source, { ...look("idle_left"), withRevision: withRevision("1", "idle_left") });
    await tick();
    expect(streamed(late).map((f) => [f.type, f.data.poseRev, f.data.animationState])).toEqual([["SPRITE_SHEET_ANIMATION", 2, "idle_left"]]);
    expect(poses(w.viewers[0]).map((p) => p.revision)).toEqual([2]);
    expect(streamed(w.viewers[0]).length).toBe(1);
  });

  test("a stream pose (a connection without datagrams) carries the revision too", async () => {
    const w = world(1);
    broadcastPoseToAOI(w.source, { ...look(), withRevision: withRevision("1", "walk_down") });
    const got: any[] = [];
    const plain: any = { readyState: 1, send: () => {}, sendFramed: (p: Uint8Array) => got.push(JSON.parse(dec.decode(p))) };
    const other = w.make("300", 20, plain);
    other.aoi.playersInAOI.add("1");
    aoiReverse.addViewer("1", "300");
    broadcastPoseToAOI(w.source, { ...look(), withRevision: withRevision("1", "walk_down") });
    got.length = 0;
    broadcastPoseToAOI(w.source, { ...look("idle_down"), withRevision: withRevision("1", "idle_down") });
    expect(got.map((f) => [f.type, f.data.poseRev])).toEqual([["SPRITE_SHEET_POSE", 3]]);
  });

  test("the packets are built once per change and only when a viewer needs one; the relay and the self copy stay as they are", async () => {
    const relayed: any[][] = [];
    const original = (ghosts as any).relay;
    (ghosts as any).relay = (_k: string, _id: string, packets: any[]) => { relayed.push(packets); };
    try {
      const w = world(3);
      let built = 0;
      const counting = (state: string) => { const f = withRevision("1", state); return (rev: number) => { built++; return f(rev); }; };
      const first = { ...look(), withRevision: counting("walk_down") };
      broadcastPoseToAOI(w.source, first);
      expect(built).toBe(1);
      // Every viewer holds the look: datagrams only, nothing built.
      broadcastPoseToAOI(w.source, { ...look("idle_down"), withRevision: counting("idle_down") });
      expect(built).toBe(1);
      expect(relayed[0]).toBe(first.full);
      expect(relayed[0].length).toBe(1);
      expect(JSON.parse(dec.decode(relayed[0][0])).data.poseRev).toBeUndefined();
      // A pose with no record (no animationState): not revised.
      const noRecord: any = { ...look("idle_left"), withRevision: counting("idle_left") };
      delete noRecord.animationState;
      broadcastPoseToAOI(w.source, noRecord);
      expect(built).toBe(1);
    } finally {
      (ghosts as any).relay = original;
    }
  });

  test("a late sheet of change N behind the datagram of N+1 leaves the viewer on N+1 (the reference screen)", async () => {
    const w = world(1);
    const screen = viewerScreen();
    broadcastPoseToAOI(w.source, look());
    screen.reliable("1", "walk_down", 0);
    // N: a look change, sent as a sheet on the stream with revision 2; N+1: a pose datagram with revision 3.
    broadcastPoseToAOI(w.source, { ...look("walk_up", { armorWeaponSprite: sheet("sword") }), withRevision: withRevision("1", "walk_up") });
    broadcastPoseToAOI(w.source, { ...look("idle_up", { armorWeaponSprite: sheet("sword") }), withRevision: withRevision("1", "idle_up") });
    await tick();
    const sheetN = streamed(w.viewers[0]).find((f) => f.data.animationState === "walk_up")!;
    expect(sheetN.data.poseRev).toBe(2);
    w.viewers[0].datagrams.slice(0, 1).forEach((d) => screen.datagram(d.bytes));
    expect(screen.shown.get("1")).toEqual({ revision: 3, state: "idle_up" });
    // The stream delivers the older sheet after the newer datagram: the pose shown stays; no repeat is needed to repair it.
    screen.reliable("1", sheetN.data.animationState, sheetN.data.poseRev);
    expect(screen.shown.get("1")).toEqual({ revision: 3, state: "idle_up" });
  });
});

describe("the revision", () => {
  test("rises by one with each change of a player and is kept on the player", () => {
    const w = world(1);
    expect(w.source.poseRev).toBeUndefined();
    for (let i = 1; i <= 5; i++) {
      broadcastPoseToAOI(w.source, look(i % 2 ? "walk_down" : "idle_down"));
      expect(w.source.poseRev).toBe(i);
    }
  });

  test("never goes down across a handoff: the new node counts on from the old one's", () => {
    // Old node: a player changes pose 7 times, then is handed off with its state.
    const oldNode = world(1);
    for (let i = 0; i < 7; i++) broadcastPoseToAOI(oldNode.source, look(i % 2 ? "idle_down" : "walk_down"));
    const last = oldNode.source.poseRev;
    expect(last).toBe(7);
    // handoffState (socket/server.ts) puts the revision in the state record; the new node's login seeds the player from it.
    const state = JSON.parse(JSON.stringify({ poseRev: oldNode.source.poseRev }));
    const arrived: any = { id: "1", poseRev: arrivedPoseRevision(state) };
    expect(arrived.poseRev).toBe(last);
    const firsts = [nextPoseRevision(arrived), nextPoseRevision(arrived)];
    expect(firsts[0]).toBeGreaterThan(last);
    expect(firsts[1]).toBe(firsts[0] + 1);

    // The old node's repeats of its last change are dropped once the player left it, so no older pose follows the new node's.
    oldNode.source.handedOff = true;
    playerCache.remove("1");
    const before = oldNode.viewers[0].datagrams.length;
    oldNode.time.advance(1000);
    expect(oldNode.viewers[0].datagrams.length).toBe(before);
  });

  test("the arriving revision is checked: only a whole, positive number that fits the datagram counts", () => {
    expect(arrivedPoseRevision({ poseRev: 41 })).toBe(41);
    expect(arrivedPoseRevision({ poseRev: 0xffffffff })).toBe(0xffffffff);
    for (const bad of [undefined, null, "9", -1, 1.5, NaN, Infinity, 0xffffffff + 1, {}]) expect(arrivedPoseRevision({ poseRev: bad })).toBe(0);
    expect(arrivedPoseRevision(undefined)).toBe(0);
    expect(arrivedPoseRevision(null)).toBe(0);
  });

  test("the handoff state carries it and the login seeds it (the wiring, read from the source)", () => {
    const server = readFileSync(join(import.meta.dir, "..", "socket", "server.ts"), "utf8").replace(/\r\n/g, "\n");
    const state = server.slice(server.indexOf("function handoffState("), server.indexOf("function releaseHandedOff("));
    expect(state).toContain("poseRev: Number.isSafeInteger(p.poseRev) && p.poseRev > 0 ? p.poseRev : 0");
    const receiver = readFileSync(join(import.meta.dir, "..", "socket", "receiver.ts"), "utf8").replace(/\r\n/g, "\n");
    expect(receiver).toContain("poseRev: arrival ? arrivedPoseRevision(arrival.snapshot.state) : 0,");
  });

  test("a revision past the datagram's width goes on the stream and stops rising", () => {
    const p: any = { poseRev: 0xffffffff };
    expect(nextPoseRevision(p)).toBe(0x100000000);
    expect(nextPoseRevision(p)).toBe(0x100000000);
    expect(encodePoseRecord("1", 0x100000000, "walk_down")).toBeNull();
  });
});

describe("the datagram", () => {
  test("a record round-trips, in UTF-8, and many records are packed into datagrams of whole records within the size", () => {
    const records = Array.from({ length: 200 }, (_, i) => encodePoseRecord(String(i + 1), i + 7, i % 2 ? "mount_unicorn_walk_downright" : "idle_up")!);
    expect(records.every((r) => r !== null)).toBe(true);
    const packed = packPoseRecords(records, 1200);
    expect(packed.length).toBeGreaterThan(1);
    for (const d of packed) { expect(d.length).toBeLessThanOrEqual(1200); expect(d[0]).toBe(0x05); }
    const back = packed.flatMap((d) => decodePoseDatagram(d));
    expect(back.length).toBe(200);
    expect(back.map((e) => [e.id, e.revision])).toEqual(records.map((_, i) => [String(i + 1), i + 7]));
    expect(back[1].state).toBe("mount_unicorn_walk_downright");
    // Cut short or not a pose datagram: nothing, no throw.
    expect(decodePoseDatagram(packed[0].subarray(0, 7))).toEqual([]);
    expect(decodePoseDatagram(new Uint8Array([0x01, 0, 0]))).toEqual([]);
    expect(decodePoseDatagram(new Uint8Array(0))).toEqual([]);
  });

  test("a field outside its width has no record", () => {
    expect(encodePoseRecord("4294967296", 1, "walk_down")).toBeNull();
    expect(encodePoseRecord("12ab", 1, "walk_down")).toBeNull();
    expect(encodePoseRecord("1", -1, "walk_down")).toBeNull();
    expect(encodePoseRecord("1", 1, "")).toBeNull();
    expect(encodePoseRecord("1", 1, "x".repeat(256))).toBeNull();
    expect(encodePoseRecord("4294967295", 4294967295, "x".repeat(255))).not.toBeNull();
  });

  test("the connection sends a pose datagram only while open, one native call for one datagram and a batch for more", () => {
    const time = clock();
    const c = connection(time);
    expect(c.wt.sendPoseRecords([])).toBe(false);
    const r = encodePoseRecord("1", 1, "walk_down")!;
    expect(c.wt.sendPoseRecords([r])).toBe(true);
    expect(c.datagrams.length).toBe(1);
    const many = Array.from({ length: 100 }, () => r);
    let batches = 0;
    c.session.datagrams.sendSyncBatch = (ps: Uint8Array[]) => { batches++; ps.forEach((p) => c.datagrams.push({ at: 0, bytes: p, lost: false })); };
    expect(c.wt.sendPoseRecords(many)).toBe(true);
    expect(batches).toBe(1);
    expect(c.datagrams.length).toBeGreaterThan(2);
    expect(c.datagrams.every((d) => d.bytes.length <= 1200)).toBe(true);
    c.wt.readyState = 3;
    expect(c.wt.sendPoseRecords([r])).toBe(false);
    expect(c.stream.length).toBe(0);
  });
});

describe("the repeat clock", () => {
  test("the default clock is the monotonic performance.now(), not the wall clock a VM or NTP step moves", () => {
    let monotonic = 5_000;
    const performanceNow = spyOn(performance, "now").mockImplementation(() => monotonic);
    // The wall clock jumps far ahead (a VM resume, an NTP step): the repeats must not notice.
    const dateNow = spyOn(Date, "now").mockImplementation(() => 9_000_000_000_000);
    try {
      const sent: Uint8Array[][] = [];
      const wt = { readyState: 1, sendPoseRecords: (records: Uint8Array[]) => { sent.push(records); return true; } };
      let armed: { fn: () => void; ms: number } | null = null;
      // No `now`: the repeater uses its default clock. Everything else is injected.
      const repeater = new PoseRepeater({
        setTimer: (fn, ms) => { armed = { fn, ms }; return armed; },
        clearTimer: () => {},
        live: () => true,
        viewer: () => ({ wt }),
        sees: () => true,
      }, [100, 400]);
      const record = new Uint8Array([1, 2, 3]);
      repeater.schedule({ id: "p1", poseRev: 7 }, 7, record, ["v1"]);
      // The first repeat is due 100 ms after the change on the monotonic clock.
      expect(armed!.ms).toBe(100);
      monotonic += 99;
      repeater.run();
      expect(sent.length).toBe(0);
      monotonic += 1;
      repeater.run();
      expect(sent.length).toBe(1);
      expect(sent[0]![0]).toBe(record);
      // The second is due 400 ms after the change, again on the same clock.
      monotonic += 299;
      repeater.run();
      expect(sent.length).toBe(1);
      monotonic += 1;
      repeater.run();
      expect(sent.length).toBe(2);
      expect(performanceNow).toHaveBeenCalled();
    } finally {
      performanceNow.mockRestore();
      dateNow.mockRestore();
    }
  });
});
