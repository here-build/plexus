import type { Expectation } from "./expectation.js";
import type { Lifecycle } from "./lifecycle.js";

/**
 * Terminal write barrier: durable state must not leave `sealed` | `failed` | `cancelled`.
 * Use `Expectation.transitionState` — the named writer for lifecycle.
 */
export class PewTerminalWriteError extends Error {
  public readonly name = "PewTerminalWriteError";

  constructor(
    public readonly expectation: Expectation,
    public readonly from: Lifecycle,
    public readonly to: Lifecycle,
  ) {
    super(`PewTerminalWriteError: cannot leave terminal state ${from} → ${to} (kind=${expectation.kind})`);
  }
}
