// Local multi-node harness: `bun cluster-local <nodes> [--coordinators <n>]`
// starts <n> cluster coordinators (default 1) and <nodes> engine processes from
// this repo, on this machine. One coordinator leads and the rest stand by: with
// --coordinators 2, stopping the leader's process (its pid is in its log line)
// shows the standby taking over within the 5 s lock ttl.
//
// Each run starts from a clean cluster state: before any child starts, every
// `cells:*` key in Redis (block tables, the map catalogue, node registry, player
// directory, counters) is deleted, so tables from an earlier run with other
// nodes do not carry over. Nothing of the cluster may be running then.
//
// Before starting it:
//   - Redis must be running:  docker compose -f src/docker/docker-compose.redis.yml up -d
//     and REDIS_URL set in .env.production (this refuses to start without it).
//   - The gateway must be running (each node registers with it, as one engine
//     does). This starts neither Redis nor the gateway.
//
// What every child gets (on top of the harness's own environment, which
// `--env-file=.env.production` fills; Bun's --env-file never overrides a
// variable that is already set, so these go through the child's env):
//   CLUSTER=true, CACHE=redis, REGION_ID (the harness's, default "local")
// The coordinators also get CLUSTER_EXPECTED_NODES=<nodes>: they split the maps
// only once every node is live, so the first node up does not take every block.
// And CLUSTER_SETTLE_MS=<nodes> x the ready timeout, the longest the one-by-one
// start below can take: it replaces the coordinator's 60 s cap, which a slow
// start would outlast (the last nodes would then get no blocks).
//
// What differs per node (i = 1..N; base = the value the engine would use alone,
// read the same way server.ts reads it; node i uses base + 10 * i):
//   NODE_ID                  node-<i>
//   SERVER_ID                <REGION_ID>-node-<i>. The gateway keys game servers by
//                            this id, so nodes sharing one would overwrite each
//                            other's registration (host/port) on every heartbeat.
//                            Side effects of the per-node id: whitelist rows are
//                            read and written per SERVER_ID, the asset-server
//                            world-list calls carry it, and the gateway realm list
//                            shows one entry per node (cluster mode folds them into
//                            one region from phase 3 Task 6).
//   WEBSRV_PORTSSL           public game port: TCP (HTTPS) and the WebTransport
//                            UDP listener, advertised to the gateway as port and
//                            wtPort. base: WEBSRV_PORTSSL, else GAME_PORT, else 3000
//   GAME_PORT                the same value (server.ts reads it when WEBSRV_PORTSSL
//                            is unset)
//   WEBSRV_PORT              plain HTTP port; only when the base env sets it
//                            (server.ts falls back to the game port otherwise)
//   WEBSRV_INTERNAL_PORT     internal HTTPS port (127.0.0.1; the engine's admin and
//                            gateway-facing server). base: WEBSRV_INTERNAL_PORT, else
//                            3002. It binds with reusePort, so a clash would not
//                            fail: two nodes would silently share the port.
//   NODE_LINK_PORT           node-to-node link port (UDP); base NODE_LINK_PORT, else game port + 5;
//                            NODE_LINK_PORT=0 turns the links off on every node
//   NODE_LINK_HOST           127.0.0.1 (every node is on this machine)
//   NODE_LINK_BIND_HOST      the base NODE_LINK_BIND_HOST, else 127.0.0.1 (nodes refuse to start with it unset)
//
// Shared by all nodes (no per-node value needed): TLS certificate paths, the
// database (DATABASE_*), the asset server, SERVER_HOST / PUBLIC_HOST. The log file
// (src/logs/<date>.log) is shared too: it is appended to a line at a time with
// the synchronous API, so lines from the nodes interleave but are not corrupted.
// The engine has no metrics or benchmark port. Each node runs its own DB worker
// pool (DB_WORKER_POOL_SIZE) and auth pool (AUTH_POOL_SIZE); lower them in
// .env.production for large N.
//
// The nodes start one after another: the next starts when the previous prints
// its readiness line ("WebTransport listening on UDP port ..."), or after 60 s.
// All nodes sync the world maps into the same directory and write each file as
// <file>.tmp then rename (src/modules/worldmaps.ts), so two nodes syncing at
// once would write the same .tmp file; startup also runs schema checks against
// the database and may (re)issue the local certificate.
//
// Output of every child is prefixed with its name. Ctrl+C (or SIGTERM) stops
// all children, then a hard kill of any still running after 30 s (a node's
// graceful shutdown takes a while: achievements, directory sweep, saves).
// Stopping on SIGINT: elsewhere the harness sends SIGINT to each child; on
// Windows it sends nothing, because the console Ctrl+C already reaches every
// child and Bun's kill() may hard-terminate, which would skip the nodes'
// graceful save. If every coordinator dies, the nodes are left running and a
// loud warning is printed.

import { RedisClient } from "bun";
import path from "node:path";
import fs from "node:fs";

