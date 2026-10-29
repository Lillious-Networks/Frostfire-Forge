import { expect, spyOn, test } from "bun:test";
import { revivePlayer, type ReviveDeps } from "../socket/revive";
import log from "../modules/logger";

function fakeDeps(over: Partial<ReviveDeps> = {}) {
  const steps: string[] = [];
  const deps: ReviveDeps = {
    clearSickness: () => { steps.push("sickness"); },
    synchronizeStats: async () => { steps.push("sync"); return { health: 1, stamina: 1, total_max_health: 120, total_max_stamina: 80 }; },
    setDeadState: async (name) => { steps.push(`dead-state:${name}`); },
    keep: () => { steps.push("keep"); },
    bumpStateRevision: () => { steps.push("revision"); },
    viewersOn: (map) => { steps.push(`viewers:${map}`); return [{ name: "v1" }, { name: "v2" }]; },
    send: (viewer, packets) => { steps.push(`send:${viewer.name}:${packets[0]}`); },
    ghostPacket: () => ["ghost"],
    revivePacket: () => ["revive"],
    broadcastEffects: () => { steps.push("effects"); },
    sendPartyStats: () => { steps.push("party"); },
    revived: () => { steps.push("revived"); },
    ...over,
  };
  return { deps, steps };
}

const deadHero = () => ({
  id: "7", username: "hero", isDead: true, isGhost: true, corpse: { map: "main", x: 1, y: 2 },
  reviveOffered: true, ghostTeleportPending: true, location: { map: "main.json" }, stats: { health: 0, stamina: 0 },
});

test("a dead player is revived in place at full health, and the map is told", async () => {
  const { deps, steps } = fakeDeps();
  const hero = deadHero();
  expect(await revivePlayer(hero, deps)).toBe("revived");
  expect(hero.isDead).toBe(false);
  expect(hero.isGhost).toBe(false);
  expect(hero.corpse).toBeNull();
  expect(hero.reviveOffered).toBe(false);
  expect(hero.ghostTeleportPending).toBe(false);
  expect(hero.stats.health).toBe(120);
  expect(hero.stats.stamina).toBe(80);
  expect(steps).toEqual([
    "sickness", "sync", "keep", "dead-state:hero", "revision", "viewers:main.json",
    "send:v1:ghost", "send:v1:revive", "send:v2:ghost", "send:v2:revive",
    "effects", "party", "revived",
  ]);
});

test("the caller's note runs after the party is told and before PLAYER_REVIVED", async () => {
  const { deps, steps } = fakeDeps();
  expect(await revivePlayer(deadHero(), deps, () => { steps.push("note"); })).toBe("revived");
  expect(steps.slice(-3)).toEqual(["party", "note", "revived"]);
});

test("a player who is neither dead nor a ghost is left alone", async () => {
  const { deps, steps } = fakeDeps();
  const hero = { ...deadHero(), isDead: false, isGhost: false };
  expect(await revivePlayer(hero, deps, () => { steps.push("note"); })).toBe("not-dead");
  expect(steps).toEqual([]);
});

test("a dead player who is not yet a ghost, and a ghost who is not dead, are each revived", async () => {
  for (const flags of [{ isDead: true, isGhost: false }, { isDead: false, isGhost: true }]) {
    const { deps, steps } = fakeDeps();
    const hero = { ...deadHero(), ...flags };
    expect(await revivePlayer(hero, deps)).toBe("revived");
    expect(hero.isDead).toBe(false);
    expect(hero.isGhost).toBe(false);
    expect(steps.at(-1)).toBe("revived");
  }
});

test("a failed death-state write is logged and the revive goes on", async () => {
  const errors: string[] = [];
  const spy = spyOn(log, "error").mockImplementation((message: string) => { errors.push(String(message)); });
  try {
    const { deps, steps } = fakeDeps({ setDeadState: async () => { throw new Error("db down"); } });
    expect(await revivePlayer(deadHero(), deps)).toBe("revived");
    expect(errors).toEqual(["Failed to clear death state for hero: db down"]);
    expect(steps.at(-1)).toBe("revived");
  } finally {
    spy.mockRestore();
  }
});

test("stats that could not be synchronized keep the player's own, filled to the totals", async () => {
  const { deps } = fakeDeps({ synchronizeStats: async () => null });
  const hero = { ...deadHero(), stats: { health: 0, stamina: 0, total_max_health: 50, total_max_stamina: 40 } };
  await revivePlayer(hero, deps);
  expect(hero.stats).toEqual({ health: 50, stamina: 40, total_max_health: 50, total_max_stamina: 40 });
});

test("the REVIVE command and the cells-revive action both call revivePlayer", async () => {
  const commands = await Bun.file(new URL("../socket/handlers/commands.ts", import.meta.url)).text();
  const start = commands.indexOf('case "REVIVE": {');
  expect(start).toBeGreaterThan(0);
  const revive = commands.slice(start, commands.indexOf("\n          case ", start + 10));
  expect(revive).toContain("revivePlayer(onlineTarget, reviveDeps()");
  expect(revive).not.toContain("bumpStateRevision()");
  expect(revive).not.toContain("player.setDeadState(");
  // The admin's "Revived" note is the callback, so it goes out before PLAYER_REVIVED; "is not dead" follows the call.
  const callStart = revive.indexOf("revivePlayer(onlineTarget, reviveDeps(), () => {");
  expect(callStart).toBeGreaterThan(0);
  const callbackEnd = revive.indexOf("\n            });", callStart);
  expect(callbackEnd).toBeGreaterThan(callStart);
  expect(revive.slice(callStart, callbackEnd).split("() => {")[1]!.trim())
    .toBe("sendPacket(wt, packetManager.notify({ message: `Revived ${shownTarget}` }));");
  expect(revive.slice(callbackEnd)).not.toContain("Revived ${");
  expect(revive.slice(callbackEnd)).toContain("sendPacket(wt, packetManager.notify({ message: `${shownTarget} is not dead` }));");
  const receiver = await Bun.file(new URL("../socket/receiver.ts", import.meta.url)).text();
  const actionStart = receiver.indexOf('registerPlayerAction("cells-revive"');
  expect(actionStart).toBeGreaterThan(0);
  const action = receiver.slice(actionStart, receiver.indexOf("\n})));\n", actionStart));
  expect(action).toContain("revivePlayer(target, reviveDeps()");
  expect(action).toContain("remoteAdminOf(args)");
  expect(action).toContain("shownName(target.username)");
  expect(action).not.toContain("shownCap");
  expect(action).not.toContain("bumpStateRevision()");
  const depsStart = receiver.indexOf("export function reviveDeps(): ReviveDeps {");
  expect(depsStart).toBeGreaterThan(0);
  const body = receiver.slice(depsStart, receiver.indexOf("\n}\n", depsStart));
  expect(body).toContain("player.setDeadState(username, 0, null)");
  expect(body).toContain("filterPlayersByMap(map)");
  expect(body).toContain("listener.emit(Events.PLAYER_REVIVED, { player: target })");
});
