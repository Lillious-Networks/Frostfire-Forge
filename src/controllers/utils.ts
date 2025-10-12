import fs from "fs";
import path from "path";

export function getSqlCert() {
  if (!process.env.SQL_SSL_MODE || process.env.SQL_SSL_MODE === "DISABLED") {
    return {}; // Mysql 9.4 doesn't like "false" here
  }
  return {
    cert: fs.readFileSync(
      path.join(import.meta.dirname, "..", "certs", "db.crt")
    ),
    rejectUnauthorized: false,
  }
}