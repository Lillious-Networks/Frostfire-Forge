import { expect, test, mock, beforeEach, afterEach, describe } from "bun:test";
import { databaseModule } from "./setup";
import { receiverSource } from "./receiver-source";

// Players mirrored from a neighbouring node (cluster mode, phase 4): the players
// ghost kind, and the AOI paths that read a mirror like a local player. Uses the
// real AOI / index modules (only the database is stubbed); each test gets its
// own map name because LayerManager has no reset.
mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (_sql: string, _params?: any[]) => [],
}));

// MAX_PLAYERS_PER_LAYER (per block) and BLOCK_SIZE_PX stay at their defaults:
// the layer manager singleton may already have been built by another test file.
const aoiConfig: Record<string, any> = {
  DEFAULT_RADIUS: 1000,
  UPDATE_THRESHOLD: 100,
  GRID_CELL_SIZE: 512,
  USE_SPATIAL_GRID: true,
  SPATIAL_GRID_THRESHOLD: 50,
  MAX_PLAYERS_PER_LAYER: 50,
  DEBUG: false,
};
mock.module("../config/aoi.json", () => ({ default: aoiConfig, ...aoiConfig }));

const playerCache = (await import("../services/playermanager")).default;
const mapIndex = (await import("../services/mapindex")).default;
const spatialGrid = (await import("../services/spatialgrid")).default;
const aoiReverse = await import("../services/aoiReverseIndex");
const {
  initializePlayerAOI,
  updatePlayerAOI,
  getPlayersNearPoint,
  updateMirrorViewers,
  queueSpawnPlayerPacket,
  broadcastToAOI,
  broadcastToAOIBestEffort,
  broadcastStatsUpdateToAOI,
  broadcastCastToAOI,
  broadcastGroundPreviewToAOI,
  clearGroundPreviewForAOI,
  broadcastPlayerUpdate,
} = await import("../socket/aoi");
const { broadcastEffectsUpdate, getEffectsState, mirrorEffectsPayload } = await import("../systems/spelleffects");
const { ghosts, Ghosts } = await import("../cluster/ghosts");
const { BorderBand } = await import("../cluster/strip");
const { playerGhostKind, playerGhostRecord } = await import("../cluster/kinds/players");
const { mirrorPlayers, entityById } = await import("../cluster/mirrors");
const { directionCode, FLAG_MOVING, FLAG_STEALTH } = await import("../cluster/linkproto");

function decode(packet: Uint8Array): any {
  return JSON.parse(new TextDecoder().decode(packet));
}

// A socket stand-in that records what it was sent (reliable and datagram).
function recordingWt(): any {
  const wt: any = { readyState: 1, sent: [] as any[] };
  wt.send = (packet: Uint8Array) => wt.sent.push(decode(packet));
  wt.sendBestEffort = (packet: Uint8Array) => wt.sent.push(decode(packet));
  return wt;
}

let mapSeq = 0;

function resetWorld() {
  playerCache.clear();
  mapIndex.clear();
  spatialGrid.clear();
  aoiReverse._reset();
}

function makePlayer(id: string, username: string, map: string, x: number, y: number): any {
  return {
    id,
    username,
    location: { map, position: { x, y, direction: "down" } },
    wt: { readyState: 1, send: () => {} },
    party: [],
    party_id: null,
    moving: false,
  };
}

function deps() {
  const moves: Array<{ id: string; final: boolean }> = [];
  return {
    moves,
    deps: {
      queueMove: (mirror: any, final: boolean) => moves.push({ id: mirror.id, final }),
      spawnQueue: new Map<string, Map<string, any>>(),
      despawnQueue: new Map<string, Set<string>>(),
    },
  };
}

async function viewerAt(id: string, map: string, x: number, y: number) {
  const viewer = makePlayer(id, `viewer${id}`, map, x, y);
  viewer.wt = recordingWt();
  playerCache.add(id, viewer);
  await initializePlayerAOI(viewer);
  return viewer;
}

function record(id: string, map: string, x: number, y: number, over: any = {}) {
  return {
    id, userid: 1, username: `ghost${id}`, layerId: null,
    location: { map, position: { x, y, direction: "down" } },
    moving: false, isAdmin: false, isGuest: false, isStealth: false, isVanished: false, isNoclip: false,
    isDead: false, isGhost: false, ghostTeleportPending: false, stats: { health: 50, total_max_health: 100, level: 3 },
    mounted: false, mount_type: null, guild: null, guild_name: null, equipment: null, equipmentRevision: 0,
    casting: false, party: [], effects: [{ id: "barrier" }], ...over,
  };
}

const packet = (type: string) => new TextEncoder().encode(JSON.stringify({ type, data: 1 }));

