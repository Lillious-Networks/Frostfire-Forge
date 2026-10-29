// src/cluster/handoffwatch.ts

// When a player crosses into a block another node owns, and whether they may go now (cells phase 6, spec §5).
// The watch tick in the receiver (Task 14) asks pickHandoffs every 250 ms; the creature tick (Task 16) asks
// handoffTarget for each creature it moved.

import { unsettled } from "./tradesettle";
import { storeIsUp } from "./health";

/** How far inside the other node's block a point must be: a player on the border does not go back and forth. */
export const EDGE_MARGIN_PX = 64;
/** How far inside the block a player must stand to be handed straight back to the node they came from (HANDOFF_DWELL_MS in handoff.ts). */
export const DWELL_MARGIN_PX = 2 * EDGE_MARGIN_PX;
/**
 * How far ahead of a walking player a border to another node is looked for: within this distance their client is told
 * which node is next and opens a session there (PlayerHandoff.prepare). The handoff itself starts EDGE_MARGIN_PX inside.
 */
export const HANDOFF_PREPARE_PX = 384;
/** The distances along the walk the prepare looks at, nearest first: a border is found within the first step past it. */
const PREPARE_STEPS_PX: readonly number[] = [96, 192, 288, HANDOFF_PREPARE_PX];
/** The most handoffs one tick starts: a crowd crossing at once is spread over a few ticks. */
export const HANDOFFS_PER_TICK = 20;

export type OwnerAt = (map: string, x: number, y: number) => string | null;

const OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

/** The map name the blocks are keyed by: players carry "main.json", the blocks "main". */
export function bareMapName(map: string): string {
  return String(map ?? "").replace(/\.json$/i, "");
}

/**
 * The node a player or creature at (x, y) should move to, or null. It moves only when another node owns the point
 * and this node owns none of the points `margin` (EDGE_MARGIN_PX) around it. A point nobody owns stays where it is.
 */
export function handoffTarget(map: string, x: number, y: number, ownerAt: OwnerAt, self: string, margin: number = EDGE_MARGIN_PX): string | null {
  const bare = bareMapName(map);
  const owner = ownerAt(bare, x, y);
  if (!owner || owner === self) return null;
  for (const [dx, dy] of OFFSETS) {
    if (ownerAt(bare, x + dx * margin, y + dy * margin) === self) return null;
  }
  return owner;
}

const UNIT: Readonly<Record<string, readonly [number, number]>> = {
  up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0],
  upleft: [-1, -1], upright: [1, -1], downleft: [-1, 1], downright: [1, 1],
};

/**
 * The node whose block a player at (x, y) walking in `walk` reaches within HANDOFF_PREPARE_PX, or null: only while this
 * node owns the point they stand on, and only along the way they walk (a player walking away, or standing, has none).
 */
export function prepareTarget(map: string, x: number, y: number, walk: string | null, ownerAt: OwnerAt, self: string): string | null {
  const unit = walk ? UNIT[walk] : undefined;
  if (!unit) return null;
  const bare = bareMapName(map);
  const here = ownerAt(bare, x, y);
  if (here && here !== self) {
    // Already past the border but not yet far enough in for the handoff (EDGE_MARGIN_PX): the prepare stays while they
    // keep walking into that block, so the client's session is not closed a moment before the switch uses it. It ends
    // when they turn back toward this node or walk toward another one.
    const step = PREPARE_STEPS_PX[0];
    const scaleHere = unit[0] !== 0 && unit[1] !== 0 ? Math.SQRT1_2 : 1;
    return ownerAt(bare, x + unit[0] * step * scaleHere, y + unit[1] * step * scaleHere) === here ? here : null;
  }
  if (here !== self) return null;
  // A diagonal covers the same distance with a smaller step on each axis.
  const scale = unit[0] !== 0 && unit[1] !== 0 ? Math.SQRT1_2 : 1;
  for (const d of PREPARE_STEPS_PX) {
    const owner = ownerAt(bare, x + unit[0] * d * scale, y + unit[1] * d * scale);
    if (owner && owner !== self) return owner;
  }
  return null;
}

export type BlockReason = "remote" | "pending" | "dead" | "revive" | "ghost-teleport" | "trading" | "settling" | "casting" | "dragged" | "cooldown" | "store" | "link";

