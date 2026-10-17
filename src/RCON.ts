import { Socket } from "net";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { TypedEmitterProtected } from "@darco2903/typed-emitter";
import { Packet } from "./packet.js";
import { SplitterTransform } from "./SplitterTransform.js";
import type { RCONEvents } from "./types/RCONEvents.js";
import type { RCONOptions } from "./types/RCONOptions.js";
import type { RCONState } from "./types/RCONState.js";
import { PacketType } from "./types/PacketType.js";

type PendingCommand = {
    id: number;
    /** Id of the end-of-response marker, `null` when multi-packet responses are disabled. */
    markerId: number | null;
    /** Response packets received so far, only used with multi-packet responses. */
    received: Packet[];
    resolve: (p: Packet) => void;
    reject: (e: string) => void;
};
type QueuedCommand = { packet: Packet; resolve: (p: Packet) => void; reject: (e: string) => void };
type PendingConnect = {
    /** Id of the auth packet, `null` until the TCP connection is established. */
    authId: number | null;
    timer: ReturnType<typeof setTimeout>;
    resolve: () => void;
    reject: (e: string) => void;
};

const DEFAULT_CONNECT_TIMEOUT = 10_000;

export class RCON extends TypedEmitterProtected<RCONEvents> {
    public readonly host: string;
    public readonly port: number;
    private readonly password: string;
    private readonly connectTimeout: number;
    private readonly multiPacketResponses: boolean;

    private socket: Socket | null;
    private state: RCONState;

    private connecting: PendingConnect | null;
    private queue: QueuedCommand[];
    private pending: PendingCommand | null;
    private lastMarkerId: number | null;

    private teardownSocketListeners: (() => void) | null;

    public constructor(host: string, port: number, password: string, options: RCONOptions = {}) {
        super();
        this.host = host;
        this.port = port;
        this.password = password;
        this.connectTimeout = options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT;
        this.multiPacketResponses = options.multiPacketResponses ?? false;
        this.socket = null;
        this.state = "idle";
        this.connecting = null;
        this.queue = [];
        this.pending = null;
        this.lastMarkerId = null;
        this.teardownSocketListeners = null;
    }

    public get currentState(): RCONState {
        return this.state;
    }

    public get isReady(): boolean {
        return this.state === "ready";
    }