// Every ghosts.relay call, while a test spies on it (the singleton is never attached here, so it would do nothing).
let relays: any[][] = [];

beforeEach(() => {
  resetWorld();
  for (const id of [...mirrorPlayers.keys()]) mirrorPlayers.delete(id);
  relays = [];
  (ghosts as any).relay = (...args: any[]) => { relays.push(args); };
});

afterEach(() => {
  delete (ghosts as any).relay;
});

test("a mirror near a local player is seen by them, never added to playerCache", async () => {
  const map = `m${++mapSeq}`;
  const viewer = await viewerAt("1", map, 1000, 1000);
  // A mirror is put on the viewer's layer, as the owner would send it.
  const layerId = viewer.aoi.layerId;
  const { deps: d } = deps();
  const kind = playerGhostKind(d);
  kind.spawn(record("900", map, 1100, 1000, { layerId }), "a");
  expect(playerCache.get("900")).toBeUndefined();
  expect(entityById("900")?.remote).toBe(true);
  expect(spatialGrid.isRemote("900")).toBe(true);
  expect(viewer.aoi.playersInAOI.has("900")).toBe(true);
  expect(aoiReverse.getViewers("900").has("1")).toBe(true);
  expect(d.spawnQueue.get("1")?.get("900")?.username).toBe("ghost900");
});

test("a mirror walking away is dropped by idle viewers", async () => {
  const map = `m${++mapSeq}`;
  const viewer = await viewerAt("1", map, 1000, 1000);
  const { deps: d, moves } = deps();
  const kind = playerGhostKind(d);
  kind.spawn(record("901", map, 1100, 1000, { layerId: viewer.aoi.layerId }), "a");
  kind.move!("901", 4000, 1000, directionCode("right"), FLAG_MOVING);
  expect(moves).toEqual([{ id: "901", final: false }]);
  // The viewer update is throttled to AOI_UPDATE_MS: force it, as the next one would.
  updateMirrorViewers(entityById("901"), d.spawnQueue, d.despawnQueue);
  expect(viewer.aoi.playersInAOI.has("901")).toBe(false);
});

test("a mirror that stops is checked against its viewers at once, and a keyframe changes nothing", async () => {
  const map = `m${++mapSeq}`;
  const viewer = await viewerAt("1", map, 1000, 1000);
  const { deps: d, moves } = deps();
  const kind = playerGhostKind(d);
  kind.spawn(record("911", map, 1100, 1000, { layerId: viewer.aoi.layerId }), "a");
  kind.move!("911", 4000, 1000, directionCode("right"), 0);
  expect(moves).toEqual([{ id: "911", final: true }]);
  expect(viewer.aoi.playersInAOI.has("911")).toBe(false);
  kind.move!("911", 4000, 1000, directionCode("right"), 0);
  expect(moves.length).toBe(1);
});

test("a local mover's own AOI update sees mirrors and leaves them untouched", async () => {
  const map = `m${++mapSeq}`;
  const mover = await viewerAt("2", map, 1000, 1000);
  const { deps: d } = deps();
  const kind = playerGhostKind(d);
  // Far first, so only the mover's own update can find it.
  kind.spawn(record("902", map, 6000, 1000, { layerId: mover.aoi.layerId }), "a");
  entityById("902").location.position.x = 1200;
  spatialGrid.updatePlayer("902", 1200, 1000, map);
  await updatePlayerAOI(mover, new Map(), new Map());
  expect(mover.aoi.playersInAOI.has("902")).toBe(true);
  expect(entityById("902").aoi.playersInAOI.size).toBe(0);
  expect(playerCache.get("902")).toBeUndefined();
});

test("relayed packets go to the mirror's viewers; a mirror never relays on", async () => {
  const map = `m${++mapSeq}`;
  const viewer = await viewerAt("1", map, 1000, 1000);
  const { deps: d } = deps();
  const kind = playerGhostKind(d);
  kind.spawn(record("903", map, 1100, 1000, { layerId: viewer.aoi.layerId }), "a");
  kind.relay!("903", [packet("TEST")], false);
  expect(viewer.wt.sent.some((p: any) => p.type === "TEST")).toBe(true);
});

test("a stealthed mirror's relayed packets reach admins only", async () => {
  const map = `m${++mapSeq}`;
  const viewer = await viewerAt("1", map, 1000, 1000);
  const admin = await viewerAt("2", map, 1050, 1000);
  admin.isAdmin = true;
  const { deps: d } = deps();
  const kind = playerGhostKind(d);
  kind.spawn(record("913", map, 1100, 1000, { layerId: viewer.aoi.layerId, isStealth: true }), "a");
  // Neither is sent a spawn of a stealthed player but the admin.
  expect(d.spawnQueue.get("1")?.has("913") ?? false).toBe(false);
  expect(d.spawnQueue.get("2")?.has("913")).toBe(true);
  kind.relay!("913", [packet("SECRET")], true);
  expect(viewer.wt.sent.some((p: any) => p.type === "SECRET")).toBe(false);
  expect(admin.wt.sent.some((p: any) => p.type === "SECRET")).toBe(true);
});

