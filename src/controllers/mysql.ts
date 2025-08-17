import log from "../modules/logger";
import * as mysql from "mysql2";
import { SQLController } from "./types";

// TODO Support MySQL Pool Cluster and Replication setups.
// TODO Support MySQL Transactions (begin, commit, rollback).

// mysql://username:password@host:port/database

export default class MySQLPoolController implements SQLController {
    private pool: mysql.Pool;

    constructor(connectionUri: string | mysql.PoolOptions) {
        this.pool = this.createPool(connectionUri);
    }

    private createPool(connectionUri: string | mysql.PoolOptions): mysql.Pool {
        if (!this.pool) {
            let config: mysql.PoolOptions = {};

            if (typeof connectionUri === "string") {
                config = { ...config, uri: connectionUri };
            }
            else if (typeof connectionUri === "object") {
                config = { ...config, ...connectionUri };
            }
            try {
                // Create the MySQL pool with the provided configuration
                log.debug(`Creating MySQL pool with config: ${JSON.stringify(config)}`);
                this.pool = mysql.createPool(config);
            }
            catch (e) {
                log.error(`Error creating MySQL pool: ${e.message}`);
                throw e;
            }
        }
        return this.pool;
    }

    private getPoolConnectionAsync(): Promise<mysql.PoolConnection> {
        return new Promise((resolve, reject) => {
            this.pool.getConnection((err, connection) => {
                if (err) {
                    log.error(`Error getting MySQL connection: ${err.message}`);
                    return reject(err);
                }
                resolve(connection);
            });
        });
    }

    query<T>(sql: string, values?: any): T[] | any[] {
        throw new Error("Method not implemented.");
    }

    async queryAsync<T>(sql: string, values?: any): Promise<T[] | any[]> {
        return new Promise(async (resolve, reject) => {
            try {
                const conn = await this.getPoolConnectionAsync();
                const formattedSql = mysql.format(sql, values);
                log.debug(`[MySQL.Query] Prepared Query: ${JSON.stringify(formattedSql)}`);
                // Uncomment the following lines to enable transactions (we probably want to use this only for insert/update/delete operations or larger queries).
                // conn.beginTransaction((err) => {
                //     if (err) {
                //         conn.release();
                //         log.error(`[MySQL.Query] Transaction Error: ${err.message}`);
                //         return reject(err);
                //     }
                // });
                conn.query(formattedSql, (err, rows) => {
                    conn.release();
                    if (err) {
                        log.error(`[MySQL.Query] Query Error: ${err.message}`);
                        return reject(err);
                    }
                    log.debug(`[MySQL.Query] Rows Returned: ${JSON.stringify(rows)}`);
                    return resolve(rows as T[]);
                });
                // conn.commit((err) => {
                //     if (err) {
                //         conn.release();
                //         log.error(`[MySQL.Query] Commit Error: ${err.message}`);
                //         conn.rollback(() => {
                //             return reject(err);
                //         });
                //     }
                // });
            }
            catch (err) {
                return reject(err);
            }
        });
    }
}
