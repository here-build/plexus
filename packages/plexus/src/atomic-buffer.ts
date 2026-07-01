/**
 * Deferred-buffer engine for `@syncing.atomic` — the spec-based transaction core.
 * See `docs/working-proposals/syncing-atomic-spec-based-transactions.md`.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY A BUFFER — POSTPONEMENT, not "hold a transaction open"
 * ───────────────────────────────────────────────────────────────────────────
 * The buffer's job is to decouple *when intent is expressed* (the method body,
 * running in program order so it can read its own writes) from *when and where
 * each effect executes* (the flush). Postponement is the point — rollback is a
 * bonus it happens to enable.
 *
 * The decisive reason to postpone is GENESIS. Materializing a fresh entity is a
 * deterministic re-derivation with its OWN origin; it must NOT be swallowed into
 * the user's transaction, or it corrupts undo granularity and broadcasts to peers
 * as if the user had authored it. So the flush runs in TWO phases:
 *
 *   phase 1 — `materialize`: genesis / entity materialization, run OUTSIDE any
 *             transaction (each carries its own origin via `[referenceSymbol]`);
 *   phase 2 — `commit`: the inert, pre-validated yjs writes, replayed inside ONE
 *             `maybeTransacting(doc)` → one transaction, one `update`, one undo
 *             item.
 *
 * During the body each routed mutation applies its local OVERLAY immediately (so
 * the body reads its own writes) and BUFFERS the deferred effect. Splitting
 * validation (eager, at overlay) from the writes (phase 2) makes the commit
 * inert: nothing fallible is left to throw mid-flush.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THROW SEMANTICS — commit-on-crash is the DEFAULT
 * ───────────────────────────────────────────────────────────────────────────
 * A throwing body does NOT roll back by default. This matches both hosts we sit
 * between: JavaScript (an exception never unwinds the effects of statements that
 * already ran) and yjs (`transact` finalizes in `finally`, never rolls back). So
 * the writes buffered BEFORE the throw are flushed, then the error rethrows.
 *
 * Rollback is OPT-IN, per decorated method, via an error predicate:
 * `@syncing.atomic({ rollbackIf: (error) => boolean })`. When the predicate
 * matches the thrown error, the frame's buffered slice is discarded (yjs was
 * never touched → the wire stays pure) and its overlay writes are inversed to
 * restore the local mirror. The error rethrows either way.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE STACK — nested frames, one flush
 * ───────────────────────────────────────────────────────────────────────────
 * A nested `@syncing.atomic` on the same doc shares the outer buffer but owns a
 * SAVEPOINT SLICE (the buffer length on entry). Only the OUTERMOST frame flushes
 * ("consume queued changes in the outer tx only"). On throw a frame consults its
 * OWN `rollbackIf`: matched → revert only its slice; otherwise commit-on-crash —
 * leave the slice for the outer flush.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THE CORE WRITE PATH IS UNCHANGED (`applyNow`)
 * ───────────────────────────────────────────────────────────────────────────
 * Every routed site passes its ORIGINAL choreography verbatim as `applyNow`. When
 * no atomic context is active for the doc (the overwhelming common case),
 * `emitOrDefer` runs exactly `applyNow()` and nothing else. Non-atomic mutations
 * are byte-for-byte what they were before routing.
 */

import type * as Y from "yjs";

import { maybeTransacting } from "./utils/utils.js";

