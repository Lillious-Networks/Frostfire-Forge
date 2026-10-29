import { describe, expect, test } from "bun:test";
import { BLOCK_SIZE_PX, BlockTable } from "../cluster/blocks";
import { MemoryStore } from "../cluster/memorystore";
import type { NodeInfo } from "../cluster/nodes";
import { LiveNodeCache, routeLogin } from "../cluster/route";
import { packetManager } from "../socket/packet_manager";
import { accountBinding, checkTicket, isSwitchTicket, NODE_TICKET_TTL_MS, nodeTicket, signTicket } from "../socket/ticket";
import { TransportConnection } from "../socket/transport";

// Cluster mode: a login lands on the node that owns the player's spawn block;
// the node that got it hands it over with SWITCH (receiver.ts, at login).

const node = (nodeId: string, over: Partial<NodeInfo> = {}): NodeInfo => ({
  nodeId, regionId: "us", publicHost: `${nodeId}.example`, port: 443, wtPort: 3002, useSSL: true, startedAt: 1, ...over,
});

/** World "world": block 0,0 is node a's, 1,0 node b's, 2,0 node c's (dead); 3,0 has no owner. */
async function table(): Promise<BlockTable> {
  const blocks = new BlockTable(new MemoryStore());
  const owner = (nodeId: string) => ({ nodeId, epoch: 1, since: 1 });
  await blocks.write("world", { epoch: 1, owners: { "0,0": owner("a"), "1,0": owner("b"), "2,0": owner("c") } });
  return blocks;
}

const at = (bx: number) => ({ map: "world.json", x: bx * BLOCK_SIZE_PX + 10, y: 10 });

describe("routeLogin", () => {
  test("a spawn in a block this node owns logs in here", async () => {
    expect(routeLogin(at(0), await table(), [node("a"), node("b")], "a")).toBe("here");
  });

  test("a spawn in a block a live node owns goes to that node", async () => {
    expect(routeLogin(at(1), await table(), [node("a"), node("b")], "a")).toEqual({ switchTo: node("b") });
  });

  test("a spawn in a dead node's block logs in here (phase 7 takes those over)", async () => {
    expect(routeLogin(at(2), await table(), [node("a"), node("b")], "a")).toBe("here");
  });

  test("a block no one owns, a map with no table, or no table at all logs in here", async () => {
    expect(routeLogin(at(3), await table(), [node("a"), node("b")], "a")).toBe("here");
    expect(routeLogin({ map: "cave.json", x: 0, y: 0 }, await table(), [node("a"), node("b")], "a")).toBe("here");
    expect(routeLogin(at(1), null, [node("a"), node("b")], "a")).toBe("here");
  });

  test("a live owner with no address to reach it by logs in here", async () => {
    expect(routeLogin(at(1), await table(), [node("a"), node("b", { publicHost: "", wtPort: 0 })], "a")).toBe("here");
  });
});

describe("LiveNodeCache", () => {
  test("reads the live nodes at most once a second", async () => {
    let now = 1000;
    let reads = 0;
    const cache = new LiveNodeCache(async () => { reads++; return [node(`n${reads}`)]; }, 1000, () => now);
    expect((await cache.get()).map((n) => n.nodeId)).toEqual(["n1"]);
    now += 999;
    expect((await cache.get()).map((n) => n.nodeId)).toEqual(["n1"]);
    now += 1;
    expect((await cache.get()).map((n) => n.nodeId)).toEqual(["n2"]);
    expect(reads).toBe(2);
  });

  test("logins at the same moment share one read", async () => {
    let reads = 0;
    const cache = new LiveNodeCache(async () => { reads++; await Promise.resolve(); return [node("a")]; }, 1000, () => 0);
    await Promise.all([cache.get(), cache.get(), cache.get()]);
    expect(reads).toBe(1);
  });

  test("a failed read is not kept: the next login reads again", async () => {
    let fail = true;
    const cache = new LiveNodeCache(async () => { if (fail) throw new Error("redis away"); return [node("a")]; }, 1000, () => 0);
    await expect(cache.get()).rejects.toThrow("redis away");
    fail = false;
    expect(await cache.get()).toEqual([node("a")]);
  });
});

