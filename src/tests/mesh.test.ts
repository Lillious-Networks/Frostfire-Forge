import { expect, test } from "bun:test";
import {
  MeshMessageType,
  encodeDatagram,
  decodeDatagram,
  encodeAck,
  decodeAck,
  encodeMoverBatch,
  decodeMoverBatch,
  fnv1a32,
  buildHelloPayload,
  verifyHelloPayload,
  MESH_HEADER_SIZE,
  FLAG_ACK_ONLY,
} from "../mesh/protocol";
import { ReliableChannel, seqDistance } from "../mesh/reliable_channel";
import { MeshSocket } from "../mesh/udp";
import { MeshLinks } from "../mesh/links";
import { allocateSessionId } from "../socket/transport";
import * as replication from "../mesh/replication";
import * as handoff from "../mesh/handoff";
import * as regions from "../mesh/regions";
import {
  encodeInputForward,
  decodeInputForward,
} from "../mesh/protocol";
import playerCache from "../services/playermanager";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

async function until(condition: () => boolean, timeoutMs = 3000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(stepMs);
  }
  throw new Error("condition not met within timeout");
}

// ---------------------------------------------------------------------------
// protocol

test("encodeDatagram/decodeDatagram round trip", () => {
  const payload = textEncoder.encode("hello");
  const frame = encodeDatagram(42, true, MeshMessageType.SPAWN, payload);
  expect(frame.length).toBe(MESH_HEADER_SIZE + payload.length);

  const decoded = decodeDatagram(frame)!;
  expect(decoded).not.toBeNull();
  expect(decoded.seq).toBe(42);
  expect(decoded.reliable).toBe(true);
  expect(decoded.ackOnly).toBe(false);
  expect(decoded.type).toBe(MeshMessageType.SPAWN);
  expect(textDecoder.decode(decoded.payload)).toBe("hello");
});

test("decodeDatagram rejects bad magic, version, and truncated frames", () => {
  const frame = encodeDatagram(1, true, MeshMessageType.PING, new Uint8Array(4));
  const view = new DataView(frame.buffer);
  view.setUint32(0, 0xdeadbeef, true);
  expect(decodeDatagram(frame)).toBeNull();

  const badVersion = encodeDatagram(1, true, MeshMessageType.PING, new Uint8Array(4));
  new DataView(badVersion.buffer).setUint8(4, 99);
  expect(decodeDatagram(badVersion)).toBeNull();

  expect(decodeDatagram(frame.slice(0, MESH_HEADER_SIZE - 1))).toBeNull();
  expect(decodeDatagram(new Uint8Array(0))).toBeNull();
});

test("ack datagrams round trip", () => {
  const frame = encodeAck(0xffff + 7, 0b1010);
  const decoded = decodeDatagram(frame)!;
  expect(decoded.ackOnly).toBe(true);
  expect(decoded.flags & FLAG_ACK_ONLY).toBe(FLAG_ACK_ONLY);
  expect(decodeAck(decoded.payload)).toEqual({ ackBase: 0xffff + 7, ackBitmap: 0b1010 });
});

test("mover batch round trips with negative coordinates", () => {
  const movers = [
    { id: 0x85400001, x: -1200, y: 30000, direction: 7, stealth: 1 },
    { id: 1, x: 0, y: 0, direction: 0, stealth: 0 },
    { id: 0xffffffff, x: 32000, y: -32001, direction: 3, stealth: 0 },
  ];
  const batch = encodeMoverBatch("overworld", movers);
  const decoded = decodeMoverBatch(batch)!;
  expect(decoded.mapName).toBe("overworld");
  expect(decoded.movers).toEqual(movers);
});

test("decodeMoverBatch rejects malformed payloads", () => {
  expect(decodeMoverBatch(new Uint8Array(2))).toBeNull();
  // A bare header (empty map name, count 0) is a valid empty batch.
  const empty = new Uint8Array(3);
  expect(decodeMoverBatch(empty)).toEqual({ mapName: "", movers: [] });
  // count claims 2 entries but only 1 present
  const truncated = new Uint8Array(3 + 9);
  new DataView(truncated.buffer).setUint16(1, 2, true);
  expect(decodeMoverBatch(truncated)).toBeNull();
});

test("fnv1a32 is stable", () => {
  expect(fnv1a32("overworld")).toBe(fnv1a32("overworld"));
  expect(fnv1a32("overworld")).not.toBe(fnv1a32("overworld.json"));
  expect(fnv1a32("")).toBe(0x811c9dc5);
});

