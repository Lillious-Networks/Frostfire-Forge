import query from "../controllers/sqldatabase";
import log from "../modules/logger";
import { tableCache, turns } from "../services/datacache";
import type { ChatLine } from "./chatgate";

export const REPORT_CATEGORIES = ["harassment", "spam", "cheating", "name", "other"] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

/** How many reports one player files in an hour. */
export const REPORTS_PER_HOUR = 5;
/** The most characters of a report's details that are kept. */
export const DETAILS_MAX = 500;
/** How many of the latest resolved reports are held beside the open ones. */
export const RESOLVED_KEPT = 50;

const HOUR = 3_600_000;

/** A line of chat as a report keeps it: when, on which channel, and what was said. Not who else it reached. */
export type ReportLine = Pick<ChatLine, "at" | "channel" | "text">;

/** Where a player was: null for one who was not online. */
export type Place = { map: string; x: number; y: number } | null;

/** A row of the reports table. Times are milliseconds since the epoch. */
export interface Report {
  id: number;
  reporter: string;
  target: string;
  category: ReportCategory;
  details: string | null;
  /** The reported player's latest lines that reached the reporter. */
  chat_log: ReportLine[];
  map: string | null;
  x: number | null;
  y: number | null;
  target_map: string | null;
  target_x: number | null;
  target_y: number | null;
  created_at: number;
  status: "open" | "resolved";
  resolved_by: string | null;
  resolved_at: number | null;
  resolution: string | null;
}

export interface Filing {
  reporter: string;
  target: string;
  category: string;
  details?: string | null;
  lines: ReportLine[];
  reporterAt: Place;
  targetAt: Place;
}

/** Why a report was not filed. */
export type RefusedReport = "self" | "category" | "duplicate" | "limit";

const COLUMNS = "id, reporter, target, category, details, chat_log, map, x, y, target_map, target_x, target_y, created_at, status, resolved_by, resolved_at, resolution";

const lower = (username: string) => String(username ?? "").toLowerCase();
const numberOrNull = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const byId = (id: number) => (report: Report) => Number(report.id) === Number(id);
const newestFirst = (a: Report, b: Report) => b.created_at - a.created_at || b.id - a.id;

/** The lines a row holds: text in a text column, already parsed in a JSON one. */
function linesOf(stored: unknown): ReportLine[] {
  if (Array.isArray(stored)) return stored as ReportLine[];
  try {
    const parsed = JSON.parse(String(stored ?? "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const fromRow = (row: any): Report => ({
  id: Number(row.id),
  reporter: row.reporter,
  target: row.target,
  category: row.category,
  details: row.details ?? null,
  chat_log: linesOf(row.chat_log),
  map: row.map ?? null,
  x: numberOrNull(row.x),
  y: numberOrNull(row.y),
  target_map: row.target_map ?? null,
  target_x: numberOrNull(row.target_x),
  target_y: numberOrNull(row.target_y),
  created_at: Number(row.created_at),
  status: row.status === "resolved" ? "resolved" : "open",
  resolved_by: row.resolved_by ?? null,
  resolved_at: numberOrNull(row.resolved_at),
  resolution: row.resolution ?? null,
});

// The reports the staff work from: every open one, and the latest that were
// resolved. Reads are answered from these rows; a change below is written to
// the database and then to them, and a write the database does not answer has
// them read again.
const rows = tableCache<Report>("reports", async () => {
  const open = (await query(`SELECT ${COLUMNS} FROM reports WHERE status = 'open'`, [])) as any[];
  const resolved = (await query(`SELECT ${COLUMNS} FROM reports WHERE status = 'resolved' ORDER BY resolved_at DESC LIMIT ?`, [RESOLVED_KEPT])) as any[];
  return [...(open || []), ...(resolved || [])].map(fromRow);
});

// One change at a time. Filing is a check followed by a write: the same
// report arriving twice must not pass the check twice before either writes.
const oneAtATime = turns();
const inTurn = <T>(work: () => Promise<T>) => oneAtATime("reports", work);

/**
 * Runs one write. When the database does not answer it the reports are read
 * again: a statement that timed out may still have been applied. The failure
 * is still thrown.
 */
async function writing<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    await rows.reload().catch((failure) => log.error(`Error reading the reports again after a failed write: ${failure}`));
    throw error;
  }
}

/** The id the database gave the row an INSERT made, when its answer says. */
function insertedId(result: any): number | null {
  const id = Number(result?.lastInsertRowid);
  return Number.isInteger(id) && id > 0 ? id : null;
}

