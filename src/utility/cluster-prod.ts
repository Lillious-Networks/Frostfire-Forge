// Production cluster in Docker: `bun docker:prod:cluster:rebuild`, `docker:prod:cluster:down`,
// `docker:prod:cluster:logs`. The cluster counterpart of docker-compose.prod.yml (one engine).
//
// How many: CLUSTER_NODES in .env.production (1 to 16) is the number of engine nodes, and
// CLUSTER_COORDINATORS (1 to 4, default 1) the number of coordinators (one leads, the rest stand by).
// Change the number and run `rebuild` again.
//
// The compose project (frostfire-forge-prod-cluster) is made here from those numbers and given to
// `docker compose` on stdin, so there is no file to keep in step. Each container is like the one in
// docker-compose.prod.yml: host networking, .env.production as its env file, src/certs, src/logs and
// src/config mounted, restart always. On top of .env.production:
//   every container   CLUSTER=true, CACHE=redis, REGION_ID (the env's, default "local")
//   coordinator(s)    CLUSTER_EXPECTED_NODES=<nodes>: the maps are split once every node is live
//   node-<i>          the same per-node values as cluster-local.ts: NODE_ID node-<i>, SERVER_ID
//                     <REGION_ID>-node-<i>, and the base ports (WEBSRV_PORTSSL or GAME_PORT, WEBSRV_PORT,
//                     WEBSRV_INTERNAL_PORT, NODE_LINK_PORT) + 10 * i. Links stay on 127.0.0.1.
// A one-shot db-setup container makes the config files and runs the database setup first (what
// `bun setup-production` does before the single engine starts); the coordinators and nodes start once
// it has finished.
//
// `rebuild`, in order:
//   1. checks REDIS_URL (with a password) and CLUSTER_LINK_SECRET, and starts Redis
//      (docker-compose.redis.yml) when REDIS_URL is this machine's port 6379
//   2. builds the image from Dockerfile.prod, while the old containers still run
//   3. stops the single engine (docker-compose.prod.yml) and the old cluster: the nodes replace it
//   4. deletes every cells:* key from Redis, so block tables and nodes of the old run do not carry over
//   5. starts db-setup, the coordinators and the nodes
// Every node and coordinator of the region runs here: step 4 would pull the state from under
// nodes of the same Redis on another machine.

import path from "node:path";
import { clearClusterState, readRedisUrl, startLocalRedis } from "./cluster-redis";

const root = path.resolve(import.meta.dir, "..", "..");
const PROJECT = "frostfire-forge-prod-cluster";
const IMAGE = "frostfire-forge-prod-cluster:local";
const MAX_NODES = 16;
const MAX_COORDINATORS = 4;
const PORT_STEP = 10;

const usage = "Usage: bun ./src/utility/cluster-prod.ts <rebuild|down|logs>, with CLUSTER_NODES set in .env.production";

function count(name: string, value: string | undefined, max: number, fallback?: number): number {
  const parsed = value?.trim() ? Number(value) : fallback;
  if (parsed === undefined || !Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    console.error(`${name} in .env.production must be a whole number from 1 to ${max}${fallback === undefined ? "" : ` (default ${fallback})`}.`);
    console.error(usage);
    process.exit(1);
  }
  return parsed;
}