test("hello payload verifies and rejects tampering", () => {
  const hello = buildHelloPayload("server-a", "cluster-1", "shared-secret");
  const ok = verifyHelloPayload(hello, "shared-secret", "cluster-1");
  expect(ok.ok).toBe(true);
  expect(ok.serverId).toBe("server-a");

  const tampered = { ...hello, signature: "deadbeef" };
  expect(verifyHelloPayload(tampered, "shared-secret", "cluster-1").ok).toBe(false);

  const wrongCluster = { ...hello };
  expect(verifyHelloPayload(wrongCluster, "shared-secret", "other-cluster").ok).toBe(false);

  const stale = buildHelloPayload("server-a", "cluster-1", "shared-secret");
  expect(verifyHelloPayload(stale, "shared-secret", "cluster-1", Date.now() + 60000).ok).toBe(false);
});

// ---------------------------------------------------------------------------
// reliable channel

interface TestLink {
  channel: ReliableChannel;
  out: Uint8Array[];
  delivered: { type: MeshMessageType; text: string }[];
  peer: TestLink | null;
  hold: boolean;
}

function createLink(options: { maxPending?: number } = {}): TestLink {
  const link: TestLink = {
    channel: null as unknown as ReliableChannel,
    out: [],
    delivered: [],
    peer: null,
    hold: false,
  };
  link.channel = new ReliableChannel({
    send: (data) => {
      link.out.push(data);
      if (link.peer && !link.hold) {
        link.peer.channel.handleIncoming(new Uint8Array(data));
      }
    },
    onDeliver: (type, payload) => {
      link.delivered.push({ type, text: textDecoder.decode(payload) });
    },
    retransmitDelayMs: 20,
    maxRetries: 5,
    maxPending: options.maxPending,
    ackDelayMs: 5,
  });
  return link;
}

function pairLinks(options: { maxPending?: number } = {}): { a: TestLink; b: TestLink } {
  const a = createLink(options);
  const b = createLink(options);
  a.peer = b;
  b.peer = a;
  return { a, b };
}

test("reliable messages deliver in order", async () => {
  const { a, b } = pairLinks();
  a.channel.sendReliable(MeshMessageType.SPAWN, textEncoder.encode("m1"));
  a.channel.sendReliable(MeshMessageType.SPAWN, textEncoder.encode("m2"));
  a.channel.sendReliable(MeshMessageType.SPAWN, textEncoder.encode("m3"));

  await until(() => b.delivered.length === 3);
  expect(b.delivered.map((d) => d.text)).toEqual(["m1", "m2", "m3"]);

  a.channel.close();
  b.channel.close();
});

test("out-of-order arrivals are reordered before delivery", async () => {
  const { a, b } = pairLinks();
  a.hold = true;
  a.channel.sendReliable(MeshMessageType.SPAWN, textEncoder.encode("m1"));
  a.channel.sendReliable(MeshMessageType.SPAWN, textEncoder.encode("m2"));
  a.channel.sendReliable(MeshMessageType.SPAWN, textEncoder.encode("m3"));
  expect(a.out.length).toBe(3);

  // Feed m3 first: it must sit in the reorder buffer, then drain after m1+m2.
  b.channel.handleIncoming(a.out[2]);
  expect(b.delivered.length).toBe(0);
  b.channel.handleIncoming(a.out[0]);
  b.channel.handleIncoming(a.out[1]);
  expect(b.delivered.map((d) => d.text)).toEqual(["m1", "m2", "m3"]);

  a.channel.close();
  b.channel.close();
});

test("duplicates are not delivered twice", async () => {
  const { a, b } = pairLinks();
  a.channel.sendReliable(MeshMessageType.SPAWN, textEncoder.encode("m1"));
  await until(() => b.delivered.length === 1);

  const original = a.out[0];
  b.channel.handleIncoming(new Uint8Array(original));
  await Bun.sleep(30);
  expect(b.delivered.length).toBe(1);

  a.channel.close();
  b.channel.close();
});

test("lost reliable messages are retransmitted", async () => {
  const { a, b } = pairLinks();
  a.hold = true;
  a.channel.sendReliable(MeshMessageType.SPAWN, textEncoder.encode("m1"));
  const first = a.out.length;

  // Wait for a retransmit to appear, then deliver only that one.
  await until(() => a.out.length > first);
  b.channel.handleIncoming(a.out[a.out.length - 1]);
  await until(() => b.delivered.length === 1);
  expect(b.delivered[0].text).toBe("m1");

  a.channel.close();
  b.channel.close();
});

