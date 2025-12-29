import query from "../controllers/sqldatabase";
import { verify, randomBytes } from "../modules/hash";
import log from "../modules/logger";
import assetCache from "../services/assetCache";
import * as settings from "../config/settings.json";
const defaultMap = settings.default_map?.replace(".json", "") || "main";
const mapCache: Map<
  string,
  {
    warps: Record<string, WarpObject>;
    collisionRLE?: number[];
    grid?: Uint8Array;
    width: number;
    height: number;
    tileWidth: number;
    tileHeight: number;
  }
> = new Map();

// Helper function to query RLE data directly without decompressing entire array
// RLE format: [width, height, value1, count1, value2, count2, ...]
function queryRLE(rleData: number[], targetIndex: number): number {
  if (!rleData || rleData.length < 2) return 0;

  let currentIndex = 0;

  // Skip width and height, start at index 2
  for (let i = 2; i < rleData.length; i += 2) {
    const value = rleData[i];
    const count = rleData[i + 1];

    // Check if target index falls within this RLE segment
    if (currentIndex + count > targetIndex) {
      return value;
    }

    currentIndex += count;
  }

  return 0; // Out of bounds or not found
}

// Bresenham's line algorithm to check for direct line-of-sight between two points
// This checks if there are any collision tiles directly blocking the straight line path
async function hasLineOfSight(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  map: string,
  maxDistance: number = 200 // Max search distance in pixels
): Promise<boolean> {
  const mapKey = map.replace(".json", "");

  // Check if distance exceeds max
  const distance = Math.sqrt(Math.pow(endX - startX, 2) + Math.pow(endY - startY, 2));
  if (distance > maxDistance) return false;

  // Load map from cache
  let mapDataCached = mapCache.get(mapKey);
  if (!mapDataCached) {
    const mapProperties = (await assetCache.get("mapProperties")) as MapProperties[];
    const mapData = mapProperties?.find((m: any) => m.name.replace(".json", "") === mapKey);
    if (!mapData) return false; // No map data, can't determine path

    const collisionData = await assetCache.getNested(mapKey, "collision");
    if (!collisionData || !Array.isArray(collisionData)) return false;

    mapDataCached = {
      warps: Array.isArray(mapData.warps)
        ? Object.fromEntries(
            (mapData.warps as WarpObject[]).map((warp, idx) => [warp.name ?? String(idx), warp])
          )
        : (mapData.warps || {}),
      collisionRLE: collisionData,
      width: collisionData[0],
      height: collisionData[1],
      tileWidth: mapData.tileWidth,
      tileHeight: mapData.tileHeight,
    };

    mapCache.set(mapKey, mapDataCached);
  }

  const { collisionRLE, width, height, tileWidth, tileHeight } = mapDataCached;

  if (!collisionRLE) return false;

  // Convert world coordinates to tile coordinates
  const startTileX = Math.floor(startX / tileWidth);
  const startTileY = Math.floor(startY / tileHeight);
  const endTileX = Math.floor(endX / tileWidth);
  const endTileY = Math.floor(endY / tileHeight);

  // Check if start or end tiles are out of bounds
  if (startTileX < 0 || startTileY < 0 || startTileX >= width || startTileY >= height) return false;
  if (endTileX < 0 || endTileY < 0 || endTileX >= width || endTileY >= height) return false;

  // Bresenham's line algorithm to check all tiles along the straight line
  const dx = Math.abs(endTileX - startTileX);
  const dy = Math.abs(endTileY - startTileY);
  const sx = startTileX < endTileX ? 1 : -1;
  const sy = startTileY < endTileY ? 1 : -1;
  let err = dx - dy;

  let currentX = startTileX;
  let currentY = startTileY;

  while (true) {
    // Check if current tile has collision
    if (currentX >= 0 && currentX < width && currentY >= 0 && currentY < height) {
      const tileIndex = currentY * width + currentX;
      const tileValue = queryRLE(collisionRLE, tileIndex);

      // If we hit a collision tile (non-zero), line of sight is blocked
      if (tileValue !== 0) {
        return false;
      }
    }

    // Check if we reached the end
    if (currentX === endTileX && currentY === endTileY) {
      break;
    }

    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      currentX += sx;
    }
    if (e2 < dx) {
      err += dx;
      currentY += sy;
    }
  }

  return true; // No collisions found along the line
}

