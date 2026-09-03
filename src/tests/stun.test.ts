import { expect, test, describe } from "bun:test";
import { isStunned } from "../systems/spelleffects";

describe("isStunned", () => {
  test("false when stunnedUntil is unset or zero", () => {
    expect(isStunned({}, 1000)).toBe(false);
    expect(isStunned({ stunnedUntil: 0 }, 1000)).toBe(false);
    expect(isStunned(null as any, 1000)).toBe(false);
  });

  test("true while the stun timestamp is in the future", () => {
    expect(isStunned({ stunnedUntil: 2000 }, 1000)).toBe(true);
  });

  test("false once the stun timestamp has passed", () => {
    expect(isStunned({ stunnedUntil: 1000 }, 1000)).toBe(false);
    expect(isStunned({ stunnedUntil: 999 }, 1000)).toBe(false);
  });

  test("compares against an epoch clock, not performance.now()", () => {
    // stunnedUntil is written as Date.now() + duration. A 5s stun applied now
    // must read as active when checked against Date.now(), and inactive after.
    const now = Date.now();
    const player = { stunnedUntil: now + 5000 };
    expect(isStunned(player, now)).toBe(true);
    expect(isStunned(player, now + 5001)).toBe(false);
  });
});
