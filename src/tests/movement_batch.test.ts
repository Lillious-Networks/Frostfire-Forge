import { expect, test } from "bun:test";
import {
  applyReceiverDiffs,
  collectGroupReceivers,
  collectReceiverEntries,
  indexMovers,
  mergeFlushRequests,
  mergeReceiverDiffs,
  type ReceiverDiff,
  encodeBatch,
  DIRECTION_MAP,
  MAX_DATAGRAM_SIZE,
  type MoverSnapshot,
  type ReceiverInfo,
} from "../socket/movement_batch";

function buildEntries(count: number): any[] {
  const entries: any[] = [];
  for (let i = 0; i < count; i++) {
    entries.push({
      id: 1000 + i,
      x: i * 3,
      y: -i * 2,
      direction: DIRECTION_MAP[["up", "down", "left", "right", "upleft", "upright", "downleft", "downright"][i % 8]],
      stealth: i % 2,
    });
  }
  return entries;
}

test("encodeBatch with probe keeps every frame within MAX_DATAGRAM_SIZE", () => {
  const entries = buildEntries(500);
  const serverSendTime = Date.now();
  const { offsets } = encodeBatch(entries, { seq: 7, serverSendTime });

  expect(offsets.length).toBeGreaterThan(1);
  for (let i = 0; i < offsets.length - 1; i++) {
    const frameLength = offsets[i + 1] - offsets[i];
    expect(frameLength).toBeLessThanOrEqual(MAX_DATAGRAM_SIZE);
  }
});

test("encodeBatch probe roundtrips seq + seconds/ms timestamp", () => {
  const entries = buildEntries(200);
  const serverSendTime = 1786706395136;
  const { data, offsets } = encodeBatch(entries, { seq: 41, serverSendTime });

  let parsedFrames = 0;
  for (let i = 0; i < offsets.length - 1; i++) {
    const frame = new Uint8Array(data.buffer, data.byteOffset + offsets[i], offsets[i + 1] - offsets[i]);

    expect(frame[0]).toBe(0x01);

    const view = new DataView(frame.buffer, frame.byteOffset);
    const count = view.getUint16(1, true);
    const entriesEnd = 3 + count * 13;

    expect(frame.length).toBe(entriesEnd + 10);

    const seq = view.getUint32(entriesEnd, true);
    const seconds = view.getUint32(entriesEnd + 4, true);
    const ms = view.getUint16(entriesEnd + 8, true);

    expect(seq).toBe(41 + i);
    expect(seconds * 1000 + ms).toBe(serverSendTime);
    parsedFrames++;
  }

  expect(parsedFrames).toBe(offsets.length - 1);
});

test("encodeBatch without probe uses the 13-byte-stride layout (32-bit positions)", () => {
  const entries = buildEntries(5);
  const { data, offsets } = encodeBatch(entries);

  expect(offsets.length).toBe(2);
  const frame = new Uint8Array(data.buffer, data.byteOffset + offsets[0], offsets[1] - offsets[0]);
  const view = new DataView(frame.buffer, frame.byteOffset);

  expect(view.getUint16(1, true)).toBe(5);
  expect(frame.length).toBe(3 + 5 * 13);
});

test("encodeBatch positions past 32767 px do not wrap", () => {
  const { data, offsets } = encodeBatch([{ id: 1, x: 40000, y: 163000, direction: 3, stealth: 0 }]);
  const view = new DataView(data.buffer, data.byteOffset + offsets[0]);
  expect(view.getUint32(3, true)).toBe(1);
  expect(view.getInt32(7, true)).toBe(40000);
  expect(view.getInt32(11, true)).toBe(163000);
  expect(view.getUint8(15)).toBe(3);
});

// Distance tiering: a far mover is sent on one tick in every `farEvery`.
const NEAR = 500;
const receiver: ReceiverInfo = { x: 0, y: 0, isAdmin: false, username: "viewer" };

function mover(id: number, x: number, party: string[] = []): MoverSnapshot {
  return { id: String(id), x, y: 0, direction: "down", stealth: false, vanished: false, party };
}

function ticksSent(m: MoverSnapshot, info: ReceiverInfo, farEvery: number, ticks = 12): number[] {
  const sent: number[] = [];
  for (let tick = 0; tick < ticks; tick++) {
    const entries = collectReceiverEntries(new Set([m.id]), [m], info, tick, NEAR, farEvery);
    if (entries.length > 0) sent.push(tick);
  }
  return sent;
}

test("a far mover is sent on exactly one of every FAR_UPDATE_EVERY consecutive ticks", () => {
  for (const id of [1, 2, 3, 4, 100]) {
    const sent = ticksSent(mover(id, 5000), receiver, 3, 12);
    expect(sent.length).toBe(4);
    for (let start = 0; start + 3 <= 12; start++) {
      expect(sent.filter((t) => t >= start && t < start + 3).length).toBe(1);
    }
  }
});

