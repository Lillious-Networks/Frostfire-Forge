import { expect, test } from "bun:test";
import { encodeBatch, DIRECTION_MAP, MAX_DATAGRAM_SIZE } from "../socket/movement_batch";

function buildEntries(count: number): any[] {
  const entries: any[] = [];
  for (let i = 0; i < count; i++) {
    entries.push({
      id: 1000 + i,
      x: i * 3,
      y: -i * 2,
      direction: DIRECTION_MAP[["up", "down", "left", "right", "upleft", "upright", "downleft", "downright"][i % 8]],
      stealth: i % 2,
    });
  }
  return entries;
}

test("encodeBatch with probe keeps every frame within MAX_DATAGRAM_SIZE", () => {
  const entries = buildEntries(500);
  const serverSendTime = Date.now();
  const { offsets } = encodeBatch(entries, { seq: 7, serverSendTime });

  expect(offsets.length).toBeGreaterThan(1);
  for (let i = 0; i < offsets.length - 1; i++) {
    const frameLength = offsets[i + 1] - offsets[i];
    expect(frameLength).toBeLessThanOrEqual(MAX_DATAGRAM_SIZE);
  }
});

test("encodeBatch probe roundtrips seq + seconds/ms timestamp", () => {
  const entries = buildEntries(200);
  const serverSendTime = 1786706395136;
  const { data, offsets } = encodeBatch(entries, { seq: 41, serverSendTime });

  let parsedFrames = 0;
  for (let i = 0; i < offsets.length - 1; i++) {
    const frame = new Uint8Array(data.buffer, data.byteOffset + offsets[i], offsets[i + 1] - offsets[i]);

    expect(frame[0]).toBe(0x01);

    const view = new DataView(frame.buffer, frame.byteOffset);
    const count = view.getUint16(1, true);
    const entriesEnd = 3 + count * 9;

    expect(frame.length).toBe(entriesEnd + 10);

    const seq = view.getUint32(entriesEnd, true);
    const seconds = view.getUint32(entriesEnd + 4, true);
    const ms = view.getUint16(entriesEnd + 8, true);

    expect(seq).toBe(41 + i);
    expect(seconds * 1000 + ms).toBe(serverSendTime);
    parsedFrames++;
  }

  expect(parsedFrames).toBe(offsets.length - 1);
});

test("encodeBatch without probe matches the legacy 9-byte-stride layout", () => {
  const entries = buildEntries(5);
  const { data, offsets } = encodeBatch(entries);

  expect(offsets.length).toBe(2);
  const frame = new Uint8Array(data.buffer, data.byteOffset + offsets[0], offsets[1] - offsets[0]);
  const view = new DataView(frame.buffer, frame.byteOffset);

  expect(view.getUint16(1, true)).toBe(5);
  expect(frame.length).toBe(3 + 5 * 9);
});
