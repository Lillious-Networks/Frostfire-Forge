import fs from "fs";
import path from "path";

export function getSqlCert() {
  if (!process.env.SQL_SSL_MODE || process.env.SQL_SSL_MODE === "DISABLED") {
    return;
  }
  return {
    cert: fs.readFileSync(
      path.join(import.meta.dirname, "..", "certs", "db.crt")
    ),
    rejectUnauthorized: false,
  }
}