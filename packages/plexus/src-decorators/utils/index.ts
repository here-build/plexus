import * as Y from "yjs";
import {
  AllowedYJSValue,
  AllowedYValue,
  isProxyEntity,
  ModelType,
  referenceSymbol,
  ReferenceTuple
} from "../proxy-runtime-types";
import { PlexusModel } from "../PlexusModel";

// Simple default implementations for missing dependencies
export class DefaultedMap<K, V> extends Map<K, V> {
  constructor(private factory: (key: K) => V) {
    super();
  }

  get(key: K): V {
    if (!super.has(key)) {
      super.set(key, this.factory(key));
    }
    return super.get(key)!;
  }
}

export class DefaultedWeakMap<K extends object, V> extends WeakMap<K, V> {
  constructor(private factory: (key: K) => V) {
    super();
  }

  get(key: K): V {
    if (!super.has(key)) {
      super.set(key, this.factory(key));
    }
    return super.get(key)!;
  }
}

export function never(value: never): never {
  debugger;
  throw new Error(`Unexpected value: ${value}`);
}

export const isModelType = (object: any): object is ModelType<{}, string> => object?.[isProxyEntity] as boolean;

const isModel = (val: any): val is PlexusModel => val && val instanceof PlexusModel;

// Tuple reference helpers
export const isTupleReference = (val: any): val is ReferenceTuple =>
  Array.isArray(val) && val.length >= 1 && val.length <= 2 && typeof val[0] === "string";

export const definitelyReference = (val: PlexusModel, doc: Y.Doc): AllowedYValue => val[referenceSymbol](doc);

export const maybeReference = (val: AllowedYJSValue, doc: Y.Doc): AllowedYValue =>
  (isModel(val) ? val?.[referenceSymbol]?.(doc) : val) ?? null;

export const curryMaybeReference =
  (doc: Y.Doc) =>
  (val: AllowedYJSValue): AllowedYValue =>
    (isModel(val) ? val[referenceSymbol](doc) : val) ?? null;

// doc transactions are rather expensive, even nested ones, and it's better to track them across the call chain efficiently
// plus it will avoid transaction events for mid-transaction stuff
const docInTransactionMotion = new WeakSet();

// Notification batching state
export let isTransacting = false;
export const pendingNotifications: Set<() => void> = new Set();

const flushNotifications = () => {
  const toNotify = new Set(pendingNotifications);
  pendingNotifications.clear();

  // Wrap in try-catch to prevent notification errors from propagating
  toNotify.forEach((notify) => {
    try {
      notify();
    } catch (e) {
      // Log but don't propagate notification errors
      console.error("Error in notification callback:", e);
    }
  });
};

export const maybeTransacting = <T>(doc: Y.Doc | null | undefined, fn: () => T): T => {
  if (!doc) {
    if (isTransacting) {
      return fn();
    } else {
      isTransacting = true;
      try {
        return fn();
      } finally {
        isTransacting = false;
        flushNotifications();
      }
    }
  }
  const isNestedTransaction = !doc || docInTransactionMotion.has(doc);
  const wasAlreadyTransacting = isTransacting;

  if (isNestedTransaction) {
    // Shadow transaction - just execute
    return fn();
  }

  try {
    docInTransactionMotion.add(doc);

    // Set transacting flag for outermost transaction
    if (!wasAlreadyTransacting) {
      isTransacting = true;
    }

    let result: T;
    if (doc) {
      result = doc.transact(fn);
    } else {
      result = fn();
    }

    if (!wasAlreadyTransacting) {
      flushNotifications();
    }

    return result;
  } catch (error) {
    // Clear pending notifications on error (don't execute them)
    if (!wasAlreadyTransacting) {
      pendingNotifications.clear();
    }
    throw error;
  } finally {
    docInTransactionMotion.delete(doc);

    // Reset flag only for outermost transaction
    if (!wasAlreadyTransacting) {
      isTransacting = false;
    }
  }
};
