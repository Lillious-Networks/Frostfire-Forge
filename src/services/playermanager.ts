class PlayerManager {
    private cache: { [key: string]: any };

    constructor() {
        // Initialize the cache
        this.cache = {};
    }
    // Add an item to the cache
    add(key: string, value: any) {
        this.cache[key] = value;
    }
    // Get an item from the cache
    get(key: string) {
        return this.cache[key];
    }
    // Remove an item from the cache
    remove(key: string) {
        delete this.cache[key];
    }
    // Clear the cache
    clear() {
        this.cache = {};
    }
    list() {
        return this.cache;
    }
    addNested(key: string, nestedKey: string, value: any) {
        if (!this.cache[key]) {
            this.cache[key] = {};
        }
        this.cache[key][nestedKey] = value;
    }
    set(key: string, value: any) {
        this.cache[key] = value;
    }
    setNested(key: string, nestedKey: string, value: any) {
        if (!this.cache[key]) {
            this.cache[key] = {};
        }
        this.cache[key][nestedKey] = value;
    }
}

const playerCache: PlayerManager = new PlayerManager();
export default playerCache;