test("acks compact the sender pending queue", async () => {
  const { a, b } = pairLinks();
  for (let i = 0; i < 10; i++) {
    a.channel.sendReliable(MeshMessageType.SPAWN, textEncoder.encode(`m${i}`));
  }
  await until(() => b.delivered.length === 10);
  await until(() => a.channel.pendingCount === 0);
  expect(a.channel.queuedCount).toBe(0);

  a.channel.close();
  b.channel.close();
});

test("send window queues overflow and flushes on ack", async () => {
  const { a, b } = pairLinks({ maxPending: 2 });
  a.hold = true;
  for (let i = 0; i < 5; i++) {
    a.channel.sendReliable(MeshMessageType.SPAWN, textEncoder.encode(`m${i}`));
  }
  expect(a.channel.pendingCount).toBe(2);
  expect(a.channel.queuedCount).toBe(3);

  // Release the hold: remaining frames + retransmits flow to b; b's acks
  // (also held from a's perspective until now) flush a's window.
  a.hold = false;
  await until(() => a.channel.pendingCount === 0 && a.channel.queuedCount === 0, 5000);

  a.channel.close();
  b.channel.close();
});

test("unreliable messages are never acked or retransmitted", async () => {
  const { a, b } = pairLinks();
  a.channel.sendUnreliable(MeshMessageType.MOVER_BATCH, textEncoder.encode("mv1"));
  await until(() => b.delivered.length === 1);
  await until(() => a.channel.pendingCount === 0, 500);
  expect(a.channel.pendingCount).toBe(0);

  a.channel.close();
  b.channel.close();
});

test("seqDistance handles u16 wraparound", () => {
  expect(seqDistance(10, 5)).toBe(5);
  expect(seqDistance(5, 10)).toBe(-5);
  expect(seqDistance(0, 0xffff)).toBe(1);
  expect(seqDistance(0xffff, 0)).toBe(-1);
  expect(seqDistance(0x8000, 0)).toBe(-0x8000);
});

// ---------------------------------------------------------------------------
// MeshSocket over real loopback UDP

async function startSocketPair(secret: string, cluster: string) {
  const receivedA: Array<{ from: string; type: MeshMessageType; text: string }> = [];
  const receivedB: Array<{ from: string; type: MeshMessageType; text: string }> = [];

  const a = new MeshSocket({
    bindHost: "127.0.0.1",
    port: 0,
    secret,
    cluster,
    localServerId: "server-a",
    onMessage: (from, type, payload) => receivedA.push({ from, type, text: textDecoder.decode(payload) }),
    retransmitDelayMs: 20,
    maxRetries: 30,
  });
  const b = new MeshSocket({
    bindHost: "127.0.0.1",
    port: 0,
    secret,
    cluster,
    localServerId: "server-b",
    onMessage: (from, type, payload) => receivedB.push({ from, type, text: textDecoder.decode(payload) }),
    retransmitDelayMs: 20,
    maxRetries: 30,
  });
  await a.start();
  await b.start();
  return { a, b, receivedA, receivedB };
}

test("mesh sockets perform the mutual HELLO handshake", async () => {
  const { a, b } = await startSocketPair("secret", "cluster");
  a.connectTo("server-b", "127.0.0.1", b.port);
  b.connectTo("server-a", "127.0.0.1", a.port);

  await until(() => a.isConnected("server-b") && b.isConnected("server-a"));
  expect(a.getConnectedServerIds()).toEqual(["server-b"]);
  expect(b.getConnectedServerIds()).toEqual(["server-a"]);

  a.stop();
  b.stop();
});

test("mesh sockets exchange reliable and unreliable messages", async () => {
  const { a, b, receivedB } = await startSocketPair("secret", "cluster");
  a.connectTo("server-b", "127.0.0.1", b.port);
  b.connectTo("server-a", "127.0.0.1", a.port);
  await until(() => a.isConnected("server-b") && b.isConnected("server-a"));

  a.sendReliable("server-b", MeshMessageType.SPAWN, textEncoder.encode("spawn-blob"));
  a.sendUnreliable("server-b", MeshMessageType.MOVER_BATCH, textEncoder.encode("mover-blob"));

  await until(() => receivedB.length >= 2);
  expect(receivedB.map((m) => m.from)).toEqual(["server-a", "server-a"]);
  expect(receivedB.map((m) => m.type).sort()).toEqual([MeshMessageType.SPAWN, MeshMessageType.MOVER_BATCH].sort());
  expect(receivedB.map((m) => m.text).sort()).toEqual(["mover-blob", "spawn-blob"]);

  a.stop();
  b.stop();
});

