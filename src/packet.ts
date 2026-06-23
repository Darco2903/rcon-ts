import { PacketType } from "./types/PacketType.js";

export class Packet {
    private static lastId: number = 0;

    public readonly id: number;
    public readonly type: PacketType;
    public readonly payload: Buffer;

    static getNextId(): number {
        Packet.lastId = (Packet.lastId + 1) % 2 ** 31;
        return Packet.lastId;
    }

    public static fromBuffer(type: PacketType, payload: Buffer): Packet {
        const id = Packet.getNextId();
        return new Packet(id, type, payload);
    }

    public static fromString(type: PacketType, payload: string): Packet {
        return Packet.fromBuffer(type, Buffer.from(payload, "utf8"));
    }

    private constructor(id: number, type: PacketType, payload: Buffer) {
        this.id = id;
        this.type = type;
        this.payload = payload;
    }

    public encode(): Buffer {
        const buffer = Buffer.alloc(this.payload.length + 14);
        buffer.writeInt32LE(this.payload.length + 10, 0);
        buffer.writeInt32LE(this.id, 4);
        buffer.writeInt32LE(this.type, 8);
        this.payload.copy(buffer, 12);
        return buffer;
    }

    static decode(buffer: Buffer): Packet {
        const length = buffer.readInt32LE(0);
        const id = buffer.readInt32LE(4);
        const type = buffer.readInt32LE(8);
        const payload = buffer.subarray(12, length + 2);
        return new Packet(id, type, payload);
    }
}
