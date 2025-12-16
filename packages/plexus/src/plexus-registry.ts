/**
 * Shared registry for Plexus instances.
 * This file exists to break circular dependencies between Plexus and PlexusModel.
 */

import type * as Y from "yjs";

import type { Plexus } from "./Plexus.js";

// Track which docs have Plexus instances (singleton per doc)
export const docPlexus = new WeakMap<Y.Doc, Plexus<any>>();
