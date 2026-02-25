import invariant from "tiny-invariant";
import type * as Y from "yjs";

import { PlexusModel } from "../PlexusModel.js";
import type { AllowedYJSMapKey, AllowedYJSValue, AllowedYValue } from "../proxy-runtime-types.js";
import { referenceSymbol } from "../proxy-runtime-types.js";
import { deref } from "../deref.js";

const SET_PREFIX = "Set";
const ARRAY_PREFIX = "Array";
const VALUE_PREFIX = "Value";

const BIGINT_REGEX = /^-?\d+n$/;

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
    return; // Valid model reference
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

/**
 * Serialize a single value to a line.
 * - BigInt → "123n"
 * - Infinity/-Infinity/NaN → literal string
 * - PlexusModel → reference string
 * - Everything else → JSON
 */
function serializeValue(item: AllowedYJSValue, doc: Y.Doc): string {
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
 * Deserialize a single line back to a value.
 * - "123n" → BigInt
 * - "Infinity"/"-Infinity"/"NaN" → special number
 * - Otherwise → JSON.parse, then deref
 */
function deserializeValue(line: string, doc: Y.Doc): AllowedYJSValue {
  if (BIGINT_REGEX.test(line)) {
    return BigInt(line.slice(0, -1));
  }
  if (line === "NaN") return NaN;
  if (line === "Infinity") return Infinity;
  if (line === "-Infinity") return -Infinity;
  return deref(doc, JSON.parse(line) as AllowedYValue);
}

/**
 * Serialize a key to a string for Y.Map storage.
 * Format: Type\nValue1\nValue2\n...
 * Only called when writing to YJS, not for in-memory operations.
 */
export function serializeKey(key: AllowedYJSMapKey, doc: Y.Doc): string {
  if (key instanceof Set) {
    // Serialize first (materializes entities via [referenceSymbol]), then sort.
    // Serialized form is deterministic and cross-peer stable.
    const lines = [...key].map((item) => serializeValue(item, doc));
    lines.sort();
    return [SET_PREFIX, ...lines].join("\n");
  }
  if (Array.isArray(key)) {
    const lines = key.map((item) => serializeValue(item, doc));
    return [ARRAY_PREFIX, ...lines].join("\n");
  }
  return [VALUE_PREFIX, serializeValue(key, doc)].join("\n");
}

/**
 * Deserialize a key from Y.Map storage.
 * Used during materialization to rebuild PathMap from YJS.
 */
export function deserializeKey(serialized: string, doc: Y.Doc): AllowedYJSMapKey {
  const [prefix, ...lines] = serialized.split("\n");

  switch (prefix) {
    case SET_PREFIX:
      return new Set<AllowedYJSValue>(lines.map((line) => deserializeValue(line, doc)));
    case ARRAY_PREFIX:
      return lines.map((line) => deserializeValue(line, doc));
    case VALUE_PREFIX:
      invariant(lines.length === 1, `Value key must have exactly one line, got ${lines.length}`);
      return deserializeValue(lines[0], doc);
    default:
      throw new TypeError(`Invalid prefix ${prefix} for serialized map key`);
  }
}
