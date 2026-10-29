import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PlayerHandoff, holdPlayerLock, type HandoffDeps, type HandoffLock, type PlayerSnapshot, type SwitchTicket } from "../cluster/handoff";
import { LinkCalls } from "../cluster/linkcalls";
import { MemoryStore } from "../cluster/memorystore";
import { PlayerLockBusy, PlayerLocks } from "../cluster/playerlock";
import { RECOVERY_READ_MS, recoverLogin, type RecoveryDeps } from "../cluster/recovery";
import type { SavedSnapshot } from "../cluster/snapshots";
import log from "../modules/logger";
import { linkPair } from "./cluster-fakelink";

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

// ---- Login recovery ----

const row = () => ({
  username: "Hero",
  isDead: 0,
  location: { map: "main", position: { x: 10, y: 20, direction: "up" } },
  stats: { health: 100, max_health: 100, stamina: 50, max_stamina: 50, level: 3 },
});

const snap = (over: Partial<SavedSnapshot> = {}): SavedSnapshot => ({
  epoch: 4, at: 2_000, username: "hero", map: "forest", x: 300, y: 400, direction: "left",
  stats: { health: 30, max_health: 120, stamina: 5, max_stamina: 60 },
  ...over,
});

const deps = (over: Partial<RecoveryDeps> = {}): RecoveryDeps => ({
  stamp: async () => ({ ownerEpoch: 4, savedAt: 1_000 }),
  snapshot: async () => snap(),
  knownMap: (map) => map === "main" || map === "forest",
  ...over,
});

test("a snapshot newer than the last save sets the location and the stats", async () => {
  const data: any = row();
  expect(await recoverLogin(data, deps())).toEqual(snap());
  expect(data.location).toEqual({ map: "forest", position: { x: 300, y: 400, direction: "left" } });
  // The row's maximums stay (controller ruling on review I1): only health and stamina come from the snapshot.
  expect(data.stats).toEqual({ health: 30, max_health: 100, stamina: 5, max_stamina: 50, level: 3 });
});

test("a level-up after the snapshot keeps the row's higher maximums", async () => {
  // Guard: the row's maximums are kept. A level-up writes them to the row without moving saved_at.
  const data: any = row();
  data.stats = { health: 140, max_health: 140, stamina: 70, max_stamina: 70, level: 4 };
  await recoverLogin(data, deps({ snapshot: async () => snap({ stats: { health: 110, max_health: 120, stamina: 55, max_stamina: 60 } }) }));
  expect(data.stats).toEqual({ health: 110, max_health: 140, stamina: 55, max_stamina: 70, level: 4 });
  // Health above the snapshot's own maximum is held to it, not to the row's.
  data.stats = { health: 140, max_health: 140, stamina: 70, max_stamina: 70, level: 4 };
  await recoverLogin(data, deps({ snapshot: async () => snap({ stats: { health: 130, max_health: 120, stamina: 65, max_stamina: 60 } }) }));
  expect(data.stats).toEqual({ health: 120, max_health: 140, stamina: 60, max_stamina: 70, level: 4 });
});

test("a snapshot whose maximums are 0 or less is not used", async () => {
  // Guard: positive maximums. A corrupt key would leave a living player at 0 health.
  const warns = spyOn(log, "warn").mockImplementation(() => {});
  spies.push(warns);
  for (const stats of [
    { health: 30, max_health: 0, stamina: 5, max_stamina: 60 },
    { health: 30, max_health: 120, stamina: 5, max_stamina: -1 },
    { health: 30, max_health: -5, stamina: 5, max_stamina: 0 },
  ]) {
    const data: any = row();
    expect(await recoverLogin(data, deps({ snapshot: async () => snap({ stats }) }))).toBeNull();
    expect(data).toEqual(row());
  }
  expect(warns).toHaveBeenCalledTimes(3);
});

test("a negative stamina in the snapshot is floored at 0", async () => {
  // Guard: the floor of the clamp.
  const data: any = row();
  await recoverLogin(data, deps({ snapshot: async () => snap({ stats: { health: 30, max_health: 120, stamina: -5, max_stamina: 60 } }) }));
  expect(data.stats.stamina).toBe(0);
  expect(data.stats.health).toBe(30);
});

test("a row with no stats is moved and does not throw", async () => {
  // Guard: the row's stats check. recoverLogin never throws, so the login goes on.
  const data: any = { ...row(), stats: null };
  expect(await recoverLogin(data, deps())).toEqual(snap());
  expect(data.location.map).toBe("forest");
  expect(data.stats).toBeNull();
});

