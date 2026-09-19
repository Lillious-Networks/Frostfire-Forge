/**
 * Creature load test.
 *
 * Seeds a map with spawns, then samples the running game server's creature
 * tick timings so the 100ms AI tick can be checked under load. It does not
 * connect clients - run `bun benchmark` alongside it for player load.
 *
 *   bun creature-loadtest seed --count 2000 --map main
 *   bun creature-loadtest watch --seconds 120
 *   bun creature-loadtest clean
 *
 * Seeded rows are named with a fixed prefix so `clean` can remove exactly what
 * this tool created and nothing else.
 */
import log from "../modules/logger";
import assetCache from "../services/assetCache";
import repository from "../systems/creatures/repository";
import { decodeCollisionRLE, NavGrid, FOOT_H } from "../systems/creatures/navgrid";
import { serverFetch } from "../modules/https_servers.ts";

const PREFIX = "[loadtest]";
// The game server's internal HTTP API runs over TLS with the same (often
// self-signed) certificate as the game port, so this goes through serverFetch.
const STATS_URL = `https://127.0.0.1:${process.env.WEBSRV_INTERNAL_PORT || "3002"}/creature-stats`;

interface Options {
  count: number;
  map: string;
  seconds: number;
  interval: number;
  wander: number;
  movement: "idle" | "wander" | "patrol";
  url: string;
}

function parseArgs(argv: string[]): { command: string; options: Options } {
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : "watch";
  const options: Options = {
    count: 2000,
    map: "",
    seconds: 60,
    interval: 5,
    wander: 8,
    movement: "wander",
    url: STATS_URL,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag?.startsWith("--")) continue;
    switch (flag) {
      case "--count": options.count = Math.max(1, parseInt(value) || 0); i++; break;
      case "--map": options.map = String(value ?? ""); i++; break;
      case "--seconds": options.seconds = Math.max(1, parseInt(value) || 0); i++; break;
      case "--interval": options.interval = Math.max(1, parseInt(value) || 0); i++; break;
      case "--wander": options.wander = Math.max(0, parseInt(value) || 0); i++; break;
      case "--movement": options.movement = (value as Options["movement"]) ?? "wander"; i++; break;
      case "--url": options.url = String(value ?? STATS_URL); i++; break;
    }
  }
  return { command, options };
}

// ----------------------------------------------------------------- seeding

/** A cheap, harmless creature: passive, no loot, no XP, so a run cannot grief live players. */
function loadTestTemplate(): any {
  return {
    id: 0,
    name: `${PREFIX} Target Dummy`,
    subname: "load test",
    level_min: 1,
    level_max: 1,
    rank: "normal",
    creature_type: "critter",
    stance: "passive",
    health_base: 100,
    health_per_level: 0,
    armor: 0,
    damage_min: 1,
    damage_max: 1,
    attack_speed_ms: 2000,
    ranged: false,
    move_speed_walk: 2.5,
    move_speed_run: 7,
    aggro_radius_override: null,
    assist_radius: 0,
    call_for_help_radius: 0,
    flee_at_hp_pct: 0,
    flee_duration_ms: 4000,
    leash_override: null,
    regen_ooc: true,
    xp_mult: 0,
    loot_table_id: null,
    gold_min: 0,
    gold_max: 0,
    sprite_type: "none",
    sprite: "",
    sprite_head: "",
    scale: 1,
    // NO_XP | NO_SOCIAL_AGGRO
    flags: (1 << 3) | (1 << 8),
  };
}

