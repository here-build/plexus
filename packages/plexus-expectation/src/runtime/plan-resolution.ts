/**
 * Runtime plan resolution — orchestration pure function + host loadedModules.
 */

import type { Expectation } from "../app/expectation.js";
import {
  resolvePlan,
  type PlanActorsSource,
  type PlanResolution,
} from "../orchestration/plan-resolution.js";

/**
 * Resolve plan for `E.kind` against session orchestration + loaded modules.
 */
export function planResolution(
  E: Expectation,
  orchestration: PlanActorsSource,
  loadedModules: ReadonlySet<string>,
): PlanResolution {
  return resolvePlan(E.kind, orchestration, loadedModules);
}
