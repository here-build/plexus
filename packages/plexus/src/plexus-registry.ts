/**
 * Shared registry for Plexus instances and dependencies.
 * This file exists to break circular dependencies between Plexus and PlexusModel.
 */

import type * as Y from "yjs";

import type { DependencyId, DependencyVersion } from "./Plexus.js";
// noinspection ES6PreferShortImport - circular imports issue
import { DefaultedWeakMap } from "./utils/defaulted-collections.js";

// Track which docs have Plexus instances.
// Any is only used because we have some issues with cyclic imports here
export const docPlexus = new WeakMap<Y.Doc, any>();

// Shared dependency doc mappings per main doc
// This ensures all Plexuses for the same doc share dependency resolution
export const sharedDependencyDocs = new DefaultedWeakMap<Y.Doc, Map<DependencyId, Y.Doc>>(() => new Map());
export const sharedDependencyVersions = new DefaultedWeakMap<Y.Doc, Map<DependencyId, DependencyVersion>>(
  () => new Map(),
);

/**
 * Get a dependency doc for cross-reference resolution.
 * Used by deref() to resolve CrossProjectReferenceTuple.
 */
export function getDependencyDoc(fromDoc: Y.Doc, dependencyId: DependencyId): Y.Doc | undefined {
  return sharedDependencyDocs.get(fromDoc).get(dependencyId);
}
