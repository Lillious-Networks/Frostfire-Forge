import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The coordinator process's start checks (secfix A round 1): it refuses a Redis URL a node would refuse.

const MAIN = join(import.meta.dir, "..", "cluster", "coordinator-main.ts");
const PRELOAD = join(import.meta.dir, "preload-config.ts");
// A test secret, long enough for requireClusterKeys: only the Redis check fails below.
const SECRET = "coordinator-main-test-secret-0123456789abcdef";

async function start(env: Record<string, string>): Promise<{ exited: number | "timeout"; output: string }> {
  // From a directory with no .env file, so nothing fills a variable in.
  // --preload: the process is not a test run, so bunfig.toml's preload (the stand-ins for the generated config files, absent on a fresh checkout) does not reach it.
  const proc = Bun.spawn([process.execPath, "--preload", PRELOAD, MAIN], {
    cwd: tmpdir(),
    env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", REGION_ID: "test", CLUSTER_LINK_SECRET: SECRET, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exited = await Promise.race([proc.exited, Bun.sleep(15_000).then(() => "timeout" as const)]);
  if (exited === "timeout") proc.kill();
  const output = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  return { exited, output };
}

test("the coordinator refuses the example Redis password, in REDIS_URL or REDIS_PASSWORD", async () => {
  for (const env of <Array<Record<string, string>>>[{ REDIS_URL: "redis://:change-me@127.0.0.1:1" }, { REDIS_URL: "rediss://127.0.0.1:1", REDIS_PASSWORD: "change-me" }]) {
    const { exited, output } = await start(env);
    // Guard: the redisUrlProblem start check.
    expect(exited).toBe(1);
    expect(output).toContain("refuses the example Redis password");
    expect(output).not.toContain("change-me");
  }
}, 40_000);

test("the coordinator refuses a Redis URL with no password and no TLS", async () => {
  const { exited, output } = await start({ REDIS_URL: "redis://127.0.0.1:1" });
  expect(exited).toBe(1);
  expect(output).toContain("needs a password in REDIS_URL");
}, 20_000);
