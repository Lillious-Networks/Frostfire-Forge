import crypto from "crypto";
import log from "../modules/logger";
import { CLUSTER_SECRET_MIN_LENGTH } from "../cluster/clusterkeys";
import { nodeLinkBindError, redisUrlProblem } from "../cluster/config";

export default (async () => {

  const startUpErrors = [];
  const startUpWarnings = [];

  if (!process.env.DATABASE_ENGINE) {
    startUpErrors.push(
      "No database engine is set, aborting... Please set the DATABASE_ENGINE environment variable to suppress this message."
    );
  }

  // SQLite is a file: it has no host, port, user or password, and DATABASE_PATH names the file in place of DATABASE_NAME.
  const sqlite = process.env.DATABASE_ENGINE === "sqlite";

  if (!sqlite && !process.env.DATABASE_HOST) {
    startUpErrors.push(
      "No database host is set, aborting... Please set the DATABASE_HOST environment variable to suppress this message."
    );
  }

  if (!sqlite && !process.env.DATABASE_PORT) {
    startUpWarnings.push(
      "No database port is set, defaulting to 3306. Please set the DATABASE_PORT environment variable to suppress this message."
    );
    process.env.DATABASE_PORT = "3306";
  }

  if (!sqlite && !process.env.DATABASE_USER) {
    startUpErrors.push(
      "No database username is set, aborting... Please set the DATABASE_USER environment variable to suppress this message."
    );
  }

  if (!sqlite && !process.env.DATABASE_PASSWORD) {
    startUpErrors.push(
      "No database password is set, aborting... Please set the DATABASE_PASSWORD environment variable to suppress this message."
    );
  }

  if (!process.env.DATABASE_NAME && !(sqlite && process.env.DATABASE_PATH)) {
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

  if (!process.env.WEBSRV_PORTSSL && !process.env.GAME_PORT) {
    startUpWarnings.push(
      "No game port is set, defaulting to 3000. Please set the WEBSRV_PORTSSL environment variable to suppress this message."
    );
    process.env.WEBSRV_PORTSSL = "3000";
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

  // A cluster node without the shared cache would serve stale rows, so it refuses to start rather than fall back.
  if (process.env.CLUSTER === "true") {
    if (process.env.CACHE?.toLowerCase() !== "redis" || !process.env.REDIS_URL) {
      startUpErrors.push(
        "Cluster mode needs CACHE=redis and REDIS_URL, aborting... Please set both environment variables to suppress this message."
      );
    }
    // Redis carries the cluster's grants, snapshots and tombstones. Their records are sealed, but a seal does not stop a
    // delete or a replay of an older record, so Redis must be closed to anyone without the password (security review H1). Only the shape of the URL is read here; its value is never printed.
    if (process.env.REDIS_URL) {
      const problem = redisUrlProblem(process.env.REDIS_URL, process.env.REDIS_PASSWORD);
      if (problem) startUpErrors.push(problem);
    }
    // Node and region names end up in Redis keys and channel names, so they are limited to plain characters.
    for (const name of ["NODE_ID", "REGION_ID"]) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(process.env[name] ?? "")) {
        startUpErrors.push(
          `Cluster mode needs ${name} set to 1-64 letters, digits, '_' or '-', aborting... Please set the ${name} environment variable to suppress this message.`
        );
      }
    }
    // The port of the node link listener: a whole number a socket can bind (0 turns links off).
    const linkPort = process.env.NODE_LINK_PORT;
    if (linkPort !== undefined && linkPort.trim() !== "") {
      if (!/^\d+$/.test(linkPort.trim()) || Number(linkPort) > 65535) {
        startUpErrors.push(
          "Cluster mode needs NODE_LINK_PORT set to a whole number from 0 to 65535, aborting... Please set the NODE_LINK_PORT environment variable to suppress this message."
        );
      }
    }
    // A link listener open on every interface cannot hold against a flood from outside (security review L2, I2).
    const bindError = nodeLinkBindError();
    if (bindError) startUpErrors.push(bindError);
    // The connection tickets nodes hand each other (SWITCH) are signed with the game server secret.
    if (!process.env.GATEWAY_GAME_SERVER_SECRET) {
      startUpErrors.push(
        "Cluster mode needs GATEWAY_GAME_SERVER_SECRET (node tickets are signed with it), aborting... Please set the GATEWAY_GAME_SERVER_SECRET environment variable to suppress this message."
      );
    }
    // Node links and the cluster bus are signed with keys derived from the cluster's own secret (cluster/clusterkeys.ts,
    // which refuses it again at start). Only its length is read here, never its value.
    if ((process.env.CLUSTER_LINK_SECRET ?? "").length < CLUSTER_SECRET_MIN_LENGTH) {
      startUpErrors.push(
        `Cluster mode needs CLUSTER_LINK_SECRET set to at least ${CLUSTER_SECRET_MIN_LENGTH} random characters (node links and the cluster bus are signed with it), aborting... Please set the CLUSTER_LINK_SECRET environment variable to suppress this message.`
      );
    }
  }

  // Validate the generated settings.json webtransport keys so typos or stale
  // legacy schemas can't silently fall back to defaults.
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const settingsPath = path.join(import.meta.dir, "../config/settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as any;

    if (!settings?.webtransport) {
      startUpWarnings.push(
        "settings.json is missing the 'webtransport' section. WebTransport will fall back to defaults. Run `bun create-config` to regenerate."
      );
    } else {
      const wt = settings.webtransport;
      if (typeof wt.maxSessions !== "number" || wt.maxSessions <= 0) {
        startUpWarnings.push(
          "settings.json 'webtransport.maxSessions' is missing or invalid. Defaulting to 2000."
        );
      }
      if (typeof wt.maxDatagramSize !== "number" || wt.maxDatagramSize <= 0) {
        startUpWarnings.push(
          "settings.json 'webtransport.maxDatagramSize' is missing or invalid. Defaulting to 1200."
        );
      }
      if (!wt.rateLimits) {
        startUpWarnings.push(
          "settings.json 'webtransport.rateLimits' is missing. WebTransport rate limits will fall back to defaults."
        );
      }
    }

    if (!settings?.packetRatelimit) {
      startUpWarnings.push(
        "settings.json is missing the 'packetRatelimit' section. Packet rate limiting will be disabled. Run `bun create-config` to regenerate."
      );
    }

    // The tick rate: a value out of range is ignored (services/tickrate.ts), which should not pass unnoticed.
    const { MIN_TICK_RATE, MAX_TICK_RATE } = await import("../services/tickrate");
    const tickRateOk = (value: unknown) => Number.isFinite(Number(value)) && Number(value) >= MIN_TICK_RATE && Number(value) <= MAX_TICK_RATE;
    if (settings?.tickRate !== undefined && !tickRateOk(settings.tickRate)) {
      startUpWarnings.push(
        `settings.json 'tickRate' must be a number from ${MIN_TICK_RATE} to ${MAX_TICK_RATE}. Ignoring it.`
      );
    }
    if (process.env.TICK_RATE && !tickRateOk(process.env.TICK_RATE)) {
      startUpWarnings.push(
        `TICK_RATE must be a number from ${MIN_TICK_RATE} to ${MAX_TICK_RATE}. Ignoring it.`
      );
    }
  } catch {
    startUpWarnings.push(
      "settings.json could not be loaded. Run `bun create-config` to regenerate the configuration."
    );
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
