import { createMachine, getNextSnapshot } from "xstate";

/**
 * Expectation lifecycle — pure transition law.
 *
 * The machine contains NO commands: "activatable" is a kernel predicate derived
 * FROM the graph (see `lifecycle.ts`), never an event fired INTO it. Scheduling
 * verbs as machine events with host-provided actions wires the kernel into the
 * entity grammar and turns the FSM into an RPC router.
 */
export const LIFECYCLE_EVENTS = ["PLAN_MISSING", "PLAN_REFUSED", "BEGIN_RUNNING", "SEAL", "FAIL", "CANCEL"] as const;

export type LifecycleEventName = (typeof LIFECYCLE_EVENTS)[number];

export type LifecycleEvent = { type: LifecycleEventName };

export const expectationLifecycleMachine = createMachine({
  id: "pew-expectation-lifecycle",
  initial: "declared",
  types: { events: {} as LifecycleEvent },
  states: {
    declared: {
      on: {
        PLAN_MISSING: "missing",
        PLAN_REFUSED: "refused",
        BEGIN_RUNNING: "running",
        CANCEL: "cancelled",
      },
    },
    missing: {
      on: {
        PLAN_REFUSED: "refused",
        BEGIN_RUNNING: "running",
        CANCEL: "cancelled",
      },
    },
    refused: {
      on: {
        PLAN_MISSING: "missing",
        BEGIN_RUNNING: "running",
        CANCEL: "cancelled",
      },
    },
    running: {
      on: {
        SEAL: "sealed",
        FAIL: "failed",
        CANCEL: "cancelled",
      },
    },
    sealed: { type: "final" },
    failed: { type: "final" },
    cancelled: { type: "final" },
  },
});

export type Lifecycle = "declared" | "missing" | "refused" | "running" | "sealed" | "failed" | "cancelled";

const resolve = (state: Lifecycle) => expectationLifecycleMachine.resolveState({ value: state, context: {} });

export function lifecycleEventAfter(from: Lifecycle, event: LifecycleEventName): Lifecycle | null {
  const snapshot = resolve(from);
  if (!snapshot.can({ type: event })) return null;
  return getNextSnapshot(expectationLifecycleMachine, snapshot, { type: event }).value as Lifecycle;
}

export function lifecycleCan(from: Lifecycle, next: Lifecycle): boolean {
  if (from === next) return true;
  return LIFECYCLE_EVENTS.some((event) => lifecycleEventAfter(from, event) === next);
}

export function lifecycleAfter(from: Lifecycle, next: Lifecycle): Lifecycle {
  return lifecycleCan(from, next) ? next : from;
}