async function walkablePoints(map: string, count: number): Promise<Array<{ x: number; y: number }>> {
  const rle = (await assetCache.getNested(map, "collision")) as number[] | null;
  const props = ((await assetCache.get("mapProperties")) || []) as any[];
  const prop = props.find((p) => String(p?.name ?? "").replace(".json", "") === map);
  const tileWidth = Number(prop?.tilewidth) || 32;
  const tileHeight = Number(prop?.tileheight) || 32;

  const points: Array<{ x: number; y: number }> = [];
  if (!Array.isArray(rle) || rle.length < 2) {
    log.warn(`No collision data for "${map}"; spawning on a plain grid instead.`);
    const side = Math.ceil(Math.sqrt(count));
    for (let i = 0; i < count; i++) {
      points.push({ x: (i % side) * tileWidth * 2 + 64, y: Math.floor(i / side) * tileHeight * 2 + 64 });
    }
    return points;
  }

  const decoded = decodeCollisionRLE(rle);
  if (!decoded) {
    log.error(`Collision data for "${map}" could not be decoded.`);
    return points;
  }
  const grid = new NavGrid(decoded.width, decoded.height, tileWidth, tileHeight, decoded.blocked);
  const maxX = decoded.width * tileWidth;
  const maxY = decoded.height * tileHeight;

  // Rejection sampling: far cheaper than scanning a big map for open tiles.
  let attempts = 0;
  while (points.length < count && attempts < count * 200) {
    attempts++;
    const x = Math.floor(Math.random() * maxX);
    const y = Math.floor(Math.random() * maxY);
    if (y < FOOT_H) continue;
    if (!grid.isWalkable(x, y)) continue;
    points.push({ x, y });
  }
  if (points.length < count) {
    log.warn(`Only found ${points.length} walkable spots on "${map}" after ${attempts} tries.`);
  }
  return points;
}

/**
 * Maps and collision live in the asset cache, which only the game server fills.
 * This script runs on its own, so load the assets the same way the server does.
 */
async function loadAssets(): Promise<void> {
  const cached = ((await assetCache.get("mapProperties")) || []) as any[];
  if (cached.length > 0) return;
  log.info("Loading assets (maps, collision)...");
  // Side-effectful module: importing it performs the whole load.
  await import("../modules/assetloader");
}

async function seed(options: Options): Promise<void> {
  await loadAssets();
  const maps = ((await assetCache.get("mapProperties")) || []) as any[];
  const names = maps.map((m) => String(m?.name ?? "").replace(".json", "")).filter(Boolean);
  const map = options.map || names[0];
  if (!map) {
    log.error("No maps found. Is the asset server running, and does this .env point at it?");
    return;
  }
  if (!names.includes(map)) {
    log.error(`Map "${map}" not found. Available: ${names.join(", ")}`);
    return;
  }

  const existing = (await repository.listTemplates()).find((t) => t.name.startsWith(PREFIX));
  const templateId = existing?.id ?? (await repository.saveTemplate(loadTestTemplate()));
  log.info(`Using template #${templateId} on map "${map}"`);

  const points = await walkablePoints(map, options.count);
  const started = performance.now();
  for (let i = 0; i < points.length; i++) {
    await repository.saveSpawn({
      id: 0,
      template_id: templateId,
      map,
      x: points[i].x,
      y: points[i].y,
      direction: "down",
      layer_policy: "per_layer",
      respawn_min_s: 60,
      respawn_max_s: 120,
      wander_radius: options.movement === "wander" ? options.wander : 0,
      movement_type: options.movement,
      patrol_path_id: null,
      link_group_id: null,
      pool_id: null,
    });
    if ((i + 1) % 250 === 0) log.info(`  ${i + 1}/${points.length} spawns written...`);
  }

  log.success(`Seeded ${points.length} spawns in ${((performance.now() - started) / 1000).toFixed(1)}s.`);
  log.info("Restart the game server (or save any creature in the editor) so it picks them up.");
}

async function clean(): Promise<void> {
  const templates = (await repository.listTemplates()).filter((t) => t.name.startsWith(PREFIX));
  if (templates.length === 0) {
    log.info("Nothing to clean: no load test templates found.");
    return;
  }
  const spawns = await repository.listSpawns();
  for (const template of templates) {
    const mine = spawns.filter((s) => s.template_id === template.id);
    for (const spawn of mine) await repository.deleteSpawn(spawn.id);
    // Deleting the template also clears any spawns that slipped through.
    await repository.deleteTemplate(template.id);
    log.success(`Removed template #${template.id} and ${mine.length} spawn(s).`);
  }
  log.info("Restart the game server to despawn anything still live.");
}

// ----------------------------------------------------------------- watching

