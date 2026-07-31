/**
 * PEW runtime domain — claim-owner host only.
 * UI and model authors must not import this entrypoint.
 */

export {
  Orchestrator,
  type BindEntry,
  type LoadedModulesSource,
  type OrchestratorHost,
} from "./orchestrator.js";

export { activate } from "./activate.js";
export { applyEmit, type ProgressApplier } from "./emit.js";
export { planResolution } from "./plan-resolution.js";
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

export {
  settleSurface,
  type SettleSurfaceBody,
  type SettleSurfaceErrorCode,
  type SettleSurfaceResult,
} from "./surface-settle.js";

export {
  DEFAULT_MAX_REBINDS,
  disposeLease,
  isRebindExhausted,
  markAwaitingRebind,
  onResolverDeath,
  type MarkAwaitingRebindOpts,
} from "./liveness.js";

export {
  collectReachable,
  isForestOrphan,
  isTreeOrphan,
  reconcile,
  walkExpectationForest,
  type ReconcileWalk,
} from "./reconcile.js";
