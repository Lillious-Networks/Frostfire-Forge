import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

// ------------------------------------------------------------ fake database
// The statements the party system sends, run against in-memory tables. A
// statement it does not know is an error, so a read that is not the load of
// the whole table fails the test that made it.

type Row = Record<string, any>;
let partiesTable: Row[];
let accountsTable: Row[];
let nextPartyId: number;
/** Every statement sent, with its values, in order. */
let queries: Array<[string, any[]]>;
/** A statement matching this is not answered: the connection is lost. */
let failing: RegExp | null;
/** The statement that was not answered was still made, as one that timed out can have been. Otherwise it was refused. */
let lostAfterWriting: boolean;
/** Whether an INSERT reports the id it gave the row. */
let reportsInsertId: boolean;

const LOAD = "SELECT id, leader, members FROM parties";

const accountOf = (username: string) => accountsTable.find((row) => row.username === String(username).toLowerCase());

async function database(sql: string, params: any[] = []): Promise<any> {
  queries.push([sql, params]);
  const lost = !!failing?.test(sql);
  if (lost && !lostAfterWriting) throw new Error("connection lost");
  const answer = run(sql, params);
  if (lost) throw new Error("connection lost");
  return answer;
}

function run(sql: string, params: any[]): any {
  switch (sql) {
    case LOAD:
      return partiesTable.map((row) => ({ ...row }));
    case "INSERT INTO parties (leader, members) VALUES (?, ?)": {
      const [leader, members] = params;
      const id = nextPartyId++;
      partiesTable.push({ id, leader, members });
      return reportsInsertId ? { lastInsertRowid: id, affectedRows: 1 } : { affectedRows: 1 };
    }
    case "UPDATE parties SET members = ? WHERE id = ?": {
      const [members, id] = params;
      for (const row of partiesTable) if (row.id === id) row.members = members;
      return { affectedRows: 1 };
    }
    case "DELETE FROM parties WHERE id = ?":
      partiesTable = partiesTable.filter((row) => row.id !== params[0]);
      return { affectedRows: 1 };
    case "UPDATE accounts SET party_id = ? WHERE username = ?": {
      const row = accountOf(params[1]);
      if (row) row.party_id = params[0];
      return { affectedRows: 1 };
    }
    case "UPDATE accounts SET party_id = ? WHERE username IN (?, ?)": {
      const [id, ...usernames] = params;
      for (const username of usernames) {
        const row = accountOf(username);
        if (row) row.party_id = id;
      }
      return { affectedRows: usernames.length };
    }
    case "UPDATE accounts SET party_id = NULL WHERE username = ?": {
      const row = accountOf(params[0]);
      if (row) row.party_id = null;
      return { affectedRows: 1 };
    }
    case "UPDATE accounts SET party_id = NULL WHERE party_id = ?":
      for (const row of accountsTable) if (row.party_id === params[0]) row.party_id = null;
      return { affectedRows: 1 };
  }
  throw new Error(`The fake database does not understand: ${sql}`);
}

mock.module("../controllers/sqldatabase", () => ({ default: database }));

const datacache = await import("../services/datacache");
const { default: log } = await import("../modules/logger");
const { default: parties } = await import("../systems/parties");

const reads = () => queries.map(([sql]) => sql).filter((sql) => sql.startsWith("SELECT"));
const writes = () => queries.filter(([sql]) => !sql.startsWith("SELECT"));
/** The accounts another system caches, that it was told to read again. */
const accountsDropped = () => dropRows.mock.calls.filter(([name]: any[]) => name === "accounts").map(([, key]: any[]) => key);
const partyIdOf = (username: string) => accountOf(username)?.party_id ?? null;
/** The parties the fake database holds, as `getAllParties` answers them. */
const inDatabase = () => partiesTable.map((row) => ({
  id: row.id,
  leader: row.leader,
  members: String(row.members ?? "").split(",").map((member) => member.trim()).filter(Boolean),
}));

let dropRows: ReturnType<typeof spyOn>;
let logged: Array<ReturnType<typeof spyOn>>;
beforeAll(() => {
  dropRows = spyOn(datacache, "dropRows");
  logged = [spyOn(log, "info"), spyOn(log, "warn"), spyOn(log, "error")].map((spy) => spy.mockImplementation(() => {}));
});
afterAll(() => {
  dropRows.mockRestore();
  for (const spy of logged) spy.mockRestore();
});

