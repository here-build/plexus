/**
 * reconcile — claim-owner forest repair + activation sweep (§5.9).
 *
 * Order:
 * 1) Tree / forest orphans → cancelTree (stop money)
 * 2) Claim orphans → awaiting_rebind (lease class, no rebindCount++)
 * 3) Activate declared|missing|refused|awaiting_rebind under openWork
 */

import { Expectation } from "../app/expectation.js";
import { isOpen, isTerminal } from "../app/lifecycle.js";

import { activate } from "./activate.js";
import { cancelTree } from "./cancel-tree.js";
import { markAwaitingRebind } from "./liveness.js";
import type { Orchestrator } from "./orchestrator.js";

/** Host surface for forest walks — product owns openWork placement. */
export type ReconcileWalk = {
  /**
   * Roots of the open-work forest (product-owned placement).
   * Used for reachability + activation sweep.
   */
  getOpenWorkRoots: () => readonly Expectation[];
  /**
   * Optional broader candidate set for forest-orphan scan (e.g. product maps,
   * known detached units). Defaults to openWork roots + their subtrees only
   * (tree orphans still repaired; forest orphans need candidates outside).
   */
  walkCandidates?: () => Iterable<Expectation>;
  /**
   * True if a live claim-owner peer still advertises a pew.binds entry for E.
   * Default: always false → claim orphans rebind locally.
   */
  hasLiveClaimPeerBind?: (E: Expectation) => boolean;
};

const ACTIVATE_STATES: ReadonlySet<string> = new Set([
  "declared",
  "missing",
  "refused",
  "awaiting_rebind",
]);

type ActivateState = "declared" | "missing" | "refused" | "awaiting_rebind";

function isActivateState(state: string): state is ActivateState {
  return ACTIVATE_STATES.has(state);
}

/** Pre-order walk of owned Expectation subtrees. */
export function* walkExpectationForest(
  roots: readonly Expectation[],
): Generator<Expectation> {
  const seen = new Set<Expectation>();
  const walk = function* (E: Expectation): Generator<Expectation> {
    if (seen.has(E)) return;
    seen.add(E);
    yield E;
    for (const child of E.children) {
      yield* walk(child);
    }
  };
  for (const root of roots) {
    yield* walk(root);
  }
}

/** Collect reachable set from openWork roots. */
export function collectReachable(roots: readonly Expectation[]): Set<Expectation> {
  return new Set(walkExpectationForest(roots));
}

/**
 * True when E is a tree orphan: non-terminal under a terminal Expectation parent.
 */
export function isTreeOrphan(E: Expectation): boolean {
  if (isTerminal(E.state)) return false;
  const parent = E.parent;
  if (parent == null) return false;
  // Parent must be an Expectation with terminal lifecycle
  if (!(parent instanceof Expectation)) return false;
  return isTerminal(parent.state);
}

/**
 * True when E is a forest orphan relative to openWork reachability.
 * Prefer Plexus `isDetached` when materialized; also treat as orphan if not
 * reachable from openWork roots and not under a non-terminal Expectation parent
 * that is itself reachable (covered by reachability set).
 */
export function isForestOrphan(
  E: Expectation,
  reachable: ReadonlySet<Expectation>,
): boolean {
  if (isTerminal(E.state)) return false;
  if (reachable.has(E)) return false;
  // Materialized + detached from doc root (strong signal)
  try {
    if (E.isDetached) return true;
  } catch {
    // unmaterialized / no doc — fall through
  }
  // Not in openWork forest → forest orphan (safe default for money)
  return true;
}

/**
 * Repair orphans then activate units that need a claim (§5.9).
 *
 * Host supplies openWork roots via `orch.getReconcileWalk()` (set on host
 * options) or the optional `walk` argument.
 */
export function reconcile(orch: Orchestrator, walk?: ReconcileWalk): void {
  const host = walk ?? orch.getReconcileWalk();
  if (!host) {
    throw new Error(
      "reconcile requires getOpenWorkRoots (pass ReconcileWalk or set host.getOpenWorkRoots)",
    );
  }

  const roots = host.getOpenWorkRoots();
  const reachable = collectReachable(roots);
  const hasLivePeer = host.hasLiveClaimPeerBind ?? (() => false);

  // Snapshot candidate lists before mutations (cancelTree mutates state/maps)
  const openNodes = [...reachable];
  const candidates = host.walkCandidates
    ? [...host.walkCandidates()]
    : openNodes;

  // ── 1) Tree orphans under openWork ─────────────────────────────────────
  for (const E of openNodes) {
    if (isTreeOrphan(E)) {
      cancelTree(orch, E, "parent_terminal");
    }
  }

  // ── 1b) Forest orphans (not reachable from openWork) ───────────────────
  for (const E of candidates) {
    if (isTerminal(E.state)) continue;
    if (reachable.has(E)) continue;
    if (isForestOrphan(E, reachable)) {
      cancelTree(orch, E, "orphaned");
    }
  }

  // ── 2) Claim orphans: running, no local bind, no live peer ─────────────
  // Re-walk open forest after cancels (state may have changed)
  const afterCancel = collectReachable(host.getOpenWorkRoots());
  for (const E of afterCancel) {
    if (E.state === "running" && !orch.binding.has(E) && !hasLivePeer(E)) {
      markAwaitingRebind(orch, E, {
        reason: "claim_orphan",
        incrementRebind: false,
      });
    }
  }

  // ── 3) Activation sweep ────────────────────────────────────────────────
  const forActivate = collectReachable(host.getOpenWorkRoots());
  for (const E of forActivate) {
    if (isOpen(E.state) && isActivateState(E.state)) {
      activate(orch, E);
    }
  }
}
