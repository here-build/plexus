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

// this import should go first
export * from "./utils/defaulted-collections.js";
export * from "./proxy-runtime-types.js";

export { PlexusModel, type PlexusInit, type PlexusConstructor } from "./PlexusModel.js";
export { syncing } from "./decorators.js";

export * from "./errors.js";

// Built-in tracking system
export * from "./tracking.js";
export * as YJS_GLOBALS from "./YJS_GLOBALS.js";

// Plexus document orchestration
export * from "./Plexus.js";
export { docPlexus } from "./plexus-registry.js";

// Utilities
export { deref } from "./deref.js";
export { undoManagerNotifications } from "./utils/undoManagerNotifications.js";

// Tree walking
export { walk, walkChildren, type WalkContext, type Visitor, type Visitors } from "./walk.js";
