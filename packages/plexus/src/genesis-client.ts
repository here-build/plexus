/**
 * Plexus ClientId Namespaces — typed regions in the 53-bit safe integer space.
 *
 * Yjs clientIds are random uint32 values. Plexus reserves the space above uint32
 * for deterministic identities (genesis) and ephemeral sessions (liminal).
 *
 * ## Layout
 *
 * ```
 * [0, 2^32)                     Regular Yjs clients (random uint32)
 * [2^32, 2^33)                  Liminal sessions (random uint32 + 2^32 offset)
 * [2^33, 31 * 2^40)             Reserved for future use
 * [31 * 2^40, MAX_SAFE_INTEGER] Genesis scaffold (0x1F prefix + 45-bit hash)
 * ```
 *
 * ## Priority (Yjs conflict resolution — higher clientId wins)
 *
 * regular < liminal < genesis
 *
 * This guarantees:
 * - Liminal values override committed values in sink docs (correct for preview)
 * - Genesis scaffold is never affected by user operations
 *
 * ## Genesis
 *
 * Deterministic, content-addressed scaffold identities (like EVM CREATE2).
 * Two independent peers producing the same scaffold get identical Yjs Items —
 * sync is a no-op instead of a conflict. Applied via Y.applyUpdate with no
 * tracked origin → invisible to UndoManager.
 *
 * ## Liminal (namespace reserved — not yet implemented)
 *
 * Ephemeral scratch sessions for continuous gestures (drags, scrubs).
 * Each session gets a fresh random clientId in [2^32, 2^33) so Yjs clocks
 * start at 0 per session with no conflicts. The clientId carries no owner
 * information — awareness protocol identifies the session owner.
 */

import * as Y from "yjs";

import { murmur32 } from "./crdt-uuid.js";

// ── Namespace Constants ──────────────────────────────────────────────

/** Yjs regular clientIds are uint32: [0, 0xFFFFFFFF]. */
export const MAX_UINT32 = 0xff_ff_ff_ff;

/**
 * Liminal clientId range: [LIMINAL_BASE, LIMINAL_BASE + MAX_UINT32].
 * One 2^32-sized slot just above the regular range.
 */
export const LIMINAL_BASE = MAX_UINT32 + 1; // 2^32 = 4_294_967_296

/**
 * Genesis clientId range: [GENESIS_BASE, MAX_SAFE_INTEGER].
 * 0x1F (31) in the upper 5 bits of the 53-bit space, leaving ~2^45 hash payload.
 *
 * The range MUST stay large (≥ 2^40) for birthday collision safety. The
 * architecture is designed for 1M+ projects with 1K+ virtual genesis sequences
 * each: 2^32 range → ~116 broken projects per 1M; 2^45 range → ~1 per 70M
 * projects. See crdt-uuid.ts genesis packing comment for the full collision
 * table and rationale.
 *
 * This forces the UUID encoding to use packed offset+clock (not Feistel), since
 * the offset from GENESIS_BASE exceeds uint32. That's an acceptable tradeoff.
 */
export const GENESIS_BASE = 31 * (2 ** 40); // 34_084_860_461_056

/** Genesis hash space: [GENESIS_BASE, MAX_SAFE_INTEGER]. ~2^45 values. */
const GENESIS_RANGE = Number.MAX_SAFE_INTEGER - GENESIS_BASE + 1;

// ── Namespace Discriminators ─────────────────────────────────────────

export function isRegularClientId(clientId: number): boolean {
  return clientId <= MAX_UINT32;
}

/** Liminal range: [LIMINAL_BASE, 2 × LIMINAL_BASE) = [2^32, 2^33). */
export function isLiminalClientId(clientId: number): boolean {
  // LIMINAL_BASE is 2^32, so the upper bound is 2^33 — one full uint32 slot.
  return clientId >= LIMINAL_BASE && clientId < 2 * LIMINAL_BASE;
}

export function isGenesisClientId(clientId: number): boolean {
  return clientId >= GENESIS_BASE;
}

/**
 * Create a random liminal clientId for a new session.
 *
 * Each session gets a fresh random uint32 offset above LIMINAL_BASE.
 * No owner encoding — awareness protocol identifies who owns the session.
 * No session counter — random avoids clock conflicts across sessions.
 */
export function newLiminalClientId(): number {
  // crypto.getRandomValues gives uniform uint32, same as Yjs uses for regular clientIds
  const rand = new Uint32Array(1);
  crypto.getRandomValues(rand);
  return LIMINAL_BASE + rand[0];
}

// ── Genesis ClientId ─────────────────────────────────────────────────

/**
 * Hash seeds — ASCII "GEN" and "SIS". Distinct seeds make the two murmur32
 * outputs statistically independent, so combining them into a 53-bit wide
 * value preserves uniformity across the genesis range.
 */