test("a snapshot read that stalls is given up after the bound, and the row is used", async () => {
  // Guard: the read bound. A partitioned store would hold the login until TCP gives up.
  const warns = spyOn(log, "warn").mockImplementation(() => {});
  spies.push(warns);
  const data: any = row();
  const started = Date.now();
  expect(await recoverLogin(data, deps({ readMs: 30, snapshot: () => new Promise<SavedSnapshot | null>(() => {}) }))).toBeNull();
  expect(Date.now() - started).toBeLessThan(500);
  expect(data).toEqual(row());
  expect(warns).toHaveBeenCalledTimes(1);
  // A late rejection after the bound is not an unhandled one.
  let reject!: (error: Error) => void;
  const late = new Promise<SavedSnapshot | null>((_resolve, no) => { reject = no; });
  expect(await recoverLogin(data, deps({ readMs: 10, snapshot: () => late }))).toBeNull();
  reject(new Error("too late"));
  await new Promise((resolve) => setTimeout(resolve, 5));
});

test("the default read bound is about a second", () => {
  expect(RECOVERY_READ_MS).toBe(1_000);
});

test("a snapshot no newer than the last save, or from an older owner, is not used", async () => {
  // Guard: chooseNewer. The row is newer after a clean logout.
  const data: any = row();
  expect(await recoverLogin(data, deps({ stamp: async () => ({ ownerEpoch: 4, savedAt: 2_000 }) }))).toBeNull();
  expect(data).toEqual(row());
  expect(await recoverLogin(data, deps({ stamp: async () => ({ ownerEpoch: 5, savedAt: 0 }) }))).toBeNull();
  expect(await recoverLogin(data, deps({ stamp: async () => null }))).toBeNull();
  expect(data).toEqual(row());
});

test("a snapshot on a map this node does not have is not used", async () => {
  // Guard: knownMap. The login would spawn on a map that is not loaded.
  const data: any = row();
  expect(await recoverLogin(data, deps({ snapshot: async () => snap({ map: "gone" }) }))).toBeNull();
  expect(data).toEqual(row());
});

test("a snapshot of another account is not used", async () => {
  // Guard: the username check. A key read under the wrong name never moves this player.
  const data: any = row();
  expect(await recoverLogin(data, deps({ snapshot: async () => snap({ username: "villain" }) }))).toBeNull();
  expect(data).toEqual(row());
});

test("a snapshot at 0 health moves the player but keeps the row's stats", async () => {
  // Guard: the health > 0 check. The death was not saved, so the row's living stats are kept.
  const data: any = row();
  expect(await recoverLogin(data, deps({ snapshot: async () => snap({ stats: { health: 0, max_health: 120, stamina: 0, max_stamina: 60 } }) }))).not.toBeNull();
  expect(data.location.map).toBe("forest");
  expect(data.stats).toEqual(row().stats);
});

test("health and stamina are held to their maximums", async () => {
  const data: any = row();
  await recoverLogin(data, deps({ snapshot: async () => snap({ stats: { health: 500, max_health: 120, stamina: 90, max_stamina: 60 } }) }));
  // Held to the smaller maximum: the row's 100 and 50 here.
  expect(data.stats.health).toBe(100);
  expect(data.stats.stamina).toBe(50);
});

test("a snapshot with no stats moves the player only", async () => {
  const data: any = row();
  await recoverLogin(data, deps({ snapshot: async () => snap({ stats: null }) }));
  expect(data.location.map).toBe("forest");
  expect(data.stats).toEqual(row().stats);
});

test("a failed read keeps the row and is logged", async () => {
  const errors = spyOn(log, "error").mockImplementation(() => {});
  spies.push(errors);
  const data: any = row();
  expect(await recoverLogin(data, deps({ snapshot: async () => { throw new Error("redis down"); } }))).toBeNull();
  expect(data).toEqual(row());
  expect(errors).toHaveBeenCalledTimes(1);
});

