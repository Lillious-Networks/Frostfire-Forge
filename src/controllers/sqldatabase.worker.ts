import { SQL } from 'bun';
import log from "../modules/logger";
import { getSqlCert } from "./utils";

let sqlController: any = null;

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
      connectionTimeout: 60000 // Increased from 30s to 60s
    });

    return db;
  }
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
      connectionTimeout: 60, // Increased from 30s to 60s
      idleTimeout: 60, // Increased from 30s to 60s
      maxLifetime: 0,
      max: 20,
    });

    return db;
  }
  else if (_databaseEngine === "sqlite") {
    const db = new SQL({
      adapter: "sqlite",
      filename: process.env.DATABASE_NAME ? `${process.env.DATABASE_NAME}.sqlite` : "./database.sqlite",
    });
    return db;
  }
}

async function createSQLControllerWithRetry(): Promise<any> {
  const maxRetryTime = 30000; // Increased from 5s to 30s
  const retryDelay = 1000;
  const startTime = Date.now();
  let lastError: Error | null = null;

  while (Date.now() - startTime < maxRetryTime) {
    try {
      const controller = await createSQLController();

      const testPromise = controller.unsafe("SELECT 1 AS test");
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Connection test query timeout")), 10000) // Increased from 3s to 10s
      );

      const result = await Promise.race([testPromise, timeoutPromise]);

      if (!result || (Array.isArray(result) && result.length === 0)) {
        throw new Error("Connection test returned invalid result");
      }

      return controller;
    } catch (error: any) {
      lastError = error;
      const elapsed = Date.now() - startTime;
      const remaining = maxRetryTime - elapsed;

      if (remaining > 0) {
        await new Promise(resolve => setTimeout(resolve, Math.min(retryDelay, remaining)));
      }
    }
  }

  throw new Error(`Database connection timeout: ${lastError?.message}`);
}

// Initialize connection when worker starts
createSQLControllerWithRetry().then(controller => {
  sqlController = controller;
  self.postMessage({ type: 'ready' });
}).catch(error => {
  self.postMessage({ type: 'error', error: error.message });
});

// Listen for query messages
self.onmessage = async (event: MessageEvent) => {
  const { id, sql, values } = event.data;
  const maxRetries = 3;
  const retryDelay = 1000;
  const queryTimeout = 15000; // Increased from 5s to 15s
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const queryPromise = sqlController.unsafe(sqlWrapper(sql, values || []));
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Query timeout after ${queryTimeout}ms`)), queryTimeout)
      );

      const result = await Promise.race([queryPromise, timeoutPromise]);
      self.postMessage({ id, result });
      return;
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
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      } else {
        self.postMessage({ id, error: error.message });
        return;
      }
    }
  }

  self.postMessage({ id, error: lastError?.message || 'Unknown error' });
};
