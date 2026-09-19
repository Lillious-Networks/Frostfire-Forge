/**
 * Corpse loot. One roll per corpse (not per player), owned by whoever the
 * tapping rules award it to. Items go to the loot owner; money is split
 * evenly between everyone eligible when the owner loots it. Pure state; the
 * socket layer performs the inventory/currency writes.
 */

export interface CorpseItem {
  index: number;
  itemName: string;
  quantity: number;
  quality: string;
  iconUrl: string;
}

export interface CorpseLoot {
  creatureId: number;
  items: CorpseItem[];
  taken: Set<number>;
  copper: number;
  /** Usernames (lowercase) allowed to take items. */
  owners: Set<string>;
  /** Usernames (lowercase) that receive a share of the money. */
  moneyShare: string[];
}

export interface LootTakeResult {
  taken: CorpseItem[];
  /** username -> copper awarded */
  copper: Map<string, number>;
  empty: boolean;
}

/** Split copper evenly; the looter receives any remainder. */
export function splitCopper(total: number, recipients: string[], looter: string): Map<string, number> {
  const out = new Map<string, number>();
  if (total <= 0) return out;
  const people = recipients.length > 0 ? recipients : [looter];
  const each = Math.floor(total / people.length);
  let remainder = total - each * people.length;
  for (const name of people) out.set(name, each);
  if (remainder > 0) {
    const key = people.includes(looter) ? looter : people[0];
    out.set(key, (out.get(key) ?? 0) + remainder);
    remainder = 0;
  }
  for (const [k, v] of out) if (v <= 0) out.delete(k);
  return out;
}

export class CorpseLootStore {
  private corpses = new Map<number, CorpseLoot>();
  /** party key -> round-robin cursor */
  private rotation = new Map<string, number>();

  /**
   * Round-robin owner for a group: rotates through the eligible members
   * (sorted for stability) each kill. Solo kills always go to the tapper.
   */
  pickOwner(groupKey: string | null, eligible: string[]): string | null {
    if (eligible.length === 0) return null;
    if (!groupKey || eligible.length === 1) return eligible[0];
    const sorted = [...eligible].sort();
    const cursor = this.rotation.get(groupKey) ?? 0;
    this.rotation.set(groupKey, cursor + 1);
    return sorted[cursor % sorted.length];
  }

  create(creatureId: number, items: CorpseItem[], copper: number, owners: string[], moneyShare: string[]): CorpseLoot | null {
    if (items.length === 0 && copper <= 0) return null;
    const loot: CorpseLoot = {
      creatureId,
      items,
      taken: new Set(),
      copper: Math.max(0, Math.floor(copper)),
      owners: new Set(owners.map((o) => o.toLowerCase())),
      moneyShare: moneyShare.map((m) => m.toLowerCase()),
    };
    this.corpses.set(creatureId, loot);
    return loot;
  }

  get(creatureId: number): CorpseLoot | undefined {
    return this.corpses.get(creatureId);
  }

  has(creatureId: number): boolean {
    return this.corpses.has(creatureId);
  }

  canLoot(creatureId: number, username: string): boolean {
    return this.corpses.get(creatureId)?.owners.has(username.toLowerCase()) ?? false;
  }

  /** Items still on the corpse. */
  remaining(creatureId: number): CorpseItem[] {
    const loot = this.corpses.get(creatureId);
    return loot ? loot.items.filter((i) => !loot.taken.has(i.index)) : [];
  }

  /** Take specific item indices (or all when null) plus any money. */
  take(creatureId: number, username: string, indices: number[] | null): LootTakeResult | null {
    const loot = this.corpses.get(creatureId);
    const looter = username.toLowerCase();
    if (!loot || !loot.owners.has(looter)) return null;

    const taken: CorpseItem[] = [];
    for (const item of loot.items) {
      if (loot.taken.has(item.index)) continue;
      if (indices && !indices.includes(item.index)) continue;
      loot.taken.add(item.index);
      taken.push(item);
    }
    const copper = splitCopper(loot.copper, loot.moneyShare, looter);
    loot.copper = 0;

    const empty = loot.items.every((i) => loot.taken.has(i.index));
    if (empty) this.corpses.delete(creatureId);
    return { taken, copper, empty };
  }

  remove(creatureId: number): void {
    this.corpses.delete(creatureId);
  }
}
