/**
 * PEW runtime domain — claim-owner host only.
 * UI and model authors must not import this entrypoint.
 */

export {
  Orchestrator,
  walkExpectationForest,
  type BindEntry,
  type MarkAwaitingRebindOpts,
  type PlanResolution,
  type SettleSurfaceBody,
  type SettleSurfaceErrorCode,
  type SettleSurfaceResult,
  type CancellationResult,
  type MaterializeAdjustmentResult,
  type AdjustmentOpResult,
} from "./orchestrator.js";

export {
  type EmitFn,
  type ControlAckFn,
  type ProgressPatch,
  type ResolverEmit,
  type ResolverHandle,
  type ResolverStartInput,
  type ResolverControlAck,
  type AdjustmentSnapshot,
  type StartResolverFn,
  type LaunchDefinitionSnapshot,
} from "./resolver.js";

export {
  type ExpectationExecution,
  type LaunchContext,
  type LaunchRuntime,
  type ExecutionSinks,
  HostPortLaunchRuntime,
  executionFromStartResolver,
} from "./execution.js";
