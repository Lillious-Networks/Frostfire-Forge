import query from "../controllers/sqldatabase";
import log from "../modules/logger";
import assetCache from "../services/assetCache";

function toMysqlDatetime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * NPCs placed by the maps themselves (particle emitters from a "Particles" object layer, see assetloader). They never
 * touch the database; list() appends them so every cache reload keeps them.
 */
let mapNpcs: Npc[] = [];

/**
 * Whether this server has read the npcs table. Until it has, list() reads it; after that list() answers the NPCs
 * held, which every write here keeps in step. Lowered when a write failed and the table could not be read again.
 */
let loaded = false;

/** The columns add() and update() write, in the order their statements name them. */
const COLUMNS = [
  "last_updated", "map", "name", "position", "direction", "hidden", "script", "dialog", "gossip", "particles", "quest_giver",
  "sprite_type", "sprite_body", "sprite_head", "sprite_helmet", "sprite_shoulderguards", "sprite_neck",
  "sprite_hands", "sprite_chest", "sprite_feet", "sprite_legs", "sprite_weapon", "vendor_items", "innkeeper",
] as const;
type Written = Record<(typeof COLUMNS)[number], unknown>;

/**
 * What an NPC stocks, from its column (text, or already read by a JSON column) or from an NPC as
 * held: the entries that are an item's name and a whole price of 0 or more. Anything else is no
 * stock. Whether the items exist is not asked here (see vendors.readVendorItems for what an editor
 * sends).
 */
