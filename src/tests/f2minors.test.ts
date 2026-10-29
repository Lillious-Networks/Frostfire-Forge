import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TransportConnection } from "../socket/transport";
import { FrameDecoder } from "../socket/framing";
import { SLOW_CROSSING_MS, crossingLogLevel } from "../cluster/handoff";
import { receiverSource } from "./receiver-source";

// Final review 2, Minors M2, M3, M4 and M7.
//   M2: the per-crossing summary lines are debug unless the crossing was slow.
//   M3: a notice sent just before a close is written before the session closes (close with drain).
//   M4: a stream write that fails for another reason than a closed session closes the connection once, with 1011.
//   M7: the node-debug comments no longer say "admin", and DebugAsker has no isAdmin.

const enc = new TextEncoder();
const dec = new TextDecoder();
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
const read = (...parts: string[]) => readFileSync(join(import.meta.dir, "..", ...parts), "utf8");
const GATEWAY = join(import.meta.dir, "..", "..", "..", "Frostfire-Forge-Gateway", "src", "webserver", "public", "js", "core");

// ---------------------------------------------------------------------- M2

describe("M2: the summary of a crossing is said at debug unless it was slow", () => {
  test("the level at 99, 100 and 101 ms", () => {
    expect(SLOW_CROSSING_MS).toBe(100);
    expect(crossingLogLevel(99)).toBe("debug");
    expect(crossingLogLevel(100)).toBe("debug");
    expect(crossingLogLevel(101)).toBe("info");
    expect(crossingLogLevel(0)).toBe("debug");
    expect(crossingLogLevel(5000)).toBe("info");
  });

  test("the sender's and the receiver's summaries both go through it, and none is said at info outright", () => {
    const handoff = read("cluster", "handoff.ts");
    expect(handoff).not.toContain("log.info(summary(");
    expect(handoff.split("sayCrossing(").length - 1).toBe(3); // the definition and the two call sites
    expect(handoff).toContain("log[crossingLogLevel(last - first)](summary(username, from, to, marks));");
    expect(handoff).toContain("sayCrossing(username, deps.self, target, marks);");
    expect(handoff).toContain("sayCrossing(arrival.snapshot.username, arrival.from, this.deps!.self, arrival.marks);");
  });

  test("the client's line is console.debug", () => {
    const client = readFileSync(join(GATEWAY, "socket.ts"), "utf8");
    const at = client.indexOf("`[handoff] client switch_rx->");
    expect(at).toBeGreaterThan(0);
    expect(client.slice(client.lastIndexOf("console.", at), at)).toStartWith("console.debug(");
  });
});

// ------------------------------------------------------- a transport to watch

/** A connection whose stream writes are held until the test settles them; `events` is what reached the stream and the session, in order. */
function rig() {
  const events: string[] = [];
  const pending: Array<{ resolve: () => void; reject: (error: any) => void }> = [];
  const closes: any[] = [];
  const session: any = {
    queuedBytes: 0n,
    close: (arg: any) => {
      closes.push(arg);
      events.push(`close:${arg.reason}`);
    },
  };
  const connection = new TransportConnection(session, 1200, 1024 * 1024);
  connection.attachStream({
    getWriter: () => ({
      write: (chunk: Uint8Array) => {
        const decoder = new FrameDecoder(1024 * 1024);
        events.push(`write:${decoder.push(chunk).map((f) => dec.decode(f)).join(",")}`);
        return new Promise<void>((resolve, reject) => pending.push({ resolve, reject }));
      },
    }),
  });
  return { connection, events, pending, closes, session };
}

const noticeText = (message: string) => JSON.stringify({ type: "NOTIFY", data: { message } });
const notify = (data: { message: string }) => [enc.encode(JSON.stringify({ type: "NOTIFY", data }))];
const sendPacket = (wt: any, packets: any[]) => { packets.forEach((packet) => wt.send(packet)); };
const NOTICE = noticeText("You have been logged in from another location.");

// ---------------------------------------------------------------------- M3

