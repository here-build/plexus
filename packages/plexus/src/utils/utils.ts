import type * as Y from "yjs";

import { docPlexus, docTransactionOrigin } from "../plexus-registry.js";
import { PlexusModel } from "../PlexusModel.js";
import type { AllowedYJSValue, AllowedYValue, ReferenceTuple } from "../proxy-runtime-types.js";
import { referenceSymbol } from "../proxy-runtime-types.js";
import { telemetry } from "../telemetry.js";

/**
 * Per-doc deferred stopCapturing.
 * When entities are created, we schedule a deferred stopCapturing so that
 * creation and subsequent user modifications end up as separate undo items.
 * If another transaction starts before the deferred fires, it's cancelled
 * (the new transaction merges naturally via captureTimeout).
 */
const pendingStopCapturing = new WeakMap<Y.Doc, boolean>();

export function markEntityCreated(doc: Y.Doc): void {
  if (pendingStopCapturing.has(doc)) return; // already scheduled
  pendingStopCapturing.set(doc, true);
}

export function never(value: never): never {
  throw new Error(`Unexpected value: ${value}`);
}

// Tuple reference helpers
export const isTupleReference = (val: any): val is ReferenceTuple =>
  Array.isArray(val) && val.length > 0 && val.length <= 2 && typeof val[0] === "string";

/**
 * Normalize a `Uint8Array`-like to the exact shape the CRDT layer stores. yjs's
 * `typeMapSet` switches on an EXACT `value.constructor`, so a subclass — most
 * often a Node `Buffer`, which isomorphic-git and friends hand in — is an
 * `instanceof Uint8Array` yet fails that switch ("Unexpected content type"). Copy
 * any non-plain Uint8Array into a plain one; a plain Uint8Array (the common case)
 * passes through untouched.
 */
const toStorableBytes = (val: Uint8Array): Uint8Array => (val.constructor === Uint8Array ? val : new Uint8Array(val));

export const maybeReference = (val: AllowedYJSValue, doc: Y.Doc): AllowedYValue => {
  if (val instanceof PlexusModel) return val[referenceSymbol](doc) ?? null;
  if (val instanceof Uint8Array) return toStorableBytes(val);
  return val ?? null;
};

export const curryMaybeReference =
  (doc: Y.Doc) =>
  (val: AllowedYJSValue): AllowedYValue =>
    maybeReference(val, doc);

// doc transactions are rather expensive, even nested ones, and it's better to track them across the call chain efficiently
// plus it will avoid transaction events for mid-transaction stuff
const docInTransactionMotion = new WeakSet();

// Notification batching state
export let isTransacting = false;
export const pendingNotifications: Set<() => void> = new Set();

export const flushNotificationsHook: { wrapper?: (fn: () => void) => void } = {};

/**
 * Optional observer fired exactly once each time a NEW outermost `doc.transact`
 * opens for a doc — NOT for nested/shadow sub-transactions. `@syncing.atomic`
 * installs this for the duration of an atomic body to spot cross-doc mutations:
 * a doc OTHER than the receiver's opening its own transaction sits OUTSIDE the
 * receiver's single-doc atomic batch. Mirrors `flushNotificationsHook` — an
 * unset observer costs one optional-call check on the cold (real-transact) path
 * and nothing on the hot (nested) path.
 */
export const transactionObserverHook: { observe?: (doc: Y.Doc) => void } = {};

export const flushNotifications = () => {
  const toNotify = new Set(pendingNotifications);
  pendingNotifications.clear();

  if (telemetry.enabled) {
    telemetry.histogram("plexus.tracking.flush_batch_size", toNotify.size);
    telemetry.counter("plexus.tracking.flush");
  }

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

// Module-local counter tracking active transactions at the call-stack
// level. Used as the `nesting_depth` attribute on transaction telemetry
// spans — increments on `maybeTransacting` enter, decrements on exit.
// Distinct from `docInTransactionMotion` (which is per-doc); this is
// the call-stack reentry depth, including no-doc transactions.
let transactionStackDepth = 0;

export const maybeTransacting = <T>(doc: Y.Doc | null | undefined, fn: () => T): T => {
  // Hot-path: build span only when telemetry enabled. The attribute set
  // is small (4 entries) and the span object is preallocated in the
  // adapter, so the cost is one method dispatch + one allocation per
  // outermost transaction.
  const transactionStartedAt = telemetry.enabled ? performance.now() : 0;
  const transactionSpan = telemetry.enabled
    ? telemetry.span("plexus.transaction", {
        has_doc: doc ? "true" : "false",
        nesting_depth: transactionStackDepth,
      })
    : null;
  transactionStackDepth++;

  const finishSpan = (outcome: "commit" | "abort") => {
    transactionStackDepth--;
    if (transactionSpan) {
      transactionSpan.end({
        outcome,
        duration_ms: performance.now() - transactionStartedAt,
      });
    }
  };

  if (!doc) {
    if (isTransacting) {
      try {
        const r = fn();
        finishSpan("commit");
        return r;
      } catch (e) {
        finishSpan("abort");
        throw e;
      }
    } else {
      isTransacting = true;
      try {
        const r = fn();
        finishSpan("commit");
        return r;
      } catch (e) {
        finishSpan("abort");
        throw e;
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
    try {
      const r = fn();
      finishSpan("commit");
      return r;
    } catch (e) {
      finishSpan("abort");
      throw e;
    }
  }

  // Entering a new transaction — cancel any pending deferred stopCapturing.
  // The new transaction will merge with the previous one via captureTimeout.
  pendingStopCapturing.delete(doc);

  try {
    docInTransactionMotion.add(doc);
    // Outermost (real) transaction opening for this doc — notify any installed
    // observer (e.g. `@syncing.atomic`'s cross-doc detector). Nested/shadow
    // sub-transactions returned above never reach here.
    transactionObserverHook.observe?.(doc);

    // Set transacting flag for outermost transaction
    if (!wasAlreadyTransacting) {
      isTransacting = true;
    }

    const r = doc.transact(fn, docTransactionOrigin.get(doc));
    finishSpan("commit");
    return r;
  } catch (error) {
    if (!wasAlreadyTransacting) {
      pendingNotifications.clear();
    }
    finishSpan("abort");
    throw error;
  } finally {
    docInTransactionMotion.delete(doc);

    // Reset flag only for outermost transaction
    if (!wasAlreadyTransacting) {
      // If entities were created, break the undo capture so creation
      // and subsequent modifications are separate undo items.
      // If entities were created, schedule deferred stopCapturing.
      // If the next synchronous code starts a new transaction before the
      // deferred fires, the pending flag is consumed and stopCapturing is skipped
      // (the transactions merge naturally via captureTimeout).
      if (pendingStopCapturing.has(doc)) {
        const capturedDoc = doc;
        setTimeout(() => {
          // Only fire if still pending and not mid-transaction
          if (pendingStopCapturing.has(capturedDoc) && !docInTransactionMotion.has(capturedDoc)) {
            pendingStopCapturing.delete(capturedDoc);
            try {
              docPlexus.get(capturedDoc)?.stopCapturing();
            } catch {
              /* UM may not exist during bootstrap */
            }
          }
        }, 0);
      }
      isTransacting = false;
      flushNotifications();
    }
  }
};
