import { getSqlCert } from "./utils";

import { SQLController } from "./types";
import MySQLController from "./mysql";
import SQLiteController from "./sqlite";


function createSQLController(): SQLController {
    const _databaseEngine = process.env.DATABASE_ENGINE || "mysql";
    // Default to MySQL if not specified, currently only supported in production environments.
    if (_databaseEngine === "mysql") {
        if (!process.env.DATABASE_HOST || !process.env.DATABASE_USER || !process.env.DATABASE_PASSWORD || !process.env.DATABASE_NAME) {
            throw new Error("MySQL connection parameters are not set in environment variables.");
        }

        const config = {
            host: process.env.DATABASE_HOST,
            user: process.env.DATABASE_USER,
            password: process.env.DATABASE_PASSWORD,
            database: process.env.DATABASE_NAME,
            ssl: getSqlCert(),
            port: parseInt(process.env.DATABASE_PORT || "3306"),
        };
        return new MySQLController(config);
    }
    // SQLite used in development environment.
    // It is not recommended to use SQLite in production.
    else if (_databaseEngine === "sqlite") {
        // log.error("SQLite is not configured. Please set DATABASE_ENGINE to 'sqlite' in your environment variables.");
        const config = {
            database: "database.sqlite"
        };
        return new SQLiteController(config.database);
    } else {
        throw new Error(`Unsupported database engine: ${_databaseEngine}`);
    }
}

const sqlController: SQLController = createSQLController();

export default function query<T>(sql: string, values?: any): Promise<T[] | any[]> {
    return sqlController.queryAsync<T>(sql, values);
}