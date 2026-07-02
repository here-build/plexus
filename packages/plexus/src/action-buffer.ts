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
 * ## Ownership mid-body — staged squash, settled once at flush
 *
 * Parenting is an explicit, first-class concern of the region, not a side
 * effect of collection writes. A routed child-field site DECLARES the ownership
 * effects of its mutation as `EmitOps.moves` data; the engine stages them into
 * the region's ownership layer at emit time and SQUASHES per entity — only the
 * LAST assignment per child survives (`effectiveParent`), earlier staged
 * destinations accumulate as residue to sweep (`displaced`: their content
 * inserts have no matching removal op, an implicit removal). Staging is gated
 * on the child's EFFECTIVE slot: re-affirming the current owner stages nothing,
 * and removing a child from a collection it no longer effectively occupies (a
 * stale residual, dual membership) is content-only — not an orphanization.
 *
 * Reads are live: the `parent` / `parentField` / `parentFieldKey` accessors and
 * the ancestry walks (cycle validation, `rootAncestor`) consult the staged
 * layer mid-body, so statement-time validation always sees the ownership the
 * body just expressed.
 *
 * At flush, ownership settles ONCE per entity, inside the same per-doc
 * transaction as the content ops and AFTER them: sweep the displaced residues
 * (identity-guarded — a successor occupant of the slot is never evicted), then
 * settle the final assignment (emancipate from the real parent + adopt, or
 * orphanize). NO re-validation happens at flush: statement-time validation
 * against effective ownership is the proof, and re-checking against a
 * half-settled mix of old and new pointers could see transient cycles that
 * exist in neither the old nor the new graph. Observers therefore witness ONE
 * net adoption per entity per action — never the intermediate hops. The settle
 * choreography reuses the protected core (`#emancipate` + `informAdoption`)
 * via an ops vtable the model layer registers at init (no import cycle).
 *
 * Ephemeral children keep genesis deferred ("no uuid until commit") but their
 * ownership is visible instantly. A mutation that settles ownership FOR REAL
 * mid-region (an ephemeral/doc-less owner, or a liminal doc — both applyNow
 * paths) converts any staged assignment for that child into residue and drops
 * the staging: the real pointers are the truth again. Savepoint rollback
 * restores the staged layer via per-entry `undoMoves` inverses, symmetric with
 * `revertOverlay`.
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
import type { PlexusModel } from "./PlexusModel.js";
import type { PlexusWrapper } from "./PlexusWrapper.js";
import type { AllowedYValue, Storageable } from "./proxy-runtime-types.js";
// NOTE: import from the `transacting` LEAF, not `utils.js` — utils imports
// PlexusModel, whose module body calls `registerRegionOwnershipOps` back into
// THIS module at evaluation time. A runtime path action-buffer → PlexusModel
// would let the model's body run while this module is still mid-evaluation,
// and the registration would hit the TDZ. See the layering note in transacting.ts.
import { maybeTransacting } from "./utils/transacting.js";

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

/**
 * Staged mid-action ownership for one entity: the destination the in-flight
 * region has moved it to. `meta` mirrors `parentMetadata` in STATEMENT-TIME
 * serialization (serialized map key / plain record key / null) — every gate
 * compares meta against other statement-time strings, which is form-consistent
 * because an owner's doc context cannot change mid-region (materialization
 * happens only at flush).
 *
 * `rawKey` is present on child-map slots only: the raw (unserialized) map key.
 * Anything that crosses the statement→flush boundary — residue sweeps, the
 * settle's parentData meta — must NOT string-compare statement-form meta
 * (entity keys serialize local-form on doc-less owners, global-form once
 * materialized); it goes through the public map proxy / re-serialization in
 * flush context via `rawKey` instead.
 */
export interface EffectiveActionParent {
  readonly parent: PlexusModel;
  readonly field: string;
  readonly meta: string | null;
  readonly rawKey?: unknown;
}

