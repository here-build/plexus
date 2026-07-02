/**
 * Deferred-buffer engine for `@syncing.action` — the spec-based transaction core.
 *
 * ## A region, not a single-doc context
 *
 * An action body opens a computation REGION: one ordered list of deferred
 * changes, each tagged with the doc it targets. The region is doc-agnostic — a
 * body may touch several docs, and each doc's changes are burst into its OWN
 * transaction at flush. "Outermost" is purely a sync-stack notion: the frame
 * with no action parent owns the flush; nested frames defer into the same region
 * and own a savepoint slice.
 *
 * ## Why a buffer — postponement, not "hold a transaction open"
 *
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
 *   phase 2 — per doc, ONE `maybeTransacting(doc)`: `describe()` produces the
 *             inert leaf writes as `YjsOp` DATA, `applyYjsOp` applies each, then
 *             `notify()` fires reactivity → one transaction, one `update`, one
 *             undo item per doc.
 *
 * During the body each routed mutation applies its local OVERLAY immediately (so
 * the body reads its own writes) and BUFFERS the deferred effect. Splitting
 * validation (eager, at overlay) from the writes (phase 2) makes the writes
 * inert: nothing fallible is left to throw mid-flush.
 *
 * ## Changes are data — `YjsOp` op-describing objects
 *
 * Every leaf yjs mutation this layer owns is expressed as a `YjsOp` descriptor
 * and applied through the single `applyYjsOp` dispatcher — the sole toucher of
 * `Y.Map` / `Y.Array` / `PlexusWrapper`. A site's `describe()` runs inside the
 * flush tx (post-genesis, so child refs and field-maps exist) and returns the
 * ops as data. Transitive genesis / adoption / field-map materialization stay as
 * calls into the protected core (they own their own transaction semantics and
 * nest into the flush tx) — they are plexus choreography, not leaf yjs ops.
 *
 * ## Liminality — instant bypass, marked for rollback
 *
 * A mutation to a LIMINAL (preview) doc has different atomicity guarantees and is
 * applied INSTANTLY (its own `applyNow`), never buffered — the preview shadow is
 * its own transactional unit already. A lightweight marker is still pushed into the region so
 * savepoint slicing sees it; if a rollback reverts a slice containing a liminal
 * marker, we warn that the liminal effect was applied instantly and cannot be
 * rolled back here (commit/revertLiminality own it).
 *
 * ## Throw semantics — commit-on-crash is the DEFAULT
 *
 * A throwing body does NOT roll back by default. This matches both hosts we sit
 * between: JavaScript (an exception never unwinds the effects of statements that
 * already ran) and yjs (`transact` finalizes in `finally`, never rolls back). So
 * the writes buffered BEFORE the throw are flushed, then the error rethrows.
 *
 * Rollback is OPT-IN, per decorated method, via an error predicate:
 * `@syncing.action({ rollbackIf: (error) => boolean })`. When the predicate
 * matches the thrown error, the frame's buffered slice is discarded (yjs was
 * never touched → the wire stays pure) and its overlay writes are inversed to
 * restore the local mirror. The error rethrows either way.
 *
 * ## Why the core write path is unchanged (`applyNow`)
 *
 * Every routed site passes its ORIGINAL choreography verbatim as `applyNow`. When
 * no region is active (the overwhelming common case), `emitOrDefer` runs exactly
 * `applyNow()` and nothing else. Mutations outside an action are byte-for-byte what
 * they were before routing.
 */

import type * as Y from "yjs";

import { docLiminality, docPlexus } from "./plexus-registry.js";
import type { PlexusWrapper } from "./PlexusWrapper.js";
import type { AllowedYValue, Storageable } from "./proxy-runtime-types.js";
import { maybeTransacting } from "./utils/utils.js";

/**
 * A single leaf yjs mutation, described as data. `applyYjsOp` is the sole caller
 * of the underlying `Y.Map` / `Y.Array` / `PlexusWrapper` mutation methods, so
 * every deferred write funnels through one auditable, loggable dispatcher.
 *
 *  - `attr-*`  — a model field-map write (a `Y.XmlElement` attribute via `PlexusWrapper`).
 *  - `map-*`   — a nested `Y.Map` entry (set / child-set / record / map fields).
 *  - `array-*` — a nested `Y.Array` slot (list / child-list fields; push = insert at end).
 */
