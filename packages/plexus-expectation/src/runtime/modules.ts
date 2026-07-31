/**
 * Host-injected resolver module registry.
 * Keyed by launchMode and/or kind; claim owner resolves at activate time.
 */

import type { StartResolverFn } from "./resolver.js";

/**
 * Lookup start fn for a bound plan.
 * Prefer kind-specific registration, then launchMode.
 */
export type ModuleRegistry = {
  resolve(kind: string, launchMode: string): StartResolverFn | undefined;
};

/** Flat map: keys are launchMode strings and/or kind strings. */
export function modulesFromMap(map: ReadonlyMap<string, StartResolverFn>): ModuleRegistry {
  return {
    resolve(kind: string, launchMode: string): StartResolverFn | undefined {
      return map.get(kind) ?? map.get(launchMode);
    },
  };
}

/** Object form of {@link modulesFromMap}. */
export function modulesFromRecord(record: Record<string, StartResolverFn>): ModuleRegistry {
  return modulesFromMap(new Map(Object.entries(record)));
}