/** What the watch asks of the rest of the node (Task 14 builds it from the trades, the drags and playerHandoff). */
export interface HandoffChecks {
  trading(username: string): boolean;
  dragged(playerId: string): boolean;
  pending(username: string): boolean;
  coolingDown(username: string): boolean;
  linkUp(peer: string): boolean;
  /** Whether the player came here from `peer` a moment ago (HANDOFF_DWELL_MS): they are not sent straight back unless they stand well inside it. */
  dwellingFrom?(username: string, peer: string): boolean;
  /** Whether the player's bags and coins may predate a swap on another node. The node's marks (cluster/tradesettle.ts) unless given. */
  settling?(username: string): boolean;
  /** Whether the cluster store is up. The node's health (cluster/health.ts) unless given. */
  storeUp?(): boolean;
}

/**
 * Why `player` may not be handed to `target` now, or null. A corpse (dead and not yet a ghost) stays, and so does a
 * player with a resurrection or a graveyard teleport on offer: the offer and the corpse live on this node. A ghost
 * may go. A trade, a cast or an admin's drag ends first, and so does the settling after a lost trade. A down link
 * pauses handoffs (spec §7). `draining`: asked by the handoff itself once the player is drained, so its own pending
 * flag and the player's frozen state are not a reason.
 */
export function handoffBlocked(player: any, target: string, checks: HandoffChecks, opts: { draining?: boolean } = {}): BlockReason | null {
  const username = String(player?.username ?? "");
  if (player?.remote) return "remote";
  if (!opts.draining && (player?.handoff || checks.pending(username))) return "pending";
  if (player?.isDead && !player?.isGhost) return "dead";
  if (player?.reviveOffered) return "revive";
  if (player?.ghostTeleportPending) return "ghost-teleport";
  if (checks.trading(username)) return "trading";
  // Marked unsettled after a lost trade: the mark is held on this node only, and the node they went to would write
  // their bags and coins from rows that may predate the swap (cluster/tradesettle.ts). They stay until it runs out.
  if ((checks.settling ?? unsettled)(username)) return "settling";
  if (player?.casting) return "casting";
  if (checks.dragged(String(player?.id ?? ""))) return "dragged";
  if (checks.coolingDown(username)) return "cooldown";
  // A dead Redis pauses handoffs (spec §7): the ticket, the directory and the owner epoch all live there.
  if (!(checks.storeUp ?? storeIsUp)()) return "store";
  if (!checks.linkUp(target)) return "link";
  return null;
}

export interface HandoffPick { player: any; target: string }

function isCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * What the watch does about players who walk toward a border (PlayerHandoff.prepare / unprepare): each moving player
 * who is not picked this tick has the node ahead of them prepared, or, walking another way, the prepare withdrawn. A
 * standing player is left as they are (the client's own timer ends a session that is not used). `walkOf` answers the
 * direction a player's mover steps in, or null.
 */
export function prepareWalkers(
  players: Iterable<any>,
  picks: ReadonlyArray<HandoffPick>,
  ownerAt: OwnerAt,
  self: string,
  checks: HandoffChecks,
  walkOf: (player: any) => string | null,
  hand: { prepare(player: any, target: string): unknown; unprepare(player: any): void },
): void {
  const picked = new Set(picks.map((pick) => pick.player));
  for (const player of players) {
    if (player?.moving !== true || player.remote || picked.has(player)) continue;
    const walk = walkOf(player);
    const map = player.location?.map;
    const x = player.location?.position?.x;
    const y = player.location?.position?.y;
    if (!walk || typeof map !== "string" || !isCoordinate(x) || !isCoordinate(y)) continue;
    const target = prepareTarget(map, x, y, walk, ownerAt, self);
    if (!target) {
      hand.unprepare(player);
      continue;
    }
    if (handoffBlocked(player, target, checks) === null) hand.prepare(player, target);
  }
}

/** The players that stand well inside another node's block and may go now, at most `max`, in the order given. */
export function pickHandoffs(players: Iterable<any>, ownerAt: OwnerAt, self: string, checks: HandoffChecks, max = HANDOFFS_PER_TICK): HandoffPick[] {
  const picks: HandoffPick[] = [];
  for (const player of players) {
    if (picks.length >= max) break;
    const map = player?.location?.map;
    const x = player?.location?.position?.x;
    const y = player?.location?.position?.y;
    // A missing or null coordinate is skipped: Number(null) is 0, which is a real point on the map.
    if (typeof map !== "string" || !isCoordinate(x) || !isCoordinate(y)) continue;
    const target = handoffTarget(map, x, y, ownerAt, self);
    if (!target || handoffBlocked(player, target, checks)) continue;
    // Just handed here from `target`: back only from well inside it, so a player on the border is not sent to and fro.
    const username = String(player?.username ?? "");
    if (checks.dwellingFrom?.(username, target) && !handoffTarget(map, x, y, ownerAt, self, DWELL_MARGIN_PX)) continue;
    picks.push({ player, target });
  }
  return picks;
}