/**
 * One ownership change a routed site declares alongside its deferred effect —
 * plain data. The site reports what its mutation DID (which child landed in
 * which slot, which child left which slot); the engine judges what it MEANS
 * (reaffirmation, stale-residual removal, displacement) against the child's
 * effective ownership. An orphan move therefore names the slot it removed
 * from (`from`) so the engine can tell an orphanization from residue cleanup.
 *
 * Child-map adoptions must carry `rawKey` (the raw map key) alongside the
 * serialized `meta` — see {@link EffectiveActionParent}.
 */
export type OwnershipMove =
  | {
      readonly child: PlexusModel;
      readonly parent: PlexusModel;
      readonly field: string;
      readonly meta?: string | null;
      readonly rawKey?: unknown;
    }
  | { readonly child: PlexusModel; readonly orphan: true; readonly from: OwnershipSlot };

/** The slot an orphan move removed its child from. */
export interface OwnershipSlot {
  readonly parent: PlexusModel;
  readonly field: string;
  readonly meta?: string | null;
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
   * local bookkeeping) needed to resolve the concrete target, then RETURN the
   * leaf writes as `YjsOp` data. The engine applies each through `applyYjsOp`.
   * Return `[]` when there is nothing to write (e.g. no field-map). Ownership
   * choreography does NOT belong here — declare it as `moves`; the flush
   * ownership pass settles the net result once per entity.
   */
  readonly describe: () => YjsOp[];
  /** Phase-2 reactivity (`trackModification`), fired after the ops are applied. */
  readonly notify?: () => void;
  /** The inverse of `overlay`, used only on rollback. Silent (overlay fired no `trackModification`). */
  readonly revertOverlay: () => void;
  /**
   * Ownership changes this mutation performs (child-field sites only) — the
   * site declares FACTS (child landed in / left this slot), the engine judges
   * MEANING (reaffirmation, residue, displacement) and squashes. Staged right
   * after `overlay` so mid-body reads and ancestry walks see live ownership;
   * settled net-once at flush; inversed on savepoint rollback.
   */
  readonly moves?: readonly OwnershipMove[];
}

/** A deferred normal mutation — its phases and overlay inverse, tagged with its target doc. */
interface NormalEntry {
  readonly kind: "normal";
  readonly doc: Y.Doc;
  readonly materialize?: () => void;
  readonly describe: () => YjsOp[];
  readonly notify?: () => void;
  readonly revertOverlay: () => void;
  /** Inverse of this entry's staged ownership moves, if it declared any. */
  readonly undoMoves?: () => void;
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
  /**
   * The ownership squash: entities moved by this region → their LAST staged
   * assignment (`null` = staged orphan). Absent key = not staged, the real
   * pointers are the truth. Read via `effectiveActionParentOf`; drives the
   * flush ownership pass.
   */
  readonly effectiveParent: WeakMap<PlexusModel, EffectiveActionParent | null>;
  /**
   * Entities with staged ownership, in LAST-assignment order — the order the
   * flush pass settles them in, replaying the user's own causal proof of
   * acyclicity without re-validating.
   */
  readonly ownershipOrder: PlexusModel[];
  /**
   * Residue to sweep at flush: for each child, the staged destinations its
   * later re-staging DISPLACED. Their content inserts flushed with no matching
   * removal op (an intra-action move away is an implicit removal), so the
   * ownership pass removes the child from each — identity-guarded.
   */
  readonly displaced: Map<PlexusModel, EffectiveActionParent[]>;
}

/**
 * The model-layer choreography the flush ownership pass drives, registered by
 * `PlexusModel` at module init (a vtable, so the engine never runtime-imports
 * the model layer — no cycle). All four run against REAL pointers: the region
 * is closed during flush, so accessors no longer consult the staged layer.
 */
