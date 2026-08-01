/**
 * Durable Expectation lifecycle as an XState machine.
 *
 * Process-local activation maps (`binding` / `activating`) stay runtime-only.
 * This graph is the only legal durable transition relation — `transitionState`
 * refuses anything outside it (and all exits from terminals).
 *
 * Pure dual: `lifecycleCan` / `lifecycleAfter` via getNextSnapshot.
 */
import { createMachine, getNextSnapshot } from "xstate";

import type { Lifecycle } from "./lifecycle.js";

export type LifecycleEvent =
  | { type: "TO"; next: Lifecycle };

/**
 * Honest graph from orchestrator / named writers:
 *  - declared → missing | refused | running | cancelled
 *  - missing  → running | cancelled
 *  - refused  → cancelled
 *  - running  → awaiting_rebind | sealed | failed | cancelled
 *  - awaiting_rebind → running | sealed | failed | cancelled
 *  - sealed | failed | cancelled — final
 */
export const expectationLifecycleMachine = createMachine({
  id: "pew-expectation-lifecycle",
  initial: "declared",
  types: { events: {} as LifecycleEvent },
  states: {
    declared: {
      on: {
        TO: [
          { target: "missing", guard: ({ event }) => event.next === "missing" },
          { target: "refused", guard: ({ event }) => event.next === "refused" },
          { target: "running", guard: ({ event }) => event.next === "running" },
          { target: "cancelled", guard: ({ event }) => event.next === "cancelled" },
        ],
      },
    },
    missing: {
      on: {
        TO: [
          { target: "running", guard: ({ event }) => event.next === "running" },
          { target: "cancelled", guard: ({ event }) => event.next === "cancelled" },
          { target: "refused", guard: ({ event }) => event.next === "refused" },
        ],
      },
    },
    refused: {
      on: {
        TO: [
          { target: "cancelled", guard: ({ event }) => event.next === "cancelled" },
          // Recovery: a later plan may still run.
          { target: "running", guard: ({ event }) => event.next === "running" },
        ],
      },
    },
    running: {
      on: {
        TO: [
          { target: "awaiting_rebind", guard: ({ event }) => event.next === "awaiting_rebind" },
          { target: "sealed", guard: ({ event }) => event.next === "sealed" },
          { target: "failed", guard: ({ event }) => event.next === "failed" },
          { target: "cancelled", guard: ({ event }) => event.next === "cancelled" },
        ],
      },
    },
    awaiting_rebind: {
      on: {
        TO: [
          { target: "running", guard: ({ event }) => event.next === "running" },
          { target: "sealed", guard: ({ event }) => event.next === "sealed" },
          { target: "failed", guard: ({ event }) => event.next === "failed" },
          { target: "cancelled", guard: ({ event }) => event.next === "cancelled" },
        ],
      },
    },
    sealed: { type: "final" },
    failed: { type: "final" },
    cancelled: { type: "final" },
  },
});

const resolve = (state: Lifecycle) =>
  expectationLifecycleMachine.resolveState({ value: state, context: {} });

export function lifecycleCan(from: Lifecycle, next: Lifecycle): boolean {
  if (from === next) return true;
  return resolve(from).can({ type: "TO", next });
}

export function lifecycleAfter(from: Lifecycle, next: Lifecycle): Lifecycle {
  if (from === next) return from;
  return getNextSnapshot(expectationLifecycleMachine, resolve(from), {
    type: "TO",
    next,
  }).value as Lifecycle;
}
