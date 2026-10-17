export enum PacketType {
    SERVERDATA_AUTH = 3,
    // AUTH_RESPONSE and EXECCOMMAND share the value 2 per the protocol: the direction tells them apart
    // (server -> client vs client -> server). Note that `PacketType[2]` only maps back to "SERVERDATA_EXECCOMMAND".
    SERVERDATA_AUTH_RESPONSE = 2,
    SERVERDATA_EXECCOMMAND = 2,
    SERVERDATA_RESPONSE_VALUE = 0,
}
