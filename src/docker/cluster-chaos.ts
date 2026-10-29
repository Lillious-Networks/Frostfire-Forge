// Chaos run for the cells cluster (phase 7): a block moves, Redis goes away, a node dies. It drives the Docker test
// stack from outside and checks what the cluster wrote in Redis and logged.
//
// Start the stack first (from the engine repo root):
//   docker compose -f src/docker/docker-compose.cluster.yml --env-file src/docker/cluster.env up -d --build
// Then:  bun src/docker/cluster-chaos.ts
//   docker compose -f src/docker/docker-compose.cluster.yml --env-file src/docker/cluster.env down
//
// Only the test stack is touched: its own compose project, ports and database. The script reads no .env file and
// prints no configuration or log text. Exit code: 0 all checks passed, 1 a check failed, 2 the stack is not up. A SKIP line
// is a check that cannot fail in the current world (no creatures, no load in the block); it does not change the code.

import { join } from "node:path";
import { creatureTotal, ownerChanges, type Order } from "./chaos-moves";

const COMPOSE = join(import.meta.dir, "docker-compose.cluster.yml");
// Compose builds Redis' password and the nodes' REDIS_URL from this file, and refuses to run without it. The script only
// hands over its path; it never opens it.
const ENV_FILE = join(import.meta.dir, "cluster.env");
const NODES = ["node-1", "node-2", "node-3"] as const;
type Node = (typeof NODES)[number];

interface Owner { nodeId: string; epoch: number; since: number }
interface Table { epoch: number; owners: Record<string, Owner> }
interface Load { nodeId: string; at: number; players: number; creatures: number; creaturesTotal?: number; blocks: Record<string, number> }
interface Service { Service: string; State: string; Health?: string }
interface Ran { code: number; out: string; err: string }

const STORE_DOWN = "The cluster store is down";
const STORE_BACK = "The cluster store is back";
const FENCED = "is fenced";
// The nodes' own healthcheck (docker-compose.cluster.yml), run inside the node's container.
const STATUS_CHECK = "const r = await fetch('http://localhost:' + process.env.WEBSRV_PORTSSL + '/status').catch(() => ({ ok: false })); process.exit(r.ok ? 0 : 1)";
// Run inside the coordinator's container: makes a move order as the coordinator does, and tells the old owner.
const ORDER_SCRIPT = [
  "const move = JSON.parse(process.env.CHAOS_ORDER);",
  "const { RedisStore } = await import('/app/src/cluster/redisstore.ts');",
  "const { MoveOrders } = await import('/app/src/cluster/moveorders.ts');",
  "const { ClusterBus } = await import('/app/src/cluster/bus.ts');",
  "const { requireClusterKeys } = await import('/app/src/cluster/clusterkeys.ts');",
  "const { sealStore } = await import('/app/src/cluster/storeseal.ts');",
  "const store = sealStore(new RedisStore(), requireClusterKeys().store);",
  "const order = await new MoveOrders(store).create(move);",
  "await new ClusterBus(store, 'chaos', requireClusterKeys().bus).toNode(move.from, 'block-move', { id: order.id });",
  "console.log('ORDER ' + order.id);",
  "store.close();",
  "process.exit(0);",
].join("\n");

const results: boolean[] = [];
let skipped = 0;

