import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RedisClient } from "bun";
import log from "../modules/logger";
import { RedisStore, STORE_CALL_MS, STORE_STALL_MISSES } from "../cluster/redisstore";
import { StoreHealth } from "../cluster/health";
import { nodeLinkBindError, redisUrlProblem } from "../cluster/config";

// Security fix group C (phase 7 review): M3 (a deadline on every Redis command), H1 (the start check for a Redis
// password), L2 (no link listener on every interface in production), L3 and L4 (the Docker files).

// ---------------------------------------------------------------- M3

// A Redis that holds the connection: its commands answer, or never do.
class FakeClient {
  onclose: ((error: Error) => void) | null = null;
  onconnect: (() => void) | null = null;
  closes = 0;
  stalled = false;
  failWith: Error | null = null;
  calls = 0;

  async connect() {}
  async duplicate() { return new FakeClient(); }
  close() { this.closes++; }

  private answer<T>(value: T): Promise<T> {
    this.calls++;
    if (this.failWith) return Promise.reject(this.failWith);
    if (this.stalled) return new Promise<T>(() => {});
    return Promise.resolve(value);
  }
  get(_key: string) { return this.answer<string | null>("value"); }
  set(..._args: unknown[]) { return this.answer("OK"); }
  del(_key: string) { return this.answer(1); }
  incrby(_key: string, _amount: number) { return this.answer(1); }
  sadd(_key: string, _member: string) { return this.answer(1); }
  srem(_key: string, _member: string) { return this.answer(1); }
  smembers(_key: string) { return this.answer<string[]>([]); }
  pexpire(_key: string, _ttl: number) { return this.answer(1); }
  publish(_channel: string, _message: string) { return this.answer(1); }
  send(_command: string, _args: string[]) { return this.answer<unknown>("PONG"); }
}

const CALL_TEST_MS = 15;
const NEVER = 1_000_000;

function setup(reviveMs = NEVER) {
  const main = new FakeClient();
  const made: FakeClient[] = [];
  const store = new RedisStore("redis://unused", main as unknown as RedisClient, () => {
    const fake = new FakeClient();
    made.push(fake);
    return fake as unknown as RedisClient;
  }, reviveMs, 50, CALL_TEST_MS, 3);
  main.onconnect!();
  return { store, main, made };
}

let stores: RedisStore[] = [];
let errors: { mockRestore(): void };
beforeEach(() => {
  stores = [];
  errors = spyOn(log, "error").mockImplementation(() => {});
  spyOn(log, "success").mockImplementation(() => {});
  spyOn(log, "warn").mockImplementation(() => {});
});
afterEach(() => {
  for (const store of stores) store.close();
  errors.mockRestore();
});
function track(rig: ReturnType<typeof setup>) {
  stores.push(rig.store);
  return rig;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(probe: () => boolean, ms = 1_000) {
  const end = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > end) throw new Error("until: timed out");
    await sleep(2);
  }
}
const miss = (store: RedisStore) => store.get("k").then(() => "answered", (error) => String(error));