export interface RegionOwnershipOps {
  /** The child's real ownership slot right now (raw internals, no staging). */
  realOf(model: PlexusModel): EffectiveActionParent | null;
  /**
   * Settle a staged adoption: dedupe → emancipate from the real parent →
   * inform. NO cycle validation — statement time already proved it against
   * effective ownership.
   */
  settleAdoption(model: PlexusModel, target: EffectiveActionParent): void;
  /** Settle a staged orphan (emancipate + clear parent data). */
  settleOrphan(model: PlexusModel): void;
  /**
   * Remove `model` from ONE displaced slot's collection, backing + yjs,
   * identity-guarded: touch the slot only if it still holds `model`, so a
   * successor occupant is never evicted. Idempotent. Child-map slots are
   * addressed via `target.rawKey` through the public proxy (never by
   * string-comparing statement-form meta against flush-form backing keys).
   */
  sweepResidue(model: PlexusModel, target: EffectiveActionParent): void;
}

let ownershipOps: RegionOwnershipOps | null = null;

/** Called once by the model layer at init. */
export function registerRegionOwnershipOps(ops: RegionOwnershipOps): void {
  ownershipOps = ops;
}

function requireOwnershipOps(): RegionOwnershipOps {
  if (ownershipOps === null) {
    throw new Error("@syncing.action: RegionOwnershipOps not registered — model layer not initialized");
  }
  return ownershipOps;
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
  if (current === null) {
    ops.applyNow();
    return;
  }
  if (doc == null) {
    // Ephemeral / doc-less receiver mid-region: the write (and its ownership
    // choreography) settles FOR REAL right now, so any staged assignment for a
    // moved child is stale — convert it to residue and drop it.
    ops.applyNow();
    if (ops.moves?.length) settleImmediateMoves(current, ops.moves);
    return;
  }
  if (isLiminalDoc(doc)) {
    // Liminal writes happen instantly — the preview shadow is already its own
    // transactional unit, with its own guarantees. We still record the marker so savepoint
    // slicing / rollback can report that a liminal effect can't be reverted here.
    ops.applyNow();
    if (ops.moves?.length) settleImmediateMoves(current, ops.moves);
    current.entries.push({ kind: "liminal", doc });
    return;
  }
  ops.overlay();
  const undoMoves = ops.moves?.length ? stageMoves(current, ops.moves) : undefined;
  current.entries.push({
    kind: "normal",
    doc,
    materialize: ops.materialize,
    describe: ops.describe,
    notify: ops.notify,
    revertOverlay: ops.revertOverlay,
    undoMoves,
  });
}

/** Sentinel distinguishing "no prior squash entry" from a staged `null` (orphan). */
const NO_STAGED = Symbol("no-staged-parent");

/** Structural equality of ownership slots (meta normalized to null). */
function slotEquals(a: EffectiveActionParent | null, parent: PlexusModel, field: string, meta: string | null): boolean {
  return a !== null && a.parent === parent && a.field === field && a.meta === meta;
}

/**
 * Stage a batch of ownership moves into the region's squash, returning the
 * inverse that restores each child's PRIOR state (map entry, order position,
 * displaced stack) in reverse order.
 *
 * Gates (both judged against EFFECTIVE ownership):
 *  - an adoption matching the child's effective slot is a reaffirmation — no
 *    ownership change, nothing staged;
 *  - an orphan whose `from` slot is NOT the child's effective slot removed a
 *    stale residual (dual membership) — content-only, nothing staged.
 *
 * Adoption over a previously STAGED adoption pushes the displaced slot onto the
 * child's residue list: its content insert flushed with no matching removal op.
 * (Displacing the REAL slot needs no residue — the settle emancipates from it.)
 */
