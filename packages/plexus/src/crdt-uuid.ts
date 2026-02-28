/**
 * CRDT-Native UUID: prefix-discriminated encoding of Yjs {clientId, clock} addresses.
 *
 * Format: prefix (1 char) + body (11 chars base63) = 12 chars total.
 *
 * Prefixes:
 *   'p' — plexus (user-generated entity, clientId ≤ uint32)
 *         Body: Feistel(clientId32, clock32), diffused by doc-specific round keys.
 *   'd' — deterministic (genesis entity, clientId > uint32)
 *         Body: pack(offset, clock) directly — no Feistel needed since
 *         the clientId is already content-addressed (a hash).
 *
 * Body alphabet: a-zA-Z0-9_ (63 chars). Capacity: 63^11 ≈ 2^65.75.
 * Valid in JS identifiers, CSS class names, and member access keys.
 *
 * Pure module — zero Yjs imports. The UUID IS the entity's physical CRDT address,
 * decodable back to a StructStore lookup in O(log n).
 */

import invariant from "tiny-invariant";
import type { PlexusUUID } from "./proxy-runtime-types.js";

// ── Body alphabet: Base63 ──

const ALPHA = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_";

const DECODE_TABLE = new Uint8Array(128);
for (let i = 0; i < ALPHA.length; i++) DECODE_TABLE[ALPHA.charCodeAt(i)] = i;

// ── Murmur3-inspired 32-bit hash for round keys ──

export function murmur32(key: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < key.length; i++) {
    let k = key.charCodeAt(i);
    k = Math.imul(k, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) >>> 0;
  }
  h ^= key.length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// ── Round key derivation ──

export function deriveRoundKeys(docGuid: string): [number, number, number, number] {
  return [murmur32(docGuid, 0), murmur32(docGuid, 1), murmur32(docGuid, 2), murmur32(docGuid, 3)];
}

// ── Round function: diffusion via multiply-xor-shift ──

function roundFn(value: number, key: number): number {
  let h = (value ^ key) >>> 0;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return h >>> 0;
}

// ── Body encoding: (hi: ≤33 bits, lo: uint32) ↔ 11 base63 chars ──
// Capacity: 63^11 ≈ 6.2×10^19 > 2^65 ≈ 3.7×10^19 ✓
// No BigInt. All intermediates ≤ 63 × 2^32 < 2^38 — safe for float64.

export function bodyEncode(hi: number, lo: number): string {
  const chars = new Array<string>(11);
  for (let i = 10; i >= 0; i--) {
    const hiRem = hi % 63;
    hi = Math.floor(hi / 63);
    const combined = hiRem * 0x100000000 + lo;
    chars[i] = ALPHA[combined % 63];
    lo = Math.floor(combined / 63);
  }
  return chars.join("");
}

export function bodyDecode(s: string): { hi: number; lo: number } {
  let hi = 0;
  let lo = 0;
  for (let i = 0; i < 11; i++) {
    const digit = DECODE_TABLE[s.charCodeAt(i)];
    const loProduct = lo * 63 + digit;
    const carry = Math.floor(loProduct / 0x100000000);
    lo = loProduct >>> 0;
    hi = hi * 63 + carry;
  }
  return { hi, lo: lo >>> 0 };
}

// ── Genesis packing constants ──
// offset = clientId - MAX_UINT32 - 1 (up to ~2^53)
// Split into hi (33 bits) and lo (20 bits offset + 12 bits clock = 32 bits).
// Max packed: (2^33 - 1) × 2^32 + (2^32 - 1) = 2^65 - 1 < 63^11 ✓

const MAX_UINT32 = 0xffffffff;
const CLOCK_BITS = 12;
const CLOCK_CAP = 1 << CLOCK_BITS; // 4096
const OFFSET_BITS = 32 - CLOCK_BITS; // 20

// ── Encode: {clientId, clock} → PlexusUUID ──

export function encode(docGuid: string, clientId: number, clock: number): PlexusUUID {
  if (clientId <= MAX_UINT32) {
    // 'p' — plexus: Feistel(clientId, clock) diffused by docGuid
    const roundKeys = deriveRoundKeys(docGuid);
    let L = clientId >>> 0;
    let R = clock >>> 0;
    for (let i = 0; i < 4; i++) {
      const newR = (L ^ roundFn(R, roundKeys[i])) >>> 0;
      L = R;
      R = newR;
    }
    return ("p" + bodyEncode(L, R)) as PlexusUUID;
  }

  // 'd' — deterministic: direct packing (clientId is already a content hash)
  // No bitwise ops on offset — it can exceed 2^32, and &/<</>>/| truncate to int32.
  invariant(clock < CLOCK_CAP, `Genesis entity clock ${clock} exceeds maximum ${CLOCK_CAP - 1}`);
  const offset = clientId - MAX_UINT32 - 1;
  const hi = Math.floor(offset / (1 << OFFSET_BITS));
  const offsetLo = offset % (1 << OFFSET_BITS);
  const lo = offsetLo * CLOCK_CAP + clock;
  return ("d" + bodyEncode(hi, lo)) as PlexusUUID;
}

// ── Decode: PlexusUUID → {clientId, clock} ──

export function decode(uuid: PlexusUUID, docGuid: string): { clientId: number; clock: number } {
  const prefix = uuid[0];
  const body = uuid.slice(1);

  if (prefix === "p") {
    const roundKeys = deriveRoundKeys(docGuid);
    let { hi: L, lo: R } = bodyDecode(body);
    for (let i = 3; i >= 0; i--) {
      const newL = (R ^ roundFn(L, roundKeys[i])) >>> 0;
      R = L;
      L = newL;
    }
    return { clientId: L, clock: R };
  }

  invariant(prefix === "d", `Unknown UUID prefix: '${prefix}'`);
  const { hi, lo } = bodyDecode(body);
  // lo is uint32 from bodyDecode, so bitwise is safe here
  const clock = lo % CLOCK_CAP;
  const offsetLo = Math.floor(lo / CLOCK_CAP);
  const offset = hi * (1 << OFFSET_BITS) + offsetLo;
  return { clientId: offset + MAX_UINT32 + 1, clock };
}
