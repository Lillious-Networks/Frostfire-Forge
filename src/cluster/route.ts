import type { BlockOwner } from "./blocks";
import type { NodeInfo } from "./nodes";

// Where a login belongs in cluster mode: on the node that owns the block the
// player spawns in. The node that got the login hands it over with SWITCH
// (socket/receiver.ts); a block no live node owns is played where the login is.

export type LoginRoute = "here" | { switchTo: NodeInfo };

/** The live nodes are read at most this often: every login asks. */
const LIVE_CACHE_MS = 1000;

/**
 * "here" when this node owns the spawn block, when no one does, or when its
 * owner is not live (phase 7 takes a dead node's blocks over; until then its
 * players log in where they are) or cannot be reached (it announced no address).
 */
export function routeLogin(
  spawn: { map: string; x: number; y: number },
  blocks: { ownerOf(map: string, x: number, y: number): BlockOwner | null } | null,
  live: readonly NodeInfo[],
  self: string
): LoginRoute {
  const owner = blocks?.ownerOf(spawn.map, spawn.x, spawn.y);
  if (!owner || owner.nodeId === self) return "here";
  const target = live.find((node) => node.nodeId === owner.nodeId);
  if (!target || !target.publicHost || !target.wtPort) return "here";
  return { switchTo: target };
}

/** The live nodes, read again once the last read is a second old. Logins at the same moment share one read; a failed read is not kept. */
export class LiveNodeCache {
  private nodes: NodeInfo[] = [];
  private readAt = -Infinity;
  private reading: Promise<NodeInfo[]> | null = null;

  constructor(private read: () => Promise<NodeInfo[]>, private ttlMs = LIVE_CACHE_MS, private now = () => Date.now()) {}

  get(): Promise<NodeInfo[]> {
    if (this.now() - this.readAt < this.ttlMs) return Promise.resolve(this.nodes);
    this.reading ??= this.read()
      .then((nodes) => {
        this.nodes = nodes;
        this.readAt = this.now();
        return nodes;
      })
      .finally(() => { this.reading = null; });
    return this.reading;
  }
}
