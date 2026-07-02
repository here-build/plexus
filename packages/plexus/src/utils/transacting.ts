import type * as Y from "yjs";

import { docPlexus, docTransactionOrigin } from "../plexus-registry.js";
import { telemetry } from "../telemetry.js";

/**
 * Transaction primitive layer — a RUNTIME LEAF, deliberately.
 *
 * The deferred-buffer engine (`action-buffer.ts`) imports `maybeTransacting`,
 * and the model layer calls back into the engine AT MODULE SCOPE
 * (`registerRegionOwnershipOps`). If this module's runtime import closure ever
 * reaches `PlexusModel`, the engine's evaluation can suspend inside its own
 * imports while the model's body runs — and the module-scope registration hits
 * the engine's uninitialized (TDZ) state. Keep runtime imports here restricted
 * to leaves (registry, telemetry); model-aware helpers live in `utils.ts`.
 */

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

// doc transactions are rather expensive, even nested ones, and it's better to track them across the call chain efficiently
// plus it will avoid transaction events for mid-transaction stuff
const docInTransactionMotion = new WeakSet();

/**
 * True while `doc` has a real (outermost) `maybeTransacting` transaction in
 * motion on the call stack. `@syncing.action` checks this at entry: an action
 * invoked inside an already-open transaction cannot own its flush boundaries.
 * (A raw `doc.transact` that bypassed `maybeTransacting` is invisible here —
 * out of contract.)
 */
export const isDocTransacting = (doc: Y.Doc): boolean => docInTransactionMotion.has(doc);

// Notification batching state
export let isTransacting = false;
export const pendingNotifications: Set<() => void> = new Set();

export const flushNotificationsHook: { wrapper?: (fn: () => void) => void } = {};

/**
 * Optional observer fired exactly once each time a NEW outermost `doc.transact`
 * opens for a doc — NOT for nested/shadow sub-transactions. `@syncing.action`
 * installs this for the duration of an action body to spot cross-doc mutations:
 * a doc OTHER than the receiver's opening its own transaction sits OUTSIDE the
 * receiver's single-doc action batch. Mirrors `flushNotificationsHook` — an
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
    // observer (e.g. `@syncing.action`'s cross-doc detector). Nested/shadow
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
