import { describe, expect, test } from "bun:test";
import { pickPlayerAt } from "../systems/playerpick";

const at = (id: string, x: number, y: number) => ({ id, location: { position: { x, y } } });
const pick = (players: ReturnType<typeof at>[], x: number, y: number, range = 35, viewer = "me") =>
  pickPlayerAt(players, x, y, range, viewer)?.id ?? null;

describe("picking a player with a click", () => {
  test("of two overlapping players, the one further south is picked, whichever comes first", () => {
    const north = at("north", 100, 100);
    const south = at("south", 104, 110);
    // The click is on both bodies and nearer the northern player's anchor.
    expect(pick([north, south], 101, 102)).toBe("south");
    expect(pick([south, north], 101, 102)).toBe("south");
  });

  test("a click on the head that shows above the player in front picks the one behind", () => {
    const north = at("north", 100, 100);
    const south = at("south", 100, 112);
    // y 84 is inside the northern body (82..121) and above the southern one (94..133).
    expect(pick([north, south], 100, 84)).toBe("north");
  });

  test("players standing side by side are picked by the body clicked, not by who is further south", () => {
    const left = at("left", 100, 100);
    const right = at("right", 130, 104);
    expect(pick([left, right], 100, 100)).toBe("left");
    expect(pick([left, right], 130, 100)).toBe("right");
  });

  test("on the very same line the viewer's own player is on top, else the nearer one", () => {
    const me = at("me", 100, 100);
    const other = at("other", 104, 100);
    const third = at("third", 96, 100);
    expect(pick([other, me], 103, 100)).toBe("me");
    expect(pick([me, other], 103, 100)).toBe("me");
    expect(pick([third, other], 103, 100)).toBe("other");
    expect(pick([other, third], 97, 100)).toBe("third");
  });

  test("the viewer's own player is covered by one standing further south", () => {
    expect(pick([at("me", 100, 100), at("other", 100, 103)], 100, 100)).toBe("other");
  });

  test("a click that misses every body picks the nearest player in range", () => {
    const a = at("a", 100, 100);
    const b = at("b", 150, 100);
    expect(pick([a, b], 122, 130)).toBe("a");
    expect(pick([a, b], 130, 130)).toBe("b");
  });

  test("nobody in range gives nothing, and a touch reaches further than a cursor", () => {
    const a = at("a", 100, 100);
    expect(pick([a], 140, 100)).toBe(null);
    expect(pick([a], 140, 100, 49)).toBe("a");
    expect(pick([], 100, 100)).toBe(null);
  });
});
