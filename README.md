<p align="center">
  <img src="../../blob/main/src/webserver/www/public/img/engine-logo-transparent.png?raw=true">
</p>

<h1 align="center">🧊🔥 Frostfire Forge 🔥🧊</h1>

<p align="center">
  <strong>A Modern 2D MMO Game Engine Platform</strong>
</p>

<p align="center">
Frostfire Forge is an upcoming 2D MMO engine platform designed to empower developers and hobbyists alike to bring their dream games and worlds to life. Built with cutting-edge technology, it offers a highly secure and optimized foundation for MMO development. With a focus on simplicity and performance, Frostfire Forge makes creating your own multiplayer universe easier than ever.
<p align="center">
  <img src="https://img.shields.io/github/actions/workflow/status/Lillious-Networks/Frostfire-Forge/production_release.yml?branch=main&label=Production&style=flat-square" alt="Production Build Status">
  <img src="https://img.shields.io/github/actions/workflow/status/Lillious-Networks/Frostfire-Forge/development_release.yml?branch=development&label=Development&style=flat-square" alt="Development Build Status">
  <img src="https://img.shields.io/badge/status-WIP-yellow?style=flat-square&label=Status" alt="Work in Progress">
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
  <img src="../../blob/main/src/webserver/www/public/img/teaser.png?raw=true">
</p>

## 📋 Table of Contents

