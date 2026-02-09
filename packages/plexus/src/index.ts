/**
 * @here.build/plexus
 *
 * Constraint network for object state superposition through mathematical field dynamics.
 *
 * Transforms traditional inheritance hierarchies into proxy networks where objects
 * exist in quantum superposition until materialization collapses them into specific instances.
 *
 * If you did not get it - it is MobX but optionally collaborative.
 * (and with few cool features - parent-child tracking, maps with structural access and dependency management)
 */

// Re-export collections for backwards compatibility
export { DefaultedMap, DefaultedWeakMap } from "@here.build/collections";
export * from "./proxy-runtime-types.js";

export { PlexusModel, type PlexusInit, type PlexusConstructor } from "./PlexusModel.js";
export { syncing } from "./decorators.js";

export * from "./errors.js";

// Built-in tracking system
export * from "./tracking.js";
export * as YJS_GLOBALS from "./YJS_GLOBALS.js";

// Plexus document orchestration
export * from "./Plexus.js";
export * from "./plexus-registry.js";

// Tree walking (traverser) and visiting (value-producing)
export * from "./walk.js";
