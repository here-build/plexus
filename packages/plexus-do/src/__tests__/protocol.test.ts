import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { describe, expect, it } from "vitest";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

import { MESSAGE_SYNC } from "../constants.js";
import { encodeDocUpdate, encodeSyncStep1, handleYjsFrame } from "../protocol.js";
import type { ProtocolRouting } from "../protocol.js";
import type { ResolvedLane } from "../types.js";

describe("handleYjsFrame", () => {
  it("round-trips sync step1 from empty client to populated server doc", () => {
    const server = new Y.Doc();
    server.getMap("root").set("k", "v");

    const prime: ResolvedLane = { id: "prime", doc: server, messageType: MESSAGE_SYNC, persistKey: "yjs-state" };
    const routing: ProtocolRouting = { prime };

    const client = new Y.Doc();
    const step1 = encodeSyncStep1(client, MESSAGE_SYNC);
    const reply = handleYjsFrame(step1, routing, "client");
    expect(reply).not.toBeNull();
    expect(reply!.byteLength).toBeGreaterThan(1);

    const decoder = decoding.createDecoder(reply!);
    const messageType = decoding.readVarUint(decoder);
    expect(messageType).toBe(MESSAGE_SYNC);
    const replyEncoder = encoding.createEncoder();
    encoding.writeVarUint(replyEncoder, MESSAGE_SYNC);
    syncProtocol.readSyncMessage(decoder, replyEncoder, client, "test");

    expect(client.getMap("root").get("k")).toBe("v");
  });

  it("encodes outbound doc updates with the lane message type", () => {
    const update = new Uint8Array([1, 2, 3]);
    const framed = encodeDocUpdate(update, MESSAGE_SYNC);
    expect(framed[0]).toBe(MESSAGE_SYNC);
  });
});