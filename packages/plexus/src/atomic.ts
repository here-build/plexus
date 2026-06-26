/**
 * `@syncing.atomic` — run a PlexusModel method body as ONE atomic Plexus
 * transaction on the RECEIVER'S doc. "Atomic" here means exactly:
 *   - ONE yjs transaction (one `update` event),
 *   - ONE undo unit (a single `undo()` reverts the whole body), and
 *   - peers see all-or-nothing of THAT update (the update is delivered whole).
 * Every model mutation performed during the method is batched and flushed
 * together instead of each mutation hitting yjs immediately.
 *
 * This is the thin, single-doc envelope and it is the WHOLE feature. It does NOT
 * add deferred replay, multi-doc atomicity, rollback, or async support. Out of
 * that envelope (async body, cross-doc mutation, ephemeral receiver) it stays
 * correct-but-unbatched and says so LOUDLY (once-per-method dev `console.warn`)
 * rather than failing silently.
 *
 * CAVEAT — throw mid-body is NOT a rollback. `doc.transact` does not roll back
 * (same as `Plexus.transact`): mutations made before the throw are committed and
 * an `update` still fires for them. The decorator only suppresses the Plexus
 * NOTIFICATION flush on throw (pending observer notifications are discarded). So
 * "atomic" is a claim about how the successful update is delivered, NOT a
 * transactional all-or-nothing guarantee against exceptions.
 *
 * ```ts
 * class Foo extends PlexusModel {
 *   @syncing accessor count!: number;
 *   @syncing.child.set accessor bars!: Set<Bar>;
 *
 *   @syncing.atomic
 *   doStuff() {
 *     this.count = 1;
 *     this.bars.add(new Bar({ ... }));  // materializes a new entity mid-method
 *     this.count = 2;
 *     // ↑ all batched; flushed as exactly ONE doc.transact() at method return
 *   }
 * }
 * ```
 *
 * ───────────────────────────────────────────────────────────────────────────
 * HOW IT WORKS (and why it is a ~5-line wrapper, not a parallel tracker)
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Plexus is NOT a transparent write-through proxy — it OWNS the model↔yjs seam.
 * Two pre-existing facts make atomic batching almost free:
 *
 *   1. THE PER-DOC TRACKER ALREADY EXISTS. Every mutation path (val set,
 *      child-val set, set/map/list/record add/delete, AND entity
 *      materialization via `[referenceSymbol]`) funnels through
 *      `maybeTransacting(owner.__doc__, fn)`. That helper keeps a per-doc
 *      "transaction in motion" set: the FIRST touch of a doc opens a real
 *      `doc.transact(...)`; every nested touch of the SAME doc becomes a shadow
 *      sub-transaction (just runs `fn()` inside the already-open transaction).
 *      So if we hold one `doc.transact` open across the whole method body, all
 *      mutations to that doc collapse into a single yjs transaction → a single
 *      `update` event → a single undo item.
 *
 *   2. THE READ-OVERLAY ALREADY EXISTS. Plexus keeps a local `backingStorage`
 *      mirror that is written synchronously on every set and read by every
 *      getter. The method body therefore sees its own pending writes with zero
 *      extra machinery (and yjs, independently, makes in-transaction writes
 *      visible to in-transaction reads — so a mid-method `new Bar()` is fully
 *      materialized, `.uuid` resolves, and `bars.size` reflects the pending add).
 *
 * `@syncing.atomic` is thus exactly: open (hold) the receiver's-doc transaction
 * for the duration of the body. That is what `Plexus.transact()` already does;
 * we just bind it to the method via `this.__doc__` (which, in this architecture,
 * is the shadow/liminal doc where entities live and from which committed writes
 * forward to main with the SHADOW_TO_MAIN origin — a real commit, NOT a preview).
 *
 * Re-entrancy is free: a nested `@syncing.atomic` call (or any nested mutation)
 * is a shadow sub-transaction, so the outermost atomic method owns the single
 * transaction and inner ones are no-ops. Errors propagate; yjs does not roll
 * back automatically (same as `Plexus.transact`), but notifications are NOT
 * flushed on throw.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * COVERED (happy path, genuinely totalic for a SINGLE doc)
 * ───────────────────────────────────────────────────────────────────────────
 *   - val set, child-val set
 *   - set / map / list / record add / set / delete / clear
 *   - mid-method materialization of a fresh ephemeral entity (add-child)
 *   - reparent / orphanize (they route through `maybeTransacting` too)
 *   - read-overlay: the body reads its own pending writes
 *   - nested `@syncing.atomic` (re-entrancy)
 *   ⇒ exactly ONE `doc.transact`, ONE update, ONE undo item.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * BOUNDARY BEHAVIOR (intentional, asserted / documented — NOT a TODO)
 * ───────────────────────────────────────────────────────────────────────────
 *   - LIMINALITY: an atomic method invoked mid-liminal-session stays IN the
 *     preview. It rides `this.__doc__`'s transaction, whose registered origin is
 *     LIMINAL during a session, so the batch is held on the shadow (preview-only)
 *     and NOT forwarded to main — committing happens at `commitLiminality()`,
 *     reverting at `revertLiminality()`. Asserted, not changed.
 *   - EMPTY TRANSACTION. A method that mutates nothing still opens a transaction
 *     on the receiver's doc. yjs emits no `update` for an empty transaction, but
 *     `afterTransaction`/cleanup still runs (~O(observers)). Cheap; documented.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * OUT-OF-ENVELOPE (correct-but-unbatched → LOUD once-per-method dev warning)
 * ───────────────────────────────────────────────────────────────────────────
 * These are NOT atomicity claims — they are the honest boundary of a single-doc,
 * synchronous envelope. Each warns at most once per decorated method.
 *
 *   - ASYNC BODY. `doc.transact` is synchronous and commits when the body
 *     function RETURNS. Mutations before the first `await` are batched; anything
 *     after an `await` runs after the transaction has already closed → NOT
 *     batched. Warns when the body returns a thenable.
 *   - CROSS-DOC mutation. We only hold the RECEIVER's doc open. If the body
 *     mutates an entity on ANOTHER doc (e.g. a second project), that doc opens
 *     its own transaction — NOT co-batched, NOT all-or-nothing across docs. We
 *     detect it via `transactionObserverHook` (a second doc opening its own
 *     outermost transaction during the body) and warn. True multi-doc atomicity
 *     is the genuinely hard part the design flags: you cannot hold N *unknown*
 *     yjs transactions open (there is no programmatic startTx/commit — only
 *     `doc.transact(fn)`), so it would need a DEFERRED-REPLAY tracker. A separate
 *     project — NOT built here.
 *   - EPHEMERAL RECEIVER. If `this` is not yet materialized, `this.__doc__` is
 *     null; there is no doc to hold open, so mutations are not collapsed. Warns.
 *     Atomic methods are normally called on a tree-resident (materialized)
 *     entity, so this is an edge.
 */

