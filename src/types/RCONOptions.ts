export interface RCONOptions {
    /** Max time in ms for `connect()` to open the socket and authenticate. Defaults to 10000. */
    connectTimeout?: number;

    /**
     * Collects responses split across several packets (long outputs) into a single one. Works by sending an
     * empty SERVERDATA_RESPONSE_VALUE after each command and waiting for its reply, so only enable it if the
     * server answers those packets (Source and Minecraft servers do), otherwise commands never resolve.
     * Defaults to `false`.
     */
    multiPacketResponses?: boolean;
}
