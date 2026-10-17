import { describe, expect, spyOn, test } from "bun:test";
import { ClaimWindow, CLAIM_WINDOW_MS } from "../systems/gathering/claims";
const { default: log } = await import("../modules/logger");

/** A clock the test runs by hand: what was put off, and for how long. */
function manual() {
  const waiting: Array<{ run: () => void; ms: number }> = [];
  return { waiting, later: (run: () => void, ms: number) => void waiting.push({ run, ms }), runAll: () => { for (const w of waiting.splice(0)) w.run(); } };
}

describe("ClaimWindow", () => {
  test("one claim alone wins once the window closes", async () => {
    const clock = manual();
    const awarded: string[] = [];
    const claims = new ClaimWindow({ award: (_id, who) => (awarded.push(who), true), later: clock.later });
    const alice = claims.claim(7, "alice");
    expect(clock.waiting[0]!.ms).toBe(CLAIM_WINDOW_MS);
    expect(claims.isOpen(7)).toBe(true);
    clock.runAll();
    expect(awarded).toEqual(["alice"]);
    expect(claims.isOpen(7)).toBe(false);
    expect(await alice).toBe(true);
  });

  test("a second claim by the same player loses at once", async () => {
    const clock = manual();
    const awarded: string[] = [];
    const claims = new ClaimWindow({ award: (_id, who) => (awarded.push(who), true), later: clock.later });
    const first = claims.claim(7, "alice");
    const again = claims.claim(7, "alice");
    expect(await again).toBe(false);
    expect(clock.waiting.length).toBe(1);
    clock.runAll();
    expect(await first).toBe(true);
    expect(awarded).toEqual(["alice"]);
  });

  test("a throwing award answers everyone false", async () => {
    const clock = manual();
    const errors = spyOn(log, "error").mockImplementation(() => {});
    const claims = new ClaimWindow({ award: () => { throw new Error("node vanished"); }, later: clock.later });
    const alice = claims.claim(7, "alice");
    const bob = claims.claim(7, "bob");
    clock.runAll();
    expect([await alice, await bob]).toEqual([false, false]);
    expect(claims.isOpen(7)).toBe(false);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0]![0]).toContain("node vanished");
    errors.mockRestore();
  });

  test("a throwing timer rejects the claim and leaves the node free", async () => {
    const clock = manual();
    let timerDown = true;
    const claims = new ClaimWindow({
      award: () => true,
      later: (run, ms) => {
        if (timerDown) throw new Error("no timer");
        clock.later(run, ms);
      },
    });
    await expect(claims.claim(7, "alice")).rejects.toThrow("no timer");
    expect(claims.isOpen(7)).toBe(false);
    timerDown = false;
    const bob = claims.claim(7, "bob");
    clock.runAll();
    expect(await bob).toBe(true);
  });

  test("two claims in one window: exactly one wins, picked at random", async () => {
    for (const [roll, expected] of [[0, "alice"], [0.99, "bob"]] as const) {
      const clock = manual();
      const awarded: string[] = [];
      const claims = new ClaimWindow({ award: (_id, who) => (awarded.push(who), true), later: clock.later, r: () => roll });
      const alice = claims.claim(7, "alice");
      const bob = claims.claim(7, "bob");
      expect(clock.waiting.length).toBe(1);
      clock.runAll();
      const results = { alice: await alice, bob: await bob };
      expect(awarded).toEqual([expected]);
      expect(results[expected]).toBe(true);
      expect(Object.values(results).filter(Boolean).length).toBe(1);
    }
  });

  test("everyone loses when the node was already gone", async () => {
    const clock = manual();
    const claims = new ClaimWindow({ award: () => false, later: clock.later });
    const alice = claims.claim(7, "alice");
    const bob = claims.claim(7, "bob");
    clock.runAll();
    expect([await alice, await bob]).toEqual([false, false]);
  });

  test("an ineligible claimant is never drawn", async () => {
    const clock = manual();
    const awarded: string[] = [];
    const claims = new ClaimWindow({
      award: (_id, who) => (awarded.push(who), true),
      eligible: (_id, who) => who !== "bob",
      later: clock.later,
      r: () => 0.99,
    });
    const alice = claims.claim(7, "alice");
    const bob = claims.claim(7, "bob");
    clock.runAll();
    expect([await alice, await bob]).toEqual([true, false]);
    expect(awarded).toEqual(["alice"]);
  });

  test("no eligible claimant: award is not called, everyone loses", async () => {
    const clock = manual();
    const awarded: string[] = [];
    const claims = new ClaimWindow({ award: (_id, who) => (awarded.push(who), true), eligible: () => false, later: clock.later });
    const alice = claims.claim(7, "alice");
    const bob = claims.claim(7, "bob");
    clock.runAll();
    expect([await alice, await bob]).toEqual([false, false]);
    expect(awarded).toEqual([]);
    expect(claims.isOpen(7)).toBe(false);
  });

  test("an eligibility check that throws counts as ineligible and is logged", async () => {
    const clock = manual();
    const errors = spyOn(log, "error").mockImplementation(() => {});
    try {
      const awarded: string[] = [];
      const claims = new ClaimWindow({
        award: (_id, who) => (awarded.push(who), true),
        eligible: (_id, who) => { if (who === "bob") throw new Error("gone"); return true; },
        later: clock.later,
        r: () => 0.99,
      });
      const alice = claims.claim(7, "alice");
      const bob = claims.claim(7, "bob");
      clock.runAll();
      expect([await alice, await bob]).toEqual([true, false]);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(errors.mock.calls[0]![0]).toContain("gone");
    } finally {
      errors.mockRestore();
    }
  });

  test("each node has its own window", async () => {
    const clock = manual();
    const claims = new ClaimWindow({ award: () => true, later: clock.later });
    const a = claims.claim(1, "alice");
    const b = claims.claim(2, "bob");
    expect(clock.waiting.length).toBe(2);
    clock.runAll();
    expect([await a, await b]).toEqual([true, true]);
  });
});
