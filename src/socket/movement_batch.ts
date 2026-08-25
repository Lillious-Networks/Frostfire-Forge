export const BATCH_HEADER = 0x01;
export const MAX_DATAGRAM_SIZE = 1200;
const ENTRY_BYTES = 9;
const PROBE_BYTES = 10; // [u32 seq][u32 seconds][u16 ms]
const MAX_ENTRIES = Math.floor((MAX_DATAGRAM_SIZE - 3 - PROBE_BYTES) / ENTRY_BYTES);

export const DIRECTION_MAP: Record<string, number> = {
  up: 0, down: 1, left: 2, right: 3,
  upleft: 4, upright: 5, downleft: 6, downright: 7,
};

export interface MoverSnapshot {
  id: string;
  x: number;
  y: number;
  direction: string;
  stealth: boolean;
  vanished: boolean;
  party: string[];
}

export interface ReceiverInfo {
  x: number;
  y: number;
  isAdmin: boolean;
  username: string;
  seq?: number;
}

export function collectReceiverEntries(
  set: Set<string>,
  movers: MoverSnapshot[],
  receiver: ReceiverInfo,
  tick: number,
  tierDistance = 0
): any[] {
  const entries: any[] = [];

  for (const mover of movers) {
    if (!set.has(mover.id)) continue;
    if (mover.stealth && !receiver.isAdmin) continue;
    if (mover.vanished && !receiver.isAdmin && !(mover.party || []).includes(receiver.username)) continue;

    if (tierDistance > 0) {
      const dx = mover.x - receiver.x;
      const dy = mover.y - receiver.y;
      if (dx * dx + dy * dy > tierDistance * tierDistance) {
        const updateSlot = (tick + (parseInt(mover.id, 10) % 4)) % 4;
        if (updateSlot !== 0) continue;
      }
    }

    entries.push({
      id: parseInt(mover.id, 10) || 0,
      x: Math.round(mover.x),
      y: Math.round(mover.y),
      direction: DIRECTION_MAP[mover.direction] ?? 1,
      stealth: mover.stealth ? 1 : 0,
    });
  }

  return entries;
}

export interface MovementProbe {
  seq: number;
  serverSendTime: number;
}

export function encodeBatch(entries: any[], probe?: MovementProbe): { data: Uint8Array; offsets: number[] } {
  const frames: Uint8Array[] = [];
  const offsets: number[] = [];

  for (let i = 0; i < entries.length; i += MAX_ENTRIES) {
    const chunkEntries = Math.min(MAX_ENTRIES, entries.length - i);
    const frame = new Uint8Array(3 + chunkEntries * ENTRY_BYTES + (probe ? PROBE_BYTES : 0));
    const view = new DataView(frame.buffer);
    frame[0] = BATCH_HEADER;
    view.setUint16(1, chunkEntries, true);

    let offset = 3;
    for (let j = 0; j < chunkEntries; j++) {
      const mover = entries[i + j];
      view.setUint32(offset, mover.id, true);
      view.setInt16(offset + 4, mover.x, true);
      view.setInt16(offset + 6, mover.y, true);
      frame[offset + 8] = mover.direction | (mover.stealth << 4);
      offset += ENTRY_BYTES;
    }

    // Trailing one-way latency probe: [u32 seq][u32 seconds][u16 ms].
    // Clients parse exactly `count` entries and ignore the trailing bytes,
    // so this is transparent to the game client. The timestamp is split into
    // seconds + milliseconds because Date.now() overflows a single u32.
    if (probe) {
      view.setUint32(offset, probe.seq + (i / MAX_ENTRIES), true);
      view.setUint32(offset + 4, Math.floor(probe.serverSendTime / 1000), true);
      view.setUint16(offset + 8, probe.serverSendTime % 1000, true);
    }

    frames.push(frame);
  }

  const total = frames.reduce((sum, frame) => sum + frame.length, 0);
  const data = new Uint8Array(total);
  let pos = 0;
  for (const frame of frames) {
    data.set(frame, pos);
    offsets.push(pos);
    pos += frame.length;
  }
  offsets.push(total);

  return { data, offsets };
}
