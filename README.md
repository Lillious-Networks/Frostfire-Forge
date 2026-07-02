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
  <img src="https://img.shields.io/github/stars/Lillious-Networks/Frostfire-Forge?style=flat-square&label=Stars" alt="GitHub Stars">
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

**2. Create/update the whitelist file:**

Create a `whitelist.txt` file in the project root directory (same directory as the game server binary):

```
admin
moderator
testuser
approved_player
```

**3. File Format:**

- One username per line
- Usernames are case-insensitive (converted to lowercase on matching)
- Lines starting with `#` are treated as comments
- Empty lines are ignored
- Whitespace at the beginning and end of each line is trimmed

Example `whitelist.txt`:
```
# Game Admins
admin
moderator

# Test Players
testuser
lillious

# Developer Accounts
dev_account
```

**4. Restart the server:**

The whitelist is loaded at server startup. After updating `whitelist.txt`, restart the game server for changes to take effect.

**5. Realm Status in Gateway:**

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

| Event | Payload | When |
|-------|---------|------|
| `onWarp` | `{ mapName, metadata }` | `constructMapMetadata()` builds a LOAD_MAP packet. `metadata` is mutable - modify `metadata.name` to change the map name sent to the client. |
| `onMapEnter` | `{ player, mapName, position }` | Player enters a new map (after AOI update, before LOAD_MAP sent) |
| `onPlayerAuthComplete` | `{ username, spawnLocation, playerData }` | After login spawn location is resolved, before map validation. `spawnLocation` is mutable - modify `.map`, `.x`, `.y` to redirect. |
| `onPartyChanged` | `{ type, members, username?, kickedUsername? }` | After party kick/leave/disband. `type` = `"kick"` \| `"leave"` \| `"disband"`. `members` = affected usernames. |
| `onPlayerChat` | `{ player, message, mapName, language? }` | After chat message is decrypted and broadcast to map |
| `onPlayerDeath` | `{ player, killer? }` | After a player dies (health ≤ 0) and death packets are sent |
| `onPlayerRespawn` | `{ player, mapName, x, y }` | After a player is respawned via admin command |
| `onGuildChanged` | `{ type, guildId, guildName, playerUsername, kickedUsername? }` | After guild create/join/leave/kick/disband. `type` = `"create"` \| `"join"` \| `"leave"` \| `"kick"` \| `"disband"` |
| `onItemEquip` | `{ player, item, slot }` | After an item is equipped and stats are recalculated |
| `onItemUnequip` | `{ player, slot }` | After an item is unequipped and stats are recalculated |
| `onPlayerMount` | `{ player, mounted, mountType? }` | After mount/dismount toggle |
| `onPlayerMoved` | `{ player, position }` | After MOVEXY processes and game loop registers player |
| `onPlayerLogout` | `{ player }` | After player state saved and logout cleanup |
| `onPlayerDisconnect` | `{ player }` | After WebSocket disconnect and drag-release cleanup |
| `onSpellCast` | `{ player, spellName, target, isEntityTarget }` | After spell effects applied, last-attack timers set |
| `onSpellInterrupted` | `{ player }` | After spell cancelled via ESC and state cleared |
| `onPlayerDamaged` | `{ attacker, target, damage, isCrit }` | After damage applied to player target health |
| `onPlayerLevelUp` | `{ player, oldLevel, newLevel }` | After XP reward causes level increase |
| `onFriendAdded` | `{ type, playerUsername, friendUsername }` | After friend request accepted and lists updated |
| `onFriendRemoved` | `{ type, playerUsername, friendUsername }` | After friend removed and list synced |
| `onPartyInvite` | `{ inviterUsername, invitedUsername }` | After party invitation sent |
| `onPartyJoin` | `{ playerUsername, partyMembers }` | After party invitation accepted and layers synced |
| `onWhisper` | `{ fromUsername, toUsername, message }` | After private message sent |
| `onPlayerStealthChange` | `{ player, isStealth }` | After stealth/unstealth toggle and spawn/despawn packets |

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
