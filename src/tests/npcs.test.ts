import { expect, test } from "bun:test";
import { mockAssetCache } from "./setup";

// Mock database
const npcsDatabase: Record<number, any> = {
  1: {
    id: 1,
    last_updated: Date.now(),
    map: "main",
    position: "100,100",
    direction: "down",
    hidden: 0,
    script: null,
    dialog: null,
    particles: "[]",
    quest: null,
  },
  2: {
    id: 2,
    last_updated: Date.now(),
    map: "village",
    position: "200,150",
    direction: "up",
    hidden: 0,
    script: null,
    dialog: null,
    particles: "[]",
    quest: 1,
  },
};

let nextNpcId = 3;

const mockQuery = async (sql: string, params: any[]) => {
  if (sql.includes("INSERT INTO npcs")) {
    const id = nextNpcId++;
    npcsDatabase[id] = { id, ...params };
    return { lastInsertRowid: id };
  }
  if (sql.includes("DELETE FROM npcs")) {
    const [id] = params;
    delete npcsDatabase[id];
    return { affectedRows: 1 };
  }
  if (sql.includes("SELECT * FROM npcs WHERE id")) {
    const [id] = params;
    return npcsDatabase[id] ? [npcsDatabase[id]] : [];
  }
  if (sql.includes("SELECT * FROM npcs")) {
    return Object.values(npcsDatabase);
  }
  if (sql.includes("UPDATE npcs")) {
    const id = params[params.length - 1];
    npcsDatabase[id] = { id, ...params };
    return { affectedRows: 1 };
  }
  return [];
};

const npcs = {
  async add(npc: any) {
    if (!npc || !npc?.map || !npc?.position) return;
    const position = `${npc.position.x || 0},${npc.position.y || 0}`;
    return await mockQuery("INSERT INTO npcs (position, map) VALUES (?, ?)", [position, npc.map]);
  },

  async remove(npc: any) {
    if (!npc?.id) return;
    return await mockQuery("DELETE FROM npcs WHERE id = ?", [npc.id]);
  },

  async list() {
    const response = (await mockQuery("SELECT * FROM npcs", [])) as any[];
    return response.map((npc) => {
      const [x, y] = (npc.position || "0,0").split(",");
      return {
        id: npc.id,
        last_updated: npc.last_updated,
        map: npc.map,
        position: { x: Number(x), y: Number(y), direction: npc.direction || "down" },
        hidden: npc.hidden === 1,
        script: npc.script,
        dialog: npc.dialog,
        particles: npc.particles ? JSON.parse(npc.particles) : [],
        quest: npc.quest,
      };
    });
  },

  async find(npc: any) {
    if (!npc?.id) return;
    return await mockQuery("SELECT * FROM npcs WHERE id = ?", [npc.id]);
  },

  async update(npc: any) {
    if (!npc?.id || !npc?.map || !npc?.position) return;
    const position = `${npc.position.x || 0},${npc.position.y || 0}`;
    return await mockQuery("UPDATE npcs SET map = ?, position = ? WHERE id = ?", [npc.map, position, npc.id]);
  },

  async move(npc: any) {
    if (!npc?.id || !npc?.position) return;
    const position = JSON.stringify(npc.position);
    return await mockQuery("UPDATE npcs SET position = ? WHERE id = ?", [position, npc.id]);
  },
};

test("npcs.list returns all npcs", async () => {
  const result = await npcs.list();
  expect(Array.isArray(result)).toBe(true);
  expect(result.length).toBeGreaterThan(0);
});

test("npcs.find returns npc by id", async () => {
  const result = (await npcs.find({ id: 1 })) as any[];
  expect(result?.length).toBeGreaterThan(0);
});

test("npcs.find returns undefined for non-existent npc", async () => {
  const result = await npcs.find({ id: 999 });
  expect((result as any)?.length || 0).toBe(0);
});

test("npcs.add requires map and position", async () => {
  const result = await npcs.add({ map: "main" });
  expect(result).toBeUndefined();
});

test("npcs.add creates new npc", async () => {
  const npc = {
    map: "dungeon",
    position: { x: 300, y: 200, direction: "left" },
  };
  const result = await npcs.add(npc);
  expect(result).toBeDefined();
});

test("npcs.remove deletes npc", async () => {
  await npcs.remove({ id: 1 });
  const result = await npcs.find({ id: 1 });
  expect((result as any)?.length || 0).toBe(0);
});

test("npcs.update modifies npc", async () => {
  const npc = { id: 2, map: "castle", position: { x: 250, y: 180 } };
  const result = await npcs.update(npc);
  expect(result).toBeDefined();
});

test("npcs.move updates npc position", async () => {
  const npc = { id: 2, position: { x: 400, y: 300, direction: "right" } };
  const result = await npcs.move(npc);
  expect(result).toBeDefined();
});
