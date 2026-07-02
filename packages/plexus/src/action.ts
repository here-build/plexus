/**
 * `@syncing.atomic` — run a PlexusModel method body as ONE atomic Plexus
 * transaction PER DOC it touches. See
 * `docs/working-proposals/syncing-atomic-spec-based-transactions.md` and the
 * engine in `./atomic-buffer.ts`.
 *
 * "Atomic" here means, for each doc the body mutates:
 *   - ONE yjs transaction (one `update` event),
 *   - ONE undo unit (a single `undo()` reverts that doc's whole batch),
 *   - peers see all-or-nothing of THAT update (delivered whole).
 *
 * A body may touch several docs; each doc is burst into its own single
 * transaction at flush (genesis first, outside any transaction). This is a
 * doc-agnostic REGION, not a single held-open transaction.
 *
 * THROW is commit-on-crash BY DEFAULT — writes buffered before the throw are
 * flushed, then the error rethrows (matches JS + yjs, which never unwind
 * completed effects). Rollback is opt-in, per method, via an error predicate:
 *
 * ```ts
 * class Foo extends PlexusModel {
 *   @syncing accessor count!: number;
 *   @syncing.child.set accessor bars!: Set<Bar>;
 *
 *   @syncing.atomic                       // commit-on-crash (default)
 *   doStuff() {
 *     this.count = 1;
 *     this.bars.add(new Bar({ ... }));    // materializes a new entity mid-method
 *     this.count = 2;
 *     // ↑ all deferred; replayed as exactly ONE flush at method return
 *   }
 *
 *   @syncing.atomic({ rollbackIf: (e) => e instanceof PlexusCycleError })
 *   risky() { ... }                       // discards the batch if the predicate matches
 * }
 * ```
 *
 * ───────────────────────────────────────────────────────────────────────────
 * HOW IT WORKS — DEFERRED BUFFER (postponement, not "hold a transaction open")
 * ───────────────────────────────────────────────────────────────────────────
 * `runAtomic` opens a computation region. While it is active, each routed
 * mutation site applies its LOCAL OVERLAY immediately (so the body reads its own
 * writes) but BUFFERS its effect, tagged with the doc it targets. On success the
 * flush runs in two phases — genesis/materialization OUTSIDE any transaction (its
 * own origin), then the inert yjs writes grouped per doc, each doc's writes inside
 * ONE `maybeTransacting(doc)` → one transaction / update / undo item per doc. On a
 * `rollbackIf` match the buffer is DISCARDED (yjs never touched → wire-pure) and
 * the overlay inverses replay in reverse to restore the mirror. See
 * `./atomic-buffer.ts` for why routing the leaf sites suffices (parent-edge /
 * materialization writes ride the flush transitively).
 *
 * Re-entrancy: a nested `@syncing.atomic` defers into the outer region (owning its
 * own savepoint slice), so the outermost method owns the single flush.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * BOUNDARY BEHAVIOR (intentional, asserted / documented — NOT a TODO)
 * ───────────────────────────────────────────────────────────────────────────
 *   - LIMINALITY: a mutation to a liminal (preview) doc applies INSTANTLY — the
 *     preview shadow is already the atomic unit, with its own guarantees. It is
 *     never buffered; a marker is recorded so a rollback slice can warn that a
 *     liminal effect cannot be reverted here (that is `revertLiminality()`'s job).
 *   - EMPTY REGION. A method that mutates nothing buffers nothing; the flush is
 *     skipped entirely (no empty transaction, so a pending `stopCapturing` is not
 *     cancelled).
 *   - EPHEMERAL RECEIVER. A body running on an un-materialized entity has null-doc
 *     mutations; those apply immediately (there is no doc to defer into) and are
 *     simply not collapsed. No warning — the region handles it gracefully.
 *   - MULTI-DOC. A body that mutates several docs is fully supported: each doc gets
 *     its own single transaction at flush. Atomicity is per-doc (yjs has no
 *     cross-doc transaction); the region guarantees each doc's batch is whole.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ASYNC IS A COMPILE ERROR (not a runtime warning)
 * ───────────────────────────────────────────────────────────────────────────
 * The deferral region is synchronous and flushes when the body RETURNS. An async
 * body would buffer only up to its first `await`; everything after runs after the
 * region has closed. Rather than warn at runtime, the decorator's return type is
 * branded so decorating a method whose return type is a `Promise` is a TYPE ERROR
 * at the declaration site — the wrong state is unrepresentable.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * OUT-OF-ENVELOPE (correct-but-unbatched → LOUD once-per-method dev warning)
 * ───────────────────────────────────────────────────────────────────────────
 *   - UNROUTED MUTATION KIND. Until every emission site is routed through the
 *     buffer, a not-yet-routed mutation inside the body takes its normal eager
 *     write path — it hits yjs DURING the body, so it is NOT batched and does NOT
 *     roll back. Detected structurally: a real transaction opening on any
 *     NON-liminal doc while the region is deferring (`isDeferring()`) can only be
 *     an unrouted write (a routed site merely overlays; a liminal write is expected
 *     to apply instantly). Warns once per method. Dormant once all sites are routed.
 */

import type * as Y from "yjs";

import { isDeferring, isLiminalDoc, runAtomic } from "./atomic-buffer.js";
import type { PlexusModel } from "./PlexusModel.js";
import { transactionObserverHook } from "./utils/utils.js";