describe("M3: a deadline on every Redis command", () => {
  test("the defaults are 2 s and 3 misses", () => {
    expect(STORE_CALL_MS).toBe(2_000);
    expect(STORE_STALL_MISSES).toBe(3);
  });

  test("every command of the store rejects when Redis does not answer, instead of waiting for ever", async () => {
    const { store, main } = track(setup());
    main.stalled = true;
    const commands: Array<[string, () => Promise<unknown>]> = [
      ["get", () => store.get("k")],
      ["set", () => store.set("k", "v")],
      ["set with ttl", () => store.set("k", "v", 100)],
      ["setIfAbsent", () => store.setIfAbsent("k", "v", 100)],
      ["del", () => store.del("k")],
      ["take", () => store.take("k")],
      ["incrBy", () => store.incrBy("k", 1)],
      ["swapIfEpoch", () => store.swapIfEpoch("k", 0, "v")],
      ["deleteIfEpoch", () => store.deleteIfEpoch("k", 0)],
      ["renewIfEpoch", () => store.renewIfEpoch("k", 0, 100)],
      ["addToSet", () => store.addToSet("k", "m")],
      ["removeFromSet", () => store.removeFromSet("k", "m")],
      ["members", () => store.members("k")],
      ["expire", () => store.expire("k", 100)],
      ["publish", () => store.publish("c", "m")],
    ];
    for (const [name, run] of commands) {
      const result = await run().then(() => "answered", (error) => String(error));
      expect(result, name).toContain("did not answer");
    }
  });

  test("a command that is answered in time is unaffected", async () => {
    const { store } = track(setup());
    expect(await store.get("k")).toBe("value");
    expect(store.isUp()).toBe(true);
  });

  test("the store reports down after 3 misses in a row, and up again when a command is answered", async () => {
    const { store, main } = track(setup());
    main.stalled = true;
    await miss(store);
    await miss(store);
    expect(store.isUp()).toBe(true);
    await miss(store);
    expect(store.isUp()).toBe(false);
    main.stalled = false;
    expect(await store.get("k")).toBe("value");
    expect(store.isUp()).toBe(true);
  });

  test("StoreHealth sees the stall", async () => {
    const { store, main } = track(setup());
    const health = new StoreHealth();
    health.attach(store, 5);
    try {
      expect(health.up()).toBe(true);
      main.stalled = true;
      for (let i = 0; i < 3; i++) await miss(store);
      expect(health.up()).toBe(false);
    } finally {
      health.detach();
    }
  });

  test("an answer in between clears the count: misses must be in a row", async () => {
    const { store, main } = track(setup());
    main.stalled = true;
    await miss(store);
    await miss(store);
    main.stalled = false;
    await store.get("k");
    main.stalled = true;
    await miss(store);
    await miss(store);
    expect(store.isUp()).toBe(true);
  });

  test("a command that fails for another reason is no stall", async () => {
    const { store, main } = track(setup());
    main.failWith = new Error("WRONGTYPE");
    for (let i = 0; i < 5; i++) expect(await miss(store)).toContain("WRONGTYPE");
    expect(store.isUp()).toBe(true);
  });

  test("a stall alone starts no revival of the connected client", async () => {
    const { store, main, made } = track(setup(5));
    main.stalled = true;
    for (let i = 0; i < 3; i++) await miss(store);
    await sleep(60);
    expect(made.length).toBe(0);
    expect(main.closes).toBe(0);
  });

  test("a stalled store hears Redis answer again with no caller sending anything (a probe)", async () => {
    const { store, main } = track(setup(10));
    main.stalled = true;
    for (let i = 0; i < 3; i++) await miss(store);
    expect(store.isUp()).toBe(false);
    main.stalled = false;
    await until(() => store.isUp());
  });

  test("the late answer of a command that missed its deadline is not an unhandled rejection", async () => {
    const { store, main } = track(setup());
    let reject!: (error: Error) => void;
    main.get = () => new Promise<string | null>((_, no) => { reject = no; });
    expect(await miss(store)).toContain("did not answer");
    reject(new Error("late"));
    await sleep(5);
  });
});

// ---------------------------------------------------------------- H1, L4: the Redis URL

describe("H1: a cluster node needs a Redis password", () => {
  test("accepts a password in the URL, with or without a user", () => {
    expect(redisUrlProblem("redis://:s3cretvalue@redis:6379")).toBeNull();
    expect(redisUrlProblem("redis://cluster:s3cretvalue@redis:6379")).toBeNull();
    expect(redisUrlProblem("rediss://redis:6379")).toBeNull();
  });

  test("refuses a URL with no password", () => {
    for (const url of ["redis://redis:6379", "redis://user@redis:6379", "redis://:@redis:6379"]) {
      expect(redisUrlProblem(url), url).toContain("REDIS_URL");
    }
  });

  test("refuses text that is not a redis URL", () => {
    expect(redisUrlProblem("not a url")).toContain("REDIS_URL");
    expect(redisUrlProblem("http://:pw@redis:6379")).toContain("REDIS_URL");
  });

  test("L4: refuses the example password, in the URL (also encoded) and in REDIS_PASSWORD", () => {
    expect(redisUrlProblem("redis://:change-me@redis:6379")).toContain("example");
    expect(redisUrlProblem("redis://:change%2Dme@redis:6379")).toContain("example");
    expect(redisUrlProblem("rediss://:change-me@redis:6379")).toContain("example");
    expect(redisUrlProblem("redis://:longrandomvalue@redis:6379", "change-me")).toContain("example");
  });

  test("a message names the variable and never the value", () => {
    for (const [url, password] of [["redis://redis:6379", undefined], ["redis://:change-me@redis:6379", "change-me"], ["redis://:hunter2hunter2@redis:6379", "change-me"]] as const) {
      const message = redisUrlProblem(url, password)!;
      expect(message).toContain("REDIS_");
      expect(message).not.toContain("hunter2hunter2");
      expect(message).not.toContain("redis:6379");
    }
  });

  test("validate_config makes the checks inside the CLUSTER=true block only", () => {
    const source = readFileSync(join(import.meta.dir, "..", "utility", "validate_config.ts"), "utf8");
    const cluster = source.slice(source.indexOf('if (process.env.CLUSTER === "true") {'), source.indexOf("// Validate the generated settings.json"));
    expect(cluster).toContain("redisUrlProblem(process.env.REDIS_URL, process.env.REDIS_PASSWORD)");
    expect(cluster).toContain("nodeLinkBindError()");
    const before = source.slice(0, source.indexOf('if (process.env.CLUSTER === "true") {'));
    expect(before).not.toContain("redisUrlProblem(");
    expect(before).not.toContain("nodeLinkBindError()");
  });
});

