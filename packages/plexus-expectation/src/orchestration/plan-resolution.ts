import type { LaunchDefinition } from "./launch-definition.js";

/**
 * Total plan-resolution outcome (spec §4.3).
 * `bound` / `refused` carry the durable definition when an entry exists.
 */
export type PlanResolution =
  | { readonly status: "missing" }
  | { readonly status: "refused"; readonly def: LaunchDefinition }
  | { readonly status: "bound"; readonly def: LaunchDefinition };

/**
 * Minimal actors map view for pure resolution.
 * Real {@link import("./orchestration.js").Orchestration} satisfies this; tests may pass a plain Map.
 */
export type PlanActorsSource = {
  readonly actors: {
    get(kind: string): LaunchDefinition | undefined;
  };
};

/**
 * Pure total function: kind + plan + loaded modules → missing | refused | bound.
 *
 * - no entry for `kind` → `missing`
 * - entry but `launchMode` not in `loadedModules` → `refused`
 * - else → `bound(def)`
 */
export function resolvePlan(
  kind: string,
  orchestration: PlanActorsSource,
  loadedModules: ReadonlySet<string>,
): PlanResolution {
  const def = orchestration.actors.get(kind);
  if (def === undefined) {
    return { status: "missing" };
  }
  if (!loadedModules.has(def.launchMode)) {
    return { status: "refused", def };
  }
  return { status: "bound", def };
}