beforeEach(async () => {
  partiesTable = [
    { id: 1, leader: "user1", members: "user1, user2" },
    { id: 2, leader: "user4", members: "user4, user5, user6" },
  ];
  accountsTable = [
    { username: "user1", party_id: 1 },
    { username: "user2", party_id: 1 },
    { username: "user3", party_id: null },
    { username: "user4", party_id: 2 },
    { username: "user5", party_id: 2 },
    { username: "user6", party_id: 2 },
    { username: "user7", party_id: null },
  ];
  nextPartyId = 3;
  queries = [];
  failing = null;
  lostAfterWriting = false;
  reportsInsertId = true;
  await datacache.clearCaches();
  dropRows.mockClear();
});

// ------------------------------------------------- one read of the table

const questions: Array<[string, () => Promise<unknown>, unknown]> = [
  ["isInParty", () => parties.isInParty("user2"), true],
  ["isPartyLeader", () => parties.isPartyLeader("user1"), true],
  ["getPartyId", () => parties.getPartyId("user2"), 1],
  ["getPartyMembers", () => parties.getPartyMembers(1), ["user1", "user2"]],
  ["getPartyLeader", () => parties.getPartyLeader(1), "user1"],
  ["exists", () => parties.exists("user5"), true],
  ["getAllParties", () => parties.getAllParties(), [
    { id: 1, leader: "user1", members: ["user1", "user2"] },
    { id: 2, leader: "user4", members: ["user4", "user5", "user6"] },
  ]],
];

describe("a party question is answered from the table, read once", () => {
  test.each(questions)("%s: asked again, the database is not", async (_name, ask, answer) => {
    expect(await ask()).toEqual(answer);
    expect(await ask()).toEqual(answer);
    expect(queries).toEqual([[LOAD, []]]);
  });

  test("every question together costs that one read", async () => {
    for (const [, ask, answer] of questions) expect(await ask()).toEqual(answer);
    expect(queries).toEqual([[LOAD, []]]);
  });

  test("names match in any case, as the database matched them", async () => {
    expect(await parties.isInParty("USER2")).toBe(true);
    expect(await parties.getPartyId("User5")).toBe(2);
    expect(await parties.isPartyLeader("USER4")).toBe(true);
  });

  test("who is in a party is who its member list names", async () => {
    // An account pointing at a party that does not list it, and a list naming an account that points nowhere.
    accountOf("user3")!.party_id = 1;
    accountOf("user2")!.party_id = null;
    expect(await parties.isInParty("user3")).toBe(false);
    expect(await parties.getPartyId("user3")).toBeNull();
    expect(await parties.isInParty("user2")).toBe(true);
    expect(await parties.getPartyId("user2")).toBe(1);
    // Someone no list names, and someone the database has never heard of.
    expect(await parties.isInParty("user7")).toBe(false);
    expect(await parties.exists("nobody")).toBe(false);
    expect(await parties.isInParty("")).toBe(false);
    expect(await parties.getPartyId("")).toBeNull();
  });

  test("a member list is read as it is stored: trimmed, without blanks", async () => {
    partiesTable[0].members = " user1 ,user2,, ";
    partiesTable[1].members = null;
    expect(await parties.getPartyMembers(1)).toEqual(["user1", "user2"]);
    expect(await parties.getPartyMembers(2)).toEqual([]);
    expect((await parties.getAllParties()).map((party) => party.members)).toEqual([["user1", "user2"], []]);
    expect(await parties.isInParty("user5")).toBe(false);
  });

  test("a party that is not there has no leader or members", async () => {
    expect(await parties.getPartyLeader(9)).toBeNull();
    expect(await parties.getPartyMembers(9)).toEqual([]);
    expect(await parties.getPartyLeader(0)).toBeNull();
    // An id that arrived as text finds the same party.
    expect(await parties.getPartyLeader("2" as any)).toBe("user4");
    expect(queries).toEqual([[LOAD, []]]);
  });

  test("an answer is a copy: changing it changes nothing held", async () => {
    (await parties.getPartyMembers(1)).push("intruder");
    const all = await parties.getAllParties();
    all[0].leader = "intruder";
    all[0].members.length = 0;
    expect(await parties.getPartyMembers(1)).toEqual(["user1", "user2"]);
    expect(await parties.getAllParties()).toEqual(questions[6][2] as any);
  });

  test("no parties at all is an empty list, not asked for twice", async () => {
    partiesTable = [];
    expect(await parties.getAllParties()).toEqual([]);
    expect(await parties.isInParty("user1")).toBe(false);
    expect(await parties.isPartyLeader("user1")).toBe(false);
    expect(queries).toEqual([[LOAD, []]]);
  });
});