export type YjsOp =
  | { readonly kind: "attr-set"; readonly wrapper: PlexusWrapper; readonly key: string; readonly value: Storageable }
  | { readonly kind: "attr-delete"; readonly wrapper: PlexusWrapper; readonly key: string }
  | { readonly kind: "map-set"; readonly map: Y.Map<AllowedYValue>; readonly key: string; readonly value: AllowedYValue }
  | { readonly kind: "map-delete"; readonly map: Y.Map<AllowedYValue>; readonly key: string }
  | { readonly kind: "map-clear"; readonly map: Y.Map<AllowedYValue> }
  | {
      readonly kind: "array-insert";
      readonly array: Y.Array<AllowedYValue>;
      readonly index: number;
      readonly content: AllowedYValue[];
    }
  | { readonly kind: "array-delete"; readonly array: Y.Array<AllowedYValue>; readonly index: number; readonly length: number };

/** The single dispatcher every deferred leaf write flows through. Runs inside the flush tx. */
export function applyYjsOp(op: YjsOp): void {
  switch (op.kind) {
    case "attr-set":
      op.wrapper.set(op.key, op.value);
      return;
    case "attr-delete":
      op.wrapper.delete(op.key);
      return;
    case "map-set":
      op.map.set(op.key, op.value);
      return;
    case "map-delete":
      op.map.delete(op.key);
      return;
    case "map-clear":
      op.map.clear();
      return;
    case "array-insert":
      op.array.insert(op.index, op.content);
      return;
    case "array-delete":
      op.array.delete(op.index, op.length);
      return;
  }
}

/** The write choreography every routed mutation site funnels through `emitOrDefer`. */
export interface EmitOps {
  /**
   * The site's ORIGINAL, unchanged code (its own `maybeTransacting` wrapper
   * included). Runs verbatim when not in a region, or when the target doc is
   * liminal (instant preview write).
   */
  readonly applyNow: () => void;
  /**
   * The synchronous local-mirror write only (backingStorage / backing
   * collection). Runs IMMEDIATELY in defer mode so the body reads its own writes.
   * NO yjs, NO `trackModification`.
   */
  readonly overlay: () => void;
  /** Optional phase-1 genesis (entity materialization). Buffered; runs OUTSIDE the flush tx. */
  readonly materialize?: () => void;
  /**
   * Phase-2, inside the flush tx: run any transitive core prep (ensureYjsMap,
   * requestAdoption, local bookkeeping) needed to resolve the concrete target,
   * then RETURN the leaf writes as `YjsOp` data. The engine applies each through
   * `applyYjsOp`. Return `[]` when there is nothing to write (e.g. no field-map).
   */
  readonly describe: () => YjsOp[];
  /** Phase-2 reactivity (`trackModification`), fired after the ops are applied. */
  readonly notify?: () => void;
  /** The inverse of `overlay`, used only on rollback. Silent (overlay fired no `trackModification`). */
  readonly revertOverlay: () => void;
}

/** A deferred normal mutation — its phases and overlay inverse, tagged with its target doc. */
interface NormalEntry {
  readonly kind: "normal";
  readonly doc: Y.Doc;
  readonly materialize?: () => void;
  readonly describe: () => YjsOp[];
  readonly notify?: () => void;
  readonly revertOverlay: () => void;
}

/** A marker that a liminal write was applied instantly. Carries no effect — flush ignores it. */
interface LiminalMarker {
  readonly kind: "liminal";
  readonly doc: Y.Doc;
}

type RegionEntry = NormalEntry | LiminalMarker;

/** A computation region: one ordered list of changes across any number of docs. */
interface Region {
  readonly entries: RegionEntry[];
}

/**
 * The active region, or null. Doc-agnostic: a region batches mutations to any
 * number of docs, bursting one transaction per doc at flush. A nested
 * `@syncing.action` reuses it (its mutations defer into the same ordered list,
 * owning a savepoint slice).
 */
let current: Region | null = null;

/** True when a region is active and mutations should be deferred (doc-agnostic). */
export const isDeferring = (): boolean => current !== null;

/** A doc is liminal when it is a main doc mid-session, or a shadow doc whose Plexus reports liminal. */
export function isLiminalDoc(doc: Y.Doc | null | undefined): boolean {
  if (!doc) return false;
  if (docLiminality.has(doc)) return true;
  return docPlexus.get(doc)?.isLiminal ?? false;
}

/**
 * The funnel every routed mutation site calls.
 *
 *  - No region active (or ephemeral, doc-less receiver) → run `applyNow` verbatim.
 *  - Target doc is LIMINAL → run `applyNow` instantly (preview owns atomicity),
 *    but push a marker so a rollback slice can warn.
 *  - Otherwise → apply the overlay immediately and buffer the deferred effect.
 */
