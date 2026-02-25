/**
 * CRDT-Native UUID Tests
 *
 * Tests the Feistel cipher encoding of Yjs {clientId, clock} addresses.
 * Pure codec tests — no Yjs dependency.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { decode, encode, fromBase62, murmur32, toBase62 } from "../../crdt-uuid.js";

// ── Arbitraries ──

const uint32 = fc.integer({ min: 0, max: 0xffffffff });
const docGuid = fc.string({ minLength: 1, maxLength: 64 });

describe("CRDT-Native UUID Codec", () => {
  describe("Base62 roundtrip", () => {
    it("roundtrips zero values", () => {
      const encoded = toBase62(0, 0);
      const decoded = fromBase62(encoded);
      expect(decoded.L).toBe(0);
      expect(decoded.R).toBe(0);
    });

    it("roundtrips max uint32 values", () => {
      const encoded = toBase62(0xffffffff, 0xffffffff);
      const decoded = fromBase62(encoded);
      expect(decoded.L).toBe(0xffffffff);
      expect(decoded.R).toBe(0xffffffff);
    });

    it("roundtrips arbitrary values", () => {
      const cases: [number, number][] = [
        [1, 0],
        [0, 1],
        [12345, 67890],
        [0x80000000, 0x80000000],
        [0xdeadbeef, 0xcafebabe],
      ];
      for (const [hi, lo] of cases) {
        const encoded = toBase62(hi, lo);
        const decoded = fromBase62(encoded);
        expect(decoded.L).toBe(hi >>> 0);
        expect(decoded.R).toBe(lo >>> 0);
      }
    });

    it("roundtrips any uint32 pair (fuzz)", () => {
      fc.assert(
        fc.property(uint32, uint32, (hi, lo) => {
          const decoded = fromBase62(toBase62(hi, lo));
          return decoded.L === hi >>> 0 && decoded.R === lo >>> 0;
        }),
      );
    });

    it("always produces 11-char output (fuzz)", () => {
      fc.assert(
        fc.property(uint32, uint32, (hi, lo) => {
          return toBase62(hi, lo).length === 11;
        }),
      );
    });

    it("first char is always a letter (fuzz)", () => {
      fc.assert(
        fc.property(uint32, uint32, (hi, lo) => {
          return /^[a-zA-Z]/.test(toBase62(hi, lo));
        }),
      );
    });

    it("output is always alphanumeric (fuzz)", () => {
      fc.assert(
        fc.property(uint32, uint32, (hi, lo) => {
          return /^[a-zA-Z][a-zA-Z0-9]{10}$/.test(toBase62(hi, lo));
        }),
      );
    });
  });

  describe("Feistel encode/decode roundtrip", () => {
    it("roundtrips with basic values", () => {
      const guid = "test-doc-guid";
      const { clientId, clock } = decode(encode(guid, 1, 0), guid);
      expect(clientId).toBe(1);
      expect(clock).toBe(0);
    });

    it("roundtrips with clock=0", () => {
      const guid = "doc-abc";
      const result = decode(encode(guid, 42, 0), guid);
      expect(result.clientId).toBe(42);
      expect(result.clock).toBe(0);
    });

    it("roundtrips with max uint32 clientId", () => {
      const guid = "doc-xyz";
      const result = decode(encode(guid, 0xffffffff, 12345), guid);
      expect(result.clientId).toBe(0xffffffff);
      expect(result.clock).toBe(12345);
    });

    it("roundtrips with max uint32 clock", () => {
      const guid = "doc-xyz";
      const result = decode(encode(guid, 7, 0xffffffff), guid);
      expect(result.clientId).toBe(7);
      expect(result.clock).toBe(0xffffffff);
    });

    it("roundtrips any (docGuid, clientId, clock) triple (fuzz)", () => {
      fc.assert(
        fc.property(docGuid, uint32, uint32, (guid, clientId, clock) => {
          const result = decode(encode(guid, clientId, clock), guid);
          return result.clientId === clientId >>> 0 && result.clock === clock >>> 0;
        }),
      );
    });
  });

  describe("docGuid isolation", () => {
    it("different docGuids produce different UUIDs for same (clientId, clock)", () => {
      const uuid1 = encode("doc-A", 1, 0);
      const uuid2 = encode("doc-B", 1, 0);
      expect(uuid1).not.toBe(uuid2);
    });

    it("decode fails with wrong docGuid (produces wrong values)", () => {
      const uuid = encode("doc-A", 42, 99);
      const wrongResult = decode(uuid, "doc-B");
      // Should not recover the original values
      expect(wrongResult.clientId === 42 && wrongResult.clock === 99).toBe(false);
    });

    it("wrong docGuid almost never recovers original values (fuzz)", () => {
      // Not a strict invariant (Feistel collisions are theoretically possible),
      // but with 64-bit output space the probability per trial is ~2^-64.
      fc.assert(
        fc.property(
          docGuid,
          docGuid.filter((s) => s.length > 0),
          uint32,
          uint32,
          (guidA, guidB, clientId, clock) => {
            fc.pre(guidA !== guidB);
            const uuid = encode(guidA, clientId, clock);
            const wrong = decode(uuid, guidB);
            return wrong.clientId !== clientId >>> 0 || wrong.clock !== clock >>> 0;
          },
        ),
      );
    });
  });

  describe("output format", () => {
    it("encode always produces valid identifier format (fuzz)", () => {
      fc.assert(
        fc.property(docGuid, uint32, uint32, (guid, clientId, clock) => {
          const uuid = encode(guid, clientId, clock);
          return uuid.length === 11 && /^[a-zA-Z][a-zA-Z0-9]{10}$/.test(uuid);
        }),
      );
    });
  });

  describe("collision resistance", () => {
    it("sequential clocks produce different UUIDs", () => {
      const guid = "collision-test";
      const uuids = new Set<string>();
      for (let clock = 0; clock < 1000; clock++) {
        uuids.add(encode(guid, 1, clock));
      }
      expect(uuids.size).toBe(1000);
    });

    it("different clients produce different UUIDs", () => {
      const guid = "collision-test";
      const uuids = new Set<string>();
      for (let clientId = 0; clientId < 1000; clientId++) {
        uuids.add(encode(guid, clientId, 0));
      }
      expect(uuids.size).toBe(1000);
    });

    it("encode is injective for fixed docGuid (fuzz)", () => {
      // Generate batches of distinct (clientId, clock) pairs and verify no UUID collisions
      fc.assert(
        fc.property(
          docGuid,
          fc.uniqueArray(fc.tuple(uint32, uint32), {
            minLength: 2,
            maxLength: 50,
            comparator: (a, b) => a[0] === b[0] && a[1] === b[1],
          }),
          (guid, pairs) => {
            const uuids = new Set(pairs.map(([c, k]) => encode(guid, c, k)));
            return uuids.size === pairs.length;
          },
        ),
      );
    });
  });

  describe("murmur32 properties", () => {
    it("always returns uint32 (fuzz)", () => {
      fc.assert(
        fc.property(fc.string(), uint32, (key, seed) => {
          const h = murmur32(key, seed);
          return h >= 0 && h <= 0xffffffff && h >>> 0 === h;
        }),
      );
    });

    it("is deterministic (fuzz)", () => {
      fc.assert(
        fc.property(fc.string(), uint32, (key, seed) => {
          return murmur32(key, seed) === murmur32(key, seed);
        }),
      );
    });

    it("different seeds produce different hashes (avalanche, fuzz)", () => {
      fc.assert(
        fc.property(fc.string({ minLength: 1 }), uint32, uint32, (key, seedA, seedB) => {
          fc.pre(seedA !== seedB);
          return murmur32(key, seedA) !== murmur32(key, seedB);
        }),
      );
    });
  });
});