test("a mirror leaving stealth is spawned for the viewers who could not see it, and despawned going back", async () => {
  const map = `m${++mapSeq}`;
  const viewer = await viewerAt("1", map, 1000, 1000);
  const admin = await viewerAt("2", map, 1050, 1000);
  admin.isAdmin = true;
  const { deps: d } = deps();
  const kind = playerGhostKind(d);
  kind.spawn(record("914", map, 1100, 1000, { layerId: viewer.aoi.layerId, isStealth: true }), "a");
  // The owner's moves stop carrying the stealth flag (the move input is clear); the state clears it below.
  kind.move!("914", 1100, 1000, directionCode("down"), 0);
  d.spawnQueue.clear();
  kind.update!("914", { isStealth: false });
  expect(d.spawnQueue.get("1")?.get("914")?.isStealth).toBe(false);
  // The admin saw it all along.
  expect(d.spawnQueue.get("2")?.has("914") ?? false).toBe(false);
  d.spawnQueue.clear();
  kind.update!("914", { isStealth: true });
  expect(d.despawnQueue.get("1")?.has("914")).toBe(true);
  expect(d.despawnQueue.get("2")?.has("914") ?? false).toBe(false);
  // Still in the viewer's AOI, as a stealthed local player stays.
  expect(viewer.aoi.playersInAOI.has("914")).toBe(true);
});

test("despawn removes the mirror everywhere", async () => {
  const map = `m${++mapSeq}`;
  const viewer = await viewerAt("1", map, 1000, 1000);
  const { deps: d } = deps();
  const kind = playerGhostKind(d);
  kind.spawn(record("904", map, 1100, 1000, { layerId: viewer.aoi.layerId }), "a");
  kind.despawn("904", "left");
  expect(entityById("904")).toBeUndefined();
  expect(spatialGrid.hasPlayer("904")).toBe(false);
  expect(viewer.aoi.playersInAOI.has("904")).toBe(false);
  expect(d.spawnQueue.get("1")?.has("904") ?? false).toBe(false);
  const despawns = viewer.wt.sent.filter((p: any) => p.type === "DESPAWN_PLAYER");
  expect(despawns.map((p: any) => p.data.id)).toEqual(["904"]);
});

test("a spawn for a local player's id is ignored", async () => {
  const map = `m${++mapSeq}`;
  await viewerAt("5", map, 1000, 1000);
  const { deps: d } = deps();
  expect(playerGhostKind(d).spawn(record("5", map, 1100, 1000), "a")).toBe(false);
  expect(mirrorPlayers.has("5")).toBe(false);
  expect(entityById("5").remote).toBeUndefined();
});

test("a stale mirror of a player who is now local is dropped without touching the local player", async () => {
  const map = `m${++mapSeq}`;
  const viewer = await viewerAt("1", map, 1000, 1000);
  const { deps: d } = deps();
  const kind = playerGhostKind(d);
  kind.spawn(record("6", map, 1100, 1000, { layerId: viewer.aoi.layerId }), "a");
  expect(viewer.aoi.playersInAOI.has("6")).toBe(true);
  // The player logs in here before the old node's despawn arrives: the login drops the mirror.
  const local = await viewerAt("6", map, 1100, 1000);
  expect(mirrorPlayers.has("6")).toBe(false);
  spatialGrid.addPlayer("6", 1100, 1000, map);
  expect(spatialGrid.isRemote("6")).toBe(false);
  const sentBefore = viewer.wt.sent.length;
  // Late messages for the id: none reaches the local player's grid entry or viewers.
  kind.move!("6", 3000, 1000, directionCode("right"), FLAG_MOVING);
  kind.update!("6", { isStealth: true });
  kind.relay!("6", [packet("LATE")], false);
  kind.despawn("6", "left");
  expect(spatialGrid.hasPlayer("6")).toBe(true);
  expect(viewer.aoi.playersInAOI.has("6")).toBe(true);
  expect(aoiReverse.getViewers("6").has("1")).toBe(true);
  expect(viewer.wt.sent.length).toBe(sentBefore);
  expect(local.isStealth).toBeUndefined();
  expect(local.location.position.x).toBe(1100);
});

