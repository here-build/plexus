/**
 * PEW orchestration domain — plan registry + LaunchDefinition.
 * Does not activate or write progress.
 */

export {
  LaunchDefinition,
  type LaunchMode,
  type ProgressMode,
} from "./launch-definition.js";
export { Orchestration } from "./orchestration.js";
export {
  resolvePlan,
  type PlanActorsSource,
  type PlanResolution,
} from "./plan-resolution.js";
// plan-changed.ts stays private: A3 is claim-owner reactions over Orchestration.actors.
// Re-export only when a product seed path needs the process-local signal.