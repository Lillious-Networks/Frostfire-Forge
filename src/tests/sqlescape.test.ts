import { describe, expect, test } from "bun:test";
import { escapeValue, sqlWrapper } from "../controllers/sqlescape";

const ENGINES: DatabaseEngine[] = ["mysql", "postgres", "sqlite"];
const LITERAL_BACKSLASH_ENGINES: DatabaseEngine[] = ["postgres", "sqlite"];

/** What the wrapper wrote for a string before backslashes were handled: quotes doubled, nothing else. */
const quoteOnly = (value: string) => "'" + value.replace(/'/g, "''") + "'";

const HOSTILE_STRINGS = [
  "abc\\",
  "\\",
  "\\'",
  "'\\",
  "\\\\'",
  "it's",
  "C:\\maps\\new",
  "a\0b",
  "\\0",
  "line1\nline2\r\n\ttab",
  "\x1a",
  '"double"',
  "100%_\\%",
  "'; DROP TABLE accounts; -- ",
  "\\'; DROP TABLE accounts; -- ",
  "",
  "ünïcødé ❄ \u{1F525}",
];

/**
 * Splits a statement into its single-quoted string literals and the rest, following MySQL's
 * documented rules for reading them. It is a model of those rules, not a server.
 * `backslashEscapes` false is the NO_BACKSLASH_ESCAPES sql_mode (also how SQLite and Postgres read).
 */
function readLiterals(sql: string, backslashEscapes: boolean) {
  const sequences: Record<string, string> = { "0": "\0", b: "\b", n: "\n", r: "\r", t: "\t", Z: "\x1a" };
  const literals: string[] = [];
  let skeleton = "";
  let i = 0;

  while (i < sql.length) {
    if (sql[i] !== "'") {
      skeleton += sql[i++];
      continue;
    }

    let value = "";
    let closed = false;
    i++;
    while (i < sql.length && !closed) {
      const char = sql[i];
      if (char === "\\" && backslashEscapes) {
        const next = sql[i + 1];
        if (next === undefined) break;
        value += next === "%" || next === "_" ? "\\" + next : (sequences[next] ?? next);
        i += 2;
      } else if (char === "'" && sql[i + 1] === "'") {
        value += "'";
        i += 2;
      } else if (char === "'") {
        closed = true;
        i++;
      } else {
        value += char;
        i++;
      }
    }

    if (!closed) throw new Error(`Unterminated string literal in: ${sql}`);
    literals.push(value);
    skeleton += "?";
  }

  return { literals, skeleton };
}

describe("escapeValue: strings on MySQL", () => {
  test("doubles a backslash so it cannot escape the closing quote", () => {
    expect(escapeValue("abc\\", "mysql")).toBe("'abc\\\\'");
    expect(escapeValue("C:\\maps\\new", "mysql")).toBe("'C:\\\\maps\\\\new'");
  });

  test("doubles single quotes rather than backslash-escaping them", () => {
    expect(escapeValue("it's", "mysql")).toBe("'it''s'");
    expect(escapeValue("\\'", "mysql")).toBe("'\\\\'''");
  });

  test("writes a NUL character as \\0", () => {
    expect(escapeValue("a\0b", "mysql")).toBe("'a\\0b'");
  });

  test("leaves line breaks, tabs, double quotes and Ctrl-Z as they are", () => {
    const value = "line1\nline2\r\n\ttab \"quoted\" \x1a";
    expect(escapeValue(value, "mysql")).toBe("'" + value + "'");
  });

  test("every value reads back as one literal holding the same text", () => {
    for (const value of HOSTILE_STRINGS) {
      expect(readLiterals(escapeValue(value, "mysql"), true)).toEqual({ literals: [value], skeleton: "?" });
    }
  });

  test("every value is still one literal when the server runs with NO_BACKSLASH_ESCAPES", () => {
    for (const value of HOSTILE_STRINGS) {
      const { literals, skeleton } = readLiterals(escapeValue(value, "mysql"), false);
      expect(skeleton).toBe("?");
      expect(literals).toHaveLength(1);
    }
  });

  test("escapes the string form of other objects the same way", () => {
    const value = { toString: () => "a\\'b" };
    expect(escapeValue(value, "mysql")).toBe("'a\\\\''b'");
  });
});

describe("escapeValue: strings on SQLite and Postgres", () => {
  test.each(LITERAL_BACKSLASH_ENGINES)("keeps a backslash as a single character on %s", (engine) => {
    expect(escapeValue("abc\\", engine)).toBe("'abc\\'");
    expect(escapeValue("C:\\maps\\new", engine)).toBe("'C:\\maps\\new'");
  });

  test.each(LITERAL_BACKSLASH_ENGINES)("writes every value exactly as before on %s", (engine) => {
    for (const value of HOSTILE_STRINGS) {
      expect(escapeValue(value, engine)).toBe(quoteOnly(value));
    }
  });

  test.each(LITERAL_BACKSLASH_ENGINES)("every value without a NUL reads back as the same text on %s", (engine) => {
    for (const value of HOSTILE_STRINGS.filter((text) => !text.includes("\0"))) {
      expect(readLiterals(escapeValue(value, engine), false)).toEqual({ literals: [value], skeleton: "?" });
    }
  });

  test.each(LITERAL_BACKSLASH_ENGINES)("escapes the string form of other objects as before on %s", (engine) => {
    const value = { toString: () => "a\\'b" };
    expect(escapeValue(value, engine)).toBe("'a\\''b'");
  });
});

describe("escapeValue: values that are not strings", () => {
  test.each(ENGINES)("null and undefined become NULL on %s", (engine) => {
    expect(escapeValue(null, engine)).toBe("NULL");
    expect(escapeValue(undefined, engine)).toBe("NULL");
  });

  test.each(ENGINES)("numbers are written bare on %s", (engine) => {
    expect(escapeValue(42, engine)).toBe("42");
    expect(escapeValue(-1.5, engine)).toBe("-1.5");
    expect(escapeValue(0, engine)).toBe("0");
  });

  test.each(ENGINES)("booleans become 1 and 0 on %s", (engine) => {
    expect(escapeValue(true, engine)).toBe("1");
    expect(escapeValue(false, engine)).toBe("0");
  });

  test.each(ENGINES)("dates become a quoted UTC timestamp without milliseconds on %s", (engine) => {
    expect(escapeValue(new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 678)), engine)).toBe("'2026-01-02 03:04:05'");
  });

  test.each(ENGINES)("a bigint is written as a quoted string on %s", (engine) => {
    expect(escapeValue(123n, engine)).toBe("'123'");
  });
});

