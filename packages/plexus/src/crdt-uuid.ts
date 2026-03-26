/**
 * CRDT-Native UUID: prefix-discriminated encoding of Yjs {clientId, clock} addresses.
 *
 * Format: prefix (1 char) + body (11 chars base63) = 12 chars total.
 *
 * Prefixes:
 *   'p' — plexus (user-generated entity, clientId ≤ uint32)
 *         Body: Feistel(clientId32, clock32) with fixed round keys.
 *         Produces pseudo-random-looking UUIDs from sequential inputs.
 *   'l' — liminal (ephemeral session entity, clientId in liminal range)
 *         Body: Feistel(clientId - LIMINAL_BASE, clock) — same cipher,
 *         subtracted base avoids collision with 'p' UUIDs. Full uint32 clock.
 *   'b' — bound (cloned into virtual map — same Feistel as 'p', reparent blocked)
 *   'd' — deterministic (genesis entity, clientId in genesis range)
 *         Body: pack(offset, clock) directly — no Feistel needed since
 *         the clientId is already content-addressed (a hash).
 *   'a' — arbitrary (test-only, PLEXUS_UUID_MODE=arbitrary)
 *         Body: nanoid(). Not decodable — used only in unit tests where
 *         CRDT addressing is irrelevant. The prefix prevents false positives
 *         on the 'd'-prefix virtual child guard (reparenting/detach invariants).
 *
 * Body alphabet: a-zA-Z0-9_ (63 chars). Capacity: 63^11 ≈ 2^65.75.
 * Valid in JS identifiers, CSS class names, and member access keys.
 *
 * Pure module — zero Yjs imports. The UUID IS the entity's physical CRDT address,
 * decodable back to a StructStore lookup in O(log n).
 */

import invariant from "tiny-invariant";

import { isGenesisClientId, isLiminalClientId, LIMINAL_BASE } from "./genesis-client.js";
import type { PlexusUUID } from "./proxy-runtime-types.js";

// ── Body alphabet: Base63 ──

const ALPHA = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_";

const DECODE_TABLE = new Uint8Array(128);
for (let i = 0; i < ALPHA.length; i++) DECODE_TABLE[ALPHA.charCodeAt(i)] = i;

// ── Murmur3-inspired 32-bit hash (used by genesis, exported) ──

export function murmur32(key: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < key.length; i++) {
    let k = key.charCodeAt(i);
    k = Math.imul(k, 0xcc_9e_2d_51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b_87_35_93);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6_54_6b_64) >>> 0;
  }
  h ^= key.length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85_eb_ca_6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2_b2_ae_35);
  h ^= h >>> 16;
  return h >>> 0;
}

// ── Feistel round keys ──
// Fixed constants (SHA-256 fractional-part seeds). No doc.guid dependency:
// a UUID must be decodable from any context — carrier doc may differ from
// the doc that created the entity (cross-document references, dependency bundles).

const ROUND_KEYS: [number, number, number, number] = [0x6a_09_e6_67, 0xbb_67_ae_85, 0x3c_6e_f3_72, 0xa5_4f_f5_3a];

// ── Round function: multiply-xor-shift ──
// Bijective per half-block. 4 rounds of a balanced Feistel network on two
// uint32 halves gives a permutation of the full 64-bit input space.
// This is NOT for security — it's for visual dispersion: sequential
// (clientId, clock) pairs should produce UUIDs with no obvious pattern,
// preventing users from inferring creation order or entity relationships.

function roundFn(value: number, key: number): number {
  let h = (value ^ key) >>> 0;
  h = Math.imul(h, 0x5b_d1_e9_95);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5b_d1_e9_95);
  h ^= h >>> 15;
  return h >>> 0;
}

// ── Body encoding: (hi: ≤33 bits, lo: uint32) ↔ 11 base63 chars ──
//
// Mixed-radix extraction: treat (hi, lo) as a single big number split across
// two JS doubles, then repeatedly extract base-63 digits from the low end.
// Each step: remainder → character, quotient → carries into the next step.
//
// The key constraint is avoiding BigInt (V8 BigInt is slow in hot paths).
// Since `hiRem * 2^32 + lo` is at most `62 * 2^32 ≈ 2^38`, all intermediates
// are exact in float64 (safe up to 2^53).
//
// Capacity: 63^11 ≈ 6.2×10^19 > 2^65 ≈ 3.7×10^19 ✓
// This means the body can represent any pair of uint32 values plus an
// additional 1-bit flag (used by genesis hi to encode offsets > 2^32).

export function bodyEncode(hi: number, lo: number): string {
  const chars = Array.from({ length: 11 });
  for (let i = 10; i >= 0; i--) {
    const hiRem = hi % 63;
    hi = Math.floor(hi / 63);
    const combined = hiRem * 0x1_00_00_00_00 + lo;
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
    const carry = Math.floor(loProduct / 0x1_00_00_00_00);
    lo = loProduct >>> 0;
    hi = hi * 63 + carry;
  }
  return { hi, lo: lo >>> 0 };
}