const reports = {
  /** The open reports, newest first. */
  async open(): Promise<Report[]> {
    return (await rows.filter((report) => report.status === "open")).sort(newestFirst);
  },
  /** The latest resolved reports, the last resolved first. */
  async resolved(): Promise<Report[]> {
    return (await rows.filter((report) => report.status === "resolved")).sort((a, b) => (b.resolved_at ?? 0) - (a.resolved_at ?? 0) || b.id - a.id);
  },
  /** One of the reports held, or null. */
  async get(id: number): Promise<Report | null> {
    return rows.find(byId(id));
  },
  /** How many reports are open, or how many of them name `username`. */
  async openCount(username?: string): Promise<number> {
    const name = username === undefined ? null : lower(username);
    let count = 0;
    // Looks at every row held and copies none: `find` copies only a row it returns, and is given none.
    await rows.find((report) => {
      if (report.status === "open" && (name === null || report.target === name)) count++;
      return false;
    });
    return count;
  },
  /** How many open reports name this player. */
  async openAgainst(username: string): Promise<number> {
    return reports.openCount(username);
  },
  /**
   * Files a report, or says why it was not filed. `target` is the name of an account: whether
   * there is one is for the caller to have asked the player system.
   */
  async file(filing: Filing, now = Date.now()): Promise<{ ok: true; report: Report } | { ok: false; code: RefusedReport }> {
    const reporter = lower(filing.reporter);
    const target = lower(filing.target);
    if (!REPORT_CATEGORIES.includes(filing.category as ReportCategory)) return { ok: false, code: "category" };
    if (target === reporter) return { ok: false, code: "self" };

    return inTurn(async () => {
      const mine = await rows.filter((report) => report.reporter === reporter);
      if (mine.some((report) => report.status === "open" && report.target === target)) return { ok: false, code: "duplicate" };
      if (mine.filter((report) => now - report.created_at < HOUR).length >= REPORTS_PER_HOUR) return { ok: false, code: "limit" };

      const report: Report = {
        id: 0,
        reporter,
        target,
        category: filing.category as ReportCategory,
        details: filing.details?.trim().slice(0, DETAILS_MAX) || null,
        // What was said, and not who else heard it: that is no part of a report, and can be long.
        chat_log: filing.lines.map(({ at, channel, text }) => ({ at, channel, text })),
        map: filing.reporterAt?.map ?? null,
        x: filing.reporterAt?.x ?? null,
        y: filing.reporterAt?.y ?? null,
        target_map: filing.targetAt?.map ?? null,
        target_x: filing.targetAt?.x ?? null,
        target_y: filing.targetAt?.y ?? null,
        created_at: now,
        status: "open",
        resolved_by: null,
        resolved_at: null,
        resolution: null,
      };
      const result = await writing(() => query(
        "INSERT INTO reports (reporter, target, category, details, chat_log, map, x, y, target_map, target_x, target_y, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')",
        [report.reporter, report.target, report.category, report.details, JSON.stringify(report.chat_log), report.map, report.x, report.y, report.target_map, report.target_x, report.target_y, report.created_at]
      ));

      const id = insertedId(result);
      if (id !== null) {
        report.id = id;
        await rows.put(report, byId(id));
        return { ok: true, report };
      }
      // An answer without an id leaves the row unknown: the table is read, and the report is the one just written.
      await rows.reload();
      const written = await rows.find((held) => held.reporter === reporter && held.target === target && held.created_at === now && held.status === "open");
      return { ok: true, report: written ?? report };
    });
  },
  /** Resolves an open report. Null when there is no such report, or it is not open. */
  async resolve(id: number, by: string, note: string | null, now = Date.now()): Promise<Report | null> {
    return inTurn(async () => {
      const report = await rows.find(byId(id));
      if (!report || report.status !== "open") return null;

      const resolved: Report = { ...report, status: "resolved", resolved_by: lower(by), resolved_at: now, resolution: note?.trim().slice(0, DETAILS_MAX) || null };
      await writing(() => query(
        "UPDATE reports SET status = 'resolved', resolved_by = ?, resolved_at = ?, resolution = ? WHERE id = ? AND status = 'open'",
        [resolved.resolved_by, resolved.resolved_at, resolved.resolution, resolved.id]
      ));
      await rows.put(resolved, byId(resolved.id));

      // Only the latest resolved ones are held: the rest stay in the table.
      const kept = await reports.resolved();
      const dropped = new Set(kept.slice(RESOLVED_KEPT).map((old) => old.id));
      if (dropped.size > 0) await rows.remove((old) => dropped.has(old.id));
      return resolved;
    });
  },
};

export default reports;
