/**
 * `@syncing.action` — run a PlexusModel method body as ONE Plexus transaction
 * PER DOC it touches (a *syncing action*: a collapsed unit of intent). The engine
 * lives in `./action-buffer.ts`.
 *
 * For each doc the body mutates, the action guarantees:
 *   - ONE yjs transaction (one `update` event, delivered whole/atomically to peers),
 *   - ONE undo unit (a single `undo()` reverts that doc's whole batch),
 *   - peers see all-or-nothing of THAT update.
 *
 * A body may touch several docs; each doc is burst into its own single
 * transaction at flush (genesis first, outside any transaction). This is a
 * doc-agnostic REGION, not a single held-open transaction.
 *
 * ## Why this exists — yjs transactions are BATCHING, not ACID
 *
 * A yjs transaction groups writes into one update; it does NOT give all-or-nothing.
 * A throw mid-transaction commits the partial and broadcasts it — there is no
 * rollback (yjs finalizes in `finally`, by design as a low-level CRDT). This is the
 * ACID-shaped layer the ecosystem keeps reaching for, built the principled way:
 * N mutations → one update / one undo step per doc, plus OPT-IN all-or-nothing on
 * throw. Without the opt-in it means exactly what yjs means — one batched update.
 *
 * ```ts
 * class Foo extends PlexusModel {
 *   @syncing accessor count!: number;
 *   @syncing.child.set accessor bars!: Set<Bar>;
 *
 *   @syncing.action                       // commit-on-crash (default)
 *   doStuff() {
 *     this.count = 1;
 *     this.bars.add(new Bar({ ... }));    // materializes a new entity mid-method
 *     this.count = 2;
 *     // ↑ all deferred; replayed as exactly ONE flush at method return
 *   }
 *
 *   @syncing.action({ rollbackIf: (e) => e instanceof PlexusCycleError })
 *   risky() { ... }                       // discards the batch if the predicate matches
 * }
 * ```
 *
 * ## How it works — deferred buffer + eager overlay
 *
 * The shift from "hold a transaction open" to POSTPONEMENT:
 *   - yjs writes are DEFERRED — buffered as inert effects, nothing hits a Y.Doc
 *     until the flush;
 *   - the in-memory layer is EAGER — each routed site applies its LOCAL OVERLAY
 *     (the backing mirror) immediately, so the body reads its own pending writes.
 *
 * `runAction` opens the region; each routed mutation overlays now and buffers its
 * effect tagged with the target doc. On success the flush runs in two phases —
 * genesis/materialization OUTSIDE any transaction (its own origin), then the inert
 * yjs writes grouped per doc, each doc's writes inside ONE `maybeTransacting(doc)`
 * → one transaction / update / undo item per doc. Routing the LEAF sites suffices:
 * parent-edge and materialization writes ride the flush transitively.
 *
 * WIRE-PURITY. Because yjs is untouched until the flush, a rolled-back action
 * broadcasts NOTHING — the buffer is centralized across every doc touched, so the
 * "separate docs → separate updates → can't net-zero" objection never arises: the
 * writes simply never happened. (Scoped to user-mutation writes; see GENESIS.)
 *
 * Re-entrancy: a nested `@syncing.action` defers into the outer region (owning its
 * own savepoint slice), so the outermost method owns the single flush.
 *
 * ## Genesis — a re-derived virtual layer, NOT a user mutation
 *
 * Entity materialization (genesis) is its own kind and runs in flush phase 1,
 * OUTSIDE the user's transaction, with its own origin. Conceptually the entity was
 * always there; genesis only materializes the observation of it. It is deterministic
 * and content-addressed, so every peer re-derives the identical structure — it is
 * wire-SAFE (idempotent), not wire-absent. The action neither buffers a rollback for
 * genesis nor unwinds it: on rollback the flush never runs, so a rolled-back
 * creation simply never materializes (no orphan). This is why wire-purity above is
 * a claim about user-mutation writes, explicitly excluding the genesis virtual layer.
 *
 * ## Throw — commit-on-crash by DEFAULT; rollback is opt-in; scope is SYNCED state
 *
 * By default a throw is commit-on-crash: writes buffered before the throw are
 * flushed, then the error rethrows — matching both hosts we sit between (JS, where
 * an exception never unwinds statements that already ran, and yjs, which never rolls
 * back). Rollback is per-method opt-in via `{ rollbackIf: (error) => boolean }`.
 *
 * When it fires, rollback reverts SYNCED state only — mentally "drop the synced
 * writes and re-sync," not "recover a snapshot": the buffer is discarded (yjs never
 * touched → wire-pure) and the overlay inverses replay in reverse to restore the
 * mirror. Ephemeral / transient / derived local state is NOT rolled back — exactly
 * as any throwing JS method leaves its non-synced side effects. The error rethrows
 * either way; `rollbackIf` decides STATE, never control flow.
 *
 * ESCAPED-ENTITY hazard: an entity materialized in a body that then rolls back can
 * leak out (returned, closed over, stashed) as a live handle that will never sync.
 * The synchronous wrapping kills the common case (no `await` → it can't escape to a
 * later turn); side-effect escape remains a matter of discipline, not structure.
 *
 * ## Identity — no uuid until commit (ordinal is the within-action handle)
 *
 * An entity created during the body has NO uuid until the flush — identity is
 * DERIVED from integration, not minted, and integration is deferred. Reading
 * `.uuid` mid-action for such an entity throws by design: the constraint is "don't
 * rely on uuid until we're done here, because we might still roll this back." The
 * ordinal is the local, materialization-stable handle available now (and the React
 * key); the uuid is the global id available post-commit. Store entity REFS, not uuid
 * strings — a ref resolves to its uuid at commit.
 *
 * ## Boundary behavior (intentional, asserted / documented — NOT a TODO)
 *
 *   - LIMINALITY: a mutation to a liminal (preview) doc applies INSTANTLY — the
 *     preview shadow is already its own transactional unit, with its own
 *     guarantees. It is never buffered; a marker is recorded so a rollback slice
 *     can warn that a liminal effect cannot be reverted here (that is
 *     `revertLiminality()`'s job).
 *   - EMPTY REGION. A method that mutates nothing buffers nothing; the flush is
 *     skipped entirely (no empty transaction, so a pending `stopCapturing` is not
 *     cancelled).
 *   - EPHEMERAL RECEIVER. A body running on an un-materialized entity has null-doc
 *     mutations; those apply immediately (there is no doc to defer into) and are
 *     simply not collapsed. No warning — the region handles it gracefully.
 *   - MULTI-DOC. A body that mutates several docs is fully supported: each doc gets
 *     its own single transaction at flush. Per-doc only (yjs has no cross-doc
 *     transaction); the region guarantees each doc's batch is whole.
 *   - MID-BODY STRUCTURAL STALENESS. The overlay is read-your-writes for the
 *     mutated field's CONTENT only; ownership is squashed per entity (last
 *     parent-assignment wins) and settled once at flush. Mid-body the two views
 *     deliberately diverge in opposite directions: back-pointers (`child.parent`,
 *     `child.parentField`, `child.parentFieldKey`) are staged-aware and answer
 *     with the EFFECTIVE slot immediately (destination, or null after a plain
 *     removal), while collection CONTENT stays stale — the source still contains
 *     the child (DUAL MEMBERSHIP) until the flush sweeps it. One loud
 *     consequence: re-inserting that child into a list that stalely still
 *     contains it throws PlexusDuplicateChildError — the throw judges content,
 *     not effective ownership, and honest noise beats silent divergence. Chosen,
 *     not accidental: eager content choreography would mutate the SOURCE
 *     collection's mirror before the action is known to commit, and rollback
 *     could no longer restore the source from the op's own snapshot (an op only
 *     knows its destination). Pinned by the decorator suite's (b2).
 *
 * ## Honest limits — crash-atomicity and async continuations
 *
 *   - CROSS-DOC IS STRUCTURALLY ALL-OR-NOTHING, NOT 2-PHASE-COMMIT. The
 *     STACK-TOPMOST action owns the single flush: every doc's transaction fires in
 *     ONE synchronous burst at the outermost boundary (`flush` loops
 *     `maybeTransacting(doc)` per doc over inert, pre-validated writes — no user
 *     code, no `await`, nothing fallible between them). A nested action never
 *     flushes; its writes — including ones to OTHER docs — defer into the same
 *     region and burst with the rest. So in normal control flow it is all-or-nothing
 *     across docs: no logical interleaving can leave a partial. The one residual is
 *     a hard PROCESS CRASH literally between two per-doc transactions; closing that
 *     needs 2-phase commit across docs (out of scope). Named, not hidden.
 *   - A DEFERRED-BODY METHOD IS A COMPILE ERROR. The region is synchronous and
 *     flushes when the body RETURNS; a body that doesn't run to completion on call
 *     escapes it — an `async` body buffers only up to its first `await`, and a
 *     generator (sync OR async) runs lazily on iteration, not at all when called.
 *     Rather than warn at runtime, the decorator does not ACCEPT such a method: when
 *     the return is a `Promise` / `AsyncIterable` / `AsyncIterator` / `Iterator`
 *     (a generator) the `target` parameter collapses to `never`, so decorating it is
 *     a TYPE ERROR at the declaration site — the wrong state is unrepresentable.
 *   - ASYNC-CONTINUATION MUTATIONS are a permanent non-goal. The buffer closes over
 *     the synchronous body only; a write from a `setTimeout` / microtask / deferred
 *     callback fires outside the body and cannot be captured. Mutate synced state
 *     only from within the synchronous body.
 *
 * ## Out-of-envelope (correct-but-unbatched → LOUD once-per-method dev warning)
 *
 *   - UNROUTED MUTATION KIND. Until every emission site is routed through the
 *     buffer, a not-yet-routed mutation inside the body takes its normal eager
 *     write path — it hits yjs DURING the body, so it is NOT batched and does NOT
 *     roll back. Detected structurally: a real transaction opening on any
 *     NON-liminal doc while the region is deferring (`isDeferring()`) can only be
 *     an unrouted write (a routed site merely overlays; a liminal write is expected
 *     to apply instantly). Warns once per method. Dormant once all sites are routed.
 */

