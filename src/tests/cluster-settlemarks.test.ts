import { expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { MemoryStore } from "../cluster/memorystore";
import { LateError, NotStartedError, runTransaction, runWithRetries } from "../controllers/sqltransaction";
import { settle } from "./cluster-fakelink";
import { databaseModule } from "./setup";

// Settle marks shared through the cluster's store (cluster/tradesettle.ts), and the open-by deadline of a swap's
// transaction (controllers/sqltransaction.ts). Two TradeSettle objects on one MemoryStore play two nodes.

/** What each transaction the batch sent was given: how many arguments, and its options. */
const transactionCalls: Array<{ arity: number; options: unknown }> = [];
/** Every statement sent outside a transaction that is not a read. */
const plainWrites: string[] = [];
/** The inventory rows the fake database holds, by player. */
const inventoryRows: Record<string, Array<Record<string, unknown>>> = {};
mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async (sql: string, values: any[] = []) => {
    const text = sql.replace(/\s+/g, " ").trim();
    if (text === "SELECT * FROM inventory WHERE username = ?") return (inventoryRows[String(values[0]).toLowerCase()] ?? []).map((row) => ({ ...row }));
    if (!text.startsWith("SELECT")) plainWrites.push(text);
    return [];
  },
  transaction: async (...args: any[]) => {
    transactionCalls.push({ arity: args.length, options: args[1] });
    return (args[0] as unknown[]).map(() => ({ affectedRows: 1 }));
  },
}));

const item = (name: string) => ({ name, quality: "common", type: "material", description: "", icon: null, equipment_slot: null, bag_slots: null });
const assetItems = [item("Iron Ore"), item("Health Potion")];
// A working cache, not a stub: bun's module mocks stay for the rest of the run, so later test files use this one too.
const assetValues = new Map<string, any>([["items", assetItems]]);
const assetNested = new Map<string, Map<string, any>>();
mock.module("../services/assetCache", () => ({
  default: {
    get: async (key: string) => assetValues.get(key) ?? null,
    set: async (key: string, value: any) => { assetValues.set(key, value); },
    add: async (key: string, value: any) => { assetValues.set(key, value); },
    remove: async (key: string) => { assetValues.delete(key); },
    addNested: async (key: string, nestedKey: string, value: any) => {
      if (!assetNested.has(key)) assetNested.set(key, new Map());
      assetNested.get(key)!.set(nestedKey, value);
    },
    getNested: async (key: string, nestedKey: string) => assetNested.get(key)?.get(nestedKey) ?? null,
    setNested: async (key: string, nestedKey: string, value: any) => {
      if (!assetNested.has(key)) assetNested.set(key, new Map());
      assetNested.get(key)!.set(nestedKey, value);
    },
    removeNested: async (key: string, nestedKey: string) => { assetNested.get(key)?.delete(nestedKey); },
    clear: async () => { assetValues.clear(); assetNested.clear(); },
    list: async () => Object.fromEntries(assetValues),
    getAll: async () => Object.fromEntries(assetValues),
    close: () => {},
  },
}));

const { TradeSettle, tradeSettle, settleKey, settleForAdmin, settleStoreAttached, settlingNotice, loginMarkRead, UNCHECKED_SETTLE, STALE_AFTER_SETTLE } = await import("../cluster/tradesettle");
const { refreshPlayer, setLoginGate, clearCaches } = await import("../services/datacache");
const { atomically } = await import("../services/batch");
const { default: trades, ACCEPT_DELAY_MS, swapStart } = await import("../systems/trades");
const editor = await import("../systems/playereditor");
const { default: permissions } = await import("../systems/permissions");
const { default: player } = await import("../systems/player");

const quiet = { drop: async () => {} };
const source = (path: string) => Bun.file(new URL(path, import.meta.url)).text();
const statement = [{ sql: "UPDATE currency SET copper = ? WHERE username = ?", values: [1, "lateuser"] }];

// ------------------------------------------------------------------ sharing the mark

