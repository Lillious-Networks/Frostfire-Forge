import log from "../modules/logger";
import * as mysql from "mysql2";
import * as sqlite from "bun:sqlite";
import fs from "fs";
import path from "path";

const _databaseEngine = process.env.DATABASE_ENGINE || "mysql"

function getSqlCert() {
  if (process.env.SQL_SSL_MODE === "DISABLED") {
    return undefined;
  }
  return {
    cert: fs.readFileSync(
      path.join(import.meta.dirname, "..", "certs", "db.crt")
    ),
    rejectUnauthorized: false,
  }
}

let pool: mysql.Pool;
if (_databaseEngine === "mysql") {
  pool = mysql.createPool({
    host: process.env.DATABASE_HOST,
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    waitForConnections: true,
    database: process.env.DATABASE_NAME,
    ssl: getSqlCert(),
    port: parseInt(process.env.DATABASE_PORT || "3306"),
  } as mysql.PoolOptions);
}


let _sqlitedb: sqlite.Database;
if (_databaseEngine === "sqlite") {
  _sqlitedb = new sqlite.Database("database.sqlite");
  _sqlitedb.exec("PRAGMA journal_mode = WAL;"); // enable Write-Ahead journaling - https://bun.com/docs/api/sqlite#wal-mode
}

const query = (sql: string, values?: any[]) => {
  log.trace(`Executing query: ${sql}`);
  return new Promise((resolve, reject) => {
    if (_databaseEngine === "sqlite" && _sqlitedb) {
      try {
        const _query = _sqlitedb.query(sql); // Prepare Statenent (with query-cache)
        const _rows = _query.all(values as any); // Execute query with params
        log.trace(`[SQLite.Query] Query: ${JSON.stringify(_query)}`);
        log.trace(`[SQLite.Query] Rows Returned: ${JSON.stringify(_rows)}`);
        resolve(_rows);
      } catch (err) {
        reject(err);
      }
    }
    else {
      pool.getConnection((err, connection) => {
        try {
          if (err) {
            reject(err);
          }
          connection.query(mysql.format(sql, values), (err, rows) => {
            if (err) {
              reject(err);
            } else {
              resolve(rows);
            }
            connection.release();
          });
        } catch (err) {
          reject(err);
        }
      });
    }
  });
};

export default query;