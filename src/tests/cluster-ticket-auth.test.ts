import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { databaseModule } from "./setup";

// Carried item (a) of the phase 6 final review, at run time: the AUTH case in socket/handlers/session.ts logs in a
// connection whose node ticket this connection spent ("spent"), or that has no spend (unset or null, a Gateway
// ticket). It refuses one spent before by another connection ("reused", "Ticket already used") and one whose spend
// could not be checked ("unknown", "Ticket could not be checked"). End to end with a MemoryStore and the server's
// own spendsTicket/spendTicket, a ticket used twice logs in once, and a store that fails refuses it (security
// review L1, m4).
//
// session.ts imports the receiver, which cannot be imported by a test (it imports the server, which starts it): a
// stand-in gives the few names session.ts takes from it. The real receiver cannot be imported to put back
// afterwards, so a stand-in here would stay for every file run after this one. The tests therefore run in a
// process of their own: this file, run by `bun test`, starts `bun test` on itself with CELLS_TICKET_AUTH_INNER set,
// and only that inner run installs the stand-ins and runs the cases.

const INNER = process.env.CELLS_TICKET_AUTH_INNER === "1";

if (!INNER) {
  test("the AUTH ticket cases pass in a process of their own (the receiver stand-in cannot be undone)", () => {
    const run = Bun.spawnSync([process.execPath, "test", import.meta.path], {
      env: { ...process.env, CELLS_TICKET_AUTH_INNER: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = `${run.stdout.toString()}\n${run.stderr.toString()}`;
    const passed = Number(/(\d+) pass/.exec(output)?.[1] ?? 0);
    const failed = Number(/(\d+) fail/.exec(output)?.[1] ?? -1);
    if (run.exitCode !== 0 || failed !== 0) console.error(output);
    expect(run.exitCode).toBe(0);
    expect(failed).toBe(0);
    // Every case below ran: a filter or a load error would pass nothing.
    expect(passed).toBe(4);
  }, 60_000);
} else {
  const posted: Array<{ token: string; id: string }> = [];
  const sent: unknown[] = [];
  const receiverStandIn = {
    authWorker: { postMessage: (message: { token: string; id: string }) => { posted.push(message); } },
    authentication_queue: new Set<string>(),
    authentication_session_queue: new Set<string>(),
    pendingAuthentications: new Map<string, unknown>(),
    releaseDraggedBy: () => {},
    sendPacket: (_wt: unknown, packet: unknown) => { sent.push(packet); },
  };
  // The stand-ins are put in before session.ts is imported, so the module graph never reaches the real ones. The
  // database is stubbed the way the other tests stub it (the real module starts its worker pool when imported).
  mock.module("../socket/receiver", () => receiverStandIn);
  mock.module("../controllers/sqldatabase", () => databaseModule({ default: async () => [] }));

  const log = (await import("../modules/logger")).default;
  const { handle } = await import("../socket/handlers/session");
  const { packetManager } = await import("../socket/packet_manager");
  const { accountBinding } = await import("../socket/ticket");
  const { spendsTicket } = await import("../cluster/handoffguards");
  const { spendTicket } = await import("../cluster/ticketspend");
  const { MemoryStore } = await import("../cluster/memorystore");
  type TicketSpend = import("../cluster/ticketspend").TicketSpend;

  afterAll(() => {
    receiverStandIn.authentication_queue.clear();
    receiverStandIn.authentication_session_queue.clear();
    receiverStandIn.pendingAuthentications.clear();
  });

  const ACCOUNT_TOKEN = "account-token-for-the-auth-test";
  let connections = 0;

  beforeEach(() => {
    posted.length = 0;
    sent.length = 0;
    receiverStandIn.authentication_queue.clear();
    receiverStandIn.authentication_session_queue.clear();
    receiverStandIn.pendingAuthentications.clear();
  });

  /** A connection as transport.ts leaves it: its ticket bound to the account, and `ticketSpent` as server.ts sets it. */
  const connection = (ticketSpent: Promise<TicketSpend> | null | undefined) => {
    const closes: Array<[number, string]> = [];
    const wt = {
      data: { id: `conn-${++connections}`, ticketAccount: accountBinding(ACCOUNT_TOKEN), ticketSpent } as Record<string, unknown>,
      close: (code: number, reason: string) => { closes.push([code, reason]); },
    };
    if (ticketSpent === undefined) delete wt.data.ticketSpent;
    return { wt, closes };
  };

  const auth = async (wt: unknown) => {
    await handle({ wt, type: "AUTH", data: ACCOUNT_TOKEN, parsedMessage: { type: "AUTH", data: ACCOUNT_TOKEN } } as any);
  };

  test("a ticket spent before, or one that could not be checked: loginFailed, closed 1008 with its reason, nothing reaches the auth worker", async () => {
    const loginFailed = spyOn(packetManager, "loginFailed");
    try {
      for (const [spend, reason] of [["reused", "Ticket already used"], ["unknown", "Ticket could not be checked"]] as const) {
        loginFailed.mockClear();
        sent.length = 0;
        const { wt, closes } = connection(Promise.resolve(spend));
        await auth(wt);
        expect(loginFailed).toHaveBeenCalledTimes(1);
        expect(sent).toEqual([loginFailed.mock.results[0]!.value]);
        expect(closes).toEqual([[1008, reason]]);
        expect(posted).toEqual([]);
        expect(receiverStandIn.authentication_queue.size).toBe(0);
      }
    } finally {
      loginFailed.mockRestore();
    }
  });

  test("a ticket spent by this connection, or no spend at all (a Gateway ticket), goes to the auth worker once", async () => {
    for (const ticketSpent of [Promise.resolve("spent" as const), null, undefined]) {
      posted.length = 0;
      const { wt, closes } = connection(ticketSpent);
      await auth(wt);
      expect(closes).toEqual([]);
      expect(posted).toEqual([{ token: ACCOUNT_TOKEN, id: String(wt.data.id) }]);
      // The next one must not trip over this one's queue entry.
      receiverStandIn.authentication_queue.clear();
    }
  });

  test("end to end: a SWITCH ticket used by two connections logs in once; a Gateway ticket is never spent", async () => {
    const store = new MemoryStore();
    const ticket = "switch-0123456789abcdef";
    const expiresAt = Date.now() + 30_000;
    // What server.ts does when a connection opens.
    const spendFor = (token: string) => (spendsTicket(store, token) ? spendTicket(store, token, expiresAt) : null);

    const first = connection(spendFor(ticket));
    const second = connection(spendFor(ticket));
    await auth(first.wt);
    receiverStandIn.authentication_queue.clear();
    await auth(second.wt);
    expect(posted.map((p) => p.id)).toEqual([String(first.wt.data.id)]);
    expect(first.closes).toEqual([]);
    expect(second.closes).toEqual([[1008, "Ticket already used"]]);

    // A Gateway ticket (not "switch-") has no spend, so a second connection with it is not refused here.
    expect(spendFor("gateway-ticket")).toBeNull();
    receiverStandIn.authentication_queue.clear();
    const gateway = connection(spendFor("gateway-ticket"));
    await auth(gateway.wt);
    expect(gateway.closes).toEqual([]);
    expect(posted.length).toBe(2);
  });

  test("end to end: a store that fails refuses the SWITCH ticket as one that could not be checked (fails closed)", async () => {
    const failing = new MemoryStore();
    failing.setIfAbsent = async () => { throw new Error("redis down"); };
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      const ticket = "switch-fedcba9876543210";
      const ticketSpent = spendsTicket(failing, ticket) ? spendTicket(failing, ticket, Date.now() + 30_000) : null;
      expect(ticketSpent).not.toBeNull();
      const { wt, closes } = connection(ticketSpent);
      await auth(wt);
      expect(closes).toEqual([[1008, "Ticket could not be checked"]]);
      expect(posted).toEqual([]);
      expect(warn.mock.calls.some((call) => String(call[0]).includes("SWITCH ticket is refused"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
}
