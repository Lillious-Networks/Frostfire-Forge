// One-command local cluster: `bun cluster <nodes> [--coordinators <n>]`
// starts the Redis container (src/docker/docker-compose.redis.yml) and waits
// until it is healthy, then runs the cluster-local harness
// (src/utility/cluster-local.ts) with the same arguments: <n> coordinators and
// <nodes> engine processes with CLUSTER=true. Read cluster-local.ts for the
// ports each node gets and what it clears from Redis at start.
//
// Before starting it, in .env.production:
//   - REDIS_URL with a password, for example redis://:<password>@127.0.0.1:6379
//     (a cluster node refuses a REDIS_URL without one). The container is started
//     with that same password, so the two always match; if the container was
//     running with another password, compose recreates it (the data volume,
//     and with it the world id counter, is kept).
//   - CLUSTER_LINK_SECRET, a long random value: it signs the node links, and a
//     node without it does not start.
// The gateway must be running, as for one engine. Stop the single engine
// (`bun production`) first: the nodes replace it.
//
// When REDIS_URL points anywhere but this machine's port 6379, no container is
// started and that Redis is used as it is.
//
// Ctrl+C stops the coordinators and nodes (cluster-local saves and shuts each
// down). Redis keeps running; stop it with
//   docker compose -f src/docker/docker-compose.redis.yml down

import path from "node:path";

const root = path.resolve(import.meta.dir, "..", "..");
const redisCompose = path.join(root, "src", "docker", "docker-compose.redis.yml");
const harness = path.join(root, "src", "utility", "cluster-local.ts");
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

const usage = "Usage: bun cluster <nodes> [--coordinators <n>]";

const args = process.argv.slice(2);
const nodes = Number(args.find((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--coordinators"));
if (!Number.isInteger(nodes) || nodes < 1) {
  console.error(usage);
  process.exit(1);
}

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  console.error("REDIS_URL is not set in .env.production. Set it to redis://:<password>@127.0.0.1:6379 (choose a long random password).");
  process.exit(1);
}
if (!process.env.CLUSTER_LINK_SECRET) {
  console.error("CLUSTER_LINK_SECRET is not set in .env.production. Set it to a long random value: cluster nodes do not start without it.");
  process.exit(1);
}

let url: URL;
try {
  url = new URL(redisUrl);
} catch {
  console.error("REDIS_URL in .env.production is not a valid URL.");
  process.exit(1);
}
const password = decodeURIComponent(url.password);
if (!password) {
  console.error("REDIS_URL has no password: cluster nodes refuse it. Use redis://:<password>@127.0.0.1:6379.");
  process.exit(1);
}

if (LOCAL_HOSTS.has(url.hostname) && (url.port || "6379") === "6379") {
  console.log("Starting Redis (docker compose, frostfire-redis) and waiting until it is healthy...");
  const redis = Bun.spawn(["docker", "compose", "-f", redisCompose, "up", "-d", "--wait"], {
    cwd: root,
    // Only the password goes to compose; the value is never printed.
    env: { ...process.env, REDIS_PASSWORD: password },
    stdio: ["ignore", "inherit", "inherit"],
  });
  if ((await redis.exited) !== 0) {
    console.error("Redis did not start. Is Docker running?");
    process.exit(1);
  }
} else {
  console.log(`REDIS_URL points at ${url.hostname}:${url.port || "6379"}, not this machine's 6379: no container started, using that Redis.`);
}

const cluster = Bun.spawn([process.execPath, harness, ...args], {
  cwd: root,
  env: process.env,
  stdio: ["inherit", "inherit", "inherit"],
});

// Ctrl+C reaches the harness directly (same console / process group), and the harness stops its children:
// this process only waits for it. A SIGTERM sent to this process alone is passed on.
process.on("SIGINT", () => {});
process.on("SIGTERM", () => {
  try { cluster.kill("SIGTERM"); } catch { /* already gone */ }
});

process.exit(await cluster.exited);
