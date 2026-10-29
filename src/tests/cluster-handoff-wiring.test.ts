import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { databaseModule } from "./setup";
import type { SealedStore } from "../cluster/storeseal";

// The wiring of phase 6 into the engine. The AOI, presence, sickness and cluster start are run for real (only the
// database is stubbed); server.ts cannot be imported (it starts the server), so its wiring is read from its source.
mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (_sql: string, _params?: any[]) => [],
}));

const playerCache = (await import("../services/playermanager")).default;
const mapIndex = (await import("../services/mapindex")).default;
const layerManager = (await import("../services/layermanager")).default;
const spatialGrid = (await import("../services/spatialgrid")).default;
const aoiReverse = await import("../services/aoiReverseIndex");
const { initializePlayerAOI, updatePlayerAOI, releasePlayerAOI, broadcastGroundPreviewToAOI, clearGroundPreviewForAOI } = await import("../socket/aoi");
const resurrection = await import("../systems/resurrection");
const { trackPresence } = await import("../cluster/presence");
const { PlayerDirectory } = await import("../cluster/directory");
const { MemoryStore } = await import("../cluster/memorystore");
const { clusterStore, reportCreaturesFrom, startCluster, stopCluster } = await import("../cluster");
const { BlockTable } = await import("../cluster/blocks");
const { deriveClusterKeys } = await import("../cluster/clusterkeys");
const HANDOFF_SECRET = "handoff-wiring-test-secret-0123456789abcdef";
// Block tables are sealed (secfix A round 1): written for startCluster through the seal it reads with.
const { sealStore } = await import("../cluster/storeseal");
const sealed = (store: Parameters<typeof sealStore>[0]) => sealStore(store, deriveClusterKeys(HANDOFF_SECRET).store);
const { delivery } = await import("../cluster/deliver");
const { resetEntityIds } = await import("../cluster/entityids");
const { invitations } = await import("../cluster/invitations");
const { LoopbackNetwork } = await import("../cluster/loopback");
const { onLinksAttached } = await import("../cluster/linkhooks");
const { forwardTable } = await import("../cluster/forwarding");
const { linkCalls } = await import("../cluster/linkcalls");
const { playerHandoff } = await import("../cluster/handoff");
const assetCache = (await import("../services/assetCache")).default;
const guards = await import("../cluster/handoffguards");
const consumables = await import("../systems/consumables");
const log = (await import("../modules/logger")).default;

const decode = (packet: Uint8Array) => JSON.parse(new TextDecoder().decode(packet));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function recordingWt(): any {
  const wt: any = { readyState: 1, sent: [] as any[] };
  wt.send = (packet: Uint8Array) => wt.sent.push(decode(packet));
  wt.sendBestEffort = (packet: Uint8Array) => wt.sent.push(decode(packet));
  return wt;
}

let mapSeq = 0;
function makePlayer(id: string, username: string, map: string, x: number, y: number): any {
  return { id, username, location: { map, position: { x, y, direction: "down" } }, wt: recordingWt(), party: [], party_id: null, moving: false };
}
async function loginPlayer(p: any): Promise<any> {
  playerCache.add(p.id, p);
  const cached = playerCache.get(p.id);
  await initializePlayerAOI(cached);
  playerCache.set(cached.id, cached);
  mapIndex.addPlayer(cached.id, cached.location.map);
  await updatePlayerAOI(cached, new Map(), new Map());
  return cached;
}

test("release takes the player out of every local index, and its viewers keep it with no despawn", async () => {
  const map = `handoff-release-${++mapSeq}`;
  const viewer = await loginPlayer(makePlayer("880001", "viewer", map, 100, 100));
  const leaver = await loginPlayer(makePlayer("880002", "leaver", map, 150, 100));
  try {
    await updatePlayerAOI(viewer, new Map(), new Map());
    expect(viewer.aoi.playersInAOI.has("880002")).toBe(true);
    expect(leaver.aoi.playersInAOI.has("880001")).toBe(true);
    expect(mapIndex.getPlayerMap("880002")).toBe(map);
    expect(spatialGrid.hasPlayer("880002")).toBe(true);
    // The leaver casts a ground preview the viewer gets: who got it is remembered, to clear it later.
    const preview = new TextEncoder().encode(JSON.stringify({ type: "GROUND_PREVIEW" }));
    broadcastGroundPreviewToAOI(leaver, [preview]);
    viewer.wt.sent.length = 0;
    const revision = leaver.aoi.revision || 0;

    playerCache.remove("880002");
    releasePlayerAOI(leaver);

    // The viewer still shows the leaver: its mirror takes the entry over.
    expect(viewer.aoi.playersInAOI.has("880002")).toBe(true);
    expect(aoiReverse.getViewers("880002").has("880001")).toBe(true);
    expect(viewer.wt.sent.some((p: any) => p?.type === "DESPAWN_PLAYER")).toBe(false);
    // The leaver is in no index of this node any more, as a viewer either.
    expect(leaver.aoi.playersInAOI.size).toBe(0);
    // Its emptied view is a new revision: a cached view of it is not reused.
    expect(leaver.aoi.revision).toBe(revision + 1);
    expect(aoiReverse.getViewers("880001").has("880002")).toBe(false);
    expect(mapIndex.getPlayerMap("880002")).toBeUndefined();
    expect(layerManager.getPlayerLayer("880002")).toBeNull();
    expect(spatialGrid.hasPlayer("880002")).toBe(false);
    // The preview's audience record is dropped (guard: forgetGroundPreview): a later clear for that caster id
    // reaches only who sees it then, not the viewer who got the old preview.
    aoiReverse.clearViewer("880001");
    const clear = new TextEncoder().encode(JSON.stringify({ type: "GROUND_PREVIEW_CLEAR" }));
    clearGroundPreviewForAOI({ id: "880002" }, [clear]);
    expect(viewer.wt.sent.some((p: any) => p?.type === "GROUND_PREVIEW_CLEAR")).toBe(false);
  } finally {
    playerCache.remove("880001");
    playerCache.remove("880002");
    mapIndex.removePlayer("880001");
    layerManager.removePlayerFromLayer("880001");
    spatialGrid.removePlayer("880001");
    aoiReverse.clearViewed("880002");
    aoiReverse.clearViewer("880001");
  }
});