function stockOf(stored: unknown): VendorItem[] {
  let list = stored;
  if (typeof stored === "string") {
    try {
      list = JSON.parse(stored);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter((entry) => entry && typeof entry.item === "string" && entry.item && Number.isInteger(entry.price) && entry.price >= 0)
    .map((entry) => ({ item: entry.item as string, price: entry.price as number }));
}

/** The stock as its column keeps it: text, and nothing for an NPC that stocks nothing. */
function stockText(stock: unknown): string | null {
  const list = stockOf(stock);
  return list.length > 0 ? JSON.stringify(list) : null;
}

/** An npcs row as the server holds it. `row` is what the table gives, or what was just written to it. */
function fromRow(npc: any): Npc {
  const position: PositionData = {
    x: Number(npc?.position?.split(",")[0]),
    y: Number(npc?.position?.split(",")[1]),
    direction: npc?.direction || "down",
  };

  return {
    id: npc?.id as number,
    last_updated: (npc?.last_updated as number) || null,
    map: npc?.map as string,
    name: npc?.name || null,
    position,
    hidden: npc?.hidden === 1,
    script: npc?.script as string,
    dialog: npc?.dialog as string,
    gossip: (npc?.gossip ?? null) as Nullable<string>,
    particles: npc?.particles as Particle[],
    quest_giver: npc?.quest_giver === 1 || npc?.quest_giver === true,
    sprite_type: (npc?.sprite_type as 'none' | 'static' | 'animated') || 'none',
    sprite_body: npc?.sprite_body || null,
    sprite_head: npc?.sprite_head || null,
    sprite_helmet: npc?.sprite_helmet || null,
    sprite_shoulderguards: npc?.sprite_shoulderguards || null,
    sprite_neck: npc?.sprite_neck || null,
    sprite_hands: npc?.sprite_hands || null,
    sprite_chest: npc?.sprite_chest || null,
    sprite_feet: npc?.sprite_feet || null,
    sprite_legs: npc?.sprite_legs || null,
    sprite_weapon: npc?.sprite_weapon || null,
    vendor_items: stockOf(npc?.vendor_items),
    innkeeper: npc?.innkeeper === 1 || npc?.innkeeper === true,
  };
}

/** The columns that keep a flag, 0 or 1, where every other keeps text. */
const FLAGS = new Set<string>(["hidden", "quest_giver", "innkeeper"]);

/** When a row was written, as its DATETIME column keeps it: to the second. */
const writtenAt = (last_updated: string) => new Date(`${last_updated.replace(" ", "T")}Z`) as unknown as number;

/**
 * The NPC a row holds once `written` has been written to it: every column but the flags keeps text (a statement
 * sends anything else as its text), and nothing where it was given nothing.
 */
function asWritten(id: Nullable<number>, written: Written): Npc {
  const row: Record<string, unknown> = { id };
  for (const column of COLUMNS) {
    const value = written[column];
    row[column] = FLAGS.has(column) || value === null || value === undefined ? value ?? null : String(value);
  }
  return { ...fromRow(row), last_updated: writtenAt(String(written.last_updated)) };
}

const sameId = (id: unknown) => (npc: Npc) => Number(npc.id) === Number(id);

/** The table's NPCs as held: the maps' own are not rows of it. */
async function stored(): Promise<Npc[]> {
  const list = await assetCache.get("npcs");
  return (Array.isArray(list) ? (list as Npc[]) : []).filter((npc) => !npcs.isMapNpc(npc));
}

/** Holds `rows` as the table's NPCs, the maps' own after them, and answers the whole list. */
async function hold(rows: Npc[]): Promise<Npc[]> {
  const list = [...rows, ...mapNpcs];
  await assetCache.set("npcs", list);
  return list;
}

/** Reads the table and holds what it has: at startup, and after a write whose outcome is not known. */
async function load(): Promise<Npc[]> {
  const response = (await query("SELECT * FROM npcs")) as any[];
  const list = await hold(response.map(fromRow));
  loaded = true;
  return list;
}

// One write at a time: each changes the NPCs held and puts them back.
let writing: Promise<unknown> = Promise.resolve();

/**
 * A statement that changes the npcs table, then `change` made to the NPCs held (it is handed them and the statement's
 * answer; null when the answer does not say what the table now holds, and the table is read instead). A statement
 * that throws may still have been applied (a timeout, say), so the table is read again rather than the NPCs left as
 * they were; if it cannot be read either, the next list() reads it.
 */
function write(sql: string, values: unknown[], change: (rows: Npc[], response: any) => Npc[] | null): Promise<any> {
  const work = async () => {
    let response;
    try {
      response = await query(sql, values as any[]);
    } catch (error) {
      loaded = false;
      await load().catch((again) => log.error(`Could not read the NPCs again after a write that failed: ${again}`));
      throw error;
    }
    const next = change(await stored(), response);
    if (next) {
      await hold(next);
    } else {
      loaded = false;
      await load();
    }
    return response;
  };
  const run = writing.then(work, work);
  writing = run.catch(() => {});
  return run;
}

const npcs = {
  setMapNpcs(list: Npc[]) {
    mapNpcs = list;
  },

  getMapNpcs(): Npc[] {
    return mapNpcs;
  },

  /** Map-placed NPCs carry negative ids so they never collide with database rows. */
  isMapNpc(npc: Pick<Npc, "id"> | null | undefined): boolean {
    return typeof npc?.id === "number" && npc.id < 0;
  },

  async add(npc: Npc) {
    if (!npc || !npc?.map || !npc?.position) return;
    const written: Written = {
      last_updated: toMysqlDatetime(Date.now()),
      map: npc.map,
      name: npc.name || null,
      position: `${npc.position.x || 0},${npc.position.y || 0}`,
      direction: npc.position.direction || "down",
      hidden: npc.hidden ? 1 : 0,
      script: npc.script || null,
      dialog: npc.dialog || null,
      gossip: npc.gossip || null,
      particles: Array.isArray(npc.particles)
        ? npc.particles.join(",")
        : (npc.particles || ""),
      quest_giver: npc.quest_giver ? 1 : 0,
      sprite_type: npc.sprite_type || "none",
      sprite_body: npc.sprite_body || null,
      sprite_head: npc.sprite_head || null,
      sprite_helmet: npc.sprite_helmet || null,
      sprite_shoulderguards: npc.sprite_shoulderguards || null,
      sprite_neck: npc.sprite_neck || null,
      sprite_hands: npc.sprite_hands || null,
      sprite_chest: npc.sprite_chest || null,
      sprite_feet: npc.sprite_feet || null,
      sprite_legs: npc.sprite_legs || null,
      sprite_weapon: npc.sprite_weapon || null,
      vendor_items: stockText(npc.vendor_items),
      innkeeper: npc.innkeeper ? 1 : 0,
    };

    return await write(
      `INSERT INTO npcs (last_updated, map, name, position, direction, hidden, script, dialog, gossip, particles, quest_giver,
        sprite_type, sprite_body, sprite_head, sprite_helmet, sprite_shoulderguards, sprite_neck,
        sprite_hands, sprite_chest, sprite_feet, sprite_legs, sprite_weapon, vendor_items, innkeeper)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      COLUMNS.map((column) => written[column]),
      // The new NPC is what was written, under the id the database answered with. An NPC is addressed by its id:
      // an answer without one leaves it unknown, and the table is read instead.
      (rows, response) => {
        const id = Number(response?.lastInsertRowid);
        return Number.isInteger(id) && id > 0 ? [...rows, asWritten(id, written)] : null;
      }
    );
  },

  async remove(npc: Npc) {
    if (!npc?.id) return;
    return await write("DELETE FROM npcs WHERE id = ?", [npc.id], (rows) => rows.filter((held) => !sameId(npc.id)(held)));
  },

  /** Every NPC: the table's, as held, and the maps' own. The table is read the first time a server asks. */
  async list() {
    if (!loaded || !Array.isArray(await assetCache.get("npcs"))) return load();
    return [...(await stored()), ...mapNpcs];
  },

  /** Reads the table again and holds what it has. */
  async reload() {
    return load();
  },

  /** The NPC of that id as held, in a list as the table's rows were: an empty one when there is none. */
  async find(npc: Npc) {
    if (!npc?.id) return;
    return (await this.list()).filter((held) => !this.isMapNpc(held) && sameId(npc.id)(held));
  },

  async update(npc: Npc) {
    if (!npc?.id || !npc?.map || !npc?.position) return;
    const written: Written = {
      last_updated: toMysqlDatetime(Date.now()),
      map: npc.map,
      name: npc.name || null,
      position: `${npc.position.x || 0},${npc.position.y || 0}`,
      direction: npc.position.direction,
      hidden: npc.hidden ? 1 : 0,
      script: npc.script,
      dialog: npc.dialog,
      gossip: npc.gossip || null,
      particles: Array.isArray(npc.particles)
        ? npc.particles.join(",")
        : (npc.particles || ""),
      quest_giver: npc.quest_giver ? 1 : 0,
      sprite_type: npc.sprite_type || "none",
      sprite_body: npc.sprite_body || null,
      sprite_head: npc.sprite_head || null,
      sprite_helmet: npc.sprite_helmet || null,
      sprite_shoulderguards: npc.sprite_shoulderguards || null,
      sprite_neck: npc.sprite_neck || null,
      sprite_hands: npc.sprite_hands || null,
      sprite_chest: npc.sprite_chest || null,
      sprite_feet: npc.sprite_feet || null,
      sprite_legs: npc.sprite_legs || null,
      sprite_weapon: npc.sprite_weapon || null,
      vendor_items: stockText(npc.vendor_items),
      innkeeper: npc.innkeeper ? 1 : 0,
    };

    return await write(
      `UPDATE npcs SET last_updated = ?, map = ?, name = ?, position = ?, direction = ?, hidden = ?, script = ?,
        dialog = ?, gossip = ?, particles = ?, quest_giver = ?, sprite_type = ?, sprite_body = ?, sprite_head = ?,
        sprite_helmet = ?, sprite_shoulderguards = ?, sprite_neck = ?, sprite_hands = ?,
        sprite_chest = ?, sprite_feet = ?, sprite_legs = ?, sprite_weapon = ?, vendor_items = ?, innkeeper = ? WHERE id = ?`,
      [...COLUMNS.map((column) => written[column]), npc.id],
      (rows) => rows.map((held) => (sameId(npc.id)(held) ? asWritten(held.id, written) : held))
    );
  },

  async move(npc: Npc) {
    if (!npc?.id || !npc?.position) return;
    const last_updated = toMysqlDatetime(Date.now());
    // The position as add() and update() write it, and as list() reads it.
    const x = npc.position.x || 0;
    const y = npc.position.y || 0;

    return await write(
      "UPDATE npcs SET last_updated = ?, position = ? WHERE id = ?",
      [last_updated, `${x},${y}`, npc.id],
      (rows) => rows.map((held) => (sameId(npc.id)(held)
        ? { ...held, last_updated: writtenAt(last_updated), position: { ...held.position, x: Number(x), y: Number(y) } }
        : held))
    );
  },
};

export default npcs;
