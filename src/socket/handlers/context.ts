// src/socket/handlers/context.ts

// What a packet handler is given: the connection, the packet, and the player it came from (null before login).
// packetReceiver builds it once per packet, after its checks, and hands it to the module that handles the type.

export interface PacketContext {
  server: any;
  wt: any;
  message: string;
  parsedMessage: Packet;
  data: any;
  type: string;
  currentPlayer: any;
  resolveNpcParticles: (npc: Npc) => Promise<Npc>;
  resolveNpcForClient: (npc: Npc) => Promise<any>;
}
