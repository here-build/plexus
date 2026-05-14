import { describe, expect, it } from "vitest";

import {
  decodeFrame,
  encodeFrame,
  messageAwareness,
  messageReady,
  messageSync,
} from "../protocol.js";

describe("protocol — frame roundtrip", () => {
  it("encodes + decodes a ready frame with empty prefix", () => {
    const frame = encodeFrame("", messageReady);
    const decoded = decodeFrame(frame, "");
    expect(decoded).toEqual({ kind: "match", type: messageReady, payload: null });
  });

  it("encodes + decodes a sync frame with payload, empty prefix", () => {
    const payload = new Uint8Array([10, 20, 30, 40]);
    const frame = encodeFrame("", messageSync, payload);
    const decoded = decodeFrame(frame, "");
    expect(decoded.kind).toBe("match");
    if (decoded.kind === "match") {
      expect(decoded.type).toBe(messageSync);
      expect(Array.from(decoded.payload!)).toEqual([10, 20, 30, 40]);
    }
  });

  it("encodes + decodes an awareness frame with non-empty prefix", () => {
    const payload = new Uint8Array([1, 2, 3]);
    const frame = encodeFrame("docA", messageAwareness, payload);
    const decoded = decodeFrame(frame, "docA");
    expect(decoded.kind).toBe("match");
    if (decoded.kind === "match") {
      expect(decoded.type).toBe(messageAwareness);
      expect(Array.from(decoded.payload!)).toEqual([1, 2, 3]);
    }
  });
});

describe("protocol — prefix multiplexing", () => {
  it("frames addressed to a different prefix surface as wrong-prefix", () => {
    const frame = encodeFrame("docA", messageReady);
    const decoded = decodeFrame(frame, "docB");
    expect(decoded).toEqual({ kind: "wrong-prefix", prefix: "docA" });
  });

  it("empty-prefix frame is not accepted by a non-empty-prefix receiver (and vice versa)", () => {
    expect(decodeFrame(encodeFrame("", messageReady), "x").kind).toBe("wrong-prefix");
    expect(decodeFrame(encodeFrame("x", messageReady), "").kind).toBe("wrong-prefix");
  });
});

describe("protocol — forward compatibility", () => {
  it("unknown outer message type decodes as unknown-type, not throw", () => {
    // Hand-build a frame with prefix="" and a varUint=99 type byte.
    // VarUint 99 fits in one byte. VarString "" is one byte 0x00.
    const synthetic = new Uint8Array([0x00, 99]);
    const decoded = decodeFrame(synthetic, "");
    expect(decoded).toEqual({ kind: "unknown-type", prefix: "", type: 99 });
  });
});
