import { Socket } from "net";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { Packet } from "./packet.js";
import { SplitterTransform } from "./SplitterTransform.js";
import type { RCONOptions } from "./types/RCONOptions.js";
import type { RCONState } from "./types/RCONState.js";
import { PacketType } from "./types/PacketType.js";

type PendingCommand = { id: number; resolve: (p: Packet) => void; reject: (e: string) => void };
type PendingPacket = { packet: Packet; resolve: (p: Packet) => void; reject: (e: string) => void };
type PendingConnect = {
    /** Id of the auth packet, `null` until the TCP connection is established. */
    authId: number | null;
    timer: ReturnType<typeof setTimeout>;
    resolve: () => void;
    reject: (e: string) => void;
};

const DEFAULT_CONNECT_TIMEOUT = 10_000;

export class RCON {
    public readonly host: string;
    public readonly port: number;
    private readonly password: string;
    private readonly connectTimeout: number;

    private socket: Socket | null;
    private state: RCONState;

    private connecting: PendingConnect | null;
    private queue: PendingPacket[];
    private pending: PendingCommand | null;

    private teardownSocketListeners: (() => void) | null;

    public constructor(host: string, port: number, password: string, options: RCONOptions = {}) {
        this.host = host;
        this.port = port;
        this.password = password;
        this.connectTimeout = options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT;
        this.socket = null;
        this.state = "idle";
        this.connecting = null;
        this.queue = [];
        this.pending = null;
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
                        this._write(packet, socket).orTee((e) => this.closeConnection(socket, e));
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
        }

        const socket = this.socket;
        if (socket === null) {
            return errAsync("Socket is not initialized");
        }

        if (this.state === "connecting") {
            this.closeConnection(socket, "cancelled by disconnect()");
            return okAsync();
        }

        return ResultAsync.fromPromise(
            new Promise<void>((resolve, reject) => {
                socket.once("error", reject);
                socket.end(() => {
                    socket.off("error", reject);
                    resolve();
                });
            }),
            (e) => `Failed to disconnect from RCON server: ${e instanceof Error ? e.message : String(e)}`,
        ).andTee(() => this.closeConnection(socket, "disconnected"));
    }

    public sendCommandRaw(command: string): ResultAsync<Packet, string> {
        if (this.state !== "ready") {
            return errAsync("RCON is not ready to send commands");
        }

        const packet = Packet.fromString(PacketType.SERVERDATA_EXECCOMMAND, command);

        return ResultAsync.fromPromise(
            new Promise<Packet>((resolve, reject) => {
                if (this.pending === null) {
                    this.pending = { id: packet.id, resolve, reject };
                    this.write(packet).orTee((e) => {
                        this.pending = null;
                        reject(e);
                    });
                } else {
                    this.queue.push({ packet, resolve, reject });
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
            if (this.state === "ready") {
                console.error("RCON socket error:", err.message);
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
        this.teardownSocketListeners?.();
        this.teardownSocketListeners = null;
        socket.destroy();

        if (this.connecting !== null) {
            const { authId, timer, reject } = this.connecting;
            clearTimeout(timer);
            this.connecting = null;
            reject(
                authId === null
                    ? `Failed to connect to RCON server: ${reason}`
                    : `Failed to authenticate: ${reason}`,
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

        if (this.connecting !== null) {
            this.handleAuthPacket(packet, this.connecting);
        } else if (this.pending !== null && this.pending.id === packet.id) {
            const { resolve } = this.pending;
            resolve(packet);
            this.sendNext();
        } else {
            console.warn(`Unexpected packet id: ${packet.id}`);
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

        this.pending = { id: next.packet.id, resolve: next.resolve, reject: next.reject };
        this.write(next.packet).orTee((err) => {
            this.pending = null;
            next.reject(err);
            this.sendNext();
        });
    }

    private _write(packet: Packet, socket: Socket): ResultAsync<void, string> {
        return ResultAsync.fromPromise(
            new Promise<void>((resolve, reject) => {
                socket.write(packet.encode(), (err) => {
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

    private write(packet: Packet): ResultAsync<void, string> {
        if (this.socket === null) {
            return errAsync("Socket is not initialized");
        }
        return this._write(packet, this.socket);
    }
}
