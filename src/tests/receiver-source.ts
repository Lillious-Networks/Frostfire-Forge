import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The receiver's source as the tests read it: receiver.ts, then each packet handler module (phase 6 split the
// switch out of it). A slice that starts at a `case "X":` finds it in the module that holds it.

export function receiverSource(): string {
  const socket = join(import.meta.dir, "..", "socket");
  const handlers = join(socket, "handlers");
  const parts = [readFileSync(join(socket, "receiver.ts"), "utf8")];
  for (const file of readdirSync(handlers).filter((f) => f.endsWith(".ts")).sort()) {
    parts.push(readFileSync(join(handlers, file), "utf8"));
  }
  return parts.join("\n");
}
