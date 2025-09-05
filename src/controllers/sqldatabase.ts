import { SQL } from 'bun';
import log from "../modules/logger";
import { getSqlCert } from "./utils";

async function createSQLController(): Promise<any> {
    const _databaseEngine = process.env.DATABASE_ENGINE || "mysql" as DatabaseEngine;
    if (_databaseEngine === "mysql") {
        if (!process.env.DATABASE_HOST || !process.env.DATABASE_USER || !process.env.DATABASE_PASSWORD || !process.env.DATABASE_NAME) {
            throw new Error("MySQL connection parameters are not set in environment variables.");
        }

        const db = new SQL({
            adapter: _databaseEngine,
            host: process.env.DATABASE_HOST,
            username: process.env.DATABASE_USER,
            password: process.env.DATABASE_PASSWORD,
            database: process.env.DATABASE_NAME,
            port: parseInt(process.env.DATABASE_PORT || "3306"),
            tls: getSqlCert(),
            max: 20,
            idleTimeout: 30,
            maxLifetime: 0,
            connectionTimeout: 30
        });
        
        return db;
    }
    // The written SQL statements are not compatible with postgres, so this is untested and probably broken.
    else if (_databaseEngine === "postgres") {
        if (!process.env.DATABASE_HOST || !process.env.DATABASE_USER || !process.env.DATABASE_PASSWORD || !process.env.DATABASE_NAME) {
            throw new Error("PostgreSQL connection parameters are not set in environment variables.");
        }

        const db = new SQL({
            url: `postgresql://${process.env.DATABASE_USER}:${encodeURIComponent(process.env.DATABASE_PASSWORD || "")}@${process.env.DATABASE_HOST}:${process.env.DATABASE_PORT || "5432"}/${process.env.DATABASE_NAME}`,
            adapter: "postgres",
            hostname: process.env.DATABASE_HOST,
            port: parseInt(process.env.DATABASE_PORT || "5432"),
            username: process.env.DATABASE_USER,
            password: process.env.DATABASE_PASSWORD,
            database: process.env.DATABASE_NAME,
            tls: getSqlCert(),
            connectionTimeout: 30,
            idleTimeout: 30,
            maxLifetime: 0,
            max: 20,
        });

        return db;
    } 
    // default to SQLite for local development and testing
    else if (_databaseEngine === "sqlite") {
        const db = new SQL({
            adapter: "sqlite",
            filename: process.env.DATABASE_NAME ? `${process.env.DATABASE_NAME}.sqlite` : "./database.sqlite",
        });
        return db;
    }
}

const sqlController = await createSQLController();

function sqlWrapper(query: string, params: any[]): string {
  const parts = query.split("?");
  if (parts.length - 1 !== params.length) {
    throw new Error("Number of placeholders does not match number of parameters");
  }

  let result = parts[0];
  for (let i = 0; i < params.length; i++) {
    const param = params[i];
    let escapedParam: string;
    
    if (param === null || param === undefined) {
      escapedParam = 'NULL';
    } else if (typeof param === 'string') {
      // Escape single quotes and wrap in quotes
      escapedParam = "'" + param.replace(/'/g, "''") + "'";
    } else if (typeof param === 'number') {
      escapedParam = param.toString();
    } else if (typeof param === 'boolean') {
      escapedParam = param ? '1' : '0';
    } else if (param instanceof Date) {
      escapedParam = "'" + param.toISOString().slice(0, 19).replace('T', ' ') + "'";
    } else {
      // For other types, convert to string and treat as string
      escapedParam = "'" + String(param).replace(/'/g, "''") + "'";
    }
    
    result += escapedParam + parts[i + 1];
  }

  return result;
}

export default async function query<T>(sql: string, values?: any[]): Promise<T[]> {
  try {
    const result = await sqlController.unsafe(sqlWrapper(sql, values || []));
    return result as T[];
  } catch (error) {
    log.error(`SQL Error: ${(error as Error).message}`);
    throw error;
  }
}