describe("sqlWrapper", () => {
  test("replaces placeholders in order", () => {
    expect(sqlWrapper("UPDATE items SET name = ?, level = ? WHERE id = ?", ["sword", 3, null], "sqlite"))
      .toBe("UPDATE items SET name = 'sword', level = 3 WHERE id = NULL");
  });

  test("returns a query without placeholders unchanged", () => {
    expect(sqlWrapper("SELECT 1 AS test", [], "mysql")).toBe("SELECT 1 AS test");
  });

  test("expands an array into a comma separated list for IN (?)", () => {
    expect(sqlWrapper("SELECT id, session_id FROM accounts WHERE id IN (?)", [[1, 2, 3]], "mysql"))
      .toBe("SELECT id, session_id FROM accounts WHERE id IN (1, 2, 3)");
  });

  test("escapes each array element for the engine", () => {
    expect(sqlWrapper("SELECT 1 FROM guilds WHERE name IN (?)", [["a\\", "b'"]], "mysql"))
      .toBe("SELECT 1 FROM guilds WHERE name IN ('a\\\\', 'b''')");
    expect(sqlWrapper("SELECT 1 FROM guilds WHERE name IN (?)", [["a\\", "b'"]], "sqlite"))
      .toBe("SELECT 1 FROM guilds WHERE name IN ('a\\', 'b''')");
  });

  test("does not treat a question mark inside a value as a placeholder", () => {
    expect(sqlWrapper("SELECT ? AS a, ? AS b", ["what?", "ok"], "sqlite")).toBe("SELECT 'what?' AS a, 'ok' AS b");
  });

  test("throws when placeholders and parameters do not match", () => {
    expect(() => sqlWrapper("SELECT ?", [], "mysql")).toThrow("Number of placeholders does not match number of parameters");
    expect(() => sqlWrapper("SELECT 1", [1], "mysql")).toThrow("Number of placeholders does not match number of parameters");
  });

  test("throws on an empty array", () => {
    expect(() => sqlWrapper("SELECT 1 WHERE id IN (?)", [[]], "mysql")).toThrow("Cannot use empty array as SQL parameter");
  });

  test("a MySQL value ending in a backslash cannot swallow the next parameter", () => {
    const name = "abc\\";
    const description = ", description = (SELECT password_hash FROM accounts LIMIT 1) -- ";
    const sql = sqlWrapper("UPDATE items SET name = ?, description = ? WHERE id = ?", [name, description, 5], "mysql");

    expect(readLiterals(sql, true)).toEqual({
      literals: [name, description],
      skeleton: "UPDATE items SET name = ?, description = ? WHERE id = 5",
    });
  });
});
