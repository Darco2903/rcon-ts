import { createServer, type Server, type Socket } from "net";
import { Packet } from "../src/packet.js";
import { PacketType } from "../src/types/PacketType.js";

/**
 * Minimal RCON server for integration tests.
 * Allows scripting the server's response to each received packet via `onPacket`.
 */
export class FakeRconServer {
    private server: Server;
    public port: number = 0;
    public connections: Socket[] = [];

    /** Overridable by tests to script server behavior. */
    public onPacket: (socket: Socket, packet: Packet) => void = (socket, packet) => {
        this.defaultAuthAndEcho(socket, packet);
    };

    /** Expected password for the default authentication response. */
    public expectedPassword: string = "correct-password";

    public constructor() {
        this.server = createServer((socket) => {
            this.connections.push(socket);
            socket.on("error", () => {
                /* avoids uncought ECONNRESET errors during brutal test shutdowns */
            });
            let buffer = Buffer.alloc(0);

            socket.on("data", (chunk) => {
                buffer = Buffer.concat([buffer, chunk]);
                while (buffer.length >= 4) {
                    const length = buffer.readInt32LE(0);
                    if (buffer.length < 4 + length) break;
                    const raw = buffer.subarray(0, 4 + length);
                    buffer = buffer.subarray(4 + length);
                    const packet = Packet.decode(raw);
                    this.onPacket(socket, packet);
                }
            });
        });
    }

    private defaultAuthAndEcho(socket: Socket, packet: Packet): void {
        if (packet.type === PacketType.SERVERDATA_AUTH) {
            const ok = packet.payload.toString("utf8") === this.expectedPassword;
            const response = Packet.fromBuffer(PacketType.SERVERDATA_AUTH_RESPONSE, Buffer.alloc(0));
            const forcedId = ok ? packet.id : -1;
            socket.write(this.encodeWithId(response, forcedId));
            return;
        }

        if (packet.type === PacketType.SERVERDATA_EXECCOMMAND) {
            const response = Packet.fromBuffer(
                PacketType.SERVERDATA_RESPONSE_VALUE,
                Buffer.from(`echo:${packet.payload.toString("utf8")}`, "utf8"),
            );
            socket.write(this.encodeWithId(response, packet.id));
            return;
        }
    }

    /** Allows forcing a different response ID (useful for simulating authentication failure with id=-1). */
    private encodeWithId(packet: Packet, id: number): Buffer {
        const encoded = packet.encode();
        encoded.writeInt32LE(id, 4);
        return encoded;
    }

    public listen(): Promise<number> {
        return new Promise((resolve) => {
            this.server.listen(0, "127.0.0.1", () => {
                const address = this.server.address();
                this.port = typeof address === "object" && address !== null ? address.port : 0;
                resolve(this.port);
            });
        });
    }

    public close(): Promise<void> {
        return new Promise((resolve) => {
            for (const socket of this.connections) {
                socket.destroy();
            }
            this.server.close(() => resolve());
        });
    }
}
