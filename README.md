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
  <img src="https://img.shields.io/badge/status-Alpha-yellow?style=flat-square&label=Status" alt="Work in Progress">
  <img src="https://img.shields.io/github/license/Lillious-Networks/Frostfire-Forge?style=flat-square&label=License" alt="License">
  <img src="https://img.shields.io/github/stars/Lillious-Networks/Frostfire-Forge?style=flat-square&label=Stars&color=yellow" alt="GitHub Stars">
</p>

---

> [!NOTE]
> **Project Status**: This project is currently a **work in progress**
>
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
- [Realm Whitelist Configuration](#️-realm-whitelist-configuration)
- [Quick Start](#-quick-start)
  - [Development Setup](#development-setup)
  - [Production Setup](#production-setup)
  - [Docker Deployment](#docker-deployment)
- [Commands Reference](#-commands-reference)
  - [Admin Commands](#admin-commands)
  - [Player Commands](#player-commands)
- [API Documentation](#-api-documentation)
  - [Plugin System](#plugin-system)
  - [Listener Events](#listener-events)
  - [Packet Types](#packet-types)
  - [Caching](#caching)
  - [Events](#events)
- [System API Reference](#-system-api-reference)

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

Game servers automatically register with the gateway on startup using the `GATEWAY_URL`, `GATEWAY_AUTH_KEY`, and `GATEWAY_GAME_SERVER_SECRET` environment variables. The server will continuously poll until the gateway is available.

---

### Asset Server (Media & Resources)

Frostfire Forge requires the [Frostfire Forge Assets](https://github.com/Lillious-Networks/Frostfire-Forge-Assets) server for all deployments. The asset server manages and distributes critical game data including:

- **Map Data** - Tile maps, collision layers, spawn points, and warps
- **Sprites & Animations** - Character sprites, item graphics, and animation frames
- **Game Resources** - Particle effects, NPC data, quest data, items, spells, and mounts
- **Dynamic Updates** - Real-time map updates from the tile editor for collaborative world building

The asset server provides a centralized repository for all game assets, enabling the game engine to fetch required data on-demand and persist editor changes back to permanent storage.

#### Setup

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
SQL_SSL_MODE="DISABLED" | "ENABLED"

# Translation Services
GOOGLE_TRANSLATE_API_KEY="your_google_api_key"
OPENAI_API_KEY="your_openai_api_key"
TRANSLATION_SERVICE="google_translate" | "openai"
OPENAI_MODEL="gpt-4.1-nano-2025-04-14"

# Application Settings
WEB_SOCKET_PORT="3000"                    # Internal WebSocket port
WEB_SOCKET_USE_SSL="true" | "false"       # Enable SSL/TLS for WebSocket
WEB_SOCKET_CERT_PATH="./src/certs/cert.pem"
WEB_SOCKET_KEY_PATH="./src/certs/key.pem"
WEB_SOCKET_CA_PATH="./src/certs/cert.ca-bundle"
GAME_NAME="Your Game Name"
LOG_LEVEL="info"                          # Logging level: trace, debug, info, warn, error

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

# Realm Configuration
WHITELIST="true" | "false"                       # Enable/disable username whitelist for this realm
```

---

## 🛡️ Realm Whitelist Configuration

### Overview

The whitelist feature restricts user access to a specific realm to only approved usernames. When enabled, any user attempting to authenticate with a username not in the whitelist will be disconnected with the message "Username not whitelisted on this realm".

### Setup Instructions

**1. Enable the whitelist for the realm:**

Set the environment variable in your `.env` file:
```bash
WHITELIST=true
```

**2. Run the whitelist command**

Run the whitelist command found in the [Admin Commands](#admin-commands) section to add or remove from the whitelist

**Realm Status in Gateway:**

The realm will display a "whitelist" badge in the realm selection UI when `WHITELIST=true`, allowing players to see which realms have restricted access.

---

## 🚀 Quick Start

### Development Setup

**Option 1: Use prebuilt Docker image:**
```bash
docker run -d --name frostfire-forge-dev -p 3000:3000 ghcr.io/lillious-networks/frostfire-forge-dev:latest
```

**Option 2: Build and run from source:**
```bash
bun development
```

**Optional: Update `.env.development` before running**

Default admin login credentials:
```
Username: demo_user
Password: Changeme123!
```

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
/weather [weather_name | clear | random]
```
- **Permission**: `admin.weather` | `admin.*`
- Changes the current world's weather. Valid values are any weather name from the `weather` database table, `clear` to disable weather, or `random` to cycle through all available weather types every 30 minutes.
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
</details>

<details>
<summary><strong>Server Restart (Scheduled: 15 minutes)</strong></summary>

```bash
/restart
```
- **Permission**: `server.restart`
</details>

<details>
<summary><strong>Respawn Player</strong></summary>

```bash
/respawn [username | id]
```
- **Permission**: `admin.respawn` | `admin.*`
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
- Spawns a loot drop at your feet. Amount defaults to 1, capped at 9,999.
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
<summary><strong>Entity Editor</strong></summary>

```bash
/entityeditor
```
- **Aliases**: `ee`
- **Permission**: `tools.entity_editor` | `tools.*`

</details>

<details>
<summary><strong>Manage Whitelist</strong></summary>

```bash
/whitelist [mode] [username]
```
- **Permission**: `admin.whitelist` | `admin.*`

**Modes**:
- `add` - Add a player to the whitelist
- `remove` - Remove a player from the whitelist
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

---

## Spell Creation Guide

Spells are stored in the `spells` database table. Each row defines a spell with its stats, visuals, and effects. The game server loads all spells from the database into memory at startup, and the `effects` column contains a JSON array that defines what the spell actually does when cast.

### Spell Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Unique spell identifier, used to reference the spell everywhere |
| `damage` | number | Base damage dealt on hit. Use negative numbers for healing spells |
| `mana` | number | Mana cost as a percentage of the caster's max stamina |
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
| `engine.onWarpCollision(fn)` | Push a warp collision interceptor. Receives `(warp, ws, player, sendPacket)`. Return `true` to suppress engine handling, `false` to let engine proceed. |
| `engine.onPacket(fn)` | Push a packet interceptor. Receives `(type, data, ws, player)`. Return `true` to suppress engine handling. |
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
| `onConnection` | `{ id, ... }` | New WebSocket connection |
| `onDisconnect` | `{ id, ... }` | WebSocket disconnected |

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
| `onPlayerDisconnect` | `{ player }` | After WebSocket disconnect and drag-release cleanup |
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
| `onSpellFailed` | `{ player, target, spellName, reason }` | After a spell cast fails validation. `reason` can be `"cooldown"`, `"mana"`, `"moving"`, `"vanished"`, `"range"`, `"nopvp"`, `"path_blocked"`, `"direction"`, `"entity_returning"`, `"no_effects"`, or `"unknown"`. |
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

---
<p align="center">
  <sub>Built with ❤️ by the Frostfire Forge Team</sub>
</p>