describe("the SWITCH ticket", () => {
  const SECRET = "test-secret";
  const NOW = 1_800_000_000_000;
  const origin = "https://play.example";
  const account = accountBinding("account-token");

  test("is for the same account and origin, bound to the target, for 30 s", () => {
    const ticket = nodeTicket(SECRET, origin, account, "b", NOW);
    expect(NODE_TICKET_TTL_MS).toBe(30_000);
    expect(ticket).toMatchObject({ origin, account, nodeId: "b", timestamp: NOW, expiresAt: NOW + 30_000 });
    expect(checkTicket(ticket, SECRET, [origin], NOW, "b", true)).toEqual({ ok: true, account, origin });
  });

  test("is refused by any other node", () => {
    expect(checkTicket(nodeTicket(SECRET, origin, account, "b", NOW), SECRET, [], NOW, "c", true)).toMatchObject({ ok: false, reason: "for another node" });
  });

  test("expires after 30 s", () => {
    expect(checkTicket(nodeTicket(SECRET, origin, account, "b", NOW), SECRET, [], NOW + 30_001, "b", true)).toMatchObject({ ok: false, reason: "expired" });
  });

  test("says it is a switch, which a client cannot add to a Gateway ticket", () => {
    const switched = nodeTicket(SECRET, origin, account, "b", NOW);
    expect(isSwitchTicket(switched.token)).toBe(true);
    const token = "ab".repeat(32);
    const gateway = { token, timestamp: String(NOW), expiresAt: String(NOW + 60_000), origin, account, nodeId: "b", signature: signTicket(SECRET, token, String(NOW), String(NOW + 60_000), origin, account, "b") };
    expect(isSwitchTicket(gateway.token)).toBe(false);
    expect(isSwitchTicket(undefined)).toBe(false);
    expect(checkTicket({ ...gateway, token: `switch-${token}` }, SECRET, [], NOW, "b", true)).toMatchObject({ ok: false, reason: "invalid signature" });
  });

  test("each one is new: two switches never share a ticket", () => {
    expect(nodeTicket(SECRET, origin, account, "b", NOW).token).not.toBe(nodeTicket(SECRET, origin, account, "b", NOW).token);
  });
});

describe("the SWITCH packet", () => {
  test("names the node, where to reach it, and the ticket for it", () => {
    const ticket = nodeTicket("s", "https://o", "acc", "b", 5);
    const [frame] = packetManager.switchNode(node("b"), ticket);
    expect(JSON.parse(new TextDecoder().decode(frame))).toEqual({
      type: "SWITCH",
      data: { nodeId: "b", publicHost: "b.example", port: 443, wtPort: 3002, useSSL: true, ticket },
    });
  });
});

describe("sendThenClose", () => {
  const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

  /** A connection on a fake session whose stream write, and the peer's close, happen when told to. */
  function fakeConnection(withClosed = true) {
    const events: string[] = [];
    let finishWrite = () => {};
    let peerCloses = () => {};
    const session: any = {
      queuedBytes: 0n,
      close: (info: any) => { events.push(`close ${info.closeCode}`); },
    };
    if (withClosed) session.closed = new Promise<void>((resolve) => { peerCloses = () => { events.push("peer closed"); resolve(); }; });
    const writable = {
      getWriter: () => ({
        write: () => {
          events.push("write");
          return new Promise<void>((resolve) => { finishWrite = () => { events.push("written"); resolve(); }; });
        },
      }),
    };
    const connection = new TransportConnection(session, 1200, 1024 * 1024);
    connection.attachStream(writable);
    return { connection, events, finish: () => finishWrite(), peerCloses: () => peerCloses() };
  }

  test("closes once the frame is written and the peer has closed (it read the SWITCH)", async () => {
    const { connection, events, finish, peerCloses } = fakeConnection();
    const done = connection.sendThenClose(packetManager.loginFailed(), 1000, "switch");
    await tick();
    expect(events).toEqual(["write"]);
    finish();
    await tick(150);
    // Written is not read: the session stays open for the peer, past any fixed grace.
    expect(events).toEqual(["write", "written"]);
    expect(connection.isOpen()).toBe(true);
    peerCloses();
    await done;
    expect(events).toEqual(["write", "written", "peer closed", "close 0"]);
    expect(connection.isOpen()).toBe(false);
  });

  test("a peer that does not close is closed at the cap", async () => {
    const { connection, events, finish } = fakeConnection();
    const done = connection.sendThenClose(packetManager.loginFailed(), 1000, "switch", { peerMs: 50 });
    finish();
    await tick();
    expect(events).toEqual(["write", "written"]);
    await done;
    expect(events).toEqual(["write", "written", "close 0"]);
  });

  test("a write that never finishes does not hold the close", async () => {
    const { connection, events } = fakeConnection();
    await connection.sendThenClose(packetManager.loginFailed(), 1000, "switch", { writeMs: 50, peerMs: 10_000 });
    expect(events).toEqual(["write", "close 0"]);
  });

  test("a session that cannot say when the peer closed gets a short grace", async () => {
    const { connection, events, finish } = fakeConnection(false);
    const started = Date.now();
    const done = connection.sendThenClose(packetManager.loginFailed(), 1000, "switch");
    finish();
    await done;
    expect(events).toEqual(["write", "written", "close 0"]);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
