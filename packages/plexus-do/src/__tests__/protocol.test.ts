import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { describe, expect, it } from "vitest";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

import { MESSAGE_AWARENESS, MESSAGE_SYNC } from "../constants.js";
import { encodeDocUpdate, encodeSyncStep1, handleYjsFrame } from "../protocol.js";
import type { ProtocolRouting } from "../protocol.js";
import type { AwarenessPlane, ResolvedLane } from "../types.js";

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

  it("applies awareness to the plane and does not touch the doc", () => {
    const doc = new Y.Doc();
    const applied: { payload: Uint8Array; origin: unknown }[] = [];
    const awareness: AwarenessPlane = {
      applyUpdate(payload, origin) {
        applied.push({ payload, origin });
      },
      encodeUpdate: () => new Uint8Array(),
      onChange: () => {},
    };
    const prime: ResolvedLane = { id: "prime", doc, messageType: MESSAGE_SYNC, persistKey: "yjs-state" };
    const payload = new Uint8Array([9, 8, 7]);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(encoder, payload);

    const reply = handleYjsFrame(encoding.toUint8Array(encoder), { prime, awareness }, "socket");
    expect(reply).toBeNull();
    expect(applied).toHaveLength(1);
    expect([...applied[0]!.payload]).toEqual([9, 8, 7]);
    expect(applied[0]!.origin).toBe("socket");
    expect(doc.getMap("root").size).toBe(0);
  });
});