// ------------------------------------------- changes: database, then table

describe("a party change is written to the database, then to the table held", () => {
  test("create makes the party with its leader first", async () => {
    expect(await parties.create("user3", "user7")).toEqual(["user3", "user7"]);
    expect(writes()).toEqual([
      ["INSERT INTO parties (leader, members) VALUES (?, ?)", ["user3", "user3, user7"]],
      ["UPDATE accounts SET party_id = ? WHERE username IN (?, ?)", [3, "user3", "user7"]],
    ]);
    expect(accountsDropped().sort()).toEqual(["user3", "user7"]);

    expect(await parties.getPartyId("user7")).toBe(3);
    expect(await parties.getPartyLeader(3)).toBe("user3");
    expect(await parties.getPartyMembers(3)).toEqual(["user3", "user7"]);
    expect(await parties.isPartyLeader("user3")).toBe(true);
    expect((await parties.getAllParties()).map((party) => party.id)).toEqual([1, 2, 3]);
    expect(reads()).toEqual([LOAD]);
  });

  test("create is refused to a leader already in a party, with nothing written", async () => {
    expect(await parties.create("user2", "user3")).toBe(false);
    expect(await parties.create("", "user3")).toBe(false);
    expect(await parties.create("user3", "")).toBe(false);
    expect(writes()).toEqual([]);
  });

  test("create is refused when the second player is already in a party: nobody is on two lists", async () => {
    expect(await parties.create("user3", "user2")).toBe(false);
    expect(await parties.create("user3", "USER5")).toBe(false);
    expect(writes()).toEqual([]);
    expect(partyIdOf("user2")).toBe(1);
    expect(await parties.getPartyId("user2")).toBe(1);
    expect(await parties.isInParty("user3")).toBe(false);
    expect(await parties.getAllParties()).toEqual(inDatabase());
  });

  test("create reads the table again when the database does not say which id it gave", async () => {
    reportsInsertId = false;
    expect(await parties.create("user3", "user7")).toEqual(["user3", "user7"]);
    expect(await parties.getPartyId("user7")).toBe(3);
    expect(await parties.getPartyLeader(3)).toBe("user3");
    expect(reads()).toEqual([LOAD, LOAD]);
  });

  test("add puts the account and the member list in step", async () => {
    expect(await parties.add("user3", 1)).toEqual(["user1", "user2", "user3"]);
    expect(writes()).toEqual([
      ["UPDATE accounts SET party_id = ? WHERE username = ?", [1, "user3"]],
      ["UPDATE parties SET members = ? WHERE id = ?", ["user1, user2, user3", 1]],
    ]);
    expect(accountsDropped()).toEqual(["user3"]);

    expect(await parties.getPartyMembers(1)).toEqual(["user1", "user2", "user3"]);
    expect(await parties.getPartyId("user3")).toBe(1);
    expect(await parties.isInParty("user3")).toBe(true);
    expect(reads()).toEqual([LOAD]);
  });

  test("add refuses a member of any party, a full party and a party that is not there", async () => {
    expect(await parties.add("user5", 1)).toEqual([]);
    expect(await parties.add("USER5", 1)).toEqual([]);
    expect(await parties.add("user3", 9)).toEqual([]);
    expect(await parties.add("", 1)).toEqual([]);
    partiesTable[1].members = "user4, user5, user6, user8, user9";
    await datacache.clearCaches();
    expect(await parties.add("user3", 2)).toEqual([]);
    expect(writes()).toEqual([]);
  });

  test("remove takes the member off the list, and those left are still a party", async () => {
    expect(await parties.remove("user6")).toEqual(["user4", "user5"]);
    expect(writes()).toEqual([
      ["UPDATE accounts SET party_id = NULL WHERE username = ?", ["user6"]],
      ["UPDATE parties SET members = ? WHERE id = ?", ["user4, user5", 2]],
    ]);
    expect(accountsDropped()).toEqual(["user6"]);

    expect(await parties.isInParty("user6")).toBe(false);
    expect(await parties.getPartyId("user5")).toBe(2);
    expect(await parties.getPartyLeader(2)).toBe("user4");
    expect(await parties.getPartyMembers(2)).toEqual(["user4", "user5"]);
    expect(partyIdOf("user4")).toBe(2);
    expect(await parties.getAllParties()).toEqual(inDatabase());
    expect(reads()).toEqual([LOAD]);
  });

  test("remove finds the member whatever case the name came in, as the account was found", async () => {
    expect(await parties.remove("USER6")).toEqual(["user4", "user5"]);
    expect(partiesTable[1].members).toBe("user4, user5");
    expect(await parties.isInParty("user6")).toBe(false);
  });

  test("remove ends the party when one member would be left", async () => {
    expect(await parties.remove("user2")).toBe(true);
    expect(writes()).toEqual([
      ["UPDATE accounts SET party_id = NULL WHERE username = ?", ["user2"]],
      ["UPDATE parties SET members = ? WHERE id = ?", ["user1", 1]],
      ["DELETE FROM parties WHERE id = ?", [1]],
      ["UPDATE accounts SET party_id = NULL WHERE party_id = ?", [1]],
    ]);
    expect([...new Set(accountsDropped())].sort()).toEqual(["user1", "user2"]);

    expect(await parties.isInParty("user1")).toBe(false);
    expect(await parties.isPartyLeader("user1")).toBe(false);
    expect((await parties.getAllParties()).map((party) => party.id)).toEqual([2]);
    expect(reads()).toEqual([LOAD]);
  });

  // A party with nobody leading it could not invite or kick: it goes with its leader, as when the leader leaves.
  test("remove of the leader ends the party, however many were in it", async () => {
    expect(await parties.remove("user4")).toBe(true);
    expect(await parties.getAllParties()).toEqual([{ id: 1, leader: "user1", members: ["user1", "user2"] }]);
    expect(await parties.getAllParties()).toEqual(inDatabase());
    expect([partyIdOf("user4"), partyIdOf("user5"), partyIdOf("user6")]).toEqual([null, null, null]);
  });

  test("remove of someone in no party writes nothing", async () => {
    expect(await parties.remove("user3")).toEqual([]);
    expect(writes()).toEqual([]);
  });

  test("remove whose party the database refuses to delete holds what the database holds", async () => {
    failing = /^DELETE FROM parties/;
    expect(await parties.remove("user2")).toBe(true);
    failing = null;
    expect(partiesTable[0]).toEqual({ id: 1, leader: "user1", members: "user1" });
    expect(await parties.getAllParties()).toEqual(inDatabase());
    expect(await parties.isInParty("user2")).toBe(false);
    expect(reads()).toEqual([LOAD, LOAD]);
  });

  test("delete takes the party out and frees its members' accounts", async () => {
    expect(await parties.delete(1)).toBe(true);
    expect(writes()).toEqual([
      ["DELETE FROM parties WHERE id = ?", [1]],
      ["UPDATE accounts SET party_id = NULL WHERE party_id = ?", [1]],
    ]);
    expect(accountsDropped().sort()).toEqual(["user1", "user2"]);

    expect(await parties.getPartyLeader(1)).toBeNull();
    expect(await parties.isInParty("user2")).toBe(false);
    expect(await parties.isPartyLeader("user1")).toBe(false);
    expect((await parties.getAllParties()).map((party) => party.id)).toEqual([2]);
    expect(reads()).toEqual([LOAD]);
  });

  test("leave by the leader ends the party; by a member it is a removal", async () => {
    expect(await parties.leave("user3")).toBe(false);
    expect(writes()).toEqual([]);

    expect(await parties.leave("user1")).toBe(true);
    expect(writes()).toEqual([
      ["DELETE FROM parties WHERE id = ?", [1]],
      ["UPDATE accounts SET party_id = NULL WHERE party_id = ?", [1]],
    ]);
    expect(await parties.isInParty("user2")).toBe(false);

    // Three were in it: the two left are still a party.
    queries = [];
    expect(await parties.leave("user5")).toEqual(["user4", "user6"]);
    expect(writes()).toEqual([
      ["UPDATE accounts SET party_id = NULL WHERE username = ?", ["user5"]],
      ["UPDATE parties SET members = ? WHERE id = ?", ["user4, user6", 2]],
    ]);
    expect(await parties.getPartyMembers(2)).toEqual(["user4", "user6"]);

    // Two were in it: one alone is no party.
    queries = [];
    expect(await parties.leave("user6")).toBe(true);
    expect(writes().map(([sql]) => sql)).toEqual([
      "UPDATE accounts SET party_id = NULL WHERE username = ?",
      "UPDATE parties SET members = ? WHERE id = ?",
      "DELETE FROM parties WHERE id = ?",
      "UPDATE accounts SET party_id = NULL WHERE party_id = ?",
    ]);
    expect(await parties.getAllParties()).toEqual([]);
    expect(reads()).toEqual([]);
  });

  test("disband by the leader ends the party", async () => {
    expect(await parties.disband("user4")).toBe(true);
    expect(writes()).toEqual([
      ["UPDATE accounts SET party_id = NULL WHERE party_id = ?", [2]],
      ["DELETE FROM parties WHERE id = ?", [2]],
      ["UPDATE accounts SET party_id = NULL WHERE party_id = ?", [2]],
    ]);
    expect([...new Set(accountsDropped())].sort()).toEqual(["user4", "user5", "user6"]);

    expect(await parties.isInParty("user5")).toBe(false);
    expect(await parties.isPartyLeader("user4")).toBe(false);
    expect(await parties.getPartyMembers(2)).toEqual([]);
    expect(reads()).toEqual([LOAD]);
  });

  test("disband is refused to a member who does not lead, and to someone in no party", async () => {
    expect(await parties.disband("user5")).toBe(false);
    expect(await parties.disband("user3")).toBe(false);
    expect(writes()).toEqual([]);
  });

});