test("a mark is kept in the store for the rest of its window", async () => {
  const store = new MemoryStore();
  const a = new TradeSettle({ ms: 1000, ...quiet });
  a.attach(store);
  const start = Date.now();
  setSystemTime(new Date(start));
  try {
    await a.unsettle("sharealice", "test", "node-h");
    // Guard: unsettle shares the mark
    const raw = await store.get(settleKey("sharealice"));
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({ until: start + 1000, peer: "node-h", left: 1000 });
    setSystemTime(new Date(start + 999));
    expect(await store.get(settleKey("sharealice"))).not.toBeNull();
    setSystemTime(new Date(start + 1001));
    expect(await store.get(settleKey("sharealice"))).toBeNull();
  } finally {
    setSystemTime();
    a.reset();
  }
});

test("a mark made longer is shared with its new end", async () => {
  const store = new MemoryStore();
  const a = new TradeSettle({ ms: 1000, ...quiet });
  a.attach(store);
  const start = Date.now();
  setSystemTime(new Date(start));
  try {
    await a.unsettle("longalice", "test", "node-h");
    setSystemTime(new Date(start + 400));
    await a.unsettle("longalice", "again", "node-h");
    expect(JSON.parse((await store.get(settleKey("longalice")))!).until).toBe(start + 1400);
  } finally {
    setSystemTime();
    a.reset();
  }
});

test("another node takes the mark from the store, and its writes wait for it", async () => {
  const store = new MemoryStore();
  const drops: string[] = [];
  const a = new TradeSettle({ ms: 120, ...quiet });
  const c = new TradeSettle({ ms: 120, drop: async (name) => { drops.push(name); } });
  a.attach(store);
  c.attach(store);
  try {
    await a.unsettle("movealice", "test", "node-h");
    expect(c.unsettled("movealice")).toBe(false);
    expect(await c.importMark("movealice")).toBe(true);
    // Guard: an imported mark is held here
    expect(c.unsettled("movealice")).toBe(true);
    // Held for what was left when it was written: never less than on the node that set it, a little more at most.
    expect(c.unsettledUntil("movealice")!).toBeGreaterThanOrEqual(a.unsettledUntil("movealice")!);
    expect(c.unsettledUntil("movealice")!).toBeLessThanOrEqual(a.unsettledUntil("movealice")! + 50);
    let wrote = false;
    const write = c.settledThen("movealice", async () => { wrote = true; });
    await Bun.sleep(40);
    expect(wrote).toBe(false);
    await write;
    expect(wrote).toBe(true);
    // The rows were dropped at the mark's end, before the write read them.
    expect(drops).toEqual(["movealice"]);
  } finally {
    a.reset();
    c.reset();
  }
});

test("a mark that has run out, or none, or a malformed one, is not taken", async () => {
  const store = new MemoryStore();
  const c = new TradeSettle({ ms: 1000, ...quiet });
  c.attach(store);
  try {
    // A value with nothing left, still in the store (its ttl is longer than its window), and one with no `left`.
    await store.set(settleKey("pastalice"), JSON.stringify({ until: Date.now() - 1, peer: "node-h", left: 0 }), 60_000);
    await store.set(settleKey("oldalice"), JSON.stringify({ until: Date.now() + 60_000, peer: "node-h" }), 60_000);
    await store.set(settleKey("junkalice"), "not json", 60_000);
    // A mark whose key ran out in the store.
    const a = new TradeSettle({ ms: 100, ...quiet });
    a.attach(store);
    const start = Date.now();
    setSystemTime(new Date(start));
    await a.unsettle("gonealice", "test", "node-h");
    setSystemTime(new Date(start + 101));
    expect(await c.importMark("gonealice")).toBe(true);
    setSystemTime();
    a.reset();
    expect(c.unsettled("gonealice")).toBe(false);
    // Guard: only a mark that has not run out is taken
    expect(await c.importMark("pastalice")).toBe(true);
    expect(c.unsettled("pastalice")).toBe(false);
    expect(await c.importMark("oldalice")).toBe(true);
    expect(c.unsettled("oldalice")).toBe(false);
    expect(await c.importMark("junkalice")).toBe(true);
    expect(c.unsettled("junkalice")).toBe(false);
    expect(await c.importMark("nobody")).toBe(true);
    expect(c.size).toBe(0);
  } finally {
    setSystemTime();
    c.reset();
  }
});

