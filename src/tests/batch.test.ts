import { beforeEach, describe, expect, mock, test } from "bun:test";
import { databaseModule } from "./setup";

// A batch gathers the statements of several systems and sends them as one transaction. The database
// layer here records what it was sent; whether a transaction is kept whole is sqltransaction.test.ts's.

type Statement = { sql: string; values?: any[]; mustChange?: boolean };

let sent: Statement[][];
let refuse: Error | null;
/** What happened, in the order it happened. */
let order: string[];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

mock.module("../controllers/sqldatabase", () => databaseModule({
  default: async () => [],
  transaction: async (statements: Statement[]) => {
    sent.push(statements);
    order.push("transaction");
    await sleep(5);
    if (refuse) throw refuse;
    return statements.map((statement) => ({ answerTo: statement.sql }));
  },
}));

const { atomically } = await import("../services/batch");
const { turns } = await import("../services/datacache");

beforeEach(() => {
  sent = [];
  refuse = null;
  order = [];
});

describe("atomically", () => {
  test("sends what was added as one transaction, in the order it was added", async () => {
    await atomically(["hero"], async (batch) => {
      batch.add({ sql: "UPDATE currency SET copper = ?", values: [5] });
      batch.add({ sql: "INSERT INTO inventory (item) VALUES (?)", values: ["sword"], mustChange: true });
    });

    expect(sent).toEqual([[
      { sql: "UPDATE currency SET copper = ?", values: [5] },
      { sql: "INSERT INTO inventory (item) VALUES (?)", values: ["sword"], mustChange: true },
    ]]);
  });

  test("answers with what the work answered", async () => {
    expect(await atomically(["hero"], async () => "done")).toBe("done");
  });

  test("hands each statement's result to the one who added it, then runs the kept steps in order", async () => {
    await atomically(["hero"], async (batch) => {
      batch.kept(() => { order.push("kept 1"); });
      batch.add({ sql: "first" }, (result) => order.push(`answer ${result.answerTo}`));
      batch.add({ sql: "second" });
      batch.add({ sql: "third" }, (result) => order.push(`answer ${result.answerTo}`));
      batch.kept(async () => { await sleep(1); order.push("kept 2"); });
      batch.undone(() => { order.push("undone"); });
    });

    expect(order).toEqual(["transaction", "answer first", "answer third", "kept 1", "kept 2"]);
  });

  test("a transaction the database refuses runs the undone steps, not the kept ones, and is the caller's error", async () => {
    refuse = new Error("database gone");

    const run = atomically(["hero"], async (batch) => {
      batch.add({ sql: "first" }, () => order.push("answer"));
      batch.kept(() => { order.push("kept"); });
      batch.undone(() => { order.push("undone 1"); });
      batch.undone(() => { order.push("undone 2"); });
    });

    await expect(run).rejects.toThrow("database gone");
    expect(order).toEqual(["transaction", "undone 1", "undone 2"]);
  });

  test("work that throws sends nothing", async () => {
    const run = atomically(["hero"], async (batch) => {
      batch.add({ sql: "first" });
      batch.kept(() => { order.push("kept"); });
      throw new Error("not enough copper");
    });

    await expect(run).rejects.toThrow("not enough copper");
    expect(sent).toEqual([]);
    expect(order).toEqual([]);
  });

  test("with nothing added the database is not asked, and the kept steps still run", async () => {
    await atomically(["hero"], async (batch) => {
      batch.kept(() => { order.push("kept"); });
    });

    expect(sent).toEqual([]);
    expect(order).toEqual(["kept"]);
  });

  test("a kept step that fails has the undone steps run, since what is held can be trusted no longer", async () => {
    const run = atomically(["hero"], async (batch) => {
      batch.add({ sql: "first" });
      batch.kept(() => { throw new Error("cache gone"); });
      batch.kept(() => { order.push("kept 2"); });
      batch.undone(() => { order.push("undone"); });
    });

    await expect(run).rejects.toThrow("cache gone");
    expect(order).toEqual(["transaction", "kept 2", "undone"]);
  });
});

describe("what a batch leaves for after it has ended", () => {
  test("runs once the batch is kept, with the player and the turns it held free again", async () => {
    const queue = turns();

    await atomically(["hero"], async (batch) => {
      await batch.hold(queue, "hero");
      batch.add({ sql: "first" });
      batch.kept(() => { order.push("kept"); });
      batch.after(async () => {
        await queue("hero", async () => { order.push("after: the turn"); });
        await atomically(["hero"], async () => { order.push("after: a batch"); });
      });
    });

    expect(order).toEqual(["transaction", "kept", "after: the turn", "after: a batch"]);
  });

  test("is not run for a batch that was not kept", async () => {
    refuse = new Error("database gone");

    await expect(atomically(["hero"], async (batch) => {
      batch.add({ sql: "first" });
      batch.after(() => { order.push("after"); });
    })).rejects.toThrow("database gone");
    await expect(atomically(["hero"], async (batch) => {
      batch.after(() => { order.push("after"); });
      throw new Error("not enough copper");
    })).rejects.toThrow("not enough copper");

    expect(order).toEqual(["transaction"]);
  });

  test("failing, is not the caller's error: what the batch wrote is kept", async () => {
    const answer = await atomically(["hero"], async (batch) => {
      batch.add({ sql: "first" });
      batch.after(() => { throw new Error("quest sync failed"); });
      batch.after(() => { order.push("the next one still runs"); });
      return "done";
    });

    expect(answer).toBe("done");
    expect(order).toEqual(["transaction", "the next one still runs"]);
  });
});

