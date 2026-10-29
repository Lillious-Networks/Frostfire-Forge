// Redis steps shared by the cluster start scripts: cluster-start.ts (`bun cluster`),
// cluster-local.ts (`bun cluster-local`) and cluster-prod.ts (`bun docker:prod:cluster:*`).

import { RedisClient } from "bun";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..", "..");
const redisCompose = path.join(root, "src", "docker", "docker-compose.redis.yml");
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** The REDIS_URL and its password, or exits with the reason a cluster node would refuse it. */
export function readRedisUrl(redisUrl: string | undefined): { url: URL; password: string } {
  if (!redisUrl) {
    console.error("REDIS_URL is not set in .env.production. Set it to redis://:<password>@127.0.0.1:6379 (choose a long random password).");
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
  return { url, password };
}

/**
 * Starts the Redis container (docker-compose.redis.yml, frostfire-redis) with the URL's password and waits until it
 * is healthy, when the URL is this machine's port 6379. Any other Redis is used as it is. Exits if Redis does not start.
 */
export async function startLocalRedis(url: URL, password: string): Promise<void> {
  if (!(LOCAL_HOSTS.has(url.hostname) && (url.port || "6379") === "6379")) {
    console.log(`REDIS_URL points at ${url.hostname}:${url.port || "6379"}, not this machine's 6379: no container started, using that Redis.`);
    return;
  }
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
}

/** Deletes every `cells:*` key (SCAN, not KEYS: it does not block Redis on a large keyspace). How many it deleted. */
export async function clearClusterState(url: string): Promise<number> {
  const redis = new RedisClient(url);
  try {
    await redis.connect();
    let cursor = "0";
    let cleared = 0;
    do {
      const [next, keys] = (await redis.send("SCAN", [cursor, "MATCH", "cells:*", "COUNT", "1000"])) as [string | number, string[]];
      cursor = String(next);
      if (keys.length > 0) cleared += Number(await redis.send("UNLINK", keys));
    } while (cursor !== "0");
    return cleared;
  } finally {
    redis.close();
  }
}
