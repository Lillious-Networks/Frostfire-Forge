// The rules of one gather, without the network: whether a player may start, and what happens when their cast ends.
// The receiver runs the cast between the two (castGather). When the cast ends the checks run again, and the player
// claims the node: claims that land in the same CLAIM_WINDOW_MS get one winner at random. The node is taken out of
// the world the moment the winner is picked; if the item then cannot be given, the node is put back.
import log from "../../modules/logger";
import { randInt } from "../creatures/constants";
import { CLAIM_WINDOW_MS, ClaimWindow } from "./claims";
import type { GatherSpawner } from "./spawner";
import type { GatherNode, Rng } from "./types";

/** px between the player and the node. */
export const GATHER_RANGE = 100;
export const GATHER_CAST_MS = 1000;

export const REASONS = {
  gone: "There is nothing there to gather.",
  far: "You are too far away to gather that.",
  dead: "You can't gather while dead.",
  stunned: "You can't gather while stunned.",
  casting: "You are already casting.",
  moving: "You must stand still to gather.",
  combat: "You can't gather while in combat.",
  full: "Your bags are full.",
  lost: "Someone else gathered it.",
  failed: "You could not gather that. Try again.",
} as const;

/** A player as the rules see them. */
export interface Gatherer {
  id: string;
  username: string;
  map: string;
  layerId: string | null;
  x: number;
  y: number;
  dead: boolean;
  stunned: boolean;
  casting: boolean;
  moving: boolean;
  inCombat: boolean;
}

export type GatherOutcome = { ok: true; node: GatherNode; item: string; quantity: number } | { ok: false; reason: string };

export interface ServiceDeps {
  spawner: Pick<GatherSpawner, "get" | "take" | "restore" | "settle" | "area">;
  /** The player as they stand now, or null when they left. */
  gatherer(playerId: string): Gatherer | null;
  hasRoomFor(username: string, item: string): Promise<boolean>;
  /** Puts the items in the player's bags: false (or a throw) when nothing was written. */
  give(username: string, item: string, quantity: number): Promise<boolean>;
  r?: Rng;
  windowMs?: number;
  later?(run: () => void, ms: number): void;
  now?(): number;
}

export class GatherService {
  private readonly claims: ClaimWindow;
  /** Nodes taken for the winner of their window, until the item is given. */
  private readonly won = new Map<number, GatherNode>();

  constructor(private readonly deps: ServiceDeps) {
    this.claims = new ClaimWindow({
      windowMs: deps.windowMs ?? CLAIM_WINDOW_MS,
      r: deps.r,
      later: deps.later,
      eligible: (nodeId, who) => this.eligible(nodeId, who),
      award: (nodeId) => {
        const node = this.deps.spawner.take(nodeId, (this.deps.now ?? Date.now)());
        if (!node) return false;
        this.won.set(nodeId, node);
        return true;
      },
    });
  }

  /** The checks that need no await: why `g` may not gather `node`, or null. `starting`: before the cast, when casting and moving count too. */
  private rule(g: Gatherer | null, node: GatherNode | undefined, starting: boolean): string | null {
    if (!g || !node || node.map !== g.map || node.layerId !== g.layerId) return REASONS.gone;
    if (Math.hypot(node.x - g.x, node.y - g.y) > GATHER_RANGE) return REASONS.far;
    if (g.dead) return REASONS.dead;
    if (g.stunned) return REASONS.stunned;
    if (starting && g.casting) return REASONS.casting;
    if (starting && g.moving) return REASONS.moving;
    if (g.inCombat) return REASONS.combat;
    return null;
  }

  /** For the moment a claim window closes: the synchronous checks only (the bag check is awaited, and runs again after). */
  private eligible(nodeId: number, who: string): boolean {
    return this.rule(this.deps.gatherer(who), this.deps.spawner.get(nodeId), false) === null;
  }

  /** Why `g` may not gather `node`, or null when they may. */
  private async refusal(g: Gatherer | null, node: GatherNode | undefined, starting: boolean): Promise<string | null> {
    const why = this.rule(g, node, starting);
    if (why) return why;
    if (!(await this.deps.hasRoomFor(g!.username, node!.item))) return REASONS.full;
    return null;
  }

  /** Whether a player may start gathering a node: the node when they may. */
  async start(playerId: string, nodeId: unknown): Promise<{ ok: true; node: GatherNode } | { ok: false; reason: string }> {
    const node = this.deps.spawner.get(Number(nodeId));
    const why = await this.refusal(this.deps.gatherer(playerId), node, true);
    if (why || !node) return { ok: false, reason: why ?? REASONS.gone };
    return { ok: true, node };
  }

  /** The cast ended: checks again, claims the node, and gives the item to whoever wins it. */
  async finish(playerId: string, nodeId: number): Promise<GatherOutcome> {
    const g = this.deps.gatherer(playerId);
    if (!g) return { ok: false, reason: REASONS.lost };
    const why = await this.refusal(g, this.deps.spawner.get(nodeId), false);
    // gone during the cast: someone else's window took it
    if (why) return { ok: false, reason: why === REASONS.gone ? REASONS.lost : why };
    if (!(await this.claims.claim(nodeId, playerId))) {
      // dropped from the draw because of their own state (left range, died, stunned): say so; otherwise someone else won
      const own = this.rule(this.deps.gatherer(playerId), this.deps.spawner.get(nodeId), false);
      return { ok: false, reason: own && own !== REASONS.gone ? own : REASONS.lost };
    }

    const node = this.won.get(nodeId)!;
    this.won.delete(nodeId);
    // the window closed after the checks: the winner may have died, entered combat or left in between
    const winner = this.deps.gatherer(playerId);
    const late = await this.refusal(winner, node, false);
    if (!winner || late) {
      this.deps.spawner.restore(node);
      const reason = late ?? REASONS.lost;
      return { ok: false, reason: reason === REASONS.gone ? REASONS.lost : reason };
    }
    const area = this.deps.spawner.area(node.areaId);
    const quantity = area ? randInt(area.quantity_min, area.quantity_max, this.deps.r) : 1;
    let given = false;
    try {
      given = await this.deps.give(winner.username, node.item, quantity);
    } catch (error) {
      log.error(`[Gathering] ${quantity} x ${node.item} could not be given to ${winner.username}: ${error}`);
      given = false;
    }
    if (!given) {
      this.deps.spawner.restore(node);
      return { ok: false, reason: REASONS.failed };
    }
    this.deps.spawner.settle(node.id);
    return { ok: true, node, item: node.item, quantity };
  }
}
