import { describe, expect, it } from "vitest";
import { Packet } from "../../src/packet.js";
import { SplitterTransform } from "../../src/SplitterTransform.js";
import { PacketType } from "../../src/types/PacketType.js";

/** Feeds `chunks` to a fresh splitter and resolves with the payloads of the packets it emits. */
function split(chunks: Buffer[]): Promise<string[]> {
    return new Promise((resolve, reject) => {
        const splitter = new SplitterTransform();
        const payloads: string[] = [];
        splitter.on("data", (data: Buffer) => payloads.push(Packet.decode(data).payload.toString("utf8")));
        splitter.on("error", reject);
        splitter.on("end", () => resolve(payloads));
        for (const chunk of chunks) {
            splitter.write(chunk);
        }
        splitter.end();
    });
}

function encode(payload: string): Buffer {
    return Packet.fromString(PacketType.SERVERDATA_RESPONSE_VALUE, payload).encode();
}

describe("SplitterTransform", () => {
    it("emits a single packet received in one chunk", async () => {
        expect(await split([encode("hello")])).toEqual(["hello"]);
    });

    it("splits several packets received in one chunk", async () => {
        const merged = Buffer.concat([encode("a"), encode(""), encode("ccc")]);

        expect(await split([merged])).toEqual(["a", "", "ccc"]);
    });

    it("reassembles a packet received one byte at a time", async () => {
        const bytes = [...encode("fragmented")].map((byte) => Buffer.from([byte]));

        expect(await split(bytes)).toEqual(["fragmented"]);
    });

    it("handles packets that are both merged and split across chunks", async () => {
        const stream = Buffer.concat([encode("first"), encode("second"), encode("third")]);
        const cut1 = encode("first").length + 2; // inside the size field of "second"
        const cut2 = stream.length - 5; // inside the payload of "third"

        const chunks = [stream.subarray(0, cut1), stream.subarray(cut1, cut2), stream.subarray(cut2)];

        expect(await split(chunks)).toEqual(["first", "second", "third"]);
    });

    it("does not emit an incomplete trailing packet", async () => {
        const partial = encode("partial").subarray(0, 8);

        expect(await split([Buffer.concat([encode("complete"), partial])])).toEqual(["complete"]);
    });

    it("errors on an invalid size field", async () => {
        const header = Buffer.alloc(4);
        header.writeInt32LE(-4);

        await expect(split([header])).rejects.toThrow("Invalid packet size: -4");
    });
});
