import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The receiver cannot be imported (it starts the server), and neither can the handler modules (they import it):
// the routing is read from their source.

const dir = join(import.meta.dir, "..", "socket", "handlers");
const modules = readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "context.ts" && f !== "index.ts");

function handlesOf(file: string): string[] {
  const text = readFileSync(join(dir, file), "utf8");
  const match = text.match(/export const handles: ReadonlySet<string> = new Set\(\[([\s\S]*?)\]\);/);
  if (!match) throw new Error(`${file} has no handles set`);
  return [...match[1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
}

// The receiver's validPacketTypes is built from this object (src/socket/types.ts): every key of it, the packets
// the server sends included.
const knownTypes = (): Set<string> => {
  const text = readFileSync(join(import.meta.dir, "..", "socket", "types.ts"), "utf8");
  return new Set([...text.matchAll(/^\s+([A-Z_0-9]+):\s*"/gm)].map((m) => m[1]));
};

test("every handler module names the labels it handles, and no label is handled twice", () => {
  const seen = new Map<string, string>();
  for (const file of modules) {
    for (const label of handlesOf(file)) {
      expect(seen.has(label) ? `${label} in ${seen.get(label)} and ${file}` : "").toBe("");
      seen.set(label, file);
    }
  }
  // The count is the coverage check: the receiver's switch had 181 labels, plus CLUSTER_DEBUG and HANDOFF_GAP, so a label that lost its handler fails here.
  // (There is no list of the packets a client sends, only validPacketTypes, which holds the server's own as well.)
  expect(seen.size).toBe(183);
});

test("every label a module names is a case of its own switch", () => {
  for (const file of modules) {
    const text = readFileSync(join(dir, file), "utf8");
    for (const label of handlesOf(file)) expect(text).toContain(`case "${label}":`);
    const cases = [...text.matchAll(/^\s{6}case "([A-Z_]+)":/gm)].map((m) => m[1]);
    expect(new Set(cases)).toEqual(new Set(handlesOf(file)));
  }
});

test("the receiver keeps no packet case and routes through the handler index", () => {
  const receiver = readFileSync(join(import.meta.dir, "..", "socket", "receiver.ts"), "utf8");
  const body = receiver.slice(receiver.indexOf("export default async function packetReceiver("));
  expect(body).not.toMatch(/^\s{6}case "[A-Z_]+":/m);
  expect(body).toContain('handlerRoutes ??= await import("./handlers/index")');
  expect(body).toContain("log.error(`Unknown packet type: ${type}`)");
  const index = readFileSync(join(dir, "index.ts"), "utf8");
  for (const file of modules) expect(index).toContain(`from "./${file.replace(/\.ts$/, "")}"`);
});

test("every label a module handles is a packet type the receiver accepts", () => {
  const known = knownTypes();
  expect(known.size).toBeGreaterThan(181);
  for (const file of modules) {
    for (const label of handlesOf(file)) expect(known.has(label) ? "" : `${label} in ${file}`).toBe("");
  }
});

// The handler modules load at the first packet, so the receiver keeps a bare import of every module it used to import
// that only they use now: without them, assetloader (which loads the assets and maps when it is imported) would run
// at the first packet instead of at startup.
test("the receiver still loads the asset loader and the other modules at startup", () => {
  const receiver = readFileSync(join(import.meta.dir, "..", "socket", "receiver.ts"), "utf8");
  expect(receiver).toContain('import "../modules/assetloader";');
  const sources = modules.map((file) => readFileSync(join(dir, file), "utf8"));
  for (const line of receiver.matchAll(/^import "([^"]+)";$/gm)) {
    const base = line[1].replace(/^\.{1,2}\//, "").replace(/\.ts$/, "");
    expect(sources.some((source) => source.includes(`/${base}"`) || source.includes(`/${base}.ts"`)) ? "" : line[1]).toBe("");
  }
});
