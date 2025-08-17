import query from "../controllers/sqldatabase";
import log from "../modules/logger";

const permissions = {
    clear: async (username: string) => {
        // Clear permissions for a player
        await query("UPDATE permissions SET permissions = NULL WHERE username = ?", [username]);
        log.info(`Permissions cleared for ${username}`);
    },    
    set: async (username: string, permissions: string | string[]) => {
        // Set permissions for a player
        const perms = typeof permissions === "string" ? [permissions] : permissions;
        // Remove duplicates
        const uniquePerms = Array.from(new Set(perms));
        await query(
            "INSERT INTO permissions (username, permissions) VALUES (?, ?) ON DUPLICATE KEY UPDATE permissions = ?",
            [username, uniquePerms.join(","), uniquePerms.join(",")]
        );
        log.info(`Permissions ${uniquePerms.join(",")} set for ${username}`);
    },
    get: async (username: string) => {
        // Get permissions for a player
        const response = await query("SELECT permissions FROM permissions WHERE username = ?", [username]) as { permissions: string }[];
        if (response.length === 0) return [];
        return response[0]?.permissions || [];
    },
    add: async (username: string, permission: string) => {
        // Get permissions for a player
        const response = await permissions.get(username) as string;
        const access = response.includes(",") ? response.split(",") : response.length ? [response] : [];
        if (access.includes(permission)) return;
        access.push(permission);
        await permissions.set(username, access);
        log.info(`Permission ${permission} added to ${username}`);
    },
    remove: async (username: string, permission: string) => {
        // Get permissions for a player
        const response = await permissions.get(username) as string;
        const access = response.includes(",") ? response.split(",") : response.length ? [response] : [];
        if (!access.includes(permission)) return;
        access.splice(access.indexOf(permission), 1);
        await permissions.set(username, access);
        log.info(`Permission ${permission} removed from ${username}`);
    },
    list: async() => {
        // Get all permission types 
        const response = await query("SELECT name FROM permission_types") as { name: string }[];
        return response.map((permission) => permission.name);
    }
}

export default permissions;