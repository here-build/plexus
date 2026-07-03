import invariant from "tiny-invariant";
import type * as Y from "yjs";

import { deref } from "../deref.js";
import { getInternals, PlexusModel } from "../PlexusModel.js";
import {
  type AllowedYJSKeyValue,
  type AllowedYJSMapKey,
  type AllowedYJSValue,
  type AllowedYValue,
  referenceSymbol,
} from "../proxy-runtime-types.js";
import { isTypedArray } from "../utils/utils.js";

const SET_PREFIX = "Set";
const ARRAY_PREFIX = "Array";
const VALUE_PREFIX = "Value";

const BIGINT_REGEX = /^-?\d+n$/;

// ── Local entity namer ──────────────────────────────────────────────
// Runtime-local incremental IDs for doc-free key serialization.
// Two canonical forms exist for PlexusModel references in map keys:
//   - local:  incremental integers (lazy, doc-free, O(n) resolution)
//   - global: CRDT UUIDs via Y.Doc (shared storage, O(1) resolution)
// They can be interchanged: local IDs are always valid within the
// current runtime; global IDs are valid across peers.

let serializationIdCounter = 0;
const entityToSerializationId = new WeakMap<PlexusModel, string>();
const serializationIdToEntity = new Map<string, WeakRef<PlexusModel>>();

function getOrCreateSerializationId(entity: PlexusModel): string {
  let id = entityToSerializationId.get(entity);
  if (!id) {
    id = `${serializationIdCounter++}`;
    entityToSerializationId.set(entity, id);
    serializationIdToEntity.set(id, new WeakRef(entity));
  }
  return id;
}

// ── Validation ──────────────────────────────────────────────────────

/**
 * Validate that a value is an allowed primitive type.
 * Throws TypeError for disallowed types.
 */
function validatePrimitive(item: unknown): void {
  const type = typeof item;
  if (type === "string" || type === "number" || type === "boolean" || type === "bigint" || item === null) {
    return; // Valid primitive
  }
  if (item instanceof PlexusModel) {
    return; // Valid model reference (UUID identity)
  }
  if (isTypedArray(item)) {
    // Bytes are content-shaped but object-identified — a fresh instance with equal
    // bytes is a different member in memory yet the same key in the CRDT, so they
    // can't be a stable set member / map key. Store bytes as a *value* instead.
    throw new TypeError(
      "Uint8Array is not allowed as a map key or set member in Plexus. " +
        "Keep bytes as a value (val field, or record/array/map value) and key by a name or id.",
    );
  }
  if (type === "undefined") {
    throw new TypeError("undefined is not allowed as a map key or value in Plexus");
  }
  if (type === "symbol") {
    throw new TypeError("Symbols are not allowed as map keys or values in Plexus");
  }
  if (type === "function") {
    throw new TypeError("Functions are not allowed as map keys or values in Plexus");
  }
  // Plain object
  throw new TypeError(
    `Plain objects are not allowed as map keys or values in Plexus. ` +
      `Use PlexusModel, Set, Array, or primitives instead. Got: ${Object.prototype.toString.call(item)}`,
  );
}

// ── Value serialization ─────────────────────────────────────────────

/**
 * Serialize a single value to a line (global canonical form).
 * PlexusModel → CRDT reference tuple via doc.
 */
function serializeValueGlobal(item: AllowedYJSValue, doc: Y.Doc): string {
  validatePrimitive(item);

  if (typeof item === "bigint") {
    return `${item}n`;
  }
  if (typeof item === "number") {
    if (Number.isNaN(item)) return "NaN";
    if (item === Infinity) return "Infinity";
    if (item === -Infinity) return "-Infinity";
  }
  if (item instanceof PlexusModel) {
    return JSON.stringify(item[referenceSymbol](doc));
  }
  return JSON.stringify(item);
}

/**
 * Serialize a single value to a line (local canonical form).
 * PlexusModel → local incremental ID, no doc needed.
 */
function serializeValueLocal(item: AllowedYJSValue): string {
  validatePrimitive(item);

  if (typeof item === "bigint") {
    return `${item}n`;
  }
  if (typeof item === "number") {
    if (Number.isNaN(item)) return "NaN";
    if (item === Infinity) return "Infinity";
    if (item === -Infinity) return "-Infinity";
  }
  if (item instanceof PlexusModel) {
    return JSON.stringify([getOrCreateSerializationId(item)]);
  }
  return JSON.stringify(item);
}

// ── Value deserialization ───────────────────────────────────────────

/**
 * Deserialize a single line back to a value.
 * Tries local resolution first (for local IDs), then doc-based (for CRDT UUIDs).
 * Returns null for unresolvable entity references.
 */
