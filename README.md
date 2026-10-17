# RCON

<!-- Built on `neverthrow` for explicit error handling (no thrown exceptions on the public API) and Node's native `net.Socket`. -->

A minimal TypeScript client for the [Source RCON protocol](https://developer.valvesoftware.com/wiki/Source_RCON_Protocol), built on top of [neverthrow](https://github.com/supermacro/neverthrow) for explicit error handling and Node's native `net.Socket`.

## Features

- Promise-based API via `ResultAsync<T, string>`, every call resolves to either a value or an error message, never throws
- Sequential command pipeline: commands are queued and sent one at a time, matched to their response by packet id
- Automatic packet framing/deframing via a `Transform` stream (`SplitterTransform`), so partial or batched TCP reads are handled transparently
- Simple state machine (`idle` → `connecting` → `ready` → `closing` → `closed`) exposed via `currentState` / `isReady`
- Optional reassembly of long responses split across several packets (`multiPacketResponses`)

## Installation

```bash
npm install @darco2903/rcon-ts
```

## Usage

```ts
import { RCON } from "@darco2903/rcon-ts";

const rcon = new RCON("127.0.0.1", 27015, "my-rcon-password");

const connectResult = await rcon.connect();
if (connectResult.isErr()) {
    console.error("Connection failed:", connectResult.error);
    process.exit(1);
}

const commandResult = await rcon.sendCommand("status");
commandResult.match(
    (output) => console.log(output),
    (error) => console.error("Command failed:", error),
);

await rcon.disconnect();
```

If you need the raw response packet (id, type, and payload buffer) instead of a decoded string, use `sendCommandRaw` instead of `sendCommand`.

```ts
const result = await rcon.sendCommandRaw("status");
result.andTee((packet) => {
    console.log(packet.id, packet.type, packet.payload);
});
```

## API

### `new RCON(host: string, port: number, password: string, options?: RCONOptions)`

Creates a client instance. Does not connect automatically.

| Option                 | Default | Description                                                                                                                                                                                                                                         |
| ---------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connectTimeout`       | `10000` | Max time in ms for `connect()` to open the socket and authenticate.                                                                                                                                                                                 |
| `multiPacketResponses` | `false` | Joins responses split across several packets into one. Works by sending an empty `SERVERDATA_RESPONSE_VALUE` after each command, so only enable it if the server answers those (Source and Minecraft servers do), otherwise commands never resolve. |

### `connect(): ResultAsync<void, string>`

Opens the TCP connection and performs the RCON authentication handshake. Resolves to `Ok` once the client is ready to send commands. Fails if:

- the socket cannot connect (unreachable host, refused connection, etc.)
- the password is rejected by the server
- the server closes the connection or doesn't answer within `connectTimeout`
- `connect()` is called while already `connecting`, `ready` or `closing`

On failure, the socket is destroyed and the state moves to `closed`.

### `disconnect(): ResultAsync<void, string>`

Gracefully closes the connection. Any command still waiting for a response, or queued behind it, is rejected with an error. While `connecting`, cancels the attempt instead (the pending `connect()` resolves to an error). Fails if the client is already `closing` or `closed`, if it has no socket at all, or if the socket fails to close gracefully (it is destroyed anyway).

### `sendCommand(command: string): ResultAsync<string, string>`

Sends a command and resolves with the response payload decoded as a UTF-8 string. Fails if the client is not in the `ready` state.

### `sendCommandRaw(command: string): ResultAsync<Packet, string>`

Same as `sendCommand`, but resolves with the full `Packet` (id, type, raw payload buffer) instead of a decoded string.

### `currentState: RCONState`

Read-only getter exposing the current connection state: `"idle" | "connecting" | "ready" | "closing" | "closed"`.

### `isReady: boolean`

Shorthand for `currentState === "ready"`.

### Events

`RCON` is an `EventEmitter`. The library never logs to the console, it emits these events instead:

- `socketError` `(err: Error)`: the socket failed. The connection is closed right after, failing any pending command.
- `unexpectedPacket` `(packet: Packet)`: a packet arrived that doesn't belong to the pending command (e.g. the extra packets of a split response when `multiPacketResponses` is off).

```ts
rcon.on("socketError", (err) => console.error("RCON socket error:", err.message));
```

## Known limitations

- No automatic reconnection. If the connection drops, `currentState` moves to `closed` and the caller is responsible for calling `connect()` again.
- No per-command timeout. If a server accepts a command but never responds, the corresponding `sendCommand` call will hang indefinitely until `disconnect()` is called.
- Multi-packet responses are only reassembled with `multiPacketResponses: true`. Without it, `sendCommand` resolves with the first packet and the rest are emitted as `unexpectedPacket`.
