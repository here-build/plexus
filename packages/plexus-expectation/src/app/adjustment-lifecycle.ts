/**
 * ExpectationAdjustment consumption lifecycle helpers.
 * Process-local delivery maps are runtime-only — not this enum.
 */

import {
  ADJUSTMENT_TERMINALS,
  type AdjustmentConsumptionState,
  type AdjustmentTerminal,
} from "./control.js";

export {
  adjustmentLifecycleMachine,
  adjustmentAfter,
  adjustmentCan,
} from "./adjustment-lifecycle-machine.js";

export type { AdjustmentConsumptionState, AdjustmentTerminal };

const TERMINAL_SET: ReadonlySet<AdjustmentConsumptionState> = new Set(ADJUSTMENT_TERMINALS);

export function isAdjustmentTerminal(state: AdjustmentConsumptionState): state is AdjustmentTerminal {
  return TERMINAL_SET.has(state);
}

export function isAdjustmentOpen(state: AdjustmentConsumptionState): boolean {
  return !isAdjustmentTerminal(state);
}

/** States that rebind re-delivers apply snapshot for. */
export const ADJUSTMENT_REDELIVER_STATES = ["queued", "delivered", "accepted"] as const satisfies readonly AdjustmentConsumptionState[];

export function shouldRedeliverAdjustment(state: AdjustmentConsumptionState): boolean {
  return (ADJUSTMENT_REDELIVER_STATES as readonly string[]).includes(state);
}

/** States that rebind re-issues retract for. */
export function shouldRetractOnRebind(state: AdjustmentConsumptionState): boolean {
  return state === "withdrawing";
}

/**
 * Reshape legality: only while not terminal and not withdrawing.
 * Epoch must be strictly greater than current.
 */
export function canReshapeAdjustment(
  state: AdjustmentConsumptionState,
  currentEpoch: number,
  nextEpoch: number,
): boolean {
  if (isAdjustmentTerminal(state) || state === "withdrawing") return false;
  return nextEpoch > currentEpoch;
}
