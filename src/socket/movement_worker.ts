import { parentPort } from "worker_threads";
import { applyReceiverDiffs, batchVolume, collectReceiverEntries, encodeBatch, indexMovers, NEAR_TIER_DISTANCE, type EntryTally, MoverSnapshot, ReceiverDiff, ReceiverInfo } from "./movement_batch.ts";

const receiverSets = new Map<string, Set<string>>();

// Per-receiver probe sequence numbers (persist across flushes so the client's
// loss accounting sees one monotonic stream per receiver).
const probeSeqs = new Map<string, number>();

function applyDiffs(diffs: ReceiverDiff[]): void {
  applyReceiverDiffs(receiverSets, diffs);
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
      const farEvery = typeof message.farEvery === "number" ? message.farEvery : undefined;
      const movers = message.movers as MoverSnapshot[];
      const receiverIds = message.receiverIds as string[];
      const receiverInfo = message.receiverInfo as Record<string, ReceiverInfo>;
      const moverIndex = indexMovers(movers);

      const batches: Array<{ receiverId: string; offsets: number[]; data: Uint8Array }> = [];
      const buffers: ArrayBuffer[] = [];

      const updatedSeqs: Record<string, number> = {};
      // The flush's movement volume (batchVolume), for the flush floor.
      let volume = 0;

      for (const receiverId of receiverIds) {
        const set = receiverSets.get(receiverId);
        if (!set || set.size === 0) continue;

        const receiver = receiverInfo[receiverId];
        if (!receiver) continue;

        const tally: EntryTally = { full: 0, far: 0 };
        const entries = collectReceiverEntries(set, movers, receiver, tick, NEAR_TIER_DISTANCE, farEvery, moverIndex, tally);
        volume += batchVolume(tally);
        if (entries.length === 0) continue;

        const receiverProbeSeq = receiver.seq ?? probeSeqs.get(receiverId) ?? 0;
        const { data, offsets } = encodeBatch(entries, { seq: receiverProbeSeq, serverSendTime: Date.now() });
        const newSeq = receiverProbeSeq + (offsets.length - 1);
        probeSeqs.set(receiverId, newSeq);
        updatedSeqs[receiverId] = newSeq;
        batches.push({ receiverId, offsets, data });
        buffers.push(data.buffer as ArrayBuffer);
      }

      parentPort?.postMessage({ type: "flushResult", tick, batches, updatedSeqs, volume }, buffers);
    }
  } catch (error: any) {
    parentPort?.postMessage({ type: "flushError", error: error?.message || String(error) });
  }
});

parentPort?.postMessage({ type: "ready" });
