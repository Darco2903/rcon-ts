import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RCON } from "../../src/RCON.js";
import { Packet } from "../../src/packet.js";
import { PacketType } from "../../src/types/PacketType.js";
import { FakeRconServer } from "../fakeServer.js";

describe("RCON", () => {
    let server: FakeRconServer;
    let port: number;

    beforeEach(async () => {
        server = new FakeRconServer();
        port = await server.listen();
    });

    afterEach(async () => {
        await server.close();
    });

    // ---------------------------------------------------------------------
    // connect() / auth
    // ---------------------------------------------------------------------
    describe("connect()", () => {
        it("connects and authenticates with the correct password", async () => {
            const rcon = new RCON("127.0.0.1", port, "correct-password");

            const result = await rcon.connect();

            expect(result.isOk()).toBe(true);
            expect(rcon.currentState).toBe("ready");
            expect(rcon.isReady).toBe(true);
        });

        it("fails and transitions to closed if the password is incorrect", async () => {
            const rcon = new RCON("127.0.0.1", port, "wrong-password");

            const result = await rcon.connect();

            expect(result.isErr()).toBe(true);
            expect(rcon.currentState).toBe("closed");
        });

        it("fails if the server is not reachable (wrong port)", async () => {
            const rcon = new RCON("127.0.0.1", 1, "any-password");

            const result = await rcon.connect();

            expect(result.isErr()).toBe(true);
            expect(rcon.currentState).toBe("closed");
        });

        it("returns an error if connect() is called while the state is already 'connecting'", async () => {
            const rcon = new RCON("127.0.0.1", port, "correct-password");

            const firstCall = rcon.connect();
            const secondResult = await rcon.connect();

            expect(secondResult.isErr()).toBe(true);
            expect(secondResult._unsafeUnwrapErr()).toMatch(/already connecting/i);

            await firstCall; // on laisse la première connexion se terminer proprement
        });

        it("returns an error if connect() is called while the state is already 'ready'", async () => {
            const rcon = new RCON("127.0.0.1", port, "correct-password");
            await rcon.connect();

            const result = await rcon.connect();

            expect(result.isErr()).toBe(true);
            expect(result._unsafeUnwrapErr()).toMatch(/already connected/i);
            expect(rcon.currentState).toBe("ready");
        });

        it("allows reconnecting after a failure (state closed -> connecting again)", async () => {
            const rcon = new RCON("127.0.0.1", port, "wrong-password");
            const first = await rcon.connect();
            expect(first.isErr()).toBe(true);
            expect(rcon.currentState).toBe("closed");

            // For this test we simulate a correct password change on the server side
            server.expectedPassword = "wrong-password";
            const second = await rcon.connect();

            expect(second.isOk()).toBe(true);
            expect(rcon.currentState).toBe("ready");
        });
    });

    // ---------------------------------------------------------------------
    // disconnect()
    // ---------------------------------------------------------------------
    describe("disconnect()", () => {
        it("disconnects properly after a successful connection", async () => {
            const rcon = new RCON("127.0.0.1", port, "correct-password");
            await rcon.connect();

            const result = await rcon.disconnect();

            expect(result.isOk()).toBe(true);
            expect(rcon.currentState).toBe("closed");
        });

        it("returns an error if disconnecting while in the 'idle' state (never connected)", async () => {
            const rcon = new RCON("127.0.0.1", port, "correct-password");

            const result = await rcon.disconnect();

            expect(result.isErr()).toBe(true);
            // The RCON has never had a socket: the message reflects this rather than "already disconnected",
            // which only applies to the "closed" state (reached after a connect+disconnect or a network close).
            expect(result._unsafeUnwrapErr()).toMatch(/socket is not initialized/i);
        });

        it("returns an error 'already disconnected' if disconnecting twice in a row after a successful connection", async () => {
            const rcon = new RCON("127.0.0.1", port, "correct-password");
            await rcon.connect();
            await rcon.disconnect();

            const result = await rcon.disconnect();

            expect(result.isErr()).toBe(true);
            expect(result._unsafeUnwrapErr()).toMatch(/already disconnected/i);
        });

        it("returns an error if disconnecting while in the 'connecting' state", async () => {
            const rcon = new RCON("127.0.0.1", port, "correct-password");

            const connectPromise = rcon.connect();
            const disconnectResult = await rcon.disconnect();

            expect(disconnectResult.isErr()).toBe(true);
            expect(disconnectResult._unsafeUnwrapErr()).toMatch(/currently connecting/i);

            await connectPromise;
        });

        it("rejects pending commands during disconnection", async () => {
            const rcon = new RCON("127.0.0.1", port, "correct-password");
            await rcon.connect();

            // Block the server to keep a command pending without a response
            server.onPacket = () => {
                /* does not reply */
            };

            const commandPromise = rcon.sendCommand("test");
            const disconnectResult = await rcon.disconnect();

            expect(disconnectResult.isOk()).toBe(true);

            const result = await commandPromise;
            expect(result.isErr()).toBe(true);
        });
    });

    // ---------------------------------------------------------------------
    // sendCommand() / sendCommandRaw()
    // ---------------------------------------------------------------------
    describe("sendCommand()", () => {
        it("refuses to send a command if the state is not 'ready'", async () => {
            const rcon = new RCON("127.0.0.1", port, "correct-password");

            const result = await rcon.sendCommand("status");

            expect(result.isErr()).toBe(true);
            expect(result._unsafeUnwrapErr()).toMatch(/not ready/i);
        });

        it("sends a command and receives the response decoded as a string", async () => {
            const rcon = new RCON("127.0.0.1", port, "correct-password");
            await rcon.connect();

            const result = await rcon.sendCommand("hello");

            expect(result.isOk()).toBe(true);
            expect(result._unsafeUnwrap()).toBe("echo:hello");
        });

        it("sendCommandRaw() returns the full Packet (id, type, payload)", async () => {
            const rcon = new RCON("127.0.0.1", port, "correct-password");
            await rcon.connect();

            const result = await rcon.sendCommandRaw("ping");

            expect(result.isOk()).toBe(true);
            const packet = result._unsafeUnwrap();
            expect(packet.type).toBe(PacketType.SERVERDATA_RESPONSE_VALUE);
            expect(packet.payload.toString("utf8")).toBe("echo:ping");
        });

        it("handles multiple commands sequentially in the order sent", async () => {
            const rcon = new RCON("127.0.0.1", port, "correct-password");
            await rcon.connect();

            const results = await Promise.all([
                //
                rcon.sendCommand("first"),
                rcon.sendCommand("second"),
                rcon.sendCommand("third"),
            ]);

            expect(results.map((r) => r._unsafeUnwrap())).toEqual([
                //
                "echo:first",
                "echo:second",
                "echo:third",
            ]);
        });

        it("never processes two commands in parallel (only one 'pending' at a time)", async () => {
            const rcon = new RCON("127.0.0.1", port, "correct-password");
            await rcon.connect();

            const receivedOrder: string[] = [];
            const originalOnPacket = server.onPacket;
            server.onPacket = (socket, packet) => {
                if (packet.type === PacketType.SERVERDATA_EXECCOMMAND) {
                    receivedOrder.push(packet.payload.toString("utf8"));
                }
                originalOnPacket(socket, packet);
            };

            await Promise.all([
                //
                rcon.sendCommand("a"),
                rcon.sendCommand("b"),
                rcon.sendCommand("c"),
            ]);

            // The server should not receive "b" until it has responded to "a", etc.
            // At minimum, verify the receive order on the server side.
            expect(receivedOrder).toEqual(["a", "b", "c"]);
        });

        it("handles an empty payload", async () => {
            const rcon = new RCON("127.0.0.1", port, "correct-password");
            await rcon.connect();

            const result = await rcon.sendCommand("");

            expect(result.isOk()).toBe(true);
            expect(result._unsafeUnwrap()).toBe("echo:");
        });

        it("rejects a command if the server closes the connection before responding", async () => {
            const rcon = new RCON("127.0.0.1", port, "correct-password");
            await rcon.connect();

            server.onPacket = (socket) => {
                socket.destroy();
            };

            const result = await rcon.sendCommand("will-fail");

            expect(result.isErr()).toBe(true);
        });
    });

    // ---------------------------------------------------------------------
    // currentState / isReady
    // ---------------------------------------------------------------------
    describe("currentState / isReady", () => {
        it("starts in the 'idle' state", () => {
            const rcon = new RCON("127.0.0.1", port, "correct-password");

            expect(rcon.currentState).toBe("idle");
            expect(rcon.isReady).toBe(false);
        });

        it("transitions through 'connecting' then 'ready'", async () => {
            const rcon = new RCON("127.0.0.1", port, "correct-password");

            expect(rcon.currentState).toBe("idle");
            const connectPromise = rcon.connect();
            expect(rcon.currentState).toBe("connecting");

            await connectPromise;
            expect(rcon.currentState).toBe("ready");
        });

        it("moves to 'closed' if the server unexpectedly closes the connection", async () => {
            const rcon = new RCON("127.0.0.1", port, "correct-password");
            await rcon.connect();

            expect(rcon.currentState).toBe("ready");

            // The server abruptly closes the connection
            for (const socket of server.connections) {
                socket.destroy();
            }

            // Wait for the "close" event to propagate on the client side
            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(rcon.currentState).toBe("closed");
        });
    });

    // ---------------------------------------------------------------------
    // Packet (encode/decode) - low-level unit tests, useful for support
    // ---------------------------------------------------------------------
    describe("Packet", () => {
        it("encodes then decodes a text payload without loss", () => {
            const packet = Packet.fromString(PacketType.SERVERDATA_EXECCOMMAND, "say hello world");
            const encoded = packet.encode();
            const decoded = Packet.decode(encoded);

            expect(decoded.id).toBe(packet.id);
            expect(decoded.type).toBe(packet.type);
            expect(decoded.payload.toString("utf8")).toBe("say hello world");
        });

        it("encodes then decodes an empty payload without loss", () => {
            const packet = Packet.fromString(PacketType.SERVERDATA_EXECCOMMAND, "");
            const encoded = packet.encode();
            const decoded = Packet.decode(encoded);

            expect(decoded.payload.length).toBe(0);
        });

        it("generates distinct incremental ids for each new packet", () => {
            const p1 = Packet.fromString(PacketType.SERVERDATA_EXECCOMMAND, "a");
            const p2 = Packet.fromString(PacketType.SERVERDATA_EXECCOMMAND, "b");

            expect(p2.id).toBe(p1.id + 1);
        });
    });
});