interface TickStats {
  creatures: number;
  awake: number;
  dormant: number;
  observed: number;
  inCombat: number;
  tick: { p50: number; p95: number; p99: number; max: number; budgetPctP95: number; count: number; avgCreaturesPerTick: number };
  phases?: Record<string, { avg: number; max: number; calls: number }>;
}

async function fetchStats(url: string, reset = false): Promise<TickStats | null> {
  const target = reset ? `${url}?reset=1` : url;
  try {
    const response = await serverFetch(target);
    if (!response.ok) throw new Error(`status ${response.status}`);
    return (await response.json()) as TickStats;
  } catch (error) {
    // Older configs serve this port in the clear; try that before giving up.
    if (target.startsWith("https://")) {
      try {
        const response = await fetch(target.replace("https://", "http://"));
        if (response.ok) return (await response.json()) as TickStats;
      } catch {
        // Fall through to the error below.
      }
    }
    log.error(`Could not read ${target}: ${(error as Error).message}`);
    log.error("Is the game server running, and is WEBSRV_INTERNAL_PORT correct?");
    log.error("Note: this needs a server build that has the /creature-stats route.");
    return null;
  }
}

async function watch(options: Options): Promise<void> {
  // Start a clean measurement window.
  if (!(await fetchStats(options.url, true))) return;
  log.info(`Sampling every ${options.interval}s for ${options.seconds}s...`);

  const p95s: number[] = [];
  const deadline = Date.now() + options.seconds * 1000;
  let last: TickStats | null = null;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, options.interval * 1000));
    const stats = await fetchStats(options.url);
    if (!stats) return;
    last = stats;
    p95s.push(stats.tick.p95);
    log.info(
      `creatures ${stats.creatures} (awake ${stats.awake}, dormant ${stats.dormant}, fighting ${stats.inCombat}) | ` +
      `tick p50 ${stats.tick.p50}ms p95 ${stats.tick.p95}ms max ${stats.tick.max}ms | ${stats.tick.budgetPctP95}% of budget`
    );
  }

  if (!last) return;
  const worst = Math.max(...p95s);
  log.info("");
  log.info("--- creature load test ---");
  log.info(`creatures:        ${last.creatures} (${last.awake} awake, ${last.dormant} dormant)`);
  log.info(`ticked per tick:  ${last.tick.avgCreaturesPerTick} average`);
  log.info(`tick p50/p95/p99: ${last.tick.p50} / ${last.tick.p95} / ${last.tick.p99} ms`);
  log.info(`tick max:         ${last.tick.max} ms`);
  log.info(`worst p95 seen:   ${worst} ms of the ${100}ms budget`);
  if (last.phases) {
    log.info("");
    log.info("per phase (avg / max ms, calls):");
    for (const [name, phase] of Object.entries(last.phases)) {
      if (phase.calls === 0) continue;
      log.info(`  ${name.padEnd(8)} ${String(phase.avg).padStart(8)} / ${String(phase.max).padStart(8)}   ${phase.calls}`);
    }
    // The phase with the biggest max is what to optimise first.
    const worstPhase = Object.entries(last.phases)
      .filter(([, p]) => p.calls > 0)
      .sort((a, b) => b[1].max - a[1].max)[0];
    if (worstPhase) log.info(`worst spike came from "${worstPhase[0]}" at ${worstPhase[1].max}ms`);
  }
  if (worst < 20) log.success("PASS: p95 stayed under the 20ms target.");
  else if (worst < 50) log.warn("MARGINAL: p95 over 20ms. It still fits the tick, but headroom is thin.");
  else log.error("FAIL: p95 over 50ms. The creature tick is eating the frame budget.");
}

async function status(options: Options): Promise<void> {
  const stats = await fetchStats(options.url);
  if (stats) log.info(JSON.stringify(stats, null, 2));
}

const { command, options } = parseArgs(process.argv.slice(2));

switch (command) {
  case "seed":
    await seed(options);
    break;
  case "clean":
    await clean();
    break;
  case "status":
    await status(options);
    break;
  case "watch":
    await watch(options);
    break;
  default:
    log.error(`Unknown command "${command}". Use: seed | watch | status | clean`);
}

process.exit(0);