const player = {
  clear: async () => {
    // Clear all session_ids, set online to 0, and clear all tokens
    await query(
      "UPDATE accounts SET session_id = NULL, online = 0, token = NULL, verified = 0, verification_code = NULL, party_id = NULL"
    );
    // Truncate the parties table
    if (process.env.DATABASE_ENGINE === "sqlite") {
      await query("DELETE FROM parties");
    } else {
      await query("TRUNCATE TABLE parties");
    }

    // Clear stats of guest accounts
    await query("DELETE FROM stats WHERE username IN (SELECT username FROM accounts WHERE guest_mode = 1)");
    // Clear client configs of guest accounts
    await query("DELETE FROM clientconfig WHERE username IN (SELECT username FROM accounts WHERE guest_mode = 1)");
    // Clear quest logs of guest accounts
    await query("DELETE FROM quest_log WHERE username IN (SELECT username FROM accounts WHERE guest_mode = 1)");
    // Clear currency of guest accounts
    await query("DELETE FROM currency WHERE username IN (SELECT username FROM accounts WHERE guest_mode = 1)");
    // Clear collectables of guest accounts
    await query("DELETE FROM collectables WHERE username IN (SELECT username FROM accounts WHERE guest_mode = 1)");
    // Clear all guest accounts
    await query("DELETE FROM accounts WHERE guest_mode = 1");
  },
  register: async (
    username: string,
    password_hash: string,
    email: string,
    req: any,
    guest: boolean
  ) => {
    if (!username || !password_hash || !email)
      return { error: "Missing fields" };
    username = username.toLowerCase();
    email = email.toLowerCase();

    if (!guest && username.startsWith("guest_"))
      return { error: "Username cannot start with 'guest_'" };

    // Check if the user exists by username
    const usernameExists = (await player.findByUsername(username)) as string[];
    if (usernameExists && usernameExists.length != 0)
      return { error: "Username already exists" };

    // Check if the user exists by email
    const emailExists = (await player.findByEmail(email)) as string[];
    if (emailExists && emailExists.length != 0)
      return { error: "Email already exists" };

    const response = await query(
      "INSERT INTO accounts (email, username, token, password_hash, ip_address, geo_location, map, position, guest_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        email,
        username,
        "", // empty token
        password_hash,
        req.ip,
        req.headers["cf-ipcountry"],
        defaultMap,
        "0,0",
        guest ? 1 : 0,
      ]
    ).catch((err) => {
      log.error(err);
      return { error: "An unexpected error occurred" };
    });
    if (!response) return { error: "An unexpected error occurred" };

    // Create stats
    await query(
      "INSERT INTO stats (username, health, max_health, stamina, max_stamina, xp, max_xp, level, crit_chance, crit_damage) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [username, 100, 100, 100, 100, 0, 100, 1, 10, 10]
    );
    // Create client config
    await query(
      "INSERT INTO clientconfig (username, fps, music_volume, effects_volume, muted) VALUES (?, ?, ?, ?, ?)",
      [username, 60, 50, 50, 0]
    );
    // Create quest log
    await query("INSERT INTO quest_log (username) VALUES (?)", [username]);
    // Create currency
    await query(
      "INSERT INTO currency (username, copper, silver, gold) VALUES (?, ?, ?, ?)",
      [username, 0, 0, 0]
    );

    // Insert default mount
    await query("INSERT INTO collectables (type, item, username) VALUES (?, ?, ?)", ["mount", "horse", username]);
    return username;
  },
  verify: async (session_id: string) => {
    // Check if there is a verification code
    const response = (await query(
      "SELECT verified FROM accounts WHERE session_id = ?",
      [session_id]
    )) as any[];
    // If a verification code exists, prevent the user from logging in until they verify their account
    if (response[0]?.verified) return true;
    return false;
  },
  findByUsername: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = await query(
      "SELECT username FROM accounts WHERE username = ?",
      [username]
    );
    return response || [];
  },
  findPlayerInDatabase: async (username?: string, id?: string) => {
    if (!username && !id) return;
    if (username) username = username.toLowerCase();
    const response = await query(
      "SELECT username, banned FROM accounts WHERE username = ? OR session_id = ?",
      [username, id]
    );
    return response || [];
  },
  findByEmail: async (email: string) => {
    if (!email) return;
    const response = await query("SELECT email FROM accounts WHERE email = ?", [
      email,
    ]);
    return response;
  },
  getLocation: async (player: Player) => {
    const username = player.username || player.id;
    const response = (await query(
      "SELECT map, position, direction FROM accounts WHERE username = ? OR session_id = ?",
      [username, username]
    )) as LocationData[];
    const map = response[0]?.map as string;
    const position: PositionData = {
      x: Number(response[0]?.position?.split(",")[0]),
      y: Number(response[0]?.position?.split(",")[1]),
      direction: response[0]?.direction || "down",
    };

    if (
      !map ||
      (!position.x && position.x.toString() != "0") ||
      (!position.y && position.y.toString() != "0")
    ) {
      return null;
    }

    return { map, position };
  },
  setLocation: async (
    session_id: string,
    map: string,
    position: PositionData
  ) => {
    if (!session_id || !map || !position) return;
    const response = await query(
      "UPDATE accounts SET map = ?, position = ?, direction = ? WHERE session_id = ?",
      [map, `${position.x},${position.y}`, position.direction, session_id]
    );
    return response;
  },
  setSessionId: async (
    token: string,
    sessionId: string
  ): Promise<boolean | string> => {
    if (!token || !sessionId) return false;
    const getUsername = (await player.getUsernameByToken(token)) as any[];
    const username = getUsername[0]?.username as string;
    if (!username) return false;

    const isBanned = (await player.isBanned(username)) as any[] | undefined;
    if (!isBanned) return false;

    if (isBanned[0]?.banned === 1) {
      log.debug(`User ${username} is banned`);
      await player.logout(sessionId);
      return false;
    }

    // Check if there's an existing session and kick it
    const existingSessionResult = await query(
      "SELECT session_id FROM accounts WHERE username = ?",
      [username]
    ) as any[];

    const existingSessionId = existingSessionResult[0]?.session_id;
    if (existingSessionId && existingSessionId !== sessionId) {
      // Close the existing WebSocket connection
      log.info(`Kicking existing session for ${username}`);

      // Import playerCache to get the WebSocket
      const playerCache = (await import("../services/playermanager.ts")).default;
      const existingPlayer = playerCache.get(existingSessionId);

      if (existingPlayer && existingPlayer.ws) {
        // Send a notification and close the connection
        const packetManager = (await import("../socket/packet_manager.ts")).packetManager;
        const sendPacket = (ws: any, packet: any) => {
          if (ws.readyState === 1) ws.send(packet);
        };

        // Notify the existing player they're being kicked
        sendPacket(existingPlayer.ws, packetManager.notify({
          message: "You have been logged in from another location."
        }));

        // Notify all other players to remove this player (prevent ghost)
        const map = existingPlayer.location?.map;
        if (map) {
          const playersInMap = Object.values(playerCache.list()).filter(
            (p) => p.location?.map === map && p.id !== existingPlayer.id
          );

          playersInMap.forEach((p) => {
            sendPacket(p.ws, packetManager.disconnect(existingPlayer.id));
          });
        }

        // Close and cleanup after a delay to ensure all packets are sent
        setTimeout(() => {
          // Remove from playerCache
          playerCache.remove(existingSessionId);

          // Close the WebSocket
          if (existingPlayer.ws && existingPlayer.ws.readyState === 1) {
            existingPlayer.ws.close(1000, "Logged in from another location");
          }
        }, 500);
      }

      // Logout the session from database
      await player.logout(existingSessionId);

      // Wait a bit longer to ensure cleanup is complete before new session starts
      await new Promise(resolve => setTimeout(resolve, 600));
    }

    await query(
      "UPDATE accounts SET session_id = ?, online = ? WHERE token = ?",
      [sessionId, 1, token]
    );

    return true;
  },
  getSessionId: async (token: string) => {
    if (!token) return;
    const response = await query(
      "SELECT session_id FROM accounts WHERE token = ?",
      [token]
    );
    return response;
  },
  logout: async (session_id: string) => {
    if (!session_id) return;
    const response = await query(
      "UPDATE accounts SET token = NULL, online = ?, session_id = NULL, verification_code = NULL, verified = ? WHERE session_id = ?",
      [0, 0, session_id]
    );
    return response;
  },
  clearSessionId: async (session_id: string) => {
    if (!session_id) return;
    const response = await query(
      "UPDATE accounts SET session_id = NULL, online = ? WHERE session_id = ?",
      [0, session_id]
    );
    return response;
  },
  login: async (username: string, password: string) => {
    if (!username || !password) return;
    username = username.toLowerCase();
    // Validate credentials
    const response = (await query(
      "SELECT username, banned, token, password_hash FROM accounts WHERE username = ?",
      [username]
    )) as {
      username: string;
      banned: number;
      token: string;
      password_hash: string;
    }[];
    if (response.length === 0 || response[0].banned === 1) {
      log.debug(`User ${username} failed to login`);
      return;
    }

    // Verify password
    const isValid = await verify(password, response[0].password_hash);
    if (!isValid) {
      log.debug(`User ${username} failed to login`);
      return;
    }

    // Use existing token and check validity or generate new one
    const token = response[0].token || (await player.setToken(username));

    log.debug(`User ${username} logged in`);
    // Update last_login
    await query(
      "UPDATE accounts SET last_login = CURRENT_TIMESTAMP WHERE username = ?",
      [username]
    );
    return token;
  },
  getUsernameBySession: async (session_id: string) => {
    if (!session_id) return;
    const response = await query(
      "SELECT username, id FROM accounts WHERE session_id = ?",
      [session_id]
    );
    return response;
  },
  getSessionIdByUsername: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = (await query(
      "SELECT session_id FROM accounts WHERE username = ?",
      [username]
    )) as any;
    return response[0]?.session_id;
  },
  getPartyIdByUsername: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = (await query(
      "SELECT party_id FROM accounts WHERE username = ?",
      [username]
    )) as any;
    return response[0]?.party_id;
  },
  getUsernameByToken: async (token: string) => {
    if (!token) return;
    const response = await query(
      "SELECT username FROM accounts WHERE token = ?",
      [token]
    );
    return response;
  },
  getEmail: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = (await query(
      "SELECT email FROM accounts WHERE username = ?",
      [username]
    )) as any;
    return response[0]?.email;
  },
  returnHome: async (session_id: string) => {
    if (!session_id) return;
    const response = await query(
      "UPDATE accounts SET map = ?, position = '0,0' WHERE session_id = ?",
      [defaultMap, session_id]
    );
    return response;
  },
  setToken: async (username: string) => {
    const token = randomBytes(32);
    if (!username || !token) return;
    // Store the token value in the database
    const response = await query(
      "UPDATE accounts SET token = ? WHERE username = ?",
      [token, username]
    );
    if (!response) return;
    // Return the hashed token for client use
    return token;
  },
  isOnline: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = await query(
      "SELECT online FROM accounts WHERE username = ?",
      [username]
    );
    return response;
  },
  isBanned: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = await query(
      "SELECT banned FROM accounts WHERE username = ?",
      [username]
    );
    return response;
  },
  getPlayers: async (map: string) => {
    if (!map) return;
    const response = await query(
      "SELECT username, session_id as id, position, map FROM accounts WHERE online = 1 and map = ?",
      [map]
    );
    return response;
  },
  getMap: async (session_id: string) => {
    if (!session_id) return;
    const response = (await query(
      "SELECT map FROM accounts WHERE session_id = ?",
      [session_id]
    )) as any;
    return response[0]?.map as string;
  },
  isAdmin: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = (await query(
      "SELECT role FROM accounts WHERE username = ?",
      [username]
    )) as any;
    return response[0]?.role === 1;
  },
  isGuest: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = (await query(
      "SELECT guest_mode FROM accounts WHERE username = ?",
      [username]
    )) as any;
    return response[0]?.guest_mode === 1;
  },
  toggleAdmin: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = (await query(
      "UPDATE accounts SET role = !role WHERE username = ?",
      [username]
    )) as any;
    if (!response) return;
    const admin = await player.isAdmin(username);
    // Remove stealth status if the player is not an admin and is stealth
    if (!admin)
      (await query(
        "UPDATE accounts SET stealth = 0, noclip = 0 WHERE username = ?",
        [username]
      )) as any;
    log.debug(`${username} admin status has been updated to ${admin}`);
    return admin;
  },
  isStealth: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = (await query(
      "SELECT stealth FROM accounts WHERE username = ?",
      [username]
    )) as any;
    return response[0]?.stealth === 1;
  },
  toggleStealth: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    (await query(
      "UPDATE accounts SET stealth = CASE WHEN stealth = 1 THEN 0 ELSE 1 END WHERE username = ? AND role = 1",
      [username]
    )) as any;
    return await player.isStealth(username);
  },
  isNoclip: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = (await query(
      "SELECT noclip FROM accounts WHERE username = ?",
      [username]
    )) as any;
    return response[0]?.noclip === 1;
  },
  toggleNoclip: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    (await query(
      "UPDATE accounts SET noclip = CASE WHEN noclip = 1 THEN 0 ELSE 1 END WHERE username = ?",
      [username]
    )) as any;
    return await player.isNoclip(username);
  },
  getSession: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = (await query(
      "SELECT session_id FROM accounts WHERE username = ?",
      [username]
    )) as any;
    return response[0]?.session_id;
  },
  getStats: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = (await query(
      "SELECT max_health, health, max_stamina, stamina, xp, max_xp, level, crit_chance, crit_damage FROM stats WHERE username = ?",
      [username]
    )) as StatsData[];
    if (!response || response.length === 0) return [];
    return {
      health: response[0].health,
      max_health: response[0].max_health,
      stamina: response[0].stamina,
      max_stamina: response[0].max_stamina,
      level: response[0].level,
      xp: response[0].xp,
      max_xp: response[0].max_xp,
      crit_chance: response[0].crit_chance,
      crit_damage: response[0].crit_damage,
    };
  },
  setStats: async (username: string, stats: StatsData) => {
    if (!username) return;
    username = username.toLowerCase();
    if (
      !stats.health ||
      !stats.max_health ||
      !stats.stamina ||
      !stats.max_stamina
    )
      return;
    const response = await query(
      "UPDATE stats SET health = ?, max_health = ?, stamina = ?, max_stamina = ? WHERE username = ?",
      [
        stats.health,
        stats.max_health,
        stats.stamina,
        stats.max_stamina,
        username,
      ]
    );
    if (!response) return [];
    return response;
  },
  increaseXp: async (username: string, xp: number) => {
    if (!username) return;
    username = username.toLowerCase();
    // Get the current xp, level and max_xp
    const stats = (await player.getStats(username)) as StatsData;
    let leveledUp = false;
    // Loop to handle multiple level-ups
    while (xp > 0) {
      const xpToLevel = stats.max_xp - stats.xp;
      if (xp >= xpToLevel) {
        stats.level++;
        xp -= xpToLevel;
        stats.xp = 0;
        leveledUp = true;
        // Update the max_xp required to level up dynamically
        stats.max_xp = player.getNewMaxXp(stats.level);
        // Calculate new max health and stamina based on level
        stats.max_health = player.getMaxHealthForLevel(stats.level);
        stats.max_stamina = player.getMaxStaminaForLevel(stats.level);
        // Restore health and stamina to full on level up
        stats.health = stats.max_health;
        stats.stamina = stats.max_stamina;
      } else {
        stats.xp += xp;
        xp = 0;
      }
    }
    // Update the xp, level, and stats in the database
    const response = await query(
      leveledUp
        ? "UPDATE stats SET xp = ?, max_xp = ?, level = ?, max_health = ?, health = ?, max_stamina = ?, stamina = ? WHERE username = ?"
        : "UPDATE stats SET xp = ?, max_xp = ?, level = ? WHERE username = ?",
      leveledUp
        ? [stats.xp, stats.max_xp, stats.level, stats.max_health, stats.health, stats.max_stamina, stats.stamina, username]
        : [stats.xp, stats.max_xp, stats.level, username]
    );
    if (!response) return [];
    return {
      xp: stats.xp,
      level: stats.level,
      max_xp: stats.max_xp,
    };
  },
  getNewMaxXp: (level: number) => {
    return Math.floor(100 * Math.pow(1.1, level - 1));
  },
  getMaxHealthForLevel: (level: number) => {
    // Formula: base_hp + (level^1.5 * 5)
    // At level 1: 100 + (1^1.5 * 5) = 105
    // At level 5: 100 + (5^1.5 * 5) = 156
    // At level 10: 100 + (10^1.5 * 5) = 258
    const baseHealth = 100;
    return Math.floor(baseHealth + Math.pow(level, 1.5) * 5);
  },
  getMaxStaminaForLevel: (level: number) => {
    // Formula: base_mana + (level^1.5 * 3)
    // At level 1: 100 + (1^1.5 * 3) = 103
    // At level 5: 100 + (5^1.5 * 3) = 134
    // At level 10: 100 + (10^1.5 * 3) = 195
    const baseStamina = 100;
    return Math.floor(baseStamina + Math.pow(level, 1.5) * 3);
  },
  increaseLevel: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = await query(
      "UPDATE stats SET level = level + 1 WHERE username = ?",
      [username]
    );
    return response;
  },
  getConfig: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = await query(
      "SELECT * FROM clientconfig WHERE username = ?",
      [username]
    );
    return response || [];
  },
  setConfig: async (session_id: string, data: any) => {
    if (!session_id) return;
    if (
      !data.fps ||
      typeof data.music_volume != "number" ||
      typeof data.effects_volume != "number" ||
      typeof data.muted != "boolean"
    )
      return [];
    const result = (await query(
      "SELECT username FROM accounts WHERE session_id = ?",
      [session_id]
    )) as any;
    if (!result[0].username) return [];
    const response = await query(
      "UPDATE clientconfig SET fps = ?, music_volume = ?, effects_volume = ?, muted = ? WHERE username = ?",
      [
        data.fps,
        data.music_volume || 0,
        data.effects_volume || 0,
        data.muted,
        result[0].username,
      ]
    );
    if (!response) return [];
    return response;
  },
  isInPvPZone: async (
    map: string,
    position: PositionData,
    playerProperties: PlayerProperties
  ) => {
    const playerWidth = playerProperties.width || 32;
    const playerHeight = playerProperties.height || 32;

    const mapKey = map.replace(".json", "");

    // Fetch PvP tile data from Redis hash
    const pvpData = await assetCache.getNested(mapKey, "nopvp");
    // If no nopvp data exists, PVP is allowed by default
    if (!pvpData || !Array.isArray(pvpData) || pvpData.length < 3) return true;

    // Fetch map properties (can be stored as a hash or a string)
    const mapPropertiesRaw = await assetCache.get("mapProperties") as MapProperties[];
    if (!mapPropertiesRaw) return true; // Allow PVP if map properties not found

    const mapData = mapPropertiesRaw.find(m => m.name.replace(".json", "") === mapKey);
    if (!mapData) return true; // Allow PVP if specific map data not found
    const tileWidth = mapData.tileWidth;
    const tileHeight = mapData.tileHeight;

    // Convert world coordinates to tile coordinates
    // position.x and position.y are the CENTER of the player sprite
    // Player sprite: 24px wide, 40px tall
    const margin = 0.1;

    // Horizontal collision: center ± half width
    const left = Math.floor((position.x - playerWidth / 2 + margin) / tileWidth);
    const right = Math.floor((position.x + playerWidth / 2 - margin) / tileWidth);

    // Vertical collision: top half can overlap (start from middle), bottom at feet
    const top = Math.floor((position.y - playerHeight / 2 + playerHeight / 2 + margin) / tileHeight); // Start from vertical center
    const bottom = Math.floor((position.y + playerHeight / 2 - margin) / tileHeight); // End at bottom

    for (let tileY = top; tileY <= bottom; tileY++) {
      for (let tileX = left; tileX <= right; tileX++) {
        // Validate tile is within map bounds
        if (tileX < 0 || tileY < 0 || tileX >= mapData.width || tileY >= mapData.height) continue;

        const targetIndex = tileY * mapData.width + tileX;

        // Query RLE data directly without decompressing
        const tileValue = queryRLE(pvpData, targetIndex);

        if (tileValue !== 0) {
          return false; // No-PvP tile → cannot attack here
        }
      }
    }

    return true; // All tiles under player are PvP-enabled
  },
  checkIfWouldCollide: async function (
    map: string,
    position: PositionData,
    playerProperties: PlayerProperties,
    mapPropertiesCache?: any // Optional cached mapProperties to avoid Redis calls
  ) {
    const playerWidth = playerProperties.width || 32;
    const playerHeight = playerProperties.height || 32;
    const mapKey = map.replace(".json", "");

    // Load map from cache or Redis
    let mapDataCached = mapCache.get(mapKey);
    if (!mapDataCached) {
      // Use provided cache or fall back to Redis
      const mapProperties = mapPropertiesCache || (await assetCache.get("mapProperties")) as MapProperties[];
      const mapData = mapProperties.find((m: any) => m.name.replace(".json", "") === mapKey);
      if (!mapData) return { value: true, reason: "no_map_data" };

      let collisionData: any;
      try {
        const fetched = await assetCache.getNested(mapKey, "collision");
        collisionData = fetched !== undefined ? fetched : (await assetCache.get(mapKey))?.collision;
        if (!collisionData || !Array.isArray(collisionData)) return { value: true, reason: "no_collision_data" };
      } catch (err: any) {
        console.error(`[RedisDebug] Failed to fetch collision for ${mapKey}:`, err);
        return { value: true, reason: "redis_error" };
      }

      // Store RLE data directly, no decompression
      mapDataCached = {
        warps: Array.isArray(mapData.warps)
          ? Object.fromEntries(
              (mapData.warps as WarpObject[]).map((warp, idx) => [warp.name ?? String(idx), warp])
            )
          : (mapData.warps || {}),
        collisionRLE: collisionData, // Store RLE data directly
        width: collisionData[0], // Width from RLE header
        height: collisionData[1], // Height from RLE header
        tileWidth: mapData.tileWidth,
        tileHeight: mapData.tileHeight,
      };

      mapCache.set(mapKey, mapDataCached);
    }

    const { warps, collisionRLE, width, height, tileWidth, tileHeight } = mapDataCached;

    // Warp collision
    for (const key in warps) {
      const warp = warps[key];
      if (
        position.x + playerWidth > warp.position.x &&
        position.x < warp.position.x + warp.size.width &&
        position.y + playerHeight > warp.position.y &&
        position.y < warp.position.y + warp.size.height
      ) {
        return {
          value: true,
          reason: "warp_collision",
          warp: { map: warp.map, position: { x: warp.x, y: warp.y } },
        };
      }
    }

    // Tile collision - Convert world coordinates to tile coordinates
    // position.x and position.y are the CENTER of the player sprite
    // Player sprite: 24px wide, 40px tall
    // Collision box should be centered on sprite with pixel-perfect accuracy
    const margin = 0.1;

    // Horizontal collision: center ± half width
    const left = Math.floor((position.x - playerWidth / 2 + margin) / tileWidth);
    const right = Math.floor((position.x + playerWidth / 2 - margin) / tileWidth);

    // Vertical collision: top half can overlap (start from middle), bottom at feet
    const top = Math.floor((position.y - playerHeight / 2 + playerHeight / 2 + margin) / tileHeight); // Start from vertical center
    const bottom = Math.floor((position.y + playerHeight / 2 - margin) / tileHeight); // End at bottom

    for (let tileY = top; tileY <= bottom; tileY++) {
      for (let tileX = left; tileX <= right; tileX++) {
        // Validate tile is within map bounds
        if (tileX < 0 || tileY < 0 || tileX >= width || tileY >= height) continue;

        // Query RLE data directly without decompressing entire grid
        const tileIndex = tileY * width + tileX;
        const tileValue = collisionRLE ? queryRLE(collisionRLE, tileIndex) : 0;

        if (tileValue !== 0) return { value: true, reason: "tile_collision", tile: { x: tileX, y: tileY } };
      }
    }

    return { value: false, reason: "no_collision" };
  },
  kick: async (username: string, ws: WebSocket) => {
    const response = (await query(
      "SELECT session_id FROM accounts WHERE username = ?",
      [username]
    )) as any;
    if (response[0]?.session_id) {
      player.logout(response[0]?.session_id);
    }
    if (ws) ws.close();
  },
  ban: async (username: string, ws: WebSocket) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = await query(
      "UPDATE accounts SET banned = 1 WHERE username = ?",
      [username]
    );
    const session_id = (await player.getSession(username)) as any;
    if (session_id[0]?.session_id) {
      player.logout(session_id[0]?.session_id);
    }
    if (ws) ws.close();
    return response;
  },
  unban: async (username: string) => {
    if (!username) return;
    username = username.toLowerCase();
    const response = await query(
      "UPDATE accounts SET banned = 0 WHERE username = ?",
      [username]
    );
    return response;
  },
  canAttack: async (
    self: Player,
    target: Player,
    playerProperties: PlayerProperties,
    maxPathfindingDistance: number = 300
  ): Promise<{ value: boolean; reason?: string }> => {
    // No self or target or no range
    if (!self || !target) return { value: false, reason: "invalid" };

    // Prevent attacks on self
    if (self.id === target.id) return { value: false, reason: "self" };

    // Ensure self is not dead
    if (!self.stats || self.stats.health <= 0)
      return { value: false, reason: "dead" };

    // Check if the target is in the same map
    if (
      !self.location ||
      !target.location ||
      target.location.map !== self.location.map
    )
      return { value: false, reason: "different_map" };

    if (self.isStealth || target.isStealth)
      return { value: false, reason: "stealth" };

    // Check if facing the right direction
    const targetPosition = target.location.position as unknown as PositionData;
    const selfPosition = self.location.position as unknown as PositionData;
    const direction = selfPosition.direction;

    // Calculate angle between players
    const dx = targetPosition.x - selfPosition.x;
    const dy = targetPosition.y - selfPosition.y;
    const angle = Math.atan2(dy, dx) * (180 / Math.PI);

    // Check if player is facing the target based on direction
    const directionAngles = {
      up: angle > -135 && angle < -45,
      down: angle > 45 && angle < 135,
      left: angle > 135 || angle < -135,
      right: angle > -45 && angle < 45,
      upleft: angle > 135 || (angle > -180 && angle < -135),
      upright: angle > -135 && angle < -45,
      downleft: angle > 135 && angle < 180,
      downright: angle > 45 && angle < 135,
    };

    if (!directionAngles[direction as keyof typeof directionAngles])
      return { value: false, reason: "direction" };

    // Check if the target is in PvP zone
    const isPvpAllowedTarget = await player.isInPvPZone(
      self.location.map,
      targetPosition,
      playerProperties
    );
    if (!isPvpAllowedTarget) return { value: false, reason: "nopvp" };
    const isPvpAllowedSelf = await player.isInPvPZone(
      self.location.map,
      selfPosition,
      playerProperties
    );
    if (!isPvpAllowedSelf) return { value: false, reason: "nopvp" };

    // Check if there's a clear path (no collision blocking) between players using A* pathfinding
    const hasPath = await hasLineOfSight(
      selfPosition.x,
      selfPosition.y,
      targetPosition.x,
      targetPosition.y,
      self.location.map,
      maxPathfindingDistance
    );

    if (!hasPath) {
      return { value: false, reason: "path_blocked" };
    }

    return { value: true, reason: "pvp" };
  },
  findClosestPlayer: (
    self: Player,
    players: Player[],
    range: number
  ): NullablePlayer => {
    if (!players) return null;
    if (!self.location?.position) return null;

    let closestPlayer = null;
    let closestDistance = range;
    const selfPosition = self.location.position as unknown as PositionData;
    for (const player of players) {
      if (player.location) {
        const position = player.location.position as unknown as PositionData;
        const distance = Math.sqrt(
          Math.pow(selfPosition.x - position.x, 2) +
            Math.pow(selfPosition.y - position.y, 2)
        );
        if (player.isStealth) continue;
        if (distance < closestDistance) {
          closestDistance = distance;
          closestPlayer = player;
        }
      }
    }
    return closestPlayer;
  },
  canMount: (player: Player): boolean => {
    // Don't allow guest players to mount
    // if (player.isGuest) return false;
    if (!player || !player.stats) return false;
    // Optional level requirement to mount
    // if (player.stats.level < 5) return false;
    return true;
  },
  GetPlayerLoginData: async (username: string) => {
    if (!username) return null;
    username = username.toLowerCase();

    // Single optimized query to get all player data using JOINs
    const mainQuery = `
      SELECT
        a.id,
        a.username,
        a.map,
        a.position,
        a.direction,
        a.role,
        a.guest_mode,
        a.stealth,
        a.noclip,
        a.party_id,
        p.permissions,
        s.max_health,
        s.health,
        s.max_stamina,
        s.stamina,
        s.xp,
        s.max_xp,
        s.level,
        s.crit_chance,
        s.crit_damage,
        c.copper,
        c.silver,
        c.gold,
        f.friends,
        cc.fps,
        cc.music_volume,
        cc.effects_volume,
        cc.muted,
        ql.completed_quests,
        ql.incomplete_quests
      FROM accounts a
      LEFT JOIN permissions p ON a.username = p.username
      LEFT JOIN stats s ON a.username = s.username
      LEFT JOIN currency c ON a.username = c.username
      LEFT JOIN friendslist f ON a.username = f.username
      LEFT JOIN clientconfig cc ON a.username = cc.username
      LEFT JOIN quest_log ql ON a.username = ql.username
      WHERE a.username = ?
    `;

    const result = await query(mainQuery, [username]) as any[];
    if (!result || result.length === 0) return null;

    const data = result[0];

    return {
      id: data.id,
      username: data.username,
      location: {
        map: data.map,
        position: {
          x: Number(data.position?.split(",")[0] || 0),
          y: Number(data.position?.split(",")[1] || 0),
          direction: data.direction || "down"
        }
      },
      permissions: data.permissions || [],
      stats: {
        max_health: data.max_health,
        health: data.health,
        max_stamina: data.max_stamina,
        stamina: data.stamina,
        xp: data.xp,
        max_xp: data.max_xp,
        level: data.level,
        crit_chance: data.crit_chance,
        crit_damage: data.crit_damage
      },
      currency: {
        copper: data.copper || 0,
        silver: data.silver || 0,
        gold: data.gold || 0
      },
      friends: data.friends ? data.friends.split(",").map((f: string) => f.trim()).filter((f: string) => f !== "") : [],
      party_id: data.party_id,
      config: data.fps ? [{
        fps: data.fps,
        music_volume: data.music_volume,
        effects_volume: data.effects_volume,
        muted: data.muted
      }] : [],
      questlog: {
        completed: data.completed_quests ? data.completed_quests.split(",") : [],
        incomplete: data.incomplete_quests ? data.incomplete_quests.split(",") : []
      },
      isAdmin: data.role === 1,
      isGuest: data.guest_mode === 1,
      isStealth: data.stealth === 1,
      isNoclip: data.noclip === 1,
    };
  },
};

// Export function to clear map cache (used when maps are updated)
export function clearMapCache(mapName?: string) {
  if (mapName) {
    const mapKey = mapName.replace(".json", "");
    mapCache.delete(mapKey);
    log.info(`Cleared map cache for: ${mapKey}`);
  } else {
    mapCache.clear();
    log.info("Cleared all map caches");
  }
}

export default player;
