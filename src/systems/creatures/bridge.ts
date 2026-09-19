/**
 * Hooks the socket layer registers so creature combat can use engine-owned
 * player flows (barriers, death, stat broadcasts, spell effects) without the
 * creature system importing receiver.ts.
 */
export interface CreatureEngineBridge {
  /** Apply already-mitigated damage to a player, including death handling. */
  damagePlayer(player: any, amount: number, info: { isCrit: boolean; creatureId: number; creatureName: string }): Promise<void> | void;
  /** Apply the WoW "Dazed" movement slow. */
  dazePlayer(player: any): Promise<void> | void;
  /** Run a spell's effects (DoT, stun, slow, interrupt...) on a player, cast by a creature. */
  applySpellEffects(player: any, caster: any, spell: SpellData): Promise<void> | void;
}

let bridge: CreatureEngineBridge | null = null;

export function setCreatureEngineBridge(next: CreatureEngineBridge): void {
  bridge = next;
}

export function getCreatureEngineBridge(): CreatureEngineBridge | null {
  return bridge;
}