test("a re-sent spawn replaces the mirror's record and keeps its viewers", async () => {
  const map = `m${++mapSeq}`;
  const viewer = await viewerAt("1", map, 1000, 1000);
  const { deps: d } = deps();
  const kind = playerGhostKind(d);
  kind.spawn(record("907", map, 1100, 1000, { layerId: viewer.aoi.layerId, guild_name: "Old" }), "a");
  const { guild_name: _dropped, ...rest } = record("907", map, 1150, 1000, { layerId: viewer.aoi.layerId });
  kind.spawn(rest, "b");
  const mirror = entityById("907");
  expect(mirror.guild_name).toBeUndefined();
  expect(mirror.mirrorFrom).toBe("b");
  expect(mirror.location.position.x).toBe(1150);
  expect(viewer.aoi.playersInAOI.has("907")).toBe(true);
  expect(mirrorPlayers.size).toBe(1);
});

test("a state change applies fields, and null clears one", async () => {
  const map = `m${++mapSeq}`;
  const { deps: d } = deps();
  const kind = playerGhostKind(d);
  kind.spawn(record("908", map, 100, 100, { guild_name: "Guild" }), "a");
  kind.update!("908", { guild_name: null, stats: { health: 20, total_max_health: 100, level: 4 }, username: "renamed" });
  const mirror = entityById("908");
  expect("guild_name" in mirror).toBe(false);
  expect(mirror.stats.health).toBe(20);
  // Identity fields are not the state's to change.
  expect(mirror.username).toBe("ghost908");
});

test("a layer change in the state moves the mirror to that layer's viewers", async () => {
  const map = `m${++mapSeq}`;
  const viewer = await viewerAt("1", map, 1000, 1000);
  const { deps: d } = deps();
  const kind = playerGhostKind(d);
  kind.spawn(record("909", map, 1100, 1000, { layerId: viewer.aoi.layerId }), "a");
  expect(viewer.aoi.playersInAOI.has("909")).toBe(true);
  kind.update!("909", { layerId: `${map}:elsewhere` });
  expect(entityById("909").aoi.layerId).toBe(`${map}:elsewhere`);
  expect(viewer.aoi.playersInAOI.has("909")).toBe(false);
});

test("area effects never pick up a mirror as a target here", async () => {
  const map = `m${++mapSeq}`;
  const viewer = await viewerAt("1", map, 1000, 1000);
  const { deps: d } = deps();
  playerGhostKind(d).spawn(record("910", map, 1010, 1000, { layerId: viewer.aoi.layerId }), "a");
  const hit = getPlayersNearPoint(1000, 1000, map, 200, viewer.aoi.layerId);
  expect(hit.map((p: any) => String(p.id))).toEqual(["1"]);
});

test("the spawn packet of a mirror carries the owner's effects", () => {
  const map = `m${++mapSeq}`;
  const { deps: d } = deps();
  playerGhostKind(d).spawn(record("906", map, 100, 100), "a");
  expect(queueSpawnPlayerPacket(entityById("906"))?.effects).toEqual([{ id: "barrier" }]);
});

test("the owner's record is JSON-safe and has no socket", async () => {
  const map = `m${++mapSeq}`;
  const local = await viewerAt("7", map, 500, 500);
  local.stats = { health: 10 };
  const snapshot = playerGhostRecord(local);
  expect(snapshot.wt).toBeUndefined();
  expect(snapshot.pvp).toBe(false);
  local.pvp = true;
  expect(playerGhostRecord(local).pvp).toBe(true);
  expect(JSON.parse(JSON.stringify(snapshot)).username).toBe("viewer7");
  const { deps: d } = deps();
  const kind = playerGhostKind(d);
  const candidates = [...kind.candidates()];
  expect(candidates.find((c) => c.id === "7")).toMatchObject({ num: 7, map, x: 500, y: 500 });
  // The state carries the layer: Ghosts re-spawns a mirror on a map change only.
  expect(kind.state!("7")).toMatchObject({ layerId: local.aoi.layerId ?? null });
});

test("the player kind lists only the players in blocks of the border band", async () => {
  const map = `m${++mapSeq}`;
  await viewerAt("7", map, 500, 500);
  await viewerAt("8", map, 3 * 4096 + 500, 500);
  const { deps: d } = deps();
  const kind = playerGhostKind(d);
  const own = (nodeId: string) => ({ nodeId, epoch: 1, since: 0 });
  // b owns block 1: block 0 borders it and block 3 does not.
  const band = new BorderBand(() => ({ "0,0": own("a"), "1,0": own("b"), "2,0": own("a"), "3,0": own("a") }), "a", () => [map]);
  expect([...kind.candidates(band)].map((c) => c.id).filter((id) => id === "7" || id === "8")).toEqual(["7"]);
  const alone = new BorderBand(() => ({ "0,0": own("a"), "3,0": own("a") }), "a", () => [map]);
  expect([...kind.candidates(alone)].filter((c) => c.map === map)).toEqual([]);
});

