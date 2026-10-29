import { beforeEach, describe, expect, test } from "bun:test";
import { ClusterBus } from "../cluster/bus";
import { Delivery } from "../cluster/deliver";
import { PlayerDirectory } from "../cluster/directory";
import { Invitations, type Invitation } from "../cluster/invitations";
import { MemoryStore } from "../cluster/memorystore";
import { PlayerManager } from "../services/playermanager";
import { receiverSource } from "./receiver-source";

// The bus signs its envelopes (security review H1): every bus of a test shares this key.
const TEST_BUS_KEY = "test-bus-key";

// Party, guild and friend invitations, held where the one who answers can find
// them: in this process without a cluster, in the cluster store with one.

const invite = (fields: Partial<Invitation> = {}): Invitation => ({
  action: "INVITE_PARTY",
  originator: "7",
  originatorName: "Hero",
  authorization: "auth-1",
  target: "sidekick",
  ...fields,
});

for (const mode of ["without a store", "with a store"] as const) {
  describe(`Invitations ${mode}`, () => {
    let invitations: Invitations;
    beforeEach(() => {
      invitations = new Invitations(mode === "with a store" ? new MemoryStore() : null);
    });

    test("an invitation is taken once", async () => {
      await invitations.add(invite());
      expect(await invitations.take("auth-1")).toEqual(invite());
      expect(await invitations.take("auth-1")).toBeNull();
    });

    test("an unknown authorization takes nothing", async () => {
      expect(await invitations.take("nope")).toBeNull();
    });

    test("findFrom finds an open invitation by originator, action and target", async () => {
      await invitations.add(invite());
      await invitations.add(invite({ action: "INVITE_GUILD", authorization: "auth-2", target: "other" }));
      expect(await invitations.findFrom("hero", "INVITE_PARTY", "Sidekick")).toEqual(invite());
      expect(await invitations.findFrom("hero", "INVITE_PARTY")).toEqual(invite());
      expect((await invitations.findFrom("Hero", "INVITE_GUILD", "other"))?.authorization).toBe("auth-2");
      expect(await invitations.findFrom("hero", "INVITE_GUILD", "sidekick")).toBeNull();
      expect(await invitations.findFrom("someone", "INVITE_PARTY")).toBeNull();
    });

    test("findFrom does not find a taken invitation", async () => {
      await invitations.add(invite());
      await invitations.take("auth-1");
      expect(await invitations.findFrom("hero", "INVITE_PARTY", "sidekick")).toBeNull();
    });
  });
}

describe("Invitations with a store", () => {
  test("two nodes on one store see each other's invitations", async () => {
    const store = new MemoryStore();
    const a = new Invitations(store);
    const b = new Invitations(store);
    await a.add(invite());
    expect((await b.findFrom("hero", "INVITE_PARTY", "sidekick"))?.authorization).toBe("auth-1");
    expect(await b.take("auth-1")).toEqual(invite());
    expect(await a.take("auth-1")).toBeNull();
    expect(await a.findFrom("hero", "INVITE_PARTY")).toBeNull();
  });

  test("an invitation expires after its ttl", async () => {
    const invitations = new Invitations(new MemoryStore());
    await invitations.add(invite(), 20);
    await Bun.sleep(30);
    expect(await invitations.findFrom("hero", "INVITE_PARTY")).toBeNull();
    expect(await invitations.take("auth-1")).toBeNull();
  });

  test("the list of what a player sent expires with their invitations", async () => {
    const store = new MemoryStore();
    const invitations = new Invitations(store);
    await invitations.add(invite(), 20);
    expect(await store.members("cells:invitesfrom:hero")).toEqual(["auth-1"]);
    await Bun.sleep(30);
    expect(await store.members("cells:invitesfrom:hero")).toEqual([]);
  });

  test("the store is attached after the singleton is made", async () => {
    const store = new MemoryStore();
    const invitations = new Invitations(null);
    invitations.attach(store);
    await invitations.add(invite());
    expect(await new Invitations(store).take("auth-1")).toEqual(invite());
  });
});

describe("Invitations without a store", () => {
  test("an originator who leaves the player cache takes their invitations along", async () => {
    const cache = new PlayerManager();
    const invitations = new Invitations(null, cache);
    cache.set("7", { id: 7, username: "Hero" });
    cache.set("8", { id: 8, username: "Other" });
    await invitations.add(invite());
    await invitations.add(invite({ originator: "8", originatorName: "Other", authorization: "auth-2" }));
    cache.remove("7");
    expect(await invitations.take("auth-1")).toBeNull();
    expect(await invitations.findFrom("hero", "INVITE_PARTY")).toBeNull();
    expect((await invitations.take("auth-2"))?.originatorName).toBe("Other");
  });

  test("a newer session of the same name keeps what it sent when the old one leaves", async () => {
    const cache = new PlayerManager();
    const invitations = new Invitations(null, cache);
    cache.set("7", { id: 7, username: "Hero" });
    cache.set("9", { id: 9, username: "Hero" });
    await invitations.add(invite({ originator: "9", authorization: "auth-new" }));
    cache.remove("7");
    expect((await invitations.take("auth-new"))?.originator).toBe("9");
  });
});

