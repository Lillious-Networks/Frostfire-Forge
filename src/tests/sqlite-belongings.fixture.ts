// Run by sqlite-belongings.test.ts in a process of its own, against a SQLite file made for it: the
// real inventory and currency systems over the real database layer, with the tables as
// src/utility/database_setup_sqlite.ts makes them.

import query from "../controllers/sqldatabase";
import assetCache from "../services/assetCache";
import { atomically } from "../services/batch";
import { clearCaches } from "../services/datacache";
import currency from "../systems/currency";
import homes from "../systems/homes";
import inventory from "../systems/inventory";

const out: Record<string, unknown> = {};

await query(`
  CREATE TABLE inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    item TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    equipped INTEGER NOT NULL DEFAULT 0,
    slot INTEGER DEFAULT NULL,
    bag_slot INTEGER DEFAULT NULL
  )
`);
await query(`
  CREATE TABLE currency (
    username TEXT NOT NULL UNIQUE PRIMARY KEY,
    copper INTEGER NOT NULL DEFAULT 0,
    silver INTEGER NOT NULL DEFAULT 0,
    gold INTEGER NOT NULL DEFAULT 0
  )
`);
await assetCache.set("items", ["Iron Ore", "Rat's \"Tail\"", "Small Pouch"].map((name) => ({ name, quality: "common", type: "material", description: "", icon: null })));

const held = () => query("SELECT username, item, quantity, slot FROM inventory ORDER BY id");
const purses = () => query("SELECT username, copper, silver, gold FROM currency ORDER BY username");
const tried = (work: Promise<unknown>) => work.then(() => "ran", (error) => String(error?.message ?? error));

// An item the player does not hold yet is an INSERT IGNORE; coins are always an upsert.
out.steps = [
  await tried(inventory.add("hero", { name: "Iron Ore", quantity: 5 })),
  await tried(inventory.add("hero", { name: "iron ore", quantity: 3 })),
  await tried(inventory.add("hero", { name: "Rat's \"Tail\"", quantity: 1 })),
  await tried(inventory.saveSlots("hero", [{ item: "Iron Ore", slot: 4, bag_slot: 0 }])),
  await tried(currency.add("hero", { copper: 50, silver: 2, gold: 1 })),
  await tried(currency.add("hero", { copper: 60, silver: 0, gold: 0 })),
  await tried(currency.remove("hero", { copper: 5, silver: 1, gold: 0 })),
];
out.afterSteps = { held: await held(), purses: await purses() };

// A purchase, as one batch: the coins and the new item are written together.
out.bought = await tried(atomically(["hero"], async (batch) => {
  await currency.remove("hero", { copper: 0, silver: 0, gold: 1 }, batch);
  await inventory.add("hero", { name: "Small Pouch", quantity: 2 }, batch);
}));

// A player's home: every write of it is an upsert on the player's one row.
await query(`
  CREATE TABLE player_home (
    username TEXT NOT NULL PRIMARY KEY,
    npc_id INTEGER DEFAULT NULL,
    offset_x INTEGER NOT NULL DEFAULT 0,
    offset_y INTEGER NOT NULL DEFAULT 0,
    used_at INTEGER NOT NULL DEFAULT 0
  )
`);
const inn = (id: number, name: string, map: string, x: number, y: number) => ({ id, name, map, hidden: false, innkeeper: true, position: { x, y, direction: "down" } });
await assetCache.set("npcs", [inn(7, "The Rusty Anchor", "harbor", 400, 300), inn(12, "Leaf Lodge", "forest.json", 100, 100)]);
const at = (username: string, map: string, x: number, y: number) => ({ username, location: { map, position: { x, y } } });
const WENT = 1_700_000_000_000;
out.homeSteps = [
  await tried(homes.set(at("hero", "harbor", 430, 340), inn(7, "", "harbor", 400, 300))),
  await tried(homes.arrive("hero", WENT)),
  await tried(homes.set(at("hero", "forest", 95, 108), inn(12, "", "forest", 100, 100))),
  await tried(homes.arrive("ally", WENT + 500)),
  await tried(homes.set(at("ally", "harbor", 430, 340), inn(7, "", "harbor", 400, 300))),
];
await homes.innGone(7);
out.homes = await query("SELECT username, npc_id, offset_x, offset_y, used_at FROM player_home ORDER BY used_at");

// What the systems answer, once everything they hold is forgotten, is what the tables hold.
await clearCaches();
out.homeRead = { hero: await homes.where("hero"), ally: await homes.where("ally"), cooldown: await homes.cooldownLeft("hero", WENT + 1000) };
out.read = {
  held: (await inventory.get("hero")).map((row: any) => [row.name, row.quantity]),
  purse: await currency.get("hero"),
};
out.tables = { held: await held(), purses: await purses() };

console.log("RESULT " + JSON.stringify(out));
process.exit(0);