test("the player kind gives the band a .json map as it is, and lists the player under the bare name", async () => {
  const map = `m${++mapSeq}`;
  const player = await viewerAt("7", map, 500, 500);
  player.location.map = `${map}.json`;
  const { deps: d } = deps();
  const kind = playerGhostKind(d);
  const own = (nodeId: string) => ({ nodeId, epoch: 1, since: 0 });
  const asked: string[] = [];
  const table: Record<string, ReturnType<typeof own>> = { "0,0": own("a"), "1,0": own("b") };
  const band = new BorderBand((name) => { asked.push(name); return name.endsWith(".json") ? table : {}; }, "a", () => [map]);
  const listed = [...kind.candidates(band)].filter((c) => c.id === "7");
  expect(listed).toHaveLength(1);
  expect(listed[0]!.map).toBe(map);
  expect(asked).toContain(`${map}.json`);
});

test("a re-sent spawn that ends the stealth spawns the mirror for the viewers who could not see it", async () => {
  const map = `m${++mapSeq}`;
  const viewer = await viewerAt("1", map, 1000, 1000);
  const admin = await viewerAt("2", map, 1050, 1000);
  admin.isAdmin = true;
  const { deps: d } = deps();
  const kind = playerGhostKind(d);
  kind.spawn(record("920", map, 1100, 1000, { layerId: viewer.aoi.layerId, isStealth: true }), "a");
  d.spawnQueue.clear();
  kind.spawn(record("920", map, 1100, 1000, { layerId: viewer.aoi.layerId, isStealth: false }), "b");
  expect(d.spawnQueue.get("1")?.get("920")?.isStealth).toBe(false);
  expect(d.despawnQueue.get("1")?.has("920") ?? false).toBe(false);
  // The admin saw it all along, and is sent it afresh for its look.
  expect(d.spawnQueue.get("2")?.has("920")).toBe(true);
  expect(d.despawnQueue.get("2")?.has("920") ?? false).toBe(false);
});

test("a re-sent spawn that starts the stealth despawns the mirror for the viewers who lose it", async () => {
  const map = `m${++mapSeq}`;
  const viewer = await viewerAt("1", map, 1000, 1000);
  const admin = await viewerAt("2", map, 1050, 1000);
  admin.isAdmin = true;
  const { deps: d } = deps();
  const kind = playerGhostKind(d);
  kind.spawn(record("921", map, 1100, 1000, { layerId: viewer.aoi.layerId }), "a");
  d.spawnQueue.clear();
  kind.spawn(record("921", map, 1100, 1000, { layerId: viewer.aoi.layerId, isStealth: true }), "b");
  expect(d.despawnQueue.get("1")?.has("921")).toBe(true);
  expect(d.spawnQueue.get("1")?.has("921") ?? false).toBe(false);
  expect(d.despawnQueue.get("2")?.has("921") ?? false).toBe(false);
  expect(d.spawnQueue.get("2")?.get("921")?.isStealth).toBe(true);
  // Still in the viewer's AOI, as a stealthed local player stays.
  expect(viewer.aoi.playersInAOI.has("921")).toBe(true);
});

test("a re-sent spawn sends the new look to the current viewers", async () => {
  const map = `m${++mapSeq}`;
  const viewer = await viewerAt("1", map, 1000, 1000);
  const { deps: d } = deps();
  const kind = playerGhostKind(d);
  kind.spawn(record("922", map, 1100, 1000, { layerId: viewer.aoi.layerId, guild_name: "Old" }), "a");
  d.spawnQueue.clear();
  kind.spawn(record("922", map, 1100, 1000, { layerId: viewer.aoi.layerId, guild_name: "New" }), "a");
  expect(d.spawnQueue.get("1")?.get("922")?.guild_name).toBe("New");
});

test("a move without the stealth flag never shows a mirror the state says is stealthed", async () => {
  const map = `m${++mapSeq}`;
  const viewer = await viewerAt("1", map, 1000, 1000);
  const admin = await viewerAt("2", map, 1050, 1000);
  admin.isAdmin = true;
  const { deps: d } = deps();
  const kind = playerGhostKind(d);
  kind.spawn(record("924", map, 1100, 1000, { layerId: viewer.aoi.layerId, isStealth: true }), "a");
  d.spawnQueue.clear();
  // A late datagram sent before the stealth started.
  kind.move!("924", 1100, 1000, directionCode("down"), 0);
  kind.move!("924", 1120, 1000, directionCode("right"), FLAG_MOVING);
  expect(entityById("924").isStealth).toBe(true);
  expect(d.spawnQueue.get("1")?.has("924") ?? false).toBe(false);
  kind.relay!("924", [packet("SECRET")], false);
  expect(viewer.wt.sent.some((p: any) => p.type === "SECRET")).toBe(false);
  expect(admin.wt.sent.some((p: any) => p.type === "SECRET")).toBe(true);
});

