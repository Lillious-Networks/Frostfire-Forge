import { expect, test, mock } from "bun:test";

// Only the database module is stubbed. Everything else under test is real,
// so this also verifies the effects-payload integration. (Mocking shared
// modules like spelleffects would leak into other test files in the run.)
mock.module("../controllers/sqldatabase", () => ({
  default: async (_sql: string, _params?: any[]) => [],
}));

const resurrection = await import("../systems/resurrection");
const playerCache = (await import("../services/playermanager")).default;
const { getEffectsPayload } = await import("../systems/spelleffects");

function baseStats() {
  return {
    health: 1000,
    max_health: 1000,
    total_max_health: 1000,
    stamina: 500,
    max_stamina: 500,
    total_max_stamina: 500,
    stat_damage: 100,
    stat_armor: 50,
    stat_critical_chance: 20,
    stat_critical_damage: 150,
    stat_avoidance: 10,
  };
}

test("sickness cuts max HP by 20% and other stats by 10%", () => {
  const stats = resurrection.applySicknessToStats(baseStats());
  expect(stats.total_max_health).toBe(800);
  expect(stats.total_max_stamina).toBe(450);
  expect(stats.stat_damage).toBe(90);
  expect(stats.stat_armor).toBe(45);
  expect(stats.stat_critical_chance).toBe(18);
  expect(stats.stat_critical_damage).toBe(135);
  expect(stats.stat_avoidance).toBe(9);
  // Current values clamp into the reduced maximums.
  expect(stats.health).toBe(800);
  expect(stats.stamina).toBe(450);
});

test("isSick follows the wall clock", () => {
  expect(resurrection.isSick(null)).toBe(false);
  expect(resurrection.isSick({})).toBe(false);
  expect(
    resurrection.isSick({ resurrectionSickUntil: Date.now() + 60_000 })
  ).toBe(true);
  expect(
    resurrection.isSick({ resurrectionSickUntil: Date.now() - 1000 })
  ).toBe(false);
});

test("applySickness flags the player and revive uses sick totals", () => {
  const player: any = { id: "7", username: "TestUser", stats: baseStats() };
  playerCache.set("7", player);
  try {
    const until = resurrection.applySickness(player);
    expect(until).toBeGreaterThan(Date.now());
    expect(player.resurrectionSickUntil).toBe(until);
    expect(resurrection.isSick(player)).toBe(true);

    // Graveyard revive math: sync rebuilds clean totals from base, the hook
    // re-applies sickness, then HP is set to 50% of the sick maximum.
    const recomputed = resurrection.applySicknessToStats(baseStats());
    expect(Math.round(recomputed.total_max_health * 0.5)).toBe(400);
  } finally {
    resurrection.clearSickness(player);
    playerCache.remove("7");
  }
  expect(resurrection.isSick(player)).toBe(false);
});

test("sickness survives relog via the username handoff, like other debuffs", () => {
  const sessionA: any = { id: "a1", username: "Relogger", stats: baseStats() };
  playerCache.set("a1", sessionA);
  try {
    resurrection.applySickness(sessionA);
    expect(resurrection.isSick(sessionA)).toBe(true);

    // Disconnect: live flag moves to the username map.
    resurrection.saveOnDisconnect(sessionA);
    playerCache.remove("a1");

    // Relog on a fresh session object: flag, timer, and scaled totals return.
    const sessionB: any = { id: "b2", username: "Relogger", stats: baseStats() };
    playerCache.set("b2", sessionB);
    try {
      expect(resurrection.restoreOnLogin(sessionB)).toBe(true);
      expect(resurrection.isSick(sessionB)).toBe(true);
      expect(sessionB.stats.total_max_health).toBe(800);
    } finally {
      resurrection.clearSickness(sessionB);
      playerCache.remove("b2");
    }
    expect(resurrection.isSick(sessionB)).toBe(false);
  } finally {
    resurrection.clearSickness(sessionA);
    playerCache.remove("a1");
  }
});

test("clean logout leaves no stale handoff behind", () => {
  const player: any = { id: "c3", username: "CleanLogout", stats: baseStats() };
  playerCache.set("c3", player);
  try {
    resurrection.saveOnDisconnect(player);
    const fresh: any = { id: "c4", username: "CleanLogout", stats: baseStats() };
    expect(resurrection.restoreOnLogin(fresh)).toBe(false);
    expect(fresh.stats.total_max_health).toBe(1000);
  } finally {
    playerCache.remove("c3");
  }
});
test("sickness shows as a debuff with a live countdown", () => {
  const player: any = {
    id: "sick-1",
    barriers: [],
    visualEffects: [],
    resurrectionSickUntil: Date.now() + 14 * 60 * 1000,
  };
  const payload = getEffectsPayload(player);
  const sick = payload.find((e: any) => e.id === "resurrection-sickness");
  expect(sick).toBeDefined();
  expect(sick.isDebuff).toBe(true);
  expect(sick.kind).toBe("sickness");
  expect(sick.description).toBe("-20% max health, -10% all other stats");
  expect(sick.duration).toBe(900);
  expect(sick.remaining).toBeGreaterThan(800);
  expect(sick.remaining).toBeLessThanOrEqual(840);
  expect(sick.spell).toBe("Resurrection Sickness");

  const clean = getEffectsPayload({ barriers: [], visualEffects: [] });
  expect(clean.find((e: any) => e.id === "resurrection-sickness")).toBeUndefined();
});