describe("validate_config applies the checks (run as a process: it exits on a startup error)", () => {
  const entry = join(import.meta.dir, "..", "utility", "validate_config.ts");
  const base: Record<string, string> = {
    PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "",
    DATABASE_ENGINE: "sqlite", DATABASE_PATH: "unused.db",
    CLUSTER: "true", CACHE: "redis", REDIS_URL: "redis://:a-test-only-password@redis:6379",
    NODE_ID: "n1", REGION_ID: "r1", GATEWAY_GAME_SERVER_SECRET: "test-only", CLUSTER_LINK_SECRET: "x".repeat(40), GAME_NAME: "test",
    NODE_LINK_BIND_HOST: "10.0.0.5", NODE_ENV: "production",
  };
  const run = (extra: Record<string, string>, drop: string[] = []) => {
    const env = { ...base, ...extra };
    for (const name of drop) delete env[name];
    // --preload: a process is not a test run, so bunfig.toml's preload (stand-ins for the generated config files, absent on a fresh checkout) does not reach it.
    const ran = Bun.spawnSync(["bun", "--preload", join(import.meta.dir, "preload-config.ts"), "-e", `await import(${JSON.stringify(entry)})`], { env, cwd: tmpdir() }); // from a directory with no .env file, so nothing fills a variable in
    return { code: ran.exitCode, out: (ran.stdout.toString() + ran.stderr.toString()).replace(/[[0-9;]*m/g, "") };
  };

  test("a good cluster configuration starts", () => {
    expect(run({}).code).toBe(0);
  });

  test("H1: a REDIS_URL with no password stops the node; the message names the variable, not the URL", () => {
    const ran = run({ REDIS_URL: "redis://secret-host:6379" });
    expect(ran.code).toBe(1);
    expect(ran.out).toContain("REDIS_URL");
    expect(ran.out).not.toContain("secret-host");
  });

  test("L4: the example password stops the node", () => {
    const ran = run({ REDIS_URL: "redis://:change-me@redis:6379" });
    expect(ran.code).toBe(1);
    expect(ran.out).toContain("example Redis password");
  });

  test("L2: no NODE_LINK_BIND_HOST stops a node, with or without NODE_ENV", () => {
    for (const drop of [["NODE_LINK_BIND_HOST"], ["NODE_LINK_BIND_HOST", "NODE_ENV"]]) {
      const ran = run({}, drop);
      expect(ran.code, drop.join()).toBe(1);
      expect(ran.out).toContain("NODE_LINK_BIND_HOST");
    }
    expect(run({ NODE_LINK_BIND_HOST: "0.0.0.0" }, ["NODE_ENV"]).code).toBe(0);
  });

  test("with CLUSTER off none of it applies", () => {
    const ran = run({ CLUSTER: "false", REDIS_URL: "redis://redis:6379" }, ["NODE_LINK_BIND_HOST"]);
    expect(ran.code).toBe(0);
  });
});

// ---------------------------------------------------------------- L2

describe("L2: no link listener on every interface by default", () => {
  const names = ["CLUSTER", "NODE_ENV", "NODE_LINK_BIND_HOST", "NODE_LINK_PORT"] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const name of names) saved[name] = process.env[name]; });
  afterEach(() => {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });
  const env = (values: Partial<Record<(typeof names)[number], string | undefined>>) => {
    for (const name of names) {
      const value = values[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };

  test("refuses an unset bind host with CLUSTER on in production, naming the variable", () => {
    env({ CLUSTER: "true", NODE_ENV: "production" });
    expect(nodeLinkBindError()).toContain("NODE_LINK_BIND_HOST");
    env({ CLUSTER: "true", NODE_ENV: "production", NODE_LINK_BIND_HOST: "   " });
    expect(nodeLinkBindError()).toContain("NODE_LINK_BIND_HOST");
  });

  test("accepts a set address, also an explicit bind to every interface (the operator's choice)", () => {
    for (const host of ["10.0.0.5", "0.0.0.0", "::"]) {
      env({ CLUSTER: "true", NODE_ENV: "production", NODE_LINK_BIND_HOST: host });
      expect(nodeLinkBindError(), host).toBeNull();
    }
  });

  test("applies whatever NODE_ENV is, also unset", () => {
    env({ CLUSTER: "true", NODE_ENV: "development" });
    expect(nodeLinkBindError()).toContain("NODE_LINK_BIND_HOST");
    env({ CLUSTER: "true" });
    expect(nodeLinkBindError()).toContain("NODE_LINK_BIND_HOST");
  });

  test("changes nothing with the cluster off or with links off", () => {
    env({ NODE_ENV: "production" });
    expect(nodeLinkBindError()).toBeNull();
    env({});
    expect(nodeLinkBindError()).toBeNull();
    env({ CLUSTER: "true", NODE_LINK_PORT: "0" });
    expect(nodeLinkBindError()).toBeNull();
  });

  test("the local cluster launcher gives its nodes a loopback bind host unless one is set", () => {
    const source = readFileSync(join(import.meta.dir, "..", "utility", "cluster-local.ts"), "utf8");
    expect(source).toContain('NODE_LINK_BIND_HOST: process.env.NODE_LINK_BIND_HOST?.trim() || "127.0.0.1"');
  });
});

