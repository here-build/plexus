/**
 * Granular field-level tracking system built into plexus core
 *
 * ARCHITECTURE: Each createTrackedFunction creates its own Map<entity, Set<field>> via internal observeAccess.
 * When proxy handlers report entity access, they add the specific field to ALL currently active tracking maps.
 *
 * This design provides:
 * - Granular tracking: Track specific fields, not whole entities
 * - Concurrent-safe: Multiple React renders can track simultaneously
 * - Memory-safe: Maps clean up when their tracking functions complete
 * - Special access patterns: Symbols for "access all" operations
 * - Performant: Direct Map/Set operations, no complex state management
 * - Batched notifications: Multiple changes trigger only one callback per cycle
 *
 * Field Access Types:
 * - val: root entity + field access
 * - map: root entity + field access + keyset access + property access + "access all"
 * - list: root entity + field access + length access + index access + "access all"
 *
 * PUBLIC API:
 * - createTrackedFunction: Main API for React integration
 */

// Special symbols for tracking comprehensive access patterns
export const ACCESS_ALL_SYMBOL = Symbol("ACCESS_ALL");
export const ACCESS_INDICES_SET_SYMBOL = Symbol("ACCESS_INDICES_SET");

// Helper class for defaulted maps
class DefaultedMap<K, V> extends Map<K, V> {
  constructor(private defaultFn: () => V) {
    super();
  }

  get(key: K): V {
    if (!this.has(key)) {
      this.set(key, this.defaultFn());
    }
    return super.get(key)!;
  }
}

// Global list of active tracking maps - each createTrackedFunction adds its own Map during execution
const activeTrackingMaps: Set<DefaultedMap<any, Set<string | symbol>>> = new Set();

/**
 * Built-in access reporter that adds specific field access to ALL currently active tracking maps
 */
export function trackAccess(entity: any, field: string | symbol): void {
  for (const trackingMap of activeTrackingMaps) {
    const fieldSet = trackingMap.get(entity);
    if (field !== undefined) {
      fieldSet.add(field);
    } else {
      // For backwards compatibility when no field specified, track root entity access
      fieldSet.add("__root__");
    }
  }
}

/**
 * Built-in modification reporter that adds specific field modification to ALL currently active tracking maps
 */
export function trackModification(entity: any, field: string | symbol): void {
  for (const trackingMap of activeTrackingMaps) {
    const fieldSet = trackingMap.get(entity);
    if (field !== undefined) {
      fieldSet.add(field);
    } else {
      // For backwards compatibility when no field specified, track root entity access
      fieldSet.add("__root__");
    }
  }
}

/**
 * Track keyset access for maps (Object.keys, "in" operator, etc.)
 */
export function trackKeysetAccess(entity: any): void {
  trackAccess(entity, ACCESS_INDICES_SET_SYMBOL);
}

/**
 * Track length access for arrays/lists
 */
export function trackLengthAccess(entity: any): void {
  trackAccess(entity, ACCESS_INDICES_SET_SYMBOL);
}

/**
 * Check if any observation is currently active
 */
export function isObserving(): boolean {
  return activeTrackingMaps.size > 0;
}

/**
 * Internal function used by createTrackedFunction - not exposed in public API
 */
function observeAccess<T>(fn: () => T): [T, Map<any, Set<string | symbol>>] {
  const myTrackingMap = new DefaultedMap<any, Set<string | symbol>>(() => new Set());
  activeTrackingMaps.add(myTrackingMap);

  try {
    return [fn(), myTrackingMap];
  } finally {
    activeTrackingMaps.delete(myTrackingMap);
  }
}

// Global state for batched notifications
let pendingNotifications = new Set<() => void>();
let isNotificationScheduled = false;

function scheduleNotification() {
  if (isNotificationScheduled) return;

  isNotificationScheduled = true;

  // Schedule notification for next event loop tick
  queueMicrotask(() => {
    const callbacks = Array.from(pendingNotifications);
    pendingNotifications.clear();
    isNotificationScheduled = false;

    // Call all pending notifications
    for (const callback of callbacks) {
      callback();
    }
  });
}



/**
 * Create a tracked version of a function that notifies when access pattern changes
 *
 * This is perfect for React components - the notifyChanges callback will only be called
 * ONCE per execution cycle, even if multiple tracked functions detect changes.
 * This enables batched re-rendering for optimal performance.
 *
 * @param notifyChanges Callback to invoke when access pattern changes (batched)
 * @param fn Function to wrap with tracking
 * @returns Wrapped function that tracks access and compares between calls
 */
export function createTrackedFunction<Args extends readonly unknown[], Return>(
  notifyChanges: () => void,
  fn: (...args: Args) => Return
): (...args: Args) => Return {
  let lastAccessMap: Map<any, Set<string | symbol>> | null = null;

  return (...args: Args): Return => {
    // Track access during this execution
    const [result, currentAccessMap] = observeAccess(() => fn(...args));

    // Compare with previous access pattern
    if (lastAccessMap !== null && !accessMapsEqual(lastAccessMap, currentAccessMap)) {
      // The access pattern changed - schedule batched notification
      pendingNotifications.add(notifyChanges);
      scheduleNotification();
    }

    // Update last access for next comparison (deep copy)
    lastAccessMap = new Map();
    for (const [entity, fields] of currentAccessMap) {
      lastAccessMap.set(entity, new Set(fields));
    }

    return result;
  };
}

/**
 * Check if two access maps represent the same field access pattern
 */
function accessMapsEqual(
  map1: Map<any, Set<string | symbol>>,
  map2: Map<any, Set<string | symbol>>
): boolean {
  if (map1.size !== map2.size) {
    return false;
  }

  for (const [entity, fields1] of map1) {
    const fields2 = map2.get(entity);
    if (!fields2) {
      return false;
    }

    if (fields1.size !== fields2.size) {
      return false;
    }

    for (const field of fields1) {
      if (!fields2.has(field)) {
        return false;
      }
    }
  }

  return true;
}
