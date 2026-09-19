import { describe, expect, test } from "bun:test";
import { castTimeCoefficient, levelRoll, periodicBonusPerTick, rollHeal, spellManaCost, withPeriodicBonus, HEAL_CRIT_MULTIPLIER } from "../systems/spellmath";

/** An rng that returns the given values in order, then repeats the last. */
const seq = (...values: number[]) => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
};

describe("level roll", () => {
  test("base plus 2-5 per level past 1", () => {
    expect(levelRoll(20, 10, () => 0)).toBe(20 + 18);
    expect(levelRoll(20, 10, () => 0.9999)).toBe(20 + 45);
    expect(levelRoll(20, 1, () => 0.5)).toBe(20);
  });

  test("uses the magnitude of negative (heal) values", () => {
    expect(levelRoll(-20, 10, () => 0)).toBe(38);
  });
});

describe("cast time coefficient (classic WoW)", () => {
  test("cast time over 3.5s, instants count as the 1.5s GCD, capped at 1", () => {
    expect(castTimeCoefficient(3.5)).toBe(1);
    expect(castTimeCoefficient(5)).toBe(1);
    expect(castTimeCoefficient(2.5)).toBeCloseTo(2.5 / 3.5);
    expect(castTimeCoefficient(0)).toBeCloseTo(1.5 / 3.5);
    expect(castTimeCoefficient(1)).toBeCloseTo(1.5 / 3.5);
  });
});

describe("heals", () => {
  test("level roll plus the cast-time share of the damage stat", () => {
    // roll 0 -> 38 at level 10; crit roll 0.99 -> no crit; 3.5s cast gets all 35 bonus.
    const heal = rollHeal(-20, { level: 10, stat_damage: 35, stat_critical_chance: 5 }, 3.5, seq(0, 0.99));
    expect(heal).toEqual({ amount: 38 + 35, isCrit: false });
  });

  test("instant heals get the GCD share of the bonus", () => {
    const heal = rollHeal(-20, { level: 1, stat_damage: 35 }, 0, seq(0, 0.99));
    expect(heal.amount).toBe(Math.floor(20 + 35 * (1.5 / 3.5)));
  });

  test("crits restore 150%", () => {
    const heal = rollHeal(-20, { level: 1, stat_damage: 0, stat_critical_chance: 50 }, 2, seq(0, 0.1));
    expect(heal).toEqual({ amount: Math.floor(20 * HEAL_CRIT_MULTIPLIER), isCrit: true });
  });

  test("never negative, even with a negative stat", () => {
    expect(rollHeal(0, { level: 1, stat_damage: -50 }, 2, () => 0.5).amount).toBe(0);
  });
});

describe("damage and heal over time (classic WoW)", () => {
  test("stat x duration/15s, split across the ticks", () => {
    // 15s, ticking every 3s: 5 ticks share all 50 -> 10 per tick.
    expect(periodicBonusPerTick(50, 15, 3)).toBe(10);
    // 6s, every 2s: 3 ticks share 6/15 of 60 = 24 -> 8 per tick.
    expect(periodicBonusPerTick(60, 6, 2)).toBe(8);
    // Longer than 15s still caps at the whole stat: 30s / 3s = 10 ticks share 50.
    expect(periodicBonusPerTick(50, 30, 3)).toBe(5);
  });

  test("no bonus without a stat, a duration or an interval", () => {
    expect(periodicBonusPerTick(0, 15, 3)).toBe(0);
    expect(periodicBonusPerTick(-20, 15, 3)).toBe(0);
    expect(periodicBonusPerTick(50, 0, 3)).toBe(0);
    expect(periodicBonusPerTick(50, 15, 0)).toBe(0);
  });

  test("folds the bonus into DoT and HoT values, keeping the sign", () => {
    const dot = { type: "damage_over_time", value: 4, duration: 15, interval: 3 };
    expect(withPeriodicBonus(dot, 50)).toEqual({ ...dot, value: 14 });
    const hot = { type: "heal_over_time", value: -5, duration: 15, interval: 3 };
    expect(withPeriodicBonus(hot, 50)).toEqual({ ...hot, value: -15 });
  });

  test("leaves other effects, zero-value effects and no-stat casters alone", () => {
    const stun = { type: "stun", value: 0, duration: 3 };
    expect(withPeriodicBonus(stun, 50)).toBe(stun);
    const empty = { type: "damage_over_time", value: 0, duration: 15, interval: 3 };
    expect(withPeriodicBonus(empty, 50)).toBe(empty);
    const dot = { type: "damage_over_time", value: 4, duration: 15, interval: 3 };
    expect(withPeriodicBonus(dot, 0)).toBe(dot);
  });
});

describe("mana cost", () => {
  test("percentage of base stamina, not the gear-boosted total", () => {
    expect(spellManaCost(10, { max_stamina: 200, total_max_stamina: 500 })).toBe(20);
  });

  test("falls back to the total when no base is known, and ignores bad input", () => {
    expect(spellManaCost(10, { total_max_stamina: 300 })).toBe(30);
    expect(spellManaCost(-5, { max_stamina: 200 })).toBe(0);
    expect(spellManaCost(10, undefined)).toBe(0);
  });
});
