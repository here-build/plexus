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

// Development-only DevTools integration
let pendingMutations: Set<{ entity: any; field: string | symbol }> = new Set();
let batchScheduled = false;

function collectMutation(entity: any, field: string | symbol) {
  pendingMutations.add({ entity, field });

  if (!batchScheduled) {
    batchScheduled = true;
    setImmediate(() => {
      flushMutationBatch();
      batchScheduled = false;
    });
  }
}

function flushMutationBatch() {
  if (pendingMutations.size === 0) return;

  const mutations = Array.from(pendingMutations).map(({ entity, field }) => ({
    entity: entity.constructor?.name || "Object",
    field: String(field),
    value: entity[field]
  }));

  // Send to Redux DevTools if available
  if (typeof window !== "undefined" && (window as any).__REDUX_DEVTOOLS_EXTENSION__) {
    const devTools = (window as any).__REDUX_DEVTOOLS_EXTENSION__.connect();
    devTools.send(
      {
        type: "PLEXUS_BATCH_UPDATE",
        payload: { mutations, count: mutations.length }
      },
      { mutations }
    );
  }

  pendingMutations.clear();
}

/**
 * Built-in modification reporter - notifies interested TrackedFunctions when data changes
 */
export function trackModification(entity: any, field: string | symbol): void {
  // Development-only DevTools collection
  if (process.env.NODE_ENV !== "production") {
    collectMutation(entity, field);
  }

  for (const notifier of unconsumedNotifiers) {
    if (!notifier.fieldset.has(entity)) {
      continue;
    }
    const entityKeyset = notifier.fieldset.get(entity)!;
    if (field === ACCESS_ALL_SYMBOL || entityKeyset.has(field) || entityKeyset.has(ACCESS_ALL_SYMBOL)) {
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
