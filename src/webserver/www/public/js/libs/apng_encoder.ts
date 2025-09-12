export class APNGEncoder {
    private frames: {data: Uint8Array, delay: number}[] = [];

    async addFrame(canvas: HTMLCanvasElement, options: {delay: number}): Promise<void> {
        return new Promise((resolve) => {
            canvas.toBlob((blob) => {
                if (!blob) {
                    resolve();
                    return;
                }
                const reader = new FileReader();
                reader.onload = () => {
                    const arrayBuffer = reader.result as ArrayBuffer;
                    this.frames.push({
                        data: new Uint8Array(arrayBuffer),
                        delay: options.delay
                    });
                    resolve();
                };
                reader.readAsArrayBuffer(blob);
            }, 'image/png');
        });
    }

    private writeUInt32(value: number): Uint8Array {
        const bytes = new Uint8Array(4);
        bytes[0] = (value >> 24) & 0xff;
        bytes[1] = (value >> 16) & 0xff;
        bytes[2] = (value >> 8) & 0xff;
        bytes[3] = value & 0xff;
        return bytes;
    }

    private crc32(data: Uint8Array): number {
        let crc = -1;
        for (let i = 0; i < data.length; i++) {
            const b = data[i];
            crc = (crc >>> 8) ^ this.crcTable[(crc ^ b) & 0xFF];
        }
        return crc ^ (-1);
    }

    private crcTable = new Uint32Array(256).map((_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = ((c & 1) !== 0) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        }
        return c;
    });

    private makeChunk(type: string, data: Uint8Array): Uint8Array {
        const typeBytes = new TextEncoder().encode(type);
        const length = data.length;
        const chunk = new Uint8Array(length + 12);
        
        // Length
        chunk.set(this.writeUInt32(length), 0);
        // Type
        chunk.set(typeBytes, 4);
        // Data
        chunk.set(data, 8);
        // CRC
        const crcData = new Uint8Array(typeBytes.length + data.length);
        crcData.set(typeBytes, 0);
        crcData.set(data, typeBytes.length);
        chunk.set(this.writeUInt32(this.crc32(crcData)), length + 8);
        
        return chunk;
    }

    finish(): Uint8Array {
        if (this.frames.length === 0) return new Uint8Array();

        const chunks: Uint8Array[] = [];
        const signature = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        chunks.push(signature);

        // Get IHDR from first frame
        const firstFrame = this.frames[0].data;
        const pos = 8; // Skip signature
        const ihdrLength = new DataView(firstFrame.buffer).getUint32(pos);
        chunks.push(firstFrame.slice(pos, pos + ihdrLength + 12));

        // Add acTL chunk (animation control)
        const acTLData = new Uint8Array(8);
        new DataView(acTLData.buffer).setUint32(0, this.frames.length); // num_frames
        new DataView(acTLData.buffer).setUint32(4, 0); // num_plays (0 = infinite)
        chunks.push(this.makeChunk('acTL', acTLData));

        // Process each frame
        let sequence = 0;
        this.frames.forEach((frame, index) => {
            // Add fcTL chunk
            const fcTLData = new Uint8Array(26);
            const dv = new DataView(fcTLData.buffer);
            dv.setUint32(0, sequence++); // sequence_number
            dv.setUint32(4, frame.data[16] << 24 | frame.data[17] << 16 | frame.data[18] << 8 | frame.data[19]); // width
            dv.setUint32(8, frame.data[20] << 24 | frame.data[21] << 16 | frame.data[22] << 8 | frame.data[23]); // height
            dv.setUint32(12, 0); // x_offset
            dv.setUint32(16, 0); // y_offset
            dv.setUint16(20, frame.delay); // delay_num
            dv.setUint16(22, 1000); // delay_den
            dv.setUint8(24, 0); // dispose_op
            dv.setUint8(25, 0); // blend_op
            chunks.push(this.makeChunk('fcTL', fcTLData));

            // Add IDAT/fdAT chunks
            let pos = 8;
            while (pos < frame.data.length) {
                const length = new DataView(frame.data.buffer).getUint32(pos);
                const type = new TextDecoder().decode(frame.data.slice(pos + 4, pos + 8));
                
                if (type === 'IDAT') {
                    const data = frame.data.slice(pos + 8, pos + 8 + length);
                    if (index === 0) {
                        chunks.push(this.makeChunk('IDAT', data));
                    } else {
                        const fdatData = new Uint8Array(data.length + 4);
                        fdatData.set(this.writeUInt32(sequence++), 0);
                        fdatData.set(data, 4);
                        chunks.push(this.makeChunk('fdAT', fdatData));
                    }
                }
                pos += 12 + length;
            }
        });

        // Add IEND chunk
        chunks.push(this.makeChunk('IEND', new Uint8Array(0)));

        // Combine all chunks
        const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const output = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
            output.set(chunk, offset);
            offset += chunk.length;
        }

        return output;
    }
}

export const APNG = {
    createAPNGEncoder: () => new APNGEncoder()
}; 