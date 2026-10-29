// Gathering wired to the engine: the spawner fed with the areas and the live layers, ticked with the creatures
// (FIXED_UPDATE, 100 ms), the sync sending nodes to players through packets, and the service given the real
// inventory. The receiver runs the cast (castGather) and hands editor packets here. See types.ts for the request.
import AOI_CONFIG from "../../config/aoi.json";
import { spawnsHere } from "../../cluster";
import { ghosts } from "../../cluster/ghosts";
import { linkCalls } from "../../cluster/linkcalls";
import { mirrorOwner, mirrorPlayers } from "../../cluster/mirrors";
import log from "../../modules/logger";
import { getIconUrl } from "../../modules/spriteSheetManager";
import assetCache from "../../services/assetCache";
import { atomically, nothingWritten } from "../../services/batch";
import layerManager, { blockOf } from "../../services/layermanager";
import mapIndex from "../../services/mapindex";
import playerCache from "../../services/playermanager";
import { packetManager } from "../../socket/packet_manager";
import creatures from "../creatures";
import { Events, listener } from "../events";
import { grantWrittenBefore, recordGrantWrite } from "../grantwrites";
import inventory from "../inventory";
import { setQuantitySource } from "../itembounds";
import spellEffects from "../spelleffects";
import { hasRoomFor } from "../vendors";
import * as editor from "./editor";
import { previewSpots } from "./placement";
import { answerGather, receiveGathered, RemoteGatherers, requestGather, withRemoteGatherers, type RemoteGatherer } from "./remote";
import { GATHER_CAST_MS, GatherService, REASONS, type GatherOutcome, type Gatherer } from "./service";
import { GatherSpawner } from "./spawner";
import { GatherSync, type GatherViewer } from "./sync";
import type { GatherNode, GatherNodeSnapshot } from "./types";

/** Ticks (100 ms each) between refreshes of one player: every player is refreshed every 300 ms. */
const SYNC_EVERY_TICKS = 3;
/** Ticks between reading the live layers of the maps with areas. */
const LAYERS_EVERY_TICKS = 10;

const normMap = (map: unknown) => String(map ?? "").replaceAll(".json", "");

function send(wt: any, packets: any[]): void {
  if (!wt || !wt.send || wt.readyState !== 1) return;
  try {
    for (const p of packets) wt.send(p);
  } catch {
    // Connection closing; the next refresh drops the viewer.
  }
}

/** item name (lower case) -> item, for icons and for checking an area's item exists. */
let itemsByName = new Map<string, any>();

async function refreshItems(): Promise<void> {
  const list = ((await assetCache.get("items")) || []) as any[];
  itemsByName = new Map(list.filter((item) => item?.name).map((item) => [String(item.name).toLowerCase(), item]));
}

const snapshot = (node: GatherNode): GatherNodeSnapshot => ({
  id: node.id, x: node.x, y: node.y, item: node.item,
  icon: getIconUrl(itemsByName.get(node.item.toLowerCase())?.icon ?? null),
  size: spawner.area(node.areaId)?.size ?? editor.DEFAULT_SIZE,
});

function viewer(id: string): GatherViewer | null {
  const p = playerCache.get(id);
  const pos = p?.location?.position;
  if (!p || !p.wt || p.wt.readyState !== 1 || !pos) return null;
  if (typeof pos.x !== "number" || typeof pos.y !== "number") return null;
  return {
    id, wt: p.wt, map: normMap(p.location.map), layerId: layerManager.getPlayerLayer(id),
    x: pos.x, y: pos.y,
    radius: p.aoi?.aoiRadius || (AOI_CONFIG as any).DEFAULT_RADIUS || 1000,
  };
}

export const spawner: GatherSpawner = new GatherSpawner((map) => creatures.navGrids.get(map), {
  onSpawn: (node) => sync.onSpawn(node),
  onDespawn: (node) => sync.onDespawn(node),
  playersInBlock: (layerId, x, y) => layerManager.countInBlock(layerId, blockOf(x, y)),
  // Cluster mode: an area in another node's block is that node's to fill.
  spawnsHere,
});

// Cluster mode: nodes another node owns near the border. Shown here; never taken here (spawner.take does not know them).
const remoteNodes = new Map<number, GatherNode>();

/** A mirror of another node's gathering node. False when the id is a node of this one's own; a resend replaces it. */
export function addRemoteGatherNode(node: GatherNode): boolean {
  if (spawner.get(node.id)) return false;
  const known = remoteNodes.has(node.id);
  remoteNodes.set(node.id, node);
  if (!known) sync.onSpawn(node);
  return true;
}