import type * as Y from "yjs";

import { isDeferring, isLiminalDoc, runAction } from "./action-buffer.js";
import type { PlexusModel } from "./PlexusModel.js";
import { isDocTransacting } from "./utils/transacting.js";
import { transactionObserverHook } from "./utils/utils.js";

// The unrouted-mutation condition warns at most once per decorated method, keyed
// on the original method fn (so re-entrant / repeated calls stay quiet).
const warnedUnroutedMethods = new WeakSet<object>();

// Same once-per-method policy for the pre-open-transaction condition.
const warnedPreOpenTxMethods = new WeakSet<object>();

const warnOnce = (seen: WeakSet<object>, key: object, message: string): void => {
  if (seen.has(key)) return;
  seen.add(key);
  // eslint-disable-next-line no-console
  console.warn(message);
};

/** Per-method configuration for the factory form `@syncing.action({ ... })`. */
export interface ActionOptions {
  /**
   * Opt-in rollback. When the body throws and this predicate returns `true` for
   * the thrown error, the action's batch is discarded (the wire stays pure and the
   * local mirror is restored) instead of the default commit-on-crash. The error
   * rethrows either way.
   */
  readonly rollbackIf?: (error: unknown) => boolean;
}

type ActionMethod<This extends PlexusModel, Args extends unknown[], Return> = (
  this: This,
  ...args: Args
) => Return;

