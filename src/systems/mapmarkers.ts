// What a map marks for a player: its inns, its merchants, its caves and its houses.
//
// All are read from the map's warps. An inn or a merchant is the door of the
// house the innkeeper or the vendor is in. A cave is a way from one stretch of
// open country into another: from the overworld down into the underworld, and
// back up. A house is a door from open country into a map that is indoors. The
// server works them out for the map a player is on and sends them
// (MAP_MARKERS): the minimap draws a pin for each inn, merchant and cave, and
// the world map a picture for each house.

import { isInnkeeper } from "./homes";
import vendors from "./vendors";

/** A place a map marks: what it is, where (map px), and its name when it has one. */
export interface MapMarker {
  kind: "inn" | "merchant" | "cave" | "house";
  x: number;
  y: number;
  name: string | null;
}

/** A place an NPC is found at: where (map px), and the NPC's name. */
export interface NpcMarker {
  x: number;
  y: number;
  name: string | null;
}

type Warps = WarpObject[] | Record<string, WarpObject> | null | undefined;
type Outdoors = (map: string) => boolean;

/** A map's name, with or without the ending its file has. */
const mapName = (map: unknown) => String(map ?? "").replaceAll(".json", "");
const listed = (warps: Warps): WarpObject[] => (Array.isArray(warps) ? warps : Object.values(warps || {}));

