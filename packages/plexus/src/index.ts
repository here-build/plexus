/**
 * The intended surface. Everything reachable from here is meant to be used.
 *
 * NAMED LISTS ONLY — no `export *`. A wildcard re-export makes the public
 * surface a side effect of what a sibling module happened to need from its
 * neighbour: `getInternals` carries "Module-internal — not re-exported from
 * index.ts" in its own doc comment and was public anyway, because
 * `PlexusModel.ts` exports it for `deref.ts` and the wildcard forwarded it.
 * An enumerated list makes adding to the surface a decision someone writes down.
 *
 * The complement is {@link file://./internals.ts} — the same package with
 * nothing withheld, deliberately undocumented. Reaching for it is allowed and
 * marks itself: the import specifier says the caller stepped outside what the
 * package intends, the way `@ts-expect-error` says it about a type.
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
  bytesProxyRawSymbol,
  type CrossProjectReferenceTuple,
  type GenericRecordSchema,
  informAdoptionSymbol,
  informOrphanizationSymbol,
  type Internals,
  materializationSymbol,
  type PlexusTagContainer,
  type PlexusUUID,
  /** `declare class` — a nominal type with no runtime binding, never a value. */
  type ReadonlyField,
  referenceSymbol,
  type ReferenceTuple,
  requestAdoptionSymbol,
  requestEmancipationSymbol,
  requestOrphanizationSymbol,
  type Storageable,
  validateAdoptionSymbol,
  type VirtualMap,
  type YPlexusNode,
} from "./proxy-runtime-types.js";
export { PLEXUS_CONTROLLED, PLEXUS_DERIVED, PLEXUS_TEST_SENTINEL } from "./sentinels.js";

export {
  type ConcretePlexusConstructor,
  getInternals,
  isBoundEntity,
  PlexusModel,
  type PlexusConstructor,
  type PlexusInit,
  safeUuid,
} from "./PlexusModel.js";
export { mintLocalID, resetLocalIDs } from "./local-id.js";
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
  ACCESS_ALL_SYMBOL,
  ENTRIES_LENGTH_SYMBOL,
  KEYS_SYMBOL,
  type Tracker,
  trackAccess,
  trackModification,
  __untracked__,
  VALUES_SYMBOL,
} from "./tracking.js";
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
export { entityClasses } from "./globals.js";
export { Plexus, type PlexusOptions, type PlexusUndoMode } from "./Plexus.js";
export {
  type BlobEntity,
  createBlobFromDoc,
  decodeBlob,
  type DecodedBlob,
  encodeBlob,
} from "./dependency-blob.js";
export {
  docAuthoring,
  docLiminality,
  docPlexus,
  docTransactionOrigin,
} from "./plexus-registry.js";
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
  AWARENESS_LANE_REGISTER,
  AWARENESS_MAX_LANES,
  awarenessChannelId,
  isAwarenessEnumerationKey,
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
  MAX_UINT32,
  isRegularClientId,
  isLiminalClientId,
  isCommittedClientId,
  isGenesisClientId,
  newClientId,
} from "./genesis-client.js";
