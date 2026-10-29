import type { LinkSender } from "../cluster/linktransport";

// A pair of in-memory links for cluster tests: what one side sends reaches the
// other side's handler on a later macrotask, as a JSON copy, the way a real
// link decodes a frame. Each side holds one handler per kind (NodeLinks throws
// on a second; a test that attaches twice uses a new pair).

export const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };

export class FakeLink implements LinkSender {
  other!: FakeLink;
  up = true;
  /** Kinds of the reliable messages sent, in order. */
  sent: string[] = [];
  datagrams: Uint8Array[] = [];
  private handlers = new Map<string, (data: any, from: string) => void>();
  private datagramHandler: ((data: Uint8Array, from: string) => void) | null = null;
  private upHandlers: Array<(peer: string) => void> = [];
  private downHandlers: Array<(peer: string) => void> = [];
  constructor(readonly self: string) {}
  isUp(peer: string) { return this.up && peer === this.other.self; }
  send(peer: string, kind: string, data: unknown) {
    if (!this.isUp(peer)) return false;
    this.sent.push(kind);
    if (kind === "CALL" && (data as any)?.name === "BLOCK_MOVE_PROBE") this.probeSeqs.add((data as any).seq);
    if (this.blackhole && !this.letsProbeThrough(kind, data)) return true;
    const copy = JSON.parse(JSON.stringify(data));
    setImmediate(() => this.other.handlers.get(kind)?.(copy, this.self));
    return true;
  }
  sendDatagram(peer: string, data: Uint8Array) {
    if (!this.isUp(peer)) return false;
    this.datagrams.push(data);
    return true;
  }
  /** Hands the datagrams sent so far to the other side. */
  release() { for (const d of this.datagrams.splice(0)) this.other.datagramHandler?.(d, this.self); }
  on(kind: string, handler: (data: any, from: string) => void) { this.handlers.set(kind, handler); }
  onDatagram(handler: (data: Uint8Array, from: string) => void) { this.datagramHandler = handler; }
  onPeerUp(handler: (peer: string) => void) { this.upHandlers.push(handler); }
  onPeerDown(handler: (peer: string) => void) { this.downHandlers.push(handler); }
  setUp(up: boolean) {
    this.up = up;
    this.other.up = up;
    for (const h of up ? this.upHandlers : this.downHandlers) h(this.other.self);
    for (const h of up ? this.other.upHandlers : this.other.downHandlers) h(this.self);
  }
  /** The link is replaced by a new HELLO (the peer may have restarted): an up on both ends with no down before it. */
  replace() {
    for (const h of this.upHandlers) h(this.other.self);
    for (const h of this.other.upHandlers) h(this.self);
  }
  /**
   * While blackholed, the old owner's BLOCK_MOVE_PROBE call and its answer still go through (true, the default): a test
   * that blackholes the link before a move means the call after the probe. A test of the probe itself sets it false.
   */
  probeThrough = true;
  private probeSeqs = new Set<number>();
  private letsProbeThrough(kind: string, data: any): boolean {
    if (!this.probeThrough || !this.other.probeThrough) return false;
    if (kind === "CALL" && data?.name === "BLOCK_MOVE_PROBE") return true;
    return kind === "ANSWER" && this.other.probeSeqs.has(data?.seq);
  }
  /** Drops what is sent from now on without telling either side (a frame lost on a dying link). */
  blackhole = false;
}

export function linkPair() {
  const a = new FakeLink("a");
  const b = new FakeLink("b");
  a.other = b;
  b.other = a;
  return { a, b };
}

/**
 * In-memory links between any number of nodes, all up at the start. As with FakeLink, a message reaches the
 * other side's handler on a later macrotask, as a JSON copy. `setUp(peer, up)` brings one link down or up and
 * runs the peer hooks on both of its ends.
 */
export class MeshLink implements LinkSender {
  peers = new Map<string, MeshLink>();
  /** Every reliable message sent, in order. */
  sent: Array<{ peer: string; kind: string; data: unknown }> = [];
  private upPeers = new Set<string>();
  private handlers = new Map<string, (data: any, from: string) => void>();
  private datagramHandlers: Array<(data: Uint8Array, from: string) => void> = [];
  private upHandlers: Array<(peer: string) => void> = [];
  private downHandlers: Array<(peer: string) => void> = [];
  constructor(readonly self: string) {}
  isUp(peer: string) { return this.upPeers.has(peer); }
  send(peer: string, kind: string, data: unknown) {
    const target = this.peers.get(peer);
    if (!target || !this.isUp(peer)) return false;
    this.sent.push({ peer, kind, data });
    const copy = JSON.parse(JSON.stringify(data ?? null));
    setImmediate(() => target.handlers.get(kind)?.(copy, this.self));
    return true;
  }
  sendDatagram(peer: string, data: Uint8Array) {
    const target = this.peers.get(peer);
    if (!target || !this.isUp(peer)) return false;
    setImmediate(() => { for (const handler of target.datagramHandlers) handler(data, this.self); });
    return true;
  }
  on(kind: string, handler: (data: any, from: string) => void) {
    // A second handler replaces the first, so a node can detach and attach again on the same link. The
    // peer hooks of the earlier attach stay in the lists: a component must ignore them after its detach
    // (LinkCalls does, with a token per attach), or they run again beside the new ones.
    this.handlers.set(kind, handler);
  }
  onDatagram(handler: (data: Uint8Array, from: string) => void) { this.datagramHandlers.push(handler); }
  onPeerUp(handler: (peer: string) => void) { this.upHandlers.push(handler); }
  onPeerDown(handler: (peer: string) => void) { this.downHandlers.push(handler); }
  setUp(peer: string, up: boolean) {
    const other = this.peers.get(peer);
    if (!other) throw new Error(`MeshLink ${this.self} has no peer ${peer}`);
    for (const [end, far] of [[this, other], [other, this]] as const) {
      if (up) end.upPeers.add(far.self);
      else end.upPeers.delete(far.self);
      for (const handler of up ? end.upHandlers : end.downHandlers) handler(far.self);
    }
  }
  /** Marks a peer up without running hooks (the mesh's starting state). */
  connect(peer: MeshLink) {
    this.peers.set(peer.self, peer);
    this.upPeers.add(peer.self);
  }
}

export function linkMesh<N extends string>(names: readonly N[]): Record<N, MeshLink> {
  const links = {} as Record<N, MeshLink>;
  for (const name of names) links[name] = new MeshLink(name);
  for (const a of names) for (const b of names) if (a !== b) links[a].connect(links[b]);
  return links;
}