export function removeRemoteGatherNode(id: number): void {
  const node = remoteNodes.get(id);
  if (!node) return;
  remoteNodes.delete(id);
  sync.onDespawn(node);
}

function remoteNodesNear(map: string, layerId: string, x: number, y: number, radius: number, out: GatherNode[]): GatherNode[] {
  const r2 = radius * radius;
  for (const node of remoteNodes.values()) {
    if (node.map !== map || node.layerId !== layerId) continue;
    if ((node.x - x) ** 2 + (node.y - y) ** 2 <= r2) out.push(node);
  }
  return out;
}

export const sync: GatherSync = new GatherSync({
  nodesNear: (map, layerId, x, y, radius) => {
    const near = spawner.nodesNear(map, layerId, x, y, radius);
    return remoteNodes.size ? remoteNodesNear(map, layerId, x, y, radius, near) : near;
  },
  get: (id) => spawner.get(id) ?? remoteNodes.get(id),
  mapsWithNodes: () => {
    if (!remoteNodes.size) return spawner.maps();
    const maps = new Set(spawner.maps());
    for (const node of remoteNodes.values()) maps.add(node.map);
    return [...maps];
  },
  playersOnMap: (map) => mapIndex.getPlayersOnMap(map),
  resolvePlayer: viewer,
  snapshot,
  sendSpawn: (wt, nodes) => send(wt, packetManager.gatherNodeSpawn(nodes)),
  sendDespawn: (wt, ids) => send(wt, packetManager.gatherNodeDespawn(ids)),
});

function gatherer(id: string): Gatherer | null {
  const p = playerCache.get(id);
  const pos = p?.location?.position;
  if (!p || !pos) return null;
  return {
    id, username: p.username, map: normMap(p.location.map), layerId: layerManager.getPlayerLayer(id),
    x: Number(pos.x), y: Number(pos.y), dead: !!(p.isDead || p.isGhost), stunned: spellEffects.isStunned(p),
    casting: !!p.casting, moving: !!p.moving,
    // in combat as the rest of the game counts it (warps, equipment), or held by a creature
    inCombat: !!p.pvp || creatures.combat.isInCombatWith(id),
  };
}

/** The items in the player's bags, as one batch. Throws when the batch failed (see nothingWritten). */
async function write(username: string, item: string, quantity: number, grantId?: string): Promise<void> {
  await atomically([username], async (batch) => {
    // A claimed hand-over's id is written with it, first in the batch (grantwrites.ts, security review M2).
    if (grantId) await recordGrantWrite(batch, grantId);
    if (!(await inventory.add(username, { name: item, quantity }, batch))) throw new Error(`${item} was not added`);
  });
}

/** The items in the player's bags, as one batch: false when the batch failed (it may have been written after all). */
async function give(username: string, item: string, quantity: number): Promise<boolean> {
  try {
    await write(username, item, quantity);
    return true;
  } catch (error) {
    log.error(`[Gathering] ${quantity} x ${item} could not be given to ${username}: ${error}`);
    return false;
  }
}

/**
 * An item a neighbouring node handed over for a gather: false when nothing of it was written (it is parked again).
 * A failure that may have come after the commit (a kept step, a lost answer) is thrown, and the item is not parked
 * again: it could be given twice. Exported for its test (cluster-secfix-b.test.ts).
 */
export async function giveHanded(username: string, item: string, quantity: number, grantId?: string): Promise<boolean> {
  try {
    await write(username, item, quantity, grantId);
    return true;
  } catch (error) {
    // Written before under this id: in their bags already, so it is neither written nor parked again.
    if (grantId && grantWrittenBefore(error)) {
      log.info(`[Gathering] Hand-over ${grantId} (${quantity} x ${item}) for ${username} was written before: not written again`);
      return true;
    }
    if (!nothingWritten(error)) throw error;
    log.error(`[Gathering] ${quantity} x ${item} could not be given to ${username}: ${error}`);
    return false;
  }
}

// Cluster mode: players of neighbouring nodes gathering this node's nodes (GATHER_REQUEST), while their request runs.
const remoteGatherers = new RemoteGatherers();

export const service = new GatherService({ spawner, ...withRemoteGatherers({ gatherer, hasRoomFor, give }, remoteGatherers) });

