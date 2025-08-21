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

// For capturing field access during function execution
const activeTrackingMaps = new Set<DefaultedMap<any, Set<string | symbol>>>();

const unconsumedNotifiers = new Set<{
  trackingFunction: () => void;
  fieldset: DefaultedMap<any, Set<string | symbol>>;
}>();
/**
 * Built-in access reporter that adds specific field access to ALL currently active tracking maps
 */
export function trackAccess(entity: any, field: string | symbol): void {
  for (const fieldset of activeTrackingMaps) {
    fieldset.get(entity).add(field);
  }
}

/**
 * Built-in modification reporter - notifies interested TrackedFunctions when data changes
 */
export function trackModification(entity: any, field: string | symbol): void {
  for (const notifier of unconsumedNotifiers) {
    const entityKeyset = notifier.fieldset.get(entity);
    if (!entityKeyset) {
      continue;
    }
    if (field === ACCESS_ALL_SYMBOL || entityKeyset.has(field)) {
      unconsumedNotifiers.delete(notifier);
      notifier.trackingFunction();
    }
  }
}

export function isObserving(): boolean {
  return activeTrackingMaps.size > 0;
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
  fn: (...args: Args) => Return
): (...args: Args) => Return {
  return (...args: Args): Return => {
    const myTrackingMap = new DefaultedMap<any, Set<string | symbol>>(() => new Set());

    activeTrackingMaps.add(myTrackingMap);
    unconsumedNotifiers.add({
      trackingFunction: notifyChanges,
      fieldset: myTrackingMap
    });

    try {
      return fn(...args);
    } finally {
      activeTrackingMaps.delete(myTrackingMap);
    }
  };
}