describe("a batch and the players it names", () => {
  test("two batches naming the same player run one after the other", async () => {
    const first = atomically(["Hero"], async (batch) => {
      order.push("first starts");
      await sleep(10);
      batch.add({ sql: "first" });
      batch.kept(() => { order.push("first kept"); });
    });
    const second = atomically(["hero"], async () => { order.push("second starts"); });
    await Promise.all([first, second]);

    expect(order).toEqual(["first starts", "transaction", "first kept", "second starts"]);
  });

  test("batches naming different players do not wait for each other", async () => {
    const first = atomically(["hero"], async () => {
      order.push("first starts");
      await sleep(10);
      order.push("first ends");
    });
    const second = atomically(["ally"], async () => { order.push("second starts"); });
    await Promise.all([first, second]);

    expect(order).toEqual(["first starts", "second starts", "first ends"]);
  });

  test("batches naming the same two players the other way round both finish", async () => {
    const trade = (players: string[], name: string) => atomically(players, async (batch) => {
      await sleep(2);
      batch.add({ sql: name });
    });

    await Promise.all([trade(["hero", "ally"], "one"), trade(["ally", "hero"], "two"), trade(["hero", "ally"], "three")]);
    expect(sent.map((statements) => statements[0].sql).sort()).toEqual(["one", "three", "two"]);
  });
});

describe("a system's turn, held for a batch", () => {
  test("is kept until the batch ends: work asked of the same key meanwhile runs after the transaction", async () => {
    const queue = turns();
    let plain: Promise<unknown> = Promise.resolve();

    await atomically(["hero"], async (batch) => {
      await batch.hold(queue, "hero");
      order.push("held");
      plain = queue("hero", async () => { order.push("plain work"); });
      await sleep(5);
      batch.add({ sql: "first" });
      batch.kept(() => { order.push("kept"); });
    });
    await plain;

    expect(order).toEqual(["held", "transaction", "kept", "plain work"]);
  });

  test("waits for work already under way on that key", async () => {
    const queue = turns();
    const plain = queue("hero", async () => {
      await sleep(10);
      order.push("plain work");
    });

    await atomically(["hero"], async (batch) => {
      await batch.hold(queue, "HERO");
      order.push("held");
    });
    await plain;

    expect(order).toEqual(["plain work", "held"]);
  });

  test("asked for twice at the same moment, both wait until it is taken", async () => {
    const queue = turns();
    const plain = queue("hero", async () => {
      await sleep(10);
      order.push("plain work");
    });

    await atomically(["hero"], async (batch) => {
      await Promise.all([
        batch.hold(queue, "hero").then(() => order.push("first has it")),
        batch.hold(queue, "hero").then(() => order.push("second has it")),
      ]);
    });
    await plain;

    expect(order).toEqual(["plain work", "first has it", "second has it"]);
  });

  test("is taken once however often it is asked for", async () => {
    const queue = turns();

    await atomically(["hero"], async (batch) => {
      await batch.hold(queue, "hero");
      await batch.hold(queue, "Hero");
      order.push("held twice");
    });

    expect(order).toEqual(["held twice"]);
    expect(queue.busy).toBe(0);
  });

  test("is given back when the transaction is refused", async () => {
    const queue = turns();
    refuse = new Error("database gone");

    await expect(atomically(["hero"], async (batch) => {
      await batch.hold(queue, "hero");
      batch.add({ sql: "first" });
    })).rejects.toThrow("database gone");

    await queue("hero", async () => { order.push("plain work"); });
    expect(order).toEqual(["transaction", "plain work"]);
  });

  test("cannot be taken for a player the batch did not name", async () => {
    const queue = turns();

    const run = atomically(["hero"], async (batch) => {
      await batch.hold(queue, "ally");
    });

    await expect(run).rejects.toThrow("ally");
  });
});

describe("what a system has pending in a batch", () => {
  test("is started once for each player and handed back as the same thing after", async () => {
    const owner = {};
    let started = 0;
    const start = async () => ({ rows: [] as string[], started: ++started });

    await atomically(["hero", "ally"], async (batch) => {
      const first = await batch.pending(owner, "hero", start);
      first.rows.push("sword");
      const again = await batch.pending(owner, "Hero", start);
      const other = await batch.pending(owner, "ally", start);

      expect(again).toBe(first);
      expect(again.rows).toEqual(["sword"]);
      expect(other).not.toBe(first);
    });

    expect(started).toBe(2);
  });

  test("is kept apart for each system", async () => {
    await atomically(["hero"], async (batch) => {
      const one = await batch.pending({}, "hero", async () => ({ of: "inventory" }));
      const two = await batch.pending({}, "hero", async () => ({ of: "currency" }));

      expect(one.of).toBe("inventory");
      expect(two.of).toBe("currency");
    });
  });

  test("is not carried into the next batch", async () => {
    const owner = {};
    let started = 0;
    const start = async () => ({ started: ++started });

    await atomically(["hero"], (batch) => batch.pending(owner, "hero", start));
    await atomically(["hero"], (batch) => batch.pending(owner, "hero", start));

    expect(started).toBe(2);
  });
});
