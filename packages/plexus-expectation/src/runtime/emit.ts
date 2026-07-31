/**
 * Emit apply (§3.3 / §5.5) — epoch fence; drop after cancel; no re-entrant activate.
 */

import type { Expectation } from "../app/expectation.js";
import { isTerminal } from "../app/lifecycle.js";

import type { Orchestrator } from "./orchestrator.js";
import type { ProgressPatch, ResolverEmit } from "./resolver.js";
import { transactEntity } from "./transact.js";

/**
 * Apply a resolver emit against claim-owner state.
 *
 * Dropped when:
 * - `E.state !== "running"`, or
 * - `message.epoch !== E.bindEpoch` (stale / cancelled epoch)
 *
 * Complete → sealed; fail → failed. Parent terminal cascades `cancelTree` on
 * open children (spec §3.5). Does **not** call `activate` on the same E.
 */
export function applyEmit(orch: Orchestrator, E: Expectation, message: ResolverEmit): void {
  // Epoch + running fence — drop after cancel / complete / stale rebind
  if (E.state !== "running") return;
  if (message.epoch !== E.bindEpoch) return;

  switch (message.type) {
    case "progress": {
      orch.applyProgress(E, message.patch);
      return;
    }
    case "complete": {
      settleTerminal(orch, E, "sealed");
      return;
    }
    case "fail": {
      settleTerminal(orch, E, "failed");
      return;
    }
    default: {
      const _exhaustive: never = message;
      void _exhaustive;
    }
  }
}

function settleTerminal(
  orch: Orchestrator,
  E: Expectation,
  terminal: "sealed" | "failed",
): void {
  // Snapshot children before durable write — cascade after parent is terminal
  const children = [...E.children];

  transactEntity(E, () => {
    // Re-check inside transact (race with cancel)
    if (E.state !== "running") return;
    E.transitionState(terminal);
  });

  // Parent terminal → cancel open children (spec §3.5). Only if we actually sealed/failed.
  if (E.state !== terminal) return;

  orch.clearBind(E);
  orch.publishAwarenessBinds();

  for (const child of children) {
    if (!isTerminal(child.state)) {
      orch.cancelTree(child, "parent_terminal");
    }
  }
}

/** Host progress hook type (product-owned fields). */
export type ProgressApplier = (E: Expectation, patch: ProgressPatch) => void;
