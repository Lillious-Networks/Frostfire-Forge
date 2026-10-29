// Loaded once before the test files (bunfig.toml).
//
// 1. The stand-ins for the generated config files, which a fresh checkout (a CI machine) does not have (see the file).
import { configStandIns } from "./preload-config";
import { afterAll, mock } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { databaseModule } from "./setup";

// 2. A developer's machine loads its .env files into every run, and they name a Redis the cache and the cluster would use.
// A unit test reaches no service: the cache is the in-memory one, as on a CI machine that has no .env file, and no Redis
// is named. (A test that needs one sets its own: cluster-store.test.ts reads CLUSTER_TEST_REDIS_URL.)
delete process.env.CACHE;
delete process.env.REDIS_URL;
delete process.env.REDIS_PASSWORD;

// The logger makes its folder (src/logs, not checked in) when it first writes a line, by looking and then making it. Test
// files that run at the same time on a fresh checkout both look, then both make: one fails with EEXIST. Made here, with
// no error for a folder that is there.
mkdirSync(join(import.meta.dir, "..", "logs"), { recursive: true });

// 3. The database layer starts a pool of workers that wait up to 30 s for MySQL when it is first imported, and a CI
// machine has none: a test file that loads it, however indirectly (a static import is loaded before the file's own
// mock.module runs), would wait that long and fail. So every file is given a database that answers every statement
// with no rows, and a test that needs rows puts its own in place with mock.module. The layer's own tests run in
// processes of their own, on SQLite (sqldatabase_transaction.test.ts, sqlite-belongings.test.ts), started with
// preload-config.ts only.
const baseline = new Map<string, () => Record<string, any>>(Object.entries(configStandIns));
const originalModule = mock.module.bind(mock);
function stand(path: string, factory: () => Record<string, any>): void {
  baseline.set(path, factory);
  originalModule(path, factory);
}
stand("../controllers/sqldatabase", () => databaseModule({ default: async () => [], drainQueries: async () => {} }));

// 4. A stand-in a test file puts in place with mock.module is not undone when the file ends: left in place, it is what
// every file run after it is given instead of the module. Which files those are is not the same everywhere (by name on
// Windows, in the filesystem's own order on a Linux runner; a --parallel run gives each file a process of its own), so
// a file that leaves one behind breaks other files on some machines and not on others. So each file's mock.module is
// undone when the file ends: the module goes back to the stand-in of 1 to 3 above, or to the real module (taken before
// the first stand-in is put in place) for the few modules that are safe to load for that. Others are left as they are:
// loading the real receiver starts the server, and the real authentication pool starts its workers.
const loadable = new Set(["../services/assetCache", "../services/datacache", "../cluster/redisstore"]);
const real = new Map<string, Record<string, any>>();
(mock as { module: typeof mock.module }).module = (path: string, factory: () => Record<string, any>) => {
  if (!baseline.has(path) && !real.has(path) && loadable.has(path)) {
    try {
      real.set(path, { ...require(path) });
    } catch {
      // not loadable here: the module is left as the file put it
    }
  }
  const back = baseline.get(path) ?? (real.has(path) ? () => real.get(path)! : null);
  if (back) {
    try {
      afterAll(() => { originalModule(path, back); });
    } catch {
      // called where no hook can be set (outside a test file): nothing to undo it with
    }
  }
  return originalModule(path, factory);
};
