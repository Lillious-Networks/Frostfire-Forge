import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The handler modules cannot be imported (they import the receiver, which starts the server). The commands' remote
// branches run in admin-commands.test.ts; here the source is read for what only it shows.
const handlers = join(import.meta.dir, "..", "socket", "handlers");
const commands = readFileSync(join(handlers, "commands.ts"), "utf8");
const session = readFileSync(join(handlers, "session.ts"), "utf8");

/** A case's body, up to the next case label at any indentation. */
function caseBody(source: string, label: string): string {
  const start = source.indexOf(`case "${label}":`);
  expect(start).toBeGreaterThan(-1);
  const from = start + label.length + 8;
  const next = source.slice(from).search(/\n\s*case "/);
  return source.slice(start, next < 0 ? undefined : from + next);
}

test("a player on another node is no longer refused", () => {
  expect(commands).not.toContain("That player is on another server node");
});

test("each remote branch runs its action only for a name", () => {
  const summon = caseBody(commands, "SUMMON");
  expect(summon).toContain('isNaN(Number(identifier)) &&');
  expect(summon).toContain('runOnPlayer(identifier, "cells-summon", {');
  expect(summon).toContain('why: "summon"');
  expect(summon).toContain('p === "admin.summonadmins" || p === "admin.*"');
  const teleport = caseBody(commands, "TELEPORT");
  expect(teleport).toContain('isNaN(Number(identifier)) &&');
  expect(teleport).toContain('runOnPlayer(identifier, "cells-teleport-to", {');
  // The admin's own held permission goes with it, read as /summon reads it (security review M4).
  expect(teleport).toContain('admins: currentPlayer.permissions.some((p: string) => p === "admin.summonadmins" || p === "admin.*"),');
  const revive = caseBody(commands, "REVIVE");
  expect(revive).toContain('isNaN(Number(reviveIdentifier))');
  expect(revive).toContain('runOnPlayer(reviveIdentifier, "cells-revive", { by: currentPlayer.username })');
});

test("AUTH refuses a node ticket that was spent elsewhere, after the account check and before the queue", () => {
  const auth = caseBody(session, "AUTH");
  const allows = auth.indexOf("ticketAllows(");
  const spent = auth.indexOf('if (ticketSpend !== null && ticketSpend !== "spent") {');
  const queued = auth.indexOf("authentication_queue.add(token)");
  expect(allows).toBeGreaterThan(-1);
  expect(spent).toBeGreaterThan(allows);
  expect(queued).toBeGreaterThan(spent);
  const refusal = auth.slice(spent, queued);
  expect(refusal).toContain("packetManager.loginFailed()");
  expect(refusal).toContain('wt.close(1008, unchecked ? "Ticket could not be checked" : "Ticket already used")');
  expect(refusal).toContain("break;");
});
