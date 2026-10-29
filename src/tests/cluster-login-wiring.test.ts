import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { receiverSource } from "./receiver-source";

// The login routing as wired into socket/receiver.ts and socket/server.ts. Neither
// can be imported (the first imports the second, which starts the server), so the
// code is read from its source: the order of the login steps is checked there, and
// switchLoginIfElsewhere is run from its source with the names it uses handed in
// as fakes (as in disconnect-events.test.ts).

type Row = Record<string, any>;
const read = (file: string) => readFileSync(join(import.meta.dir, "..", "socket", file), "utf8");
const receiver = receiverSource();
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

describe("the login handler", () => {
  const login = cut(receiver, "async function completeLogin(", /\r?\n}\r?\n/);
  const at = (text: string) => {
    const index = login.indexOf(text);
    if (index < 0) throw new Error(`Not in the login handler: ${text}`);
    return index;
  };
  const route = at("switchLoginIfElsewhere(wt, sessionId,");

  test("routes once the spawn point is final", () => {
    expect(route).toBeGreaterThan(at("playerData.corpse.x"));
    expect(route).toBeGreaterThan(at("spawnLocation.x = default_map_spawnpoint.x"));
    expect(route).toBeGreaterThan(at("spawnLocation.map = map.name"));
  });

  test("routes before anything of the login is done or kept here", () => {
    for (const step of [
      "player.toggleNoclip(",
      "player.toggleStealth(",
      "listener.emit(Events.PLAYER_AUTH_COMPLETE",
      "ignores.list(",
      "worlds.adjustPlayerCount(spawnLocation.map, 1)",
      "packetManager.weather(",
      "playerCache.add(wt.data.id",
      "wt.markLoggedIn",
    ]) expect(route).toBeLessThan(at(step));
  });

  test("leaves the duplicate-login kick where it was, before the routing", () => {
    expect(at("(duplicate login)")).toBeLessThan(route);
  });
});

describe("validateConnectionToken", () => {
  test("asks for a node id in cluster mode, and for this node", () => {
    const body = cut(server, "function validateConnectionToken(", /\r?\n}\r?\n/);
    expect(body).toContain("const cluster = clusterEnabled();");
    expect(body).toContain('checkTicket(fields, sharedSecret, ALLOWED_ORIGINS, Date.now(), cluster ? nodeId() : "", cluster)');
  });
});

describe("switchLoginIfElsewhere", () => {
  const make = withNames(
    ["clusterEnabled", "clusterBlocks", "routeLogin", "liveNodes", "nodeId", "log", "player", "nodeTicket", "packetManager"],
    `${cut(receiver, "async function switchLoginIfElsewhere(", /\r?\n}\r?\n/)}\n}\nreturn switchLoginIfElsewhere;`
  );

  const target = { nodeId: "b", publicHost: "b.example", port: 443, wtPort: 3002, useSSL: true };
  let order: string[];
  let cluster: boolean;
  let route: any;
  let warned: string[];
  let env: string | undefined;

  beforeEach(() => {
    order = [];
    cluster = true;
    route = { switchTo: target };
    warned = [];
    env = process.env.GATEWAY_GAME_SERVER_SECRET;
  });

  function run(data: Row = { ticketAccount: "acc", ticketOrigin: "https://o" }) {
    process.env.GATEWAY_GAME_SERVER_SECRET = "secret";
    const switchLogin = make({
      clusterEnabled: () => cluster,
      clusterBlocks: () => ({ ownerOf: () => null }),
      routeLogin: () => { order.push("route"); return route; },
      liveNodes: { get: async () => { order.push("live"); return [target]; } },
      nodeId: () => "a",
      log: { error: () => {}, warn: (m: string) => warned.push(m), debug: () => {} },
      player: { clearSessionId: async (id: string) => { order.push(`clear ${id}`); } },
      nodeTicket: (secret: string, origin: string, account: string, node: string) => { order.push(`ticket ${secret} ${origin} ${account} ${node}`); return { token: "t" }; },
      packetManager: { switchNode: (node: any, ticket: any) => [`SWITCH ${node.nodeId} ${ticket.token}`] },
    });
    const wt = {
      data,
      sendThenClose: async (packets: string[], code: number, reason: string) => { order.push(`${packets.join()} then close ${code} ${reason}`); },
    };
    return switchLogin(wt, "7", "alice", { map: "world.json", x: 5000, y: 10 }).finally(() => {
      if (env === undefined) delete process.env.GATEWAY_GAME_SERVER_SECRET;
      else process.env.GATEWAY_GAME_SERVER_SECRET = env;
    });
  }

  test("does nothing outside cluster mode", async () => {
    cluster = false;
    expect(await run()).toBe(false);
    expect(order).toEqual([]);
  });

  test("logs in here when the spawn block is this node's, no one's or a dead node's", async () => {
    route = "here";
    expect(await run()).toBe(false);
    expect(order).toEqual(["live", "route"]);
  });

  test("lets go of the session, then sends SWITCH with a ticket for the owner, then closes", async () => {
    expect(await run()).toBe(true);
    expect(order).toEqual([
      "live",
      "route",
      "clear 7",
      "ticket secret https://o acc b",
      "SWITCH b t then close 1000 switch",
    ]);
  });

  test("does not hand on a login another node has handed over", async () => {
    expect(await run({ ticketAccount: "acc", ticketOrigin: "https://o", switched: true })).toBe(false);
    expect(order).toEqual(["live", "route"]);
    expect(warned).toHaveLength(1);
  });
});
