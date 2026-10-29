// src/socket/handlers/index.ts
import type { PacketContext } from "./context";
import * as chat from "./chat";
import * as combat from "./combat";
import * as commands from "./commands";
import * as death from "./death";
import * as editors from "./editors";
import * as gathering from "./gathering";
import * as items from "./items";
import * as mail from "./mail";
import * as movement from "./movement";
import * as npcs from "./npcs";
import * as session from "./session";
import * as social from "./social";
import * as targeting from "./targeting";
import * as trade from "./trade";

// Which module handles which packet type. Each module lists its own types; a type listed twice is an error at load.

export interface PacketModule {
  handles: ReadonlySet<string>;
  handle(ctx: PacketContext): Promise<unknown>;
}

const modules: PacketModule[] = [session, movement, chat, targeting, combat, editors, npcs, commands, social, trade, death, items, gathering, mail];
const byType = new Map<string, PacketModule>();
for (const module of modules) {
  for (const type of module.handles) {
    if (byType.has(type)) throw new Error(`Packet type ${type} has two handlers`);
    byType.set(type, module);
  }
}

export function route(type: string): PacketModule | undefined {
  return byType.get(type);
}
