class PlayerManager {
    private cache: { [key: string]: any };

    constructor() {

        this.cache = {};
    }

    add(key: string, value: any) {
        this.cache[key] = value;
    }

        get(key: string) {
        return this.cache[key];
    }

    remove(key: string) {
        delete this.cache[key];
    }

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