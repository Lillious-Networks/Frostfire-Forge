import log from "../modules/logger";
import type { ClusterStore } from "./store";

// Where each online player is: which node holds them, under which id. Every
// change raises the entry's epoch, so a node that lost a player (to a handoff
// or a newer login) can never overwrite or delete the newer entry. Epochs come
// from a per-name counter that never goes back, so a name freed by a release
// and claimed again starts above every epoch it has used: a late release of an
// old claim can never delete a newer one.

export interface DirectoryEntry {
  nodeId: string;
  playerId: string;
  epoch: number;
  map: string;
}

const entryKey = (username: string) => `cells:dir:${username.toLowerCase()}`;
const nodeKey = (nodeId: string) => `cells:dirnode:${nodeId}`;
const epochKey = (username: string) => `cells:direpoch:${username.toLowerCase()}`;

/** The most set members one repair pass checks, and how many it reads at once. */
export const REPAIR_BATCH = 200;
/** The most names `owed` keeps; the oldest goes first (the repair covers what it forgets). */
const OWED_MAX = 1000;
const REPAIR_PARALLEL = 20;

export class PlayerDirectory {
  // Other nodes whose set a claim of this node took the name from, kept until the name has left that set. A claim that
  // fails after its swap (the store went away) runs again and then reads its own entry as the previous one: without
  // this the old node's set would keep the name.
  private owed = new Map<string, Set<string>>();
  private repairFrom = 0;

  constructor(private store: ClusterStore, readonly nodeId: string) {}

