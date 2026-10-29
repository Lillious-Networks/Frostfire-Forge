import { expect, mock, test } from "bun:test";
import { deedsOf } from "../systems/achievements/criteria";
import { Events, listener, setPlayerPvp } from "../systems/events";
import { databaseModule, mockQuery } from "./setup";

// The edits that keep a mirror (a player of a neighbouring node) from being written or counted twice.
// player.ts reaches the database through many modules; canAttack reads none of it.
mock.module("../controllers/sqldatabase", () => databaseModule({ default: mockQuery }));
const { default: playerSystem } = await import("../systems/player");

const alice = { id: "p1", username: "Alice" };
const bob = { id: "p2", username: "bob" };

test("a death across a border is counted once on each node: the victim's node the death, the killer's node the kill", () => {
  // The victim's node: the killer is the stand-in for a player of another node.
  expect(deedsOf(Events.PLAYER_DEATH, { player: alice, killer: { ...bob, remote: true } })).toEqual([
    { username: "Alice", type: "death", target: null, amount: 1 },
  ]);
  // The killer's node: the victim is the mirror.
  expect(deedsOf(Events.PLAYER_DEATH, { player: { ...alice, remote: true }, killer: bob })).toEqual([
    { username: "bob", type: "pvp_kill", target: null, amount: 1 },
  ]);
  // Both local, as before.
  expect(deedsOf(Events.PLAYER_DEATH, { player: alice, killer: bob })).toHaveLength(2);
});

test("setPlayerPvp leaves a mirror alone: no flag, no event", () => {
  const heard: any[] = [];
  const onEnter = (event: any) => heard.push(event);
  listener.on(Events.PLAYER_ENTERED_PVP, onEnter);
  try {
    const mirror: any = { id: "m1", username: "Mirror", remote: true };
    setPlayerPvp(mirror, true);
    expect(mirror.pvp).toBeUndefined();
    expect(heard).toEqual([]);
    const local: any = { id: "l1", username: "Local" };
    setPlayerPvp(local, true);
    expect(local.pvp).toBe(true);
    expect(heard).toHaveLength(1);
  } finally {
    listener.off(Events.PLAYER_ENTERED_PVP, onEnter);
  }
});

test("canAttack reads the same map whether its name ends in .json or not", async () => {
  const self: any = { id: "a", username: "A", stats: { health: 10 }, location: { map: "forest.json", position: { x: 0, y: 0, direction: "up" } } };
  const target: any = { id: "b", username: "B", stats: { health: 10 }, location: { map: "forest", position: { x: 50, y: 0 } } };
  // Facing up with the target to the right: past the map check it fails on direction.
  expect((await playerSystem.canAttack(self, target, { width: 24, height: 40 }, 300, true)).reason).toBe("direction");
  target.location.map = "cave";
  expect((await playerSystem.canAttack(self, target, { width: 24, height: 40 }, 300, true)).reason).toBe("different_map");
});