/**
 * Return shapes that prove the method body does NOT run to completion when called,
 * so the decorator refuses a method that returns one — the region is synchronous
 * and flushes on RETURN.
 *
 *   - `Promise`         — an `async` body suspends at its first `await`, buffering
 *                         only the writes before it;
 *   - `AsyncIterable` / `AsyncIterator`
 *                       — an `async function*` (the `[Symbol.asyncIterator]` side)
 *                         or a hand-rolled async `.next()`-only object;
 *   - `Iterator`        — a SYNC generator (`function*` → `Generator`, which is an
 *                         `Iterator`) whose body runs lazily on iteration, not on
 *                         call, so its mutations miss the region entirely.
 *
 * `Iterator` (not `Iterable`) is the deliberate cut: `string`, arrays, `Map`/`Set`
 * are `Iterable` but not `Iterator`, so a body that legitimately RETURNS one of
 * those is untouched. The one over-broad case is a body that returns a live
 * iterator it built eagerly (`return map.values()`) — its body DID complete, but it
 * reads as an `Iterator` and is rejected; wrap it (`[...map.values()]`) if you hit
 * it. The real invariant is "the body runs to completion when called."
 *
 * Two assignability edges, resolved opposite ways in `SyncActionMethod`:
 *   - `(): never` (an always-throwing body, explicitly annotated) would match here
 *     only because `never` is assignable to EVERYTHING — but such a body does run
 *     at call time, and commit-on-crash is precisely its designed semantics, so it
 *     is escaped back to accepted;
 *   - `(): any` matches for the same assignability reason and is KEPT rejected on
 *     purpose: an `any` return may well be a `Promise`, so the decorator demands
 *     the real annotation instead of admitting sloppily-typed async. (`unknown`
 *     stays accepted — unlike `any` it cannot silently BE a promise downstream
 *     without narrowing.)
 */
