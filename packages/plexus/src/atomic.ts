/**
 * `@syncing.atomic` — run a PlexusModel method body as ONE atomic Plexus
 * transaction on the RECEIVER'S doc, with real rollback on throw.
 * See `docs/working-proposals/syncing-atomic-spec-based-transactions.md` and the
 * engine in `./atomic-buffer.ts`.
 *
 * "Atomic" here means:
 *   - ONE yjs transaction (one `update` event),
 *   - ONE undo unit (a single `undo()` reverts the whole body),
 *   - peers see all-or-nothing of THAT update (delivered whole), AND
 *   - THROW = ROLLBACK. If the body throws, nothing reaches yjs (the wire stays
 *     pure) and the local mirror is restored to its pre-body state.
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
 *     // ↑ all deferred; replayed as exactly ONE doc.transact() at method return
 *   }
 * }
 * ```
 *
 * ───────────────────────────────────────────────────────────────────────────
 * HOW IT WORKS — DEFERRED BUFFER (not "hold a transaction open")
 * ───────────────────────────────────────────────────────────────────────────
 * `runAtomic` opens a per-doc deferral context. While it is active, each routed
 * mutation site applies its LOCAL OVERLAY immediately (so the body reads its own
 * writes) but BUFFERS its yjs write. On success the buffer replays inside ONE
 * `maybeTransacting(doc)` → one transaction / update / undo item. On throw the
 * buffer is DISCARDED (yjs never touched → real rollback) and the overlay
 * inverses replay in reverse to restore the mirror. See `./atomic-buffer.ts` for
 * why routing a few leaf sites suffices (materialization / `ensureYjsMap` /
 * parent-edges are carried along transitively when the buffer replays).
 *
 * Re-entrancy: a nested `@syncing.atomic` on the same doc defers into the outer
 * buffer, so the outermost method owns the single flush.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * BOUNDARY BEHAVIOR (intentional, asserted / documented — NOT a TODO)
 * ───────────────────────────────────────────────────────────────────────────
 *   - LIMINALITY: an atomic method invoked mid-liminal-session stays IN the
 *     preview. The flush rides `this.__doc__`'s transaction, whose registered
 *     origin is LIMINAL during a session, so the batch is held on the shadow
 *     (preview-only) and NOT forwarded to main — committing happens at
 *     `commitLiminality()`, reverting at `revertLiminality()`. Asserted.
 *   - EMPTY TRANSACTION. A method that mutates nothing buffers nothing; the
 *     success flush still opens (and immediately closes) one transaction on the
 *     receiver's doc. yjs emits no `update` for it. Cheap; documented.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * OUT-OF-ENVELOPE (correct-but-unbatched → LOUD once-per-method dev warning)
 * ───────────────────────────────────────────────────────────────────────────
 * These are the honest boundary of a single-doc, synchronous envelope. Each
 * warns at most once per decorated method.
 *
 *   - ASYNC BODY. The deferral context is synchronous and flushes when the body
 *     function RETURNS. Mutations before the first `await` are buffered; anything
 *     after an `await` runs after the context has closed → NOT batched, NOT
 *     rolled back. Warns when the body returns a thenable.
 *   - CROSS-DOC mutation. We only defer the RECEIVER's doc. A mutation to ANOTHER
 *     doc falls through to its normal write path (its own transaction) — NOT
 *     co-batched, NOT all-or-nothing across docs. Detected via
 *     `transactionObserverHook` (a second doc opening its own outermost
 *     transaction during the body) and warned. True multi-doc atomicity needs a
 *     cross-doc deferred-replay tracker — a separate project, NOT built here.
 *   - EPHEMERAL RECEIVER. If `this` is not yet materialized, `this.__doc__` is
 *     null; there is no doc to defer into, so mutations are not collapsed and a
 *     throw does not roll back. Warns. Atomic methods are normally called on a
 *     tree-resident (materialized) entity, so this is an edge.
 *   - UNROUTED MUTATION KIND. Only two of the spec's ~30 emission sites are wired
 *     into the deferred buffer so far: val `set` (`decorators.ts`) and child
 *     `Set.add` (`proxies/set.ts`). Any other mutation inside the body (map/array/
 *     record writes, `Set.delete`/`clear`, single-child set, `detach`, …) still
 *     takes its normal eager write path — it hits yjs DURING the body, so it is
 *     NOT batched and does NOT roll back. Detected structurally: a real
 *     transaction opening on the RECEIVER's doc while the buffer is deferring
 *     (`isDeferring`) can only be an unrouted write; warns. The full §11 emission
 *     rewrite is a separate project, NOT built here.
 */

import type * as Y from "yjs";

import { isDeferring, runAtomic } from "./atomic-buffer.js";
import type { PlexusModel } from "./PlexusModel.js";
import { transactionObserverHook } from "./utils/utils.js";

// Each out-of-envelope condition warns at most once per decorated method, keyed
// on the original method fn (so re-entrant / repeated calls stay quiet).
const warnedThenableMethods = new WeakSet<object>();
const warnedCrossDocMethods = new WeakSet<object>();
const warnedEphemeralMethods = new WeakSet<object>();
const warnedUnroutedMethods = new WeakSet<object>();

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
    // UNROUTED-MUTATION detection. Only two emission sites are routed through the
    // deferred buffer so far (val `set`, child-`Set.add`). A real transaction
    // opening on the RECEIVER's own doc WHILE we are deferring means an unrouted
    // mutation kind (map/array/record set, `Set.delete/clear`, single-child set,
    // detach, …) escaped the buffer and wrote yjs eagerly — NOT batched, NOT
    // rolled back. `isDeferring(doc)` cleanly separates this from the commit flush
    // (which runs after `current` is restored → `isDeferring` false). This turns
    // the buffer's partial coverage into a LOUD boundary instead of a silent
    // mis-batch, pending the full §11 emission rewrite.
    let unroutedLeak = false;
    const previousObserver = transactionObserverHook.observe;
    if (doc) {
      transactionObserverHook.observe = (touched: Y.Doc): void => {
        if (touched === doc) {
          if (isDeferring(doc)) unroutedLeak = true;
        } else {
          foreignDocs.add(touched);
        }
        previousObserver?.(touched);
      };
    }

    let result: Return;
    try {
      // Ephemeral receiver: no doc to defer into → run the body straight (mutations
      // hit their normal, un-deferred write paths; no batching, no rollback).
      result = doc ? runAtomic(doc, () => target.apply(this, args)) : target.apply(this, args);
    } finally {
      if (doc) transactionObserverHook.observe = previousObserver;
    }

    if (unroutedLeak) {
      warnOnce(
        warnedUnroutedMethods,
        target,
        `${label} performed a mutation kind that is NOT yet routed through the atomic buffer ` +
          `(only val \`set\` and child \`Set.add\` are). That write hit yjs eagerly during the ` +
          `body — so it was NOT batched into the single transaction and will NOT roll back on ` +
          `throw. Restrict atomic bodies to the routed mutation kinds until the full emission ` +
          `rewrite lands.`,
      );
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
