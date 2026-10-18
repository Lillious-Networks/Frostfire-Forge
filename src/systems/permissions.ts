import query from "../controllers/sqldatabase";
import log from "../modules/logger";
import { rowCache, tableCache, turns } from "../services/datacache";

/** A row of the permissions table: `permissions` is the comma-separated list. */
type PermissionsRow = { permissions: string };

/** The longest list the permissions column holds as it was given. */
const LIST_LENGTH = 255;

// Each player's rows of the permissions table, as it has them: one, or none
// for a player who holds no permission. Reads are answered from these, and
// every change below is written to the database and then to them.
const rows = rowCache<PermissionsRow[]>("permissions", async (username) =>
    (await query("SELECT permissions FROM permissions WHERE username = ?", [username])) as PermissionsRow[] || []
, { perPlayer: true });

// The permissions there are to give. Nothing writes this table while the
// server runs: the database setup fills it.
const types = tableCache<{ name: string }>("permission_types", async () =>
    (await query("SELECT name FROM permission_types")) as { name: string }[] || []
);

// One write to a player's row at a time: statements sent side by side reach
// the database in no set order, so the row held could end as one left it and
// the table as the other did.
const oneAtATime = turns();

/**
 * A write of a player's row: the statement, then `left` as the rows held.
 * When what it left cannot be said here (`left` null), or it failed, in which
 * case it may still have been written (one that timed out, say), the rows are
 * forgotten instead and the next read asks the database.
 */
function write(username: string, sql: string, values: unknown[], left: PermissionsRow[] | null): Promise<void> {
    return oneAtATime(username, async () => {
        try {
            await query(sql, values);
        } catch (error) {
            await rows.drop(username);
            throw error;
        }
        if (left) await rows.set(username, left);
        else await rows.drop(username);
    });
}

/** A stored comma-separated list as its names. */
export function names(list: string | null | undefined): string[] {
    return String(list ?? "").split(",").map((p) => p.trim()).filter(Boolean);
}

/** Whether `held` includes `name`, itself or as its family's `family.*`. */
export function covers(held: readonly string[], name: string): boolean {
    if (held.includes(name)) return true;
    const dot = name.indexOf(".");
    return dot > 0 && held.includes(`${name.slice(0, dot)}.*`);
}

/**
 * Whether a holder of `held` may give `name` to someone. A holder of
 * `server.*` gives anything. The server family (`server.*` and every
 * `server.` permission) is otherwise given only by one who holds that very
 * permission; anything else by a holder of `permission.*`, or one who holds it.
 */
export function canGrant(held: readonly string[], name: string): boolean {
    if (held.includes("server.*")) return true;
    if (name.startsWith("server.")) return held.includes(name);
    return held.includes("permission.*") || covers(held, name);
}

/**
 * Whether a holder of `held` may change what a holder of `target` holds, or
 * their admin role: only one who could have given them all of it.
 */
export function outranks(held: readonly string[], target: readonly string[]): boolean {
    return target.every((name) => canGrant(held, name));
}

const permissions = {
    clear: async (username: string) => {
        await write(username, "DELETE FROM permissions WHERE username = ?", [username], []);
        log.info(`Permissions cleared for ${username}`);
    },
    set: async (username: string, permissions: string | string[]) => {

        const perms = typeof permissions === "string" ? [permissions] : permissions;

        const uniquePerms = Array.from(new Set(perms));
        const list = uniquePerms.join(",");
        await write(
            username,
            "INSERT INTO permissions (username, permissions) VALUES (?, ?) ON DUPLICATE KEY UPDATE permissions = ?",
            [username, list, list],
            // A list longer than the column is cut short by some databases: what is stored is then read, not assumed.
            list.length <= LIST_LENGTH ? [{ permissions: list }] : null
        );
        log.info(`Permissions ${uniquePerms.join(",")} set for ${username}`);
    },
    get: async (username: string) => {

        const response = (await rows.get(username)) ?? [];
        if (response.length === 0) return "";
        return response[0]?.permissions || "";
    },
    /** What the player holds, as names. */
    held: async (username: string) => names(await permissions.get(username) as string),
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

        const response = await types.all();
        return response.map((permission) => permission.name);
    }
}

export default permissions;
