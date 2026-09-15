import { expect, test, describe } from "bun:test";
import {
  claimBatchEntry,
  requeueSpawnBatch,
  claimDespawnEntry,
  requeueDespawnEntry,
} from "../socket/batch_queue_utils";

// Regression tests for the simultaneous-login invisibility race.
//
// `flushSpawnBatches` (receiver.ts) awaits sprite/animation lookups per
// receiver. A second player logging in during that await queues a spawn into
// the same per-receiver Map the flush is holding. The old flush then deleted
// the entry (or cleared it to re-queue only its own stale remainder),
// dropping the newly arrived spawn. The existing player never got the spawn
// packet, so its client never created the entity and ignored every later
// movement/stats update for it - exactly one side going blind, only sometimes
// (it needs the 50ms flush timer to fire between the two logins' writes).

function spawn(id: string): any {
  return { id, username: `player_${id}` };
}

describe("spawn batch claim/requeue (simultaneous-login race)", () => {
  test("arrival during flush await is preserved, not dropped", async () => {
    const queue = new Map<string, Map<string, any>>();
    // Player A logged in first: B's spawn is queued for A.
    queue.set("A", new Map([["B", spawn("B")]]));

    // Flush claims A's entry BEFORE its first await.
    const claimed = claimBatchEntry(queue, "A");
    expect(claimed?.size).toBe(1);

    // While the flush awaits sprite data, player C logs in: updatePlayerAOI
    // queues C's spawn for A via the usual get-or-create pattern.
    await Promise.resolve(); // simulate the await window
    if (!queue.has("A")) queue.set("A", new Map());
    queue.get("A")!.set("C", spawn("C"));

    // Flush sent everything it claimed (<=10 spawns), so remainder is empty.
    requeueSpawnBatch(queue, "A", new Map());

    // C's spawn must survive for the next flush.
    expect(queue.has("A")).toBe(true);
    expect(queue.get("A")!.has("C")).toBe(true);
  });

  test("remainder merges with mid-flush arrivals, arrivals win on conflict", async () => {
    const queue = new Map<string, Map<string, any>>();
    const initial = new Map<string, any>();
    for (let i = 0; i < 12; i++) initial.set(`p${i}`, spawn(`p${i}`));
    queue.set("A", initial);

    const claimed = claimBatchEntry(queue, "A")!;
    const values = Array.from(claimed.values());
    const remaining = new Map<string, any>();
    for (const r of values.slice(10)) remaining.set(r.id, r);

    // Mid-flush: a fresher snapshot of p11 arrives plus a brand-new p12.
    await Promise.resolve();
    queue.set("A", new Map([
      ["p11", { ...spawn("p11"), fresh: true }],
      ["p12", spawn("p12")],
    ]));

    requeueSpawnBatch(queue, "A", remaining);

    const merged = queue.get("A")!;
    expect(merged.has("p10")).toBe(true); // stale remainder kept
    expect(merged.has("p12")).toBe(true); // arrival kept
    expect((merged.get("p11") as any).fresh).toBe(true); // arrival wins
  });

  test("backpressured receiver keeps its whole batch for the next flush", () => {
    const queue = new Map<string, Map<string, any>>();
    queue.set("A", new Map([["B", spawn("B")]]));

    const claimed = claimBatchEntry(queue, "A")!;
    // Flush skips sending: requeue everything it claimed.
    requeueSpawnBatch(queue, "A", claimed);

    expect(queue.get("A")!.has("B")).toBe(true);
  });

  test("old pattern demonstrably drops the mid-flush arrival", async () => {
    // Documents the original bug: delete-after-await on the live entry.
    const queue = new Map<string, Map<string, any>>();
    queue.set("A", new Map([["B", spawn("B")]]));

    const liveRef = queue.get("A")!;
    const snapshot = Array.from(liveRef.values());
    expect(snapshot.length).toBe(1);

    await Promise.resolve(); // await window
    liveRef.set("C", spawn("C")); // arrival lands in the same live Map

    // Old code: nothing left over, so `spawnBatchQueue.delete("A")`.
    queue.delete("A");

    expect(queue.has("A")).toBe(false); // C's spawn lost -> A never sees C
  });
});

describe("despawn batch claim/requeue", () => {
  test("backpressured despawns are preserved instead of wiped", () => {
    const queue = new Map<string, Set<string>>();
    queue.set("A", new Set(["B", "C"]));

    const claimed = claimDespawnEntry(queue, "A")!;
    // Flush skips sending (backpressure): union back.
    requeueDespawnEntry(queue, "A", claimed);

    expect([...queue.get("A")!].sort()).toEqual(["B", "C"]);
  });

  test("mid-flush arrivals union with the unsent remainder", async () => {
    const queue = new Map<string, Set<string>>();
    queue.set("A", new Set(["B"]));

    const claimed = claimDespawnEntry(queue, "A")!;
    await Promise.resolve(); // await window (defensive: despawn flush is sync today)
    queue.set("A", new Set(["C"]));

    requeueDespawnEntry(queue, "A", claimed);

    expect([...queue.get("A")!].sort()).toEqual(["B", "C"]);
  });

  test("old blanket-clear pattern drops backpressured despawns", () => {
    // Documents the second bug: `continue` on backpressure followed by a
    // blanket `despawnBatchQueue.clear()` at the end of the flush.
    const queue = new Map<string, Set<string>>();
    queue.set("A", new Set(["B"]));

    for (const [, ids] of queue.entries()) {
      if (ids.size === 0) continue;
      const backpressured = true;
      if (backpressured) continue; // skipped, entry left in place...
    }
    queue.clear(); // ...then wiped. A never gets B's despawn -> ghost entity.

    expect(queue.size).toBe(0);
  });
});
