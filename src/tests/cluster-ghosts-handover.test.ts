import { expect, test } from "bun:test";
import { GHOST_TOMBSTONE_MS, Ghosts, type GhostKind } from "../cluster/ghosts";
import { linkMesh, settle } from "./cluster-fakelink";

// A test kind: entities live in `local` on their owner; mirrors in `shown`.

function testKind(local: Map<string, { id: string; x: number }>, shown: Map<string, { owner: string; record: any }>, log: string[]): GhostKind {
  return {
    name: "player",
    *candidates() {
      for (const e of local.values()) yield { id: e.id, num: Number(e.id), map: "m", layerId: null, x: e.x, y: 0 };
    },
    snapshot: (id) => (local.has(String(id)) ? { id: String(id), x: local.get(String(id))!.x } : null),
    spawn: (record, from) => {
      if (local.has(String(record.id))) return false;
      shown.set(String(record.id), { owner: from, record });
      log.push(`spawn ${record.id} from ${from}`);
    },
    rehome: (id, owner) => {
      const mirror = shown.get(String(id));
      if (mirror) mirror.owner = owner;
      log.push(`rehome ${id} to ${owner}`);
    },
    despawn: (id, reason) => {
      shown.delete(String(id));
      log.push(`despawn ${id} ${reason}`);
    },
  };
}

function cluster(handoverExpireMs = 10_000, now?: () => number) {
  const links = linkMesh(["a", "b", "c"] as const);
  const nodes = {} as Record<"a" | "b" | "c", { ghosts: Ghosts; local: Map<string, any>; shown: Map<string, any>; log: string[] }>;
  for (const name of ["a", "b", "c"] as const) {
    const ghosts = new Ghosts({ scanMs: 60_000, expireMs: 50, handoverExpireMs, ...(now ? { now } : {}) });
    const local = new Map();
    const shown = new Map();
    const log: string[] = [];
    ghosts.register(testKind(local, shown, log));
    // Every node mirrors everything to every other node.
    ghosts.attach(links[name], () => new Set(["a", "b", "c"].filter((n) => n !== name)));
    nodes[name] = { ghosts, local, shown, log };
  }
  const stop = () => { for (const n of Object.values(nodes)) n.ghosts.detach(); };
  return { links, nodes, stop };
}

test("a handover moves the mirrors to the new owner with no despawn", async () => {
  const { nodes, stop } = cluster();
  try {
    nodes.a.local.set("7", { id: "7", x: 1 });
    nodes.a.ghosts.scan();
    await settle();
    expect(nodes.c.shown.get("7")?.owner).toBe("a");
    nodes.a.ghosts.handOver("player", "7", "b");
    nodes.a.local.delete("7");
    await settle();
    expect(nodes.c.log).toEqual(["spawn 7 from a", "rehome 7 to b"]);
    expect(nodes.c.ghosts.ownerOf("player", "7")).toBe("b");
    // The new owner's later sends reach the re-keyed mirror; the old owner's no longer do.
    nodes.a.ghosts.scan();
    await settle();
    expect(nodes.c.log.filter((l) => l.startsWith("despawn"))).toEqual([]);
  } finally {
    stop();
  }
});

test("a handover from a node that does not own the mirror is ignored", async () => {
  const { links, nodes, stop } = cluster();
  try {
    nodes.a.local.set("7", { id: "7", x: 1 });
    nodes.a.ghosts.scan();
    await settle();
    links.b.send("c", "GHOST_HANDOVER", { kind: "player", id: "7", num: 7, to: "z" });
    await settle();
    // Guard: entry.from === from. Without it any peer could take another node's entity's mirror. The target
    // is a third node: a handover naming its own sender is ignored by a separate check.
    expect(nodes.c.ghosts.ownerOf("player", "7")).toBe("a");
  } finally {
    stop();
  }
});

test("a handed-over mirror the new owner never sends expires", async () => {
  const { nodes, stop } = cluster(30);
  try {
    nodes.a.local.set("7", { id: "7", x: 1 });
    nodes.a.ghosts.scan();
    await settle();
    nodes.a.ghosts.handOver("player", "7", "b");
    nodes.a.local.delete("7");
    await settle();
    await Bun.sleep(60);
    expect(nodes.c.shown.has("7")).toBe(false);
    expect(nodes.c.log.at(-1)).toBe("despawn 7 expired");
  } finally {
    stop();
  }
});

test("a handed-over mirror the new owner sends again does not expire", async () => {
  const { nodes, stop } = cluster(30);
  try {
    nodes.a.local.set("7", { id: "7", x: 1 });
    nodes.a.ghosts.scan();
    await settle();
    nodes.a.ghosts.handOver("player", "7", "b");
    nodes.a.local.delete("7");
    nodes.b.ghosts.dropMirror("player", "7");
    nodes.b.local.set("7", { id: "7", x: 2 });
    await settle();
    nodes.b.ghosts.scan();
    await settle();
    await Bun.sleep(60);
    expect(nodes.c.shown.get("7")?.owner).toBe("b");
  } finally {
    stop();
  }
});