test("mesh sockets reject peers with the wrong secret", async () => {
  const { a, receivedA } = await startSocketPair("secret", "cluster");
  const intruder = new MeshSocket({
    bindHost: "127.0.0.1",
    port: 0,
    secret: "wrong-secret",
    cluster: "cluster",
    localServerId: "intruder",
    onMessage: (from, type, payload) => receivedA.push({ from, type, text: textDecoder.decode(payload) }),
    retransmitDelayMs: 20,
    maxRetries: 30,
  });
  await intruder.start();
  intruder.connectTo("server-a", "127.0.0.1", a.port);

  await Bun.sleep(300);
  expect(a.isConnected("intruder")).toBe(false);
  expect(intruder.isConnected("server-a")).toBe(false);

  a.stop();
  intruder.stop();
});

test("mesh sockets reject peers from a different cluster", async () => {
  const { a, receivedA } = await startSocketPair("secret", "cluster-1");
  const other = new MeshSocket({
    bindHost: "127.0.0.1",
    port: 0,
    secret: "secret",
    cluster: "cluster-2",
    localServerId: "other",
    onMessage: (from, type, payload) => receivedA.push({ from, type, text: textDecoder.decode(payload) }),
    retransmitDelayMs: 20,
    maxRetries: 30,
  });
  await other.start();
  other.connectTo("server-a", "127.0.0.1", a.port);

  await Bun.sleep(300);
  expect(a.isConnected("other")).toBe(false);
  expect(other.isConnected("server-a")).toBe(false);

  a.stop();
  other.stop();
});

// ---------------------------------------------------------------------------
// MeshLinks

test("mesh links connect, broadcast, and detect peer loss", async () => {
  const linksA = new MeshLinks({
    enabled: true,
    bindHost: "127.0.0.1",
    port: 0,
    cluster: "test-cluster",
    secret: "secret",
    localServerId: "a",
    heartbeatIntervalMs: 40,
    peerTimeoutMs: 200,
    reconnectBaseDelayMs: 50,
    reconnectMaxDelayMs: 100,
    retransmitDelayMs: 20,
    maxRetries: 10,
  });
  const linksB = new MeshLinks({
    enabled: true,
    bindHost: "127.0.0.1",
    port: 0,
    cluster: "test-cluster",
    secret: "secret",
    localServerId: "b",
    heartbeatIntervalMs: 40,
    peerTimeoutMs: 200,
    reconnectBaseDelayMs: 50,
    reconnectMaxDelayMs: 100,
    retransmitDelayMs: 20,
    maxRetries: 10,
  });

  const received: Array<{ from: string; type: MeshMessageType; text: string }> = [];
  let peerDownNotified = false;
  linksB.onMessage((from, type, payload) => received.push({ from, type, text: textDecoder.decode(payload) }));
  linksA.onPeerDown(() => {
    peerDownNotified = true;
  });

  await linksA.start();
  await linksB.start();

  linksA.setPeerList([{ serverId: "b", host: "127.0.0.1", port: linksB.port }]);
  linksB.setPeerList([{ serverId: "a", host: "127.0.0.1", port: linksA.port }]);

  await until(() => linksA.isConnected("b") && linksB.isConnected("a"));

  linksA.broadcast(MeshMessageType.STATE_EVENT, textEncoder.encode("event-1"));
  await until(() => received.some((m) => m.type === MeshMessageType.STATE_EVENT));
  expect(received.find((m) => m.type === MeshMessageType.STATE_EVENT)).toEqual({
    from: "a",
    type: MeshMessageType.STATE_EVENT,
    text: "event-1",
  });

  // Killing B must surface as a peer-down on A within the silence timeout.
  linksB.stop();
  await until(() => peerDownNotified, 2000);
  expect(linksA.isConnected("b")).toBe(false);

  linksA.stop();
});

