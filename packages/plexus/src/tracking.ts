/**
 * Granular field-level tracking system built into plexus core
 *
 * ARCHITECTURE: WeakSet-based change notification system.
 * Functions register interest in specific fields, get notified when those fields change.
 *
 * This design provides:
 * - Change-based notifications: Notify when accessed data changes, not access patterns
 * - Granular tracking: Track specific fields, not whole entities
 * - Automatic cleanup: WeakSet auto-removes dead TrackedFunctions
 * - Batched notifications: Multiple changes trigger only one callback per cycle
 * - Memory-safe: WeakMap/WeakSet prevent memory leaks
 * - Performance: Direct field lookups, bounded iteration over active functions
 *
 * Field Access Types:
 * - val: root entity + field access
 * - map: root entity + field access + keyset access + property access + "access all"
 * - list: root entity + field access + length access + index access + "access all"
 *
 * PUBLIC API:
 * - createTrackedFunction: Main API for React integration
 */

import type { AllowedYJSMapKey } from "./proxy-runtime-types.js"; // Special symbols for tracking comprehensive access patterns
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

// Helper class for defaulted maps
class DefaultedMap<K, V> extends Map<K, V> {
  constructor(private readonly defaultFn: () => V) {
    super();
  }

  get(key: K): V {
    if (!this.has(key)) {
      this.set(key, this.defaultFn());
    }
    return super.get(key)!;
  }
}

// For capturing field access during function execution
const activeTrackingMaps = new Set<DefaultedMap<any, Set<Tracker>>>();

const unconsumedNotifiers = new Set<{
  trackingFunction: () => void;
  fieldset: DefaultedMap<any, Set<Tracker>>;
}>();

let untracked = false;
/** @protected this is internal metod to do some magic and should not be used outside explicitly */
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

type TrackingHook = {
  access?: (entity: any, field: Tracker) => void;
  modification?: (entity: any, field: Tracker) => void;
};

export const trackingHook: TrackingHook = {};

/**
 * Built-in access reporter that adds specific field access to ALL currently active tracking maps
 */
export function trackAccess(entity: any, field: Tracker): void {
  for (const fieldset of activeTrackingMaps) {
    fieldset.get(entity).add(field);
  }
  trackingHook.access?.(entity, field);
}

/**
 * Built-in modification reporter - notifies interested TrackedFunctions when data changes
 */
export function trackModification(entity: any, field: Tracker): void {
  if (untracked) {
    return;
  }
  for (const notifier of unconsumedNotifiers) {
    if (!notifier.fieldset.has(entity)) {
      continue;
    }
    if (field !== ACCESS_ALL_SYMBOL) {
      const entityKeyset = notifier.fieldset.get(entity)!;
      if (!entityKeyset.has(field) && !entityKeyset.has(ACCESS_ALL_SYMBOL)) {
        continue;
      }
    }
    unconsumedNotifiers.delete(notifier);
    pendingNotifications.add(notifier.trackingFunction);
  }
  if (trackingHook.modification) {
    if (isTransacting) {
      pendingNotifications.add(() => {
        trackingHook.modification!(entity, field);
      });
    } else {
      trackingHook.modification(entity, field);
    }
  }
  if (!isTransacting) {
    flushNotifications();
  }
}

/**
 * Create a tracked version of a function that notifies when accessed data changes
 *
 * This is perfect for React components - the notifyChanges callback will only be called
 * ONCE per execution cycle when data accessed by this function is modified.
 * This enables batched re-rendering for optimal performance.
 *
 * @param notifyChanges Callback to invoke when accessed data changes (batched)
 * @param fn Function to wrap with tracking
 * @returns Wrapped function that tracks access and registers for change notifications
 */
export function createTrackedFunction<Args extends readonly unknown[], Return>(
  notifyChanges: () => void,
  fn: (...args: Args) => Return,
): (...args: Args) => Return {
  return (...args: Args): Return => {
    const myTrackingMap = new DefaultedMap<any, Set<string | symbol>>(() => new Set());

    activeTrackingMaps.add(myTrackingMap);
    let executed = false;
    let triggered = false;
    unconsumedNotifiers.add({
      trackingFunction: () => {
        if (executed) {
          activeTrackingMaps.delete(myTrackingMap);
          notifyChanges();
        } else {
          triggered = true;
        }
      },
      fieldset: myTrackingMap,
    });

    try {
      return fn(...args);
    } finally {
      executed = true;
      // activeTrackingMaps cleanup should be placed BEFORE notifyChanges to avoid recursion
      activeTrackingMaps.delete(myTrackingMap);
      if (triggered) {
        notifyChanges();
      }
    }
  };
}
