import { expect, test } from "bun:test";
import { mockAssetCache } from "./setup";

// Mock database
const mountsDatabase: Record<string, any> = {
  test_mount: { name: "test_mount", description: "A test mount" },
  horse: { name: "horse", description: "A fast horse" },
};

const mockQuery = async (sql: string, params: any[]) => {
  if (sql.includes("INSERT IGNORE INTO mounts")) {
    const [name, description] = params;
    if (!mountsDatabase[name]) {
      mountsDatabase[name] = { name, description };
      return { affectedRows: 1 };
    }
    return { affectedRows: 0 };
  }
  if (sql.includes("DELETE FROM mounts")) {
    const [name] = params;
    if (mountsDatabase[name]) {
      delete mountsDatabase[name];
      return { affectedRows: 1 };
    }
    return { affectedRows: 0 };
  }
  if (sql.includes("SELECT * FROM mounts WHERE name")) {
    const name = params[0];
    return mountsDatabase[name] ? [mountsDatabase[name]] : [];
  }
  if (sql.includes("SELECT * FROM mounts")) {
    return Object.values(mountsDatabase);
  }
  if (sql.includes("UPDATE mounts")) {
    const [description, , , name] = params;
    if (mountsDatabase[name]) {
      mountsDatabase[name].description = description;
      return { affectedRows: 1 };
    }
    return { affectedRows: 0 };
  }
  return [];
};

const mounts = {
  async add(mount: any) {
    if (!mount?.name || !mount?.description) return;
    return await mockQuery("INSERT IGNORE INTO mounts (name, description) VALUES (?, ?)", [mount.name, mount.description]);
  },

  async remove(mount: any) {
    if (!mount?.name) return;
    return await mockQuery("DELETE FROM mounts WHERE name = ?", [mount.name]);
  },

  async list() {
    return await mockQuery("SELECT * FROM mounts", []);
  },

  async find(mount: any) {
    if (!mount?.name) return;
    const response = await mockQuery("SELECT * FROM mounts WHERE name = ?", [mount.name]);
    if ((response as any[]).length === 0) return;
    return response;
  },

  async update(mount: any) {
    if (!mount?.name || !mount?.description) return;
    const result = await mockQuery("UPDATE mounts SET description = ? WHERE name = ?", [mount.description, mount.name]);
    if (result) {
      const mounts = (await mockAssetCache.get("mounts")) as any[];
      const index = mounts.findIndex((m) => m.name === mount.name);
      if (index !== -1) {
        mounts[index] = mount;
        await mockAssetCache.set("mounts", mounts);
      }
    }
  },
};

test("mounts.list returns all mounts", async () => {
  const result = (await mounts.list()) as any[];
  expect(Array.isArray(result)).toBe(true);
  expect(result.length).toBeGreaterThan(0);
});

test("mounts.find returns mount by name", async () => {
  const result = (await mounts.find({ name: "test_mount" })) as any[];
  expect(result?.length).toBeGreaterThan(0);
  expect(result[0].name).toBe("test_mount");
});

test("mounts.find returns undefined for non-existent mount", async () => {
  const result = await mounts.find({ name: "nonexistent" });
  expect(result).toBeUndefined();
});

test("mounts.add requires name and description", async () => {
  const result = await mounts.add({ name: "incomplete" });
  expect(result).toBeUndefined();
});

test("mounts.add adds valid mount", async () => {
  const newMount = { name: "dragon", description: "A powerful dragon" };
  await mounts.add(newMount);
  const result = await mounts.find(newMount);
  expect(result).toBeDefined();
});

test("mounts.remove deletes mount", async () => {
  const mount = { name: "horse", description: "A fast horse" };
  await mounts.remove(mount);
  const result = await mounts.find(mount);
  expect(result).toBeUndefined();
});

test("mounts.update modifies mount", async () => {
  const mount = { name: "test_mount", description: "Updated description" };
  await mounts.update(mount);
  const result = await mounts.find(mount);
  expect(result).toBeDefined();
});