function deserializeValueFlexible(line: string, doc: Y.Doc | null): AllowedYJSKeyValue {
  if (BIGINT_REGEX.test(line)) {
    return BigInt(line.slice(0, -1));
  }
  if (line === "NaN") return Number.NaN;
  if (line === "Infinity") return Infinity;
  if (line === "-Infinity") return -Infinity;

  const parsed = JSON.parse(line);

  // Check if it's a reference tuple: [id] or [id, docId]
  if (Array.isArray(parsed) && parsed.length > 0 && parsed.length <= 2 && typeof parsed[0] === "string") {
    // Try local resolution first
    const localEntity = serializationIdToEntity.get(parsed[0])?.deref();
    if (localEntity) return localEntity;
    // Fall back to doc-based resolution
    if (doc) return deref(doc, parsed as AllowedYValue);
    // Can't resolve
    return null as unknown as AllowedYJSKeyValue;
  }

  return parsed;
}

// ── Key serialization (public API) ──────────────────────────────────

function serializeKeyWith(sv: (item: AllowedYJSValue) => string, key: AllowedYJSMapKey): string {
  if (key instanceof Set) {
    // Serialize first (materializes entities in global mode), then sort.
    // Serialized form is deterministic and cross-peer stable.
    const lines = [...key].map(sv);
    lines.sort();
    return [SET_PREFIX, ...lines].join("\n");
  }
  if (Array.isArray(key)) {
    const lines = key.map(sv);
    return [ARRAY_PREFIX, ...lines].join("\n");
  }
  return [VALUE_PREFIX, sv(key)].join("\n");
}

/**
 * Serialize a key to a string for storage.
 * Format: Type\nValue1\nValue2\n...
 *
 * When doc is available, uses global canonical form (CRDT UUIDs).
 * When doc is null, uses local canonical form (incremental IDs).
 */
export function serializeKey(key: AllowedYJSMapKey, doc: Y.Doc | null = null): string {
  const sv = doc ? (item: AllowedYJSValue) => serializeValueGlobal(item, doc) : serializeValueLocal;
  return serializeKeyWith(sv, key);
}

/** An entity serializes globally without genesis iff it is already doc-backed. */
function hasGlobalIdentity(item: PlexusModel): boolean {
  const internals = getInternals(item);
  if (internals.isDependency) return true;
  return Boolean(internals.yjsModel);
}

/**
 * Serialize a key WITHOUT doc side effects — the statement-time form.
 *
 * `serializeKey` with a doc MATERIALIZES fresh entities (genesis is a doc
 * write). Deferred-region statements must not do doc work — the region may
 * roll back, and genesis belongs to flush phase 1 with its own origin. So
 * each entity serializes in the form it ALREADY has: global (a pure read of
 * its reference tuple) when doc-backed, local (incremental id) when fresh.
 * Both forms deserialize via `deserializeKey`, and each is stable per entity
 * across a single-doc region; the flush re-serializes in global form.
 */
export function serializeKeyNonMinting(key: AllowedYJSMapKey, doc: Y.Doc | null): string {
  if (!doc) return serializeKey(key, null);
  const sv = (item: AllowedYJSValue) =>
    item instanceof PlexusModel && !hasGlobalIdentity(item)
      ? serializeValueLocal(item)
      : serializeValueGlobal(item, doc);
  return serializeKeyWith(sv, key);
}

/**
 * Materialize every entity inside a key onto `doc` — the flush-phase-1 twin
 * of `serializeKeyNonMinting`: key genesis happens here, OUTSIDE the flush
 * transaction, so flush-time `serializeKey(key, doc)` is a pure read.
 */
export function materializeKeyEntities(key: AllowedYJSMapKey, doc: Y.Doc): void {
  const visit = (item: AllowedYJSValue): void => {
    if (item instanceof PlexusModel) item[referenceSymbol](doc);
  };
  if (key instanceof Set) {
    for (const item of key) visit(item);
  } else if (Array.isArray(key)) {
    for (const item of key) visit(item);
  } else {
    visit(key);
  }
}

/**
 * Deserialize a key from storage.
 *
 * Tries local resolution first (local IDs via WeakRef),
 * then doc-based resolution (CRDT UUIDs). Returns null for
 * unresolvable entity references.
 */
export function deserializeKey(serialized: string, doc: Y.Doc | null = null): AllowedYJSMapKey {
  const [prefix, ...lines] = serialized.split("\n");

  const dv = (line: string) => deserializeValueFlexible(line, doc);

  switch (prefix) {
    case SET_PREFIX:
      return new Set<AllowedYJSKeyValue>(lines.map(dv));
    case ARRAY_PREFIX:
      return lines.map(dv);
    case VALUE_PREFIX:
      invariant(lines.length === 1, `Value key must have exactly one line, got ${lines.length}`);
      return dv(lines[0]);
    default:
      throw new TypeError(`Invalid prefix ${prefix} for serialized map key`);
  }
}