type Row = Record<string, any>;
const transpiler = new Bun.Transpiler({ loader: "ts" });
/** Code that names `names`, made into a function of them. */
function withNames(names: string[], code: string): (given: Row) => any {
  return new Function(`"use strict";\n${transpiler.transformSync(`function make({ ${names.join(", ")} }: any) { ${code} }`)}\nreturn make;`)();
}
/** `source` from where `from` starts up to the first match of `until` after it. */
function cut(source: string, from: string, until: RegExp): string {
  const start = source.indexOf(from);
  if (start < 0) throw new Error(`Not found in the source: ${from}`);
  const rest = source.slice(start);
  const end = rest.search(until);
  if (end < 0) throw new Error(`No end found for: ${from}`);
  return rest.slice(0, end);
}

const receiver = receiverSource();
const server = read("socket", "server.ts");

const displacedSource = cut(receiver, 'registerPlayerAction("displaced-login", (p) => {', /\r?\n\}\);/) + "\n});";
const stolenInactiveSource = cut(server, 'if (reason === "session_stolen" && stillInCache.wt?.readyState === 1) {', /\r?\n\s*continue;/);
const stolenDisconnectSource = cut(server, 'if (data.reason === "session_stolen" && playerData.wt?.readyState === 1) {', /\r?\n\s*if \(!playerData\.isGuest\)/);

/** The three sites that tell a player they were logged in elsewhere and then close the connection, each run from its source. */
const sites: Array<{ name: string; source: string; run: (wt: any) => void }> = [
  {
    name: "a login on another node (receiver, displaced-login)",
    source: displacedSource,
    run: (wt) => {
      let handler: ((p: any) => void) | null = null;
      withNames(["registerPlayerAction", "sendPacket", "packetManager"], displacedSource)({
        registerPlayerAction: (_name: string, fn: (p: any) => void) => { handler = fn; },
        sendPacket,
        packetManager: { notify },
      });
      handler!({ wt });
    },
  },
  {
    name: "session stolen in the inactive sweep (server)",
    source: stolenInactiveSource,
    run: (wt) => {
      withNames(["reason", "stillInCache", "id", "packetQueue", "ClientRateLimit", "sendPacket", "packetManager"], `do { ${stolenInactiveSource}\ncontinue; } } while (false);`)({
        reason: "session_stolen",
        stillInCache: { wt },
        id: "5",
        packetQueue: new Map(),
        ClientRateLimit: new Map(),
        sendPacket,
        packetManager: { notify },
      });
    },
  },
  {
    name: "session stolen in the disconnect handler (server)",
    source: stolenDisconnectSource,
    run: (wt) => {
      withNames(["data", "playerData", "sendPacket", "packetManager"], stolenDisconnectSource)({
        data: { id: "5", reason: "session_stolen" },
        playerData: { wt },
        sendPacket,
        packetManager: { notify },
      });
    },
  },
];