    public connect(): ResultAsync<void, string> {
        if (this.state === "connecting") {
            return errAsync("RCON is already connecting");
        } else if (this.state === "ready") {
            return errAsync("RCON is already connected");
        } else if (this.state === "closing") {
            return errAsync("RCON is currently disconnecting");
        }

        this.state = "connecting";
        const socket = (this.socket = new Socket());
        this.setupSocketListeners(socket);

        return ResultAsync.fromPromise(
            new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => {
                    this.closeConnection(socket, `timed out after ${this.connectTimeout}ms`);
                }, this.connectTimeout);
                const attempt: PendingConnect = { authId: null, timer, resolve, reject };
                this.connecting = attempt;

                try {
                    socket.connect(this.port, this.host, () => {
                        const packet = Packet.fromString(PacketType.SERVERDATA_AUTH, this.password);
                        attempt.authId = packet.id;
                        this._write(socket, [packet]).orTee((e) => this.closeConnection(socket, e));
                    });
                } catch (e) {
                    this.closeConnection(socket, e instanceof Error ? e.message : String(e));
                }
            }),
            (e) => String(e),
        );
    }

    public disconnect(): ResultAsync<void, string> {
        if (this.state === "closed") {
            return errAsync("RCON is already disconnected");
        } else if (this.state === "closing") {
            return errAsync("RCON is already disconnecting");
        }

        const socket = this.socket;
        if (socket === null) {
            return errAsync("Socket is not initialized");
        }

        if (this.state === "connecting") {
            this.closeConnection(socket, "cancelled by disconnect()");
            return okAsync();
        }

        this.state = "closing";

        return ResultAsync.fromPromise(
            new Promise<void>((resolve, reject) => {
                socket.end((err?: Error | null) => (err ? reject(err) : resolve()));
            }),
            (e) => `Failed to disconnect from RCON server: ${e instanceof Error ? e.message : String(e)}`,
        )
            .andTee(() => this.closeConnection(socket, "disconnected"))
            .orTee((e) => this.closeConnection(socket, e));
    }

    public sendCommandRaw(command: string): ResultAsync<Packet, string> {
        if (this.state !== "ready") {
            return errAsync("RCON is not ready to send commands");
        }

        const packet = Packet.fromString(PacketType.SERVERDATA_EXECCOMMAND, command);

        return ResultAsync.fromPromise(
            new Promise<Packet>((resolve, reject) => {
                this.queue.push({ packet, resolve, reject });
                if (this.pending === null) {
                    this.sendNext();
                }
            }),
            (e) => `Failed to send command: ${e instanceof Error ? e.message : String(e)}`,
        );
    }

    public sendCommand(command: string): ResultAsync<string, string> {
        return this.sendCommandRaw(command).map((packet) => packet.payload.toString("utf8"));
    }

    private setupSocketListeners(socket: Socket): void {
        const splitter = new SplitterTransform();
        let lastError: Error | null = null;

        const onPacket = (data: Buffer) => this.handlePacket(data);
        const onSplitterError = (err: Error) => socket.destroy(err);
        const onError = (err: Error) => {
            lastError = err;
            if (socket === this.socket) {
                this.emit("socketError", err);
            }
        };
        const onClose = () => this.closeConnection(socket, lastError?.message ?? "closed by server");

        socket
            //
            .pipe(splitter)
            .on("data", onPacket)
            .on("error", onSplitterError);

        socket.on("error", onError);
        socket.once("close", onClose);

        this.teardownSocketListeners = () => {
            socket.off("close", onClose);
            socket.unpipe(splitter);
            splitter.off("data", onPacket);
            // `onError` stays attached so late errors from the destroyed socket don't crash the process.
        };
    }

    /**
     * Destroys `socket` and fails everything waiting on it: the connect attempt, the pending
     * command and the queued ones. No-op if `socket` is no longer the active socket.
     */
    private closeConnection(socket: Socket, reason: string): void {
        if (socket !== this.socket) {
            return;
        }

        this.socket = null;
        this.state = "closed";
        this.lastMarkerId = null;
        this.teardownSocketListeners?.();
        this.teardownSocketListeners = null;
        socket.destroy();

        if (this.connecting !== null) {
            const { authId, timer, reject } = this.connecting;
            clearTimeout(timer);
            this.connecting = null;
            reject(
                authId === null ? `Failed to connect to RCON server: ${reason}` : `Failed to authenticate: ${reason}`,
            );
        }

        this.rejectAll(`RCON connection closed: ${reason}`);
    }

    private rejectAll(reason: string): void {
        const pending = this.pending;
        const queue = this.queue;
        this.pending = null;
        this.queue = [];

        pending?.reject(reason);
        for (const { reject } of queue) {
            reject(reason);
        }
    }

    private handlePacket(data: Buffer): void {
        const packet = Packet.decode(data);
        const pending = this.pending;

        if (this.connecting !== null) {
            this.handleAuthPacket(packet, this.connecting);
        } else if (pending !== null && pending.id === packet.id) {
            if (pending.markerId === null) {
                pending.resolve(packet);
                this.sendNext();
            } else {
                pending.received.push(packet);
            }
        } else if (pending !== null && pending.markerId === packet.id) {
            this.lastMarkerId = pending.markerId;
            pending.resolve(Packet.merge(pending.id, pending.received));
            this.sendNext();
        } else if (packet.id !== this.lastMarkerId) {
            // Packets carrying the last marker's id are expected: Source answers a marker with two packets.
            this.emit("unexpectedPacket", packet);
        }
    }

    private handleAuthPacket(packet: Packet, attempt: PendingConnect): void {
        const socket = this.socket;
        if (socket === null) {
            return;
        }

        // Source servers send an empty SERVERDATA_RESPONSE_VALUE right before the auth response.
        if (packet.type === PacketType.SERVERDATA_RESPONSE_VALUE) {
            return;
        }

        if (packet.type !== PacketType.SERVERDATA_AUTH_RESPONSE) {
            this.closeConnection(socket, `unexpected packet type ${packet.type}`);
        } else if (packet.id === -1) {
            this.closeConnection(socket, "wrong password");
        } else if (packet.id !== attempt.authId) {
            this.closeConnection(socket, `unexpected packet id ${packet.id}`);
        } else {
            clearTimeout(attempt.timer);
            this.connecting = null;
            this.state = "ready";
            attempt.resolve();
        }
    }

    private sendNext(): void {
        const next = this.queue.shift();
        if (next === undefined) {
            this.pending = null;
            return;
        }

        const packets = [next.packet];
        let markerId: number | null = null;
        if (this.multiPacketResponses) {
            // Servers answer in order, so the reply to this empty packet marks the end of the command's response.
            const marker = Packet.fromBuffer(PacketType.SERVERDATA_RESPONSE_VALUE, Buffer.alloc(0));
            markerId = marker.id;
            packets.push(marker);
        }

        this.pending = { id: next.packet.id, markerId, received: [], resolve: next.resolve, reject: next.reject };
        this.write(packets).orTee((err) => {
            // Already failed by `closeConnection()` if the socket went down meanwhile.
            if (this.pending?.id !== next.packet.id) {
                return;
            }
            next.reject(err);
            this.sendNext();
        });
    }

    private _write(socket: Socket, packets: Packet[]): ResultAsync<void, string> {
        return ResultAsync.fromPromise(
            new Promise<void>((resolve, reject) => {
                socket.write(Buffer.concat(packets.map((p) => p.encode())), (err) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            }),
            (e) => `Failed to write packet: ${e instanceof Error ? e.message : String(e)}`,
        );
    }

    private write(packets: Packet[]): ResultAsync<void, string> {
        if (this.socket === null) {
            return errAsync("Socket is not initialized");
        }
        return this._write(this.socket, packets);
    }
}
