import { Worker } from "worker_threads";
import assetCache from "../services/assetCache";
import log from "../modules/logger";
import { AuthDispatcher, authWorkerEnv } from "./authdispatch";

const MAX_AUTH_POOL_SIZE = 64;
const parsedAuthPoolSize = parseInt(process.env.AUTH_POOL_SIZE || "", 10);
const AUTH_POOL_SIZE = Number.isInteger(parsedAuthPoolSize) && parsedAuthPoolSize > 0
  ? Math.min(parsedAuthPoolSize, MAX_AUTH_POOL_SIZE)
  : 8;

const prepareAssets = async () => {
    const items = await assetCache.get("items");
    const maps = await assetCache.get("maps");
    const mounts = await assetCache.get("mounts");
    const spells = await assetCache.get("spells");

    return {
        items: items ? JSON.stringify(items) : null,
        maps: maps ? JSON.stringify(maps) : null,
        mounts: mounts ? JSON.stringify(mounts) : null,
        spells: spells ? JSON.stringify(spells) : null,
    };
};

const pool = new AuthDispatcher<Worker>({
    size: AUTH_POOL_SIZE,
    create: (assets) => new Worker(new URL("authentication.ts", import.meta.url), {
        workerData: { assets },
        env: authWorkerEnv(process.env),
    }),
    debug: (message) => log.debug(message),
    error: (message) => log.error(message),
});
let initializing: Promise<void> | null = null;

async function initPool(): Promise<void> {
    if (pool.started) return;
    initializing ??= prepareAssets().then((assets) => {
        pool.start(assets);
        log.info(`[AUTH POOL] ${pool.size} workers ready`);
    }).catch((error) => {
        initializing = null;
        throw error;
    });
    await initializing;
}

/**
 * The pool, started on first use. Logins are posted to it as to one worker (`postMessage`) and its answers are read
 * as from one (`on("message")`): each login goes to the worker with the fewest in flight, and every answer, a
 * replacement worker's too, reaches the same handlers (authdispatch.ts).
 */
export async function getAuthPool(): Promise<AuthDispatcher<Worker>> {
    await initPool();
    return pool;
}

export function resetAuthWorker(): void {
    pool.stop();
    initializing = null;
}

/**
 * The spell list changed while the server is running (spell editor). Each
 * worker builds a logging-in player's spell book from the copy of the list it
 * was started with, so hand every worker the new list, and keep it for any
 * worker started later.
 */
export async function refreshAuthSpells(): Promise<void> {
    if (!pool.started) return;
    const spells = await assetCache.get("spells");
    pool.refresh("spells", spells ? JSON.stringify(spells) : null);
}

/**
 * The item list changed while the server is running (item editor). Each
 * worker builds a logging-in player's inventory from the copy of the list it
 * was started with, so hand every worker the new list, and keep it for any
 * worker started later.
 */
export async function refreshAuthItems(): Promise<void> {
    if (!pool.started) return;
    const items = await assetCache.get("items");
    pool.refresh("items", items ? JSON.stringify(items) : null);
}

/**
 * The mount list changed while the server is running (mount editor). Each
 * worker leaves a mount it does not know out of a logging-in player's
 * collection, so hand every worker the new list, and keep it for any worker
 * started later.
 */
export async function refreshAuthMounts(): Promise<void> {
    if (!pool.started) return;
    const mounts = await assetCache.get("mounts");
    pool.refresh("mounts", mounts ? JSON.stringify(mounts) : null);
}