/** A single buffered mutation: its two-phase deferred effect and overlay inverse. */
interface DeferredOp {
  /**
   * Phase 1 — materialization / genesis. Runs OUTSIDE the flush transaction so
   * re-derivation keeps its own origin (not swallowed into the user's tx).
   * Optional: primitive writes have nothing to materialize.
   */
  readonly materialize?: () => void;
  /** Phase 2 — the inert, pre-validated yjs write + `trackModification`, inside the one flush tx. */
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
 *  - `applyNow`   — the site's ORIGINAL, unchanged code (its own `maybeTransacting`
 *                   wrapper included). Runs verbatim when not deferring.
 *  - `overlay`    — the synchronous local-mirror write only (backingStorage /
 *                   backing collection). Runs IMMEDIATELY in defer mode so the body
 *                   reads its own writes. NO yjs, NO `trackModification`.
 *  - `materialize`— optional phase-1 genesis (entity / field-map materialization).
 *                   Buffered; runs OUTSIDE the flush tx.
 *  - `commit`     — phase-2 yjs write + `trackModification`. Buffered; runs inside
 *                   the one flush tx.
 *  - `revertOverlay` — the inverse of `overlay`, used only on rollback. Silent (the
 *                   overlay fired no `trackModification`, so its inverse mustn't either).
 */
export function emitOrDefer(
  doc: Y.Doc | null | undefined,
  ops: {
    applyNow: () => void;
    overlay: () => void;
    materialize?: () => void;
    commit: () => void;
    revertOverlay: () => void;
  },
): void {
  if (isDeferring(doc)) {
    ops.overlay();
    current!.buffer.push({ materialize: ops.materialize, commit: ops.commit, revertOverlay: ops.revertOverlay });
  } else {
    ops.applyNow();
  }
}

/**
 * Undo overlay writes from `buffer[from..]` in REVERSE, then drop them so they
 * never commit. A failing inverse must not mask the error that triggered the
 * rollback, so each inverse is isolated (L1).
 */
function revertBufferFrom(buffer: DeferredOp[], from: number): void {
  for (let i = buffer.length - 1; i >= from; i--) {
    try {
      buffer[i]!.revertOverlay();
    } catch {
      // Best-effort mirror restore. The original throw is what the caller must see;
      // a broken inverse cannot be allowed to replace it.
    }
  }
  buffer.length = from;
}

/**
 * Flush a root context: phase 1 (materialize, outside any tx) then phase 2 (all
 * commits inside ONE transaction). Skipped entirely when nothing was buffered — a
 * needless empty transaction would cancel a pending `stopCapturing` and silently
 * merge the next edit into this undo item (L2).
 */
function flush(context: AtomicContext): void {
  const { buffer, doc } = context;
  if (buffer.length === 0) return;
  // Phase 1 — genesis OUTSIDE the transaction (each op carries its own origin).
  for (const op of buffer) op.materialize?.();
  // Phase 2 — one transaction of inert, pre-validated writes.
  maybeTransacting(doc, () => {
    for (const op of buffer) op.commit();
  });
}

/**
 * Run `body` as one atomic transaction on `doc`.
 *
 *  - Success: flush the buffer (phase 1 outside the tx, phase 2 in one tx).
 *  - Throw with no matching `rollbackIf`: commit-on-crash — flush what was buffered
 *    before the throw, then rethrow (matches JS + yjs finalization semantics).
 *  - Throw matching `rollbackIf`: discard the buffer (yjs never written → wire-pure),
 *    restore the local mirror by inversing the overlays in reverse, then rethrow.
 *
 * Nested same-doc calls share the outer buffer but own a savepoint slice; the
 * OUTERMOST call owns the single flush.
 */
export function runAtomic<T>(doc: Y.Doc, body: () => T, rollbackIf?: (error: unknown) => boolean): T {
  // NESTED (same doc): share the outer buffer, own a savepoint slice.
  if (isDeferring(doc)) {
    const { buffer } = current!;
    const savepoint = buffer.length;
    try {
      return body();
    } catch (error) {
      // This frame's own predicate decides its slice; commit-on-crash otherwise.
      if (rollbackIf?.(error)) revertBufferFrom(buffer, savepoint);
      throw error;
    }
  }

  // ROOT frame: open a fresh deferral context for this doc.
  const context: AtomicContext = { doc, buffer: [] };
  const previous = current;
  current = context;

  let result: T;
  try {
    result = body();
  } catch (error) {
    current = previous;
    if (rollbackIf?.(error)) {
      // ROLLBACK: discard everything, restore the mirror. Wire stays pure.
      revertBufferFrom(context.buffer, 0);
      throw error;
    }
    // COMMIT-ON-CRASH (default): flush what was buffered before the throw, rethrow.
    flush(context);
    throw error;
  }

  current = previous;
  flush(context);
  return result;
}
