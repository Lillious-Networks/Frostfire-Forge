const HEADER_BYTES = 4;

export function encodeCloseReason(code: number, reason: string): string {
  return `${code}|${reason || ""}`;
}

export function decodeCloseReason(reason: string | undefined): { code: number; reason: string } {
  if (!reason) {
    return { code: 0, reason: "" };
  }

  const separator = reason.indexOf("|");
  if (separator === -1) {
    return { code: 1, reason };
  }

  const code = parseInt(reason.slice(0, separator), 10);
  return {
    code: Number.isFinite(code) ? code : 1,
    reason: reason.slice(separator + 1),
  };
}

export function encodeFrame(payload: Uint8Array): Uint8Array {
  if (payload.length > 0xffffffff) {
    throw new Error(`Frame payload too large: ${payload.length} bytes`);
  }

  const frame = new Uint8Array(HEADER_BYTES + payload.length);
  const view = new DataView(frame.buffer);
  view.setUint32(0, payload.length, true);
  frame.set(payload, HEADER_BYTES);
  return frame;
}

export class FrameDecoder {
  private buffer: Uint8Array = new Uint8Array(0);
  private maxFrameSize: number;
  private overflowed: boolean = false;

  constructor(maxFrameSize: number) {
    this.maxFrameSize = maxFrameSize;
  }

  push(chunk: Uint8Array): Uint8Array[] {
    if (this.overflowed) {
      return [];
    }

    const combined = new Uint8Array(this.buffer.length + chunk.length);
    combined.set(this.buffer, 0);
    combined.set(chunk, this.buffer.length);
    this.buffer = combined;

    const frames: Uint8Array[] = [];

    while (this.buffer.length >= HEADER_BYTES) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, HEADER_BYTES);
      const length = view.getUint32(0, true);

      if (length > this.maxFrameSize) {
        this.overflowed = true;
        this.buffer = new Uint8Array(0);
        break;
      }

      if (this.buffer.length < HEADER_BYTES + length) {
        break;
      }

      frames.push(this.buffer.slice(HEADER_BYTES, HEADER_BYTES + length));
      this.buffer = this.buffer.slice(HEADER_BYTES + length);
    }

    return frames;
  }

  isOverflowed(): boolean {
    return this.overflowed;
  }
}
