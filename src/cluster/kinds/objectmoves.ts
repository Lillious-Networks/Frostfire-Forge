import log from "../../modules/logger";
import { checkBoundsNow, isItemQuantity, refreshItemNames, refreshItemQuantityMax } from "../../systems/itembounds";
import loot, { type LootItem } from "../../systems/loot";
import lootChest, { type MovedChest } from "../../systems/lootChest";
import skeletons, { type DeathSkeleton } from "../../systems/skeletons";
import {
  adoptTornado, removeRemoteTornado, setRemoteTornado, takeOwnTornado, tornadoMaps, tornadoesOn, type Tornado,
} from "../../systems/tornadoes";
import { inMove, registerBlockPart, type BlockMove, type BlockOf, type BlockPart } from "../blockparts";
import type { GhostKindName, Ghosts } from "../ghosts";
import { objectViews, type ObjectViews } from "./objects";

// The objects of a moving block (cells phase 7): ground loot, chests, death skeletons, tornadoes. On the old owner
// each leaves its own objects, is handed over in the ghost tracker, and stays shown here as the new owner's mirror.
// On the new owner each becomes its own, and its mirror entry is dropped. Gathering nodes and ground AOEs do not move:
// the new owner's spawner fills its own areas, and an AOE runs out in seconds.
// Each collect logs, under the move's id, every object it took, by name: a move later lost on any path (an order
// never decided, a node that died) leaves what it carried named in the log.
// At most once rests on the move's order (blockmove.ts): accept or restore runs once per move. Run twice on the same
// data, the part refuses only what is still here; an object taken since (loot picked up) would be taken in again.

export const OBJECTS_PART = "objects";

export interface MovedObjects {
  loot: LootItem[];
  chests: MovedChest[];
  skeletons: DeathSkeleton[];
  tornadoes: Tornado[];
}

export interface ObjectMovesDeps {
  ghosts: Pick<Ghosts, "handOver" | "adoptMirror" | "dropMirror">;
  now(): number;
  /** How this node's viewers are shown objects; objectViews by default. */
  views?: ObjectViews;
  blockOf?: BlockOf;
}

type Adopted = "mirror" | "new" | null;

interface Mover<T extends { id: string }> {
  key: keyof MovedObjects;
  ghost: GhostKindName;
  /** For log lines: "Loot", "Chest", ... */
  label: string;
  /** For the malformed warning: "loot", "chests", ... */
  plural: string;
  own(): Iterable<{ id: string; map: string; x: number; y: number }>;
  take(id: string): T | null;
  adopt(record: T, now: number): Adopted;
  /** The record the ghost kind's spawn takes. */
  ghostRecord(record: T): any;
  /** A remote copy in place with nothing sent: this node's viewers already see it. */
  keepShown(record: T): void;
  /** The remote copy out, and its viewers told. */
  dropShown(record: T): void;
  show(record: T): void;
  valid(value: unknown): value is T;
}

const isText = (v: unknown): v is string => typeof v === "string";
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const finite = (...values: unknown[]) => values.every((v) => typeof v === "number" && Number.isFinite(v));
const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/** Each player's rolled items of a chest that they have not taken: "p1: Opal x1, Gem x1; p2: none". */
function untakenRolls(playerLoot: unknown): string {
  if (!Array.isArray(playerLoot)) return "no rolls";
  if (!playerLoot.length) return "not opened";
  return playerLoot.map((entry: any) => {
    const rolled: any[] = Array.isArray(entry?.[1]?.rolled) ? entry[1].rolled : [];
    const taken = new Set(Array.isArray(entry?.[1]?.taken) ? entry[1].taken : []);
    const left = rolled.filter((i) => !taken.has(i?.index)).map((i) => `${String(i?.itemName)} x${String(i?.quantity)}`);
    return `${String(entry?.[0])}: ${left.length ? left.join(", ") : "none"}`;
  }).join("; ");
}

/**
 * A record for a log line, by id; loot with the item and how many, a chest with each player's untaken rolled items:
 * what was lost or refused is named.
 */
function named(v: unknown): string {
  if (!isObject(v)) return String(v);
  if (v.item != null) return `${String(v.id ?? "?")} (${String(v.item)} x${String(v.quantity)})`;
  if (v.playerLoot !== undefined) return `${String(v.id ?? "?")} (${untakenRolls(v.playerLoot)})`;
  return String(v.id ?? "?");
}

/**
 * A rolled chest item as a move carries it, held to the hand-over bounds (itembounds.ts checkBoundsNow, security review
 * Minor 6): a name of the item table (when one is loaded) and a whole count from 1 to the item quantity cap, as ground
 * loot is held to. A bound not read yet does not drop it: a moved record cannot wait, so only a known bound refuses.
 * The cap and the table are read in accept. Guard (test "a moved chest's rolled item is held to the bounds: a name not
 * in the item table is dropped").
 */
