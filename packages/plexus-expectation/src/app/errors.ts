import type { Lifecycle } from "./lifecycle.js";
import type { Expectation } from "./expectation.js";

/**
 * Clone of a non-terminal Expectation (or a subtree containing one) is refused.
 * Terminal-only subtrees may clone; clone resets `bindEpoch` / `rebindCount`.
 */
export class PewCloneOpenError extends Error {
  readonly expectation: Expectation;

  constructor(expectation: Expectation) {
    super(
      `PewCloneOpenError: cannot clone non-terminal Expectation (state=${expectation.state}, kind=${expectation.kind})`,
    );
    this.name = "PewCloneOpenError";
    this.expectation = expectation;
  }
}

/**
 * Terminal write barrier: durable state must not leave `sealed` | `failed` | `cancelled`.
 * Use `Expectation.transitionState` — the named writer for lifecycle.
 */
export class PewTerminalWriteError extends Error {
  readonly expectation: Expectation;
  readonly from: Lifecycle;
  readonly to: Lifecycle;

  constructor(expectation: Expectation, from: Lifecycle, to: Lifecycle) {
    super(
      `PewTerminalWriteError: cannot leave terminal state ${from} → ${to} (kind=${expectation.kind})`,
    );
    this.name = "PewTerminalWriteError";
    this.expectation = expectation;
    this.from = from;
    this.to = to;
  }
}
