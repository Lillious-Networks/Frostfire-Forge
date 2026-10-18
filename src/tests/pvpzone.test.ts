import { afterEach, describe, expect, test } from "bun:test";
import { areaCastRefusal, areaSpellHarms, pvpEnabled, targetedCastRefused } from "../systems/pvpzone";

const environmentPvp = process.env.PVP;
afterEach(() => {
  if (environmentPvp === undefined) delete process.env.PVP;
  else process.env.PVP = environmentPvp;
});

// A map whose southern half (y >= 500) is a no-PvP zone.
const allowed = async (position: { x: number; y: number }) => position.y < 500;
const field = { x: 100, y: 100 };
const town = { x: 100, y: 800 };

describe("casting a spell at a target", () => {
  test("a harmful one is allowed where PvP is", async () => {
    expect(await targetedCastRefused(true, field, { x: 140, y: 120 }, allowed)).toBe(false);
  });

  test("a harmful one is refused when the caster or the target stands in a no-PvP zone", async () => {
    expect(await targetedCastRefused(true, town, field, allowed)).toBe(true);
    expect(await targetedCastRefused(true, field, town, allowed)).toBe(true);
    expect(await targetedCastRefused(true, town, town, allowed)).toBe(true);
  });

  test("a beneficial one (a heal, a buff) is allowed in a no-PvP zone, on yourself or on another", async () => {
    expect(await targetedCastRefused(false, town, town, allowed)).toBe(false);
    expect(await targetedCastRefused(false, town, { x: 140, y: 820 }, allowed)).toBe(false);
    expect(await targetedCastRefused(false, field, town, allowed)).toBe(false);
    expect(await targetedCastRefused(false, town, field, allowed)).toBe(false);
  });
});

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

describe("PVP in the environment", () => {
  test("PvP is on when PVP is unset, true, or anything but false", () => {
    delete process.env.PVP;
    expect(pvpEnabled()).toBe(true);
    process.env.PVP = "true";
    expect(pvpEnabled()).toBe(true);
    process.env.PVP = "";
    expect(pvpEnabled()).toBe(true);
  });

  test("PvP is off when PVP is false, in any case", () => {
    process.env.PVP = "false";
    expect(pvpEnabled()).toBe(false);
    process.env.PVP = " FALSE ";
    expect(pvpEnabled()).toBe(false);
  });

  test("with PVP=false a harmful area spell harms no player, even where PvP zones allow it", async () => {
    process.env.PVP = "false";
    expect(await areaSpellHarms(field, { x: 140, y: 120 }, allowed)).toBe(false);
    expect(await areaSpellHarms(undefined, field, allowed)).toBe(false);
  });

  test("with PVP=false an area spell may still be cast (it harms creatures)", async () => {
    process.env.PVP = "false";
    expect(await areaCastRefusal(field, null, allowed)).toBe(null);
    expect(await areaCastRefusal(field, { x: 300, y: 200 }, allowed)).toBe(null);
  });
});
