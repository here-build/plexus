/**
 * Durable Expectation lifecycle.
 *
 * Process-local activation maps (`binding` / `activating`) are runtime-only —
 * not part of this durable enum.
 */

export type Lifecycle =
  | "declared"
  | "missing"
  | "refused"
  | "running"
  | "awaiting_rebind"
  | "sealed"
  | "failed"
  | "cancelled";

/** Settlement terminals — no further state transitions leave these. */
export const TERMINAL_LIFECYCLES = ["sealed", "failed", "cancelled"] as const satisfies readonly Lifecycle[];

export type TerminalLifecycle = (typeof TERMINAL_LIFECYCLES)[number];

const TERMINAL_SET: ReadonlySet<Lifecycle> = new Set(TERMINAL_LIFECYCLES);

export function isTerminal(state: Lifecycle): state is TerminalLifecycle {
  return TERMINAL_SET.has(state);
}

export function isOpen(state: Lifecycle): boolean {
  return !isTerminal(state);
}
