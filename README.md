<p align="center">
  <img src="../../blob/main/src/webserver/www/public/img/engine-logo-transparent.png?raw=true">
</p>

<h3 align="center">🧊🔥 2D MMO Game Engine 🔥🧊</h3>

<p align="center" style="font-size: 12.5px;">
Frostfire Forge is an upcoming 2D MMO engine platform designed to empower developers and hobbyists alike to bring their dream games and worlds to life. Built with cutting-edge technology, it offers a highly secure and optimized foundation for MMO development. With a focus on simplicity and performance, Frostfire Forge makes creating your own multiplayer universe easier than ever.
</p>

<hr>
<br>

![github](https://img.shields.io/github/actions/workflow/status/Lillious-Networks/Frostfire-Forge/build_release.yml)

> [!NOTE]
> This project is currently a **work in progress**
>
> Core Development Team: [Lillious](https://github.com/Lillious), [Deph0](https://github.com/Deph0)
>
> [Discord](https://discord.gg/4spUbuXBvZ)

<h3>Getting Started</h3>

> [!IMPORTANT]
> **Requirements**:
> - [Bun](https://bun.sh/)
> - [MySQL](https://www.mysql.com/downloads/)

<h3>Setting up the development environment</h3>

<h4>- Update the .env.development file</h4>

<h4>- Run the setup script</h4>

```
bun setup-development
```

<h4>- Run the server</h4>

```
bun development
```

<h4>- Login Information</h4>

```
Username: demo_user
Password: Changeme123!
```

<hr>

<h3>Setting up the production environment</h3>

<h4>- Run the setup script</h4>

```
bun setup-production
```

<h4>- Update the .env.production file</h4>

<h4>- Run the server</h4>

```
bun production
```

<h4>- Running the server as a service</h4>

```
bun service:start
```


<h3>Production Environment Variables</h3>

> [!IMPORTANT]
> The below environment variables are required

```
DATABASE_HOST
DATABASE_USER
DATABASE_PASSWORD
DATABASE_NAME
EMAIL_USER
EMAIL_PASSWORD
EMAIL_SERVICE
EMAIL_TEST
SQL_SSL_MODE DISABLED | ENABLED
DATABASE_ENGINE sqlite | mysql
WEBSRV_PORT
WEBSRV_PORTSSL
WEBSRV_USESSL true | false
WEBSRV_USECERT true | false
GOOGLE_TRANSLATE_API_KEY
WEB_SOCKET_URL
ASSET_PATH
DOMAIN
GAME_NAME
DATABASE_PORT
```

<hr>

<h3>Admin Commands</h3>

<h4>Disconnect Player</h4>

```
/kick [username | id]
Aliases: disconnect
Permission: admin.kick | admin.*
```

<h4>Warp</h4>

```
/warp [map]
Permission: admin.warp | admin.*
```

<h4>Reload Map</h4>

```
/reloadmap [map]
Permission: admin.reloadmap | admin.*
```

<h4>Ban Player</h4>

```
/ban [username | id]
Aliases: ban
Permission: admin.ban | admin.*
``` 

<h4>Unban Player</h4>

```
/unban [username | id]
Aliases: unban
Permission: admin.unban | admin.*
```

<h4>Send Message to Players</h4>

```
/notify [audience?] [message]
Audience: all (default) | map | admins
Aliases: notify
Permission: server.notify | server.*
```

<h4>Toggle Admin Status</h4>

```
/admin [username | id]
Aliases: setadmin
Permission: server.admin | server.*
```

<h4>Server Shutdown</h4>

```
/shutdown
Aliases: shutdown
Permission: server.shutdown | server.*
```

<h4>Server Restart (Scheduled: 15 minutes)</h4>

```
/restart
Aliases: restart
Permission: server.restart
```

<h4>Respawn Player</h4>

```
/respawn [username | id]
Aliases: respawn
Permission: admin.respawn | admin.*
```

<h4>Summon Player</h4>

```
/summon [username | id]
Aliases: summon
Permissions: admin.summon | admin.*
```

<h4>Update Player Permissions</h4>

```
/permission [mode] [username | id] [permissions?]
Aliases: permissions
Permission: admin.permission | admin.*

Modes:
- add
Permission: permission.add | permission.*
- remove
Permission: permission.remove | permission.*
- set
Permission: permission.add | permission.*
- clear
Permission: permission.remove | permission.*
- list
Permission: permission.list | permission.*
```

<hr>

<h3>Player Commands</h3>

<h4>Whisper</h4>

```
/whisper [username] [message]
Aliases: w
```

<hr>

<h3>Client Identity</h3>

<h5>Structure</h5>

```ts
declare interface Identity {
  id: string;
  useragent: string;
}
```

<h3>Authorized Packet Types</h3>

```ts
import { packetTypes } from "./types";
```

<h5>Structure</h5>

```ts
declare interface Packet {
  type: PacketType;
  data: PacketData;
  id: Nullable<string>;
  useragent: Nullable<string>;
  language: Nullable<string>;
  publicKey: Nullable<string>;
}

declare interface PacketType {
  [key: any]: string;
}

declare interface PacketData {
  data: Array<any>;
}
```

<hr>
<h3>Rate Limiting</h3>
<h5>Options</h5>

```ts
const RateLimitOptions: RateLimitOptions = {
  maxRequests: 2000,
  time: 2000,
  maxWindowTime: 1000,
};
```

<h5>Structure</h5>

```ts
declare interface RateLimitOptions {
  maxRequests: number;
  time: number;
  maxWindowTime: number;
}
```

<hr>
<h3>Caching</h3>

```ts
import cache from '../services/cache'; // Main player cache
import assetCache from '../services/assetCache'; // Asset caching
```

<h5>cache.add(key: string, value: any);</h5>
<h5>assetCache.add(key: string, value: any);</h5>
<p style="font-size:0.75em;">Adds an item to the cache</p>

<h5>cache.addNested(key: string, nestedKey: string, value: any);</h5>
<h5>assetCache.addNested(key: string, nestedKey: string, value: any);</h5>
<p style="font-size:0.75em;">Adds a nested item to the cache</p>

<h5>cache.get(key: string)</h5>
<h5>assetCache.get(key: string)</h5>
<p style="font-size:0.75em;">Fetches an item from the cache</p>

<h5>cache.remove(key: string)</h5>
<h5>assetCache.remove(key: string)</h5>
<p style="font-size:0.75em;">Removes an item from the cache</p>

<h5>cache.clear();</h5>
<h5>assetCache.clear();</h5>
<p style="font-size:0.75em;">Clears the cache</p>

<h5>cache.list();</h5>
<h5>assetCache.list();</h5>
<p style="font-size:0.75em;">Fetches all items from the cache</p>

<h5>cache.set();</h5>
<h5>assetCache.set();</h5>
<p style="font-size:0.75em;">Updates an item in cache</p>

<h5>cache.setNested();</h5>
<h5>assetCache.setNested();</h5>
<p style="font-size:0.75em;">Updates a nested item in cache</p>

<hr>
<h3>Events</h3>

```ts
import { Events } from "../socket/server";
```

<h5>events.GetOnlineCount();</h5>
<p style="font-size:0.75em;">Returns the amount of clients that are currently connected</p>

<h5>events.GetOnlineData();</h5>
<p style="font-size:0.75em;">Returns a list that contains client connection data</p>

<h5>events.Broadcast(packet: string);</h5>
<p style="font-size:0.75em;">Broadcasts a message to all connected clients</p>

<h5>events.GetClientRequests();</h5>
<p style="font-size:0.75em;">Returns a list that contains client request data

<h5>events.GetRateLimitedClients();</h5>
<p style="font-size:0.75em;">Returns a list of rate limited clients</p>

<hr>
<h3>Listener Events</h3>

<h5>onAwake</h5>
<p style="font-size:0.75em;">Fires immediately after the server starts</p>

```ts
Listener.on("onAwake", (data) => {
  console.log("Awake event emitted");
});
```

<h5>onStart</h5>
<p style="font-size:0.75em;">Fires immediately after <b>onAwake</b></p>

```ts
Listener.on("onStart", (data) => {
  console.log("Start event emitted");
});
```

<h5>onUpdate</h5>
<p style="font-size:0.75em;">Fires immediately after <b>onStart</b> every 60 frames</p>

```ts
Listener.on("onUpdate", (data) => {
  console.log("Update event emitted");
});
```

<h5>onFixedUpdate</h5>
<p style="font-size:0.75em;">Fires immediately after <b>onStart</b> every 100ms</p>

```ts
Listener.on("onFixedUpdate", (data) => {
  console.log("Fixed update event emitted");
});
```

<h5>onSave</h5>
<p style="font-size:0.75em;">Runs every 1 minute</p>

```ts
Listener.on("onSave", (data) => {
  console.log("Save event emitted");
});
```

<h5>onConnection</h5>
<p style="font-size:0.75em;">Fires when a new connection is established</p>

```ts
Listener.on("onConnection", (data) => {
  console.log(`New connection: ${data}`);
});
```

<h5>onDisconnect</h5>
<p style="font-size:0.75em;">Fires when a connection is dropped</p>

```ts
Listener.on("onDisconnect", (data) => {
  console.log(`Disconnected: ${data}`);
});
```

<h5>onServerTick</h5>
<p style="font-size:0.75em;">Fires every 1 second</p>

```ts
Listener.on("onServerTick", (data) => {
  console.log(`Server tick: ${data}`);
});
```

<hr>
<h3>Inventory Management</h3>

```ts
import inventory from "../systems/inventory";
```

<h5>Structure</h5>

```ts
declare interface InventoryItem {
  name: string;
  quantity: number;
}
```

<h5>inventory.add();</h5>
<p style="font-size:0.75em;">Add an item to player inventory</p>

```ts
await inventory.add(username, { name: "item_name", quantity: number });
```

<h5>inventory.remove();</h5>
<p style="font-size:0.75em;">Remove an item from player inventory</p>

```ts
await inventory.remove(username, { name: "item_name", quantity: number });
```

<h5>inventory.find();</h5>
<p style="font-size:0.75em;">Find an item from player inventory</p>

```ts
await inventory.find(username, { name: "item_name" });
```

<h5>inventory.delete();</h5>
<p style="font-size:0.75em;">Delete an item from player inventory</p>

```ts
await inventory.delete(username, { name: "item_name" });
```

<h5>inventory.get();</h5>
<p style="font-size:0.75em;">Fetches a player's inventory</p>

```ts
await inventory.get(username);
```

<hr>
<h3>Weapon Management</h3>

```ts
import weapon from "../systems/weapons";
```

<h5>Structure</h5>

```ts
declare interface WeaponData {
  name: string;
  damage: number;
  mana: number;
  range: number;
  quality: string;
  type: string;
  description: string;
}
```

<h5>weapon.add();</h5>
<p style="font-size:0.75em;">Adds a weapon to the weapon database</p>

```ts
await weapon.add(weapon);
```

<h5>weapon.remove();</h5>
<p style="font-size:0.75em;">Removes a weapon to the weapon database</p>

```ts
await weapon.remove(weapon);
```

<h5>weapon.find();</h5>
<p style="font-size:0.75em;">Fetches a weapon from the weapon database</p>

```ts
await weapon.find(weapon);
```

<h5>weapon.update();</h5>
<p style="font-size:0.75em;">Updates a weapon in the weapon database</p>

```ts
await weapon.update(weapon);
```

<h5>weapon.list();</h5>
<p style="font-size:0.75em;">Lists all weapon in the weapon database</p>

```ts
await weapon.list();
```

<hr>
<h3>Item Management</h3>

```ts
import items from "../systems/items";
```

<h5>Structure</h5>

```ts
declare interface Item {
  name: string;
  quality: string;
  description: string;
}
```

<h5>items.add();</h5>
<p style="font-size:0.75em;">Add an item to the item database</p>

```ts
await items.add({ name: "item_name", quality: "item_quality", description: "item_description" });
```

<h5>items.remove();</h5>
<p style="font-size:0.75em;">Remove an item from the item database</p>

```ts
await items.remove({ name: "item_name" });
```

<h5>items.list();</h5>
<p style="font-size:0.75em;">List all items from the item database</p>

```ts
await items.list();
```

<h5>items.find();</h5>
<p style="font-size:0.75em;">Find an item from the item database</p>

```ts
await items.find({ name: "item_name" });
```

<h5>items.update();</h5>
<p style="font-size:0.75em;">Updates an item in the database</p>

```ts
await items.update(item);
```

<hr>
<h3>Player Management</h3>

```ts
import player from "../systems/player";
```

<h5>Structure</h5>

```ts
declare interface Player {
  id?: string;
  username?: string;
  position?: PositionData;
  location?: LocationData;
  map?: string;
  stats?: StatsData;
  isStealth?: boolean;
  isAdmin?: boolean;
  isNoclip?: boolean;
  pvp?: boolean;
  last_attack?: number;
}
```

<h5>player.getLocation();</h5>
<p style="font-size:0.75em;">Get a player's location data</p>

```ts
await player.getLocation({ name: username }) as LocationData | null;
```

<h5>player.setSessionId();</h5>
<p style="font-size:0.75em;">Sets a player's sessionId</p>

```ts
await player.setSessionId(token, sessionId);
```

<h5>player.getSessionId();</h5>
<p style="font-size:0.75em;">Get a player's sessionId</p>

```ts
await player.getSessionId(token);
```

<h5>player.login();</h5>
<p style="font-size:0.75em;">Logs a player in</p>

```ts
await player.login("user_name, password);
```

<h5>player.logout();</h5>
<p style="font-size:0.75em;">Logs the player out by clearing the auth token</p>

```ts
await player.logout(sessionId);
```

<h5>player.clearSessionId();</h5>
<p style="font-size:0.75em;">Clears the players session by clearing the session id</p>

```ts
await player.clearSessionId(sessionId);
```

<h5>player.getUsernameBySession();</h5>
<p style="font-size:0.75em;">Gets a player's username by sessionId</p>

```ts
await player.getUsernameBySession(sessionId);
```

<h5>player.getUsernameByToken();</h5>
<p style="font-size:0.75em;">Gets a player's username by authentication token</p>

```ts
await player.getUsernameByToken(sessionId);
```

<h5>player.register();</h5>
<p style="font-size:0.75em;">Registers a new player account</p>

```ts
await player.register(username, password, email, request);
```

<h5>player.findByUsername();</h5>
<p style="font-size:0.75em;">Finds a player by username</p>

```ts
await player.findByUsername(username);
```

<h5>player.findByEmail();</h5>
<p style="font-size:0.75em;">Finds a player by email</p>

```ts
await player.findByEmail(email);
```

<h5>player.setToken();</h5>
<p style="font-size:0.75em;">Assigns a player an authentication token</p>

```ts
await player.setToken(username);
```

<h5>player.getEmail();</h5>
<p style="font-size:0.75em;">Gets a players email</p>

```ts
await player.getEmail(sessionId);
```

<h5>player.returnHome();</h5>
<p style="font-size:0.75em;">Sets the players location to the main map at 0, 0</p>

```ts
await player.returnHome(sessionId);
```

<h5>player.isOnline();</h5>
<p style="font-size:0.75em;">Checks if the player is currently online</p>

```ts
await player.isOnline(username);
```

<h5>player.isBanned();</h5>
<p style="font-size:0.75em;">Checks if the player is currently banned</p>

```ts
await player.isBanned(username);
```

<h5>player.getStats();</h5>
<p style="font-size:0.75em;">Fetches a player's stats</p>

```ts
await player.getStats(username);
```

<h5>player.setStats();</h5>
<p style="font-size:0.75em;">Sets a player's stats</p>

```ts
await player.setStats(username, stats);
```

<h5>player.getConfig();</h5>
<p style="font-size:0.75em;">Fetches a player's client configuration</p>

```ts
await player.getConfig(username);
```

<h5>player.setConfig();</h5>
<p style="font-size:0.75em;">Sets a player's client configuration</p>

```ts
await player.getConfig(session_id, stats);
```

<h5>player.checkIfWouldCollide();</h5>
<p style="font-size:0.75em;">Checks if a player would collide with a future position</p>

```ts
await player.checkIfWouldCollide(map, position);
```

<h5>player.kick();</h5>
<p style="font-size:0.75em;">Kicks a player from the server</p>

```ts
await player.kick(username, websocket);
```

<h5>player.ban();</h5>
<p style="font-size:0.75em;">Bans a player from the server</p>

```ts
await player.ban(username, websocket);
```

<h5>player.canAttack();</h5>
<p style="font-size:0.75em;">Returns true if a self can attack another player</p>

```ts
await player.canAttack(self, target, range);
```

<h5>player.findClosestPlayer();</h5>
<p style="font-size:0.75em;">Returns the closest player or null</p>

```ts
await player.findClosestPlayer(self, players, range);
```

<h5>player.increaseXp();</h5>
<p style="font-size:0.75em;">Increases a player's xp</p>

```ts
await player.increaseXp(username, xp);
```

<h5>player.getNewMaxXp();</h5>
<p style="font-size:0.75em;">Returns the new max xp for a player</p>

```ts
await player.getNewMaxXp(level);
```

<h5>player.increaseLevel();</h5>
<p style="font-size:0.75em;">Increases a player's level</p>

```ts
await player.increaseLevel(username);
```


<hr>
<h3>Audio Management</h3>

```ts
import audio from "../systems/audio";
```

<h5>Structure</h5>

```ts
declare interface AudioData {
  name: string;
  data: Buffer;
  pitch?: number;
}
```

<h5>audio.list();</h5>
<p style="font-size:0.75em;">List all audio files in cache</p>

```ts
audio.list() as AudioData[];
```

<h5>audio.get();</h5>
<p style="font-size:0.75em;">Fetches an audio file from cache</p>

```ts
audio.get(name) as AudioData[];
```

<hr>
<h3>Spell Management</h3>

```ts
import spell from "../systems/spells";
```

<h5>Structure</h5>

```ts
declare interface SpellData {
  name: string;
  damage: number;
  mana: number;
  range: number;
  type: string;
  cast_time: number;
  description: string;
}
```

<h5>spell.add();</h5>
<p style="font-size:0.75em;">Adds a spell to the spell database</p>

```ts
await spell.add(spell);
```

<h5>spell.remove();</h5>
<p style="font-size:0.75em;">Removes a spell from the spell database</p>

```ts
await spell.remove(spell);
```

<h5>spell.find();</h5>
<p style="font-size:0.75em;">Fetches a spell from the spell database</p>

```ts
await spell.find(spell);
```

<h5>spell.update();</h5>
<p style="font-size:0.75em;">Updates a spell in the spell database</p>

```ts
await spell.update(spell);
```

<h5>spell.list();</h5>
<p style="font-size:0.75em;">Lists all spell in the spell database</p>

```ts
await spell.list();
```


<hr>
<h3>NPC Management</h3>

```ts
import npc from "../systems/npcs";
```

<h5>Structure</h5>

```ts
declare interface Npc {
  id: Nullable<number>;
  last_updated: Nullable<number>;
  map: string;
  position: PositionData;
  direction: string;
  hidden: boolean;
  script: Nullable<string>;
}
```

<h5>npc.add();</h5>
<p style="font-size:0.75em;">Adds a npc to the npc database</p>

```ts
await npc.add(npc);
```

<h5>npc.remove();</h5>
<p style="font-size:0.75em;">Removes a npc to the npc database</p>

```ts
await npc.remove(npc);
```

<h5>npc.find();</h5>
<p style="font-size:0.75em;">Fetches a npc from the npc database</p>

```ts
await npc.find(npc);
```

<h5>npc.update();</h5>
<p style="font-size:0.75em;">Updates a npc in the npc database</p>

```ts
await npc.update(npc);
```

<h5>npc.list();</h5>
<p style="font-size:0.75em;">Lists all npcs in the npc database</p>

```ts
await npc.list();
```

<h5>npc.move();</h5>
<p style="font-size:0.75em;">Changes a npc location</p>

```ts
await npc.move(npc);
```

<hr>
<h3>Permissions Management</h3>

```ts
import permissions from "../systems/permissions";
```

<h5>permissions.clear();</h5>
<p style="font-size:0.75em;">Clears a player's permissions</p>

```ts
await permissions.clear(username);
```

<h5>permissions.get();</h5>
<p style="font-size:0.75em;">Fetches a player's permissions</p>

```ts
await permissions.get(username);
``` 

<h5>permissions.add();</h5>
<p style="font-size:0.75em;">Adds a permission to a player</p>

```ts
await permissions.add(username, permission);
```

<h5>permissions.remove();</h5>
<p style="font-size:0.75em;">Removes a permission from a player</p>

```ts
await permissions.remove(username, permission);
``` 

<h5>permissions.set();</h5>
<p style="font-size:0.75em;">Sets a player's permissions</p>

```ts
await permissions.set(username, permissions);
``` 

<h5>permissions.list();</h5>
<p style="font-size:0.75em;">Lists all permissions</p>

```ts
await permissions.list();
```

<hr>
<h3>Particle Management</h3>

```ts
import particle from "../systems/particles";
```

<h5>Structure</h5>

```ts
declare interface Particle {
  name: string | null;
  size: number;
  color: string | null;
  velocity: {
      x: number;
      y: number;
  };
  lifetime: number;
  scale: number;
  opacity: number;
  visible: boolean;
  gravity: {
      x: number;
      y: number;
  };
  localposition: {
    x: number | 0;
    y: number | 0;
  } | null;
  interval: number;
  amount: number;
  staggertime: number;
  currentLife: number | null;
  initialVelocity: {
    x: number;
    y: number;
  } | null;
  spread: {
    x: number;
    y: number;
  };
  weather: WeatherData | 'none';
}
```

<h5>particle.add();</h5>
<p style="font-size:0.75em;">Adds a particle to the particle database</p>

```ts
await particle.add(particle);
```

<h5>particle.remove();</h5>
<p style="font-size:0.75em;">Removes a particle from the particle database</p>

```ts
await particle.remove(particle);
```

<h5>particle.find();</h5>
<p style="font-size:0.75em;">Fetches a particle from the particle database</p>

```ts
await particle.find(particle);
```

<h5>particle.update();</h5>
<p style="font-size:0.75em;">Updates a particle in the particle database</p>

```ts
await particle.update(particle);
```

<h5>particle.list();</h5>
<p style="font-size:0.75em;">Lists all particles in the particle database</p>

```ts
await particle.list();
```

<hr>
<h3>Weather Management</h3>

```ts
import weather from "../systems/weather";
```

<h5>Structure</h5>

```ts
declare interface WeatherData {
  name: string;
  temperature: number;
  humidity: number;
  wind_speed: number;
  wind_direction: string;
  precipitation: number;
  ambience: number;
}
```

<h5>weather.add();</h5>
<p style="font-size:0.75em;">Adds a weather to the weather database</p>

```ts 
await weather.add(weather);
```

<h5>weather.remove();</h5>
<p style="font-size:0.75em;">Removes a weather from the weather database</p>

```ts
await weather.remove(weather);
```

<h5>weather.find();</h5>
<p style="font-size:0.75em;">Fetches a weather from the weather database</p>

```ts
await weather.find(weather);
```

<h5>weather.update();</h5>
<p style="font-size:0.75em;">Updates a weather in the weather database</p>  

```ts
await weather.update(weather);
``` 

<h5>weather.list();</h5>
<p style="font-size:0.75em;">Lists all weathers in the weather database</p>

```ts
await weather.list();
```

<hr>
<h3>World Management</h3>

```ts
import world from "../systems/worlds";
```

<h5>Structure</h5>

```ts
declare interface WorldData {
  name: string;
  weather: string;
  max_players: number;
  default_map: string;
}
```

<h5>world.add();</h5>
<p style="font-size:0.75em;">Adds a world to the world database</p>

```ts
await world.add(world);
```

<h5>world.remove();</h5>
<p style="font-size:0.75em;">Removes a world from the world database</p>

```ts
await world.remove(world);
```

<h5>world.find();</h5>
<p style="font-size:0.75em;">Fetches a world from the world database</p>

```ts
await world.find(world);
```

<h5>world.update();</h5>
<p style="font-size:0.75em;">Updates a world in the world database</p>

```ts
await world.update(world);
```

<h5>world.list();</h5>
<p style="font-size:0.75em;">Lists all worlds in the world database</p>

```ts
await world.list();
```

<h5>world.getCurrentWeather();</h5>
<p style="font-size:0.75em;">Fetches the current weather for a world</p>

```ts
await world.getCurrentWeather(world);
```

<h5>world.getMaxPlayers();</h5>
<p style="font-size:0.75em;">Fetches the max players for a world</p>

```ts
await world.getMaxPlayers(world);
```

<hr>
<h3>Quest Management</h3>

```ts
import quest from "../systems/quests";
```

<h5>Structure</h5>

```ts
declare interface Quest {
  id: number;
  name: string;
  description: string;
  reward: number;
  xp_gain: number;
  required_quest: number;
  required_level: number;
}
```

<h5>quest.add();</h5>
<p style="font-size:0.75em;">Adds a quest to the quest database</p>

```ts
await quest.add(quest);
```

<h5>quest.remove();</h5>
<p style="font-size:0.75em;">Removes a quest from the quest database</p>  

```ts
await quest.remove(id);
```

<h5>quest.find();</h5>
<p style="font-size:0.75em;">Fetches a quest from the quest database</p>

```ts
await quest.find(id);
```

<h5>quest.update();</h5>
<p style="font-size:0.75em;">Updates a quest in the quest database</p>

```ts
await quest.update(quest);
```

<h5>quest.list();</h5>
<p style="font-size:0.75em;">Lists all quests in the quest database</p>

```ts
await quest.list();
```
  
<hr>
<h3>Quest Log Management</h3>

```ts
import questlog from "../systems/questlog";
```

<h5>Structure</h5>

```ts
declare interface QuestLogData {
  completed: number[];
  incomplete: number[];
}
```

<h5>questlog.get();</h5>
<p style="font-size:0.75em;">Fetches a player's quest log</p>

```ts
await questlog.get(username);
```

<h5>questlog.startQuest();</h5>
<p style="font-size:0.75em;">Starts a quest for a player</p>

```ts
await questlog.startQuest(username, id);
```

<h5>questlog.completeQuest();</h5>
<p style="font-size:0.75em;">Completes a quest for a player</p>

```ts
await questlog.completeQuest(username, id);
```

<h5>questlog.updateQuestLog();</h5>
<p style="font-size:0.75em;">Updates a player's quest log</p>

```ts
await questlog.updateQuestLog(username, questLog);
```

<hr>
<h3>Friend Management</h3>

```ts
import friends from "../systems/friends";
```

<h5>friends.list();</h5>
<p style="font-size:0.75em;">Lists a players friends</p>

```ts
await friends.list(username);
```

<h5>friends.add();</h5>
<p style="font-size:0.75em;">Adds a friend to the players friends list</p>

```ts
await friends.add(username, friend_username);
```

<h5>friends.remove();</h5>
<p style="font-size:0.75em;">Remove a friend to the players friends list</p>

```ts
await friends.remove(username, friend_username);
```

<hr>
<h3>Party Management</h3>

```ts
import parties from "../systems/parties";
```

<h5>parties.isInParty();</h5>
<p style="font-size:0.75em;">Checks if a player is in a party</p>

```ts
await parties.isInParty(username);
```

<h5>parties.isPartyLeader();</h5>
<p style="font-size:0.75em;">Checks if a player is a party leader</p>

```ts
await parties.isPartyLeader(username);
```

<h5>parties.getPartyId();</h5>
<p style="font-size:0.75em;">Fetches the players party id</p>

```ts
await parties.getPartyId(username);
```

<h5>parties.getPartyMembers();</h5>
<p style="font-size:0.75em;">Fetches party members</p>

```ts
await parties.getPartyMembers(party_id);
```

<h5>parties.getPartyLeader();</h5>
<p style="font-size:0.75em;">Fetches the party leader</p>

```ts
await parties.getPartyLeader(party_id);
```

<h5>parties.add();</h5>
<p style="font-size:0.75em;">Adds a player to a party</p>

```ts
await parties.add(username, party_id);
```

<h5>parties.remove();</h5>
<p style="font-size:0.75em;">Removes a player from a party</p>

```ts
await parties.remove(username);
```

<h5>parties.delete();</h5>
<p style="font-size:0.75em;">Deletes a party</p>

```ts
await parties.delete(party_id);
```

<h5>parties.create();</h5>
<p style="font-size:0.75em;">Creates an initial party with a leader and another player</p>

```ts
await parties.create(leader, member);
```

<h5>parties.leave();</h5>
<p style="font-size:0.75em;">Forces a player to leave their party</p>

```ts
await parties.leave(username);
```

<hr>
<h3>Currency Management</h3>

```ts
import currency from "../systems/currency";
```

<h5>Structure</h5>

```ts
declare interface Currency {
  copper: number;
  silver: number;
  gold: number;
}
```

<h5>currency.get();</h5>
<p style="font-size:0.75em;">Gets a players currency</p>

```ts
await currency.get(username);
```

<h5>currency.add();</h5>
<p style="font-size:0.75em;">Adds currency to a player</p>

```ts
await currency.add(username, currency);
```

<h5>currency.remove();</h5>
<p style="font-size:0.75em;">Removes currency from a player</p>

```ts
await currency.remove(username, currency);
```

<h5>currency.set();</h5>
<p style="font-size:0.75em;">Sets a players currency</p>

```ts
await currency.set(username, currency);
```