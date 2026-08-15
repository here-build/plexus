/**
 * Field-level MobX tracking. Decorators and collection proxies call
 * {@link trackAccess} / {@link trackModification} on every field read and write.
 *
 * Minting is UNCONDITIONAL — there is no register step, no opt-out, and no
 * second reactive backend. A first read of an entity+field allocates a
 * `DefaultedMap` for the entity and an `IAtom` for the field, on every host
 * including ones that never observe anything. That cost buys the guarantee
 * that a value read anywhere is reactive without the caller arranging it;
 * an opt-in flag instead means a host that forgets it sees silently dead
 * reactivity rather than a slower one.
 *
 * Entity keys are held weakly, so atoms die with the entity.
 *
 * Field Access Types:
 * - val: root entity + field access
 * - map: root entity + field access + keyset access + property access + "access all"
 * - list: root entity + field access + length access + index access + "access all"
 */

import { DefaultedMap, DefaultedWeakMap } from "@here.build/collections";
import { createAtom, type IAtom } from "mobx";

import type { AllowedYJSMapKey } from "./proxy-runtime-types.js";
import { COLLECTION_ENTITY_TYPE, telemetry, TRACKER_KIND, type TrackerKindLabel } from "./telemetry.js";
import { flushNotifications, isTransacting, pendingNotifications } from "./utils/utils.js";

// Special symbols for tracking comprehensive access patterns
export const ACCESS_ALL_SYMBOL = Symbol("ACCESS_ALL");

/**
 * Semantic tracking symbols for collections (Set, Map, Array, Record)
 * Some cases require specific trigger conditions to avoid false-positives:
 * - KEYS_SYMBOL: Track key/index additions/removals. (has(), keys(), includes())
 * - VALUES_SYMBOL: Track value changes (get(), values(), at())
 * - ENTRIES_LENGTH_SYMBOL: Track length/size changes (size, length)
 *
 * Derivation rules:
 * - ENTRIES_LENGTH_SYMBOL fires when KEYS_SYMBOL fires (key add/remove changes length)
 * - ACCESS_ALL_SYMBOL fires on any change
 */

export const KEYS_SYMBOL = Symbol("KEYS");
export const VALUES_SYMBOL = Symbol("VALUES");
export const ENTRIES_LENGTH_SYMBOL = Symbol("ENTRIES_LENGTH");

export type Tracker = string | symbol | AllowedYJSMapKey;

let untracked = false;
/** @protected internal method to suppress tracking during specific operations */
export const __untracked__ = <T>(fn: () => T): T => {
  const wasUntracked = untracked;
  untracked = true;
  try {
    return fn();
  } finally {
    if (!wasUntracked) {
      untracked = false;
    }
  }
};

// ── Telemetry helpers ────────────────────────────────────────────────────
//
// Hot-path callers gate on `telemetry.enabled` before constructing the
// attributes object literal. When disabled, every emit reduces to a single
// property load + a branch — zero allocation, zero indirection.

/**
 * Map a tracker (string, symbol, or AllowedYJSMapKey) onto its low-
 * cardinality categorical label for telemetry attributes.
 */
function trackerKindOf(field: Tracker): TrackerKindLabel {
  switch (field) {
    case KEYS_SYMBOL:
      return TRACKER_KIND.KEYS;
    case VALUES_SYMBOL:
      return TRACKER_KIND.VALUES;
    case ENTRIES_LENGTH_SYMBOL:
      return TRACKER_KIND.ENTRIES_LENGTH;
    case ACCESS_ALL_SYMBOL:
      return TRACKER_KIND.ACCESS_ALL;
    default:
      return TRACKER_KIND.NAMED;
  }
}

/**
 * Duck-typed entity-type extraction without importing PlexusModel.
 *
 * Importing PlexusModel would cycle (PlexusModel.ts → tracking.ts →
 * PlexusModel.ts). Reading `entity.__type__` directly would recurse
 * through materialized-collection proxies' `get` handlers (which call
 * `trackAccess` again). The fix is to walk the prototype chain looking
 * for the `__type__` getter — `Object.getPrototypeOf` doesn't trigger
 * proxy `get` traps, and a proxy of a `Record<string, T>` has
 * `Object.prototype` as its target's prototype, not `PlexusModel.prototype`,
 * so the walk terminates without finding a getter and the proxy is
 * correctly labeled `_collection`.
 */
function entityTypeOf(entity: unknown): string {
  if (entity === null || typeof entity !== "object") return COLLECTION_ENTITY_TYPE;
  let proto: object | null = Object.getPrototypeOf(entity);
  while (proto && proto !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, "__type__");
    if (descriptor) {
      const getter = descriptor.get;
      if (typeof getter === "function") {
        try {
          const t = getter.call(entity);
          if (typeof t === "string") return t;
        } catch {
          // Fall through — entity is in a state that can't yield a type.
        }
      } else if (typeof descriptor.value === "string") {
        return descriptor.value;
      }
      break;
    }
    proto = Object.getPrototypeOf(proto);
  }
  return COLLECTION_ENTITY_TYPE;
}

const objectAllMap = new DefaultedWeakMap<object, IAtom>(() => createAtom(""));
const objectFieldMap = new DefaultedWeakMap<object, DefaultedMap<Tracker, IAtom>>(
  () => new DefaultedMap((key: Tracker) => createAtom(String(key))),
);

function reportAccess(entity: object, field: Tracker): void {
  const atom = field === ACCESS_ALL_SYMBOL ? objectAllMap.get(entity) : objectFieldMap.get(entity).get(field);
  atom.reportObserved();
}

function reportModification(entity: object, field: Tracker): void {
  if (field === ACCESS_ALL_SYMBOL) {
    objectAllMap.get(entity).reportChanged();
    for (const atom of objectFieldMap.get(entity).values()) {
      atom.reportChanged();
    }
  } else {
    if (objectAllMap.has(entity)) objectAllMap.get(entity).reportChanged();
    objectFieldMap.get(entity).get(field).reportChanged();
  }
}

/** Report a field access — MobX tracks the dependency on this entity+field atom. */
export function trackAccess(entity: any, field: Tracker): void {
  reportAccess(entity, field);
  if (telemetry.enabled) {
    telemetry.counter("plexus.tracking.access", {
      entity_type: entityTypeOf(entity),
      tracker_kind: trackerKindOf(field),
    });
  }
}

/** Report a field modification — MobX invalidates dependents of this entity+field atom. */
export function trackModification(entity: any, field: Tracker): void {
  if (untracked) {
    if (telemetry.enabled) {
      telemetry.counter("plexus.tracking.untracked_modification", {
        entity_type: entityTypeOf(entity),
        tracker_kind: trackerKindOf(field),
      });
    }
    return;
  }
  if (telemetry.enabled) {
    telemetry.counter("plexus.tracking.modification", {
      entity_type: entityTypeOf(entity),
      tracker_kind: trackerKindOf(field),
      batched: isTransacting ? "true" : "false",
    });
  }
  if (isTransacting) {
    pendingNotifications.add(() => {
      reportModification(entity, field);
    });
  } else {
    reportModification(entity, field);
  }
  if (!isTransacting) {
    flushNotifications();
  }
}
