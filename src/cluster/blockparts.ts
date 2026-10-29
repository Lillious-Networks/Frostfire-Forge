import { blockAt } from "./blocks";
import { bareMap } from "./mirrors";

// What moves with a block (spec §2, moving a block). Each system that keeps state tied to a place registers a part:
// the creature spawner's slots, ground loot, chests, skeletons, tornadoes. A move (blockmove.ts) takes every
// part's state out of the old owner first (collect), sends it all in one call, and the new owner takes it in
// (accept). A move that certainly did not reach the new owner puts it back (restore); one that did tells each part
// (sent). Removed before it is sent: a lost call loses the block's objects, logged by name, and never doubles them.
// Registration at module load does nothing by itself: only a move runs a part.

/** One block changing owner, as its move order says. `map` is bare (no ".json"). */
export interface BlockMove { id: string; map: string; bx: number; by: number; from: string; to: string }

export interface BlockPart<D = unknown> {
  /** Its key in the BLOCK_MOVE body. */
  name: string;
  /** Collected and accepted in this order, lowest first; restored in the reverse order. */
  order: number;
  /** Old owner: takes the part's state in the block out of this node, and answers it. */
  collect(move: BlockMove): D | Promise<D>;
  /** Old owner: puts back what collect took, when the move certainly did not happen. */
  restore(move: BlockMove, data: D): void | Promise<void>;
  /** New owner: takes the state in. What it refuses, it logs by name. */
  accept(move: BlockMove, data: D, from: string): void | Promise<void>;
  /** Old owner, once the new owner accepted. */
  sent?(move: BlockMove, data: D): void | Promise<void>;
  /**
   * Old owner, when the move cannot be decided in the usual time and it keeps holding the state for `forMs` more
   * (blockmove.ts, UNDECIDED_HOLD_MS): keep answering for it that long. Nothing is dropped; a part that lets go of the
   * state on a timer (the creature spawner's OUTGOING_KEEP_MS) holds on for `forMs` from now.
   */
  hold?(move: BlockMove, data: D, forMs: number): void | Promise<void>;
  /**
   * Old owner, when it cannot learn whether the new owner took the state in (the order could not be read in time).
   * The new owner may hold it: drop what this node still holds of it, logged by name, and put nothing back.
   */
  lost?(move: BlockMove, data: D): void | Promise<void>;
  /**
   * Old owner, after lost: the order was read back aborted later, so the new owner never took the state in. Puts back
   * what lost could not drop and other nodes still hold, before the block is this node's again. Never called once
   * the table moved the block on, nor after a restart (the data died with the run).
   */
  lostAborted?(move: BlockMove, data: D): void | Promise<void>;
}

const parts = new Map<string, BlockPart<any>>();

/** Throws on a second part of one name; the returned function removes this one. */
export function registerBlockPart(part: BlockPart<any>): () => void {
  if (parts.has(part.name)) throw new Error(`Block part ${part.name} is already registered`);
  parts.set(part.name, part);
  return () => { if (parts.get(part.name) === part) parts.delete(part.name); };
}

export function blockParts(): Array<BlockPart<any>> {
  return [...parts.values()].sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export type BlockOf = (map: string, x: number, y: number) => { bx: number; by: number };

/** Whether (x, y) of `map` lies in the moving block. `blockOf` is the table's (it clamps at the map's edge). */
export function inMove(move: Pick<BlockMove, "map" | "bx" | "by">, map: string, x: number, y: number, blockOf: BlockOf = (_map, px, py) => blockAt(px, py)): boolean {
  if (bareMap(map) !== bareMap(move.map)) return false;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const { bx, by } = blockOf(map, x, y);
  return bx === move.bx && by === move.by;
}
