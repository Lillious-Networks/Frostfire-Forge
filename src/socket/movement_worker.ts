import { parentPort } from "worker_threads";
import { collectReceiverEntries, encodeBatch, MoverSnapshot, ReceiverInfo } from "./movement_batch.ts";

const receiverSets = new Map<string, Set<string>>();

// Per-receiver probe sequence numbers (persist across flushes so the client's
// loss accounting sees one monotonic stream per receiver).
const probeSeqs = new Map<string, number>();

function applyDiffs(diffs: Array<{ playerId: string; add: string[]; remove: string[] }>): void {
  for (const diff of diffs) {
    let set = receiverSets.get(diff.playerId);
    if (!set) {
      set = new Set<string>();
      receiverSets.set(diff.playerId, set);
    }
    for (const add of diff.add) set.add(add);
    for (const remove of diff.remove) set.delete(remove);
  }
}

parentPort?.on("message", (message: any) => {
  try {
    if (message.type === "applyDiffs") {
      applyDiffs(message.diffs || []);
      return;
    }

    if (message.type === "removePlayers") {
      for (const id of message.ids) {
        receiverSets.delete(id);
        probeSeqs.delete(id);
        for (const set of receiverSets.values()) set.delete(id);
      }
      return;
    }

    if (message.type === "flush") {
      applyDiffs(message.diffs || []);

      const tick = message.tick as number;
      const movers = message.movers as MoverSnapshot[];
      const receiverIds = message.receiverIds as string[];
      const receiverInfo = message.receiverInfo as Record<string, ReceiverInfo>;

      const batches: Array<{ receiverId: string; offsets: number[]; data: Uint8Array }> = [];
      const buffers: ArrayBuffer[] = [];

      const tierDistance = receiverIds.length > 800 ? 400 : 0;

      const updatedSeqs: Record<string, number> = {};

      for (const receiverId of receiverIds) {
        const set = receiverSets.get(receiverId);
        if (!set || set.size === 0) continue;

        const receiver = receiverInfo[receiverId];
        if (!receiver) continue;

        const entries = collectReceiverEntries(set, movers, receiver, tick, tierDistance);
        if (entries.length === 0) continue;

        const receiverProbeSeq = receiver.seq ?? probeSeqs.get(receiverId) ?? 0;
        const { data, offsets } = encodeBatch(entries, { seq: receiverProbeSeq, serverSendTime: Date.now() });
        const newSeq = receiverProbeSeq + (offsets.length - 1);
        probeSeqs.set(receiverId, newSeq);
        updatedSeqs[receiverId] = newSeq;
        batches.push({ receiverId, offsets, data });
        buffers.push(data.buffer as ArrayBuffer);
      }

      parentPort?.postMessage({ type: "flushResult", tick, batches, updatedSeqs }, buffers);
    }
  } catch (error: any) {
    parentPort?.postMessage({ type: "flushError", error: error?.message || String(error) });
  }
});

parentPort?.postMessage({ type: "ready" });
