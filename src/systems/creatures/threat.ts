/**
 * WoW threat table. Pure data structure: no engine imports.
 *
 * - Threat accumulates per unit; the current victim keeps aggro until another
 *   unit exceeds 110% of its threat (in melee range) or 130% (at range).
 * - Taunt forces the victim for a duration and matches top threat.
 */
import type { CreatureCombatState } from "./types";

export const MELEE_PULL_RATIO = 1.1;
export const RANGED_PULL_RATIO = 1.3;
export const TAUNT_DURATION_MS = 3000;
/** Threat a unit gets for simply being noticed (proximity aggro). */
export const PROXIMITY_THREAT = 0.01;

export interface ThreatEntry {
  threat: number;
  addedAt: number;
  /** When the creature first failed to reach this unit; null while reachable. */
  unreachableSince: number | null;
}

export class ThreatTable {
  private entries = new Map<string, ThreatEntry>();
  victimId: string | null = null;
  private tauntedBy: string | null = null;
  private tauntUntil = 0;

  get size(): number {
    return this.entries.size;
  }

  isEmpty(): boolean {
    return this.entries.size === 0;
  }

  has(unitId: string): boolean {
    return this.entries.has(unitId);
  }

  get(unitId: string): ThreatEntry | undefined {
    return this.entries.get(unitId);
  }

  threatOf(unitId: string): number {
    return this.entries.get(unitId)?.threat ?? 0;
  }

  units(): IterableIterator<string> {
    return this.entries.keys();
  }

  /** Add threat (negative amounts reduce it, never below zero). Returns true if the unit is new. */
  add(unitId: string, amount: number, now: number): boolean {
    const existing = this.entries.get(unitId);
    if (existing) {
      existing.threat = Math.max(0, existing.threat + amount);
      return false;
    }
    this.entries.set(unitId, { threat: Math.max(0, amount), addedAt: now, unreachableSince: null });
    return true;
  }

  /** Scale a unit's threat, e.g. 0.5 for a 50% threat drop. */
  modify(unitId: string, multiplier: number): void {
    const entry = this.entries.get(unitId);
    if (entry) entry.threat = Math.max(0, entry.threat * multiplier);
  }

  remove(unitId: string): boolean {
    const removed = this.entries.delete(unitId);
    if (this.victimId === unitId) this.victimId = null;
    if (this.tauntedBy === unitId) {
      this.tauntedBy = null;
      this.tauntUntil = 0;
    }
    return removed;
  }

  clear(): void {
    this.entries.clear();
    this.victimId = null;
    this.tauntedBy = null;
    this.tauntUntil = 0;
  }

  /** Highest-threat unit (earliest added wins ties). */
  top(): string | null {
    let best: string | null = null;
    let bestThreat = -1;
    let bestAdded = Infinity;
    for (const [id, e] of this.entries) {
      if (e.threat > bestThreat || (e.threat === bestThreat && e.addedAt < bestAdded)) {
        best = id;
        bestThreat = e.threat;
        bestAdded = e.addedAt;
      }
    }
    return best;
  }

  taunt(unitId: string, now: number, durationMs = TAUNT_DURATION_MS): void {
    const topId = this.top();
    const topThreat = topId ? this.threatOf(topId) : 0;
    this.add(unitId, 0, now);
    const entry = this.entries.get(unitId)!;
    entry.threat = Math.max(entry.threat, topThreat);
    this.tauntedBy = unitId;
    this.tauntUntil = now + durationMs;
    this.victimId = unitId;
  }

  /**
   * Choose the victim. `eligible` filters units that can currently be
   * attacked (alive, reachable...); `inMelee` decides the 110% vs 130% rule.
   */
  selectVictim(now: number, inMelee: (unitId: string) => boolean, eligible: (unitId: string) => boolean = () => true): string | null {
    if (this.tauntedBy && now < this.tauntUntil && this.entries.has(this.tauntedBy) && eligible(this.tauntedBy)) {
      this.victimId = this.tauntedBy;
      return this.victimId;
    }
    if (this.tauntedBy && now >= this.tauntUntil) {
      this.tauntedBy = null;
    }

    let challenger: string | null = null;
    let challengerThreat = -1;
    for (const [id, e] of this.entries) {
      if (id === this.victimId || !eligible(id)) continue;
      if (e.threat > challengerThreat) {
        challenger = id;
        challengerThreat = e.threat;
      }
    }

    const victimValid = this.victimId !== null && this.entries.has(this.victimId) && eligible(this.victimId);
    if (!victimValid) {
      this.victimId = challenger;
      return this.victimId;
    }
    if (challenger === null) return this.victimId;

    const victimThreat = this.threatOf(this.victimId!);
    const ratio = inMelee(challenger) ? MELEE_PULL_RATIO : RANGED_PULL_RATIO;
    if (challengerThreat > victimThreat && challengerThreat >= victimThreat * ratio - 1e-9) {
      this.victimId = challenger;
    }
    return this.victimId;
  }

  /** Snapshot for debug overlays: sorted by threat, with % of victim's threat. */
  snapshot(): Array<{ unitId: string; threat: number; pctOfVictim: number }> {
    const victimThreat = this.victimId ? this.threatOf(this.victimId) : 0;
    return [...this.entries]
      .map(([unitId, e]) => ({
        unitId,
        threat: e.threat,
        pctOfVictim: victimThreat > 0 ? (e.threat / victimThreat) * 100 : 0,
      }))
      .sort((a, b) => b.threat - a.threat);
  }
}

/** Fresh out-of-combat state for a newly spawned creature. */
export function createCombatState(): CreatureCombatState {
  return {
    threat: new ThreatTable(),
    startX: 0,
    startY: 0,
    startedAt: 0,
    fleeUntil: 0,
    fleeFromId: null,
    fledThisCombat: false,
    evadeStartedAt: 0,
    nextAggroScanAt: 0,
    nextCombatPulseAt: 0,
    lastRepathAt: 0,
    pathTargetX: 0,
    pathTargetY: 0,
    corpseUntil: 0,
    tapper: null,
  };
}
