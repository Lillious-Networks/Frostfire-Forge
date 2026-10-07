import query from "../controllers/sqldatabase";
import log from "../modules/logger";
import type { Batch } from "../services/batch";
import { tableCache } from "../services/datacache";

/** How many of the latest trades are held. The table keeps them all. */
export const TRADES_KEPT = 500;

/** What one player handed over in a trade. */
export interface TradeGave {
  items: Array<{ name: string; quantity: number }>;
  coins: Currency;
}

/** A row of the trade_log table: a trade that was completed. Times are milliseconds since the epoch. */
export interface TradeRecord {
  id: number;
  player_a: string;
  player_b: string;
  a_gave: TradeGave;
  b_gave: TradeGave;
  created_at: number;
}

const COLUMNS = "id, player_a, player_b, a_gave, b_gave, created_at";
const NOTHING: TradeGave = { items: [], coins: { copper: 0, silver: 0, gold: 0 } };

const lower = (username: string) => String(username ?? "").toLowerCase();
const newestFirst = (a: TradeRecord, b: TradeRecord) => b.id - a.id;

/** What a row holds of one side: text in a text column, already parsed in a JSON one. */
function gaveOf(stored: unknown): TradeGave {
  try {
    const parsed = typeof stored === "string" ? JSON.parse(stored) : stored;
    if (parsed && Array.isArray(parsed.items) && parsed.coins) return parsed as TradeGave;
  } catch {
    // A row that cannot be read shows as nothing given.
  }
  return structuredClone(NOTHING);
}

const fromRow = (row: any): TradeRecord => ({
  id: Number(row.id),
  player_a: row.player_a,
  player_b: row.player_b,
  a_gave: gaveOf(row.a_gave),
  b_gave: gaveOf(row.b_gave),
  created_at: Number(row.created_at),
});

// The latest trades, which is what the staff look through. Reads are answered
// from these rows; a trade is written to the database with the swap itself, and
// then added to them.
const rows = tableCache<TradeRecord>("trade_log", async () =>
  (((await query(`SELECT ${COLUMNS} FROM trade_log ORDER BY id DESC LIMIT ?`, [TRADES_KEPT])) as any[]) || []).map(fromRow)
);

/** The id the database gave the row an INSERT made, when its answer says. */
function insertedId(result: any): number | null {
  const id = Number(result?.lastInsertRowid);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** After a trade was written: it is held, and the oldest ones beyond what is kept are let go. */
async function remember(record: TradeRecord) {
  await rows.put(record, (held) => held.id === record.id);
  const held = (await rows.all()).sort(newestFirst);
  const dropped = new Set(held.slice(TRADES_KEPT).map((old) => old.id));
  if (dropped.size > 0) await rows.remove((old) => dropped.has(old.id));
}

const tradeLog = {
  /**
   * Adds a completed trade to `batch` (see services/batch), so it is written with the swap or not
   * at all. The record handed back has its id once the batch is kept.
   */
  write(batch: Batch, trade: Omit<TradeRecord, "id">): TradeRecord {
    const record: TradeRecord = { ...trade, id: 0, player_a: lower(trade.player_a), player_b: lower(trade.player_b) };
    batch.add({
      sql: "INSERT INTO trade_log (player_a, player_b, a_gave, b_gave, created_at) VALUES (?, ?, ?, ?, ?)",
      values: [record.player_a, record.player_b, JSON.stringify(record.a_gave), JSON.stringify(record.b_gave), record.created_at],
    }, (result) => { record.id = insertedId(result) ?? 0; });
    // The trade stands whatever becomes of the copy held here: a failure is not the batch's.
    batch.after(async () => {
      try {
        // An answer without an id leaves the row unknown: the table is read.
        if (record.id > 0) await remember(record);
        else await rows.reload();
      } catch (error) {
        log.error(`Error holding a trade that was written: ${error}`);
        await rows.drop();
      }
    });
    return record;
  },
  /** The latest trades a player was part of, the newest first. */
  async of(username: string, limit = 20): Promise<TradeRecord[]> {
    const name = lower(username);
    return (await rows.filter((record) => record.player_a === name || record.player_b === name)).sort(newestFirst).slice(0, limit);
  },
};

export default tradeLog;