import type * as Y from "yjs";

import type { PlexusModel } from "./PlexusModel.js";
import { maybeTransacting, transactionObserverHook } from "./utils/utils.js";

// Each out-of-envelope condition warns at most once per decorated method, keyed
// on the original method fn (so re-entrant / repeated calls stay quiet).
const warnedThenableMethods = new WeakSet<object>();
const warnedCrossDocMethods = new WeakSet<object>();
const warnedEphemeralMethods = new WeakSet<object>();

const isThenable = (value: unknown): boolean =>
  typeof value === "object" && value !== null && typeof Reflect.get(value, "then") === "function";

const warnOnce = (seen: WeakSet<object>, key: object, message: string): void => {
  if (seen.has(key)) return;
  seen.add(key);
  // eslint-disable-next-line no-console
  console.warn(message);
};

/**
 * `@syncing.atomic` method decorator. Constrained to `PlexusModel` receivers —
 * the whole point is batching model mutations, which flow through a doc the
 * receiver owns. Applying it to a non-PlexusModel method is meaningless (and a
 * type error).
 */
export function atomic<This extends PlexusModel, Args extends unknown[], Return>(
  target: (this: This, ...args: Args) => Return,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>,
): (this: This, ...args: Args) => Return {
  const label = `@syncing.atomic: method "${String(context.name)}"`;

  return function atomicMethod(this: This, ...args: Args): Return {
    // `this.__doc__` is the doc whose transaction we hold open. For a
    // materialized entity it is the shadow doc where mutations land and from
    // which committed writes forward to main — i.e. a real commit, no preview
    // (or a preview if mid-liminal-session, where the origin is LIMINAL).
    const doc = this.__doc__;

    // EPHEMERAL RECEIVER: no doc to hold open → no batching. Say so once.
    if (!doc) {
      warnOnce(
        warnedEphemeralMethods,
        target,
        `${label} ran on an un-materialized (ephemeral) receiver — \`this.__doc__\` is null, ` +
          `so there is no transaction to batch into and mutations are NOT collapsed. Call it on ` +
          `a tree-resident entity (one reachable from a Plexus root).`,
      );
    }

    // CROSS-DOC detection. Observe any OTHER doc opening its own outermost
    // transaction during the body — those mutations sit outside this batch.
    // Chain to any outer observer (nested atomic) so every level still sees it.
    // Only meaningful when we actually hold a receiver doc; an ephemeral receiver
    // is already covered by the warning above.
    const foreignDocs = new Set<Y.Doc>();
    const previousObserver = transactionObserverHook.observe;
    if (doc) {
      transactionObserverHook.observe = (touched: Y.Doc): void => {
        if (touched !== doc) foreignDocs.add(touched);
        previousObserver?.(touched);
      };
    }

    let result: Return;
    try {
      result = maybeTransacting(doc, () => target.apply(this, args));
    } finally {
      if (doc) transactionObserverHook.observe = previousObserver;
    }

    if (foreignDocs.size > 0) {
      warnOnce(
        warnedCrossDocMethods,
        target,
        `${label} mutated a doc other than the receiver's own — only the receiver's doc is held ` +
          `in the atomic transaction, so those cross-doc mutations are NOT batched and NOT ` +
          `all-or-nothing with the rest. @syncing.atomic is single-doc only.`,
      );
    }

    if (isThenable(result)) {
      warnOnce(
        warnedThenableMethods,
        target,
        `${label} returned a thenable. The atomic transaction commits when the synchronous body ` +
          `returns — mutations after the first \`await\` are NOT batched. Async atomic bodies are ` +
          `not supported.`,
      );
    }

    return result;
  };
}