/** Where a warp is marked: the middle of its top edge. Nothing for a warp that does not say where it is. */
function topOf(warp: WarpObject): { x: number; y: number } | null {
  const x = Number(warp.position?.x) + (Number(warp.size?.width) || 0) / 2;
  const y = Number(warp.position?.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/**
 * Where NPCs of a kind are marked on a map. Such an NPC stands inside a house, which is a map of
 * its own: it is marked on the door that leads there (a warp of this map into the NPC's map), at
 * the middle of the door's top edge, once however many doors the house has, under the name of the
 * first of them in it. `outdoors` says whether a map is open country (a world) and not the inside
 * of something: an NPC standing in the open is marked where it stands, on its own map only, and a
 * way into that map from another is not its door. Indoors nothing is marked for the room's own.
 */
function npcMarkers(map: string, npcs: Npc[], warps: Warps, outdoors: Outdoors): NpcMarker[] {
  const here = mapName(map);
  // The first of them on each map that has one.
  const found = new Map<string, Npc>();
  for (const npc of npcs) if (!found.has(mapName(npc.map))) found.set(mapName(npc.map), npc);

  const marked: NpcMarker[] = [];
  const reached = new Set<string>();
  for (const warp of listed(warps)) {
    const to = mapName(warp?.map);
    const npc = found.get(to);
    if (!npc || to === here || reached.has(to) || outdoors(to)) continue;
    const at = topOf(warp);
    if (!at) continue;
    reached.add(to);
    marked.push({ ...at, name: npc.name || null });
  }
  if (outdoors(here)) {
    for (const npc of npcs) {
      if (mapName(npc.map) !== here) continue;
      marked.push({ x: Number(npc.position?.x), y: Number(npc.position?.y), name: npc.name || null });
    }
  }
  return marked;
}

/** Where a map's inns are marked: the houses its innkeepers are in (see npcMarkers). A hidden one is not there. */
export function innMarkers(map: string, npcs: Npc[], warps: Warps, outdoors: Outdoors): NpcMarker[] {
  return npcMarkers(map, (npcs || []).filter((npc) => isInnkeeper(npc)), warps, outdoors);
}

/**
 * The doors of a map's inns, from open country: of each house an innkeeper is in, the first door
 * that leads there from this map. Indoors there are none, and an innkeeper standing in the open has
 * no door.
 */
export function innDoors(map: string, npcs: Npc[], warps: Warps, outdoors: Outdoors): WarpObject[] {
  const here = mapName(map);
  if (!outdoors(here)) return [];
  const inns = new Set((npcs || []).filter((npc) => isInnkeeper(npc)).map((npc) => mapName(npc.map)));
  const doors: WarpObject[] = [];
  const reached = new Set<string>();
  for (const warp of listed(warps)) {
    const to = mapName(warp?.map);
    if (!inns.has(to) || to === here || reached.has(to) || outdoors(to) || !topOf(warp)) continue;
    reached.add(to);
    doors.push(warp);
  }
  return doors;
}

/** Where a map's merchants are marked: the houses its vendors are in (see npcMarkers). A hidden one is not there. */
export function merchantMarkers(map: string, npcs: Npc[], warps: Warps, outdoors: Outdoors): NpcMarker[] {
  return npcMarkers(map, (npcs || []).filter((npc) => !npc.hidden && vendors.isVendor(npc)), warps, outdoors);
}

/**
 * A map made of separate cave systems (a world's underworld): their rectangles, in tiles, and the size of a tile.
 * A warp from one of them into another is a cave as much as one into another map.
 */
export interface MapSections {
  sections: Array<{ x: number; y: number; width: number; height: number }>;
  tileWidth: number;
  tileHeight: number;
}

/** The section a point (map px) lies in, or -1. */
function sectionAt(layout: MapSections, x: number, y: number): number {
  const c = x / layout.tileWidth, r = y / layout.tileHeight;
  return layout.sections.findIndex((s) => c >= s.x && c < s.x + s.width && r >= s.y && r < s.y + s.height);
}

/**
 * Where a map's caves are: each warp of an open map that leads into another open map, marked at
 * the middle of its top edge. A warp to another place on the same map is no cave, and neither is a
 * door into a house or out of one, but on a map made of cave systems (`layout`) a warp from one into
 * another is: it is the way into the next cave (USER REQUEST 2026-10-16: "Fix the blue diamonds that
 * go to other caves in the underworld, it should be the same cave icon for those as well").
 */
export function caveMarkers(map: string, warps: Warps, outdoors: Outdoors, layout?: MapSections | null): Array<{ x: number; y: number }> {
  const here = mapName(map);
  if (!outdoors(here)) return [];
  const sectioned = !!layout?.sections?.length && layout.tileWidth > 0 && layout.tileHeight > 0;
  const marked: Array<{ x: number; y: number }> = [];
  for (const warp of listed(warps)) {
    const to = mapName(warp?.map);
    if (!to || !outdoors(to)) continue;
    const at = topOf(warp);
    if (!at) continue;
    if (to === here) {
      // the same map: a cave only from one cave system into another
      if (!sectioned) continue;
      const from = sectionAt(layout!, at.x, Number(warp.position?.y) + (Number(warp.size?.height) || 0) / 2);
      const into = sectionAt(layout!, Number(warp.x), Number(warp.y));
      if (from < 0 || into < 0 || from === into) continue;
    }
    marked.push(at);
  }
  return marked;
}

/**
 * Where a map's houses are: each door of an open map that leads into a map that is indoors, marked
 * at the middle of its top edge, once however many doors the house has. From inside, the door back
 * out is no house.
 */
export function houseMarkers(map: string, warps: Warps, outdoors: Outdoors): Array<{ x: number; y: number }> {
  const here = mapName(map);
  if (!outdoors(here)) return [];
  const marked: Array<{ x: number; y: number }> = [];
  const reached = new Set<string>();
  for (const warp of listed(warps)) {
    const to = mapName(warp?.map);
    if (!to || to === here || outdoors(to) || reached.has(to)) continue;
    const at = topOf(warp);
    if (!at) continue;
    reached.add(to);
    marked.push(at);
  }
  return marked;
}

/** Everything a map marks: its inns, its merchants, its caves, then its houses. A house with an inn or a merchant in it is marked as both. */
export function mapMarkers(map: string, npcs: Npc[], warps: Warps, outdoors: Outdoors, layout?: MapSections | null): MapMarker[] {
  return [
    ...innMarkers(map, npcs, warps, outdoors).map((inn) => ({ kind: "inn" as const, ...inn })),
    ...merchantMarkers(map, npcs, warps, outdoors).map((merchant) => ({ kind: "merchant" as const, ...merchant })),
    ...caveMarkers(map, warps, outdoors, layout).map((cave) => ({ kind: "cave" as const, ...cave, name: null })),
    ...houseMarkers(map, warps, outdoors).map((house) => ({ kind: "house" as const, ...house, name: null })),
  ];
}