test("mesh links reconnect after a peer restarts", async () => {
  const linksA = new MeshLinks({
    enabled: true,
    bindHost: "127.0.0.1",
    port: 0,
    cluster: "test-cluster",
    secret: "secret",
    localServerId: "a",
    heartbeatIntervalMs: 40,
    peerTimeoutMs: 200,
    reconnectBaseDelayMs: 50,
    reconnectMaxDelayMs: 100,
    retransmitDelayMs: 20,
    maxRetries: 10,
  });
  await linksA.start();

  const makeB = () =>
    new MeshLinks({
      enabled: true,
      bindHost: "127.0.0.1",
      port: 0,
      cluster: "test-cluster",
      secret: "secret",
      localServerId: "b",
      heartbeatIntervalMs: 40,
      peerTimeoutMs: 200,
      reconnectBaseDelayMs: 50,
      reconnectMaxDelayMs: 100,
      retransmitDelayMs: 20,
      maxRetries: 10,
    });

  const b1 = makeB();
  await b1.start();
  const bPort = b1.port;
  linksA.setPeerList([{ serverId: "b", host: "127.0.0.1", port: bPort }]);
  await until(() => linksA.isConnected("b"));

  b1.stop();
  await until(() => !linksA.isConnected("b"), 2000);

  const b2 = makeB();
  await b2.start();
  linksA.setPeerList([{ serverId: "b", host: "127.0.0.1", port: b2.port }]);
  await until(() => linksA.isConnected("b"), 5000);

  linksA.stop();
  b2.stop();
});

// ---------------------------------------------------------------------------
// replication

const replicationTextEncoder = new TextEncoder();

function spawnPayload(id: string, map: string, x: number, y: number, username: string) {
  return replicationTextEncoder.encode(
    JSON.stringify({
      id,
      map,
      spawnData: {
        id,
        username,
        location: { map, x, y, direction: "down" },
        isStealth: false,
        isVanished: false,
        party: [],
        spriteData: { bodySprite: "body.png" },
      },
    })
  );
}

test("replication SPAWN creates and indexes a ghost", () => {
  replication.clearGhosts();
  expect(replication.isMeshEnabled()).toBe(false);
  expect(replication.getGhostCount()).toBe(0);

  replication.handleMeshMessage("server-b", MeshMessageType.SPAWN, spawnPayload("1001", "overworld", 10, 20, "alice"));

  expect(replication.getGhostCount()).toBe(1);
  expect(replication.hasGhostsOnMap("overworld")).toBe(true);
  expect(replication.getGhostsOnMap("other")).toEqual([]);

  const ghost = replication.getGhost("1001")!;
  expect(ghost.map).toBe("overworld");
  expect(ghost.position).toEqual({ x: 10, y: 20, direction: "down" });
  expect(ghost.authorityServerId).toBe("server-b");

  replication.clearGhosts();
});

test("replication MOVER_BATCH updates ghost positions", () => {
  replication.clearGhosts();
  replication.handleMeshMessage("server-b", MeshMessageType.SPAWN, spawnPayload("1001", "overworld", 0, 0, "alice"));

  const movers = [
    { id: 1001, x: 100, y: -50, direction: 7, stealth: 0 },
    { id: 9999, x: 1, y: 1, direction: 0, stealth: 0 }, // unknown ghost - ignored
  ];
  replication.handleMeshMessage("server-b", MeshMessageType.MOVER_BATCH, encodeMoverBatch("overworld", movers));

  const ghost = replication.getGhost("1001")!;
  expect(ghost.position).toEqual({ x: 100, y: -50, direction: "downright" });

  replication.clearGhosts();
});

test("replication DESPAWN removes the ghost", () => {
  replication.clearGhosts();
  replication.handleMeshMessage("server-b", MeshMessageType.SPAWN, spawnPayload("1001", "overworld", 0, 0, "alice"));
  expect(replication.getGhostCount()).toBe(1);

  replication.handleMeshMessage(
    "server-b",
    MeshMessageType.DESPAWN,
    replicationTextEncoder.encode(JSON.stringify({ id: "1001", map: "overworld" }))
  );
  expect(replication.getGhostCount()).toBe(0);
  expect(replication.hasGhostsOnMap("overworld")).toBe(false);

  replication.clearGhosts();
});

test("replication getGhostMovers filters by interested ids", () => {
  replication.clearGhosts();
  replication.handleMeshMessage("server-b", MeshMessageType.SPAWN, spawnPayload("1001", "overworld", 0, 0, "alice"));
  replication.handleMeshMessage("server-b", MeshMessageType.SPAWN, spawnPayload("1002", "overworld", 50, 50, "bob"));
  replication.handleMeshMessage("server-c", MeshMessageType.SPAWN, spawnPayload("1003", "dungeon", 0, 0, "eve"));

  const movers = replication.getGhostMovers("overworld", new Set(["1002"]));
  expect(movers.length).toBe(1);
  expect(movers[0].id).toBe("1002");
  expect(movers[0].direction).toBe("down");

  replication.clearGhosts();
});