  async get(username: string): Promise<DirectoryEntry | null> {
    const raw = await this.store.get(entryKey(username));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as DirectoryEntry;
    } catch {
      return null;
    }
  }

  /**
   * At login on this node. `previous` is whoever held the name before (on any node). `onSwap` hears the entry the swap
   * replaced as soon as the swap has happened: the set updates after it can fail, and the caller then still knows
   * whose entry this claim took.
   */
  async claim(
    username: string, playerId: string, map: string, onSwap?: (previous: DirectoryEntry | null) => void,
  ): Promise<{ entry: DirectoryEntry; previous: DirectoryEntry | null }> {
    const name = username.toLowerCase();
    for (let attempt = 0; attempt < 5; attempt++) {
      const previous = await this.get(name);
      const epoch = await this.store.incrBy(epochKey(name), 1);
      const entry: DirectoryEntry = { nodeId: this.nodeId, playerId, epoch, map };
      if (!(await this.store.swapIfEpoch(entryKey(name), previous?.epoch ?? 0, JSON.stringify(entry)))) continue;
      onSwap?.(previous);
      if (previous && previous.nodeId !== this.nodeId) {
        const owes = this.owed.get(name) ?? new Set<string>();
        owes.add(previous.nodeId);
        this.owed.delete(name);
        this.owed.set(name, owes);
        if (this.owed.size > OWED_MAX) this.owed.delete(this.owed.keys().next().value as string);
      }
      // A node whose entry names the name now holds it for real: its member stays. dropName reads the entry again
      // after the removal and puts a member back that a claim made meanwhile.
      for (const other of [...(this.owed.get(name) ?? [])]) {
        if ((await this.get(name))?.nodeId !== other) await this.dropName(other, name);
        this.owed.get(name)?.delete(other);
      }
      this.owed.delete(name);
      await this.store.addToSet(nodeKey(this.nodeId), name);
      return { entry, previous };
    }
    throw new Error(`The directory entry for ${name} kept changing`);
  }

  /** At logout: only the claim with this epoch is removed. Whether it was. */
  async release(username: string, epoch: number): Promise<boolean> {
    const name = username.toLowerCase();
    this.owed.delete(name);
    if (!(await this.store.deleteIfEpoch(entryKey(name), epoch))) {
      // The epoch was lost (a newer claim, here or on another node, holds the entry): this node's own set must not keep
      // a name it no longer holds. Only this node's set is touched, never the entry.
      if ((await this.get(name))?.nodeId !== this.nodeId) await this.dropName(this.nodeId, name);
      return false;
    }
    // A login here may have claimed the name again since: its entry needs the name kept in the set.
    // dropName also puts the member back when a claim lands between the check and the removal.
    if ((await this.get(name))?.nodeId !== this.nodeId) await this.dropName(this.nodeId, name);
    return true;
  }

  /**
   * Raises the entry's epoch above `floor`, when the entry is still `entry`. For a name whose counter went back (Redis
   * lost it) while the database holds a higher owner epoch: the claim must outrank every save fenced before. The new
   * epoch, or null when the entry changed meanwhile (a newer claim has it).
   */
  async lift(username: string, floor: number, entry: DirectoryEntry): Promise<number | null> {
    const name = username.toLowerCase();
    let epoch = await this.store.incrBy(epochKey(name), 1);
    if (epoch <= floor) epoch = await this.store.incrBy(epochKey(name), floor - epoch + 1);
    const lifted: DirectoryEntry = { ...entry, epoch };
    return (await this.store.swapIfEpoch(entryKey(name), entry.epoch, JSON.stringify(lifted))) ? epoch : null;
  }

  /**
   * Clears up what a node left behind (it stopped, or died and came back): each
   * entry it still holds goes, and its set empties. How many entries were removed.
   */
  async sweepNode(nodeId: string, stillDead?: () => Promise<boolean>): Promise<number> {
    if (stillDead) return this.sweepDeadRun(nodeId, stillDead);
    let removed = 0;
    for (const name of await this.playersOn(nodeId)) {
      const entry = await this.get(name);
      if (entry?.nodeId === nodeId && (await this.store.deleteIfEpoch(entryKey(name), entry.epoch))) removed++;
      await this.store.removeFromSet(nodeKey(nodeId), name);
    }
    return removed;
  }

  /**
   * sweepNode for a run found dead by another process, while a new run of the node may start under the same id and
   * take logins: an entry of the new run must not go. The entries are read first and `stillDead` (the node's
   * announcement still names the dead run) is asked once after: a node claims only after it announces, so every entry
   * read before it says yes is the dead run's. When it says no, nothing is deleted (the new run cleared what the dead
   * run left before it announced). Each entry goes only at the epoch read, so a claim made since stays, and its name
   * leaves the set only with it. A name whose entry was already gone or held by another node leaves the set either
   * way: it holds nothing of the node's.
   */
  private async sweepDeadRun(nodeId: string, stillDead: () => Promise<boolean>): Promise<number> {
    const held: Array<[string, number]> = [];
    const leftover: string[] = [];
    for (const name of await this.playersOn(nodeId)) {
      const entry = await this.get(name);
      if (entry?.nodeId === nodeId) held.push([name, entry.epoch]);
      else leftover.push(name);
    }
    for (const name of leftover) await this.dropName(nodeId, name);
    if (held.length === 0 || !(await stillDead())) return 0;
    let removed = 0;
    for (const [name, epoch] of held) {
      if (!(await this.store.deleteIfEpoch(entryKey(name), epoch))) continue;
      removed++;
      await this.dropName(nodeId, name);
    }
    return removed;
  }

  // Takes a name the node no longer holds out of its set. A claim writes its entry before it joins the set: an entry
  // of the node found after the removal is a new claim, whose name belongs in the set, and is put back.
  private async dropName(nodeId: string, name: string): Promise<void> {
    await this.store.removeFromSet(nodeKey(nodeId), name);
    if ((await this.get(name))?.nodeId === nodeId) await this.store.addToSet(nodeKey(nodeId), name);
  }

  /**
   * Set repair: the per-node set is only an index, and a stale member (left by a failed claim or a lost release) would
   * stay until the node restarts. Looks at up to REPAIR_BATCH members of this node's set per call, continuing where
   * the last call stopped, and drops each whose entry names another node or is missing. Never touches an entry,
   * a player or the fence. How many members were dropped.
   */
  async repairIndex(): Promise<number> {
    const names = (await this.playersOn(this.nodeId)).sort();
    if (names.length === 0) { this.repairFrom = 0; return 0; }
    if (this.repairFrom >= names.length) this.repairFrom = 0;
    const batch = names.slice(this.repairFrom, this.repairFrom + REPAIR_BATCH);
    this.repairFrom = batch.length < REPAIR_BATCH ? 0 : this.repairFrom + REPAIR_BATCH;
    let dropped = 0;
    for (let i = 0; i < batch.length; i += REPAIR_PARALLEL) {
      const part = batch.slice(i, i + REPAIR_PARALLEL);
      const entries = await Promise.all(part.map((name) => this.get(name)));
      for (let j = 0; j < part.length; j++) {
        if (entries[j]?.nodeId === this.nodeId) continue;
        // dropName reads the entry again and keeps a claim made since.
        await this.dropName(this.nodeId, part[j]);
        if ((await this.get(part[j]))?.nodeId === this.nodeId) continue;
        dropped++;
        log.info(`Directory set of ${this.nodeId} dropped ${part[j]}: its entry ${entries[j] ? `names ${entries[j]!.nodeId}` : "is missing"}`);
      }
    }
    return dropped;
  }

  /** The usernames a node holds: for clearing up after a node dies. */
  playersOn(nodeId: string): Promise<string[]> {
    return this.store.members(nodeKey(nodeId));
  }
}
