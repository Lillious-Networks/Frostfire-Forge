import { Worker } from "worker_threads";
import assetCache from "../services/assetCache";

// Prepare serializable asset data for worker threads
const prepareAssets = async () => {
    const items = await assetCache.get("items");
    const maps = await assetCache.get("maps");
    const mounts = await assetCache.get("mounts");

    console.log(`[AUTH POOL] Preparing assets for worker:`);
    console.log(`  - Items: ${items?.length || 0}`);
    console.log(`  - Maps: ${maps?.length || 0}`);
    console.log(`  - Mounts: ${mounts?.length || 0}`);
    if (mounts && mounts.length > 0) {
        console.log(`  - First mount icon type: ${typeof mounts[0]?.icon}, has .data: ${!!mounts[0]?.icon?.data}, isBuffer: ${Buffer.isBuffer(mounts[0]?.icon)}`);
    }

    return {
        items: items ? JSON.stringify(items) : null,
        maps: maps ? JSON.stringify(maps) : null,
        mounts: mounts ? JSON.stringify(mounts) : null,
    };
};

// DO NOT cache assets at module scope - fetch fresh each time worker is created
// This prevents stale data issues in development/hot-reload environments
let serializedAssets: Awaited<ReturnType<typeof prepareAssets>> | null = null;

// Single persistent worker that gets reused
// This prevents creating multiple connection pools
let persistentWorker: Worker | null = null;

async function createPersistentWorker(): Promise<Worker> {
    // Fetch fresh assets from cache each time worker is created
    // This ensures we always have the latest data, especially after hot reloads
    serializedAssets = await prepareAssets();

    const worker = new Worker(new URL("authentication.ts", import.meta.url).href, {
        workerData: { assets: serializedAssets }
    });

    worker.on("error", (error) => {
        console.error("[AUTH POOL] Worker error:", error);
        // Recreate worker on error
        persistentWorker = null;
        serializedAssets = null;
    });

    worker.on("exit", (code) => {
        if (code !== 0) {
            console.error(`[AUTH POOL] Worker exited with code ${code}`);
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

// Force recreation of worker (useful for hot reloads in development)
export function resetAuthWorker(): void {
    if (persistentWorker) {
        persistentWorker.terminate();
        persistentWorker = null;
        serializedAssets = null;
    }
}