import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import log from "../modules/logger";
import { applyDotCredit, checkedCredit, CREDIT_THROTTLE_MS, DotCredit, type DotCreditBody } from "../cluster/dotcredit";

const dot = (over: any = {}) => ({
  id: "d1", spell: "Poison", icon: null, casterId: "11", casterUsername: "Caster", damagePerTick: 5, interval: 1, duration: 10,
  stackable: false, maxStacks: 1, stacks: 1, expiresAt: 0, nextTickAt: 0, particles: null, ...over,
});

// Control characters built from their codes, so the file holds none.
const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const ESC = String.fromCharCode(27);
const NUL = String.fromCharCode(0);

function credit(mirrors: Record<string, any> = {}) {
  const clock = { now: 1_000 };
  const sent: Array<{ to: string; body: DotCreditBody }> = [];
  const c = new DotCredit({
    now: () => clock.now,
    send: async (to, body) => { sent.push({ to, body }); return true; },
    mirror: (id) => mirrors[id] ?? null,
  });
  return { c, clock, sent };
}

test("ticks are sent at most every 2 s per caster and target; a kill always", () => {
  const { c, clock, sent } = credit();
  const target = { id: "7", username: "Victim" };
  c.credit(dot() as any, target, false);
  c.credit(dot() as any, target, false);
  // Guard: the throttle.
  expect(sent.length).toBe(1);
  // Guard: a kill bypasses the throttle.
  c.credit(dot() as any, target, true);
  expect(sent.map((s) => s.body.killed)).toEqual([false, true]);
  clock.now += CREDIT_THROTTLE_MS;
  c.credit(dot() as any, target, false);
  expect(sent.length).toBe(3);
  expect(sent[0]).toEqual({ to: "Caster", body: { victimId: "7", victimName: "Victim", killed: false } });
});

test("the throttle is per caster and target", () => {
  const { c, sent } = credit();
  c.credit(dot() as any, { id: "7", username: "A" }, false);
  c.credit(dot() as any, { id: "8", username: "B" }, false);
  c.credit(dot({ casterId: "12", casterUsername: "Other" }) as any, { id: "7", username: "A" }, false);
  expect(sent.length).toBe(3);
});

test("a send that fails is logged, with the caster's name free of control characters, and does not escape", async () => {
  const errors = spyOn(log, "error").mockImplementation((() => {}) as any);
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const c = new DotCredit({ now: () => 1, send: async () => { throw new Error("link down"); }, mirror: () => null });
    c.credit(dot({ casterUsername: `Ca${NL}ster${ESC}[0m` }) as any, { id: "7", username: "V" }, true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Guard: the catch. Without it the rejection is unhandled and nothing is logged.
    expect(unhandled).toEqual([]);
    expect(errors).toHaveBeenCalledTimes(1);
    const line = String((errors.mock.calls[0] as any[])[0]);
    expect(line).toContain("link down");
    // Guard: printable. A peer-chosen name must not break the log line.
    expect(line).toContain("Caster[0m");
    expect(line).not.toContain(NL);
    expect(line).not.toContain(ESC);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    errors.mockRestore();
  }
});

test("the throttle map is capped: a map full of fresh entries drops its oldest", () => {
  const { c, sent } = credit();
  for (let i = 0; i < 4_100; i++) c.credit(dot() as any, { id: String(i), username: "V" }, false);
  expect(sent.length).toBe(4_100);
  // The oldest entry was dropped, so it is sent again at once; the newest is still throttled.
  c.credit(dot() as any, { id: "0", username: "V" }, false);
  expect(sent.length).toBe(4_101);
  c.credit(dot() as any, { id: "4099", username: "V" }, false);
  expect(sent.length).toBe(4_101);
});

test("the killer is a remote stand-in from the caster's mirror, or a stub", () => {
  const mirror = { id: "11", username: "Caster", stats: { level: 9 }, wt: { send() {} }, mirrorFrom: "b" };
  const { c } = credit({ "11": mirror });
  const killer = c.killer(dot() as any);
  // Guard: remote and no wt. Without them handlePlayerDeath sends to or caches the stand-in.
  expect(killer).toMatchObject({ id: "11", username: "Caster", remote: true, stats: { level: 9 } });
  expect(killer.wt).toBeUndefined();
  expect(mirror.wt).toBeDefined();
  const stub = credit().c.killer(dot() as any);
  expect(stub).toEqual({ id: "11", username: "Caster", remote: true, wt: undefined, aoi: undefined });
});

