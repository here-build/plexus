/**
 * Host-injected resolver modules — one entity: {@link ModuleRegistry}.
 *
 * Loader types (`inprocess` / `surface` / …) are a separate static floor on the
 * host (`loadedModules`). This registry is only **handlers for known kinds**
 * (kind key preferred, launchMode as fallback). Extensions may
 * {@link ModuleRegistry.register} after claim-owner install; call
 * `noteModulesChanged` so open work can activate once the starter exists.
 */

import type { StartResolverFn } from "./resolver.js";

/** The only module shape Orchestrator accepts. Always mutable for late wire. */
export type ModuleRegistry = {
  resolve(kind: string, launchMode: string): StartResolverFn | undefined;
  /** Late-wire a known kind (preferred) or mode-level fallback starter. */
  register(key: string, start: StartResolverFn): void;
};

/** Adapt a flat map (keys = kind and/or launchMode) into {@link ModuleRegistry}. */
export function modulesFromMap(map: ReadonlyMap<string, StartResolverFn>): ModuleRegistry {
  const store = new Map(map);
  return {
    resolve(kind: string, launchMode: string): StartResolverFn | undefined {
      return store.get(kind) ?? store.get(launchMode);
    },
    register(key: string, start: StartResolverFn): void {
      store.set(key, start);
    },
  };
}

/** Adapt a plain record into {@link ModuleRegistry}. */
export function modulesFromRecord(record: Record<string, StartResolverFn>): ModuleRegistry {
  return modulesFromMap(new Map(Object.entries(record)));
}