test("movers at different ids are staggered across ticks", () => {
  const first = ticksSent(mover(3, 5000), receiver, 3, 3);
  const second = ticksSent(mover(4, 5000), receiver, 3, 3);
  expect(first).not.toEqual(second);
});

test("a near mover is sent on every tick", () => {
  expect(ticksSent(mover(7, 100), receiver, 3, 9).length).toBe(9);
  expect(ticksSent(mover(7, NEAR), receiver, 3, 9).length).toBe(9);
});

test("a far party member is sent on every tick", () => {
  const member = mover(8, 5000, ["viewer"]);
  expect(ticksSent(member, receiver, 3, 9).length).toBe(9);
});

test("a far mover that is the receiver's target is sent on every tick", () => {
  const target = mover(9, 5000);
  expect(ticksSent(target, { ...receiver, targetId: "9" }, 3, 9).length).toBe(9);
  expect(ticksSent(target, { ...receiver, targetId: "10" }, 3, 9).length).toBe(3);
});

test("FAR_UPDATE_EVERY of 1 sends a far mover on every tick", () => {
  expect(ticksSent(mover(11, 5000), receiver, 1, 9).length).toBe(9);
});

test("tierDistance 0 disables tiering", () => {
  const far = mover(12, 5000);
  for (let tick = 0; tick < 6; tick++) {
    expect(collectReceiverEntries(new Set([far.id]), [far], receiver, tick, 0, 3).length).toBe(1);
  }
});

test("a far mover's final stop position is sent on an off-slot tick", () => {
  const stopped = { ...mover(13, 5000), final: true };
  expect(ticksSent(stopped, receiver, 3, 9).length).toBe(9);
  // The same mover without the flag is throttled.
  expect(ticksSent(mover(13, 5000), receiver, 3, 9).length).toBe(3);
});

test("collectGroupReceivers returns the movers and everyone who sees one, once each", () => {
  const viewers: Record<string, string[]> = { "1": ["2", "3"], "2": ["3", "4"], "5": [] };
  const receivers = collectGroupReceivers(["1", "2", "5"], (id) => viewers[id] ?? []);
  expect(new Set(receivers)).toEqual(new Set(["1", "2", "3", "4", "5"]));
  expect(receivers.length).toBe(5);
  // A player who sees no mover is never visited.
  expect(receivers).not.toContain("9");
});

test("collectGroupReceivers is empty without movers", () => {
  expect(collectGroupReceivers([], () => ["1"])).toEqual([]);
});

test("a snapshot diff replaces the set, a plain diff edits it", () => {
  const sets = new Map<string, Set<string>>([["1", new Set(["1", "2", "stale"])]]);
  applyReceiverDiffs(sets, [{ playerId: "1", add: ["1", "3"], remove: [], replace: true }]);
  expect([...sets.get("1")!].sort()).toEqual(["1", "3"]);
  applyReceiverDiffs(sets, [{ playerId: "1", add: ["4"], remove: ["3"] }, { playerId: "2", add: ["2"], remove: [] }]);
  expect([...sets.get("1")!].sort()).toEqual(["1", "4"]);
  expect([...sets.get("2")!]).toEqual(["2"]);
});

test("merged diffs have the same effect as applying both lists in order", () => {
  const cases: Array<[ReceiverDiff[], ReceiverDiff[]]> = [
    [[{ playerId: "1", add: ["a", "b"], remove: [], replace: true }], [{ playerId: "1", add: ["c"], remove: ["a"] }]],
    [[{ playerId: "1", add: ["a"], remove: ["b"] }], [{ playerId: "1", add: ["b"], remove: ["a"] }]],
    [[{ playerId: "1", add: ["a"], remove: ["x"] }], [{ playerId: "1", add: ["c"], remove: ["a"] }, { playerId: "2", add: ["z"], remove: [] }]],
    [[{ playerId: "1", add: ["a"], remove: [] }], [{ playerId: "1", add: ["q"], remove: [], replace: true }]],
  ];
  for (const [older, newer] of cases) {
    const start = () => new Map<string, Set<string>>([["1", new Set(["x", "b"])]]);
    const sequential = start();
    applyReceiverDiffs(sequential, older);
    applyReceiverDiffs(sequential, newer);
    const combined = start();
    applyReceiverDiffs(combined, mergeReceiverDiffs(older, newer));
    expect(Object.fromEntries([...combined].map(([k, v]) => [k, [...v].sort()]))).toEqual(
      Object.fromEntries([...sequential].map(([k, v]) => [k, [...v].sort()]))
    );
  }
});