// --------------------------------- a write the database does not answer

// Each write, the statement of it that is not answered, what the write then
// answers, and the accounts the player system must be told to read again.
const unanswered: Array<[string, RegExp, () => Promise<unknown>, unknown, string[]]> = [
  ["create (the party)", /^INSERT INTO parties/, () => parties.create("user3", "user7"), false, []],
  ["create (the accounts)", /^UPDATE accounts/, () => parties.create("user3", "user7"), false, ["user3", "user7"]],
  ["add (the account)", /^UPDATE accounts/, () => parties.add("user3", 1), [], ["user3"]],
  ["add (the member list)", /^UPDATE parties/, () => parties.add("user3", 1), [], ["user3"]],
  ["remove (the account)", /^UPDATE accounts/, () => parties.remove("user6"), [], ["user6"]],
  ["remove (the member list)", /^UPDATE parties/, () => parties.remove("user6"), [], ["user6"]],
  ["delete (the party)", /^DELETE FROM parties/, () => parties.delete(1), false, []],
  ["delete (the accounts)", /^UPDATE accounts/, () => parties.delete(1), false, ["user1", "user2"]],
  ["leave by the leader", /^DELETE FROM parties/, () => parties.leave("user1"), false, []],
  ["leave by a member", /^UPDATE parties/, () => parties.leave("user5"), [], ["user5"]],
  ["disband (the accounts)", /^UPDATE accounts/, () => parties.disband("user4"), false, ["user4", "user5", "user6"]],
  ["disband (the party)", /^DELETE FROM parties/, () => parties.disband("user4"), false, ["user4", "user5", "user6"]],
];

