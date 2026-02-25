/**
 * CRDT-Native UUID: Feistel cipher encoding of Yjs {clientId, clock} addresses.
 *
 * Pure module — zero Yjs imports. The UUID IS the entity's physical CRDT address,
 * decodable back to a StructStore lookup in O(log n).
 *
 * See 04-crdt-native-uuid.md for design rationale.
 */

import type { PlexusUUID } from "./proxy-runtime-types.js";

// ── Base62 alphabet ──

const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ALPHANUM = LETTERS + "0123456789";

// Lookup table for O(1) char→index decoding
const DECODE = new Uint8Array(128);
for (let i = 0; i < ALPHANUM.length; i++) DECODE[ALPHANUM.charCodeAt(i)] = i;

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

// ── Encode: {clientId, clock} → PlexusUUID ──

export function encode(docGuid: string, clientId: number, clock: number): PlexusUUID {
  const roundKeys = deriveRoundKeys(docGuid);
  let L = clientId >>> 0;
  let R = clock >>> 0;
  for (let i = 0; i < 4; i++) {
    const newR = (L ^ roundFn(R, roundKeys[i])) >>> 0;
    L = R;
    R = newR;
  }
  return toBase62(L, R) as PlexusUUID;
}

// ── Decode: PlexusUUID → {clientId, clock} ──

export function decode(uuid: PlexusUUID, docGuid: string): { clientId: number; clock: number } {
  const roundKeys = deriveRoundKeys(docGuid);
  let { L, R } = fromBase62(uuid);
  for (let i = 3; i >= 0; i--) {
    const newL = (R ^ roundFn(L, roundKeys[i])) >>> 0;
    R = L;
    L = newL;
  }
  return { clientId: L, clock: R };
}

// ── Base62 encoding: 64-bit → 11 alphanumeric chars (first char always letter) ──
// Capacity: 52 × 62^10 ≈ 4.36×10^19 > 2^64 ≈ 1.84×10^19 ✓
// No BigInt. All intermediates < 2^53 for native float math.

export function toBase62(hi: number, lo: number): string {
  hi = hi >>> 0;
  lo = lo >>> 0;
  const chars = new Array<string>(11);
  for (let i = 10; i >= 1; i--) {
    const hiRem = hi % 62;
    hi = (hi / 62) >>> 0;
    const combined = hiRem * 0x100000000 + lo;
    chars[i] = ALPHANUM[combined % 62];
    lo = (combined / 62) >>> 0;
  }
  // Remaining value guaranteed < 52 (first char is always a letter)
  chars[0] = LETTERS[hi * 0x100000000 + lo];
  return chars.join("");
}

export function fromBase62(s: string): { L: number; R: number } {
  let hi = 0;
  let lo = LETTERS.indexOf(s[0]);
  for (let i = 1; i < 11; i++) {
    const digit = DECODE[s.charCodeAt(i)];
    const loProduct = lo * 62 + digit;
    const carry = (loProduct / 0x100000000) >>> 0;
    lo = loProduct >>> 0;
    hi = hi * 62 + carry;
  }
  return { L: hi >>> 0, R: lo >>> 0 };
}