const isRolledItem = (v: unknown): boolean => {
  if (!isObject(v) || !isId(v.itemName) || !isItemQuantity(v.quantity)) return false;
  const verdict = checkBoundsNow([{ itemName: v.itemName, quantity: v.quantity }], 0);
  return verdict.ok || !verdict.ready;
};

// Security review M4: the count of moved ground loot is held to what one configured source hands out (itembounds.ts
// isItemQuantity, read in accept), so a node cannot hand over more of an item than any loot gives. Guard (test "moved loot or a
// chest roll above the most one source gives is refused by name").
export function isMovedLoot(v: unknown): v is LootItem {
  if (!isObject(v)) return false;
  return isId(v.id) && isText(v.item) && isItemQuantity(v.quantity) && isText(v.quality) && isText(v.iconUrl)
    && isId(v.map) && finite(v.x, v.y, v.expiresAt) && isText(v.ownerId) && isText(v.ownerName);
}

export function isMovedChest(v: unknown): v is MovedChest {
  if (!isObject(v) || !isId(v.id) || !isId(v.map) || !finite(v.x, v.y) || !isText(v.iconUrl) || !isText(v.createdBy)) return false;
  if (v.lootTableId != null && !Number.isInteger(v.lootTableId)) return false;
  if (v.inlineLootTable != null && !Array.isArray(v.inlineLootTable)) return false;
  return Array.isArray(v.playerLoot) && v.playerLoot.every((entry: unknown) =>
    Array.isArray(entry) && entry.length === 2 && isId(entry[0]) && isObject(entry[1]) && Array.isArray(entry[1].rolled)
    && entry[1].rolled.every(isRolledItem) && Array.isArray(entry[1].taken) && entry[1].taken.every((i: unknown) => Number.isInteger(i)));
}

export function isMovedSkeleton(v: unknown): v is DeathSkeleton {
  if (!isObject(v)) return false;
  return isId(v.id) && isId(v.username) && isId(v.map) && (v.layerId === null || isId(v.layerId)) && finite(v.x, v.y, v.createdAt, v.expiresAt);
}

export function isMovedTornado(v: unknown): v is Tornado {
  if (!isObject(v)) return false;
  return isId(v.id) && isId(v.map) && finite(v.x, v.y, v.heading, v.speed, v.diesAt) && v.speed >= 0;
}

function movers(views: ObjectViews): Array<Mover<any>> {
  const chestView = (c: MovedChest) => ({ id: c.id, map: c.map, x: c.x, y: c.y, iconUrl: c.iconUrl });
  const tornadoView = (t: Tornado) => ({ id: t.id, map: t.map, x: Math.round(t.x), y: Math.round(t.y) });
  const lootMover: Mover<LootItem> = {
    key: "loot", ghost: "loot", label: "Loot", plural: "loot",
    own: () => loot.all(),
    take: (id) => loot.takeOwn(id),
    adopt: (r, now) => loot.adoptOwn(r, now),
    ghostRecord: (r) => ({ ...r }),
    keepShown: (r) => loot.addRemote({ ...r }),
    dropShown: (r) => { if (loot.removeRemote(r.id)) views.hideLoot(r); },
    show: (r) => views.showLoot(r),
    valid: isMovedLoot,
  };
  const chestMover: Mover<MovedChest> = {
    key: "chests", ghost: "chest", label: "Chest", plural: "chests",
    own: () => lootChest.all(),
    take: (id) => lootChest.takeOwn(id),
    adopt: (r) => lootChest.adoptOwn(r),
    ghostRecord: chestView,
    keepShown: (r) => lootChest.addRemote(chestView(r)),
    dropShown: (r) => { if (lootChest.removeRemote(r.id)) views.hideChest(r); },
    show: (r) => views.showChest(chestView(r)),
    valid: isMovedChest,
  };
  const skeletonMover: Mover<DeathSkeleton> = {
    key: "skeletons", ghost: "skeleton", label: "Skeleton", plural: "skeletons",
    own: () => skeletons.all(),
    take: (id) => skeletons.takeOwn(id),
    adopt: (r, now) => skeletons.adoptOwn(r, now),
    ghostRecord: (r) => ({ ...r }),
    keepShown: (r) => skeletons.addRemote({ ...r }),
    dropShown: (r) => { if (skeletons.removeRemote(r.id)) views.hideSkeleton(r); },
    show: (r) => views.showSkeleton(r),
    valid: isMovedSkeleton,
  };
  const tornadoMover: Mover<Tornado> = {
    key: "tornadoes", ghost: "tornado", label: "Tornado", plural: "tornado",
    *own() { for (const map of tornadoMaps()) yield* tornadoesOn(map); },
    take: (id) => takeOwnTornado(id),
    adopt: (r) => adoptTornado(r),
    ghostRecord: tornadoView,
    keepShown: (r) => { setRemoteTornado(tornadoView(r)); },
    // The tick's show pass lists what is left on the map: nothing to send here.
    dropShown: (r) => removeRemoteTornado(r.id),
    show: () => {},
    valid: isMovedTornado,
  };
  return [lootMover, chestMover, skeletonMover, tornadoMover];
}