function stageMoves(region: Region, moves: readonly OwnershipMove[]): () => void {
  const layer = region.effectiveParent;
  const undos: Array<() => void> = [];
  for (const move of moves) {
    const child = move.child;
    const previous: EffectiveActionParent | null | typeof NO_STAGED = layer.has(child)
      ? (layer.get(child) ?? null)
      : NO_STAGED;
    const effective = previous === NO_STAGED ? requireOwnershipOps().realOf(child) : previous;

    let displacedPush: EffectiveActionParent | undefined;
    if ("orphan" in move) {
      if (!slotEquals(effective, move.from.parent, move.from.field, move.from.meta ?? null)) continue;
      layer.set(child, null);
    } else {
      if (slotEquals(effective, move.parent, move.field, move.meta ?? null)) continue;
      if (previous !== NO_STAGED && previous !== null) {
        displacedPush = previous;
        let residue = region.displaced.get(child);
        if (!residue) {
          residue = [];
          region.displaced.set(child, residue);
        }
        residue.push(previous);
      }
      layer.set(child, { parent: move.parent, field: move.field, meta: move.meta ?? null, rawKey: move.rawKey });
    }

    // Last-assignment order: move the child to the end.
    const orderIndex = region.ownershipOrder.indexOf(child);
    if (orderIndex !== -1) region.ownershipOrder.splice(orderIndex, 1);
    region.ownershipOrder.push(child);

    undos.push(() => {
      // LIFO discipline (revertRegionFrom walks entries in reverse, this runner
      // walks its own moves in reverse) guarantees the region state is exactly
      // as this staging left it — the child is the last order element.
      region.ownershipOrder.pop();
      if (orderIndex !== -1) region.ownershipOrder.splice(orderIndex, 0, child);
      if (displacedPush !== undefined) {
        const residue = region.displaced.get(child)!;
        residue.pop();
        if (residue.length === 0) region.displaced.delete(child);
      }
      if (previous === NO_STAGED) layer.delete(child);
      else layer.set(child, previous);
    });
  }
  return () => {
    for (let i = undos.length - 1; i >= 0; i--) undos[i]!();
  };
}

/**
 * An applyNow-path mutation (ephemeral/doc-less owner, liminal doc) settled its
 * ownership choreography FOR REAL mid-region. Any staged assignment for a moved
 * child is now stale: a staged ADOPTION's content insert becomes residue to
 * sweep, and the staging drops so reads (and the flush settle) fall through to
 * the real pointers. Deliberately NOT undoable — the real write it mirrors
 * isn't rolled back on these paths either (same warning class as liminal).
 */
function settleImmediateMoves(region: Region, moves: readonly OwnershipMove[]): void {
  for (const move of moves) {
    const staged = region.effectiveParent.get(move.child);
    if (staged === undefined) continue;
    if (staged !== null) {
      let residue = region.displaced.get(move.child);
      if (!residue) {
        residue = [];
        region.displaced.set(move.child, residue);
      }
      residue.push(staged);
    }
    region.effectiveParent.delete(move.child);
    // Stays in ownershipOrder: the flush pass still sweeps the residue, and
    // skips the settle (no staged entry).
  }
}

/**
 * The in-flight action's staged ownership for `model`:
 *
 *  - `undefined` — not superseded; the REAL pointers are the truth.
 *  - `null` — staged orphan (removed from its parent mid-action).
 *  - otherwise — the staged destination.
 *
 * Consulted by the `parent` / `parentField` / `parentFieldKey` accessors and by
 * the ancestry walks (cycle validation, `rootAncestor`). Always `undefined`
 * outside a region — including DURING flush, which runs after the region closes
 * precisely so choreography reads pre-action state.
 */
