<p align="center">
  <img src="../../blob/main/logo.png?raw=true">
</p>

<h1 align="center">🧊🔥 Frostfire Forge 🔥🧊</h1>

<p align="center">
  <strong>A Modern 2D MMO Game Engine Platform</strong>
</p>

<p align="center">
Frostfire Forge is an upcoming 2D MMO engine platform designed to empower developers and hobbyists alike to bring their dream games and worlds to life. Built with cutting-edge technology, it offers a highly secure and optimized foundation for MMO development. With a focus on simplicity and performance, Frostfire Forge makes creating your own multiplayer universe easier than ever.
<p align="center">
  <!-- <img src="https://img.shields.io/github/actions/workflow/status/Lillious-Networks/Frostfire-Forge/production_release.yml?branch=main&label=Production&style=flat-square" alt="Production Build Status"> -->
  <!-- <img src="https://img.shields.io/github/actions/workflow/status/Lillious-Networks/Frostfire-Forge/development_release.yml?branch=development&label=Development&style=flat-square" alt="Development Build Status"> -->
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
> - [MySQL](https://www.mysql.com/downloads/) - Database
> - [Frostfire Forge Gateway](https://github.com/Lillious-Networks/Frostfire-Forge-Gateway) - Authentication and reverse proxy gateway (required for all deployments)
> - [Docker](https://www.docker.com/) (Optional) - For containerized deployment

---

## 🏗️ Architecture

### Gateway (Authentication & Reverse Proxy)

Frostfire Forge requires the [Frostfire Forge Gateway](https://github.com/Lillious-Networks/Frostfire-Forge-Gateway) for all deployments. The gateway handles centralized user authentication, game server registration and management, automatic failover, and request routing to game servers.

#### Setup

Game servers automatically register with the gateway on startup using the `GATEWAY_URL`, `GATEWAY_AUTH_KEY`, and `GATEWAY_GAME_SERVER_SECRET` environment variables. The server will continuously poll until the gateway is available.

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
GAME_NAME="Your Game Name"
LOG_LEVEL="info"                          # Logging level: trace, debug, info, warn, error

# Gateway (Required)
GATEWAY_URL="http://gateway:9999"               # Gateway registration endpoint
GATEWAY_AUTH_KEY="your_secret_key"              # Shared secret for server registration
GATEWAY_GAME_SERVER_SECRET="another_secret_key" # Game server authentication token
SERVER_HOST="game-server-hostname"              # Internal server hostname
PUBLIC_HOST="yourdomain.com"                    # External hostname for clients
SERVER_ID="server-1"                            # Game server identification
```

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

<p align="center">
  <sub>Built with ❤️ by the Frostfire Forge Team</sub>
</p>
