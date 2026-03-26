/**
 * Genesis Client IDs — deterministic, content-addressed CRDT scaffold identities.
 *
 * Like EVM CREATE2: the identity of a scaffold element (type sub-map, meta entry, etc.)
 * is a pure function of its semantic position, not of which client created it.
 * Two independent clients producing the same scaffold get the same Yjs Items —
 * sync becomes a no-op instead of an LWW conflict.
 *
 * Layout: integer in (MAX_UINT32, MAX_SAFE_INTEGER] — structurally above the uint32 range
 * that Yjs uses for real clientIds (crypto.getRandomValues on Uint32Array). Collision with
 * a regular Yjs client is impossible, not probabilistic.
 *
 * Two murmur32 hashes (different seeds) are combined into a ~53-bit value, then mapped
 * into the genesis range via modulo. ~9×10^15 possible values — birthday collision among
 * entity types is negligible (~10^-13 for 100 types).
 *
 * Unidirectional: we never decode back to (type, path).
 * In the worst case, inspect op 0 on that clientId in the struct store — it's self-describing.
 */

import * as Y from "yjs";

import { murmur32 } from "./crdt-uuid.js";

/** Yjs clientIds are uint32: [0, 0xFFFFFFFF]. Genesis lives above this. */
const MAX_UINT32 = 0xff_ff_ff_ff;

/** Number of integers in (MAX_UINT32, MAX_SAFE_INTEGER]. */
const GENESIS_RANGE = Number.MAX_SAFE_INTEGER - MAX_UINT32;

/** Hash seeds — "GEN" and "SIS" in hex-ish */
const SEED_HI = 0x47_45_4e;
const SEED_LO = 0x53_49_53;

/**
 * Compute a deterministic genesis clientId for a scaffold element.
 *
 * Produces a value in (MAX_UINT32, MAX_SAFE_INTEGER] — above all possible
 * Yjs uint32 clientIds, safe for JS float64 arithmetic.
 */
export function genesisClientId(type: string, path: string[]): number {
  const canonical = `${type}\0${path.join("\0")}`;
  const hi = murmur32(canonical, SEED_HI);
  const lo = murmur32(canonical, SEED_LO);
  // Combine two 32-bit hashes into a ~53-bit value.
  // (hi & 0x1FFFFF) keeps 21 bits; * 0x100000000 shifts left 32; + lo fills lower 32.
  // Maximum: (2^21 - 1) * 2^32 + (2^32 - 1) = 2^53 - 1 = MAX_SAFE_INTEGER.
  // Note: bitwise ops truncate to 32 bits, so we use arithmetic (& is safe for 21-bit mask).
  const wide = (hi & 0x1f_ff_ff) * 0x1_00_00_00_00 + (lo >>> 0);
  return (wide % GENESIS_RANGE) + MAX_UINT32 + 1;
}

// ── High-level deterministic scaffold API ──
//
// Each path segment is produced as a separate update vector from its own
// temporary doc. One doc per Item — no cross-contamination between segments.
//
// Applied via Y.applyUpdate → remote change → invisible to UndoManager.
// Idempotent: if the element already exists, returns it immediately.

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