const root = path.resolve(import.meta.dir, "..", "..");
const bun = process.execPath;

const MAX_NODES = 16;
const MAX_COORDINATORS = 4;
const PORT_STEP = 10;
const STOP_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 60_000;
const READY_LINE = "WebTransport listening on UDP port";

const usage = `Usage: bun cluster-local <nodes> [--coordinators <n>]   (nodes 1 to ${MAX_NODES}, coordinators 1 to ${MAX_COORDINATORS}, default 1)`;

function parseArgs(args: string[]): { nodeCount: number; coordinatorCount: number } | null {
  let nodes: string | undefined;
  let coordinators = "1";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--coordinators") coordinators = args[++i] ?? "";
    else if (args[i]!.startsWith("--coordinators=")) coordinators = args[i]!.slice("--coordinators=".length);
    else if (nodes === undefined) nodes = args[i];
    else return null;
  }
  const nodeCount = Number(nodes);
  const coordinatorCount = Number(coordinators);
  if (!Number.isInteger(nodeCount) || nodeCount < 1 || nodeCount > MAX_NODES) return null;
  if (!Number.isInteger(coordinatorCount) || coordinatorCount < 1 || coordinatorCount > MAX_COORDINATORS) return null;
  return { nodeCount, coordinatorCount };
}

const parsed = parseArgs(process.argv.slice(2));
if (!parsed) {
  console.error(usage);
  process.exit(1);
}
const { nodeCount, coordinatorCount } = parsed;

if (!process.env.REDIS_URL) {
  console.error("REDIS_URL is not set: cluster mode needs Redis. Start it with `docker compose -f src/docker/docker-compose.redis.yml up -d` and set REDIS_URL in .env.production.");
  process.exit(1);
}

const coordinatorEntry = path.join(root, "src", "cluster", "coordinator-main.ts");
if (!fs.existsSync(coordinatorEntry)) {
  console.error(`${coordinatorEntry} not found.`);
  process.exit(1);
}

const regionId = process.env.REGION_ID || "local";

function portFrom(value: string | undefined, fallback: number | null): number | null {
  const parsed = parseInt(value || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// The same reads as server.ts.
const baseGamePort = portFrom(process.env.WEBSRV_PORTSSL, null) ?? portFrom(process.env.GAME_PORT, 3000)!;
const baseHttpPort = portFrom(process.env.WEBSRV_PORT, null);
const baseInternalPort = portFrom(process.env.WEBSRV_INTERNAL_PORT, 3002)!;
// By default links get their own base (game port + 5), so a node's link port does not meet another node's
// game, HTTP or internal port (they step by PORT_STEP = 10). NODE_LINK_PORT=0 turns the links off on every node.
const linksOff = process.env.NODE_LINK_PORT?.trim() === "0";
const baseLinkPort = portFrom(process.env.NODE_LINK_PORT, null) ?? baseGamePort + 5;

const highest = Math.max(baseGamePort, baseHttpPort ?? 0, baseInternalPort, baseLinkPort) + PORT_STEP * nodeCount;
if (highest > 65535) {
  console.error(`Ports would pass 65535 (base ports + ${PORT_STEP * nodeCount}). Lower the base ports in .env.production.`);
  process.exit(1);
}

interface Child {
  name: string;
  proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  /** Resolves when the readiness line is printed, or when the process exits. */
  ready: Promise<void>;
}

const children: Child[] = [];
let stopping = false;

const COLORS = ["36", "33", "35", "32", "34", "91", "96", "93", "95", "92", "94", "31", "37", "90", "46", "43"];
const colored = process.stdout.isTTY === true;
const coordinatorName = (i: number) => (i === 1 ? "coordinator" : `coordinator-${i}`);
const coordinatorNames = new Set(Array.from({ length: coordinatorCount }, (_, i) => coordinatorName(i + 1)));
const nameWidth = Math.max(coordinatorName(coordinatorCount).length, `node-${nodeCount}`.length);

function prefix(name: string, colorIndex: number): string {
  const tag = `[${name}]`.padEnd(nameWidth + 2);
  return colored ? `\x1b[${COLORS[colorIndex % COLORS.length]}m${tag}\x1b[0m ` : `${tag} `;
}

function note(message: string) {
  process.stdout.write(`${prefix("harness", 12)}${message}\n`);
}

async function pump(stream: ReadableStream<Uint8Array>, out: NodeJS.WriteStream, tag: string, onLine?: (line: string) => void) {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, "");
      out.write(`${tag}${line}\n`);
      onLine?.(line);
      pending = pending.slice(newline + 1);
    }
  }
  pending += decoder.decode();
  if (pending) {
    out.write(`${tag}${pending}\n`);
    onLine?.(pending);
  }
}

