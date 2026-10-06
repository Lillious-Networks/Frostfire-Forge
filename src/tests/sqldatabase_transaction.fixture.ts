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

console.log("RESULT " + JSON.stringify(out));
process.exit(0);
