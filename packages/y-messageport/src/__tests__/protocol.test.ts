import { describe, expect, it } from "vitest";

import {
  decodeFrame,
  encodeFrame,
  messageAwareness,
  messageReady,
  messageSync,
} from "../protocol.js";

describe("protocol — frame roundtrip", () => {
  it("encodes + decodes a ready frame", () => {
    const frame = encodeFrame(messageReady);
    const decoded = decodeFrame(frame);
    expect(decoded).toEqual({ kind: "match", type: messageReady, payload: null });
  });

  it("encodes + decodes a sync frame with payload", () => {
    const payload = new Uint8Array([10, 20, 30, 40]);
    const frame = encodeFrame(messageSync, payload);
    const decoded = decodeFrame(frame);
    expect(decoded.kind).toBe("match");
    if (decoded.kind === "match") {
      expect(decoded.type).toBe(messageSync);
      expect(Array.from(decoded.payload!)).toEqual([10, 20, 30, 40]);
    }
  });

  it("encodes + decodes an awareness frame", () => {
    const payload = new Uint8Array([1, 2, 3]);
    const frame = encodeFrame(messageAwareness, payload);
    const decoded = decodeFrame(frame);
    expect(decoded.kind).toBe("match");
    if (decoded.kind === "match") {
      expect(decoded.type).toBe(messageAwareness);
      expect(Array.from(decoded.payload!)).toEqual([1, 2, 3]);
    }
  });
});

describe("protocol — forward compatibility", () => {
  it("unknown outer message type decodes as unknown-type, not throw", () => {
    // Hand-build a frame with a varUint=99 type byte. VarUint 99 fits in one byte.
    const synthetic = new Uint8Array([99]);
    const decoded = decodeFrame(synthetic);
    expect(decoded).toEqual({ kind: "unknown-type", type: 99 });
  });

  it("type 5 (reserved) decodes as unknown-type", () => {
    const synthetic = new Uint8Array([5]);
    const decoded = decodeFrame(synthetic);
    expect(decoded).toEqual({ kind: "unknown-type", type: 5 });
  });
});