export function effectiveActionParentOf(model: PlexusModel): EffectiveActionParent | null | undefined {
  return current?.effectiveParent.get(model);
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
      // Inverse of the emit order (overlay, then stage): unstage first.
      entry.undoMoves?.();
    } catch {
      // Same isolation as revertOverlay — a broken inverse must not mask the trigger.
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
 * first-encounter order — and bursts ONE `maybeTransacting(doc)` per doc: the
 * content ops (each entry's described writes + notify), then the OWNERSHIP pass
 * for the entities whose staged moves target that doc, in last-assignment
 * order — sweep each displaced residue, then settle the final assignment. The
 * settle choreography re-enters the proxies (region already closed → immediate
 * writes) and nests into the same transaction via `maybeTransacting`.
 *
 * Skipped entirely when nothing normal was buffered — a needless empty transaction
 * would cancel a pending `stopCapturing` and silently merge the next edit into this
 * undo item (L2). (No normal entries ⇒ no unreverted staged moves either: every
 * staged move rides a normal entry, and reverting the entry unwinds the stage.)
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

  // Ownership work per doc, in last-assignment order. Resolved AFTER phase 1 so
  // genesis has assigned docs. A doc-less chain (fully ephemeral) has nothing
  // to settle — its real writes applied immediately mid-body.
  const ownershipByDoc = new Map<Y.Doc, PlexusModel[]>();
  for (const child of region.ownershipOrder) {
    const staged = region.effectiveParent.get(child);
    const residue = region.displaced.get(child);
    if (staged === undefined && !residue?.length) continue;
    const doc = staged?.parent.__doc__ ?? residue?.[0]?.parent.__doc__ ?? child.__doc__;
    if (!doc) continue;
    let group = ownershipByDoc.get(doc);
    if (!group) {
      group = [];
      ownershipByDoc.set(doc, group);
      if (!byDoc.has(doc)) byDoc.set(doc, []);
    }
    group.push(child);
  }

  // Phase 2 — one transaction per doc: inert pre-validated content writes, then
  // the net ownership settle.
  for (const [doc, entries] of byDoc) {
    maybeTransacting(doc, () => {
      for (const entry of entries) {
        for (const op of entry.describe()) applyYjsOp(op);
        entry.notify?.();
      }
      const settles = ownershipByDoc.get(doc);
      if (!settles) return;
      const ops = requireOwnershipOps();
      for (const child of settles) {
        const final = region.effectiveParent.get(child);
        for (const slot of region.displaced.get(child) ?? []) {
          // A residue slot equal to the FINAL slot is not residue — the child
          // circled back (a→b→a); its content entry IS the final home.
          // Statement-form meta comparison is sound here: both strings were
          // produced in the same region context.
          if (final != null && slotEquals(final, slot.parent, slot.field, slot.meta)) continue;
          ops.sweepResidue(child, slot);
        }
        if (final === undefined) continue;
        if (final === null) ops.settleOrphan(child);
        else ops.settleAdoption(child, final);
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
 *  - `rollbackIf` ITSELF throwing: settles as commit-on-crash (the predicate never
 *    affirmatively matched) and the predicate's error propagates — per JS catch
 *    semantics — instead of the body's. The region is never abandoned: one of
 *    revert/flush always runs, so the mirror cannot silently outrun yjs.
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
  const region: Region = { entries: [], effectiveParent: new WeakMap(), ownershipOrder: [], displaced: new Map() };
  const previous = current;
  current = region;

  let result: T;
  try {
    result = body();
  } catch (error) {
    current = previous;
    // The predicate is user code and may itself throw. Standard JS applies — its
    // error replaces the body's — but the region MUST still settle: an abandoned
    // buffer would leave the mirror permanently ahead of yjs. The `finally`
    // guarantees exactly one of revert/flush runs; a throwing predicate settles
    // as commit-on-crash (it never affirmatively matched).
    let matched = false;
    try {
      matched = rollbackIf?.(error) ?? false;
    } finally {
      if (matched) {
        // ROLLBACK: discard everything, restore the mirror. Wire stays pure.
        revertRegionFrom(region, 0);
      } else {
        // COMMIT-ON-CRASH (default): flush what was buffered before the throw.
        flush(region);
      }
    }
    throw error;
  }

  current = previous;
  flush(region);
  return result;
}
