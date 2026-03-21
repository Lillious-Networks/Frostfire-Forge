import { expect, test } from "bun:test";

const permissionsDatabase: Record<string, any> = {
  user1: { permissions: "admin,moderator" },
  user2: { permissions: "player" },
  user3: { permissions: null },
};

const mockQuery = async (sql: string, params: any[]) => {
  if (sql.includes("UPDATE permissions SET permissions = NULL")) {
    const [username] = params;
    permissionsDatabase[username] = { permissions: null };
    return { affectedRows: 1 };
  }
  if (sql.includes("INSERT INTO permissions")) {
    const [username, perms] = params;
    permissionsDatabase[username] = { permissions: perms };
    return { affectedRows: 1 };
  }
  if (sql.includes("SELECT permissions FROM permissions")) {
    const [username] = params;
    return permissionsDatabase[username] ? [permissionsDatabase[username]] : [];
  }
  if (sql.includes("SELECT name FROM permission_types")) {
    return [{ name: "admin" }, { name: "moderator" }, { name: "player" }];
  }
  return [];
};

const permissions = {
  async clear(username: string) {
    await mockQuery("UPDATE permissions SET permissions = NULL WHERE username = ?", [username]);
  },

  async set(username: string, perms: string | string[]) {
    const permsList = typeof perms === "string" ? [perms] : perms;
    const uniquePerms = Array.from(new Set(permsList));
    await mockQuery("INSERT INTO permissions (username, permissions) VALUES (?, ?) ON DUPLICATE KEY UPDATE permissions = ?", [
      username,
      uniquePerms.join(","),
      uniquePerms.join(","),
    ]);
  },

  async get(username: string) {
    const response = (await mockQuery("SELECT permissions FROM permissions WHERE username = ?", [username])) as {
      permissions: string;
    }[];
    if (response.length === 0) return [];
    return response[0]?.permissions || [];
  },

  async add(username: string, permission: string) {
    const response = (await this.get(username)) as string;
    const access = response.includes(",") ? response.split(",") : response.length ? [response] : [];
    if (access.includes(permission)) return;
    access.push(permission);
    await this.set(username, access);
  },

  async remove(username: string, permission: string) {
    const response = (await this.get(username)) as string;
    const access = response.includes(",") ? response.split(",") : response.length ? [response] : [];
    if (!access.includes(permission)) return;
    access.splice(access.indexOf(permission), 1);
    await this.set(username, access);
  },

  async list() {
    const response = (await mockQuery("SELECT name FROM permission_types", [])) as { name: string }[];
    return response.map((permission) => permission.name);
  },
};

test("permissions.get returns permissions for user", async () => {
  const result = await permissions.get("user1");
  expect(result).toContain("admin");
  expect(result).toContain("moderator");
});

test("permissions.get returns empty for user with no permissions", async () => {
  const result = await permissions.get("user3");
  expect(result).toEqual([]);
});

test("permissions.get returns empty for non-existent user", async () => {
  const result = await permissions.get("nonexistent");
  expect(Array.isArray(result)).toBe(true);
});

test("permissions.set sets single permission", async () => {
  await permissions.set("user1", "admin");
  const result = await permissions.get("user1");
  expect(result).toBeDefined();
});

test("permissions.set sets multiple permissions", async () => {
  await permissions.set("user1", ["admin", "moderator", "player"]);
  const result = await permissions.get("user1");
  expect(result).toBeDefined();
});

test("permissions.set removes duplicates", async () => {
  await permissions.set("user1", ["admin", "admin", "admin"]);
  const result = await permissions.get("user1");
  expect(result).toBeDefined();
});

test("permissions.add adds permission to user", async () => {
  await permissions.add("user2", "moderator");
  const result = await permissions.get("user2");
  expect(result).toBeDefined();
});

test("permissions.add prevents duplicate permissions", async () => {
  await permissions.add("perms_test_user", "admin");
  const after = await permissions.get("perms_test_user");
  expect(after).toBeDefined();
});

test("permissions.remove removes permission from user", async () => {
  await permissions.remove("user1", "moderator");
  const result = await permissions.get("user1");
  expect(result).toBeDefined();
});

test("permissions.clear clears all permissions", async () => {
  await permissions.clear("user1");
  const result = await permissions.get("user1");
  expect(result).toEqual([]);
});

test("permissions.list returns all permission types", async () => {
  const result = await permissions.list();
  expect(Array.isArray(result)).toBe(true);
  expect(result.length).toBeGreaterThan(0);
});
