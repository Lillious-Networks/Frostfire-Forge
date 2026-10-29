import log from "../../modules/logger";
import type { CreatureSpawner, MovedSlot } from "../../systems/creatures/spawner";
import { inMove, registerBlockPart, type BlockOf, type BlockPart } from "../blockparts";

// The creature spawn slots of a moving block (cells phase 7). Collected first (order 0), so a creature's slot has
// left the old owner before any object of the block is touched. A live creature does not move with its slot: it
// stays where it stands, foreign now, and the handoff watch moves it once the table says the block is the new
// owner's. Third holders learn the new home once the block was sent.

export const CREATURE_SLOTS_PART = "creature-slots";

export interface CreatureSlotsDeps {
  self: string;
  now(): number;
  spawner: Pick<CreatureSpawner, "exportSlots" | "importSlots" | "settleSlots">
    & Partial<Pick<CreatureSpawner, "holdSlots">>
    & Partial<Pick<CreatureSpawner, "foreignHome" | "dropForeign" | "despawn" | "getTemplate">>;
  /** creatureHandoff.tellHome: casts CREATURE_HOME. False when it could not be sent. */
  tellHome(holder: string, id: number, home: string): boolean;
  blockOf?: BlockOf;
}

const isInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

/** A slot from the wire: every field of its kind, of the right type. */
export function isMovedSlot(value: unknown): value is MovedSlot {
  const s = value as any;
  if (!s || typeof s !== "object" || !isInt(s.spawnId) || s.spawnId <= 0) return false;
  if (s.layerId !== null && (typeof s.layerId !== "string" || !s.layerId)) return false;
  if (s.kind === "waiting") return typeof s.inMs === "number" && Number.isFinite(s.inMs);
  if (s.kind !== "held") return false;
  return isInt(s.instanceId) && s.instanceId > 0 && (s.poolId === null || isInt(s.poolId)) && isInt(s.templateId)
    && typeof s.holder === "string" && s.holder.length > 0;
}

export function creatureSlotsPart(deps: CreatureSlotsDeps): BlockPart<MovedSlot[]> {
  const where = (move: { map: string; bx: number; by: number }) => `block ${move.bx},${move.by} of map ${move.map}`;
  return {
    name: CREATURE_SLOTS_PART,
    order: 0,
    collect: (move) => deps.spawner.exportSlots((map, x, y) => inMove(move, map, x, y, deps.blockOf), move.to, deps.self, deps.now()),
    restore: (_move, slots) => {
      deps.spawner.importSlots(slots, deps.now(), deps.self);
    },
    accept: (move, data, from) => {
      if (!Array.isArray(data)) {
        log.warn(`The creature slots of ${where(move)} from ${from} are malformed: none were taken`);
        return;
      }
      const slots = (data as unknown[]).filter(isMovedSlot);
      if (slots.length !== data.length) {
        log.warn(`${data.length - slots.length} malformed creature slot(s) of ${where(move)} from ${from} were dropped`);
      }
      deps.spawner.importSlots(slots, deps.now(), deps.self);
    },
    sent: (move, slots) => {
      // The move happened: the slots' creatures still here may be handed on again, to the new owner first of all.
      deps.spawner.settleSlots(slots);
      for (const slot of slots) {
        // The new owner took its own slot in accept; this node set its own creature's home in collect.
        if (slot.kind !== "held" || slot.holder === move.to || slot.holder === deps.self) continue;
        if (!deps.tellHome(slot.holder, slot.instanceId, move.to)) {
          log.warn(`Creature ${slot.instanceId} held by ${slot.holder}: its new home ${move.to} could not be told; its sweep finds the slot once this node forgets it`);
        }
      }
    },
    hold: (_move, slots, forMs) => {
      // The move is not decided yet and this node keeps the slots: the spawner answers for them that much longer, so
      // their creatures stay here, foreign, until the move is sent or put back (and nothing is removed meanwhile).
      deps.spawner.holdSlots?.(slots, deps.now(), forMs);
    },
    lost: (move, slots) => {
      // The new owner may have taken the slots in, held by this node: its sweep then finds each creature gone and
      // spawns it once. If it did not, the slots wait here as elsewhere ones. Either way the creatures this node still
      // holds for them go, with no respawn and no word to the new owner, so a slot never has two.
      const { spawner } = deps;
      if (!spawner.foreignHome || !spawner.dropForeign || !spawner.despawn) {
        log.error(`The creature slots of ${where(move)} were lost, and this node cannot drop their creatures`);
        return;
      }
      const dropped: string[] = [];
      for (const slot of slots) {
        if (slot.kind !== "held" || slot.holder !== deps.self) continue;
        if (spawner.foreignHome(slot.instanceId) !== move.to) continue;
        // No longer foreign first, so the despawn neither tells the new owner nor schedules a respawn.
        spawner.dropForeign(slot.instanceId);
        spawner.despawn(slot.instanceId, deps.now(), { respawn: false });
        dropped.push(`${spawner.getTemplate?.(slot.templateId)?.name ?? "Creature"} ${slot.instanceId}`);
      }
      if (dropped.length > 0) log.error(`The creature slots of ${where(move)} were lost: their creatures here were removed (${dropped.join(", ")})`);
      // A slot another node holds stays out: that node's creature keeps its home here, and the slot waits as an
      // elsewhere one. Put back as away now, a holder handing the creature home would make it live here while the new
      // owner, if it took the slot, finds it gone and spawns a second. Only an abort puts it back (lostAborted).
    },
    lostAborted: (move, slots) => {
      // The new owner never took the slots in. The ones other nodes hold go back as away slots, as a restore puts
      // them: otherwise this node spawns them afresh once the block is its again, while their holders keep the creatures.
      const held = slots.filter((slot): slot is Extract<MovedSlot, { kind: "held" }> => slot.kind === "held" && slot.holder !== deps.self);
      if (held.length === 0) return;
      const taken = deps.spawner.importSlots(held, deps.now(), deps.self);
      log.warn(`The lost move of ${where(move)} was aborted: ${taken} of ${held.length} creature slot(s) held elsewhere are held here again (${held.map((slot) => `${slot.instanceId} at ${slot.holder}`).join(", ")})`);
    },
  };
}

export function registerCreatureSlots(deps: CreatureSlotsDeps): () => void {
  return registerBlockPart(creatureSlotsPart(deps));
}
