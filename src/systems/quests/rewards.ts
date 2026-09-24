import query from "../../controllers/sqldatabase";
import assetCache from "../../services/assetCache";
import log from "../../modules/logger";
import inventory from "../inventory";
import currency from "../currency";
import playerSystem from "../player";

export interface XpResult {
  xp: number;
  level: number;
  max_xp: number;
}

export interface GrantedRewards {
  ok: boolean;
  items?: Array<{ name: string; quantity: number }>;
  xpResult?: XpResult | null;
  error?: string;
  code?: string;
}

const BASE_INVENTORY_SLOTS = 25;

export function choiceSet(quest: Quest): QuestReward[] {
  return (quest.rewards || []).filter((r) => r.is_choice).sort((a, b) => a.sort_order - b.sort_order);
}

export function guaranteedRewards(quest: Quest): QuestReward[] {
  return (quest.rewards || []).filter((r) => !r.is_choice).sort((a, b) => a.sort_order - b.sort_order);
}

/** If the quest has a choice set, the index must pick exactly one of it. */
export function validateChoice(quest: Quest, rewardChoiceIndex?: number): boolean {
  const choices = choiceSet(quest);
  if (choices.length === 0) return true;
  return (
    typeof rewardChoiceIndex === "number" &&
    Number.isInteger(rewardChoiceIndex) &&
    rewardChoiceIndex >= 0 &&
    rewardChoiceIndex < choices.length
  );
}

async function getMaxSlots(username: string): Promise<number> {
  let slots = BASE_INVENTORY_SLOTS;
  try {
    const bagRows = (await query("SELECT * FROM bags WHERE username = ?", [username.toLowerCase()])) as any[];
    const bagRow = bagRows?.[0];
    if (bagRow) {
      const items = ((await assetCache.get("items")) || []) as Item[];
      for (const slot of ["slot_1", "slot_2", "slot_3", "slot_4"]) {
        const itemName = bagRow[slot];
        if (itemName) {
          const item = Array.isArray(items) ? items.find((i: any) => i.name === itemName) : null;
          slots += item?.bag_slots != null ? Number(item.bag_slots) : 10;
        }
      }
    }
  } catch {
    // Default slots on error.
  }
  return slots;
}

async function hasBagSpace(username: string, rewards: QuestReward[]): Promise<boolean> {
  if (rewards.length === 0) return true;
  try {
    const rows = (await query("SELECT item FROM inventory WHERE username = ?", [username.toLowerCase()])) as any[];
    const owned = new Set((rows || []).map((r: any) => String(r.item ?? r.name ?? "").toLowerCase()));
    const needed = new Set<string>();
    for (const r of rewards) {
      if (!owned.has(String(r.item_name).toLowerCase())) needed.add(String(r.item_name).toLowerCase());
    }
    if (needed.size === 0) return true;
    const maxSlots = await getMaxSlots(username);
    return owned.size + needed.size <= maxSlots;
  } catch {
    return true;
  }
}

export async function grant(
  username: string,
  quest: Quest,
  rewardChoiceIndex?: number
): Promise<GrantedRewards> {
  const uname = username.toLowerCase();
  const choices = choiceSet(quest);
  const guaranteed = guaranteedRewards(quest);
  const picked = choices.length > 0 ? choices[rewardChoiceIndex as number] : undefined;
  const itemRewards = [...guaranteed, ...(picked ? [picked] : [])];

  // Validate every reward item resolves before mutating anything.
  try {
    const items = ((await assetCache.get("items")) || []) as Item[];
    const names = new Set((items || []).map((i) => String(i.name).toLowerCase()));
    for (const r of itemRewards) {
      if (!names.has(String(r.item_name).toLowerCase())) {
        return { ok: false, error: `Reward item "${r.item_name}" does not exist.`, code: "bad_item" };
      }
      if ((Number(r.quantity) || 0) < 1) {
        return { ok: false, error: "Reward quantity is invalid.", code: "bad_quantity" };
      }
    }
  } catch (error) {
    log.error(`Quest reward item validation failed for ${uname} quest ${quest.id}: ${error}`);
    return { ok: false, error: "Could not validate rewards.", code: "db_error" };
  }

  // Bag-space precheck before mutating anything: a half-granted reward is the
  // worst possible failure here.
  if (!(await hasBagSpace(username, itemRewards))) {
    return { ok: false, error: "You don't have enough bag space.", code: "bag_full" };
  }

  const granted: Array<{ name: string; quantity: number }> = [];
  let xpResult: XpResult | null = null;
  try {
    for (const r of itemRewards) {
      await inventory.add(uname, { name: r.item_name, quantity: r.quantity } as any);
      granted.push({ name: r.item_name, quantity: r.quantity });
    }
    if (quest.xp_reward > 0) {
      // Kept (not discarded): the caller merges these into the cached stats.
      // synchronizeStats rebuilds from the stale in-memory copy and would
      // otherwise wipe the fresh xp/level on the very next sync.
      const result = (await playerSystem.increaseXp(uname, quest.xp_reward)) as any;
      if (result && !Array.isArray(result)) {
        xpResult = { xp: result.xp, level: result.level, max_xp: result.max_xp };
      }
    }
    if (quest.copper_reward > 0) {
      await currency.add(uname, { copper: quest.copper_reward, silver: 0, gold: 0 });
    }
  } catch (error) {
    log.error(`Quest reward grant failed for ${uname} quest ${quest.id}: ${error}`);
    return { ok: false, error: "Could not grant rewards.", code: "db_error" };
  }
  return { ok: true, items: granted, xpResult };
}

const questRewards = {
  grant,
  validateChoice,
  choiceSet,
  guaranteedRewards,
};

export default questRewards;
