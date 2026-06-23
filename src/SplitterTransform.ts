import { Transform, type TransformCallback } from "stream";

export class SplitterTransform extends Transform {
    private buffer: Buffer = Buffer.alloc(0);

    public _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback): void {
        let offset = 0;

        this.buffer = Buffer.concat([this.buffer, chunk]);

        while (offset + 4 <= this.buffer.length) {
            const length = this.buffer.readInt32LE(offset);
            if (offset + 4 + length > this.buffer.length) break;
            this.push(this.buffer.subarray(offset, offset + 4 + length));
            offset += 4 + length;
        }

        this.buffer = this.buffer.subarray(offset);
        callback();
    }
}