test("replication removeGhostsFromServer cleans up only that server's ghosts", () => {
  replication.clearGhosts();
  replication.handleMeshMessage("server-b", MeshMessageType.SPAWN, spawnPayload("1001", "overworld", 0, 0, "alice"));
  replication.handleMeshMessage("server-b", MeshMessageType.SPAWN, spawnPayload("1002", "overworld", 0, 0, "bob"));
  replication.handleMeshMessage("server-c", MeshMessageType.SPAWN, spawnPayload("1003", "overworld", 0, 0, "eve"));

  replication.removeGhostsFromServer("server-b");
  expect(replication.getGhostCount()).toBe(1);
  expect(replication.getGhost("1003")).toBeDefined();

  replication.clearGhosts();
});

test("replication re-spawn moves a ghost between maps", () => {
  replication.clearGhosts();
  replication.handleMeshMessage("server-b", MeshMessageType.SPAWN, spawnPayload("1001", "overworld", 0, 0, "alice"));
  replication.handleMeshMessage("server-b", MeshMessageType.SPAWN, spawnPayload("1001", "dungeon", 5, 5, "alice"));

  expect(replication.getGhostCount()).toBe(1);
  expect(replication.hasGhostsOnMap("overworld")).toBe(false);
  expect(replication.hasGhostsOnMap("dungeon")).toBe(true);

  replication.clearGhosts();
});

// ---------------------------------------------------------------------------
// phase 2.2: regions, input forwarding, handoff

test("hello payload round-trips the server index", () => {
  const hello = buildHelloPayload("server-b", "cluster", "secret", 2);
  const ok = verifyHelloPayload(hello, "secret", "cluster");
  expect(ok.ok).toBe(true);
  expect(ok.serverIndex).toBe(2);
});

test("input forward codec round trips", () => {
  const encoded = encodeInputForward("4294967295", 7);
  const decoded = decodeInputForward(encoded)!;
  expect(decoded.playerId).toBe("4294967295");
  expect(decoded.directionIndex).toBe(7);
  expect(decodeInputForward(new Uint8Array(3))).toBeNull();
});

test("region ownership is deterministic and gated on a complete roster", () => {
  regions.initRegions("server-1", 1);

  // No peers known: ownership undecided (stay local).
  expect(regions.getRegionOwner("overworld", 100, 100, ["server-2"])).toBeUndefined();

  regions.learnPeerIndex("server-2", 2);
  regions.learnPeerIndex("server-3", 3);

  const desired = ["server-2", "server-3"];
  const rosterByIndex = ["server-1", "server-2", "server-3"];

  // Ownership is fnv1a(regionKey) % rosterSize over the index-sorted roster.
  const owners = new Set<string>();
  for (let x = 0; x < 100000; x += 1024) {
    for (let y = 0; y < 100000; y += 1024) {
      const region = regions.regionOf("overworld", x, y);
      const hash = fnv1a32(regions.regionKey(region.map, region.regionX, region.regionY));
      const expected = rosterByIndex[hash % 3];

      const owner = regions.getRegionOwner("overworld", x, y, desired);
      expect(owner).toBe(expected === "server-1" ? null : expected);
      if (typeof owner === "string") owners.add(owner);
    }
  }

  // Regions spread across remote owners AND local ones.
  expect(owners.size).toBe(2);

  regions.forgetPeerIndex("server-2");
  regions.forgetPeerIndex("server-3");
});

test("region ownership is local when alone", () => {
  regions.initRegions("solo", 1);
  expect(regions.getRegionOwner("overworld", 0, 0, [])).toBeNull();
});

test("handoff request builds a connection-less avatar on the owner", async () => {
  handoff.initHandoff("server-1");
  handoff.attachMeshLinks({
    enabled: true,
    sendToServer: () => true,
  } as any);
  handoff.attachHandoffHooks({
    buildSpawnData: async (player: any) => ({
      id: player.id,
      username: player.username,
      location: { map: "overworld", x: 50, y: 60, direction: "down" },
    }),
  });

  const state = {
    playerId: "4242",
    spawnData: {
      id: "4242",
      username: "alice",
      location: { map: "overworld", x: 50, y: 60, direction: "down" },
    },
    runtime: {
      stats: { health: 100, max_health: 100 },
      pvp: false,
      mounted: false,
      mount_type: null,
      isStealth: false,
      isVanished: false,
      isNoclip: false,
      isAdmin: false,
      isGuest: true,
      party: null,
      guild: null,
      guild_name: null,
      equipment: {},
      equipmentRevision: 0,
      spellCooldowns: {},
      castId: 0,
      casting: false,
      stunnedUntil: 0,
      slowPercent: 0,
      slowMultiplier: 1,
      last_attack: null,
      attackDelay: 0,
    },
  };

  handoff.handleHandoffRequest("server-2", textEncoder.encode(JSON.stringify(state)));

  await until(() => playerCache.get("4242") !== undefined);
  const avatar = playerCache.get("4242")!;
  expect(avatar.remoteAvatar).toBe(true);
  expect(avatar.remotePresence).toBe("server-2");
  expect(avatar.ws).toBeNull();
  expect(avatar.username).toBe("alice");

  handoff.cleanupAvatar(avatar);
  expect(playerCache.get("4242")).toBeUndefined();

  handoff.attachMeshLinks(null);
});

