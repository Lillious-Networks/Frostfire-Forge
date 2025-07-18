import query from "../controllers/sqldatabase";
import { randomBytes, verify } from "../modules/hash";
import log from "../modules/logger";
import assetCache from "../services/assetCache";

const player = {
    clear: async () => {
        // Clear all session_ids, set online to 0, and clear all tokens
        await query("UPDATE accounts SET session_id = NULL, online = 0, token = NULL, verified = 0, verification_code = NULL, party_id = NULL");
        // Truncate the parties table
        if (process.env.DATABASE_ENGINE === "sqlite") {
            await query("DELETE FROM parties");
        } else {
            await query("TRUNCATE TABLE parties");
        }
    },
    register: async (username: string, password_hash: string, email: string, req: any) => {
        if (!username || !password_hash || !email) return { error: "Missing fields" };
        username = username.toLowerCase();
        email = email.toLowerCase();

        // Check if the user exists by username
        const usernameExists = await player.findByUsername(username) as string[];
        if (usernameExists && usernameExists.length != 0) return { error: "Username already exists" };

        // Check if the user exists by email
        const emailExists = await player.findByEmail(email) as string[];
        if (emailExists && emailExists.length != 0) return { error: "Email already exists" };

        const response = await query(
            "INSERT INTO accounts (email, username, token, password_hash, ip_address, geo_location, map, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [
              email,
              username,
              "", // empty token
              password_hash,
              req.ip,
              req.headers["cf-ipcountry"],
              "main",
              "0,0"
            ]
          ).catch((err) => {
            log.error(err);
            return { error: "An unexpected error occurred" };
          });
          if (!response) return { error: "An unexpected error occurred" };

        // Create stats
        await query("INSERT INTO stats (username, health, max_health, stamina, max_stamina, xp, max_xp, level) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [username, 100, 100, 100, 100, 0, 100, 1]);
        // Create client config
        await query("INSERT INTO clientconfig (username, fps, music_volume, effects_volume, muted) VALUES (?, ?, ?, ?, ?)", [username, 60, 50, 50, 0]);
        // Create quest log
        await query("INSERT INTO quest_log (username) VALUES (?)", [username]);
        return username;
    },
    verify: async (session_id: string) => {
        // Check if there is a verification code
        const response = await query("SELECT verified FROM accounts WHERE session_id = ?", [session_id]) as any[];
        // If a verification code exists, prevent the user from logging in until they verify their account
        if (response[0]?.verified) return true;
        return false;
    },
    findByUsername: async (username: string) => {
        if (!username) return;
        username = username.toLowerCase();
        const response = await query("SELECT username FROM accounts WHERE username = ?", [username]);
        return response || [];
    },
    findPlayerInDatabase: async (username?: string, id?: string) => {
        if (!username && !id) return;
        if (username) username = username.toLowerCase();
        const response = await query("SELECT username, banned FROM accounts WHERE username = ? OR session_id = ?", [username, id]);
        return response || [];
    },
    findByEmail: async (email: string) => {
        if (!email) return;
        const response = await query("SELECT email FROM accounts WHERE email = ?", [email]);
        return response;
    },
    getLocation: async (player: Player) => {
        const username = player.username || player.id;
        const response = await query("SELECT map, position, direction FROM accounts WHERE username = ? OR session_id = ?", [username, username]) as LocationData[];
        const map = response[0]?.map as string;
        const position: PositionData = {
            x: Number(response[0]?.position?.split(",")[0]),
            y: Number(response[0]?.position?.split(",")[1]),
            direction: response[0]?.direction || "down"
        };

        if (!map || (!position.x && position.x.toString() != '0') || (!position.y && position.y.toString() != '0')) {
            return null;
        }

        return { map, position };
    },
    setLocation: async (session_id: string, map: string, position: PositionData) => {
        if (!session_id || !map || !position) return;
        const response = await query("UPDATE accounts SET map = ?, position = ?, direction = ? WHERE session_id = ?", [map, `${position.x},${position.y}`, position.direction, session_id]);
        return response;
    },
    setSessionId: async (token: string, sessionId: string) => {
        if (!token || !sessionId) return;
        // Check if the user already has a session id       
        const sessionExists = await player.getSessionId(token) as any[];
        if (sessionExists[0]?.session_id) {
            if (sessionExists[0]?.session_id != sessionId) return;
        }
        const getUsername = await player.getUsernameByToken(token) as any[];
        const username = await getUsername[0]?.username as string;
        const isBanned = await player.isBanned(username) as any[] | undefined;
        if (!isBanned) return;
        const response = await query("UPDATE accounts SET session_id = ?, online = ? WHERE token = ?", [sessionId, 1, token]);
        if (isBanned[0]?.banned === 1) {
            log.debug(`User ${username} is banned`);
            await player.logout(sessionId);
            return;
        }
        return response;
    },
    getSessionId: async (token: string) => {
        if (!token) return;
        const response = await query("SELECT session_id FROM accounts WHERE token = ?", [token]);
        return response;
    },
    logout: async (session_id: string) => {
        if (!session_id) return;
        const response = await query("UPDATE accounts SET token = NULL, online = ?, session_id = NULL, verification_code = NULL, verified = ? WHERE session_id = ?", [0, 0, session_id]);
        return response;
    },
    clearSessionId: async (session_id: string) => {
        if (!session_id) return;
        const response = await query("UPDATE accounts SET session_id = NULL, online = ? WHERE session_id = ?", [0, session_id]);
        return response;
    },
    login: async (username: string, password: string) => {
        if (!username || !password) return;
        username = username.toLowerCase();
        // Validate credentials
        const response = await query("SELECT username, banned, token, password_hash FROM accounts WHERE username = ?", [username]) as { username: string, banned: number, token: string, password_hash: string }[];
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

        // Use existing token or generate new one
        const token = response[0].token || await player.setToken(username);

        log.debug(`User ${username} logged in`);
        // Update last_login
        await query("UPDATE accounts SET last_login = CURRENT_TIMESTAMP WHERE username = ?", [username]);
        return token;
    },
    getUsernameBySession: async (session_id: string) => {
        if (!session_id) return;
        const response = await query("SELECT username, id FROM accounts WHERE session_id = ?", [session_id]);
        return response;
    },
    getSessionIdByUsername: async (username: string) => {
        if (!username) return;
        username = username.toLowerCase();
        const response = await query("SELECT session_id FROM accounts WHERE username = ?", [username]) as any;
        return response[0]?.session_id;
    },
    getPartyIdByUsername: async (username: string) => {
        if (!username) return;
        username = username.toLowerCase();
        const response = await query("SELECT party_id FROM accounts WHERE username = ?", [username]) as any;
        return response[0]?.party_id;
    },
    getUsernameByToken: async (token: string) => {
        if (!token) return;
        const response = await query("SELECT username FROM accounts WHERE token = ?", [token]);
        return response;
    },
    getEmail: async (username: string) => {
        if (!username) return;
        username = username.toLowerCase();
        const response = await query("SELECT email FROM accounts WHERE username = ?", [username]) as any;
        return response[0]?.email;
    },
    returnHome: async (session_id: string) => {
        if (!session_id) return;
        const response = await query("UPDATE accounts SET map = 'main', position = '0,0' WHERE session_id = ?", [session_id]);
        return response;
    },
    setToken: async (username: string) => {
        const token = randomBytes(32);
        if (!username || !token) return;
        const response = await query("UPDATE accounts SET token = ? WHERE username = ?", [token, username]);
        if (!response) return;
        return token;
    },
    isOnline: async (username: string) => {
        if (!username) return;
        username = username.toLowerCase();
        const response = await query("SELECT online FROM accounts WHERE username = ?", [username]);
        return response;
    },
    isBanned: async (username: string) => {
        if (!username) return;
        username = username.toLowerCase();
        const response = await query("SELECT banned FROM accounts WHERE username = ?", [username]);
        return response;
    },
    getPlayers: async (map: string) => {
        if (!map) return;
        const response = await query("SELECT username, session_id as id, position, map FROM accounts WHERE online = 1 and map = ?", [map]);
        return response;
    },
    getMap: async (session_id: string) => {
        if (!session_id) return;
        const response = await query("SELECT map FROM accounts WHERE session_id = ?", [session_id]) as any;
        return response[0]?.map as string
    },
    isAdmin: async (username: string) => {
        if (!username) return;
        username = username.toLowerCase();
        const response = await query("SELECT role FROM accounts WHERE username = ?", [username]) as any;
        return response[0]?.role === 1;
    },
    toggleAdmin: async (username: string) => {
        if (!username) return;
        username = username.toLowerCase();
        const response = await query("UPDATE accounts SET role = !role WHERE username = ?", [username]) as any;
        if (!response) return;
        const admin = await player.isAdmin(username);
        // Remove stealth status if the player is not an admin and is stealth
        if (!admin) await query("UPDATE accounts SET stealth = 0, noclip = 0 WHERE username = ?", [username]) as any;
        log.debug(`${username} admin status has been updated to ${admin}`);
        return admin;
    },
    isStealth: async (username: string) => {
        if (!username) return;
        username = username.toLowerCase();
        const response = await query("SELECT stealth FROM accounts WHERE username = ?", [username]) as any;
        return response[0]?.stealth === 1;
    },
    toggleStealth: async (username: string) => {
        if (!username) return;
        username = username.toLowerCase();
        await query("UPDATE accounts SET stealth = CASE WHEN stealth = 1 THEN 0 ELSE 1 END WHERE username = ? AND role = 1", [username]) as any;
        return await player.isStealth(username);
    },
    isNoclip: async (username: string) => {
        if (!username) return;
        username = username.toLowerCase();
        const response = await query("SELECT noclip FROM accounts WHERE username = ?", [username]) as any;
        return response[0]?.noclip === 1;
    },
    toggleNoclip: async (username: string) => {
        if (!username) return;
        username = username.toLowerCase();
        await query("UPDATE accounts SET noclip = CASE WHEN noclip = 1 THEN 0 ELSE 1 END WHERE username = ?", [username]) as any;
        return await player.isNoclip(username);
    },
    getSession: async (username: string) => {
        if (!username) return;
        username = username.toLowerCase();
        const response = await query("SELECT session_id FROM accounts WHERE username = ?", [username]) as any;
        return response[0]?.session_id;
    },
    getStats: async (username: string) => {
        if (!username) return;
        username = username.toLowerCase();
        const response = await query("SELECT max_health, health, max_stamina, stamina, xp, max_xp, level FROM stats WHERE username = ?",
            [username]) as StatsData[];
        if (!response || response.length === 0) return [];
        return {
            health: response[0].health,
            max_health: response[0].max_health,
            stamina: response[0].stamina,
            max_stamina: response[0].max_stamina,
            level: response[0].level,
            xp: response[0].xp,
            max_xp: response[0].max_xp
        };
    },
    setStats: async (username: string, stats: StatsData) => {
        if (!username) return;
        username = username.toLowerCase();
        if (!stats.health || !stats.max_health || !stats.stamina || !stats.max_stamina) return;
        const response = await query("UPDATE stats SET health = ?, max_health = ?, stamina = ?, max_stamina = ? WHERE username = ?", [stats.health, stats.max_health, stats.stamina, stats.max_stamina, username]);
        if (!response) return [];
        return response;
    },
    increaseXp: async (username: string, xp: number) => {
        if (!username) return;
        username = username.toLowerCase();
        // Get the current xp, level and max_xp
        const stats = await player.getStats(username) as StatsData;
        // Loop to handle multiple level-ups
        while (xp > 0) {
            const xpToLevel = stats.max_xp - stats.xp;
            if (xp >= xpToLevel) {
                stats.level++;
                xp -= xpToLevel;
                stats.xp = 0;
                // Update the max_xp required to level up dynamically
                stats.max_xp = player.getNewMaxXp(stats.level);
            } else {
                stats.xp += xp;
                xp = 0;
            }
        }
        // Update the xp and level
        const response = await query("UPDATE stats SET xp = ?, max_xp = ?, level = ? WHERE username = ?", [stats.xp, stats.max_xp, stats.level, username]);
        if (!response) return [];
        return {
            xp: stats.xp,
            level: stats.level,
            max_xp: stats.max_xp
        }
    },
    getNewMaxXp: (level: number) => {
        return Math.floor(100 * Math.pow(1.1, level - 1));
    },
    increaseLevel: async (username: string) => {
        if (!username) return;
        username = username.toLowerCase();
        const response = await query("UPDATE stats SET level = level + 1 WHERE username = ?", [username]);
        return response;
    },
    getConfig: async (username: string) => {
        if (!username) return;
        username = username.toLowerCase();
        const response = await query("SELECT * FROM clientconfig WHERE username = ?", [username]);
        return response || [];
    },
    setConfig: async (session_id: string, data: any) => {
        if (!session_id) return;
        if (!data.fps || typeof data.music_volume != 'number' || typeof data.effects_volume != 'number' || typeof data.muted != 'boolean') return [];
        const result = await query("SELECT username FROM accounts WHERE session_id = ?", [session_id]) as any;
        if (!result[0].username) return [];
        const response = await query("UPDATE clientconfig SET fps = ?, music_volume = ?, effects_volume = ?, muted = ? WHERE username = ?", [data.fps, data.music_volume || 0, data.effects_volume || 0, data.muted, result[0].username]);
        if (!response) return [];
        return response;
    },
    isInPvPZone: (map: string, position: PositionData, playerProperties: PlayerProperties) => {
        const playerWidth = playerProperties.width || 32;
        const playerHeight = playerProperties.height || 32;

        const mapKey = map.replace(".json", "");
        const pvpData = assetCache.get(mapKey);
        const mapProperties = assetCache.get("mapProperties") as MapProperties[];
        const mapData = mapProperties.find(m => m.name.replace(".json", "") === mapKey);
        if (!mapData || !pvpData || !pvpData.nopvp) return false;

        const data = pvpData.nopvp;
        if (!Array.isArray(data) || data.length < 3) return false;

        const tileData = data.slice(2);
        const tileWidth = mapData.tileWidth;
        const tileHeight = mapData.tileHeight;
        const gridOffsetWidth = Math.floor(mapData.width / 2);
        const gridOffsetHeight = Math.floor(mapData.height / 2);

        const margin = 0.1;
        const adjustedX = position.x + tileWidth / 2;
        const adjustedY = position.y + tileHeight / 2;

        const left = Math.floor((adjustedX + margin) / tileWidth);
        const right = Math.floor((adjustedX + playerWidth - margin) / tileWidth);
        const top = Math.floor((adjustedY + margin) / tileHeight);
        const bottom = Math.floor((adjustedY + playerHeight - margin) / tileHeight);

        for (let y = top; y <= bottom; y++) {
            for (let x = left; x <= right; x++) {
                const indexX = x + gridOffsetWidth;
                const indexY = y + gridOffsetHeight;

                const targetIndex = (indexY * mapData.width) + indexX;
                let currentIndex = 0;
                let tileValue = 0;

                for (let i = 0; i < tileData.length; i += 2) {
                    const value = tileData[i];
                    const count = tileData[i + 1];

                    if (currentIndex + count > targetIndex) {
                        tileValue = value;
                        break;
                    }

                    currentIndex += count;
                }

                if (tileValue !== 0) {
                    return false; // Found a no-PvP tile → cannot attack here
                }
            }
        }

        return true; // All tiles under player are PvP-enabled
    },
    checkIfWouldCollide: (map: string, position: PositionData, playerProperties: PlayerProperties) => {
        const playerWidth = playerProperties.width || 32;
        const playerHeight = playerProperties.height || 32;

        // Retrieve collision data for the map
        const collisionData = assetCache.get(map.replace(".json", ""));
        const mapProperties = assetCache.get("mapProperties") as any[];
        const mapData = mapProperties.find(m => m.name.replace(".json", "") === map.replace(".json", "")) as MapProperties | undefined;
        if (!mapData) return { value: true, reason: "no_map_data" };
        
        const warps = (mapData.warps || {}) as WarpObject[];

        for (const key of Object.keys(warps)) {
            const warp = warps[key as any];
            // Just check if player position is within warp bounds
            if (
                position.x + playerWidth > warp.position.x &&
                position.x < warp.position.x + warp.size.width &&
                position.y + playerHeight > warp.position.y &&
                position.y < warp.position.y + warp.size.height
            ) {
                return {
                    value: true,
                    reason: "warp_collision",
                    warp: {
                        map: warp.map,
                        position: {
                            x: warp.x,
                            y: warp.y
                        }
                    }
                };
            }
        }

        if (!collisionData) return { value: true, reason: "no_collision_data" };

        const data = collisionData.collision || collisionData;
        if (!data || !Array.isArray(data)) return { value: true, reason: "no_collision_data" };

        const gridOffsetWidth = Math.floor(mapData.width / 2);
        const gridOffsetHeight = Math.floor(mapData.height / 2);
        const tileWidth = mapData.tileWidth;
        const tileHeight = mapData.tileHeight;
        const collision = data.slice(2) as any[];

        // Calculate player bounding box in tile coordinates
        // Apply small margin and adjust for offset
        const margin = 0.1; // Small margin in pixels
        const adjustedX = position.x + tileWidth/2;
        const adjustedY = position.y + tileHeight/2;
        
        const left = Math.floor((adjustedX + margin) / tileWidth);
        const right = Math.floor((adjustedX + playerWidth - margin) / tileWidth);
        const top = Math.floor((adjustedY + margin) / tileHeight);
        const bottom = Math.floor((adjustedY + playerHeight - margin) / tileHeight);

        for (let y = top; y <= bottom; y++) {
            for (let x = left; x <= right; x++) {
                const indexX = x + gridOffsetWidth;
                const indexY = y + gridOffsetHeight;

                const targetIndex = (indexY * mapData.width) + indexX;
                let currentIndex = 0;
                let tileValue = 0;

                for (let i = 0; i < collision.length; i += 2) {
                    const value = collision[i];
                    const count = collision[i + 1];

                    if (currentIndex + count > targetIndex) {
                        tileValue = value;
                        break;
                    }

                    currentIndex += count;
                }

                if (tileValue !== 0) {
                    return { value: true, reason: "tile_collision", tile: { x: left, y: top } };
                }
            }
        }

        return { value: false, reason: "no_collision" }; // No collisions
    },
    kick: async (username: string, ws: WebSocket) => {
        const response = await query("SELECT session_id FROM accounts WHERE username = ?", [username]) as any;
        if (response[0]?.session_id) {
            player.logout(response[0]?.session_id);
        }
        if (ws) ws.close();
    },
    ban: async (username: string, ws: WebSocket) => {
        if (!username) return;
        username = username.toLowerCase();
        const response = await query("UPDATE accounts SET banned = 1 WHERE username = ?", [username]);
        const session_id = await player.getSession(username) as any;
        if (session_id[0]?.session_id) {
            player.logout(session_id[0]?.session_id);
        }
        if (ws) ws.close();
        return response;
    },
    unban: async (username: string) => {
        if (!username) return;
        username = username.toLowerCase();
        const response = await query("UPDATE accounts SET banned = 0 WHERE username = ?", [username]);
        return response;
    },
    canAttack: (self: Player, target: Player, playerProperties: PlayerProperties): {value: boolean, reason?: string} => {
        // No self or target or no range
        if (!self || !target) return { value: false, reason: "invalid" };

        // Prevent attacks on self
        if (self.id === target.id) return { value: false, reason: "self" };

        // Ensure self is not dead
        if (!self.stats || self.stats.health <= 0) return { value: false, reason: "dead" };

        // Check if the target is in the same map
        if (!self.location || !target.location || target.location.map !== self.location.map) return { value: false, reason: "different_map" };

        if (self.isStealth || target.isStealth) return { value: false, reason: "stealth" };

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
            'up': angle > -135 && angle < -45,
            'down': angle > 45 && angle < 135,
            'left': angle > 135 || angle < -135,
            'right': angle > -45 && angle < 45,
            'upleft': angle > 135 || (angle > -180 && angle < -135),
            'upright': angle > -135 && angle < -45,
            'downleft': angle > 135 && angle < 180,
            'downright': angle > 45 && angle < 135
        };

        if (!directionAngles[direction as keyof typeof directionAngles]) return { value: false, reason: "direction" };

        // Check if the target is in PvP zone
        const isPvpAllowedTarget = player.isInPvPZone(self.location.map, targetPosition, playerProperties);
        if (!isPvpAllowedTarget) return { value: false, reason: "nopvp" };
        const isPvpAllowedSelf = player.isInPvPZone(self.location.map, selfPosition, playerProperties);
        if (!isPvpAllowedSelf) return { value: false, reason: "nopvp" };

        return { value: true, reason: "pvp" };
    },
    findClosestPlayer: (self: Player, players: Player[], range: number): NullablePlayer => {
        if (!players) return null;
        if (!self.location?.position) return null;

        let closestPlayer = null;
        let closestDistance = range;
        const selfPosition = self.location.position as unknown as PositionData;
        for (const player of players) {
            if (player.location) {
                const position = player.location.position as unknown as PositionData;
                const distance = Math.sqrt(Math.pow(selfPosition.x - position.x, 2) + Math.pow(selfPosition.y - position.y, 2));
                if (player.isStealth) continue;
                if (distance < closestDistance) {
                    closestDistance = distance;
                    closestPlayer = player;
                }                
            }
        }
        return closestPlayer;
    }
};

export default player;