test("an imported mark is held for what was left of it, whatever the other node's clock says", async () => {
  const store = new MemoryStore();
  const c = new TradeSettle({ ms: 1000, ...quiet });
  c.attach(store);
  try {
    // The marking node's clock is 10 s behind this one: by its `until` the mark ran out long ago.
    await store.set(settleKey("skewalice"), JSON.stringify({ until: Date.now() - 10_000, peer: "node-h", left: 500 }), 500);
    const before = Date.now();
    expect(await c.importMark("skewalice")).toBe(true);
    // Guard: this node's clock only
    expect(c.unsettled("skewalice")).toBe(true);
    expect(c.unsettledUntil("skewalice")!).toBeGreaterThanOrEqual(before + 500);
    expect(c.unsettledUntil("skewalice")!).toBeLessThanOrEqual(Date.now() + 500);
  } finally {
    c.reset();
  }
});

test("a node with no store reads nothing and imports nothing", async () => {
  const c = new TradeSettle({ ms: 1000, ...quiet });
  expect(c.attached()).toBe(false);
  expect(await c.importMark("lonealice")).toBe(true);
  expect(c.size).toBe(0);
  expect(settleStoreAttached()).toBe(false);
});

test("an unmarked player's writes wait for nothing, with a store attached", async () => {
  const store = new MemoryStore();
  const get = spyOn(store, "get");
  const node = new TradeSettle({ ms: 1000, ...quiet });
  node.attach(store);
  try {
    // One promise made at load, whoever asks: no allocation and no store read.
    expect(node.settled("fastalice")).toBe(node.settled("fastbob"));
    let ran = false;
    const done = node.settledThen("fastalice", async () => { ran = true; });
    // The work ran before settledThen returned: nothing was awaited first.
    expect(ran).toBe(true);
    await done;
    expect(get).not.toHaveBeenCalled();
  } finally {
    node.reset();
  }
});

// ------------------------------------------------------------------ admin writes

test("a mark that cannot be read refuses an admin's write", async () => {
  const store = new MemoryStore();
  store.get = async () => { throw new Error("store down"); };
  tradeSettle.attach(store);
  try {
    expect(await tradeSettle.importMark("downalice")).toBe(false);
    expect(await tradeSettle.settleEverywhere("downalice")).toBe(false);
    // Guard: a mark that cannot be read refuses the write
    expect(await settleForAdmin("downalice")).toBe(UNCHECKED_SETTLE);
  } finally {
    tradeSettle.detach();
    tradeSettle.reset();
  }
});

test("an admin's write to a player marked on another node waits for the mark", async () => {
  const store = new MemoryStore();
  const a = new TradeSettle({ ms: 100, ...quiet });
  a.attach(store);
  tradeSettle.reset({ ms: 100, ...quiet });
  tradeSettle.attach(store);
  try {
    await a.unsettle("givealice", "test", "node-h");
    const started = Date.now();
    // Guard: settleEverywhere waits for the imported mark
    expect(await settleForAdmin("givealice")).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(80);
    expect(tradeSettle.unsettled("givealice")).toBe(false);
  } finally {
    a.reset();
    tradeSettle.detach();
    tradeSettle.reset();
  }
});

// /give is run from its source, with the names its case uses handed in (as admin-commands.test.ts runs commands):
// the command module cannot be imported here, it starts the server.
const GIVE_NAMES = [
  "commandName", "currentPlayer", "wt", "args", "sendPacket", "packetManager", "playerCache", "player", "assetCache",
  "inventory", "getIconUrl", "settleStoreAttached", "settleForAdmin", "settlingNotice",
];
async function giveCommand(): Promise<(names: Record<string, unknown>) => Promise<void>> {
  const text = await source("../socket/handlers/commands.ts");
  const start = text.indexOf('\n          case "GIVE": {');
  const end = text.indexOf('\n          case "', start + 1);
  const block = text.slice(start, end);
  const body = new Bun.Transpiler({ loader: "ts" }).transformSync(`async function run({ ${GIVE_NAMES.join(", ")} }: any) { switch (commandName) {${block}\n} }`);
  return new Function(`"use strict";\n${body}\nreturn run;`)();
}

