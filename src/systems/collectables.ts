import query from "../controllers/sqldatabase";
import { rowCache, turns } from "../services/datacache";

// Each player's collectables: the item and type of every row.
const rows = rowCache<any[]>("collectables", async (username) =>
    (await query("SELECT item, type FROM collectables WHERE username = ?", [username])) as any[] || []
, { perPlayer: true });

// One change to a player's collectables at a time. Each works from the list held and puts back what its write left,
// so two running side by side would each put back a list without the other's change (and both would pass the
// "already has it" check before either wrote).
const oneAtATime = turns();

/**
 * A change to a player's collectables, in its turn. When it fails, the list held is forgotten and the next read loads
 * it: a write that threw may still have been made (one that timed out, say), so what is held can be trusted no longer.
 */
function change<T>(username: string, work: () => Promise<T>): Promise<T> {
    return oneAtATime(username, async () => {
        try {
            return await work();
        } catch (error) {
            await rows.drop(username);
            throw error;
        }
    });
}

// The rows a WHERE on a name picks: MySQL compares text without regard to case, the other engines exactly.
const sameName = (a: string, b: string) =>
    (process.env.DATABASE_ENGINE || "mysql") === "mysql" ? String(a).toLowerCase() === String(b).toLowerCase() : a === b;

/** Whether a row is this collectable: what WHERE type = ? AND item = ? picks. */
const is = (collectable: Collectable) => (row: any) => sameName(row.type, collectable.type) && sameName(row.item, collectable.item);

const collectables = {
    async list(username: string) {
        if (!username) return [];
        return (await rows.get(username)) ?? [];
    },
    async add(collectable: Collectable) {
        if (!collectable?.type || !collectable?.item || !collectable?.username) return;

        return change(collectable.username, async () => {
            const held = (await rows.get(collectable.username)) ?? [];

            if (held.some(is(collectable))) return;

            const result = await query(
                "INSERT INTO collectables (type, item, username) VALUES (?, ?, ?)",
                [collectable.type, collectable.item, collectable.username]
            );
            await rows.set(collectable.username, [...held, { item: collectable.item, type: collectable.type }]);
            return result;
        });
    },
    async remove(collectable: Collectable) {
        if (!collectable?.type || !collectable?.item || !collectable?.username) return;
        return change(collectable.username, async () => {
            const result = await query(
                "DELETE FROM collectables WHERE type = ? AND item = ? AND username = ?",
                [collectable.type, collectable.item, collectable.username]
            );
            const held = (await rows.get(collectable.username)) ?? [];
            await rows.set(collectable.username, held.filter((row) => !is(collectable)(row)));
            return result;
        });
    },
    async find(collectable: Collectable) {
        if (!collectable?.type || !collectable?.item || !collectable?.username) return;
        const response = ((await rows.get(collectable.username)) ?? []).filter(is(collectable));
        if (response.length === 0) return;
        return response;
    }
}

export default collectables;