// A party invitation from a player on node a to one on node b: answered on b, the inviter's side runs on a.
describe("an invitation across nodes", () => {
  const encode = (text: string) => new TextEncoder().encode(text);
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };

  function member(username: string, fields: Record<string, any> = {}): any {
    const sent: string[] = [];
    return { username, ...fields, sent, wt: { readyState: 1, send: (p: Uint8Array) => sent.push(decode(p)), sendBestEffort: (p: Uint8Array) => sent.push(`~${decode(p)}`) } };
  }

  function players(entries: Record<string, any>) {
    return {
      get: (key: string) => entries[key],
      getByUsername: (name: string) => Object.values(entries).find((p) => p.username.toLowerCase() === name.toLowerCase()),
      list: () => entries,
    };
  }

  async function node(store: MemoryStore, id: string, entries: Record<string, any>) {
    const bus = new ClusterBus(store, id, TEST_BUS_KEY);
    const directory = new PlayerDirectory(store, id);
    const delivery = new Delivery(players(entries));
    delivery.attach(bus, directory);
    await bus.start();
    for (const [key, p] of Object.entries(entries)) await directory.claim(p.username, key, "main");
    delivery.registerAction("party-update", (p, { members }) => {
      p.party = members;
      p.wt.send(encode(`party:${members.join(",")}`));
    });
    return { delivery, invitations: new Invitations(store) };
  }

  test("is answered on the invitee's node and the inviter's side runs on theirs", async () => {
    const store = new MemoryStore();
    const hero = member("Hero");
    const sidekick = member("Sidekick");
    const a = await node(store, "a", { "7": hero });
    const b = await node(store, "b", { "8": sidekick });

    // On a: the invitation is kept and reaches the invitee on b.
    await a.invitations.add(invite());
    expect(await a.delivery.deliverToPlayer("sidekick", [encode("invite:auth-1")])).toBe(true);
    await settle();
    expect(sidekick.sent).toEqual(["invite:auth-1"]);

    // On b: the answer takes it, finds the inviter online, and updates them where they are.
    const taken = await b.invitations.take("auth-1");
    expect(taken?.originatorName).toBe("Hero");
    expect(await b.delivery.isOnline(taken!.originatorName)).toBe(true);
    expect(await b.delivery.runOnPlayer(taken!.originatorName, "party-update", { members: ["hero", "sidekick"] })).toBe(true);
    expect(await b.delivery.deliverToPlayer(taken!.originatorName, [encode("Sidekick has joined your party")])).toBe(true);
    await settle();
    expect(hero.party).toEqual(["hero", "sidekick"]);
    expect(hero.sent).toEqual(["party:hero,sidekick", "Sidekick has joined your party"]);

    // A second answer, on either node, finds nothing.
    expect(await b.invitations.take("auth-1")).toBeNull();
    expect(await a.invitations.take("auth-1")).toBeNull();
  });
});

// ------------------------------------------------- what the receiver does with an answer
// socket/receiver.ts cannot be imported (it imports the server, which starts it), so
// INVITATION_RESPONSE is run from its source with the names it uses handed in as fakes.