// ── Genesis packing constants ──
//
// Genesis clientIds are content-addressed hashes — already pseudo-random.
// No Feistel needed (it would add latency for zero benefit). Instead, pack
// the offset (clientId above uint32) and a 12-bit clock into the body directly.
//
// ## Why genesis can't use Feistel (and why the packed encoding exists)
//
// Feistel operates on two uint32 halves. If genesis clientIds fit in uint32,
// we'd use the same code path as p/l prefixes. But genesis clientIds live in
// [GENESIS_BASE, MAX_SAFE_INTEGER] — a ~2^45 range — so the offset from base
// exceeds uint32.
//
// We CANNOT shrink the range to fit uint32. The architecture is designed for
// 1M+ projects with 1K+ virtual genesis sequences each. Birthday collision
// math at that scale:
//
//   Range 2^32 → 1.16×10⁻⁴ per project → ~116 affected projects per 1M
//   Range 2^36 → 7.3×10⁻⁶  per project → ~7 affected projects per 1M
//   Range 2^40 → 4.5×10⁻⁷  per project → ~0.5 (coin flip across fleet)
//   Range 2^45 → 1.4×10⁻⁸  per project → ~0.014 (one in ~70M projects)
//
// A collision means two different virtual children get the same genesis
// clientId → Yjs merges their Items → silent data corruption. At 2^32,
// ~116 out of 1M projects would hit this. The packed encoding and 12-bit
// clock cap are the price for collision safety at fleet scale.
//
// Layout: hi (33 bits of offset) | lo (20 bits offset tail + 12 bits clock)
// The clock cap (4096) is acceptable: genesis scaffold elements are created
// once per virtual child (type roots, slot entries), not iterated.
//
// Max packed: (2^33 - 1) × 2^32 + (2^32 - 1) = 2^65 - 1 < 63^11 ✓

const MAX_UINT32 = 0xff_ff_ff_ff;
const CLOCK_BITS = 12;
const CLOCK_CAP = 1 << CLOCK_BITS; // 4096
const OFFSET_BITS = 32 - CLOCK_BITS; // 20

// ── Encode: {clientId, clock} → PlexusUUID ──

export function encode(clientId: number, clock: number, binding?: "bound"): PlexusUUID {
  if (isLiminalClientId(clientId)) {
    // 'l' — liminal: Feistel on (clientId - LIMINAL_BASE, clock).
    // Subtracting the base gives a uint32 that won't collide with 'p' UUIDs.
    // Full uint32 clock — no cap, supports long drag sessions.
    let L = ((clientId - LIMINAL_BASE) >>> 0);
    let R = clock >>> 0;
    for (let i = 0; i < 4; i++) {
      const newR = (L ^ roundFn(R, ROUND_KEYS[i])) >>> 0;
      L = R;
      R = newR;
    }
    return (`l${bodyEncode(L, R)}`) as PlexusUUID;
  }

  if (clientId <= MAX_UINT32) {
    // 'p'/'b' — regular client: Feistel(clientId, clock)
    let L = clientId >>> 0;
    let R = clock >>> 0;
    for (let i = 0; i < 4; i++) {
      const newR = (L ^ roundFn(R, ROUND_KEYS[i])) >>> 0;
      L = R;
      R = newR;
    }
    const prefix = binding === "bound" ? "b" : "p";
    return (prefix + bodyEncode(L, R)) as PlexusUUID;
  }

  // 'd' — genesis: direct packing (clientId is already a content hash)
  // No bitwise ops on offset — it can exceed 2^32, and &/<</>>/| truncate to int32.
  invariant(isGenesisClientId(clientId), `ClientId ${clientId} is in reserved range (not regular, liminal, or genesis)`);
  invariant(clock < CLOCK_CAP, `Genesis entity clock ${clock} exceeds maximum ${CLOCK_CAP - 1}`);
  const offset = clientId - MAX_UINT32 - 1;
  const hi = Math.floor(offset / (1 << OFFSET_BITS));
  const offsetLo = offset % (1 << OFFSET_BITS);
  const lo = offsetLo * CLOCK_CAP + clock;
  return `d${bodyEncode(hi, lo)}` as PlexusUUID;
}

// ── Decode: PlexusUUID → {clientId, clock} ──

export function decode(uuid: PlexusUUID): { clientId: number; clock: number } {
  const prefix = uuid[0];
  const body = uuid.slice(1);

  if (prefix === "p" || prefix === "b") {
    // Feistel inverse — same for p (normal) and b (bound)
    let { hi: L, lo: R } = bodyDecode(body);
    for (let i = 3; i >= 0; i--) {
      const newL = (R ^ roundFn(L, ROUND_KEYS[i])) >>> 0;
      R = L;
      L = newL;
    }
    return { clientId: L, clock: R };
  }

  if (prefix === "l") {
    // Feistel inverse for liminal — add LIMINAL_BASE back to recover the full clientId
    let { hi: L, lo: R } = bodyDecode(body);
    for (let i = 3; i >= 0; i--) {
      const newL = (R ^ roundFn(L, ROUND_KEYS[i])) >>> 0;
      R = L;
      L = newL;
    }
    return { clientId: L + LIMINAL_BASE, clock: R };
  }

  invariant(prefix === "d", `Unknown UUID prefix: '${prefix}'`);
  const { hi, lo } = bodyDecode(body);
  const clock = lo % CLOCK_CAP;
  const offsetLo = Math.floor(lo / CLOCK_CAP);
  const offset = hi * (1 << OFFSET_BITS) + offsetLo;
  return { clientId: offset + MAX_UINT32 + 1, clock };
}