// A statement that timed out may still have been applied, so after either
// kind of failure the table is read again rather than trusted.
for (const made of [false, true]) {
  describe(`a party write the database ${made ? "made but never answered" : "refused"}`, () => {
    test.each(unanswered)("%s: the table is read again, so what is held is what the database holds", async (_name, statement, write, answer, accounts) => {
      await parties.getAllParties();
      lostAfterWriting = made;
      failing = statement;
      expect(await write()).toEqual(answer);
      failing = null;

      expect(reads()).toEqual([LOAD, LOAD]);
      expect([...new Set(accountsDropped())].sort()).toEqual(accounts);
      expect(await parties.getAllParties()).toEqual(inDatabase());
      expect(reads()).toEqual([LOAD, LOAD]);
    });
  });
}

test("a write that was made but never answered is what the next read answers", async () => {
  await parties.getAllParties();
  lostAfterWriting = true;

  failing = /^UPDATE parties/;
  expect(await parties.add("user3", 1)).toEqual([]);
  expect(await parties.getPartyMembers(1)).toEqual(["user1", "user2", "user3"]);
  expect(await parties.getPartyId("user3")).toBe(1);

  failing = /^DELETE FROM parties/;
  expect(await parties.delete(2)).toBe(false);
  expect(await parties.getPartyLeader(2)).toBeNull();
  expect(await parties.isInParty("user5")).toBe(false);

  failing = /^INSERT INTO parties/;
  expect(await parties.create("user7", "user4")).toBe(false);
  expect(await parties.getPartyId("user7")).toBe(3);
  expect(await parties.getPartyLeader(3)).toBe("user7");
});

