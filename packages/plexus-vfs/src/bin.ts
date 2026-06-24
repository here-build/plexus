/**
 * The single representation seam of the whole package.
 *
 * Plexus `@syncing` fields are CRDT-backed and (today) store JS primitives —
 * a `Uint8Array` is not a syncable value. So file content rides as a **latin1
 * byte-string**: 1 char ↔ 1 byte. Every byte 0x00–0xFF maps to exactly one
 * UTF-16 code unit in the 0x00–0xFF range, so the round-trip is lossless for
 * arbitrary binary — which is what lets git's own (binary) object files survive
 * the store and isomorphic-git work unmodified.
 *
 * When a real `Uint8Array` Plexus field lands, ONLY these two functions (and the
 * `content` field's type) change; nothing downstream of the seam moves.
 *
 * Efficiency note: `String.fromCharCode(...bytes)` blows the call stack on large
 * inputs, and char-by-char `+=` is O(n²). We chunk: fixed-size `subarray` →
 * `fromCharCode(...chunk)` → join. That keeps both the arg-count and the
 * allocation count bounded.
 *
 * NB: `charCodeAt`/`fromCharCode` (UTF-16 code units, 0–0xFFFF) are LOAD-BEARING
 * here, not a lint slip. The latin1 mapping is per-code-unit; `codePointAt`/
 * `fromCodePoint` would collapse surrogate pairs into single >0xFFFF code points
 * and corrupt the byte stream — so `unicorn/prefer-code-point` is disabled below.
 */
/* eslint-disable unicorn/prefer-code-point */

const CHUNK = 0x80_00; // 32k — comfortably under the arg-count limit of fromCharCode

/** latin1 byte-string → bytes. Each code unit is taken mod 256 (it always is, by construction). */
export function binToBytes(bin: string): Uint8Array {
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i) & 0xff;
  }
  return out;
}

/** bytes → latin1 byte-string, chunked to stay O(n) and stack-safe. */
export function bytesToBin(bytes: Uint8Array): string {
  if (bytes.length <= CHUNK) {
    return String.fromCharCode(...bytes);
  }
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
  }
  return parts.join("");
}

/**
 * Stable uint32 from a PlexusUUID string (FNV-1a). iso-git folds `stat.ino`
 * into its index; it only needs to be stable per entity across reads, not
 * globally unique. FNV-1a over the UUID chars gives exactly that.
 */
export function uint32FromUUID(uuid: string): number {
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < uuid.length; i++) {
    h ^= uuid.charCodeAt(i);
    // h * 16777619 (the FNV prime) via shifts, kept in uint32 by the final >>> 0
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}
