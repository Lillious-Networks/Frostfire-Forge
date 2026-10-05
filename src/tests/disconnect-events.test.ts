import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

// Neither socket/server.ts nor socket/receiver.ts can be imported (the first
// starts the server, the second imports the first), so the code under test is
// run from its source, with the names it uses handed in as fakes.

type Row = Record<string, any>;
const read = (file: string) => readFileSync(join(import.meta.dir, "..", "socket", file), "utf8");
const receiver = read("receiver.ts");
const server = read("server.ts");
const transpiler = new Bun.Transpiler({ loader: "ts" });

/** `source` from where `from` starts up to the first match of `until` after it. */
function cut(source: string, from: string, until: RegExp): string {
  const start = source.indexOf(from);
  if (start < 0) throw new Error(`Not found in the source: ${from}`);
  const rest = source.slice(start);
  const end = rest.search(until);
  if (end < 0) throw new Error(`No end found for: ${from}`);
  return rest.slice(0, end);
}

/** Code that names `names`, made into a function of them. */
function withNames(names: string[], code: string): (given: Row) => any {
  return new Function(`"use strict";\n${transpiler.transformSync(`function make({ ${names.join(", ")} }: any) { ${code} }`)}\nreturn make;`)();
}

// ------------------------------------------------------------------ fixtures

let online: Record<string, any>;
let sent: Array<{ to: any; packets: any[] }>;
let emitted: any[][];
/** What a disconnect did, in order. */
let order: string[];

function connect(id: string, username: string, over: Row = {}): any {
  const live: Row = {
    id, username, isGuest: false, friends: [], stats: { health: 10 },
    location: { map: "main.json", position: { x: 1, y: 2, direction: "down" } },
    wt: { readyState: 1, data: {}, send: () => {}, close: () => {} },
    ...over,
  };
  online[id] = live;
  return live;
}

const playerCache = {
  list: () => online,
  get: (id: string) => online[id],
  getByUsername: (username: string) => Object.values(online).find((live) => live.username === username),
  set: (id: string, value: any) => { online[id] = value; },
};
const listener = { emit: (...event: any[]) => { emitted.push(event); order.push(`emit ${event[0]}`); } };
const Events = { PLAYER_DISCONNECT: "onPlayerDisconnect", GUILD_CHANGED: "onGuildChanged" };
const sendPacket = (to: any, packets: any[]) => { sent.push({ to, packets }); };

beforeEach(() => {
  online = {};
  sent = [];
  emitted = [];
  order = [];
});

// ------------------------------------------------------------ dragged players

const dragRelease = withNames(
  ["draggedPlayersMap", "playerCache", "filterPlayersByMap", "sendPacket", "packetManager"],
  `${cut(receiver, "export function releaseDraggedBy(", /\r?\n}\r?\n/).replace("export ", "")}\n}\nreturn releaseDraggedBy;`,
);

function releaser(draggedPlayersMap: Map<any, any>): (adminId: string | number) => void {
  return dragRelease({
    draggedPlayersMap,
    playerCache,
    filterPlayersByMap: (map: string) => Object.values(online).filter((live) => live.location.map === map),
    sendPacket,
    packetManager: { dragPlayerStop: (data: Row) => [{ type: "DRAG_PLAYER_STOP", data }] },
  });
}

describe("an admin who leaves", () => {
  test("lets go of every player they were dragging, and the players on those maps are told", () => {
    const held = connect("11", "held");
    const watcher = connect("12", "watcher");
    const elsewhere = connect("13", "elsewhere", { location: { map: "cave.json", position: { x: 0, y: 0, direction: "down" } } });
    const gone = connect("14", "gone", { wt: { readyState: 3 } });
    // The drag packets store the ids as they arrive: a number for one, text for another.
    const dragged = new Map<any, any>([[11, "1"], [13, 1], [12, "2"]]);

    releaser(dragged)("1");

    expect([...dragged.entries()]).toEqual([[12, "2"]]);
    const stops = (who: any) => sent.filter((entry) => entry.to === who.wt).map((entry) => entry.packets[0].data);
    expect(stops(held)).toEqual([{ id: 11, adminId: "1" }]);
    expect(stops(watcher)).toEqual([{ id: 11, adminId: "1" }]);
    expect(stops(elsewhere)).toEqual([{ id: 13, adminId: "1" }]);
    expect(stops(gone)).toEqual([]);
  });

  test("holding nobody, nothing is sent", () => {
    connect("11", "held");
    const dragged = new Map<any, any>([[11, "2"]]);

    releaser(dragged)("1");

    expect(dragged.size).toBe(1);
    expect(sent).toEqual([]);
  });
});

// ----------------------------------------------------------------- admin drag

const dragCases = withNames(
  ["type", "data", "currentPlayer", "wt", "playerCache", "player", "log", "updatePlayerAOI", "spawnBatchQueue", "despawnBatchQueue", "packetManager", "broadcastToAOI", "draggedPlayersMap", "sendPacket", "filterPlayersByMap"],
  `return (async () => { let globalStateRevision = 0; switch (type) {${cut(receiver, '\n      case "DRAG_PLAYER_STOP": {', /\r?\n {6}}\r?\n/)}\n      }${cut(receiver, '\n      case "DRAG_UPDATE": {', /\r?\n {6}}\r?\n/)}\n      }\n} })();`,
);