test("handoff complete marks the presence player as remote-simulated", () => {
  const player: any = {
    id: "4242",
    username: "alice",
    handoffPending: true,
    location: { map: "overworld", position: { x: 1, y: 2, direction: "down" } },
  };
  playerCache.add(player.id, player);

  handoff.handleHandoffComplete(
    textEncoder.encode(JSON.stringify({ playerId: "4242", authority: "server-2" }))
  );

  expect(player.remoteSim).toBe(true);
  expect(player.remoteAuthority).toBe("server-2");
  expect(player.handoffPending).toBe(false);

  handoff.handleAuthorityDown("server-2");
  expect(player.remoteSim).toBe(false);
  expect(player.remoteAuthority).toBeNull();

  playerCache.remove("4242");
});

test("presence forwards movement input to the authority via mesh links", () => {
  const sent: Array<{ serverId: string; type: number; reliable: boolean; payload: Uint8Array }> = [];
  replication.attachMeshLinks({
    enabled: true,
    sendToServer: (serverId: string, type: number, payload: Uint8Array, reliable: boolean) => {
      sent.push({ serverId, type, reliable, payload });
      return true;
    },
    broadcast: () => {},
  } as any);

  const player = { id: "4242", remoteAuthority: "server-2" };
  replication.forwardMoveInput(player, 7);
  replication.forwardPacketInput(player, JSON.stringify({ type: "ATTACK", data: {} }));

  expect(sent.length).toBe(2);
  expect(sent[0].serverId).toBe("server-2");
  expect(sent[0].type).toBe(MeshMessageType.INPUT_FORWARD);
  expect(sent[0].reliable).toBe(false);
  expect(decodeInputForward(sent[0].payload)!.directionIndex).toBe(7);
  expect(sent[1].type).toBe(MeshMessageType.INPUT_PACKET);
  expect(sent[1].reliable).toBe(true);

  replication.attachMeshLinks(null);
});

test("remote-simulated players get positions fed back into the mover pipeline", () => {  const movementQueue = new Map<string, any>();
  replication.attachHooks({
    queueLocalMover: (playerId: string, movementData: any) => {
      movementQueue.set(playerId, movementData);
    },
  });

  const player = {
    id: "4242",
    username: "alice",
    remoteSim: true,
    remoteAuthority: "server-b",
    location: { map: "overworld", position: { x: 0, y: 0, direction: "down" } },
    aoi: { playersInAOI: new Set<string>() },
  };
  playerCache.add(player.id, player);

  const movers = [{ id: 4242, x: 120, y: -40, direction: 7, stealth: 0 }];
  replication.handleMeshMessage("server-b", MeshMessageType.MOVER_BATCH, encodeMoverBatch("overworld", movers));

  expect(player.location.position).toEqual({ x: 120, y: -40, direction: "downright" });
  expect(movementQueue.has("4242")).toBe(true);

  playerCache.remove("4242");
  replication.clearGhosts();
});

test("aoi refreshes are rate-limited per player", () => {
  let updates = 0;
  replication.attachHooks({
    updatePlayerAOI: async () => {
      updates++;
    },
  });

  const player: any = {
    id: "7777",
    username: "bob",
    aoi: { playersInAOI: new Set<string>() },
    ws: { readyState: 1, send: () => {} },
    location: { map: "overworld", position: { x: 0, y: 0, direction: "down" } },
  };
  playerCache.add(player.id, player);

  // A moving ghost marks everyone on its map; the first flush runs, the
  // immediate second one must be skipped by the min-interval throttle.
  replication.handleMeshMessage("server-b", MeshMessageType.SPAWN, spawnPayload("5555", "overworld", 0, 0, "carol"));
  replication.handleMeshMessage(
    "server-b",
    MeshMessageType.MOVER_BATCH,
    encodeMoverBatch("overworld", [{ id: 5555, x: 200, y: 200, direction: 0, stealth: 0 }])
  );

  replication.flushAoIRefreshQueue();
  expect(updates).toBe(1);

  // Ghost moves again -> player re-marked, but still within the interval.
  replication.handleMeshMessage(
    "server-b",
    MeshMessageType.MOVER_BATCH,
    encodeMoverBatch("overworld", [{ id: 5555, x: 400, y: 400, direction: 0, stealth: 0 }])
  );
  replication.flushAoIRefreshQueue();
  expect(updates).toBe(1);

  playerCache.remove("7777");
  replication.clearGhosts();
});