test("a state that clears the stealth does not show the mirror while moves still carry the flag", async () => {
  const map = `m${++mapSeq}`;
  const viewer = await viewerAt("1", map, 1000, 1000);
  const { deps: d } = deps();
  const kind = playerGhostKind(d);
  kind.spawn(record("925", map, 1100, 1000, { layerId: viewer.aoi.layerId, isStealth: true }), "a");
  d.spawnQueue.clear();
  kind.update!("925", { isStealth: false });
  expect(entityById("925").isStealth).toBe(true);
  expect(d.spawnQueue.get("1")?.has("925") ?? false).toBe(false);
  // The next move or keyframe without the flag shows it.
  kind.move!("925", 1100, 1000, directionCode("down"), 0);
  expect(entityById("925").isStealth).toBe(false);
  expect(d.spawnQueue.get("1")?.get("925")?.isStealth).toBe(false);
});

// The move input alone: a stale move with the flag after the stealth ended hides, and the next move without it heals.
test("the stealth flag on a move hides the mirror at once, and showing it again spawns it", async () => {
  const map = `m${++mapSeq}`;
  const viewer = await viewerAt("1", map, 1000, 1000);
  const admin = await viewerAt("2", map, 1050, 1000);
  admin.isAdmin = true;
  const { deps: d } = deps();
  const kind = playerGhostKind(d);
  kind.spawn(record("923", map, 1100, 1000, { layerId: viewer.aoi.layerId }), "a");
  d.spawnQueue.clear();
  kind.move!("923", 1100, 1000, directionCode("down"), FLAG_STEALTH);
  expect(entityById("923").isStealth).toBe(true);
  expect(d.despawnQueue.get("1")?.has("923")).toBe(true);
  expect(d.despawnQueue.get("2")?.has("923") ?? false).toBe(false);
  // The relayed packets of a stealthed player now reach the admin only.
  kind.relay!("923", [packet("SECRET")], false);
  expect(viewer.wt.sent.some((p: any) => p.type === "SECRET")).toBe(false);
  expect(admin.wt.sent.some((p: any) => p.type === "SECRET")).toBe(true);
  d.despawnQueue.clear();
  kind.move!("923", 1100, 1000, directionCode("down"), 0);
  expect(entityById("923").isStealth).toBe(false);
  expect(d.spawnQueue.get("1")?.get("923")?.isStealth).toBe(false);
  expect(d.spawnQueue.get("2")?.has("923") ?? false).toBe(false);
});

test("at the visibility cap a nearer mirror takes the farthest member's place", async () => {
  const map = `m${++mapSeq}`;
  const viewer = await viewerAt("1", map, 1000, 1000);
  const { deps: d } = deps();
  const kind = playerGhostKind(d);
  kind.spawn(record("930", map, 1800, 1000, { layerId: viewer.aoi.layerId }), "a");
  expect(viewer.aoi.playersInAOI.has("930")).toBe(true);
  aoiConfig.MAX_VISIBLE_PLAYERS = 1;
  try {
    kind.spawn(record("931", map, 1050, 1000, { layerId: viewer.aoi.layerId }), "a");
  } finally {
    delete aoiConfig.MAX_VISIBLE_PLAYERS;
  }
  expect(viewer.aoi.playersInAOI.has("931")).toBe(true);
  expect(viewer.aoi.playersInAOI.has("930")).toBe(false);
  expect(d.despawnQueue.get("1")?.has("930")).toBe(true);
  expect(d.spawnQueue.get("1")?.has("930") ?? false).toBe(false);
});

