// Run by sqldatabase_transaction.test.ts in a process of its own, against a SQLite file made for it:
// the real worker pool, which a test file cannot import beside the files that stand in for it.

import query, { transaction, GuardError } from "../controllers/sqldatabase";

const out: Record<string, unknown> = {};
const balances = () => query("SELECT username, copper FROM currency ORDER BY username");

await query("CREATE TABLE currency (username TEXT PRIMARY KEY, copper INTEGER NOT NULL)");
await query("INSERT INTO currency (username, copper) VALUES (?, ?)", ["a", 100]);

await transaction([
  { sql: "UPDATE currency SET copper = copper - ? WHERE username = ?", values: [10, "a"] },
  { sql: "INSERT INTO currency (username, copper) VALUES (?, ?)", values: ["b", 5] },
]);
out.kept = await balances();

out.guard = await transaction([
  { sql: "UPDATE currency SET copper = 0 WHERE username = ?", values: ["a"] },
  { sql: "UPDATE currency SET copper = copper - 1 WHERE username = ?", values: ["nobody"], mustChange: true },
]).then(() => "kept", (error) => (error instanceof GuardError ? error.statement : String(error)));

out.failed = await transaction([
  { sql: "UPDATE currency SET copper = 0 WHERE username = ?", values: ["a"] },
  { sql: "INSERT INTO no_such_table (username) VALUES (?)", values: ["a"] },
]).then(() => "kept", (error) => (error instanceof GuardError ? "guard" : String(error.message)));
out.afterUndone = await balances();

// More takers than coins, all at once and spread over the workers: each coin is taken once.
await query("UPDATE currency SET copper = 25 WHERE username = ?", ["a"]);
const runs = await Promise.allSettled(Array.from({ length: 40 }, () => transaction([
  { sql: "UPDATE currency SET copper = copper - 1 WHERE username = ? AND copper >= 1", values: ["a"], mustChange: true },
  { sql: "UPDATE currency SET copper = copper + 1 WHERE username = ?", values: ["b"] },
])));
out.took = runs.filter((run) => run.status === "fulfilled").length;
out.refused = runs.filter((run) => run.status === "rejected" && run.reason instanceof GuardError).length;
out.final = await balances();

// The two forms of insert the systems write MySQL's way, which the layer puts into SQLite's words.
const IGNORE = "INSERT IGNORE INTO bag (username, item, quantity) VALUES (?, ?, ?)";
const UPSERT = "INSERT INTO purse (username, copper, silver) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE copper = ?, silver = ?";
const said = (error: unknown) => (error instanceof GuardError ? `guard ${error.statement}` : String((error as Error)?.message ?? error));
await query("CREATE TABLE bag (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, item TEXT NOT NULL, quantity INTEGER NOT NULL, UNIQUE (username, item))");
await query("CREATE TABLE purse (username TEXT NOT NULL UNIQUE PRIMARY KEY, copper INTEGER NOT NULL DEFAULT 0, silver INTEGER NOT NULL DEFAULT 0)");

const added: any = await query(IGNORE, ["a", "Ore", 1]).catch(said);
// The same row again is in the way: nothing is added, and nothing is refused.
const ignored: any = await query(IGNORE, ["a", "Ore", 9]).catch(said);
out.ignore = { id: added?.lastInsertRowid ?? added, again: Array.isArray(ignored) ? "ran" : ignored };
// In a transaction an insert that was ignored changed no rows, which is what mustChange asks about.
out.ignoreGuard = await transaction([{ sql: IGNORE, values: ["a", "Ore", 9], mustChange: true }]).then(() => "kept", said);
out.ignoreKept = await transaction([{ sql: IGNORE, values: ["a", "Rat's \"Tail\"", 2], mustChange: true }]).then(() => "kept", said);
out.bag = await query("SELECT username, item, quantity FROM bag ORDER BY id").catch(said);

out.upsertFirst = await query(UPSERT, ["a", 1, 2, 1, 2]).then(() => "ran", said);
out.upsertAgain = await query(UPSERT, ["a", 30, 40, 30, 40]).then(() => "ran", said);
out.upsertTogether = await transaction([
  { sql: UPSERT, values: ["b", 5, 6, 5, 6] },
  { sql: UPSERT, values: ["a", 7, 8, 7, 8], mustChange: true },
]).then(() => "kept", said);
out.purse = await query("SELECT username, copper, silver FROM purse ORDER BY username").catch(said);

console.log("RESULT " + JSON.stringify(out));
process.exit(0);