const where = (move: BlockMove) => `block ${move.bx},${move.by} of map ${move.map}`;

function adoptAll<T extends { id: string }>(mover: Mover<T>, records: T[], deps: ObjectMovesDeps, move: BlockMove): void {
  const now = deps.now();
  for (const record of records) {
    let adopted: Adopted;
    try {
      adopted = mover.adopt(record, now);
    } catch (error) {
      log.error(`${mover.label} ${named(record)} of ${where(move)} could not be taken in, and is lost: ${error}`);
      continue;
    }
    if (adopted === null) {
      log.warn(`${mover.label} ${named(record)} of ${where(move)} is already this node's own: the one here is kept`);
      continue;
    }
    // It is this node's own now: a failure to show it, or to drop its mirror entry, does not stop the rest.
    try {
      // A mirror shown here already is not shown twice.
      if (adopted === "new") mover.show(record);
      deps.ghosts.dropMirror(mover.ghost, record.id);
    } catch (error) {
      log.error(`${mover.label} ${named(record)} of ${where(move)} is this node's own, but was not shown: ${error}`);
    }
  }
}

export function objectMovesPart(deps: ObjectMovesDeps): BlockPart<MovedObjects> {
  const list = movers(deps.views ?? objectViews);
  return {
    name: OBJECTS_PART,
    order: 1,
    collect: (move) => {
      const out: MovedObjects = { loot: [], chests: [], skeletons: [], tornadoes: [] };
      for (const mover of list) {
        // Ids first: take() changes the map own() walks.
        const ids = [...mover.own()].filter((o) => inMove(move, o.map, o.x, o.y, deps.blockOf)).map((o) => o.id);
        for (const id of ids) {
          const record = mover.take(id);
          if (!record) continue;
          // In the answer before anything else can throw: what was taken is sent (or restored), never dropped.
          (out[mover.key] as unknown[]).push(record);
          try {
            // Untracked now, before the next ghost pass finds it gone and despawns it on every peer, the new owner among them.
            deps.ghosts.handOver(mover.ghost, id, move.to);
            // Its viewers here keep it: a copy already shown, held as the new owner's mirror until the new owner sends it.
            mover.keepShown(record);
            if (!deps.ghosts.adoptMirror(mover.ghost, mover.ghostRecord(record), move.to)) mover.dropShown(record);
          } catch (error) {
            log.error(`${mover.label} ${named(record)} of ${where(move)} leaves with its block, but its mirror here failed: ${error}`);
            try {
              mover.dropShown(record);
            } catch (cleanup) {
              log.error(`${mover.label} ${named(record)}: its copy here could not be removed: ${cleanup}`);
            }
          }
        }
      }
      const taken = list.filter((mover) => out[mover.key].length)
        .map((mover) => `${mover.plural} ${(out[mover.key] as unknown[]).map(named).join(", ")}`);
      if (taken.length) log.info(`Block move ${move.id} takes out of ${where(move)} for ${move.to}: ${taken.join("; ")}`);
      return out;
    },
    restore: (move, data) => {
      for (const mover of [...list].reverse()) adoptAll(mover, data[mover.key] as any[], deps, move);
    },
    accept: async (move, data, from) => {
      // The quantity cap and the item table read now (itembounds.ts): a configured row above 9999 is moved, not dropped,
      // and a rolled chest item is checked against the table this node loads.
      await refreshItemQuantityMax();
      await refreshItemNames();
      if (!isObject(data)) {
        log.warn(`The objects of ${where(move)} from ${from} are malformed: none were taken`);
        return;
      }
      for (const mover of list) {
        const raw = (data as any)[mover.key];
        if (raw === undefined) continue;
        if (!Array.isArray(raw)) {
          log.warn(`The ${mover.plural} of ${where(move)} from ${from} are malformed: none were taken`);
          continue;
        }
        const records = raw.filter((r: unknown) => mover.valid(r));
        if (records.length !== raw.length) {
          const dropped = raw.filter((r: unknown) => !mover.valid(r)).map(named).join(", ");
          log.warn(`${raw.length - records.length} malformed ${mover.plural} record(s) of ${where(move)} from ${from} were dropped: ${dropped}`);
        }
        adoptAll(mover, records, deps, move);
      }
    },
  };
}

export function registerObjectMoves(deps: ObjectMovesDeps): () => void {
  return registerBlockPart(objectMovesPart(deps));
}
