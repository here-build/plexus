import { PlexusDependencyError, PlexusTypedArrayAliasError } from "../errors.js";
import { getInternals, type PlexusModel } from "../PlexusModel.js";
import {
  ACCESS_ALL_SYMBOL,
  ENTRIES_LENGTH_SYMBOL,
  trackAccess,
  trackModification,
  VALUES_SYMBOL,
} from "../tracking.js";
import { type AssertNever, type MethodsOf } from "./method-classification.js";
import { maybeReference, maybeTransacting } from "../utils/utils.js";

// `.slice()` on a Uint8Array returns a Uint8Array (a detached byte copy); the
// spread the rule prefers yields a `number[]` — the wrong type. The rule is
// inverted for this file.
/* eslint-disable unicorn/prefer-spread */

/**
 * Write-focused proxy over a single `Uint8Array` val field.
 *
 * Unlike the collection proxies (array/record/set/map), bytes are NOT entities:
 * there is no child-ownership, no adoption/orphanization, no reference/deref, no
 * nested Y.Array. The backing is the lone scalar val stored at
 * `owner.__yjsFieldsMap__.get(key)` (a yjs `ContentBinary` Uint8Array), mirrored
 * in `internals.backingStorage` and kept live by the *model-level* observer
 * PlexusModel installs at bootstrap (a remote attribute change refreshes
 * `backingStorage.set(key, …)` — so a scalar val needs no observer of its own,
 * see `currentBytes`).
 *
 * Every write produces a brand-new array. yjs snapshots the buffer on
 * transaction/sync (`new ContentBinary(new Uint8Array(c))`), so mutating an
 * array already handed to yjs in place would retro-corrupt committed items and
 * undo history. We never do that — `writeBytes` always stores a fresh array.
 *
 * `instanceof Uint8Array` holds via a `getPrototypeOf` trap (NOT a real
 * Uint8Array target — a real one's non-configurable indexed slots trip Proxy
 * invariants the moment the trapped length differs from the target's).
 */

export type MaterializedTypedArrayProxyInitTarget = {
  owner: PlexusModel;
  key: string;
};

/**
 * Read-only TypedArray methods, forwarded to the live bytes. The copy-returning
 * ones (`slice`, `toReversed`, `toSorted`, `with`) double as the detach hatch:
 * `content.slice()` is a real, owned `Uint8Array` for native consumers
 * (crypto/TextDecoder) — no bespoke `toNative()` needed. `slice` COPIES (unlike
 * `subarray`, which views the shared buffer and is therefore banned).
 */
const UINT8ARRAY_METHODS = {
  /**
   * Read-only methods, forwarded to the live bytes. The copy-returning ones
   * (`slice`, `toReversed`, `toSorted`, `with`, `toBase64`, `toHex`) double as
   * the detach hatch: `content.slice()` is a real, owned `Uint8Array` for native
   * consumers (crypto/TextDecoder) — no bespoke `toNative()` needed.
   */
  readonly: [
    "at",
    "entries",
    "every",
    "filter",
    "find",
    "findIndex",
    "findLast",
    "findLastIndex",
    "forEach",
    "includes",
    "indexOf",
    "join",
    "keys",
    "lastIndexOf",
    "map",
    "reduce",
    "reduceRight",
    "slice",
    "some",
    "toBase64",
    "toHex",
    "toLocaleString",
    "toReversed",
    "toSorted",
    "toString",
    "values",
    "with",
  ],
  /** Mutating methods — applied to a fresh copy, then committed (so writes sync). */
  mutating: ["set", "fill", "copyWithin", "sort", "reverse", "setFromBase64", "setFromHex"],
  /**
   * Aliasing escapes that would leak a live view onto the tracked buffer — banned.
   * `subarray` returns a view; `.buffer` exposes the raw ArrayBuffer (handled
   * separately below). Use `slice()` for a detached copy instead.
   */
  banned: ["subarray"],
  /**
   * Handled by dedicated get-trap branches, not the dispatch tables — listed
   * only so the exhaustiveness check below stays total. `Symbol.iterator` yields
   * immutable byte values; `valueOf` returns the proxy (`this`), never raw bytes.
   */
  intercepted: [Symbol.iterator, "valueOf"],
} as const satisfies Record<string, ReadonlyArray<MethodsOf<Uint8Array>>>;

