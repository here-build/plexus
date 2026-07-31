/**
 * cancelTree — abort-before-durable-cancel (spec §3.5). Money-critical.
 *
 * 1) Collect owned subtree
 * 2) Abort bound running resolvers (AbortSignal into startResolver)
 * 3) One durable pass: non-terminal → cancelled
 * 4) Clear binding / activating for nodes
 */

import type { Expectation } from "../app/expectation.js";
import { isTerminal } from "../app/lifecycle.js";

import type { Orchestrator } from "./orchestrator.js";
import { transactEntity } from "./transact.js";

/** Root + owned descendants (pre-order; cancel durable prefers children-first). */
export function collectOwnedSubtree(root: Expectation): Expectation[] {
  const out: Expectation[] = [];
  const walk = (E: Expectation) => {
    out.push(E);
    for (const child of E.children) {
      walk(child);
    }
  };
  walk(root);
  return out;
}

/**
 * Abort paid work first, then write durable `cancelled`.
 * Invariant: AbortSignal fires before durable state becomes cancelled.
 */
export function cancelTree(orch: Orchestrator, root: Expectation, reason?: unknown): void {
  const nodes = collectOwnedSubtree(root);

  // ── 2) ABORT PHASE — stop spend before durable settle ──────────────────
  // Must complete for all nodes BEFORE any durable cancelled write.
  for (const E of nodes) {
    const bind = orch.binding.get(E);
    if (bind && E.state === "running" && bind.handle && !bind.handle.aborted) {
      bind.handle.abort(reason);
    }
  }

  // ── 3) DURABLE PHASE ───────────────────────────────────────────────────
  // Children before parent so tree walks see parent last (preferred order).
  const durableOrder = [...nodes].reverse();
  const anchor = root;
  transactEntity(anchor, () => {
    for (const E of durableOrder) {
      if (!isTerminal(E.state)) {
        E.transitionState("cancelled");
      }
    }
  });

  // ── 4) Clear process-local maps ────────────────────────────────────────
  for (const E of nodes) {
    orch.clearBind(E);
    orch.clearActivating(E);
  }
  orch.publishAwarenessBinds();
}