describe("relays to the neighbours", () => {
  // A local player with a numeric id: the relay is keyed by the string form.
  const owner = () => ({
    id: 42, username: "owner", location: { map: "relaymap", position: { x: 10, y: 10, direction: "down" } },
    aoi: { playersInAOI: new Set<string>(), aoiRadius: 1000, revision: 0, layerId: null }, party: [], stats: {},
  });
  const frames = [packet("X")];

  for (const [name, send, bestEffort] of [
    ["broadcastToAOI", (p: any) => broadcastToAOI(p, frames, false), false],
    ["broadcastToAOIBestEffort", (p: any) => broadcastToAOIBestEffort(p, frames, false), true],
    ["broadcastCastToAOI", (p: any) => broadcastCastToAOI(p, frames), true],
    ["broadcastGroundPreviewToAOI", (p: any) => broadcastGroundPreviewToAOI(p, frames), true],
    ["clearGroundPreviewForAOI", (p: any) => clearGroundPreviewForAOI(p, frames), false],
  ] as Array<[string, (p: any) => void, boolean]>) {
    test(`${name} relays once, with the string id`, () => {
      send(owner());
      expect(relays).toEqual([["player", "42", frames, bestEffort]]);
    });
  }

  test("broadcastStatsUpdateToAOI relays once, for the target", () => {
    const caster = { ...owner(), id: 7 };
    broadcastStatsUpdateToAOI(owner(), caster, frames);
    expect(relays).toEqual([["player", "42", frames, true]]);
  });

  test("broadcastPlayerUpdate relays the spawn frames once, reliably", () => {
    broadcastPlayerUpdate(owner());
    expect(relays.length).toBe(1);
    expect(relays[0][0]).toBe("player");
    expect(relays[0][1]).toBe("42");
    expect(decode(relays[0][2][0]).type).toBe("SPAWN_PLAYER");
    expect(relays[0][3]).toBe(false);
  });

  test("broadcastEffectsUpdate relays once, reliably, and not while vanished", () => {
    broadcastEffectsUpdate(owner());
    expect(relays.length).toBe(1);
    expect(relays[0][1]).toBe("42");
    expect(decode(relays[0][2][0]).type).toBe("EFFECTS");
    expect(relays[0][3]).toBe(false);
    relays = [];
    broadcastEffectsUpdate({ ...owner(), isVanished: true });
    expect(relays).toEqual([]);
  });

  test("a mirror relays nothing on", async () => {
    const map = `m${++mapSeq}`;
    const viewer = await viewerAt("1", map, 1000, 1000);
    const { deps: d } = deps();
    const kind = playerGhostKind(d);
    kind.spawn(record("940", map, 1100, 1000, { layerId: viewer.aoi.layerId }), "a");
    const mirror = entityById("940");
    kind.relay!("940", frames, false);
    kind.relay!("940", frames, true);
    broadcastToAOI(mirror, frames, false);
    broadcastCastToAOI(mirror, frames);
    broadcastStatsUpdateToAOI(mirror, null, frames);
    broadcastPlayerUpdate(mirror);
    broadcastEffectsUpdate(mirror);
    expect(relays).toEqual([]);
  });
});