test("when the table cannot be read again either, the write still answers that it failed", async () => {
  await parties.getAllParties();
  failing = /^UPDATE parties|^SELECT/;
  expect(await parties.add("user3", 1)).toEqual([]);
  failing = null;
  expect(reads()).toEqual([LOAD, LOAD]);
});

// ------------------------------------------------- what the callers do
// socket/receiver.ts cannot be imported (it imports the server, which starts
// it), so its party cases are run from their source over the real party
// system, with the other names they use handed in as fakes.

const receiver = readFileSync(join(import.meta.dir, "..", "socket", "receiver.ts"), "utf8");
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

const caseNames = [
  "type", "data", "response", "inviter", "currentPlayer", "wt", "parties", "player", "playerCache", "sendPacket", "packetManager",
  "listener", "Events", "syncPartyLayers", "sendAnimationTo", "queueSpawnPlayerPacket", "getAnimationNameForDirection",
  "getPlayerSpriteSheetData", "getMountSpriteUrl", "spellEffects", "queueSpawnForReceivers",
];

/** One `case` of a switch in the receiver, indented by `indent`, as a function of the names it uses. */
function receiverCase(name: string, indent: number): (given: Row) => Promise<void> {
  const body = cut(receiver, `\n${" ".repeat(indent)}case "${name}": {`, new RegExp(`\\r?\\n {${indent}}}\\r?\\n`));
  const code = `return (async () => { switch (type) {${body}\n}\n} })();`;
  return new Function(`"use strict";\n${transpiler.transformSync(`function make({ ${caseNames.join(", ")} }: any) { ${code} }`)}\nreturn make;`)();
}

const kickCase = receiverCase("KICK_PARTY_MEMBER", 6);
const leaveCase = receiverCase("LEAVE_PARTY", 6);
// The answer to an invitation, not the sending of one: the case inside INVITATION_RESPONSE.
const inviteAnswerCase = receiverCase("INVITE_PARTY", 10);

let online: Record<string, any>;
/** Who was sent what, in order. */
let sent: Array<[string, Row]>;
let emitted: any[][];
let synced: Array<[string, string[]]>;

function connect(username: string): any {
  const live = { id: `session-${username}`, username, isGuest: false, party: ["as", "it", "was"], invitations: [], wt: { username } };
  online[live.id] = live;
  return live;
}

const sentTo = (username: string) => sent.filter(([to]) => to === username).map(([, packet]) => packet);
const notice = (message: string) => ({ type: "NOTIFY", data: { message } });
const partyNow = (members: string[]) => ({ type: "UPDATE_PARTY", data: { members } });

const given = () => ({
  parties,
  player: { getSessionIdByUsername: async (username: string) => Object.values(online).find((live) => live.username === username)?.id },
  playerCache: { get: (id: string) => online[id], set: (id: string, value: any) => { online[id] = value; }, list: () => online },
  sendPacket: (to: any, packet: Row) => { sent.push([to.username, packet]); },
  packetManager: {
    notify: (data: Row) => ({ type: "NOTIFY", data }),
    updateParty: (data: Row) => ({ type: "UPDATE_PARTY", data }),
    despawnPlayer: (id: string) => ({ type: "DESPAWN_PLAYER", data: { id } }),
  },
  listener: { emit: (...event: any[]) => { emitted.push(event); } },
  Events: { PARTY_CHANGED: "onPartyChanged" },
  syncPartyLayers: async (leader: string, members: string[]) => { synced.push([leader, members]); },
  sendAnimationTo: async () => {},
  queueSpawnPlayerPacket: () => null,
  getAnimationNameForDirection: () => "",
  getPlayerSpriteSheetData: async () => null,
  getMountSpriteUrl: () => null,
  spellEffects: { getEffectsPayload: () => [] },
  queueSpawnForReceivers: () => {},
});