function portFrom(value: string | undefined, fallback: number | null): number | null {
  const parsed = parseInt(value || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const command = process.argv[2];
if (command !== "rebuild" && command !== "down" && command !== "logs") {
  console.error(usage);
  process.exit(1);
}

const nodeCount = count("CLUSTER_NODES", process.env.CLUSTER_NODES, MAX_NODES);
const coordinatorCount = count("CLUSTER_COORDINATORS", process.env.CLUSTER_COORDINATORS, MAX_COORDINATORS, 1);
const regionId = process.env.REGION_ID || "local";

// The same reads as server.ts and cluster-local.ts.
const baseGamePort = portFrom(process.env.WEBSRV_PORTSSL, null) ?? portFrom(process.env.GAME_PORT, 3000)!;
const baseHttpPort = portFrom(process.env.WEBSRV_PORT, null);
const baseInternalPort = portFrom(process.env.WEBSRV_INTERNAL_PORT, 3002)!;
const linksOff = process.env.NODE_LINK_PORT?.trim() === "0";
const baseLinkPort = portFrom(process.env.NODE_LINK_PORT, null) ?? baseGamePort + 5;

const highest = Math.max(baseGamePort, baseHttpPort ?? 0, baseInternalPort, baseLinkPort) + PORT_STEP * nodeCount;
if (highest > 65535) {
  console.error(`Ports would pass 65535 (base ports + ${PORT_STEP * nodeCount}). Lower the base ports in .env.production.`);
  process.exit(1);
}

const clusterEnv = { CLUSTER: "true", CACHE: "redis", REGION_ID: regionId };

const engine = {
  image: IMAGE,
  pull_policy: "never",
  network_mode: "host",
  env_file: [path.join(root, ".env.production")],
  volumes: [
    `${path.join(root, "src", "certs")}:/app/src/certs`,
    `${path.join(root, "src", "logs")}:/app/src/logs`,
    `${path.join(root, "src", "config")}:/app/src/config`,
  ],
  ulimits: { nofile: { soft: 1048576, hard: 1048576 } },
  restart: "always",
  // The engine's shutdown takes up to 9 s (running handoffs, achievement flush, leaving the cluster).
  stop_grace_period: "20s",
};
const afterSetup = { "db-setup": { condition: "service_completed_successfully" } };

const services: Record<string, unknown> = {
  "db-setup": {
    ...engine,
    build: { context: root, dockerfile: "src/docker/Dockerfile.prod" },
    restart: "no",
    // The config files are made in the container, like the single engine's: src/config on the host belongs to
    // the container's user, so the deploy user may not be able to write it.
    command: ["sh", "-c", "bun create-config --environment production && exec bun ./src/utility/database_setup_dispatch.ts"],
    healthcheck: { disable: true },
  },
};
const coordinatorName = (i: number) => (i === 1 ? "coordinator" : `coordinator-${i}`);
for (let i = 1; i <= coordinatorCount; i++) {
  services[coordinatorName(i)] = {
    ...engine,
    command: ["bun", "./src/cluster/coordinator-main.ts"],
    environment: { ...clusterEnv, CLUSTER_EXPECTED_NODES: String(nodeCount) },
    healthcheck: { disable: true },
    depends_on: afterSetup,
  };
}
for (let i = 1; i <= nodeCount; i++) {
  const offset = PORT_STEP * i;
  const gamePort = String(baseGamePort + offset);
  const environment: Record<string, string> = {
    ...clusterEnv,
    NODE_ID: `node-${i}`,
    SERVER_ID: `${regionId}-node-${i}`,
    WEBSRV_PORTSSL: gamePort,
    GAME_PORT: gamePort,
    WEBSRV_INTERNAL_PORT: String(baseInternalPort + offset),
    NODE_LINK_PORT: linksOff ? "0" : String(baseLinkPort + offset),
    NODE_LINK_HOST: "127.0.0.1",
    NODE_LINK_BIND_HOST: process.env.NODE_LINK_BIND_HOST?.trim() || "127.0.0.1",
  };
  if (baseHttpPort !== null) environment.WEBSRV_PORT = String(baseHttpPort + offset);
  services[`node-${i}`] = {
    ...engine,
    command: ["bun", "./src/socket/server.ts", "--sql-preconnect"],
    environment,
    depends_on: { ...afterSetup, coordinator: { condition: "service_started" } },
  };
}

// JSON is YAML, so compose reads the project as it is.
const project = JSON.stringify({ name: PROJECT, services });

async function compose(args: string[]): Promise<void> {
  const proc = Bun.spawn(["docker", "compose", "-f", "-", ...args], {
    cwd: root,
    stdin: new TextEncoder().encode(project),
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`docker compose ${args.join(" ")} failed (exit ${code}).`);
    process.exit(code);
  }
}

if (command === "down") {
  await compose(["down", "--remove-orphans"]);
  process.exit(0);
}
if (command === "logs") {
  await compose(["logs", "-f"]);
  process.exit(0);
}

const { url, password } = readRedisUrl(process.env.REDIS_URL);
if (!process.env.CLUSTER_LINK_SECRET) {
  console.error("CLUSTER_LINK_SECRET is not set in .env.production. Set it to a long random value: cluster nodes do not start without it.");
  process.exit(1);
}

console.log(`Region ${regionId}: ${coordinatorCount} coordinator(s) and ${nodeCount} node(s) (CLUSTER_NODES, CLUSTER_COORDINATORS)`);
for (let i = 1; i <= nodeCount; i++) {
  console.log(`  node-${i}: game/WebTransport port ${baseGamePort + PORT_STEP * i}, internal port ${baseInternalPort + PORT_STEP * i}, ${linksOff ? "links off" : `link port ${baseLinkPort + PORT_STEP * i}`}`);
}

await startLocalRedis(url, password);
await compose(["build"]);

console.log("Stopping the single engine (docker-compose.prod.yml) and the old cluster...");
const single = Bun.spawn(["docker", "compose", "-f", path.join(root, "src", "docker", "docker-compose.prod.yml"), "down"], {
  cwd: root,
  stdio: ["ignore", "inherit", "inherit"],
});
if ((await single.exited) !== 0) {
  console.error("Could not stop the single engine (docker-compose.prod.yml).");
  process.exit(1);
}
await compose(["down", "--remove-orphans"]);

try {
  console.log(`Cleared ${await clearClusterState(url.href)} cells:* key(s) from Redis`);
} catch (error) {
  console.error(`Could not clear the cluster state from Redis: ${error}`);
  process.exit(1);
}

await compose(["up", "-d", "--force-recreate", "--remove-orphans"]);
