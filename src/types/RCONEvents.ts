import type { Packet } from "../packet.js";

export interface RCONEvents {
    /** The socket emitted an error. The connection is closed right after, failing any pending command. */
    socketError: [err: Error];
    /** A packet arrived that doesn't belong to the pending command. */
    unexpectedPacket: [packet: Packet];
}