test("a handed-off player is not put back by playerCache.set", () => {
  const p: any = { id: "880010", username: "Gone" };
  playerCache.add(p.id, p);
  try {
    p.handedOff = true;
    playerCache.remove(p.id);
    playerCache.set(p.id, p);
    expect(playerCache.get(p.id)).toBeUndefined();
    expect(playerCache.getByUsername("Gone")).toBeUndefined();
    // A player not handed off is still written as before, and so is a handed-off one still in the cache.
    const q: any = { id: "880011", username: "Here" };
    playerCache.set(q.id, q);
    expect(playerCache.get(q.id)).toBe(q);
    // Guard I3: another object under a held key (a hand-back reused the id) is refused, not written over the session.
    const q2: any = { id: "880011", username: "Here", handedOff: true };
    playerCache.set(q.id, q2);
    expect(playerCache.get(q.id)).toBe(q);
    expect(playerCache.getByUsername("Here")).toBe(q);
  } finally {
    playerCache.remove("880010");
    playerCache.remove("880011");
  }
});

const sickStats = () => ({ health: 100, total_max_health: 100, stamina: 50, total_max_stamina: 50 });

test("a forgotten sickness is not restored at a later login here", () => {
  const arrived: any = { id: "880020", username: "Sicky", stats: sickStats() };
  try {
    // As a relog (or Task 14's arrival) leaves it: restored at login.
    resurrection.saveOnDisconnect({ username: "SICKY", resurrectionSickUntil: Date.now() + 60_000 });
    expect(resurrection.restoreOnLogin(arrived)).toBe(true);
    expect(arrived.resurrectionSickUntil).toBeGreaterThan(Date.now());

    // Guard: the release forgets it. A later login here starts with none.
    resurrection.saveOnDisconnect(arrived);
    resurrection.forgetSickness(arrived);
    const again: any = { id: "880020", username: "Sicky", stats: sickStats() };
    expect(resurrection.restoreOnLogin(again)).toBe(false);
    expect(again.stats.total_max_health).toBe(100);
  } finally {
    resurrection.forgetSickness(arrived);
    playerCache.remove("880020");
  }
});

test("forgetSickness cancels the sickness timer: it does not fire on the player later", async () => {
  const p: any = { id: "880022", username: "Timed", stats: sickStats() };
  try {
    resurrection.saveOnDisconnect({ username: "timed", resurrectionSickUntil: Date.now() + 40 });
    expect(resurrection.restoreOnLogin(p)).toBe(true);
    const until = p.resurrectionSickUntil;
    resurrection.forgetSickness(p);
    await sleep(90);
    // The expiry would have set it to 0 (and written the player back).
    expect(p.resurrectionSickUntil).toBe(until);
  } finally {
    resurrection.forgetSickness(p);
    playerCache.remove("880022");
  }
});

test("forgetSickness never writes the player back into playerCache", () => {
  // Not marked handed off: the playerCache.set guard would hide a write of a marked one.
  const p: any = { id: "880021", username: "Released", resurrectionSickUntil: Date.now() + 60_000 };
  const set = spyOn(playerCache, "set");
  const add = spyOn(playerCache, "add");
  try {
    resurrection.forgetSickness(p);
    expect(set).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(playerCache.get("880021")).toBeUndefined();
  } finally {
    set.mockRestore();
    add.mockRestore();
    playerCache.remove("880021");
  }
});

test("a handed-off player's directory entry is released only after the hold", async () => {
  const directory = new PlayerDirectory(new MemoryStore(), "wiring-a");
  const stop = trackPresence(directory, () => {}, { holdReleaseMs: (v) => (v?.handedOff ? 60 : 0) });
  const p: any = { id: "880030", username: "Holder", location: { map: "main" } };
  try {
    playerCache.add(p.id, p);
    await sleep(10);
    expect((await directory.get("Holder"))?.nodeId).toBe("wiring-a");
    p.handedOff = true;
    playerCache.remove(p.id);
    await sleep(10);
    expect(await directory.get("Holder")).not.toBeNull();
    await sleep(100);
    expect(await directory.get("Holder")).toBeNull();
    // One not handed off is released at once, as before.
    const q: any = { id: "880032", username: "Leaver", location: { map: "main" } };
    playerCache.add(q.id, q);
    await sleep(10);
    playerCache.remove(q.id);
    await sleep(10);
    expect(await directory.get("Leaver")).toBeNull();
  } finally {
    stop();
    playerCache.remove("880030");
    playerCache.remove("880032");
  }
});

test("stopping presence cancels a held release", async () => {
  const directory = new PlayerDirectory(new MemoryStore(), "wiring-b");
  const stop = trackPresence(directory, () => {}, { holdReleaseMs: () => 40 });
  const p: any = { id: "880031", username: "Cancelled", location: { map: "main" } };
  playerCache.add(p.id, p);
  await sleep(10);
  playerCache.remove(p.id);
  stop();
  await sleep(80);
  expect(await directory.get("Cancelled")).not.toBeNull();
});

