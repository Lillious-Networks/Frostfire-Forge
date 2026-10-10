<p align="center">
  <img src="../../blob/main/logo.png?raw=true">
</p>

<h1 align="center">🧊🔥 Frostfire Forge 🔥🧊</h1>

<p align="center">
  <strong>A Modern 2D MMO Game Engine Platform</strong>
</p>

<p align="center">
Frostfire Forge is an upcoming 2D MMO engine platform designed to empower developers and hobbyists alike to bring their dream games and worlds to life. Built with cutting-edge technology, it offers a highly secure and optimized foundation for MMO development. With a focus on simplicity and performance, Frostfire Forge makes creating your own multiplayer universe easier than ever.
</p>
<p align="center">
  <img src="https://img.shields.io/github/actions/workflow/status/Lillious-Networks/Frostfire-Forge/release.yml?branch=main&label=Docker&style=flat-square" alt="Docker">
  <img src="https://img.shields.io/badge/status-Beta-blue?style=flat-square&label=Status" alt="Beta">
  <img src="https://img.shields.io/github/stars/Lillious-Networks/Frostfire-Forge?style=flat-square&label=Stars&color=tomato" alt="GitHub Stars">
</p>

---

> [!NOTE]
> **Core Development Team**: [Lillious](https://github.com/Lillious), [Deph0](https://github.com/Deph0)
>
> **Community**: [Join our Discord](https://discord.gg/4spUbuXBvZ)

---

> [!NOTE]
> Teaser

<p align="center">
  <img src="../../blob/main/src/assets/teaser/teaser.png?raw=true">
</p>

## 📋 Table of Contents

- [Requirements](#-requirements)
- [Architecture](#-architecture)
  - [Gateway (Authentication & Reverse Proxy)](#gateway-authentication--reverse-proxy)
  - [Asset Server (Media & Resources)](#asset-server-media--resources)
- [Environment Variables](#-environment-variables)
- [Weather](#weather)
  - [How a Weather Is Drawn](#how-a-weather-is-drawn)
  - [Real Weather](#real-weather)
- [Realm Whitelist Configuration](#️-realm-whitelist-configuration)
- [Quick Start](#-quick-start)
  - [Development Setup](#development-setup)
  - [Production Setup](#production-setup)
- [Commands Reference](#-commands-reference)
  - [Admin Commands](#admin-commands)
  - [Player Commands](#player-commands)
- [Benchmarking](#-benchmarking)
- [Spell Creation Guide](#spell-creation-guide)
- [Quest System Guide](#quest-system-guide)
- [API Documentation](#-api-documentation)
  - [Plugin System](#plugin-system)
  - [Listener Events](#listener-events)
  - [Packet Types](#packet-types)
  - [Caching](#caching)
  - [Events](#events)

---

## 🔧 Requirements

> [!IMPORTANT]
> **Required Software**:
> - [Bun](https://bun.sh/) - JavaScript runtime & package manager
> - [MySQL](https://www.mysql.com/downloads/) - Database
> - [Frostfire Forge Gateway](https://github.com/Lillious-Networks/Frostfire-Forge-Gateway) - Authentication and reverse proxy gateway (required for all deployments)
> - [Frostfire Forge Assets](https://github.com/Lillious-Networks/Frostfire-Forge-Assets) - Asset server for map data, sprites, and resources (required for all deployments)
> - [Docker](https://www.docker.com/) (Optional) - For containerized deployment

---

## 🏗️ Architecture

### Gateway (Authentication & Reverse Proxy)

Frostfire Forge requires the [Frostfire Forge Gateway](https://github.com/Lillious-Networks/Frostfire-Forge-Gateway) for all deployments. The gateway handles centralized user authentication, game server registration and management, automatic failover, and request routing to game servers.

#### Setup

> [!IMPORTANT]
> The gateway's `bun setup` must run **before** the engine's `bun setup`.

Game servers automatically register with the gateway on startup using the `GATEWAY_URL`, `GATEWAY_AUTH_KEY`, and `GATEWAY_GAME_SERVER_SECRET` environment variables. The server will continuously poll until the gateway is available.

---

### Asset Server (Media & Resources)

Frostfire Forge requires the [Frostfire Forge Assets](https://github.com/Lillious-Networks/Frostfire-Forge-Assets) server for all deployments. The asset server manages and distributes critical game data including:

- **Map Data** - Tile maps, collision layers, spawn points, and warps
- **World Maps** - Large worlds (up to 10240 x 10240 tiles) kept as a `.world` directory next to the `.json` maps and served in chunks like any other map. The game server syncs only a world's manifest and its collision and no-PvP data
- **Sprites & Animations** - Character sprites, item graphics, and animation frames
- **Game Resources** - Particle effects, NPC data, quest data, items, spells, and mounts
- **Dynamic Updates** - Real-time map updates from the tile editor for collaborative world building

The asset server provides a centralized repository for all game assets, enabling the game engine to fetch required data on-demand and persist editor changes back to permanent storage.

#### Setup

> [!IMPORTANT]
> The asset server must be running **before** starting the engine in order to syncronize maps.

The game server connects to the asset server using the `ASSET_SERVER_URL` and `ASSET_SERVER_AUTH_KEY` environment variables.

---

## ⚙️ Environment Variables

```bash
DATABASE_ENGINE="mysql"
DATABASE_HOST="your_db_host"
DATABASE_NAME="your_db_name"
DATABASE_PASSWORD="your_db_password"
DATABASE_PORT="3306"
DATABASE_USER="your_db_user"
SQL_SSL_MODE="DISABLED"                    # Set to "ENABLED" to require TLS for the database connection

# Translation Services
GOOGLE_TRANSLATE_API_KEY="your_google_api_key"
OPENAI_API_KEY="your_openai_api_key"
TRANSLATION_SERVICE="google_translate"      # Set to "openai" to use OpenAI translation
OPENAI_MODEL="gpt-4.1-nano-2025-04-14"

# Security (Optional)
SESSION_KEY="your_session_secret_key"          # Session encryption key
RSA_PASSPHRASE="your_rsa_passphrase"           # Passphrase for the chat encryption key

# Application Settings
WEBSRV_PORT="8081"                          # Plain HTTP port (HTTP->HTTPS redirect when SSL is enabled)
WEBSRV_PORTSSL="3000"                       # Public port - TCP (HTTP API via edge proxy) + UDP (WebTransport) share this port
WEBSRV_INTERNAL_PORT="3002"                 # Internal plain-HTTP API port (127.0.0.1, behind the edge proxy)
HTTP_USE_SSL="true"                         # Set to "false" to disable TLS for the public HTTP listener
WEBSRV_HTTP1="true"                         # "false" disables HTTP/1.1 on the HTTP listeners
WEBSRV_HTTP2="true"                         # "false" disables HTTP/2 on the HTTP listeners
WEBSRV_HTTP3="false"                        # HTTP/3 is force-disabled for the game server (WebTransport owns the UDP port)
TLS_CERT_PATH="./src/certs/cert.pem"        # TLS certificate (shared by HTTP + WebTransport)
TLS_KEY_PATH="./src/certs/key.pem"
TLS_CA_PATH="./src/certs/cert.ca-bundle"
GAME_NAME="Your Game Name"
LOG_LEVEL="info"                          # Logging level: trace, debug, info, warn, error

# Local certificate handling (Optional)
SKIP_CERT_TRUST="false"                      # Set to "true" to skip Windows certificate trust
TLS_INSECURE_SKIP_VERIFY="true"              # Set to "false" to require verification against the configured certificate

# CORS Configuration (Security)
CORS_ALLOWED_ORIGINS="https://game.example.com,https://client.example.com" # Comma-separated list of allowed origins

# Gateway (Required)
GATEWAY_URL="http://gateway:9999"               # Gateway registration endpoint
GATEWAY_AUTH_KEY="your_secret_key"              # Shared secret for server registration
GATEWAY_GAME_SERVER_SECRET="another_secret_key" # Game server authentication token
SERVER_HOST="game-server-hostname"              # Internal server hostname
PUBLIC_HOST="yourdomain.com"                    # External hostname for clients
SERVER_ID="server-1"                            # Game server identification
SERVER_DESCRIPTION="The server description"     # Game server description

# Asset Server (Required)
ASSET_SERVER_URL="http://assets:8000"           # Asset server endpoint
ASSET_SERVER_AUTH_KEY="your_secret_key"         # Asset server authentication token

# Cache Configuration
CACHE="memory"                              # Set to "redis" to use Redis
REDIS_URL="redis://localhost:6379"

# Worker Pools (Optional)
DB_WORKER_POOL_SIZE="8"                      # SQL worker threads (default: 8)
AUTH_POOL_SIZE="8"                           # Authentication worker threads (default: 8)

# Benchmarking (Optional)
WT_HANDSHAKE_RATE_LIMIT_DISABLED="false"     # Set to "true" to disable WebTransport handshake rate limits

# Realm Configuration
WHITELIST="false"                             # Set to "true" to enable the username whitelist

# Real weather (Optional)
WEATHER_API_KEY=""                            # OpenWeatherMap API key; empty turns real weather off
WEATHER_API_LOCATION=""                       # "lat,lon" (47.61,-122.33) or a city and its country (Seattle,US)
WEATHER_API_MINUTES="10"                      # Minutes between readings (default: 10)
```

---

## Weather

A world's weather is the name of a row of the `weather` table, or one of three words of `/weather`: `clear`, `random` (another weather every 30 minutes) or `weather_api` (the real weather, below). Weathers are created and edited live with the [Weather Editor](#admin-commands) and given to a world with `/weather`.

A map with no entry in the `worlds` table (the inside of a house, for one) is clear and has no day and night cycle: it is never darkened, and its shadows and time-driven particles see a standing midday.

### How a Weather Is Drawn

The client picks what it draws by the weather's name, and the row's values shape it:

| Name | Drawn |
|------|-------|
| `rainy` | Rain, with splashes where it lands |
| `thunderstorm` | Rain, lightning strikes and a darkened scene (by as much as `ambience` says) |
| `snowy` | Snow, which melts where it lands |
| `darkness` | A near-black scene with no sun and no shadows (by as much as `ambience` says) |
| `clear`, any other name | No rain, snow or darkening: only its wind |

- **Precipitation** (0 to 100) is how much rain or snow falls. 80 is the seeded thunderstorm, and a weather named for rain or snow never falls less than a drizzle.
- **Temperature** is in degrees Fahrenheit. Below 32, rain falls as snow.
- **Wind speed** and **wind direction** (`none`, `left`, `right`, `up`, `down`) draw white wind streaks across the screen, more and faster as the wind rises, with gusts. Wind to the left or right also slants rain and snow and pushes particles that are affected by weather. Streaks need a direction and a speed above 0.

`bun setup` seeds `clear`, `thunderstorm`, `darkness`, `rainy` and `snowy`.

### Real Weather

A world set to `weather_api` follows the weather of a real place. With `WEATHER_API_KEY` (a free key from [OpenWeatherMap](https://openweathermap.org/api), "Current Weather Data") and `WEATHER_API_LOCATION` set, the server reads that place's weather at startup and every `WEATHER_API_MINUTES`, and holds the temperature (Fahrenheit), humidity, wind speed (mph), wind direction, precipitation (0 to 100) and ambience in memory. `weather_api` is a word of `/weather`, like `clear` and `random`: it is not a row of the weather table and nothing is written to the database.

Give it to a world with `/weather weather_api`. Every world on it shows the same reading, and players there see the change as soon as a reading differs: rain as heavy as the precipitation, snow when it snows or when the temperature is below 32, lightning in a thunderstorm, and wind from the real direction. Without a key it is a still, clear day.

The time of day follows the same place: each reading carries the place's shift from UTC (daylight saving included), and every player sees that place's clock, on every world. Without a key or a place, each player's own clock is used.

---

## 🛡️ Realm Whitelist Configuration

### Overview

The whitelist feature restricts user access to a specific realm to only approved usernames. When enabled, any user attempting to authenticate with a username not in the whitelist will be disconnected with the message "Username not whitelisted on this realm".

### Setup Instructions

**1. Enable the whitelist for the realm:**

Set the environment variable in your `.env` file to have the realm start with its whitelist on:
```bash
WHITELIST=true
```

Or turn it on and off while the server runs, with `/whitelist on` and `/whitelist off` or the switch on the Server page of the control panel. A switch made this way lasts until the server restarts, when `WHITELIST` decides again. Turning it on adds you to the list and checks new logins only: players already online stay.

**2. Run the whitelist command**

Run the whitelist command found in the [Admin Commands](#admin-commands) section to add or remove from the whitelist. Usernames can only be added or removed while the whitelist is on.

**Realm Status in Gateway:**

The realm will display a "whitelist" badge in the realm selection UI while its whitelist is on (`WHITELIST=true`, or turned on with `/whitelist on`), allowing players to see which realms have restricted access.

---

## 🚀 Quick Start

### Development Setup

**Option 1: Use prebuilt Docker image:**
```bash
docker run -d --name frostfire-forge-dev -p 3000:3000 -p 3000:3000/udp --ulimit nofile=1048576:1048576 ghcr.io/lillious-networks/frostfire-forge-dev:latest
```

**Option 2: Build and run from source:**
```bash
bun development
```

**Optional: Update `.env.development` before running**

**Create your admin account**

Setup creates no accounts. Make the first admin from the [Gateway](https://github.com/Lillious-Networks/Frostfire-Forge-Gateway) repository, then open the link it prints to set the password:
```bash
bun create-admin-development <username> <email>
```

> [!NOTE]
> **Local WebTransport certificates**: when `TLS_CERT_PATH`/`TLS_KEY_PATH` are set but no certificate exists (or the existing one is expired/unsuitable), the server generates a pin-suitable local certificate (ECDSA P-256, 14-day validity) at those paths automatically at startup. You can also generate one manually with `bun generate-local-cert`. If the variables are not set, the server does not fall back to any default paths - WebTransport requires an explicit certificate.

---

### Production Setup

**Update the `.env.production` file**

Configure your production environment variables.

**Start the production server:**
```bash
bun production
```

**Optional: Run setup separately**

If you prefer to set up the database manually before starting the server:
```bash
bun setup-production
```

---

## 📜 Commands Reference

### Admin Commands

<details>
<summary><strong>Disconnect Player</strong></summary>

```bash
/kick [username | id]
```
- **Aliases**: `disconnect`
- **Permission**: `admin.kick` | `admin.*`
</details>

<details>
<summary><strong>Warp</strong></summary>

```bash
/warp [map]
```
- **Permission**: `admin.warp` | `admin.*`
</details>

<details>
<summary><strong>Change Weather</strong></summary>

```bash
/weather [weather_name | clear | random | weather_api]
```
- **Permission**: `admin.weather` | `admin.*`
- Changes the current world's weather. Valid values are any weather name from the `weather` database table, `clear` for clear weather, `random` to cycle through all available weather types every 30 minutes, or `weather_api` to follow the real weather (see [Real Weather](#real-weather)).
</details>

<details>
<summary><strong>Reload Map</strong></summary>

```bash
/reloadmap [map]
```
- **Permission**: `admin.reloadmap` | `admin.*`
</details>

<details>
<summary><strong>Ban Player</strong></summary>

```bash
/ban [username | id]
```
- **Permission**: `admin.ban` | `admin.*`
</details>

<details>
<summary><strong>Unban Player</strong></summary>

```bash
/unban [username | id]
```
- **Permission**: `admin.unban` | `admin.*`
</details>

<details>
<summary><strong>Mute Player</strong></summary>

```bash
/mute [username] [duration?] [reason?]
```
- **Duration**: a number and a unit, such as `30m`, `2h` or `7d`. Left out (or `permanent`), the mute lasts until it is lifted
- **Permission**: `admin.mute` | `admin.*`
- **Description**: The player still sees their own say, whisper, party and guild messages, and is not told. Nobody else receives them
</details>

<details>
<summary><strong>Unmute Player</strong></summary>

```bash
/unmute [username]
```
- **Permission**: `admin.unmute` | `admin.*`
</details>

<details>
<summary><strong>Player Reports</strong></summary>

```bash
/reports
/reports view [number]
/reports resolve [number] [note?]
```
- **Permission**: `admin.reports` | `admin.*`
- **Description**: List the open reports players have sent, show one with the chat lines attached, or close one with a note. Admins online with the permission are told when a report arrives
</details>

<details>
<summary><strong>Player Trades</strong></summary>

```bash
/trades [username]
```
- **Permission**: `admin.trades` | `admin.*`
- **Description**: List the latest trades a player completed: who each was with, when, what they gave and what they got. Players trade from the right-click menu on another player; every completed trade is written to the `trade_log` table
</details>

<details>
<summary><strong>Send Message to Players</strong></summary>

```bash
/notify [audience?] [message]
```
- **Audience**: `all` (default) | `map` | `admins`
- **Aliases**: `notify`
- **Permission**: `server.notify` | `server.*`
</details>

<details>
<summary><strong>Toggle Admin Status</strong></summary>

```bash
/admin [username | id]
```
- **Aliases**: `setadmin`
- **Permission**: `server.admin` | `server.*`
</details>

<details>
<summary><strong>Server Shutdown</strong></summary>

```bash
/shutdown
```
- **Permission**: `server.shutdown` | `server.*`
- Warns everyone, disconnects them after 5 seconds, then stops the server process. A supervisor that restarts on any exit (the Docker compose files use `restart: always`) starts it again.
</details>

<details>
<summary><strong>Server Restart (Scheduled: 15 minutes)</strong></summary>

```bash
/restart
```
- **Permission**: `server.restart`
- Run it again to cancel the countdown. When it ends, everyone is disconnected and the server process exits: it is started again by its supervisor (the Docker compose files use `restart: always`). Started by hand with `bun production`, it stays down.
</details>

<details>
<summary><strong>Respawn Player</strong></summary>

```bash
/respawn [username | id]
```
- **Permission**: `admin.respawn` | `admin.*`
</details>

<details>
<summary><strong>Revive Player</strong></summary>

```bash
/revive [username | id]
```
- **Permission**: `admin.revive` | `admin.*`
- Revives a dead or ghost player in place at full health. Omitting the username revives yourself. Only works on online targets that are actually dead.
</details>

<details>
<summary><strong>Reset Cooldowns</strong></summary>

```bash
/cooldowns [username | id]
```
- **Alias**: `/resetcooldowns`
- **Permission**: `admin.cooldowns` | `admin.*`
- Ends every cooldown an online player is waiting on: spells, the spell lockout after an interrupt, the cooldown consumables share and the home item's hour. Omitting the username resets your own.
</details>

<details>
<summary><strong>Kill Player</strong></summary>

```bash
/kill [username | id]
```
- **Permission**: `admin.kill` | `admin.*`
- Kills an online player through the normal death flow (skeleton, corpse, Release Spirit popup). Omitting the username kills yourself. Fails if the target is already dead or a ghost.
</details>

<details>
<summary><strong>Summon Player</strong></summary>

```bash
/summon [username | id]
```
- **Permission**: `admin.summon` | `admin.*` | `admin.summonadmins`
</details>

<details>
<summary><strong>Give Item</strong></summary>

```bash
/give [username] [item_name] [amount?]
```
- **Permission**: `admin.items` | `admin.*`
- Grants an item to a player. Amount defaults to 1.
</details>

<details>
<summary><strong>Drop Item</strong></summary>

```bash
/drop [item_name] [amount?]
```
- **Permission**: `admin.items` | `admin.*`
- Spawns a loot drop at your feet with no owner, so any player can pick it up. Amount defaults to 1, capped at 9,999.
</details>

<details>
<summary><strong>Update Player Permissions</strong></summary>

```bash
/permission [mode] [username | id] [permissions?]
```
- **Aliases**: `permissions`
- **Permission**: `admin.permission` | `admin.*`

**Modes**:
- `add` - Permission: `permission.add` | `permission.*`
- `remove` - Permission: `permission.remove` | `permission.*`
- `set` - Permission: `permission.add` | `permission.*`
- `clear` - Permission: `permission.remove` | `permission.*`
- `list` - Permission: `permission.list` | `permission.*`

`add` and `set` only work on a player who is an admin. `remove`, `clear` and `list` work on anyone, so what a former admin still holds can be taken away. `add` and `remove` take one permission or a comma-separated list.
</details>

<details>
<summary><strong>Tile Editor</strong></summary>

```bash
/tileeditor
```
- **Aliases**: `te`
- **Permission**: `tools.tile_editor` | `tools.*`

</details>

<details>
<summary><strong>NPC Editor</strong></summary>

```bash
/npceditor
```
- **Aliases**: `ne`
- **Permission**: `tools.npc_editor` | `tools.*`

Creates and edits NPCs: name, dialog, scripts, particles, placement, and the same sprite appearance pickers as the creature editor. The **Quest giver** flag allows quests to be linked through the **Quests Given** / **Quests Ended** pickers. The **gossip chain** (one line per step) plays in the overhead speech bubble on chat-like timing when spoken to, and supports `${player.*}` placeholders (see Quest System Guide).

</details>

<details>
<summary><strong>Particle Editor</strong></summary>

```bash
/particleeditor
```
- **Aliases**: `pe`
- **Permission**: `tools.particle_editor` | `tools.*`

</details>

<details>
<summary><strong>Creature Editor</strong></summary>

```bash
/creatureeditor
```
- **Aliases**: `ce`
- **Permission**: `tools.creature_editor` | `tools.*`

Edits creature templates, abilities, spawns, patrol paths, link groups and spawn pools, with in-world spawn placement, patrol drawing and a debug overlay (aggro/leash radii, live threat table). Existing legacy entities can be converted with `bun migrate-entities` (add `--dry-run` to preview, `--drop-legacy` to drop the old tables afterwards).

</details>

<details>
<summary><strong>Item Editor</strong></summary>

```bash
/itemeditor
```
- **Aliases**: `ie`
- **Permission**: `tools.item_editor` | `tools.*`

Creates and edits items: name, type, quality, icon, description, equipment slot, level requirement, bag slots and every stat. Weapons also carry `damage_min`, `damage_max` and `attack_speed_ms`, which drive melee auto-attack damage and swing timing. A weapon with no damage range falls back to its flat damage stat.

</details>

<details>
<summary><strong>Spell Editor</strong></summary>

```bash
/spelleditor
```
- **Aliases**: `se`
- **Permission**: `tools.spell_editor` | `tools.*`

Creates and edits spells: name, icon, description, damage, mana cost, range, cast time, cooldown, particles, area and ground targeting, charge and teleport, and the effects a spell applies (each effect type with only the fields it uses). A saved spell works at once, without a restart. Spells registered by plugins are shown read-only.

</details>

<details>
<summary><strong>Weather Editor</strong></summary>

```bash
/weathereditor
```
- **Aliases**: `we`
- **Permission**: `tools.weather_editor` | `tools.*`

Creates, edits and deletes the rows of the `weather` table: name, wind speed and direction, ambience, temperature, humidity and precipitation. A saved weather is shown at once to the players of every world that shows it, including a world on `random` that settled on it. The client picks what it draws by the weather's name (see [How a Weather Is Drawn](#how-a-weather-is-drawn)), so a name is fixed once saved; a weather of any other name only carries its wind. `clear` cannot be deleted. Deleting a weather sets every world that uses it to `clear`. `random`, `none` and `weather_api` are words of `/weather` and cannot be used as a weather's name.

</details>

<details>
<summary><strong>Quest Editor</strong></summary>

```bash
/questeditor
```
- **Aliases**: `qe`
- **Permission**: `tools.quest_editor` | `tools.*`

Creates and edits quests: offer/progress/completion text, level and prerequisites, chains, kill/collect/talk/explore objectives, guaranteed and choice-of-one rewards, repeatable and daily flags, and the NPCs that give and end each quest.

</details>

<details>
<summary><strong>Player Editor</strong></summary>

```bash
/player edit [username | id]
```
- **Permission**: `server.admin` | `server.*`

Opens the player editor on one player, online or offline; admins also get **Edit Player Attributes** when right-clicking a player. `id` is the connection id of an online player (as the other commands take) or an account id. The editor changes stats, currency, location, inventory, equipment, mounts, spells, friends, guild, party, quest log, permissions and the admin role; an online player's client is updated as each change is made. Changing permissions also needs `permission.add` / `permission.remove` (or `permission.*`), as `/permission` does.

</details>

<details>
<summary><strong>Control Panel</strong></summary>

```bash
/controlpanel
```
- **Aliases**: `cp`
- **Permission**: admin role

Opens the server control panel in its own window: a dashboard with a page for each kind of work (Dashboard, Players, Communication, Server, World, Items & Loot). The Dashboard charts players online, server lag and memory over the last hour, 6 hours or 24 hours, breaks the online players down by map, level and role, and lists what admins last did through the panel. That history is kept in memory only (a reading every 15 seconds for the last hour, one a minute for the last 24 hours, the last 100 actions) and starts again when the server restarts. Players is a table of everyone online, with a search over every account, and a side panel for the player picked.

The panel has a control for every admin command above; the editors are opened with their own commands. Each control runs the command it stands for under that command's own permission, so the panel gives nobody a power the commands would refuse; what cannot be taken back (kick, ban, kill, the admin role, permissions, restart, shutdown, deleting a loot table) asks for confirmation first.

</details>

<details>
<summary><strong>Manage Whitelist</strong></summary>

```bash
/whitelist [mode] [username]
```
- **Permission**: `admin.whitelist` | `admin.*`

**Modes**:
- `on` - Turn the whitelist on without a restart. The usernames are loaded from the database, you are added to the list, and new logins are checked; players already online stay
- `off` - Turn the whitelist off without a restart
- `add` - Add a player to the whitelist (while it is on)
- `remove` - Remove a player from the whitelist (while it is on)

`on` and `off` last until the server restarts: `WHITELIST` in the environment decides how it starts. The same switch is on the Server page of the control panel.
</details>

---

### Player Commands

<details>
<summary><strong>Whisper</strong></summary>

```bash
/whisper [username] [message]
```
- **Aliases**: `w`
</details>

<details>
<summary><strong>Party Chat</strong></summary>

```bash
/party [message]
```
- **Aliases**: `p`
- **Requirement**: Must be in a party
- **Description**: Send a message to all party members
</details>

<details>
<summary><strong>Local Chat</strong></summary>

```bash
/say [message]
```
- **Aliases**: `s`
- **Description**: Send a message to local players
</details>

<details>
<summary><strong>Ignore</strong></summary>

```bash
/ignore [username]
/unignore [username]
/ignorelist
```
- **Description**: Stop receiving a player's chat, whispers, invitations and friend requests. They are not told. Ignoring a friend ends the friendship
- **Limits**: Up to 100 players. Admins cannot be ignored, and admins cannot ignore players
</details>

<details>
<summary><strong>Report Player</strong></summary>

```bash
/report [username] [reason]
```
- **Description**: Send a report to the admins, with the player's recent chat lines that reached you. They are not told
- **Limits**: One open report per player, five reports an hour
</details>

---

## 📊 Benchmarking

The engine ships load-testing tools that connect real WebTransport clients (guest accounts) to your game server.

### Concurrent Client Load Test

```bash
bun benchmark 500 --rate 20 --duration 120
```

- `[clients]` - number of concurrent clients (positional)
- `--rate` - connection ramp rate per second (default: 3)
- `--duration` - test duration in seconds (default: 60)
- `--host`, `--wt`, `--gateway`, `--gateway-url`, `--realm` - target selection options
- `bun benchmark:development` / `bun benchmark:production` run against the matching env file

### Daily Activity Curve Simulation

```bash
bun benchmark 2000 --simulation
```

Runs a 5-minute simulation of a realistic daily login curve (early-morning ramp, lunch peak, evening decline, late-night tail) scaled to the given peak client count. The simulation includes continuous login/logout churn, realistic player behavior (idle/AFK, wandering, returning to spawn hubs), a low-rate packet mix (targeting, inspecting, chat, mounting), and 1-5 minute player sessions ending in clean logouts or abrupt disconnects. Use `--duration` to change the span (curve stretches to fit).

### Connection Hold Test

```bash
bun benchmark:connections 1000
```

Opens and holds the given number of WebTransport connections to measure handshake throughput and connection stability.

---

## Spell Creation Guide

Spells are stored in the `spells` database table. Each row defines a spell with its stats, visuals, and effects. The game server loads all spells from the database into memory at startup, and the `effects` column contains a JSON array that defines what the spell actually does when cast.

### Spell Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Unique spell identifier, used to reference the spell everywhere |
| `damage` | number | Base damage dealt on hit, rolled with the caster's level (+2 to +5 per level past 1) plus their damage stat. Use negative numbers for healing spells: a heal restores the same level roll plus (cast time / 3.5s) of the caster's damage stat (instant casts count as 1.5s), crits for 150%, and ignores armor and avoidance, as in classic WoW |
| `mana` | number | Mana cost as a percentage of the caster's base stamina (from level alone, not gear), as in WoW |
| `range` | number | Maximum cast distance in pixels |
| `type` | string | Spell category label. Currently only `"spell"` is supported. |
| `cast_time` | number | How long the cast bar takes in seconds (0 = instant) |
| `cooldown` | number | Seconds before the spell can be cast again |
| `can_move` | number | `1` = can cast while walking, `0` = must stand still |
| `description` | string | Tooltip text shown in the spellbook |
| `icon` | string | Icon filename served by the asset server |
| `sprite` | string | (Optional) Sprite name for the casting visual |
| `particles` | string | (Optional) Comma-separated particle names for the projectile or cast visual |
| `effects` | JSON array | (Optional) The spell's effects - see Effects Format below |
| `aoe_radius` | number | (Optional) Splash radius in pixels around the target |
| `ground_aoe` | number | (Optional) Set to `1` for ground-targeted area spells |
| `ground_duration` | number | (Optional) How long a ground AoE zone stays active in seconds |
| `is_thrown` | number | (Optional) Set to `1` for thrown projectiles that arc through the air |
| `charge_distance` | number | (Optional) Distance the caster dashes toward the target before casting |
| `teleport_behind` | number | (Optional) Set to `1` to blink behind the target before casting |

### Effects Format

The `effects` column holds a JSON array of effect objects. Each effect has a `type` that determines what happens. Note: effect `type` values (`"stun"`, `"slow"`, etc.) are separate from the spell's own `type` field, which is a category label.

```json
[
  { "type": "damage_over_time", "value": 4, "duration": 12, "interval": 3, "stackable": true, "max_stacks": 5 }
]
```

**Common fields for all effects:**

| Field | Description |
|-------|-------------|
| `type` | The effect type (see table below) |
| `value` | Effect strength: damage per tick, slow percentage, absorb amount, etc. |
| `duration` | How long the effect lasts in seconds. `0` or omitted = instant or permanent (depending on type) |
| `interval` | Tick rate in seconds for periodic effects like DoTs and HoTs |
| `stackable` | Whether re-casting the same spell adds stacks instead of just refreshing |
| `max_stacks` | Maximum number of stacks if stackable (defaults to 5) |
| `target_particles` | Comma-separated particle names shown on the affected target |

### Effect Types

<details>
<summary><strong>damage_over_time</strong></summary>

Deals `value` damage to the target every `interval` seconds for the full `duration`. Set `stackable` to allow multiple applications to stack up to `max_stacks`.

```json
{ "type": "damage_over_time", "value": 4, "duration": 12, "interval": 3, "stackable": true, "max_stacks": 5 }
```

This deals 4 damage every 3 seconds for 12 seconds (4 ticks total), stacking up to 5 times.

As in classic WoW, each tick also gets a share of the caster's damage stat, fixed when the effect lands: the stat × (`duration` / 15s, capped at 1), split evenly across the ticks. With 50 damage stat, the example above adds 50 × 12/15 = 40 over its 4 ticks, so 14 per tick. `heal_over_time` works the same way.
</details>

<details>
<summary><strong>heal_over_time</strong></summary>

Works exactly like `damage_over_time` but restores health. The `value` is automatically treated as healing. Same `interval`, `duration`, `stackable`, and `max_stacks` rules apply.

```json
{ "type": "heal_over_time", "value": 5, "duration": 10, "interval": 2 }
```

This restores 5 health every 2 seconds for 10 seconds (5 ticks total).
</details>

<details>
<summary><strong>absorbtion</strong></summary>

Creates a damage-absorbing barrier on the target. The barrier absorbs up to `value` damage before breaking, and lasts for `duration` seconds. Multiple barriers from different spells stack; casting the same spell again refreshes the shield's strength and timer.

```json
{ "type": "absorbtion", "value": 50, "duration": 8 }
```

This creates a shield that absorbs up to 50 damage for 8 seconds.
</details>

<details>
<summary><strong>stun</strong></summary>

Prevents the target from moving or casting spells for `duration` seconds. Multiple stuns stack - the longest stun takes priority. When a stun ends, the next longest active stun (if any) continues.

```json
{ "type": "stun", "value": 0, "duration": 3 }
```

This stuns the target for 3 seconds. The `value` field is ignored.
</details>

<details>
<summary><strong>slow</strong></summary>

Reduces the target's movement speed by `value` percent for `duration` seconds. `value` should be between 1 and 99. If multiple slows are active, only the strongest one applies.

```json
{ "type": "slow", "value": 50, "duration": 5 }
```

This cuts the target's movement speed in half for 5 seconds.
</details>

<details>
<summary><strong>vanish</strong></summary>

Makes the target invisible to all players except admins and party members. Lasts for `duration` seconds; if `duration` is `0` or omitted, the effect is permanent until cancelled. Taking damage or casting a hostile spell breaks vanish.

```json
{ "type": "vanish", "value": 0, "duration": 0 }
```

This makes the caster invisible permanently (until broken).
</details>

<details>
<summary><strong>interrupt</strong></summary>

Cancels the target's current spell cast and prevents them from casting anything for `duration` seconds. Only works if the target is actively casting a spell that allows interruption.

```json
{ "type": "interrupt", "value": 0, "duration": 3 }
```

This stops the target's cast and locks their spells for 3 seconds.
</details>

<details>
<summary><strong>visual</strong></summary>

Purely cosmetic - plays `target_particles` on the target for `duration` seconds. No gameplay effect.

```json
{ "type": "visual", "value": 0, "duration": 5, "target_particles": "frost_particles" }
```

This shows frost particles on the target for 5 seconds with no other effect.
</details>

### Multiple Effects

A single spell can have multiple effects. They all apply at the same time when the spell hits.

```json
[
  { "type": "damage_over_time", "value": 3, "duration": 9, "interval": 3 },
  { "type": "slow", "value": 30, "duration": 4 }
]
```

This spell poisons the target and slows them, both applied on the same hit.

### How Spell Casting Works

1. The caster selects a target and presses the spell hotkey.
2. Cooldown, mana, range, and stun checks run first. If any fail, the cast does not start.
3. A cast bar appears for the duration of `cast_time`. If `can_move` is `0`, moving during this time cancels the cast and refunds the cooldown. Pressing escape also cancels the cast and refunds the cooldown.
4. When the cast completes, a projectile flies from caster to target. If the target is very close the projectile arrives almost immediately.
5. Base damage is calculated, then modified by level, critical chance, avoidance, and armor.
6. Active barriers on the target absorb damage first, then remaining damage hits health.
7. All effects in the `effects` array are then applied to the target.
8. If `aoe_radius` is set, the damage and effects also apply to everyone within that radius around the primary target.
9. The cooldown and mana cost are consumed.

**Ground AoE spells** work the same way, except the caster clicks a location on the map instead of targeting a player. If `ground_duration` is set, the zone persists and ticks on anyone inside it. If `is_thrown` is set, the projectile arcs toward the ground position before the zone appears.

**Charge spells** and **teleport-behind spells** move the caster instantly to a position near the target before applying effects. They have no cast time and no projectile.

### Adding a New Spell

Spells can be created in three ways.

**Via database** -- add a row to the `spells` table. The server loads spells from the database at startup, so the spell will be available on the next restart. Example:

```sql
INSERT INTO spells (name, damage, mana, `range`, type, cast_time, cooldown, description, icon, can_move, effects, aoe_radius) VALUES
('shadow_burst', 12, 15, 800, 'spell', 1.5, 20, 'Unleashes a burst of shadow energy that damages and slows nearby enemies.', 'shadow_burst', 0, '[{ "type": "slow", "value": 25, "duration": 4 }]', 200);
```

**Via plugin manifest** -- define spells in a plugin's `manifest.json` under a `spells` array. These are loaded automatically at startup and merged into the spell cache before any plugin code runs. Example:

```json
{
  "name": "my-fire-spells",
  "version": "1.0.0",
  "entry": "./src/index.ts",
  "provides": ["fire.spells"],
  "spells": [
    {
      "name": "fire_blast",
      "damage": 15,
      "mana": 12,
      "range": 600,
      "type": "spell",
      "cast_time": 1,
      "cooldown": 8,
      "description": "Hurls a blast of fire at the target.",
      "icon": "fire_blast",
      "can_move": 0,
      "effects": [
        { "type": "damage_over_time", "value": 3, "duration": 6, "interval": 2 }
      ]
    }
  ]
}
```

**Via `engine.registerSpell()`** -- call this inside a plugin's `register()` function to add a spell at runtime. Duplicate names are skipped.

```ts
export default {
  async register(engine: EngineAPI) {
    await engine.registerSpell({
      name: "shadow_nova",
      damage: 20,
      mana: 25,
      range: 500,
      type: "spell",
      cast_time: 2,
      cooldown: 30,
      description: "Unleashes a wave of shadow energy.",
      effects: [{ type: "slow", value: 40, duration: 4 }]
    });
  }
};
```

All plugin-created spells live in memory only and are re-registered on each startup. They do not persist to the database.

Players learn spells through the `learned_spells` table by linking a spell name to their username.

---

## Quest System Guide

Quests are authored in the quest editor (`/questeditor`, alias `qe`, permission `tools.quest_editor` | `tools.*`) and linked to NPCs through the NPC editor's **Quests Given** / **Quests Ended** pickers (NPCs need the **Quest giver** flag first).

### Talking to NPCs

- Press **E** near an NPC (or tap them on mobile) to talk. An NPC is interactable when it has quests or gossip to share.
- **L** opens the quest log. A tracked-quest HUD lists live objective counts; clicking a tracked quest jumps to it.
- Quest markers float above NPC heads: gold `!` = quest available, grey `?` = in progress, gold `?` = ready to turn in.
- NPCs with no quests show their gossip in the overhead speech bubble only, with no popup.

### Quest Flow

Offer → accept → complete objectives → turn in. Turn-ins can chain straight into a follow-up quest. Abandoning returns to the quest list. The log holds up to **25** active quests.

### Objective Types

| Type | Description |
|------|-------------|
| `kill` | Defeat N of a creature |
| `collect` | Hold N of an item (progress follows your inventory up and down) |
| `talk` | Speak to an NPC |
| `explore` | Visit a map, or a point within a radius of one |

### Rewards

Quests grant guaranteed items, a choice of one from a set, XP, and gold/silver/copper. Turn-in is refused when the rewards don't fit in your bags, so rewards are never half-granted.

### Repeatable and Daily Quests

Quests can be one-time, `repeatable`, or `daily`. Dailies reset at **03:00 UTC** and become available again after the reset.

### Gossip Chains and Placeholders

An NPC's gossip chain (one line per step) plays in order when spoken to, each line lingering like a chat message. Lines support `${player.*}` placeholders filled from the talking player:

| Placeholder | Value |
|-------------|-------|
| `${player.name}` | Username |
| `${player.username}` | Login name |
| `${player.userid}` | Account id |
| `${player.level}` | Level |
| `${player.guild_name}` | Guild name |
| `${player.mounted}` | Mounted? |
| `${player.isAdmin}` / `${player.isGuest}` | Flags |
| `${player.stats.*}` | Any stat, e.g. `${player.stats.health}`, `${player.stats.level}` |
| `${player.currency.*}` | `copper`, `silver` or `gold` |

Unknown paths stay as written. The NPC editor's gossip field autocompletes these inside `${...}`.

---

## 📚 API Documentation

### Plugin System

Plugins are self-contained modules that extend the engine without modifying engine source code. They live under `src/plugins/` and are auto-discovered via `manifest.json` manifests.

#### Creating a Plugin

**1. Directory structure:**

```
src/plugins/
└── MyPlugin/
    ├── manifest.json       # Manifest
    └── src/
        └── index.ts      # Entry point
```

**2. Manifest file (`manifest.json`):**

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "What this plugin does",
  "entry": "./src/index.ts",
  "requires": {
    "engine": ">=1.0.0"
  },
  "provides": [
    "feature.one",
    "feature.two"
  ]
}
```

**3. Entry point (`src/index.ts`):**

```ts
import { listener, Events } from "@engine/systems/events";

export default {
  async register(engine: EngineAPI, manifest: PluginManifest) {
    // `manifest` contains name, version, description from manifest.json
    // Register packet types, builders, interceptors, and event listeners
    listener.on(Events.PARTY_CHANGED, (data) => { ... });
  },

  async unregister() {
    // Cleanup
  },
};
```

The loader reads `name`, `version`, and `description` from `manifest.json`. The plugin module only exports `register` and optionally `unregister`.

#### Engine API

The `engine` object passed to `register()` provides these methods:

| Method | Description |
|--------|-------------|
| `engine.addPacketTypes(types: string[])` | Register custom packet type constants |
| `engine.addPacketBuilders(builders: Record<string, Function>)` | Register packet builder functions |
| `engine.registerHandlers(handlers: Record<string, Function>)` | Register packet handlers |
| `engine.onWarpCollision(fn)` | Push a warp collision interceptor. Receives `(warp, wt, player, sendPacket)`. Return `true` to suppress engine handling, `false` to let engine proceed. |
| `engine.onPacket(fn)` | Push a packet interceptor. Receives `(type, data, wt, player)`. Return `true` to suppress engine handling. |
| `engine.addHttpRoute(method, path, handler)` | Register an HTTP route. `handler` receives `(req: Request)` and returns `Response`. |
| `engine.teleportPlayer(playerObj, mapName, x, y)` | Teleport a player to a map position. |
| `engine.registerSpell(spell)` | Register a spell into the asset cache at runtime. Duplicate names are skipped. Spells are not persisted to the database. |

#### Imports Available to Plugins

Use the `@engine/` prefix to import engine modules:

```ts
import log from "@engine/modules/logger.ts";
import playerCache from "@engine/services/playermanager.ts";
import assetCache from "@engine/services/assetCache.ts";
import packet from "@engine/modules/packet.ts";
import { listener, Events } from "@engine/systems/events";
```

Types (`EngineAPI`, `PluginManifest`, `PluginHandlerFn`) are declared globally in `types.d.ts` - no import required.

---

### Listener Events

Import the listener from `@engine/systems/events`:

```ts
import { listener } from "@engine/systems/events";
```

#### Lifecycle Events

| Event | Payload | When |
|-------|---------|------|
| `onAwake` | - | Server starts |
| `onStart` | - | After `onAwake` |
| `onPluginLoad` | `{ name, version, dirPath }` | Plugin manifest discovered and module imported |
| `onPluginInitialize` | `{ name, engine }` | Before `plugin.register()` is called |
| `onPluginRegister` | `{ name }` | After `plugin.register()` succeeds |
| `onPluginUnregister` | `{ name }` | Plugin unloaded |

#### Tick Events

| Event | Interval |
|-------|----------|
| `onUpdate` | Every frame (~60 FPS) |
| `onFixedUpdate` | Every 100ms |
| `onSave` | Every 60 seconds |
| `onServerTick` | Every 1 second |

#### Network Events

| Event | Payload | When |
|-------|---------|------|
| `onConnection` | `{ id, ... }` | New WebTransport session |
| `onDisconnect` | `{ id, ... }` | WebTransport session disconnected |

#### Game Events (Plugin Hooks)

##### Map and Movement

| Event | Payload | When |
|-------|---------|------|
| `onWarp` | `{ mapName, metadata }` | `constructMapMetadata()` builds a LOAD_MAP packet. `metadata` is mutable - modify `metadata.name` to change the map name sent to the client. |
| `onMapEnter` | `{ player, mapName, position }` | Player enters a new map (after AOI update, before LOAD_MAP sent) |
| `onPlayerMoved` | `{ player, position }` | After MOVEXY processes and game loop registers player |

##### Authentication and Lifecycle

| Event | Payload | When |
|-------|---------|------|
| `onPlayerAuthComplete` | `{ username, spawnLocation, playerData }` | After login spawn location is resolved, before map validation. `spawnLocation` is mutable - modify `.map`, `.x`, `.y` to redirect. |
| `onPlayerLogout` | `{ player }` | After player state saved and logout cleanup |
| `onPlayerDisconnect` | `{ player }` | After connection disconnect and drag-release cleanup |
| `onPlayerStealthChange` | `{ player, isStealth }` | After stealth/unstealth toggle and spawn/despawn packets |

##### Combat

| Event | Payload | When |
|-------|---------|------|
| `onPlayerDamaged` | `{ attacker, target, damage, isCrit }` | After damage applied to player target health |
| `onPlayerHealed` | `{ caster, target, amount, source? }` | After healing is applied (direct spell, HoT tick, or ground AoE). `source` is the spell name. |
| `onPlayerDeath` | `{ player, killer? }` | After a player dies (health <= 0) and death packets are sent |
| `onPlayerRespawn` | `{ player, mapName, x, y }` | After a player is respawned via admin command |
| `onPlayerLevelUp` | `{ player, oldLevel, newLevel }` | After XP reward causes level increase |
| `onPlayerEnterAOE` | `{ player, zoneId, spellName }` | After a player walks into a ground AoE zone. Not emitted when the zone is cast on top of them. |
| `onPlayerLeftAOE` | `{ player, zoneId, spellName }` | After a player leaves a ground AoE zone or the zone expires. |

##### Spells and Effects

| Event | Payload | When |
|-------|---------|------|
| `onSpellCast` | `{ player, spellName, target, isEntityTarget }` | After spell effects applied, last-attack timers set |
| `onSpellFailed` | `{ player, target, spellName, reason }` | After a spell cast fails validation. `reason` can be `"cooldown"`, `"mana"`, `"moving"`, `"vanished"`, `"range"`, `"nopvp"`, `"path_blocked"`, `"direction"`, `"no_effects"`, or `"unknown"`. |
| `onSpellInterrupted` | `{ player }` | After spell cancelled via ESC and state cleared |
| `onPlayerAbsorbtion` | `{ caster, target, spellName, amount, duration }` | After a barrier/shield is applied to a player. |
| `onPlayerStunned` | `{ caster, target, spellName, duration }` | After a stun effect is applied to a player. |
| `onPlayerDebuffAdded` | `{ caster, target, spellName, effectType, effect }` | After any hostile effect (stun, slow, DoT, interrupt) is applied. `effect` is the full SpellEffect object. |
| `onPlayerBuffAdded` | `{ caster, target, spellName, effectType, effect }` | After any friendly effect (HoT, barrier, vanish, visual) is applied. `effect` is the full SpellEffect object. |
| `onPlayerDebuffRemoved` | `{ player, effectId, effectType, spellName? }` | After a hostile effect expires or is cancelled. |
| `onPlayerBuffRemoved` | `{ player, effectId, effectType, spellName? }` | After a friendly effect expires or is cancelled. |
| `onPlayerVanish` | `{ player, vanished, spellName? }` | After vanish is applied (`vanished: true`) or broken/expired (`vanished: false`). |

##### Social

| Event | Payload | When |
|-------|---------|------|
| `onPlayerChat` | `{ player, message, mapName, language? }` | After chat message is decrypted and broadcast to map |
| `onWhisper` | `{ fromUsername, toUsername, message }` | After private message sent |
| `onPlayerEnteredPVP` | `{ player }` | After a player's PvP flag transitions from false to true (combat starts). |
| `onPlayerLeftPVP` | `{ player }` | After a player's PvP flag transitions from true to false (combat ends). |
| `onPartyChat` | `{ player, message, partyMembers }` | After a party chat message is sent. `partyMembers` is the list of usernames in the party. |
| `onGuildChat` | `{ player, message, guildMembers, guildId }` | After a guild chat message is sent. `guildMembers` is the list of usernames in the guild. |
| `onPartyChanged` | `{ type, members, username?, kickedUsername? }` | After party join/kick/leave/disband. `type` = `"join"` \| `"kick"` \| `"leave"` \| `"disband"`. `members` = affected usernames. |
| `onPartyInvite` | `{ inviterUsername, invitedUsername }` | After party invitation sent |
| `onVendorBuy` | `{ player, npcId, item, quantity, coins }` | After a player buys from a vendor, or buys back something they sold. `coins` = copper paid |
| `onVendorSell` | `{ player, npcId, item, quantity, coins }` | After a player sells an item to a vendor. `coins` = copper received |
| `onItemUsed` | `{ player, item, health, stamina, home }` | After a player uses a consumable. `health` / `stamina` = what it restored. For the home item both are 0 and `home` = `{ map, x, y }` where they arrived (fired once the cast has finished); otherwise `home` = `null` |
| `onHomeSet` | `{ player, npcId, inn }` | After a player makes an innkeeper's inn their home. `inn` = the NPC's name |
| `onTradeCompleted` | `{ trade }` | After two players complete a trade. `trade` = `{ id, player_a, player_b, a_gave, b_gave, created_at }`; each `gave` is `{ items: [{ name, quantity }], coins }` |
| `onGuildChanged` | `{ type, guildId, guildName, playerUsername, kickedUsername? }` | After guild create/join/leave/kick/disband. `type` = `"create"` \| `"join"` \| `"leave"` \| `"kick"` \| `"disband"` |
| `onFriendAdded` | `{ type, playerUsername, friendUsername }` | After friend request accepted and lists updated |
| `onFriendRemoved` | `{ type, playerUsername, friendUsername }` | After friend removed and list synced |

##### Equipment and Mounts

| Event | Payload | When |
|-------|---------|------|
| `onItemEquip` | `{ player, item, slot }` | After an item is equipped and stats are recalculated |
| `onItemUnequip` | `{ player, slot }` | After an item is unequipped and stats are recalculated |
| `onPlayerMount` | `{ player, mounted, mountType? }` | After mount/dismount toggle |

##### Loot

| Event | Payload | When |
|-------|---------|------|
| `onPlayerLootDropped` | `{ player, itemName, quantity, mapName, x, y }` | After loot is dropped/spawned on the ground. |
| `onPlayerLootDespawned` | `{ player, itemName, quantity, mapName, x, y }` | After loot despawns from the ground (timeout or cleanup). |
| `onPlayerLootRetrieved` | `{ player, itemName, quantity, mapName, x, y }` | After a player picks up loot. |

##### Quests

| Event | Payload | When |
|-------|---------|------|
| `onQuestAccepted` | `{ username, questId }` | After a quest is accepted. |
| `onQuestObjectiveProgress` | `{ username, questId, objectiveId, count, required }` | After any objective credit. |
| `onQuestReady` | `{ username, questId }` | After all objectives of a quest are met. |
| `onQuestCompleted` | `{ username, questId, rewards }` | After a quest is turned in. |
| `onQuestAbandoned` | `{ username, questId }` | After a quest is abandoned. |

---

### Packet Types

```ts
import { packetTypes } from "./types";
```

Packet type definitions for client-server communication.

---

### Caching

```ts
import playerCache from "../services/playermanager"; // Player cache
import assetCache from "../services/assetCache";    // Asset cache
```

| Method | Description |
|--------|-------------|
| `playerCache.add(key, value)` | Add a player to cache |
| `playerCache.get(key)` | Get a player by key |
| `playerCache.list()` | Get all cached players |
| `playerCache.remove(key)` | Remove a player from cache |
| `playerCache.set(key, value)` | Update a player in cache |
| `playerCache.setNested(key, nestedKey, value)` | Set a nested property on a player |
| `assetCache.add(key, value)` | Add an asset to cache |
| `assetCache.get(key)` | Get an asset by key |
| `assetCache.addNested(key, nestedKey, value)` | Add nested asset data |
| `assetCache.getNested(key, nestedKey)` | Get nested asset data |
| `assetCache.set(key, value)` | Update an asset in cache |
| `assetCache.setNested(key, nestedKey, value)` | Update nested asset data |

---

### Events

The event bus is available via `@engine/systems/events`:

```ts
import { listener } from "@engine/systems/events";
```

| Method | Description |
|--------|-------------|
| `listener.on(event, handler)` | Register an event handler |
| `listener.emit(event, payload)` | Emit an event |
| `listener.off(event, handler)` | Remove an event handler |

## License

Free for noncommercial use under the [PolyForm Noncommercial License 1.0.0](LICENSE). Every commercial use needs a paid [commercial license](COMMERCIAL-LICENSE.md) from Lillious Networks. See [LICENSING.md](LICENSING.md) for which one applies to you.

Contributions are welcome and need a signed [Contributor License Agreement](CLA.md); see [CONTRIBUTING.md](CONTRIBUTING.md).

---
<p align="center">
  <sub>Built with ❤️ by the Frostfire Forge Team</sub>
</p>
