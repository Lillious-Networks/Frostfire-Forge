import { redis } from "bun";

type RedisValue = any;

interface CacheService {
  add(key: string, value: any): Promise<void>;
  get(key: string): Promise<any>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
  list(): Promise<Record<string, RedisValue>>;
  addNested(key: string, nestedKey: string, value: RedisValue): Promise<void>;
  getNested(key: string, nestedKey: string): Promise<RedisValue>;
  removeNested(key: string, nestedKey: string): Promise<void>;
  set(key: string, value: any): Promise<void>;
  setNested(key: string, nestedKey: string, value: RedisValue): Promise<void>;
  getAll(): Promise<Record<string, RedisValue>>;
  close(): void;
}

class MemoryCacheService implements CacheService {
  private cache = new Map<string, any>();
  private hashes = new Map<string, Map<string, any>>();
  private prefix: string;

  constructor(prefix = "asset:") {
    this.prefix = prefix;
  }

  private prefixed(key: string) {
    return `${this.prefix}${key}`;
  }

  async add(key: string, value: any): Promise<void> {
    this.cache.set(this.prefixed(key), value);
  }

  async get(key: string): Promise<any> {
    return this.cache.get(this.prefixed(key)) ?? null;
  }

  async remove(key: string): Promise<void> {
    this.cache.delete(this.prefixed(key));
    this.hashes.delete(this.prefixed(key));
  }

  async clear(): Promise<void> {
    const keysToDelete: string[] = [];
    for (const key of this.cache.keys()) {
      if (key.startsWith(this.prefix)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.cache.delete(key);
    }

    const hashesToDelete: string[] = [];
    for (const key of this.hashes.keys()) {
      if (key.startsWith(this.prefix)) {
        hashesToDelete.push(key);
      }
    }
    for (const key of hashesToDelete) {
      this.hashes.delete(key);
    }
  }

  async list(): Promise<Record<string, RedisValue>> {
    const out: Record<string, RedisValue> = {};
    for (const [key, value] of this.cache.entries()) {
      if (key.startsWith(this.prefix)) {
        const shortKey = key.slice(this.prefix.length);
        out[shortKey] = value;
      }
    }
    return out;
  }

  async addNested(key: string, nestedKey: string, value: RedisValue): Promise<void> {
    const prefixedKey = this.prefixed(key);
    if (!this.hashes.has(prefixedKey)) {
      this.hashes.set(prefixedKey, new Map());
    }
    this.hashes.get(prefixedKey)!.set(nestedKey, value);
  }

  async getNested(key: string, nestedKey: string): Promise<RedisValue> {
    const prefixedKey = this.prefixed(key);
    const hash = this.hashes.get(prefixedKey);
    return hash?.get(nestedKey) ?? undefined;
  }

  async removeNested(key: string, nestedKey: string): Promise<void> {
    const prefixedKey = this.prefixed(key);
    const hash = this.hashes.get(prefixedKey);
    if (hash) {
      hash.delete(nestedKey);
    }
  }

  async set(key: string, value: any): Promise<void> {
    await this.add(key, value);
  }

  async setNested(key: string, nestedKey: string, value: RedisValue): Promise<void> {
    await this.addNested(key, nestedKey, value);
  }

  async getAll(): Promise<Record<string, RedisValue>> {
    return await this.list();
  }

  close(): void {
    this.cache.clear();
    this.hashes.clear();
  }
}

class RedisCacheService implements CacheService {
  private client = redis;
  private prefix: string;

  constructor(prefix = "asset:") {
    this.prefix = prefix;
  }

  private prefixed(key: string) {
    return `${this.prefix}${key}`;
  }

  /** Recursively reconstruct all Buffer objects in parsed JSON */
  private reconstructBuffers(obj: any, depth: number = 0): any {
    if (!obj || typeof obj !== 'object') return obj;

    // Check if this object is a serialized Buffer
    if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
      return Buffer.from(obj.data);
    }

    // Recursively process arrays
    if (Array.isArray(obj)) {
      return obj.map(item => this.reconstructBuffers(item, depth + 1));
    }

