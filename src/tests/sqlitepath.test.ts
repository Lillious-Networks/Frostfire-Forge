import { afterAll, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveSqlitePath } from "../controllers/sqlitepath";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ff-sqlitepath-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("the SQLite file", () => {
  test("DATABASE_PATH names it in full, and its folder is made", () => {
    const wanted = path.join(root, "data", "sqlite", "game.sqlite");
    expect(resolveSqlitePath({ DATABASE_PATH: wanted, DATABASE_NAME: "ignored" })).toBe(wanted);
    expect(fs.existsSync(path.dirname(wanted))).toBe(true);
  });

  test("without DATABASE_PATH it is where it always was", () => {
    expect(resolveSqlitePath({ DATABASE_NAME: "mystika" })).toBe(path.join(os.tmpdir(), "frostfire_forge", "mystika.sqlite"));
    expect(resolveSqlitePath({ DATABASE_PATH: "  ", DATABASE_NAME: "mystika" })).toBe(path.join(os.tmpdir(), "frostfire_forge", "mystika.sqlite"));
    expect(resolveSqlitePath({})).toBe("./database.sqlite");
  });
});