- [Requirements](#-requirements)
- [Quick Start](#-quick-start)
  - [Development Setup](#development-setup)
  - [Production Setup](#production-setup)
  - [Docker Deployment](#docker-deployment)
- [Environment Variables](#-environment-variables)
- [Commands Reference](#-commands-reference)
  - [Admin Commands](#admin-commands)
  - [Player Commands](#player-commands)
- [API Documentation](#-api-documentation)
  - [Packet Types](#authorized-packet-types)
  - [Caching](#caching)
  - [Events](#events)
  - [Listener Events](#listener-events)
- [System API Reference](#-system-api-reference)

---

## 🔧 Requirements

> [!IMPORTANT]
> **Required Software**:
> - [Bun](https://bun.sh/) - JavaScript runtime & package manager
> - [MySQL](https://www.mysql.com/downloads/) - Database (or SQLite for development)
> - [Docker](https://www.docker.com/) (Optional) - For containerized deployment

---

## 🚀 Quick Start

### Development Setup

#### 1. Update the `.env.development` file

Configure your development environment variables.

#### 2. Run the setup script

```bash
bun setup-development
```

#### 3. Start the development server

```bash
bun development
```

#### 4. Default Login Credentials

```
Username: demo_user
Password: Changeme123!
```

---

### Production Setup

#### 1. Run the production setup script

```bash
bun setup-production
```

#### 2. Update the `.env.production` file

Configure your production environment variables.

#### 3. Start the production server

**Direct execution:**
```bash
bun production
```

---

### Docker Deployment

#### Pull Pre-built Local Image

Pull the latest pre-built local Docker image:
```bash
docker pull ghcr.io/lillious-networks/frostfire-forge-local:latest
```

Run the pulled image:
```bash
docker run -p 80:80 -p 3000:3000 --name frostfire-forge-local ghcr.io/lillious-networks/frostfire-forge-local:latest
```

#### Prerequisites

- Docker and Docker Compose installed
- Proper environment variable file configured

#### Development Environment

**Start the development container:**
```bash
bun run docker:dev
```

**View logs:**
```bash
bun run docker:dev:logs
```

**Stop the container:**
```bash
bun run docker:dev:down
```

**Rebuild the container:**
```bash
bun run docker:dev:build
```

#### Production Environment

**Start the production container:**
```bash
bun run docker:prod
```

**View logs:**
```bash
bun run docker:prod:logs
```

**Stop the container:**
```bash
bun run docker:prod:down
```

**Rebuild the container:**
```bash
bun run docker:prod:build
```

#### Docker Configuration Notes

- **Development**: Source code is mounted as a volume for hot-reload
- **Production**: Multi-stage build with optimized dependencies
- **Environment Files**: `.env.production`, `.env.development` or `.env.local` is automatically loaded
- **Ports Exposed**: 80 (HTTP), 443 (HTTPS), 3000 (Application)
- **Redis**: If `CACHE=redis`, configure `REDIS_URL` and `REDIS_PASSWORD` in your `.env` file

---

## ⚙️ Environment Variables

> [!IMPORTANT]
> The following environment variables are required for production.

```bash
DATABASE_ENGINE="mysql" | "sqlite"
DATABASE_HOST="your_db_host"
DATABASE_NAME="your_db_name"
DATABASE_PASSWORD="your_db_password"
DATABASE_PORT="3306"
DATABASE_USER="your_db_user"
SQL_SSL_MODE="DISABLED" | "ENABLED"

# Email Configuration
EMAIL_PASSWORD="your_email_password"
EMAIL_SERVICE="mail.example.com"
EMAIL_USER="your_email@example.com"
EMAIL_TEST="your_test_email@example.com"

# Server Configuration
WEBSRV_PORT="80"
WEBSRV_PORTSSL="443"
WEBSRV_USESSL="true"
SESSION_KEY="your_session_secret_key"

# Translation Services
GOOGLE_TRANSLATE_API_KEY="your_google_api_key"
OPENAI_API_KEY="your_openai_api_key"
TRANSLATION_SERVICE="google_translate" | "openai"
OPEN_AI_MODEL="gpt-4"

# Application Settings
WEB_SOCKET_URL="wss://yourdomain.com"
WEB_SOCKET_PORT="3000"
DOMAIN="https://yourdomain.com"
GAME_NAME="Your Game Name"

# Caching
CACHE="redis" | "memory"
REDIS_URL="redis://default@redis:6379"  # Required if CACHE=redis

# Versioning (can be provided at runtime)
VERSION="1.0.0"
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
- **Permission**: `admin.summon` | `admin.*`
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

---

## 📚 API Documentation

### Authorized Packet Types

```ts
import { packetTypes } from "./types";
```

Packet type definitions for client-server communication.

---

### Caching

```ts
import cache from '../services/cache'; // Main player cache
import assetCache from '../services/assetCache'; // Asset caching
```

| Method | Description |
|--------|-------------|
| `cache.add(key, value)` | Adds an item to the cache |
| `cache.addNested(key, nestedKey, value)` | Adds a nested item to the cache |
| `cache.get(key)` | Fetches an item from the cache |
| `cache.remove(key)` | Removes an item from the cache |
| `cache.clear()` | Clears the cache |
| `cache.list()` | Fetches all items from the cache |
| `cache.set()` | Updates an item in cache |
| `cache.setNested()` | Updates a nested item in cache |

> Same methods apply to `assetCache`

---

### Events

```ts
import { Events } from "../socket/server";
```

| Method | Description |
|--------|-------------|
| `events.GetOnlineCount()` | Returns the amount of clients currently connected |
| `events.GetOnlineData()` | Returns a list containing client connection data |
| `events.Broadcast(packet)` | Broadcasts a message to all connected clients |
| `events.GetClientRequests()` | Returns a list containing client request data |
| `events.GetRateLimitedClients()` | Returns a list of rate limited clients |

---

### Listener Events

#### onAwake
Fires immediately after the server starts.

```ts
Listener.on("onAwake", (data) => {
  console.log("Awake event emitted");
});
```

#### onStart
Fires immediately after **onAwake**.

```ts
Listener.on("onStart", (data) => {
  console.log("Start event emitted");
});
```

#### onUpdate
Fires immediately after **onStart** every 60 frames.

```ts
Listener.on("onUpdate", (data) => {
  console.log("Update event emitted");
});
```

#### onFixedUpdate
Fires immediately after **onStart** every 100ms.

```ts
Listener.on("onFixedUpdate", (data) => {
  console.log("Fixed update event emitted");
});
```

#### onSave
Runs every 1 minute.

```ts
Listener.on("onSave", (data) => {
  console.log("Save event emitted");
});
```

#### onConnection
Fires when a new connection is established.

```ts
Listener.on("onConnection", (data) => {
  console.log(`New connection: ${data}`);
});
```

#### onDisconnect
Fires when a connection is dropped.

```ts
Listener.on("onDisconnect", (data) => {
  console.log(`Disconnected: ${data}`);
});
```

#### onServerTick
Fires every 1 second.

```ts
Listener.on("onServerTick", (data) => {
  console.log(`Server tick: ${data}`);
});
```

---

## 📖 System API Reference

> [!NOTE]
> **Complete system API documentation is available at `/docs`**
>
> The documentation includes detailed information about all system modules:
> - **Player Management** - Authentication, stats, inventory, and more
> - **World Systems** - Worlds, maps, weather, and NPCs
> - **Combat & Skills** - Weapons, spells, and combat mechanics
> - **Social Features** - Friends, parties, and permissions
> - **Economy** - Currency and item management
> - **Quest System** - Quests and quest logs
> - **Effects** - Particles, audio, and visual effects
>
> **Generate latest documentation:**
> ```bash
> bun run docs
> ```
>
> This will regenerate the API documentation with the latest system changes.

---

<p align="center">
  <sub>Built with ❤️ by the Frostfire Forge Team</sub>
</p>
