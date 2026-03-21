import query from "../controllers/sqldatabase";
import log from "../modules/logger";

const permissions = {
    clear: async (username: string) => {

        await query("UPDATE permissions SET permissions = NULL WHERE username = ?", [username]);
        log.info(`Permissions cleared for ${username}`);
    },
    set: async (username: string, permissions: string | string[]) => {

        const perms = typeof permissions === "string" ? [permissions] : permissions;

        const uniquePerms = Array.from(new Set(perms));
        await query(
            "INSERT INTO permissions (username, permissions) VALUES (?, ?) ON DUPLICATE KEY UPDATE permissions = ?",
            [username, uniquePerms.join(","), uniquePerms.join(",")]
        );
        log.info(`Permissions ${uniquePerms.join(",")} set for ${username}`);
    },
    get: async (username: string) => {

        const response = await query("SELECT permissions FROM permissions WHERE username = ?", [username]) as { permissions: string }[];
        if (response.length === 0) return [];
        return response[0]?.permissions || [];
    },
    add: async (username: string, permission: string) => {

        const response = await permissions.get(username) as string;
        const accessSet = new Set(response.split(",").filter(Boolean));
        if (accessSet.has(permission)) return;
        accessSet.add(permission);
        await permissions.set(username, Array.from(accessSet));
        log.info(`Permission ${permission} added to ${username}`);
    },
    remove: async (username: string, permission: string) => {

        const response = await permissions.get(username) as string;
        const accessSet = new Set(response.split(",").filter(Boolean));
        if (!accessSet.has(permission)) return;
        accessSet.delete(permission);
        await permissions.set(username, Array.from(accessSet));
        log.info(`Permission ${permission} removed from ${username}`);
    },
    list: async() => {

        const response = await query("SELECT name FROM permission_types") as { name: string }[];
        return response.map((permission) => permission.name);
    }
}

export default permissions;