/**
 * PEW runtime domain — claim-owner host only.
 * UI and model authors must not import this entrypoint.
 */

export {
  Orchestrator,
  DEFAULT_MAX_REBINDS,
  collectReachable,
  isForestOrphan,
  isTreeOrphan,
  walkExpectationForest,
  type BindEntry,
  type MarkAwaitingRebindOpts,
  type OrchestratorHost,
  type ProgressApplier,
  type ReconcileWalk,
  type SettleSurfaceBody,
  type SettleSurfaceErrorCode,
  type SettleSurfaceResult,
} from "./orchestrator.js";

export {
  modulesFromMap,
  modulesFromRecord,
  type ModuleRegistry,
} from "./modules.js";

export {
  handleFromController,
  snapshotDefinition,
  type EmitFn,
  type LaunchDefinitionSnapshot,
  type ProgressPatch,
  type ResolverEmit,
  type ResolverHandle,
  type ResolverStartInput,
  type StartResolverFn,
  type WorkIdentity,
} from "./resolver.js";
