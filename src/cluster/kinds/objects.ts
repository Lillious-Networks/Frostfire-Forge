import { broadcastToAOIAtPosition } from "../../socket/aoi";
import log from "../../modules/logger";
import mapIndex from "../../services/mapindex";
import playerCache from "../../services/playermanager";
import { packetManager } from "../../socket/packet_manager";
import loot, { type LootItem } from "../../systems/loot";
import lootChest from "../../systems/lootChest";
import skeletons, { type DeathSkeleton } from "../../systems/skeletons";
import { addRemoteZone, findZoneById, getZonesOnMap, removeRemoteZone, zoneMaps } from "../../systems/groundaoe";
import { moveRemoteTornado, removeRemoteTornado, setRemoteTornado, tornadoMaps, tornadoesOn } from "../../systems/tornadoes";
import { addRemoteGatherNode, removeRemoteGatherNode, spawner as gatherSpawner } from "../../systems/gathering";
import { ghosts, type GhostCandidate, type GhostKind } from "../ghosts";
import { idNumber } from "../linkproto";

// Ghost kinds for the things players see but do not walk: loot, chests,
// gathering nodes, skeletons, ground AOEs, tornadoes. None of them is written on
// the receiving side. Loot and chests go to the whole map, as this node's own do;
// the rest go to the players near them.
// A spawn whose id is one of this node's own is refused (false), so Ghosts records nothing for it.

const bare = (map: unknown) => String(map ?? "").replace(/\.json$/, "");
/** Whether every value is a number a position or count can hold: a record from the wire is not trusted to be one. */
const finite = (...values: unknown[]) => values.every((value) => typeof value === "number" && Number.isFinite(value));
const at = (id: string | number, map: string, layerId: string | null, x: number, y: number): GhostCandidate => ({ id, num: idNumber(id), map: bare(map), layerId, x, y });

/** Every player on the map: how this node's own loot and chests are sent. */
function toWholeMap(map: unknown, packets: any[]): void {
  for (const id of mapIndex.getPlayersOnMap(bare(map))) {
    const wt = playerCache.get(id)?.wt;
    if (!wt || wt.readyState !== 1) continue;
    try {
      for (const packet of packets) wt.send(packet);
    } catch (error) {
      // Logged as sendPacket logs it.
      log.error(`Failed to send packet: ${error}`);
    }
  }
}

// What the client's LOOT_SPAWN carries: the record without the owner-side expiry.
const lootPayload = (l: any) => ({ id: l.id, item: l.item, quantity: l.quantity, quality: l.quality, iconUrl: l.iconUrl, x: l.x, y: l.y, ownerId: l.ownerId, ownerName: l.ownerName });
const chestPayload = (c: any) => ({ id: c.id, x: c.x, y: c.y, iconUrl: c.iconUrl, map: c.map });
const skeletonPayload = (s: any) => ({ id: s.id, username: s.username, map: s.map, x: s.x, y: s.y, createdAt: s.createdAt, expiresAt: s.expiresAt });

/** How this node shows and hides one of its own loot, chests and skeletons: what the kinds below send for a mirror. */
export interface ObjectViews {
  showLoot(l: LootItem): void;
  hideLoot(l: LootItem): void;
  showChest(c: { id: string; map: string; x: number; y: number; iconUrl: string }): void;
  hideChest(c: { id: string; map: string }): void;
  showSkeleton(s: DeathSkeleton): void;
  hideSkeleton(s: DeathSkeleton): void;
}

export const objectViews: ObjectViews = {
  showLoot: (l) => toWholeMap(l.map, packetManager.lootSpawn(lootPayload(l))),
  hideLoot: (l) => toWholeMap(l.map, packetManager.lootDespawn(l.id)),
  showChest: (c) => toWholeMap(c.map, packetManager.lootChestSpawn(chestPayload(c))),
  hideChest: (c) => toWholeMap(c.map, packetManager.lootChestDespawn(c.id)),
  showSkeleton: (s) => broadcastToAOIAtPosition(s.x, s.y, s.map, packetManager.skeletonSpawn(skeletonPayload(s)), s.layerId ?? undefined, { bestEffort: true }),
  hideSkeleton: (s) => broadcastToAOIAtPosition(s.x, s.y, s.map, packetManager.skeletonDespawn(s.id), s.layerId ?? undefined, { bestEffort: true }),
};

const lootKind: GhostKind = {
  name: "loot",
  *candidates() { for (const l of loot.all()) yield at(l.id, l.map, null, l.x, l.y); },
  snapshot: (id) => { const l = loot.get(String(id)); return l ? { ...l } : null; },
  spawn: (r) => {
    if (!finite(r.x, r.y, r.quantity, r.expiresAt)) return false;
    // Only these fields are kept, as the owner's record has them.
    const record = {
      id: String(r.id), item: String(r.item ?? ""), quantity: r.quantity, quality: String(r.quality ?? ""), iconUrl: String(r.iconUrl ?? ""),
      map: String(r.map ?? ""), x: r.x, y: r.y, ownerId: String(r.ownerId ?? ""), ownerName: String(r.ownerName ?? ""), expiresAt: r.expiresAt,
    };
    if (loot.get(record.id)) return false;
    // A resend replaces the record; only a new one is shown (loot never moves).
    const known = loot.removeRemote(record.id);
    loot.addRemote(record);
    if (!known) toWholeMap(record.map, packetManager.lootSpawn(lootPayload(record)));
    return true;
  },
  despawn: (id) => {
    const l = loot.removeRemote(String(id));
    if (l) toWholeMap(l.map, packetManager.lootDespawn(l.id));
  },
};

