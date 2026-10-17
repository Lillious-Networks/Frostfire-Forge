// Who gets a node when several players finish gathering it at the same moment. The first claim on a node opens a
// short window; every claim that comes in while it is open joins it. When it closes, one claimant is picked at random
// (USER REQUEST 2026-10-17: "just choose randomly who to award it to") and `award` is asked, synchronously, whether
// the node is still there to give (it takes the node out of the world as it answers). Everyone else loses.
import log from "../../modules/logger";
import type { Rng } from "./types";

export const CLAIM_WINDOW_MS = 50;

export interface ClaimOptions {
  /** The picked claimant: true when they get the node. Called once per window, before anything is awaited. */
  award(nodeId: number, winner: string): boolean;
  /** Whether a claimant may still win when the window closes (synchronous). One that may not is dropped before the draw. */
  eligible?(nodeId: number, who: string): boolean;
  windowMs?: number;
  r?: Rng;
  /** Runs `run` after `ms`: setTimeout, or a clock a test runs by hand. */
  later?(run: () => void, ms: number): void;
}

interface Claim {
  who: string;
  answer(won: boolean): void;
}

export class ClaimWindow {
  private open = new Map<number, Claim[]>();

  constructor(private readonly options: ClaimOptions) {}

  /** A claim on a node: true once its window closes when this claimant got it. A second claim by the same claimant loses. */
  claim(nodeId: number, who: string): Promise<boolean> {
    return new Promise<boolean>((answer) => {
      const claims = this.open.get(nodeId);
      if (claims) {
        if (claims.some((c) => c.who === who)) answer(false);
        else claims.push({ who, answer });
        return;
      }
      const later = this.options.later ?? ((run: () => void, ms: number) => void setTimeout(run, ms));
      later(() => this.close(nodeId), this.options.windowMs ?? CLAIM_WINDOW_MS);
      this.open.set(nodeId, [{ who, answer }]);
    });
  }

  isOpen(nodeId: number): boolean {
    return this.open.has(nodeId);
  }

  private close(nodeId: number): void {
    const claims = this.open.get(nodeId);
    if (!claims) return;
    this.open.delete(nodeId);
    // a claimant who left range, died, was stunned or went away during the window is dropped before the draw
    const eligible = claims.filter((claim) => {
      try {
        return this.options.eligible?.(nodeId, claim.who) ?? true;
      } catch (error) {
        log.error(`[Gathering] The claim of ${claim.who} on node ${nodeId} could not be checked: ${error}`);
        return false;
      }
    });
    let winner: Claim | undefined;
    let got = false;
    try {
      if (eligible.length > 0) {
        const roll = (this.options.r ?? Math.random)();
        winner = eligible[Math.min(eligible.length - 1, Math.floor(roll * eligible.length))]!;
        got = this.options.award(nodeId, winner.who);
      }
    } catch (error) {
      log.error(`[Gathering] A claim on node ${nodeId} failed: ${error}`);
      got = false;
    }
    for (const claim of claims) claim.answer(got && claim === winner);
  }
}