type DeferredDelivery = Promise<unknown> | AsyncIterable<unknown> | AsyncIterator<unknown> | Iterator<unknown>;

/**
 * The method type the decorator ACCEPTS. The ban is at the INPUT: when `Return`
 * is a `DeferredDelivery` the whole parameter collapses to `never`, so an async
 * method, an async generator, or a sync generator is simply not an accepted
 * argument — the error lands on the `@syncing.action` line as "not assignable",
 * with no brand and nothing leaking into the decorator's output type. For a body
 * that returns synchronously it is the ordinary `ActionMethod`, and because that
 * clean naked function type is the conditional's FALSE branch, `This` / `Args` /
 * `Return` still infer from it (so the decorated method keeps its real return
 * type). The `[Return]` wrapper is non-distributive, so only a wholly-deferred
 * return is rejected (`Promise<T> | T` — a body that may hand back a promise it
 * built synchronously — stays accepted; its continuation writes are the
 * documented ASYNC-CONTINUATION non-goal, not a laziness proof).
 *
 * The leading `[Return] extends [never]` arm escapes the one assignability false
 * positive: an explicitly-annotated always-throwing method (see `DeferredDelivery`).
 */
type SyncActionMethod<This extends PlexusModel, Args extends unknown[], Return> = [Return] extends [never]
  ? ActionMethod<This, Args, Return>
  : [Return] extends [DeferredDelivery]
    ? never
    : ActionMethod<This, Args, Return>;

/**
 * The decorator the factory form returns. Generic in its call signature so it
 * infers `This / Args / Return` from the method it is applied to — a method with
 * typed parameters (e.g. `foo(kind: "a" | "b")`) must decorate cleanly, which a
 * non-generic `unknown[]` signature would reject on contravariant arg checking.
 */
interface GenericActionDecorator {
  <This extends PlexusModel, Args extends unknown[], Return>(
    target: SyncActionMethod<This, Args, Return>,
    context: ClassMethodDecoratorContext<This, ActionMethod<This, Args, Return>>,
  ): ActionMethod<This, Args, Return>;
}

/**
 * `@syncing.action` method decorator. Constrained to `PlexusModel` receivers —
 * the whole point is batching model mutations, which flow through docs the
 * receiver owns. Applying it to a non-PlexusModel method is meaningless (and a
 * type error). Applying it to an async method, an async generator, or a sync
 * generator is a type error too — the `target` parameter is not satisfiable by a
 * `DeferredDelivery` return (see `SyncActionMethod`).
 *
 * Two usages:
 *   - bare       `@syncing.action`                 — commit-on-crash (default);
 *   - configured `@syncing.action({ rollbackIf })` — opt-in rollback predicate.
 */
