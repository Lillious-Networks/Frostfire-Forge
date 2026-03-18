import path from "path";
import fs from "fs";
const pwd = process.cwd();
const args = process.argv.slice(2);
const environment_index = args.indexOf("--environment");
const environment = environment_index !== -1 ? args[environment_index + 1]?.toLowerCase() : 'local';

const configPath = path.join(pwd, "src", "config");
if (!fs.existsSync(configPath)) {
  fs.mkdirSync(configPath);
}

const environment_variables = `DATABASE_ENGINE="sqlite"
DATABASE_NAME="frostfire-forge-dev"
WEB_SOCKET_PORT=3000
WEB_SOCKET_USE_SSL=false
GAME_NAME="Frostfire Forge - ${environment.charAt(0).toUpperCase() + environment.slice(1)} Environment"
LOG_LEVEL="info"
CACHE="memory"
GATEWAY_URL="http://gateway:9999"
GATEWAY_AUTH_KEY=""
GATEWAY_GAME_SERVER_SECRET=""
SERVER_ID="server-1"
SERVER_HOST="localhost"
PUBLIC_HOST="localhost"
`;

const production_environment_variables = `DATABASE_ENGINE=""
DATABASE_HOST=""
DATABASE_NAME=""
DATABASE_PASSWORD=""
DATABASE_PORT=""
DATABASE_USER=""
SQL_SSL_MODE=""


GOOGLE_TRANSLATE_API_KEY=""
OPENAI_API_KEY=""
TRANSLATION_SERVICE=""
OPENAI_MODEL=""

WEB_SOCKET_PORT=""
WEB_SOCKET_USE_SSL=""
GAME_NAME=""
LOG_LEVEL="info"

SERVER_ID=""
SERVER_HOST=""
PUBLIC_HOST=""
GATEWAY_URL=""
GATEWAY_AUTH_KEY=""
GATEWAY_GAME_SERVER_SECRET=""

CACHE=""
REDIS_URL=""
`;

const assetConfig = {
  maps: {
    path: "/maps/",
  },
  sfx: {
    path: "/sfx/",
  },
  sprites: {
    path: "/sprites/",
  },
  animations: {
    path: "/animations/",
  },
  icons: {
    path: "/icons/",
  }
};

const settings = {
  "webserverRatelimit": {
    "enabled": true,
    "windowMs": 5,
    "max": 500
  },
  "websocketRatelimit": {
    "enabled": true,
    "maxRequests": 2000,
    "time": 2000,
    "maxWindowTime": 1000
  },
  "websocket": {
    "maxPayloadMB": 50,
    "benchmarkenabled": false,
    "idleTimeout": 120,
    "maxConnections": 50000
  },
  "world": "overworld",
  "default_map": "overworld.json"
};

if (!fs.existsSync(path.join(".env.local")) && environment === "local") {
  console.info("Creating .env.local file for local environment...");
  fs.writeFileSync(path.join(".env.local"), environment_variables);
}

if (!fs.existsSync(path.join(".env.development")) && environment === "development") {
  console.info("Creating .env.development file for development environment...");
  fs.writeFileSync(path.join(".env.development"), environment_variables);
}

if (!fs.existsSync(path.join(".env.production")) && environment === "production") {
  console.info("Creating .env.production file for production environment...");
  fs.writeFileSync(path.join(".env.production"), production_environment_variables);
}

if (!fs.existsSync(path.join(configPath, "assets.json"))) {
  fs.writeFileSync(
    path.join(configPath, "assets.json"),
    JSON.stringify(assetConfig, null, 2)
  );
  console.log(`Created assets config file at ${path.join(configPath, "assets.json")}`);
} else {
  console.log(`Assets config file loaded from ${path.join(configPath, "assets.json")}`);
}

if (!fs.existsSync(path.join(configPath, "settings.json"))) {
  fs.writeFileSync(
    path.join(configPath, "settings.json"),
    JSON.stringify(settings, null, 2)
  );
  console.log(`Created settings file at ${path.join(configPath, "settings.json")}`);
} else {
  console.log(`Settings loaded from ${path.join(configPath, "settings.json")}`);
}

const AOI_CONFIG = {
  DEFAULT_RADIUS: 1000,
  UPDATE_THRESHOLD: 100,
  GRID_CELL_SIZE: 512,
  USE_SPATIAL_GRID: false,
  SPATIAL_GRID_THRESHOLD: 50,
  MAX_PLAYERS_PER_LAYER: 50,
  DEBUG: false
};

if (!fs.existsSync(path.join(configPath, "aoi.json"))) {
  fs.writeFileSync(
    path.join(configPath, "aoi.json"),
    JSON.stringify(AOI_CONFIG, null, 2)
  );
  console.log(`Created AOI config file at ${path.join(configPath, "aoi.json")}`);
} else {
  console.log(`AOI config loaded from ${path.join(configPath, "aoi.json")}`);
}

const security_definitions = `# Security Definitions
.env
ajax.js
drupal.js
jquery.js
jquery.once.js
drupal.js
drupalSettingsLoader.js
l10n.js
drupal.js
view-source
wlwmanifest.xml
credentials
.aws
wp-admin
shell
wget
curl
showLogin.cc
get_targets
bablosoft
console
Autodiscover.xml
execute-solution
mt-xmlrpc.cgi
php
`

if (!fs.existsSync(path.join(configPath, "security.cfg"))) {
  fs.writeFileSync(
    path.join(configPath, "security.cfg"),
    security_definitions
  );
  console.log(`Created security definitions file at ${path.join(configPath, "security.cfg")}`);
} else {
  console.log(`Security definitions loaded from ${path.join(configPath, "security.cfg")}`);
}