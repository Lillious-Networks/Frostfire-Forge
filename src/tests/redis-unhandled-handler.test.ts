import { describe, test, expect, spyOn } from "bun:test";
import log from "../modules/logger";
import { onUnhandledRejection, isRedisError } from "../services/unhandled";

const redisError = () => Object.assign(new Error("Connection timeout reached after 5000ms"), { code: "ERR_REDIS_CONNECTION_TIMEOUT" });

describe("onUnhandledRejection", () => {
  test("a Redis error is logged with its stack and the node keeps running", () => {
    const errors = spyOn(log, "error").mockImplementation(() => {});
    const exits: number[] = [];
    try {
      onUnhandledRejection(redisError(), (code) => exits.push(code));
      expect(exits).toEqual([]);
      expect(errors).toHaveBeenCalledTimes(1);
      const line = String(errors.mock.calls[0]![0]);
      expect(line).toContain("keeps running");
      expect(line).toContain("Connection timeout reached");
      expect(line).toContain("at ");
    } finally {
      errors.mockRestore();
    }
  });

  test("any other reason is logged and exits with code 1", () => {
    const errors = spyOn(log, "error").mockImplementation(() => {});
    const exits: number[] = [];
    try {
      onUnhandledRejection(new TypeError("boom"), (code) => exits.push(code));
      onUnhandledRejection("text", (code) => exits.push(code));
      onUnhandledRejection(Object.assign(new Error("x"), { code: "ECONNRESET" }), (code) => exits.push(code));
      onUnhandledRejection(Object.assign(new Error("y"), { code: "ERR_INVALID_ARG_TYPE" }), (code) => exits.push(code));
      expect(exits).toEqual([1, 1, 1, 1]);
      expect(errors).toHaveBeenCalledTimes(4);
    } finally {
      errors.mockRestore();
    }
  });

  test("only ERR_REDIS_ codes count", () => {
    expect(isRedisError(redisError())).toBe(true);
    expect(isRedisError(null)).toBe(false);
    expect(isRedisError({ code: 5 })).toBe(false);
  });
});