// Does nothing until startCluster attaches the links: no neighbour calls before then.
linkCalls.handle("GATHER_REQUEST", (request, from) =>
  answerGather(request, from, { service, gatherers: remoteGatherers, ownerOf: mirrorOwner, mirrorOf: (id) => mirrorPlayers.get(String(id)) }));

/** The node that owns a mirrored gathering node. Null for this node's own nodes, and for unknown ids. */
function remoteGatherOwner(nodeId: number): string | null {
  return remoteNodes.has(nodeId) ? ghosts.ownerOf("gather", nodeId) : null;
}

/** A player here as the owner of `item`'s node is sent them. Null when they left. */
async function remoteSnapshot(playerId: string, item: string): Promise<RemoteGatherer | null> {
  const here = gatherer(playerId);
  return here ? { ...here, hasRoom: await hasRoomFor(here.username, item) } : null;
}

/** Whether a player may start gathering a node: this node's own (service.start), or a neighbour's (GATHER_REQUEST). */
export async function startGather(playerId: string, nodeId: unknown): Promise<{ ok: true; node: GatherNode } | { ok: false; reason: string }> {
  const id = Number(nodeId);
  const owner = remoteGatherOwner(id);
  if (!owner) return service.start(playerId, nodeId);
  const sent = await remoteSnapshot(playerId, remoteNodes.get(id)!.item);
  if (!sent) return { ok: false, reason: REASONS.gone };
  const answer = await requestGather(owner, { phase: "start", nodeId: id, gatherer: sent });
  if (!answer.ok) return { ok: false, reason: answer.reason ?? REASONS.failed };
  return answer.node?.id === id ? { ok: true, node: answer.node } : { ok: false, reason: REASONS.gone };
}

/**
 * The cast ended: this node's node is claimed here (service.finish); a neighbour's is claimed there, and the item
 * it answers is put in the bags here. A node that was taken meanwhile is no longer mirrored: service.finish then
 * answers that someone else gathered it.
 */
export async function finishGather(playerId: string, nodeId: number): Promise<GatherOutcome> {
  const owner = remoteGatherOwner(nodeId);
  if (!owner) return service.finish(playerId, nodeId);
  const node = remoteNodes.get(nodeId)!;
  // The item the node's mirror names must be the item of its area, which every node reads (security review M4): the
  // owner is not asked to let go of a node that gives something no area gives.
  const area = spawner.area(node.areaId);
  if (area && String(area.item).toLowerCase() !== String(node.item).toLowerCase()) {
    log.warn(`[Gathering] Node ${nodeId} of ${owner} shows ${node.item} and its area ${node.areaId} gives ${area.item}: not gathered`);
    return { ok: false, reason: REASONS.failed };
  }
  const sent = await remoteSnapshot(playerId, node.item);
  if (!sent) return { ok: false, reason: REASONS.lost };
  const answer = await requestGather(owner, { phase: "finish", nodeId, gatherer: sent }, node.item);
  if (!answer.ok) return { ok: false, reason: answer.reason ?? REASONS.failed };
  // The owner has settled the node: an item that cannot be written now is parked again, or logged by name as lost.
  const received = await receiveGathered(sent.username, owner, nodeId, answer, {
    // What the node gives, from the mirror and this node's areas: the owner's answer is checked against it.
    expected: { item: node.item, maxQuantity: spawner.area(node.areaId)?.quantity_max ?? 1 },
    // Still this session on this node: the id is per connection, so a player who left or reconnected
    // (a new id) fails this and the item is logged as lost, and an id reused by someone else fails the name.
    stillHere: () => playerCache.get(playerId)?.username === sent.username,
    give: giveHanded,
  });
  return received.ok ? { ok: true, node: answer.node ?? node, item: received.item, quantity: received.quantity } : received;
}

function layersNow(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const map of spawner.maps()) out.set(map, layerManager.getLayersForMap(map).map((layer) => layer.layerId));
  return out;
}

/**
 * Hands the areas' largest quantity_max to the item quantity cap (itembounds.ts, security review M4 fix round 1): a
 * gather from another node may carry that many of one item. Guard (test "a configured quantity above 9999 is in bounds,
 * and one above every configured source is refused").
 */
export function noteAreaQuantities(areas: ReadonlyArray<{ quantity_max?: unknown }>): void {
  const most = areas.reduce((m, area) => Math.max(m, Math.floor(Number(area?.quantity_max) || 0)), 0);
  setQuantitySource("gathering areas", () => most);
}