// The unrouted-mutation condition warns at most once per decorated method, keyed
// on the original method fn (so re-entrant / repeated calls stay quiet).
const warnedUnroutedMethods = new WeakSet<object>();

const warnOnce = (seen: WeakSet<object>, key: object, message: string): void => {
  if (seen.has(key)) return;
  seen.add(key);
  // eslint-disable-next-line no-console
  console.warn(message);
};

/** Per-method configuration for the factory form `@syncing.atomic({ ... })`. */
export interface AtomicOptions {
  /**
   * Opt-in rollback. When the body throws and this predicate returns `true` for
   * the thrown error, the atomic batch is discarded (the wire stays pure and the
   * local mirror is restored) instead of the default commit-on-crash. The error
   * rethrows either way.
   */
  readonly rollbackIf?: (error: unknown) => boolean;
}

type AtomicMethod<This extends PlexusModel, Args extends unknown[], Return> = (
  this: This,
  ...args: Args
) => Return;

/**
 * Compile-time rejection type for async bodies. It carries a unique-symbol brand
 * and is therefore NOT assignable to a method slot — returning it from the
 * decorator surfaces as a type error at the `@syncing.atomic` declaration, with
 * the message below shown in the mismatch.
 */
declare const asyncNotAllowed: unique symbol;
interface AsyncMethodNotAllowed {
  readonly [asyncNotAllowed]: "@syncing.atomic cannot decorate an async method: the deferral region is synchronous and flushes when the body returns. Make the method synchronous.";
}

/**
 * Maps a method type to the decorator's return type: the method itself when
 * synchronous, or the un-assignable `AsyncMethodNotAllowed` brand when its return
 * type is a Promise (non-distributive `[Return]` so only a wholly-async return is
 * rejected). Applied to both the bare overload and the factory's returned
 * decorator so async is banned in both usages.
 */
type AtomicResult<This extends PlexusModel, Args extends unknown[], Return> = [Return] extends [Promise<unknown>]
  ? AsyncMethodNotAllowed
  : AtomicMethod<This, Args, Return>;

/**
 * The decorator the factory form returns. Generic in its call signature so it
 * infers `This / Args / Return` from the method it is applied to — a method with
 * typed parameters (e.g. `foo(kind: "a" | "b")`) must decorate cleanly, which a
 * non-generic `unknown[]` signature would reject on contravariant arg checking.
 */
interface GenericAtomicDecorator {
  <This extends PlexusModel, Args extends unknown[], Return>(
    target: AtomicMethod<This, Args, Return>,
    context: ClassMethodDecoratorContext<This, AtomicMethod<This, Args, Return>>,
  ): AtomicResult<This, Args, Return>;
}

/**
 * `@syncing.atomic` method decorator. Constrained to `PlexusModel` receivers —
 * the whole point is batching model mutations, which flow through docs the
 * receiver owns. Applying it to a non-PlexusModel method is meaningless (and a
 * type error). Applying it to an async method is a type error (see
 * `AsyncMethodNotAllowed`).
 *
 * Two usages:
 *   - bare       `@syncing.atomic`                 — commit-on-crash (default);
 *   - configured `@syncing.atomic({ rollbackIf })` — opt-in rollback predicate.
 */
export function atomic<This extends PlexusModel, Args extends unknown[], Return>(
  target: AtomicMethod<This, Args, Return>,
  context: ClassMethodDecoratorContext<This, AtomicMethod<This, Args, Return>>,
): AtomicResult<This, Args, Return>;
export function atomic(options: AtomicOptions): GenericAtomicDecorator;
export function atomic(
  targetOrOptions: AtomicMethod<PlexusModel, unknown[], unknown> | AtomicOptions,
  maybeContext?: ClassMethodDecoratorContext<PlexusModel, AtomicMethod<PlexusModel, unknown[], unknown>>,
): unknown {
  // Factory form: `@syncing.atomic({ rollbackIf })` → return the actual decorator.
  if (typeof targetOrOptions !== "function") {
    const { rollbackIf } = targetOrOptions;
    return (target: AtomicMethod<PlexusModel, unknown[], unknown>, context: ClassMethodDecoratorContext) =>
      buildAtomicMethod(target, context, rollbackIf);
  }
  // Bare form: `@syncing.atomic` (TC39 invokes it as `(method, context)`).
  return buildAtomicMethod(targetOrOptions, maybeContext!, undefined);
}

function buildAtomicMethod<This extends PlexusModel, Args extends unknown[], Return>(
  target: AtomicMethod<This, Args, Return>,
  context: ClassMethodDecoratorContext<This, AtomicMethod<This, Args, Return>>,
  rollbackIf: ((error: unknown) => boolean) | undefined,
): AtomicMethod<This, Args, Return> {
  const label = `@syncing.atomic: method "${String(context.name)}"`;

  return function atomicMethod(this: This, ...args: Args): Return {
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
      result = runAtomic(() => target.apply(this, args), rollbackIf);
    } finally {
      transactionObserverHook.observe = previousObserver;
    }

    if (unroutedLeak) {
      warnOnce(
        warnedUnroutedMethods,
        target,
        `${label} performed a mutation kind that is NOT yet routed through the atomic buffer. ` +
          `That write hit yjs eagerly during the body — so it was NOT batched into the single ` +
          `transaction and will NOT roll back on throw. Restrict atomic bodies to the routed ` +
          `mutation kinds until the full emission rewrite lands.`,
      );
    }

    return result;
  };
}