export function emitOrDefer(doc: Y.Doc | null | undefined, ops: EmitOps): void {
  if (current === null || doc == null) {
    ops.applyNow();
    return;
  }
  if (isLiminalDoc(doc)) {
    // Liminal writes happen instantly — the preview shadow is already its own
    // transactional unit, with its own guarantees. We still record the marker so savepoint
    // slicing / rollback can report that a liminal effect can't be reverted here.
    ops.applyNow();
    current.entries.push({ kind: "liminal", doc });
    return;
  }
  ops.overlay();
  current.entries.push({
    kind: "normal",
    doc,
    materialize: ops.materialize,
    describe: ops.describe,
    notify: ops.notify,
    revertOverlay: ops.revertOverlay,
  });
}

/**
 * Undo overlay writes from `entries[from..]` in REVERSE, then drop them so they
 * never commit. A failing inverse must not mask the error that triggered the
 * rollback, so each inverse is isolated (L1). If the reverted slice contains a
 * liminal marker, warn: that effect was applied instantly and cannot be undone
 * here (commit/revertLiminality owns it).
 */
function revertRegionFrom(region: Region, from: number): void {
  const { entries } = region;
  let sawLiminal = false;
  for (let i = entries.length - 1; i >= from; i--) {
    const entry = entries[i]!;
    if (entry.kind === "liminal") {
      sawLiminal = true;
      continue;
    }
    try {
      entry.revertOverlay();
    } catch {
      // Best-effort mirror restore. The original throw is what the caller must see;
      // a broken inverse cannot be allowed to replace it.
    }
  }
  entries.length = from;
  if (sawLiminal) {
    // eslint-disable-next-line no-console
    console.warn(
      "@syncing.action rollback: a reverted change targeted a liminal (preview) doc. Liminal writes " +
        "apply instantly and are NOT rolled back here — use revertLiminality() to discard the preview.",
    );
  }
}

/**
 * Flush a region. Phase 1 runs every `materialize` (genesis, outside any tx, in
 * region order). Phase 2 groups the normal entries by doc — preserving
 * first-encounter order — and bursts ONE `maybeTransacting(doc)` per doc, applying
 * each entry's described ops through `applyYjsOp` then firing its `notify`.
 *
 * Skipped entirely when nothing normal was buffered — a needless empty transaction
 * would cancel a pending `stopCapturing` and silently merge the next edit into this
 * undo item (L2).
 */
function flush(region: Region): void {
  const normal = region.entries.filter((e): e is NormalEntry => e.kind === "normal");
  if (normal.length === 0) return;

  // Phase 1 — genesis OUTSIDE any transaction (each op carries its own origin).
  for (const entry of normal) entry.materialize?.();

  // Group by doc, preserving the order docs were first touched.
  const byDoc = new Map<Y.Doc, NormalEntry[]>();
  for (const entry of normal) {
    let group = byDoc.get(entry.doc);
    if (!group) {
      group = [];
      byDoc.set(entry.doc, group);
    }
    group.push(entry);
  }

  // Phase 2 — one transaction per doc of inert, pre-validated writes.
  for (const [doc, entries] of byDoc) {
    maybeTransacting(doc, () => {
      for (const entry of entries) {
        for (const op of entry.describe()) applyYjsOp(op);
        entry.notify?.();
      }
    });
  }
}

/**
 * Run `body` as one action region.
 *
 *  - Success: flush the region (phase 1 outside any tx, phase 2 one tx per doc).
 *  - Throw with no matching `rollbackIf`: commit-on-crash — flush what was buffered
 *    before the throw, then rethrow (matches JS + yjs finalization semantics).
 *  - Throw matching `rollbackIf`: discard the buffer (yjs never written → wire-pure),
 *    restore the local mirror by inversing the overlays in reverse, then rethrow.
 *
 * Nested calls share the outer region but own a savepoint slice; the OUTERMOST
 * call owns the single flush.
 */
export function runAction<T>(body: () => T, rollbackIf?: (error: unknown) => boolean): T {
  // NESTED: share the outer region, own a savepoint slice.
  if (current !== null) {
    const region = current;
    const savepoint = region.entries.length;
    try {
      return body();
    } catch (error) {
      // This frame's own predicate decides its slice; commit-on-crash otherwise.
      if (rollbackIf?.(error)) revertRegionFrom(region, savepoint);
      throw error;
    }
  }

  // ROOT frame: open a fresh region.
  const region: Region = { entries: [] };
  const previous = current;
  current = region;

  let result: T;
  try {
    result = body();
  } catch (error) {
    current = previous;
    if (rollbackIf?.(error)) {
      // ROLLBACK: discard everything, restore the mirror. Wire stays pure.
      revertRegionFrom(region, 0);
      throw error;
    }
    // COMMIT-ON-CRASH (default): flush what was buffered before the throw, rethrow.
    flush(region);
    throw error;
  }

  current = previous;
  flush(region);
  return result;
}
