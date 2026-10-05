import { describe, expect, test } from "bun:test";
import { areaCastRefusal, areaSpellHarms } from "../systems/pvpzone";

// A map whose southern half (y >= 500) is a no-PvP zone.
const allowed = async (position: { x: number; y: number }) => position.y < 500;
const field = { x: 100, y: 100 };
const town = { x: 100, y: 800 };

describe("casting a harmful spell that has no target", () => {
  test("is allowed where PvP is", async () => {
    expect(await areaCastRefusal(field, null, allowed)).toBe(null);
    expect(await areaCastRefusal(field, { x: 300, y: 200 }, allowed)).toBe(null);
  });

  test("is refused when the caster stands in a no-PvP zone", async () => {
    expect(await areaCastRefusal(town, null, allowed)).toBe("caster");
    // ... wherever a ground spell is aimed
    expect(await areaCastRefusal(town, field, allowed)).toBe("caster");
  });

  test("is refused when a ground spell is placed in a no-PvP zone from outside", async () => {
    expect(await areaCastRefusal(field, town, allowed)).toBe("aim");
  });
});

describe("who a harmful area spell harms", () => {
  test("a player standing where PvP is allowed", async () => {
    expect(await areaSpellHarms(field, { x: 140, y: 120 }, allowed)).toBe(true);
  });

  test("not a player standing in a no-PvP zone, though the spell reaches them from outside", async () => {
    expect(await areaSpellHarms({ x: 100, y: 480 }, { x: 100, y: 520 }, allowed)).toBe(false);
  });

  test("nobody when the caster stands in a no-PvP zone (walked in during the cast, or after leaving a zone behind)", async () => {
    expect(await areaSpellHarms({ x: 100, y: 520 }, { x: 100, y: 480 }, allowed)).toBe(false);
  });

  test("a lingering zone whose caster has left the game asks for the victim alone", async () => {
    expect(await areaSpellHarms(undefined, field, allowed)).toBe(true);
    expect(await areaSpellHarms(undefined, town, allowed)).toBe(false);
  });
});