test("mesh peers exchange connection counts for the global total", async () => {
  const linksA = new MeshLinks({
    enabled: true,
    bindHost: "127.0.0.1",
    port: 0,
    cluster: "test-cluster",
    secret: "secret",
    localServerId: "a",
    heartbeatIntervalMs: 40,
    peerTimeoutMs: 400,
    reconnectBaseDelayMs: 50,
    reconnectMaxDelayMs: 100,
  });
  const linksB = new MeshLinks({
    enabled: true,
    bindHost: "127.0.0.1",
    port: 0,
    cluster: "test-cluster",
    secret: "secret",
    localServerId: "b",
    heartbeatIntervalMs: 40,
    peerTimeoutMs: 400,
    reconnectBaseDelayMs: 50,
    reconnectMaxDelayMs: 100,
  });

  replication.attachMeshLinks(linksA);
  linksA.onMessage((serverId, type, payload) => {
    replication.handleMeshMessage(serverId, type, payload);
  });

  await linksA.start();
  await linksB.start();

  linksA.setPeerList([{ serverId: "b", host: "127.0.0.1", port: linksB.port }]);
  linksB.setPeerList([{ serverId: "a", host: "127.0.0.1", port: linksA.port }]);
  await until(() => linksA.isConnected("b") && linksB.isConnected("a"));

  // B reports its count over the mesh; A must see it.
  linksB.broadcast(
    MeshMessageType.CONNECTION_COUNT,
    textEncoder.encode(JSON.stringify({ count: 42 })),
    false
  );

  await until(() => replication.getPeerConnectionCount() === 42);
  expect(replication.getPeerConnectionCount()).toBe(42);

  linksA.stop();
  linksB.stop();
  replication.attachMeshLinks(null);
  replication.clearGhosts();
});

// ---------------------------------------------------------------------------
// session id allocation

test("allocateSessionId returns unique ids in the mesh band when indexed", () => {
  const previous = process.env.MESH_SERVER_INDEX;
  process.env.MESH_SERVER_INDEX = "5";

  const active = new Set<string>();
  const ids = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const id = allocateSessionId(active)!;
    expect(id).not.toBeNull();
    const numeric = parseInt(id, 10);
    expect(numeric).toBeGreaterThanOrEqual(0x85000000);
    expect(numeric).toBeLessThan(0x86000000);
    active.add(id);
    ids.add(id);
  }
  expect(ids.size).toBe(100);

  if (previous === undefined) {
    delete process.env.MESH_SERVER_INDEX;
  } else {
    process.env.MESH_SERVER_INDEX = previous;
  }
});

test("mesh id bands are disjoint across server indexes", () => {
  const previous = process.env.MESH_SERVER_INDEX;
  process.env.MESH_SERVER_INDEX = "3";
  const first = parseInt(allocateSessionId(new Set<string>())!, 10);
  process.env.MESH_SERVER_INDEX = "4";
  const second = parseInt(allocateSessionId(new Set<string>())!, 10);

  expect(Math.floor(first / 0x1000000)).toBe(0x83);
  expect(Math.floor(second / 0x1000000)).toBe(0x84);
  expect(Math.floor(first / 0x1000000)).not.toBe(Math.floor(second / 0x1000000));

  if (previous === undefined) {
    delete process.env.MESH_SERVER_INDEX;
  } else {
    process.env.MESH_SERVER_INDEX = previous;
  }
});

test("allocateSessionId falls back to random ids without an index", () => {
  const previous = process.env.MESH_SERVER_INDEX;
  delete process.env.MESH_SERVER_INDEX;

  const active = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const id = allocateSessionId(active)!;
    expect(id).not.toBeNull();
    active.add(id);
  }
  expect(active.size).toBe(20);

  if (previous !== undefined) {
    process.env.MESH_SERVER_INDEX = previous;
  }
});