/** The cases tell each member without waiting for it to be done: let that finish. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

async function kick(leader: any, username: string): Promise<void> {
  await kickCase({ ...given(), type: "KICK_PARTY_MEMBER", data: { username }, currentPlayer: leader, wt: leader.wt });
  await settled();
}
async function leave(live: any): Promise<void> {
  await leaveCase({ ...given(), type: "LEAVE_PARTY", data: {}, currentPlayer: live, wt: live.wt });
  await settled();
}
async function answerInvite(invited: any, inviter: any, response = "ACCEPT"): Promise<void> {
  await inviteAnswerCase({ ...given(), type: "INVITE_PARTY", response, inviter, currentPlayer: invited, wt: invited.wt });
  await settled();
}

describe("what the socket layer does with a party's answer", () => {
  beforeEach(() => {
    online = {};
    sent = [];
    emitted = [];
    synced = [];
  });

  test("a kick from a party of three: those left get the new list, the kicked player is told they have no party", async () => {
    const [leader, stays, kicked] = ["user4", "user5", "user6"].map(connect);
    await kick(leader, "user6");

    expect(partiesTable[1]).toEqual({ id: 2, leader: "user4", members: "user4, user5" });
    expect(sentTo("user4")).toEqual([notice("User6 has been kicked from the party"), partyNow(["user4", "user5"])]);
    expect(sentTo("user5")).toEqual([partyNow(["user4", "user5"]), notice("User4 has kicked User6 from the party")]);
    expect(sentTo("user6")).toEqual([partyNow([]), notice("You have been kicked from the party")]);
    expect([leader.party, stays.party, kicked.party]).toEqual([["user4", "user5"], ["user4", "user5"], []]);
    expect(synced).toEqual([["user4", ["user4", "user5"]]]);
    expect(emitted).toEqual([["onPartyChanged", { type: "kick", username: "user4", kickedUsername: "user6", members: ["user6"] }]]);
  });

  test("a kick from a party of two ends it, and both are told", async () => {
    const [leader, kicked] = ["user1", "user2"].map(connect);
    await kick(leader, "user2");

    expect(partiesTable.map((row) => row.id)).toEqual([2]);
    for (const username of ["user1", "user2"]) expect(sentTo(username)).toEqual([partyNow([]), notice("The party has been disbanded")]);
    expect([leader.party, kicked.party]).toEqual([[], []]);
    expect(emitted).toEqual([["onPartyChanged", { type: "disband", members: ["user1", "user2"] }]]);
  });

  test("a kick the database does not answer is reported as failed, and nobody is told anything else", async () => {
    connect("user5");
    connect("user6");
    failing = /^UPDATE parties/;
    await kick(connect("user4"), "user6");
    failing = null;

    expect(sent).toEqual([["user4", notice("Failed to kick User6 from the party")]]);
    expect(emitted).toEqual([]);
  });

  test("a member leaving a party of three is told they have no party, and those left get the new list", async () => {
    const [leader, stays, leaver] = ["user4", "user5", "user6"].map(connect);
    await leave(leaver);

    expect(partiesTable[1]).toEqual({ id: 2, leader: "user4", members: "user4, user5" });
    expect(sentTo("user6")).toEqual([notice("You have left the party"), partyNow([])]);
    for (const username of ["user4", "user5"]) expect(sentTo(username)).toEqual([partyNow(["user4", "user5"]), notice("User6 has left the party")]);
    expect([leader.party, stays.party, leaver.party]).toEqual([["user4", "user5"], ["user4", "user5"], []]);
    expect(synced).toEqual([["user4", ["user4", "user5"]]]);
    expect(emitted).toEqual([["onPartyChanged", { type: "leave", username: "user6", members: ["user6"] }]]);
  });

  test("the leader leaving, or one of only two, ends the party for everyone", async () => {
    const three = ["user4", "user5", "user6"].map(connect);
    await leave(three[0]);
    for (const username of ["user4", "user5", "user6"]) expect(sentTo(username)).toEqual([partyNow([]), notice("The party has been disbanded")]);
    expect(three.map((live) => live.party)).toEqual([[], [], []]);

    const two = ["user1", "user2"].map(connect);
    await leave(two[1]);
    for (const username of ["user1", "user2"]) expect(sentTo(username)).toEqual([partyNow([]), notice("The party has been disbanded")]);
    expect(partiesTable).toEqual([]);
    expect(emitted.map(([, event]) => event.type)).toEqual(["disband", "disband"]);
  });

  test("a leave the database does not answer is reported as failed", async () => {
    connect("user4");
    failing = /^UPDATE parties/;
    await leave(connect("user6"));
    failing = null;

    expect(sent).toEqual([["user6", notice("Failed to leave party")]]);
    expect(emitted).toEqual([]);
  });

  test("an invitation accepted joins the inviter's party, or makes one", async () => {
    const [leader, member, joins] = ["user1", "user2", "user3"].map(connect);
    await answerInvite(joins, leader);
    expect(partiesTable[0].members).toBe("user1, user2, user3");
    expect(sentTo("user3")).toEqual([notice("You have joined User1's party"), partyNow(["user1", "user2", "user3"])]);
    expect(sentTo("user2")).toEqual([partyNow(["user1", "user2", "user3"])]);
    expect(member.party).toEqual(["user1", "user2", "user3"]);

    const [inviter, invited] = [connect("user7"), connect("user8")];
    accountsTable.push({ username: "user8", party_id: null });
    await answerInvite(invited, inviter);
    expect(partiesTable[2]).toEqual({ id: 3, leader: "user7", members: "user7, user8" });
    expect(sentTo("user8")[0]).toEqual(notice("You have joined User7's party"));
    expect(invited.party).toEqual(["user7", "user8"]);
  });

  test("an invitation into a party the player cannot join says so, and not that they joined", async () => {
    // Already in another party since the invitation was sent.
    const [leader, invited] = [connect("user1"), connect("user5")];
    await answerInvite(invited, leader);

    expect(sent).toEqual([["user5", notice("Failed to join party")]]);
    expect(writes()).toEqual([]);
    expect(invited.party).toEqual(["as", "it", "was"]);
    expect(emitted).toEqual([]);
  });

  test("an invitation accepted is announced as a join; one declined is not, and changes nothing", async () => {
    const [leader, , joins] = ["user1", "user2", "user3"].map(connect);
    await answerInvite(joins, leader);
    expect(emitted).toEqual([["onPartyChanged", { type: "join", username: "user3", members: ["user1", "user2", "user3"] }]]);

    emitted = [];
    const [inviter, invited] = [connect("user7"), connect("user8")];
    accountsTable.push({ username: "user8", party_id: null });
    const before = writes().length;
    await answerInvite(invited, inviter, "DECLINE");
    expect(emitted).toEqual([]);
    expect(writes()).toHaveLength(before);
  });

  test("an invitation from a player without a party is refused to one who has since joined another", async () => {
    const [inviter, invited] = [connect("user3"), connect("user2")];
    await answerInvite(invited, inviter);

    expect(sent).toEqual([["user2", notice("Failed to create party")]]);
    expect(writes()).toEqual([]);
    expect(await parties.getAllParties()).toEqual(inDatabase());
    expect(partiesTable.map((row) => row.members)).toEqual(["user1, user2", "user4, user5, user6"]);
    expect(emitted).toEqual([]);
  });
});

// ------------------------------------------------------------- behaviour

test("parties.isInParty returns true for users in party", async () => {
  const result = await parties.isInParty("user1");
  expect(result).toBe(true);
});

test("parties.isInParty returns false for users not in party", async () => {
  const result = await parties.isInParty("user3");
  expect(result).toBe(false);
});

test("parties.isPartyLeader returns true for party leaders", async () => {
  const result = await parties.isPartyLeader("user1");
  expect(result).toBe(true);
});

test("parties.isPartyLeader returns false for non-leaders", async () => {
  const result = await parties.isPartyLeader("user2");
  expect(result).toBe(false);
});

test("parties.getPartyId returns party id", async () => {
  const result = await parties.getPartyId("user1");
  expect(result).toBe(1);
});

test("parties.getPartyId returns null for non-members", async () => {
  const result = await parties.getPartyId("user3");
  expect(result).toBeNull();
});

test("parties.getPartyMembers returns members list", async () => {
  const result = await parties.getPartyMembers(1);
  expect(result).toContain("user1");
  expect(result).toContain("user2");
});

test("parties.getPartyLeader returns leader name", async () => {
  const result = await parties.getPartyLeader(1);
  expect(result).toBe("user1");
});

test("parties.getAllParties returns all parties", async () => {
  const result = await parties.getAllParties();
  expect(Array.isArray(result)).toBe(true);
  expect(result.length).toBeGreaterThan(0);
});