test("the new owner keeps its own mirror until the entity arrives, then drops it with no despawn", async () => {
  const { nodes, stop } = cluster();
  try {
    nodes.a.local.set("7", { id: "7", x: 1 });
    nodes.a.ghosts.scan();
    await settle();
    nodes.a.ghosts.handOver("player", "7", "b");
    nodes.a.local.delete("7");
    await settle();
    expect(nodes.b.shown.has("7")).toBe(true);
    nodes.b.local.set("7", { id: "7", x: 1 });
    nodes.b.ghosts.dropMirror("player", "7");
    expect(nodes.b.ghosts.ownerOf("player", "7")).toBe(null);
    // The kind is told to drop it; a real kind sees the entity local and drops it as shadowed (no viewer despawn).
    expect(nodes.b.log.at(-1)).toBe("despawn 7 arrived");
  } finally {
    stop();
  }
});

test("the old owner holds an adopted mirror of the entity it handed over", async () => {
  const { nodes, stop } = cluster(30);
  try {
    nodes.a.local.set("7", { id: "7", x: 1 });
    nodes.a.ghosts.scan();
    await settle();
    nodes.a.ghosts.handOver("player", "7", "b");
    nodes.a.local.delete("7");
    expect(nodes.a.ghosts.adoptMirror("player", { id: "7", x: 1 }, "b")).toBe(true);
    expect(nodes.a.ghosts.ownerOf("player", "7")).toBe("b");
    // Not sent again by b: it expires like a mirror whose link flapped.
    await Bun.sleep(60);
    expect(nodes.a.shown.has("7")).toBe(false);
  } finally {
    stop();
  }
});

test("a handover leaves nothing tracked, so the next scan does not despawn it everywhere", async () => {
  const { nodes, stop } = cluster();
  try {
    nodes.a.local.set("7", { id: "7", x: 1 });
    nodes.a.ghosts.scan();
    await settle();
    nodes.a.ghosts.handOver("player", "7", "b");
    nodes.a.local.delete("7");
    // Without the untrack the entry stays (with no peers, so the scan below sends nothing and then drops it):
    // only looking before the scan shows the guard.
    expect((nodes.a.ghosts as any).tracked.get("player")?.has("7")).toBe(false);
    nodes.a.ghosts.scan();
    await settle();
    // Guard: the untrack in handOver. Without it, this scan sends GHOST_DESPAWN "gone" to b and c.
    expect(nodes.c.log).not.toContain("despawn 7 gone");
  } finally {
    stop();
  }
});

// ---- stall fix: a spawn that lands after the entity arrived (the bulk lane is behind the control lane)

const lateSpawn = { kind: "player", id: "7", num: 7, record: { id: "7", x: 1 } };

test("a spawn that lands after the entity arrived here and left again makes no mirror", async () => {
  const { links, nodes, stop } = cluster();
  try {
    // The entity came from a (the control lane) before a's spawn, held back in the bulk lane, landed. No mirror was there yet.
    nodes.b.local.set("7", { id: "7", x: 1 });
    nodes.b.ghosts.dropMirror("player", "7");
    nodes.b.local.delete("7");
    links.a.send("b", "GHOST_SPAWN", lateSpawn);
    await settle();
    // Guard: the tombstone. Without it the spawn makes a mirror that no despawn ever follows (a no longer tracks the entity).
    expect(nodes.b.shown.has("7")).toBe(false);
    expect(nodes.b.ghosts.ownerOf("player", "7")).toBe(null);
  } finally {
    stop();
  }
});

test("a tombstone for a mirror that was there refuses only that peer's spawn", async () => {
  const { links, nodes, stop } = cluster();
  try {
    nodes.a.local.set("7", { id: "7", x: 1 });
    nodes.a.ghosts.scan();
    await settle();
    expect(nodes.b.shown.get("7")?.owner).toBe("a");
    nodes.b.ghosts.dropMirror("player", "7");
    nodes.b.local.delete("7");
    links.a.send("b", "GHOST_SPAWN", lateSpawn);
    links.c.send("b", "GHOST_SPAWN", lateSpawn);
    await settle();
    expect(nodes.b.ghosts.ownerOf("player", "7")).toBe("c");
  } finally {
    stop();
  }
});

test("the entity handed back to that peer clears the tombstone: its spawn is taken", async () => {
  const { links, nodes, stop } = cluster();
  try {
    nodes.b.local.set("7", { id: "7", x: 1 });
    nodes.b.ghosts.dropMirror("player", "7");
    // The entity goes back to a within the minute.
    nodes.b.ghosts.handOver("player", "7", "a");
    nodes.b.local.delete("7");
    links.a.send("b", "GHOST_SPAWN", lateSpawn);
    await settle();
    expect(nodes.b.ghosts.ownerOf("player", "7")).toBe("a");
  } finally {
    stop();
  }
});

test("a tombstone ends after GHOST_TOMBSTONE_MS", async () => {
  let clock = 1_000_000;
  const { links, nodes, stop } = cluster(10_000, () => clock);
  try {
    nodes.b.ghosts.dropMirror("player", "7");
    clock += GHOST_TOMBSTONE_MS - 1;
    links.a.send("b", "GHOST_SPAWN", lateSpawn);
    await settle();
    expect(nodes.b.shown.has("7")).toBe(false);
    clock += 2;
    links.a.send("b", "GHOST_SPAWN", lateSpawn);
    await settle();
    expect(nodes.b.ghosts.ownerOf("player", "7")).toBe("a");
  } finally {
    stop();
  }
});