/** Reads the areas again and gives them to the spawner. */
async function doReload(): Promise<void> {
  await refreshItems();
  const usable = (await editor.allAreas()).filter((area) => {
    if (itemsByName.has(area.item.toLowerCase())) return true;
    log.warn(`[Gathering] Area ${area.id} on ${area.map} gives ${area.item}, which is not an item: it spawns nothing.`);
    return false;
  });
  const maps = [...new Set(usable.map((area) => area.map))];
  await creatures.wantNavGrids(maps);
  for (const map of maps) if (!creatures.navGrids.get(map)) log.warn(`[Gathering] ${map} has no collision data: its areas spawn nothing.`);
  const now = Date.now();
  spawner.setAreas(usable, now);
  noteAreaQuantities(usable);
  spawner.setLayers(layersNow(), now);
}

let reloading: Promise<void> = Promise.resolve();

/** Reads the areas again (start, and every editor change). Reloads run one after another, never overlapping. */
export function reloadAreas(): Promise<void> {
  const run = reloading.then(doReload, doReload);
  reloading = run.catch(() => {});
  return run;
}

/** The client cleared its nodes (LOAD_MAP): send those around the player again. */
export function resyncPlayer(playerId: string): void {
  sync.resync(playerId);
}

let initialized = false;

export async function init(): Promise<void> {
  if (initialized) return;
  initialized = true;
  await reloadAreas();

  let tick = 0;
  listener.on(Events.FIXED_UPDATE, () => {
    try {
      const now = Date.now();
      tick++;
      if (tick % LAYERS_EVERY_TICKS === 0) spawner.setLayers(layersNow(), now);
      spawner.tick(now);
      // the nodes that spawned this tick (and since: editor saves, restores), one packet per player
      sync.flush();
      sync.refresh(tick % SYNC_EVERY_TICKS, SYNC_EVERY_TICKS);
    } catch (error) {
      log.error(`[Gathering] Tick failed: ${error}`);
    }
  });
  listener.on(Events.SERVER_TICK, () => {
    refreshItems().catch(() => {});
  });
  const leave = (payload: any) => {
    const id = payload?.player?.id;
    if (id) sync.forget(id);
  };
  listener.on(Events.PLAYER_LOGOUT, leave);
  listener.on(Events.PLAYER_DISCONNECT, leave);
  log.success(`Gathering started: ${spawner.maps().length} map(s) with areas`);
}

// ------------------------------------------------------------------ editor

async function editorItems(): Promise<editor.EditorItem[]> {
  await refreshItems();
  return [...itemsByName.values()]
    .map((item) => ({ name: String(item.name), image: getIconUrl(item.icon ?? null) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function editorWorld(admin: any): editor.EditorWorld {
  return {
    here: normMap(admin?.location?.map),
    items: editorItems,
    preview: async (map, area) => {
      if (!creatures.navGrids.get(map)) await creatures.wantNavGrids([map]);
      const grid = creatures.navGrids.get(map);
      return grid ? previewSpots(grid, area, area.max_nodes, Math.random).map(({ x, y }) => ({ x, y })) : null;
    },
  };
}

/** One editor packet: answered to the admin; a change reloads the spawner and tells the other open editors. */
export async function handleEditorPacket(admin: any, type: string, data: any): Promise<void> {
  const wt = admin?.wt;
  if (!wt) return;
  const answer = await editor.handleEditorPacket(admin, type, data, editorWorld(admin));
  if (answer.kind === "data") return send(wt, packetManager.gatheringEditorData(answer.data));
  if (answer.kind === "preview") return send(wt, packetManager.gatheringEditorPreview({ spots: answer.spots, wanted: answer.wanted, note: answer.note }));
  if (answer.denied) send(wt, packetManager.notify({ message: editor.DENIED }));
  send(wt, packetManager.gatheringEditorResult({ ok: answer.ok, errors: answer.errors, fields: answer.fields, id: answer.id, notes: answer.notes, action: type, data: answer.data }));
  if (!answer.changed) return;
  try {
    await reloadAreas();
  } catch (error) {
    log.error(`[Gathering] Reloading the areas after an editor change failed: ${error}`);
  }
  const updated = packetManager.gatheringEditorUpdated({ by: admin.username });
  for (const other of Object.values(playerCache.list()) as any[]) {
    if (other?.wt && other.id !== admin.id && editor.mayHaveEditorOpen(other)) send(other.wt, updated);
  }
}

export const canUseEditor = editor.canUseEditor;

export default { init, reloadAreas, resyncPlayer, handleEditorPacket, canUseEditor, service, startGather, finishGather, spawner, sync, GATHER_CAST_MS };
