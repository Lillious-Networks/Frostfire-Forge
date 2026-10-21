import { beforeEach, describe, expect, mock, test } from "bun:test";
import { databaseModule, standInFor } from "./setup";

const queries: Array<{ sql: string; params: any[] }> = [];

mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (sql: string, params: any[] = []) => {
    queries.push({ sql, params });
    return [];
  },
}));

const cache = new Map<string, any>();
await standInFor("../services/assetCache", () => ({
  default: {
    get: async (key: string) => cache.get(key),
    set: async (key: string, value: any) => cache.set(key, value),
    add: async (key: string, value: any) => cache.set(key, value),
  },
}));

// Mount names in the cache each time the login workers were handed the list.
const handedToLoginWorkers: string[][] = [];
await standInFor("../socket/authentication_pool", () => ({
  refreshAuthMounts: async () => {
    handedToLoginWorkers.push(((cache.get("mounts") || []) as Mount[]).map((m) => m.name));
  },
  refreshAuthItems: async () => {},
  refreshAuthSpells: async () => {},
  getAuthWorker: async () => null,
  resetAuthWorker: () => {},
}));

const editor = await import("../systems/mounteditor");

// What the asset server has: only the unicorn's sheet.
const assets: import("../systems/mounteditor").AssetLists = {
  icons: async () => [{ name: "mount_unicorn", image: "/icon?name=mount_unicorn" }],
  spriteSheets: async () => ({ mount: [{ name: "mount_unicorn", image: null }] }),
};
const send = (admin: any, type: string, data: any) => editor.handleEditorPacket(admin, type, data, assets);

const admin = { username: "root", isAdmin: true, permissions: [] };
const unicorn: Mount = { name: "unicorn", description: "A sturdy unicorn for traveling.", particles: "sparkle", icon: "mount_unicorn" };

beforeEach(() => {
  queries.length = 0;
  handedToLoginWorkers.length = 0;
  cache.set("mounts", [{ ...unicorn }]);
});

describe("who may use the mount editor", () => {
  test("admins and holders of its permission, as copied to the player at login", () => {
    expect(editor.canUseEditor(admin)).toBe(true);
    expect(editor.canUseEditor({ username: "builder", permissions: ["chat.say", "tools.mount_editor"] })).toBe(true);
    expect(editor.canUseEditor({ username: "painter", permissions: ["tools.*"] })).toBe(true);
    expect(editor.canUseEditor({ username: "player", permissions: ["chat.say"] })).toBe(false);
    expect(editor.canUseEditor({ username: "guest", isGuest: true, isAdmin: true })).toBe(false);
  });

  test("anyone else is refused, and nothing is written", async () => {
    const answer = await send({ username: "player" }, "MOUNT_EDITOR_SAVE", { name: "griffin", description: "Flies." });
    expect(answer).toMatchObject({ kind: "result", ok: false, denied: true, errors: [editor.DENIED] });
    expect(queries).toHaveLength(0);
  });
});

describe("a mount the editor sends", () => {
  test("needs a name of its own that can name a file, and a description", () => {
    const fields = (raw: any) => {
      const read = editor.readMount(raw, null, [unicorn]);
      return read.ok ? {} : read.fields;
    };
    expect(fields({ name: "", description: "x" })).toHaveProperty("name");
    expect(fields({ name: "Unicorn", description: "x" }).name).toBe("There is already a mount called Unicorn.");
    expect(fields({ name: "../horse", description: "x" })).toHaveProperty("name");
    expect(fields({ name: "griffin", description: "  " })).toHaveProperty("description");
    expect(editor.readMount({ name: " griffin ", description: " Flies. ", icon: "" }, null, [unicorn]))
      .toEqual({ ok: true, mount: { name: "griffin", description: "Flies.", icon: null } });
  });

  test("keeps its saved name, whatever was sent", () => {
    const read = editor.readMount({ name: "pegasus", description: "Faster." }, "unicorn", [unicorn]);
    expect(read).toEqual({ ok: true, mount: { name: "unicorn", description: "Faster.", icon: null } });
  });
});

describe("the editor's list", () => {
  test("says which sheet each mount is drawn with, and whether the asset server has it", async () => {
    cache.set("mounts", [{ ...unicorn }, { name: "Griffin", description: "Flies.", particles: null, icon: null }]);
    const answer = await send(admin, "MOUNT_EDITOR_LIST", {});
    expect(answer.kind).toBe("data");
    if (answer.kind !== "data") return;
    expect(answer.data.mounts).toEqual([
      { name: "Griffin", description: "Flies.", icon: null, sheet: "mount_griffin", hasSheet: false },
      { name: "unicorn", description: unicorn.description, icon: "mount_unicorn", sheet: "mount_unicorn", hasSheet: true },
    ]);
  });
});

describe("saving and deleting", () => {
  test("a new mount is added, and the login workers are handed the new list", async () => {
    const answer = await send(admin, "MOUNT_EDITOR_SAVE", { originalName: null, name: "griffin", description: "Flies.", icon: "griffin" });
    expect(answer).toMatchObject({ kind: "result", ok: true, name: "griffin", changed: true });
    expect(queries.some((q) => q.sql.startsWith("INSERT IGNORE INTO mounts") && q.params[0] === "griffin")).toBe(true);
    expect((cache.get("mounts") as Mount[]).map((m) => m.name)).toEqual(["unicorn", "griffin"]);
    expect(handedToLoginWorkers).toEqual([["unicorn", "griffin"]]);
  });

  test("a change keeps the mount's particles, which the editor does not show", async () => {
    const answer = await send(admin, "MOUNT_EDITOR_SAVE", { originalName: "unicorn", name: "unicorn", description: "Swift.", icon: null });
    expect(answer).toMatchObject({ ok: true, name: "unicorn" });
    const update = queries.find((q) => q.sql.startsWith("UPDATE mounts"))!;
    expect(update.params).toEqual(["Swift.", "sparkle", null, "unicorn"]);
    expect((cache.get("mounts") as Mount[])[0]).toMatchObject({ description: "Swift.", particles: "sparkle", icon: null });
  });

  test("a refused save writes nothing and says which fields are wrong", async () => {
    const answer = await send(admin, "MOUNT_EDITOR_SAVE", { originalName: null, name: "unicorn", description: "" });
    expect(answer).toMatchObject({ kind: "result", ok: false, errors: ["2 fields need fixing."] });
    if (answer.kind === "result") expect(Object.keys(answer.fields ?? {}).sort()).toEqual(["description", "name"]);
    expect(queries).toHaveLength(0);
    expect(handedToLoginWorkers).toEqual([]);
  });

  test("a mount that is gone cannot be changed or deleted", async () => {
    for (const type of ["MOUNT_EDITOR_SAVE", "MOUNT_EDITOR_DELETE"]) {
      const answer = await send(admin, type, { originalName: "pegasus", name: "pegasus", description: "x" });
      expect(answer).toMatchObject({ ok: false, errors: ["There is no mount called pegasus any more."] });
    }
    expect(queries).toHaveLength(0);
  });

  test("deleting removes the row and the cached mount, and tells the login workers", async () => {
    const answer = await send(admin, "MOUNT_EDITOR_DELETE", { originalName: "Unicorn" });
    expect(answer).toMatchObject({ ok: true, name: "unicorn", changed: true });
    expect(queries.some((q) => q.sql === "DELETE FROM mounts WHERE name = ?" && q.params[0] === "unicorn")).toBe(true);
    expect(cache.get("mounts")).toEqual([]);
    expect(handedToLoginWorkers).toEqual([[]]);
  });
});
