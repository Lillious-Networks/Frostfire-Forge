import { expect, test } from "bun:test";
import { cleanLogMessage } from "../modules/logger";

test("a player's text cannot restyle the console or pose as a log entry of its own", () => {
  expect(cleanLogMessage("Unknown packet type: x\n12:00:00 ✔  Admin granted")).toBe("Unknown packet type: x\n    12:00:00 ✔  Admin granted");
  expect(cleanLogMessage("a\r\nb\rc")).toBe("a\n    b\n    c");
  expect(cleanLogMessage("\x1b[31mred\x1b[0m \x1b]0;title\x07done")).toBe("red done");
  expect(cleanLogMessage("bell\x07 null\x00 tab\t")).toBe("bell null tab");
  expect(cleanLogMessage("plain line")).toBe("plain line");
});