describe("the receiver's cluster wiring (read from its source: receiver.ts cannot be imported)", () => {
  const receiver = receiverSource();
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const cut = (from: string, until: RegExp) => {
    const start = receiver.indexOf(from);
    if (start < 0) throw new Error(`Not found in the source: ${from}`);
    const rest = receiver.slice(start);
    const end = rest.search(until);
    if (end < 0) throw new Error(`No end found for: ${from}`);
    return rest.slice(0, end);
  };
  const withNames = (names: string[], code: string): ((given: Record<string, any>) => any) =>
    new Function(`"use strict";\n${transpiler.transformSync(`function make({ ${names.join(", ")} }: any) { ${code} }`)}\nreturn make;`)();

  const chatStart = "// Cluster mode: listeners across a block border";
  const chat = withNames(
    ["clusterEnabled", "currentPlayer", "forwardAoiEvent", "MIRROR_RADIUS_PX", "packetManager", "wt", "sentMessage", "sentLinks"],
    cut(chatStart, /listener\.emit\(Events\.PLAYER_CHAT/),
  );
  const runChat = (cluster: boolean, over: any = {}) => {
    const calls: any[][] = [];
    chat({
      clusterEnabled: () => cluster,
      currentPlayer: { username: "talker", location: { map: "main", position: { x: 5, y: 6 } }, aoi: { layerId: "main:1" }, ...over },
      forwardAoiEvent: (...args: any[]) => calls.push(args),
      MIRROR_RADIUS_PX: 1234,
      packetManager: { chat: (data: any) => [data] },
      wt: { data: { id: "77" } },
      sentMessage: "hello",
      sentLinks: [],
    });
    return calls;
  };

  test("a chat line is forwarded once, from the speaker's place", () => {
    expect(runChat(true)).toEqual([["main", "main:1", 5, 6, 1234, [{ id: "77", message: "hello", username: "talker" }], { speaker: "talker" }]]);
  });

  test("a chat line is not forwarded with cluster off, or from a stealthed or vanished speaker", () => {
    expect(runChat(false)).toEqual([]);
    expect(runChat(true, { isStealth: true })).toEqual([]);
    expect(runChat(true, { isVanished: true })).toEqual([]);
  });

  test("the chat forward comes after the mute check and before the no-listener return", () => {
    const at = receiver.indexOf(chatStart);
    const muted = receiver.lastIndexOf("if (said.muted) return;", at);
    expect(muted).toBeGreaterThan(0);
    expect(at - muted).toBeLessThan(1000);
    const empty = receiver.indexOf("if (playersInMap.length === 0) return;", at);
    expect(empty).toBeGreaterThan(at);
    expect(empty - at).toBeLessThan(2000);
  });

  test("a stealth toggle is relayed to the mirrors' viewers, reliably", () => {
    const handler = cut('case "STEALTH": {', /\r?\n {6}case "/);
    expect(handler).toContain('ghosts.relay("player", String(currentPlayer.id), packetManager.stealth(stealthData), false);');
  });

  test("a mirror's step is queued under its layer, as a local walker's", () => {
    const body = cut("export function queueRemoteMovement", /\r?\n}\r?\n/).replace("export ", "");
    const queue = withNames(["movementBatchQueue", "globalStateRevision"], `${body}\n}\nreturn queueRemoteMovement;`);
    const movementBatchQueue = new Map<string, Map<string, any>>();
    const queueRemoteMovement = queue({ movementBatchQueue, globalStateRevision: 9 });
    const mirror = { id: "950", isStealth: true, aoi: { layerId: "main:2" }, location: { map: "main", position: { x: 1, y: 2, direction: "up" } } };
    queueRemoteMovement(mirror, false);
    expect(movementBatchQueue.get("main:2")?.get("950")).toEqual({ i: "950", d: { x: 1, y: 2, dr: "up" }, r: 9, s: 1 });
    queueRemoteMovement({ ...mirror, isStealth: false, aoi: { layerId: null } }, true);
    expect(movementBatchQueue.get("main")?.get("950")).toEqual({ i: "950", d: { x: 1, y: 2, dr: "up" }, r: 9, s: 0, f: 1 });
  });

  test("the movement and spawn flushes find mirrors as well as local players", () => {
    expect(receiver).toContain("allPlayers[movingPlayerId] ?? entityById(movingPlayerId)");
    expect(receiver).toContain("allPlayers[queuedPlayer.id] ?? entityById(queuedPlayer.id)");
    expect(receiver).toContain("allPlayers[spawnData.id] ?? entityById(spawnData.id)");
  });
});

describe("the effects in a mirror's state", () => {
  const barrier = (expiresAt: number) => ({ id: "b1", spell: "Shield", amount: 50, duration: 30, expiresAt, token: 1, icon: null, particles: null });

  test("carry the time they run out, and the mirror counts down from it", () => {
    const now = 1_000_000;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const state = getEffectsState({ barriers: [barrier(now + 30_000)] }, now);
      expect(state).toEqual([expect.objectContaining({ id: "b1", kind: "barrier", expiresAt: now + 30_000 })]);
      expect("remaining" in state[0]).toBe(false);
      expect(mirrorEffectsPayload(state, now + 10_500)[0].remaining).toBe(20);
      expect(mirrorEffectsPayload(state, now + 40_000)[0].remaining).toBe(0);
      expect(mirrorEffectsPayload([{ id: "x" }], now)).toEqual([{ id: "x" }]);
      expect(mirrorEffectsPayload(undefined, now)).toEqual([]);
    } finally {
      Date.now = realNow;
    }
  });

  test("unchanged effects send no state over two scans", async () => {
    const map = `m${++mapSeq}`;
    const local = await viewerAt("12", map, 500, 500);
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    local.barriers = [barrier(now + 30_000)];
    const sent: string[] = [];
    const links: any = {
      self: "a",
      isUp: () => true,
      send: (_peer: string, kind: string) => { sent.push(kind); return true; },
      sendDatagram: () => true,
      on() {}, onDatagram() {}, onPeerUp() {}, onPeerDown() {},
    };
    const g = new Ghosts({ scanMs: 1e9, now: () => Date.now() });
    const { deps: d } = deps();
    g.register(playerGhostKind(d));
    g.attach(links, () => new Set(["b"]));
    try {
      g.scan();
      expect(sent).toEqual(["GHOST_SPAWN"]);
      now += 1_500;
      g.scan();
      now += 1_400;
      g.scan();
      expect(sent).toEqual(["GHOST_SPAWN"]);
      // A refreshed barrier is a change.
      local.barriers[0].expiresAt = now + 30_000;
      g.scan();
      expect(sent).toEqual(["GHOST_SPAWN", "GHOST_STATE"]);
    } finally {
      g.detach();
      Date.now = realNow;
    }
  });
});
