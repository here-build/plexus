import { expectationLifecycleMachine, type Lifecycle } from "./lifecycle-machine.js";

export type TerminalLifecycle = Extract<Lifecycle, "sealed" | "failed" | "cancelled">;

const TERMINAL_SET: ReadonlySet<Lifecycle> = new Set(
  Object.values(expectationLifecycleMachine.states)
    .filter((node) => node.type === "final")
    .map((node) => node.key as Lifecycle),
);

export const TERMINAL_LIFECYCLES = [...TERMINAL_SET] as readonly TerminalLifecycle[];

export function isTerminal(state: Lifecycle): state is TerminalLifecycle {
  return TERMINAL_SET.has(state);
}

export function isOpen(state: Lifecycle): boolean {
  return !isTerminal(state);
}

/** Open and not running — one-execution forbids re-spawn of a running uuid. */
export function isActivatable(state: Lifecycle): boolean {
  return isOpen(state) && state !== "running";
}