const SEED_HI = 0x47_45_4e;
const SEED_LO = 0x53_49_53;

/**
 * Compute a deterministic genesis clientId for a scaffold element.
 *
 * Produces a value in [GENESIS_BASE, MAX_SAFE_INTEGER] — the 0x1F prefix namespace.
 *
 * Why two hashes: a single murmur32 is 32-bit, but the genesis range is ~2^45.
 * Two independent 32-bit hashes are combined: hi (masked to 21 bits) shifted left
 * by 32, plus lo. This gives a 53-bit intermediate, constrained via modulo.
 *
 * Birthday collision for 10K scaffold types: ~10^-7. Negligible.
 */
export function genesisClientId(type: string, path: string[]): number {
  const canonical = `${type}\0${path.join("\0")}`;
  const hi = murmur32(canonical, SEED_HI);
  const lo = murmur32(canonical, SEED_LO);
  // (hi & 0x1FFFFF) keeps 21 bits; * 2^32 shifts left; + lo fills lower 32 bits.
  // Wide intermediate: up to 2^53 - 1. Modulo constrains to GENESIS_RANGE.
  // No bitwise ops on the result — JS bitwise truncates to int32.
  const wide = (hi & 0x1f_ff_ff) * 0x1_00_00_00_00 + (lo >>> 0);
  return (wide % GENESIS_RANGE) + GENESIS_BASE;
}

// ── High-level deterministic scaffold API ────────────────────────────
//
// Creates nested Y.Map/Y.Array structures at known paths with deterministic
// clientIds. The core trick: each path segment gets its OWN genesis clientId
// and is produced in a throwaway doc, then merged via Y.applyUpdate.
//
// Why a separate doc per segment: Yjs assigns sequential clocks within a doc.
// If multiple segments shared a doc, clock assignment would depend on creation
// order, breaking determinism when peers create segments in different orders.
// One doc per segment → clock is always 0 → perfectly deterministic.
//
// Why applyUpdate (not direct mutation): applyUpdate uses the source doc's
// clientId, not the target doc's. This makes it a "remote" change in Yjs
// terms — invisible to UndoManager. Users can undo everything they've done
// without destroying the scaffold that makes the document structure work.

/** Cache: canonical key → precomputed single-segment vector */
const vectorCache = new Map<string, Uint8Array>();

function getSegmentVector(type: "map" | "array", path: string[]): Uint8Array {
  const cacheKey = `${type}\0${path.join("\0")}`;
  let vector = vectorCache.get(cacheKey);
  if (vector) return vector;

  const tmpDoc = new Y.Doc();
  tmpDoc.clientID = genesisClientId(type, path);

  // Recursion: apply parent's genesis vector so the parent Y.Map exists in tmpDoc
  if (path.length > 2) {
    Y.applyUpdate(tmpDoc, getSegmentVector("map", path.slice(0, -1)));
  }

  // Navigate to parent (reduce is no-op when path has 2 elements)
  const parent = path.slice(1, -1).reduce<Y.Map<any>>((m, k) => m.get(k), tmpDoc.getMap(path[0]));
  parent.set(path.at(-1)!, type === "array" ? new Y.Array() : new Y.Map());

  vector = Y.encodeStateAsUpdate(tmpDoc);
  tmpDoc.destroy();
  vectorCache.set(cacheKey, vector);
  return vector;
}

/**
 * Ensure a deterministic Y.Map exists at the given path. Returns it.
 *
 * - path[0]: top-level shared type name (e.g. "types")
 * - path[1..]: nested map keys, each created with its own genesis clientId
 * - Applied as update vectors → invisible to UndoManager
 * - Idempotent: duplicate Items are no-ops in Yjs
 *
 * @example
 * ```ts
 * const subModelMap = declareDeterministicMap(doc, ["types", "SubModel"]);
 * ```
 */
export function declareDeterministicMap<V = any>(doc: Y.Doc, path: string[]): Y.Map<V> {
  // Leaf vector contains full ancestry (getSegmentVector is recursive).
  // Y.applyUpdate skips Items that already exist — idempotent by construction.
  if (path.length > 1) Y.applyUpdate(doc, getSegmentVector("map", path));
  return path.slice(1).reduce<Y.Map<any>>((m, k) => m.get(k), doc.getMap(path[0])) as Y.Map<V>;
}

/**
 * Ensure a deterministic Y.Array exists at the given path. Returns it.
 * Same as declareDeterministicMap but the leaf is a Y.Array.
 * All intermediate segments are still Y.Maps.
 */
export function declareDeterministicArray<V = any>(doc: Y.Doc, path: string[]): Y.Array<V> {
  if (path.length > 1) Y.applyUpdate(doc, getSegmentVector("array", path));
  return path.slice(1).reduce<any>((m, k) => m.get(k), doc.getMap(path[0])) as Y.Array<V>;
}
