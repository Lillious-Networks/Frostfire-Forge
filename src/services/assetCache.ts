import { redis } from "bun";

type RedisValue = any;

class AssetCacheService {
  private client = redis;
  private prefix: string;

  constructor(prefix = "asset:") {
    this.prefix = prefix;
  }

  private prefixed(key: string) {
    return `${this.prefix}${key}`;
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
      return JSON.parse(data);
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
      out[shortKey] =
        values[i] === null ? undefined : JSON.parse(values[i] as string);
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
    return raw === null ? undefined : JSON.parse(raw);
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
}

const assetCache = new AssetCacheService();
export default assetCache;
