import type * as Y from "yjs";

import { docTransactionOrigin } from "../plexus-registry.js";
import { PlexusModel } from "../PlexusModel.js";
import type { AllowedYJSValue, AllowedYValue, ReferenceTuple } from "../proxy-runtime-types.js";
import { referenceSymbol } from "../proxy-runtime-types.js";

export function never(value: never): never {
  throw new Error(`Unexpected value: ${value}`);
}

// Tuple reference helpers
export const isTupleReference = (val: any): val is ReferenceTuple =>
  Array.isArray(val) && val.length > 0 && val.length <= 2 && typeof val[0] === "string";

export const maybeReference = (val: AllowedYJSValue, doc: Y.Doc): AllowedYValue =>
  (val instanceof PlexusModel ? val[referenceSymbol](doc) : val) ?? null;

export const curryMaybeReference =
  (doc: Y.Doc) =>
  (val: AllowedYJSValue): AllowedYValue =>
    (val instanceof PlexusModel ? val[referenceSymbol](doc) : val) ?? null;

// doc transactions are rather expensive, even nested ones, and it's better to track them across the call chain efficiently
// plus it will avoid transaction events for mid-transaction stuff
const docInTransactionMotion = new WeakSet();


// Notification batching state
export let isTransacting = false;
export const pendingNotifications: Set<() => void> = new Set();

export const flushNotificationsHook: { wrapper?: (fn: () => void) => void } = {};

export const flushNotifications = () => {
  const toNotify = new Set(pendingNotifications);
  pendingNotifications.clear();

  const doFlush = () => {
    for (const notify of toNotify) {
      try {
        notify();
      } catch (error) {
        console.error("Error in notification callback:", error);
      }
    }
  };

  if (flushNotificationsHook.wrapper) {
    flushNotificationsHook.wrapper(doFlush);
  } else {
    doFlush();
  }
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
  const isNestedTransaction = docInTransactionMotion.has(doc);
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

    return doc.transact(fn, docTransactionOrigin.get(doc));
  } catch (error) {
    if (!wasAlreadyTransacting) {
      pendingNotifications.clear();
    }
    throw error;
  } finally {
    docInTransactionMotion.delete(doc);

    // Reset flag only for outermost transaction
    if (!wasAlreadyTransacting) {
      isTransacting = false;
      flushNotifications();
    }
  }
};
