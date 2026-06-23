import { Socket } from "net";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { Packet } from "./packet.js";
import { SplitterTransform } from "./SplitterTransform.js";
import type { RCONState } from "./types/RCONState.js";
import { PacketType } from "./types/PacketType.js";

type PendingCommand = { id: number; resolve: (p: Packet) => void; reject: (e: string) => void };
type PendingPacket = { packet: Packet; resolve: (p: Packet) => void; reject: (e: string) => void };

export class RCON {
    public readonly host: string;
    public readonly port: number;
    private readonly password: string;

    private socket: Socket | null;
    private state: RCONState;

    private queue: PendingPacket[];
    private pending: PendingCommand | null;

    public constructor(host: string, port: number, password: string) {
        this.host = host;
        this.port = port;
        this.password = password;
        this.socket = null;
        this.state = "idle";
        this.queue = [];
        this.pending = null;
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

        return ResultAsync.fromPromise(
            new Promise<void>((resolve, reject) => {
                socket.once("error", reject);
                socket.connect(this.port, this.host, () => {
                    socket.off("error", reject);
                    resolve();
                });
            }),
            (e) => `Failed to connect to RCON server: ${e instanceof Error ? e.message : String(e)}`,
        )
            .andThen(() => this.auth(this.password))
            .andTee(() => {
                this.setupSocketListeners(socket);
                this.state = "ready";
            })
            .orTee(() => {
                socket.destroy();
                this.state = "closed";
            });
    }

    public disconnect(): ResultAsync<void, string> {
        if (this.state === "closed") {
            return errAsync("RCON is already disconnected");
        } else if (this.state === "connecting") {
            return errAsync("RCON is currently connecting, cannot disconnect");
        }

        const socket = this.socket;
        if (socket === null) {
            return errAsync("Socket is not initialized");
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
        ).andTee(() => this.handleClose());
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

    private onSocketError(err: Error): void {
        console.error("RCON socket error:", err.message);
    }

    private setupSocketListeners(socket: Socket): void {
        socket
            //
            .pipe(new SplitterTransform())
            .on("data", this.handlePacket.bind(this));

        socket.on("error", this.onSocketError.bind(this));
        socket.once("close", this.handleClose.bind(this));
    }

    private teardownSocketListeners(): void {
        if (this.socket !== null) {
            this.socket.off("data", this.handlePacket.bind(this));
            this.socket.off("error", this.onSocketError.bind(this));
            this.socket.off("close", this.handleClose.bind(this));
        }
    }

    private handleClose(): void {
        this.teardownSocketListeners();
        this.socket = null;
        this.state = "closed";
        this.reset();
    }

    private reset(): void {
        this.queue = [];
        if (this.pending) {
            this.pending.reject("RCON connection closed");
            this.pending = null;
        }
    }

    private auth(password: string): ResultAsync<void, string> {
        const socket = this.socket;
        const packet = Packet.fromString(PacketType.SERVERDATA_AUTH, password);

        if (socket === null) {
            return errAsync("Socket is not initialized");
        }

        const p = ResultAsync.fromPromise(
            new Promise<Packet>((resolve, reject) => {
                const onData = (data: Buffer) => {
                    socket.off("error", onError);
                    resolve(Packet.decode(data));
                };

                const onError = (err: Error) => {
                    socket.off("data", onData);
                    reject(err);
                };

                socket.once("data", onData);
                socket.once("error", onError);
            }),
            (e) => `Failed to authenticate: ${e instanceof Error ? e.message : String(e)}`,
        ).andThen((packet) => {
            if (packet.type !== PacketType.SERVERDATA_AUTH_RESPONSE || packet.id === -1) {
                return errAsync("Failed to authenticate with RCON server.");
            }
            return okAsync();
        });
        return this._write(packet, socket).andThen(() => p);
    }

    private handlePacket(data: Buffer): void {
        const packet = Packet.decode(data);

        if (this.pending !== null && this.pending.id === packet.id) {
            const { resolve } = this.pending;
            resolve(packet);
            this.sendNext();
        } else {
            console.warn(`Unexpected packet id: ${packet.id}`);
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