test("the caster's node gives PvP state, and on a kill emits the death", () => {
  const caster = { id: "11", username: "Caster", last_attack: null as number | null };
  const pvp: any[] = [];
  const deaths: any[] = [];
  const deps = { setPvp: (p: any) => pvp.push(p), mirror: () => null, emitDeath: (victim: any, killer: any) => deaths.push({ victim, killer }) };
  expect(applyDotCredit(caster, { victimId: "7", victimName: "Victim", killed: false }, deps)).toBe(true);
  expect(pvp).toEqual([caster]);
  expect(caster.last_attack).not.toBeNull();
  expect(deaths).toEqual([]);
  expect(applyDotCredit(caster, { victimId: "7", victimName: "Victim", killed: true }, deps)).toBe(true);
  expect(deaths).toEqual([{ victim: { id: "7", username: "Victim", remote: true }, killer: caster }]);
});

test("a kill uses the victim's mirror when there is one", () => {
  const caster = { id: "11", username: "Caster" };
  const mirror = { id: "7", username: "Victim", remote: true, stats: { health: 0 } };
  const deaths: any[] = [];
  applyDotCredit(caster, { victimId: "7", victimName: "Forged", killed: true }, {
    setPvp: () => {}, mirror: (id) => (id === "7" ? mirror : null), emitDeath: (victim, killer) => deaths.push({ victim, killer }),
  });
  expect(deaths).toEqual([{ victim: mirror, killer: caster }]);
});

test("a credit for oneself, for a mirror, or malformed is refused", () => {
  const deps = { setPvp: () => { throw new Error("no"); }, mirror: () => null, emitDeath: () => { throw new Error("no"); } };
  // Guard: the self check.
  expect(applyDotCredit({ id: "7", username: "X" }, { victimId: "7", victimName: "X", killed: true }, deps)).toBe(false);
  // Guard: the remote check.
  expect(applyDotCredit({ id: "11", remote: true }, { victimId: "7", victimName: "V", killed: true }, deps)).toBe(false);
  // Guard: checkedCredit.
  expect(applyDotCredit({ id: "11" }, { victimId: 7, killed: "yes" }, deps)).toBe(false);
  expect(applyDotCredit({ id: "11" }, null, deps)).toBe(false);
  expect(applyDotCredit(null, { victimId: "7", victimName: "V", killed: true }, deps)).toBe(false);
  expect(checkedCredit({ victimId: "7", victimName: "V".repeat(200), killed: false })?.victimName.length).toBe(64);
  expect(checkedCredit({ victimId: "7".repeat(200), victimName: "V", killed: false })?.victimId.length).toBe(64);
  expect(checkedCredit({ victimId: "", victimName: "V", killed: false })).toBeNull();
  expect(checkedCredit("7")).toBeNull();
  // Guard: printable. Control characters from a peer never reach a log line.
  expect(checkedCredit({ victimId: "7", victimName: `A${CR}${NL}B${NUL}C`, killed: false })?.victimName).toBe("ABC");
  expect(checkedCredit({ victimId: NL, victimName: "V", killed: false })).toBeNull();
});

test("a kill of a player on this node is refused: a peer cannot name a local player as the victim", () => {
  const caster = { id: "11", username: "Caster" };
  const deps = {
    setPvp: () => { throw new Error("no"); }, mirror: () => null, emitDeath: () => { throw new Error("no"); },
    local: (id: string) => id === "7",
  };
  // Guard: the local-victim check.
  expect(applyDotCredit(caster, { victimId: "7", victimName: "V", killed: true }, deps)).toBe(false);
});

// dots.ts is read, not imported: importing it loads the AOI, packet and spell modules, which start timers and need the
// asset caches, so the tick cannot be run here. The shape of the hook is pinned instead.
test("dots.ts gives a tick of a caster on another node PvP state and a killer", () => {
  const source = readFileSync(join(import.meta.dir, "..", "systems", "dots.ts"), "utf8");
  // Guard: the remote branch. A caster that is not in playerCache and is not the target is a remote caster.
  expect(source).toContain("const remote = !caster && dot.casterId && dot.casterId !== String(target.id) ? remoteCaster : null;");
  expect(source).toMatch(/if \(remote\) \{\s*setPlayerPvp\(target, true\);\s*target\.last_attack = performance\.now\(\);/);
  expect(source).toContain("remote.credit(dot, target, target.stats.health <= 0);");
  expect(source).toContain("await playerDeathHandler(target, caster || remote?.killer(dot) || null, { damage, isCrit: false });");
  expect(source).toContain("export function setRemoteDotCaster(");
});
