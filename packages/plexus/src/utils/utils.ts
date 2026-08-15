import type * as Y from "yjs";

import { PlexusModel } from "../PlexusModel.js";
import type { AllowedYJSValue, AllowedYValue, ReferenceTuple } from "../proxy-runtime-types.js";
import { bytesProxyRawSymbol, referenceSymbol } from "../proxy-runtime-types.js";

// The transaction primitive layer lives in `transacting.ts` — a runtime LEAF
// the deferred-buffer engine imports directly (see the layering note there).
// Re-exported here so consumers keep one import surface; the bindings stay
// live (`isTransacting` mutates inside transacting.ts).
export {
  flushNotifications,
  isTransacting,
  markEntityCreated,
  maybeTransacting,
  pendingNotifications,
  transactionObserverHook,
} from "./transacting.js";

export function never(value: never): never {
  throw new Error(`Unexpected value: ${value}`);
}

// Tuple reference helpers
export const isTupleReference = (val: any): val is ReferenceTuple =>
  Array.isArray(val) && val.length > 0 && val.length <= 2 && typeof val[0] === "string";

/**
 * Normalize a `Uint8Array`-like to the exact shape the CRDT layer stores. yjs's
 * `typeMapSet` switches on an EXACT `value.constructor`, so a subclass — most
 * often a Node `Buffer`, which isomorphic-git and friends hand in — is an
 * `instanceof Uint8Array` yet fails that switch ("Unexpected content type"). Copy
 * any non-plain Uint8Array into a plain one; a plain Uint8Array (the common case)
 * passes through untouched.
 *
 * A byte val reads back as a live write-through proxy (see `buildTypedArrayProxy`)
 * whose `constructor` reports `Uint8Array`, so the exact-ctor check would wrongly
 * pass it through. The brand unwraps it to its owned raw bytes first — yjs copies
 * on transaction, so handing the live array is safe.
 */
const toStorableBytes = (val: Uint8Array): Uint8Array => {
  const raw = (val as { [bytesProxyRawSymbol]?: Uint8Array })[bytesProxyRawSymbol];
  if (raw) return raw;
  return val.constructor === Uint8Array ? val : new Uint8Array(val);
};

/**
 * The single recognition predicate for "this value is a byte buffer plexus stores
 * as a scalar val". Uint8Array is the one typed array plexus admits (see
 * `AllowedPrimitive`); subclasses (a Node `Buffer`) count as bytes here — the
 * `instanceof` check is deliberately looser than `toStorableBytes`'s exact-ctor
 * normalization, which is a downstream storage detail, not recognition.
 */
export const isTypedArray = (val: unknown): val is Uint8Array => val instanceof Uint8Array;

export const maybeReference = (val: AllowedYJSValue, doc: Y.Doc): AllowedYValue => {
  if (val instanceof PlexusModel) return val[referenceSymbol](doc) ?? null;
  if (isTypedArray(val)) return toStorableBytes(val);
  return val ?? null;
};

export const curryMaybeReference =
  (doc: Y.Doc) =>
  (val: AllowedYJSValue): AllowedYValue =>
    maybeReference(val, doc);
