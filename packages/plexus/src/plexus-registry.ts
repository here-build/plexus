/**
 * Shared registry for Plexus instances.
 * This file exists to break circular dependencies between Plexus and PlexusModel.
 */

import type * as Y from "yjs";

import type { Plexus } from "./Plexus.js";

// Track which docs have Plexus instances (singleton per doc)
export const docPlexus = new WeakMap<Y.Doc, Plexus<any>>();
export const docLiminality = new WeakMap<Y.Doc, Y.Doc>();

/**
 * Prime → authoring (shadow) doc, and shadow → itself. The awareness read half
 * resolves references on the AUTHORING plane so reads hand back the family's
 * live tree instance, never a prime-homed twin (docs/awareness-coherence.md).
 * Docs outside any Plexus family are absent — readers fall back to the doc
 * itself.
 */
export const docAuthoring = new WeakMap<Y.Doc, Y.Doc>();

/**
 * Transaction origin per doc. Shadow doc: SHADOW_TO_MAIN (normal) or LIMINAL_ORIGIN (during liminality).
 * maybeTransacting reads this to set the Yjs transaction origin. Unset docs get origin=undefined.
 */
export const docTransactionOrigin = new WeakMap<Y.Doc, any>();
