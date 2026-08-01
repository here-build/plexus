/**
 * ExpectationAdjustment consumption lifecycle as an XState machine.
 * Pure dual: `adjustmentCan` / `adjustmentAfter` via getNextSnapshot.
 */
import { createMachine, getNextSnapshot } from "xstate";

import type { AdjustmentConsumptionState } from "./control.js";

export type AdjustmentLifecycleEvent = { type: "TO"; next: AdjustmentConsumptionState };

/**
 * Apply: announced → queued → delivered → accepted → considered
 * Retract: *open* → withdrawing → withdrawn
 * Terminals: considered | withdrawn | refused
 */
export const adjustmentLifecycleMachine = createMachine({
  id: "pew-adjustment-lifecycle",
  initial: "announced",
  types: { events: {} as AdjustmentLifecycleEvent },
  states: {
    announced: {
      on: {
        TO: [
          { target: "queued", guard: ({ event }) => event.next === "queued" },
          { target: "withdrawn", guard: ({ event }) => event.next === "withdrawn" },
          { target: "refused", guard: ({ event }) => event.next === "refused" },
        ],
      },
    },
    queued: {
      on: {
        TO: [
          { target: "delivered", guard: ({ event }) => event.next === "delivered" },
          { target: "withdrawn", guard: ({ event }) => event.next === "withdrawn" },
          { target: "refused", guard: ({ event }) => event.next === "refused" },
          { target: "withdrawing", guard: ({ event }) => event.next === "withdrawing" },
        ],
      },
    },
    delivered: {
      on: {
        TO: [
          { target: "accepted", guard: ({ event }) => event.next === "accepted" },
          { target: "withdrawing", guard: ({ event }) => event.next === "withdrawing" },
          { target: "refused", guard: ({ event }) => event.next === "refused" },
        ],
      },
    },
    accepted: {
      on: {
        TO: [
          { target: "considered", guard: ({ event }) => event.next === "considered" },
          { target: "withdrawing", guard: ({ event }) => event.next === "withdrawing" },
          { target: "refused", guard: ({ event }) => event.next === "refused" },
        ],
      },
    },
    withdrawing: {
      on: {
        TO: [
          // ackDropped only — no jump to considered (ops refuse markConsidered while withdrawing)
          { target: "withdrawn", guard: ({ event }) => event.next === "withdrawn" },
          { target: "refused", guard: ({ event }) => event.next === "refused" },
        ],
      },
    },
    considered: { type: "final" },
    withdrawn: { type: "final" },
    refused: { type: "final" },
  },
});

const resolve = (state: AdjustmentConsumptionState) =>
  adjustmentLifecycleMachine.resolveState({ value: state, context: {} });

export function adjustmentCan(from: AdjustmentConsumptionState, next: AdjustmentConsumptionState): boolean {
  if (from === next) return true;
  return resolve(from).can({ type: "TO", next });
}

export function adjustmentAfter(
  from: AdjustmentConsumptionState,
  next: AdjustmentConsumptionState,
): AdjustmentConsumptionState | null {
  if (from === next) return from;
  if (!adjustmentCan(from, next)) return null;
  return getNextSnapshot(adjustmentLifecycleMachine, resolve(from), {
    type: "TO",
    next,
  }).value as AdjustmentConsumptionState;
}
