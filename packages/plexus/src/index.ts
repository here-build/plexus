/**
 * The intended surface. Everything reachable from here is meant to be used.
 *
 * NAMED LISTS ONLY — no `export *`. A wildcard makes the surface a side effect
 * of what a sibling module happened to need from its neighbour, and nothing in
 * the diff says a surface changed. It also hides defects: `ReadonlyField` sat
 * here as a value for as long as the wildcard did, and it is a `declare class`
 * with no runtime binding — importing it as one always threw. Enumerating the
 * list surfaced that on the first build.
 *
 * The complement is `./internals.ts` — the same package with nothing withheld,
 * deliberately undocumented. Reaching for it is allowed and marks itself: the
 * import specifier says the caller stepped outside what the package intends,
 * the way `@ts-expect-error` says it about a type.
 */

export {
  type AllowedKeyPrimitive,
  type AllowedPrimitive,
  type AllowedVirtualMapKey,
  type AllowedYJSKeyValue,
  type AllowedYJSMapKey,
  type AllowedYJSValue,
  type AllowedYJSValueList,
  type AllowedYJSValueMap,
  type AllowedYJSValueSet,
  type AllowedYValue,
  type AwarenessSerializable,
  type AwarenessShape,
  type CrossProjectReferenceTuple,
  type GenericRecordSchema,
  type Internals,
  type PlexusTagContainer,
  type PlexusUUID,
  /** `declare class` — a nominal type with no runtime binding, never a value. */
  type ReadonlyField,
  type ReferenceTuple,
  type Storageable,
  type VirtualMap,
  type YPlexusNode,
} from "./proxy-runtime-types.js";
export { PLEXUS_CONTROLLED, PLEXUS_DERIVED } from "./sentinels.js";

export {
  getInternals,
  PlexusModel,
  type PlexusConstructor,
  type PlexusInit,
} from "./PlexusModel.js";
export { resetLocalIDs } from "./local-id.js";
export { syncing } from "./decorators.js";
export {
  PlexusCycleError,
  PlexusDependencyError,
  PlexusDocMismatchError,
  PlexusDuplicateChildError,
  PlexusRootParentError,
  PlexusSelfAdoptionError,
  PlexusTypedArrayAliasError,
  PlexusUnstorableValueError,
} from "./errors.js";
export {
  setTelemetryAdapter,
  telemetry,
  TRACKER_KIND,
  COLLECTION_ENTITY_TYPE,
  ORIGIN_KIND,
  bucketCount,
  bucketBytes,
  type TelemetryAdapter,
  type TelemetryAttributes,
  type TelemetrySpan,
  type TrackerKindLabel,
  type OriginKindLabel,
} from "./telemetry.js";
export * as YJS_GLOBALS from "./YJS_GLOBALS.js";
export { Plexus, type PlexusOptions, type PlexusUndoMode } from "./Plexus.js";
export { docPlexus, docTransactionOrigin } from "./plexus-registry.js";
export {
  buildVisitor,
  type Visitor,
  type Visitors,
  walk,
  type WalkContext,
  walkChildren,
} from "./walk.js";
export {
  PlexusAwareness,
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
  removeAwarenessStates,
  modifyAwarenessUpdate,
  type PlexusAwarenessOptions,
} from "./awareness.js";
export { FieldAwareness, type FrozenAwareness, type ShapeOfAwareness } from "./field-awareness.js";
export {
  LIMINAL_BASE,
  COMMITTED_BASE,
  GENESIS_BASE,
  isRegularClientId,
  isLiminalClientId,
  isCommittedClientId,
  isGenesisClientId,
} from "./genesis-client.js";