/** Runs `/give givebob <item> 2` as an admin: what the admin was told, and each item added, with when. */
async function give(itemName = "Iron Ore") {
  const run = await giveCommand();
  const wt = {};
  const told: string[] = [];
  const added: Array<{ name: string; item: unknown; at: number }> = [];
  await run({
    commandName: "GIVE",
    currentPlayer: { permissions: ["admin.*"] },
    wt,
    args: ["givebob", itemName, "2"],
    sendPacket: (to: unknown, packets: Array<{ message?: string }>) => { if (to === wt) told.push(...packets.map((packet) => String(packet.message))); },
    packetManager: { notify: ({ message }: { message: string }) => [{ message }], addInventoryItem: () => [] },
    playerCache: { list: () => ({}), get: () => undefined, set: () => {} },
    player: { findPlayerInDatabase: async () => [{ username: "givebob" }] },
    assetCache: { get: async () => assetItems },
    inventory: { add: async (name: string, added_: unknown) => { added.push({ name, item: added_, at: Date.now() }); return true; } },
    getIconUrl: () => null,
    settleStoreAttached,
    settleForAdmin,
    settlingNotice,
  });
  return { told, added };
}

test("/give waits for the target's mark before it adds the item", async () => {
  const store = new MemoryStore();
  const a = new TradeSettle({ ms: 100, ...quiet });
  a.attach(store);
  tradeSettle.reset({ ms: 100, ...quiet });
  tradeSettle.attach(store);
  try {
    await a.unsettle("givebob", "test", "node-h");
    const started = Date.now();
    const { told, added } = await give();
    // Guard: the /give fence
    expect(added).toHaveLength(1);
    expect(added[0].at - started).toBeGreaterThanOrEqual(80);
    // The admin is told it waits, before the item is given.
    expect(told[0]).toContain("givebob has a trade settling");
    expect(told[told.length - 1]).toBe("Gave 2x Iron Ore to givebob");
  } finally {
    a.reset();
    tradeSettle.detach();
    tradeSettle.reset();
  }
});

test("/give gives nothing when the target's mark cannot be read, and checks the item first", async () => {
  const store = new MemoryStore();
  let reads = 0;
  store.get = async () => { reads++; throw new Error("store down"); };
  tradeSettle.attach(store);
  try {
    const refused = await give();
    expect(refused.added).toEqual([]);
    expect(refused.told).toEqual([UNCHECKED_SETTLE]);
    // An item that does not exist is said at once, with no wait and no read.
    reads = 0;
    const unknown = await give("Iron Oar");
    expect(unknown.told).toEqual(["Item 'Iron Oar' does not exist"]);
    expect(reads).toBe(0);
  } finally {
    tradeSettle.detach();
    tradeSettle.reset();
  }
});

test("/give with no store attached gives at once and reads nothing", async () => {
  expect(settleStoreAttached()).toBe(false);
  const { told, added } = await give();
  expect(added).toHaveLength(1);
  expect(told).toEqual(["Gave 2x Iron Ore to givebob"]);
});