const chestKind: GhostKind = {
  name: "chest",
  *candidates() { for (const c of lootChest.all()) yield at(c.id, c.map, null, c.x, c.y); },
  snapshot: (id) => { const c = lootChest.getChest(String(id)); return c ? chestPayload(c) : null; },
  spawn: (r) => {
    if (!finite(r.x, r.y)) return false;
    if (lootChest.getChest(String(r.id))) return false;
    const known = lootChest.removeRemote(String(r.id));
    lootChest.addRemote(chestPayload(r));
    if (!known) toWholeMap(r.map, packetManager.lootChestSpawn(chestPayload(r)));
    return true;
  },
  despawn: (id) => {
    const c = lootChest.removeRemote(String(id));
    if (c) toWholeMap(c.map, packetManager.lootChestDespawn(c.id));
  },
};

const skeletonKind: GhostKind = {
  name: "skeleton",
  *candidates() { for (const s of skeletons.all()) yield at(s.id, s.map, s.layerId ?? null, s.x, s.y); },
  snapshot: (id) => { const s = skeletons.get(String(id)); return s ? { ...s } : null; },
  spawn: (r) => {
    if (!finite(r.x, r.y)) return false;
    if (skeletons.get(String(r.id))) return false;
    const known = skeletons.removeRemote(String(r.id));
    skeletons.addRemote({ ...skeletonPayload(r), layerId: r.layerId ?? null });
    if (!known) broadcastToAOIAtPosition(r.x, r.y, r.map, packetManager.skeletonSpawn(skeletonPayload(r)), r.layerId ?? undefined, { bestEffort: true });
    return true;
  },
  despawn: (id) => {
    const s = skeletons.removeRemote(String(id));
    if (s) broadcastToAOIAtPosition(s.x, s.y, s.map, packetManager.skeletonDespawn(s.id), s.layerId ?? undefined, { bestEffort: true });
  },
};

const zoneKind: GhostKind = {
  name: "groundaoe",
  *candidates() {
    for (const map of zoneMaps()) for (const z of getZonesOnMap(map)) yield at(z.id, z.mapName, z.layerId ?? null, z.position.x, z.position.y);
  },
  snapshot: (id) => {
    const z = findZoneById(String(id));
    if (!z) return null;
    return {
      id: z.id, spellId: z.spellId, spellName: z.spellName, casterId: z.casterId, casterUsername: z.casterUsername, mapName: z.mapName,
      layerId: z.layerId ?? null, x: z.position.x, y: z.position.y, radius: z.radius, duration: z.duration, damageType: z.damageType,
      particles: z.particles, createdAt: z.createdAt, expiresAt: z.expiresAt,
    };
  },
  spawn: (r) => finite(r.x, r.y) && addRemoteZone(r),
  despawn: (id) => removeRemoteZone(String(id)),
};

function ownTornado(id: string | number) {
  for (const map of tornadoMaps()) for (const t of tornadoesOn(map)) if (t.id === id) return t;
  return null;
}

const tornadoKind: GhostKind = {
  name: "tornado",
  *candidates() {
    for (const map of tornadoMaps()) for (const t of tornadoesOn(map)) yield at(t.id, t.map, null, t.x, t.y);
  },
  snapshot: (id) => {
    const t = ownTornado(id);
    return t ? { id: t.id, map: t.map, x: Math.round(t.x), y: Math.round(t.y) } : null;
  },
  // A tornado has no facing the client draws; 1 stands in for one.
  motion: (id) => {
    const t = ownTornado(id);
    return t ? { x: t.x, y: t.y, dir: 1, flags: 0 } : null;
  },
  spawn: (r) => {
    if (!finite(r.x, r.y)) return false;
    return setRemoteTornado({ id: String(r.id), map: String(r.map), x: r.x, y: r.y });
  },
  // tornadoes.ts keeps the record, so resetTornadoes clears it all.
  move: (id, x, y) => { if (finite(x, y)) moveRemoteTornado(String(id), x, y); },
  despawn: (id) => removeRemoteTornado(String(id)),
};

const gatherKind: GhostKind = {
  name: "gather",
  *candidates() {
    for (const map of gatherSpawner.nodeMaps()) for (const n of gatherSpawner.nodesOnMap(map)) yield at(n.id, n.map, n.layerId, n.x, n.y);
  },
  snapshot: (id) => { const n = gatherSpawner.get(Number(id)); return n ? { ...n } : null; },
  spawn: (r) => {
    if (!finite(r.id, r.areaId, r.x, r.y)) return false;
    return addRemoteGatherNode({
      id: r.id, areaId: r.areaId, map: String(r.map ?? ""), layerId: String(r.layerId ?? ""), x: r.x, y: r.y, item: String(r.item ?? ""), tile: String(r.tile ?? ""),
    });
  },
  despawn: (id) => removeRemoteGatherNode(Number(id)),
};

export function registerObjectGhosts(): void {
  for (const kind of [lootKind, chestKind, skeletonKind, zoneKind, tornadoKind, gatherKind]) ghosts.register(kind);
}
