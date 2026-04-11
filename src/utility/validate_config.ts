import crypto from "crypto";
import log from "../modules/logger";

export default (async () => {

  const startUpErrors = [];
  const startUpWarnings = [];

  if (!process.env.DATABASE_ENGINE) {
    startUpErrors.push(
      "No database engine is set, aborting... Please set the DATABASE_ENGINE environment variable to suppress this message."
    );
  }

  if (!process.env.DATABASE_HOST) {
    startUpErrors.push(
      "No database host is set, aborting... Please set the DATABASE_HOST environment variable to suppress this message."
    );
  }

  if (!process.env.DATABASE_PORT) {
    startUpWarnings.push(
      "No database port is set, defaulting to 3306. Please set the DATABASE_PORT environment variable to suppress this message."
    );
    process.env.DATABASE_PORT = "3306";
  }

  if (!process.env.DATABASE_USER) {
    startUpErrors.push(
      "No database username is set, aborting... Please set the DATABASE_USER environment variable to suppress this message."
    );
  }

  if (!process.env.DATABASE_PASSWORD) {
    startUpErrors.push(
      "No database password is set, aborting... Please set the DATABASE_PASSWORD environment variable to suppress this message."
    );
  }

  if (!process.env.DATABASE_NAME) {
    startUpErrors.push(
      "No database name is set, aborting... Please set the DATABASE_NAME environment variable to suppress this message."
    );
  }

  if (!process.env.SQL_SSL_MODE) {
    startUpWarnings.push(
      "No database SSL is set, defaulting to false. Please set the SQL_SSL_MODE environment variable to suppress this message."
    );
    process.env.SQL_SSL_MODE = "false";
  }

  if (!process.env.GOOGLE_TRANSLATE_API_KEY) {
    startUpWarnings.push(
      "No Google Translation API key is set, translation functionality will be disabled. Please set the GOOGLE_TRANSLATE_API_KEY environment variable to suppress this message."
    );
  }

  if (!process.env.WEB_SOCKET_PORT) {
    startUpWarnings.push(
      "No websocket port is set, defaulting to 3000. Please set the WEB_SOCKET_PORT environment variable to suppress this message."
    );
    process.env.WEB_SOCKET_PORT = "3000";
  }

  if (process.env.SESSION_KEY) {
    startUpWarnings.push(
      "Session key is set. Do not set this manually. It will be overwritten with a random value. Please remove the SESSION_KEY environment variable to suppress this message."
    );
  }

  process.env.SESSION_KEY = crypto.randomBytes(20).toString("hex");

  if (process.env.RSA_PASSPHRASE) {
    startUpWarnings.push(
      "RSA passphrase is set. Do not set this manually. It will be overwritten with a random value. Please remove the RSA_PASSPHRASE environment variable to suppress this message."
    );
  }

  process.env.RSA_PASSPHRASE = crypto.randomBytes(32).toString("hex");

  if (!process.env.GAME_NAME) {
    startUpErrors.push(
      "No game name is set, aborting... Please set the GAME_NAME environment variable to suppress this message."
    );
  }

  if (!process.env.LOG_LEVEL) {
    startUpWarnings.push(
      "No log level is set, defaulting to info. Please set the LOG_LEVEL environment variable (trace, debug, info, warn, error) to suppress this message."
    );
    process.env.LOG_LEVEL = "info";
  } else if (!["trace", "debug", "info", "warn", "error"].includes(process.env.LOG_LEVEL)) {
    startUpWarnings.push(
      `Invalid LOG_LEVEL '${process.env.LOG_LEVEL}'. Valid values are: trace, debug, info, warn, error. Defaulting to info.`
    );
    process.env.LOG_LEVEL = "info";
  }

  if (process.env.CACHE?.toLowerCase() === "redis") {
    if (!process.env.REDIS_URL) {
      startUpWarnings.push(
        "No Redis URL is set, aborting... Please set the REDIS_URL environment variable to suppress this message."
      );
      process.env.CACHE = "memory";
    }
  }

  if (startUpWarnings.length > 0) {
    for (const warning of startUpWarnings) {
      log.warn(warning);
    }
  }

  if (startUpErrors.length > 0) {
    for (const error of startUpErrors) {
      log.error(error);
    }
    process.exit(1);
  }
})();
