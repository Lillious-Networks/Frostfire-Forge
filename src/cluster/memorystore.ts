import type { ClusterStore } from "./store";

// A value that is not JSON (or has no epoch) has epoch 0: the Lua scripts of RedisStore say the same.
const epochOf = (raw: string | undefined): number => {
  if (raw === undefined) return 0;
  try {
    const epoch = JSON.parse(raw)?.epoch;
    return typeof epoch === "number" || typeof epoch === "string" ? Number(epoch) || 0 : 0;
  } catch {
    return 0;
  }
};

/** A ClusterStore held in this process: for tests, where several nodes may share one. */
export class MemoryStore implements ClusterStore {
  private values = new Map<string, { value: string; expires: number }>();
  private sets = new Map<string, { members: Set<string>; expires: number }>();
  private channels = new Map<string, Array<(message: string) => void>>();

  private live(key: string): string | undefined {
    const held = this.values.get(key);
    if (!held) return undefined;
    if (held.expires && held.expires <= Date.now()) {
      this.values.delete(key);
      return undefined;
    }
    return held.value;
  }

  private liveSet(key: string): Set<string> | undefined {
    const held = this.sets.get(key);
    if (!held) return undefined;
    if (held.expires && held.expires <= Date.now()) {
      this.sets.delete(key);
      return undefined;
    }
    return held.members;
  }

  async get(key: string) {
    return this.live(key) ?? null;
  }

  async set(key: string, value: string, ttlMs = 0) {
    this.values.set(key, { value, expires: ttlMs > 0 ? Date.now() + ttlMs : 0 });
  }

  async setIfAbsent(key: string, value: string, ttlMs: number) {
    if (this.live(key) !== undefined) return false;
    await this.set(key, value, ttlMs);
    return true;
  }

  async del(key: string) {
    this.values.delete(key);
    this.sets.delete(key);
  }

  async take(key: string) {
    const held = this.live(key);
    this.values.delete(key);
    return held ?? null;
  }

  async incrBy(key: string, amount: number) {
    const value = (Number(this.live(key) ?? 0) || 0) + amount;
    this.values.set(key, { value: String(value), expires: 0 });
    return value;
  }

  async swapIfEpoch(key: string, expectedEpoch: number, value: string) {
    if (epochOf(this.live(key)) !== expectedEpoch) return false;
    this.values.set(key, { value, expires: 0 });
    return true;
  }

  async deleteIfEpoch(key: string, epoch: number) {
    const held = this.live(key);
    if (held === undefined || epochOf(held) !== epoch) return false;
    this.values.delete(key);
    return true;
  }

  async renewIfEpoch(key: string, epoch: number, ttlMs: number) {
    const held = this.live(key);
    if (held === undefined || epochOf(held) !== epoch) return false;
    this.values.get(key)!.expires = Date.now() + ttlMs;
    return true;
  }

  async addToSet(key: string, member: string) {
    if (!this.liveSet(key)) this.sets.set(key, { members: new Set(), expires: 0 });
    this.sets.get(key)!.members.add(member);
  }

  async removeFromSet(key: string, member: string) {
    const members = this.liveSet(key);
    members?.delete(member);
    // As in Redis, a set with no members is no longer there.
    if (members?.size === 0) this.sets.delete(key);
  }

  async members(key: string) {
    return [...(this.liveSet(key) ?? [])];
  }

  async expire(key: string, ttlMs: number) {
    const value = this.values.get(key);
    if (this.live(key) !== undefined && value) value.expires = Date.now() + ttlMs;
    const set = this.sets.get(key);
    if (this.liveSet(key) && set) set.expires = Date.now() + ttlMs;
  }

  // Delivered on a later turn, as Redis would: a publisher never runs its own handler inline.
  async publish(channel: string, message: string) {
    for (const handler of this.channels.get(channel) ?? []) setImmediate(() => handler(message));
  }

  async subscribe(channel: string, handler: (message: string) => void) {
    if (!this.channels.has(channel)) this.channels.set(channel, []);
    this.channels.get(channel)!.push(handler);
  }

  async unsubscribe(channel: string, handler: (message: string) => void) {
    const list = this.channels.get(channel);
    if (!list) return;
    const at = list.indexOf(handler);
    if (at >= 0) list.splice(at, 1);
    if (list.length === 0) this.channels.delete(channel);
  }

  isUp(): boolean {
    return true;
  }

  close() {
    this.channels.clear();
  }
}
