/**
 * @here.build/plexus
 *
 * Constraint network for object state superposition through mathematical field dynamics.
 *
 * Transforms traditional inheritance hierarchies into proxy networks where objects
 * exist in quantum superposition until materialization collapses them into specific instances.
 */

// this import should go first
export * from "./utils/defaulted-collections.js";
export * from "./proxy-runtime-types.js";

// New decorator-based API
export { PlexusModel, type PlexusInit, type PlexusConstructor } from "./PlexusModel.js";
export { syncing } from "./decorators.js";

// Built-in tracking system
export * from "./tracking.js";
export * as YJS_GLOBALS from "./YJS_GLOBALS.js";

// Plexus document orchestration
export * from "./Plexus.js";
export { docPlexus } from "./plexus-registry.js";

// Utilities
export { deref } from "./deref.js";
export { undoManagerNotifications } from "./utils/undoManagerNotifications.js";
