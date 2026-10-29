import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyPartyMembers, cacheIfHeld, clearParty } from "../socket/partystate";
import { clusterEnabled } from "../cluster/config";
import playerCache from "../services/playermanager";

test("members set the party and its id", async () => {
  const p: any = { username: "alice", party: [], party_id: null };
  await applyPartyMembers(p, ["alice", "bob"], async (name) => (name === "alice" ? 12 : null));
  expect(p.party).toEqual(["alice", "bob"]);
  expect(p.party_id).toBe(12);
});

test("no members clear the id without asking", async () => {
  const p: any = { username: "alice", party: ["alice", "bob"], party_id: 12 };
  let asked = false;
  await applyPartyMembers(p, [], async () => { asked = true; return 12; });
  expect(p.party).toEqual([]);
  expect(p.party_id).toBeNull();
  expect(asked).toBe(false);
});

test("a failed look-up leaves no stale id", async () => {
  const p: any = { username: "alice", party: [], party_id: 3 };
  await applyPartyMembers(p, ["alice", "bob"], async () => { throw new Error("db"); });
  expect(p.party).toEqual(["alice", "bob"]);
  expect(p.party_id).toBeNull();
});

test("clearParty clears both", () => {
  const p: any = { party: ["alice"], party_id: 4 };
  clearParty(p);
  expect(p).toEqual({ party: [], party_id: null });
});

// The look-up is slow here: the party changes while it runs.
const slowId = (id: number) => () => new Promise<number>((resolve) => setTimeout(() => resolve(id), 20));

test("a clear during the look-up leaves the id null", async () => {
  const p: any = { username: "alice", party: [], party_id: null };
  const update = applyPartyMembers(p, ["alice", "bob"], slowId(5));
  clearParty(p);
  await update;
  expect(p.party).toEqual([]);
  expect(p.party_id).toBeNull();
});

test("a newer update during the look-up sets its own id", async () => {
  const p: any = { username: "alice", party: [], party_id: null };
  const older = applyPartyMembers(p, ["alice", "bob"], slowId(5));
  const newer = applyPartyMembers(p, ["alice"], async () => 7);
  await newer;
  await older;
  expect(p.party).toEqual(["alice"]);
  expect(p.party_id).toBe(7);
});

test("a player who left the cache during the look-up is not put back", async () => {
  const p: any = { id: "9101", username: "gone", party: [], party_id: null };
  playerCache.add(p.id, p);
  const update = applyPartyMembers(p, ["gone", "bob"], slowId(5));
  playerCache.remove(p.id);
  await update;
  cacheIfHeld(playerCache, p);
  expect(playerCache.get(p.id)).toBeUndefined();
});

test("a player still in the cache is written back", async () => {
  const p: any = { id: "9102", username: "here", party: [], party_id: null };
  playerCache.add(p.id, p);
  await applyPartyMembers(p, ["here", "bob"], slowId(5));
  cacheIfHeld(playerCache, p);
  expect(playerCache.get(p.id)).toBe(p);
  playerCache.remove(p.id);
});

// With CLUSTER unset the party writes stay as they were: the party id is neither read nor cleared. The receiver
// cannot be imported by a test, so its gates are read from the source. Whitespace is collapsed so a re-indent does
// not break the checks.
const socket = join(import.meta.dir, "..", "socket");
const flat = (text: string) => text.replace(/\s+/g, " ");
const receiver = flat(readFileSync(join(socket, "receiver.ts"), "utf8"));
const social = flat(readFileSync(join(socket, "handlers", "social.ts"), "utf8"));

test("CLUSTER unset means not cluster mode", () => {
  const saved = process.env.CLUSTER;
  delete process.env.CLUSTER;
  try {
    expect(clusterEnabled()).toBe(false);
  } finally {
    if (saved === undefined) delete process.env.CLUSTER;
    else process.env.CLUSTER = saved;
  }
});

test("party-cleared keeps the old write unless cluster mode is on", () => {
  expect(receiver).toContain("if (clusterEnabled()) clearParty(p); else p.party = []; playerCache.set(p.id, p);");
});

test("party-update reads the party id only in cluster mode, and writes the player back only if still cached", () => {
  expect(receiver).toContain(
    "if (clusterEnabled()) { await trackPacket(String(p.id), () => applyPartyMembers(p, Array.isArray(members) ? members : [], (username) => parties.getPartyId(username))); cacheIfHeld(playerCache, p); } else { p.party = members; playerCache.set(p.id, p); }",
  );
});

test("LEAVE_PARTY keeps the old write unless cluster mode is on", () => {
  expect(social).toContain("if (clusterEnabled()) clearParty(currentPlayer); else currentPlayer.party = []; playerCache.set(currentPlayer.id, currentPlayer);");
});