test("the receiver recovers before the routing and before the player is cached", () => {
  const source = readFileSync(join(import.meta.dir, "../socket/receiver.ts"), "utf8");
  const recover = source.indexOf("await recoverLogin(playerData, {");
  const dbMap = source.indexOf("const dbMap = playerData.location?.map;");
  const route = source.indexOf("switchLoginIfElsewhere(wt, sessionId, playerData.username, spawnLocation)");
  const cached = source.indexOf("playerCache.add(wt.data.id, {");
  expect(recover).toBeGreaterThan(0);
  // Guard: the order. After playerCache.add the epoch is claimed, and the stamp would be this login's own.
  expect(recover).toBeLessThan(dbMap);
  expect(dbMap).toBeLessThan(route);
  expect(route).toBeLessThan(cached);
  // Guard: the condition. An arrival, a dead player and a guest are not recovered.
  expect(source).toContain("if (clusterEnabled() && !arrival && !Number(playerData.isDead) && !playerData.isGuest) {");
  // Guard: the store check and the deps. The cache names maps with ".json"; a bare name would turn recovery off.
  const block = source.slice(recover - 200, recover + 400);
  expect(block).toMatch(/const store = clusterStore\(\);\s+if \(store\) \{\s+await recoverLogin\(playerData, \{/);
  expect(block).toContain("stamp: (username) => player.saveStamp(username),");
  expect(block).toContain("snapshot: (username) => readSnapshot(store, username),");
  expect(block).toContain("knownMap: (map) => mapPropertiesCache.some((m: any) => m.name === `${map}.json`),");
});

// ---- The handoff lock ----

type Node = { handoff: PlayerHandoff; calls: LinkCalls; players: Map<string, any>; log: string[]; deps: HandoffDeps };

function ticketFor(target: string): SwitchTicket {
  return { token: `switch-${Math.random().toString(16).slice(2)}`, timestamp: 1, expiresAt: 2, signature: "sig", origin: "o", account: "ann", nodeId: target };
}

function node(name: string, link: any): Node {
  const calls = new LinkCalls(1_000);
  calls.attach(link);
  const players = new Map<string, any>();
  const steps: string[] = [];
  const deps: HandoffDeps = {
    calls,
    ghosts: {
      handOver: (kind, id, to) => { steps.push(`handOver ${kind} ${id} ${to}`); },
      adoptMirror: (kind, record, from) => { steps.push(`adoptMirror ${kind} ${record.id} ${from}`); return true; },
    },
    self: name,
    ownerAt: () => (name === "a" ? "b" : name),
    now: () => 1_000_000,
    player: (id) => players.get(id) ?? null,
    playerByUsername: (username) => [...players.values()].find((p) => p.username === username) ?? null,
    drain: async () => { steps.push("drain"); },
    undrain: () => { steps.push("undrain"); },
    snapshot: (p): PlayerSnapshot => ({ id: String(p.id), username: p.username, map: "main", x: 1, y: 0, direction: "down", creatureIds: [], playerIds: [], state: {} }),
    ghostRecord: (p) => ({ id: String(p.id) }),
    ticket: (_p, target) => { steps.push("ticket"); return ticketFor(target); },
    node: (target) => ({ nodeId: target, publicHost: "h", port: 1, wtPort: 2, useSSL: true }),
    release: (p) => { players.delete(String(p.id)); steps.push(`release ${p.id}`); },
    save: async (p) => { steps.push(`save ${p.id}`); },
    sendSwitch: async (p) => { steps.push(`switch ${p.id}`); },
    forward: (id, username, to) => { steps.push(`forward ${id} ${username} ${to}`); },
  };
  const handoff = new PlayerHandoff();
  handoff.start(deps);
  return { handoff, calls, players, log: steps, deps };
}

function pair() {
  const { a: la, b: lb } = linkPair();
  const a = node("a", la);
  const b = node("b", lb);
  const stop = () => { a.handoff.stop(); b.handoff.stop(); a.calls.detach(); b.calls.detach(); };
  return { a, b, stop };
}

/** A lock that always gives itself, and writes when it is taken and let go. */
const loggingLock = (n: Node): HandoffLock => async (username) => {
  n.log.push(`lock ${username}`);
  return async () => { n.log.push(`unlock ${username}`); };
};

test("the handoff looks at the lock before the drain, takes it after the drain and lets it go after the save, before the SWITCH", async () => {
  const { a, stop } = pair();
  try {
    a.handoff.setLock(loggingLock(a));
    const player: any = { id: "7", username: "ann" };
    a.players.set("7", player);
    expect(await a.handoff.handOff(player, "b")).toBe("switched");
    // Guard: the lock step and the letGo after the save. A write on another node would land between the save and the new node's read.
    // The first lock and unlock are the look (handoff fix 2, N1): a busy lock refuses before the player is stopped.
    expect(a.log).toEqual(["ticket", "lock ann", "unlock ann", "drain", "lock ann", "handOver player 7 b", "release 7", "adoptMirror player 7 b", "forward 7 ann b", "save 7", "unlock ann", "switch 7"]);
  } finally {
    stop();
  }
});

test("a held lock refuses the handoff before the drain, keeps the player walking, and aborts the arrival", async () => {
  const { a, stop } = pair();
  try {
    a.handoff.setLock(async () => null);
    const aborts = spyOn(a.calls, "cast");
    spies.push(aborts);
    const player: any = { id: "7", username: "ann" };
    a.players.set("7", player);
    // Guard: the null check. Without it the handoff runs while another node writes the player's rows.
    expect(await a.handoff.handOff(player, "b")).toBe("refused");
    expect(aborts.mock.calls.some((c) => c[1] === "HANDOFF_ABORT")).toBe(true);
    expect(a.players.get("7")).toBe(player);
    // Guard: the look before the drain (N1). Without it the walker is stopped and given back on every try.
    expect(player.handoff).toBeUndefined();
    expect(a.log).toEqual(["ticket"]);
    expect(a.handoff.coolingDown("ann")).toBe(true);
  } finally {
    stop();
  }
});

test("a handoff refused after the lock was taken lets the lock go", async () => {
  const { a, b, stop } = pair();
  try {
    a.handoff.setLock(loggingLock(a));
    const player: any = { id: "7", username: "ann" };
    a.players.set("7", player);
    // A trade begun while the answer was awaited: refused once the lock is held.
    a.deps.recheck = () => "trading";
    void b;
    expect(await a.handoff.handOff(player, "b")).toBe("refused");
    // Guard: the letGo in finally. A refused handoff would keep the lock for its whole ttl.
    expect(a.log).toEqual(["ticket", "lock ann", "unlock ann", "drain", "lock ann", "unlock ann", "undrain"]);
  } finally {
    stop();
  }
});

test("a player who left while the lock was taken is gone, and the lock is let go", async () => {
  const { a, stop } = pair();
  try {
    const player: any = { id: "7", username: "ann" };
    let taken = 0;
    a.handoff.setLock(async (username) => {
      // The look finds the player; the lock taken after the drain finds them gone.
      if (++taken === 2) a.players.delete("7");
      a.log.push(`lock ${username}`);
      return async () => { a.log.push(`unlock ${username}`); };
    });
    a.players.set("7", player);
    // Guard: the player check after the lock. The handoff would ticket a player who disconnected.
    expect(await a.handoff.handOff(player, "b")).toBe("gone");
    expect(a.log).toEqual(["ticket", "lock ann", "unlock ann", "drain", "lock ann", "unlock ann"]);
  } finally {
    stop();
  }
});

test("a release that rejects after the save is logged, and the SWITCH is still sent", async () => {
  // Guard: the try in letGo. A rejecting release would end the run before the client is sent on.
  const errors = spyOn(log, "error").mockImplementation(() => {});
  spies.push(errors);
  const { a, stop } = pair();
  try {
    a.handoff.setLock(async (username) => {
      a.log.push(`lock ${username}`);
      return async () => { throw new Error("store gone"); };
    });
    const player: any = { id: "7", username: "ann" };
    a.players.set("7", player);
    expect(await a.handoff.handOff(player, "b")).toBe("switched");
    // The look and the lock after the drain each fail to let go: two lines, and the handoff goes on.
    expect(a.log).toEqual(["ticket", "lock ann", "drain", "lock ann", "handOver player 7 b", "release 7", "adoptMirror player 7 b", "forward 7 ann b", "save 7", "switch 7"]);
    expect(errors).toHaveBeenCalledTimes(2);
  } finally {
    stop();
  }
});

test("without a lock set, a handoff runs as before", async () => {
  const { a, stop } = pair();
  try {
    expect(a.handoff.setLock(null)).toBeNull();
    const player: any = { id: "7", username: "ann" };
    a.players.set("7", player);
    expect(await a.handoff.handOff(player, "b")).toBe("switched");
    expect(a.log).toEqual(["ticket", "drain", "handOver player 7 b", "release 7", "adoptMirror player 7 b", "forward 7 ann b", "save 7", "switch 7"]);
  } finally {
    stop();
  }
});

test("setLock answers the lock set before", () => {
  const handoff = new PlayerHandoff();
  const one: HandoffLock = async () => null;
  expect(handoff.setLock(one)).toBeNull();
  expect(handoff.setLock(null)).toBe(one);
});

test("holdPlayerLock holds the cluster lock until the release, and a second holder gets null", async () => {
  const store = new MemoryStore();
  const mine = new PlayerLocks(store, "a");
  const theirs = new PlayerLocks(store, "b");
  const release = await holdPlayerLock(mine, "Ann");
  expect(release).not.toBeNull();
  expect(mine.held("ann")).toBe(true);
  // Guard: waitMs 0. A busy lock answers null at once instead of holding the handoff for 2 s.
  const started = Date.now();
  expect(await holdPlayerLock(theirs, "ann")).toBeNull();
  expect(Date.now() - started).toBeLessThan(500);
  await release!();
  expect(mine.held("ann")).toBe(false);
  expect(await store.get("cells:plock:ann")).toBeNull();
  const again = await holdPlayerLock(theirs, "ann");
  expect(again).not.toBeNull();
  await again!();
});

test("holdPlayerLock answers null on a store failure and logs it, but not on a busy lock", async () => {
  const errors = spyOn(log, "error").mockImplementation(() => {});
  spies.push(errors);
  expect(await holdPlayerLock({ withLocks: async () => { throw new PlayerLockBusy("ann"); } }, "ann")).toBeNull();
  expect(errors).not.toHaveBeenCalled();
  expect(await holdPlayerLock({ withLocks: async () => { throw new Error("redis down"); } }, "ann")).toBeNull();
  expect(errors).toHaveBeenCalledTimes(1);
});
