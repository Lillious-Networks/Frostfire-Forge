import query from "../controllers/sqldatabase";
import type { Batch } from "../services/batch";
import { rowCache, turns } from "../services/datacache";
import { Events, listener, type CollectableAddedEvent } from "./events";

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

/** Said once a row is written: achievements count it (systems/achievements). */
function added(collectable: Collectable): void {
    listener.emit(Events.COLLECTABLE_ADDED, { username: collectable.username, type: collectable.type, item: collectable.item } as CollectableAddedEvent);
}

/** What a batch has pending for a player: their collectables as its statements so far leave them. */
interface Pending {
    held: any[];
    written: boolean;
}

/**
 * A player's collectables as `batch` has them so far, the first time with this system's turn taken until the batch
 * ends. Once the batch is kept they are the rows held; if it is not, the rows held are forgotten.
 */
async function pendingIn(batch: Batch, username: string): Promise<Pending> {
    await batch.hold(oneAtATime, username);
    return batch.pending(rows, username, async () => {
        const state: Pending = { held: (await rows.get(username)) ?? [], written: false };
        batch.kept(() => (state.written ? rows.set(username, state.held) : undefined));
        batch.undone(() => rows.drop(username));
        return state;
    });
}

const collectables = {
    async list(username: string) {
        if (!username) return [];
        return (await rows.get(username)) ?? [];
    },
    /**
     * Adds a collectable the player does not have yet. With a `batch` (see services/batch), the statement is added to
     * it instead of sent, and the answer is true when there was one to add, false when the player has it already.
     */
    async add(collectable: Collectable, batch?: Batch) {
        if (!collectable?.type || !collectable?.item || !collectable?.username) return;

        if (batch) {
            const state = await pendingIn(batch, collectable.username);
            if (state.held.some(is(collectable))) return false;
            state.held = [...state.held, { item: collectable.item, type: collectable.type }];
            state.written = true;
            batch.add({
                sql: "INSERT INTO collectables (type, item, username) VALUES (?, ?, ?)",
                values: [collectable.type, collectable.item, collectable.username],
                mustChange: true,
            });
            batch.after(() => added(collectable));
            return true;
        }

        const said = { wrote: false };
        const result = await change(collectable.username, async () => {
            const held = (await rows.get(collectable.username)) ?? [];

            if (held.some(is(collectable))) return;

            const result = await query(
                "INSERT INTO collectables (type, item, username) VALUES (?, ?, ?)",
                [collectable.type, collectable.item, collectable.username]
            );
            said.wrote = true;
            await rows.set(collectable.username, [...held, { item: collectable.item, type: collectable.type }]);
            return result;
        });
        if (said.wrote) added(collectable);
        return result;
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
