/**
 * CRDT-Native UUID Tests
 *
 * Tests the prefix-discriminated UUID encoding:
 *   'p' + Feistel body (user-generated entities)
 *   'd' + packed body (deterministic genesis entities)
 *
 * Pure codec tests — no Yjs dependency.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { bodyDecode, bodyEncode, decode, encode, murmur32 } from "../../crdt-uuid.js";

// ── Arbitraries ──

const uint32 = fc.integer({ min: 0, max: 0xffffffff });

// Genesis clientIds: above uint32, up to MAX_SAFE_INTEGER
const genesisClientId = fc.integer({ min: 0x100000000, max: Number.MAX_SAFE_INTEGER });
const genesisClock = fc.integer({ min: 0, max: 4095 }); // 12-bit cap

describe("CRDT-Native UUID Codec", () => {
  describe("Body (base63) roundtrip", () => {
    it("roundtrips zero values", () => {
      const decoded = bodyDecode(bodyEncode(0, 0));
      expect(decoded.hi).toBe(0);
      expect(decoded.lo).toBe(0);
    });

    it("roundtrips max uint32 values", () => {
      const decoded = bodyDecode(bodyEncode(0xffffffff, 0xffffffff));
      expect(decoded.hi).toBe(0xffffffff);
      expect(decoded.lo).toBe(0xffffffff);
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
        const decoded = bodyDecode(bodyEncode(hi, lo));
        expect(decoded.hi).toBe(hi >>> 0);
        expect(decoded.lo).toBe(lo >>> 0);
      }
    });

    it("roundtrips any uint32 pair (fuzz)", () => {
      fc.assert(
        fc.property(uint32, uint32, (hi, lo) => {
          const decoded = bodyDecode(bodyEncode(hi, lo));
          return decoded.hi === hi >>> 0 && decoded.lo === lo >>> 0;
        }),
      );
    });

    it("always produces 11-char output (fuzz)", () => {
      fc.assert(
        fc.property(uint32, uint32, (hi, lo) => {
          return bodyEncode(hi, lo).length === 11;
        }),
      );
    });

    it("output is always valid base63 (fuzz)", () => {
      fc.assert(
        fc.property(uint32, uint32, (hi, lo) => {
          return /^[a-zA-Z0-9_]{11}$/.test(bodyEncode(hi, lo));
        }),
      );
    });
  });

  describe("Feistel encode/decode roundtrip ('p' prefix)", () => {
    it("roundtrips with basic values", () => {
      const { clientId, clock } = decode(encode(1, 0));
      expect(clientId).toBe(1);
      expect(clock).toBe(0);
    });

    it("roundtrips with clock=0", () => {
      const result = decode(encode(42, 0));
      expect(result.clientId).toBe(42);
      expect(result.clock).toBe(0);
    });

    it("roundtrips with max uint32 clientId", () => {
      const result = decode(encode(0xffffffff, 12345));
      expect(result.clientId).toBe(0xffffffff);
      expect(result.clock).toBe(12345);
    });

    it("roundtrips with max uint32 clock", () => {
      const result = decode(encode(7, 0xffffffff));
      expect(result.clientId).toBe(7);
      expect(result.clock).toBe(0xffffffff);
    });

    it("roundtrips any (clientId, clock) pair (fuzz)", () => {
      fc.assert(
        fc.property(uint32, uint32, (clientId, clock) => {
          const result = decode(encode(clientId, clock));
          return result.clientId === clientId >>> 0 && result.clock === clock >>> 0;
        }),
      );
    });

    it("always produces 'p' prefix (fuzz)", () => {
      fc.assert(
        fc.property(uint32, uint32, (clientId, clock) => {
          return encode(clientId, clock)[0] === "p";
        }),
      );
    });
  });

  describe("Genesis encode/decode roundtrip ('d' prefix)", () => {
    it("roundtrips basic genesis values", () => {
      const clientId = 0x100000000; // smallest above-uint32
      const result = decode(encode(clientId, 0));
      expect(result.clientId).toBe(clientId);
      expect(result.clock).toBe(0);
    });

    it("roundtrips max genesis values", () => {
      const clientId = Number.MAX_SAFE_INTEGER;
      const clock = 4095;
      const result = decode(encode(clientId, clock));
      expect(result.clientId).toBe(clientId);
      expect(result.clock).toBe(clock);
    });

    it("roundtrips any genesis (clientId, clock) pair (fuzz)", () => {
      fc.assert(
        fc.property(genesisClientId, genesisClock, (clientId, clock) => {
          const result = decode(encode(clientId, clock));
          return result.clientId === clientId && result.clock === clock;
        }),
      );
    });

    it("always produces 'd' prefix (fuzz)", () => {
      fc.assert(
        fc.property(genesisClientId, genesisClock, (clientId, clock) => {
          return encode(clientId, clock)[0] === "d";
        }),
      );
    });

    it("throws on clock exceeding cap", () => {
      expect(() => encode(0x100000000, 4096)).toThrow("exceeds maximum");
      expect(() => encode(0x100000000, 5000)).toThrow("exceeds maximum");
    });
  });

  describe("output format", () => {
    it("plexus UUIDs: always 12 chars, p + base63 (fuzz)", () => {
      fc.assert(
        fc.property(uint32, uint32, (clientId, clock) => {
          const uuid = encode(clientId, clock);
          return uuid.length === 12 && /^p[a-zA-Z0-9_]{11}$/.test(uuid);
        }),
      );
    });

    it("genesis UUIDs: always 12 chars, d + base63 (fuzz)", () => {
      fc.assert(
        fc.property(genesisClientId, genesisClock, (clientId, clock) => {
          const uuid = encode(clientId, clock);
          return uuid.length === 12 && /^d[a-zA-Z0-9_]{11}$/.test(uuid);
        }),
      );
    });
  });

  describe("collision resistance", () => {
    it("sequential clocks produce different UUIDs", () => {
      const uuids = new Set<string>();
      for (let clock = 0; clock < 1000; clock++) {
        uuids.add(encode(1, clock));
      }
      expect(uuids.size).toBe(1000);
    });

    it("different clients produce different UUIDs", () => {
      const uuids = new Set<string>();
      for (let clientId = 0; clientId < 1000; clientId++) {
        uuids.add(encode(clientId, 0));
      }
      expect(uuids.size).toBe(1000);
    });

    it("p-prefix encode is injective (fuzz)", () => {
      fc.assert(
        fc.property(
          fc.uniqueArray(fc.tuple(uint32, uint32), {
            minLength: 2,
            maxLength: 50,
            comparator: (a, b) => a[0] === b[0] && a[1] === b[1],
          }),
          (pairs) => {
            const uuids = new Set(pairs.map(([c, k]) => encode(c, k)));
            return uuids.size === pairs.length;
          },
        ),
      );
    });

    it("d-prefix encode is injective (fuzz)", () => {
      fc.assert(
        fc.property(
          fc.uniqueArray(fc.tuple(genesisClientId, genesisClock), {
            minLength: 2,
            maxLength: 50,
            comparator: (a, b) => a[0] === b[0] && a[1] === b[1],
          }),
          (pairs) => {
            const uuids = new Set(pairs.map(([c, k]) => encode(c, k)));
            return uuids.size === pairs.length;
          },
        ),
      );
    });

    it("p and d prefixes never collide", () => {
      const pUuid = encode(1, 0);
      const dUuid = encode(0x100000000, 0);
      expect(pUuid[0]).toBe("p");
      expect(dUuid[0]).toBe("d");
      expect(pUuid).not.toBe(dUuid);
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
