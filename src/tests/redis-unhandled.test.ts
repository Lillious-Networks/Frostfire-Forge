import { describe, test, expect, spyOn, afterEach } from "bun:test";
import log from "../modules/logger";
import { deferredStep } from "../services/deferredstep";

// A Redis call that fails in a timer callback must be logged, not left as a rejection nobody handles (an unhandled
// rejection ended a game-server node during a short Redis outage).

const timeout = () => Object.assign(new Error("Connection timeout reached after 5000ms"), { code: "ERR_REDIS_CONNECTION_TIMEOUT" });

const escaped: unknown[] = [];
const onEscape = (reason: unknown) => escaped.push(reason);

afterEach(() => {
  process.off("unhandledRejection", onEscape);
  escaped.length = 0;
});

describe("deferredStep", () => {
  test("a rejected Redis call in a timer step is logged and does not escape", async () => {
    const errors = spyOn(log, "error").mockImplementation(() => {});
    process.on("unhandledRejection", onEscape);
    try {
      setTimeout(deferredStep("The spawn of alice", async () => { throw timeout(); }), 0);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(escaped).toEqual([]);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0]![0])).toContain("The spawn of alice could not be finished");
      expect(String(errors.mock.calls[0]![0])).toContain("Connection timeout reached");
    } finally {
      errors.mockRestore();
    }
  });

  test("a step that works runs once and logs nothing", async () => {
    const errors = spyOn(log, "error").mockImplementation(() => {});
    let ran = 0;
    try {
      deferredStep("a step", async () => { ran++; })();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(ran).toBe(1);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});

describe("a fire-and-forget cache write", () => {
  test("a rejected write with a catch is logged and does not escape", async () => {
    const errors = spyOn(log, "error").mockImplementation(() => {});
    process.on("unhandledRejection", onEscape);
    const cache = { add: async (_key: string, _value: unknown): Promise<void> => { throw timeout(); } };
    try {
      cache.add("maps", []).catch((error) => log.error(`The map data could not be written to the cache: ${error}`));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(escaped).toEqual([]);
      expect(errors).toHaveBeenCalledTimes(1);
    } finally {
      errors.mockRestore();
    }
  });
});

describe("a failing spawn step", () => {
  test("closes the player's connection after the log line, and does not escape", async () => {
    const errors = spyOn(log, "error").mockImplementation(() => {});
    process.on("unhandledRejection", onEscape);
    const closed: Array<[number, string]> = [];
    const wt = { close: (code: number, reason: string) => closed.push([code, reason]) };
    try {
      setTimeout(deferredStep("The spawn of alice", async () => { throw timeout(); }, () => wt.close(1011, "The spawn could not be finished")), 0);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(escaped).toEqual([]);
      expect(closed).toEqual([[1011, "The spawn could not be finished"]]);
      expect(errors).toHaveBeenCalledTimes(1);
    } finally {
      errors.mockRestore();
    }
  });

  test("a clean-up that throws is logged too", async () => {
    const errors = spyOn(log, "error").mockImplementation(() => {});
    process.on("unhandledRejection", onEscape);
    try {
      deferredStep("a step", async () => { throw timeout(); }, () => { throw new Error("closed already"); })();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(escaped).toEqual([]);
      expect(errors).toHaveBeenCalledTimes(2);
    } finally {
      errors.mockRestore();
    }
  });
});
