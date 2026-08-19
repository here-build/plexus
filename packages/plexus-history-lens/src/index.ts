/**
 * `@here.build/plexus-history-lens` — the describing layer.
 *
 * here.build-specific consolidation of the domain-agnostic `PlexusChange[]` (from
 * `@here.build/plexus-history`) into human-readable `IntentEvent[]`. Retrospective, lossy, and TOTAL: it
 * recognizes the operations vocabulary but does not depend on it (changes with no operation behind them —
 * CRDT merges, repairs, raw writes — degrade to a generic line, never fail). The clay tenet keeps model
 * semantics HERE; core knows only CRDT shapes.
 *
 * STRUCTURE: a CENTRAL pipeline ({@link consolidate} / {@link humanize}) over a registry of per-area
 * {@link AreaModule}s (`./areas/*`, summed in `./registry`). Each model area is its own moldable module —
 * adding one is an import + a registry entry + its `*Intent` in the {@link IntentEvent} union.
 */
export type { IntentEvent, IntentKind, IntentEventBase, RawEdit } from "./types.js";
export type { ComponentAdded, ComponentRenamed, ComponentRemoved, ComponentIntent } from "./areas/component.js";
export type { PageRouteChanged, PageIntent } from "./areas/page.js";
export type { ParamsStatesTypesIntent } from "./areas/params-states-types.js";
export type { AreaModule, CutMeta } from "./area.js";
export { AREAS } from "./registry.js";
export { consolidate, type LensCtx } from "./consolidate.js";
export { humanize, humanizeOne } from "./humanize.js";
export { resolveTarget, type ResolvedTarget } from "./resolve-target.js";
export { HEREBUILD_OBJECT_TYPES, isHerebuildObject, objectKind } from "./object-types.js";
export {
  resolveVarianceCoord,
  variantSubjectType,
  varianceKindOf,
  VARIANCE_KEYED_FACETS,
  type VarianceCoord,
  type VarianceKind,
} from "./variance.js";
export { resolveChange, type ChangeResolution } from "./resolve-change.js";
export { pass2, composeGesture, coordinateClause, coordKey, type ResolvedChange, type ObjectRef } from "./pass2.js";
export { narrate, narrateChanges } from "./narrate.js";