/** Where each session's player was last saved. */
let savedAt: Record<string, Row>;
/** What was sent to the players who see the one dragged. */
let shown: Array<{ of: any; packets: any[] }>;

function drag(admin: any, data: Row, type = "DRAG_UPDATE"): Promise<void> {
  return dragCases({
    type,
    data,
    currentPlayer: admin,
    wt: admin.wt,
    draggedPlayersMap: new Map(),
    sendPacket,
    filterPlayersByMap: (map: string) => Object.values(online).filter((live) => live.location.map === map),
    playerCache,
    // As systems/player.ts saves a location: for the session with that id, and for nobody without one.
    player: {
      setLocation: async (session_id: string, map: string, position: Row) => {
        if (!session_id || !map || !position) return;
        if (!online[session_id]) return { affectedRows: 0 };
        savedAt[session_id] = { map, x: Math.round(position.x), y: Math.round(position.y), direction: position.direction };
        return { affectedRows: 1 };
      },
    },
    log: { error: () => {} },
    updatePlayerAOI: async () => {},
    spawnBatchQueue: new Map(),
    despawnBatchQueue: new Map(),
    packetManager: {
      moveXY: (moved: Row) => [{ type: "MOVEXY", data: moved }],
      dragPlayerStop: (stopped: Row) => [{ type: "DRAG_PLAYER_STOP", data: stopped }],
    },
    broadcastToAOI: (of: any, packets: any[]) => { shown.push({ of, packets }); },
  });
}

describe("an admin dragging a player", () => {
  beforeEach(() => {
    savedAt = {};
    shown = [];
  });

  test("moves them and shows it to the players who see them; where they are put down is saved once, when the drag stops", async () => {
    const admin = connect("1", "admin", { permissions: ["admin.drag"] });
    const held = connect("11", "held");

    await drag(admin, { id: "11", x: 20, y: 30 });
    await drag(admin, { id: "11", x: 40.4, y: 50.6 });

    expect(held.location.position).toEqual({ x: 40.4, y: 50.6, direction: "down" });
    // The updates arrive twenty a second: none of them writes.
    expect(savedAt).toEqual({});
    expect(shown).toHaveLength(2);
    shown = [shown[1]];

    await drag(admin, { id: "11" }, "DRAG_PLAYER_STOP");
    expect(savedAt).toEqual({ "11": { map: "main.json", x: 40, y: 51, direction: "down" } });
    expect(shown).toHaveLength(1);
    expect(shown[0].of).toBe(held);
    expect(shown[0].packets[0].data).toMatchObject({ i: "11", d: { x: 40.4, y: 50.6, dr: "down" } });
  });

  test("is for admins who may drag: anyone else moves and saves nothing", async () => {
    const nobody = connect("2", "nobody", { permissions: ["admin.kick"] });
    const held = connect("11", "held");

    await drag(nobody, { id: "11", x: 40, y: 50 });

    expect(held.location.position).toEqual({ x: 1, y: 2, direction: "down" });
    expect(savedAt).toEqual({});
    expect(shown).toEqual([]);
  });

  test("of someone who is not online does nothing", async () => {
    const admin = connect("1", "admin", { permissions: ["admin.*"] });

    await drag(admin, { id: "99", x: 40, y: 50 });

    expect(savedAt).toEqual({});
    expect(shown).toEqual([]);
  });
});

// ---------------------------------------------------------------- disconnect

const disconnectNames = [
  "playerCache", "packetManager", "effectManager", "dots", "getStunsForPlayer", "getSlowsForPlayer", "saveSicknessOnDisconnect",
  "loot", "cleanupPlayerState", "releaseDraggedBy", "listener", "Events", "removeFromAuthenticationQueues", "worlds", "log", "player", "console",
  "forgetPlayer",
];
const disconnectHandler = withNames(
  disconnectNames,
  `return ${cut(server, 'listener.on("onDisconnect", ', /\r?\n}\);\r?\n/).replace('listener.on("onDisconnect", ', "")}\n};`,
);

function onDisconnect(over: Row = {}): (data: Row) => Promise<void> {
  return disconnectHandler({
    playerCache,
    packetManager: { notify: () => [{}], updateOnlineStatus: () => [{}] },
    effectManager: { saveDots: () => {}, saveBarriers: () => {}, saveStuns: () => {}, saveSlows: () => {} },
    dots: { getPlayerDots: () => [] },
    getStunsForPlayer: () => [],
    getSlowsForPlayer: () => [],
    saveSicknessOnDisconnect: () => {},
    loot: { scheduleCleanup: () => {} },
    // As the server's own: the player is out of the cache once this has run.
    cleanupPlayerState: (live: any) => { order.push("cleanup"); delete online[live.id]; },
    releaseDraggedBy: (id: string) => { order.push(`release ${id}`); },
    listener,
    Events,
    removeFromAuthenticationQueues: () => {},
    worlds: { adjustPlayerCount: async () => 0 },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    player: {
      setStats: async () => { order.push("save"); },
      setLocation: async () => {},
      clearSessionId: async () => {},
    },
    console: { error: () => {} },
    forgetPlayer: async (username: string) => { order.push(`forget ${username}`); },
    ...over,
  });
}

