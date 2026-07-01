/**
 * Deferred-buffer engine for `@syncing.atomic` — the spec-based transaction core.
 * See `docs/working-proposals/syncing-atomic-spec-based-transactions.md`.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY A BUFFER (and not just holding a transaction open)
 * ───────────────────────────────────────────────────────────────────────────
 * The earlier `@syncing.atomic` was a thin wrapper that got "one transaction"
 * by HOLDING `doc.transact` open across the method body — every nested yjs write
 * shadowed into it. That is correct for batching, but it cannot ROLL BACK: by
 * the time the body throws, yjs has already committed the partial writes (yjs
 * transactions never roll back). "Atomic" was therefore a claim about delivery,
 * not an all-or-nothing guarantee.
 *
 * This engine instead DEFERS the yjs writes. During the body, each routed
 * mutation site applies its local overlay IMMEDIATELY (so the body reads its own
 * writes) but BUFFERS the yjs write as a thunk. On success we replay the whole
 * buffer inside ONE `maybeTransacting(doc)` → one yjs transaction, one `update`,
 * one undo item — the same observable batching as before. On throw we DISCARD
 * the buffer: yjs was never touched, so the wire is pure (real rollback), and we
 * replay the overlay inverses in reverse to return the local mirror to its
 * pre-body state.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THE CORE WRITE PATH IS UNCHANGED (`applyNow`)
 * ───────────────────────────────────────────────────────────────────────────
 * Every routed site passes its ORIGINAL choreography verbatim as `applyNow`.
 * When no atomic context is active for the doc (the overwhelming common case —
 * `@syncing.atomic` is a rarely-used, opt-in decorator), `emitOrDefer` runs
 * exactly `applyNow()` and nothing else. So non-atomic mutations are byte-for-
 * byte what they were before routing; only a mutation performed INSIDE an atomic
 * body takes the deferred branch.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * TRANSITIVE DEFERRAL (why only a few sites need routing)
 * ───────────────────────────────────────────────────────────────────────────
 * A deferred `commit` thunk runs at FLUSH time, by which point the atomic
 * context has already been restored to its previous value. So any yjs write the
 * thunk triggers transitively (entity materialization via `[referenceSymbol]`,
 * `ensureYjsMap`, parent-edge writes) sees NO active context, runs its normal
 * `maybeTransacting`, and — because we replay inside one open flush transaction —
 * shadows into that single transaction. Routing the leaf mutation is enough; its
 * downstream yjs writes are carried along for free.
 */

import type * as Y from "yjs";

import { maybeTransacting } from "./utils/utils.js";

/** A single buffered mutation: its deferred yjs write and the inverse of its overlay. */
interface DeferredOp {
  /** The yjs write + `trackModification`. Replayed once, in order, at flush. */
  readonly commit: () => void;
  /** Undo of the immediate overlay write. Replayed in REVERSE on rollback. */
  readonly revertOverlay: () => void;
}

interface AtomicContext {
  readonly doc: Y.Doc;
  readonly buffer: DeferredOp[];
}

/**
 * The active atomic context, or null. Single-doc: a context batches mutations to
 * exactly one doc. A nested `@syncing.atomic` on the SAME doc reuses it (its
 * mutations defer into the same buffer); a mutation to ANOTHER doc falls through
 * to `applyNow` (its own transaction — not co-batched, flagged by the decorator).
 */
let current: AtomicContext | null = null;

/** True when mutations to `doc` should be deferred into the active atomic buffer. */
export const isDeferring = (doc: Y.Doc | null | undefined): boolean =>
  current !== null && doc != null && current.doc === doc;

/**
 * The write choreography every routed mutation site funnels through.
 *
 *  - `applyNow`  — the site's ORIGINAL, unchanged code (its own `maybeTransacting`
 *                  wrapper included). Runs verbatim when not deferring.
 *  - `overlay`   — the synchronous local-mirror write only (backingStorage /
 *                  backing collection). Runs IMMEDIATELY in defer mode so the body
 *                  reads its own writes. NO yjs, NO `trackModification`.
 *  - `commit`    — the yjs write + `trackModification`. Buffered in defer mode.
 *  - `revertOverlay` — the inverse of `overlay` (+ its `trackModification`), used
 *                  only on rollback.
 */
export function emitOrDefer(
  doc: Y.Doc | null | undefined,
  ops: {
    applyNow: () => void;
    overlay: () => void;
    commit: () => void;
    revertOverlay: () => void;
  },
): void {
  if (isDeferring(doc)) {
    ops.overlay();
    current!.buffer.push({ commit: ops.commit, revertOverlay: ops.revertOverlay });
  } else {
    ops.applyNow();
  }
}

/**
 * Run `body` as one atomic transaction on `doc`.
 *
 *  - Success: replay every buffered `commit` inside ONE `maybeTransacting(doc)`
 *    → one yjs transaction, one `update`, one undo item.
 *  - Throw: DISCARD the buffer (yjs never written → wire-pure), replay the overlay
 *    inverses in reverse to restore the local mirror, then rethrow. Reactions
 *    flush naturally via the inverse writes' `trackModification`, batched by the
 *    surrounding `maybeTransacting` (an empty yjs transaction — no `update`).
 *
 * Nested same-doc calls just run `body`; their mutations defer into the outer
 * buffer and the OUTERMOST call owns the single flush.
 */
export function runAtomic<T>(doc: Y.Doc, body: () => T): T {
  // Nested same-doc: defer into the already-open buffer; outer owns the flush.
  if (current !== null && current.doc === doc) {
    return body();
  }

  const context: AtomicContext = { doc, buffer: [] };
  const previous = current;
  current = context;

  let result: T;
  try {
    result = body();
  } catch (error) {
    current = previous;
    // Rollback: yjs untouched (wire-pure). Restore overlays in reverse so the
    // local mirror returns to its pre-body state. Batch the notifications.
    if (context.buffer.length > 0) {
      maybeTransacting(doc, () => {
        for (let i = context.buffer.length - 1; i >= 0; i--) {
          context.buffer[i]!.revertOverlay();
        }
      });
    }
    throw error;
  }

  current = previous;
  // Commit: replay the whole buffer as ONE transaction.
  maybeTransacting(doc, () => {
    for (const op of context.buffer) op.commit();
  });
  return result;
}