// Compile error if any Uint8Array method is left unclassified — the safety net
// that flagged the base64/hex methods the moment the TS lib introduced them.
type _Exhaustive = AssertNever<
  Exclude<MethodsOf<Uint8Array>, (typeof UINT8ARRAY_METHODS)[keyof typeof UINT8ARRAY_METHODS][number]>
>;

const READ_ONLY_METHODS = new Set<string | symbol>(UINT8ARRAY_METHODS.readonly);
const MUTATING_METHODS = new Set<string | symbol>(UINT8ARRAY_METHODS.mutating);
const BANNED = new Set<string | symbol>(UINT8ARRAY_METHODS.banned);

export const buildTypedArrayProxy = ({ owner, key }: MaterializedTypedArrayProxyInitTarget): Uint8Array => {
  const internals = getInternals(owner);
  // A dependency entity is read-only and never reaches this proxy by construction
  // (the val getter guards `isDependency` upstream); a typed loud throw if it does.
  PlexusDependencyError.invariant(!internals.isDependency, owner, "accessed");

  /**
   * The live stored bytes. Reads from `backingStorage` (the model observer keeps
   * it in sync with remote changes — a scalar val is a plain XmlElement
   * attribute, caught by `PlexusModel`'s own `element.observe`). Falls back to an
   * empty array when the field is currently null/absent so reads never throw.
   */
  const currentBytes = (): Uint8Array => {
    const stored = internals.backingStorage.get(key) as unknown;
    return stored instanceof Uint8Array ? stored : new Uint8Array(0);
  };

  /**
   * Commit a fresh array as the new field value. Mirrors the val `set()` helper
   * but does NOT fire the field-key tracker (`owner`+`key`): that key means
   * "the whole field was reassigned" and is fired by the decorator `set` helper.
   * In-place mutations fire granular `self`+symbol trackers at the call site, so
   * a `content[1]` write never wakes a `content[0]` reader (see mobx/index.ts).
   */
  const writeBytes = (next: Uint8Array): void => {
    maybeTransacting(owner.__doc__, () => {
      // Same write path as the val `set()` helper: raw into backingStorage, and
      // `maybeReference` into the yjs attribute (identity for bytes, since a
      // Uint8Array isn't a PlexusModel — kept for canonical-path fidelity). yjs
      // preserves the instance on local read-back, so the model observer's
      // `newValue !== oldValue` guard no-ops and never double-fires owner+key.
      internals.backingStorage.set(key, next);
      owner.__yjsFieldsMap__?.set(key, maybeReference(next, owner.__doc__!));
    });
  };

  // Plain extensible target — NOT a real Uint8Array (its non-configurable
  // indexed slots would trip Proxy invariants when the trapped length changes).
  const target: Record<string | symbol, unknown> = {};

  const self = new Proxy(target, {
    getPrototypeOf() {
      // Makes `proxy instanceof Uint8Array` true and method-lookups inherit
      // from the real prototype where we don't trap them.
      return Uint8Array.prototype;
    },
    get(_t, prop, receiver) {
      switch (true) {
        // Aliasing escapes — refuse with a door that routes to `.slice()`.
        case BANNED.has(prop):
          return () => {
            throw new PlexusTypedArrayAliasError(owner, key, String(prop));
          };
        // `.buffer` would expose the underlying ArrayBuffer (a live aliasing view).
        case prop === "buffer":
          throw new PlexusTypedArrayAliasError(owner, key, "buffer");
        // valueOf returns `this` — the proxy (guarded), never the raw tracked bytes.
        case prop === "valueOf":
          return () => receiver;
        case prop === Symbol.toStringTag:
          return "Uint8Array";
      }

      const bytes = currentBytes();
      switch (true) {
        // length/size reads depend on structure, not values.
        case prop === "length":
        case prop === "byteLength":
        case prop === "byteOffset":
        case prop === "BYTES_PER_ELEMENT":
          trackAccess(owner, key);
          trackAccess(self, ENTRIES_LENGTH_SYMBOL);
          return Reflect.get(bytes, prop);
        case prop === Symbol.iterator:
          // Iterating reads every value → depend on VALUES.
          trackAccess(owner, key);
          trackAccess(self, VALUES_SYMBOL);
          return bytes[Symbol.iterator].bind(bytes);
        case MUTATING_METHODS.has(prop):
          return (...args: unknown[]) => {
            // Read FRESH at call time (not at property-access time) so a retained
            // method reference can't apply against a stale snapshot.
            const next = bytes.slice();
            const result = next[prop](...args);
            writeBytes(next);
            // Bulk change → ACCESS_ALL wakes per-index and whole-value readers alike.
            trackModification(self, ACCESS_ALL_SYMBOL);
            // sort/reverse/fill/copyWithin return the array (→ the proxy);
            // `set` returns undefined.
            return result === next ? receiver : result;
          };
        case READ_ONLY_METHODS.has(prop):
          return (...args: unknown[]) => {
            trackAccess(owner, key);
            trackAccess(self, VALUES_SYMBOL);
            return bytes[prop](...args);
          };
      }

      // Numeric index read → depend on just that index.
      if (typeof prop === "string") {
        const idx = Number(prop);
        if (Number.isInteger(idx) && idx >= 0) {
          trackAccess(owner, key);
          trackAccess(self, String(idx));
          return bytes[idx];
        }
      }

      // Anything else inherited from Uint8Array.prototype (constructor, etc.).
      return Reflect.get(Uint8Array.prototype, prop, bytes);
    },
    set(_t, prop, value) {
      // Numeric index write → commit a mutated copy.
      if (typeof prop === "string") {
        const idx = Number(prop);
        if (Number.isInteger(idx) && idx >= 0) {
          // `& 0xff` faithfully matches a real Uint8Array's ToUint8 coercion
          // (truncate + mod 256; NaN → 0).
          const numeric = Number(value) & 0xff;
          const bytes = currentBytes();
          // No-op write (same byte) doesn't fire — mirrors the array proxy.
          if (bytes[idx] === numeric) return true;
          const next = bytes.slice();
          next[idx] = numeric;
          writeBytes(next);
          // The specific index, plus VALUES for whole-value (iterator) readers.
          trackModification(self, String(idx));
          trackModification(self, VALUES_SYMBOL);
          return true;
        }
      }
      // Reject non-index writes (e.g. `.length =`): a real Uint8Array's length is
      // a read-only accessor, so strict-mode assignment throws rather than no-op.
      return false;
    },
    has(_t, prop) {
      const bytes = currentBytes();
      if (typeof prop === "string") {
        const idx = Number(prop);
        if (Number.isInteger(idx) && idx >= 0) {
          return idx < bytes.length;
        }
      }
      return Reflect.has(bytes, prop);
    },
    ownKeys() {
      // Mirror a real Uint8Array: own keys are exactly the indices (NOT
      // `length` — that's an inherited prototype getter). All reported keys must
      // be `configurable: true` here (the target is the extensible `{}`), or the
      // getOwnPropertyDescriptor invariant throws.
      const bytes = currentBytes();
      return Reflect.ownKeys(bytes);
    },
    getOwnPropertyDescriptor(_t, prop) {
      if (typeof prop === "string") {
        const bytes = currentBytes();
        const idx = Number(prop);
        if (Number.isInteger(idx) && idx >= 0 && idx < bytes.length) {
          // configurable: true is REQUIRED — the property isn't on the real
          // target, and a non-configurable report would trip the Proxy invariant.
          return { value: bytes[idx], writable: true, enumerable: true, configurable: true };
        }
      }
      // `length` (and everything else) has no OWN descriptor on a Uint8Array —
      // it's resolved through the prototype. Returning undefined keeps
      // Object.keys / spread / getOwnPropertyDescriptor invariant-safe.
      return undefined;
    },
    defineProperty() {
      return false;
    },
    deleteProperty() {
      return false;
    },
    setPrototypeOf() {
      return false;
    },
  });

  return self as unknown as Uint8Array;
};
