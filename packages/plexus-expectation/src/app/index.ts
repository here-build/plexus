/**
 * PEW app domain — durable work types + author-facing control shapes.
 * Claim owners and resolvers do not live here.
 */

export {
  type Lifecycle,
  type TerminalLifecycle,
  TERMINAL_LIFECYCLES,
  isTerminal,
  isOpen,
  expectationLifecycleMachine,
  lifecycleAfter,
  lifecycleCan,
} from "./lifecycle.js";

export { PewTerminalWriteError } from "./errors.js";

export { Expectation } from "./expectation.js";

export {
  PROGRESS_FIELD,
  type ProgressMode,
  type ProgressPatch,
} from "./progress-plane.js";

export {
  type CancellationStrength,
  type CancellationRequest,
  type CancellationState,
  type Cancellation,
  type SettleSurfaceDisposition,
  type SettleSurfaceRequest,
  type SettleSurfaceIntent,
  type ExpectationAdjustmentIntent,
  type AdjustmentConsumptionState,
  type AdjustmentTerminal,
  type CancelIntent,
  type PewIntent,
  ADJUSTMENT_TERMINALS,
} from "./control.js";

export {
  ExpectationAdjustment,
  type AdjustmentBag,
} from "./expectation-adjustment.js";

export {
  isAdjustmentTerminal,
  isAdjustmentOpen,
  adjustmentLifecycleMachine,
  adjustmentAfter,
  adjustmentCan,
  canReshapeAdjustment,
  shouldRedeliverAdjustment,
  shouldRetractOnRebind,
  ADJUSTMENT_REDELIVER_STATES,
} from "./adjustment-lifecycle.js";