// ---------------------------------------------------------------- L2, L3, L4: the Docker files

describe("the Docker files", () => {
  const docker = (name: string) => readFileSync(join(import.meta.dir, "..", "docker", name), "utf8");
  const cluster = docker("docker-compose.cluster.yml");
  const service = (text: string, name: string) => {
    const start = text.indexOf(`\n  ${name}:\n`);
    expect(start, name).toBeGreaterThan(-1);
    const next = text.slice(start + 1).search(/\n  [a-z0-9-]+:\n|\nvolumes:\n|\nnetworks:\n/);
    return text.slice(start, next < 0 ? undefined : start + 1 + next);
  };

  test("L3: the gateway, assets, mysql and both db-init services blank REDIS_PASSWORD as they blank CLUSTER_LINK_SECRET", () => {
    for (const name of ["gateway", "assets", "mysql", "db-init-engine", "db-init-gateway"]) {
      const block = service(cluster, name);
      expect(block, name).toContain('CLUSTER_LINK_SECRET: ""');
      expect(block, name).toContain('REDIS_PASSWORD: ""');
    }
  });

  test("L4: Redis gets the password from a config file, not from its arguments", () => {
    for (const file of ["docker-compose.cluster.yml", "docker-compose.redis.yml"]) {
      const block = service(docker(file), "redis");
      expect(block, file).not.toContain("--requirepass");
      expect(block, file).toContain("requirepass");
      expect(block, file).toContain("/run/redis-conf/redis.conf");
      expect(block, file).toContain("tmpfs:");
      // The password is read in the container's shell ($$ is compose's escape for $), never by compose.
      expect(block, file).not.toMatch(/\$\{REDIS_PASSWORD[^}]*\}[^\n]*requirepass/);
    }
  });

  test("L4: the cluster's Redis keeps the REDIS_PASSWORD variable the chaos script and the health check read", () => {
    const block = service(cluster, "redis");
    expect(block).toContain("REDIS_PASSWORD: ${REDIS_PASSWORD:?");
    expect(block).toContain("REDISCLI_AUTH");
    const chaos = readFileSync(join(import.meta.dir, "..", "docker", "cluster-chaos.ts"), "utf8");
    expect(chaos).toContain('REDISCLI_AUTH="$REDIS_PASSWORD"');
  });

  test("L2: every node sets NODE_LINK_BIND_HOST explicitly, and the networks are as before (no fixed subnet or address)", () => {
    for (const name of ["node-1", "node-2", "node-3"]) {
      expect(service(cluster, name), name).toContain('NODE_LINK_BIND_HOST: "0.0.0.0"');
    }
    expect(cluster).not.toContain("ipv4_address");
    expect(cluster).not.toContain("ipam");
  });
});
