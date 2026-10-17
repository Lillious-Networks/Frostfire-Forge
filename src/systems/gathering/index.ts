// Gathering wired to the engine: the spawner fed with the areas and the live layers, ticked with the creatures
// (FIXED_UPDATE, 100 ms), the sync sending nodes to players through packets, and the service given the real
// inventory. The receiver runs the cast (castGather) and hands editor packets here. See types.ts for the request.
import AOI_CONFIG from "../../config/aoi.json";
import log from "../../modules/logger";
import { getIconUrl } from "../../modules/spriteSheetManager";
import assetCache from "../../services/assetCache";
import { atomically } from "../../services/batch";
import layerManager from "../../services/layermanager";
import mapIndex from "../../services/mapindex";
import playerCache from "../../services/playermanager";
import { packetManager } from "../../socket/packet_manager";
import creatures from "../creatures";
import { Events, listener } from "../events";
import inventory from "../inventory";
import spellEffects from "../spelleffects";
import { hasRoomFor } from "../vendors";
import * as editor from "./editor";
import { previewSpots } from "./placement";
import { GATHER_CAST_MS, GatherService, type Gatherer } from "./service";
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
});

export const sync: GatherSync = new GatherSync({
  nodesNear: (map, layerId, x, y, radius) => spawner.nodesNear(map, layerId, x, y, radius),
  get: (id) => spawner.get(id),
  mapsWithNodes: () => spawner.maps(),
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

/** The items in the player's bags, as one batch: false when nothing was written. */
async function give(username: string, item: string, quantity: number): Promise<boolean> {
  try {
    return await atomically([username], async (batch) => {
      if (!(await inventory.add(username, { name: item, quantity }, batch))) throw new Error(`${item} was not added`);
      return true;
    });
  } catch (error) {
    log.error(`[Gathering] ${quantity} x ${item} could not be given to ${username}: ${error}`);
    return false;
  }
}

export const service = new GatherService({ spawner, gatherer, hasRoomFor, give });

function layersNow(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const map of spawner.maps()) out.set(map, layerManager.getLayersForMap(map).map((layer) => layer.layerId));
  return out;
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

export default { init, reloadAreas, resyncPlayer, handleEditorPacket, canUseEditor, service, spawner, sync, GATHER_CAST_MS };
