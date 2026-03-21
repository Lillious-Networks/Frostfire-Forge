import { Worker } from "worker_threads";
import assetCache from "../services/assetCache";
import log from "../modules/logger";

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

let serializedAssets: Awaited<ReturnType<typeof prepareAssets>> | null = null;

let persistentWorker: Worker | null = null;

async function createPersistentWorker(): Promise<Worker> {

    serializedAssets = await prepareAssets();

    const worker = new Worker(new URL("authentication.ts", import.meta.url).href, {
        workerData: { assets: serializedAssets }
    });

    worker.on("error", (error) => {
        log.error(`[AUTH POOL] Worker error: ${error.message}`);

        persistentWorker = null;
        serializedAssets = null;
    });

    worker.on("exit", (code) => {
        if (code !== 0) {
            log.error(`[AUTH POOL] Worker exited with code ${code}`);
        }
        persistentWorker = null;
        serializedAssets = null;
    });

    return worker;
}

export async function getAuthWorker(): Promise<Worker> {
    if (!persistentWorker) {
        persistentWorker = await createPersistentWorker();
    }
    return persistentWorker;
}

export function resetAuthWorker(): void {
    if (persistentWorker) {
        persistentWorker.terminate();
        persistentWorker = null;
        serializedAssets = null;
    }
}