test("an arrival does not displace the old node's session", async () => {
  const store = new MemoryStore();
  const elsewhere = new PlayerDirectory(store, "wiring-old");
  await elsewhere.claim("Arriver", "880040", "main");
  const directory = new PlayerDirectory(store, "wiring-new");
  const displaced: string[] = [];
  const stop = trackPresence(directory, (_prev, username) => displaced.push(username), { quiet: (u) => u === "Arriver" });
  try {
    playerCache.add("880040", { id: "880040", username: "Arriver", location: { map: "main" } });
    await sleep(10);
    expect(displaced).toEqual([]);
    expect((await directory.get("Arriver"))?.nodeId).toBe("wiring-new");
    // Any other login that finds an entry elsewhere still displaces it.
    await elsewhere.claim("Other", "880041", "main");
    playerCache.add("880041", { id: "880041", username: "Other", location: { map: "main" } });
    await sleep(10);
    expect(displaced).toEqual(["Other"]);
  } finally {
    stop();
    playerCache.remove("880040");
    playerCache.remove("880041");
  }
});

// ------------------------------------------------------------------ startCluster runs the link hooks

const saved = { cluster: process.env.CLUSTER, cache: process.env.CACHE, node: process.env.NODE_ID, secret: process.env.CLUSTER_LINK_SECRET };
beforeEach(() => {
  process.env.CLUSTER = "true";
  // startCluster refuses a node whose player rows are not shared (CACHE=redis), whoever made its store.
  process.env.CACHE = "redis";
  process.env.NODE_ID = "b";
  // startCluster refuses a node without the link secret (security review H2).
  process.env.CLUSTER_LINK_SECRET = HANDOFF_SECRET;
});
afterEach(async () => {
  await stopCluster();
  reportCreaturesFrom(null);
  delivery.detach();
  invitations.attach(null);
  resetEntityIds();
  forwardTable.clear();
  for (const [name, value] of [["CLUSTER", saved.cluster], ["CACHE", saved.cache], ["NODE_ID", saved.node], ["CLUSTER_LINK_SECRET", saved.secret]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const own = (nodeId: string) => ({ nodeId, epoch: 1, since: 0 });
const mainMap = { name: "main.json", width: 300, height: 100, tileWidth: 32, tileHeight: 32 };
const address = { publicHost: "b.example.com", port: 3000, wtPort: 3000, useSSL: true, linkHost: "b.loop", linkPort: 7012, certHash: "" };

async function startB(store: InstanceType<typeof MemoryStore>) {
  await new BlockTable(sealed(store)).write("main", { epoch: 1, owners: { "0,0": own("a"), "1,0": own("b"), "2,0": own("b") } });
  await startCluster(store, address, { beatMs: 10, refreshMs: 20 }, { transport: new LoopbackNetwork().transport("b.loop", 7012), pingMs: 20, deadMs: 100 });
}

test("startCluster runs the link hooks with the block owners, sets the forwarding, and undoes both at stop", async () => {
  const before = await assetCache.get("mapProperties");
  await assetCache.add("mapProperties", [mainMap]);
  const seen: any[] = [];
  let undone = 0;
  const unregister = onLinksAttached((ctx) => {
    seen.push(ctx);
    return () => { undone++; };
  });
  try {
    const store = new MemoryStore();
    await startB(store);
    expect(seen).toHaveLength(1);
    expect(seen[0].self).toBe("b");
    expect(seen[0].ownerAt("main", 100, 100)).toBe("a");
    expect(seen[0].ownerAt("main.json", 5000, 100)).toBe("b");
    // The store is used through its seal (storeseal.ts, security review H1).
    expect((clusterStore() as SealedStore).inner).toBe(store);
    // The hooks see the store, so a handoff pauses while it is down (R12).
    expect(seen[0].store).toBe(clusterStore());

    // A delivery for a player who just left goes where the forward table says (the name in any case).
    forwardTable.addPlayer("7", "Ann", "c");
    const forwarder = delivery.setForwarder(null);
    expect(typeof forwarder).toBe("function");
    expect(forwarder!("ANN")).toBe("c");
    delivery.setForwarder(forwarder);
    // A call for them is redirected the same way.
    const redirect = (linkCalls as any).redirect;
    expect(typeof redirect).toBe("function");
    expect(redirect("APPLY_REWARD", { playerId: "7" }, "a")).toBe("c");

    await stopCluster();
    expect((linkCalls as any).redirect).toBeNull();
    expect(undone).toBe(1);
    expect(clusterStore()).toBeNull();
    expect(delivery.setForwarder(null)).toBeNull();
    expect(forwardTable.to("user:ann")).toBeNull();
  } finally {
    unregister();
    await assetCache.add("mapProperties", before);
  }
});

test("startCluster holds a handed-off player's directory entry, and an arrival displaces no one", async () => {
  const before = await assetCache.get("mapProperties");
  await assetCache.add("mapProperties", [mainMap]);
  const runOn = spyOn(delivery, "runOnPlayerAt").mockImplementation(async () => ({ ok: true } as any));
  const arrived = spyOn(playerHandoff, "arrivedRecently").mockImplementation((username: string) => username === "Arriver");
  try {
    const store = new MemoryStore();
    const directory = new PlayerDirectory(store, "reader");
    const elsewhere = new PlayerDirectory(store, "a");
    await startB(store);

    // Held: the new node's claim replaces it, or it is released after HANDOFF_PRESENCE_HOLD_MS.
    const p: any = { id: "880050", username: "Mover", location: { map: "main" } };
    playerCache.add(p.id, p);
    await sleep(20);
    expect((await directory.get("Mover"))?.nodeId).toBe("b");
    p.handedOff = true;
    playerCache.remove(p.id);
    await sleep(30);
    expect((await directory.get("Mover"))?.nodeId).toBe("b");
    // Not handed off: released at once.
    const q: any = { id: "880051", username: "Quitter", location: { map: "main" } };
    playerCache.add(q.id, q);
    await sleep(20);
    playerCache.remove(q.id);
    await sleep(30);
    expect(await directory.get("Quitter")).toBeNull();

    // An arrival finds the old node's entry and does not close a session there; another login does.
    await elsewhere.claim("Arriver", "880052", "main");
    await elsewhere.claim("Twice", "880053", "main");
    playerCache.add("880052", { id: "880052", username: "Arriver", location: { map: "main" } });
    playerCache.add("880053", { id: "880053", username: "Twice", location: { map: "main" } });
    await sleep(30);
    expect(runOn.mock.calls.map((call) => (call[3] as any)?.username)).toEqual(["Twice"]);
  } finally {
    runOn.mockRestore();
    arrived.mockRestore();
    for (const id of ["880050", "880051", "880052", "880053"]) playerCache.remove(id);
    await assetCache.add("mapProperties", before);
  }
});

// ------------------------------------------------------------------ the server's guards, by behaviour

test("only a SWITCH ticket is spent, and only in cluster mode", () => {
  const store = {};
  expect(guards.spendsTicket(store, "switch-abc")).toBe(true);
  // The Gateway's own login tokens are never spent here.
  expect(guards.spendsTicket(store, "abc")).toBe(false);
  expect(guards.spendsTicket(store, "")).toBe(false);
  expect(guards.spendsTicket(store, undefined)).toBe(false);
  // No store: cluster mode is off.
  expect(guards.spendsTicket(null, "switch-abc")).toBe(false);
  expect(guards.spendsTicket(undefined, "switch-abc")).toBe(false);
});

test("an arrival keeps its id unless a connection here still has it open", () => {
  const open = new Set(["5"]);
  const isOpen = (id: string) => open.has(id);
  expect(guards.arrivalId("7", isOpen)).toBe("7");
  expect(guards.arrivalId("5", isOpen)).toBeNull();
  expect(guards.arrivalId(null, isOpen)).toBeNull();
});

test("a shutdown step ends in time, is cut short at its cap or the deadline, and never throws", async () => {
  const warn = spyOn(log, "warn").mockImplementation(() => {});
  const error = spyOn(log, "error").mockImplementation(() => {});
  const warned = (text: string) => warn.mock.calls.some((c) => String(c[0]).includes(text));
  try {
    const far = Date.now() + 60_000;
    expect(await guards.boundedStep("quick", async () => {}, far, 1_000)).toBe(true);
    expect(warn).not.toHaveBeenCalled();

    // Cut at its own cap.
    let t = Date.now();
    expect(await guards.boundedStep("slow", () => sleep(2_000), far, 30)).toBe(false);
    expect(Date.now() - t).toBeLessThan(1_000);
    expect(warned("slow cut short")).toBe(true);

    // Cut at the deadline, before its own cap.
    t = Date.now();
    expect(await guards.boundedStep("late", () => sleep(2_000), Date.now() + 30, 60_000)).toBe(false);
    expect(Date.now() - t).toBeLessThan(1_000);
    expect(warned("late cut short")).toBe(true);

    // No time left: not started at all.
    let ran = false;
    expect(await guards.boundedStep("skipped", () => { ran = true; }, Date.now() - 1, 1_000)).toBe(false);
    expect(ran).toBe(false);
    expect(warned("skipped skipped")).toBe(true);

    // A step that fails has ended: logged, and the shutdown goes on.
    expect(await guards.boundedStep("broken", async () => { throw new Error("db away"); }, far)).toBe(true);
    expect(error.mock.calls.some((c) => String(c[0]).includes("broken failed"))).toBe(true);
    expect(await guards.boundedStep("sync throw", () => { throw new Error("x"); }, far)).toBe(true);
  } finally {
    warn.mockRestore();
    error.mockRestore();
  }
});

test("the consumable cooldown is read as time left and set from it, never past a full cooldown", () => {
  try {
    expect(consumables.readyIn("NewPlayer")).toBe(0);
    consumables.setReadyIn("Ann", 10_000);
    // Keyed as the use checks it (lowercase).
    expect(consumables.readyIn("ANN")).toBeGreaterThan(9_000);
    expect(consumables.readyIn("ann")).toBeLessThanOrEqual(10_000);
    expect(consumables.default.cooldownLeft("ANN")).toBeGreaterThan(9_000);
    consumables.setReadyIn("ann", consumables.CONSUMABLE_COOLDOWN_MS * 10);
    expect(consumables.readyIn("ann")).toBeLessThanOrEqual(consumables.CONSUMABLE_COOLDOWN_MS);
    consumables.setReadyIn("ann", 0);
    expect(consumables.readyIn("ann")).toBe(0);
    consumables.setReadyIn("ann", 5_000);
    consumables.setReadyIn("ann", Number.NaN);
    expect(consumables.readyIn("ann")).toBe(0);
  } finally {
    consumables.default.reset();
  }
});

// ------------------------------------------------------------------ server.ts wiring (read from its source)

const serverSource = readFileSync(join(import.meta.dir, "..", "socket", "server.ts"), "utf8");

/**
 * The code only: comments taken out and every string literal emptied, so a match cannot be met by a comment or by
 * text inside a string. (server.ts has no regex literal that holds a quote or "//".)
 */
function codeOf(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];
    if (c === "/" && n === "/") {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end;
      continue;
    }
    if (c === "/" && n === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== c) {
        if (source[j] === "\\") j++;
        j++;
      }
      out += c + c;
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const serverCode = codeOf(serverSource);

/** The code from `start` to `end` (both written as source; matched as code). */
function body(start: string, end: string): string {
  const from = serverCode.indexOf(codeOf(start));
  expect(from).toBeGreaterThanOrEqual(0);
  const to = serverCode.indexOf(codeOf(end), from + codeOf(start).length);
  expect(to).toBeGreaterThan(from);
  return serverCode.slice(from, to);
}
/** Where `code` holds `snippet` as code, or -1. */
const at = (code: string, snippet: string) => code.indexOf(codeOf(snippet));
const has = (code: string, snippet: string) => at(code, snippet) >= 0;

test("codeOf drops comments and string contents", () => {
  expect(codeOf('a(); // b();\n/* c(); */ d("e();"); f(`g(); ${1}`);')).toBe('a(); \n d(""); f(``);');
});

test("server.ts starts the player handoff and the DoT credit when the links attach, and stops both", () => {
  const hook = body("onLinksAttached((ctx) => {", "\n});\n");
  for (const snippet of [
    "playerHandoff.start(", "setRemoteDotCaster(dotCredit)", "playerHandoff.stop()", "setRemoteDotCaster(previousCaster)",
    "release: releaseHandedOff", "save: saveHandedOff", "forward: (playerId, username, to) => forwardTable.addPlayer(playerId, username, to)",
    "undrain: (p) => forceStopPlayerMovement(p)", "nodeAddressesLive = true", "nodeAddressesLive = false",
  ]) expect(`${snippet}: ${has(hook, snippet)}`).toBe(`${snippet}: true`);
  expect(at(hook, "nodeAddressesLive = false")).toBeGreaterThan(at(hook, "return () => {"));
});

test("server.ts registers the link hook before it starts the cluster (startCluster runs the hooks then)", () => {
  const hookAt = at(serverCode, "onLinksAttached((ctx) => {");
  const startAt = at(serverCode, "await startCluster(");
  expect(hookAt).toBeGreaterThanOrEqual(0);
  expect(startAt).toBeGreaterThanOrEqual(0);
  expect(hookAt).toBeLessThan(startAt);
  // What the hook reads at once is declared before it too (a let or const after it would not be set yet).
  for (const declaration of ["const nodeAddresses = new Map", "let nodeAddressesLive", "let nodeAddressesRead"]) {
    expect(at(serverCode, declaration)).toBeGreaterThanOrEqual(0);
    expect(at(serverCode, declaration)).toBeLessThan(hookAt);
  }
});

test("the node addresses are read once the cluster is up, again on a miss, and never after the hook stopped", () => {
  // Guard M2: right after startCluster resolves (the hook's first read ran before the node registry existed).
  const after = serverCode.slice(at(serverCode, "await startCluster("), at(serverCode, "startWebTransportServer("));
  expect(has(after, "if (cluster) void refreshNodeAddresses();")).toBe(true);
  const node = body("node: (target) => {", "\n    },\n");
  expect(has(node, "if (!address) void refreshNodeAddresses();")).toBe(true);
  expect(has(node, "return address ?? null;")).toBe(true);
  // A read that ends after the hook stopped writes nothing.
  const read = body("async function readNodeAddresses(", "\n}\n");
  expect(at(read, "if (!nodeAddressesLive) return;")).toBeGreaterThan(at(read, "await clusterNodes()"));
  expect(at(read, "if (!nodeAddressesLive) return;")).toBeLessThan(at(read, "nodeAddresses.clear()"));
  // One read at a time.
  const refresh = body("function refreshNodeAddresses(", "\n}\n");
  expect(has(refresh, "nodeAddressesRead ??= readNodeAddresses().finally(() => { nodeAddressesRead = null; });")).toBe(true);
});

test("a drain that times out gives the handoff up, quietly, instead of copying a player mid-packet", () => {
  const drain = body("drain: async (p, ms) => {", "\n    },\n");
  expect(has(drain, "gameLoop.unregisterMovingPlayer(p.id)")).toBe(true);
  expect(drain).toMatch(/if \(!\(await waitIdle\(String\(p\.id\), ms\)\)\) throw new HandoffGiveUp\(/);
});

test("the SWITCH closes the connection even when the send fails", () => {
  const send = body("sendSwitch: async (p, node, ticket, resume) => {", "\n    },\n");
  expect(has(send, 'await wt.sendThenClose(packetManager.switchNode(node, ticket, { resume }), 1000, "switch")')).toBe(true);
  const finallyAt = at(send, "} finally {");
  expect(finallyAt).toBeGreaterThan(at(send, "sendThenClose"));
  expect(has(send.slice(finallyAt), 'wt?.close?.(1000, "switch")')).toBe(true);
});

test("the release of a handed-off player does none of a disconnect's leaving", () => {
  const release = body("function releaseHandedOff(", "\n}\n");
  for (const call of [
    "cleanupPlayerState(p, { despawn: false })", "() => cooldownManager.removePlayer(p.username)",
    "effectManager.saveDots(lower, [])", "effectManager.saveBarriers(lower, [])", "effectManager.saveStuns(lower, [])",
    "effectManager.saveSlows(lower, [])", "() => forgetSickness(p)", "() => setConsumableReadyIn(p.username, 0)",
    "() => creatures.closeEditorFor(id)", "() => creatures.sync.forget(id)", "() => gathering.sync.forget(id)",
    "fishing.endSession(id);", "() => releaseDraggedBy(p.id)",
    "if (p.wt?.data?.connectionToken) removeFromAuthenticationQueues(String(p.wt.data.id || p.id), p.wt.data.connectionToken);",
  ]) expect(`${call}: ${has(release, call)}`).toBe(`${call}: true`);
  for (const forbidden of ["PLAYER_DISCONNECT", "clearSessionId", "forgetPlayer", "scheduleCleanup", "updateOnlineStatus", "combat.removeUnit", "despawnPlayerFromAllAOI"]) {
    expect(`${forbidden}: ${release.includes(forbidden)}`).toBe(`${forbidden}: false`);
  }
  // Guard I1: both flags are set before any step runs. From the first, playerCache.set refuses the player; from the
  // second, the receiver drops a new LOGIN or AUTH on the old connection (it stays open until the SWITCH closes it).
  const stepsAt = at(release, "const steps");
  for (const flag of ["p.handedOff = true;", "if (p.wt?.data) p.wt.data.handedOff = true;"]) {
    expect(at(release, flag)).toBeGreaterThanOrEqual(0);
    expect(at(release, flag)).toBeLessThan(stepsAt);
  }
  // Each step runs on its own: one that throws cannot stop the ones after it.
  expect(release).toMatch(/for \(const \[what, step\] of steps\) \{\s*try \{\s*step\(\);\s*\} catch/);
  // A cleanup that throws still takes the player out of the cache and the spatial indexes (guard M4), each removal
  // on its own.
  const finallyAt = at(release, "} finally {");
  expect(finallyAt).toBeGreaterThan(at(release, "cleanupPlayerState(p, { despawn: false })"));
  const fin = release.slice(finallyAt, at(release, "() => cooldownManager.removePlayer(p.username)"));
  for (const removal of [
    "if (playerCache.get(id) === p) playerCache.remove(id);", "() => mapIndex.removePlayer(id)",
    "() => spatialGrid.removePlayer(id)", "() => layerManager.removePlayerFromLayer(id)",
  ]) expect(`${removal}: ${has(fin, removal)}`).toBe(`${removal}: true`);
  expect(fin).toMatch(/for \(const \[where, remove\] of removals\) \{\s*try \{\s*remove\(\);\s*\} catch/);
  const cleanup = body("function cleanupPlayerState(", "\n}\n");
  expect(has(cleanup, 'if (despawn) despawnPlayerFromAllAOI(playerData, "disconnect", despawnBatchQueue);')).toBe(true);
  expect(has(cleanup, "else releasePlayerAOI(playerData);")).toBe(true);
});

test("the handoff state carries the consumable cooldown", () => {
  const state = body("function handoffState(", "\n}\n");
  expect(has(state, "consumableReadyIn: consumableReadyIn(p.username),")).toBe(true);
  expect(serverSource).toContain('import { readyIn as consumableReadyIn, setReadyIn as setConsumableReadyIn } from "../systems/consumables.ts";');
});

test("the handed-off save names its twin, the disconnect's saves", () => {
  const save = body("async function saveHandedOff(", "\n}\n");
  expect(has(save, "await player.setStats(p.username, p.stats)")).toBe(true);
  expect(has(save, "await player.setLocation(p.id, p.location.map, p.location.position)")).toBe(true);
  expect(has(save, "await achievements.onLeave({ player: p })")).toBe(true);
  // A warp hands off with the location already at the destination: the count it leaves is the old map's.
  expect(has(save, 'await worlds.adjustPlayerCount(p?.handoffFromMap || p?.location?.map || "", -1)')).toBe(true);
  expect(save.includes("clearSessionId")).toBe(false);
  const doc = serverSource.slice(serverSource.lastIndexOf("/**", serverSource.indexOf("async function saveHandedOff(")), serverSource.indexOf("async function saveHandedOff("));
  expect(doc).toContain("onDisconnect");
});

test("a switch ticket is spent when its connection opens, and an arrival's id comes before a new one", () => {
  const open = body("function onTransportOpen(", "\n}\n");
  expect(has(open, "connection.data.ticketSpent = spendsTicket(store, token)\n    ? spendTicket(store, token, Number(connection.data.ticketExpiresAt) || 0)\n    : null;")).toBe(true);
  const allocate = body("allocateId:", "certPem:");
  expect(has(allocate, "const kept = arrivalId(playerHandoff.claimArrivalId(token), connectionOpen);")).toBe(true);
  expect(has(allocate, "if (kept !== null) return kept;")).toBe(true);
  expect(at(allocate, "if (kept !== null) return kept;")).toBeLessThan(at(allocate, "cluster.ids.tryNext()"));
});

test("a shutdown keeps to one deadline: each step is bounded by its cap and the time left", () => {
  const shutdown = body("async function gracefulShutdown(", "\n}\n");
  const deadlineAt = at(shutdown, "const deadline = Date.now() + SHUTDOWN_DEADLINE_MS;");
  expect(deadlineAt).toBeGreaterThanOrEqual(0);
  expect(deadlineAt).toBeLessThan(at(shutdown, "gameLoop.stop()"));
  // Cluster mode keeps the last STOP_MS for leaving the cluster; with CLUSTER=false the steps have the whole deadline.
  const steps = [
    "const stepsDeadline = cluster ? deadline - STOP_MS : deadline;",
    "gameLoop.stop();",
    'const achievementsFlushed = boundedStep("", () => achievements.onSave(), stepsDeadline, ACHIEVEMENT_FLUSH_MS);',
    "playerHandoff.stop();",
    'await boundedStep("", () => playerHandoff.idle(), stepsDeadline, HANDOFF_IDLE_MS);',
    'await boundedStep("", () => client.unregister(), stepsDeadline, UNREGISTER_MS);',
    "webTransportServer.stop();",
    "await achievementsFlushed;",
    'await boundedStep("", () => achievements.onSave(), stepsDeadline, ACHIEVEMENT_FLUSH_MS);',
    'await boundedStep("", () => stopCluster(), deadline, STOP_MS);',
    "process.exit(0);",
  ];
  let last = -1;
  for (const step of steps) {
    const where = at(shutdown, step);
    expect(`${step} ${where > last}`).toBe(`${step} true`);
    last = where;
  }
  // Nothing in the shutdown waits outside a bounded step.
  expect(shutdown.match(/await /g)?.length).toBe(5);
  // The achievement write starts with the shutdown, and is waited for before the process exits.
  expect(at(shutdown, "achievementsFlushed")).toBeLessThan(at(shutdown, "playerHandoff.stop();"));
  // The caps are real waits, and the deadline sits under the compose files' 20 s stop grace.
  const idleMs = Number(serverCode.match(/const HANDOFF_IDLE_MS = ([\d_]+);/)?.[1]?.replaceAll("_", ""));
  expect(idleMs).toBeGreaterThan(0);
  expect(idleMs).toBeLessThan(guards.SHUTDOWN_DEADLINE_MS);
  for (const name of ["ACHIEVEMENT_FLUSH_MS", "STOP_MS", "UNREGISTER_MS"]) {
    const value = Number(serverCode.match(new RegExp(`const ${name} = ([\\d_]+);`))?.[1]?.replaceAll("_", ""));
    expect(`${name}: ${value > 0}`).toBe(`${name}: true`);
  }
  expect(guards.SHUTDOWN_DEADLINE_MS).toBeGreaterThan(0);
  expect(guards.SHUTDOWN_DEADLINE_MS).toBeLessThan(20_000);
  // Leaving the cluster always has its part, and the unregister cannot take all the time before it.
  expect(serverConst("STOP_MS")).toBeLessThan(guards.SHUTDOWN_DEADLINE_MS);
  expect(serverConst("UNREGISTER_MS")).toBeLessThan(guards.SHUTDOWN_DEADLINE_MS - serverConst("STOP_MS"));
});

/** A number constant of server.ts (`const NAME = 1_000;`, anywhere in the file). */
function serverConst(name: string): number {
  const value = Number(serverCode.match(new RegExp(`const ${name} = ([\\d_]+);`))?.[1]?.replaceAll("_", ""));
  expect(`${name}: ${value > 0}`).toBe(`${name}: true`);
  return value;
}

const transpiler = new Bun.Transpiler({ loader: "ts" });
/** A piece of server.ts's source made into a function of the given names (server.ts itself cannot be imported). */
function withNames(names: string[], code: string): (given: Record<string, any>) => any {
  return new Function(`"use strict";\n${transpiler.transformSync(`function make({ ${names.join(", ")} }: any) { ${code} }`)}\nreturn make;`)();
}
/** The source from `from` up to (not with) the first match of `until` after it. */
function sourceCut(from: string, until: RegExp): string {
  const start = serverSource.indexOf(from);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = serverSource.slice(start).search(until);
  expect(end).toBeGreaterThan(0);
  return serverSource.slice(start, start + end);
}

const shutdownNames = [
  "Date", "SHUTDOWN_DEADLINE_MS", "STOP_MS", "UNREGISTER_MS", "HANDOFF_IDLE_MS", "cluster", "log", "gameLoop", "playerHandoff",
  "boundedStep", "gatewayClient", "webTransportServer", "httpServers", "achievements", "stopCluster", "process",
];
const makeShutdown = withNames(shutdownNames, `${sourceCut("async function gracefulShutdown(", /\r?\n}\r?\n/)}\n}\nreturn gracefulShutdown;`);

/**
 * Runs server.ts's gracefulShutdown with its own constants and the real boundedStep, on a clock SPEED times as fast
 * (so 9 s take under a second). A step named in `hangs` never ends. Answers when each step started, in ms after the
 * signal.
 */
async function runShutdown(cluster: boolean, hangs: string[]): Promise<Record<string, number>> {
  const SPEED = 10;
  const t0 = Date.now();
  const clock = () => t0 + (Date.now() - t0) * SPEED;
  const at: Record<string, number> = {};
  // A step that runs twice (the achievement write) is recorded as "name" then "name 2".
  const step = (name: string) => () => {
    at[name in at ? `${name} 2` : name] = clock() - t0;
    return hangs.includes(name) ? new Promise(() => {}) : Promise.resolve();
  };
  let exited!: () => void;
  const exit = new Promise<void>((resolve) => {
    exited = resolve;
  });
  const shutdown = makeShutdown({
    Date: { now: clock },
    SHUTDOWN_DEADLINE_MS: guards.SHUTDOWN_DEADLINE_MS,
    STOP_MS: serverConst("STOP_MS"),
    UNREGISTER_MS: serverConst("UNREGISTER_MS"),
    HANDOFF_IDLE_MS: serverConst("HANDOFF_IDLE_MS"),
    cluster,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    gameLoop: { stop() {} },
    playerHandoff: { stop() {}, idle: step("idle") },
    // The real boundedStep, with its deadline and cap turned into real ms.
    boundedStep: (what: string, run: () => unknown, deadline: number, cap = Infinity) =>
      guards.boundedStep(what, run, t0 + (deadline - t0) / SPEED, cap / SPEED),
    gatewayClient: { unregister: step("unregister") },
    webTransportServer: { stop() {} },
    httpServers: { proxy: { stop() {} } },
    achievements: { onSave: step("flush") },
    stopCluster: step("stop"),
    process: {
      exit: (code: number) => {
        at[`exit ${code}`] = clock() - t0;
        exited();
      },
    },
  });
  const warn = spyOn(log, "warn").mockImplementation(() => {});
  const error = spyOn(log, "error").mockImplementation(() => {});
  try {
    void shutdown("SIGTERM");
    await exit;
  } finally {
    warn.mockRestore();
    error.mockRestore();
  }
  return at;
}

// Timer slack, in shutdown ms (a real ms is SPEED of them).
const SLACK_MS = 500;

test("a shutdown with a hanging gateway unregister still flushes the achievements and leaves the cluster, in time", async () => {
  const at = await runShutdown(true, ["unregister"]);
  expect(Object.keys(at)).toEqual(["flush", "idle", "unregister", "flush 2", "stop", "exit 0"]);
  // The flush starts with the shutdown, before the handoff wait and the unregister, and writes again after them.
  expect(at.flush).toBeLessThan(SLACK_MS);
  expect(at["flush 2"]).toBeGreaterThan(at.unregister);
  expect(at["exit 0"]).toBeLessThan(guards.SHUTDOWN_DEADLINE_MS);
});

test("a shutdown whose steps all hang still leaves the cluster with its full STOP_MS, and exits by the deadline", async () => {
  const at = await runShutdown(true, ["idle", "unregister", "flush", "stop"]);
  expect(at.stop).toBeDefined();
  expect(guards.SHUTDOWN_DEADLINE_MS - at.stop).toBeGreaterThan(serverConst("STOP_MS") - SLACK_MS);
  expect(at["exit 0"]).toBeLessThan(guards.SHUTDOWN_DEADLINE_MS + SLACK_MS);
});

test("running handoffs that take their whole wait still leave the achievements written", async () => {
  const at = await runShutdown(true, ["idle"]);
  // The flush ran at the start, not after the handoff wait used up the steps' time.
  expect(at.flush).toBeLessThan(SLACK_MS);
  expect(at.flush).toBeLessThan(at.idle + SLACK_MS);
  expect(at.stop).toBeDefined();
});

test("with CLUSTER=false a hanging gateway unregister still lets the achievements flush", async () => {
  const at = await runShutdown(false, ["unregister"]);
  expect(Object.keys(at)).toEqual(["flush", "unregister", "flush 2", "exit 0"]);
  expect(at.flush).toBeLessThan(SLACK_MS);
  expect(at["exit 0"]).toBeLessThan(guards.SHUTDOWN_DEADLINE_MS);
});

test("a player who leaves while a warp's handoff runs is counted off the map they were on", async () => {
  const names = [
    "playerCache", "packetManager", "console", "effectManager", "dots", "getStunsForPlayer", "getSlowsForPlayer",
    "saveSicknessOnDisconnect", "loot", "cleanupPlayerState", "releaseDraggedBy", "listener", "Events",
    "removeFromAuthenticationQueues", "worlds", "log", "player", "clusterEnabled", "isOnline", "deliverToPlayer", "forgetPlayer",
  ];
  const source = sourceCut('listener.on("onDisconnect", ', /\r?\n}\);\r?\n/).replace('listener.on("onDisconnect", ', "");
  const make = withNames(names, `return ${source}\n};`);
  const run = async (playerData: any) => {
    const counted: string[] = [];
    const errors: unknown[] = [];
    const handler = make({
      playerCache: { get: (id: string) => (id === playerData.id ? playerData : undefined), getByUsername: () => playerData },
      packetManager: {},
      console: { error() {} },
      effectManager: {},
      dots: {},
      getStunsForPlayer: () => [],
      getSlowsForPlayer: () => [],
      saveSicknessOnDisconnect() {},
      loot: {},
      cleanupPlayerState() {},
      releaseDraggedBy() {},
      listener: { emit() {} },
      Events: { PLAYER_DISCONNECT: "PLAYER_DISCONNECT" },
      removeFromAuthenticationQueues() {},
      worlds: {
        adjustPlayerCount: async (map: string, by: number) => {
          counted.push(`${map} ${by}`);
          return 0;
        },
      },
      log: { error: (e: unknown) => errors.push(e), warn() {}, info() {}, debug() {} },
      player: { clearSessionId: async () => {} },
      clusterEnabled: () => false,
      isOnline: async () => false,
      deliverToPlayer: async () => {},
      forgetPlayer: async () => {},
    });
    await handler({ id: playerData.id, reason: "player_left" });
    expect(errors).toEqual([]);
    return counted;
  };
  // Mid-warp: the location is already the destination, and the count leaves the old map.
  expect(await run({ id: "880050", username: "Warper", isGuest: true, handoffFromMap: "old_map", location: { map: "new_map" } })).toEqual(["old_map -1"]);
  // Any other leave: the map they are on, as before.
  expect(await run({ id: "880051", username: "Walker", isGuest: true, location: { map: "main" } })).toEqual(["main -1"]);
});

test("the compose files give the engine a 20 s stop grace", () => {
  const dir = join(import.meta.dir, "..", "docker");
  for (const file of ["docker-compose.cluster.yml", "docker-compose.dev.yml", "docker-compose.prod.yml"]) {
    expect(`${file}: ${readFileSync(join(dir, file), "utf8").includes("stop_grace_period: 20s")}`).toBe(`${file}: true`);
  }
  // In the cluster stack bun gets the SIGTERM itself (sh does not pass it on).
  expect(readFileSync(join(dir, "docker-compose.cluster.yml"), "utf8")).toContain("&& exec bun ./src/socket/server.ts");
});
