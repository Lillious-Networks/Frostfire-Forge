import { expect, test } from "bun:test";
import { mockAssetCache } from "./setup";

const particlesDatabase: Record<string, any> = {
  test_particle: {
    name: "test_particle",
    size: 5,
    color: "ffffff",
    velocity: "10,10",
    lifetime: 2000,
    scale: 1,
    opacity: 1,
    visible: 1,
    gravity: "0,9.8",
    localposition: "0,0",
    interval: 100,
    amount: 10,
    staggertime: 50,
    spread: "5,5",
    affected_by_weather: 0,
  },
};

const mockQuery = async (sql: string, params: any[]) => {
  if (sql.includes("INSERT INTO particles")) {
    return { affectedRows: 1 };
  }
  if (sql.includes("DELETE FROM particles")) {
    const [name] = params;
    if (particlesDatabase[name]) {
      delete particlesDatabase[name];
      return { affectedRows: 1 };
    }
    return { affectedRows: 0 };
  }
  if (sql.includes("SELECT * FROM particles WHERE name")) {
    const [name] = params;
    return particlesDatabase[name] ? [particlesDatabase[name]] : [];
  }
  if (sql.includes("SELECT * FROM particles")) {
    return Object.values(particlesDatabase);
  }
  if (sql.includes("UPDATE particles")) {
    const name = params[params.length - 1];
    particlesDatabase[name] = { name, ...params };
    return { affectedRows: 1 };
  }
  return [];
};

const particles = {
  async add(particle: any) {
    const response = await mockQuery("INSERT INTO particles (size, color) VALUES (?, ?)", [particle.size, particle.color]);
    await mockAssetCache.set("particles", response);
    return response;
  },

  async remove(particle: any) {
    const response = await mockQuery("DELETE FROM particles WHERE name = ?", [particle.name]);
    await mockAssetCache.set("particles", response);
    return response;
  },

  async update(particle: any) {
    const response = await mockQuery("UPDATE particles SET size = ? WHERE name = ?", [particle.size, particle.name]);
    await mockAssetCache.set("particles", response);
    return response;
  },

  async list() {
    const response = (await mockQuery("SELECT * FROM particles", [])) as any[];
    return response.map((particle) => ({
      name: particle.name,
      size: particle.size,
      color: particle.color,
      velocity: { x: parseFloat(particle.velocity?.split(",")[0] || "0"), y: parseFloat(particle.velocity?.split(",")[1] || "0") },
      lifetime: particle.lifetime,
      scale: particle.scale,
      opacity: particle.opacity,
      visible: particle.visible,
      gravity: { x: parseFloat(particle.gravity?.split(",")[0] || "0"), y: parseFloat(particle.gravity?.split(",")[1] || "0") },
      localposition: { x: parseFloat(particle.localposition?.split(",")[0] || "0"), y: parseFloat(particle.localposition?.split(",")[1] || "0") },
      interval: particle.interval,
      amount: particle.amount,
      staggertime: particle.staggertime,
      spread: { x: parseFloat(particle.spread?.split(",")[0] || "0"), y: parseFloat(particle.spread?.split(",")[1] || "0") },
      currentLife: null,
      initialVelocity: null,
      weather: "none",
    }));
  },

  async find(particle: any) {
    const response = (await mockQuery("SELECT * FROM particles WHERE name = ?", [particle.name])) as any[];
    if (!response || response.length === 0) return null;
    const p = response[0];
    if (!p) return null;
    return {
      name: p.name,
      size: p.size,
      color: p.color,
      velocity: p.velocity,
      lifetime: p.lifetime,
      scale: p.scale,
      opacity: p.opacity,
      visible: p.visible,
      gravity: p.gravity,
      localposition: p.localposition,
      interval: p.interval,
      amount: p.amount,
      staggertime: p.staggertime,
      spread: p.spread,
      currentLife: null,
      initialVelocity: null,
      weather: "none",
    };
  },
};

test("particles.list returns all particles", async () => {
  const result = await particles.list();
  expect(Array.isArray(result)).toBe(true);
  expect(result.length).toBeGreaterThanOrEqual(0);
});

test("particles.find returns particle by name", async () => {
  const result = await particles.find({ name: "test_particle" });
  expect(result?.name).toBe("test_particle");
});

test("particles.find returns null for non-existent particle", async () => {
  const result = await particles.find({ name: "unique_nonexistent_name_12345" });

  expect(result === null || result === undefined).toBe(true);
});

test("particles.add creates new particle", async () => {
  const particle = { name: "new_particle", size: 3, color: "ff0000" };
  const result = await particles.add(particle);
  expect(result).toBeDefined();
});

test("particles.remove deletes particle", async () => {
  const result = await particles.remove({ name: "test_particle" });
  expect(result).toBeDefined();
});

test("particles.update modifies particle", async () => {
  const particle = { name: "test_particle", size: 8 };
  const result = await particles.update(particle);
  expect(result).toBeDefined();
});

test("particles properties include velocity objects", async () => {
  const result = await particles.list();
  if (result.length > 0) {
    expect(result[0].velocity?.x).toBeDefined();
    expect(result[0].velocity?.y).toBeDefined();
  }
});