    // Recursively process object properties
    const result: any = {};
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        result[key] = this.reconstructBuffers(obj[key], depth + 1);
      }
    }
    return result;
  }

  /** Helper to send commands with debug info */
  private async safeSend<T = any>(cmd: string, args: string[]): Promise<T> {
    const key = args[0];
    try {
      return await this.client.send(cmd, args);
    } catch (e: any) {
      let type: string | null = null;
      try {
        type = await this.client.send("TYPE", [key]);
      } catch {
        type = "unknown";
      }

      console.error(
        `[RedisDebug] ERROR on ${cmd} ${args.join(" ")} | key=${key} | type=${type}`
      );
      console.error(new Error("[RedisDebug] stack trace").stack);
      throw e;
    }
  }

  /** Ensure key is cleared if type mismatch occurs */
  private async ensureHashKey(key: string): Promise<void> {
    const type = await this.safeSend("TYPE", [this.prefixed(key)]);
    if (type !== "none" && type !== "hash") {
      await this.safeSend("DEL", [this.prefixed(key)]);
    }
  }

  async add(key: string, value: any) {
    const data = typeof value === "string" ? value : JSON.stringify(value);
    await this.client.set(this.prefixed(key), data);
  }

  async get(key: string) {
    const data = await this.client.get(this.prefixed(key));
    if (!data) return null;
    try {
      const parsed = JSON.parse(data);
      // Recursively reconstruct all Buffers
      return this.reconstructBuffers(parsed);
    } catch {
      return data;
    }
  }

  async remove(key: string): Promise<void> {
    await this.safeSend("DEL", [this.prefixed(key)]);
  }

  async clear(): Promise<void> {
    const pattern = this.prefix + "*";
    const keys = (await this.safeSend<string[]>("KEYS", [pattern])) ?? [];
    if (keys.length === 0) return;

    const chunkSize = 500;
    for (let i = 0; i < keys.length; i += chunkSize) {
      const chunk = keys.slice(i, i + chunkSize);
      await this.safeSend("DEL", chunk);
    }
  }

  async list(): Promise<Record<string, RedisValue>> {
    const pattern = this.prefix + "*";
    const keys = (await this.safeSend<string[]>("KEYS", [pattern])) ?? [];
    const out: Record<string, RedisValue> = {};
    if (keys.length === 0) return out;

    const stringKeys: string[] = [];
    for (const k of keys) {
      const type = await this.safeSend("TYPE", [k]);
      if (type === "string") stringKeys.push(k);
    }

    const values = (await this.safeSend<(string | null)[]>("MGET", stringKeys)) ?? [];
    for (let i = 0; i < stringKeys.length; i++) {
      const shortKey = stringKeys[i].slice(this.prefix.length);
      if (values[i] === null) {
        out[shortKey] = undefined;
      } else {
        const parsed = JSON.parse(values[i] as string);
        // Recursively reconstruct all Buffers
        out[shortKey] = this.reconstructBuffers(parsed);
      }
    }
    return out;
  }

  /** Nested hash helpers */
  async addNested(key: string, nestedKey: string, value: RedisValue): Promise<void> {
    await this.ensureHashKey(key);
    await this.safeSend("HSET", [this.prefixed(key), nestedKey, JSON.stringify(value)]);
  }

  async getNested(key: string, nestedKey: string): Promise<RedisValue> {
    await this.ensureHashKey(key);
    const raw = await this.safeSend<string | null>("HGET", [this.prefixed(key), nestedKey]);
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw);
    // Recursively reconstruct all Buffers
    return this.reconstructBuffers(parsed);
  }

  async removeNested(key: string, nestedKey: string): Promise<void> {
    await this.ensureHashKey(key);
    await this.safeSend("HDEL", [this.prefixed(key), nestedKey]);
  }

  async set(key: string, value: any) {
    await this.add(key, value);
  }

  async setNested(key: string, nestedKey: string, value: RedisValue): Promise<void> {
    await this.addNested(key, nestedKey, value);
  }

  close(): void {
    if (typeof (this.client as any).close === "function") {
      (this.client as any).close();
    }
  }

  async getAll(): Promise<Record<string, RedisValue>> {
    return await this.list();
  }
}

const cacheType = process.env.CACHE?.toLowerCase() || "memory";
const assetCache: CacheService = cacheType === "redis"
  ? new RedisCacheService()
  : new MemoryCacheService();

export default assetCache;