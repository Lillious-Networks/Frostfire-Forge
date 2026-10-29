import { beforeEach, expect, test } from "bun:test";
import { type DirectoryEntry, PlayerDirectory } from "../cluster/directory";
import { MemoryStore } from "../cluster/memorystore";
import { trackPresence } from "../cluster/presence";
import playerCache from "../services/playermanager";

// The listeners stay on the shared playerCache for the whole run, so they are
// registered once here; each test uses names of its own.
const store = new MemoryStore();
const directory = new PlayerDirectory(store, "a");
const displaced: Array<{ previous: DirectoryEntry; username: string }> = [];
trackPresence(directory, (previous, username) => displaced.push({ previous, username }));

// Every claim and release here is a chain of MemoryStore calls, which settle within one immediate.
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  playerCache.clear();
  displaced.length = 0;
});

test("a login points the name at this node", async () => {
  playerCache.add("7", { username: "Login", location: { map: "main" } });
  await settle();
  expect(await directory.get("login")).toEqual({ nodeId: "a", playerId: "7", epoch: 1, map: "main" });
});

test("a remove right after the add ends with no entry", async () => {
  playerCache.add("8", { username: "Quick", location: { map: "main" } });
  playerCache.remove("8");
  await settle();
  expect(await directory.get("quick")).toBeNull();
  expect(await directory.playersOn("a")).not.toContain("quick");
});

test("a login that displaces another node's entry says so", async () => {
  const other = new PlayerDirectory(store, "b");
  await other.claim("Taken", "99", "east");
  playerCache.add("9", { username: "Taken", location: { map: "main" } });
  await settle();
  expect(displaced.length).toBe(1);
  expect(displaced[0].previous.nodeId).toBe("b");
  expect(displaced[0].username).toBe("Taken");
  expect((await directory.get("taken"))?.nodeId).toBe("a");
});

test("a login over this node's own entry does not count as displaced", async () => {
  await directory.claim("Mine", "5", "main");
  playerCache.add("5", { username: "Mine", location: { map: "main" } });
  await settle();
  expect(displaced).toEqual([]);
  expect((await directory.get("mine"))?.nodeId).toBe("a");
});
