import { expect, spyOn, test } from "bun:test";
import log from "../modules/logger";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "../cluster/memorystore";
import { spendTicket, TICKET_KEY_PREFIX } from "../cluster/ticketspend";

test("a ticket is spent once", async () => {
  const store = new MemoryStore();
  const now = 1_000_000;
  expect(await spendTicket(store, "switch-abc", now + 30_000, now)).toBe("spent");
  // Guard: setIfAbsent. Without it, the same ticket opens a second connection.
  expect(await spendTicket(store, "switch-abc", now + 30_000, now)).toBe("reused");
  expect(await spendTicket(store, "switch-def", now + 30_000, now)).toBe("spent");
});

test("the spent mark outlives the ticket", async () => {
  const ttls: number[] = [];
  const keys: string[] = [];
  const store = { setIfAbsent: async (key: string, _value: string, ttlMs: number) => { ttls.push(ttlMs); keys.push(key); return true; } };
  await spendTicket(store, "switch-abc", 1_030_000, 1_000_000);
  expect(ttls).toEqual([31_000]);
  // Checked here, not inside the store: a throw there would take the refusal path.
  expect(keys).toEqual(["cells:ticket:switch-abc"]);
  expect(TICKET_KEY_PREFIX).toBe("cells:ticket:");
  // An expired or odd expiry still keeps the mark for a second.
  await spendTicket(store, "switch-abc", 0, 1_000_000);
  expect(ttls[1]).toBe(1_000);
  // A NaN or fractional expiry still gives Redis a whole TTL.
  await spendTicket(store, "switch-abc", Number.NaN, 1_000_000);
  expect(ttls[2]).toBe(1_000);
  await spendTicket(store, "switch-abc", 1_000_000.4, 1_000_000);
  expect(ttls[3]).toBe(1_001);
});

test("an empty token is never spent", async () => {
  const store = new MemoryStore();
  expect(await spendTicket(store, "", 2_000, 1_000)).toBe("unknown");
});

test("a store that fails gives \"unknown\", which refuses the ticket (fails closed, security review L1)", async () => {
  const store = { setIfAbsent: async () => { throw new Error("redis down"); } };
  const warn = spyOn(log, "warn").mockImplementation(() => {});
  try {
    expect(await spendTicket(store, "switch-abc", 2_000, 1_000)).toBe("unknown");
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
});

test("the transport hands the ticket token to allocateId and keeps it on the connection", () => {
  const source = readFileSync(join(import.meta.dir, "..", "socket", "transport.ts"), "utf8");
  expect(source).toContain("allocateId?: (token: string) => string | null;");
  expect(source).toContain('options.allocateId(String(data?.token ?? ""))');
  expect(source).toContain('ticketToken: String(data?.token ?? "")');
  expect(source).toContain("ticketExpiresAt: Number(data?.expiresAt) || 0");
});
