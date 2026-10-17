import { Transform, type TransformCallback } from "stream";

/** Smallest valid size field: id (4) + type (4) + two null terminators (2). */
export const MIN_PACKET_SIZE = 10;

/**
 * Largest size field accepted. The spec caps it at 4096, but several servers send bigger
 * packets, so this is only a guard against garbage lengths making the buffer grow forever.
 */
export const MAX_PACKET_SIZE = 1024 * 1024;

export class SplitterTransform extends Transform {
    private buffer: Buffer = Buffer.alloc(0);

    public constructor() {
        super({ readableObjectMode: true });
    }

    public _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback): void {
        let offset = 0;

        this.buffer = Buffer.concat([this.buffer, chunk]);

        while (offset + 4 <= this.buffer.length) {
            const length = this.buffer.readInt32LE(offset);
            if (length < MIN_PACKET_SIZE || length > MAX_PACKET_SIZE) {
                callback(new Error(`Invalid packet size: ${length}`));
                return;
            }
            if (offset + 4 + length > this.buffer.length) break;
            this.push(this.buffer.subarray(offset, offset + 4 + length));
            offset += 4 + length;
        }

        this.buffer = this.buffer.subarray(offset);
        callback();
    }
}
