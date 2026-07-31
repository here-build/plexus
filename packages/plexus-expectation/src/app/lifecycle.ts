/**
 * Durable Expectation lifecycle (§3.2).
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

/** True when the unit is settled (`sealed` | `failed` | `cancelled`). */
export function isTerminal(state: Lifecycle): state is TerminalLifecycle {
  return TERMINAL_SET.has(state);
}

/** True when work is still open (non-terminal). */
export function isOpen(state: Lifecycle): boolean {
  return !isTerminal(state);
}
