import { afterEach, expect, mock, test } from "bun:test";
import { databaseModule } from "./setup";

// The guard the node's start and /shutdown and /restart clear through (cluster/clearguard.ts). It loads the cluster
// module, which reaches the database: stubbed first.
mock.module("../controllers/sqldatabase", () => databaseModule({ default: async (_sql: string, _params?: any[]) => [] }));
const { clearShared } = await import("../cluster/clearguard");

const saved = process.env.CLUSTER;
afterEach(() => {
  if (saved === undefined) delete process.env.CLUSTER;
  else process.env.CLUSTER = saved;
});

test("without a cluster the clear is called", async () => {
  process.env.CLUSTER = "false";
  let cleared = 0;
  expect(await clearShared(async () => { cleared++; })).toBe(true);
  expect(cleared).toBe(1);
});

test("in a cluster whose node registry is not started the clear is skipped", async () => {
  process.env.CLUSTER = "true";
  let cleared = 0;
  expect(await clearShared(async () => { cleared++; })).toBe(false);
  expect(cleared).toBe(0);
});