describe("M3: the notice is written before the close", () => {
  // The sites above are run from their source. Two others cannot be: the one in the login handler (receiver.ts, the
  // earlier session of the same account on this node) and the stale-owner one in the save (server.ts). So every
  // close with this reason is also checked as source text: all of them pass drain.
  test("every close that says 'Logged in from another location' drains, receiver and server alike", () => {
    const files: Array<[string, string]> = [["receiver", receiver], ["server", server]];
    let total = 0;
    for (const [name, text] of files) {
      const closes = [...text.replace(/\r\n/g, "\n").matchAll(/\bclose\??\.?\??\(\s*1000,\s*"Logged in from another location"[^)]*\)/g)].map((m) => m[0]);
      total += closes.length;
      for (const close of closes) expect(`${name}: ${close}`).toContain("{ drain: true })");
    }
    // receiver: the displaced login and the login handler; server: the two session-stolen sites and the stale-owner save.
    expect(total).toBe(5);
  });

  for (const site of sites) {
    test(`${site.name}: keeps the close code and reason, and closes with drain`, () => {
      expect(site.source).toContain('.close(1000, "Logged in from another location", { drain: true });');
      expect(site.source.indexOf("notify(")).toBeLessThan(site.source.indexOf(".close("));
    });

    test(`${site.name}: behind a write in flight, the notice is written, then the session closes`, async () => {
      const { connection, events, pending, closes } = rig();
      connection.send(enc.encode('{"n":1}'));
      await tick();
      expect(events).toEqual(['write:{"n":1}']);

      site.run(connection);
      // The first write is still in flight: the notice waits in the outbox, and the session is not closed over it.
      await tick();
      expect(events).toEqual(['write:{"n":1}']);
      expect(closes).toHaveLength(0);

      pending[0].resolve();
      await tick();
      expect(events).toEqual(['write:{"n":1}', `write:${NOTICE}`]);
      expect(closes).toHaveLength(0);

      pending[1].resolve();
      await tick();
      expect(events).toEqual(['write:{"n":1}', `write:${NOTICE}`, "close:1000|Logged in from another location"]);
      expect(closes).toEqual([{ closeCode: 0, reason: "1000|Logged in from another location" }]);
    });

    test(`${site.name}: with nothing in flight, the notice is itself the write in flight: the session closes once it has settled`, async () => {
      const { connection, events, pending, closes } = rig();
      site.run(connection);
      await tick();
      // The notice went to the stream at once; the close waits for that write.
      expect(events).toEqual([`write:${NOTICE}`]);
      expect(closes).toHaveLength(0);
      pending[0].resolve();
      await tick();
      expect(events).toEqual([`write:${NOTICE}`, "close:1000|Logged in from another location"]);
      expect(closes).toEqual([{ closeCode: 0, reason: "1000|Logged in from another location" }]);
    });

    test(`${site.name}: the notice write never settles: the session still closes at the 1 s bound, once`, async () => {
      const { connection, events, closes } = rig();
      site.run(connection);
      await tick(50);
      expect(events).toEqual([`write:${NOTICE}`]);
      expect(closes).toHaveLength(0);
      await tick(1200);
      expect(closes).toEqual([{ closeCode: 0, reason: "1000|Logged in from another location" }]);
      expect(events).toEqual([`write:${NOTICE}`, "close:1000|Logged in from another location"]);
    });

    test(`${site.name}: the notice write fails during the drain: the connection closes once, with no unhandled rejection`, async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
      process.on("unhandledRejection", onUnhandled);
      try {
        const { connection, events, pending, closes } = rig();
        site.run(connection);
        await tick();
        pending[0].reject(new Error("stream reset"));
        await tick(50);
        expect(closes).toEqual([{ closeCode: 0, reason: "1000|Logged in from another location" }]);
        expect(events).toEqual([`write:${NOTICE}`, "close:1000|Logged in from another location"]);
        expect(unhandled).toEqual([]);
        // Later, nothing closes the session a second time.
        await tick(20);
        expect(closes).toHaveLength(1);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });

    test(`${site.name}: the close still happens when the write in flight never settles`, async () => {
      const { connection, events, closes } = rig();
      connection.send(enc.encode('{"n":1}'));
      await tick();
      site.run(connection); // the first write never settles: the notice stays in the outbox
      await tick(50);
      expect(closes).toHaveLength(0);
      await tick(1200); // SEND_THEN_CLOSE_WRITE_MS (1000) bounds the wait
      expect(closes).toEqual([{ closeCode: 0, reason: "1000|Logged in from another location" }]);
      expect(events.filter((e) => e.startsWith("close:"))).toHaveLength(1);
      expect(events).not.toContain(`write:${NOTICE}`); // the stuck stream never took it; the close is not held for it
    });

    test(`${site.name}: when the write in flight fails, the close happens once`, async () => {
      const { connection, pending, closes } = rig();
      connection.send(enc.encode('{"n":1}'));
      await tick();
      site.run(connection);
      pending[0].reject(new Error("stream reset"));
      await tick();
      expect(closes).toEqual([{ closeCode: 0, reason: "1000|Logged in from another location" }]);
    });
  }

  test("without drain the notice behind a write in flight is dropped (what the change fixes)", async () => {
    const { connection, events, pending, closes } = rig();
    connection.send(enc.encode('{"n":1}'));
    await tick();
    connection.send(enc.encode("notice"));
    connection.close(1000, "x");
    pending[0].resolve();
    await tick();
    expect(events).toEqual(['write:{"n":1}', "close:1000|x"]);
    expect(closes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------- M4

describe("M4: a failed stream write closes the connection once, with 1011", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  beforeEach(() => {
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
  });
  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
  });

  test("a write error that is not a closed session closes with 1011 and the reason, once", async () => {
    const { connection, events, pending, closes } = rig();
    connection.send(enc.encode("a"));
    await tick();
    pending[0].reject(new Error("stream reset"));
    await tick();
    expect(closes).toEqual([{ closeCode: 1, reason: "1011|stream write failed" }]);
    expect(connection.readyState).toBe(3);
    expect(events).toEqual(["write:a", "close:1011|stream write failed"]);
    expect(unhandled).toEqual([]);
  });

  test("later frames are not written, and nothing closes again", async () => {
    const { connection, events, pending, closes } = rig();
    connection.send(enc.encode("a"));
    await tick();
    pending[0].reject(new Error("stream reset"));
    await tick();
    expect(connection.send(enc.encode("b"))).toBe(false);
    connection.sendBestEffort(enc.encode("c"));
    connection.close(1000, "later");
    await tick();
    expect(events).toEqual(["write:a", "close:1011|stream write failed"]);
    expect(closes).toHaveLength(1);
    expect(unhandled).toEqual([]);
  });

  test("frames queued behind the failed write are dropped and their senders settle", async () => {
    const { connection, events, pending, closes } = rig();
    connection.send(enc.encode("a"));
    await tick();
    connection.send(enc.encode("b"));
    connection.send(enc.encode("c"));
    await tick();
    pending[0].reject(new Error("stream reset"));
    await tick();
    expect(events.filter((e) => e.startsWith("write:"))).toEqual(["write:a"]);
    expect(closes.filter((c) => c.reason === "1011|stream write failed")).toHaveLength(1);
    expect(connection.bufferedAmount).toBe(0);
    expect(unhandled).toEqual([]);
  });

  test("a closed-session error does not close again", async () => {
    for (const error of [
      Object.assign(new Error("closed"), { code: "E_SESSION_CLOSED" }),
      new Error("the session is closed"),
      Object.assign(new Error("x"), { code: "GenericFailure" }),
    ]) {
      const { connection, pending, closes } = rig();
      connection.send(enc.encode("a"));
      await tick();
      pending[0].reject(error);
      await tick();
      expect(closes).toHaveLength(0);
      expect(connection.send(enc.encode("b"))).toBe(false);
    }
    expect(unhandled).toEqual([]);
  });

  test("a connection that was closed already is not closed a second time by the failing write", async () => {
    const { connection, pending, closes } = rig();
    connection.send(enc.encode("a"));
    await tick();
    connection.send(enc.encode("notice"));
    connection.close(1000, "Logged in from another location", { drain: true });
    pending[0].reject(new Error("stream reset"));
    await tick();
    expect(closes).toEqual([{ closeCode: 0, reason: "1000|Logged in from another location" }]);
    expect(unhandled).toEqual([]);
  });

  test("a write that throws at once takes the same path", async () => {
    const closes: any[] = [];
    const session: any = { queuedBytes: 0n, close: (arg: any) => { closes.push(arg); } };
    const connection = new TransportConnection(session, 1200, 1024);
    connection.attachStream({ getWriter: () => ({ write: () => { throw new Error("writer broke"); } }) });
    connection.send(enc.encode("a"));
    await tick();
    expect(closes).toEqual([{ closeCode: 1, reason: "1011|stream write failed" }]);
    expect(unhandled).toEqual([]);
  });

  test("a session whose close throws does not throw out of the write path", async () => {
    const session: any = { queuedBytes: 0n, close: () => { throw new Error("close broke"); } };
    const connection = new TransportConnection(session, 1200, 1024);
    connection.attachStream({ getWriter: () => ({ write: () => Promise.reject(new Error("stream reset")) }) });
    connection.send(enc.encode("a"));
    await tick();
    expect(connection.readyState).toBe(3);
    expect(unhandled).toEqual([]);
  });
});

// ---------------------------------------------------------------------- M7

describe("M7: the node-debug comments say any logged-in player gets the table", () => {
  const nodedebug = read("cluster", "nodedebug.ts").replaceAll("\r\n", "\n");
  const editors = read("socket", "handlers", "editors.ts");

  test("DebugAsker has no isAdmin", () => {
    expect(nodedebug).not.toContain("isAdmin");
    expect(nodedebug).toMatch(/export interface DebugAsker \{\n  location\?:/);
  });

  test("no comment calls the request or the overlay an admin's", () => {
    expect(nodedebug).not.toContain("an admin's CLUSTER_DEBUG");
    expect(nodedebug).not.toContain("Not an admin");
    expect(nodedebug).toContain("any logged-in player gets the table");
    expect(editors).not.toContain("The admin's \"Cluster Nodes\"");
    expect(editors).toContain("open to any logged-in player");
  });
});
