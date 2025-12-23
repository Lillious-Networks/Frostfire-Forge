import { Worker } from "worker_threads";
import assetCache from "../services/assetCache";

// Prepare serializable asset data for worker threads
const prepareAssets = async () => {
    const items = await assetCache.get("items");
    const maps = await assetCache.get("maps");

    return {
        items: items ? JSON.stringify(items) : null,
        maps: maps ? JSON.stringify(maps) : null
    };
};

// Pre-load and serialize assets once
const serializedAssets = await prepareAssets();

// Single persistent worker that gets reused
// This prevents creating multiple connection pools
let persistentWorker: Worker | null = null;

function createPersistentWorker(): Worker {
    const worker = new Worker(new URL("authentication.ts", import.meta.url).href, {
        workerData: { assets: serializedAssets }
    });

    worker.on("error", (error) => {
        console.error("[AUTH POOL] Worker error:", error);
        // Recreate worker on error
        persistentWorker = null;
    });

    worker.on("exit", (code) => {
        if (code !== 0) {
            console.error(`[AUTH POOL] Worker exited with code ${code}`);
        }
        persistentWorker = null;
    });

    return worker;
}

export function getAuthWorker(): Worker {
    if (!persistentWorker) {
        persistentWorker = createPersistentWorker();
    }
    return persistentWorker;
}