/**
 * Liveness / rebind (§5.6–5.7).
 *
 * - Unexpected resolver death → awaiting_rebind + rebindCount++
 * - Lease yield → abort then awaiting_rebind, rebindCount unchanged
 * - MAX_REBINDS caps activation from awaiting_rebind
 */

import type { Expectation } from "../app/expectation.js";
import { isTerminal } from "../app/lifecycle.js";

import type { Orchestrator } from "./orchestrator.js";
import { transactEntity } from "./transact.js";

/** Default cap on unexpected rebinds before activation fails with rebind_exhausted. */
export const DEFAULT_MAX_REBINDS = 3;

export type MarkAwaitingRebindOpts = {
  readonly reason?: unknown;
  /** True for unexpected resolver death; false for lease_yield / claim-orphan class. */
  readonly incrementRebind: boolean;
};

/**
 * Abort live handle (if any), write `awaiting_rebind`, clear process-local bind.
 * Money rule: abort before durable state change.
 */
export function markAwaitingRebind(
  orch: Orchestrator,
  E: Expectation,
  opts: MarkAwaitingRebindOpts,
): void {
  if (isTerminal(E.state)) return;

  const bind = orch.binding.get(E);
  // ── ABORT PHASE ────────────────────────────────────────────────────────
  if (bind?.handle && !bind.handle.aborted) {
    bind.handle.abort(opts.reason ?? "awaiting_rebind");
  }

  // ── DURABLE PHASE ──────────────────────────────────────────────────────
  if (E.state !== "awaiting_rebind" || opts.incrementRebind) {
    transactEntity(E, () => {
      if (isTerminal(E.state)) return;
      if (opts.incrementRebind) {
        E.rebindCount += 1;
      }
      if (E.state !== "awaiting_rebind") {
        E.transitionState("awaiting_rebind");
      }
    });
  }

  // ── Clear process-local maps ───────────────────────────────────────────
  orch.clearBind(E);
  orch.clearActivating(E);
  orch.publishAwarenessBinds();
}

/**
 * Unexpected resolver death while claim owner is alive (§5.6).
 * Increments rebindCount; leaves E ready for re-activate via activate/reconcile.
 */
export function onResolverDeath(
  orch: Orchestrator,
  E: Expectation,
  reason: unknown = "resolver_death",
): void {
  if (E.state !== "running") return;
  markAwaitingRebind(orch, E, { reason, incrementRebind: true });
}

/**
 * Lease dispose / yield (§5.6).
 *
 * For every local bind: abort handle, then `awaiting_rebind` with **rebindCount
 * unchanged**. Clears binding + activating maps.
 */
export function disposeLease(
  orch: Orchestrator,
  reason: unknown = "lease_yield",
): void {
  const bound = [...orch.binding.entries()];

  // ── ABORT PHASE — stop spend before durable writes ─────────────────────
  for (const [, bind] of bound) {
    if (bind.handle && !bind.handle.aborted) {
      bind.handle.abort(reason);
    }
  }

  // ── DURABLE PHASE ──────────────────────────────────────────────────────
  for (const [E] of bound) {
    if (E.state === "running") {
      transactEntity(E, () => {
        if (E.state === "running") {
          E.transitionState("awaiting_rebind");
        }
      });
    }
  }

  // ── Clear maps (even if some were already non-running) ─────────────────
  for (const [E] of bound) {
    orch.clearBind(E);
    orch.clearActivating(E);
  }
  // Any in-flight activate without a bind yet
  for (const E of [...orch.activating]) {
    orch.clearActivating(E);
  }
  orch.publishAwarenessBinds();
}

/**
 * True when activation from `awaiting_rebind` should fail with rebind_exhausted.
 * Spec: `rebindCount > MAX_REBINDS` (default 3).
 */
export function isRebindExhausted(E: Expectation, maxRebinds: number = DEFAULT_MAX_REBINDS): boolean {
  return E.state === "awaiting_rebind" && E.rebindCount > maxRebinds;
}
