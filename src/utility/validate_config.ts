import crypto from "crypto";
import log from "../modules/logger";

export default (async () => {
  // Track start up errors and warnings
  const startUpErrors = [];
  const startUpWarnings = [];

  // Validate environment variables

  // Database Engine
  if (!process.env.DATABASE_ENGINE) {
    startUpErrors.push(
      "No database engine is set, aborting... Please set the DATABASE_ENGINE environment variable to suppress this message."
    );
  }

  // Database Host
  if (!process.env.DATABASE_HOST) {
    startUpErrors.push(
      "No database host is set, aborting... Please set the DATABASE_HOST environment variable to suppress this message."
    );
  }

  // Database Port
  if (!process.env.DATABASE_PORT) {
    startUpWarnings.push(
      "No database port is set, defaulting to 3306. Please set the DATABASE_PORT environment variable to suppress this message."
    );
    process.env.DATABASE_PORT = "3306";
  }

  // Database Username
  if (!process.env.DATABASE_USER) {
    startUpErrors.push(
      "No database username is set, aborting... Please set the DATABASE_USER environment variable to suppress this message."
    );
  }

  // Database Password
  if (!process.env.DATABASE_PASSWORD) {
    startUpErrors.push(
      "No database password is set, aborting... Please set the DATABASE_PASSWORD environment variable to suppress this message."
    );
  }

  // Database Name
  if (!process.env.DATABASE_NAME) {
    startUpErrors.push(
      "No database name is set, aborting... Please set the DATABASE_NAME environment variable to suppress this message."
    );
  }

  // Database SSL
  if (!process.env.SQL_SSL_MODE) {
    startUpWarnings.push(
      "No database SSL is set, defaulting to false. Please set the SQL_SSL_MODE environment variable to suppress this message."
    );
    process.env.SQL_SSL_MODE = "false";
  }

  // Email Service
  if (!process.env.EMAIL_SERVICE) {
    startUpWarnings.push(
      "No email service is set, email functionality will be disabled. Please set the EMAIL_SERVICE environment variable to suppress this message."
    );
  }

  // Email User
  if (!process.env.EMAIL_USER) {
    startUpWarnings.push(
      "No email user is set, email functionality will be disabled. Please set the EMAIL_USER environment variable to suppress this message."
    );
  }

  // Email Password
  if (!process.env.EMAIL_PASSWORD) {
    startUpWarnings.push(
      "No email password is set, email functionality will be disabled. Please set the EMAIL_PASSWORD environment variable to suppress this message."
    );
  }

  // Webserver HTTP Port
  if (!process.env.WEBSRV_PORT) {
    startUpWarnings.push(
      "No webserver HTTP port is set, defaulting to 80. Please set the WEBSRV_PORT environment variable to suppress this message."
    );
    process.env.WEBSRV_PORT = "80";
  }

  // Webserver HTTPS Port
  if (!process.env.WEBSRV_PORTSSL) {
    startUpWarnings.push(
      "No webserver HTTPS port is set, defaulting to 443. Please set the WEBSRV_PORTSSL environment variable to suppress this message."
    );
    process.env.WEBSRV_PORTSSL = "443";
  }

  // Webserver Use SSL
  if (!process.env.WEBSRV_USESSL) {
    startUpWarnings.push(
      "No webserver SSL is set, defaulting to false. Please set the WEBSRV_USESSL environment variable to suppress this message."
    );
    process.env.WEBSRV_USESSL = "false";
  }

  // Google Translation API Key
  if (!process.env.GOOGLE_TRANSLATE_API_KEY) {
    startUpWarnings.push(
      "No Google Translation API key is set, translation functionality will be disabled. Please set the GOOGLE_TRANSLATE_API_KEY environment variable to suppress this message."
    );
  }

  // Websocket URL
  if (!process.env.WEB_SOCKET_URL) {
    startUpErrors.push(
      "No websocket URL is set, aborting... Please set the WEB_SOCKET_URL environment variable to suppress this message."
    );
  }

  // Domain
  if (!process.env.DOMAIN) {
    startUpWarnings.push(
      "No domain is set, skipping hostname check. Please set the DOMAIN environment variable to suppress this message."
    );
  }

  // Session Key
  if (!process.env.SESSION_KEY) {
    startUpWarnings.push(
      "No session key is set, setting to a random value. Please set the SESSION_KEY environment variable to suppress this message."
    );
    process.env.SESSION_KEY = crypto.randomBytes(20).toString("hex");
  }

  // Asset Path
  if (!process.env.ASSET_PATH) {
    startUpWarnings.push(
      "No asset path is set, defaulting to ../../config/assets.json. Please set the ASSET_PATH environment variable to suppress this message."
    );
    process.env.ASSET_PATH = "../../config/assets.json";
  }

  // Game Name
  if (!process.env.GAME_NAME) {
    startUpErrors.push(
      "No game name is set, aborting... Please set the GAME_NAME environment variable to suppress this message."
    );
  }

  // RSA Passphrase
  if (process.env.RSA_PASSPHRASE) {
    startUpWarnings.push(
      "RSA passphrase is set. Do not set this manually. It will be overwritten with a random value. Please remove the RSA_PASSPHRASE environment variable to suppress this message."
    );
  }

  // Generate a random RSA passphrase
  process.env.RSA_PASSPHRASE = crypto.randomBytes(32).toString("hex");

  // Check if there are any warnings
  if (startUpWarnings.length > 0) {
    for (const warning of startUpWarnings) {
      log.warn(warning);
    }
  }

  // Check if there are any errors
  if (startUpErrors.length > 0) {
    for (const error of startUpErrors) {
      log.error(error);
    }
    process.exit(1);
  }
})();