function check(ok: boolean, what: string, detail = ""): boolean {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}: ${what}${detail ? ` (${detail})` : ""}`);
  return ok;
}

/** A check that cannot fail in this world: it is shown, but it is neither a pass nor a failure. */
function skip(what: string, reason: string): void {
  skipped++;
  console.log(`SKIP: ${what} (${reason})`);
}

const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";

async function compose(args: string[]): Promise<Ran> {
  const proc = Bun.spawn(["docker", "compose", "-f", COMPOSE, "--env-file", ENV_FILE, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
}

async function redis(...args: string[]): Promise<string> {
  // The test Redis has a password; the container holds it in REDIS_PASSWORD, so it never passes through this script.
  const ran = await compose(["exec", "-T", "redis", "sh", "-c", 'REDISCLI_AUTH="$REDIS_PASSWORD" exec redis-cli --raw "$@"', "sh", ...args]);
  if (ran.code !== 0) throw new Error(`redis-cli ${args[0]} failed: ${firstLine(ran.err)}`);
  return ran.out.trim();
}

async function getJson<T>(key: string): Promise<T | null> {
  const raw = await redis("GET", key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function keys(pattern: string): Promise<string[]> {
  return (await redis("--scan", "--pattern", pattern)).split("\n").map((key) => key.trim()).filter(Boolean).sort();
}

async function tables(): Promise<Map<string, Table>> {
  const all = new Map<string, Table>();
  for (const key of await keys("cells:blocks:*")) {
    const table = await getJson<Table>(key);
    if (table?.owners && typeof table.owners === "object") all.set(key.slice("cells:blocks:".length), table);
  }
  return all;
}

/** Every move order the coordinator still keeps (orders are sealed, but their fields read as plain JSON). */
async function moveOrders(): Promise<Map<string, Order>> {
  const orders = new Map<string, Order>();
  for (const id of (await redis("SMEMBERS", "cells:moves")).split("\n").map((line) => line.trim()).filter(Boolean)) {
    const order = await getJson<Order>(`cells:move:${id}`);
    if (order?.id === id) orders.set(id, order);
  }
  return orders;
}

const alive = async (node: Node) => (await redis("GET", `cells:alive:${node}`)) !== "";
const loadOf = (node: Node) => getJson<Load>(`cells:load:${node}`);

async function services(): Promise<Service[]> {
  const text = (await compose(["ps", "--all", "--format", "json"])).out.trim();
  if (!text) return [];
  // Older Compose prints one array, newer one object per line.
  if (text.startsWith("[")) return JSON.parse(text) as Service[];
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Service);
}

async function running(node: Node): Promise<boolean> {
  return (await services()).some((s) => s.Service === node && s.State === "running");
}

async function answers(node: Node): Promise<boolean> {
  return (await compose(["exec", "-T", node, "bun", "--eval", STATUS_CHECK])).code === 0;
}

async function logsSince(service: string, since: string): Promise<string> {
  const ran = await compose(["logs", "--no-color", "--since", since, service]);
  return ran.out + ran.err;
}

/** Docker's --since takes RFC 3339; two seconds back covers a host clock a little ahead of the VM's. */
const stamp = () => new Date(Date.now() - 2_000).toISOString();

/** Polls `probe` once a second until it answers a truthy value or `ms` pass. A probe that throws counts as not yet. */
async function until<T>(ms: number, probe: () => Promise<T | null | undefined | false>): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch {
      // Not yet (Redis restarting, a container starting).
    }
    if (Date.now() >= end) return null;
    await Bun.sleep(1_000);
  }
}

const ownersByBlock = (all: Map<string, Table>) => {
  const owners = new Map<string, Owner>();
  for (const [map, table] of all) for (const [key, owner] of Object.entries(table.owners)) owners.set(`${map}|${key}`, owner);
  return owners;
};

/** Every live node's creatures, awake or not (creaturesTotal: `creatures` is the awake ones). Null while a node has no report. */
async function totalCreatures(nodes: readonly Node[]): Promise<number | null> {
  return creatureTotal(await Promise.all(nodes.map((node) => loadOf(node))));
}

/** The total, once three reads a second apart agree (the reports are a second old at most). */
async function steadyCreatures(nodes: readonly Node[], ms: number): Promise<number | null> {
  let last: number | null = null;
  let same = 0;
  const steady = await until(ms, async () => {
    const total = await totalCreatures(nodes);
    same = total !== null && total === last ? same + 1 : 0;
    last = total;
    return same >= 2 ? { total } : null;
  });
  return steady?.total ?? null;
}

/** A block of `from` with a neighbour owned by another node; the one with the most load first (it has creatures). */
function edgeBlock(all: Map<string, Table>, from: Node, load: Load | null) {
  const found: Array<{ map: string; bx: number; by: number; to: string; blockEpoch: number; weight: number }> = [];
  for (const [map, table] of all) {
    for (const [key, owner] of Object.entries(table.owners)) {
      if (owner.nodeId !== from) continue;
      const [bx, by] = key.split(",").map(Number) as [number, number];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const next = table.owners[`${bx + dx},${by + dy}`];
        if (!next || next.nodeId === from) continue;
        found.push({ map, bx, by, to: next.nodeId, blockEpoch: owner.epoch, weight: load?.blocks[`${map}|${key}`] ?? 0 });
        break;
      }
    }
  }
  found.sort((a, b) => b.weight - a.weight);
  return found[0] ?? null;
}

async function stackIsUp(): Promise<boolean> {
  const list = await services();
  for (const name of ["redis", "mysql", "gateway", "coordinator", ...NODES]) {
    if (!list.some((s) => s.Service === name && s.State === "running")) {
      console.error(`The cluster test stack is not up (${name} is not running). Start it with:`);
      console.error("  docker compose -f src/docker/docker-compose.cluster.yml --env-file src/docker/cluster.env up -d --build");
      return false;
    }
  }
  const ready = await until(180_000, async () => {
    const now = await services();
    if (!NODES.every((node) => now.some((s) => s.Service === node && s.Health === "healthy"))) return false;
    if (!(await Promise.all(NODES.map(alive))).every(Boolean)) return false;
    // The coordinator splits the maps once all three nodes are live: wait until each of them owns blocks.
    const owners = new Set([...ownersByBlock(await tables()).values()].map((owner) => owner.nodeId));
    return NODES.every((node) => owners.has(node));
  });
  if (!ready) console.error("The nodes did not become healthy, live and block owners within 180 s");
  return ready !== null;
}

async function blockMoves(): Promise<void> {
  console.log("\n--- A block moves from node-1 to a neighbour");
  const before = await tables();
  const block = edgeBlock(before, "node-1", await loadOf("node-1"));
  if (!check(block !== null, "node-1 has a block with a neighbour on another node")) return;
  const move = block!;
  const where = `${move.map} ${move.bx},${move.by}`;
  const creaturesBefore = await steadyCreatures(NODES, 30_000);
  if (!check(creaturesBefore !== null, "the creature count is steady before the move", `${creaturesBefore}`)) return;

  const order = { map: move.map, bx: move.bx, by: move.by, from: "node-1", to: move.to, blockEpoch: move.blockEpoch };
  const made = await compose(["exec", "-T", "-e", `CHAOS_ORDER=${JSON.stringify(order)}`, "coordinator", "bun", "--eval", ORDER_SCRIPT]);
  const id = /ORDER (\S+)/.exec(made.out)?.[1];
  if (!check(made.code === 0 && !!id, "the move order is made and sent to node-1", made.code === 0 ? where : firstLine(made.err))) return;

  const end = await until(60_000, async () => {
    const state = (await getJson<{ state: string }>(`cells:move:${id}`))?.state;
    return state === "done" || state === "aborted" ? state : null;
  });
  if (!check(end === "done", `the order for ${where} ends "done"`, `${end ?? "still open after 60 s"}`)) return;

  const owner = (await tables()).get(move.map)?.owners[`${move.bx},${move.by}`];
  check(owner?.nodeId === move.to && owner.epoch > move.blockEpoch, `${move.to} owns ${where} at a higher epoch`,
    `${owner?.nodeId} at ${owner?.epoch}, was node-1 at ${move.blockEpoch}`);
  const key = `${move.map}|${move.bx},${move.by}`;
  // A block with no load before the move cannot show that the load left it.
  if (move.weight > 0) {
    const left = await until(15_000, async () => {
      const load = await loadOf("node-1");
      return load && !(load.blocks[key] > 0) ? true : null;
    });
    check(left !== null, `node-1 no longer reports load in ${where}`);
  } else {
    skip(`node-1 no longer reports load in ${where}`, "the block had no load before the move");
  }
  // With no creatures in the world a doubled or lost one cannot happen.
  if (creaturesBefore! > 0) {
    const after = await until(30_000, async () => ((await totalCreatures(NODES)) === creaturesBefore ? true : null));
    check(after !== null, "the creatures across the nodes add up as before: none doubled, none lost",
      `before ${creaturesBefore}, now ${await totalCreatures(NODES)}`);
  } else {
    skip("the creatures across the nodes add up as before: none doubled, none lost", "there are no creatures in the world");
  }
}

async function redisGoesAway(): Promise<void> {
  console.log("\n--- Redis goes away for 8 s");
  const before = ownersByBlock(await tables());
  const ordersBefore = await moveOrders();
  const deadBefore = new Set(await keys("cells:dead:*"));
  const since = stamp();
  const stopped = await compose(["stop", "redis"]);
  if (!check(stopped.code === 0, "Redis is stopped", firstLine(stopped.err))) return;
  try {
    await Bun.sleep(8_000);
    for (const node of NODES) {
      check(await running(node), `${node} keeps running without Redis`);
      check(await answers(node), `${node} answers /status without Redis`);
      const down = await until(10_000, async () => (await logsSince(node, since)).includes(STORE_DOWN));
      check(down !== null, `${node} logs that the store is down and its handoffs, delivery, directory and snapshots pause`);
    }
  } finally {
    await compose(["start", "redis"]);
  }
  const pong = await until(30_000, async () => (await redis("PING")) === "PONG");
  if (!check(pong !== null, "Redis is back")) return;
  check(ownersByBlock(await tables()).size === before.size, "the block tables survived Redis' restart", `${before.size} blocks before`);
  for (const node of NODES) {
    const back = await until(30_000, async () => (await alive(node)) && (await logsSince(node, since)).includes(STORE_BACK));
    check(back !== null, `${node} logs that the store is back, and beats again`);
  }
  // Long enough for the coordinator's dead-node confirmation to run out, had it started one.
  await Bun.sleep(10_000);
  const newDead = (await keys("cells:dead:*")).filter((key) => !deadBefore.has(key));
  check(newDead.length === 0, "no node was taken over during the outage", newDead.join(", "));
  for (const node of NODES) check(!(await logsSince(node, since)).includes(FENCED), `${node} was not fenced`);
  const after = ownersByBlock(await tables());
  // The rebalancer keeps working before and after the outage, and its own moves change owners too. A change is its own
  // when a move order into the new owner was committed since the start: one that was not committed then, or is new.
  // The orders, not the logs: they name the block and the new owner, and need no clock or text match. Stopping the
  // coordinator instead would also stop the dead-node confirmation the check above relies on.
  const { changed, unexplained } = ownerChanges(before, after, ordersBefore, await moveOrders());
  check(unexplained.length === 0, "no block changed owner during the outage, except by the rebalancer's own committed move orders",
    unexplained.length > 0 ? unexplained.slice(0, 5).join(", ") : `${changed.length} moved by the rebalancer`);
}

async function nodeDies(): Promise<void> {
  console.log("\n--- node-3 dies");
  const before = ownersByBlock(await tables());
  const owned = [...before].filter(([, owner]) => owner.nodeId === "node-3");
  if (!check(owned.length > 0, "node-3 owns blocks before it dies", `${owned.length}`)) return;
  const since = stamp();
  const killed = await compose(["kill", "node-3"]);
  if (!check(killed.code === 0, "node-3 is killed", firstLine(killed.err))) return;

  const takenOver = await until(45_000, async () => {
    if (!(await redis("GET", "cells:dead:node-3"))) return null;
    const now = ownersByBlock(await tables());
    return [...now.values()].some((owner) => owner.nodeId === "node-3") ? null : now;
  });
  if (!check(takenOver !== null, "the coordinator writes node-3's tombstone and gives away all its blocks within 45 s")) return;
  const wrong = owned.filter(([key, owner]) => {
    const next = takenOver!.get(key);
    return !next || !["node-1", "node-2"].includes(next.nodeId) || next.epoch <= owner.epoch;
  }).map(([key]) => key);
  check(wrong.length === 0, "every block of node-3 went to node-1 or node-2 at a higher epoch", wrong.slice(0, 5).join(", "));
  for (const node of ["node-1", "node-2"] as const) {
    check(await alive(node), `${node} is still live`);
    check(!(await logsSince(node, since)).includes(FENCED), `${node} was not fenced`);
  }

  console.log("\n--- node-3 starts again");
  const restartedAt = stamp();
  const started = await compose(["up", "-d", "--no-deps", "node-3"]);
  if (!check(started.code === 0, "node-3 is started again", firstLine(started.err))) return;
  const live = await until(180_000, async () => {
    const healthy = (await services()).some((s) => s.Service === "node-3" && s.Health === "healthy");
    return healthy && (await alive("node-3"));
  });
  check(live !== null, "node-3's new run is healthy and live");
  await Bun.sleep(10_000);
  check(await running("node-3"), "node-3 stays up: the old tombstone is not its new run's");
  check(!(await logsSince("node-3", restartedAt)).includes(FENCED), "node-3's new run was not fenced");
}

async function main(): Promise<number> {
  if (!(await stackIsUp())) return 2;
  await blockMoves();
  await redisGoesAway();
  await nodeDies();
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed, ${skipped} skipped`);
  return failed === 0 ? 0 : 1;
}

process.exit(await main());