/** The player editor, with `boss` allowed to use it and `editbob` an account that is not online. */
async function withEditor<T>(work: (act: (action: string, data: Record<string, unknown>) => Promise<{ errors: string[]; told: string[]; took: number }>) => Promise<T>): Promise<T> {
  const spies = [
    spyOn(permissions, "get").mockImplementation((async (name: string) => (name === "boss" ? "server.admin" : "")) as any),
    spyOn(player, "findAccount").mockImplementation((async () => ({ id: 77, username: "editbob" })) as any),
    spyOn(player, "getAccount").mockImplementation((async () => null) as any),
  ];
  await clearCaches();
  const act = async (action: string, data: Record<string, unknown>) => {
    const frames: unknown[] = [];
    const admin = { id: "9001", username: "boss", isGuest: false, wt: { readyState: 1, send: (frame: unknown) => frames.push(frame) } };
    plainWrites.length = 0;
    transactionCalls.length = 0;
    const started = Date.now();
    const result = await editor.handleEditorPacket(admin, "PLAYER_EDITOR_ACTION", { target: "editbob", action, ...data });
    if (result.kind !== "result") throw new Error("An action answers with a result");
    const told = frames.map((frame) => (typeof frame === "string" ? frame : new TextDecoder().decode(frame as Uint8Array)));
    return { errors: result.errors, told, took: Date.now() - started };
  };
  try {
    return await work(act);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}
const written = () => plainWrites.length + transactionCalls.length;
const balance = { gold: 1, silver: 0, copper: 0 };

test("the player editor waits for the target's mark before it runs an action", async () => {
  const store = new MemoryStore();
  const a = new TradeSettle({ ms: 100, ...quiet });
  a.attach(store);
  tradeSettle.reset({ ms: 100, ...quiet });
  tradeSettle.attach(store);
  try {
    await withEditor(async (act) => {
      await a.unsettle("editbob", "test", "node-h");
      const added = await act("inventory.add", { item: "Iron Ore", quantity: 1 });
      // Guard: the player editor fence
      expect(added.took).toBeGreaterThanOrEqual(80);
      expect(added.errors).toEqual([]);
      expect(written()).toBeGreaterThan(0);
      expect(added.told.some((text) => text.includes("editbob has a trade settling"))).toBe(true);
    });
  } finally {
    a.reset();
    tradeSettle.detach();
    tradeSettle.reset();
  }
});

test("the player editor changes nothing when the target's mark cannot be read", async () => {
  const store = new MemoryStore();
  store.get = async () => { throw new Error("store down"); };
  tradeSettle.attach(store);
  try {
    await withEditor(async (act) => {
      const set = await act("currency.set", balance);
      // Guard: the editor's refusal
      expect(set.errors).toEqual([UNCHECKED_SETTLE]);
      expect(written()).toBe(0);
    });
  } finally {
    tradeSettle.detach();
    tradeSettle.reset();
  }
});

test("after a wait the player editor refuses a balance or stack set from the old snapshot", async () => {
  const store = new MemoryStore();
  const a = new TradeSettle({ ms: 100, ...quiet });
  a.attach(store);
  tradeSettle.reset({ ms: 100, ...quiet });
  tradeSettle.attach(store);
  try {
    await withEditor(async (act) => {
      for (const [action, data] of [["currency.set", balance], ["inventory.set", { item: "Iron Ore", quantity: 9 }]] as const) {
        await a.unsettle("editbob", "test", "node-h");
        const set = await act(action, data);
        // Guard: an absolute change after a wait
        expect(set.errors).toEqual([STALE_AFTER_SETTLE]);
        expect(set.took).toBeGreaterThanOrEqual(80);
        expect(written()).toBe(0);
      }
      // Settled, with nothing to wait for: the same change is made.
      const again = await act("currency.set", balance);
      expect(again.errors).toEqual([]);
      expect(written()).toBeGreaterThan(0);
    });
  } finally {
    a.reset();
    tradeSettle.detach();
    tradeSettle.reset();
  }
});

test("the player editor with no store attached reads nothing and changes at once", async () => {
  expect(settleStoreAttached()).toBe(false);
  await withEditor(async (act) => {
    const set = await act("currency.set", balance);
    expect(set.errors).toEqual([]);
    expect(set.told).toEqual([]);
    expect(written()).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------ login

test("with no store attached the login gate reads nothing and awaits nothing", () => {
  const gate = setLoginGate(null);
  setLoginGate(gate);
  expect(gate).not.toBeNull();
  expect(gate!("gatelessalice")).toBeUndefined();
});

test("a login reads the player's mark before it reads their rows", async () => {
  const store = new MemoryStore();
  await store.set(settleKey("gatealice"), JSON.stringify({ until: Date.now() + 60_000, peer: "node-a", left: 60_000 }), 60_000);
  const realGet = store.get.bind(store);
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const asked: string[] = [];
  store.get = async (key: string) => {
    asked.push(key);
    await released;
    return realGet(key);
  };
  tradeSettle.attach(store);
  try {
    let finished = false;
    const login = refreshPlayer("gatealice").then(() => { finished = true; });
    await settle();
    expect(asked).toEqual([settleKey("gatealice")]);
    // Guard: refreshPlayer awaits the login gate
    expect(finished).toBe(false);
    release();
    await login;
    expect(tradeSettle.unsettled("gatealice")).toBe(true);
  } finally {
    tradeSettle.detach();
    tradeSettle.reset();
  }
});

test("a login whose mark is not read in time goes on", async () => {
  const store = new MemoryStore();
  store.get = () => new Promise<string | null>(() => {});
  tradeSettle.attach(store);
  const limit = loginMarkRead.ms;
  loginMarkRead.ms = 50;
  try {
    const started = Date.now();
    // Guard: the login read's time limit
    await refreshPlayer("slowalice");
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(45);
    expect(took).toBeLessThan(1000);
  } finally {
    loginMarkRead.ms = limit;
    tradeSettle.detach();
    tradeSettle.reset();
  }
});

// ------------------------------------------------------------------ the open-by deadline

test("a transaction that opens after its open-by deadline sends nothing and is refused whole", async () => {
  const sent: string[] = [];
  const db = {
    begin: async (work: (tx: any) => Promise<any>) => {
      await Bun.sleep(40);
      return work({ unsafe: async (text: string) => { sent.push(text); return { affectedRows: 1 }; } });
    },
  };
  const run = runTransaction(db, statement, "mysql", 15_000, Date.now() + 10);
  // Guard: the open-by check inside the transaction
  await expect(run).rejects.toBeInstanceOf(LateError);
  expect(sent).toEqual([]);
});

test("a transaction past its open-by deadline does not ask for a connection", async () => {
  let begun = 0;
  const db = {
    begin: async (work: (tx: any) => Promise<any>) => {
      begun++;
      return work({ unsafe: async () => ({ affectedRows: 1 }) });
    },
  };
  const run = runTransaction(db, statement, "mysql", 15_000, Date.now() - 1);
  await expect(run).rejects.toBeInstanceOf(LateError);
  // Guard: the open-by check before begin
  expect(begun).toBe(0);
});

test("a transaction that did not open is not tried again past its open-by deadline", async () => {
  let begun = 0;
  const db = { begin: async () => { begun++; throw new Error("no connection free"); } };
  const openBy = Date.now() + 30;
  const run = runWithRetries(() => runTransaction(db, statement, "mysql", 15_000, openBy), 3, 60);
  await expect(run).rejects.toBeInstanceOf(LateError);
  expect(begun).toBe(1);
});

test("with no deadline a transaction that did not open is tried again, as before", async () => {
  let begun = 0;
  const db = { begin: async () => { begun++; throw new Error("no connection free"); } };
  const run = runWithRetries(() => runTransaction(db, statement, "mysql"), 3, 1);
  await expect(run).rejects.toBeInstanceOf(NotStartedError);
  expect(begun).toBe(3);
});

test("a transaction that opened and failed, or was late, is not run again", async () => {
  // One that opened may have been kept: a second run would write it twice.
  let tries = 0;
  const failed = runWithRetries(async () => { tries++; throw new Error("deadlock"); }, 3, 1);
  // Guard: runWithRetries retries only NotStartedError
  await expect(failed).rejects.toThrow("deadlock");
  expect(tries).toBe(1);
  let lateTries = 0;
  const late = runWithRetries(async () => { lateTries++; throw new LateError(0); }, 3, 1);
  await expect(late).rejects.toBeInstanceOf(LateError);
  expect(lateTries).toBe(1);
});

test("a transaction within its open-by deadline runs", async () => {
  const sent: string[] = [];
  const db = {
    begin: async (work: (tx: any) => Promise<any>) => work({ unsafe: async (text: string) => { sent.push(text); return { affectedRows: 1 }; } }),
  };
  const results = await runTransaction(db, statement, "mysql", 15_000, Date.now() + 10_000);
  expect(results).toHaveLength(1);
  expect(sent).toHaveLength(1);
});

test("a batch hands its earliest open-by deadline to the transaction, and none when it set none", async () => {
  transactionCalls.length = 0;
  await atomically(["batchalice"], async (batch) => {
    batch.add({ sql: "UPDATE currency SET copper = 1 WHERE username = 'batchalice'" });
  });
  await atomically(["batchalice"], async (batch) => {
    batch.openBy(9_000);
    batch.openBy(5_000);
    batch.add({ sql: "UPDATE currency SET copper = 2 WHERE username = 'batchalice'" });
  });
  // Guard: the batch passes its deadline on
  expect(transactionCalls).toEqual([
    { arity: 1, options: undefined },
    { arity: 2, options: { openBy: 5_000 } },
  ]);
});

test("a later open-by deadline does not push back an earlier one", async () => {
  transactionCalls.length = 0;
  await atomically(["batchalice"], async (batch) => {
    batch.openBy(5_000);
    batch.openBy(9_000);
    batch.add({ sql: "UPDATE currency SET copper = 3 WHERE username = 'batchalice'" });
  });
  // Guard: the earliest deadline holds
  expect(transactionCalls).toEqual([{ arity: 2, options: { openBy: 5_000 } }]);
});

test("a swap sends its transaction as before between two players here, and with its start bound across a border", async () => {
  inventoryRows.tradehero = [{ id: 1, username: "tradehero", item: "Iron Ore", quantity: 5, equipped: 0, slot: 0, bag_slot: 0 }];
  const online = new Map<string, any>();
  const person = (username: string, over: Record<string, unknown> = {}) => {
    const made = { id: `id-${username}`, username, isGuest: false, isDead: false, isGhost: false, pvp: false, location: { map: "overworld", position: { x: 100, y: 100 } }, ...over };
    online.set(username, made);
    return made;
  };
  const find = (username: string) => online.get(String(username).toLowerCase());
  const swapOnce = async (remote: boolean) => {
    await clearCaches();
    trades.reset();
    const trade = trades.open(person("tradehero"), person("tradeally", { remote }), Date.now());
    if (typeof trade === "string") throw new Error(trade);
    const offered = await trades.offer("tradehero", { items: [{ name: "Iron Ore", quantity: 1 }], coins: { gold: 0, silver: 0, copper: 0 } });
    expect(offered.ok).toBe(true);
    const at = Date.now() + ACCEPT_DELAY_MS;
    await trades.accept("tradehero", find, at);
    transactionCalls.length = 0;
    const before = Date.now();
    const answer = await trades.accept("tradeally", find, at);
    const after = Date.now();
    expect(answer.state).toBe("completed");
    return { calls: [...transactionCalls], before, after };
  };
  try {
    // Guard: only a swap across a border sets an open-by deadline
    const local = await swapOnce(false);
    expect(local.calls).toEqual([{ arity: 1, options: undefined }]);
    const across = await swapOnce(true);
    expect(across.calls).toHaveLength(1);
    expect(across.calls[0].arity).toBe(2);
    const openBy = (across.calls[0].options as { openBy: number }).openBy;
    expect(openBy).toBeGreaterThanOrEqual(across.before + swapStart.ms);
    expect(openBy).toBeLessThanOrEqual(across.after + swapStart.ms);
  } finally {
    trades.reset();
    delete inventoryRows.tradehero;
    await clearCaches();
  }
});

test("a swap across a border may not open after its start bound", async () => {
  const text = await source("../systems/trades.ts");
  const swap = text.slice(text.indexOf("async function swap("), text.indexOf("const trades = {"));
  // Guard: the swap's open-by deadline
  expect(swap).toContain("if (bound) batch.openBy(bound.startBy);");
});

test("the database client and worker hand the open-by deadline to the transaction", async () => {
  const worker = await source("../controllers/sqldatabase.worker.ts");
  // Guard: the worker passes the deadline on, and retries through runWithRetries only
  expect(worker).toContain("runTransaction(sqlController, statements, _databaseEngine, timeout, openBy)");
  expect(worker).toContain("runWithRetries(");
  expect(worker).toContain('queryTimeout, typeof openBy === "number" ? openBy : undefined)');
  const client = await source("../controllers/sqldatabase.ts");
  expect(client).toContain("options.openBy === undefined ? { transaction: statements } : { transaction: statements, openBy: options.openBy }");
});

// Security review H1: a mark holds a player's writes for as long as it says is left, so no mark is taken for longer
// than any node ever sets one (SETTLE_MS).
test("a mark that claims more than SETTLE_MS is held for SETTLE_MS", async () => {
  const { SETTLE_MS, leftOf } = await import("../cluster/tradesettle");
  expect(leftOf(JSON.stringify({ left: SETTLE_MS * 1000 }))).toBe(SETTLE_MS);
  expect(leftOf(JSON.stringify({ left: Number.MAX_SAFE_INTEGER }))).toBe(SETTLE_MS);
  expect(leftOf(JSON.stringify({ left: SETTLE_MS }))).toBe(SETTLE_MS);
  expect(leftOf(JSON.stringify({ left: 250 }))).toBe(250);
  const store = new MemoryStore();
  const c = new TradeSettle({ ms: 1000, ...quiet });
  c.attach(store);
  try {
    await store.set(settleKey("longalice"), JSON.stringify({ until: Date.now() + 1e12, peer: "node-h", left: 1e12 }), 60_000);
    const before = Date.now();
    expect(await c.importMark("longalice")).toBe(true);
    // Guard: the cap. Without it alice's bags, coins and an admin's writes wait for 30 years.
    expect(c.unsettledUntil("longalice")!).toBeLessThanOrEqual(Date.now() + SETTLE_MS);
    expect(c.unsettledUntil("longalice")!).toBeGreaterThanOrEqual(before);
  } finally {
    c.reset();
  }
});