export function action<This extends PlexusModel, Args extends unknown[], Return>(
  target: SyncActionMethod<This, Args, Return>,
  context: ClassMethodDecoratorContext<This, ActionMethod<This, Args, Return>>,
): ActionMethod<This, Args, Return>;
export function action(options: ActionOptions): GenericActionDecorator;
export function action(
  targetOrOptions: ActionMethod<PlexusModel, unknown[], unknown> | ActionOptions,
  maybeContext?: ClassMethodDecoratorContext<PlexusModel, ActionMethod<PlexusModel, unknown[], unknown>>,
): unknown {
  // Factory form: `@syncing.action({ rollbackIf })` → return the actual decorator.
  if (typeof targetOrOptions !== "function") {
    const { rollbackIf } = targetOrOptions;
    return (target: ActionMethod<PlexusModel, unknown[], unknown>, context: ClassMethodDecoratorContext) =>
      buildActionMethod(target, context, rollbackIf);
  }
  // Bare form: `@syncing.action` (TC39 invokes it as `(method, context)`).
  return buildActionMethod(targetOrOptions, maybeContext!, undefined);
}

function buildActionMethod<This extends PlexusModel, Args extends unknown[], Return>(
  target: ActionMethod<This, Args, Return>,
  context: ClassMethodDecoratorContext<This, ActionMethod<This, Args, Return>>,
  rollbackIf: ((error: unknown) => boolean) | undefined,
): ActionMethod<This, Args, Return> {
  const label = `@syncing.action: method "${String(context.name)}"`;

  return function actionMethod(this: This, ...args: Args): Return {
    // PRE-OPEN TRANSACTION detection. Called inside an already-open transaction
    // (e.g. `plexus.transact(() => model.action())`, or synchronously from a
    // notification fired inside another action's flush), the region cannot own
    // its boundaries: the flush's per-doc transactions nest silently into the
    // outer one — genesis and content merge into the caller's transaction (no
    // separate undo step, no origin separation) — and the unrouted-mutation
    // detector below is blind for this doc (its observer fires only on NEW
    // outermost transactions). The batch still applies; only the envelope
    // guarantees degrade.
    if (this.__doc__ && isDocTransacting(this.__doc__)) {
      warnOnce(
        warnedPreOpenTxMethods,
        target,
        `${label} was called inside an already-open transaction ` +
          `(plexus.transact(() => model.action())?). The action cannot own its transaction ` +
          `boundaries there: its writes merge into the outer transaction (no separate undo ` +
          `step, no origin separation) and unrouted-mutation detection is blind for this doc. ` +
          `Call actions outside transact() — the action itself is the batch.`,
      );
    }

    // UNROUTED-MUTATION detection. A routed mutation only overlays during the
    // body (no real transaction until flush); a liminal write is expected to apply
    // instantly. So a real transaction opening on any NON-liminal doc WHILE the
    // region is deferring means an unrouted mutation kind escaped the buffer and
    // wrote yjs eagerly — NOT batched, NOT rolled back. `isDeferring()` cleanly
    // separates this from the flush (which runs after the region closes →
    // `isDeferring()` false). This turns partial routing coverage into a LOUD
    // boundary; it goes dormant once every emission site is routed.
    let unroutedLeak = false;
    const previousObserver = transactionObserverHook.observe;
    transactionObserverHook.observe = (touched: Y.Doc): void => {
      if (isDeferring() && !isLiminalDoc(touched)) unroutedLeak = true;
      previousObserver?.(touched);
    };

    let result: Return;
    try {
      result = runAction(() => target.apply(this, args), rollbackIf);
    } finally {
      transactionObserverHook.observe = previousObserver;
    }

    if (unroutedLeak) {
      warnOnce(
        warnedUnroutedMethods,
        target,
        `${label} performed a mutation kind that is NOT yet routed through the action buffer. ` +
          `That write hit yjs eagerly during the body — so it was NOT batched into the single ` +
          `transaction and will NOT roll back on throw. Restrict action bodies to the routed ` +
          `mutation kinds until the full emission rewrite lands.`,
      );
    }

    return result;
  };
}
