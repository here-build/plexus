import { PlexusTypedArrayAliasError } from "../errors.js";
import { type PlexusModel } from "../PlexusModel.js";
import { bytesProxyRawSymbol } from "../proxy-runtime-types.js";
import { trackAccess, trackModification } from "../tracking.js";
import { maybeReference, maybeTransacting } from "../utils/utils.js";
import { type AssertNever, type MethodsOf } from "./method-classification.js";

/**
 * Write-focused proxy over a single `Uint8Array` val field.
 *
 * Bytes are just a special kind of primitive: this proxy IS the value stored in
 * the field's `backingStorage` slot (not a lazily-cached wrapper over a raw
 * mirror). It owns its bytes privately and is returned verbatim by the val
 * getter.
 *
 * Reactivity is ALL-OR-NOTHING on the whole buffer — the field is one atom,
 * `(owner, key)`, exactly like every other scalar val. There is no per-index or
 * per-value tracking: any read (index, iteration, length, read-only method)
 * depends on `(owner, key)`; any in-place write (index write, mutating method)
 * fires `(owner, key)`. So a reader of `blob[0]` wakes on a write to `blob[5]`,
 * and this holds identically for local and remote changes (the model's observer
 * fires the same `(owner, key)` atom on a remote byte change). Sub-buffer
 * granularity would be false precision: bytes are an opaque payload, revised as a
 * unit.
 *
 * Uint8Array is problematic to be represented in the right manner here due to the conflict of requirements.
 * It is quite tricky but feasible to guard the Uint8Array, but the underlying buffer is structurally impossible
 * to make guarded; so, we're relying here on a convention that user must treat ArrayBuffer returned by .buffer
 * as readonly, which is mildly enforced by types, yet potentially overridable.
 *
 * However, for storage we need to clone the value specifically instead of linking directly, as using
 * the typed array from the input as-is posess potential structural risks of uncontrolled divergence.
 * The isolating copy happens once at ingest (the val setter / materialization); this proxy then OWNS
 * that copy and mutates it via fresh arrays.
 *
 * Unlike the collection proxies (array/record/set/map), bytes are NOT entities:
 * there is no child-ownership, no adoption/orphanization, no reference/deref, no nested Y.Array.
 * So this proxy never touches the `Internals` struct — it holds the bytes and pushes fresh copies
 * straight to the scalar val at `owner.__yjsFieldsMap__.get(key)` on write.
 *
 * Every write produces a brand-new array.
 * yjs snapshots the buffer on transaction/sync (`new ContentBinary(new Uint8Array(c))`),
 * so mutating an array already handed to yjs in place would retro-corrupt committed items and undo history.
 * We never do that — every write replaces `bytes` with a fresh array before handing it to yjs.
 *
 * This is acknowledged as a typical tradeoff problem - we make individual updates significantly larger,
 * while preserving the crdt log length at a reasonable size. There may be better optimizations, but not for today.
 *
 * `instanceof Uint8Array` holds via a `getPrototypeOf` trap
 * (NOT a real Uint8Array target — a real one's non-configurable indexed slots trip Proxy
 * invariants the moment the trapped length differs from the target's).
 */


// `.slice()` on a Uint8Array returns a Uint8Array (a detached byte copy); the
// spread the rule prefers yields a `number[]` — the wrong type. The rule is
// inverted for this file.
/* eslint-disable unicorn/prefer-spread */

/**
 * Read-only TypedArray methods, forwarded to the live bytes.
 * The copy-returning ones (`slice`, `toReversed`, `toSorted`, `with`) double as the detach hatch:
 * `content.slice()` is a real, owned `Uint8Array` for native consumers (crypto/TextDecoder)
 * — no bespoke `toNative()` needed. `slice` COPIES
 * (unlike `subarray`, which views the shared buffer and is therefore banned).
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

export const buildTypedArrayProxy = (initial: Uint8Array, owner: PlexusModel, key: string): Uint8Array => {
  // A dependency entity is read-only and never reaches this proxy by construction
  // (the val getter guards `isDependency` upstream), so no guard is needed here.
  //
  // The proxy OWNS its bytes: `initial` is already an isolated copy (the ingest
  // site — the val setter / materialization — copies before wrapping), so no
  // further clone is needed here.
  let bytes = initial;

  // Commit a fresh array as the new value: replace the owned bytes, push a copy to
  // the scalar yjs attribute, and fire the field atom `(owner, key)` — all in ONE
  // transaction, mirroring the val setter (decorators.ts `set`). Reactivity is
  // all-or-nothing, so every in-place write funnels through here and wakes the
  // whole field.
  const commit = (next: Uint8Array): void => {
    maybeTransacting(owner.__doc__, () => {
      bytes = next;
      owner.__yjsFieldsMap__?.set(key, maybeReference(next, owner.__doc__!));
      trackModification(owner, key);
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
        // The serialization egress (`maybeReference`) unwraps to raw bytes here —
        // our `constructor` reads as `Uint8Array`, so a value check can't tell us
        // from a plain buffer.
        case prop === bytesProxyRawSymbol:
          return bytes;
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

      switch (true) {
        // Every read depends on the whole field atom `(owner, key)` — all-or-nothing.
        case prop === "length":
        case prop === "byteLength":
        case prop === "byteOffset":
        case prop === "BYTES_PER_ELEMENT":
          trackAccess(owner, key);
          return Reflect.get(bytes, prop);
        case prop === Symbol.iterator:
          trackAccess(owner, key);
          return bytes[Symbol.iterator].bind(bytes);
        case MUTATING_METHODS.has(prop):
          return (...args: unknown[]) => {
            // Read FRESH at call time (not at property-access time) so a retained
            // method reference can't apply against a stale snapshot.
            const next = bytes.slice();
            const result = next[prop](...args);
            commit(next); // fires `(owner, key)`
            // sort/reverse/fill/copyWithin return the array (→ the proxy);
            // `set` returns undefined.
            return result === next ? receiver : result;
          };
        case READ_ONLY_METHODS.has(prop):
          return (...args: unknown[]) => {
            trackAccess(owner, key);
            return bytes[prop](...args);
          };
      }

      // Numeric index read → depends on the whole field (all-or-nothing).
      if (typeof prop === "string") {
        const idx = Number(prop);
        if (Number.isInteger(idx) && idx >= 0) {
          trackAccess(owner, key);
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
          // No-op write (same byte) doesn't fire — mirrors the array proxy.
          if (bytes[idx] === numeric) return true;
          const next = bytes.slice();
          next[idx] = numeric;
          commit(next); // fires `(owner, key)`
          return true;
        }
      }
      // Reject non-index writes (e.g. `.length =`): a real Uint8Array's length is
      // a read-only accessor, so strict-mode assignment throws rather than no-op.
      return false;
    },
    has(_t, prop) {
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
      return Reflect.ownKeys(bytes);
    },
    getOwnPropertyDescriptor(_t, prop) {
      if (typeof prop === "string") {
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

/**
 * Ingest a raw (or already-proxied) byte value into the live write-through proxy
 * that a val field stores directly in `backingStorage`. Copies for isolation
 * (copy-on-set: a caller mutating the buffer they passed can't retro-corrupt our
 * state) and normalizes any subclass / proxy to a plain owned `Uint8Array`.
 */
export const wrapByteVal = (value: Uint8Array, owner: PlexusModel, key: string): Uint8Array => {
  const raw = (value as { [bytesProxyRawSymbol]?: Uint8Array })[bytesProxyRawSymbol] ?? value;
  return buildTypedArrayProxy(new Uint8Array(raw), owner, key);
};
