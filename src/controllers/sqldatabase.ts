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
            max: 50,
            idleTimeout: 60000,
            maxLifetime: 0,
            connectionTimeout: 30000
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

async function createSQLControllerWithRetry(): Promise<any> {
    const maxRetryTime = 5000; // 5 seconds total retry time
    const retryDelay = 1000; // 1 second between retries
    const startTime = Date.now();
    let lastError: Error | null = null;

    while (Date.now() - startTime < maxRetryTime) {
        try {
            log.info("Attempting to connect to database...");
            const controller = await createSQLController();

            // Test the connection with a simple query with timeout
            const testPromise = controller.unsafe("SELECT 1 AS test");
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error("Connection test query timeout")), 3000)
            );

            const result = await Promise.race([testPromise, timeoutPromise]);

            // Verify we got a valid result
            if (!result || (Array.isArray(result) && result.length === 0)) {
                throw new Error("Connection test returned invalid result");
            }

            log.success("Database connection established and verified!");
            return controller;
        } catch (error: any) {
            lastError = error;
            const elapsed = Date.now() - startTime;
            const remaining = maxRetryTime - elapsed;

            if (remaining > 0) {
                log.warn(`Database connection failed: ${error.message}. Retrying in ${retryDelay}ms... (${Math.ceil(remaining / 1000)}s remaining)`);
                await new Promise(resolve => setTimeout(resolve, Math.min(retryDelay, remaining)));
            }
        }
    }

    log.error(`Failed to connect to database after ${maxRetryTime}ms. Last error: ${lastError?.message}`);
    throw new Error(`Database connection timeout: ${lastError?.message}`);
}

const sqlController = await createSQLControllerWithRetry();

function sqlWrapper(query: string, params: any[]): string {
  const parts = query.split("?");
  if (parts.length - 1 !== params.length) {
    throw new Error("Number of placeholders does not match number of parameters");
  }

  let result = parts[0];
  for (let i = 0; i < params.length; i++) {
    const param = params[i];

    // Handle array (for IN clauses)
    if (Array.isArray(param)) {
      if (param.length === 0) {
        throw new Error("Cannot use empty array as SQL parameter");
      }
      const escapedArray = param.map(p => escapeValue(p)).join(", ");
      result += escapedArray + parts[i + 1];
    } else {
      result += escapeValue(param) + parts[i + 1];
    }
  }

  return result;
}

function escapeValue(param: any): string {
  if (param === null || param === undefined) {
    return "NULL";
  } else if (typeof param === "string") {
    return "'" + param.replace(/'/g, "''") + "'";
  } else if (typeof param === "number") {
    return param.toString();
  } else if (typeof param === "boolean") {
    return param ? "1" : "0";
  } else if (param instanceof Date) {
    return "'" + param.toISOString().slice(0, 19).replace("T", " ") + "'";
  } else {
    return "'" + String(param).replace(/'/g, "''") + "'";
  }
}


export default async function query<T>(sql: string, values?: any[]): Promise<T[]> {
  const maxRetries = 3;
  const retryDelay = 1000; // 1 second between retries
  const queryTimeout = 5000; // 5 second timeout per query
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Add timeout to the query
      const queryPromise = sqlController.unsafe(sqlWrapper(sql, values || []));
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Query timeout after ${queryTimeout}ms`)), queryTimeout)
      );

      const result = await Promise.race([queryPromise, timeoutPromise]);
      return result as T[];
    } catch (error: any) {
      lastError = error;
      const isConnectionError =
        error.message?.includes("Connection") ||
        error.message?.includes("connection") ||
        error.message?.includes("timeout") ||
        error.message?.includes("ECONNREFUSED") ||
        error.message?.includes("ETIMEDOUT") ||
        error.message?.includes("closed") ||
        error.message?.includes("Query timeout") ||
        error.code === "ECONNREFUSED" ||
        error.code === "ETIMEDOUT";

      if (isConnectionError && attempt < maxRetries) {
        log.warn(`SQL connection error (attempt ${attempt}/${maxRetries}): ${error.message}. Retrying in ${retryDelay}ms...`);
        log.debug(`Failed query: ${sql.substring(0, 100)}...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      } else {
        log.error(`SQL Error: ${error.message}`);
        log.debug(`Failed query: ${sql.substring(0, 100)}...`);
        throw error;
      }
    }
  }

  log.error(`SQL Error after ${maxRetries} attempts: ${lastError?.message}`);
  throw lastError;
}