describe("INVITATION_RESPONSE", () => {
  const receiver = receiverSource();
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const from = `\n      case "INVITATION_RESPONSE": {`;
  const start = receiver.indexOf(from);
  const rest = receiver.slice(start);
  const body = rest.slice(0, rest.search(/\r?\n {6}\}\r?\n/));
  const names = [
    "type", "data", "currentPlayer", "wt", "log", "playerCache", "sendPacket", "packetManager", "invitations", "isOnline",
    "clusterEnabled", "subscriptionLocked", "friends", "deliverToPlayer", "listener", "Events",
  ];
  const answerCase: (given: Record<string, any>) => Promise<void> = new Function(
    `"use strict";\n${transpiler.transformSync(`function make({ ${names.join(", ")} }: any) { return (async () => { switch (type) {${body}\n}\n} })(); }`)}\nreturn make;`,
  )();

  type Packet = { type: string; data: any };
  let online: Record<string, any>;
  let sent: Array<[string, Packet]>;
  let locked: boolean;
  let cluster: boolean;
  let held: Invitations;

  const notice = (message: string) => ({ type: "NOTIFY", data: { message } });
  const sentTo = (username: string) => sent.filter(([to]) => to === username).map(([, packet]) => packet);
  const connect = (id: string, username: string) => (online[id] = { id, username, wt: { username } });
  const find = (username: string) => Object.values(online).find((p) => p.username.toLowerCase() === username.toLowerCase());

  beforeEach(() => {
    online = {};
    sent = [];
    locked = false;
    cluster = false;
    held = new Invitations(null);
  });

  const answer = (answering: any, data: Record<string, any>) => answerCase({
    type: "INVITATION_RESPONSE",
    data,
    currentPlayer: answering,
    wt: answering.wt,
    log: { info: () => {} },
    playerCache: { get: (id: string) => online[id], set: (id: string, value: any) => { online[id] = value; } },
    sendPacket: (to: any, packet: Packet) => { sent.push([to.username, packet]); },
    packetManager: { notify: (data: any) => ({ type: "NOTIFY", data }), updateFriends: (data: any) => ({ type: "UPDATE_FRIENDS", data }) },
    invitations: held,
    // As cluster/deliver.ts: on this node, or (with `cluster`) "hero" is online on another one.
    isOnline: async (username: string) => !!find(username) || (cluster && username.toLowerCase() === "hero"),
    clusterEnabled: () => cluster,
    subscriptionLocked: () => locked,
    friends: { add: async (_name: string, friend: string) => [friend] },
    deliverToPlayer: async (username: string, packet: Packet) => {
      const live = find(username);
      if (live) sent.push([live.username, packet]);
      else if (cluster && username.toLowerCase() === "hero") sent.push(["hero@b", packet]);
      else return false;
      return true;
    },
    listener: { emit: () => {} },
    Events: { FRIEND_ADDED: "onFriendAdded" },
  });

  const friendRequest = () => held.add({ action: "FRIEND_REQUEST", originator: "7", originatorName: "Hero", authorization: "auth-1", target: "Sidekick" });
  const accept = { action: "FRIEND_REQUEST", originator: "7", authorization: "auth-1", response: "ACCEPT" };

  test("an accepted friend request tells both, and a second answer finds nothing", async () => {
    connect("7", "Hero");
    const sidekick = connect("8", "Sidekick");
    await friendRequest();
    await answer(sidekick, accept);
    expect(sentTo("Sidekick")).toEqual([notice("You are now friends with Hero"), { type: "UPDATE_FRIENDS", data: { friends: ["hero"] } }]);
    expect(sentTo("Hero")).toEqual([notice("You are now friends with Sidekick"), { type: "UPDATE_FRIENDS", data: { friends: ["sidekick"] } }]);

    sent = [];
    await answer(sidekick, accept);
    expect(sent).toEqual([["Sidekick", notice("Invitation not found or has already been processed")]]);
  });

  test("without a cluster, an answer to an inviter who left says they are gone, as before", async () => {
    const sidekick = connect("8", "Sidekick");
    await answer(sidekick, accept);
    expect(sent).toEqual([["Sidekick", notice("Unable to process invitation - user not found or has disconnected")]]);
  });

  test("an answer that does not match, or a locked accept, leaves the invitation open", async () => {
    connect("7", "Hero");
    const sidekick = connect("8", "Sidekick");
    await friendRequest();
    await answer(sidekick, { ...accept, action: "INVITE_PARTY" });
    expect(sent).toEqual([["Sidekick", notice("Invitation not found or has already been processed")]]);

    sent = [];
    locked = true;
    await answer(sidekick, accept);
    expect(sent).toEqual([]);

    locked = false;
    await answer(sidekick, accept);
    expect(sentTo("Hero")[0]).toEqual(notice("You are now friends with Sidekick"));
  });

  test("in a cluster, the inviter on another node is told by name", async () => {
    cluster = true;
    held = new Invitations(new MemoryStore());
    const sidekick = connect("8", "Sidekick");
    await friendRequest();
    await answer(sidekick, accept);
    expect(sentTo("hero@b")).toEqual([notice("You are now friends with Sidekick"), { type: "UPDATE_FRIENDS", data: { friends: ["sidekick"] } }]);
    expect(sentTo("Sidekick")[0]).toEqual(notice("You are now friends with Hero"));
  });

  test("in a cluster, an invitation whose inviter is offline everywhere says they are gone", async () => {
    cluster = true;
    held = new Invitations(new MemoryStore());
    const sidekick = connect("8", "Sidekick");
    await held.add({ action: "FRIEND_REQUEST", originator: "7", originatorName: "Ghost", authorization: "auth-1" });
    await answer(sidekick, accept);
    expect(sent).toEqual([["Sidekick", notice("Unable to process invitation - user not found or has disconnected")]]);
  });
});