test("coalescing a queued flush keeps its snapshot, diffs, receivers and movers", () => {
  const info = (x: number): ReceiverInfo => ({ x, y: 0, isAdmin: false, username: "u" });
  const older = {
    tick: 4,
    movers: [mover(1, 0), { ...mover(2, 0), final: true }],
    receiverIds: ["1", "2"],
    receiverInfo: { "1": info(1), "2": info(2) } as Record<string, ReceiverInfo>,
    diffs: [{ playerId: "1", add: ["1", "2"], remove: [], replace: true }] as ReceiverDiff[],
  };
  const newer = {
    tick: 5,
    movers: [mover(1, 10)],
    receiverIds: ["1", "3"],
    receiverInfo: { "1": info(10), "3": info(3) } as Record<string, ReceiverInfo>,
    diffs: [{ playerId: "1", add: ["3"], remove: ["2"] }] as ReceiverDiff[],
  };
  const merged = mergeFlushRequests(older, newer);
  expect(merged.tick).toBe(5);
  expect(merged.movers.map((m) => [m.id, m.x, !!m.final]).sort()).toEqual([["1", 10, false], ["2", 0, true]]);
  expect([...merged.receiverIds].sort()).toEqual(["1", "2", "3"]);
  expect(merged.receiverInfo["1"].x).toBe(10);
  const sets = new Map<string, Set<string>>();
  applyReceiverDiffs(sets, merged.diffs);
  expect([...sets.get("1")!].sort()).toEqual(["1", "3"]);
});

// The pre-index algorithm: every mover checked against the receiver's set.
function collectByScan(set: Set<string>, movers: MoverSnapshot[], receiver: ReceiverInfo, tick: number, tierDistance: number, farEvery: number): any[] {
  return collectReceiverEntries(set, movers, receiver, tick, tierDistance, farEvery);
}

test("indexed collectReceiverEntries matches the full scan on a randomized case", () => {
  let seed = 12345;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const directions = Object.keys(DIRECTION_MAP);
  const movers: MoverSnapshot[] = [];
  for (let i = 0; i < 60; i++) {
    movers.push({
      id: String(100 + i * 7),
      x: random() * 2000,
      y: random() * 2000,
      direction: directions[i % directions.length],
      stealth: random() < 0.1,
      vanished: random() < 0.1,
      party: random() < 0.2 ? ["friend"] : [],
      final: random() < 0.1,
    });
  }
  const moverIndex = indexMovers(movers);
  for (let r = 0; r < 200; r++) {
    const set = new Set<string>();
    const size = Math.floor(random() * 80);
    for (let k = 0; k < size; k++) {
      // Some ids in the set are not movers this flush.
      set.add(random() < 0.8 ? movers[Math.floor(random() * movers.length)].id : String(900000 + k));
    }
    const receiver: ReceiverInfo = {
      x: random() * 2000,
      y: random() * 2000,
      isAdmin: random() < 0.1,
      username: random() < 0.3 ? "friend" : "someone",
      targetId: random() < 0.3 ? movers[Math.floor(random() * movers.length)].id : undefined,
    };
    const tick = Math.floor(random() * 10);
    const expected = collectByScan(set, movers, receiver, tick, 500, 3);
    expect(collectReceiverEntries(set, movers, receiver, tick, 500, 3, moverIndex)).toEqual(expected);
  }
});

test("indexed collectReceiverEntries walks the visible set, not every mover", () => {
  const movers: MoverSnapshot[] = [];
  for (let i = 0; i < 2000; i++) {
    movers.push({ id: String(i + 1), x: i, y: i, direction: "down", stealth: false, vanished: false, party: [] });
  }
  const moverIndex = indexMovers(movers);
  const sets: Set<string>[] = [];
  for (let r = 0; r < 5000; r++) {
    const set = new Set<string>();
    for (let k = 0; k < 150; k++) set.add(String(((r * 13 + k * 17) % 2000) + 1));
    sets.push(set);
  }
  const receiver: ReceiverInfo = { x: 0, y: 0, isAdmin: false, username: "r" };

  // The mover list is never iterated when the set is the smaller side.
  let iterated = 0;
  const counting = new Proxy(movers, {
    get(target, key, receiverProxy) {
      if (key === Symbol.iterator) iterated++;
      return Reflect.get(target, key, receiverProxy);
    },
  });
  collectReceiverEntries(sets[0], counting, receiver, 0, 500, 3, moverIndex);
  expect(iterated).toBe(0);

  const start = performance.now();
  let total = 0;
  for (const set of sets) total += collectReceiverEntries(set, movers, receiver, 0, 500, 3, moverIndex).length;
  const elapsed = performance.now() - start;
  expect(total).toBeGreaterThan(0);
  // 5,000 receivers x 150 lookups; the full scan would be 10 million checks.
  expect(elapsed).toBeLessThan(2000);
});
