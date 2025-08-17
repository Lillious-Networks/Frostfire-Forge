// https://github.com/oven-sh/bun/blob/main/src/js/bun/sqlite.ts
import * as sqlite from "bun:sqlite";
import log from "../modules/logger";

import { SQLController } from "./types";

/**
 * SQLiteController is a class that provides an interface for interacting with an SQLite database.
 */
export default class SQLiteController implements SQLController {
    private db: sqlite.Database;

    /**
     * Creates an instance of SQLite Database in WAL mode.
     * @param dbPath The path to the SQLite database file. Defaults to "database.sqlite", use Empty string or ":memory:" for in-memory database.
     * @throws Will throw an error if the database cannot be opened.
     */
    constructor(private dbPath: string = "database.sqlite") {
        this.db = new sqlite.Database(this.dbPath);
        this.db.exec("PRAGMA journal_mode = WAL;"); // Enable Write-Ahead journaling - https://bun.com/docs/api/sqlite#wal-mode
        log.info(`SQLite database opened with ${!this.dbPath ? '":memory:"' : 'Path "' + this.dbPath + '"'} in WAL mode.`);
    }

    /**
     * Executes a SQL query and returns the result.
     * @param sql The SQL query to execute.
     * @param values Optional parameters for the query.
     * @returns The rows returned by the query.
     * @throws Will throw an error if the query fails.
     * @template T The type of the rows returned by the query.
     */
    query<T>(sql: string, values?: any): T[] | any[] {
        try {
            const _query = this.db.query(sql); // Prepare Statement (with query-cache)
            log.debug(`[SQLite.Query] Prepared Query: ${JSON.stringify(_query)}`);
            const _rows = _query.all(values); // Execute query with params
            log.debug(`[SQLite.Query] Rows Returned: ${JSON.stringify(_rows)}`);
            return _rows as T[];
        }
        catch (e: unknown) {
            // This is stupid, Typescript should handle this better than "unknown".
            // e.g. catch (e: Error | TypeError | sqlite.SQLiteError) but maybe that's my Java(tm) history showing...
            if (e instanceof sqlite.SQLiteError) {
                log.error(`[SQLite.Query.Catch] SQLite Error: ${e.message}`);
            }
            else if (e instanceof Error || e instanceof TypeError) {
                log.error(`[SQLite.Query.Catch] Error: ${e.message}`);
            }
            throw e; // Re-throw the error to be handled by the caller (idgf).
        }
    }

    queryAsync<T>(sql: string, values?: any): Promise<T[] | any[]> {
        return new Promise((resolve, reject) => {
            try {
                const result: T[] = this.query<T>(sql, values);
                return resolve(result);
            }
            catch (e: unknown) {
                return reject(e);
            }
        });
    }
}