describe("a connection that ends", () => {
  test("is announced once, after the cleanup and the release of dragged players, before anything is saved", async () => {
    const hero = connect("5", "hero");

    await onDisconnect()({ id: "5", reason: "player_left" });

    // Their cached rows are let go last, after the saves that write them.
    expect(order).toEqual(["cleanup", "release 5", "emit onPlayerDisconnect", "save", "forget hero"]);
    expect(emitted).toEqual([["onPlayerDisconnect", { player: hero }]]);

    // The player is out of the cache: the same disconnect again is nothing.
    await onDisconnect()({ id: "5", reason: "player_left" });
    expect(emitted).toHaveLength(1);
  });

  test("is announced for a guest too", async () => {
    const guest = connect("6", "guest_1", { isGuest: true });

    await onDisconnect()({ id: "6", reason: "player_left" });

    expect(emitted).toEqual([["onPlayerDisconnect", { player: guest }]]);
  });

  test("is still announced when saving the player fails", async () => {
    connect("5", "hero");
    const failing = onDisconnect({ player: { setStats: async () => { throw new Error("database gone"); }, setLocation: async () => {}, clearSessionId: async () => {} } });

    await failing({ id: "5", reason: "player_left" });

    expect(emitted.map((event) => event[0])).toEqual(["onPlayerDisconnect"]);
  });

  test("keeps the cached rows of a player who is already back in under a new session", async () => {
    connect("5", "hero");
    connect("8", "hero");

    await onDisconnect({ cleanupPlayerState: (live: any) => { delete online[live.id]; } })({ id: "5", reason: "session_stolen" });

    expect(order.filter((step) => step.startsWith("forget"))).toEqual([]);
    expect(online["8"]).toBeDefined();
  });

  test("of someone who never logged in is not a player's disconnect", async () => {
    await onDisconnect()({ id: "77", reason: "player_left" });

    expect(emitted).toEqual([]);
    expect(order).toEqual([]);
  });
});

// ----------------------------------------------------------------- guild join

const inviteNames = ["type", "response", "inviter", "currentPlayer", "wt", "guilds", "sendPacket", "packetManager", "playerCache", "broadcastPlayerUpdate", "player", "listener", "Events"];
const guildInvite = withNames(
  inviteNames,
  `return (async () => { switch (type) {${cut(receiver, '\n          case "INVITE_GUILD": {', /\r?\n {10}}\r?\n/)}\n          }\n} })();`,
);

/** The guilds table: who leads, and who is in which guild. */
let guildOf: Record<string, number>;
const guilds = {
  getGuildId: async (username: string) => guildOf[username.toLowerCase()] ?? null,
  isGuildLeader: async (username: string) => username === "leader",
  isInGuild: async (username: string) => username.toLowerCase() in guildOf,
  add: async (username: string, guildId: number) => {
    guildOf[username] = guildId;
    return Object.keys(guildOf).filter((name) => guildOf[name] === guildId);
  },
  getGuildName: async () => "Wolves",
};

function answerInvite(invited: any, inviter: any, response: string): Promise<void> {
  return guildInvite({
    type: "INVITE_GUILD",
    response,
    inviter,
    currentPlayer: invited,
    wt: invited.wt,
    guilds,
    sendPacket,
    packetManager: { notify: (data: Row) => [{ type: "NOTIFY", data }], updateGuild: (data: Row) => [{ type: "UPDATE_GUILD", data }] },
    playerCache,
    broadcastPlayerUpdate: () => {},
    player: { getSessionIdByUsername: async (username: string) => Object.values(online).find((live) => live.username === username)?.id },
    listener,
    Events,
  });
}

describe("a guild invitation", () => {
  beforeEach(() => {
    guildOf = { leader: 7 };
  });

  test("accepted, is announced as a join", async () => {
    const leader = connect("1", "leader");
    const newbie = connect("2", "newbie");

    await answerInvite(newbie, leader, "accept");

    expect(guildOf.newbie).toBe(7);
    expect(newbie.guild_name).toBe("Wolves");
    expect(emitted).toEqual([["onGuildChanged", { type: "join", guildId: 7, guildName: "Wolves", playerUsername: "newbie" }]]);
  });

  test("declined, or accepted by someone already in a guild, is not", async () => {
    const leader = connect("1", "leader");
    const newbie = connect("2", "newbie");

    await answerInvite(newbie, leader, "decline");
    expect(emitted).toEqual([]);

    guildOf.newbie = 9;
    await answerInvite(newbie, leader, "accept");
    expect(guildOf.newbie).toBe(9);
    expect(emitted).toEqual([]);
  });
});
