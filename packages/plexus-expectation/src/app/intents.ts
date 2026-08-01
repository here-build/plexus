/**
 * @deprecated Prefer `app/control.ts` — re-exports kept for one migration window.
 * App domain never imports orchestration or runtime.
 */

export type {
  SettleSurfaceDisposition,
  SettleSurfaceRequest,
  SettleSurfaceIntent,
  CancelIntent,
  PewIntent,
  CancellationStrength,
  CancellationRequest,
  CancellationState,
  Cancellation,
  ExpectationAdjustmentIntent,
  AdjustmentConsumptionState,
  AdjustmentTerminal,
} from "./control.js";

export { ADJUSTMENT_TERMINALS } from "./control.js";