function start(name: string, colorIndex: number, args: string[], env: Record<string, string>): Child {
  const proc = Bun.spawn([bun, ...args], {
    cwd: root,
    env: { ...process.env, ...env } as Record<string, string>,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const tag = prefix(name, colorIndex);
  let markReady = () => {};
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  const onLine = (line: string) => { if (line.includes(READY_LINE)) markReady(); };
  pump(proc.stdout, process.stdout, tag, onLine).catch(() => {});
  pump(proc.stderr, process.stderr, tag, onLine).catch(() => {});
  const child = { name, proc, ready };
  children.push(child);
  void proc.exited.then((code) => {
    markReady();
    if (!stopping) note(`${name} exited with code ${code}`);
    if (!stopping && coordinatorNames.has(name)) {
      const left = children.filter((c) => coordinatorNames.has(c.name) && c.proc.exitCode === null).length;
      if (left > 0) {
        note(`${left} coordinator(s) still running: a standby takes the lock once the leader's runs out (5 s)`);
      } else {
        const banner = "!!! EVERY COORDINATOR HAS EXITED: the nodes are still running WITHOUT a coordinator (no block assignment or rebalancing). Restart the harness. !!!";
        process.stderr.write(colored ? `\x1b[1;41;97m${banner}\x1b[0m\n` : `${banner}\n`);
      }
    }
    if (children.every((c) => c.proc.exitCode !== null)) process.exit(stopping ? 0 : code || 1);
  });
  return child;
}

async function stopAll(reason: string) {
  if (stopping) return;
  stopping = true;
  note(`${reason}: stopping ${children.length} process(es)`);
  // A console Ctrl+C already reached every child on Windows; an explicit kill could hard-terminate them.
  if (!(process.platform === "win32" && reason === "SIGINT")) {
    for (const child of children) {
      try { child.proc.kill("SIGINT"); } catch { /* already gone */ }
    }
  }
  const timeout = setTimeout(() => {
    for (const child of children) {
      if (child.proc.exitCode === null) {
        note(`${child.name} did not stop, killing it`);
        try { child.proc.kill("SIGKILL"); } catch { /* already gone */ }
      }
    }
  }, STOP_TIMEOUT_MS);
  await Promise.all(children.map((child) => child.proc.exited));
  clearTimeout(timeout);
  process.exit(0);
}

process.on("SIGINT", () => void stopAll("SIGINT"));
process.on("SIGTERM", () => void stopAll("SIGTERM"));
process.on("exit", () => {
  for (const child of children) {
    if (child.proc.exitCode === null) {
      try { child.proc.kill("SIGKILL"); } catch { /* already gone */ }
    }
  }
});

const clusterEnv = { CLUSTER: "true", CACHE: "redis", REGION_ID: regionId };

/** Deletes every `cells:*` key (SCAN, not KEYS: it does not block Redis on a large keyspace). How many it deleted. */
async function clearClusterState(url: string): Promise<number> {
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

// Before any child: block tables and the rest from an earlier run (other nodes, an old split) must not carry over.
try {
  note(`cleared ${await clearClusterState(process.env.REDIS_URL!)} cells:* key(s) from Redis`);
} catch (error) {
  console.error(`Could not clear the cluster state from Redis (is it running?): ${error}`);
  process.exit(1);
}

// The engine's own start script creates the config files first; once here, not once per node.
note("creating config files if missing");
const config = Bun.spawn([bun, "./src/utility/create_config.ts", "--environment", "production"], {
  cwd: root,
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
});
if ((await config.exited) !== 0) {
  console.error("create-config failed.");
  process.exit(1);
}

note(`region ${regionId}: starting ${coordinatorCount} coordinator(s) and ${nodeCount} node(s); Ctrl+C stops them`);
for (let i = 1; i <= coordinatorCount; i++) {
  // The split waits until every node is live: the nodes start one by one, and owned blocks never move.
  start(coordinatorName(i), 0, ["--env-file=.env.production", "./src/cluster/coordinator-main.ts"], {
    ...clusterEnv,
    CLUSTER_EXPECTED_NODES: String(nodeCount),
    CLUSTER_SETTLE_MS: String(nodeCount * READY_TIMEOUT_MS),
  });
}

for (let i = 1; i <= nodeCount; i++) {
  if (stopping) break;
  const offset = PORT_STEP * i;
  const gamePort = String(baseGamePort + offset);
  const env: Record<string, string> = {
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
  if (baseHttpPort !== null) env.WEBSRV_PORT = String(baseHttpPort + offset);
  note(`node-${i}: game/WebTransport port ${gamePort}, internal port ${env.WEBSRV_INTERNAL_PORT}, ${linksOff ? "links off" : `link port ${env.NODE_LINK_PORT}`}`);
  const node = start(`node-${i}`, i, ["--env-file=.env.production", "./src/socket/server.ts", "--sql-preconnect"], env);
  if (i < nodeCount) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), READY_TIMEOUT_MS); });
    const late = await Promise.race([node.ready.then(() => false), timedOut]);
    clearTimeout(timer);
    if (late) note(`node-${i} not ready after ${READY_TIMEOUT_MS / 1000} s, starting the next node anyway`);
  }
}
