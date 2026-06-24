/**
 * Compile-time exhaustiveness for the materialized-collection proxies.
 *
 * Each proxy (typed-array / array / set / map) intercepts a built-in's methods
 * and must classify EVERY one — `readonly` (forward to the live value),
 * `mutating` (apply to a copy, then commit), `banned` (refuse with a door), or
 * `intercepted` (handled by a dedicated branch). Drop one and a mutation slips
 * through untracked.
 *
 * `MethodsOf<T>` is the set of function-valued keys of `T`. A proxy subtracts its
 * classified union from that set and feeds the remainder to `AssertNever`. A
 * non-empty remainder raises a compile error that NAMES the unclassified
 * method — which is exactly how the `Uint8Array` base64/hex methods were caught
 * the moment the TS lib added them.
 * Keeping the pattern uniform means a future built-in method (a new `Array` or
 * `Set` op) breaks the build instead of silently escaping a proxy's tracking.
 */

export type MethodsOf<T> = keyof { [K in keyof T as T[K] extends (...args: any[]) => any ? K : never]: K };

/** Errors at the use site unless `T` is `never`, surfacing leftovers in the message. */
export type AssertNever<T extends never> = T;
